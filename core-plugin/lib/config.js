/**
 * config.js —— 全部对外配置集中在这里。
 *
 * 约定（改代码前先读这段）：
 *   1. 任何「魔法数字 / 硬编码路径 / 业务专名」都不许散落在别的文件里，一律加到这里。
 *   2. 每一项都必须写清「改了会怎样」，因为改配置的人看不到你脑子里的上下文。
 *   3. 默认值必须能在一台**干净的机器**上跑起来 —— 不依赖任何个人目录、账号名、聊天软件。
 *
 * 依赖：@deepseek-ai/schemastery（DSH 自带；单独用本插件时也会随包安装）
 */
import Schema from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

/* ────────────────────────────────────────────────────────────
 * 一、记忆根的解析（四级回落，命中一个就走）
 * ──────────────────────────────────────────────────────────── */

/**
 * 先决定 DSH 的 home 在哪。
 * 回落顺序：显式传入 → 环境变量 DSH_HOME → ~/.dsh
 */
export function resolveDshHome(explicit) {
  if (explicit) return explicit;
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  return join(homedir(), '.dsh');
}

/**
 * 再决定记忆库在哪。
 * 回落顺序：显式传入 → 环境变量 DSH_MEMORY_HOME → <dshHome>/记忆库 → 自动探测
 *
 * 自动探测只在「看起来像记忆库」时才认（有索引或事件目录），
 * 避免把一个空目录当成记忆根、然后写一堆文件进去。
 */
export function resolveMemoryDir({ dshHome, explicit } = {}) {
  const byExplicit = explicit || process.env.DSH_MEMORY_HOME;
  if (byExplicit) return byExplicit;

  const guess = join(resolveDshHome(dshHome), '记忆库');
  if (looksLikeMemoryDir(guess)) return guess;

  // 再退一步：<dshHome>/memory（给不用中文目录名的用户）
  const alt = join(resolveDshHome(dshHome), 'memory');
  if (looksLikeMemoryDir(alt)) return alt;

  // 都不像 → 仍然返回默认的那个，由调用方决定要不要创建
  return guess;
}

function looksLikeMemoryDir(p) {
  try {
    return existsSync(join(p, '索引.md')) || existsSync(join(p, 'index.md')) || existsSync(join(p, '事件')) || existsSync(join(p, 'events'));
  } catch {
    return false;
  }
}

/* ────────────────────────────────────────────────────────────
 * 二、由记忆根派生出的所有路径
 * ──────────────────────────────────────────────────────────── */

/**
 * 注意：这里刻意保留中文默认文件名（索引.md / 事件），
 * 是因为本套系统最初就长在中文目录里；想换成英文，
 * 在配置里把 indexFile / eventsDir 指向你的文件名即可，代码不关心。
 */
export function resolvePaths(conf = {}) {
  const memoryDir = resolveMemoryDir({ dshHome: conf.dshHome, explicit: conf.memoryDir });
  return {
    dshHome: resolveDshHome(conf.dshHome),
    memoryDir,
    indexFile: conf.indexFile || join(memoryDir, '索引.md'),
    eventsDir: conf.eventsDir || join(memoryDir, '事件'),
    globalMemoryFile: conf.globalMemoryFile || join(memoryDir, '全局记忆.md'),
    /** 出问题时往这里追加一行；永远不要静音它（见 docs/ARCHITECTURE.md「警报为什么不许静音」） */
    alarmFile: conf.alarmFile || join(memoryDir, '系统警报.md'),
    /** 「动规矩之前必须留证据」用的目录；不配就不写 */
    evidenceDir: conf.evidenceDir || join(memoryDir, '检索证据'),
    /**
     * 历史碎片目录（可选）。
     * 设为 null = 不读碎片，检索只看索引 —— 这是干净默认值。
     * 指向某个目录时，会把该目录下 *.md 的**标题**也纳入检索（不读正文）。
     */
    fragmentDir: conf.fragmentDir || null,
    traceFile: conf.traceFile || join(resolveDshHome(conf.dshHome), 'precheck-trace.log'),
  };
}

