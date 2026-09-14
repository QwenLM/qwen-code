# 远程 Qwen Code 操作本地 Mac：中继 node_repl

> 状态：方案草案 v2，未实现。v1（三个方案、中继驱动）被本版替换，替换原因见 §1。Mac 侧的中继进程定为 `qwen` 子命令，不做独立 app（2026-09-14 维护者决定，见 §3.1）。
> 基线：`origin/main` @ `c666ec1a0a`（2026-09-14）。以下结论全部读自代码和设计文档，未构建、未运行；本环境没有 Mac，需要真机的步骤见 `docs/verification/remote-computer-use/README.md`。
> 关联：#5626（反向工具通道）、#11548（Web Shell 连接远程 daemon）、#11475（远程 daemon 工作流）、`docs/design/2026-09-03-client-filesystem-bridge.md`、`docs/design/2026-08-23-computer-use-skill.md`、`docs/users/features/computer-use.md`

## 0. 一句话结论

可以做：把 skill 依赖的 `node_repl`（连同 SDK 和内嵌驱动）整套放在 Mac 上，通过 `qwen serve` 的反向工具通道按会话注册给远端会话。远端 skill 几乎不用改。

缺三样东西：

1. Mac 上的一个中继进程，做成 `qwen` 的子命令，不做独立 app：拉起本地 `node_repl`，连远端 `/acp`，中继 MCP 帧；
2. 一个把中继进程绑定到远端具体会话的配对入口；
3. skill 读参考文档的方式要改成不经过 `node_repl`。

## 1. 为什么 v1 的三个方案都不对

v1 把"驱动守护进程 `qwen-cua-driver serve`"当成 computer use 的核心，围绕它设计了三个方案：驱动 HTTP MCP 走 SSH 隧道（A）、SDK 经转发的 socket 连守护进程（B）、Mac 侧进程中继 `qwen-cua-driver mcp`（C）。复查代码后发现前提就错了：

- **skill 的常规路径不经过守护进程。** `ComputerUse.create()` 调 `CuaDriver.createConfigured`，返回 `DriverBackend::Embedded`（`cua-driver-sdk/src/lib.rs` 的 `create_configured`）：驱动以原生库形式在 `node_repl` 进程里内嵌运行。SDK README 也写明 "In-process use inherits the host process's platform accessibility permissions"。所以 TCC 授权落在拉起 `node_repl` 的进程身份上，不是 `QwenCuaDriver.app`。
- **方案 B 不成立。** `ComputerUse.connect({ socketPath })` 向守护进程发 `trusted_session_begin`（`cua-driver-sdk/src/service_session.rs:38`），而守护进程只接受"原始的嵌入宿主连接"（`cua-driver/src/serve.rs:787`，错误码 77）：要求 `CUA_DRIVER_EMBEDDED=1` 且对端 pid 等于守护进程的父进程 pid（`serve.rs:524`）。经 SSH 转发的连接对端是 `ssh` 进程，永远不满足；就算在同一台 Mac 上，standalone 守护进程也会拒绝。`connect()` 上方的注释称之为"released socket clients 的临时兼容路径"（`lib.rs:901`）。v1 事实第 6 条据此作废。
- **方案 A 和 C 中继的是另一条产品线。** 守护进程的 `call` 和 HTTP MCP 暴露的是给外部 agent 用的原始工具面（`qwen-cua-driver mcp`），不是 skill 的 App API。走这条路会绕过 #9856 之后的整个 skill 层，模型拿到的是原始的点击和截图，`references/macos.md` 里的工作流全部失效。

结论：远程化的对象是 `node_repl`，不是驱动。

## 2. 原理

Computer use 是一个循环：观察 → 模型决策 → 发出工具调用 → 驱动在本机执行 → 再观察。模型从不直接接触机器，只输出结构化的工具调用。

当前链路全部在同一台机器上：

```text
computer-use skill → node_repl MCP（stdio）→ @qwen-code/cua-sdk
  → 内嵌驱动（原生库，同进程）→ AX / CGEvent
```

`node_repl` 及其下游必须跑在被控机器的图形会话里，并以获得 TCC 授权的进程身份运行；agent 循环放在哪里都行。两者之间只隔着一层 MCP。远程控制，就是把 `node_repl` 这个 MCP server 搬到 Mac 上，再把它的调用通道搬到网络上。

skill 已经预留了这种情形：它按"已连接驱动返回的平台"选择工作流（"A connected driver may control a different machine"，`SKILL.md:72`），bootstrap 也只在"`node_repl` is unavailable"时才执行（`SKILL.md:16`）。

## 3. 方案：`qwen mac-bridge` 在 Mac 上中继 node_repl

