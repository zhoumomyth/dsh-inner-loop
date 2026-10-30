/**
 * rules-enforce.js —— 执行层：判定「这次工具调用该不该被 A3 拦」。
 *
 * ══════════════════════════════════════════════════════════════
 * 设计原则（2026-10-31 架构审查三轮定稿）
 *
 * ① **默认不可信**，不枚举危险工具，而是只信一份只读白名单。
 *    不认识的一律按危险处理 —— 这样明天接进来的 `mcp__sql__execute`、
 *    `python_execute`、`my_new_db_writer` 天然被覆盖，不用改代码。
 *
 *    反面证据（MCP SDK 自己的注释）：
 *      "Clients should never make tool use decisions based on ToolAnnotations
 *       received from untrusted servers."
 *    → 所以**不能**用 `readOnlyHint` 这类工具自述做安全边界。
 *
 * ② **bash 不能一刀切**。A3 清单要求「备份路径」和「语法检查结果」，
 *    模型必须调 bash 才能拿到（ls / node --check）。
 *    如果连这些也拦，清单永远完不成，模型只能编路径 —— 那是把防呆锁变成幻觉发生器。
 *    所以 bash 按**命令前缀白名单**放行，但出现管道/重定向就降级。
 *    （注意：这不是"穷举危险模式"，是白名单 + 少量防御性降级。）
 *
 * ③ **熔断绝不放行**。`ask` 在无人值守 / IM 通道会挂死；
 *    无条件放行会让 `rm -rf` 直接落地。
 *    所以第 N 次起：继续 deny + 标记「本轮写入权限已回收」+ 写警报，
 *    并在下一步注入一条最高优先级提醒。
 *    ⚠️ 界限：`pre-execute` **无法清空本轮 tool_calls**（那是模型的输出，
 *       不是我们能改的输入）；能做的只有拒 + 通知。
 * ══════════════════════════════════════════════════════════════
 */

/* ────────────────────────────────────────────────────────────
 * 一、工具判定
 * ──────────────────────────────────────────────────────────── */

/**
 * 只读工具白名单 —— **这是唯一的信任来源**。
 * 不在这个列表里的工具，A3 激活时一律拦截。
 */
export const DEFAULT_READONLY_TOOLS = [
  'read',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'read_image',
  // UI / 状态类：有副作用但不碰文件/系统/网络，不该让用户被弹窗骚扰
  'present',
  'todo_write',
  'ask_user_question',
];

/** 万能执行器：里面装什么都可能，所以要看命令本身 */
export const DEFAULT_EXECUTORS = [
  'bash', 'pwsh', 'powershell', 'shell', 'sh', 'cmd',
  'python', 'python3', 'python_execute', 'node', 'deno', 'bun',
];

/**
 * ⚠️ **不再解析命令字符串**（2026-10-31 第四轮审查推翻）。
 *
 * 教训：`node --check a.js && rm -rf /` 用前缀匹配拦不住；
 * 而用正则解析整句是无底洞（`node -e "require('fs').rmSync(...)"` 怎么写都能绕过）。
 *
 * 改成**显式声明协议**：模型想执行命令，必须在命令开头写 `READONLY:`。
 *   READONLY: ls -la            → 放行
 *   READONLY: node --check a.js → 放行
 *   ls -la                      → 拦（没声明）
 *
 * 声明了却夹带私货（`READONLY: ls && rm -rf /`）→ **那是它的诚信问题**，
 * 不再在字符串解析上死磕。系统的责任是「要求声明」，不是「验证声明真假」。
 */
export function isDeclaredReadonly(cmd) {
  return /^\s*READONLY:\s*\S/i.test(String(cmd || ''));
}

/** 去掉 READONLY: 前缀，拿到真正要执行的命令（供审计用） */
export function stripReadonlyPrefix(cmd) {
  return String(cmd || '').replace(/^\s*READONLY:\s*/i, '');
}

