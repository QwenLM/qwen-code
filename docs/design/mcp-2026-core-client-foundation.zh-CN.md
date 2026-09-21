# MCP 2026 核心客户端基础

[English](mcp-2026-core-client-foundation.md) | [简体中文](mcp-2026-core-client-foundation.zh-CN.md)

## 背景

Qwen Code 配置的 MCP 会话目前使用 v1 TypeScript SDK。只实现 MCP `2026-07-28`
无状态协议的服务器无法完成旧版 `initialize` 握手，但无条件切换到现代协议会破坏现有服务器。

官方 TypeScript SDK v2 已负责线路层兼容逻辑：`server/discover` 协商、旧版回退、
每次请求的元数据与 HTTP 请求头、分页以及缓存提示。Qwen Code 应配置这些行为，而非重复实现。

## 范围

本次 #8968 的工作将配置的 MCP 会话迁移到 v2 客户端，为 stdio 会话提供可选的自动协议协商，
并为守护进程支持的 WebShell 会话添加首个 MCP Apps 宿主。当协商得到现代协议时，
工具、提示词、资源列表和资源读取操作使用 v2 支持缓存的辅助方法。

远程 HTTP / SSE / TCP 客户端仍使用 `versionNegotiation.mode = 'legacy'`。
SDK v2 在 HTTP `server/discover` 探测超时后会直接拒绝，不回退到 `initialize`，
所以自动协商会丢弃那些忽略初始化前未知方法、原本可用的远程服务器。
在 SDK 修复此问题前，暂不支持只实现 2026-07-28 的远程服务器。

以下内容仍为独立后续工作：

- 仅支持现代协议的远程（HTTP / SSE / TCP）协议协商；
- 跨 TUI、WebShell、无头模式与 ACP 的交互式 MRTR 信息征询和审批；
- MCP App 发起的工具调用、链接、下载、消息、模型上下文更新和全屏展示；
- Qwen Code 内部 IDE、Computer Use 和内嵌 MCP 服务器集成的迁移，
  它们不属于配置的外部 MCP 会话。

## 设计

配置的 stdio MCP 客户端默认使用 `versionNegotiation.mode = 'legacy'`。
设置 `versionNegotiation: "auto"` 可启用最多 5 秒的 `server/discover` 探测；
探测还会进一步缩短，以确保探测和 initialize 回退均包含在 `discoveryTimeoutMs` 内
（发现窗口限制为 `[100ms, 300s]`；预算不足以覆盖两个步骤时跳过探测，使用 `legacy`）。
明确的现代协议证据选择无状态 `2026-07-28` 协议；旧版证据，包括始终不回答探测的静默
stdio 服务器，则回退到未改变的 `initialize` 流程。

SDK 会在启动会话进程前，使用一次性兄弟进程执行可选的 stdio 自动协商，
所以每次连接会执行配置命令两次。默认旧版策略跳过探测，保留单进程 initialize 流程，
以兼容具有非幂等启动副作用或锁文件等单一所有者资源的服务器。

远程 HTTP / SSE / TCP 客户端使用 `versionNegotiation.mode = 'legacy'`，
不发送 `server/discover`。

现代会话使用带类型的 v2 列表/读取方法，使 SDK 能汇总分页并遵守 `ttlMs` 和
`cacheScope`。旧版会话继续使用 Qwen Code 原有的提示词和资源请求路径，
因为该路径有意兼容未声明相应能力却提供方法的旧服务器。

工具发现使用同一次支持缓存的 `tools/list` 结果注册 schema 和注解。
工具执行继续通过原始客户端进行，使进度、取消、超时、权限检查和输出处理留在现有路径内。

配置的客户端声明 `io.modelcontextprotocol/ui` 扩展和
`text/html;profile=mcp-app` 资源类型。当服务器也声明该扩展时，工具发现会保留其
`ui://` 资源 URI。调用成功后，Qwen Code 读取并校验对应 HTML，将其保存在结构化
展示结果中，而不改变模型可见结果。缺失、超大、格式错误或不可读的资源仍产生
`html` 为空的 `mcp_app` 展示，其 `fallbackText` 在普通工具文本之前添加
`Warning: MCP App '<uri>' from '<server>' could not be displayed: <reason>`；
模型可见结果仍为普通工具文本。

