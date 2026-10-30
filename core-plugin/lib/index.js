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
import { createRadarState, renderChecklist, scanRulesDetailed } from './rules-radar.js';
import {
  a3Passed, checkA3Format, classifyCommand, classifyTool, createBreaker,
  DEFAULT_EXECUTORS, denyReason, DEPRECATED_READONLY_RE, extractCommand,
  nonReadonlyReason, normalizeToolName, readAssistantText, readonlyDeprecatedReason,
  revokeNotice, unknownCommandReason,
} from './rules-enforce.js';

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

/**
 * 工具结果的「出事了」判据。
 * 只认能证伪的证据，不猜：非 0 退出码 / 明确的错误类型 / 权限或缺失。
 */
const BAD_RESULT_RE = /\[exit code: [1-9]\d*\]|^\s*(?:Syntax|Type|Reference|Range|URI)?Error:|ENOENT|EPERM|EACCES|文件不存在/i;

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

  /* 雷达状态：铁律① —— 只 new 一次（每次 new 就是每次重置，精简模式永远不生效） */
  const radarState = conf.radar
    ? createRadarState({ calmAfterSteps: conf.radarCalmSteps })
    : null;
  /** 最近几轮调过的工具名，给雷达当"历史惯性"用 */
  const recentTools = [];
  /** A3 熔断：conf.enforce 默认 false，所以这条通常是 null（不注册拦截钩子） */
  const breaker = conf.enforce === true ? createBreaker({ limit: conf.enforceLimit }) : null;
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

      /* ── ①·B 动态规则路由：这一轮该把哪条细则拍在它脸上 ──
       * 命中了就往 body 里叠清单；雷达自己崩了只记警报，绝不影响对话。 */
      if (radarState && userText) {
        try {
          const det = scanRulesDetailed({ userText, toolNames: recentTools });
          const ids = det.ids || [];
          if (ids.length) {
            const terse = conf.radarTerse && radarState.isTerse();
            const rendered = renderChecklist(ids, undefined, {
              terse,
              maxPoints: conf.radarMaxPoints,
            });
            if (rendered.text) {
              body += `\n\n${rendered.text}`;
              for (const id of ids) radarState.markInjected(id, step);
            }
            alarm.trace(
              `radar ids=${ids.join('+')} score=${det.intent?.score} terse=${terse} points=${rendered.points} why=${(det.intent?.reasons || []).join(',')}`,
            );
          } else {
            alarm.trace(`radar none score=${det.intent?.score} why=${(det.intent?.reasons || []).join(',')}`);
          }
        } catch (e) {
          alarm.noteError('pre-step:radar', e);
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

  /* ── ③ 雷达的痛觉：工具出错 → 立刻退出精简模式 ────────────
   * 判据是「有没有出事」，不是「跑了几步」。
   * 独立的 session/event 钩子，不吃 conf.distill 的开关。 */
  if (radarState) {
    ctx.on('session/event', (session, event) => {
      try {
        if (event?.type === 'tool/call') {
          const n = String(event?.data?.name || '').toLowerCase();
          if (n) {
            recentTools.push(n);
            if (recentTools.length > 8) recentTools.shift();
          }
          return;
        }
        if (event?.type !== 'tool/result') return;
        const parts = event?.data?.message?.content ?? [];
        const txt = parts.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
        const bad = BAD_RESULT_RE.test(txt);
        radarState.noteStep({ ok: !bad });
        if (bad) alarm.trace(`radar 痛觉触发：工具结果像失败，退出精简 terse=${radarState.isTerse()}`);
      } catch (e) {
        alarm.noteError('session/event:radar', e);
      }
    });
    alarm.trace('registered session/event radar-pain');
  }

  /* ── ④ 物理拦截：写工具执行前先看模型答没答 A3 清单 ────────
   *
   * 🔴 **默认关闭**（conf.enforce = false）。
   * 2026-10-31 实机教训：开着它的时候，备份（Copy-Item）、改文件、连重启都被拒，
   * 「答满清单就放行」这条根本没实现 —— 笼子把开锁的钥匙也锁在里面了。
   *
   * 现在的分级（打开后才会用）：
   *   ① safe    已知只读前缀 / 插件体检查命令 → 直接放行，不计数
   *   ② unknown 不在白名单也不危险 → 答满 A3 清单放行
   *   ③ danger  带 ; | > && rm del → 答满清单也放行；只有用废弃 READONLY: 口令的才硬拦
   */
  if (breaker !== null) {
    try {
      ctx.on('tools/pre-execute', async (exec, next) => {
        const decision = await next();
        if (decision?.kind !== 'allow') return decision; // 别人已经拒了/取消了，不抢
        try {
          const toolName = normalizeToolName(exec?.name);
          const executorSet = (Array.isArray(conf.executors) ? conf.executors : DEFAULT_EXECUTORS).map(normalizeToolName);
          const isExecutor = executorSet.includes(toolName);
          const cmd = isExecutor ? extractCommand(exec?.arguments) : '';

          if (!isExecutor) {
            const kind = classifyTool(exec?.name, exec?.arguments, {
              readOnlyTools: Array.isArray(conf.readOnlyTools) ? conf.readOnlyTools : undefined,
              customWriteTools: Array.isArray(conf.customWriteTools) ? conf.customWriteTools : undefined,
              executors: Array.isArray(conf.executors) ? conf.executors : undefined,
            });
            if (kind === 'readonly') return decision;
          } else {
            const verdict = classifyCommand(cmd, { safeReadonlyPrefixes: conf.safeReadonlyPrefixes });
            if (verdict === 'safe') {
              alarm.trace(`enforce fast-path tool=${exec?.name ?? "?"} cmd=${String(cmd).slice(0, 80)}`);
              return decision;
            }
            if (verdict === 'danger' && DEPRECATED_READONLY_RE.test(String(cmd))) {
              alarm.trace(`enforce DENY(deprecated) tool=${exec?.name ?? "?"}`);
              return { kind: "deny", reason: readonlyDeprecatedReason(exec?.name ?? "tool") };
            }
            if (verdict === 'danger') {
              alarm.trace(`enforce danger-cmd tool=${exec?.name ?? "?"} → 退回 A3 清单`);
            }
          }

          const session = exec?.agent?.session;
          const said = readAssistantText(session);
          // null = 读不到（接口缺失/异常）→ 放行，不许猜
          if (said === null || said === undefined || said === "") return decision;
          if (a3Passed(said)) return decision;

          const info = checkA3Format(said);
          const st = breaker.deny(session, 'A3');
          if (st.revoked === true) {
            alarm.noteError("enforce:revoke", new Error(`A3 连续 ${st.count} 次未答，写入权限已回收：${exec?.name ?? "?"}`));
            return { kind: "deny", reason: revokeNotice(exec?.name ?? "tool", st.count) };
          }
          const isUnknownCmd = isExecutor && classifyCommand(cmd, { safeReadonlyPrefixes: conf.safeReadonlyPrefixes }) === "unknown";
          const base = denyReason(info, exec?.name ?? "tool");
          return {
            kind: "deny",
            reason: isUnknownCmd ? unknownCommandReason(exec?.name ?? "tool", cmd) + "\n\n" + base : base,
          };
        } catch (e) {
          // 拦截器自己崩了 → 记警报 + 放行（绝不因为自己坏了而卡死工具）
          alarm.noteError("pre-execute:enforce", e);
          return decision;
        }
      });
      alarm.trace('enforce tools/pre-execute registered');
    } catch (e) {
      alarm.noteError("enforce:register", e);
    }
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
  BAD_RESULT_RE,
};
