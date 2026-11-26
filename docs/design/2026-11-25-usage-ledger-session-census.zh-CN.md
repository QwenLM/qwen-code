# 台账口径会话普查与 Daemon 会话结束用量持久化

[English](./2026-11-25-usage-ledger-session-census.md)

## 状态

已实现 —— 已通过本地单元测试、全仓构建/类型检查以及真实进程 CLI/daemon/ACP 端到端验证；PR #17902（[用量面板与 `/stats` Token 口径修复](./2026-11-19-usage-dashboard-accounting.zh-CN.md)）的直接后续迭代。

## 问题

PR #17902 已将 Daemon 状态用量面板与 TUI `/stats` 的 token、请求数、平均延迟与缓存命中率统一对齐到逐请求台账（`token-usage-YYYY-MM.jsonl`），并有意将两项缺口留作后续：

1. **仅按记录文件计数的会话数严重偏少，且可能出现 `tokens > 0` 但 `sessions = 0`。** `buildUsageDashboard`（`summary.sessions` 与 `daily[i].sessions`）和 `loadStatsData`（`report.sessionCount` 与 `delta.sessions`）目前仍只统计持久化或重建出的 `UsageSummaryRecord` 条数。退出前被强杀的进程、从未写入 `usage_record.jsonl` 的 daemon 会话、以及未被扫描目录覆盖的历史都存在于逐请求台账中（例如参考历史 7 天内台账共有 633 个会话），却未计入会话数；反之，同一个会话被 resume 三次会写出三条运行记录并被算成 3 个会话而非 1 个。
2. **Daemon / ACP 会话在结束时从未持久化 `usage_record.jsonl`。** CLI 运行会在退出及 `/clear` / `/resume` / `/branch` 切换时落盘按运行增量，但 `packages/cli/src/acp-integration/acpAgent.ts` 的 `QwenAgent.removeStoredSessionEntry` 直接调用 `uiTelemetryService.removeSession(sessionId)` 丢弃内存指标而从未落盘。导致 daemon / Web Shell 会话在关闭、空闲回收或优雅停机后丢失按项目、工具、文件变更、时长与技能明细，并迫使每次面板刷新重复扫描重放 transcript。

## 范围

- 范围内：
  - 在 `UiTelemetryService` 中新增按 `sessionId` 隔离的实时指标与运行起始时钟（排除重放与恢复的历史，与 PR #17902 进程级 `#liveMetrics` 不变量保持一致）。
  - 在 `removeStoredSessionEntry` 销毁 daemon / ACP 会话时，以 best-effort、至多一次语义落盘 `runScoped: true` 增量记录（覆盖显式关闭、空闲回收与 daemon 优雅停机）。
  - 在 `usage-dashboard-service.ts` 提供共享的台账口径唯一活跃会话计数（`countActiveSessions`），供 `buildUsageDashboard`（`summary.sessions` 与 `daily[i].sessions`）和 `loadStatsData`（`report.sessionCount` 及 `delta.sessions` 两侧）共用。
  - 同步更新 Web Shell 全语种的每日会话图副标题（由「每日结束运行数 / runs ended per day」更新为「每日活跃会话数 / active sessions per day」）。
- 范围外：
  - 不修改 `TokenUsageRecord`（`schemaVersion: 1`），不向逐请求台账写入工作目录路径。保持路径隐私边界是明确产品决策；daemon 会话的按项目、工具、文件与技能明细改由会话结束落盘 `usage_record.jsonl` 自然补齐。
  - 不改变 `usageHistoryService.ts` 中底层纯记录聚合函数 `aggregateUsage` 的行为。

## 设计

### 1. 按会话隔离的实时遥测与 Daemon 会话结束落盘

`UiTelemetryService` 目前的 `#sessionMetrics` 会接收来自 `addReplayedEvent` 与 `restoreSessionModelMetrics` 的历史事件。若在 daemon 关闭时直接持久化 `#sessionMetrics`，会重新引入 PR #17902 已修复的重放历史重复计费缺陷。

- 在 `UiTelemetryService` 新增 `#sessionLiveMetrics: Map<string, SessionMetrics>` 与 `#sessionRunStartTimes: Map<string, Date>`。
- 仅在实时 `addEvent(event, sessionId)` 与 `recordSkillInvocation(skillName, success, sessionId)` 时累积到 `#sessionLiveMetrics`（`addReplayedEvent` 与 `restoreSessionModelMetrics` 绝不写入），并在该 `sessionId` 首次出现实时活动时惰性记录 `#sessionRunStartTimes`。
- 累积 `#sessionLiveMetrics` 时不传入 `sessionId` 参数（与 `#liveMetrics` 一致），避免在持久化桶内多余分配仅用于展示的 `statsModels`、`invocations` 与 `timingSamples`。
- 暴露只读方法 `getLiveMetricsForSession(sessionId): SessionMetrics | undefined` 与 `getRunStartTimeForSession(sessionId): Date | undefined`。
- 在 `snapshotForReplay`、`restoreFromReplaySnapshot`、`reset`、`resetSession` 与 `removeSession` 中完整同步维护 `#sessionLiveMetrics` 与 `#sessionRunStartTimes`。
- 在 `packages/cli/src/utils/usage-persistence.ts` 新增 `persistSessionUsageOnClose(config, sessionId)`：读取该会话的实时指标与起始时间，若 `!hasRunActivity(metrics)` 则直接跳过（保证恢复后无新活动直接关闭零写入），将 `endTime` 钳位至 `Math.max(startTime.getTime(), Date.now())`，调用 `persistSessionUsage` 写入 `runScoped: true` 记录。
- 在 `QwenAgent.removeStoredSessionEntry` 中紧邻 `uiTelemetryService.removeSession(sessionId)` 之前调用 `persistSessionUsageOnClose(session.getConfig(), sessionId)`。由于 `removeStoredSessionEntry` 入口已有 `this.sessions.get(sessionId) !== session` 幂等守卫，且紧随其后的 `removeSession` 会删除实时桶，每次会话生命周期至多落盘一次，且异常被隔离不会阻断销毁流程。