/* ────────────────────────────────────────────────────────────
 * 一·B、三级漏斗（2026-10-31 第八轮：Fast-Path）
 *
 * `READONLY:` 口令作废 —— 它只是个暗号：系统既没剥掉它，也没验剥完的内容。
 * 实测中被 `READONLY: ; 任意命令` 一次就绕过。
 *
 * 改成三级（危险符号优先于白名单，顺序不能反）：
 *   ① safe    已知只读前缀 + 不含危险符号 → 直接放行，连清单都不用答
 *   ② unknown 不在白名单、也不危险（netstat 这种）→ 退回 A3 清单问询
 *   ③ danger  带 ; | > && rm del Set-Content 之类，或用废弃口令 → 直接 deny
 * ──────────────────────────────────────────────────────────── */

/** 危险符号 / 危险词：命中就进第三级，不给答题机会 */
export const DANGER_CMD_RE = new RegExp(
  [
    '[;]',
    '&&',
    '\\|\\|',
    '[|]',
    '>',
    '\\b(?:rm|del|erase|rmdir|rd|mv|move|cp|copy|xcopy|ren|rename)\\b',
    '\\b(?:Set-Content|Add-Content|Clear-Content|Out-File|New-Item|Remove-Item|Copy-Item|Move-Item|Rename-Item|Start-Process|Stop-Process|Invoke-Expression|Invoke-WebRequest|Invoke-RestMethod)\\b',
    '\\b(?:curl|wget|scp|ssh|chmod|chown|sudo|reg\\s+add)\\b',
    '\\b(?:python|python3|node|deno|bun)\\b[^\\n]*\\s-e\\s',
  ].join('|'),
  'i',
);

/** 一级白名单：明确的只读前缀。命中且不危险 → 快速通道，不用答清单 */
export const SAFE_CMD_RE = new RegExp(
  '^\\s*(?:' + [
    'Get-Content', 'Get-ChildItem', 'Get-Item', 'Get-ItemProperty', 'Get-Location',
    'Get-Date', 'Get-Command', 'Get-Process', 'Get-Service', 'Test-Path',
    'Select-String', 'Measure-Object', 'Resolve-Path', 'Split-Path', 'Join-Path',
    'Select-Object', 'Sort-Object', 'Where-Object', 'Format-Table', 'Format-List',
    'ConvertTo-Json', 'ConvertFrom-Json', 'Out-String', 'Write-Output',
    'cat', 'ls', 'dir', 'type', 'head', 'tail', 'more', 'less', 'pwd', 'echo',
    'which', 'whereis', 'wc', 'stat', 'findstr', 'grep', 'rg',
    'netstat', 'ipconfig', 'systeminfo', 'tasklist', 'hostname', 'whoami',
    'git\\s+(?:status|diff|log|show|branch|remote|rev-parse|describe)',
    'node\\s+--check', 'node\\s+--version', 'npm\\s+(?:ls|list|view)', 'pnpm\\s+(?:list|ls)',
  ].join('|') + ')\\b',
  'i',
);

/** 已作废的口令：出现就 deny，不再猜意图 */
export const DEPRECATED_READONLY_RE = /^\s*READONLY:/i;

/**
 * 插件自身体检命令（2026-10-31 老板下的死命令）。
 *
 * 老板原话：「你造的安全系统把你自己锁死了，还要老板帮你敲命令检查，这是极其失败的。」
 * 凡是体检自己的命令，一律放行、不进熔断计数：
 *   node --check x.js / node --version / node --test x.mjs
 *   C:\...\node.exe --check x.js        （node 不在 PATH 时的写法，实测必须支持）
 *   cd <目录> / push-location <目录> / pop-location   （前置切目录）
 *
 * 防夹带：**按分隔符切段，每一段都必须是体检命令**才算数。
 *   cd D:\x ; node --check a.js      → 两段都合规 → 放行
 *   node --check a.js && rm -rf /    → 第二段不合规 → 落到下面重新判
 */
export const SELF_CHECK_SEGMENT_RE = new RegExp(
  '^\\s*(?:' + [
    'cd\\s+\\S+',
    'push-location\\s+\\S+',
    'pop-location',
    '(?:[A-Za-z]:[\\\\/][^\\s]*[\\\\/])?node(?:\\.exe)?\\s+--(?:check|version|test)\\b.*',
  ].join('|') + ')$',
  'i',
);

