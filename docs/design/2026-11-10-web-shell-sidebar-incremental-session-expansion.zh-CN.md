# Web Shell 侧栏：会话列表增量展开

[English](2026-11-10-web-shell-sidebar-incremental-session-expansion.md) | [简体中文](2026-11-10-web-shell-sidebar-incremental-session-expansion.zh-CN.md)

状态：已随本次变更实现。

## 问题

Web Shell 左侧栏的每个会话列表默认预览 5 条，并提供一次性的「展开全部」
（Show all）按钮。会话很多时，一次点击会挂载全部行，把侧栏其余内容挤出
可视区域，列表也难以浏览。用户希望改为有界的增量展开。

## 现状

五个侧栏渲染器共用同一模式：布尔 `showAll` 状态、
`SIDEBAR_SESSION_PREVIEW_LIMIT = 5` 的预览行数，以及文案为
`sidebar.showAllSessions`（"Show all" / 「展开显示」）的按钮，点击后显示
全部：

- `WebShellSidebar.tsx` —— 主工作区平铺会话列表。
- `WorkspaceSection.tsx` —— 二级工作区平铺会话列表。
- `SessionGroupSection.tsx` —— 置顶分组、自定义分组、未分组、定时任务与
  频道分区。
- `RecentSessions.tsx` —— 「最近」分区（目录本身上限 20 条）。
- `StandaloneRecents.tsx` —— 独立会话的活动/已归档列表。

`ActivityView.tsx` 已经是增量展开（每次点击 `budget + 10`），是本变更的
先例。

## 目标

- 会话列表按每次 10 条的有界步进展开，不再一次展开全部。
- 五个渲染器行为一致。
- 保留现有重置语义（收起、切换来源、切换排序）。

## 非目标

- 不改 5 条预览上限。
- 不改服务端分页（独立会话的「加载下一页」按钮保留
  `sidebar.showAllSessions` 文案与行为）。
- 不新增「收回到 5 条」的入口；收起分区本身就会重置预览。
- 不改置顶（Pinned）分区——它有意渲染全部置顶行，不设预览上限。

## 方案

把每处布尔展开全部状态替换为数值可见计数，初始值为
`SIDEBAR_SESSION_PREVIEW_LIMIT`。每次点击增加
`SIDEBAR_SESSION_EXPAND_STEP = 10`（新增共享常量，位于
`client/constants/sessions.ts`）。按钮文案使用新 i18n 键
`sidebar.showMoreSessions`，报告下一次点击会新增的行数：
`min(10, 剩余)` —— "Show 10 more" / 「再显示 10 个」；剩余不足 10 条时
显示实际剩余数（"Show 3 more" / 「再显示 3 个」）。全部行可见后按钮消失。

现有豁免路径不变：搜索中、重命名编辑的行在预览之外、
`limitSessions={false}` 时仍显示全部行。现有重置点把计数恢复为 5，而非
清除布尔：分区收起、工作区/来源切换、排序切换（独立会话）、批量收起/
展开。

## 设计决策

- **步进 10，累加。** 5 → 15 → 25 …… 与 ActivityView 先例一致，保持
  「每次点击加十条」的单一心智模型。「首次点击到 10」的变体会混用两种
  步进并使文案复杂化。
- **文案报告增量而非总数。** "Show N more" 明确表达点击的效果；最后一
  步计数收敛为剩余数，文案不会夸大。
- **一个共享常量，五个调用点。** 步进与预览上限一起放在
  `constants/sessions.ts`，各界面不会漂移；除常量外不引入新抽象。
- **保留 `sidebar.showAllSessions`。** 独立会话的服务端加载更多按钮仍在
  使用；删除该键会改动无关控件。

## 约束与风险

- 可见计数是组件状态，不持久化；重新挂载从 5 条预览开始，与旧布尔行为
  完全一致。
- `RecentSessions` 的目录仍上限 20 条，因此最多两次点击即展开完毕
  （5 → 15 → 20）。
- 树形行按「收起的父行算一行」计数，保持不变；步进作用于渲染行，而非
  原始会话记录。

## 验证计划

- 单元测试（vitest，jsdom）：各渲染器的同置测试文件覆盖 5 条预览、
  「Show 10 more」→ 15 行、剩余数文案、全部展开后按钮消失、收起重置。
- `i18n.test.ts` 钉住新键的中英文文案与计数。
- Playwright e2e（`web-shell.session-preview-expansion.spec.ts`）基于
  mock daemon：16 条会话的工作区按 5 → 15 → 16 展开，收起后重置，并在
  `?language=zh-CN` 下渲染中文文案。现有
  `web-shell.workspace-sidebar.spec.ts` 拖拽排序用例更新为新按钮名。

## 验收标准

- 侧栏每个会话列表每次点击至多新增 10 行。
- 按钮文案恒等于下一次点击将新增的行数。
- 全部行可见后不再保留按钮。
- 收起/来源/排序重置后列表回到 5 行。
- 搜索、重命名显示、独立会话服务端分页行为与之前一致。
