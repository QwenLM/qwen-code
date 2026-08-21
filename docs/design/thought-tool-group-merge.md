# Merge completed read/search tool batches into the thought line

## Problem

When the model thinks and then calls tools, the TUI renders a collapsed
thought line (`∴ Thought for 5s (ctrl+o to expand)`) followed by the tool
batch. The vertical spacing below the thought line is inconsistent because it
is owned by the _next_ history item's `marginTop`
(`getHistoryItemMarginTop` in `HistoryItemDisplay.tsx`): a fresh `gemini`
assistant block adds a blank line, while `tool_group` / `gemini_content` sit
tight against it. The same "Thought for …" line therefore sometimes has a gap
below it and sometimes not.

Claude Code solves this differently: information-gathering batches that follow
thinking collapse into the thought line itself once they finish —
`Thought for 9s, searched for 2 patterns (ctrl+o to expand)` — while the tools
render normally while they run. This removes the spacing inconsistency for the
dominant case (think → read/search) and keeps scrollback dense.

## Current state

Live turn flow (`useGeminiStream.ts`):

1. Streamed reasoning lives in `pendingThoughtItem` (dynamic area).
2. On the first `ToolCallRequest`, `commitPendingThought` commits the thought
   to history → Ink `<Static>` → **frozen, can never be re-rendered**.
3. Tools execute; the live group is `pendingToolCallGroupDisplay` (dynamic).
4. When the batch completes, the scheduler's `onComplete` commits the finished
   `tool_group` via `addItem` → also frozen.

Because step 2 freezes the thought line before step 4 knows whether the batch
is mergeable, the merge must be decided **at commit time**, which requires
deferring the thought commit.

Rendering facts that shape the design:

- Both the `<Static>` path and the virtual-viewport (VP) path render items
  one-by-one through `HistoryItemDisplay`; VP additionally assumes one data
  entry = one visual row. Cross-item render-time merging is therefore not
  viable; the merge must be expressed on the committed items themselves.
- Interactive resume (`resumeHistoryUtils`) deliberately does **not**
  reintroduce thought rows, so no resume-path merging is needed. Only the
  standalone picker preview emits them (thoughts expanded, no merge).
- `tool_group` items committed by the scheduler are adjacent to the thought
  by timing, not structure. The merge does not need to validate adjacency:
  `onComplete` commits the thought and the group back-to-back, so nothing
  can land between them. Items committed asynchronously while the batch runs
  (e.g. a `memory_saved` notification) may land above the merged line —
  harmless, and consistent with them landing above today's separate lines.
- Existing building blocks: `isCollapsibleTool` / `buildToolSummary`
  (`CompactToolGroupDisplay.tsx`) already classify read/search/list tools and
  phrase summaries ("Searched 2 patterns", "Read a.ts, b.ts"); the
  `HistoryItemBase.display` bag is the established home for display-only
  flags; `isHistoryItemVisibleAfterRestore` is the precedent for filtering
  committed items out of the rendered list.

## Proposed change

### 1. Defer the thought commit across tool execution

In the `ToolCallRequest` handler, when the pending thought is a single
`gemini_thought` head (not a `gemini_thought_content` tail of a split
oversized thought), do not commit it. Instead mark a merge deferral active,
freeze the thought's duration on the pending item, and flag the item
`finalized: true` so the dynamic area renders the completed style
(`∴ Thought for 5s`, therefore-icon, no live "Thinking…" tick) while tools run
below it.

`commitPendingThought` becomes deferral-aware: while a deferral is active it
is a no-op, so the existing blanket calls (stream `finally`, Finished,
thought→content transition) keep the thought pending until the deferral is
resolved.

### 2. Resolve the deferral at batch completion

In the scheduler `onComplete` callback (where the finished `tool_group` is
committed), evaluate the merge predicate:

- deferral active and `pendingThoughtItem` is still a `gemini_thought` head;
- every tool in the batch is collapsible (`isCollapsibleTool`), has status
  Success, and carries no inline images / omitted-image overflow;
- no managed-memory ops in the batch (their "Recalled/Wrote N memories" badge
  would be swallowed);
- nothing interleaved (the pending thought was never committed, which is the
  only way another item could have landed between it and the batch).

If the predicate holds:

- commit the thought item with a new `toolSummary` field holding
  `buildToolSummary(tools, isActive=false)`;
- commit the `tool_group` item as usual, plus the display-only flag
  `display.mergedIntoThought = true`.