对于 Amplitude（#11945）等较大或较慢的 App，可在 `mcpServers` 中为服务器设置
`appResourceMaxBytes` 和 `appResourceTimeoutMs`。HTML 默认限制为 1 MiB，
可设置范围为 1 字节–4 MiB。资源截止时间默认取通用 MCP 超时与 10 秒的较小值；
显式 App 超时覆盖该截止时间，并限制在 100–120,000 ms。有限数值向下取整；
非数字或非有限值回退到默认值。SDK 请求与取消信号使用同一截止时间，
调用方取消仍会中止读取。超过限制时，在已有展示警告中标明对应设置项，
不改变已成功的工具结果。

SDK 初始化及守护进程设置读写会保留这两个资源限制字段，包括稍后由核心取整和钳制的有限数值。
这些设置随已发现工具经过元数据补全、完整限定名转换、会话投影及重连重试。
设置参与连接池指纹计算，避免不同资源策略的会话复用第一个会话的限制。
现有设置协调机制会检测配置变化。不新增守护进程路由或沙箱能力。

4 MiB 上限为打包应用提供余量，同时在现有 32 MiB 会话记录/回放限制下为 JSON 转义
（每个 HTML 字节最多变成六字节）预留空间。120 秒上限限制可选 UI 的等待时间。
这是宿主策略，并非协议限制，也不保证 Amplitude 兼容性。SDK 在大小检查前已构造完整响应，
因此限制约束的是接收/保留的 HTML，而非网络传输或峰值内存。

一份被保留的 App 文档还会穿过若干比该信封更紧的预算，且计量单位各不相同：
WebShell 历史页预算（16 MiB，按 UTF-16 码元乘二估算——同一页容纳两个满上限文档
就会超限）；守护进程 4 MiB 的压缩回放窗口，一个满上限文档在构造上就会将其占满；
EventBus 每订阅者 2 MiB 的实时帧预算；以及按 JSON 序列化字节流计量的 32 MiB
恢复页限制。因此历史页准入按文档降级而非整页失败：当物化页超过预算时，页表将每个
MCP App 展示的 `html` 整体丢弃（回放只在 `html` 非空时挂载 iframe，且不会重新拉取
资源），该轮次仍凭 `fallbackText` 正常导航；只有在无可降级内容时页面才失败关闭。
接受更大的文档会增加会话记录和回放载荷。本次不包含流式传输限制或 App 发起的工具调用。

实时交付时，若 MCP App 会超出某个订阅者的字节队列预算，则只为该订阅者移除整个
HTML 并重试入队，保留完整文字结果。正常消费的订阅者和回放环仍保留原始 App。
若文字回退也超出队列预算，仍按原规则断开；帧数限制和强制回放交付语义不变。

守护进程未认证的 `/mcp-app-sandbox` 路由返回不缓存的重定向，目标为绑定到
`127.0.0.1` 随机端口的专用静态监听器。每次渲染获得新的 `<uuid>.localhost` 源。
监听器仅响应已注册的 Host、GET 方法和资源路径，在唯一一次成功响应前删除注册，
且不提供守护进程 API 或 WebSocket 端点。注册固定经校验的宿主来源和资源 CSP，
查询参数不能替换该策略。

两层 iframe 均授予 `allow-same-origin`。App 与其代理共享每次渲染的源，可互相访问
DOM 和该源的存储；二者构成同一个信任边界。它们与 WebShell、守护进程及其他 App
均不同源，因此不能读取 WebShell `sessionStorage`，也不能作为同源客户端调用
守护进程 API。`Origin-Agent-Cluster: ?1` 防止通过 `document.domain` 放宽每次渲染的
来源边界。顶层导航、弹窗及其他未授予的沙箱能力仍受限制。

AppBridge 和 postMessage 向内层 iframe 传递 HTML、工具输入及结果。代理校验父子
来源，以 HTTP 响应头应用资源 CSP，并转发消息。宿主 AppBridge 按 schema 校验
入站消息；代理本身不筛选载荷结构。已绑定的 daemon 会话在现有权限策略下声明
受限的 App 服务器工具调用能力。来源生命周期、能力边界及验证限制详见
[MCP App 服务器工具调用](mcp-app-server-tools.zh-CN.md)。