```text
远端 Linux                                   本地 Mac（终端）
qwen serve daemon                            qwen mac-bridge
  /acp WS  <------- 子命令主动连出 ------------  ├─ ACP initialize
  ClientMcpWsConnection                          ├─ mcp_register {server:'node-repl', sessionId}
  → addSessionRuntimeMcpServer(sessionId)        ├─ mcp_message <-> node_repl MCP（stdio 子进程）
ACP 子进程：该会话里出现 node_repl 工具            │     └─ @qwen-code/cua-sdk → 内嵌驱动 → AX
skill 看到 node_repl 可用，跳过 bootstrap          └─ Ctrl-C 即停止
```

Mac 主动连出，是因为 Mac 通常在 NAT 后面，开发机才有可达入口；反向工具通道正是为"daemon 在远端、能力在本地"设计的，本地文件桥（#10962）已经用它跑通了同类问题。

### 3.1 中继进程的形态与职责

**形态（已决定）**：`qwen` 的一个子命令，形如 `qwen mac-bridge --daemon <url> --token <t> --session <id>`，在 Mac 的终端里运行。对已经装了 qwen 的开发者零新增安装。不做独立 app、不做签名与公证、不做菜单栏界面。理由：今天本地 computer use 就是 `qwen` 在终端里拉起 `node_repl`，TCC 授权记在终端名下；子命令方式与它完全对等，没有新增的授权身份或安装步骤。

中继进程自己不实现 computer use。它只做中继。

1. **拉起本地 `node_repl`**：`npx -y @qwen-code/node-repl-mcp@<版本>`（stdio），版本与 skill bootstrap 里写的一致；确保 `@qwen-code/cua-sdk` 已安装（它的 postinstall 会从 GitHub Releases 拉 macOS 原生库，`typescript/scripts/install-native.mjs:24`）。
2. **主动连出**：用 WebSocket 连远端 `/acp` 并带上 token。非浏览器客户端可以直接用 `Authorization` 头，也可以用 `qwen-bearer.*` 子协议。30 秒内要完成 ACP `initialize`，否则 daemon 会关闭这个未初始化的连接。
3. **会话级注册**：发 `mcp_register { server: 'node-repl', sessionId }`，必须带 `sessionId`。收到 `register_failed: No live ACP channel` 时，先调 `POST /workspace/acp/preheat` 预热再重试。
4. **中继**：把 `mcp_message { id, server, payload }` 里的 `payload` 交给本地 `node_repl` 子进程，再按原来的 `id` 回传结果。一次注册会触发 N+1 轮完整握手（N 是活跃会话数），`node_repl` 是单连接 stdio，所以中继层要能重复应答 `initialize` 和 `tools/list`。
5. **权限**：TCC 授权记在拉起 `node_repl` 的进程身份上（§1）。子命令从终端启动，授权记在终端名下，与本地 computer use 一致；用户已经给终端开过辅助功能和屏幕录制的话，不需要再授权。首次运行时把这一点打印出来。
6. **本地刹车**：远端的审批发生在开发机的 Web Shell 上；那个会话如果开了 YOLO，就不会再询问。Mac 这边的否决权就是终端里的 Ctrl-C：进程退出，WebSocket 断开，daemon 自动撤掉这个 server，远端下一次调用立即失败。退出前尽量先发 `mcp_unregister`，让远端得到干净的错误而不是超时。
7. **连接生命周期**：断线后退避重连、处理睡眠唤醒、一台 Mac 只跑一个实例。WebSocket 断开时，daemon 会自动撤掉这个 server。

### 3.2 远端侧的改动

- **参考文档的读取**（确定要改）：skill 现在让 `node_repl` 用 `readFile(`${skillBase}/references/<platform>.md`)` 读参考文档（`SKILL.md:31-49`）。`node_repl` 跑在 Mac 上时，这个远端路径在 Mac 上不存在。改成用远端的 `read_file` 工具读，不经过 `node_repl`。
- **bootstrap 不需要改**：skill 只在 `node_repl` 不可用时才安装；远端会话里已经有中继进程注册的 `node_repl`，就不会在 Linux 上执行 `qwen mcp add` 和 `npm install`。要在原型里确认模型确实这样做。
- **同名遮蔽**：如果 Linux 用户自己也配过 `node-repl`，会话级运行时注册的同名 server 会遮蔽设置里的那一项（`McpClientManager.addRuntimeMcpServer` 的 shadow-over-settings 检测，`packages/core/src/tools/mcp-client-manager.ts`），不是拒绝。这正是想要的路由行为；但"工具名 `node_repl` 最终解析到遮蔽者"还没有在运行中确认。

### 3.3 配对（需要新设计）

本地文件桥运行在会话页面里，天然知道 `sessionId`；独立的中继进程不知道。需要在远端 Web Shell 的会话里提供一个"连接我的 Mac"入口，把 daemon 地址、`sessionId` 和一次性凭据交给中继进程，形式可以是 deep link 或配对码。

