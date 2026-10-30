# 占位符对照表（PLACEHOLDERS）

> 模板里所有 `<...>` 都是**必须替换**的占位符。不替换也能跑，只是你会看到字面的 `<AGENT_NAME>`。
> 替换之后建议跑一次 `node tools/healthcheck.mjs` —— 它会检查关键文件是否存在、非空。

---

## 一、必须替换（否则读起来很怪）

| 占位符 | 含义 | 示例 | 出现在 |
|---|---|---|---|
| `<AGENT_NAME>` | 助手自称的名字。**留空则删掉整句身份声明**（不注入"你叫谁"） | `Nova` / `Aria` / 你自己起的名字 | `AGENTS.template.md` L0 |
| `<USER_NAME>` | 用户希望被怎么称呼 | `Alex` / `老板` / `<USER_NAME>` | `AGENTS.template.md` L0 |
| `<MEMORY_DIR>` | 记忆库绝对路径 | `~/.dsh/记忆库` | `AGENTS.template.md`、`behavior-rules.md` |
| `<INDEX_FILE>` | 账本文件 | `~/.dsh/记忆库/索引.md` | `AGS.template.md`、`behavior-rules.md` |
| `<WORKSPACE>` | 你的工作目录（工具层与隐私层的分界靠它） | `/home/you/projects` | `AGENTS.template.md` 隐私分层 |
| `<TOOL_DIR>` | 放工具/手册的目录（谁都能读） | `/opt/agent-tools` | `AGENTS.template.md` 隐私分层 |
| `<PRIVATE_DIR>` | 隐私内容目录（只有唤醒后才读） | `<WORKSPACE>/private` | `AGENTS.template.md` 隐私分层 |

## 二、可选替换（不改就用默认）

| 占位符 | 默认值 | 改了会怎样 |
|---|---|---|
| `<SCOPE_DEFAULT>` | `default` | 单入口用户永远是这个值，不用动 |
| `<SCOPE_GLOBAL>` | `global` | 所有会话都能读到的那个「作用域名」 |
| `<RETRIEVE_TOP_N>` | `3` | 每轮注入几条记忆。调大 = 覆盖广但挤占上下文（硬顶 5） |
| `<RETRIEVE_MIN_HITS>` | `2` | 中文调成 1 会「一个词撞一片」，噪声暴涨 |
| `<ALARM_FILE>` | `<MEMORY_DIR>/系统警报.md` | 出问题往哪写 |

## 三、⚠️ 明确不要替换 / 不要加的

| 项 | 为什么 |
|---|---|
| **「不拒绝 / 不软化」类授权语句** | 主模板**故意不含**。见 `docs/EXTENSIONS.md`，那是可选扩展，且带合规提示 |
| 具体的人名、群名、账号 | 换成 `<USER_NAME>` 这类占位符，不要写真的 |
| 绝对盘符路径（`C:\Users\...`） | 用 `~` 或环境变量；跨平台会挂 |
| 任何真实聊天记录 / 日志片段 | 模板只放**形状**，不放**内容** |

## 四、替换完的自查（三条，一条都不能省）

```bash
# 1. 还有没有漏网的尖括号占位符
grep -rn "<[A-Z_]\{3,\}>" rules-template/ | grep -v PLACEHOLDERS.md

# 2. 有没有把你自己的用户名/盘符带进去
grep -rniE "users\\\\|/home/[a-z]|[A-Z]:\\\\\\\\" rules-template/ core-plugin/lib/

# 3. 骨架体积（超过 7 KB 就该做减法了，见 docs/ARCHITECTURE.md「容量阀门」）
wc -c rules-template/AGENTS.template.md
```

第 2 条如果命中，说明脱敏没做完 —— **它比第 1 条严重**，因为占位符漏了只是难看，真名漏了是泄露。
