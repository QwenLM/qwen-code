# Tool-result Markdown height budgets

[English](toolresult-markdown-height.md) | [简体中文](toolresult-markdown-height.zh-CN.md)

## Problem and scope

ToolMessage previously disabled Markdown whenever a terminal-height budget was
present. Even short question answers consequently displayed literal bold markers.
Restore formatting without removing height constraints or changing tool execution.
This is a CLI-only bugfix; no core, configuration, dependency, or protocol changes.

## Design

- Shell output defaults to plain text, even when force-shown, focused, or
  uncapped. Explicit Markdown is honored only when the shell cap is inactive.
  Explicit plain text and sanitized raw-file details remain plain text.
- Render completed string results as Markdown only when their full rendered
  height fits. Otherwise use the existing tail-preserving plain-text preview,
  including for an oversized first line or table. Expansion restores full
  Markdown. Completed visual Mermaid and display-math blocks also use the
  plain-text preview under a budget: source line count cannot bound diagrams or
  wrapped copy-command headers. The plain-text preview registers overflow and
  clears it on expansion or unmount; shell-cap-only truncation does not advertise
  expansion.
- Forward the pending flag for live results. They use MarkdownDisplay's existing
  streaming budget and table cues, not a completed-result viewport cue.
- Use Ink's word-aware wrap-ansi options for height accounting. Include list
  indentation/markers, blockquote prefixes, and fenced-code padding, numbered
  gutters, and tab expansion. Count the code block's own lines, not the entire
  buffer; honor the live render mode and showLineNumbers in both shared callers.
- Reuse the table renderer's pure renderTableText layout function instead of a
  separate approximate column-width algorithm. Budgeting and rendering share
  horizontal/vertical layout decisions. A pending slice can turn a closed table
  into the frontier, so account for the larger of those two layouts. Count table
  height per rendered line. Wrap bounded table text only until overflow is known,
  not the invisible tail. Reserve margins and cues separately; tiny clamps show
  only the cue rather than an isolated border.
- Do not mark complete results as streaming to obtain clipping. Callers without
  a budget retain full rendering. Overflow registration remains opt-in.

## Constraints and risks

The shared estimator also serves live assistant output, so its existing streaming
and source-splitting tests must remain green. Exact table layout does more work
than approximate accounting, but removes divergent layout rules and uses installed
helpers only. Completed overflowing tool results deliberately lose Markdown
formatting in the bounded preview, but retain visible tail content and the
existing rendered-row hidden count. Other non-pending enforceHeightBudget callers
(e.g. plan confirmation) still use a head preview: an oversized first block can
leave only a cue, whose count is source lines, not rendered rows. No generic
Markdown tail slicer or layout cache is introduced.

## Validation and acceptance

- Reproduce literal **Color** using global qwen in an interactive terminal, then
  verify bold terminal cells without delimiters using the local bundled CLI.
- Use real Markdown rendering inside actual width-constrained Ink containers.
  Assert frame heights and overflow lifecycle for paragraphs, word wrapping,
  Chinese, lists, code gutters/tabs, narrow/long/asymmetric tables, and expansion.
  Pin tail visibility, minimum-budget first-block content, exact fits, pending
  cues, raw mode, and mounted non-empty-to-empty Markdown overflow cleanup.
- Preserve shell caps, explicit plain text, and raw-file detail through regression
  tests. Run related tool, Markdown, table, estimator, MaxSizedBox, and streaming
  tests, plus build, bundle, typecheck, lint, and formatting checks.
- Distinguish component coverage from interactive E2E evidence; short-result
  Ctrl+S checks do not prove expansion of a long result.
