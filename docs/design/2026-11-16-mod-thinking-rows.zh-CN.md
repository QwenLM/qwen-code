# Mod 思考行

[English](2026-11-16-mod-thinking-rows.md) | [简体中文](2026-11-16-mod-thinking-rows.zh-CN.md)

状态：已在 Ink 和 OpenTUI 终端实现，Web Shell 由 [Web Shell 中的 Mod 思考行](2026-11-20-mod-thinking-rows-in-web-shell.zh-CN.md) 实现。本文新增 `Thinking` 渲染站点，在 #13749 跟踪，建立在 [Mod 回复行](2026-11-10-mod-assistant-message-rows.zh-CN.md) 之上。

## 问题与现状

Mod 能改写回复每一块的显示（`AssistantMessage`），但改不了模型的思考。想把模型英文输出显示成另一种语言的 Mod，能翻译回复，思考却仍是模型的原文。

作者契约里没有思考站点。它唯一能碰到思考文本的途径是在流式过程中改写思考分片：需要整套流式中间件，只在实时会话中生效，恢复的会话仍显示原文。

## 目标与非目标

目标：

- Ink 和 OpenTUI 对话记录里每个已完成的思考块都有一个 `ui.render` 站点，hook 可以改写展开后显示的文本。
- 从未展开的思考不触发 hook，翻译类 Mod 只为用户打开的思考花一次模型调用。
- 存储的思考和模型读到的内容保持原文。

非目标：

- 折叠行（`Thought for 12s`），由宿主绘制。
- 流式中的思考、子代理视图、会话预览、headless 运行和 ACP 宿主。Web Shell 的 ACP 会话之后才有了这个站点。
- 用树替换整行，与回复行相同。

## 契约

`Thinking` 是 Qwen Code 自己的站点，作者契约里没有对应站点，用户文档写明了这一点。事件沿用回复行的形状：

```js
{ surface: 'terminal', component: 'Thinking', requestId: '41', props: { text } }
```

- `text` 是该块的 markdown，去掉末尾空白，与行的绘制一致。hook 用 `next(...)` 传下改写后的 props；`next(e)` 保持原样。
- 信封固定，props 的键不变，hook 不能新增 prop。改写后的 `text` 沿用回复行的规则：最多 100,000 个字符，除制表符和换行外不含控制字符，只在文本变了时检查。
- hook 自己返回一棵树时该块保持原样，debug 日志说明一次。

没有 `isExpanded` prop：站点只对展开的块触发，它永远是 `true`。也没有首块标记：翻译思考的 Mod 用不到，以后需要时再加，也不会破坏按用户文档要求展开 `...e.props` 的 hook。

## Qwen 的设计决策

### 只在完成且展开时触发

两个终端默认折叠思考。思考块完成、展开且与对话视口相交时，行才把它交给 Mod。已挂载但位于视口外的块会等到滚入视口。收起或滚出视口会撤回请求。回复行的缓存也保存思考的改写结果，供再次展开或滚回时使用。空白思考不触发。

### 复用行的机制

`AssistantMessage` 和 `Thinking` 都是行站点，hook 只能改写 props。core 把它们当作同一组处理：worker 的回答（`{ tree, props }`）、props 检查和最终树的检查，以后再加行站点只需要名字和固定 props。CLI 的行调度、会话归属、30 秒期限和按站点筛选 hook 原样复用。

### 在哪里提供

与回复行相同：Ink 只在虚拟化历史（`ui.useTerminalBuffer`）下提供，展开的思考可以重画；OpenTUI 两种屏幕模式都提供。Ink 会把长思考拆成首块和后续块，各自单独触发；OpenTUI 的实时思考是一个块。`/copy` 读取助手回复，因此 Ink 在思考正文中省略 Mermaid 和 LaTeX 源码复制提示。

## 验证与验收

core 运行时测试（真实 QuickJS worker）：指定 `Thinking` 或不指定 component 的 hook 能听到它，只指定 `AssistantMessage` 的听不到；改写的 `text` 会被绘制；树、新增 prop 和控制字符让该块保持原样。

CLI 测试覆盖两个终端中已提交且展开的思考，并验证位于视口外的已挂载思考会等到滚入视口才触发。Ink 测试还覆盖后续块，并验证 Mod 新增的公式会正常显示且省略 `/copy` 源码提示。

PTY 测试在两个终端都跑。模型回复带思考和正文，一个 Mod 给每次渲染编号。测试检查折叠时不触发，`ctrl+o` 后显示第一次渲染的改写文本；收起再打开仍是第一次渲染的结果；存储的对话保留原始思考。

验收：两个终端里，改写每段思考的 Mod 在已完成的思考展开后显示改写文本，思考一直折叠时从不运行。

## 风险与待定问题

- 打开一个 hook 要等模型调用的思考时，先显示原文，答案到了再替换，该块高度会变。
- `ctrl+o` 一次展开视野内所有思考，翻译类 Mod 可能为每一块各发一次模型调用；行仍然一次渲染一个。
