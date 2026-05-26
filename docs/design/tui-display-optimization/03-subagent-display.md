# §3.4 SubAgent Display

## Goal

> SubAgent 总标题加合适的"品牌 Icon"，信息结构标题参考 gemini-cli 的友好格式（如"子任务：修复测试用例 → 结果：3/5 通过"）。
> 视觉上更结构化、状态一目了然。

> **范围说明**：本节 _不_ 引入新的品牌 Icon 图形（用户要求暂不做品牌）。我们引入一个**统一 SubAgent 符号家族** `≡ / ! / ✓ / ✗ / ℹ` 直接对齐 gemini-cli `SubagentGroupDisplay.tsx:229-243` 实际硬编码，作为信息结构改造的载体；后续品牌升级 PR 可以替换具体 glyph 而不动结构。

## Current baseline

| 路径                                                  | 现状                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| `LiveAgentPanel.tsx`                                  | composer 上方实时活体面板，状态符号 `○ ⏸ ✔ ✖`，最多 5 行          |
| `ToolMessage.tsx:281-350` `SubagentExecutionRenderer` | 决定 pending / queued / terminal 三种渲染                            |
| `ToolMessage.tsx:360-417` `SubagentScrollbackSummary` | 终态单行：`✔ researcher: investigate · 5 tools · 12s · 2.4k tokens` |
| `ToolGroupMessage.tsx:21-92`                          | 多个 subagent 谓词；终态/pending/running 路由                        |

## New design

### A. Group-level aggregation (v2)

当一个 `tool_group` 包含 **≥2** 个子代理 entry（即并行 spawn 的多个子任务），不再逐个 SubagentScrollbackSummary。而是 emit 一个聚合 group header（**gemini-cli 真实文案**）：

```
≡ 4 Agents (3 completed, 1 failed)
  ✓ researcher: investigate import order       · 5 tools · 12s · 2.4k tok
  ✓ planner:    sketch refactor                · 3 tools · 4s  · 0.8k tok
  ✓ writer:     update docs                    · 2 tools · 2s  · 0.3k tok
  ✗ tester:     run regression                 · 8 tools · 31s · failure: timeout
```

Header 文案规则（对照 `gemini-cli/SubagentGroupDisplay.tsx:100-108`）：

- 全 completed → `"N Agents Completed"`
- 混合 → `"N Agents (X running, Y completed)..."`（仅出 running 与 completed；failed/cancelled 用同样的 X/Y 列出，从 gemini 行为延伸；本 PR 完整版含 failed 计数）
- 全 running → `"Running N Agents..."`

> qwen 选择"完整版"含 failed 是因为终态报告价值高；这是本地强化，文档明示。

单个 subagent（最常见 — qwen 自创结构化布局，灵感来自用户提示的"子任务→结果"二段式）：

```
≡ Agent · researcher · investigate import order
  ✓ 5 tools · 12s · 2.4k tok
```

> 文档明示：单 agent 两行结构来自用户提示的"子任务：XXX → 结果：Y/Z 通过"灵感，**非** gemini-cli 真实格式（gemini 实际是单行 `"Subagent X completed."`，见 `SubagentProgressDisplay.tsx:66-78`）。我们选择两行，因为终端等宽渲染下两行更紧凑可读。

### B. Live panel polish (v2)

`LiveAgentPanel` 顶部新增聚合行（仅在 ≥2 active agents 时；单个时直接显示 row 与现状一致）：

```
≡ 3 Agents (2 running, 1 paused)
  ! researcher  · investigating
  ! planner     · sketching
  ⏸ writer      · waiting on confirmation
```

> live panel 保留 `⏸ paused`（这是 panel 上下文，与 scrollback summary 上下文不同 — panel 反映运行时状态，paused 在运行中有意义）。

### C. Glyphs (v2 — aligned to gemini-cli actual usage)

```
≡   group header   (theme.text.accent)
!   running        (theme.text.primary)
✓   completed      (theme.status.success)
✗   failed         (theme.status.error)
ℹ   cancelled      (theme.status.warning)
```

