#!/usr/bin/env node
/**
 * dep-graph.mjs —— 拆完文件后的体检：谁依赖谁、有没有死循环、有没有违反铁律。
 *
 * 跑法：node tests/dep-graph.mjs
 * 退出码：0 = 干净   2 = 有环或违反铁律
 *
 * 检查四条：
 *   ① 循环引用（A→B→A）—— 有环 = DSH 启动可能卡死
 *   ② config.js 必须是叶子：它可以被任何人 import，但它不许 import 本地文件
 *   ③ 除入口 index.js 外，任何文件不许 `new Config(` / `import { Config }`
 *      （配置实例必须在入口 resolveConfig() 一次，然后往下传）
 *   ④ 每个本地 import 的目标文件必须真实存在（防手滑写错文件名）
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'core-plugin', 'lib');

const files = readdirSync(LIB).filter((f) => f.endsWith('.js')).sort();
const graph = new Map(); // file -> [importedLocalFile]
const raw = new Map();

for (const f of files) {
  const src = readFileSync(join(LIB, f), 'utf8');
  raw.set(f, src);
  const deps = new Set();
  // 静态 import ... from './x.js'   + 函数式 import('./x.js')
  for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
    const target = basename(m[1]); // './retrieve.js' → 'retrieve.js'
    if (files.includes(target) && target !== f) deps.add(target);
  }
  graph.set(f, [...deps]);
}

let problems = 0;
const note = (s) => { problems += 1; console.log('  ❌ ' + s); };
const ok = (s) => console.log('  ✅ ' + s);

console.log('═══ 依赖表 ═══');
for (const f of files) {
  const d = graph.get(f);
  console.log(`  ${f.padEnd(18)} → ${d.length ? d.join(', ') : '（无本地依赖，叶子）'}`);
}

console.log('\n═══ ① 循环引用 ═══');
const color = new Map(); // 0=未访问 1=栈中 2=完成
const cycles = [];
function dfs(node, stack) {
  color.set(node, 1);
  stack.push(node);
  for (const nxt of graph.get(node) ?? []) {
    const c = color.get(nxt) ?? 0;
    if (c === 1) cycles.push([...stack.slice(stack.indexOf(nxt)), nxt].join(' → '));
    else if (c === 0) dfs(nxt, stack);
  }
  stack.pop();
  color.set(node, 2);
}
for (const f of files) if (!color.get(f)) dfs(f, []);
if (cycles.length === 0) ok('无环');
else cycles.forEach((c) => note('发现环：' + c));

console.log('\n═══ ② config.js 必须是叶子 ═══');
if (!graph.has('config.js')) note('config.js 不存在？');
else if (graph.get('config.js').length === 0) ok('config.js 无本地依赖（叶子正确）');
else note('config.js 反过来依赖了：' + graph.get('config.js').join(', '));

console.log('\n═══ ③ 只有入口能构造/导入 Config ═══');
for (const f of files) {
  if (f === 'index.js' || f === 'config.js') continue;
  const src = raw.get(f);
  if (/new\s+Config\s*\(/.test(src)) note(`${f} 里出现了 new Config()（应在入口 resolveConfig 一次并往下传）`);
  if (/import\s*\{[^}]*\bConfig\b[^}]*\}\s*from/.test(src)) note(`${f} 里 import 了 Config 本体（只需要 resolve 后的对象）`);
}
if (problems === 0) ok('无越权构造');

console.log('\n═══ ④ 本地 import 目标存在性 ═══');
let missing = 0;
for (const f of files) {
  const src = raw.get(f);
  for (const m of src.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
    if (!existsSync(join(LIB, basename(m[1])))) { note(`${f} 引用了不存在的 ${m[1]}`); missing += 1; }
  }
}
if (missing === 0) ok('全部本地引用都能解析');

console.log(`\n═══ 结果 ═══`);
console.log(`文件 ${files.length} 个｜问题 ${problems} 个`);
process.exit(problems === 0 ? 0 : 2);
