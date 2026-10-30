# 发版 SOP（RELEASE）

> 开源项目的头号死因不是代码烂，是**发版随缘**：
> 忘了改版本号、忘了跑测试、发出去的包里少一个文件、tag 打错了但已经推了。
>
> 这份文档把每一步固化成命令。**照着敲，不要凭记忆。**
> 全程大约 10 分钟。

---

## 0. 前置检查

```bash
git status                # 必须是 clean；有未提交就先处理
git branch --show-current # 必须是 main
git remote -v             # 确认没指向别人的仓库（真踩过）
```

## 1. 改版本号

**只有一个地方要改**：`core-plugin/package.json` 的 `version`。

```bash
cd core-plugin
# 手动改，或者：
pnpm version patch --no-git-tag-version    # 0.1.0 → 0.1.1
pnpm version minor --no-git-tag-version    # 0.1.0 → 0.2.0
```

> ⚠️ `--no-git-tag-version` 是必须的 —— 否则 pnpm 会自己打一个 tag，
> 而那时候代码还没测、包还没验，tag 已经钉死了。

**语义化约定**（简单版）：
| 改什么 | 用哪个 |
|---|---|
| 修 bug、改文档 | `patch` |
| 加功能、不破坏现有配置 | `minor` |
| **改配置字段名 / 改账本行格式** / 删功能 | `major` |

最后一类必须 `major`：**别人升级后会读不了自己的旧数据**，得让他知道。

## 2. 跑全套测试（四条，一条都不能跳）

```bash
cd ..                              # 回到仓库根
node tests/runtime-check.mjs       # 配置能 import / 路径干净 / 类型校验 / 裸环境降级
node tests/retrieve.test.mjs       # 五个纯函数 + 降级标记
node tests/index.test.mjs          # 三条铁律（工厂只 new 一次 / 降级要说 / 安全退出）
node tests/dep-graph.mjs           # 循环引用 / config 是叶子 / 无越权构造
```

**全部退出码 0 才继续。** 任何一条非 0 → 回去修，不要带着红灯发版。

## 3. 打包并**解包真跑一遍**（最容易被跳过、也最容易出事的一步）

```bash
cd core-plugin
pnpm pack --pack-destination ..        # 生成 ../dsh-inner-loop-x.y.z.tgz
cd ..

# ① 看包里有什么
tar -tzf dsh-inner-loop-*.tgz

# ② 解包到临时目录，装依赖，用假 ctx 真跑一次
mkdir -p /tmp/pkgtest && tar -xzf dsh-inner-loop-*.tgz -C /tmp/pkgtest
cd /tmp/pkgtest/package
pnpm install --ignore-scripts
node -e "
  (async () => {
    const m = await import('file://' + process.cwd() + '/lib/index.js');
    const hooks = new Set();
    m.apply({ logger: () => ({ debug(){} }), on: (e) => hooks.add(e) }, {});
    console.log('exports:', Object.keys(m).join(','));
    console.log('hooks:', [...hooks].join(','));
    process.exit(hooks.has('agent/pre-step') && hooks.has('session/event') ? 0 : 2);
  })();
"
```

### 这一步为什么不能省

`package.json` 的 `files` 白名单只决定「**有的话**打进去」，**它不检查文件到底存不存在**。

真实事故：`files` 里写了 `cordis.patch.yml`，但那个文件从来没被创建过。
`pnpm pack` 照常成功、退出码 0 —— 因为"没有就不打"。
用户装完之后：**DSH 去读 patch 文件，找不到，插件静默不加载，界面毫无反应。**

所以发布前必须**看清单 + 真跑一次**：

```bash
# 清单里必须有的（少一个都不行）
#   package/lib/*.js        ← 七个模块
#   package/package.json
#   package/cordis.patch.yml   ← 最容易漏

# 清单里绝对不许有的
#   tests/  tmp*  *.log  *.bak_*  证据/  警报/  索引.md  *.jsonl  node_modules/
```

一条命令自查：

```bash
tar -tzf dsh-inner-loop-*.tgz | grep -E 'tmp|tests?/|\.log|\.bak|node_modules' && echo "❌ 有污染" || echo "✅ 干净"
```

## 4. 打 Tag

```bash
git add -A
git commit -m "chore: release v0.1.1"
git tag -a v0.1.1 -m "v0.1.1: <一句话说清这版改了什么>"
```

`-a` 是必须的（带注释的 tag）。轻量 tag 不带日期和作者，发出去像一个野标签。

**tag 名统一带 `v`**，跟 GitHub Release 的名字对齐：`v0.1.1`。

## 5. GitHub Release 挂 tarball

1. 进仓库 → `Releases` → `Draft a new release`
2. **Choose a tag** → 选刚打的那个（如果没自动出现，手动输入 `v0.1.1`）
3. 标题：`v0.1.1`
4. 描述：这版**改了什么、影响了谁、要不要动配置**（三段，别写 changelog 全量）
5. **把 `dsh-inner-loop-x.y.z.tgz` 拖进 Attach binaries**
6. Publish

> tarball **不要提交进仓库**（`.gitignore` 里有 `*.tgz`）。它只挂在 Release 上。

## 6. 推

```bash
git push origin main
git push origin v0.1.1     # tag 要单独推
```

推完之后**去网页上确认一遍**：Release 页面能看到 tarball，main 分支的 README 是新版。

---

## 回滚（万一推错了）

| 情况 | 怎么退 |
|---|---|
| 代码有问题，还没人装 | 修完发 `patch` 版本，别改历史 |
| tag 打错了、还没发 Release | `git tag -d v0.1.1` + `git push origin :refs/tags/v0.1.1` |
| Release 内容写错 | 网页上 Edit；tarball 可以重传（删旧的加新的） |
| **已经有人装了坏版本** | 立刻发 `patch` 并在 Release 描述里**明说上一版有问题**，别装作无事 |

**永远不要 `git push --force` 到 main。** 别人的 fork 和引用会全断。

---

## 发版后 5 分钟自检

- [ ] `npm view dsh-inner-loop version` 显示新版本（如果确实发了 npm）
- [ ] Release 页面的 tarball 能下载、大小对得上
- [ ] 找个干净目录 `pnpm add` 一遍，能装上
- [ ] 装上之后跑 `node node_modules/dsh-inner-loop/../tools/healthcheck.mjs`
      （注意：`tools/` **不在 npm 包里**，只有仓库里有 —— 这是刻意的，工具链不进包）

---

## 已知坑（都真实发生过）

| 现象 | 根因 | 防线 |
|---|---|---|
| 装完毫无反应 | `cordis.patch.yml` 没打进包 | 第 3 步看清单 |
| 装完插件没加载 | `package.json` 里 `name` 跟 `export const name` 不一致 | 体检的「钩子契约」项会查 |
| 拿到注入时机不稳 | 漏了 `export const inject = ['systemPrompt']` | 同上 |
| Linux 用户 diff 全红 | 换行符被转成 CRLF | `.gitattributes`（`eol=lf`） |
| 装依赖直接失败 | `peerDependencies` 版本范围写太严（`>=0.1.0` 但最新只有 `0.0.1-rc.1`） | 先用 `npm view <pkg> versions` 查真实版本 |
| tarball 混进仓库 | `.gitignore` 漏了 `*.tgz` | 每次发版 `git status` 看一眼 |