/* ────────────────────────────────────────────────────────────
 * 三、配置 schema（强类型 + 每一项都写「改了会怎样」）
 * ──────────────────────────────────────────────────────────── */

export const Config = Schema.object({
  /* ── 总开关 ── */
  enabled: Schema.boolean().default(true).description('关掉后插件完全不工作（不注入、不检索、不沉淀）。排障时用它做二分。'),

  /* ── 路径（留空 = 按 resolvePaths 的默认推导） ── */
  dshHome: Schema.string().default('').description('DSH 的 home。留空 = 环境变量 DSH_HOME 或 ~/.dsh。'),
  memoryDir: Schema.string().default('').description('记忆库目录。留空 = <dshHome>/记忆库（会自动探测 memory/ 作为备选）。'),
  indexFile: Schema.string().default('').description('账本文件。留空 = <memoryDir>/索引.md。一行一条，格式见 docs/ARCHITECTURE.md。'),
  eventsDir: Schema.string().default('').description('事件流水目录。留空 = <memoryDir>/事件。按 <作用域>/<日期>.jsonl 分层。'),
  globalMemoryFile: Schema.string().default('').description('跨作用域通用事实。留空 = <memoryDir>/全局记忆.md。每轮无条件带前 N 行。'),
  alarmFile: Schema.string().default('').description('警报文件。留空 = <memoryDir>/系统警报.md。出问题只追加，不覆盖。'),
  evidenceDir: Schema.string().default('').description('证据目录。留空 = <memoryDir>/检索证据。不配也不会报错，只是不落证据。'),
  fragmentDir: Schema.string().default('').description('可选：历史碎片目录。留空 = 不读碎片。填了则把该目录 *.md 的标题纳入检索。'),
  traceFile: Schema.string().default('').description('运行日志。留空 = <dshHome>/precheck-trace.log。排障第一现场。'),

  /* ── 检索 ── */
  retrieve: Schema.boolean().default(true).description('每轮是否自动检索并注入命中条目。关掉 = 只剩沉淀。'),
  retrieveTopN: Schema.number().default(3).description('每轮最多注入几条。默认 3；上限 5（再多会挤占上下文，且命中质量下降更快）。'),
  retrieveMinHits: Schema.number().default(2).description('两条文本至少共享几个二字组才算命中。2 = 偏严格（漏检多、误检少）；1 = 偏宽（中文一个词就能撞一片）。'),
  globalMemoryLines: Schema.number().default(12).description('每轮无条件带上全局记忆的前几行。0 = 不带。'),

  /* ── 沉淀 ── */
  distill: Schema.boolean().default(true).description('每轮结束是否把这一轮抽成一条结论写进账本。关掉 = 只写流水、不写账本。'),
  maxAskChars: Schema.number().default(0).description('存进流水的提问最多保留多少字。0 = 不截断（推荐 0，截断会丢上下文）。'),
  maxAnswerChars: Schema.number().default(0).description('存进流水的回答最多保留多少字。0 = 不截断。历史教训：曾默认 800，长答案后段全部丢失且不报错。'),
  principleMaxChars: Schema.number().default(0).description('用户立规矩时，原话最多保留多少字。0 = 不截断。'),
  duplicateThreshold: Schema.number().default(0.95).description('判「这条结论是不是已经有了」的覆盖率阈值。0.95 = 只挡几乎逐字一致的，宁可重复也不丢。'),
  duplicateMinCommon: Schema.number().default(12).description('判重时至少要共享多少个二字组。太小会把不同的事判成重复。'),

  /* ── 作用域（多入口场景的关键扩展点） ── */
  defaultScope: Schema.string().default('default').description('识别不出作用域时用哪个名字。所有只有一个入口的用户，永远是它。'),
  globalScope: Schema.string().default('global').description('「所有作用域都能看见」的那个名字。账单里这一类的条目会被所有会话读到。'),
  scopeProvider: Schema.string().default('').description('可选：自定义作用域解析模块（相对路径或包名）。实现 resolve(sessionId) => scope。留空 = 永远是 defaultScope。'),
  manualTextPatterns: Schema.array(Schema.string()).default([]).description('可选：识别「宿主插件注入的说明文本」的正则片段数组。留空 = 不识别。设错会导致把真对话当注入文本丢掉，动它之前先读 docs/DIY_GUIDE.md。'),

  /* ── 动态规则路由（雷达） ── */
  radar: Schema.boolean().default(true).description('每轮是否按意图把对应的细则清单拍进上下文（A3 写代码 / A5 报数 / A6 高危 / A7 判重）。关掉 = 只注入自检与检索。'),
  radarMaxPoints: Schema.number().default(5).description('一轮最多注入几条核心问句。多条规则同时命中时按融合池去重后截断，上限 5。'),
  radarTerse: Schema.boolean().default(true).description('连续几步没出事是否自动精简清单（只留标题 + 第 1 条）。任何工具报错 / 语法错误 / 被 deny 立刻恢复全量。'),
  radarCalmSteps: Schema.number().default(3).description('连续几步都正常才进精简模式。判据是「有没有出事」，不是「跑了几步」。'),

  /* ── 警报 ── */
  alarmThrottleMs: Schema.number().default(600000).description('同一个错误签名多久内只记一次。默认 10 分钟。设 0 = 每次都记（碎片多的时候会刷屏）。'),
  alarmMaxEntries: Schema.number().default(200).description('警报文件超过多少条时滚动，只保留最近 100 条。防止无限增长。'),

  /* ── 物理拦截（默认关闭） ── */
  enforce: Schema.boolean().default(false).description('写工具执行前，检查模型有没有答 A3 清单；没答够就 deny。**默认关**：它在实机上把「备份 / 改文件 / 重启」也拦了，连开锁的钥匙一起锁住。想用再打开。'),
  enforceLimit: Schema.number().default(3).description('连续被拒几次后回收写入权限。只在不放行的情况下生效。'),
  safeReadonlyPrefixes: Schema.array(Schema.string()).default([]).description('一级白名单之外、你自己确认过安全的只读命令前缀（正则片段，如 netstat）。'),
});

