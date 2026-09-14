# 交接：远程 Qwen Code 操作本地 Mac（PR #11799）

> 写给接手的 session 或 agent。按顺序阅读：本文 → 方案 `docs/plans/2026-09-14-remote-computer-use-mac-companion.md` → 真机验证说明 `docs/verification/remote-computer-use/README.md`。
> 状态（2026-09-14）：只有文档，没有代码。用户暂不做真机验证，后续换 session 或 agent 继续。

## 1. 现在在哪

- PR：https://github.com/QwenLM/qwen-code/pull/11799（草稿；base `main`；head `yiliang114:docs/remote-computer-use-plan`）。
- 分支上的文件（只有这三个，都是文档）：
  - `docs/plans/2026-09-14-remote-computer-use-mac-companion.md`：方案，包括原理、已有零件、三个方案、Mac 伴侣设计、已核实事实表、未决问题、实施切片；
  - `docs/plans/2026-09-14-remote-computer-use-handoff.md`：本文；
  - `docs/verification/remote-computer-use/README.md`：片0 真机验证说明。
- 调研基线：`origin/main` @ `f9534f4395`。所有结论读自这个版本的代码，没有构建、没有运行。
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

## 3. 关键结论（细节和证据见方案 §5）

- **可行。** 驱动必须跑在 Mac 上，因为它要用 Mac 的图形会话和 macOS 权限；agent 循环可以在任何地方。两者之间只隔着 MCP。
- **零件都在 main 上**：
  - cua-driver 的 HTTP MCP（只绑回环地址，必须带 Bearer token）；
  - SDK 的 `connect({ socketPath })`；
  - Rust SDK 与传输方式无关的 `DriverEnvelopeChannel`；
  - `qwen serve` 的反向工具通道（会话级注册，已带 `alwaysLoadTools`）；
  - Web Shell 本地文件桥的客户端（可以直接当伴侣的参考实现）。
- **推荐路线**：先用方案 A（驱动 HTTP MCP + `ssh -R`）在真机上验证，再把方案 C（Mac 伴侣接入反向工具通道）做成正式功能。
- **写交接时新发现的坑**：macOS 上 `qwen-cua-driver mcp` 和 `permissions grant` 通过 LaunchServices 拉起守护进程时不转发环境变量（`packages/cua-driver/rust/crates/cua-driver/src/cli.rs:1121-1235`，调用点在 `:1332` 和 `:2837`），而 HTTP 端点只能靠环境变量打开。验证说明里给了两种绕过方式和检查手段。
- **驱动的发布形态**：可执行文件 `qwen-cua-driver`，应用 `/Applications/QwenCuaDriver.app`，bundle id `com.qwencode.cua-driver`，状态目录 `~/.cua-driver`；macOS 默认 socket 是 `~/Library/Caches/qwen-cua-driver/qwen-cua-driver.sock`（`cua-driver-core/src/daemon.rs:144`）。安装命令见 `packages/cua-driver/README.md`。
- **正确的授权方式**是 `qwen-cua-driver permissions grant`，它会以 QwenCuaDriver 的身份申请权限；`permissions status` 只读。

## 4. 待用户决定（不要自行决定）

1. **伴侣放在哪个宿主里**：并入 live-host、并入 desktop-shell，还是做成独立应用。live-host 是实验性的 Live 语音功能，它的 daemon 发现只认回环地址。
2. **配对凭据的形态**：deep link 还是配对码；是否复用 daemon LAN listener 的配对凭据机制；凭据是否只对单个会话有效。
3. **片1 原型放在哪里**：`packages/cli` 的子命令，还是独立的包。
4. **这个方案 PR 何时从草稿转为 ready**；代码 PR 是另开，还是追加到这个 PR（按"不要太碎"的原则判断，建议方案先合、代码另开）。

## 5. 下一步（按顺序）

1. **片0 真机验证**：让有 Mac 的人或 agent 按 `docs/verification/remote-computer-use/README.md` 执行，把结果写成同目录的 `results.md`，推到本 PR 分支。
2. **根据片0 的结果修订方案**：尤其是方案 §6 未决问题的第 1–3 点，以及方案 A 的启动方式。
3. **片1：Node 命令行原型伴侣**。起点：
   - 连接、初始化、注册和重试逻辑：`packages/web-shell/client/local-files/bridge-client.ts`。它跑在浏览器里，Node 版需要换掉 WebSocket 实现和 `navigator.locks`；
   - 帧协议：`packages/cli/src/serve/acp-http/client-mcp-ws.ts`；
   - 会话级注册：`packages/cli/src/serve/acp-http/client-mcp-sender-registry.ts`；
   - 可以对照的测试：`packages/cli/src/serve/acp-http/client-mcp-ws.test.ts`（register → tools/list → tools/call 的完整往返）；
   - 本地驱动：拉起 `qwen-cua-driver mcp`（stdio）做中继；
   - 放在哪里：先问用户（§4 第 3 点）。
4. **片2、片3**：见方案 §7。

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
2. `packages/core/src/skills/bundled/computer-use/SKILL.md`：skill 的 bootstrap，以及"驱动可能在另一台机器上"的表述。
3. `docs/design/2026-08-23-computer-use-skill.md`、`docs/design/cua-driver-computer-use-sdk.md`：skill 和 SDK 的设计边界。
4. `packages/cua-driver/README.md`：安装和发布形态。
5. `packages/cua-driver/rust/crates/cua-driver/src/mcp_http.rs`：HTTP MCP 端点。
6. `packages/cua-driver/rust/crates/cua-driver/src/cli.rs`：帮助文本（约 480–560 行）、LaunchServices 拉起（约 1121–1235 行）、`permissions grant`（约 2811 行起）。
7. `packages/cua-driver/typescript/computer-use/README.md`、`index.d.ts`：`connect({ socketPath })`。
8. `packages/cua-driver/rust/crates/cua-driver-sdk/src/remote.rs`：远程传输抽象。
9. `docs/design/2026-09-03-client-filesystem-bridge.md` §2–§5：反向工具通道的实测事实。注意其中事实 12 已经过时。
10. `packages/cli/src/serve/acp-http/client-mcp-ws.ts`、`client-mcp-sender-registry.ts`、`index.ts`（约 1561–1760 行）：通道、注册和 `/acp` 升级时的鉴权。
11. `packages/web-shell/client/local-files/bridge-client.ts`：客户端参考实现。
12. `packages/live-host/README.md`、`src/main/discovery.ts`、`src/native/appshot.mm`：现有的 Mac 原生宿主。
13. `packages/core/src/tools/mcp-client.ts:285`：HTTP MCP 客户端对 405 的处理。
