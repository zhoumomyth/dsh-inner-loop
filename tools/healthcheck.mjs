#!/usr/bin/env node
/**
 * healthcheck.mjs —— 独立体检（22 项）。
 *
 * 跑法：node tools/healthcheck.mjs
 * 退出码：0 = 全绿   1 = 有警告   2 = 有严重问题
 *
 * ── 为什么它不 import 插件本体 ──────────────────────────
 * 它要覆盖的场景就是「插件根本 import 不进来」。写在插件里的自检在那一刻一次都跑不到。
 * 所以这里：
 *   · 不 import core-plugin 的任何文件（只用子进程 + 静态读源码）
 *   · 路径自己推导（跟 config.js 的四级回落保持同一套规则，但不共享代码）
 *     —— 刻意重复一小段逻辑，换「插件坏了它也能跑」
 *
 * ── 跨平台 ─────────────────────────────────────────────
 * 纯 Node，Windows / macOS / Linux 通用。
 *   Windows :  node tools\healthcheck.mjs
 *   Linux/Mac: node tools/healthcheck.mjs
 * 下面所有检查项都不依赖 shell 命令，改路径分隔符不影响。
 */
import { readFileSync, existsSync, statSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ── 路径推导：与 config.js 同一套四级回落，但不 import 它 ── */
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const MEMORY_DIR = process.env.DSH_MEMORY_HOME || join(DSH_HOME, '记忆库');
const INDEX_FILE = join(MEMORY_DIR, '索引.md');
const ALARM_FILE = join(MEMORY_DIR, '系统警报.md');

/** 插件位置：环境变量 → 仓库内相对位置 → node_modules */
function locatePlugin() {
  const candidates = [
    process.env.INNER_LOOP_PLUGIN,
    resolvePath(HERE, '..', 'core-plugin', 'lib', 'index.js'),
    resolvePath(HERE, '..', 'node_modules', 'dsh-inner-loop', 'lib', 'index.js'),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}
const PLUGIN = locatePlugin();
const PLUGIN_DIR = PLUGIN ? dirname(dirname(PLUGIN)) : null;
const NODE = process.execPath;

const rows = [];
let fatal = 0;
let warn = 0;
let info = 0;
const ok = (n, d = '') => rows.push({ s: '✅', n, d });
const wa = (n, d = '') => { warn += 1; rows.push({ s: '⚠️', n, d }); };
const no = (n, d = '') => { fatal += 1; rows.push({ s: '❌', n, d }); };
/** ℹ️ 只做提示，不进 warn、不影响退出码。 */
const inf = (n, d = '') => { info += 1; rows.push({ s: 'ℹ️', n, d }); };

/**
 * 已知良性条目：命中了也不算未处理故障。
 * `@deepseek-ai/dsh-llm` 是可选依赖 —— 缺了就降级走 fallback 构造，功能不降级。
 * 2026-10-31 定为 ℹ️：之前每次体检都报 ⚠️，属于噪音。
 */
const BENIGN_ALARM_RE = /loadMessageFactory.*(?:Cannot find package|@deepseek-ai\/dsh-llm)/;

/* ── 1. 运行时 ──────────────────────────────────────── */
const major = Number(process.versions.node.split('.')[0]);
if (major >= 18) ok('node 版本', `v${process.versions.node}（要求 ≥18）`);
else no('node 版本', `v${process.versions.node}，插件 engines 要求 ≥18`);

/* ── 2. 记忆根与关键路径 ────────────────────────────── */
if (existsSync(MEMORY_DIR)) ok('记忆库目录', MEMORY_DIR);
else no('记忆库目录', `不存在：${MEMORY_DIR}（设 DSH_MEMORY_HOME 或先建索引）`);

if (existsSync(INDEX_FILE)) {
  const st = statSync(INDEX_FILE);
  if (st.size === 0) no('索引文件', `存在但是 0 字节：${INDEX_FILE}`);
  else ok('索引文件', `${st.size.toLocaleString()} B`);
} else no('索引文件', `不存在：${INDEX_FILE}`);

if (existsSync(join(MEMORY_DIR, '事件'))) ok('事件目录');
else wa('事件目录', '不存在（沉淀只会写流水，不会失败；但新建时要注意权限）');

/* ── 3. 可写性（这条治「我以为写不进去」）────────────── */
try {
  const probe = join(MEMORY_DIR, '_healthcheck_probe.tmp');
  writeFileSync(probe, 'x', 'utf8');
  unlinkSync(probe);
  ok('记忆库可写', '建探针文件后删除成功');
} catch (e) {
  no('记忆库可写', `写不进去：${e.message}`);
}

/* ── 4. 内容健康度 ──────────────────────────────────── */
try {
  const t = readFileSync(INDEX_FILE, 'utf8');
  const bytes = Buffer.byteLength(t, 'utf8');
  const lines = t.split(/\r?\n/).filter((l) => l.trim().startsWith('- [')).length;
  if (lines === 0) no('索引内容', '文件非空但一行账本都没有（格式不对？）');
  else ok('索引内容', `${bytes.toLocaleString()} B / ${lines} 行账本`);
  // 抽样：最近 20 行有多少能按标准格式解析
  const all = t.split(/\r?\n/).filter((l) => l.trim().startsWith('- ['));
  const sample = all.slice(-20);
  const badSample = sample.filter((l) => !/^-\s*\[[^\]]+\]\s*\[[^\]]+\]\s*\[[^\]]+\]/.test(l.trim()));
  if (badSample.length > 0) wa('账本格式', `最近 ${sample.length} 行里 ${badSample.length} 行不符合 [日期][作用域][类型] 格式`);
  else ok('账本格式', `抽样最近 ${sample.length} 行全部合规`);
} catch (e) {
  no('索引内容', `读不了：${e.message}`);
}

