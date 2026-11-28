# Exec 工具调用以高亮 JavaScript 展示

[English](exec-tool-code-view.md) | [简体中文](exec-tool-code-view.zh-CN.md)

## 问题

`exec` 工具只有一个 `source` 参数：在隔离运行时中执行的 JavaScript
程序。目前所有转录界面都把工具参数渲染为 JSON，于是这段程序显示为一个
带有 `\n` 转义、没有语法高亮的 JSON 字符串字面量，多行脚本变成难以阅读
的一行。

## 现状

三个界面渲染 exec 调用的参数，且都按 JSON 处理：

- 消息列表工具卡片（`packages/web-shell/client/components/messages/ToolGroup.tsx`
  中的 `GenericToolDetails`），经由 `formatJsonPayload`；
- 回合调用面板（`TurnCallsPanel.tsx`），经由 `toolCallContent` →
  `ToolCallDetail`，后者把任何能解析为 JSON 的文本放入代码块；
- 轨迹检查器（`TrajectoryDetail.tsx`），经由 `formatRaw` →
  `ToolCallDetail`。

## 目标

- 在上述三个界面把 exec 调用的 `source` 显示为带真实换行、有语法高亮
  的 JavaScript。
- 其他工具的渲染保持不变。

## 非目标

- 不对源码做重排或美化格式化。
- 不改动结果渲染、截断上限或审批卡片。
- 不引入新的高亮依赖。

## 方案

- `toolFormatting.ts` 新增 `getExecSource(tool)`：当工具为 `exec`
  且 `args.source` 是非空字符串时原样返回，否则返回 `undefined`。
  与 `getStringArg` 不同，它不折叠换行。
- `ToolCallDetail` 增加可选 `language`。给定语言时走现有
  Markdown + shiki 管线渲染围栏代码块；仅在未给定语言时做 JSON
  自动识别。
- `toolCallContent` 对 exec 调用返回 `argumentsText = source` 与
  `argumentsLanguage = 'javascript'`；`TurnCallsPanel` 和
  `TrajectoryDetail` 把语言透传给 `ToolCallDetail`。
- `GenericToolDetails` 把参数 payload 构造为
  `{ text: source, json: false, language: 'javascript' }`；
  `ToolPayloadBlock` 以 `payload.language ?? 'json'` 设置围栏语言，
  显式语言的 payload 即使不是 JSON 也按代码渲染。

## 设计决策

- **JavaScript 而非 TypeScript。** exec 运行时执行的是纯 JavaScript
  （顶层 `await`、`tools.*` 绑定）；web shell 已内置 shiki 的
  `javascript` 语法，足以覆盖模型写出的语法。
- **源码原样展示。** 面板显示的正是模型实际执行的字节。浏览器端格式化
  器会引入依赖并可能改写程序；真实换行加高亮已解决可读性问题。
- **保留回退。** 输入中没有字符串 `source` 的 exec 调用（畸形或未来
  schema）仍按 JSON 渲染，其他工具走原有路径。
- **沿用既有预算。** 源码经过现有截断与 "Show more" 上限；超过 Markdown
  预算的代码与今天的 JSON 一样回退为纯文本。控制字符净化仍然生效
  （保留 `\n` 与 `\t`）。

## 验证计划

单元测试（vitest，PR 流水线执行）：

- `ToolGroup.test.tsx`：exec 参数渲染为 `javascript` 代码块且源码
  原样；无 `source` 的 exec 调用保持 JSON。
- `TurnCallsPanel.test.tsx`：展开的 exec 行显示高亮源码与纯文本结果。
- `TrajectoryDetail.test.tsx`：输入区把源码渲染为 `javascript` 代码。

## 验收标准

- 在三个界面展开 exec 调用时，源码显示为带真实换行的高亮 JavaScript，
  而不是 JSON 字符串字面量。
- 复制参数得到原始源码。
- 非 exec 工具、无字符串 source 的 exec、以及结果渲染均保持不变。
