# Web Shell 连接远程 Daemon

[English](remote-web-shell-daemon.md) | [简体中文](remote-web-shell-daemon.zh-CN.md)

状态：[#11475](https://github.com/QwenLM/qwen-code/issues/11475) 的 Web Shell 阶段实现。2026-10-08 修订：恢复侧边栏聚合视图，取代 2026-09-12 的收窄（`e879557a`）——那次变更删除了多主机项目目录并把聚合声明为非目标。

## 问题

Web Shell 已经通过同一个 daemon `baseUrl` 发送 workspace、session、文件、SSE 和 WebSocket 请求，但独立入口会拒绝显式选择的跨源 daemon。因此，Web Shell 页面目前无法直接连接一个已经运行的远程 daemon。

连接远程 daemon 还会同时隐藏所有本地项目：侧边栏只列出所连 daemon 的 workspace，每一行都带着按连接判定的同一个“远程”标记，没有任何地方标出主机名。用户添加远程目录后期待侧边栏把本地文件夹保留在它旁边；实际看到的却是每一行都标着“远程”，而且找不到回到本地 daemon 的入口。

## 目标

- 允许 Web Shell URL 通过 `?daemon=<origin>` 选择一个远程 daemon。
- 允许用户在 Web Shell 中填写或更换 daemon 地址和可选的 bearer token。
- 记住验证成功的远程计算机，让后续添加 workspace 时可以复用。
- 远程 daemon 继续作为其 workspace、session、文件、终端和执行的唯一所有者。
- 在所选 daemon 上保持重连和 session 导航。
- 按 daemon origin 隔离 bearer 凭据。
- 在同一个侧边栏中同时保留本地与远程项目身份：条目以 daemon origin + workspace ID 区分，当前所连主机的实时项目列表在前，其他主机的已保存项目按主机分组列在其下。选择已保存项目时导航到对应主机和 workspace。
- 按行、按主机标记归属：只要已知不止一台主机，实时项目列表上方就标出所连主机；已保存的远程条目使用服务器图标，本地条目使用笔记本图标；对话标题栏用标签标出对话所在的主机。

## 非目标

- 桌面端集成、托管 SSH、daemon 安装、发现、中继、联邦或虚拟文件系统。
- 在一个 Web Shell 实例中同时流式接收或跨多个 daemon 执行实时会话。只有所连 daemon 是实时的；其他主机以已保存身份出现，选择时导航过去。
- 启动或停止由外部管理的 daemon。

## 设计

连接地址是 HTTP origin，例如 `https://daemon.example.com`、内网地址 `http://10.0.0.8:4170`；如果用户自行管理 SSH 隧道，则填写 `http://127.0.0.1:4170`。拒绝凭据、路径、查询参数和 fragment，确保一个地址只标识一个 daemon origin。HTTP 会以明文传输 daemon 流量和 bearer token，因此在可信网络之外应使用 HTTPS。

独立 Web Shell 读取 `daemon` 查询参数，并把该 origin 传给现有的 `DaemonWorkspaceProvider`。现有 SDK 客户端随后把 REST、SSE、文件、session 和终端 WebSocket 流量直接发送到该 daemon。session 导航会保留 `daemon` 参数。

连接前页面始终提供 daemon 地址和可选 token 表单，包括 URL 中目标无效的情况。连接成功后，现有 Daemon 状态概览会显示当前目标和连接状态，并提供相同的切换控件。切换目标时执行完整页面导航，清除 URL 中已选的 session、workspace 和 context，并为新 daemon 创建全新的 SDK client。重连到当前正在使用的目标时改为原地重新加载，因此已选的 session、workspace 和 context 会像普通刷新一样原样保留。此过程不会探测或回退到其他 runtime。连接页列出已保存的主机，让用户在主机不可达或选错时始终有路可回。

现有侧边栏继续作为 workspace 和 session 管理界面，并同时保留页面自身 daemon 与浏览器使用过的远程主机的项目身份。条目以 daemon origin + workspace ID 区分。`localStorage` 只持久化身份字段——origin、workspace `id`、`cwd`、`displayName`——绝不保存 token 或项目内容。只要已知不止一台主机，实时项目列表上方的标题就标出所连主机：页面自身 daemon 用笔记本图标，远程主机用服务器图标加主机名。实时列表下方，其他主机的已保存项目按主机分组渲染；跨源连接时始终合成页面自身 daemon 的分组，让本地项目保持可见、可选。选择已保存项目会导航到对应主机并预选该 workspace（`?daemon=<origin>&workspace=<id>`）；只有所连主机提供实时会话。主机不可达不会删除其已保存项目，过时的列表继续渲染。跨源连接时实时列表中的远程 workspace 行继续使用带蓝色小地球的文件夹图标，已保存的远程条目使用普通服务器图标，两个分区里本地与远程目录在视觉上都能区分。

所连 daemon 的每次 capabilities 刷新都会把该主机的项目身份重新写入已保存主机目录。跨源连接时，shell 额外用按 origin 隔离的 token 探测页面自身 daemon 并刷新其已保存项目列表，让本地分组在首次使用时就有内容并保持最新；探测失败则保留上一次保存的列表。

设置中新增“连接”分类，用于添加、查看、移除或选择远程计算机。添加跨 origin 计算机时会临时导航到对应 daemon，复用现有连接页验证 capabilities 和凭据而不放宽 CSP；验证成功或取消后都会返回来源 shell，并重新打开“设置 > 连接”。无论来自“设置 > 连接”还是 Daemon 状态，只要显式提交连接表单，就会把验证后的 origin 记录到浏览器本地的连接目录中；bearer token 仍限定在当前标签页，移除连接时也会同时清理该 origin 在当前标签页中的凭据。普通的“添加工作区”操作直接打开目录浏览器；浏览器顶部的“目录来源”可以选择这台计算机或一台已连接的远程计算机，参考 Codex 创建项目时的来源选择方式，不再增加独立的“本地/远程”步骤。选择当前标签页尚未连接的计算机时导航到对应 daemon，再续接同一个目录浏览流程；选择当前已连接的 daemon 则保持原地打开，不重新加载 shell。目录浏览使用 daemon 返回的目录建议，支持进入上级目录和手工填写绝对路径，并通过现有 workspace mutation 注册所选目录；连接远程 daemon 时继续隐藏原生目录选择器。session 发现、对话记录加载、文件引用、终端流量和执行不需要再实现一套远程专用逻辑，因为它们已经统一使用所选 SDK client。

对话标题栏用一个紧凑标签标出对话所在的主机——笔记本图标加“本地”，或服务器图标加“远程 · 主机名”——工作目录放在悬停提示中。已知至少一台其他主机时才显示该标签；纯本地 shell 保持无标签。

添加操作仍是一次性流程。导航期间只在当前标签页保存来源 URL；取消会返回该 URL，切换“目录来源”会在所选计算机上续接同一个目录浏览器，注册成功后留在所选 daemon 并清除续接状态。连接目录只保存 origin；已保存主机项目目录只保存身份字段，绝不保存 token，也绝不会把一个 daemon 的 workspace 合并进另一个 daemon 的实时列表。普通 daemon 切换不会续接该流程。

Bearer token 仍保存在当前标签页的 `sessionStorage` 中，但存储键按 daemon origin 区分。旧的无限定存储键只用于同源连接。选择远程 daemon 时绝不会复用页面自身 daemon 或另一个远程 daemon 的 token。

当 HTML shell 由 `qwen serve` 提供时，CSP 的 `connect-src` 只增加经过校验的目标 daemon origin，以及对应的 `ws:` 或 `wss:` origin。远程 daemon 仍必须通过 `--allow-origin` 独立允许 Web Shell 页面 origin；现有 Origin、Host 和 bearer 校验继续作为最终边界。为刷新已保存项目而探测页面自身 daemon 属于同源请求，不需要改动 CSP。

断开连接或关闭浏览器只会释放客户端连接，不会停止由外部管理的 daemon；现有 daemon 侧的客户端 detach 和 session 保留策略保持不变。

## 失败与安全边界

- 不熟悉的 `?daemon=` 目标必须先明确确认，再发起探测。显式连接表单只会在 capabilities 探测成功后把目标写入持久化连接目录；直接打开普通 daemon URL 仍只在当前标签页生效。
- 浏览器本地文件桥仅在所连接的 daemon 与页面同源时提供，独立与嵌入式外壳一致：跨来源目标不会挂载文件桥，本地目录不会被交给一个文案承诺「文件留在你的电脑上」的远程 daemon。远端工作区文件仍由选中的 daemon 提供。同源的 SSH 隧道部署保留原行为和按来源隔离的授权。
- 远程添加续接必须显式触发，只在当前标签页生效，并且仅使用一次。它复用只含 origin 的连接目录，并且不会改变普通 daemon 切换行为。
- 已保存主机项目目录只持久化项目身份（origin、id、cwd、displayName），绝不保存 bearer token、文件内容或 session 数据；从连接目录移除的主机只保留其已保存项目，直到下一次 capabilities 刷新成功为止。
- 无效的远程地址会由连接页明确报告，并且不会被访问。
- 认证、Origin、Host 和网络失败继续在现有连接页中明确展示；一个有效的远程目标失败时，不会回退到本地 runtime。
- 即使 URL 指向攻击者控制的 daemon，也不会把其他 daemon 的 token 发送给它。
- 通过 `?daemon=` 选择的 loopback URL 可能是 SSH 隧道，不能据此认为 daemon host 与浏览器 host 是同一台机器。
- 接受 HTTP 和 HTTPS 目标；可信网络之外推荐 HTTPS。如需 SSH 传输，由用户在 Qwen Code 之外建立 loopback 隧道。

## 验证

- 单元测试覆盖地址校验、token 隔离、查询参数保留和 CSP source。
- 单元测试已保存主机目录：只持久化身份字段、刷新时更新、跨源时合成页面自身分组、存储不可用时降级。
- 启动本地 Web Shell 和远程主机上已配置 token 的 daemon，再在浏览器中填写地址和 token 完成连接。
- 在“设置 > 连接”中添加一台远程计算机，确认验证后回到同一个设置分类，再通过普通“添加工作区”的“目录来源”选择该计算机，浏览并注册一个目录，确认新 workspace 在该 daemon 上成为当前 workspace。
- shell 连接远程 daemon 时，验证侧边栏在实时列表上方标出所连主机、在其下方的本地分组中列出页面自己的项目、仅在主机跨源时给实时行加地球标记、并显示标题栏标签；然后选择一个已保存的本地项目，确认页面导航到页面自身的 daemon 并激活该 workspace。
- 验证切换“目录来源”时目录浏览器保持打开，取消会回到准确的来源页面且 URL 不含 token 或续接标记，普通 daemon 切换不会打开目录浏览器。
- 验证本地页面能列出远程 workspace、获取远程目录建议、列出和引用远程文件，并加载远程 session 对话记录。
- 验证刷新后仍保留目标、已保存主机分组和已选 session，并且不需要重新填写 token，包括已保存主机不可达的情况。

## 验收标准

- Web Shell 页面可以直接连接显式配置的远程 daemon origin。
- 无效或不可达的目标可以在连接页替换；已连接的目标可以在 Daemon 状态中切换。
- 独立 Web Shell 的设置面板提供“连接”分类，用于管理验证过的远程计算机 origin。
- 侧边栏只提供一个“添加工作区”入口，并直接打开目录浏览器；“目录来源”可以在这台计算机和验证过的远程连接之间切换，跨导航续接、浏览 daemon 目录并注册所选绝对路径。
- 添加远程目录后本地项目仍然保留在列表中：所连主机的实时项目与页面自己的已保存项目都能从同一侧边栏选择，按主机分组并标注。
- 归属按行、按主机标记：远程条目用服务器图标，本地分组用笔记本图标，仅在所连主机跨源时给实时行加地球标记，对话标题栏标签标出当前主机。
- 取消会按预期回到来源 shell，切换“目录来源”时目录浏览流程保持活动；添加成功后留在所选 daemon；持久化目录只含连接 origin 与项目身份字段，绝不包含 token 或项目内容。
- workspace/session 发现以及文件/终端操作通过现有 SDK 使用所选 daemon。
- 凭据绝不会跨 daemon origin 复用。
- 远程选择在导航和刷新后仍然保留。
- 无效地址以及 daemon 的策略/认证失败会明确显示，并且不会回退到其他 runtime。
