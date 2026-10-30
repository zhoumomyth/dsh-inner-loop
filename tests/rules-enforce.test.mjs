// rules-enforce.js 单测 v3 —— 四轮审查后的定稿
// 跑法：node tests/rules-enforce.test.mjs
import {
  classifyTool, normalizeToolName, extractCommand, isDeclaredReadonly, stripReadonlyPrefix,
  readAssistantText, createBreaker, checkA3Format, a3Passed,
  A3_PASS_THRESHOLD, denyReason, revokeNotice, revokedReminder,
  DEFAULT_READONLY_TOOLS, DEFAULT_EXECUTORS,
} from '../core-plugin/lib/rules-enforce.js';

let pass = 0;
let fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass += 1; console.log(`  ✅ ${n}${e ? '  — ' + e : ''}`); }
  else { fail += 1; console.log(`  ❌ ${n}${e ? '  — ' + e : ''}`); }
};

const cls = (name, args, conf) => classifyTool(name, args, conf);
const bash = (command) => ({ command });

console.log('═══ 1. 默认不可信：未知工具一律拦 ═══');
{
  ok('mcp__sql__execute（未知）→ write', cls('mcp__sql__execute', {}) === 'write');
  ok('python_execute（未知名字）→ write', cls('python_execute', {}) === 'write');
  ok('完全没见过的名字 → write', cls('whatever_tool', {}) === 'write');
  ok('空名字 → write', cls('', {}) === 'write');
  ok('customWriteTools 生效', cls('my_writer', {}, { customWriteTools: ['my_writer'] }) === 'write');
}

console.log('═══ 2. 只读白名单：唯一可信来源 ═══');
{
  ok('read → readonly', cls('read', {}) === 'readonly');
  ok('grep → readonly', cls('grep', {}) === 'readonly');
  ok('glob → readonly', cls('glob', {}) === 'readonly');
  ok('web_search → readonly', cls('web_search', {}) === 'readonly');
  ok('present → readonly（UI 类）', cls('present', {}) === 'readonly');
  ok('todo_write → readonly（状态类）', cls('todo_write', {}) === 'readonly');
  ok('mcp__fs__read → readonly', cls('mcp__fs__read', {}) === 'readonly');
  ok('用户可扩 readOnlyTools', cls('my_safe', {}, { readOnlyTools: ['my_safe'] }) === 'readonly');
  ok('present / todo_write 在默认表里',
    DEFAULT_READONLY_TOOLS.includes('present') && DEFAULT_READONLY_TOOLS.includes('todo_write'));
}

console.log('═══ 3. 执行器只认 READONLY: 声明（不再解析命令）═══');
{
  // 关键：不声明一律拦，哪怕命令本身无害
  ok('ls 不声明 → write', cls('bash', bash('ls -la')) === 'write', '不再猜命令内容');
  ok('node --check 不声明 → write', cls('bash', bash('node --check a.js')) === 'write');

  // 声明了就放行
  ok('READONLY: ls → readonly', cls('bash', bash('READONLY: ls -la')) === 'readonly');
  ok('READONLY: node --check → readonly', cls('bash', bash('READONLY: node --check a.js')) === 'readonly');
  ok('READONLY: python -m py_compile → readonly', cls('bash', bash('READONLY: python -m py_compile a.py')) === 'readonly');
  ok('前缀大小写不敏感', cls('bash', bash('readonly: ls')) === 'readonly');
  ok('前导空格容忍', cls('bash', bash('   READONLY: ls')) === 'readonly');

  // 这是审查点名的那句话：前缀匹配拦不住的
  ok('`node --check a.js && rm -rf /` 不声明 → write',
    cls('bash', bash('node --check a.js && rm -rf /')) === 'write', '前缀匹配在这里会漏');

  // 声明了却夹带私货 → 系统不追责（诚信问题）
  ok('READONLY: ls && rm -rf / → readonly（声明即放行，不追真假）',
    cls('bash', bash('READONLY: ls && rm -rf /')) === 'readonly',
    '系统的责任是要求声明，不是验证声明真假');

  ok('空命令 → write', cls('bash', bash('')) === 'write');
  ok('没有命令行 → write', cls('bash', {}) === 'write');

  // 其他执行器同理
  ok('pwsh READONLY → readonly', cls('pwsh', bash('READONLY: Get-ChildItem')) === 'readonly');
  ok('python 不声明 → write', cls('python', bash('open("a","w")')) === 'write');
  ok('python 在 executors 名单里', DEFAULT_EXECUTORS.includes('python'));
}

console.log('═══ 4. READONLY 协议工具函数 ═══');
{
  ok('isDeclaredReadonly 认前缀', isDeclaredReadonly('READONLY: ls'));
  ok('isDeclaredReadonly 不认空', !isDeclaredReadonly(''));
  ok('isDeclaredReadonly 不认普通命令', !isDeclaredReadonly('ls -la'));
  ok('stripReadonlyPrefix 去掉前缀', stripReadonlyPrefix('READONLY: node --check a.js') === 'node --check a.js');
  ok('stripReadonlyPrefix 无前缀时原样返回', stripReadonlyPrefix('ls') === 'ls');
  ok('normalize mcp__a__write → write', normalizeToolName('mcp__a__write') === 'write');
  ok('extractCommand 认 command/cmd/code',
    extractCommand({ command: 'a' }) === 'a' && extractCommand({ cmd: 'b' }) === 'b' && extractCommand({ code: 'c' }) === 'c');
}

