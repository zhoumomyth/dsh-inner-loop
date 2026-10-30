/**
 * scope.js —— 作用域：这条记忆该给谁看见。
 *
 * 单入口用户（只有一个聊天窗口）：所有记忆都是 `defaultScope`，这个文件基本不干活。
 * 多入口用户（网页 + 即时通讯 + 群聊）：同一个人在不同入口说的话该不该互相看见，
 * 由 provider 决定 —— 这是本插件**唯一**跟「聊天软件」有关的扩展点。
 *
 * 依赖：只用 node 内置。默认实现不读任何外部文件，不 import 本地模块。
 *
 * ── 自定义 provider 的契约 ──────────────────────────────
 * `scopeProvider` 写模块路径或包名即可。该模块导出下面任一函数：
 *
 *   export function resolveAll()              -> Map<sessionId, scopeName>   // 推荐，一次拿全表
 *   export function resolve(sessionId)        -> scopeName | undefined       // 按需查
 *
 * 只要求「纯查询」：不许有副作用、不许抛。查不到就返回 undefined，由本文件兜底成 defaultScope。
 */

const DEFAULT_TTL_MS = 60 * 1000;

/**
 * @param {object} opts
 * @param {string} [opts.defaultScope]  识别不出时的兜底名
 * @param {string} [opts.globalScope]   「所有作用域都可见」的名字
 * @param {string} [opts.provider]      provider 模块路径/包名；留空 = 永远 defaultScope
 * @param {number} [opts.ttlMs]         provider 结果缓存多久（默认 60 秒）
 * @param {(line:string)=>void} [opts.trace] 可选：把 provider 的异常报出去
 */
export function createScopeResolver({
  defaultScope = 'default',
  globalScope = 'global',
  provider = '',
  ttlMs = DEFAULT_TTL_MS,
  trace = () => {},
} = {}) {
  let cache = null; // { at:number, map:Map }
  let loaded = null; // provider 模块（加载成功后有值）
  let loadTried = false;
  let loadError = null;

  async function loadProvider() {
    if (loadTried) return loaded;
    loadTried = true;
    if (!provider) return null;
    try {
      loaded = await import(provider);
      return loaded;
    } catch (e) {
      loadError = e;
      // provider 挂了不能让插件崩 —— 降级成单作用域，但要报出去
      trace(`scope provider 加载失败（降级为 ${defaultScope}）: ${e?.message ?? e}`);
      return null;
    }
  }

  /** 拉一次全表（有缓存）。返回 Map<sessionId, scope>。 */
  async function refresh() {
    if (cache && Date.now() - cache.at < ttlMs) return cache.map;

    const map = new Map();
    const mod = await loadProvider();
    if (mod) {
      try {
        if (typeof mod.resolveAll === 'function') {
          const all = await mod.resolveAll();
          if (all instanceof Map) {
            for (const [k, v] of all) if (v) map.set(String(k), String(v));
          } else if (all && typeof all === 'object') {
            for (const [k, v] of Object.entries(all)) if (v) map.set(String(k), String(v));
          }
        } else if (typeof mod.resolve === 'function') {
          // 只有按需查的接口 → 不做全表（避免猜 sessionId 列表），交给 resolveOne
        }
      } catch (e) {
        trace(`scope provider resolveAll 抛错（降级）: ${e?.message ?? e}`);
      }
    }
    cache = { at: Date.now(), map };
    return map;
  }

  /** 解析单个 sessionId 对应的作用域名。永不抛。 */
  async function resolve(sessionId) {
    const sid = String(sessionId || '');
    if (!sid) return defaultScope;

    const map = await refresh();
    if (map.has(sid)) return map.get(sid);

    // 全表里没有 → 试试按需查接口
    const mod = await loadProvider();
    if (mod && typeof mod.resolve === 'function') {
      try {
        const got = await mod.resolve(sid);
        if (got) {
          map.set(sid, String(got));
          return String(got);
        }
      } catch (e) {
        trace(`scope provider resolve 抛错（降级）: ${e?.message ?? e}`);
      }
    }
    return defaultScope;
  }

  /** 这个作用域是不是「所有会话都能看见」。 */
  function isGlobal(scope) {
    return String(scope) === String(globalScope);
  }

  /** 检索时的可见性判据：全局 + 当前作用域，其余一律看不见。 */
  function visible(itemScope, currentScope) {
    return isGlobal(itemScope) || String(itemScope) === String(currentScope);
  }

  /** 把作用域名变成安全的目录名（多入口场景下会用来分目录存流水）。 */
  function safeDir(scope) {
    return String(scope || defaultScope).replace(/[\\/:*?"<>|]/g, '_');
  }

  return {
    resolve,
    isGlobal,
    visible,
    safeDir,
    get providerError() { return loadError; },
    /** 测试用：强制失效缓存 */
    invalidate() { cache = null; },
  };
}