export function isSelfCheckCommand(cmd) {
  const segs = String(cmd || '').split(/[\r\n;]+|&&|\|\|/).map((s) => s.trim()).filter(Boolean);
  if (segs.length === 0) return false;
  return segs.every((s) => SELF_CHECK_SEGMENT_RE.test(s));
}

/**
 * 万能执行器的命令分级。
 *
 * 🔴 2026-10-31 第九轮：DANGER 不再"直接死"。
 * 上一版把 `Copy-Item`（备份）也判成 danger 硬拦，结果**连备份都做不了**，
 * 答满清单照样被拒 —— 笼子把开锁的钥匙也锁在里面了。
 * 现在只有「用废弃口令夹带」才是真 danger；其余危险命令降级成 unknown，
 * 走 A3 清单：答满四条放行，不答才拦。
 *
 * @returns {'safe'|'unknown'|'danger'}
 */
export function classifyCommand(cmd, conf = {}) {
  const c = String(cmd || '').trim();
  if (!c) return 'danger';
  // 🔴 最高优先级：插件体检命令无条件放行，绝不拦截、绝不计数
  if (isSelfCheckCommand(c)) return 'safe';
  if (DEPRECATED_READONLY_RE.test(c)) return 'danger';      // 废弃口令：作弊通道，硬拦
  if (DANGER_CMD_RE.test(c)) return 'unknown';              // 危险命令：降级为"要清单"
  if (SAFE_CMD_RE.test(c)) return 'safe';
  const extra = Array.isArray(conf.safeReadonlyPrefixes) ? conf.safeReadonlyPrefixes : [];
  for (const p of extra) {
    if (!p || typeof p !== 'string') continue;
    try { if (new RegExp('^\\s*(?:' + p + ')', 'i').test(c)) return 'safe'; } catch { /* 用户写坏的正则：忽略 */ }
  }
  return 'unknown';
}

/** 归一化：小写 + 取 mcp__<srv>__<tool> 的最后一段 */
export function normalizeToolName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return '';
  return n.includes('__') ? n.split('__').pop() : n;
}

/** 从 exec.arguments 里尽量挖出命令文本（不同执行器字段名不一样） */
export function extractCommand(args) {
  if (!args || typeof args !== 'object') return '';
  for (const k of ['command', 'cmd', 'script', 'code', 'input', 'source']) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * 判定一个工具调用的性质。
 *
 * @param {string} name            exec.name
 * @param {object} args            exec.arguments
 * @param {object} conf
 * @param {string[]} [conf.readOnlyTools]
 * @param {string[]} [conf.customWriteTools]
 * @param {string[]} [conf.executors]
 * @returns {'readonly'|'write'}
 */
export function classifyTool(name, args, conf = {}) {
  const n = normalizeToolName(name);
  if (!n) return 'write'; // 名字都没有 → 保守按危险

  const readonly = new Set((conf.readOnlyTools ?? DEFAULT_READONLY_TOOLS).map(normalizeToolName));
  const customWrite = new Set((conf.customWriteTools ?? []).map(normalizeToolName));
  const executors = new Set((conf.executors ?? DEFAULT_EXECUTORS).map(normalizeToolName));

  // ① 只读白名单：唯一可信来源
  if (readonly.has(n)) return 'readonly';

  // ② 用户显式声明的写工具
  if (customWrite.has(n)) return 'write';

  // ③ 万能执行器：只认 READONLY: 声明，不解析命令内容
  if (executors.has(n)) {
    const cmd = extractCommand(args);
    if (!cmd) return 'write';
    return isDeclaredReadonly(cmd) ? 'readonly' : 'write';
  }

  // ④ 未知工具：默认不可信
  return 'write';
}

/* ────────────────────────────────────────────────────────────
 * 二、读取最近一条 assistant 的话（含 reasoning）
 * ──────────────────────────────────────────────────────────── */

export function readAssistantText(session) {
  if (!session || typeof session.snapshotEvents !== 'function') return null;
  try {
    const events = session.snapshotEvents();
    if (!Array.isArray(events)) return null;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i];
      if (e?.type !== 'assistant/message') continue;
      const parts = e?.data?.message?.content;
      if (!Array.isArray(parts)) continue;
      const texts = [];
      for (const p of parts) {
        if (!p || typeof p !== 'object') continue;
        // reasoning 也要收：带 CoT 的模型会把清单答在思考里，正文只有工具调用
        if (p.type === 'text' || p.type === 'reasoning') {
          const t = typeof p.text === 'string' ? p.text : typeof p.reasoning === 'string' ? p.reasoning : '';
          if (t) texts.push(t);
        }
      }
      const joined = texts.join('\n');
      if (joined.trim()) return joined;
    }
    return '';
  } catch {
    return null;
  }
}