实际引用：`/Users/gawain/Documents/codebase/opensource/gemini-cli/packages/cli/src/ui/components/messages/SubagentGroupDisplay.tsx:229-243` (硬编码 glyph)。**不是** `constants.ts:21-26`（那是 TOOL_STATUS）。

> 不保留 `⏸ paused`：gemini-cli 无此状态；qwen 的 `paused` 在 LiveAgentPanel 仍保留 `⏸`（panel 是另一上下文）。SubAgent **scrollback summary** 终态只 emit completed/failed/cancelled，无 paused。

新文件 `packages/cli/src/ui/constants/subagentGlyphs.ts` 统一定义，附 Windows fallback (`>`, `!`, `+`, `x`, `i`)。

### D. Stats line format

```
<glyph> <name>: <description> · <N tools> · <Hs Ms.Ms> · <K.k tok>[ · <reason>]
```

- name bold; description secondary; trailing stats secondary, 用 `·` 分隔。
- 当 description 缺失（task spawn 无描述）时退化为 `<glyph> <name>` 一行。
- failure reason 仅在非 completed 状态显示，截断到 60 char。

## Implementation outline

### A. New components

```
packages/cli/src/ui/components/messages/SubagentSummary.tsx     ← 单个 subagent 完整行
packages/cli/src/ui/components/messages/SubagentGroupSummary.tsx ← 聚合 header + rows
packages/cli/src/ui/constants/subagentGlyphs.ts                 ← 符号表
```

### B. ToolGroupMessage 路由

新增预处理：

```ts
const subagentTools = inlineToolCalls.filter(isSubagentToolEntry);
const nonSubagentTools = inlineToolCalls.filter(t => !isSubagentToolEntry(t));

if (subagentTools.length >= 2) {
  return (
    <>
      <SubagentGroupSummary tools={subagentTools} />
      {nonSubagentTools.length > 0 && /* render non-subagent rows */}
    </>
  );
}
// 1 subagent → SubagentSummary instead of inline SubagentScrollbackSummary
```

### C. LiveAgentPanel

读取已有的 `BackgroundTaskViewContext`，仅在 ≥2 个活体 entry 时增加聚合 header；行渲染保持不变（已经够好）。

### D. 删除 / 收敛旧路径

- `SubagentScrollbackSummary` 内部逻辑搬到 `SubagentSummary`；`ToolMessage.tsx` 的内联调用统一替换。
- `SubagentExecutionRenderer` 中 `pendingConfirmation` / `queued` 分支保留（与 group summary 互不冲突）。

## i18n keys

```
ui.subagent.groupCompleted       "{n} Agents Completed"
ui.subagent.groupMixed           "{n} Agents ({states})"
ui.subagent.stateRunning         "{n} running"
ui.subagent.stateCompleted       "{n} completed"
ui.subagent.stateFailed          "{n} failed"
ui.subagent.statsTools           "{n} tools"
ui.subagent.statsTokens          "{k} tokens"
ui.subagent.singleAgent          "Agent"
ui.subagent.completedLine        "Completed"
ui.subagent.failedLine           "Failed"
ui.subagent.cancelledLine        "Cancelled"
ui.subagent.runningLine          "Running"
```

zh + en 同步。

## Risk

- **Force-expand 仍要保留**：当任何一个 subagent 有 `pendingConfirmation` 时，组不可 collapse 成单行 group header —— 仍走 §3.3 普通 tool 列表展开（confirm UI 必须可点）。预处理判断写在 `isForceExpandGroup`（已存在，复用即可）。
- **`SubagentScrollbackSummary` 在 transcript jsonl-replay 中的依赖**：检查测试 `mergeCompactToolGroups.test.ts`，确保 `isForceExpandGroup` 对 terminal subagent 的判定不破坏（应当不变）。

## Files touched

- 新：`SubagentSummary.tsx`, `SubagentGroupSummary.tsx`, `subagentGlyphs.ts`
- 改：`ToolGroupMessage.tsx`（subagent 路由）
- 改：`LiveAgentPanel.tsx`（≥2 聚合 header）
- 改：`ToolMessage.tsx`（删除 `SubagentScrollbackSummary` 或替换 import）
- 改：i18n `en.js`, `zh.js`
