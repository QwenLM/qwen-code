# §3.1 Thinking Display

## Goal

> 默认隐藏思考过程，仅通过 `--verbose` 或快捷键按需开启。  
> （Ctrl+O 已被语义重写，不再做"显示思考"开关 — 思考完整内容在 Ctrl+O 的"详情视图"中始终可见。）

## Current state (baseline)

- `HistoryItem.type === 'gemini_thought' | 'gemini_thought_content'`，由 `ThinkMessage` / `ThinkMessageContent` 渲染，前缀 `✦`，secondary 色。
- `HistoryItemDisplay.tsx:155, 165` 把整组渲染包在 `!compactMode &&` 里 —— 即"compact 模式 = 完全不渲染"。
- `compactMode` 默认 `false`，所以**目前默认是显示思考的**（提案痛点）。
- `compactMode` setting `description: 'Hide tool output and thinking for a cleaner view (toggle with Ctrl+O).'`（耦合了两个能力）。

## New behaviour (v2)

**Default UX:**

1. 思考事件**仍然进入 history**（保持现有 `gemini_thought` / `gemini_thought_content` 入流逻辑不变），但 `HistoryItemDisplay` 在 `verbose=false` 时不渲染它们。
   - 关键原因：Ctrl+O transcript overlay 只 slice `history` 数组，如果 thoughts 不入 history，transcript 也看不到，会与 §3.7 "transcript 始终显示完整思考"冲突。让 thoughts 入 history + 渲染层 gate 是唯一一致的做法。
2. 与 CC 风格对齐：streaming 期间在 composer 上方显示一行 `✻ Thinking… (4.2s) · Ctrl+O for details`。
3. 完成后历史中的 thoughts items 仍存在（透明给 jsonl resume），只是默认不渲染。

> Note on CC reference accuracy: CC 实际正常思考用 `∴ Thinking <CtrlOToExpand />`（`AssistantThinkingMessage.tsx:44`），redacted 思考用 `✻ Thinking…`（`AssistantRedactedThinkingMessage.tsx:16`）。我们选 `✻ + 秒数 + Ctrl+O hint` 是混合本地化：`✻` 在 monospace 终端比 `∴` 视觉更稳定；加秒数对长思考体验更友好；Ctrl+O hint 类比 CC 的 `<CtrlOToExpand />`。

**`--verbose` UX:**

- 当 `ui.verbose === true` 时，恢复完整渲染（与目前 `compactMode=false` 等价）。
- 同时提供 `/verbose on|off|toggle` slash command（已能复用 settings 写入路径），保证不需要 Ctrl+O 也能开启。

**Ctrl+O transcript UX (详见 §3.7):**

- transcript 详情视图无论 `verbose` 是 true / false 都**始终显示完整思考链**（这就是 Ctrl+O 在 CC 中的核心价值）。

## Implementation outline

### A. Source-side: 不改动入 history 逻辑

`gemini_thought` / `gemini_thought_content` 入 history 的现有代码**保持不动**。Gating 全部下放到渲染层（§C）。这保证：

- jsonl resume 兼容
- transcript overlay 能看完整 thoughts
- `mergeCompactToolGroups.isHiddenInCompactMode` 已有的语义不被破坏

### B. Live thinking pulse

在 composer 之上（与 LiveAgentPanel 同区），渲染 `ThinkingPulse`：

```
✻ Thinking… (4.2s) · Ctrl+O for details
```

实现要点（**不**引入新事件总线）：

```ts
// packages/cli/src/ui/hooks/useThinkingPulse.ts
export function useThinkingPulse() {
  const { history, pendingHistoryItems, streamingState } = useUIState();
  const verbose = useEffectiveVerbose();

  // 当 verbose=true 时不显示 pulse（thoughts 已直接渲染）
  if (verbose) return null;

  // 检查是否处于"思考中"状态：streamingState 在 responding 阶段
  // 且最后一个 pending item 是 thought 类型
  const last = pendingHistoryItems.at(-1);
  const isThinking =
    streamingState === StreamingState.Responding &&
    (last?.type === 'gemini_thought' ||
      last?.type === 'gemini_thought_content');

  // 计时：last thought 出现的最早时间戳，组件挂载时刻或 ref tracking
  // ...
  return { active: isThinking, elapsedMs };
}
```

> 不需要 `appEvents.thinking_chunk` 等事件（这些事件不存在；review 已捕获 v1 的错误假设）。所有状态都从 `useUIState()` + `pendingHistoryItems` 派生。

### C. HistoryItemDisplay 渲染分支

```tsx
{verbose && itemForDisplay.type === 'gemini_thought' && (
  <ThinkMessage ... />
)}
{verbose && itemForDisplay.type === 'gemini_thought_content' && (
  <ThinkMessageContent ... />
)}
```

`compactMode` 整体下线（详见 §3.7 + 07-verbose-and-settings）。

### D. Transcript overlay 中的强制显示

§3.7 transcript overlay 渲染时，强制传入 `verbose=true` 给 `HistoryItemDisplay`（通过新的 `forceVerbose` prop 或 transcript-scope 的 `CompactModeContext.Provider` 等价）—— 保证"按下 Ctrl+O 后能看到当时的思考过程"。

## Edge cases (v2)

- **Thinking 发生在 streaming text 中间**：thoughts 与 text chunks 都入 history；pulse 仅在最后一个 pending item 为 thought 时为 active。text chunk 到达后 pulse 立刻 inactive。
- **Thinking-only turn**：完成后无 text/tool，仍 emit `turn_summary`（§3.5）独占一行。
- **resume 老会话**：history 里有的 thoughts 默认不渲染，verbose 或 transcript 时可见。完全一致。
- **运行中 `/verbose on/off`**：渲染层即时切换；老 thoughts 一致显示/隐藏；transcript 视图不受影响。

## Files touched (v2)

- `packages/cli/src/ui/components/HistoryItemDisplay.tsx` — `!compactMode` → `verbose` (语义反转)
- `packages/cli/src/ui/contexts/DisplayModeContext.tsx` — **新**（详见 07）
- `packages/cli/src/ui/hooks/useThinkingPulse.ts` — **新**（state-derived，无新事件总线）
- `packages/cli/src/ui/components/ThinkingPulse.tsx` — **新**
- Composer 父级容器 — 挂载 `<ThinkingPulse />`
- i18n: `ui.thinkingPulse` ("Thinking…"), `ui.thinkingPulseHint` ("Ctrl+O for details")

> **不**改动 AppContainer 思考事件入历史逻辑。
