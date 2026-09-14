# 交接：远程 Qwen Code 操作本地 Mac（PR #11799）

> 写给接手的 session 或 agent。按顺序阅读：本文 → 方案 `docs/plans/2026-09-14-remote-computer-use-mac-companion.md` → 真机验证说明 `docs/verification/remote-computer-use/README.md`。
> 状态（2026-09-14，第三次修订）：只有文档，没有代码。方案已从 v1（中继驱动）改为 v2（中继 node_repl），原因见方案 §1；Mac 侧的中继进程定为 `qwen` 子命令，不做独立 app（用户决定，见方案 §3.1）。

## 1. 现在在哪

- PR：https://github.com/QwenLM/qwen-code/pull/11799（草稿；base `main`；head `yiliang114:docs/remote-computer-use-plan`）。
- 分支上的文件（只有这三个，都是文档）：
  - `docs/plans/2026-09-14-remote-computer-use-mac-companion.md`：方案 v2；
  - `docs/plans/2026-09-14-remote-computer-use-handoff.md`：本文；
  - `docs/verification/remote-computer-use/README.md`：片1 原型的验证说明（替换了 v1 的片0）。
- 调研基线：v1 读的是 `origin/main` @ `f9534f4395`，v2 复查读的是 `c666ec1a0a`。所有结论读自代码，没有构建、没有运行。
- 用户原始诉求：远程 Linux 开发机（无图形界面）上的 Qwen Code，能通过 computer use 操作用户本地的 Mac。

## 2. 用户的工作约定（必须遵守）

- **不要合并 PR。** 用户自己审阅并合并每一个 PR。
- **不要 force-push 已开的 PR。** 需要修改时追加提交。
- **提交信息和 PR 描述里不加 claude.ai/code 会话链接，不发布 Artifact。** 报告写成 `docs/plans/*.md`，验证说明写成 `docs/verification/<topic>/README.md`，都要推到 PR 分支上，否则用户在其他机器上找不到。
- **不要拆太碎。** 相关改动放进同一个 PR；不要关闭已经开的 PR，要合并就往已有分支追加提交并更新描述。只有确实带来好处时才拆（不同的审阅人、不同的风险、一部分能先合）。
- **在用户的开发服务器（`/root/workspace/qwen-code` 所在机器）上，不要跑 build、整包 typecheck 或测试**：内存小，出过 OOM。需要真实运行的验证，写成说明交给别的机器。
- **不要从本地工作区取文件来提交。** `/root/workspace/qwen-code` 常常落后 main 上百个提交，还有用户未提交的改动和不属于本任务的未跟踪文件。要用 `git show origin/main:<path>` 取内容，再用临时 index 构造提交（配方见 §6），不要 checkout，也不要动工作区。
- **提交 md 前跑 prettier 的 experimental-cli**：`node node_modules/.bin/prettier --experimental-cli --config-path .prettierrc.json --check <file>`。仅文档的 PR 在 CI 里不跑这一步，但格式不对的 md 会让下一个全量 PR 的 lint 失败。
- PR 描述：英文正文，外加 `<details>` 里的完整中文翻译，段落不要硬换行。提交信息遵循 Conventional Commits。

## 3. 关键结论（细节和证据见方案 §1、§5）

- **远程化的对象是 `node_repl`，不是驱动守护进程。** skill 的常规路径是 `ComputerUse.create()` → 驱动以原生库内嵌在 `node_repl` 进程里运行；守护进程和它的 HTTP MCP 是给外部 agent 用的另一条产品线。TCC 授权落在拉起 `node_repl` 的进程身份上。
- **v1 的方案 B 不成立**：`connect({ socketPath })` 发 `trusted_session_begin`，standalone 守护进程只接受"嵌入宿主连接"（父进程 pid 校验），任何 SDK 客户端都会被拒，与隧道无关。v1 的方案 A 和 C 中继的是原始工具面，会绕过 skill 层。
- **v2 方案**：Mac 上的 `qwen mac-bridge` 子命令拉起本地 `node_repl`，主动连远端 `/acp`，按会话 `mcp_register { server: 'node-repl' }`，中继帧。远端 skill 只需把读参考文档的方式改成 `read_file`（它现在让 `node_repl` 读远端路径，Mac 上不存在）。
- **不做独立 app**：子命令从终端启动，TCC 授权记在终端名下，与本地 computer use 一致；本地刹车就是 Ctrl-C。签名 app、菜单栏界面列为可选片3，默认不做。
- **零件都在 main 上**：`@qwen-code/node-repl-mcp`、`@qwen-code/cua-sdk`、反向工具通道（会话级注册、`alwaysLoadTools`、同名遮蔽设置项）、本地文件桥的客户端实现。
- **#11548 的位置**：它让 Web Shell 连到远程 daemon，是配对入口最自然的落点，但它没有按会话的配对凭据；它刻意不给跨来源 daemon 挂本地文件桥，computer use 的配对要对齐这条边界。
- **独立的 bug**：macOS 上驱动经 LaunchServices 拉起时不转发环境变量，HTTP 端点因此无法打开（`cli.rs:1121-1235`）。与本方案无关，值得单独报 issue。

## 4. 待用户决定（不要自行决定）

已决定（不要再问）：中继进程是 `qwen` 的子命令，放在 `packages/cli`，不做独立 app。

1. **配对凭据的形态**：deep link 还是配对码；是否复用 daemon LAN listener 的配对凭据机制；凭据是否只对单个会话有效。
2. **这个方案 PR 何时从草稿转为 ready**；代码 PR 是另开，还是追加到这个 PR（按"不要太碎"的原则判断，建议方案先合、代码另开）。

