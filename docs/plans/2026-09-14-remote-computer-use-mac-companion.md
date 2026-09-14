# 远程 Qwen Code 操作本地 Mac：Computer Use 反向通道

> 状态：方案草案，未实现
> 基线：`origin/main` @ `f9534f4395`（2026-09-14）。以下结论全部读自代码和设计文档，未构建、未运行；本环境没有 Mac，需要真机的步骤见 §7 片0。
> 关联：#5626（反向工具通道 / CDP 隧道）、`docs/design/2026-09-03-client-filesystem-bridge.md`、`docs/design/2026-08-23-computer-use-skill.md`、`docs/users/features/computer-use.md`

## 0. 一句话结论

可以做，零件基本都在：cua-driver 负责在 Mac 上"看"和"操作"，`qwen serve` 的反向工具通道 `client_mcp_over_ws` 负责把工具调用从远端送回本地。

缺三样东西：

1. 一个 Mac 伴侣进程：负责中继、持有 macOS 权限、提供本地刹车；
2. 一个把伴侣绑定到远端具体会话的配对入口；
3. skill 对"驱动在别的机器上"的路由。

## 1. 原理：为什么"大脑"和"手眼"可以分开

Computer use 是一个循环：观察 → 模型决策 → 发出工具调用 → 驱动在本机执行 → 再观察。模型从不直接接触机器，只输出结构化的工具调用。

- **观察**有两种做法：
  - 纯视觉：截图，模型输出像素坐标；
  - 无障碍树：macOS AX / Windows UIA / Linux AT-SPI 给出带角色、标签、可执行动作的元素列表，模型说"点元素 37"。

  Qwen Code 以无障碍树为主，截图按需获取（`app.getState({ includeScreenshot: true })`）。

- **执行**在 macOS 上有两种：用 CGEvent 合成鼠标键盘事件，或直接对 AX 元素执行动作。两者都受 TCC 约束：辅助功能权限（读 UI、注入输入）和屏幕录制权限（截图），授权记在具体的进程身份上。

所以驱动**必须**跑在被控机器的图形会话里，并以获得授权的进程身份运行；agent 循环放在哪里都行。两者之间只隔着一层工具协议（MCP）。远程控制，就是把这层协议搬到网络上。

当前链路全部在同一台机器上：

```text
computer-use skill → node_repl MCP（stdio）→ @qwen-code/cua-sdk
  → qwen-cua-driver 守护进程（Unix socket）→ AX
```

skill 已经预留了驱动在别处的情形。它要求按"已连接驱动返回的平台"选择工作流："not the CLI or Node host operating system. A connected driver may control a different machine."

## 2. 已有零件与缺口

| 零件                              | 位置                                                                                | 已提供                                                                    | 远程场景的缺口                                              |
| --------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| cua-driver HTTP MCP               | `packages/cua-driver/rust/crates/cua-driver/src/mcp_http.rs`                        | Streamable HTTP 形态的 MCP，Bearer 鉴权，拒绝浏览器 Origin                | 只绑 `127.0.0.1`，跨机器需要隧道                            |
| cua-sdk `connect({ socketPath })` | `packages/cua-driver/typescript/computer-use/README.md`                             | SDK 连到指定守护进程，继承其身份与权限                                    | skill 用的是 `create()`，没有走 `connect`                   |
| Rust SDK 远程传输抽象             | `packages/cua-driver/rust/crates/cua-driver-sdk/src/remote.rs`                      | 与载体无关的 `DriverEnvelopeChannel`，含取消协商与 `completion_known`     | 没有现成的载体实现                                          |
| 反向工具通道                      | `packages/cli/src/serve/acp-http/client-mcp-ws.ts`、`client-mcp-sender-registry.ts` | 客户端托管 MCP server，会话级注册，跨会话调用硬拒绝                       | 目前只有浏览器和扩展作为客户端                              |
| 反向通道的客户端参考实现          | `packages/web-shell/client/local-files/bridge-client.ts`                            | `/acp` 连接、ACP initialize、`mcp_register`、预热重试、Web Locks 选主     | 跑在浏览器里，不能拉起本地进程                              |
| Qwen Live Host                    | `packages/live-host`                                                                | 签名公证的 macOS 应用、TCC 授权引导、自动安装、AX + ScreenCaptureKit 观察 | daemon 发现只认本机回环地址；协议是 Live 专用；没有输入注入 |