#11548 让独立 Web Shell 能连到远程 daemon，是这个入口最自然的位置：远程开发时用户面前就是 Mac 上的浏览器 Web Shell，页面知道 daemon 地址和当前 `sessionId`。但 #11548 本身没有按会话绑定或一次性凭据的逻辑，它用的是 daemon 的长期 bearer token，中继进程的凭据不应复用它。daemon 的 LAN listener 已经要求升级请求携带配对凭据、不接受运行时 token，可以参考那套机制。具体形态待定。

#11548 还划了一条要先对齐的边界：连跨来源 daemon 时不挂载浏览器本地文件桥，理由是本机目录不应交给远程 daemon。computer use 交出去的是本机的键盘、鼠标和屏幕，风险更高，所以配对必须是明确的授权动作，不能只是一个按钮。

### 3.4 安全

- 这等于让远端机器控制本机的键盘和鼠标。
- 注册必须是会话级的。workspace 级注册会扩散到同一 workspace 的所有会话，包括钉钉等渠道驱动的会话，以及之后新建的会话。
- 跨会话调用已经由 sender registry 硬拒绝。
- 残余风险：同一 workspace 内，任何通过鉴权的 WebSocket 客户端都能绑定到该 workspace 的任意会话。文件桥 v1 接受了这个风险；对 computer use 来说风险更高，所以配对凭据应该只对单个会话有效。

## 4. 已有零件与缺口

| 零件                     | 位置                                                                                | 已提供                                                                   | 远程场景的缺口                                 |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| node_repl MCP server     | `packages/node-repl`（npm `@qwen-code/node-repl-mcp`）                              | stdio MCP，工具名 `node_repl`（`src/mcp-server.ts:179`），状态跨调用持久 | 只能被同机进程拉起                             |
| cua-sdk 内嵌驱动         | `packages/cua-driver/typescript`（npm `@qwen-code/cua-sdk`）                        | `create()` 在进程内运行驱动，平台由 `getPlatform()` 返回                 | 无；它就该留在 Mac 上                          |
| 反向工具通道             | `packages/cli/src/serve/acp-http/client-mcp-ws.ts`、`client-mcp-sender-registry.ts` | 客户端托管 MCP server，会话级注册，跨会话调用硬拒绝                      | 目前只有本地文件桥这一个客户端                 |
| 反向通道的客户端参考实现 | `packages/web-shell/client/local-files/bridge-client.ts`                            | `/acp` 连接、ACP initialize、`mcp_register`、预热重试、Web Locks 选主    | 跑在浏览器里，不能拉起本地进程                 |
| Web Shell 远程 daemon    | #11548                                                                              | 浏览器连到指定 daemon，token 按 origin 隔离                              | 没有按会话的配对凭据；跨来源时刻意不挂本地能力 |

## 5. 已核实的事实

