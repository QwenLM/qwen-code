# Unified Tool Output Rendering

## Background

The TUI previously had two rendering modes for tool results:

- **Compact mode** (Ctrl+O): collapsed completed tool results into a one-line summary
- **Normal mode**: showed full tool results inline, causing excessive vertical noise

Users had to manually toggle between modes. Most of the time, completed tool results (file contents, search results, etc.) added no value to the conversation flow.

## Design

### Core Principle

**One unified mode**: tool rendering is determined by tool category, not by a user-toggled mode. Information-gathering tools (read/search/list) are collapsed into a summary; mutation tools (edit/write/command/agent) always render individually with full results.

### Semantic Summary (`buildToolSummary`)

Instead of showing raw tool names and counts (`ReadFile x 3`), generate human-readable summaries using a count-based format:

| Scenario           | Output                                        |
| ------------------ | --------------------------------------------- |
| Single tool        | `Read 1 file` / `Ran 1 command`               |
| Multiple same-type | `Read 3 files`                                |
| Mixed types        | `Ran 1 command, read 3 files, edited 2 files` |
| Active (executing) | `Reading 1 file` (present progressive)        |
| Completed          | `Read 1 file` (past tense)                    |

### Tool Categories

| Category | Display Names                | Past Verb | Active Verb | Collapsible |
| -------- | ---------------------------- | --------- | ----------- | ----------- |
| read     | ReadFile, Read File(s)       | Read      | Reading     | Yes         |
| edit     | Edit, NotebookEdit           | Edited    | Editing     | No          |
| write    | WriteFile                    | Wrote     | Writing     | No          |
| search   | Grep, Glob                   | Searched  | Searching   | Yes         |
| list     | ListFiles, Read Directory    | Listed    | Listing     | Yes         |
| command  | Shell                        | Ran       | Running     | No          |
| agent    | Agent, Workflow, SendMessage | Ran       | Running     | No          |
| other    | (everything else)            | Used      | Using       | No          |

### Rendering Rules

1. **Type-based partition**: tools are split by `isCollapsibleTool()` — collapsible tools (read/search/list) render as a `CompactToolGroupDisplay` summary line; non-collapsible tools (edit/write/command/agent/other) render individually via `ToolMessage`
2. **Memory-only groups** have a dedicated rendering path (read/write counts badge) that takes priority, but only when all ops succeed (`!hasErrorTool && every status === Success`)
3. **Result collapse**: only collapsible tools with `Success` status have their text/ANSI output collapsed. Non-collapsible tools (including MCP tools, WebFetch, etc.) always show results. Canceled tools keep partial output visible
4. **Tool names** render bold regardless of status, providing consistent styling across both `CompactToolGroupDisplay` and individual `ToolMessage` paths
5. **Force-expand conditions**: when any tool in a group is confirming, errored, user-initiated, in a focused shell, or a terminal subagent, ALL tools render individually (no partition) with results forced visible only for the triggering tools (errored, confirming, terminal subagent) — successful siblings keep normal collapse behavior
6. **`tool_use_summary`** items (LLM-generated semantic summaries) render unconditionally alongside `CompactToolGroupDisplay`'s mechanical count — they serve different purposes (semantic context vs tool count)
7. **Memory badge**: rendered in both the all-collapsible path and the mixed path when memory ops are present in a non-memory-only group

### Key Changes

| File                          | Change                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CompactToolGroupDisplay.tsx` | Added `buildToolSummary()` with count format, `isCollapsibleTool()`, removed border styles                                                        |
| `ToolMessage.tsx`             | `shouldCollapseResult` gated on `isCollapsibleTool()` and `Success` only; `isDim` removed                                                         |
| `ToolGroupMessage.tsx`        | Type-based partition replaces `showCompact`; `forceShowResult` simplified to `forceExpandAll`; height budget accounts for collapsible summary row |
| `MainContent.tsx`             | Removed `mergedHistory` alias, `absorbedCallIds`, `summaryByCallId`, cross-group merging                                                          |
| `HistoryItemDisplay.tsx`      | `tool_use_summary` renders unconditionally (removed `summaryAbsorbed` gate)                                                                       |
| `mergeCompactToolGroups.ts`   | `compactToggleHasVisualEffect` no longer triggers on `tool_group` (compact mode has no effect on tool rendering)                                  |

## Alternatives Considered

1. **Keep two modes with improved summaries**: Rejected — unnecessary cognitive overhead for users
2. **Per-tool summary (Gemini CLI style)**: Each tool gets its own summary arrow. Rejected — still too verbose for large tool batches
3. **Phased rollout**: Rejected — user preference for single implementation pass
