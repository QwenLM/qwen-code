# Tool-result Markdown height budgets

[English](toolresult-markdown-height.md) | [简体中文](toolresult-markdown-height.zh-CN.md)

## Problem and scope

ToolMessage previously disabled Markdown whenever a terminal-height budget was
present. Even short question answers consequently displayed literal bold markers.
Restore formatting without removing height constraints or changing tool execution.
This is a CLI-only bugfix; no core, configuration, dependency, or protocol changes.

## Design

- Keep capped shell output on the existing tail-preserving plain-text path.
  Explicit plain text and sanitized raw-file details remain plain text.
- Enable MarkdownDisplay's existing enforceHeightBudget path for string tool
  results. Register actual truncation with OverflowContext so expandable results
  retain the show-more hint; clear registrations on expansion or unmount.
- Use Ink's word-aware wrap-ansi options for height accounting. Include list
  indentation/markers and fenced-code padding, numbered gutters, and tab expansion.
- Reuse the table renderer's pure renderTableText layout function instead of a
  separate approximate column-width algorithm. Budgeting and rendering share
  horizontal/vertical layout decisions, including the streaming frontier anchor.
  Bounded table text is wrapped before counting/clipping rows. Table margins and
  truncation cues are reserved separately; a cue occupies at most one row.
- Do not mark complete results as streaming to obtain clipping. Callers without
  a budget retain full rendering. Overflow registration is opt-in for tool results.

## Constraints and risks

The shared estimator also serves live assistant output, so its existing streaming
and source-splitting tests must remain green. Exact table layout does more work
than approximate accounting, but removes divergent layout rules and uses installed
helpers only. Source pre-slicing may omit an entire oversized line or table after
preceding text; the visible cue and expansion path must disclose missing content.

## Validation and acceptance

- Reproduce literal **Color** using global qwen in an interactive terminal, then
  verify bold terminal cells without delimiters using the local bundled CLI.
- Use real Markdown rendering inside actual width-constrained Ink containers.
  Assert frame heights and overflow lifecycle for paragraphs, word wrapping,
  Chinese, lists, code gutters/tabs, narrow/long/asymmetric tables, and expansion.
- Preserve shell caps, explicit plain text, and raw-file detail through regression
  tests. Run related tool, Markdown, table, estimator, MaxSizedBox, and streaming
  tests, plus build, bundle, typecheck, lint, and formatting checks.
- Distinguish component coverage from interactive E2E evidence; short-result
  Ctrl+S checks do not prove expansion of a long result.
