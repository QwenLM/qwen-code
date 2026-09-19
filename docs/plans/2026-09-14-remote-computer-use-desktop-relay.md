# 远程 Qwen Code 使用本地桌面机：launchd 按需拉起的 node_repl 中继

> 状态：v3，已实现（本 PR），全量 build、typecheck 和相关单元测试已通过，未在真机上跑过。v1（中继驱动守护进程）和 v2（`qwen bridge` 子命令）都被替换，原因见 §1、§2。
> 基线：`origin/main` @ `42f9d13cda`（2026-09-19）。真机验证步骤见 `docs/verification/remote-computer-use/README.md`。
> 关联：#5626（反向工具通道）、#10962（本地文件桥）、#11548（Web Shell 连接远程 daemon）、#11475（远程 daemon 工作流）、`docs/users/features/computer-use.md`

## 0. 结论

用户面前那台有图形会话的机器（下称桌面机）把自己的 `node_repl`（连同 `@qwen-code/cua-sdk` 和内嵌驱动）借给一个远端会话。三个部件：

1. **桌面机上一次性安装**：`npx -y @qwen-code/node-repl-mcp@latest desktop-relay install`。它把运行时装到 `~/.qwen/desktop-relay`，并向 launchd 注册 `127.0.0.1:47821` 上的 socket（inetd 模式）。平时没有任何进程；有连接进来时 launchd 才拉起一个短命进程。
2. **Web Shell 的“使用这台电脑”入口**：页面把 daemon 地址、`sessionId` 和 token 交给本机的中继；中继在桌面机上弹出原生确认框；用户允许后，中继拉起 `node_repl`，通过 daemon 的反向工具通道按会话注册给这一个会话。
3. **终端 SSH 路径**：用 `RemoteForward` 把开发机上的一个 socket 转发到同一个端口，远端把它注册成 `node-repl` MCP server。第一次 `tools/call` 时弹确认框。

远端 skill 不用改：main 上的 `SKILL.md` 已经写明参考文档留在托管 skill 的机器上，读不到时用 `read_file`。

## 1. 为什么中继的是 node_repl

- skill 的常规路径 `ComputerUse.create()` 返回 `DriverBackend::Embedded`：驱动以原生库形式跑在 `node_repl` 进程里，不经过 `qwen-cua-driver` 守护进程。TCC 授权落在拉起 `node_repl` 的进程身份上。
- `ComputerUse.connect({ socketPath })` 发 `trusted_session_begin`，standalone 守护进程只接受“原始的嵌入宿主连接”（`cua-driver/src/serve.rs:787`，错误码 77），经 SSH 转发的连接永远不满足。
- 守护进程的 HTTP MCP 是给外部 agent 用的原始工具面，走它会绕过 #9856 之后的 skill 层。

所以要搬的是 `node_repl` 这个 MCP server，而不是驱动。

## 2. 形态是怎么定下来的

| 候选                              | 否决理由                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------- |
| 独立的桌面 app（签名、菜单栏）    | 要用户额外装一个 app                                                          |
| `qwen bridge` 子命令              | 每次使用都要在桌面机上敲命令，不是开箱即用                                    |
| 桌面机上常驻本地 `qwen serve`     | 浏览器用户为此多跑一个服务，不合适                                            |
| 本地 TUI 连远端 daemon            | TUI 今天没有这种模式，离本需求太远                                            |
| **launchd socket 激活（本方案）** | 一次性安装，之后零常驻进程；浏览器里点按钮即可；SSH 终端路径复用同一个 socket |

有一个事实绕不开：浏览器页面不能读别的 app 的界面、也不能替用户点鼠标，所以桌面机上必须有一个原生进程充当“桌面”这项能力的服务端。本方案让这个进程只在需要时存在。

## 3. 实现

### 3.1 部件

```text
桌面机                                                     远端开发机
浏览器 Web Shell ──(1) POST http://127.0.0.1:47821/connect
                        │
launchd（inetd 模式）拉起：node-repl-mcp desktop-relay agent
   ├─ 原生确认框（osascript）
   ├─ 拉起 node_repl（stdio，cwd = ~/.qwen/desktop-relay）
   └─ (2) WebSocket /acp ────────────────────────────►  qwen serve（QWEN_SERVE_CLIENT_MCP_OVER_WS=1）
         ACP initialize → mcp_register {server:'desktop-node-repl', sessionId}
         mcp_message ⇄ node_repl                         该会话里出现 node_repl 工具
```

代码都在 `packages/node-repl/src/desktop-relay/`，入口是 `node-repl-mcp desktop-relay <command>`（`src/index.ts` 按参数动态加载，普通 MCP 模式不受影响）：

