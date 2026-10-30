/**
 * distill.js —— 把「这一轮发生了什么」抽成一条能进账本的结论。
 *
 * 依赖：index-store.js（分词）+ 传入的 alarm / scope / conf。**不 import config.js**。
 *
 * 这一环最容易写脏，因为「要不要记」是个判断，而判断最容易悄悄错。
 * 所以三道闸全部做成纯函数，每条都有单测：
 *
 *   闸 ①  防污染  纯 JSON / tool_calls / 代码块 → 不算内容，只写流水
 *   闸 ②  防废话  纯应答（"好的"）、客套尾（"希望这能帮到你"）、过渡句（"我去查"）一律不算
 *   闸 ③  防悄悄截断  配了 maxAnswerChars 就得切，但**切了必须留 … 并 trace 一笔**
 *
 * 设计底线：**它宁可少记一条，也不记一条假的。**
 * 账本里出现一条编出来的结论，比账本少一条严重得多。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bigrams } from './index-store.js';
import { stamp } from './alarm.js';

/* ── 闸 ①：这段文本是"工具输出/JSON"，不是人话 ── */
const TOOL_DUMP_RE = /^[\[{]\s*["']?(type|tool_call|tool_calls|tool_result|call_id|function|arguments|content)["']?\s*[:}]/;
const TOOL_MARKERS = /"tool_calls"|"tool_call_id"|"function_call"|"arguments"\s*:/;

export function looksLikeToolDump(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (TOOL_DUMP_RE.test(t)) return true;
  if (TOOL_MARKERS.test(t)) return true;
  return false;
}

/* ── 闸 ②：废话与纯应答 ── */
const ACK_RE = /^(好的|好|行|嗯+|哦+|收到|明白|了解|可以|没问题|ok|okay|sure|got it|知道了)[\s，,。.!！~～:：、\-]*$/i;
const POLITE_RE = /(希望这?能帮到你|随时告诉我|有问题随时|还想要什么|要不要我|需要我再说|祝你好运|祝顺利|希望能帮上|如需|请随时|我随时)/;
const TRANSITION_RE = /^(在呢|我去查|我查一下|这个我得看看|我先看|我去看|等我看|稍等|马上|这就去|我看看)/;
const MARKED_RE = /(?:注意|警告|结论|重点|关键|前提|风险)\s*[：:]\s*([^\n。！!；;]{8,80})/;

export function stripNoise(text) {
  let s = String(text || '').trim();
  s = s.replace(/^(好的|收到|明白|了解|可以|没问题)[\s，,。.!！~～:：、\-]*/i, '');
  s = s.replace(POLITE_RE, '');
  return s.trim();
}

export function isPureAck(text) {
  return ACK_RE.test(String(text || '').trim());
}

/* ── 闸 ③：截断必须留痕 ── */
/**
 * @param {string} text
 * @param {number} max  0 = 不截断
 * @returns {{text:string, truncated:boolean, originalLength:number}}
 */
export function clipText(text, max) {
  const s = String(text ?? '');
  const limit = Number(max) || 0;
  if (limit <= 0 || s.length <= limit) return { text: s, truncated: false, originalLength: s.length };
  return { text: `${s.slice(0, limit)}…`, truncated: true, originalLength: s.length };
}

/* ── 抽结论 ── */
/**
 * 从一段回答里抽出「这一轮学到了什么」。
 * 抽不出来就返回空串 —— **空串是合法结果**，代表"这轮没有值得进账本的结论"。
 */
export function extractConclusion(answer, { maxChars = 0 } = {}) {
  const raw = String(answer || '')
    .replace(/```[\s\S]*?```/g, ' ') // 代码块不是结论
    .trim();
  if (!raw) return '';

  // ① 有显式标记就先信标记
  const marked = raw.match(MARKED_RE);
  if (marked) {
    const s = stripNoise(marked[1]);
    if (s.length >= 8) return clipText(s, maxChars).text;
  }

  // ② 逐句筛
  const parts = raw.split(/\n+|(?<=[。！!；;])/).map((x) => x.trim()).filter(Boolean);
  const usable = (part) => {
    const s = stripNoise(part);
    if (!s) return '';
    if (isPureAck(s)) return '';
    if (s.length < 8) return '';
    if (/[？?]$/.test(s)) return ''; // 问句不是结论
    if (TRANSITION_RE.test(s)) return '';
    return s;
  };

  // ③ 短回答整段用
  if (raw.length <= 160) {
    const kept = parts.map(usable).filter(Boolean);
    if (kept.length > 0) return clipText(kept.join(' ').slice(0, 120), maxChars).text;
  }

  // ④ 长回答取第一句 + 尾句
  let head = '';
  for (const p of parts) { head = usable(p); if (head) break; }
  let tail = '';
  if (raw.length > 400) {
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const t = usable(parts[i]);
      if (t && t !== head) { tail = t; break; }
    }
  }
  if (head && tail) return clipText(`${head} … ${tail}`.slice(0, 200), maxChars).text;
  return clipText(head, maxChars).text;
}

/* ── 判重 ── */
/**
 * 这条结论是不是已经记过了。
 * 刻意**很保守**：只挡「几乎逐字一样」的。宁可账本多一行，也不能丢一条改口的命令。
 * @returns {boolean}
 */
export function isDuplicate(a, b, { threshold = 0.95, minCommon = 12 } = {}) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return false;
  let common = 0;
  for (const g of A) if (B.has(g)) common += 1;
  if (common < minCommon) return false;
  return common / Math.min(A.size, B.size) >= threshold;
}

/* ── 工厂 ── */
/**
 * @param {object} opts
 * @param {object} opts.conf      resolve 后的配置
 * @param {object} opts.alarm     alarm 实例（trace / noteError）
 * @param {object} opts.scope     scope 实例（safeDir）
 * @param {(line:string)=>boolean} [opts.isDuplicateLine]  可选：拿现有账本行判重
 */
export function createDistiller({ conf, alarm, scope, isDuplicateLine } = {}) {
  const eventsDir = conf?.eventsDir;
  const maxAnswer = Number(conf?.maxAnswerChars) || 0;
  const maxAsk = Number(conf?.maxAskChars) || 0;
  const maxPrinciple = Number(conf?.principleMaxChars) || 0;

  function writeEvent(scopeName, record) {
    if (!eventsDir) return false;
    try {
      const dir = join(eventsDir, scope.safeDir(scopeName));
      mkdirSync(dir, { recursive: true });
      const day = stamp().slice(0, 10);
      appendFileSync(join(dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
      return true;
    } catch (e) {
      alarm.noteError('distill:writeEvent', e);
      return false;
    }
  }

  /**
   * @param {object} input
   * @param {string} input.scopeName
   * @param {string} input.ask
   * @param {string} input.answer
   * @param {string} input.turnId
   * @param {string} [input.reason]
   * @returns {{eventWritten:boolean, indexed:boolean, duplicate:boolean, reason:string, conclusion:string}}
   */
  function distill({ scopeName, ask, answer, turnId, reason = 'unknown' }) {
    const askClip = clipText(String(ask ?? ''), maxAsk);
    const ansClip = clipText(String(answer ?? ''), maxAnswer);
    if (askClip.truncated) alarm.trace(`distill 截断 ask: ${askClip.originalLength} → ${askClip.text.length}`);
    if (ansClip.truncated) alarm.trace(`distill 截断 answer: ${ansClip.originalLength} → ${ansClip.text.length}`);

    const record = {
      at: stamp(),
      scope: scopeName,
      turn: turnId,
      reason,
      ask: askClip.text,
      answer: ansClip.text,
      // 让读日志的人知道这条被切过 —— 悄悄吃掉关键信息是最难查的故障
      truncated: { ask: askClip.truncated, answer: ansClip.truncated },
    };

    // 闸 ①：工具输出 / JSON 一律不进账本
    if (looksLikeToolDump(ansClip.text)) {
      record.distilled = false;
      record.skip = 'tool-dump';
      const wrote = writeEvent(scopeName, record);
      return { eventWritten: wrote, indexed: false, duplicate: false, reason: 'tool-dump', conclusion: '' };
    }

    const principle = isPureAck(askClip.text) ? false : /(以后|今后|下次|不许|不准|不要再用|别再用|一律|默认|记住|定下来|统一用|禁止|永远)/.test(String(askClip.text || '').slice(0, 30));

    let conclusion = '';
    if (principle) {
      // 用户立规矩 → 直接把原话当原则（不抽，避免改写他的语气）
      conclusion = clipText(stripNoise(askClip.text), maxPrinciple).text;
    } else {
      conclusion = extractConclusion(ansClip.text, { maxChars: 0 }); // 结论本身不做长度截断，只在入账时再说
    }

    if (!conclusion) {
      record.distilled = false;
      record.skip = 'no-conclusion';
      const wrote = writeEvent(scopeName, record);
      return { eventWritten: wrote, indexed: false, duplicate: false, reason: 'no-conclusion', conclusion: '' };
    }

    if (isDuplicateLine && isDuplicateLine(conclusion)) {
      record.distilled = true;
      record.duplicate = true;
      const wrote = writeEvent(scopeName, record);
      return { eventWritten: wrote, indexed: false, duplicate: true, reason: 'duplicate', conclusion };
    }

    record.distilled = true;
    record.conclusion = conclusion;
    record.type = principle ? '原则' : '结论';
    const wrote = writeEvent(scopeName, record);
    return { eventWritten: wrote, indexed: true, duplicate: false, reason: 'indexed', conclusion };
  }

  return { distill, writeEvent };
}
