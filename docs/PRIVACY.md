# PRIVACY · 脱敏规则与发布前自查

> 这份文档解决一个问题：**怎么保证发出去的包里没有你的隐私。**
> 里面每一条坑都是实际踩过的，不是想象出来的。

---

## 一、脱敏规则（改代码前先过一遍）

| 类型 | 不许出现 | 正确写法 |
|---|---|---|
| 用户目录 | `C:\Users\某个名字` / `/home/某个名字` | `os.homedir()` / `~` |
| 盘子路径 | `D:\AItools\...` 这类固定位置 | `path.resolve(__dirname, '..')` 或配置项 |
| 人名称呼 | 真名、昵称、助手名 | `<USER_NAME>` / `<AGENT_NAME>` 占位符 |
| 聊天软件耦合 | QQ 号、群号、`qq-bridge` 文件名 | 抽成 `scopeProvider` 扩展点 |
| 业务专名 | 特定比赛、特定行业词 | 配置数组，默认空 |
| 真实数据 | 记忆索引、事件流、日志、证据 | 一律不进仓库（见 `.gitignore`） |

**判据一句话**：换个陌生人 clone 下来，读到这段会不会知道他跟谁在用什么？

---

## 二、发布前检查清单（按顺序，一条都不能跳）

```bash
# 1. 代码层：有没有硬编码的私有路径
node tests/runtime-check.mjs

# 2. 文本层：占位符有没有漏、有没有真名
grep -rnE "<[A-Z_]{3,}>" rules-template/ | grep -v PLACEHOLDERS.md
grep -rniE "users[\\\\/]|d:\\\\aitools|/home/[a-z]" rules-template/ core-plugin/lib/ | grep -v PLACEHOLDERS.md

# 3. 打包层：最终发出去的包里到底有什么（.gitignore 挡不住已 git add 的文件）
npm pack --dry-run 2>&1 | tee pack-list.txt
#    人工过一遍：不许有 *.md 数据、*.bak_*、tmp/、证据目录、警报文件

# 4. 依赖层：删掉 node_modules 从零装一次，确认开箱即用
rm -rf node_modules && npm install && node tests/runtime-check.mjs
```

**第 3 条是最硬的闸**：`npm pack` 看的是「别人拿到手的那个压缩包」，不是你的工作区。

---

## 三、已知坑（三条，都是实际发生的）

### 坑 1 · 为什么我的脱敏检查器会查到自己？

第一次写自查命令时：

```bash
grep -rniE "users\\\\|/home/[a-z]|[A-Z]:\\\\" rules-template/
```

结果**命中了两处，都在 `PLACEHOLDERS.md` 里** —— 一处是我故意写的反例 `C:\Users\...`，另一处是这条命令本身的示例。

**教训**：用正则查敏感词时，**必须排除「用来举例的文档」**。检查器把示例当违规，会让你养成「看到告警就忽略」的坏习惯——那比不检查更糟。

正确写法：`grep ... | grep -v PLACEHOLDERS.md`

### 坑 2 · 检查器静默失效：一个解构写错，永远不报错

脱敏检查的第一版：

```js
const flat = Object.entries(paths).map(([k, v]) => `${k}=${v}`);   // → 字符串数组
const bad = flat.filter(([, v]) => /Users\\[A-Za-z]/.test(String(v)));  // ← 对字符串解构
```

`flat` 是字符串数组，`([, v])` 解构出来 `v` 永远是 `undefined`，正则测的是 `"undefined"`。

**结果：永远 0 命中、永远「通过」。**

它比漏掉一条检查更危险：**它让你以为检查过了。**

**教训**：任何「检查器」都要做一次**反向验证** —— 故意塞一个违规值进去，确认它真的会报。`tests/runtime-check.mjs` 里有这一步。

### 坑 3 · `peerDependencies` 版本范围写错，直接装不上

第一版写的是：

```json
"peerDependencies": { "@deepseek-ai/dsh-llm": ">=0.1.0" }
```

实测装依赖时直接失败：

```
[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for @deepseek-ai/dsh-llm@>=0.1.0
The latest release is "0.0.1-rc.1"   ← 比 0.1.0 小
```

**教训**：写 peer 范围之前先查真实版本列表（`npm view <pkg> versions`）。可选依赖的版本范围写太严，等于把一个「可选」变成了「必须装对才能装」。

---

## 四、我想改默认参数，改哪个文件？

这是新用户第一个会问的问题。两个地方都能改，**用途不同**：

| 你想做的事 | 改哪里 | 为什么 |
|---|---|---|
| 改**默认值**（比如默认检索 5 条） | `core-plugin/lib/config.js` 里的 `Schema.number().default(...)` | 这是代码里的出厂设置 |
| 改**你自己机器上的值** | `cordis.patch.yml` 或 profile 配置（DSH 的插件配置入口） | 这是运行时注入，不动代码、升级不冲突 |
| 改**字段名/加新字段** | `config.js` 的 `Config` schema | `schema` 是唯一真相，DSH 的 `Config['~standard'].validate` 会按它校验 |

**三个原则**：

1. **`config.js` 是唯一真相**。所有字段必须声明在 `Config` schema 里，否则 DSH 启动时校验不过，插件直接不加载。
2. **`cordis.patch.yml` 只放「装到哪、叫什么」**，不放业务参数 —— 放这里会跟 `config.js` 的默认值分叉，而且**分叉时不会报错**（这是真实踩过的坑）。
3. **想改默认值给所有人用** → 改 `config.js` 并发 PR；**只想改自己的** → 改运行时配置。

> 校验失败的典型症状：DSH 启动报 `invalid config` 或插件静默不加载。
> 排障第一步：`node tools/healthcheck.mjs`，它会检查 schema 能否构造。
