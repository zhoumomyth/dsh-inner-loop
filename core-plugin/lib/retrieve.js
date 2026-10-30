/**
 * retrieve.js —— 枢纽：把「账本里有什么」变成「这一轮该塞给模型哪三条」。
 *
 * 依赖：index-store.js（读数据 + **分词**）+ scope 实例（判可见性）+ 传入的 conf。
 *       **不 import config.js**，不 new Config —— 配置对象从入口传进来。
 *
 * ⚠️ 分词必须用 index-store 的 bigrams，不许在这里另写一份。
 *    真实教训：第一版这里自己写了个简化版 gramsOf（少了停用词过滤），
 *    结果「建索引时用的分词」和「检索时用的分词」不是同一套 ——
 *    命中率会莫名其妙偏低，而且**不会报错**。所有文本切分只留一个出口。
 *
 * 设计要点：算法全部拆成**纯函数**，可以脱离 DSH、脱离文件系统单独测。
 *   scoreEntry     一个字一个字地数命中
 *   rankEntries    过滤 + 排序
 *   resolveConflicts  同一主题的两条原则，只留新的
 *   formatHit      渲染成注入用的那一行
 * 只有 createRetriever 那层才碰 store / scope / 副作用。
 */
import { bigrams } from './index-store.js';

/** 纯函数：这条记录跟查询共享多少个二字组。 */
export function scoreEntry(entry, queryGrams) {
  if (!entry?.grams || !queryGrams?.size) return 0;
  let hits = 0;
  for (const g of queryGrams) if (entry.grams.has(g)) hits += 1;
  return hits;
}

/** 纯函数：两段文字的二字组重叠率（0~1，按较小的一方算）。 */
export function overlapRatio(a, b) {
  const A = typeof a === 'string' ? bigrams(a) : a;
  const B = typeof b === 'string' ? bigrams(b) : b;
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const g of A) if (B.has(g)) common += 1;
  return common / Math.min(A.size, B.size);
}

/**
 * 纯函数：过滤 + 排序。
 * @param {Array} entries
 * @param {Set<string>} queryGrams
 * @param {object} opts
 * @param {number} [opts.minHits]      至少命中几个组
 * @param {string} [opts.currentScope] 当前作用域
 * @param {(itemScope:string,current:string)=>boolean} [opts.isVisible]
 */
export function rankEntries(entries, queryGrams, { minHits = 2, currentScope = 'default', isVisible } = {}) {
  const visible = isVisible ?? ((a, b) => a === 'global' || a === b);
  const scored = [];
  for (const entry of entries) {
    if (!visible(entry.scope, currentScope)) continue;
    const hits = scoreEntry(entry, queryGrams);
    if (hits >= minHits) scored.push({ entry, hits });
  }
  // 命中多的在前；同分按日期新的在前
  scored.sort((x, y) => y.hits - x.hits || (x.entry.date < y.entry.date ? 1 : x.entry.date > y.entry.date ? -1 : 0));
  return scored;
}

/**
 * 纯函数：冲突裁决（**简化版**）。
 *
 * 只处理 type === '原则' 的条目：两条原则的重叠率 ≥ threshold 时视为同一主题，
 * 只保留日期更新的那条；被压下的记进 superseded，供调用方决定要不要提示模型。
 *
 * 明确不做子句级合并 —— 那需要把句子切开再拼回去，出错时很难察觉。
 * 宁可多留一条、并把被取代的事实说出来，也不做「看起来更聪明」的合并。
 */
export function resolveConflicts(ranked, { threshold = 0.6 } = {}) {
  const kept = [];
  const superseded = [];
  for (const item of ranked) {
    if (item.entry.type !== '原则') { kept.push(item); continue; }
    const idx = kept.findIndex(
      (k) => k.entry.type === '原则' && overlapRatio(k.entry.body, item.entry.body) >= threshold,
    );
    if (idx < 0) { kept.push(item); continue; }
    const cur = kept[idx];
    const itemIsNewer = String(item.entry.date) >= String(cur.entry.date);
    if (itemIsNewer) {
      superseded.push(cur.entry);
      kept[idx] = item;
    } else {
      superseded.push(item.entry);
    }
  }
  return { kept, superseded };
}

/** 纯函数：渲染成注入用的那一行（丢掉 kw —— 那是给人检索用的，对模型是噪声）。 */
export function formatHit(entry, hits) {
  const tag = entry.type && entry.type !== '结论' ? `[${entry.type}]` : '';
  const body = String(entry.body || '').trim();
  const h = Number.isFinite(hits) ? `（命中 ${hits}）` : '';
  return `- [${entry.date}] ${tag}${body}${h}`;
}

/**
 * 工厂：真正干活的那层。
 *
 * @param {object} opts
 * @param {object} opts.store      index-store 实例（提供 read()）
 * @param {object} opts.scope      scope 实例（提供 resolve / visible）
 * @param {object} opts.conf       resolve 后的配置（不是 Config 实例）
 * @param {(l:string)=>void} [opts.trace]
 */
export function createRetriever({ store, scope, conf, trace = () => {} }) {
  const topN = Math.max(1, Math.min(Number(conf?.retrieveTopN) || 3, 5));
  const minHits = Math.max(1, Number(conf?.retrieveMinHits) || 2);

  /**
   * @returns {Promise<{ok:boolean, lines:string[], hits:number, superseded:number, errors:Array, degraded:boolean}>}
   *
   * degraded=true 表示**数据源有问题**（账本读不到 / 行解析失败）。
   * 上层必须区别对待：degraded 时不能对外说「没有相关记忆」，那是在撒谎。
   */
  async function retrieve(text, sessionId) {
    const query = bigrams(text);
    if (query.size === 0) return { ok: true, lines: [], hits: 0, superseded: 0, errors: [], degraded: false };

    const read = store.read();
    if (!read.ok) {
      trace(`retrieve 数据源异常：${read.errors.map((e) => e.where).join(',')}`);
    }

    const currentScope = await scope.resolve(sessionId);
    let ranked = rankEntries(read.entries, query, {
      minHits,
      currentScope,
      isVisible: (a, b) => scope.visible(a, b),
    });

    // 严格档没命中 → 放宽到 1 个组再试一次（中文里一个词能撞一片，但总比空手强）
    if (ranked.length === 0 && minHits > 1) {
      ranked = rankEntries(read.entries, query, {
        minHits: 1,
        currentScope,
        isVisible: (a, b) => scope.visible(a, b),
      });
    }

    const { kept, superseded } = resolveConflicts(ranked);
    const picked = kept.slice(0, topN);

    return {
      ok: true,
      lines: picked.map((x) => formatHit(x.entry, x.hits)),
      hits: picked.length,
      superseded: superseded.length,
      errors: read.errors,
      degraded: !read.ok,
    };
  }

  return { retrieve, topN, minHits };
}
