/**
 * index.js —— 入口。只有它负责「装配」和「挂钩子」，其余文件都是零件。
 *
 * 三条铁律（都有对应的测试）：
 *   ① **工厂只 new 一次**：scope / store / retriever / distiller 全部在 apply() 里建一次，
 *      之后每轮复用。否则 scope 的缓存永远失效，「多入口」场景会退化成单入口。
 *   ② **降级要说出来**：检索降级（degraded）时，注入里必须带一句「本轮记忆检索降级，原因…」。
 *      不许让模型以为「没有相关记忆」，那是撒谎。
 *   ③ **装配失败安全退出**：resolveConfig 抛错、依赖缺失 → 打一行 stderr 然后 return，
 *      绝不让异常冲出 apply() 把宿主带崩。
 */
import { resolveConfig } from './config.js';
import { createAlarm } from './alarm.js';
import { createScopeResolver } from './scope.js';
import { createIndexStore } from './index-store.js';
import { createRetriever } from './retrieve.js';
import { createDistiller, looksLikeToolDump } from './distill.js';

export const name = 'dsh-inner-loop';

/** 我们依赖宿主提供 systemPrompt 服务；声明它以拿到注入时机。 */
export const inject = ['systemPrompt'];

/** 默认注入的自检四句（可以用 conf.selfCheckText 整体替换） */
const DEFAULT_CHECK_TEXT = `【内循环自检 · 每步一次，不输出给对方】
1. 这件事需要历史信息吗？需要 → 先查索引，命中再读细则。
2. 这是什么类型？创作 / 事实 / 操作 / 闲聊。
3. 手上的信息够吗？不够就说「我需要先查」，不许硬编。
4. 这是新问题，还是旧原则没执行？`;

const MARKER = '【内循环自检';

export function buildReminder(text) {
  return `<system-reminder>\n${text}\n</system-reminder>`;
}

export function fallbackUserMessage(text, sectionName, pluginName = name) {
  return {
    role: 'user',
    id: `${pluginName}-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`,
    content: [{ type: 'text', text }],
    source: {
      kind: `plugin:${pluginName}`,
      plugin: pluginName,
      form: 'snapshot',
      sections: [{ name: sectionName, text }],
    },
  };
}

/**
 * 可选依赖：宿主提供 @deepseek-ai/dsh-llm 时用它构造标准消息，
 * 没有就用 fallback —— **降级不是故障**，是设计。
 */
async function loadMessageFactory() {
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    return typeof mod.createUserMessage === 'function' ? mod.createUserMessage : undefined;
  } catch {
    return undefined;
  }
}

export function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    const text = parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n').trim();
    if (text) return text;
  }
  return '';
}

export function alreadyInjected(messages, marker = MARKER) {
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (m) => Array.isArray(m?.content) && m.content.some((p) => p?.type === 'text' && typeof p.text === 'string' && p.text.includes(marker)),
  );
}

/* ── 测试可见的内部状态 ── */
let __scopeCreateCount = 0;
let __retriever = null;
let __distiller = null;
let __conf = null;