/* ── 5. 插件能否找到 ────────────────────────────────── */
if (!PLUGIN) {
  no('插件位置', '找不到 lib/index.js（设 INNER_LOOP_PLUGIN 指向它）');
} else {
  ok('插件位置', PLUGIN);

  /* 5a. 语法 */
  const chk = spawnSync(NODE, ['--check', PLUGIN], { stdio: 'pipe', encoding: 'utf8', timeout: 10000 });
  if (chk.error) no('插件语法', `子进程起不来：${chk.error.message}`);
  else if (chk.status === 0) ok('插件语法', 'node --check 通过');
  else no('插件语法', `node --check 失败（exit=${chk.status}）：${tail(chk.stderr)}`);

  /* 5b. import 5 秒熔断 */
  const impCode = `import(${JSON.stringify('file:///' + PLUGIN.replace(/\\/g, '/'))}).then(m=>process.exit(Object.keys(m).length?0:3)).catch(e=>{console.error(e.message);process.exit(2)})`;
  const imp = spawnSync(NODE, ['-e', impCode], { stdio: 'pipe', encoding: 'utf8', timeout: 5000 });
  if (imp.error) no('插件 import', `子进程起不来：${imp.error.message}`);
  else if (imp.signal || imp.status === null) no('插件 import', '**超时 5 秒 → 判定挂死/死循环，宿主会起不来**');
  else if (imp.status === 0) ok('插件 import', '5 秒内成功');
  else no('插件 import', `import 失败（exit=${imp.status}）：${tail(imp.stderr)}`);

  /* 5c. 钩子契约（静态读源码，不执行） */
  try {
    const src = readFileSync(PLUGIN, 'utf8');
    const onCount = (src.match(/ctx\.on\s*\(/g) ?? []).length;
    if (onCount >= 2) ok('钩子注册点数', `ctx.on 出现 ${onCount} 处（预期 ≥2：注入 + 沉淀）`);
    else wa('钩子注册点数', `只有 ${onCount} 处，预期 ≥2`);
    if (src.includes('agent/pre-step')) ok('钩子名 agent/pre-step');
    else wa('钩子名 agent/pre-step', '源码里没找到 —— 宿主改过注入点了？');
    if (src.includes('session/event')) ok('钩子名 session/event');
    else no('钩子名 session/event', '源码里没找到 —— 沉淀链会断');
    if (/export const name\s*=/.test(src)) ok('导出 name');
    else wa('导出 name', '缺 name，装配时可能对不上');
    if (/export const inject\s*=/.test(src)) ok('导出 inject');
    else wa('导出 inject', '缺 inject，可能拿不到注入时机');
  } catch (e) {
    no('钩子契约静态检查', `读源码失败：${e.message}`);
  }

  /* 5d. 装配声明（最容易漏、后果最静默的一项） */
  const patchRef = join(PLUGIN_DIR, 'cordis.patch.yml');
  try {
    const pj = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8'));
    const declared = pj?.dsh?.bundle?.patch;
    if (!declared) no('装配声明', 'package.json 里没有 dsh.bundle.patch');
    else if (!existsSync(patchRef)) no('装配声明', `package.json 指向 ${declared}，但文件不存在 → 插件会静默不加载`);
    else ok('装配声明', declared);
  } catch (e) {
    no('装配声明', `读 package.json 失败：${e.message}`);
  }

  /* 5e. 依赖能否 import */
  if (PLUGIN_DIR) {
    for (const dep of ['@deepseek-ai/schemastery', '@deepseek-ai/cosmokit']) {
      const r = spawnSync(NODE, ['-e', `import('${dep}').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(2)})`], {
        stdio: 'pipe', encoding: 'utf8', timeout: 5000, cwd: PLUGIN_DIR,
      });
      if (r.status === 0) ok(`依赖 ${dep}`);
      else no(`依赖 ${dep}`, `import 失败：${tail(r.stderr, 2)} → 插件整个不加载`);
    }
    // 可选依赖：有就好，没有属正常
    const opt = spawnSync(NODE, ['-e', `import('@deepseek-ai/dsh-llm').then(()=>process.exit(0)).catch(()=>process.exit(7))`], {
      stdio: 'ignore', timeout: 5000, cwd: PLUGIN_DIR,
    });
    if (opt.status === 0) ok('可选依赖 dsh-llm', '可用（注入走标准消息构造）');
    else ok('可选依赖 dsh-llm', '不可用（走 fallback 构造，功能不降级）');
  }
}

/* ── 6. 警报文件 ────────────────────────────────────── */
if (existsSync(ALARM_FILE)) {
  const t = readFileSync(ALARM_FILE, 'utf8');
  const lines = t.split(/\r?\n/).filter((l) => /^- \[/.test(l) && !l.includes('[测试]'));
  const benign = lines.filter((l) => BENIGN_ALARM_RE.test(l)).length;
  const n = lines.length - benign;
  if (benign > 0) inf('已知良性条目', `${benign} 条（可选依赖 dsh-llm 缺失 → fallback 构造，功能不降级）`);
  if (n > 0) wa('系统警报有未处理条目', `${n} 条 → ${ALARM_FILE}`);
  else ok('系统警报', '无未处理条目（[测试] / 已知良性的不算）');
} else ok('系统警报', '尚未创建（有错时才建）');

function tail(s, n = 3) {
  return String(s || '').trim().split(/\r?\n/).filter((l) => l.trim()).slice(0, n).join(' ⏎ ') || '（无 stderr）';
}

/* ── 输出 ───────────────────────────────────────────── */
const stampNow = () => {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

console.log(`═══ inner-loop 独立体检 · ${stampNow()} ═══`);
console.log(`平台 ${process.platform} ｜ node ${process.versions.node}`);
for (const r of rows) console.log(`${r.s} ${r.n}${r.d ? '  — ' + r.d : ''}`);
console.log(`\n合计：✅ ${rows.filter((r) => r.s === '✅').length} ｜ ℹ️ ${info} ｜ ⚠️ ${warn} ｜ ❌ ${fatal}`);

if (fatal > 0) {
  try {
    const bad = rows.filter((r) => r.s === '❌').map((r) => `  - ${r.n}：${r.d}`).join('\n');
    writeFileSync(
      ALARM_FILE,
      `${existsSync(ALARM_FILE) ? readFileSync(ALARM_FILE, 'utf8') : ''}\n- [${stampNow()}] **独立体检 ❌ ${fatal} 项**\n${bad}\n`,
      'utf8',
    );
    console.log(`\n已写入 ${ALARM_FILE}`);
  } catch (e) {
    console.error('[healthcheck] 警报写入失败：' + e.message);
  }
  process.exit(2);
}
process.exit(warn > 0 ? 1 : 0);
