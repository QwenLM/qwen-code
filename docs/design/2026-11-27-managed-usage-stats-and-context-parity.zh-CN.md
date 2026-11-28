# Managed 会话能力门控用量统计与上下文入口对等（Slice 5）

[English](2026-11-27-managed-usage-stats-and-context-parity.md) |
[简体中文](2026-11-27-managed-usage-stats-and-context-parity.zh-CN.md)

状态：已实现（[统一聊天界面](2026-11-16-unified-chat-surface.zh-CN.md)
Slice 5）。日期：2026-11-27。

## 背景与问题

在全仓全部三条聊天列（`ManagedSessionsPage`、`ChatPane`、`App` 主列）均已切
至共享 `ChatSurface` 之后，Managed 会话在后端事实已经齐备的前提下仍存在两处明
确的能力门控体验差距：

1. **编辑器下方缺少共享用量统计条（`ComposerUsageStats`）。** Daemon 主列在
   编辑器下方渲染 `ComposerUsageStats` 展示实时输出速率、总 token 数与缓存命中
   率，点击可打开用量明细面板。`ManagedAgentProvider.diagnostics.getStatistics`
   已返回包含总量、token 计数、已知度计数器与生成耗时的
   `ManagedDiagnosticStats`，但 `ManagedSessionsPage` 尚未挂载
   `ComposerUsageStats`。
2. **`ChatEditor` 上下文占用环在 Managed 侧缺少详情入口。**
   `ManagedSessionsPage` 已向 `ChatEditor` 传入 `tokenCount`、`contextWindow`、
   `contextUsageKnown` 与 `contextUsageControls`，但未传入
   `onOpenContextUsage`，尽管 `ManagedDiagnosticsPanel` 已具备会话上下文拆解明
   细页签。

## 目标

- 通过后端中立的结构化类型 `SessionUsageStatsSnapshot` 解除
  `ComposerUsageStats` 与 `tokenUsageTotals` 对 daemon 类型的导入耦合，并为
  `ComposerUsageStats` 增补可选 `AbortSignal` 透传与 `cacheHitUnknown` 支持，
  对既有 Daemon 调用方保持 100% 向后兼容。
- 新增纯函数 fail-closed 适配器 `managedDiagnosticStatsToUsageSnapshot`，将
  `ManagedDiagnosticStats` 投影为 `SessionUsageStatsSnapshot`，绝不伪造用户回
  合数或未知的 token/缓存命中率。
- 在 `ManagedSessionsPage` 接入严格能力门控的 `ComposerUsageStats`（放于
  `ChatSurface.footerTrailing`）与 `onOpenContextUsage`（放于
  `ChatSurface.composerProps`），配合 `ManagedDiagnosticsPanel` 新增的可选
  `initialTab` 分别直达 `'statistics'` 与 `'context'` 页签。

## 非目标

- 不为 Managed 会话新增会话搜索或 Goal 控件（后端无对应契约，按父设计文档延
  后）。
- 不改动任何 Managed/Daemon HTTP/SSE 路由、OpenAPI schema、存储键或 i18n 文案
  键。
- 不将 `ManagedUserMessageQueue` 替换为 Daemon `ComposerStatusStack`（Managed
  队列为后端持久化记录，动作集不同）。
- 不在本增量清理 `dist-managed-host` 剩余传递 daemon 值导入（属 Slice 6）。

## 范围

- **`packages/web-shell/client/components/artifacts/tokenUsageTotals.ts`：**
  - 定义后端中立结构化类型 `SessionUsageGeneration`、
    `SessionUsageModelMetrics` 与 `SessionUsageStatsSnapshot`（与
    `DaemonSessionStatsStatus` 完全结构兼容，并增加可选
    `cacheHitUnknown?: boolean`），移除
    `@qwen-code/web-shell/daemon-react-sdk` 类型导入。
- **`packages/web-shell/client/components/ComposerUsageStats.tsx`：**
  - 将 `loadStats` 类型改为 `SessionUsageStatsSnapshot` 并新增可选第二参数
    `signal?: AbortSignal`，每次请求创建 `AbortController` 并在切会话或卸载时
    中止。
  - 当 `status.cacheHitUnknown` 为 `true` 时省略缓存命中率段，避免对从未上报缓
    存 token 的供应方误展示 `0% cache hit`。
- **`packages/web-shell/client/components/managed/managed-usage-stats.ts`：**
  - 纯适配器 `managedDiagnosticStatsToUsageSnapshot(stats)`：- 当 `availability` 为 `'unsupported'` / `'not_recorded'`、`statistics` 为
    `null`、`totals.requests.total <= 0` 或 `usageKnown.{total, prompt,
candidates}` 全为 0 时返回空快照（`models: {}`）。- 读取 `statistics.totals`（自动涵盖 `overflow` 及
    `modelBreakdownOmitted: true` 场景），将 `timing.totalGenerationMs` 与
    `timing.throughputOutputTokens` 映射至生成窗口速率字段使 `outputSpeed`
    与 `ManagedDiagnosticsPanel` 公式完全一致；`promptCount` 恒置 `0`（不将
    LLM API 请求数混同为用户回合数）；设置
    `cacheHitUnknown: totals.usageKnown.cached <= 0`。
