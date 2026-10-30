// rules-radar.js 单测 v3 —— 三分法（冷启动 + 防污染）
// 跑法：node tests/rules-radar.test.mjs
import {
  RULE_CHECKS, detectIntent, readContext, matchOne, scanRules,
  createRadarState, renderChecklist, mergeChecklists, MAX_POINTS,
} from '../core-plugin/lib/rules-radar.js';

let pass = 0;
let fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass += 1; console.log(`  ✅ ${n}${e ? '  — ' + e : ''}`); }
  else { fail += 1; console.log(`  ❌ ${n}${e ? '  — ' + e : ''}`); }
};
const d = (text, hist) => detectIntent(text, hist || {});

console.log('═══ 1. 冷启动：第一句话就能触发（审查第一刺）═══');
{
  const r1 = d('帮我修一下这个 Python 脚本的 bug');
  ok('「帮我修一下这个 Python 脚本的 bug」→ A3',
    r1.rule === 'A3', `score=${r1.score.toFixed(2)} ${r1.reasons.join('/')}`);
  ok('新会话无历史也能触发', d('帮我改下 lib/index.js').rule === 'A3');
  ok('「重构这段代码」→ A3', d('重构这段代码').rule === 'A3');
  ok('「这个函数报错了」→ A3', d('这个函数报错了').rule === 'A3');
  ok('「fix the bug in a.js」→ A3', d('fix the bug in a.js').rule === 'A3');
  ok('绝对路径 + 动作词 → A3', d('把 D:\\project\\lib\\index.js 里的超时改成 30').rule === 'A3');
  ok('强指令单独就过阈值（≥0.5）', r1.score >= 0.5);
}

console.log('═══ 2. 防污染：不该触发的绝不触发（审查第二刺）═══');
{
  ok('「写一段关于秋天的散文」→ 不触发', d('你能给我写一段关于秋天的散文吗').rule === null, '有"写"但不是写代码');
  ok('「写首诗」→ 不触发', d('帮我写首诗').rule === null);
  ok('「写个小说开头」→ 不触发', d('写个小说开头').rule === null);
  ok('「别改代码」→ 不触发', d('别改代码了').rule === null);
  ok('「只是问问，不用改」→ 不触发', d('只是问问，不用改').rule === null);
  ok('「今天天气不错」→ 不触发', d('今天天气不错').rule === null);
  ok('「改主意了」→ 不触发', d('改主意了').rule === null);
}

console.log('═══ 3. 历史惯性：只在模糊句时兜底 ═══');
{
  const hist = { recentWriteTurns: 2, turnsSinceWrite: 1, lastToolNames: ['write', 'read'] };

  ok('「好」+ 刚写过 → 续期 A3', d('好', hist).rule === 'A3', '模糊句靠历史救');
  ok('「继续」+ 刚写过 → 续期 A3', d('继续', hist).rule === 'A3');
  ok('「嗯」+ 刚写过 → 续期 A3', d('嗯', hist).rule === 'A3');

  ok('「好」+ 无历史 → 不触发', d('好').rule === null);
  ok('「好」+ 写入很久前 → 不触发',
    d('好', { recentWriteTurns: 0, turnsSinceWrite: 99, lastToolNames: ['read'] }).rule === null);
  ok('强指令不依赖历史', d('帮我改下这个函数').rule === 'A3');
}

console.log('═══ 4. 话题漂移：换话题必须退场（审查第二刺）═══');
{
  const hist = { recentWriteTurns: 2, turnsSinceWrite: 0, lastToolNames: ['write'] };
  const r = d('对了，帮我查一下唐朝的官职', hist);
  ok('「对了…查唐朝官职」+ 刚写过 → 不触发', r.rule === null, `score=${r.score.toFixed(2)}`);
  ok('漂移被识别', r.reasons.some((x) => x.includes('漂移')), r.reasons.join('/'));
  ok('「另外，说说别的」→ 不触发', d('另外，说说别的吧', hist).rule === null);
  ok('「换个话题」→ 不触发', d('换个话题', hist).rule === null);
  ok('漂移 + 强指令 → 也不触发（0.6-0.5=0.1）',
    d('对了，帮我改下这个函数', hist).rule === null, '刻意如此：说「对了」通常意味着换方向');
}

console.log('═══ 5. 其他规则：只看当前句 ═══');
{
  ok('「你打了几个字」→ A5', d('你打了几个字').rule === 'A5');
  ok('「统计一下多少行」→ A5', d('统计一下多少行').rule === 'A5');
  ok('「把那个文件删了」→ A6', d('把那个文件删了').rule === 'A6');
  ok('「不要删除」→ 不触发', d('不要删除那个文件').rule === null);
  ok('「重置 git --hard」→ A6', d('重置 git --hard').rule === 'A6');
}