## 3. 三个方案

### 方案 A：cua-driver HTTP MCP + SSH 反向隧道

Mac 上：

```bash
export CUA_DRIVER_RS_MCP_HTTP_PORT=8765
export CUA_DRIVER_RS_MCP_HTTP_TOKEN="$(openssl rand -hex 32)"
qwen-cua-driver serve
ssh -R 8765:127.0.0.1:8765 <devbox>
```

远端开发机上：

```bash
qwen mcp add --scope user --transport http cua http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer <token>"
```

注意：HTTP 端点只能通过守护进程的环境变量打开。但在 macOS 上，`qwen-cua-driver mcp` 和 `permissions grant` 通过 LaunchServices 拉起守护进程时不转发环境变量（事实 14），所以被自动拉起的守护进程不会开 HTTP 端点，而且不会报错。在终端里直接运行 `serve` 可以避开这个问题，但权限可能会记在终端名下。完整步骤和检查方法见 `docs/verification/remote-computer-use/README.md`。

- 优点：不写代码，今天就能试。
- 缺点：
  - 模型拿到的是驱动的底层工具，不是 skill 的 App API；
  - 内置 `computer-use` skill 会在 Linux 上执行 bootstrap（安装 `node_repl` 和 SDK），需要让模型绕开它，或改用驱动自带的 `packages/cua-driver/rust/Skills/cua-driver/SKILL.md`；
  - 共享开发机上其他用户也能连到转发的端口，只有 token 在保护。

### 方案 B：node_repl 留在远端，SDK 经转发的 Unix socket 连 Mac 守护进程

执行 `ssh -R /tmp/cua.sock:<Mac 守护进程 socket> <devbox>`，然后在 node_repl 里用 `ComputerUse.connect({ socketPath: '/tmp/cua.sock' })`。

- 优点：保留 skill 的 App API；Unix socket 有文件权限，比 TCP 端口更适合共享机器。
- 缺点：
  - skill 要改成调用 `connect`；
  - SDK 与守护进程的版本必须严格一致；
  - 远端安装 SDK 时仍会下载 Linux 原生库（只用作客户端，能否省掉未验证）。

### 方案 C（推荐产品化）：Mac 伴侣接入反向工具通道

```text
远端 Linux                                  本地 Mac
qwen serve daemon                           Mac 伴侣
  /acp WS  <------- 伴侣主动连出 -------------  ├─ ACP initialize
  ClientMcpWsConnection                         ├─ mcp_register {server:'computer', sessionId}
  → addSessionRuntimeMcpServer(sessionId)       ├─ mcp_message <-> qwen-cua-driver mcp（stdio）
ACP 子进程：只在该会话里出现 mcp__computer__*    └─ 菜单栏状态 + 一键停止
```

- 优点：不需要 SSH 和额外端口；鉴权、会话隔离、断线清理全部复用现有实现；和 Web Shell 的本地文件桥走同一条通道。
- 缺点：要新写伴侣和配对入口（§4）。

建议顺序：

1. 先用方案 A 在真机上验证链路和延迟（§7 片0）；
2. 再按方案 C 做成正式功能；
3. 方案 B 只在"需要保留 skill 的 App API、又不想做伴侣"时考虑。

## 4. 方案 C：Mac 伴侣

伴侣自己不实现 computer use。它只做中继、权限宿主和本地刹车。

### 4.1 职责

1. **主动连出**：用 WebSocket 连远端 `/acp` 并带上 token。非浏览器客户端可以直接用 `Authorization` 头，也可以用 `qwen-bearer.*` 子协议。30 秒内要完成 ACP `initialize`，否则 daemon 会关闭这个未初始化的连接。
2. **会话级注册**：发 `mcp_register { server: 'computer', sessionId }`，必须带 `sessionId`。收到 `register_failed: No live ACP channel` 时，先调 `POST /workspace/acp/preheat` 预热再重试。
3. **中继**：把 `mcp_message { id, server, payload }` 里的 `payload` 交给本地 `qwen-cua-driver mcp`（stdio 子进程），再按原来的 `id` 回传结果。一次注册会触发 N+1 轮完整握手（N 是活跃会话数），所以要能重复应答 `initialize` 和 `tools/list`。
4. **权限宿主**：macOS 把授权记在拉起驱动的那个进程上。所以伴侣最终应该是签名的 `.app`，有稳定的 bundle ID，并引导用户授予辅助功能和屏幕录制权限。原型阶段从终端启动也可以，授权会记在终端名下。
5. **本地刹车**：远端的审批发生在开发机的 Web Shell 上；那个会话如果开了 YOLO，就不会再询问。所以 Mac 这边必须有自己的否决权：
   - 菜单栏显示"远程会话 X 正在控制本机"；
   - 一键停止：发 `mcp_unregister` 并结束驱动进程；
   - 驱动以 `--permission-mode standard` 运行（这也是默认值）。
