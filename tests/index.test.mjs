// index.js 装配层测试 —— 三条铁律各一条断言
// 跑法：node tests/index.test.mjs
import { apply, __test__, buildReminder, lastUserText, alreadyInjected } from '../core-plugin/lib/index.js';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}${e ? '  — ' + e : ''}`); } else { fail++; console.log(`  ❌ ${n}${e ? '  — ' + e : ''}`); } };

// 造一个最小的假 ctx（只要能注册钩子、能被触发）
function makeCtx() {
  const hooks = new Map();
  return {
    logger: () => ({ debug: () => {} }),
    on(event, handler) { if (!hooks.has(event)) hooks.set(event, []); hooks.get(event).push(handler); },
    _fire(event, ...args) { const hs = hooks.get(event) ?? []; return Promise.all(hs.map((h) => h(...args))); },
    _has(event) { return (hooks.get(event) ?? []).length > 0; },
  };
}

console.log('═══ 铁律③：装配失败必须安全退出（不许把宿主带崩）═══');
{
  const ctx = makeCtx();
  let threw = false;
  try {
    // 故意传一个会让 schema 校验失败的值
    apply(ctx, { retrieveTopN: 'not-a-number' });
  } catch { threw = true; }
  ok('非法配置不抛异常', threw === false);
  ok('非法配置下不注册任何钩子', !ctx._has('agent/pre-step') && !ctx._has('session/event'));
}

console.log('═══ 正常装配 ═══');
const ctx = makeCtx();
__test__.resetScopeCreateCount();
apply(ctx, { traceFile: 'D:/AI/开源/dsh-inner-loop/tmp_t.log', alarmFile: 'D:/AI/开源/dsh-inner-loop/tmp_a.md', indexFile: 'D:/AI/开源/dsh-inner-loop/tmp_i.md' });
ok('注册了 agent/pre-step', ctx._has('agent/pre-step'));
ok('注册了 session/event', ctx._has('session/event'));
const ret = __test__.getRetriever();
ok('retriever 已装配', !!ret);
ok('topN 默认 3', ret?.topN === 3, String(ret?.topN));

console.log('═══ 铁律①：工厂只 new 一次（连调 100 次 retrieve）═══');
{
  const before = __test__.getScopeCreateCount();
  ok('装配后 scope 工厂调用 1 次', before === 1, String(before));
  for (let i = 0; i < 100; i += 1) {
    await ret.retrieve(`第 ${i} 次随便问点什么`, 'session-x');
  }
  const after = __test__.getScopeCreateCount();
  ok('100 次 retrieve 之后仍是 1 次', after === 1, String(after));
}

console.log('═══ 铁律②：degraded 时必须让模型知道自己瞎了 ═══');
{
  // 用一个必定读不到账本的配置重新装配
  const ctx2 = makeCtx();
  apply(ctx2, {
    traceFile: 'D:/AI/开源/dsh-inner-loop/tmp_t2.log',
    alarmFile: 'D:/AI/开源/dsh-inner-loop/tmp_a2.md',
    indexFile: 'D:/AI/开源/dsh-inner-loop/绝对不存在的账本.md',
  });
  const handlers = [];
  ctx2.on('agent/pre-step', () => {}); // 确保 map 存在
  const decision = { messages: [{ role: 'user', content: [{ type: 'text', text: '问一个需要历史的问题' }] }] };
  const next = async () => decision;
  // 直接调已注册的那个 handler
  const out = await ctx2._fire('agent/pre-step', { step: 1, signal: { aborted: false }, agent: { id: 's1' } }, next);
  const last = out?.at?.(0);
  const msgs = last?.messages ?? [];
  const injectedText = msgs.map((m) => (m.content ?? []).map((p) => p.text).join('')).join('\n');
  ok('注入了一条消息', msgs.length > decision.messages.length);
  ok('含自检标记', injectedText.includes('内循环自检'));
  ok('含降级提示', /记忆检索降级/.test(injectedText), injectedText.includes('记忆检索降级') ? '有' : '无');
}

console.log('═══ 纯函数 ═══');
ok('buildReminder 包了 system-reminder', buildReminder('x').includes('<system-reminder>'));
ok('lastUserText 取最后一条 user', lastUserText([
  { role: 'user', content: [{ type: 'text', text: '第一句' }] },
  { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
  { role: 'user', content: [{ type: 'text', text: '第二句' }] },
]) === '第二句');
ok('alreadyInjected 认得出标记', alreadyInjected([{ role: 'user', content: [{ type: 'text', text: '前缀 【内循环自检 · 每步一次' }] }]));

console.log(`\n合计：✅ ${pass} ｜ ❌ ${fail}`);
process.exit(fail === 0 ? 0 : 2);
