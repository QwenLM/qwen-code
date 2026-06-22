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
| Mixed types        | `Read 3 files, edited 2 files, ran 1 command` |
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

1. **Completed tool groups** always render via `CompactToolGroupDisplay` regardless of compact mode setting
2. **Individual completed tools** collapse their result output (`shouldCollapse = isCompleted && !forceShowResult`)
3. **Completed tool names** render dimmed (`isDim = status === Success`)
4. **Force-expand conditions** remain: errors, confirmations, focused shell, user-initiated, terminal subagents
5. **`compactLabel`** (LLM-generated) takes precedence over `buildToolSummary()` when available

### Key Changes

| File                          | Change                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `CompactToolGroupDisplay.tsx` | Added `buildToolSummary()`, removed border styles, removed "Press Ctrl+O" hint           |
| `ToolMessage.tsx`             | Removed `compactMode` gate from `shouldCollapse` and `isDim`                             |
| `ToolGroupMessage.tsx`        | `showCompact` now triggers for all-completed groups via `(compactMode \|\| allComplete)` |

## Alternatives Considered

1. **Keep two modes with improved summaries**: Rejected — unnecessary cognitive overhead for users
2. **Per-tool summary (Gemini CLI style)**: Each tool gets its own summary arrow. Rejected — still too verbose for large tool batches
3. **Phased rollout**: Rejected — user preference for single implementation pass
