# VS Code 远程窗口的 webview daemon 地址

[English](./vscode-remote-webview-daemon-url.md)

## 问题

在远程窗口（Remote-SSH、Dev Containers、WSL）下，companion 扩展以扩展宿主子进程的方式启动 `qwen serve`，因此 daemon 绑定的是**远端**机器 loopback 上的随机端口（`packages/vscode-ide-companion/src/services/qwenDaemonProcess.ts`：`--hostname 127.0.0.1 --port 0`，地址从 stdout 抓取）。而 webview 的渲染进程在本地桌面客户端里。`WebViewProvider` 把抓到的 `runtime.baseUrl` 原样展开进 `webShellBootstrap` 载荷，于是内嵌的 Web Shell 拿着 `http://127.0.0.1:<port>/capabilities` 去请求客户端自己的 loopback，所有请求都以 `ERR_CONNECTION_REFUSED` 失败，界面上表现为 "Failed to load workspace"。在 VS Code 的 PORTS 面板里手动转发端口可以临时救活，但扩展宿主一重启就会分配新端口，随即再次失效（#11976）。

另有两道门使得单纯调用 `vscode.env.asExternalUri()` 并不足够：

- webview 的 CSP 写死了 `connect-src http://127.0.0.1:* ws://127.0.0.1:*`（`WebViewContent.ts`），它既不匹配转发后的 `localhost` origin，也不匹配 shell 在该地址之上升级出的 `ws:`（`web-shell/client/local-files/bridge-client.ts`、`web-shell/client/voice/useVoiceCapture.ts`）。只解析地址，等于把连接被拒换成一条 CSP 违规。
- `validateDaemonBaseUrl()`（`services/daemonIdeConnection.ts`）只接受 loopback 主机，因此解析后的地址不能到处替换 daemon 地址。这条 loopback-only 不变量是有意为之，见 `docs/developers/daemon/16-vscode-ide-adapter.md`。

## 决策

- 远程感知以 `vscode.env.remoteName` 为开关。本地窗口保持原有路径不变。
- 面向 webview 的地址按每次 bootstrap 解析。`WebViewProvider.resolveWebviewDaemonBaseUrl()` 对 daemon 的 loopback 地址调用 `vscode.env.asExternalUri()`，其结果**只**覆盖 `webShellBootstrap` 载荷里的 `baseUrl`。不做任何缓存：扩展宿主重启后转发到的是一个新的客户端端口。
- 宿主侧继续使用原始 loopback 地址。`runtime` 不被修改，因此扩展宿主自身对它的用法、以及 daemon 适配器的 loopback-only 不变量都不受影响。
- 解析结果必须仍然是 loopback 地址。`resolveWebviewDaemonBaseUrl()` 复用 `services/daemonIdeConnection.ts` 里的 `isLoopbackHostname()`，否则抛错，由既有的 bootstrap 处理以 `webShellBootstrapError` 呈现。它还会在调用该谓词之前拒绝带方括号的 IPv6 字面量，即使共享谓词接受 `[::1]`：Chromium 会把带方括号的 IPv6 CSP host-source 判为非法并忽略，因此 `WebViewContent.ts` 无法放行解析后的 origin。这个做法与 `packages/web-shell/client/config/daemon.ts` 和 `packages/cli/src/serve/web-shell-static.ts` 里已有的拒绝一致，同时不收窄扩展宿主自身的 loopback 支持。解析后的地址与 daemon 的 bearer token 同处一个载荷，因此一个 relay origin 会让该 token 与第三方主机之间只剩一道 CSP。失败即关闭（fail closed）把 token 留在宿主侧，也让一个不受支持的远程形态变成明确的提示，而不是只出现在 DevTools 里的 CSP 违规。
- 远程窗口的 CSP `connect-src` 增加 `http://localhost:* ws://localhost:*`，其门控依据是 `vscode.env.remoteName`，而不是由解析后的 origin 推导。HTML 是在 `resolveWebviewView` 和创建 panel 时生成的，那时还不存在任何 daemon——`daemonProcess.start()` 只在 `webShellReady` 处理里运行——所以写策略时无从得知解析后的 origin。本地窗口的策略保持原有的收紧程度。不需要额外的 `wss:` 或 `https:` 条目：按 CSP 的 scheme 匹配规则，`http:` 源同样匹配 `https:`，`ws:` 源同样匹配 `wss:`，这一点已在无头 Chromium 里对两种策略分别验证。
- daemon 侧无需改动：它本来就带 `--allow-origin '*'` 启动，转发后的 origin 能通过 CORS。