## 兼容性与安全

- 不将任何配置的服务器固定到现代协议。
- 配置的 stdio 服务器默认使用单进程旧版流程，可通过 `versionNegotiation: "auto"`
  选择额外的协商进程。
- 旧版回退保持 SDK 与 v1 字节兼容的序列。
- 授权和 Qwen Code 的 MCP 权限边界不变。
- 现代缓存为每个客户端实例私有，不跨工作区或授权主体共享结果。
- MCP App HTML 默认限制为 1 MiB，可按服务器调到最多 4 MiB，且从不进入模型上下文。
- App HTML 在双层 iframe 沙箱中运行，两层均带 `allow-same-origin`。
  隔离依赖专用静态回环监听器上的每次渲染独立来源、一次性注册和
  `Origin-Agent-Cluster: ?1`。隔离响应强制执行服务器声明的资源 CSP。
- 隔离源不可用时，WebShell 显示普通工具文本，不渲染 App。
- 压缩按用途区分。终端交互历史保留 `type: 'mcp_app'`，但将 `html` 置空并保留原
  `fallbackText`，TUI 渲染文本而不挂载空沙箱。持久化会话记录在配置的资源限制内
  保留 App `html`，供 WebShell 回放挂载，并仅在序列化结果符合保留展示预算
  （32 KiB）时保存 `toolResult`；超过预算则整个字段被丢弃，而非截断。
  保留的 `html` 只进入回放 `rawOutput` 和恢复后的展示，从不进入模型上下文。
  256 KiB 或更大的合规资源在回放时会超过守护进程的大管道帧阈值，
  这是从会话记录渲染 App 的预期成本。
- 宿主发送 `ui/resource-teardown` 并等待结束后再卸载沙箱 iframe。

## 验证

- 1,048,577 字节的有效 App 在默认设置下必须失败，显式设置 2 MiB 后必须渲染，
  覆盖文本及 base64 资源编码。
- 11 秒资源读取在默认设置下必须失败，设置 30 秒 App 截止时间后必须成功；
  仅提高通用 MCP 超时仍保留原有 10 秒上限。调用方取消必须继续生效。
- 配置限制必须接受精确边界、拒绝超量 HTML、约束范围外数字，并对非有限值回退。
  不同策略不得共享连接池工具快照。
- 使用确定性 fixture 验证本地渲染及持久化记录回放。真实 Amplitude 验证还需要
  OAuth 和可访问图表；fixture 成功本身不代表真实服务兼容。
- 仅支持现代协议的控制传输必须通过 `server/discover` 连接，列举和调用工具时
  不使用 `initialize`，并携带现代请求元数据。
- 真实 Streamable HTTP 传输使用旧版 `initialize` 握手，仍须发送协议和方法请求头，
  并在 `tools/call` 中发送工具名请求头。不包含仅支持现代协议的远程协商。
- 旧版控制传输必须回退到 `initialize`，保留现有发现和调用行为。
- 带缓存提示的现代列表结果必须无需第二次线路请求即可复用。
- 模拟 stdio MCP 服务器必须声明 Apps 扩展，返回 `ui://` 仪表盘资源，
  并在真实守护进程支持的 WebShell 会话记录中渲染仪表盘。
  PR 说明应包含此次验证使用的外部 fixture，而不将其放入产品仓库。
- 压缩后的终端历史回放必须显示回退文本且不挂载沙箱 iframe。
  持久化会话记录回放必须挂载沙箱并渲染保留的 App `html`，不得携带超预算的 `toolResult`。
- 无效 App 资源 MIME 类型和不可用资源必须保留普通文本结果。
- 沙箱路由必须拒绝 CSP 指令注入，并保持静态、no-store、认证前资源的性质。
- 现有 MCP 客户端、连接池、工具、OAuth 和资源测试必须通过，之后通过仓库构建和类型检查。

## 演示

用于验证的外部 stdio 演示提供一个 `show_revenue_dashboard` 工具及其
`ui://revenue-dashboard` 资源。PR 说明包含参考实现及守护进程配置。
