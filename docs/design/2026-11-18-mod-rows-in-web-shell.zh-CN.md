# Web Shell 中的 Mod 回复行

[English](2026-11-18-mod-rows-in-web-shell.md) | [简体中文](2026-11-18-mod-rows-in-web-shell.zh-CN.md)

状态：已实现。本文让 Web Shell 绘制 Mod 对回复行的改写，在 #13749 跟踪。它建立在 [ACP 会话中的 Mod](2026-11-18-mods-in-acp-sessions.zh-CN.md) 和 [Mod 回复行](2026-11-10-mod-assistant-message-rows.zh-CN.md) 之上。思考行在下一步。

## 问题与现状

Mod 能在 ACP 会话中运行之后，Web Shell 会话会加载工作区的 Mod，但它们绘制的东西到不了页面。会话不报告 surface，`ui.render` hook 被跳过；Mod 的日志行作为 SDK 不认识的帧到达事件流，Web Shell 把它们隐藏了。一个翻译回复的 Mod 在终端里有效，在 Web Shell 里什么都不做。Web Shell 设置页里也没有 `experimental.mods`，Web Shell 用户只能编辑设置文件来打开它。

## 目标与非目标

目标：

- Web Shell 会话的 Mod 在 `desktop` surface 上运行，像终端里的 `AssistantMessage` 行一样，改写模型回复每个已完成块的显示。
- 一个块只有被人看到时才花一次 hook 运行，且每段文本只花一次：刷新页面或打开第二个标签页不会再次运行 hook。
- Mod 的日志行显示在 Web Shell 的对话记录中。
- 该设置出现在 Web Shell 设置页。

非目标：

- 思考行（下一步）、prompt 上方的横条，以及代替整行绘制的树。
- 在 `$.ui.invalidate('ui.render')` 时重绘页面已经持有的行。
- ACP-over-HTTP 传输上的 Mod 行，以及其他 ACP 客户端（Zed、VS Code companion）中的 Mod 行。
- 移除 `MessageRewriteMiddleware`。思考行也完成后再移除。

## 兼容契约

以下部分遵循 Mod 作者契约：

- `AssistantMessage` 站点及其 props 与终端相同：`text`（块的 markdown）和 `isFirstOfReply`。hook 用 `next({ ...e, props: { ...e.props, text } })` 改写行。信封和 `isFirstOfReply` 是固定的。
- 会话在 `desktop` 上绘制：`session.start` 收到 `surface: 'desktop'` 和 `isInteractive: true`，`$.session.surfaces()` 为 `["desktop"]`。
- 对 `desktop` 事件，`$.ui.resolve(e)` 返回 desktop 的元素表，即十个构造器 `Box`、`Text`、`Button`、`Input`、`Select`、`Svg`、`Link`、`Code`、`Markdown` 和 `Client`。与终端一样，行只绘制改写后的 props。
- `requestId` 是行的名字；这里它是行 props 的摘要。契约中可选的 `viewport` 不提供。

## Qwen 的设计决策

### Web Shell 主动请求它的行

这一步之前的计划是让子进程对每个结束的块运行 hook，再按消息 id 和块序号把改写推送给页面。子进程做不好这件事：实时的回复块没有消息 id，页面的块编号是每次投影各自分配的，而且只有页面知道哪些块在屏幕上（对思考来说，还有哪些已展开）。所以由页面来请求。回复块完成并出现在屏幕上后，Web Shell 向 daemon 请求它的行（`POST /session/:id/mod-row`）。daemon 把请求转发给子进程，会话的 Mod 通过终端使用的同一个行队列作答。这保留了终端的成本规则：没人看到的块不花 hook 运行。

### 能力与 surface

daemon 的 bridge 在 ACP `initialize` 的客户端能力中写明它的 Web Shell 绘制哪些行站点：`_meta["qwen.modRows"]: ["AssistantMessage"]`。客户端绘制行站点时，子进程让该客户端每个会话的 Mod 在 `desktop` surface 上运行，并提供其中自己能作答的站点。Zed 和 VS Code companion 不发送这项能力，它们的会话保持原样。surface 在加载时读取，所以它属于 daemon，而不是当时打开的某个页面：经 daemon 由其他客户端驱动的会话也报告 `desktop`。daemon 在 `/capabilities` 中通告 `session_mod_rows`，Web Shell 只在此时发起请求。desktop 上 `isInteractive` 为 true，因为 Web Shell 的 prompt 前有人。

Mod 宿主把"是不是 ACP 会话"和 surface 分开，所以 desktop 会话仍遵循 ACP 宿主的规则：不触发 prompt 和工具中间件，日志经 ACP 通知发出，上下文数字取自会话自己的 chat。

### 行的身份

信封由子进程构造。`requestId` 是 component 和 props 的摘要，props 按站点的确切键和类型检查。页面的块 id 是每次投影各自分配的，在不同标签页和刷新之间都不同；摘要则让同样的文本成为同一行，于是会话的行缓存（与终端一样最多 1,000 行）可以直接回答刷新或第二个标签页，不必再运行 hook。文本和标志都相同的两个块是同一行，共用一个答案；对改写文本来说，答案本来就相同。

### 一次一个请求

