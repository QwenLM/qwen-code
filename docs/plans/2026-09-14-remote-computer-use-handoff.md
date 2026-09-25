# 交接：远程 Qwen Code 使用本地桌面机（PR #11799）

> 写给接手的 session 或 agent。按顺序阅读：本文 → 方案 `docs/plans/2026-09-14-remote-computer-use-desktop-relay.md` → 真机验证说明 `docs/verification/remote-computer-use/README.md`。
> 状态（2026-09-25）：代码已实现；Mac 上补验了真实 launchd、安全边界、浏览器权限提示，以及真实 SDK Client 到 node-repl 的取消协议闭环。入口现在由 daemon capability 控制，普通用户默认隐藏。已同步 main `99fd76553e` 并通过全量本地构建、类型检查和 lint，推送后的 CI 另行确认。**Linux Serve → Mac 的端到端流程尚未通过验收**；详见 `docs/verification/remote-computer-use/results.md` 首节。
>
> 如果你是在另一台 Mac 上接手的 agent：直接从 §5 开始，按验证说明跑。

## 1. 现在在哪

- PR：https://github.com/QwenLM/qwen-code/pull/11799（草稿；base `main`；head `yiliang114:docs/remote-computer-use-plan`）。最近一次合并的是 `origin/main` @ `b9840886b8`（2026-09-23），唯一冲突是 `package-lock.json`：main 迁到 pnpm 后删了它，分支也跟着删掉。
- 改动：
  - `packages/node-repl/src/desktop-relay/`：桌面侧中继（安装、launchd、连接处理、反向通道客户端、多客户端复用、确认框）和单元测试；
  - `packages/node-repl/src/index.ts`：`desktop-relay` 参数动态加载上面的模块；
  - `packages/node-repl/package.json`、`pnpm-lock.yaml`：新增 `ws` 和 `@types/ws`（工作区已有同版本）；
  - `packages/web-shell/client/desktop-relay/`、`components/DesktopRelayControl.tsx`：“使用这台电脑”入口和测试；侧边栏底部新增 `desktopRelay` 项；中英文文案；
  - `packages/core/src/skills/bundled/computer-use/SKILL.md`：Web 路径优先使用独立的 `desktop-node-repl` server，平台参考文档由远端 skill 主机读取；
  - 文档：`docs/users/features/computer-use.md` 新增一节；`packages/node-repl/README.md` 新增 Desktop relay 一节；本目录下的方案、交接和验证说明。
- 2026-09-19 修订关闭了五个代码问题：client MCP 与 settings 中的 `node-repl` 同名冲突、多客户端取消消息串线、SDK pin 漂移、`uninstall --purge --home` 可递归删除任意目录，以及交互侧文案被打进只读 transcript 后超过 bundle 上限。
- 2026-09-23 修订（`12ebef1ca1`）：中继原来丢弃所有 `notifications/cancelled`，但 node_repl 靠它中止正在运行的单元，结果用户停止对话后桌面还在被操作。现在只要恰好一个待处理请求用这个 id，就改写 id 后转发。验证说明 C.3 加了对应的检查。
- 2026-09-25 补验继续修复取消后 pending 残留：SDK 取消后不回包，中继必须主动清理，否则后续复用 ID 的取消会失效。真实子进程测试已覆盖连续取消和后续调用；仍不是跨机 Web Shell 停止按钮验收。同轮修正了 skill 示例优先选择桌面工具的判断。
- 用户原始诉求：远程 Linux 开发机（无图形界面）上的 Qwen Code，能通过 computer use 操作用户面前那台有图形界面的机器。

## 2. 用户的工作约定（必须遵守）

- **不要合并 PR。** 用户自己审阅并合并每一个 PR。
- **不要 force-push 已开的 PR。** 需要修改时追加提交；落后 main 时合并 main，不要 rebase。
- **提交信息和 PR 描述里不加 claude.ai/code 会话链接，不发布 Artifact。** 报告写成 `docs/plans/*.md`，验证说明写成 `docs/verification/<topic>/README.md`，都要推到 PR 分支上。
- **不要拆太碎。** 相关改动放进同一个 PR。
- **在用户的开发服务器（`/root/workspace/qwen-code` 所在的 Linux 机器）上，不要跑 build、typecheck 或测试**：内存小，出过 OOM。需要真实运行的验证，写成说明交给别的机器；判断有没有改坏别处，看 CI。**在接手验证的 Mac 上没有这个限制**，build、测试、打包都应该跑。
- **在开发服务器上不要从本地工作区取文件来提交**：那里的检出通常落后 main 上百个提交，还有用户未提交的改动。用 `git show origin/main:<path>` 取内容，再用临时 index 构造提交（配方见 §6）。在新机器上干净检出本分支的话，正常 `git commit` 就行。
- **提交前跑 prettier 的 experimental-cli**：`node node_modules/.bin/prettier --experimental-cli --config-path .prettierrc.json --check <file>`。
- PR 描述：英文正文，外加 `<details>` 里的完整中文翻译。提交信息遵循 Conventional Commits。
- 和用户沟通：不要把一堆选项丢给用户挑，给出一个推荐和理由；不要用“伴侣”这个词（用户会理解成要额外装的 app）。

## 3. 关键决定（不要重新讨论）

