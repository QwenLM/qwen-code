# 融合本地 daemon 与 Managed WebShell

[English](2026-10-21-managed-daemon-web-shell.md) | [简体中文](2026-10-21-managed-daemon-web-shell.zh-CN.md)

状态：统一启动与共享工作区导航已实现；原生 macOS arm64 验收使用确定性模型。日期：2026-10-21。

## 问题与范围

本次改动之前，#14928 的本地启动器运行 Java、私有 Hosted Harness 和仅支持 Managed 的 WebShell。
用户还需要一条命令启动普通 daemon，并在同一个应用中使用 Local 会话。现有
WebShell 在传入 Java provider 后已经支持 Local 与 Managed 导航。

`qwen serve --managed --open` 统一监督普通 daemon、Java 和私有 Harness，公开
一个需要认证的 loopback origin。普通 `qwen serve` 保持现有行为。继续遵循 runtime
安装、H2 持久化、Managed Workspace 所有权与既有恢复限制。

## 实现方案

启动器等待 Java 与 Harness 就绪、创建默认 Managed Workspace，然后通过
`runQwenServe` 启动普通 daemon。daemon 使用正常的当前目录 Workspace 和持久公开
bearer。其内置 HTTP、SSE 与 WebSocket 传输继续独占普通 Session、终端、语音和
Workspace 路由，避免为 daemon 的传输与安全边界再实现一层代理。
普通 ACP 子进程在首次 Local 使用时启动，不在报告应用就绪时并行预热。这样用户
刚启动便立即停止应用时，不会遇到初始化期间的退出竞态；仅使用 Managed 时也不
创建闲置的 Local 模型进程。

启动器通过私有依赖配置，在 daemon 认证之后、JSON body 解析之前，挂载既有
Managed boot 与签名 Java 代理路由。`/managed/boot` 属于进程级作用域。Java
WebShell 与精确附件内容路由保留 Java 的 tenant、actor、Workspace 与 Session
授权，绝不回退普通 daemon handler。`/capabilities` 返回真实 daemon 能力。
Java 内部、writer、Broker 和维护接口继续保持私有。

服务端 HTML 标记启用需要认证的同源 Managed boot。浏览器仅使用经过校验的公开
启动值和公开 bearer 创建现有 Java provider，并传给正常的 standalone WebShell。
共享工作区导航控制两类会话。调用者提供的 daemon 目标、身份字段或 Java
endpoint 不能修改 Managed provider。恢复 Managed URL 时，不能被过时的 Local
Workspace 或 Session 导航参数阻断。

启动器独占进程信号，本调用禁用内嵌 daemon 的信号处理。退出时先关闭 daemon
接入与传输，再停止 Java 和 Harness。daemon 监听意外关闭或所属子进程退出时，
以非零结果结束应用。启动失败清理所属服务并释放私有数据锁。持久 worker 继续
遵循既有所有权。

## 共享工作区导航

移除 Local/Managed 执行方式 tab。普通与托管工作区进入现有“项目”导航，托管工作区带有“托管”标识，每个工作区包含自己的会话。选择会话沿用其所属 provider，从工作区新建任务则使用该工作区的 provider。顶部“新建任务”跟随当前会话或草稿。打开托管会话时，普通工作区、无工作区会话及其既有操作仍然可用。

侧边栏在现有工作区列表内提供内部插槽。托管页面保留单一的会话目录、分页和刷新生命周期，并将导航投影到该插槽；插槽接收共同的搜索文本。托管工作区发现使用已有 provider 的 workspace binding API，无需修改 Java、SDK 协议或 daemon 路由。工作区和会话身份保留 provider storage key 与服务端 ID。即使显示名或 ID 相同，也绝不把托管工作区伪装成普通 daemon cwd。

托管工作区选择接入已有创建组件，保留工作区校验、已编辑目录的切换确认、未决命令恢复和授权检查。显式选择的工作区若不能创建会话，应保持不可用，不能悄悄切换到其他工作区或普通 primary。新建工作区或会话会刷新共同目录。托管工作区发现与全局分页的托管会话列表均保留显式加载更多入口。会话所属工作区不在当前工作区页时，仍按服务端工作区身份提供可达入口。

两种会话组件保持挂载，使导航保留草稿和进行中的工作。托管深链与显式普通链接沿用现有 URL 约定。普通权限、文件系统、Git、信任、删除和运行时控制不会成为托管行的操作。共享界面导航不迁移会话、不合并存储，也不增加跨 provider 操作。