Otherwise (error/cancel/partial batch, edit/shell/agent tools, deferral absent
e.g. oversized-thought tail): commit the thought normally, then the group —
today's behavior.

The deferral must also resolve safely on every non-completion exit:
user cancel, stream error, non-continuation retry, model fallback (commit the
thought normally), and the post-loop scheduling decision when no executable
tools were scheduled at all (e.g. duplicate-suppressed batch).

### 3. Render the merged line

`ThinkMessage` (ConversationMessages.tsx) gains `toolSummary?: string`:
collapsed and expanded labels append `, <summary>` (leading letter lowercased,
mirroring `buildToolSummary`'s own multi-category join):

```
∴ Thought for 9s, searched 2 patterns (ctrl+o to expand)
```

`HistoryItemDisplay` renders nothing for a `tool_group` with
`display.mergedIntoThought` unless `fullDetail` is on. To keep VP height
accounting clean, `MainContent` filters merged-away groups out of the rendered
list (same place it applies `isHistoryItemVisibleAfterRestore`), except in
full detail. There is no separate transcript snapshot: Ctrl+O toggles
`fullDetail` and remounts `<Static>`, re-running the same filter.

Full-detail (Ctrl+O) therefore shows everything: the thought expanded plus the
tool group rendered with forced expansion/results. Clicking the merged line
expands the thought body in place (per-item expansion); the global Ctrl+O /
Alt+T toggle is one and the same full-detail switch (both keys are bound to
`Command.TOGGLE_THINKING_EXPANDED`), so it opens full detail and re-admits the
merged-away tool group too — consistent with the existing philosophy that
read/search/list results are disposable (the same partition that already
collapses them into a summary line today).

### 4. Data model

| Item                       | Change                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `HistoryItemGeminiThought` | + `toolSummary?: string`, + `finalized?: boolean` (pending-phase completed styling)               |
| `HistoryItemToolGroup`     | display flag `display.mergedIntoThought?: boolean` via the existing `HistoryItemBase.display` bag |

Both fields are additive and display-only; history semantics, session
persistence (model parts), SDK stream messages, and `/export` are unchanged.

## Files affected

| Area                | Files                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stream/commit logic | `packages/cli/src/ui/hooks/useGeminiStream.ts` (ToolCallRequest handler, `commitPendingThought`, scheduler `onComplete`, `cancelOngoingRequest`, and the error/retry/fallback/new-prompt resolve points)                   |
| Types               | `packages/cli/src/ui/types.ts`                                                                                                                                                                                             |
| Rendering           | `packages/cli/src/ui/components/messages/ConversationMessages.tsx` (`ThinkMessage`), `packages/cli/src/ui/components/HistoryItemDisplay.tsx` (suppressed group), `packages/cli/src/ui/components/MainContent.tsx` (filter) |
| Tests               | `useGeminiStream.test.tsx` (commit-timing assertions change), `ConversationMessages.test.tsx`, `HistoryItemDisplay.test.tsx`                                                                                               |

## Scope boundaries

- In scope: the main conversation, live turns only (commit-time merge).
- Out of scope (documented follow-ups):
  - subagent chat view (`agentHistoryAdapter`) — has the same adjacency but a
    separate rendering surface;
  - merging batches that contain edit/command/agent tools (those stay
    expanded, as in Claude Code);
  - merging across multiple consecutive batches in one thought (only the batch
    immediately resolved with the deferred thought merges; later batches
    render as today);
  - the residual spacing difference between a collapsed thought followed by a
    non-mergeable tool group (tight) vs. followed by text (blank line). After
    this change the dominant read/search case is merged; the remaining cases
    match Claude Code's tight tool rendering.

## Key risks

- `useGeminiStream` commit ordering is subtle; every path that commits or
  discards pending state must resolve the deferral. Mitigation: deferral is a
  single ref checked by `commitPendingThought`; resolution is centralized in
  onComplete plus a small set of explicit fallback commits, each covered by a
  unit test.
- Existing unit tests assert the thought commits at tool-call start; those
  assertions move to batch completion (or normal commit for non-mergeable
  batches).
- The deferred thought renders in the dynamic area during tool execution (one
  extra line re-rendered per tick) — negligible; tool groups already do this.

## Open questions

None blocking. Label phrasing uses the existing `buildToolSummary` output
(English verbs by precedent); locale behavior matches today's compact tool
summaries.
