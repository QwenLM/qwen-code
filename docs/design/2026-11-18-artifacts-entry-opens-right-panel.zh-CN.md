# 产物头部入口改为打开右侧面板的产物列表 tab

[English](2026-11-18-artifacts-entry-opens-right-panel.md) | [简体中文](2026-11-18-artifacts-entry-opens-right-panel.zh-CN.md)

状态：已实现。验证记录：web-shell 包 typecheck、客户端 Vite 构建、聚焦单测/DOM
测试，以及对真实 daemon 的无头浏览器 E2E 均通过。完整根 `npm run build` 在已合入的
#17689 中记录为通过，但本次加固 PR 未重跑；`npm run bundle` 仍未验证。

## 问题陈述

聊天头部有两个按钮控制同一个 `EnvironmentPanel`：

- **切换环境信息**（`chatHeader.toggleEnvironment`）是真正的 toggle：带
  `aria-pressed={environmentOpen}`，可开可关。
- **打开产物（N）**（`chatHeader.openArtifacts`）是单向快捷入口：调用
  `handleEnvironmentPanelOpenChange(true)` 并递增 `artifactsExpandSignal` 来展开
  面板的产物小节。它没有 `aria-pressed`，也从不关闭任何东西。

两者都由 #17397（`e27d125a26`）接成这样——该 PR 把产物入口做成环境面板产物小节
的深链。由此带来三个问题：

1. **内容重叠。** 产物入口展示的是环境开关所展示内容的真子集；两个头部按钮打开
   同一个面板。
2. **状态不对称。** 环境开关打开时高亮（`.action[aria-pressed='true']`）；产物
   按钮从不高亮，哪怕是它刚打开了面板。docked 模式下再点产物按钮是无操作，而关闭
   面板的唯一途径是*另一个*按钮。
3. **浮动模式闪烁。** 浮动环境面板在外部 `pointerdown` 时关闭，且只豁免
   `data-web-shell-environment-toggle`。产物入口（`data-web-shell-artifacts-entry`）
   不在豁免之列，于是浮动着面板时点它，会在 `pointerdown` 关掉面板、又在 `click`
   重新打开。

## 现状

- `ChatContextHeader.tsx` 渲染环境开关（带 `aria-pressed`）与产物入口（无
  `aria-pressed`，仅在 `artifactCount > 0` 时显示）。
- `App.tsx` 的 `artifactsHeaderEntry` 门控为
  `artifactsHeaderItemVisible && mainView === 'chat' &&
environmentPanelItems.includes('artifacts') && connection.sessionId`，其
  `onOpenArtifacts` 打开环境面板。
- `EnvironmentPanel.tsx` 在 `artifacts` 小节列出产物；点击某行调用
  `onOpenArtifact` → `openArtifactPanel`，在右侧面板打开一个 `artifact:` tab。
- 右侧面板（`ArtifactPanel.tsx`）是多 tab 预览面。已存在由专属头部按钮打开的
  session 级 tab：`token_usage` 与 `context_usage`（`openTokenUsagePanel` /
  `openContextUsagePanel`）。无活动 tab 时面板显示 launcher
  （`right-panel-empty-actions`），其中不列出产物。
- 右侧面板的头部开关（`rightPanelAvailable`）在面板打开时隐藏
  （`!artifactPanelOpen`），因此面板一旦打开，头部就没有可见的关闭入口。
- managed 模式（`ManagedSessionsPage.tsx`）渲染自己的 `ChatContextHeader`，不传
  `onOpenArtifacts` / `artifactCount`，且两处 `ArtifactPanel` 渲染都 gate 了
  `!managedMode`。产物入口仅存在于 standalone。

## 目标

- 给产物入口一个独立目的地：右侧扩展面板，通过一个专门的 session 级**产物列表
  tab**。
- 把入口做成右侧面板的 **toggle**，带 `aria-pressed`，与右侧开关一致，消除单向
  不对称。
- 消除产物入口与环境开关之间的内容重叠（两者现在打开不同面板）。
- 保留 #17397 落地的冷打开早期可见性（入口仍读取 load 内嵌的产物列表，只是目的地
  改变）。

## 非目标 / 范围边界

- 仅 standalone 聊天。managed 模式不变。
- 环境面板的 `artifacts` 小节保留，仍可经环境开关到达。是否移除它是开放问题，不属于
  本次改动。
- 每轮 `TurnOutputs` 芯片不变。
- 右侧开关按钮自身行为不变（仍在面板打开时隐藏）。
- 不改产物存储、`/load` 响应形状，或 `useSessionArtifacts` 的早期 seed 路径。

## 提议方案

以现有 `token_usage` / `context_usage` 头部按钮 tab 为模型实现新 tab。

### 新 tab kind 与 opener

- 在 `ArtifactPanelTab` 增加 `artifacts` 成员：
  `{ id: string; kind: 'artifacts'; title: string; sessionId?: string }`。
  session 级、完全可序列化（列表本身不存在 tab 上）。
- 在 `App.tsx` 增加 `openArtifactsListPanel(sessionId)`，仿照
  `openTokenUsagePanel`：tab id 为 `artifacts:${sessionId}`，upsert 进
  `artifactPanelTabs`，设为活动，关闭时套用默认宽度，打开面板。

### 列表视图组件

- 新增 `ArtifactsListPanel.tsx`（同目录放置，仿照 `TokenUsagePanel` /
  `ContextUsagePanel`）。Props：`artifacts`、`loading`、`onOpenArtifact`。渲染与
  环境面板产物小节相同的列表形态（`FileTypeIcon` + `artifactDisplayName`）、加载
  骨架与空态。点击某行调用 `onOpenArtifact(artifactId)`。
