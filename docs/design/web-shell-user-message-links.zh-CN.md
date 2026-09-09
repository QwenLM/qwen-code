# Web Shell 用户消息中的可点击 URL

[English](web-shell-user-message-links.md) | [简体中文](web-shell-user-message-links.zh-CN.md)

## 问题陈述

在 Web Shell 的对话历史中，助手消息已经能把裸 URL 渲染为可点击链接
（remark-gfm autolink literals → `MarkdownLink`），但用户消息以原始纯文本
渲染。用户在输入框中键入或粘贴的 URL 在对话记录里不可点击，只能复制粘贴
才能打开。

## 现状

- `packages/web-shell/client/components/messages/UserMessage.tsx` 渲染用户
  文本时不做任何链接检测：
  - `DefaultUserMessageContent` 将注解文本片段直接渲染为 `{segment.text}`。
  - `renderedContent` memo 的解析片段路径直接返回 `part.text`（解析失败时
    返回整个 `content` 字符串）。
- 助手输出经由 `Markdown.tsx`；`MarkdownLink`（`Markdown.tsx:765`）用
  `isSafeHref`（`Markdown.tsx:167`）校验 href，并通过
  `useExternalLinkOpener`（`client/hooks/useExternalLinkOpener.ts`）处理
  点击——在打包的桌面壳中拦截导航，在普通浏览器中为空操作（使用原生
  `target="_blank"` 行为）。

## 提议的改动

1. **新增工具 `client/utils/linkify.ts`**，导出
   `splitTextByUrls(text): Array<{ type: 'text' | 'url'; value: string }>`：
   - 仅匹配 `http://` 与 `https://` URL（必须显式带 scheme）。
   - CJK 字符会终止匹配（句读符号、全角括号以及表意文字/假名/谚文区
     间）——这类字符在真实 URL 中必然经过百分号编码，且中文/日文行文常
     在 URL 后不加空格直接接文字。
   - 从匹配结果尾部裁剪 ASCII 句读符号（`, . ; : ! ? ' " \``）以及在
URL 内无配对开括号的右括号 `) ] }`（当 URL 内含配对 `(`时保留`)`——例如维基百科风格的 URL）。
   - 裁剪后只剩裸 scheme（`https://`）的匹配不算 URL，保持纯文本。
2. **新增组件 `client/components/messages/LinkifiedText.tsx`**：将字符串中
   的 URL 片段渲染为 `<a target="_blank" rel="noopener noreferrer">`，用
   `isSafeHref` 校验、经 `useExternalLinkOpener` 处理点击，行为对齐
   `MarkdownLink`。非 URL 片段原样渲染。文本不含 URL 时直接返回原始字符串
   （不引入额外 DOM 节点）。
3. **`UserMessage.tsx`**：在两条默认渲染路径中用 `LinkifiedText` 包裹文本
   片段（`DefaultUserMessageContent` 的文本片段与 `renderedContent` memo
   中解析片段的文本部分）。
4. **`UserMessage.module.css`**：新增 `.link` 规则，对齐
   `Markdown.module.css`（`color: var(--agent-blue-500)`，悬停下划线）。

## 设计决策与理由

| 决策                                                     | 理由                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 仅支持显式 `https?://` scheme；不匹配裸 `www.`/域名/邮箱 | 最小改动面，几乎无误判；粘贴的 URL 几乎都带 scheme。                                             |
| 复用 `isSafeHref` + `useExternalLinkOpener`              | 与助手消息链接相同的安全校验与桌面壳路由；无需维护第二套策略。                                   |
| 独立的小工具 + 组件，而不是把用户文本走 `Markdown`       | 用户文本有意不走 markdown（composer 标签、`white-space: pre-wrap` 布局）；正则分词不改变该契约。 |
| 不处理宿主自定义 `renderUserMessageContent` 的输出       | 该输出属于嵌入宿主；覆盖它会破坏定制化契约。                                                     |
| 定时任务运行的 prompt 同样链接化                         | 机器生成的只是头部行；prompt 正文是用户编写的任务指令，应与普通用户消息一致。                    |

## 受影响文件

- `packages/web-shell/client/utils/linkify.ts`（新增）
- `packages/web-shell/client/utils/linkify.test.ts`（新增）
- `packages/web-shell/client/components/messages/LinkifiedText.tsx`（新增）
- `packages/web-shell/client/components/messages/LinkifiedText.test.tsx`（新增）
- `packages/web-shell/client/components/messages/UserMessage.tsx`（包裹文本）
- `packages/web-shell/client/components/messages/UserMessage.module.css`（`.link`）
- `packages/web-shell/client/components/messages/UserMessage.test.tsx`（集成用例）

## 范围边界

- 仅 Web Shell 对话记录中的用户消息（同时覆盖复用 `UserMessage` 的
  `mid_turn_message_injected` 系统消息）。
- 不改动助手/thinking/markdown 渲染、输入框或 CLI 终端 UI。

## 验证

- `splitTextByUrls` 单元测试：scheme 过滤、尾部标点、配对/不配对括号、
  CJK 标点、多 URL、无匹配透传。
- `LinkifiedText` 组件测试与 `UserMessage` 集成用例：URL 渲染为带
  `target="_blank"` / `rel="noopener noreferrer"` 的锚点；周围文本与
  composer 标签 chip 不变。
- `npm run build && npm run typecheck` 及聚焦的 vitest 运行。

## 验收标准

- 包含 `https://example.com/foo` 的用户消息将其显示为链接，点击在新标签页
  打开（浏览器）或调起系统浏览器（桌面壳）。
- 带尾部标点的 `https://example.com/foo.` 链接不包含最后的 `.`。
- 不含 URL 的消息渲染与之前完全一致。

## 待决问题

- 无。
