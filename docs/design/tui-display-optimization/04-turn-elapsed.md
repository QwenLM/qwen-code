# §3.5 Per-Turn Elapsed Time

## Goal

> 回复末尾增加 `⏱ X.Xs` 耗时显示。

## Current

- 工具级 `IndividualToolCallDisplay.startTime/endTime` 已有；`ToolElapsedTime` 组件可格式化。
- **没有** turn 级时间字段。一个"turn"在当前架构等价于一个 assistant message 的 `gemini` history item 起、到下一个 user 输入前的所有 `gemini_content / tool_group / gemini_thought*` 之和。

## Design

### Where to render (v2)

独立 history item，独占一行：

```
✦ Done. Updated 3 files.
⏱ 12.4s
[Composer marginTop=1]
> _
```

> v1 的"内联到 assistant message 尾部"方案废除：独立 history item 解耦更干净，VP 路径自动支持。

### Data flow

1. 新增 history item type `turn_summary`：

```ts
type HistoryItemTurnSummary = {
  type: 'turn_summary';
  id: number;
  durationMs: number;
  // 可选：tokens? error? — 留扩展空间但本 PR 仅写 durationMs
};
```

2. `AppContainer`（或 streaming 完成处理处）在 turn 结束时计算 `Date.now() - turnStartTime` 并 `addItem({ type: 'turn_summary', durationMs })`。

3. `HistoryItemDisplay` 渲染：

```tsx
{
  itemForDisplay.type === 'turn_summary' && (
    <Box paddingLeft={2} marginTop={0}>
      <Text dimColor>⏱ {formatTurnDuration(itemForDisplay.durationMs)}</Text>
    </Box>
  );
}
```

`formatTurnDuration`：

- < 1s → `0.4s`
- < 60s → `12.4s`
- ≥ 60s → `2m 14s`

### Turn boundary detection (v2 — 含 abort / retry / interrupt 路径)

- **start**：从用户 submit prompt 那一刻（addItem `user` 时记录 turnStartMs ref）。
- **end / emit**：在 `useGeminiStream` 的 `setIsResponding(false)` 之前的统一 finally 路径中 emit `turn_summary`。具体放在 `useGeminiStream.ts` 现有 turn-end aggregation 同处。
- **abort 路径**：`cancelOngoingRequest` 走的同一 finally 也 emit，附加 `cancelled: true` 字段；渲染为 `⏱ 3.2s · cancelled`。
- **retry 路径**：retry 在同一 turn 内重试 → 不重复 emit；start time 保持原值；总耗时累计。retry 触发"新 turn"路径（>3 次或用户手动）→ 新 turn 重新计时。
- **next-submit interrupt**（用户没等完就回车下一条）：旧 turn 收到中断 → 触发 abort 同样路径 emit `⏱ X.Xs · cancelled` 后才开始新 turn。
- **error-only turn**（无 assistant 输出）：error message 之后追加 `⏱ X.Xs · failed`。

### `--verbose` interaction

- verbose=false → 显示 `⏱ 12.4s`（默认 ON）。
- verbose=true → 在 dim 行末追加 token 计数：`⏱ 12.4s · 2.3k in · 1.1k out`（如果可获取）。

### Skip cases

- 用户中断（abort）：仍显示 `⏱ 3.2s · cancelled`。
- turn 内只有 tool calls 没有 assistant text（极少）：仍 emit `turn_summary`，独占一行。
- 失败 turn（无 assistant 输出，纯 error）：error message 之后追加 `⏱ X.Xs`。

## Files touched

- `packages/cli/src/ui/types.ts` — 新 `HistoryItemTurnSummary`
- `packages/cli/src/ui/components/HistoryItemDisplay.tsx` — 新分支
- `packages/cli/src/ui/AppContainer.tsx` 或 `packages/cli/src/ui/hooks/useGeminiStream.ts` — emit
- `packages/cli/src/ui/utils/formatters.ts`（或新增 `formatTurnDuration`）
- i18n: 文案极少（`cancelled` 已有）

## Risk

- **VP 路径不需要特殊处理**，因为 `turn_summary` 走 `HistoryItemDisplay` 的统一分支，VP 复用同一组件。
- **历史 jsonl 没有 turn_summary**：resume 时不会有；不影响。我们**不**把这字段写进 jsonl（UI-only），避免破坏 schema。
- **快速 turn (< 0.1s)**：仍显示 `0.1s`，**不过滤**（与 CC/Codex 一致）。
- **新 HistoryItem type audit**：需检查所有 `switch(item.type)` 处的 default fallthrough：
  - `historyUtils.ts` switch — 新增 `turn_summary` case 或确认 default 安全
  - `mergeCompactToolGroups.ts:122` `isHiddenInCompactMode` — `turn_summary` 不在 hidden set，**不会被合并/丢弃**（pass-through）
  - `resumeHistoryUtils.ts` switch — pass-through (UI-only，resume 时不期望出现)
  - 任何 history 序列化点 — 跳过 `turn_summary` 不写 jsonl