- `ArtifactPanel.tsx`：为 `kind: 'artifacts'` 增加 `PackageIcon` tab 栏图标；增加
  内容分支，用现有 `artifacts` / `loading` props 渲染 `ArtifactsListPanel`；新增
  顶层 `onOpenArtifact?: (artifactId: string) => void` prop，在调用点接到
  `openArtifactPanel`。

### 持久化

- 在 `PersistedArtifactPanelTab` 增加
  `Pick<Extract<ArtifactPanelTab, { kind: 'artifacts' }>, 'id' | 'kind' |
'title' | 'sessionId'>`，并在 `parsePersistedArtifactPanelTab` 增加对应 case。
  恢复无需重新接线，因为列表来自实时 `artifacts` prop。

### 头部接线与状态

- `artifactsHeaderEntry.onOpenArtifacts` 改为 toggle：
  `artifactPanelOpen ? closeArtifactPanel() : openArtifactsListPanel(sessionId)`。
- 去掉 `environmentPanelItems.includes('artifacts')` 门控条件；入口现在依赖右侧
  面板而非环境面板。保留
  `artifactsHeaderItemVisible && mainView === 'chat' && connection.sessionId`。
  按钮在 `artifactCount > 0` 时渲染；或右面板打开且产物列表 tab 为激活 tab
  （`artifactsTabActive`，即 `activeArtifactPanelTabId === 'artifacts:<sessionId>'`）
  时渲染，使恢复出的零产物产物 tab 保留关闭入口；零产物且无关 tab 打开时不出现。
- `ChatContextHeader.tsx`：给产物按钮加 `aria-pressed={rightPanelOpen}`
  （`rightPanelOpen` 已是 `artifactPanelOpen`）。由于右侧开关在打开时隐藏，面板
  打开后产物按钮就是头部可见的开/关入口。
- 更新 `ChatHeaderRenderInfo.onOpenArtifacts` 契约注释为“打开右侧面板的产物列表
  tab（toggle）”；自定义 `renderChatHeader` 路径使用同一 handler。

### 清理

- 移除 `artifactsExpandSignal`（`App.tsx` 的 state、`EnvironmentPanel.tsx` 的 prop
  与 effect，以及相关测试）。它唯一的消费者是头部入口打开环境面板，而这不再发生。
  环境面板产物小节保持默认展开行为。

### i18n

- tab 标题复用 `environment.artifacts`，空态与加载态复用
  `environment.artifactsEmpty` 与 `common.loading`。这些键在各语言中均已存在，
  不新增字符串。

## 关键设计决策与理由

- **专门列表 tab，而非 launcher 或自动打开最新一个。** tab 与面板的 tab 模型一致，
  在已有其他 tab 时仍可达，且忠实展示全部 N 个产物（与计数徽章吻合）。launcher 只在
  无活动 tab 时渲染；自动打开一个产物只会显示 N 中的 1 个。
- **toggle 语义。** 打开时确保产物 tab 为活动；已打开时点击则关闭面板。
  `aria-pressed` 反映 `artifactPanelOpen`，与右侧开关一致，并补上头部关闭入口。
- **列表来自实时 prop，而非 tab 载荷。** 使 tab 完全可序列化、恢复简单，并避免陈旧
  快照。
- **保留环境面板产物小节。** 限制范围；与新 tab 的重复记为开放问题，供维护者讨论。

## 约束与风险

- 新 tab kind 必须在所有按 kind 分支处处理：`getArtifactPanelTabKind`、
  `isWorkspaceScopedTab`、tab 栏图标链、内容链，以及持久化 parse/restore。漏掉某个
  分支可能错误渲染。
- 移除 `artifactsExpandSignal` 触及 `EnvironmentPanel` 及其测试；需确认无其他消费者。
- `aria-pressed` 反映整个右侧面板，而非特指产物 tab；当其他 tab 活动时按钮仍显示
  按下。这与右侧开关一致，予以接受。
- 浮动环境面板的外部点击 bug 不再涉及产物入口（它不再打开该面板）；环境开关的豁免
  不变。

## 验证计划

- 单测：`ArtifactsListPanel`（列表 / 点击 / 空态 / 加载）；`ArtifactPanel` 产物 tab
  渲染与图标；`parsePersistedArtifactPanelTab` 接受 `artifacts`；
  `ChatContextHeader` 产物 `aria-pressed` 与标签；`App` 头部入口打开右侧面板产物
  tab、再点关闭；移除 `artifactsExpandSignal` 后环境面板仍列出产物。
- E2E（headless 对真实 daemon）：冷打开一个有产物的会话；点产物入口；断言右侧面板
  打开在产物列表 tab（而非环境面板）；点列表中某产物，断言其预览 tab；再点入口，断言
  右侧面板关闭且 `aria-pressed` 翻转；断言环境开关仍独立打开环境面板。
- 回归：每轮芯片不变；managed 模式不变；环境面板产物小节仍可用。

## 验收标准

- 产物入口打开右侧面板的产物列表 tab，而非环境面板。
- 入口是带 `aria-pressed` 的 toggle；再点关闭右侧面板。
- 点击列表中某产物打开其预览 tab。
- 环境开关不受影响；产物入口不再引起浮动面板闪烁。
- 持久化的产物 tab 跨刷新恢复。
- build、typecheck、bundle 与聚焦单测通过。

## 开放问题

- 是否同时移除环境面板的产物小节（现已被右侧面板 tab 重复）——留待维护者讨论。
- `aria-pressed` 是否应特指产物 tab 为活动，而非整个右侧面板。
