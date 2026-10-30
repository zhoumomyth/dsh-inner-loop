// 5 秒熔断冒烟测试：不只是 import，而是真的把 apply() 跑一遍、把 pre-step 走一遍。
// 跑法：node tests/smoke.mjs   （退出码 0 = 通过；9 = 超时；2 = 断言失败）
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const timer = setTimeout(() => {
  console.error('❌ 熔断：5 秒内没跑完');
  process.exit(9);
}, 5000);

let pass = 0;
let fail = 0;
const ok = (name, cond) => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}`); }
};

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-il-smoke-'));

try {
  const mod = await import('../core-plugin/lib/index.js');
  ok('index.js 能 import', typeof mod.apply === 'function');
  ok('导出了 rules-radar 依赖的函数', typeof mod.__test__?.BAD_RESULT_RE?.test === 'function');

  const handlers = { 'agent/pre-step': [], 'session/event': [] };
  const ctx = {
    on(n, fn) { (handlers[n] ||= []).push(fn); },
    logger: () => ({ debug() {} }),
  };

  mod.apply(ctx, {
    enabled: true,
    retrieve: false,
    distill: false,
    dshHome: tmpHome,
  });

  ok('注册了 agent/pre-step', handlers['agent/pre-step'].length === 1);
  ok('注册了 session/event（雷达痛觉）', handlers['session/event'].length === 1);

  // ── 真跑一轮 pre-step：冷启动第一句就该挂 A3 清单 ──
  const decision = {
    messages: [{ role: 'user', content: [{ type: 'text', text: '帮我修一下 src/app.js 的渲染 bug' }] }],
  };
  const next = async () => decision;
  const out = await handlers['agent/pre-step'][0]({ step: 1, signal: {}, agent: { id: 'smoke-sess' } }, next);

  const injected = out?.messages?.[out.messages.length - 1];
  const text = (injected?.content || []).filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
  ok('注入消息确实追加了', out.messages.length === 2);
  ok('带上了自检块', text.includes('【内循环自检'));
  ok('冷启动就挂上 A3 清单', text.includes('【本轮触发 A3'));
  // 注意：自检块自己也有「1. 2. 3.」，数编号必须先切出雷达清单那一段
  const radarSeg = text.slice(text.indexOf('【本轮触发'));
  ok('清单问句不超过 5 条', ((radarSeg.match(/^\d+\. /gm) || []).length) <= 5);
  ok('清单问句至少 1 条', ((radarSeg.match(/^\d+\. /gm) || []).length) >= 1);
  ok('带 READONLY 取证提示', text.includes('READONLY'));

  // ── 不该触发的句子不注入清单 ──
  const d2 = {
    messages: [{ role: 'user', content: [{ type: 'text', text: '帮我写一段关于秋天的散文' }] }],
  };
  const out2 = await handlers['agent/pre-step'][0]({ step: 1, signal: {}, agent: { id: 'smoke-sess' } }, async () => d2);
  const t2 = (out2?.messages?.[out2.messages.length - 1]?.content || []).filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
  ok('散文不挂清单', !t2.includes('【本轮触发'));

  // ── 痛觉：坏的工具结果不炸，好的一样 ──
  const ev = handlers['session/event'][0];
  let threw = false;
  try {
    ev({ id: 'smoke-sess' }, { type: 'tool/call', data: { name: 'pwsh' } });
    ev({ id: 'smoke-sess' }, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '[exit code: 1]' }] } } });
    ev({ id: 'smoke-sess' }, { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'ok' }] } } });
    ev({ id: 'smoke-sess' }, { type: 'turn/end', data: {} });
  } catch (e) {
    threw = true;
    console.log('    ', e?.message);
  }
  ok('session/event 各种事件都不抛', !threw);

  // ── enforce：**默认关**，打开才拦（代码留着，开关在 config）──
  ok('默认不注册拦截钩子（enforce=false）', (handlers['tools/pre-execute'] || []).length === 0);
  {
    const H2 = { 'agent/pre-step': [], 'tools/pre-execute': [], 'session/event': [] };
    const ctx2 = { on(n, fn) { (H2[n] ||= []).push(fn); }, logger: () => ({ debug() {} }) };
    mod.apply(ctx2, { enabled: true, retrieve: false, distill: false, enforce: true });
    ok('打开 enforce 后注册了拦截钩子', H2['tools/pre-execute'].length === 1);

    // 真拦一次：写工具 + 模型没答清单 → deny
    const ex2 = H2['tools/pre-execute'][0];
    if (ex2) {
      const r = await ex2({ name: 'write', arguments: {}, agent: { session: { id: 'smoke2', snapshotEvents: () => [] } }, signal: {} }, async () => ({ kind: 'allow' }));
      ok('打开后读不到模型的话 → 放行（不猜）', r.kind === 'allow');
      const s2 = { id: 'smoke2', snapshotEvents: () => [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我改一下' }] } } }] };
      const r2 = await ex2({ name: 'write', arguments: {}, agent: { session: s2 }, signal: {} }, async () => ({ kind: 'allow' }));
      ok('打开后没答清单 → deny', r2.kind === 'deny');
    }
  }

  // ── 二次 apply 不炸（幂等性） ──
  let threw2 = false;
  try {
    mod.apply({ on() {}, logger: () => ({ debug() {} }) }, { enabled: true, retrieve: false, distill: false, dshHome: tmpHome });
  } catch { threw2 = true; }
  ok('重复 apply 不抛', !threw2);
} catch (e) {
  fail += 1;
  console.log(`  ❌ 顶层异常：${e?.message}`);
  console.log(e?.stack?.split('\n').slice(0, 6).join('\n'));
} finally {
  clearTimeout(timer);
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n冒烟：✅ ${pass} ｜ ❌ ${fail}`);
process.exit(fail === 0 ? 0 : 2);