- 中继对象是 `node_repl`，不是 `qwen-cua-driver` 守护进程（方案 §1）。
- 桌面侧不做独立 app、不做 `qwen` 子命令、不要求本地 `qwen serve`；用 launchd socket 激活，一次性安装，平时零常驻进程（方案 §2）。
- 代码放在 `@qwen-code/node-repl-mcp` 包里：桌面机本来就要装它，它的 cell 从 cwd 的 `node_modules` 解析 `@qwen-code/cua-sdk`。
- 不限平台的定位：面向所有有图形会话的机器；本轮只实现和验证 macOS 的安装方式。

## 4. 待用户决定

1. 这个 PR 何时从草稿转为 ready；是否要把实现和方案拆成两个 PR。
2. 侧边栏的“使用这台电脑”已改为 capability-gated：普通 standalone 默认隐藏，远端显式开启 client MCP 后显示；宿主可通过 `footer.items` 显式启用，桌面端外壳默认隐藏。
3. 何时发布包含本改动的 `@qwen-code/node-repl-mcp` 版本（发布前 Web Shell 里显示的安装命令装不到中继）。
4. 授权记在 `node` 名下：官方 node 用 Node.js 的签名，TCC 按签名识别，所以给它屏幕录制和辅助功能，等于这台 Mac 上所有 node 脚本都拿到了这两项权限（复制 node 换个路径也没用）。二选一：接受并在用户文档里写明；或者以后做一个单独签名的 helper。
5. 反向通道在 main 上默认关闭，远端 daemon 要带 `QWEN_SERVE_CLIENT_MCP_OVER_WS=1` 启动。是只写进文档，还是推动默认打开。

## 5. 下一步

1. **真机验证（阻塞项）**：按 `docs/verification/remote-computer-use/README.md` 执行，卡住时查该文 F 节的排查手册。结果写到同目录的 `results.md`，追加提交推到本分支，并在 PR 里留一条评论。
   - 先跑 A、B 两节：只需要这台 Mac，最快能判断 launchd 这一层能不能用。
   - 最可能不通的是 C.1 和 C.8：浏览器能不能从安全页面访问 `http://127.0.0.1:47821`。
   - C.3 的取消检查是这次新加的，一定要跑。
2. 验证中发现的代码问题可以直接在 Mac 上修：改完跑相关的 `packages/node-repl/src/desktop-relay/*.test.ts` 和 `packages/web-shell` 里的 DesktopRelay 测试，用 `--experimental-cli` 跑 prettier，追加提交（不要 force-push）。
3. 把 §4 的第 4、5 项连同验证结果一起交给用户决定。
4. 后续：Linux 桌面（systemd socket 激活）和 Windows 的安装方式；截图超过 10 MB 帧上限时自动压缩。

**和 SSH workspace（#12255，已合入 main）的关系，不要当成替代方案重新提出**：那个方案里 `qwen serve` 跑在本地，远端只放代码；用户要的是 daemon 在远端，所以它不满足需求。而且它在 SSH 会话里清空了 `mcpServers`，也禁用了 skills，node-repl 在那里本来就用不了。

## 6. 操作配方

以下配方用于开发服务器（工作区不干净、检出落后 main）。在新机器上干净检出本分支时，正常的 `git merge origin/main`、`git commit`、`git push`（不带 `--force`）就够了。

- 读 main：先 `git fetch origin main`，之后一律用 `git show origin/main:<path>` 和 `git grep <pattern> origin/main -- <paths>`。
- remote：`origin` 是 `QwenLM/qwen-code`，`fork` 是 `yiliang114/qwen-code`；`gh` 已登录 `yiliang114`。
- 往本 PR 追加提交而不碰工作区：

  ```bash
  git fetch fork docs/remote-computer-use-plan
  BASE=$(git rev-parse FETCH_HEAD)            # PR 分支当前的头
  export GIT_INDEX_FILE=$(mktemp -u)
  git read-tree "$BASE"
  B=$(git hash-object -w <编辑后的文件>)
  git update-index --add --cacheinfo 100644,"$B",<仓库内路径>
  TREE=$(git write-tree); unset GIT_INDEX_FILE
  git diff --stat "$BASE" "$TREE"             # 只应出现你改的文件
  C=$(git commit-tree "$TREE" -p "$BASE" -m "...")
  git push fork "$C":refs/heads/docs/remote-computer-use-plan   # 不带 --force
  ```

  要修改分支上已有的文件，从 `git show "$BASE":<path>` 取当前内容再编辑。

- 分支落后 main 需要合并时：`git commit-tree <合并后的 tree> -p "$BASE" -p origin/main`，合并后的 tree 由 `origin/main` 的 tree 加上分支独有的文件构成，推之前用 `git diff --stat origin/main <tree>` 确认只有本 PR 的文件。

## 7. 调研路径

1. `docs/users/features/computer-use.md`、`packages/core/src/skills/bundled/computer-use/SKILL.md`：现有链路和 skill 的 bootstrap 条件。
2. `packages/cua-driver/typescript/computer-use/index.js`（`create()` / `connect()`）与 `cua-driver-sdk/src/lib.rs`、`cua-driver/src/serve.rs`：为什么不能连守护进程。
3. `packages/node-repl/src/runtime/module-loader.mjs`：cell 的裸包解析。
4. `packages/cli/src/serve/acp-http/client-mcp-ws.ts`、`client-mcp-sender-registry.ts`、`index.ts`（约 255–300、1561–1760 行）：反向通道、注册和升级鉴权。
5. `packages/web-shell/client/local-files/bridge-client.ts`、`components/LocalFilesControl.tsx`：浏览器侧的参考实现和工作区路由规则。
6. 本 PR 的 `packages/node-repl/src/desktop-relay/`：从 `agent.ts` 的文件头注释开始读。
