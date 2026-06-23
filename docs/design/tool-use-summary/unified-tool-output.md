# Unified Tool Output Rendering

## Background

The TUI previously had two rendering modes for tool results:

- **Compact mode** (Ctrl+O): collapsed completed tool results into a one-line summary
- **Normal mode**: showed full tool results inline, causing excessive vertical noise

Users had to manually toggle between modes. Most of the time, completed tool results (file contents, search results, etc.) added no value to the conversation flow.

## Design

### Core Principle

**One unified mode**: completed tools always show a semantic overview line. No mode switching needed.

### Semantic Summary (`buildToolSummary`)

Instead of showing raw tool names and counts (`ReadFile x 3`), generate human-readable summaries:

| Scenario           | Output                                        |
| ------------------ | --------------------------------------------- |
| Single tool        | `Read package.json` / `Ran npm test`          |
| Multiple same-type | `Read 3 files`                                |
| Mixed types        | `Ran 1 command, read 3 files, edited 2 files` |
| Active (executing) | `Reading package.json` (present progressive)  |
| Completed          | `Read package.json` (past tense)              |
| Error/Canceled     | `Read package.json` (past tense)              |

### Tool Categories

| Category | Display Names                | Past Verb | Active Verb |
| -------- | ---------------------------- | --------- | ----------- |
| read     | ReadFile                     | Read      | Reading     |
| edit     | Edit, NotebookEdit           | Edited    | Editing     |
| write    | WriteFile                    | Wrote     | Writing     |
| search   | Grep, Glob                   | Searched  | Searching   |
| list     | ListFiles                    | Listed    | Listing     |
| command  | Shell                        | Ran       | Running     |
| agent    | Agent, Workflow, SendMessage | Ran       | Running     |
| other    | (everything else)            | Used      | Using       |

### Rendering Rules

1. **Completed tool groups** (`allComplete`: every tool is Success, Error, or Canceled) always render via `CompactToolGroupDisplay` regardless of compact mode setting
2. **Memory-only groups** have a dedicated rendering path that takes priority over `showCompact`
3. **Individual completed tools** collapse their result output (`shouldCollapse = isCompleted && !forceShowResult`)
4. **Completed tool names** render dimmed (`isDim = status === Success`)
5. **Force-expand conditions** remain: errors, confirmations, focused shell, user-initiated, terminal subagents
6. **`compactLabel`** (LLM-generated) takes precedence over `buildToolSummary()` when available
7. **Summary absorption**: `tool_use_summary` items are suppressed when their sibling `tool_group` renders via `CompactToolGroupDisplay` (prevents duplicate display)

### Key Changes

| File                          | Change                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `CompactToolGroupDisplay.tsx` | Added `buildToolSummary()`, removed border styles, removed "Press Ctrl+O" hint             |
| `ToolMessage.tsx`             | Removed `compactMode` gate from `shouldCollapse` and `isDim`                               |
| `ToolGroupMessage.tsx`        | `showCompact` now triggers for all-completed groups via `(compactMode \|\| allComplete)`   |
| `MainContent.tsx`             | `absorbedCallIds` now tracks completed groups in non-compact mode                          |
| `HistoryItemDisplay.tsx`      | `tool_use_summary` rendering gated only on `summaryAbsorbed` (removed `compactMode` guard) |

## Alternatives Considered

1. **Keep two modes with improved summaries**: Rejected — unnecessary cognitive overhead for users
2. **Per-tool summary (Gemini CLI style)**: Each tool gets its own summary arrow. Rejected — still too verbose for large tool batches
3. **Phased rollout**: Rejected — user preference for single implementation pass