console.log('═══ 6. 上下文抽取与兼容接口 ═══');
{
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: '改一下 a.js' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好' }, { type: 'tool-call', name: 'write' }] },
  ];
  const c = readContext(msgs);
  ok('抽到工具名', c.tools.includes('write'));
  ok('抽到文本', c.text.includes('改一下'));
  ok('抽到 assistant 文本', c.assistantText.includes('好'));
  ok('matchOne 认 tool-call', matchOne(RULE_CHECKS.A3, { tools: ['write'] }).hit);
  ok('scanRules 返回 A3', scanRules({ tools: ['write'] }).includes('A3'));
  ok('空输入返回 null', d('').rule === null);
}

console.log('═══ 7. 状态：跨轮存活 ═══');
{
  const st = createRadarState();
  st.hit('A3', 1);
  for (let t = 2; t <= 5; t += 1) st.tick(t, '今天天气不错');
  ok('聊 4 轮闲聊后仍活着', st.list().includes('A3'));

  const st2 = createRadarState();
  st2.hit('A3', 1);
  st2.tick(2, '搞定了');
  ok('「搞定了」立刻清空', st2.list().length === 0);

  const st3 = createRadarState();
  st3.hit('A3', 1);
  st3.tick(2, '那个变量还没改');
  ok('「那个」算续命', st3.list().includes('A3'));

  const s4 = createRadarState();
  s4.hit('A3', 1);
  const first = s4.needsInject('A3', 1);
  s4.markInjected('A3', 1);
  ok('同轮不重复注入', first && !s4.needsInject('A3', 1));
}

console.log('═══ 8. 清单渲染 ═══');
{
  const { text } = renderChecklist(['A3']);
  ok('含四条要点', text.includes('备份') && text.includes('回读'));
  ok('提到 READONLY 取证方式', text.includes('READONLY'));
  ok('没有 pointer 式「详见某文件」', !/详见|参见.*\.md/.test(text));
}

console.log('═══ 9. 冷启动：新会话第一句就要能触发（不靠历史）═══');
{
  // 2026-10-31 补：旧版 scanRules 只走 toolMatch，
  // 新会话第一句话永远返回 []，「帮我修这个 bug」全程静默。
  ok('scanRules 冷启动就要有 A3', scanRules({ userText: '帮我修一下这个 Python 脚本的 bug', toolNames: [] }).includes('A3'));
  ok('scanRules 空参数不炸', Array.isArray(scanRules({})));
  ok('冷启动「把这个函数改成 async」', d('把这个函数改成 async').rule === 'A3');
  ok('冷启动「src/app.js 里那行写错了，改一下」', d('src/app.js 里那行判断写错了，改一下').rule === 'A3');
  ok('冷启动散文不误触发', scanRules({ userText: '你能给我写一段关于秋天的散文吗？', toolNames: [] }).length === 0);
  ok('冷启动闲聊不误触发', scanRules({ userText: '今天天气不错', toolNames: [] }).length === 0);
}

console.log('═══ 10. 优先级：报数 > 改代码，高危 > 改代码，否定 > 一切 ═══');
{
  ok('「统计一下改了哪些文件」判 A5', d('统计一下改了哪些文件').rule === 'A5');
  ok('「把那个文件删了」判 A6', d('把那个文件删了').rule === 'A6');
  ok('「不要删除那个文件」判 null', d('不要删除那个文件').rule === null);
  ok('「算一下这个 bug 怎么修」不被 A5 抢走', d('算一下这个 bug 怎么修').rule === 'A3');
}

console.log('═══ 11. 特征打分：中文倒装 / 动宾乱序都要兜住（审查第一刺）═══');
{
  // 这三句是 2026-10-31 架构师点名要兜的：旧正则只认"动词在前、名词在后"
  ok('「bug 修一下」', d('bug 修一下').rule === 'A3');
  ok('「这个文件你看一眼哪里错」', d('这个文件你看一眼哪里错').rule === 'A3');
  ok('「把 app.js 的渲染逻辑抽出来」', d('把 app.js 的渲染逻辑抽出来').rule === 'A3');
  ok('「看一眼这个报错」', d('看一眼这个报错').rule === 'A3');
  ok('「把统计出来的修改结果，写到 report.md 里」仍挂 A3', d('你把统计出来的修改结果，写到 report.md 里').rules.includes('A3'));

  // 反向：分不够的绝不弹清单
  ok('「我今天心情还不错」不触发', d('我今天心情还不错').rules.length === 0);
  ok('「我觉得这不对」不触发', d('我觉得这不对').rules.length === 0);
  ok('「帮我写个周报」不触发（只有「写」= 2 分）', d('帮我写个周报').rules.length === 0);
  ok('「帮我把这段话改通顺」不触发', d('帮我把这段话改通顺').rules.length === 0);
  ok('特征分可解释', d('bug 修一下').reasons.some((x) => x.startsWith('+3')));
}

