# AskUser 问细节：HTML 一键预览与跟随 UI 语言输出

[English](2026-11-07-ask-details-preview-and-ui-language.md)

状态：草稿。已合并的细节侧任务（#16458，squash `61aef512e7`）的跟进。实际使用
暴露两个摩擦点：

1. 细节侧任务写到 `.qwen/tmp/` 的 HTML 解释查看不便：用户反馈要先打开文件、再
   触发预览，而不是直接看到渲染后的解释。
2. 生成的 HTML 不能可靠地用读者的语言。细节任务的本意是让用户快速了解待答问题；
   语言不匹配就达不到效果。

## 问题 1 — HTML 产物卡片一键预览

### 现状

细节子会话写一个自包含 HTML 文件并回复其路径。该文件在子会话转录里以产物卡片
（`components/artifacts/TurnOutputs.tsx` 的 `ArtifactCard`）呈现。卡片的 `Open`
动作派发 `{kind:'artifact'}` tab 请求；`App.tsx` 的 `handleTurnOutputOpen` 把
workspace HTML 产物路由到 `artifact` tab，由 `ArtifactPanel.tsx` 经
`ArtifactDetail` → `WorkspaceFilePreview`（`previewKind:'html'`）→
`HtmlArtifactPreview` → `RenderedHtmlPreview`（沙箱 `srcdoc` iframe）渲染。正常
大小的文档直接渲染；只有超过大文档阈值的才回退到源码优先的「渲染完整预览」门槛。

报告的多步体验来自侧任务上下文：子面板是嵌套右面板，从中打开产物走的是嵌套右面板
接线，而不是直接把用户落到渲染预览上。卡片又把动作泛称为「Open」，没有传达
HTML 可以渲染查看。

### proposed 改动

给 HTML 产物卡片一个显式的主 **Preview** 动作，直接打开渲染后的 HTML，复用现有
artifact-tab 预览路径（不新增预览渲染器、不新增 tab 类型）：

- `ArtifactCard` 对以 HTML 渲染的产物（`isRenderedArtifact` / HTML mime/扩展名）
  渲染一个 `Preview` 按钮，与现有 `Open`、`Download` 并列。该按钮派发卡片已有的
  同一个产物打开请求，落到渲染预览 tab。
- 仅在产物确实可打开时提供该动作（`canOpenWorkspaceArtifact`、无外部 URL），与
  现有 `Open` 守卫一致，缺失或被阻塞的产物绝不显示死的 Preview 按钮。
- i18n：若已有 `common.preview` 则复用，否则新增本地化标签（en/zh-CN）。

改动是 additive 的，限于卡片 affordance 及其打开请求；预览渲染器、沙箱/CSP、
大文档门槛均不变。

### 涉及文件

- `packages/web-shell/client/components/artifacts/TurnOutputs.tsx`
  （`ArtifactCard`、产物打开请求）。
- `packages/web-shell/client/i18n.tsx`（Preview 标签，若不复用）。
- 测试：`TurnOutputs.dom.test.tsx`（HTML 产物出现 Preview 按钮、派发打开请求、
  不可打开的产物不显示/禁用）。

### 验证点

在真实细节侧任务里确认点 Preview 直接落到渲染 HTML（单一动作），含嵌套右面板
路由。若嵌套路由仍引入中间面板，则调整 Preview 请求使渲染预览 tab 被直接激活。

## 问题 2 — 可靠跟随 UI 语言

### 现状

`askUser.detailsPrompt`（`i18n.tsx` 的 en + zh-CN）以问题快照开头（使首提示命名
得到问题派生的标题），把输出语言指令埋在段落中部（「…in English」/「…用中文
写作」）。实际上模型不能可靠遵循埋在长指令里的语言要求，HTML 可能用错语言。

### 改动方案

把语言要求改成显著、显式、强制的指令，覆盖整页，同时保持问题快照在最前（命名）
并保留 `ASD-STE100` 与 `.qwen/tmp/` token（现有内容测试）：

- en：独立要求整页——每个标题、正文句子、列表项、标签——都用 English 写作，
  不混用其他语言。
- zh-CN：整页必须用简体中文写作——每个标题、正文句子、列表项和标签都用中文，
  不要混用其他语言。

输出语言继续跟随 Web Shell UI 语言（en 模板目标 English，zh-CN 模板目标中文）；
本改动强化遵循度，不改变语言来源。

### 涉及文件

- `packages/web-shell/client/i18n.tsx`（两个 `askUser.detailsPrompt` 模板）。
- 测试：新增回归断言每个模板携带强制的整页语言要求（en + zh-CN），与现有命名
  测试（`SideTaskPanel.test.tsx`）和内容断言（`App.test.tsx`）并存。

## 范围边界

- 不改预览渲染器、沙箱/CSP、大文档门槛、产物注册、侧任务创建流程。
- 不改语言来源（仍 UI 语言）；不耦合 daemon output-language。
- 不在生成时自动打开预览（用户选的是显式一键 Preview，而非自动打开）。

## 待解问题

- 嵌套侧任务右面板路由是否需要显式调整以单一动作激活渲染预览 tab（验证阶段
  解决）。