| 文件                 | 作用                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `cli.ts`             | `install` / `uninstall` / `status` / `socket <path>`，以及 launchd 调用的 `agent`                         |
| `launchd.ts`         | 生成 LaunchAgent plist（`Sockets` + `inetdCompatibility { Wait: false }`），`launchctl bootstrap/bootout` |
| `agent.ts`           | 一条连接的处理：按首字节区分 HTTP 与原始 JSON-RPC；HTTP 路由；原始模式的延迟确认                          |
| `http.ts`            | 单请求的 HTTP/1.1 解析与响应（`Connection: close`）                                                       |
| `consent.ts`         | 原生确认框与通知（`osascript`，消息作为参数传入，不拼进脚本）                                             |
| `acp-relay.ts`       | 反向工具通道客户端：initialize、按会话注册、重试预热、应答 `mcp_message`                                  |
| `mcp-child-relay.ts` | 一个 `node_repl` 子进程服务多个 MCP 客户端                                                                |
| `runtime.ts`         | 生产环境接线：拉起子进程、`ws` 连接、`active.json` 状态文件、中继主流程                                   |

### 3.2 一条连接的处理（`agent.ts`）

launchd 的 inetd 模式把接受的连接作为新进程的 stdin/stdout。进程先读首字节：

- **HTTP**（浏览器）：
  - `Host` 必须是 `127.0.0.1:47821` 或 `localhost:47821`，否则 421。这挡住 DNS rebinding。
  - `OPTIONS` 预检：回显 `Origin`，并带 `Access-Control-Allow-Private-Network: true`（Chrome 对“公网页面访问回环地址”的要求）。
  - `GET /status`：返回版本；只有发起连接的那个 `Origin` 能看到当前连接的会话和阶段。
  - `POST /connect`：必须有合法的 web `Origin`；校验 body（daemon 地址只允许 http/https、不带凭据；`sessionId`；可选 token 和 workspace）；**弹原生确认框**；拒绝或超时返回 403；允许后结束上一个中继（一台机器只有一个），写 `active.json`（不含 token），回 202，然后在同一个进程里跑中继，直到结束。
  - `POST /disconnect`：只接受发起连接的 `Origin`，给中继进程发 SIGTERM。
- **原始 JSON-RPC**（SSH 转发过来的 MCP 客户端）：拉起 `node_repl` 直接服务。握手和 `tools/list` 不需要确认；**第一次 `tools/call` 时弹确认框**，拒绝后这条连接上的所有 `tools/call` 都返回错误。这样远端 qwen 启动时不会弹框。

### 3.3 一个 node_repl 服务多个客户端（`mcp-child-relay.ts`）

daemon 为每个活跃会话加一个用于发现的 MCP 客户端，经同一个注册接入，每个客户端的请求 id 都从 0 开始；而 `node_repl` 是只服务一个客户端的 stdio server。所以：

- 第一个 `initialize` 转发给子进程，之后的用缓存结果应答；`notifications/initialized` 只转发一次；
- 请求 id 改写成中继自己的编号，回复时还原；反向通道没有携带来源客户端身份，无法安全区分不同客户端复用的请求 id，因此丢弃 `notifications/cancelled`；
- 子进程发起的请求一律回 -32601（反向通道只承载 daemon 发起的请求），通知丢弃；
- 回复超过 9 MB 时换成错误（daemon 的 `/acp` 单帧上限 10 MB），提示模型减少输出，比如缩小截图；
- 子进程退出后，挂起的和之后的请求都返回错误。

### 3.4 反向通道客户端（`acp-relay.ts`）

行为照搬 Web Shell 本地文件桥（`bridge-client.ts`）实测过的规则：30 秒内完成 ACP `initialize`；`register_failed` 时先预热再重试（主工作区用 `POST /workspace/acp/preheat`，其他工作区用 `POST /workspaces/:w/runtime/ensure`），最多 6 次；`already_registered` 时等待而不消耗重试次数；`rate_limited` 在注册阶段计入重试，连接后忽略。

有一处刻意不同：**连接断开即结束，不自动重连**。桌面控制权不会在没有新的确认的情况下恢复。

非浏览器客户端直接用 `Authorization: Bearer` 头；`ws` 默认不发 `Origin`，所以 daemon 的跨站检查不适用。

### 3.5 Web Shell 入口

`packages/web-shell/client/components/DesktopRelayControl.tsx`，放在侧边栏底部“本地文件”旁边（桌面端外壳默认隐藏，因为它的 daemon 本来就在本机）：

- 只在用户打开面板、或连接处于进行中时才探测 `/status`：未经提示就访问回环端口可能触发浏览器的本地网络权限提示，而且每次探测都会在桌面机上拉起一个短命进程。连接稳定后每 30 秒探测一次。
- 状态：检测中 / 未设置（显示一次性安装命令和复制按钮）/ 未连接 / 等待确认 / 连接中 / 已连接 / 被其他会话使用 / 失败 / 不可用。
- 与本地文件桥共用工作区路由规则（`resolveLocalFilesWorkspaceRoute`）：daemon 未启用 `client_mcp_over_ws`、工作区不受信任或是 live 工作区时不提供入口；页面不是安全上下文时也不提供（浏览器不允许）。

### 3.6 SSH 终端路径

```text
# 桌面机的 ~/.ssh/config
Host devbox
  RemoteForward /home/you/.qwen/desktop-relay.sock 127.0.0.1:47821
  StreamLocalBindUnlink yes
```