6. **连接生命周期**：断线后退避重连、处理睡眠唤醒、一台 Mac 只跑一个实例。WebSocket 断开时，daemon 会自动撤掉这个 server。

### 4.2 配对（需要新设计）

本地文件桥运行在会话页面里，天然知道 `sessionId`；独立的伴侣进程不知道。需要在远端 Web Shell 的会话里提供一个"连接我的 Mac"入口，把 daemon 地址、`sessionId` 和一次性凭据交给伴侣，形式可以是 deep link 或配对码。

凭据不应复用 daemon 的长期 bearer token。daemon 的 LAN listener 已经要求升级请求携带配对凭据、不接受运行时 token，可以参考那套机制。具体形态待定。

### 4.3 远端侧的改动

- `computer-use` skill 要能识别已经注册的 `mcp__computer__*` 工具并优先使用，不要在 Linux 上执行 bootstrap 去安装 `node_repl` 和 SDK。
- 按驱动返回的平台选择工作流：这一点 skill 已经满足。

### 4.4 安全

- 这等于让远端机器控制本机的键盘和鼠标。
- 注册必须是会话级的。workspace 级注册会扩散到同一 workspace 的所有会话，包括钉钉等渠道驱动的会话，以及之后新建的会话。
- 跨会话调用已经由 sender registry 硬拒绝。
- 驱动不要使用 `--permission-mode unrestricted`。
- 残余风险：同一 workspace 内，任何通过鉴权的 WebSocket 客户端都能绑定到该 workspace 的任意会话。文件桥 v1 接受了这个风险；对 computer use 来说风险更高，所以配对凭据应该只对单个会话有效。

## 5. 已核实的事实

| #   | 事实                                                                                                                                                                                                  | 证据                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | 设置了 `CUA_DRIVER_RS_MCP_HTTP_PORT` 时，cua-driver 会启动 HTTP MCP，只绑 `127.0.0.1`，端点是 `POST /mcp`                                                                                             | `mcp_http.rs`（`configured_port`、`spawn`）；`serve.rs:642`、`serve.rs:1364` |
| 2   | HTTP MCP 必须配置 32–4096 字符的 Bearer token，否则启动失败；token 错误返回 401                                                                                                                       | `mcp_http.rs:324-347` 及其测试                                               |
| 3   | 带 `Origin` 头的请求返回 403                                                                                                                                                                          | `mcp_http.rs` 的 `serve_conn`                                                |
| 4   | 非 POST 请求返回 405，通知返回 202；Qwen 的 MCP 客户端把 GET 收到 405 当作"不支持 SSE"，退回只用 POST                                                                                                 | `mcp_http.rs` 的 `serve_conn`；`packages/core/src/tools/mcp-client.ts:285`   |
| 5   | 驱动的截图以 MCP image content 内联返回（base64 + `mimeType`），不是文件路径                                                                                                                          | `cua-driver-core/src/protocol.rs:281`                                        |
| 6   | SDK 可以连接指定的守护进程，并继承它的身份与权限                                                                                                                                                      | `computer-use/README.md:248`；`computer-use/index.d.ts:80`                   |
| 7   | 驱动的 `--permission-mode` 取值为 standard（默认）、bounded、unrestricted                                                                                                                             | `cua-driver/src/cli.rs:516`                                                  |
| 8   | 反向通道的帧类型是 `mcp_register` / `mcp_message` / `mcp_unregister`；每个连接最多注册 10 个 server                                                                                                   | `client-mcp-ws.ts`                                                           |
| 9   | 会话级注册带 `alwaysLoadTools: true`，工具不会藏在 `tool_search` 后面（文件桥设计文档里的事实 12 已经过时）                                                                                           | `client-mcp-sender-registry.ts:309`                                          |
| 10  | `/acp` 的跨站检查只在请求带 `Origin` 时生效；非浏览器客户端可以用 `Authorization` 头；非回环地址且没有 token 的升级请求返回 403                                                                       | `acp-http/index.ts:1694-1755`                                                |
| 11  | `/acp` WebSocket 单帧上限 10 MB                                                                                                                                                                       | `acp-http/index.ts:1568`                                                     |
| 12  | live-host 的 daemon 发现只接受回环地址                                                                                                                                                                | `packages/live-host/src/main/discovery.ts:44`                                |
| 13  | live-host 的原生能力是 AX 读树加 ScreenCaptureKit 截图，没有注入输入的代码                                                                                                                            | `packages/live-host/src/native/appshot.mm`                                   |
| 14  | macOS 上 `qwen-cua-driver mcp` 和 `permissions grant` 用 `open -n -g -a QwenCuaDriver --args serve` 拉起守护进程，只转发 `--socket` 和 `--grant`，不转发环境变量；全仓只有这两个调用点                | `cua-driver/src/cli.rs:1121-1235`、`:1332`、`:2837`                          |
| 15  | HTTP 端口和 token 只从环境变量读取，没有命令行参数或配置文件入口                                                                                                                                      | `mcp_http.rs`（`configured_port`、`configured_auth_token`）                  |
| 16  | 驱动发布形态：可执行文件 `qwen-cua-driver`，应用 `/Applications/QwenCuaDriver.app`，bundle id `com.qwencode.cua-driver`；macOS 默认 socket 是 `~/Library/Caches/qwen-cua-driver/qwen-cua-driver.sock` | `packages/cua-driver/README.md`；`cua-driver-core/src/daemon.rs:144`         |

