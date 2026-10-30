/**
 * rules-radar.js —— 意图雷达：判断「这一轮该把哪条规则拍给它」。
 *
 * ══════════════════════════════════════════════════════════════
 * 三分加权（2026-10-31 第五轮审查定稿）
 *
 * 上一版只看「历史行为特征」（最近调了几次 read / edit），有两个死穴：
 *   ❌ **冷启动**：新会话第一句「帮我修一下这个 Python 脚本的 bug」——
 *      没有任何历史动作，雷达全瞎，防呆锁直接失效。
 *   ❌ **上下文污染**：用户上一轮写了文件，这一轮问「帮我查唐朝官职」，
 *      还死死咬着 A3 不放 —— 用户会觉得这 AI 有神经病。
 *
 * 所以改成加权三分：
 *   ① 当前句的强指令（权重 0.6）—— **决定性**。冷启动靠它。
 *   ② 历史行为的惯性（权重 0.3）—— 只在当前句「模糊」时才加（"好" / "继续"）。
 *   ③ 物理兜底（不在本文件）—— rules-enforce.js 在工具执行层照常拦。
 *      雷达瞎了也不会漏，只是从「提前引导」降级成「物理拦截」。
 *
 * 另外两条必须有的排除：
 *   · **话题漂移**：「对了 / 另外 / 换个话题」→ 减分，让旧规则退场。
 *   · **创作类排除**：「写一段秋天的散文」是「写」，但不是「写代码」。
 *      不排掉这个，用户一说"写"就被弹防呆清单。
 * ══════════════════════════════════════════════════════════════
 */

/* ────────────────────────────────────────────────────────────
 * 一、规则清单（硬编码，不读大文件）
 * ──────────────────────────────────────────────────────────── */

export const RULE_CHECKS = {
  A3: {
    label: '写代码 / 改代码',
    toolMatch: ['write', 'edit', 'patch', 'apply_patch', 'str_replace'],
    points: [
      { id: 'exit', text: '改之前原文件备份在哪？给**完整路径**（不是"我备份了"）' },
      { id: 'syntax', text: '跑过语法检查吗？**命令原文 + 结果**（exit code / 通过 / 报错原文）' },
      { id: 'back', text: '改完**回读**了吗？那一行确实在了吗？' },
      { id: 'hits', text: '这次替换**预期命中几次**？**实际命中几次**？（给数字）' },
    ],
    checklist: [
      '【本轮触发 A3 · 写代码】在你给出修改结果**之前**，先逐条回答：',
      '1. 改之前，原文件备份在哪？（给**完整路径**，不是"我备份了"）',
      '2. 跑过语法检查吗？**命令原文 + 结果**（exit code / 通过 / 报错原文）',
      '3. 这次替换**预期命中几次**？**实际命中几次**？（给数字）',
      '4. 改完**回读**了吗？那一行确实在了吗？',
      '',
      '想跑命令取证，请在命令开头写 `READONLY:`。',
    ].join('\n'),
  },

  A5: {
    label: '报数 / 计算',
    toolMatch: [],
    points: [
      { id: 'src', text: '这个数是怎么得到的？**工具返回的原文**贴在哪？' },
      { id: 'nope', text: '没有工具返回 → 不许给数字，先说「我没数」。' },
    ],
    checklist: [
      '【本轮触发 A5 · 报数】你即将说出一个精确数量。',
      '1. 这个数是怎么得到的？**工具返回的原文**贴在哪？',
      '2. 没有工具返回 → 不许给数字，先说「我没数」。',
    ].join('\n'),
  },

  A6: {
    label: '高危 / 不可逆操作',
    toolMatch: [],
    points: [
      { id: 'exit', text: '要动的东西**备份在哪**？崩了用哪条命令退回来 —— **还原命令写不具体就别动手**' },
      { id: 'why', text: '为什么干 —— 是这件事要的，还是我脑补的额外动作？' },
      { id: 'blast', text: '会反噬到什么 —— 宿主进程 / 正在被锁的东西 / 已写好的文件？' },
    ],
    checklist: [
      '【本轮触发 A6 · 高危操作】这个动作改完可能退不回来。',
      '1. 为什么干 —— 是这件事要的，还是我脑补的额外动作？',
      '2. 会反噬到什么 —— 宿主进程 / 正在被锁的东西 / 已写好的文件？',
      '3. 崩了怎么退 —— **还原命令写不出具体的就别动手。**',
    ].join('\n'),
  },

  A7: {
    label: '重建账本 / 去重',
    toolMatch: [],
    points: [
      { id: 'dup1', text: '你把两条的**原文**都读过了吗？' },
      { id: 'dup2', text: '判的是哪一种：A/B 留档 / 真重复 / 同标题不同事？' },
      { id: 'dup3', text: '依据是原文里**哪一句**？判不清 → 停手问人。' },
    ],
    checklist: [
      '【本轮触发 A7 · 判重】',
      '1. 你把两条的**原文**都读过了吗？',
      '2. 判的是哪一种：A/B 留档 / 真重复 / 同标题不同事？',
      '3. 依据是原文里**哪一句**？判不清 → 停手问人。',
    ].join('\n'),
  },
};

