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
- 同时连接多个 daemon 的会话流或同时跨 daemon 执行。
- 启动或停止由外部管理的 daemon。

## 设计

连接地址是 HTTP origin，例如 `https://daemon.example.com`、内网地址 `http://10.0.0.8:4170`；如果用户自行管理 SSH 隧道，则填写 `http://127.0.0.1:4170`。拒绝凭据、路径、查询参数和 fragment，确保一个地址只标识一个 daemon origin。HTTP 会以明文传输 daemon 流量和 bearer token，因此在可信网络之外应使用 HTTPS。

独立 Web Shell 读取 `daemon` 查询参数，并把该 origin 传给现有的 `DaemonWorkspaceProvider`。现有 SDK 客户端随后把 REST、SSE、文件、session 和终端 WebSocket 流量直接发送到该 daemon。session 导航会保留 `daemon` 参数。

连接前页面始终提供 daemon 地址和可选 token 表单，包括 URL 中目标无效的情况。连接成功后，现有 Daemon 状态概览会显示当前目标和连接状态，并提供相同的切换控件。切换目标时执行完整页面导航，清除 URL 中已选的 session、workspace 和 context，并为新 daemon 创建全新的 SDK client。此过程不会探测或回退到其他 runtime。

独立页面的侧边栏保留浏览器本地的本地与远程项目目录，以 daemon origin 和 workspace ID 区分身份。localStorage 只保存项目身份和显示名称，不保存 token。选择项目时导航到对应 daemon 和 workspace；只有当前 daemon 提供实时会话。主机不可达不会删除已保存的项目，连接页提供返回本地或其他已保存主机的入口。嵌入式消费者保留原来的单 provider 界面。

添加工作区先选择本地或远程。本地指提供页面服务的 daemon（开发时为本地 Vite 代理），不是浏览器文件系统权限。远程填写 HTTP(S) origin 和可选的按 origin 隔离的 token。更换主机时先导航，使新文档获得所选 daemon 的 CSP；认证后通过 `addWorkspace` 续接标记重新打开目录步骤，然后移除标记。在页面当前已连接的 daemon 上添加目录时，通过应用已有的工作区流程原地注册。目录建议与注册均请求该 daemon。已注册的目录直接选中，不再重复注册。只有本地目标且 capability 支持时提供原生目录选择器。会话、文件、终端与执行继续通过所选 SDK client。

Bearer token 仍保存在当前标签页的 `sessionStorage` 中，但存储键按 daemon origin 区分。旧的无限定存储键只用于同源连接。选择远程 daemon 时绝不会复用页面自身 daemon 或另一个远程 daemon 的 token。

当 HTML shell 由 `qwen serve` 提供时，CSP 的 `connect-src` 只增加经过校验的目标 daemon origin，以及对应的 `ws:` 或 `wss:` origin。远程 daemon 仍必须通过 `--allow-origin` 独立允许 Web Shell 页面 origin；现有 Origin、Host 和 bearer 校验继续作为最终边界。

断开连接或关闭浏览器只会释放客户端连接，不会停止由外部管理的 daemon；现有 daemon 侧的客户端 detach 和 session 保留策略保持不变。

## 失败与安全边界

- 无效的远程地址会由连接页明确报告，并且不会被访问。
- 认证、Origin、Host 和网络失败继续在现有连接页中明确展示；一个有效的远程目标失败时，不会回退到本地 runtime。
- 即使 URL 指向攻击者控制的 daemon，也不会把其他 daemon 的 token 发送给它。
- 如果页面加载时 `?daemon=` 指向的 origin 既不是页面自身的 daemon，也不在主机目录中，也不是本标签页刚选择的主机，则不会探测它。连接页显示该 origin 并等待用户确认连接；在此输入的 token 只发送给该 origin。
- 通过 `?daemon=` 选择的 loopback URL 可能是 SSH 隧道，不能据此认为 daemon host 与浏览器 host 是同一台机器。
- 接受 HTTP 和 HTTPS 目标；可信网络之外推荐 HTTPS。如需 SSH 传输，由用户在 Qwen Code 之外建立 loopback 隧道。

## 验证

- 单元测试覆盖地址校验、token 隔离、查询参数保留和 CSP source。
- 启动本地 Web Shell 和远程主机上已配置 token 的 daemon，再在浏览器中填写地址和 token 完成连接。
- 验证本地页面能列出远程 workspace、获取远程目录建议、列出和引用远程文件，并加载远程 session 对话记录。
- 验证刷新后仍保留目标和已选 session，并且不需要重新填写 token。

## 验收标准

独立页面的添加流程提供常驻目录列表、上一级操作，以及添加前明确的“使用此目录”确认。显示名称输入框以文件夹名作为占位提示。为已注册目录填写名称时，先更新显示名称再打开该工作区。跨主机添加后取消，会返回原来的同源页面，包括原 session 和 workspace；添加成功不触发取消导航。远程项目使用服务器图标，项目操作菜单保持可见，对话界面显示当前 daemon 和工作目录。移除操作继续通过已有确认弹窗说明文件与会话历史不会被删除。

- Web Shell 页面可以直接连接显式配置的远程 daemon origin。
- 无效或不可达的目标可以在连接页替换；已连接的目标可以在 Daemon 状态中切换。
- workspace/session 发现以及文件/终端操作通过现有 SDK 使用所选 daemon。
- 凭据绝不会跨 daemon origin 复用。
- 远程选择在导航和刷新后仍然保留。
- 添加远程项目后本地项目仍然保留，二者均可从同一侧栏选择。
- 无效地址以及 daemon 的策略/认证失败会明确显示，并且不会回退到其他 runtime。
