# Mod 回复行

[English](2026-11-10-mod-assistant-message-rows.md) | [简体中文](2026-11-10-mod-assistant-message-rows.zh-CN.md)

状态：提议中。本文为 Ink 终端新增 `AssistantMessage` 渲染站点，在 #13749 跟踪。OpenTUI 终端在单独的改动中跟进。

## 问题与现状

Mod 目前只能绘制输入框上方的 band，没法改变模型回复在对话记录里的呈现。想把回复显示成另一种语言、隐藏套话或高亮术语的 Mod，都无处下手。`$.model.complete`（#16737）为这类 Mod 提供了所需的补全，本改动再给它提供"行"。

现在 `ui.render` hook 会听到宿主绘制的所有站点，而宿主只绘制 `AbovePrompt`。

## 目标与非目标

目标：

- 在 Ink 对话记录里，为助手回复的每个块提供一个 `ui.render` 站点，它的 hook 可以改写该行显示的文本。
- 存储的消息、模型读到的内容、`/copy` 和导出都保留原文。
- Mod 在 hook 里等待模型调用时，会话里的其他 Mod hook 不会被每一行都挡住。

非目标：

- 用自绘的元素树替换整行。行仍然绘制自己的消息组件，只是用 hook 传下来的文本。
- OpenTUI 终端、思考行和 ACP 宿主（后续阶段）。
- 终端 scrollback 里的行（非虚拟化的 Ink），这些行一旦打印就无法重画。

## 兼容契约

以下部分遵循 Mod 作者契约：

- 组件名 `AssistantMessage`，props 为 `text`（该块的 markdown）和 `isFirstOfReply`（开启一段回复的块为 true）。
- hook 用 `next({ ...e, props: { ...e.props, text } })` 改写该行显示的内容；`next(e)` 保持原样。行对应的存储消息不变。
- 外层字段（`surface`、`component`、`requestId`、`viewport`）和 `isFirstOfReply` 固定不可改。hook 修改它们，或写入非字符串的 `text`，会像抛错一样失败：该 hook 被跳过，或者运行它的 `.catch`。
- 和其他事件一样，用 matcher 的 `component` 选择站点。

## Qwen 的设计决策

### 何时触发一行

块完整之后才触发一行，流式输出过程中不触发。流式中的块每收到一个分片就变一次，调用模型的 hook 会为每个版本付费；完整的块只问一次。在 Ink 里，一段回复存成一个 `gemini` 条目加若干 `gemini_content` 条目：流式输出时按安全切分点拆开，好让实时区域保持小巧。每个已提交的条目是一行：`requestId` 是条目的 id，`gemini` 条目的 `isFirstOfReply` 为 true。

### 只在能重画的地方提供

Ink 只在虚拟视口（`ui.useTerminalBuffer`，交互终端默认开启）里提供该站点。在 scrollback 模式下，已提交的条目只打印一次，无法改变，所以不提供该站点，它的 hook 会被跳过，和不绘制某个站点的宿主一样。这个模式在会话期间固定不变，所以加载时读取的站点列表始终正确。

只提供主对话记录。子代理视图复用同一个条目组件，但有自己的 id，可能和主对话记录的 id 冲突。

### 只为可能听到的 hook 触发站点

加载时，每个插件针对宿主绘制的每个站点，报告自己是否有 `ui.render` 注册可能听到它：不带收窄的 hook 听到所有站点；matcher 指定了 `component` 的 hook，只听到该值能匹配的站点。宿主只在有插件可能听到时才触发一行，所以只画 band 的 Mod 不会为每一行付出一次 dispatch。`$.ui.invalidate('ui.render')` 只重跑调用者可能听到的站点。

### 暂时只支持改写 props

链的结果必须是 `next` 返回的 engine 节点。之后该行用最后到达链底层的 `text` 绘制自己的消息组件。hook 如果自己返回一棵树，该行保持原样，debug 日志每次加载说明一次。改写后的 `text` 遵守元素树文本的规则：最多 100,000 个字符，除制表符和换行外不含控制字符。回复自己的文本不做检查，所以原样传下去的 hook 不会因此失败。

### 一次只渲染一行

一个会话同一时间只运行一个 Mod dispatch。上一行结束后才把下一行放入队列，所以 `tool.call` 或 `turn.start` 最多等一行。宿主会在行渲染超过 30 秒时取消它，等待模型的时间计入时限。dispatch 开始前已滚出视口的行会被跳过。结果按行和输入缓存，滚回视口时直接显示已有结果，不再 dispatch。不再显示的行最多保留 1,000 个。渲染失败时显示原文。因 `$.ui.invalidate('ui.render')` 或切换中止而重新渲染时，行在等待新结果期间继续显示旧结果。

输入超过 Mod 载荷一半的行不会触发，而不是把截断的文本交给 hook。

### 会话切换

行归属于当前显示的对话历史所在的会话。`/clear`、`/resume` 或 `/branch` 切换到另一会话时，宿主清空旧行缓存，等新历史提交后才接收其中的行。分支继承的回复纳入分支历史后，可以在分支中重新渲染。切换中止时，原会话中可见的行可以重新渲染。

### 复制提示

`/copy` 读取存储的对话历史。改写行中的 Mermaid 或 LaTeX 块如果能在原行找到唯一且完全匹配的源码，就显示原块的 `/copy mermaid N` 或 `/copy latex N` 提示。新增、改动过或无法唯一匹配的块省略提示。

## 验证与验收

core 运行时测试，使用真实的 QuickJS worker：

- 收窄、不收窄、事件模式、正则和数组 matcher 的按站点 hook 列表；只绘制 band 的宿主不列出任何行插件。
- 改写后的 `text` 会被绘制；树、修改 `isFirstOfReply`、控制字符都让该行保持原样，并只说明一次。
- 等待 `$.model.complete`（由另一个 Mod 代答）的 hook 能改写该行。
- hook 等待模型调用时 dispatch 被放弃：dispatch 能结束，宿主调用被取消，下一个 dispatch 正常运行。

CLI 测试覆盖逐行调度、跳过等待期间隐藏的行、重新挂载、invalidate、渲染时限、会话归属和源码复制提示。Ink PTY 测试执行 `/clear`，检查每行由哪个会话接收。

验收：在开启虚拟视口的 Ink 终端里，一个改写每个回复块的 Mod，在块完整后显示改写后的文本，之前显示原文；`/copy` 仍复制原文。

## 风险与待定问题

- 一行的 hook 可能让其他 Mod hook 等到该行结束或达到 30 秒时限。并发 dispatch 是单独的阶段。
- 视口底部以上的行在文本被改写后高度会变化，列表会重新测量。
- 以后是否允许 hook 在行里绘制树，以及树如何容纳 engine 自己的行。