/* ────────────────────────────────────────────────────────────
 * 一·B、清单融合（2026-10-31 第七轮）
 *
 * A6 + A3 同时命中时，两套清单直接拼接是 7 条问句 ——
 * 模型面对这一步的上下文压力，极可能漏答或者干脆摆烂。
 * 所以统一走融合池：同一条问法只出现一次，合并后 **最多 5 条**。
 * ──────────────────────────────────────────────────────────── */

/** 融合池。顺序 = 优先保留顺序，超出 MAX_POINTS 时先砍后面的 */
const FUSED_POOL = [
  {
    id: 'exit',
    applies: ['A3', 'A6'],
    text: '要动的东西**备份在哪**（给完整路径）？崩了用哪条命令退回来 —— **还原命令写不具体就别动手**',
  },
  { id: 'why', applies: ['A6'], text: '为什么干 —— 是这件事要的，还是我脑补的额外动作？' },
  { id: 'blast', applies: ['A6'], text: '会反噬到什么 —— 宿主进程 / 正在被锁的东西 / 已写好的文件？' },
  { id: 'syntax', applies: ['A3'], text: '跑过语法检查吗？**命令原文 + 结果**（exit code / 通过 / 报错原文）' },
  { id: 'back', applies: ['A3'], text: '改完**回读**了吗？那一行确实在了吗？' },
  { id: 'src', applies: ['A5'], text: '这个数是怎么得到的？**工具返回的原文**贴在哪？' },
  { id: 'nope', applies: ['A5'], text: '没有工具返回 → 不许给数字，先说「我没数」。' },
  { id: 'hits', applies: ['A3'], text: '这次替换**预期命中几次**？**实际命中几次**？（给数字）' },
  { id: 'dup1', applies: ['A7'], text: '你把两条的**原文**都读过了吗？' },
  { id: 'dup2', applies: ['A7'], text: '判的是哪一种：A/B 留档 / 真重复 / 同标题不同事？' },
  { id: 'dup3', applies: ['A7'], text: '依据是原文里**哪一句**？判不清 → 停手问人。' },
];

/** 一轮里模型最多看到几条核心问句 */
export const MAX_POINTS = 5;

/**
 * 把本轮命中的规则融合成一份问句清单（去重 + 截断）。
 * 只命中一条时，效果等于原来的单独清单。
 */