/* ────────────────────────────────────────────────────────────
 * 三、熔断：不放行、不 ask，改为「回收写入权限」
 * ──────────────────────────────────────────────────────────── */

/**
 * @param {object} opts
 * @param {number} [opts.limit=3]  第几次起回收权限
 */
export function createBreaker({ limit = 3 } = {}) {
  /** key → { count, revoked } */
  const state = new Map();
  const keyOf = (session, ruleId) => `${session?.id ?? 'anon'}::${ruleId}`;

  return {
    /** 记一次拒绝，返回 { count, revoked } */
    deny(session, ruleId) {
      const k = keyOf(session, ruleId);
      const cur = state.get(k) || { count: 0, revoked: false };
      cur.count += 1;
      if (cur.count >= limit) cur.revoked = true;
      state.set(k, cur);
      return { ...cur };
    },

    /** 本项目/本会话的写入权限是否已被回收 */
    isRevoked(session, ruleId) {
      return !!state.get(keyOf(session, ruleId))?.revoked;
    },

    count(session, ruleId) {
      return state.get(keyOf(session, ruleId))?.count ?? 0;
    },

    /** 用户明确表示结束、或任务边界过了 → 复位 */
    reset(session, ruleId) {
      if (ruleId) state.delete(keyOf(session, ruleId));
      else state.clear();
    },

    dispose(session) {
      const pre = `${session?.id ?? 'anon'}::`;
      for (const k of [...state.keys()]) if (k.startsWith(pre)) state.delete(k);
    },

    _dump() {
      return Object.fromEntries(state);
    },
  };
}

/* ────────────────────────────────────────────────────────────
 * 四、格式复查（只判格式到没到，不判真假）
 * ──────────────────────────────────────────────────────────── */

const ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\/(?:home|Users|opt|tmp|var|root|mnt)\/)[^\s，。；、）)]{2,}/;

export const A3_FORM_CHECKS = [
  { key: '备份路径', re: ABS_PATH_RE },
  {
    key: '语法检查',
    re: /(exit\s*(?:code)?\s*[:=]?\s*0\b|退出码\s*[:=]?\s*0\b|语法通过|无语法错误|编译通过|--check|py_compile|--noEmit)/i,
  },
  { key: '命中次数', re: /\d+\s*(?:次|处|条)/ },
  { key: '回读', re: /(回读|重新读|再看一遍|复读|确认[^。\n]{0,12}(在|已改|存在))|read[^\n]{0,20}(回读|again)/i },
];

export function checkA3Format(text, checks = A3_FORM_CHECKS) {
  const t = String(text || '');
  const passed = [];
  const missing = [];
  for (const c of checks) {
    if (c.re.test(t)) passed.push(c.key);
    else missing.push(c.key);
  }
  return { hits: passed.length, total: checks.length, missing, passed };
}

export const A3_PASS_THRESHOLD = 3;

export function a3Passed(text) {
  return checkA3Format(text).hits >= A3_PASS_THRESHOLD;
}

/* ────────────────────────────────────────────────────────────
 * 五、文案
 * ──────────────────────────────────────────────────────────── */

