# MCP App 服务端工具调用

[English](mcp-app-server-tools.md) | [简体中文](mcp-app-server-tools.zh-CN.md)

## 问题与范围

Tableau MCP App 4.8.1 的 335,305 字节 HTML 可以载入 Qwen WebShell，但宿主没有 `serverTools`，因此 App 拒绝请求嵌入令牌。Amplitude 也需要 App 到服务端的调用。本变更为绑定 daemon 会话的 App 增加 `tools/call`。资源读取、工具列表、外部导航及其他宿主能力不在范围内。

原有两层不透明沙箱还使嵌套 Tableau iframe 遇到 `Origin: null` 的 CORS 错误。本变更新增独立渲染来源，让嵌套 iframe 保留实际 Tableau 来源。每次渲染使用随机来源；稳定的 `_meta.ui.domain` 配置仍不受支持。

## 设计

在发现和现有连接池中保留服务端声明的 App 可见性。ToolRegistry 维护独立 App 工具查找，App-only 工具不会进入模型声明、搜索或延迟调用。两个目录均遵守现有会话服务端过滤、禁用工具和注册表生命周期。

WebShell 提供绑定到所显示会话的执行回调。AppBridge 仅在具有该回调时声明 `serverTools`。宿主从已渲染 App 固定服务端和资源 URI，只接受 iframe 提交的精确原始工具名与参数。未绑定会话的独立 transcript 仅展示内容。

受 mutation 保护的 REST 端点解析实时会话所属运行时，并验证已注册客户端，不回退到其他运行时。bridge 分别记录 App 调用及其发起客户端，将请求交给对应会话的 ACP 子进程，并在断开时取消。子进程要求同一服务端已声明对应 App 资源，且目标工具允许 App 访问。关闭中的会话拒绝新调用并终止未完成调用。App 调用可以与模型 prompt 共存；现有权限队列串行显示审批，审批发起者不继承当前模型 prompt。

复用 Session.runTool 的启用检查、权限规则、审批模式、hooks、调用守卫和取消。受信任的内部 App 执行参数提供已验证工具与 buildForApp invocation。App 执行通过临时回调原样返回 MCP content、structuredContent、isError、\_meta，普通工具流程仅收到固定摘要。不把原始 App 结果发送或持久化到模型历史、遥测、hooks 或 transcript 输出。这类调用不再次加载 App HTML。

即使会话和客户端 ID 未变，替换 session attachment 也会更新 App 回调。App 工具卡仍会显示，但 `mcp-app-` 工具更新不计为模型生成，不能在模型回合结束后重新触发 Processing。普通模型工具的活动判断保持不变。

Daemon 的 `/mcp-app-sandbox` 路由现在只返回不缓存的重定向。按需启动的独立静态 HTTP listener 绑定 `127.0.0.1` 并使用随机端口。每次渲染在该 listener 上获得新的 `UUID.localhost` 主机名，使 App 与 daemon 以及其他 App 分别隔离。它不提供 daemon API、代理或 WebSocket 端点。只有精确匹配注册 Host、GET 方法及资源路径的请求能取得文档，其余请求返回 404。

服务端注册固定经过验证的 CSP 与 hostOrigin。注册在 60 秒后过期，最多保留 256 条待消费记录，并在唯一一次成功响应前删除。查询参数不能改变独立文档的策略，也不能重新填充已消费的来源。父页面来源必须是普通 HTTP(S) loopback 来源，沙箱子域会被拒绝。沙箱来源不会加入 daemon 受信任来源集合，其 CORS、Host 和 bearer 检查保持不变。

两层 iframe 均允许 scripts、forms 和 same-origin，同时保留沙箱对顶层导航、弹窗及其他未授予能力的限制。嵌套 Tableau iframe 因而可以保留自己的来源而非 `null`；App 不会获得 daemon 来源。代理校验父页面来源，并同时校验子窗口和子窗口来源。它还发送 `Origin-Agent-Cluster: ?1`。Listener 闭包持有注册表和关闭函数；两条应用关闭路径都会清空注册并关闭连接。若关闭与按需启动发生竞争，待完成的启动会拒绝，而不是让请求永久悬挂。

## 涉及层

- Core MCP 发现、DiscoveredMCPTool、ToolRegistry 及生命周期测试。
- ACP Session 和 agent 扩展分发；daemon bridge、审批归属与 REST 路由。
- TypeScript daemon client、WebShell 会话回调/AppBridge 及模型活动判断。
- 独立沙箱 listener、策略注册及 daemon 关闭集成。

## 验证与验收

验证 App-only 发现及对模型隐藏、同服务端查找、model-only/禁用/排除工具拒绝、原始结果保真，以及持久化输出不包含模拟令牌标记。验证审批允许/拒绝、hooks、取消、会话销毁与客户端/运行时归属。提交前完成构建、类型检查、相关测试和连续两轮无发现自审。

当前验证结果：独立沙箱 HTTP 探针 12/12 通过，完整 daemon 来源防护探针 14/14 通过，CLI 沙箱测试 14 项通过，Web App 测试 17 项通过。全量 build、typecheck 和 bundle 均通过。这些检查覆盖一次性来源、拒绝策略覆盖和 API/WS 路径、关闭竞态，以及真实 daemon 拒绝沙箱来源请求；它们不能证明 Tableau 图表已成功显示。还需验证 attachment 替换、模型完成后的 App 成功/失败，同时保留普通模型工具的活动状态。

在用户的 Chrome 与实际构建的 Qwen WebShell 中使用未修改的官方 Tableau HTML。官方 Tableau 4.8.1 App 已在实际构建的 Qwen WebShell 和用户的 Chrome 中成功显示经认证的 Tableau Cloud 图表。只有模型工具选择采用确定性方式；MCP HTML、OAuth、数据和嵌入的 Tableau 图表均为真实内容。先前使用无效令牌的 fixture 仅证明调用通路，与此次经认证的结果分开记录。更改 Region 筛选后图表成功更新，完整重载 Qwen 页面后，图表在新的隔离来源下恢复，Qwen 输入仍可使用。分别报告这些验证范围，并在对应行为验证后才将截图及载入观察补入 PR #12258。

## 风险与待确认问题

App 工具可能产生副作用，不允许新增绕过既有权限或 hook 策略的路径。原始结果可能包含 JWT，必须避免进入模型及 transcript 输出。宿主调用成功后，Tableau 认证与嵌入策略可能暴露其他要求；浏览器验证支持此次经认证的图表显示结果，未测试的交互行为不作成功声明。

使用 daemon 同端口的主机名别名仍能访问其 API，不能替代独立 listener。多个 App 共用一个来源会允许它们互相访问文档，因此每次渲染必须使用独立来源。随机来源解决的是嵌套 iframe 的来源身份，不是稳定 `_meta.ui.domain` 支持。远程端口转发以及本地 Chrome 测试环境以外的浏览器尚未验证；额外的 loopback listener 和 `*.localhost` 解析需要单独验证兼容性。经认证的图表显示、Region 筛选和完整 Qwen 页面重载均已在该本地 Chrome 环境中验证。