### 2. 台账口径唯一活跃会话普查

`loadTokenUsageDailyByModel` 已在内存中按天按模型维护 `sessionId` 集合（`getTokenUsageSessionIds`），`deduplicateScopedLedgers` 也保留了去重后的 per-scope 覆盖集合（`getLedgerSessionIds`），无需额外磁盘扫描。

- 在 `packages/core/src/services/usage-dashboard-service.ts` 新增并导出 `countActiveSessions(records, startKey, endKey, ledgerDaily?, runtimeScopes?)`：
  - 汇总以下两类非空 `sessionId` 的并集：
    1. `records` 中所有 `transcriptSupplement !== true` 且本地结束日 `localDateKey(record.timestamp)` 落在 `[startKey, endKey]` 内的记录；
    2. `runtimeScopes`（存在时）或 `ledgerDaily` 中 `day ∈ [startKey, endKey]` 的所有 `getLedgerSessionIds(ledger, day, model)` 条目。
  - 返回去重集合大小。
- 统一在以下位置使用 `countActiveSessions`：
  - `buildUsageDashboard` 的 `summary.sessions`（基于 `endedRecords`、`rangeStartKey`、`todayKey`、`ledgerDaily`、`runtimeScopes`）；
  - `buildDaily` 的按日 `sessions`（每日结束的非 supplement 记录 `sessionId` 与当日台账 `sessionId` 的并集大小）；
  - `loadStatsData` 的 `report.sessionCount`（窗口 `[currentStartKey, currentEndKey]`），以及 `delta.sessions` 两侧的 `currentDeltaReport.sessionCount` 与 `previousReport.sessionCount`（各自已完成本地日窗口），确保纯台账覆盖周期也能精确计算会话环比。
- 同步更新 Web Shell 全部语种（`en`、`zh-CN`、`zh-TW`、`ru`）的 `daemon.usage.dailySessionsSub` 文案为每日活跃会话数。

## 约束与不变量

- **Daemon 关闭绝不重放计费。** 恢复后无任何新实时活动的 daemon 会话关闭时零写入；有新实时请求时只写入本次实时增量。
- **台账覆盖日不再出现 `tokens > 0, sessions = 0`。** 只要窗口或某日存在带 `sessionId` 的台账记录，即使 `usage_record.jsonl` 无对应行，也至少计为 1 个活跃会话。
- **唯一会话去重与单调性。** 同一 `sessionId` 在窗口内的多次运行、同时出现在台账与 `usage_record.jsonl`、或跨多工作空间运行时，均去重计为 1 个会话。
- **Future-ended 运行保持读时钟边界。** `timestamp > now` 的未结束记录仍不计入 `endedRecords`，但当日已落台账的真实 API 请求会将其 `sessionId` 计为活跃会话。
- **台账 schema 零改动。** `token-usage-YYYY-MM.jsonl` 保持 `schemaVersion: 1`，不写入项目目录路径。

## 验收标准

1. ACP / daemon 会话在显式关闭、空闲回收或优雅停机时，若有实时活动则恰好写出 1 条 `runScoped: true` 增量记录（含 token、工具、文件、技能与执行 ID），恢复后无新活动关闭则零写入。**已验证**：通过 `uiTelemetry.test.ts`、`usage-persistence.test.ts`、`acpAgent.test.ts` 关闭接线测试以及真实 `node dist/cli.js --acp` 进程实测（`300/300` token 与台账精确一致，空闲 `session/load` 后关闭零新增写入，退出码 0）。
2. `buildUsageDashboard` 的 `summary.sessions` 与 `daily[i].sessions` 精确统计台账与已结束非 supplement 记录的唯一活跃 `sessionId`；纯台账日期返回准确会话数而非 `0`。**已验证**：通过 `usage-dashboard-service.test.ts`（96/96）与真实 `qwen serve` `/usage/dashboard` 实测（同会话两次运行去重为 `sessions: 1`；删除 `usage_record.jsonl` 与 transcript 仅留台账时返回 `sessions: 1` 及 `daily[today].sessions: 1`）。
3. `loadStatsData` 的 `report.sessionCount` 与 `delta.sessions` 采用同一唯一活跃会话普查口径，包括纯台账覆盖的环比周期。**已验证**：通过 `statsDataService.test.ts`（44/44）与 `statsDataService.history.test.ts`（10/10）。
4. Web Shell 全部语种正确渲染更新后的每日活跃会话副标题，并通过逐语种渲染测试。**已验证**：通过 `UsageDashboardTab.test.tsx`（13/13，覆盖 `en`、`zh-CN`、`zh-TW`、`ru`）。
5. 已通过 `packages/core`、`packages/cli`、`packages/web-shell` 单元测试、全仓 `npm run build`、`npm run typecheck`、`npm run bundle`、ESLint、Prettier 以及基于新鲜构建产物的本机真实进程 CLI、daemon 与 ACP 端到端验证。