export function denyReason(info, toolName) {
  return [
    '【A3 拦截 · 工具未执行】',
    `你想调用的 \`${toolName}\` 会改变文件或系统状态，但 A3 检查清单只答了 ${info.hits}/${info.total} 条。`,
    `缺：${info.missing.join('、')}`,
    '',
    '先把缺的补上（可以先用只读命令查：ls / cat / node --check / py_compile），再调用写入。',
    '四条是：1. 备份绝对路径 · 2. 语法检查命令+结果 · 3. 命中次数 · 4. 回读确认',
  ].join('\n');
}

/**
 * 权限锁死后的通告。
 *
 * 2026-10-31 第四轮审查：光 deny 会让模型无限对撞（第 4、5、6 次还在请求）。
 * 所以 reason 里必须给**逃生通道** —— 明确要求它停止调工具、转纯文本交给人。
 */
/** 第三级：命中危险符号/危险词 */
export function nonReadonlyReason(toolName, cmd) {
  return [
    '【A3 拦截 · 非只读命令】',
    `\`${toolName}\` 这次要跑的命令带着写入或拼接符号，不能当只读放行。`,
    `命令：${String(cmd).slice(0, 200)}`,
    '',
    '命中危险符号/危险词（`;` `|` `>` `&&` `rm` `del` `Set-Content` `Out-File` 之类）。',
    '要真写东西 → 按 A3 清单答满四条再来；只是看一眼 → 换成不带拼接的单条只读命令。',
  ].join('\n');
}

/** 第三级：还在用已废弃的 READONLY: 口令 */
export function readonlyDeprecatedReason(toolName) {
  return [
    '【A3 拦截 · 口令已作废】',
    `\`${toolName}\` 用了 \`READONLY:\` 前缀 —— 这个口令 2026-10-31 起废弃。`,
    '',
    '原因：它只是个暗号，系统没法验证剥掉前缀之后你还跑不跑别的。实测 `READONLY: ; 任意命令` 一次就绕过去了。',
    '',
    '现在三条路：',
    '1. 只读命令直接跑（Get-Content / ls / cat / grep / node --check / git status …）不用加任何前缀',
    '2. 不在白名单的只读命令（如 netstat）→ 答 A3 清单后放行',
    '3. 写操作 / 带拼接符号 → 别想绕',
  ].join('\n');
}

/** 第二级：不在白名单，但也没看到危险符号 */
export function unknownCommandReason(toolName, cmd) {
  return [
    '【A3 问询 · 不在只读快车道】',
    `\`${toolName}\` 要跑的 \`${String(cmd).slice(0, 120)}\` 不在已知只读白名单里，但也没看到危险符号。`,
    '',
    '如果是只读操作：在正文里答 A3 清单（说明不写文件），答满 3 条就放行。',
    '嫌麻烦就换 read / grep 这类原生只读工具。',
    '确认它长期安全 → 让用户把它加进 config 的 safeReadonlyPrefixes。',
  ].join('\n');
}

export function revokeNotice(toolName, count) {
  return [
    '【A3 · 写入权限已锁死】',
    `你已连续 ${count} 次被拦截，始终没有回答 A3 检查清单。`,
    `本次 \`${toolName}\` **未执行**。`,
    '',
    '## 立即停止调用工具。',
    '',
    '改为**纯文本**向用户报告三件事：',
    '1. 你想改哪个文件（完整路径）',
    '2. 打算怎么改（说清改动内容）',
    '3. 为什么必须改',
    '',
    '由人决定下一步。系统在无人工确认的情况下不会再放行任何写入。',
  ].join('\n');
}

/** 下一步注入的最高优先级提醒（由 pre-step 用） */
export function revokedReminder() {
  return [
    '【系统提示 · 写入权限已回收】',
    '上一轮你连续多次在没答 A3 清单的情况下尝试写文件，本轮写入权限已被回收。',
    '要恢复：先在正文或思考里按顺序答完这四条 ——',
    '1. 备份的绝对路径',
    '2. 语法检查命令 + 结果（exit 0 / 通过）',
    '3. 替换预期命中几次 / 实际几次',
    '4. 回读确认',
  ].join('\n');
}
