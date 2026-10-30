// 运行时验证 v1：config.js 能 import、路径脱敏干净、降级不崩
// 跑法：node tests/runtime-check.mjs
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { existsSync, renameSync, readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CONFIG = join(ROOT, 'core-plugin', 'lib', 'config.js');

let pass = 0, fail = 0;
const ok = (n, d = '') => { pass++; console.log(`  ✅ ${n}${d ? '  — ' + d : ''}`); };
const no = (n, d = '') => { fail++; console.log(`  ❌ ${n}${d ? '  — ' + d : ''}`); };

console.log('═══ 1. config.js 能否 import ═══');
let cfg;
try {
  cfg = await import('file://' + CONFIG.replace(/\\/g, '/'));
  ok('import 成功', Object.keys(cfg).join(','));
} catch (e) {
  no('import 失败', e.message);
  process.exit(2);
}

console.log('═══ 2. 导出完整性 ═══');
for (const k of ['Config', 'DEFAULTS', 'resolveConfig', 'resolveDshHome', 'resolveMemoryDir', 'resolvePaths']) {
  if (cfg[k]) ok(`导出 ${k}`); else no(`缺导出 ${k}`);
}

console.log('═══ 3. schemastery 强类型是否生效 ═══');
try {
  const inst = new cfg.Config({});
  ok('new Config({}) 构造成功');
  try {
    new cfg.Config({ retrieveTopN: 'abc' });
    no('类型校验未生效', '传字符串 retrieveTopN 竟然通过');
  } catch { ok('非法类型被拒', 'retrieveTopN="abc" → 抛错'); }
} catch (e) {
  no('Config 构造失败', e.message);
}

console.log('═══ 4. 解析出的路径有没有泄露个人目录 ═══');
// ⚠️ 这里踩过坑：第一版写成 flat.filter(([, v]) => ...) —— flat 是字符串数组，
//    解构出来的 v 永远是 undefined，正则测的是 "undefined"，永远不报错。
//    检查器失效还静默通过，比没检查更危险。改成对 [key, value] 逐个判。
const paths = cfg.resolvePaths({});
const hardcoded = ['D:\\AItools', 'AI朋友', '小满', '周默', 'dsh-precheck', 'deepseek-harness'];
const leaked = Object.entries(paths).filter(([, v]) => {
  if (v === null || v === undefined) return false;
  const s = String(v);
  return hardcoded.some((h) => s.includes(h));
});
if (leaked.length === 0) ok('无硬编码私有路径', `检查了 ${Object.keys(paths).length} 个路径 × ${hardcoded.length} 个关键词`);
else no('发现硬编码私有路径', leaked.map(([k, v]) => `${k}=${v}`).join(' | '));

// 第二条判据：路径必须由 homedir 派生（换个用户跑，结果应当自动跟着变）
const { homedir } = await import('node:os');
const home = homedir();
const notDerived = Object.entries(paths).filter(([, v]) => v !== null && v !== undefined && !String(v).startsWith(home));
if (notDerived.length === 0) ok('全部路径都由 homedir 派生（换机器自动跟随）');
else no('有路径不是从 homedir 派生', notDerived.map(([k, v]) => `${k}=${v}`).join(' | '));

console.log('    路径预览（本机解析结果，别人机器上是他们自己的 home）：');
for (const [k, v] of Object.entries(paths)) console.log(`      ${k.padEnd(16)} ${v}`);

console.log('═══ 5. resolveConfig 合并默认值 ═══');
const merged = cfg.resolveConfig({ retrieveTopN: 5 });
if (merged.retrieveTopN === 5 && merged.retrieveMinHits === 2) ok('用户值覆盖 + 其余取默认');
else no('合并结果不对', JSON.stringify({ topN: merged.retrieveTopN, minHits: merged.retrieveMinHits }));
if (merged.maxAnswerChars === 0) ok('maxAnswerChars 默认 0（不截断）');
else no('maxAnswerChars 默认不是 0', String(merged.maxAnswerChars));

console.log('═══ 6. 裸环境降级：dsh-llm 装不上时必须不崩 ═══');
const dllm = join(ROOT, 'core-plugin', 'node_modules', '@deepseek-ai', 'dsh-llm');
const stash = dllm + '.__stashed';
let stashed = false;
try {
  if (existsSync(dllm)) { renameSync(dllm, stash); stashed = true; }
  // 子进程里测，父进程的模块缓存不影响
  const { spawnSync } = await import('node:child_process');
  const code = `
    import('@deepseek-ai/dsh-llm')
      .then(() => { console.log('HAS_DLLM'); process.exit(0); })
      .catch((e) => { console.log('NO_DLLM ' + (e.code || e.message)); process.exit(0); });
  `;
  const r = spawnSync(process.execPath, ['-e', code], { cwd: join(ROOT, 'core-plugin'), encoding: 'utf8', timeout: 8000 });
  const out = (r.stdout || '').trim();
  if (out.startsWith('NO_DLLM')) ok('裸环境成立（dsh-llm 确实不可用）', out);
  else if (out.startsWith('HAS_DLLM')) no('裸环境不成立', 'dsh-llm 仍然可解析，测不到降级路径');
  else no('子进程未预期输出', out + ' / ' + (r.stderr || '').slice(0, 120));
} finally {
  if (stashed) renameSync(stash, dllm);
}

console.log(`\n合计：✅ ${pass} ｜ ❌ ${fail}`);
process.exit(fail === 0 ? 0 : 2);
