// retrieve.js 的纯函数单测 —— 不碰文件系统、不碰 DSH
// 跑法：node tests/retrieve.test.mjs
import {
  scoreEntry, overlapRatio, rankEntries, resolveConflicts, formatHit, createRetriever,
} from '../core-plugin/lib/retrieve.js';
import { bigrams } from '../core-plugin/lib/index-store.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n      got : ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`); }
};
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  — ' + extra : ''}`); }
};

const mk = (body, { date = '2026-10-30', scope = 'default', type = '结论' } = {}) => ({
  body, date, scope, type, keywords: [], src: '', grams: bigrams(body),
});

console.log('═══ 1. scoreEntry ═══');
const e1 = mk('报数之前必须调工具算');
// 手算依据：e1 的二组 = 报数/数之/之前/前必/必须/须调/调工/工具/具算
//           query   = 报数/数必/必须/须工/工具
//           交集    = 报数/必须/工具 → 3
eq('命中共有二字组数量', scoreEntry(e1, bigrams('报数必须工具')), 3);
eq('完全无关 → 0', scoreEntry(e1, bigrams('天气不错')), 0);
eq('空查询 → 0', scoreEntry(e1, new Set()), 0);

console.log('═══ 2. overlapRatio ═══');
ok('同一句话 = 1', overlapRatio('不许自己设上限', '不许自己设上限') === 1);
ok('完全无关 = 0', overlapRatio('不许自己设上限', '今天天气很好') < 0.2, String(overlapRatio('不许自己设上限','今天天气很好').toFixed(2)));
ok('部分重叠介于 0 和 1', (() => { const r = overlapRatio('不许自己给东西设上限', '不许自己设上限'); return r > 0.5 && r < 1; })());

console.log('═══ 3. rankEntries ═══');
const entries = [
  mk('报数之前必须调工具算', { date: '2026-10-30' }),
  mk('报数之前必须调工具算清楚', { date: '2026-10-29' }),
  mk('今天天气不错', { date: '2026-10-30' }),
  mk('别的会话里的记忆', { date: '2026-10-30', scope: 'other' }),
  mk('全局都能看见的东西', { date: '2026-10-30', scope: 'global' }),
];
const q = bigrams('报数必须工具');
const r1 = rankEntries(entries, q, { minHits: 2, currentScope: 'default' });
ok('过滤掉不相干', r1.every((x) => !x.entry.body.includes('天气')));
ok('过滤掉别的作用域', r1.every((x) => x.entry.scope !== 'other'));
ok('同分时新日期在前', r1[0].entry.date === '2026-10-30', r1.map((x) => x.entry.date).join(','));
eq('minHits 放宽到 1 会多命中', rankEntries(entries, q, { minHits: 1, currentScope: 'default' }).length >= r1.length, true);
ok('scope 判据可注入', rankEntries(entries, q, { minHits: 1, currentScope: 'default', isVisible: () => true }).length >= r1.length);

console.log('═══ 4. resolveConflicts ═══');
const conflict = [
  { entry: mk('不许自己给东西设上限', { date: '2026-10-29', type: '原则' }), hits: 5 },
  { entry: mk('不许自己给东西设上限，一律先问', { date: '2026-10-30', type: '原则' }), hits: 4 },
  { entry: mk('报数之前必须调工具算', { date: '2026-10-30', type: '结论' }), hits: 3 },
];
const rc = resolveConflicts(conflict);
eq('同主题原则只留一条', rc.kept.filter((x) => x.entry.type === '原则').length, 1);
eq('留下的是新日期那条', rc.kept.find((x) => x.entry.type === '原则').entry.date, '2026-10-30');
eq('被取代的记下来了', rc.superseded.length, 1);
eq('结论条不受影响', rc.kept.filter((x) => x.entry.type === '结论').length, 1);

console.log('═══ 5. formatHit ═══');
eq('渲染格式', formatHit(mk('测试正文'), 3), '- [2026-10-30] 测试正文（命中 3）');
eq('原则带标签', formatHit(mk('规矩', { type: '原则' }), 2), '- [2026-10-30] [原则]规矩（命中 2）');

console.log('═══ 6. createRetriever 端到端（假 store / 假 scope）═══');
const fakeStore = { read: () => ({ ok: true, entries, errors: [] }) };
const fakeScope = { resolve: async () => 'default', visible: (a, b) => a === 'global' || a === b };
const conf = { retrieveTopN: 3, retrieveMinHits: 2 };
const ret = createRetriever({ store: fakeStore, scope: fakeScope, conf, trace: () => {} });
const out = await ret.retrieve('报数必须工具', 'session-1');
ok('返回结构完整', ['ok', 'lines', 'hits', 'superseded', 'errors', 'degraded'].every((k) => k in out));
ok('有命中', out.hits > 0, out.hits + ' 条');
ok('未降级', out.degraded === false);
ok('topN 生效', out.lines.length <= 3);

console.log('═══ 7. 降级：数据源坏了必须标出来 ═══');
const brokenStore = { read: () => ({ ok: false, entries: [], errors: [{ where: 'index-store:read', message: 'EACCES' }] }) };
const ret2 = createRetriever({ store: brokenStore, scope: fakeScope, conf, trace: () => {} });
const out2 = await ret2.retrieve('随便什么', 'session-1');
ok('degraded=true（不是"没命中"）', out2.degraded === true);
ok('错误透传上来', out2.errors.length === 1 && out2.errors[0].message === 'EACCES');
ok('lines 为空但 ok 仍为 true（检索本身没抛）', out2.lines.length === 0 && out2.ok === true);

console.log(`\n合计：✅ ${pass} ｜ ❌ ${fail}`);
process.exit(fail === 0 ? 0 : 2);