已选会话的工作区解析区分待确认、已确认绑定和已确认旧式未绑定三种状态。历史导航进入不同会话时，先使原工作区失效，再允许新建任务；重放或完成同一会话时保留已确认绑定。

显式导航与异步命令完成使用不同回调。点击托管历史会打开对应会话；如果托管创建或提交在用户选择普通会话后才完成，只更新已记录的托管选择。工作区创建使用[工作区运行方式选择](2026-10-21-unified-workspace-navigation.zh-CN.md)中的显式选项。统一创建弹窗保持打开时，完成创建会选中新工作区；已关闭或后台操作不会切换当前显示的 provider。

验收要求：没有执行方式 tab、两种 provider 导航同时可见、空工作区和分页工作区正确归组、选择与新建及草稿保持 provider 作用域、刷新和深链恢复正常、共同搜索生效，以及托管错误明确显示且不回退普通后端。仅普通或仅托管的现有嵌入方式仍需可用。

## 影响组件与边界

- CLI 本地启动器、Managed 代理中间件和 daemon 内嵌依赖。
- WebShell 认证启动、provider 注入、共享工作区导航与创建及选择回归测试。
- 双语本地交付设计和用户说明。

本次不增加托管模式、公开 Java endpoint、跨 provider 会话转换、远程 daemon
Managed fanout 或发行发布。普通 daemon 可使用启动目录。Managed 工作使用应用
创建的 Workspace，或通过已有本机目录导入能力显式导入的项目；回环签名启动器
会启用该能力。

完整界面已有的 Mobile access / Local Control 入口尚未接入：其配对 LAN 监听无法
通过 Managed boot 的 primary-listener 校验。本次仅验收 loopback 应用，调整或
隐藏该入口属于后续工作；普通 daemon 的 Local Control 语义不变。

## 验证与验收

先用全局 CLI 记录尚未支持的基线，再使用隔离 runtime/data 目录验证本地 bundle。
确认单个监听提供真实 daemon capabilities、普通 Workspace API 和认证后的
Managed boot，UI 在同一工作区导航中显示两种 provider 且没有执行方式 tab。使用确定性模型 fixture 分别
运行普通 Session 与 Managed Session，刷新并恢复两者，验证流式响应与普通 ACP
WebSocket，再停止启动器。检查启动拒绝和所属服务故障只清理所属服务，并保留
持久数据。

定向测试覆盖 Java 原始字节签名、路由所有权与拒绝、公开 boot 认证、provider
origin/token 绑定、过时 Local 导航、启动器清理与内嵌信号策略。运行根目录 build、
typecheck、bundle，受影响 CLI/WebShell 测试，以及格式和 lint。回环签名本机目录
导入涉及的 Java 授权改动见其[独立设计](2026-10-21-managed-local-directory-import.zh-CN.md)；
明确报告无法运行的 runtime 或浏览器检查。

macOS arm64 上重新构建的 CLI 与匹配的既有 Java runtime 已通过验收：两类 Session
均完成两轮对话，保留独立草稿并在刷新后恢复；带有过时 Local 参数的链接能恢复
Managed 历史。认证 HTTP、原始字节签名、SSE 与 ACP WebSocket 检查通过。正常与
立即退出、端口占用后重试、重启持久化、所属服务故障与缺失 runtime 拒绝均通过，
所属测试服务已清理。根目录 build、typecheck、bundle、215 项相关单元测试、定向
lint、格式和文档引用检查通过。模型响应来自确定性 fixture；本次未验收 Linux
生命周期、真实 provider 推理和整机重启恢复。

共享导航修订通过 431 项定向前端测试，覆盖工作区及会话分页、显式选择拒绝、未决创建、已编辑目录确认、隐藏 Local 所有权与后台命令完成。浏览器验收覆盖同名普通及托管工作区与历史、独立草稿、在两种 provider 中实际新建任务、空工作区草稿、共同搜索、带过时 Local 路由的刷新，以及浏览器前进和返回。API 回读确认新托管任务的精确工作区及普通任务原有 cwd。模型调用使用隔离的确定性 fixture。针对新 prompt 的首次精确文本等待已按 fixture 实际的 `Fixture reply:` 协议修正，这不是产品失败。一项定向后台完成测试先复现了导航回归，在区分显式导航与结果记录后通过。

## 未决问题

本范围没有必需的未决问题。匹配 runtime archive 的公开发行与更多平台的生命周期
验收独立于本地实现。
