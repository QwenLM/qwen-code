# Web Shell 连接远程 Daemon

[English](remote-web-shell-daemon.md) | [简体中文](remote-web-shell-daemon.zh-CN.md)

状态：已为 [#11475](https://github.com/QwenLM/qwen-code/issues/11475) 实现

## 问题

Web Shell 已经通过同一个 daemon `baseUrl` 发送 workspace、session、文件、SSE 和 WebSocket 请求，但独立入口会拒绝显式选择的跨源 daemon。因此，Web Shell 页面目前无法直接连接一个已经运行的远程 daemon。

## 目标

- 允许 Web Shell URL 通过 `?daemon=<origin>` 选择一个远程 daemon。
- 允许用户在 Web Shell 中填写或更换 daemon 地址和可选的 bearer token。
- 远程 daemon 继续作为 workspace、session、文件、终端和执行的唯一所有者。
- 在所选 daemon 上保持重连和 session 导航。
- 按 daemon origin 隔离 bearer 凭据。

## 非目标

- 桌面端集成、托管 SSH、daemon 安装、发现、中继、联邦或虚拟文件系统。
- 在一个 Web Shell 实例中聚合多个 daemon。
- 启动或停止由外部管理的 daemon。

## 设计

连接地址是 HTTP origin，例如 `https://daemon.example.com`、内网地址 `http://10.0.0.8:4170`；如果用户自行管理 SSH 隧道，则填写 `http://127.0.0.1:4170`。拒绝凭据、路径、查询参数和 fragment，确保一个地址只标识一个 daemon origin。HTTP 会以明文传输 daemon 流量和 bearer token，因此在可信网络之外应使用 HTTPS。

独立 Web Shell 读取 `daemon` 查询参数，并把该 origin 传给现有的 `DaemonWorkspaceProvider`。现有 SDK 客户端随后把 REST、SSE、文件、session 和终端 WebSocket 流量直接发送到该 daemon。session 导航会保留 `daemon` 参数。

连接前页面始终提供 daemon 地址和可选 token 表单，包括 URL 中目标无效的情况。连接成功后，现有 Daemon 状态概览会显示当前目标和连接状态，并提供相同的切换控件。切换目标时执行完整页面导航，清除 URL 中已选的 session、workspace 和 context，并为新 daemon 创建全新的 SDK client。此过程不会探测或回退到其他 runtime。

现有侧边栏继续作为 workspace 和 session 管理界面。workspace 注册使用手工输入的绝对路径和 daemon 返回的目录建议；连接远程 daemon 时继续隐藏原生目录选择器。session 发现、对话记录加载、文件引用、终端流量和执行不需要再实现一套远程专用逻辑，因为它们已经统一使用所选 SDK client。

Bearer token 仍保存在当前标签页的 `sessionStorage` 中，但存储键按 daemon origin 区分。旧的无限定存储键只用于同源连接。选择远程 daemon 时绝不会复用页面自身 daemon 或另一个远程 daemon 的 token。

当 HTML shell 由 `qwen serve` 提供时，CSP 的 `connect-src` 只增加经过校验的目标 daemon origin，以及对应的 `ws:` 或 `wss:` origin。远程 daemon 仍必须通过 `--allow-origin` 独立允许 Web Shell 页面 origin；现有 Origin、Host 和 bearer 校验继续作为最终边界。

断开连接或关闭浏览器只会释放客户端连接，不会停止由外部管理的 daemon；现有 daemon 侧的客户端 detach 和 session 保留策略保持不变。

## 失败与安全边界

- 无效的远程地址会由连接页明确报告，并且不会被访问。
- 认证、Origin、Host 和网络失败继续在现有连接页中明确展示；一个有效的远程目标失败时，不会回退到本地 runtime。
- 即使 URL 指向攻击者控制的 daemon，也不会把其他 daemon 的 token 发送给它。
- 通过 `?daemon=` 选择的 loopback URL 可能是 SSH 隧道，不能据此认为 daemon host 与浏览器 host 是同一台机器。
- 接受 HTTP 和 HTTPS 目标；可信网络之外推荐 HTTPS。如需 SSH 传输，由用户在 Qwen Code 之外建立 loopback 隧道。

## 验证

- 单元测试覆盖地址校验、token 隔离、查询参数保留和 CSP source。
- 启动本地 Web Shell 和远程主机上已配置 token 的 daemon，再在浏览器中填写地址和 token 完成连接。
- 验证本地页面能列出远程 workspace、获取远程目录建议、列出和引用远程文件，并加载远程 session 对话记录。
- 验证刷新后仍保留目标和已选 session，并且不需要重新填写 token。

## 验收标准

- Web Shell 页面可以直接连接显式配置的远程 daemon origin。
- 无效或不可达的目标可以在连接页替换；已连接的目标可以在 Daemon 状态中切换。
- workspace/session 发现以及文件/终端操作通过现有 SDK 使用所选 daemon。
- 凭据绝不会跨 daemon origin 复用。
- 远程选择在导航和刷新后仍然保留。
- 无效地址以及 daemon 的策略/认证失败会明确显示，并且不会回退到其他 runtime。
