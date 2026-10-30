/**
 * index-store.js —— 只管「把账本读进来」，不算分、不决定给谁看。
 *
 * 依赖：只用 node 内置。不 import 本地模块（错误上报靠参数传入）。
 *
 * ── 账本行格式（这份文件的唯一权威定义）──────────────────
 *
 *   - [YYYY-MM-DD] [作用域] [结论|原则] 正文…… | kw: 词1 词2 … | src: 溯源
 *     └─ 日期       └─ 谁看的   └─ 类型     └─ 可被检索的正文   └─ 触发词   └─ 出处
 *
 * 三个方括号的顺序是硬约定：作用域必须紧跟日期之后，因为我们靠位置认它，
 * 不靠解析全文（全文里出现方括号的概率远高于行首）。
 *
 * ── 可选：历史碎片目录 ─────────────────────────────────
 * 配了 `fragmentDir` 时，会把该目录下每个 *.md 的**标题**也变成一条 entry，
 * 类型标成 `碎片`。只读标题不读正文 —— 碎片通常是成篇长文，整篇读进来既慢又没必要。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LINE_RE = /^-\s*\[([^\]]+)\]\s*\[([^\]]+)\]\s*\[([^\]]+)\]\s*([\s\S]*?)(?:\s*\|\s*kw:\s*([^|]*))?(?:\s*\|\s*src:\s*(.*))?$/;
const STOP_CHARS = new Set(['的', '了', '是', '在', '和', '与', '或', '就', '都', '也', '而', '被', '把', '对', '从', '向', '为', '以', '及', '等', '这', '那', '其', '个', '我', '你', '他', '她', '它']);

/**
 * 二字组：中文按 2 字滑窗，英文/数字按词。
 * 用 Set 存，天然去重。
 */
export function bigrams(text) {
  const out = new Set();
  const s = String(text || '');
  if (!s) return out;

  // 英文/数字词（≥2 字符）
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_\-]{1,}/g)) out.add(m[0].toLowerCase());
  // 数字串
  for (const m of s.matchAll(/\d{2,}/g)) out.add(m[0]);
  // 中文连续段 → 二字滑窗
  for (const seg of s.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const run = seg[0];
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const g = run.slice(i, i + 2);
      if (STOP_CHARS.has(g[0]) || STOP_CHARS.has(g[1])) continue;
      out.add(g);
    }
    // 单字段也留一份（三个字以上的专名，中间两字会被滑窗覆盖；这里补首尾）
    if (run.length >= 2) {
      out.add(run.slice(0, 2));
      out.add(run.slice(-2));
    }
  }
  return out;
}

/** 解析一行账本。格式不对返回 null（调用方决定要不要报）。 */
export function parseIndexLine(line) {
  const m = String(line || '').match(LINE_RE);
  if (!m) return null;
  const date = m[1].trim();
  const scope = m[2].trim();
  const type = m[3].trim();
  const rest = (m[4] || '').trim();
  const keywords = (m[5] || '').trim();
  const src = (m[6] || '').trim();
  const text = keywords ? `${rest} ${keywords}` : rest;
  return {
    line: String(line).trimEnd(),
    date,
    scope,
    type,
    body: rest,
    keywords: keywords ? keywords.split(/\s+/).filter(Boolean) : [],
    src,
    grams: bigrams(text),
  };
}

/**
 * @param {object} opts
 * @param {string} opts.indexFile       账本文件
 * @param {string|null} [opts.fragmentDir]  可选：碎片目录（只读标题）
 * @param {(line:string)=>void} [opts.trace]
 * @param {(where:string, e:unknown)=>void} [opts.noteError]
 */