console.log('═══ 12. 复选框：A5 命中不能丢 A3（审查第二刺）═══');
{
  const r1 = d('统计一下改了哪些文件');
  ok('「统计一下改了哪些文件」主规则 A5', r1.rule === 'A5');
  ok('同一句 A3 也要挂上（不互斥）', r1.rules.includes('A3') && r1.rules.includes('A5'));
  const r2 = d('把那个文件删了');
  ok('「把那个文件删了」主规则 A6', r2.rule === 'A6');
  ok('高危时 A3 也叠着（删之前一样要备份）', r2.rules.includes('A3'));
}

console.log('═══ 13. 注入节流：连跑 3 步正常就闭嘴，只留最小清单（审查第三刺）═══');
{
  const st = createRadarState({ quietAfterSteps: 3 });
  ok('第 1 步不精简', st.noteStep(true) === false);
  ok('第 2 步不精简', st.noteStep(true) === false);
  ok('第 3 步开始精简', st.noteStep(true) === true);
  ok('出事立刻回到完整清单', st.noteStep(false) === false);

  const full = renderChecklist(['A3']).text;
  const terse = renderChecklist(['A3'], undefined, { terse: true }).text;
  ok('精简版比完整版短', terse.length < full.length / 2);
  ok('精简版保留第一条问句', terse.includes('备份'));
}

console.log('═══ 14. 降权桶：改散文别当成改代码（审查第四刺）═══');
{
  const r = d('帮我改一下这段散文，出错的地方润色一下，bug 太多');
  ok('润色 + 故障词不再误弹 A3', r.rules.length === 0);
  ok('降权理由可解释', r.reasons.some((x) => x.includes('文本润色语境')));
  ok('有路径兜底时只扣 2，仍是 A3', d('把 app.js 里那段文案改一下').rules.includes('A3'));
  ok('改 README 措辞仍是 A3', d('改一下 README.md 的措辞').rules.includes('A3'));
  ok('货真价实的排障仍要触发', d('修一下 src/app.js 的渲染 bug').rules.includes('A3'));
}

console.log('═══ 15. 清单融合：一轮最多 5 条核心问句（审查第五刺）═══');
{
  ok('A3 单独 4 条', mergeChecklists(['A3']).length === 4);
  ok('A6 单独 3 条', mergeChecklists(['A6']).length === 3);
  const both = mergeChecklists(['A6', 'A3']);
  ok('A6+A3 融合后 ≤5 条', both.length <= MAX_POINTS);
  ok('融合后不重复「备份/退路」', both.filter((p) => p.id === 'exit').length === 1);
  ok('四种全撞也不超过 5 条', mergeChecklists(['A6', 'A3', 'A5', 'A7']).length === MAX_POINTS);
  ok('空输入返回空数组', mergeChecklists([]).length === 0);
  ok('未知规则不炸', Array.isArray(mergeChecklists(['A99'])));

  const text = renderChecklist(['A6', 'A3']).text;
  ok('渲染出来的问句编号不超过 5', (text.match(/^\d+\. /gm) || []).length <= MAX_POINTS);
  ok('渲染仍带 READONLY 提示', text.includes('READONLY'));
}

console.log('═══ 16. terse 由「有没有出事」驱动，不看步数（审查第六刺）═══');
{
  const st = createRadarState({ calmAfterSteps: 3 });
  ok('连跑 3 步 normal → 精简', [st.noteStep(true), st.noteStep(true), st.noteStep(true)].pop() === true);
  ok('工具报错立刻退出精简', st.noteStep({ hadToolError: true }) === false && st.isTerse() === false);

  st.noteStep(true); st.noteStep(true); st.noteStep(true);
  ok('恢复后再连跑 3 步回到精简', st.isTerse() === true);
  ok('语法错误立刻退出精简', st.noteStep({ hadSyntaxError: true }) === false);

  st.noteStep(true); st.noteStep(true); st.noteStep(true);
  ok('被 deny 立刻退出精简', st.noteStep({ denied: true }) === false);

  st.noteStep(true); st.noteStep(true); st.noteStep(true);
  ok('非 0 退出码立刻退出精简', st.noteStep({ exitCode: 1 }) === false);

  st.noteStep(true); st.noteStep(true); st.noteStep(true);
  ok('fail() 直接踢出精简', st.fail() === false);
}

console.log(`\n合计：✅ ${pass} ｜ ❌ ${fail}`);
process.exit(fail === 0 ? 0 : 2);
