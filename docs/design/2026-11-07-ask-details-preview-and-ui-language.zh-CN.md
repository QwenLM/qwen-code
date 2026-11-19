# AskUser 问细节：HTML 产物卡片的 Preview affordance 与跟随 UI 语言输出

[English](2026-11-07-ask-details-preview-and-ui-language.md)

状态：已实现（跟进 PR #16587）。已合并的细节侧任务（#16458，squash
`61aef512e7`）的跟进。实际使用暴露两个摩擦点：

1. 细节侧任务写到 `.qwen/tmp/` 的 HTML 解释不便被发现为渲染视图：产物卡片把动作
   泛称为「Open」，没有传达 HTML 会渲染打开。用户描述为要先打开文件再预览；下方
   验证发现路由本就一步直达渲染，故摩擦是可发现性，而非步骤数。
2. 生成的 HTML 不能可靠地用读者的语言。细节任务的本意是让用户快速了解待答问题；
   语言不匹配就达不到效果。

## 问题 1 — HTML 产物卡片的 Preview affordance

### 现状

细节子会话写一个自包含 HTML 文件并回复其路径。该文件在子会话转录里以产物卡片
（`components/artifacts/TurnOutputs.tsx` 的 `ArtifactCard`）呈现，因为提示词中
显式的 `record_artifact` 步骤登记了它——`write_file` 的自动登记会跳过 `.qwen/` 等
点目录，没有该步骤就不会有卡片。卡片的 `Open` 动作派发 `{kind:'artifact'}` tab
请求；`App.tsx` 的 `handleTurnOutputOpen` 把
workspace HTML 产物路由到 `artifact` tab，由 `ArtifactPanel.tsx` 经
`ArtifactDetail` → `WorkspaceFilePreview`（`previewKind:'html'`）→
`HtmlArtifactPreview` → `RenderedHtmlPreview`（沙箱 `srcdoc` iframe）渲染。正常
大小的文档直接渲染；只有超过大文档阈值的才回退到源码优先的「渲染完整预览」门槛。

追踪打开路径可见点击本就一步落到渲染预览：卡片的 `Open` 派发同一个
`{kind:'artifact'}` 请求，嵌套侧任务面板经同一个 `handleTurnOutputOpen`
（`onNestedRightPanelOpen`）路由，因此继承完全相同的 artifact-tab 预览路径。该路径
上唯一的源码优先门槛是 `LargeDocumentPreview`（>1 MiB），自包含的细节解释不会触发。
所以缺口是可发现性：泛称「Open」（配外链图标）没有传达 HTML 会渲染打开。这是静态
代码追踪，不是在嵌套面板里的真实点击；visuals 截图在会话转录里对 mock daemon 演练
该卡片。

### 改动方案

给 HTML 产物卡片一个显式的主 **Preview** 动作，直接打开渲染后的 HTML，复用现有
artifact-tab 预览路径（不新增预览渲染器、不新增 tab 类型）：

- `ArtifactCard` 对可渲染产物（`isRenderedArtifact`：HTML、Markdown、图片）把其
  单一打开动作改标为 **Preview**（配眼睛图标）。它**替换**这些产物上的泛称
  `Open` 标签——同一个按钮条件切换图标与文案，而非在 `Open` 之外多一个按钮；
  `Download` 不变。点击处理与改动前逐字节一致：派发同一个产物打开请求，本就落到
  渲染预览 tab。
- 仅在产物确实可打开时提供该动作（`canOpenWorkspaceArtifact`、无外部 URL），与
  现有 `Open` 守卫一致，缺失或被阻塞的产物绝不显示死的 Preview 按钮。
- i18n：复用已有的 `turnOutputs.preview` 键（en/zh 已定义、`ArtifactPanel` 已用）；
  不新增 i18n 键。

改动限于卡片 affordance（标签＋图标）；点击派发、预览渲染器、沙箱/CSP、大文档
门槛均不变。

**影响范围。** relabel 基于 `isRenderedArtifact`，因此每个会话里的 HTML、Markdown、
图片产物卡片都会显示「Preview」，不止问细节卡片。这是为一致性有意为之：这些产物
都打开在渲染预览 tab。非渲染产物（如 CSV、PPTX）与外链产物保持「Open」。
`external_url` 产物（如带 `url`、无 workspace 路径的图片）即使类别本可渲染也保持
「Open」：面板对它只展示元信息与 Open link，卡片不能承诺预览。
`isRenderedArtifact` 就本次改标的类别与面板谓词对齐——归一化 mime 参数
（`text/html; charset=utf-8` → `text/html`）、并在路径无扩展名时也认 `image/*`
mime（`getArtifactImageMimeType`）——故 HTML、Markdown、图片卡片与面板一致。
PDF、DOCX、XLSX 卡片保持「Open」：面板经专门查看器渲染它们
（`WorkspacePdfPreview` / `DocxPreview` / `SpreadsheetPreview`），但它们不在本次
改标范围内（既有行为，此处未改）。这两种 mime 形状都可由模型经 `record_artifact`
输入产出，已有夹具钉住。

### 涉及文件

- `packages/web-shell/client/components/artifacts/TurnOutputs.tsx`
  （`ArtifactCard`、条件图标/标签）。
- `packages/web-shell/client/i18n.tsx`（不新增键；复用 `turnOutputs.preview`）。
- 测试：`TurnOutputs.dom.test.tsx`（HTML 产物 Preview 标签、非渲染保持 Open、
  不可打开的产物 Preview 禁用）。

### 验证（已解决）

嵌套路由的待解问题由代码追踪关闭：嵌套侧任务面板与主转录用同一个
`handleTurnOutputOpen`，workspace HTML 产物路由到渲染预览 tab、1 MiB 以下无源码
优先门槛，故点击本就一步落到渲染 HTML。因此本 PR 修的是标签（可发现性），而非
步骤数。visuals 截图（真实 Chromium、mock daemon）展示卡片改动前（「Open」）与
改动后（「Preview」）；点击派发不变。这是静态追踪加 mock-daemon 截图，不是在真实
嵌套侧任务面板里的 live 点击；若未来在最新构建上仍报告多步，嵌套路由需另行 live
调查。

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
- 不在生成时自动打开预览（用户选的是显式 Preview 动作，而非自动打开）。
- 不改路由：点击派发与之前的「Open」完全一致。

## 待解问题

- affordance 改动无遗留待解。嵌套路由问题已由代码追踪解决（见上方验证）。
- 强化后的整页指令在实践中是否改变模型输出语言，本质上是概率性的；测试钉住提示词
  字符串，而非模型遵循度。语言**设置项**（机制）是更强的杠杆，但在此有意超范围。