console.log('═══ 5. reasoning 必须扫 ═══');
{
  const mk = (parts) => ({ snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: parts } } }] });
  const cot = mk([{ type: 'reasoning', text: '备份在 D:\\bak\\a.js。node --check exit 0。预期 1 次实际 1 次。回读确认在。' }]);
  ok('只有 reasoning → 也读得到', (readAssistantText(cot) || '').includes('D:\\bak'));
  ok('这份文本能过 a3Passed', a3Passed(readAssistantText(cot)));
  ok('字段名叫 reasoning 也认', (readAssistantText(mk([{ type: 'reasoning', reasoning: '备份在 /home/u/a' }])) || '').includes('/home/u'));
  ok('读不到 session → null', readAssistantText({}) === null);
  ok('只有 tool-call → 空串', readAssistantText(mk([{ type: 'tool-call', name: 'write' }])) === '');
}

console.log('═══ 6. 熔断：不放行、不 ask，锁死后给逃生通道 ═══');
{
  const b = createBreaker({ limit: 3 });
  const s = { id: 's1' };

  ok('初始未锁死', !b.isRevoked(s, 'A3'));
  b.deny(s, 'A3');
  ok('拒 1 次 → 未锁死', !b.isRevoked(s, 'A3'));
  b.deny(s, 'A3');
  ok('拒 2 次 → 未锁死', !b.isRevoked(s, 'A3'));
  const r3 = b.deny(s, 'A3');
  ok('拒 3 次 → 锁死', r3.revoked && b.isRevoked(s, 'A3'));
  ok('第 4 次仍记数（不是放行）', b.deny(s, 'A3').revoked && b.count(s, 'A3') === 4);

  ok('不同会话隔离', !b.isRevoked({ id: 's2' }, 'A3'));
  ok('不同规则隔离', !b.isRevoked(s, 'A5'));
  b.reset(s, 'A3');
  ok('reset 恢复', !b.isRevoked(s, 'A3'));
  b.dispose(s);
  ok('dispose 清干净', b.count(s, 'A3') === 0);
}

console.log('═══ 7. 格式复查 3/4 ═══');
{
  const full = '备份在 D:\\bak\\a.js。node --check 退出码 0。预期 1 次，实际 1 次。回读确认那一行已改。';
  ok('四条齐 → 4/4', checkA3Format(full).hits === 4 && a3Passed(full));

  const cheat = '我备份了，也跑过 node --check 了。';
  ok('糊弄话 → 只命中 1 条', checkA3Format(cheat).hits === 1);
  ok('糊弄话不通过', !a3Passed(cheat));

  const three = '备份在 /home/u/bak/a.js。py_compile 通过。命中 2 处。';
  ok('三条 → 过', checkA3Format(three).hits === 3 && a3Passed(three));
  ok('阈值 3', A3_PASS_THRESHOLD === 3);
}

console.log('═══ 8. 文案：拒绝 + 锁死逃生通道 ═══');
{
  const d = denyReason(checkA3Format('我备份了'), 'write');
  ok('拒绝文案带工具名', d.includes('write'));
  ok('拒绝文案提示 READONLY 取证方式', d.includes('READONLY') || d.includes('只读命令'));

  const rv = revokeNotice('write', 3);
  ok('锁死文案说「未执行」', rv.includes('未执行'));
  ok('★ 锁死文案要求「立即停止调用工具」', rv.includes('立即停止调用工具'), '这是审查要的逃生通道');
  ok('★ 锁死文案要求转纯文本报告', rv.includes('纯文本'));
  ok('★ 锁死文案说「由人决定」', rv.includes('由人决定'));

  const rr = revokedReminder();
  ok('下一步提醒含四条', rr.includes('备份') && rr.includes('回读'));
}

console.log('═══ 9. 闭环：模型怎么从「被拦」走到「能写」═══');
{
  ok('① 直接 write → write（拦）', cls('write', { file_path: 'a.js' }) === 'write');
  ok('② 调 bash 拍照 → 不声明就还拦', cls('bash', bash('ls -la')) === 'write');
  ok('③ 加 READONLY 声明 → 放行', cls('bash', bash('READONLY: ls -la')) === 'readonly');
  ok('④ READONLY 跑语法检查 → 放行', cls('bash', bash('READONLY: node --check a.js')) === 'readonly');
  ok('⑤ 拿到结果答清单 → 可过格式复查',
    a3Passed('备份在 D:\\bak\\a.js。node --check exit 0。预期 1 次实际 1 次。回读确认在。'));
  ok('⑥ 此时 write 才由调用方放行', cls('write', {}) === 'write', '判定仍是 write，放行权在调用方看清单');
}

console.log(`\n合计：✅ ${pass} ｜ ❌ ${fail}`);
process.exit(fail === 0 ? 0 : 2);