## 范围

覆盖交给内嵌 Web Shell 的 daemon 地址，以及 webview 的 CSP。不改动：

- MCP IDE server（`ide-server.ts`）——它的消费者是同机的 CLI，且自 #11624 起在远程已可正常工作；
- daemon 只绑定 loopback 的姿态（`packages/cli/src/serve/loopback-binds.ts`）；
- 浏览器形态的远程（vscode.dev tunnel、Codespaces web）——那里 `asExternalUri` 返回的是 HTTPS relay origin，而不是转发后的 `localhost`。枚举这些域名属于猜测，且由于上述原因策略无法按 bootstrap 推导。这类窗口现在会以明确的提示 fail closed，而不是挂载一个什么都连不上的 shell；支持它属于后续工作，而放宽 CSP 的人必须先决定 bearer token 允许去往何处。

隧道解析到带方括号的 IPv6 字面量同样不受支持，并会以明确提示 fail closed。无头 Chromium 会把无端口、具体端口和通配端口三种写法都判为非法 CSP host-source；`http://localhost:*` 也不会覆盖 `http://[::1]:<port>` 请求。因此，若要支持这种解析结果，需要找到浏览器兼容的策略表达方式，而不是删除这道守卫。

已知限制（对真实 daemon 实测，而非推断）：Host 白名单（`packages/cli/src/serve/auth.ts` 的 `hostAllowlist`）只接受 `<host>:<daemon 端口>`，且它在鉴权**之前**就拒绝。`Host: localhost:<daemon 端口>` 返回 200；同一请求只要 Host 里是别的端口，即便带合法 bearer token 也返回 `403 {"error":"Invalid Host header"}`——去掉 token 后，白名单内的 Host 得到 401、另一个仍是 403，这就钉住了两者的先后顺序。VS Code 的转发通常复用 daemon 的端口号，这也正是今天手动转发能生效的原因，所以常见路径是通的；一旦客户端端口不同，shell 拿到的就是 403 而不是工作区。原始 TCP 转发会保留 Host 头，因此会撞上这道门；而把 Host 改写成 daemon 自身 authority 的代理则不会。放宽这道防 DNS rebinding 的防线是一个独立的、涉及安全的决策，不在本次改动范围内。

## 验证

- `WebViewProvider` 单测：远程窗口下载荷携带解析后的地址，同时 `asExternalUri` 收到的是 loopback 地址；本地窗口下载荷不变且从不调用 `asExternalUri`；两次 bootstrap 产生两次解析，因此缓存的地址无法跨重启存活；解析到 relay origin 或带方括号的 IPv6 地址时完全不发 bootstrap，改为呈现错误。
- `WebViewContent` 单测：`connect-src` 在本地保持仅 loopback，在远程增加 `localhost` 的 HTTP/WS 组合。
- 五个行为测试在没有修复时会失败。两个本地窗口测试在修复前后都通过，其存在意义是钉住本地路径没有被放宽。
- 机制层复现（无需桌面客户端）：在 Docker 容器里用扩展完全相同的 argv 启动真实 CLI，并用扩展完全相同的正则抓取它的地址。容器内访问 `/capabilities` 返回 200；从宿主发起同一个 `http://127.0.0.1:<port>` 请求则被拒绝——正是报告里的失败，且没有使用任何替身进程。随后在无头 Chromium 里分别加载两种 CSP（策略从 DOM 里回读校验）：改动前的策略会以 `connect-src` 违规拦掉 `http://localhost:<port>` 与 `ws://localhost:<port>`，改动后两者都放行，而 `wss://localhost:<port>` 在两种策略下都被 `ws:` 源放行。另一次 Chromium 探针确认，带方括号的 IPv6 host-source 无论不写端口、写具体端口还是写通配端口，都会被判为非法并忽略；有效的 `127.0.0.1` source 仍然生效，而 `localhost` 不会覆盖字面量 `[::1]` 请求。
- 端到端确认需要真实的 Remote-SSH 或 Dev Container 窗口加桌面客户端，无法在无头环境运行；手动步骤见 E2E 测试计划。机制层探针覆盖不到的是 VS Code 自己的隧道——尤其是真实窗口究竟复用 daemon 的端口（200）还是拿到另一个端口（403）。