Web Shell 对每个会话只保持一个在途请求，其余按出现顺序排队。轮到之前离开屏幕的块会离开队列。会话的 Mod 本来就一次渲染一行，更多的在途请求只会在子进程里等待，而大量挂起的请求可能占满浏览器到 daemon 的连接。页面放弃的请求在子进程中不会被取消，最多浪费正在进行的那一行。子进程给每个请求 60 秒，涵盖加载、排在前面的行和它自己 30 秒的渲染。bridge 的兜底超时是 75 秒。

答复说明三种情况之一。会话里没有 hook 听这个站点，页面不再为它请求。hook 没有及时作答或会话已经换了，行保持原样，下次显示时再请求。或者 hook 作答了，可能没有改写。页面只保存答案；失败永远不会被当作"没有改写"保存。

### 什么是回复行

Web Shell 提供承载模型回复的助手消息，其中包括对后台通知的回复。命令输出、工作区 Agent 的回复、本地命令的输出以及工具卡片中的子代理文本均被排除。判断 `isFirstOfReply` 时会跳过思考和 Mod 日志行，前一条消息也是回复文本时才标为 false。Web Shell 不记录响应边界，因此沿用 OpenTUI 的做法，只把已知的续块标为 false。页面只在消息的 Markdown 中绘制改写。复制、搜索和分支使用原文，与终端的 `/copy` 相同。行滚出视口后仍保留答案，所以视口上方的行高度不变。

### 日志进入对话记录

SDK 将每个 `mod_log` 显示为一行信息 `[Mod <plugin>] <text>`，与终端打印的一样。日志行排在它到达时正在输出的回复块下方。回合折叠时，分段回复也会保持可见。daemon 将日志保留在内存中。活跃会话分页加载时，已保留的日志与持久化消息页一起返回。从磁盘恢复的会话从没有先前日志的状态开始。

### 设置

`experimental.mods` 移出 Web Shell 的仅终端列表，并有了中文标签和说明。修改后新建的会话无需重启 daemon 就会加载 Mod。该设置仍声明需要重启，这在终端里成立（运行中的会话不会重新加载 Mod），所以页面也照此提示。

## 验证与验收

单元测试：

- core 运行时（真实 QuickJS worker）：desktop 宿主的 `session.start` 报告 `desktop`、`true` 和 `["desktop"]`。desktop 行被改写，`$.ui.resolve` 交出 desktop 元素表并拒绝其他 surface。
- Mod 会话：desktop 宿主用 ACP 宿主的参数和客户端的站点加载。请求得到改写；相同 props 的请求从缓存作答，`requestId` 是 32 位十六进制摘要。没有 hook 听的站点答 unhooked，过大的行按原样绘制，终端宿主不回答请求。行队列在客户端单次请求的每种结束方式下都给出结果：有改写、无改写、会话被清空、请求中止。
- ACP：能力带来 desktop 和本宿主能作答的站点。请求等待加载完成，拒绝与站点不符的 props，加载失败后答 unhooked。agent 把客户端的站点交给每个会话，并路由 ext method。
- bridge、daemon 路由和 SDK：`initialize` 声明站点，行被转发。路由检查请求体，对不在运行中的会话返回 404。SDK 认识 `mod_log`，把它画在正在流式输出的回复下方，并发出行请求。
- Web Shell：asker 一次请求一行，跳过已释放的行，保存答案，失败后重新请求，收到 unhooked 后停止。回复行绘制改写、复制原文；只在完成且在屏幕上时请求，离开屏幕后保留答案。列表标出回复行及其 `isFirstOfReply`（跳过思考和 Mod 日志行），没有能力时一行都不标。命令输出带上它的来源。

一个集成测试运行装有 Mod、且 Mod 关闭的真实 `qwen serve`。能力已通告，会话答 unhooked。通过设置路由打开 Mod 时响应说需要重启，但下一个会话就加载了 Mod，一次 prompt 完成。行被改写；第二个客户端请求同一行时得到第一次的答案，hook 的计数不增加；标志不同则再次运行 hook。`Thinking` 答 unhooked，不匹配的 props 失败，事件流中带有 `mod_log` 行 `start desktop true ["desktop"]`。对没有该能力的客户端，ACP 集成测试仍看到 `null`。

在真实 Web Shell 中做了同样的浏览器检查，回复分多段流式输出，中间有一次读文件。两个回复块在实时阶段各渲染一次；刷新后、在第二个标签页中、以及重新展开已结束的回合时，都显示第一次的答案，复制得到原文。

验收：在 Web Shell 中打开 `experimental.mods` 并安装一个改写 `AssistantMessage` 的 Mod 后，屏幕上每个已完成的回复块显示改写后的文本，刷新后再次显示且不再运行 hook，复制得到原文，Mod 的日志行显示在对话记录中。

## 风险与待定问题

- 行在完成后才请求，所以调用模型的改写会先显示原文，随后行的高度发生变化。
- surface 属于 daemon：由 daemon 的其他客户端驱动的会话也报告 `desktop` 和 `isInteractive: true`，尽管没有页面在绘制它。
- `$.ui.invalidate('ui.render')` 不会重绘页面已经持有的行；页面要到刷新后才会重新请求。之后可以加一个通知，告诉页面重新请求。
- `mod_log` 行与其他帧一样占用会话事件 ring 的位置。
- 在途请求计入空闲清理所检查的会话工作。hook 等待模型时，用户主动关闭会话可以取消请求。
- Web Shell 会话中，`Thinking` 的 hook 加载时不会收到"不会运行"的诊断（因为会话为回复行触发 `ui.render`），在思考行完成之前也不会被调用。
