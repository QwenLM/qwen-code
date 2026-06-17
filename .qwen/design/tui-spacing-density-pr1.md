# TUI Spacing And Density PR1

## Why

The current TUI often spends extra rows on spacing before assistant output,
between status/tool blocks, and inside expanded tool groups. In common
sessions this makes simple answers, file lists, tool output, error states,
diffs, and long streaming output harder to scan because users need to scroll
through blank space rather than content.

This PR is the first focused pass for QwenLM/qwen-code#4588. It addresses only
spacing and density so the review can compare row usage before and after
without also reviewing thinking visibility, tool borders, SubAgent layout,
branding, or theme color changes.

## How

The implementation keeps the existing information structure and rendering
surfaces intact:

- History item spacing is centralized near `HistoryItemDisplay`. User prompts
  and standalone command views still start with a turn separator, while
  assistant continuations, tool groups, status messages, tool summaries, and
  related in-turn output no longer add an extra leading spacer row.
- Expanded tool groups keep their current border and status/title structure,
  but no longer insert blank rows between adjacent tool entries.
- Tool results render directly below the tool title/status row. This removes
  the extra blank line between the tool header and its output without changing
  output content, truncation, shell focus, confirmation prompts, or compact
  mode behavior.

Markdown blank-line behavior is intentionally left unchanged. The renderer
already collapses consecutive blank lines to one spacer and preserves complex
blocks such as tables, code blocks, and math blocks.

## Spacing Standard

- Independent user turns keep one visual separator.
- Assistant output and in-turn follow-up blocks do not add a second separator.
- Tool header and tool result content are adjacent.
- Expanded multi-tool groups do not insert blank rows between each tool entry.
- Complex Markdown blocks keep their existing internal layout.

## Expected Effect

Under the same terminal width and same rendered content, target scenarios should
use fewer visible rows:

- Simple Q&A should drop at least one visible row.
- Expanded tool output should drop at least one row for each rendered tool
  result that previously had a blank header/result spacer.
- Multi-tool groups should drop one row between each adjacent tool entry.
- Project inspection, diff, file-list, error, and long-stream scenarios should
  not gain rows unless terminal wrapping changes make that unavoidable.

## Measurement

The automated spacing assertions and terminal evidence use 100-column fixtures
for the changed rules:

| Scenario | Width | Baseline rows | PR1 rows | Delta | Evidence |
| --- | ---: | ---: | ---: | ---: | --- |
| Simple assistant reply | 100 | 2 | 1 | -1 | leading history spacer removed |
| Tool header with one-line result | 100 | 3 | 2 | -1 | header and result are adjacent |
| Three-tool expanded group with rendered results | 100 | 16 | 11 | -5 | one header/result spacer removed per tool result and one inter-tool separator removed between adjacent tools |
| Full representative fixture | 100 | 26 | 19 | -7 | same rendered content captured in tmux |

The snapshot diffs also cover the existing 80-column fixtures to confirm the
same row-count deltas in the current component test harness.

## Out Of Scope

- Hiding thinking traces.
- Removing tool borders.
- Redesigning SubAgent output.
- Changing startup branding or the banner.
- Changing theme colors.
- Adding per-turn assistant elapsed time.
- Changing table inline-code highlighting.