- **`packages/web-shell/client/components/managed/ManagedDiagnosticsPanel.tsx`：**
  - 新增可选 `initialTab?: ManagedDiagnosticsTab`（默认 `'context'`）。
- **`packages/web-shell/client/components/managed/ManagedSessionsPage.tsx`：**
  - 用单一谓词
    `diagnosticsAvailable = Boolean(currentSummary?.capabilities.diagnostics && !detail.signals?.session && provider.diagnostics)`
    统一门控 `diagnosticsButton`、`onOpenContextUsage`、`ComposerUsageStats`
    与 `ManagedDiagnosticsPanel`。
  - 当 `diagnosticsAvailable && currentSummary` 时在 `ChatSurface.footerTrailing`
    渲染 `ComposerUsageStats`，向 `provider.diagnostics.getStatistics` 透传
    `AbortSignal`，点击打开 `ManagedDiagnosticsPanel` 的 `'statistics'` 页签。
  - 当 `diagnosticsAvailable` 时向 `composerProps` 传入 `onOpenContextUsage`，点
    击上下文占用环打开 `ManagedDiagnosticsPanel` 的 `'context'` 页签。
  - 在 `diagnosticsOwner` 中记录打开时的触发元素，关闭对话框时准确归还焦点。

## 关键设计决策

1. **直接读取 `statistics.totals` 而非累加 `statistics.models`。**
   - Managed 统计对按模型列表有条目上限，且可能置位 `modelBreakdownOmitted` 或
     写入 `overflow` 桶。读取 `statistics.totals` 可确保在明细截断或省略时底部
     统计条仍反映完整会话用量。
2. **对未知 token 与缓存命中指标采用 fail-closed 展示。**
   - `ManagedModelStatisticsBucket` 按字段记录 `usageKnown`。当所有请求均未上报
     token 时返回空 `models` 隐藏统计条；当缓存 token 从未上报
     （`usageKnown.cached <= 0`）时通过 `cacheHitUnknown: true` 隐藏缓存命中率
     段，避免误导性显示 `0% cache hit`。
   - `promptCount` 保持 `0`（Managed 统计的是 LLM API 请求数而非用户提示数），
     `ComposerUsageStats` 自动省略回合段。
3. **在切会话或卸载时中止在飞的 `loadStats` 请求。**
   - 通过可选第二参数 `AbortSignal` 既保持与 Daemon 单参
     `loadComposerUsageStats` 的完全兼容，又使 `ManagedSessionsPage` 在切会话、
     失权或卸载时立即取消陈旧的 `getStatistics` HTTP 请求。

## 约束

- `ComposerUsageStats` 与 `tokenUsageTotals` 不得存在任何 `daemon/**` 或
  `@qwen-code/web-shell/daemon-react-sdk` 导入。
- `build-artifact.test.ts` 的 transcript 入口隔离门禁（`keeps Token Usage copy
and lookups in the interactive entry only`）必须保持全绿。
- 不改动 Managed/Daemon HTTP/SSE 路由、OpenAPI schema、存储键或 i18n 文案键。
- 严格能力门控：当 `capabilities.diagnostics` 为假/缺失、`provider.diagnostics`
  缺失或会话读失权时，不渲染 `ComposerUsageStats` 也不提供 `onOpenContextUsage`。

## 验证与验收标准

- **单测与集成测试：**
  - `managed-usage-stats.test.ts`、`ComposerUsageStats.test.tsx`、
    `ManagedDiagnosticsPanel.test.tsx`、`ManagedSessionsPage.test.tsx`、
    `ChatSurface.test.tsx`、`App.test.tsx` 与 `build-artifact.test.ts` 全部通过。
  - 新增回归用例覆盖 `managedDiagnosticStatsToUsageSnapshot`（全部
    `availability` 态、`usageKnown` 守卫、`cacheHitUnknown`、`overflow` /
    `modelBreakdownOmitted`、`promptCount === 0`、速率公式一致）、
    `ComposerUsageStats`（切会话/卸载中止 `AbortSignal` 与 `cacheHitUnknown`）、
    `ManagedDiagnosticsPanel`（`initialTab="statistics"`）以及
    `ManagedSessionsPage`（能力门控、用量条展示、点击用量条进 Statistics 页签、
    点击上下文环进 Context 页签、切会话/失权中止请求）。
- **变异见证：** 全部可达新增守卫、能力门控、中止路径与适配器分支在独立变异装
  置下验证转红。
- **静态门禁：** `tsconfig.lib.json`、`tsconfig.json`、
  `eslint --max-warnings=0`、`prettier --check` 与全仓
  `npm run build && npm run typecheck`。
- **本地真实浏览器 Before/After E2E：** 真实本地 Vite + Chromium（`<StrictMode>`）
  分别挂载未改动 `origin/main`（改前）与 Slice 5（改后）的
  `<ManagedAgentWebShell>`，验证能力开启时编辑器下方出现共享用量条（含真实
  token/速率/缓存命中）、点击直达 Statistics 页签、点击上下文环直达 Context 页
  签，且 0 页面错误、0 非预期控制台错误。