export function mergeChecklists(ids = [], { maxPoints = MAX_POINTS } = {}) {
  const set = new Set(ids.filter(Boolean));
  if (!set.size) return [];
  const seen = new Set();
  const out = [];
  for (const p of FUSED_POOL) {
    if (out.length >= maxPoints) break;
    if (!p.applies.some((id) => set.has(id))) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────
 * 二、特征桶（2026-10-31 第六轮：不再穷举句式，改打分）
 *
 * 上一版用「动词+名词近邻」的死正则，中文一倒装就瞎。实测三句漏两句：
 *   「bug 修一下」                    → 过（侥幸）
 *   「这个文件你看一眼哪里错」         → 漏
 *   「把 app.js 的渲染逻辑抽出来」     → 漏
 * 中文语序无穷，穷举句式是无底洞。
 *
 * 改成：同一句里出现哪些特征，各加各的分；累计 ≥ A3_THRESHOLD 就挂 A3。
 * 每个桶最多加一次分 —— 防止一句话堆十个"文件"来刷分。
 * ──────────────────────────────────────────────────────────── */

/** ① 路径 / 文件名（最强的代码语境信号，相对路径也算） */
const F_PATH =
  /(?:[A-Za-z]:[\\/]|\/(?:home|Users|opt|tmp)\/)[^\s，。]{2,}\.(?:js|mjs|ts|py|json|yml|yaml|md|ps1|sh|css|html)|(?:^|[\s"'`（(])(?:[\w.\-]+\/)*[\w.\-]+\.(?:js|mjs|ts|py|json|yml|yaml|md|ps1|sh|css|html)/i;

/** ② 故障语境。注：不单收「不对」——「我觉得这不对」是抱怨，不是排障 */
const F_FAULT =
  /(报错|出错|写错|错在|哪里错|哪有错|有错|错了|异常|挂了|崩了|跑不起来|跑不通|失败|bug|traceback|error|exception|undefined|null is not)/i;

/** ③ 代码名词 */
const F_CODE = /(代码|函数|脚本|模块|接口|变量|配置|正则|入口|依赖|类|方法|文件|schema|index|sql|query)/i;

/** ④ 动手动词。「写」单独只值 2 分，够不到阈值，所以"写篇周报"不会被弹清单 */
const F_VERB =
  /(改|修|重写|重构|替换|换成|抽|拆|补|加|删|搬|移|注入|生成|调|跑通|调通|优化|整理|写|实现|接上|对齐|统一)/;

/** ⑤ 反引号 / 代码块 */
const F_CODEBLOCK = /`[^`\n]{1,200}`|```/;

/** ⑥ 英文代码词 */
const F_EN =
  /\b(fix|refactor|patch|implement|rewrite|debug|optimi[sz]e|async|await|class|function|return|import|export|const|let|var|api|json|null)\b/i;

/**
 * ⑦ 降权桶：文本 / 文案语境。
 * 「帮我改一下这段散文，出错的地方润色一下，bug 太多」——
 * 故障(3) + 动词(2) = 5 分，会误弹代码清单。用户只是想润稿。
 * 命中这个桶就扣分：没有路径/代码块兜底时扣 5（直接压到阈值以下），有则只扣 2。
 */
const F_PROSE =
  /(散文|文章|文案|措辞|段落|这段话|作文|小说|诗|日记|台词|稿件|周报|邮件|简历|歌词|剧本|字幕|推送|朋友圈|润色)/;

/** 特征表：改权重只动这里 */
export const FEATURES = [
  { key: '路径/文件名', weight: 4, re: F_PATH },
  { key: '故障语境', weight: 3, re: F_FAULT },
  { key: '代码名词', weight: 2, re: F_CODE },
  { key: '动手动词', weight: 2, re: F_VERB },
  { key: '代码块', weight: 2, re: F_CODEBLOCK },
  { key: '英文代码词', weight: 1, re: F_EN },
];

/** 阈值：够 3 分挂 A3（一个"报错"就够，一个"写"不够） */
export const A3_THRESHOLD = 3;

/** 计算 / 报数 */
const STRONG_CALC_RE = /(几个|多少|几条|几行|几次|第几|字数|行数|个数|次数|统计一下|算一下|数一下)/;

/** 硬计量词：命中就判 A5，且主规则优先于 A3 */
const STRONG_CALC_HARD_RE = /(第几|字数|行数|个数|次数|统计一下|数一下|几条|几行|几次|几个)/;

/** 高危操作 */
const STRONG_DANGER_RE = /(删(除|掉|了)?|覆盖|清空|格式化|重置|回滚|卸载|杀掉|kill|rm\s|drop\s|truncate|--hard|强制推送|改系统|改注册表)/i;

/* ────────────────────────────────────────────────────────────
 * 三、必须排除的（防止上下文污染）
 * ──────────────────────────────────────────────────────────── */

/** 创作类："写散文/诗/小说" —— 有"写"，但不是写代码 */
const CREATIVE_WRITE_RE = /(写|作|来|编|起)[^。！？\n]{0,6}(散文|诗|小说|故事|文章|文案|歌词|段子|作文|剧本|广告语|祝福语|情书)/;

/** 明确的否定 */
const DENY_RE = /(不用写|不需要写|别写|别改|不要改|不用改|先不改|不用动代码|只是问问|说下而已)/;

/** 模糊句：当前句没信息量，才回去看历史 */
const VAGUE_RE = /^(好|好的|嗯+|哦|行|可以|继续|接着|再来|还有呢|然后呢|OK|ok)[\s，。.!！~～术]*$/;

/** 话题漂移 */
const TOPIC_SHIFT_RE = /(对了|另外|顺带|换个话题|说说别的|不聊这个|先不说这个|另一件事|扯远了)/;

/* ────────────────────────────────────────────────────────────
 * 四、意图判定：三分加权
 * ──────────────────────────────────────────────────────────── */

/**
 * 这一轮该挂哪几条规则（**复选框，不互斥**）。
 *
 * 返回值里：
 *   · `rules` —— 全部命中的规则，注入时叠加；命中 A5 不丢 A3
 *   · `rule`  —— 主规则（只用于日志/单测），优先级 A6 > A5(硬计量) > A3 > A5(软)
 *
 * @param {string} text     当前这句用户输入
 * @param {object} [history]
 * @param {number} [history.recentWriteTurns]  最近 N 轮里有几轮动过写工具
 * @param {number} [history.turnsSinceWrite]   距上次写工具几轮
 * @param {string[]} [history.lastToolNames]   最近几轮的工具名
 */
export function detectIntent(text, history = {}) {
  const t = String(text || '');
  const reasons = [];
  const rules = [];
  const empty = (why) => ({ rule: null, rules: [], score: 0, reasons: [why], vague: false });

  if (!t.trim()) return empty('空输入');

  // ── 否决：用户明说别动 / 创作类 ──
  if (/不(要|用|需|必)(删|动|清|覆盖|改)/.test(t)) return empty('用户明确否定危险动作');
  if (DENY_RE.test(t)) return empty('用户明确否定');
  if (CREATIVE_WRITE_RE.test(t)) return empty('创作类写作，不是写代码');

  const vague = VAGUE_RE.test(t.trim());
  const shifted = TOPIC_SHIFT_RE.test(t);

  // ── 打分：特征桶各加一次 ──
  let score = 0;
  for (const f of FEATURES) {
    if (f.re.test(t)) {
      score += f.weight;
      reasons.push(`+${f.weight} ${f.key}`);
    }
  }
  if (shifted) {
    score -= 4;
    reasons.push('-4 话题漂移');
  }

  // ── 文本 / 润色语境：对冲代码特征，别把改散文判成改代码 ──
  if (F_PROSE.test(t)) {
    const anchored = F_PATH.test(t) || F_CODEBLOCK.test(t);
    const cut = anchored ? 2 : 5;
    score -= cut;
    reasons.push(`-${cut} 文本润色语境${anchored ? '（有路径/代码块兜底，只扣 2）' : ''}`);
  }

  // ── 历史惯性：只在模糊句（"好"/"继续"）上补 ──
  const recentWrite = Number(history.recentWriteTurns || 0);
  const since = Number(history.turnsSinceWrite);
  const tools = Array.isArray(history.lastToolNames) ? history.lastToolNames.map((x) => String(x).toLowerCase()) : [];
  const wroteRecently = tools.some((x) => /^(write|edit|patch)$/.test(x)) || recentWrite > 0;

  if (vague && wroteRecently) {
    rules.push('A3');
    reasons.push('惯性:模糊句+刚动过写工具（续期）');
  } else if (!vague && Number.isFinite(since) && since <= 2 && wroteRecently) {
    score += 1;
    reasons.push('+1 惯性:距上次写入≤2轮');
  }

  // ── 组装：叠加，不互斥 ──
  const danger = STRONG_DANGER_RE.test(t);
  const hardCalc = STRONG_CALC_HARD_RE.test(t);
  const softCalc = !hardCalc && STRONG_CALC_RE.test(t);

  if (danger) {
    rules.unshift('A6');
    reasons.push('命中:A6 高危');
  }
  if (score >= A3_THRESHOLD) {
    rules.push('A3');
    reasons.push(`命中:A3 特征分 ${score}≥${A3_THRESHOLD}`);
  }
  if (hardCalc || softCalc) {
    rules.push('A5');
    reasons.push(hardCalc ? '命中:A5 硬计量' : '命中:A5 软计量');
  }

  // 去重，保持顺序（A6 在前）
  const uniq = [...new Set(rules)];

  // 主规则：只做展示/日志用，注入按 uniq 全上
  let rule = null;
  if (uniq.includes('A6')) rule = 'A6';
  else if (uniq.includes('A5') && hardCalc) rule = 'A5';
  else if (uniq.includes('A3')) rule = 'A3';
  else if (uniq.includes('A5')) rule = 'A5';

  return { rule, rules: uniq, score: Math.max(0, score), reasons, vague };
}

/** 兼容旧接口：从 messages 抽上下文（工具名 + 文本） */
export function readContext(messages, { lookback = 3 } = {}) {
  if (!Array.isArray(messages)) return { text: '', tools: [], assistantText: '' };
  const recent = messages.slice(-Math.max(2, lookback * 2));
  const texts = [];
  const tools = [];
  let assistantText = '';
  for (const m of recent) {
    const parts = Array.isArray(m?.content) ? m.content : [];
    for (const p of parts) {
      if (!p || typeof p !== 'object') continue;
      if (p.type === 'text' && typeof p.text === 'string') {
        texts.push(p.text);
        if (m.role === 'assistant') assistantText += p.text;
      } else if (p.type === 'tool-call' || p.type === 'toolCall') {
        const name = p.name || p.toolName || p?.function?.name || '';
        if (name) tools.push(String(name).toLowerCase());
      }
    }
  }
  return { text: texts.join('\n'), tools, assistantText };
}

/* ────────────────────────────────────────────────────────────
 * 五、状态：按任务生命周期存活
 * ──────────────────────────────────────────────────────────── */

export const TASK_END_RE = /(搞定了|结束了|完事了|收工|可以了|不用了|先到这|就到这|谢谢，够了|没事了)/;
export const TASK_CONTINUE_RE = /(继续|接着|还有|那个|刚才|上面|前面|再改|再来|顺便)/;

export function createRadarState({ cooldownTurns = 8, calmAfterSteps = 3 } = {}) {
  const active = new Map();
  let calmSteps = 0;

  return {
    hit(id, turn = 0) {
      const cur = active.get(id) || {};
      active.set(id, { ...cur, lastHitTurn: turn });
    },
    tick(turn = 0, text = '') {
      const s = String(text || '');
      if (TASK_END_RE.test(s)) {
        active.clear();
        return { cleared: true, reason: 'task-end' };
      }
      if (TASK_CONTINUE_RE.test(s)) {
        for (const [id, v] of active) active.set(id, { ...v, lastHitTurn: turn });
        return { cleared: false, reason: 'continue' };
      }
      for (const [id, v] of [...active]) {
        if (turn - (v.lastHitTurn ?? 0) >= cooldownTurns) active.delete(id);
      }
      return { cleared: false, reason: 'idle' };
    },
    list() { return [...active.keys()]; },
    needsInject(id, turn = 0) {
      const s = active.get(id);
      return !s || s.lastInjectTurn !== turn;
    },
    markInjected(id, turn = 0) {
      const cur = active.get(id) || {};
      active.set(id, { ...cur, lastInjectTurn: turn });
    },
    /**
     * 报一步执行结果。**判据是「有没有出事」，不是「跑了几步」。**
     *
     * 连续 calmAfterSteps 步都没出事 → 进「精简模式」，少念经。
     * 一旦出现下列任一情况，立刻清零、退回完整清单：
     *   · 工具调用报错（非 0 退出 / 抛异常）
     *   · 语法检查没过
     *   · 被 enforce 层 deny 过
     *
     * 兼容两种调用：
     *   noteStep(true)                                  // 旧签名，布尔
     *   noteStep({ ok:false, hadToolError:true })       // 新签名
     *   noteStep({ hadSyntaxError:true })
     */
    noteStep(input = true) {
      let ok;
      if (typeof input === 'boolean') {
        ok = input;
      } else {
        const { ok: explicit, hadToolError, hadSyntaxError, denied, exitCode } = input || {};
        if (typeof explicit === 'boolean') ok = explicit;
        else ok = !hadToolError && !hadSyntaxError && !denied && !(Number(exitCode) > 0);
      }
      calmSteps = ok ? calmSteps + 1 : 0;
      return this.isTerse();
    },
    /** 出事了：直接退出精简模式，不等计数 */
    fail() {
      calmSteps = 0;
      return false;
    },
    isTerse() { return calmSteps >= calmAfterSteps; },
    _dump() { return Object.fromEntries(active); },
    reset() { active.clear(); calmSteps = 0; },
  };
}

/* ────────────────────────────────────────────────────────────
 * 六、渲染
 * ──────────────────────────────────────────────────────────── */

/**
 * 渲染要注入的清单 —— 一律走 mergeChecklists 融合，最多 MAX_POINTS 条。
 *
 * terse = true 时只出「短标题 + 第 1 条问句」，2 行以内 ——
 * 给已经连着跑通、没出过错的会话用，避免每轮重复喂整份清单。
 */
export function renderChecklist(ids, rules = RULE_CHECKS, { maxChars = 1600, terse = false, maxPoints = MAX_POINTS } = {}) {
  const active = (ids || []).filter((id) => rules[id]);
  if (!active.length) return { text: '', truncated: false, ids: [], terse, points: 0 };

  const points = mergeChecklists(active, { maxPoints });

  if (!points.length) {
    // 命中了规则但融合池里没有对应条目（自定义 rules）→ 退回原始 checklist
    const raw = active.map((id) => rules[id].checklist).filter(Boolean);
    return { text: raw.join('\n\n'), truncated: false, ids: active, terse, points: 0 };
  }

  let text;
  if (terse) {
    text = `【${active.join('+')}·精简】${points[0].text}`;
  } else {
    const head = `【本轮触发 ${active.join(' + ')}】在你给出结果**之前**，先逐条回答（最多 ${maxPoints} 条，别答成作文）：`;
    const body = points.map((p, i) => `${i + 1}. ${p.text}`).join('\n');
    const tail = '想跑命令取证，请在命令开头写 `READONLY:`。';
    text = `${head}\n${body}\n\n${tail}`;
  }

  let truncated = false;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…（清单过长已截断）`;
    truncated = true;
  }
  return { text, truncated, ids: active, terse, points: points.length };
}

/** 单条规则是否命中（保留给旧测试与 toolMatch 场景） */
export function matchOne(rule, ctx) {
  if (!rule) return { hit: false, by: null };
  if (rule.toolMatch?.length) {
    const hit = (ctx?.tools || []).some((t) => rule.toolMatch.some((k) => String(t).includes(k)));
    if (hit) return { hit: true, by: 'tool' };
  }
  return { hit: false, by: null };
}

/**
 * 本轮该注入哪几条规则（叠加，不互斥）。
 *
 * 两条路一起走（缺一条就是残的）：
 *   ① 意图：只看用户这句话，**不依赖历史** —— 冷启动（新会话第一句就说"帮我修这个 bug"）靠这条
 *   ② 工具：本轮调用过 write/edit 之类，工具名命中 rule.toolMatch —— 作为补充
 *
 * 旧版只走了 ②，于是新会话第一句话永远返回 []，整套防呆静默失效。
 *
 * 返回：{ ids, intent } 也有兼容形态 —— 传 `{ format: 'array' }` 时只返回字符串数组。
 */
export function scanRules(ctx = {}, rules = RULE_CHECKS) {
  const out = [];
  const tools = Array.isArray(ctx?.toolNames)
    ? ctx.toolNames
    : Array.isArray(ctx?.tools)
      ? ctx.tools
      : [];
  const userText = ctx?.userText || ctx?.text || '';
  const history = ctx?.history || {
    lastToolNames: tools,
    recentWriteTurns: ctx?.recentWriteTurns,
    turnsSinceWrite: ctx?.turnsSinceWrite,
  };

  // ① 意图路（冷启动也能触发；可能一次挂好几条）
  const intent = detectIntent(userText, history);
  for (const id of intent?.rules || []) {
    if (rules[id] && !out.includes(id)) out.push(id);
  }

  // ② 工具路（工具名命中，作补充）
  for (const [id, r] of Object.entries(rules)) {
    if (out.includes(id)) continue;
    if (matchOne(r, { ...ctx, tools }).hit) out.push(id);
  }

  return out;
}

/** 带完整诊断信息的版本，接线时用这个（能拿到 reasons / score 写日志） */
export function scanRulesDetailed(ctx = {}, rules = RULE_CHECKS) {
  const ids = scanRules(ctx, rules);
  const intent = detectIntent(ctx?.userText || ctx?.text || '', ctx?.history || {
    lastToolNames: Array.isArray(ctx?.toolNames) ? ctx.toolNames : [],
    recentWriteTurns: ctx?.recentWriteTurns,
    turnsSinceWrite: ctx?.turnsSinceWrite,
  });
  return { ids, intent };
}