## 6. 未决与需实测

1. **方案 A 端到端**：`qwen mcp add --transport http` 能否对驱动的 HTTP 端点完成握手并调用工具。事实 1–4 都来自读代码。
2. **延迟**：远端到 Mac，每次观察或动作都是一个往返。AX 文本经过有界观察和增量传输后很小，截图才是大头。需要实测一个真实任务的总耗时。
3. **截图体积**：全屏 Retina PNG 经 base64 后可能接近 10 MB 的帧上限（事实 11），伴侣可能需要缩放或压缩。
4. **配对凭据**的形态和生命周期（§4.2）。
5. **伴侣放在哪个宿主里**：并入 live-host、并入 desktop-shell，还是做成独立应用。live-host 目前是实验性的 Live 语音功能，要不要让它承担这个角色，需要产品决定。
6. **方案 B 是否可行**：远端 SDK 经转发的 socket 连 Mac 守护进程时，版本握手和原生库下载的实际行为。

## 7. 实施切片

**片0：真机验证方案 A（不改代码）**

完整步骤、预期输出和需要回报的内容见 `docs/verification/remote-computer-use/README.md`，结果写入同目录的 `results.md`。接手的 session 或 agent 先读 `docs/plans/2026-09-14-remote-computer-use-handoff.md`。

要回答的问题：握手能否完成；观察、点击、输入能否成功；单步往返耗时和截图大小；token 错误和断开隧道时的表现；守护进程的 HTTP 端点在 macOS 上怎样才能真正打开（事实 14）。

**片1：Node 命令行原型伴侣**

形如 `qwen-mac-bridge --daemon <url> --token <t> --session <id>`：复用 `bridge-client.ts` 的连接、初始化和注册重试逻辑，拉起 `qwen-cua-driver mcp` 做 stdio 中继。

验收：远端会话里出现 `mcp__computer__*` 工具，且只在该会话可见；关掉伴侣后工具消失。

**片2：配对入口和 skill 路由**

Web Shell 会话里加"连接我的 Mac"入口；skill 能识别远程驱动的工具，不在 Linux 上执行 bootstrap。

**片3：签名宿主和本地刹车**

并入选定的宿主（§6 第 5 点），获得稳定的 TCC 身份、菜单栏状态和一键停止。

## 8. 非目标

- 在远端 Linux 上模拟桌面（Xvfb 等）：那是控制远端机器，不是控制本地 Mac。
- 让 Mac 伴侣执行任意 shell 命令。
- 以 Windows 或 Linux 作为被控端：驱动本身支持，但本方案只验证 macOS。