| #   | 事实                                                                                                                                                                 | 证据                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | skill 的常规路径 `ComputerUse.create()` 使用 `DriverBackend::Embedded`：驱动在 `node_repl` 进程内运行，不经过守护进程                                                | `typescript/computer-use/index.js:438-446`；`cua-driver-sdk/src/lib.rs` 的 `create_configured`   |
| 2   | `ComputerUse.connect({ socketPath })` 发 `trusted_session_begin`；standalone 守护进程对非嵌入宿主连接返回错误 77                                                     | `cua-driver-sdk/src/service_session.rs:38`；`cua-driver/src/serve.rs:787`                        |
| 3   | "嵌入宿主连接"要求 `CUA_DRIVER_EMBEDDED=1` 且对端 pid 等于守护进程的父进程 pid                                                                                       | `cua-driver-core/src/lib.rs:37`；`cua-driver/src/serve.rs:524-536`                               |
| 4   | 守护进程对每个 Unix socket 连接检查对端 uid 等于自身 euid                                                                                                            | `cua-driver/src/serve.rs:507-521`、`:650`                                                        |
| 5   | SDK 与守护进程的版本检查比较 contract、tools-list schema、capability、MCP protocol 四个版本，不比较 driver 版本本身                                                  | `cua-driver-sdk/src/lib.rs:332-361`                                                              |
| 6   | `@qwen-code/cua-sdk` 的 postinstall 按平台从 GitHub Releases 下载原生库；有 darwin、linux、win32 三种目标                                                            | `typescript/scripts/install-native.mjs:24`；`typescript/src/native-assets.ts:42-70`              |
| 7   | skill 只在 `node_repl` 不可用时执行 bootstrap；按已连接驱动返回的平台选工作流；用 `node_repl` 内的 `readFile` 读 `${skillBase}/references/*.md`                      | `SKILL.md:16-19`、`:31-49`、`:72`                                                                |
| 8   | `node_repl` MCP server 注册的工具名是 `node_repl`                                                                                                                    | `packages/node-repl/src/mcp-server.ts:178-179`                                                   |
| 9   | 反向通道的帧类型是 `mcp_register` / `mcp_message` / `mcp_unregister`；每个连接最多注册 10 个 server                                                                  | `client-mcp-ws.ts`                                                                               |
| 10  | 会话级注册带 `alwaysLoadTools: true`，工具不会藏在 `tool_search` 后面                                                                                                | `client-mcp-sender-registry.ts:309`                                                              |
| 11  | 运行时注册的 server 与设置里的同名 server 冲突时，运行时项遮蔽设置项                                                                                                 | `packages/core/src/tools/mcp-client-manager.ts` 的 `addRuntimeMcpServer`（shadow-over-settings） |
| 12  | `/acp` 的跨站检查只在请求带 `Origin` 时生效；非浏览器客户端可以用 `Authorization` 头；非回环地址且没有 token 的升级请求返回 403                                      | `acp-http/index.ts:1694-1755`                                                                    |
| 13  | `/acp` WebSocket 单帧上限 10 MB                                                                                                                                      | `acp-http/index.ts:1568`                                                                         |
| 14  | 反向通道目前只有本地文件桥这一个客户端；Chrome 扩展不使用 `mcp_register`                                                                                             | `git grep mcp_register` 只命中 `client-mcp-ws.ts` 和 `bridge-client.ts`                          |
| 15  | #11548 连跨来源 daemon 时不挂载浏览器本地文件桥；凭据按 daemon origin 隔离                                                                                           | #11548 `docs/design/remote-web-shell-daemon.md`                                                  |
| 16  | macOS 上 `qwen-cua-driver mcp` 和 `permissions grant` 用 `open -n -g -a QwenCuaDriver --args serve` 拉起守护进程，不转发环境变量；HTTP 端口和 token 只从环境变量读取 | `cua-driver/src/cli.rs:1121-1235`、`:1332`、`:2837`；`mcp_http.rs`                               |

事实 16 属于 `qwen-cua-driver mcp` 那条产品线，与本方案无关，保留是因为它是一个独立的 bug，值得单独报 issue。

## 6. 未决与需实测

1. **模型行为**：远端会话里已有中继进程注册的 `node_repl` 时，模型是否确实跳过 bootstrap、不在 Linux 上执行 `qwen mcp add` 和 `npm install`。
2. **截图体积**：`node_repl` 的输出里截图以 base64 内联，Retina 全屏可能接近 10 MB 帧上限（事实 13）。需要实测；超了就在 Mac 侧缩放，或让 `node_repl` 把截图写到 Mac 本地再走文件桥。
3. **同名遮蔽的运行时表现**（§3.2 第 3 点）。
4. **延迟**：每次 `node_repl` 调用一个往返。AX 文本经过有界观察和增量传输后很小，模型推理才是大头；需要实测一个真实任务的总耗时作参照。
5. **配对凭据**的形态和生命周期（§3.3）。

## 7. 实施切片

**片1：`qwen mac-bridge` 子命令**

放在 `packages/cli`，形如 `qwen mac-bridge --daemon <url> --token <t> --session <id>`：复用 `bridge-client.ts` 的连接、初始化和注册重试逻辑，拉起 `node_repl` 做 stdio 中继；同时把 skill 读参考文档的方式改成 `read_file`。

验收：远端会话里出现 `node_repl` 工具，且只在该会话可见；skill 不在 Linux 上跑 bootstrap；`getPlatform()` 返回 `macos`；一个真实任务跑通；记录截图体积和单步耗时；Ctrl-C 后工具消失。步骤见 `docs/verification/remote-computer-use/README.md`。

**片2：配对入口**

Web Shell 会话里加"连接我的 Mac"入口，凭据只对单个会话有效；入口给出的是一条可复制的 `qwen mac-bridge …` 命令。

**片3（可选，默认不做）：独立于终端的授权身份或图形化停止开关**

只在出现明确需求时才考虑，例如用户不愿意给终端开屏幕录制权限。那时再评估并入 desktop-shell 或 live-host，不在本方案范围内。

## 8. 非目标

- 在远端 Linux 上模拟桌面（Xvfb 等）：那是控制远端机器，不是控制本地 Mac。
- 让中继进程执行任意 shell 命令。
- 独立的 Mac app、签名与公证、菜单栏界面：已决定不做（§3.1）。
- 以 Windows 或 Linux 作为被控端：`node_repl` 和 SDK 本身支持，但本方案只验证 macOS。
- 中继 `qwen-cua-driver` 守护进程或它的 HTTP MCP：那是给外部 agent 用的原始工具面（§1）。