## 5. 下一步（按顺序）

1. **真机验证方案 §1 的两条事实**（不写代码，十分钟）：让有 Mac 的人按 `docs/verification/remote-computer-use/README.md` 的 A 部分执行，确认 standalone 守护进程拒绝 `connect()`，并测一张全屏截图的 base64 体积。结果写成同目录的 `results.md`，推到本 PR 分支。
2. **片1：`qwen mac-bridge` 子命令**。起点：
   - 连接、初始化、注册和重试逻辑：`packages/web-shell/client/local-files/bridge-client.ts`。它跑在浏览器里，Node 版需要换掉 WebSocket 实现和 `navigator.locks`；
   - 帧协议：`packages/cli/src/serve/acp-http/client-mcp-ws.ts`；
   - 会话级注册：`packages/cli/src/serve/acp-http/client-mcp-sender-registry.ts`；
   - 可以对照的测试：`packages/cli/src/serve/acp-http/client-mcp-ws.test.ts`（register → tools/list → tools/call 的完整往返）；
   - 本地子进程：`npx -y @qwen-code/node-repl-mcp@0.1.4`（stdio），版本跟 `SKILL.md:19` 保持一致；
   - skill 改动：`packages/core/src/skills/bundled/computer-use/SKILL.md` 里读 `references/*.md` 的那段改用 `read_file`；
   - 验收和测量：验证说明的 B 部分；
   - 放在哪里：`packages/cli` 的子命令（已决定）。
3. **片2（配对入口）**：见方案 §7。片3 是可选项，默认不做。

## 6. 操作配方

- 读 main：先 `git fetch origin main`，之后一律用 `git show origin/main:<path>` 和 `git grep <pattern> origin/main -- <paths>`。
- remote：`origin` 是 `QwenLM/qwen-code`，`fork` 是 `yiliang114/qwen-code`；`gh` 已登录 `yiliang114`。
- 往本 PR 追加一个文件而不碰工作区：

  ```bash
  git fetch fork docs/remote-computer-use-plan
  BASE=$(git rev-parse FETCH_HEAD)            # PR 分支当前的头
  export GIT_INDEX_FILE=$(mktemp -u)
  git read-tree "$BASE"
  B=$(git hash-object -w <编辑后的文件>)
  git update-index --add --cacheinfo 100644,"$B",<仓库内路径>
  TREE=$(git write-tree); unset GIT_INDEX_FILE
  git diff --stat "$BASE" "$TREE"             # 只应出现你改的文件
  C=$(git commit-tree "$TREE" -p "$BASE" -m "docs(plans): ...")
  git push fork "$C":refs/heads/docs/remote-computer-use-plan   # 不带 --force
  ```

  要修改分支上已有的文件，从 `git show "$BASE":<path>` 取当前内容再编辑，不要用本地工作区里的版本。

## 7. 调研路径（复查时按这个顺序读）

1. `docs/users/features/computer-use.md`：现有 computer use 的用户文档和链路。
2. `packages/core/src/skills/bundled/computer-use/SKILL.md`：bootstrap 条件（`:16`）、`create()` 调用（`:35`）、读参考文档（`:31-49`）、"驱动可能在另一台机器上"（`:72`）。
3. `packages/cua-driver/typescript/computer-use/index.js`：`create()`（`:438`）走 `createConfigured`，`connect()`（`:469`）走 `CuaDriver.connect`。
4. `packages/cua-driver/rust/crates/cua-driver-sdk/src/lib.rs`：`create_configured` 返回 `Embedded`；`connect`（`:904`）的注释；`create_trusted_session`（`:1042`）按后端分派；版本检查（`:332-361`）。
5. `packages/cua-driver/rust/crates/cua-driver-sdk/src/service_session.rs:38`：`connect_and_bind` 发 `trusted_session_begin`。
6. `packages/cua-driver/rust/crates/cua-driver/src/serve.rs`：`authenticate_unix_peer`（`:507`）、`authenticate_embedded_host_connection`（`:524`）、接受连接（`:650`）、`trusted_session_begin` 的拒绝（`:787`）。
7. `packages/cua-driver/rust/crates/cua-driver-core/src/lib.rs:37`：`embedded_mode()`。
8. `packages/cua-driver/typescript/scripts/install-native.mjs`、`src/native-assets.ts`：SDK 原生库的下载与平台目标。
9. `packages/node-repl/src/mcp-server.ts:178`：`node_repl` 工具注册。
10. `packages/core/src/tools/mcp-client-manager.ts` 的 `addRuntimeMcpServer`：同名遮蔽设置项。
11. `docs/design/2026-09-03-client-filesystem-bridge.md` §2–§5：反向工具通道的实测事实。注意其中事实 12 已经过时。
12. `packages/cli/src/serve/acp-http/client-mcp-ws.ts`、`client-mcp-sender-registry.ts`、`index.ts`（约 1561–1760 行）：通道、注册和 `/acp` 升级时的鉴权。
13. `packages/web-shell/client/local-files/bridge-client.ts`：客户端参考实现。
14. PR #11548 的 `docs/design/remote-web-shell-daemon.md`：Web Shell 连远程 daemon 的边界。
15. `packages/cua-driver/rust/crates/cua-driver/src/cli.rs:1121-1235`：LaunchServices 拉起不转发环境变量（独立 bug）。