```bash
# 开发机上
qwen mcp add --scope user node-repl npx -y @qwen-code/node-repl-mcp@latest \
  desktop-relay socket /home/you/.qwen/desktop-relay.sock
```

`desktop-relay socket` 只是把 stdio 接到这个 Unix socket 上。ssh 按 `StreamLocalBindMask`（默认 0177）创建 socket，只有本人能连。

## 4. 安全模型

- **被允许的会话可以在桌面机上以用户权限运行任意代码，并查看、操作屏幕。** 这是中继 `node_repl` 的直接后果（`node_repl` 没有能力沙箱），与本地 computer use 相同。确认框、README 和用户文档都这样写明。
- 每次连接都要在桌面机上确认，不记住任何选择。确认框是原生对话框，网页无法绘制或点击。
- 连接成功和结束时发系统通知。停止：Web Shell 里断开；或结束会话；或 `kill` 中继进程。
- Web 路径的 token 由页面交给本机中继，只存在于中继进程的内存里，不写盘。
- 残余风险：
  - 任何网页都能请求 `/connect` 并弹出确认框，确认框里写着请求来源和 daemon 地址，靠用户判断。Chrome 的本地网络访问权限提示是额外的一层。
  - TCC 授权记在 launchd 拉起的 `node` 可执行文件名下，而不是终端；其他由非终端拉起的同一个 `node` 也会继承这份授权。
  - `/status` 会向任意来源暴露“已安装”和版本号。

## 5. 已核实的事实

| #   | 事实                                                                                                                          | 证据                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | skill 的常规路径 `ComputerUse.create()` 使用 `DriverBackend::Embedded`，驱动在 `node_repl` 进程内运行                         | `typescript/computer-use/index.js:438-446`；`cua-driver-sdk/src/lib.rs`                   |
| 2   | standalone 守护进程拒绝非嵌入宿主的 `trusted_session_begin`（错误码 77）                                                      | `cua-driver-sdk/src/service_session.rs:38`；`cua-driver/src/serve.rs:787`                 |
| 3   | `node_repl` 的裸包从 `<cwd>/node_modules` 解析                                                                                | `packages/node-repl/src/runtime/module-loader.mjs:123`                                    |
| 4   | skill 只在 `node_repl` 不可用时 bootstrap；平台参考文档始终由托管 skill 的主机用 `read_file` 读取，不让远端 REPL 读取本机路径 | `packages/core/src/skills/bundled/computer-use/SKILL.md`                                  |
| 5   | `/acp` 升级优先读 `Authorization: Bearer`；跨站检查只在请求带 `Origin` 时生效；单帧上限 10 MB                                 | `cli/src/serve/acp-http/index.ts:270-300`、`:1568`                                        |
| 6   | 会话级注册带 `alwaysLoadTools: true`；client MCP 不允许遮蔽设置里的同名 server，因此 Web 路径使用独立名称 `desktop-node-repl` | `client-mcp-sender-registry.ts`；`core/src/tools/mcp-client-manager.ts`                   |
| 7   | 预热路由：`POST /workspace/acp/preheat`、`POST /workspaces/:workspace/runtime/ensure`                                         | `cli/src/serve/routes/workspace-status.ts:150`；`sdk-typescript/.../DaemonClient.ts:6545` |
| 8   | server 名称只允许 `[A-Za-z0-9_-]`，`desktop-node-repl` 合法                                                                   | `cli/src/runtime/validate-server-name.ts:7`                                               |
| 9   | MCP SDK 1.30 的 server 用一个 handler 处理 `initialize`；中继不依赖它能否重复初始化，自己缓存                                 | `@modelcontextprotocol/sdk/dist/esm/server/index.js:52`                                   |

## 6. 未验证（需要真机）

1. launchd inetd 模式下，`new net.Socket({ fd: 0 })` 能否正常读写接受的 TCP 连接；`socket.end()` 后浏览器能否立即拿到响应。
2. `osascript display dialog` 从 LaunchAgent 进程弹出时是否在最前面、能否正常点击。
3. Chrome（含本地网络访问权限提示）和 Safari 从 https 页面访问 `http://127.0.0.1:47821` 的实际表现。
4. TCC 授权实际记在谁名下；第一次授权屏幕录制后是否需要重新连接。
5. 模型看到远端注册的 `node_repl` 后是否确实跳过 bootstrap；截图体积与 10 MB 帧上限的关系。
6. 发布：`npx … @latest desktop-relay install` 要等 `@qwen-code/node-repl-mcp` 发布包含本改动的版本后才可用；发布前用 `--package <tarball>` 安装（见验证说明）。

## 7. 非目标与后续

- 非目标：在远端模拟桌面（Xvfb）；独立的桌面 app；中继 `qwen-cua-driver` 守护进程或它的 HTTP MCP。
- 后续：Linux 桌面（systemd socket 激活）和 Windows 的安装方式；是否需要比“Web Shell 断开 / kill”更直接的本地停止开关。