export function createIndexStore({ indexFile, fragmentDir = null, trace = () => {}, noteError = () => {} } = {}) {
  let cache = null; // { key, entries, mtime, size }
  let fragCache = null; // { key, entries }

  /** 只负责「读 + 解析」。出错**往外抛**，由 read() 统一 catch 并上报。 */
  function readFromDisk() {
    if (!existsSync(indexFile)) {
      throw new Error(`账本不存在：${indexFile}`);
    }
    const text = readFileSync(indexFile, 'utf8'); // 可能抛（权限/编码/磁盘）
    const entries = [];
    let badLines = 0;
    for (const raw of text.split(/\r?\n/)) {
      const t = raw.trim();
      if (!t.startsWith('- [')) continue;
      const e = parseIndexLine(t);
      if (e) entries.push(e);
      else badLines += 1;
    }
    return { entries, badLines };
  }

  function readFragments(report = () => {}) {
    if (!fragmentDir) return [];
    try {
      if (!existsSync(fragmentDir)) {
        trace(`碎片目录不存在，跳过：${fragmentDir}`);
        return [];
      }
      const files = readdirSync(fragmentDir).filter((f) => f.endsWith('.md'));
      const key = `${files.length}:${statSync(fragmentDir).mtimeMs}`;
      if (fragCache && fragCache.key === key) return fragCache.entries;

      const entries = [];
      for (const f of files) {
        try {
          // 只读头部 1500 字符找标题，不整篇读
          const head = readFileSync(join(fragmentDir, f), 'utf8').slice(0, 1500);
          const mt = head.match(/^title:\s*(.+)$/m) ?? head.match(/^#\s+(.+)$/m);
          const title = mt ? String(mt[1]).trim() : '';
          if (!title) continue;
          const d = f.slice(0, 8);
          const date = /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '';
          entries.push({
            line: `- [${date}] [${'__global__'}] [碎片] ${title} | src: ${f}`,
            date,
            scope: '__global__', // 由调用方替换成真正的 globalScope
            type: '碎片',
            body: title,
            keywords: [],
            src: f,
            grams: bigrams(title),
          });
        } catch (e) {
        report('index-store:fragment', e);
      }
      }
      fragCache = { key, entries };
      return entries;
    } catch (e) {
      report('index-store:fragmentDir', e);
      return [];
    }
  }

  /**
   * 读全部条目（账本 + 可选碎片）。
   *
   * ⚠️ 返回值是**结构化结果**，不是裸数组 —— 这是刻意的：
   *   上层必须能区分「真的没有记忆」和「读失败了」。
   *   如果这里静默返回 []，上面就永远不知道"检索 0 命中"是因为库空还是因为文件坏了。
   *
   * 叶子节点铁律：**不 throw、不自己写日志**。出问题就
   *   ① 调外部注入的 noteError 上报；② 在返回值里如实标 ok=false + errors。
   * 由上层（retrieve / index.js）决定「要不要把这件事告诉模型」。
   *
   * @returns {{ ok: boolean, entries: Array, errors: Array<{where:string, message:string}> }}
   */
  function read({ force = false } = {}) {
    const errors = [];
    const report = (where, e) => {
      const message = String(e?.message ?? e ?? 'unknown');
      errors.push({ where, message });
      noteError(where, e);
    };

    let st;
    try {
      st = existsSync(indexFile) ? statSync(indexFile) : { mtimeMs: 0, size: 0 };
    } catch (e) {
      report('index-store:stat', e);
      st = { mtimeMs: 0, size: 0 };
    }

    const key = `${st.mtimeMs}:${st.size}`;
    let indexEntries;
    if (!force && cache && cache.key === key) {
      indexEntries = cache.entries;
    } else {
      try {
        const got = readFromDisk();
        indexEntries = got.entries;
        if (got.badLines) errors.push({ where: 'index-store:bad-lines', message: `${got.badLines} 行格式不符，已跳过` });
      } catch (e) {
        report('index-store:read', e);
        indexEntries = [];
      }
      cache = { key, entries: indexEntries };
    }

    const fragEntries = readFragments(report);
    const entries = [...indexEntries, ...fragEntries];
    return { ok: errors.length === 0, entries, errors };
  }

  /** 便捷口：只要数组、不关心错误的场景（比如统计）。错误照样上报，只是不返回。 */
  function readEntries({ force = false } = {}) {
    return read({ force }).entries;
  }

  function stats() {
    const { entries, ok } = read();
    return {
      ok,
      total: entries.length,
      fromIndex: entries.filter((e) => e.type !== '碎片').length,
      fromFragment: entries.filter((e) => e.type === '碎片').length,
    };
  }

  return { read, readEntries, stats, bigrams, parseIndexLine };
}