export const DEFAULTS = {
  enabled: true,
  retrieve: true,
  retrieveTopN: 3,
  retrieveMinHits: 2,
  globalMemoryLines: 12,
  distill: true,
  maxAskChars: 0,
  maxAnswerChars: 0,
  principleMaxChars: 0,
  duplicateThreshold: 0.95,
  duplicateMinCommon: 12,
  defaultScope: 'default',
  globalScope: 'global',
  radar: true,
  radarMaxPoints: 5,
  radarTerse: true,
  radarCalmSteps: 3,
  alarmThrottleMs: 600000,
  alarmMaxEntries: 200,
  enforce: false,
  enforceLimit: 3,
  safeReadonlyPrefixes: [],
};

/**
 * 把用户配置 + 默认值合成一份，并把空字符串的路径解析成真实路径。
 *
 * ⚠️ 这里必须**真的跑一遍 schema 校验** —— 定义了 Config 不等于校验生效。
 *    真实教训：第一版只是 `{...DEFAULTS, ...raw}` 合并，结果 `retrieveTopN: 'abc'`
 *    原样穿过去，一路跑到打分函数里变成 NaN，最后表现为「检索永远 0 命中」。
 *    校验失败应当**抛**，由入口 apply() 接住并安全退出（见 index.js 铁律③）。
 */
export function resolveConfig(raw = {}) {
  const validated = new Config(raw || {}); // ← 校验 + 填默认；非法类型会抛
  const merged = { ...DEFAULTS, ...validated };
  const p = resolvePaths(merged);
  return {
    ...merged,
    // 路径字段：空字符串 → 用派生值
    dshHome: p.dshHome,
    memoryDir: p.memoryDir,
    indexFile: p.indexFile,
    eventsDir: p.eventsDir,
    globalMemoryFile: p.globalMemoryFile,
    alarmFile: p.alarmFile,
    evidenceDir: p.evidenceDir,
    fragmentDir: p.fragmentDir,
    traceFile: p.traceFile,
  };
}
