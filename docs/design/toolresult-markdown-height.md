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
- Render string results as Markdown only when their full rendered height fits.
  Otherwise use the existing tail-preserving plain-text preview, including for
  an oversized first line or table. Expansion restores full Markdown. Visual
  Mermaid and display-math tool results also use the plain-text preview under a
  budget: source line count cannot bound diagrams or wrapped copy-command
  headers. The plain-text preview registers overflow and clears it on expansion
  or unmount; shell-cap-only truncation does not advertise expansion.
- Forward the pending flag for fitting live results. The full-fit probe mirrors
  MarkdownDisplay's streaming headroom and frontier layout, but rejects an
  oversized first table: live tools replace output rather than commit a hidden
  prefix to scrollback. Overflowing live results therefore keep their newest
  tail and hidden-row count, not an assistant-style head slice.
- Completed enforceHeightBudget callers with an actual height budget render
  Mermaid as code and display-math as literal source. Math contents are not
  reparsed as Markdown. This keeps following plan steps readable when they fit,
  without guessing visual height; unbounded callers retain visual rendering.
- Use Ink's word-aware wrap-ansi options for height accounting. Include list
  indentation/markers, render-mode task checkboxes, blockquote prefixes, and
  fenced-code padding, numbered gutters, and tab expansion. Count the code
  block's own lines, not the entire buffer; honor the live render mode and
  showLineNumbers at every fitPendingSlice caller: the shared Markdown renderer,
  streaming commit loop, and tool-result full-fit probe.
- Reuse the table renderer's pure renderTableText layout function instead of a
  separate approximate column-width algorithm. Budgeting and rendering share
  horizontal/vertical layout decisions. A pending slice can turn a closed table
  into the frontier. If only the streaming layout fits, keep the table as the
  frontier and defer following text; otherwise account for the larger layout
  while following text is retained. Skip the second layout when the first alone
  forces a cut. Count table height per rendered line. Wrap bounded table text only until overflow is known,
  not the invisible tail. Reserve margins and cues separately; tiny clamps show
  only the cue rather than an isolated border.
- Do not mark complete results as streaming to obtain clipping. Callers without
  a budget retain full rendering. Only the plain-text tool preview registers
  expandable overflow; plan and assistant table cues are pure text. Keep the
  existing full-plan editor affordance rather than add Ctrl+S behavior.

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
  assistant table cues, raw mode, bounded visual source, task lists, disabled
  gutters, runtime mode toggles, explicit shell caps, and tool-preview overflow
  cleanup after expansion, empty text, or unmount.
- Preserve shell caps, explicit plain text, and raw-file detail through regression
  tests. Run related tool, Markdown, table, estimator, MaxSizedBox, and streaming
  tests, plus build, bundle, typecheck, lint, and formatting checks.
- Distinguish component coverage from interactive E2E evidence; short-result
  Ctrl+S checks do not prove expansion of a long result.
