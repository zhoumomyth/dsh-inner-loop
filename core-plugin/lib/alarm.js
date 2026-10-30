/**
 * alarm.js —— 出问题时报出来，而且不许静默。
 *
 * 依赖：只用 node 内置。**不 import 任何本地模块**，所以它永远是依赖树的叶子，
 *       不可能参与循环引用。
 *
 * 为什么单独一个文件：错误上报曾经被 8 处空 catch 吞掉，
 * 结果「索引读失败 → 检索永远 0 命中」这种事故跑了很久没人知道。
 * 上报逻辑必须比调用它的业务代码更简单、更不可能出错。
 *
 * 两条出口：
 *   trace(line)          每行一条，进日志文件。排障第一现场，可以很多。
 *   noteError(where, e)  限流后追加进警报文件。给人看的，必须少而准。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_THROTTLE_MS = 10 * 60 * 1000; // 10 分钟
const DEFAULT_MAX_ENTRIES = 200;
const TRIM_KEEP = 100;

/** 本地时间戳，格式 YYYY-MM-DD HH:mm（不依赖时区库） */
export function stamp(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * @param {object} opts
 * @param {string} opts.traceFile       日志文件路径
 * @param {string} opts.alarmFile       警报文件路径
 * @param {number} [opts.throttleMs]    同一错误签名多久内只记一次
 * @param {number} [opts.maxEntries]    警报文件超过多少条时滚动
 * @param {boolean} [opts.echo]         true = 同时打到 stderr（开发时用）
 */
export function createAlarm({
  traceFile,
  alarmFile,
  throttleMs = DEFAULT_THROTTLE_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  echo = false,
} = {}) {
  const seen = new Map(); // 错误签名 → 上次记录时间

  const ensureDir = (f) => {
    try {
      const d = dirname(f);
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    } catch {
      /* 建目录失败由下面的写操作统一暴露 */
    }
  };

  /** 写日志。它自己失败时**只能**走 stderr —— 没有更下面的地方可以告状。 */
  function trace(line) {
    const text = `${new Date().toISOString()} ${line}\n`;
    try {
      ensureDir(traceFile);
      appendFileSync(traceFile, text, 'utf8');
    } catch (e) {
      try {
        process.stderr.write(`[inner-loop] trace 写入失败: ${e?.message}\n`);
      } catch {
        /* 连 stderr 都写不了，那就真的没有任何出口了 */
      }
    }
    if (echo) {
      try { process.stderr.write(text); } catch { /* 同上 */ }
    }
  }

  /** 警报文件滚动：超过 maxEntries 条时只留最近 TRIM_KEEP 条。 */
  function trimAlarm() {
    try {
      if (!existsSync(alarmFile)) return;
      const lines = readFileSync(alarmFile, 'utf8').split(/\r?\n/);
      const entries = lines.filter((l) => /^- \[/.test(l));
      if (entries.length <= maxEntries) return;
      const keep = entries.slice(-TRIM_KEEP);
      const header = lines.filter((l) => !/^- \[/.test(l)).join('\n').trimEnd();
      writeFileSync(alarmFile, `${header}\n\n${keep.join('\n')}\n`, 'utf8');
    } catch (e) {
      try { process.stderr.write(`[inner-loop] 警报滚动失败: ${e?.message}\n`); } catch { /* ignore */ }
    }
  }

  /**
   * 运行时异常出口。
   * @param {string} where  出事的位置（函数名/阶段名），会作为限流签名的一部分
   * @param {unknown} e     异常对象或字符串
   * @returns {boolean}     这次是否真的写进了警报（false = 被限流或被吞）
   */
  function noteError(where, e) {
    let msg = 'unknown';
    try { msg = String(e?.message ?? e); } catch { msg = 'unprintable'; }

    trace(`ERR ${where} ${msg}`);

    try {
      const sig = `${where}|${msg.slice(0, 80)}`;
      const now = Date.now();
      if (throttleMs > 0 && now - (seen.get(sig) ?? 0) < throttleMs) return false;
      seen.set(sig, now);

      ensureDir(alarmFile);
      appendFileSync(alarmFile, `\n- [${stamp()}] **系统警报**｜\`${where}\` — ${msg}\n`, 'utf8');
      trimAlarm();
      return true;
    } catch (e2) {
      try { process.stderr.write(`[inner-loop] 警报写入失败: ${e2?.message}\n`); } catch { /* ignore */ }
      return false;
    }
  }

  /**
   * 主动报警（不是异常，是"体检发现问题"这类）。
   * @param {string} title
   * @param {string[]} lines
   */
  function alarm(title, lines = []) {
    try {
      ensureDir(alarmFile);
      const body = lines.map((l) => `  - ${l}`).join('\n');
      appendFileSync(alarmFile, `\n- [${stamp()}] **${title}**\n${body}\n`, 'utf8');
      trimAlarm();
      return true;
    } catch (e) {
      try { process.stderr.write(`[inner-loop] 主动报警失败: ${e?.message}\n`); } catch { /* ignore */ }
      return false;
    }
  }

  return { trace, noteError, alarm };
}