export function apply(ctx, rawConfig = {}) {
  /* 铁律③：装配失败安全退出 —— 这一步之前什么都还没注册，退出就是干净的。 */
  let conf;
  try {
    conf = resolveConfig(rawConfig);
  } catch (e) {
    try { process.stderr.write(`[${name}] 配置解析失败，插件未启用：${e?.message}\n`); } catch { /* ignore */ }
    return;
  }
  if (!conf.enabled) {
    try { process.stderr.write(`[${name}] enabled=false，插件未启用\n`); } catch { /* ignore */ }
    return;
  }

  let alarm;
  let resolver;
  let store;
  let retriever;
  let distiller;
  try {
    alarm = createAlarm({
      traceFile: conf.traceFile,
      alarmFile: conf.alarmFile,
      throttleMs: conf.alarmThrottleMs,
      maxEntries: conf.alarmMaxEntries,
    });
    /* 铁律①：工厂只 new 一次。计数器让这件事可被测试验证。 */
    __scopeCreateCount += 1;
    resolver = createScopeResolver({
      defaultScope: conf.defaultScope,
      globalScope: conf.globalScope,
      provider: conf.scopeProvider,
      trace: alarm.trace,
    });
    store = createIndexStore({
      indexFile: conf.indexFile,
      fragmentDir: conf.fragmentDir,
      trace: alarm.trace,
      noteError: alarm.noteError,
    });
    retriever = createRetriever({ store, scope: resolver, conf, trace: alarm.trace });
    distiller = createDistiller({ conf, alarm, scope: resolver });
  } catch (e) {
    try { process.stderr.write(`[${name}] 装配失败，插件未启用：${e?.message}\n`); } catch { /* ignore */ }
    return;
  }

  __retriever = retriever;
  __distiller = distiller;
  __conf = conf;
  alarm.trace(`apply ok enabled=${conf.enabled} topN=${retriever.topN} minHits=${retriever.minHits}`);
  const log = (...args) => {
    try { ctx.logger?.(name)?.debug?.(...args); } catch { /* 宿主 logger 不可用不影响对话 */ }
  };

  /* ── ① 每轮第一步：注入自检 + 检索结果 ───────────────── */
  ctx.on(
    'agent/pre-step',
    async ({ step, signal, agent }, next) => {
      const decision = await next();
      if (decision?.kind === 'reject' || signal?.aborted === true) return decision;
      if (step !== 1) return decision;
      if (alreadyInjected(decision.messages, MARKER)) return decision;

      const userText = lastUserText(decision.messages);
      const sid = String(agent?.id ?? 'session');
      const scopeName = await resolver.resolve(sid);

      let body = String(conf.selfCheckText || DEFAULT_CHECK_TEXT);

      if (conf.retrieve && userText) {
        try {
          const r = await retriever.retrieve(userText, sid);
          if (r.hits > 0) {
            body += `\n\n【本作用域(${scopeName}) 命中 ${r.hits} 条】\n${r.lines.join('\n')}`;
          }
          /* 铁律②：降级必须说出来，不许装没事 */
          if (r.degraded) {
            const why = r.errors.map((e) => `${e.where}: ${e.message}`).join('; ').slice(0, 240);
            body += `\n\n[系统提示：本轮记忆检索降级，可能无法获取完整历史，原因：${why || '数据源不可用'}]`;
            alarm.trace(`inject degraded sid=${sid} why=${why}`);
          }
          alarm.trace(`retrieve scope=${scopeName} hits=${r.hits} degraded=${r.degraded} superseded=${r.superseded}`);
        } catch (e) {
          /* 检索自己崩了 → 也要让模型知道，而不是静默给个空 */
          alarm.noteError('pre-step:retrieve', e);
          body += '\n\n[系统提示：本轮记忆检索出错，可能无法获取完整历史，原因：检索组件异常]';
        }
      }

      const text = buildReminder(body);
      let injected;
      const create = await loadMessageFactory();
      if (typeof create === 'function') {
        injected = create({
          content: [{ type: 'text', text }],
          source: { kind: `plugin:${name}`, plugin: name, form: 'snapshot', sections: [{ name: conf.sectionName ?? 'inner-loop', text: body }] },
        });
      } else {
        alarm.trace('loadMessageFactory 不可用，走 fallback 消息构造');
        injected = fallbackUserMessage(text, conf.sectionName ?? 'inner-loop', name);
      }
      return { ...decision, messages: [...decision.messages, injected] };
    },
    { prepend: true },
  );
  alarm.trace('registered agent/pre-step');

  /* ── ② 沉淀：攒回答 → turn/end 落账 ────────────────── */
  if (conf.distill) {
    const answerBuf = new Map();

    ctx.on('session/event', (session, event) => {
      try {
        const sid = String(session?.id ?? event?.sessionId ?? 'session');

        if (event?.type === 'turn/start') {
          answerBuf.delete(sid); // 防上一轮异常结束留下的死缓存
          return;
        }

        if (event?.type === 'assistant/message') {
          const parts = event?.data?.message?.content ?? [];
          const text = parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n').trim();
          if (text && !looksLikeToolDump(text)) answerBuf.set(sid, { text, at: Date.now() });
          // 过期的先清（连开几天内存里全是死会话）
          const cutoff = Date.now() - 10 * 60 * 1000;
          for (const [k, v] of answerBuf) if (!v || v.at < cutoff) answerBuf.delete(k);
          return;
        }

        if (event?.type !== 'turn/end') return;

        const buffered = answerBuf.get(sid);
        answerBuf.delete(sid);
        const reason = typeof event?.data?.reason?.kind === 'string' ? event.data.reason.kind : 'unknown';

        retriever /* 仅用于保持引用，避免被 gc 优化掉 */;
        resolver.resolve(sid).then((scopeName) => {
          const out = distiller.distill({
            scopeName,
            ask: '',
            answer: buffered?.text ?? '',
            turnId: String(event?.data?.turn ?? ''),
            reason,
          });
          alarm.trace(`distill scope=${scopeName} reason=${reason} indexed=${out.indexed} skip=${out.reason}`);
          log('distill', out);
        }).catch((e) => alarm.noteError('distill:scope', e));
      } catch (e) {
        alarm.noteError('session/event', e);
      }
    });
    alarm.trace('registered session/event distiller');
  }

  log('inner-loop ready');
  alarm.trace('ready');
}

export { Config } from './config.js';

/* ── 测试入口：不许在生产代码里用 ── */
export const __test__ = {
  getScopeCreateCount: () => __scopeCreateCount,
  resetScopeCreateCount: () => { __scopeCreateCount = 0; },
  getRetriever: () => __retriever,
  getDistiller: () => __distiller,
  getConfig: () => __conf,
  buildReminder,
  fallbackUserMessage,
  lastUserText,
  alreadyInjected,
};
