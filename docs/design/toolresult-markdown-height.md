# Tool-result Markdown height budgets

[English](toolresult-markdown-height.md) | [简体中文](toolresult-markdown-height.zh-CN.md)

## Problem and scope

ToolMessage previously disabled Markdown whenever a terminal-height budget was
present. Even short question answers consequently displayed literal bold markers.
Restore formatting without removing height constraints or changing tool execution.
The fix also preserves the tool's display mode in session records; it does not
change configuration, dependencies, model messages, or tool execution.

## Design

- Persist the actual tool-result Markdown flag at each recording boundary
  (scheduler, TUI and headless batch recording, non-interactive Mod calls, and
  ACP). Restore the recorded boolean
  before considering the current tool declaration. Older records use the
  registered tool's declaration; missing tools and standalone previews without
  a recorded declaration default to plain text. Ordinary errors and synthetic
  results remain plain text, preserving the live renderer's Advisor exception.
  Legacy cancelled records without a display declaration also fall back to plain
  text. Mod recording uses the returned response's error state, even when its
  native invocation completed successfully before the result was withheld.
  Do not infer a display mode from the tool name.
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
  Trim trailing whitespace only when probing pending text, matching the renderer;
  completed results keep their source text unchanged. In both states, ignore
  leading blank lines and charge each plain blank run as one spacer, matching
  MarkdownDisplay; do not collapse blanks inside code or math blocks. Decide
  full fit from rendered height alone, not a raw source-line count.
- Completed enforceHeightBudget callers with an actual height budget render
  Mermaid as code and display-math as literal source. Math contents are not
  reparsed as Markdown, and their invisible `$$` delimiters do not consume the
  completed height budget. This keeps following plan steps readable when they
  fit, without guessing visual height; unbounded callers retain visual rendering.
  Plan confirmation passes the actual body width after margins and padding to
  the shared renderer, so wrapping and height accounting use the same width.
- Use Ink's word-aware wrap-ansi options for height accounting. Include list
  indentation/markers, render-mode task checkboxes, blockquote prefixes, and
  fenced-code padding, numbered gutters, and tab expansion. Count the code
  block's own lines, not the entire buffer; honor the live render mode and
  showLineNumbers at every fitPendingSlice caller: the shared Markdown renderer,
  streaming commit loop, and tool-result full-fit probe.
  Non-code tabs bypass the printable-width shortcut and use wrap-ansi's tab stops.
  Budgeted line charges skip exact wrapping when a conservative width lower bound
  already exceeds the remaining rows. Uncapped calls retain exact counts, and
  the bound allows double-width glyphs in a one-column viewport.
  Pending Mermaid previews count the header's wrapped height and one truncated
  row per source line, without code gutters, source wrapping, or a visible closing
  fence. Completed bounded Mermaid source keeps ordinary code-block accounting.
- Reuse the table renderer's pure renderTableText layout function instead of a
  separate approximate column-width algorithm. Budgeting and rendering share
  horizontal/vertical layout decisions. Before layout, reject tables whose
  minimum height (one row per data row, respecting clamps, plus margins) already
  exceeds the remaining budget, avoiding full layout of huge tool results.
  When the data-row count guarantees a finite clamp will engage, use the exact
  clamped cost without layout, including completed-layout and closing-line
  charges; preserve the tiny-clamp cue-only behavior.
  A pending slice can turn a closed table
  into the frontier. If only the streaming layout fits, keep the table as the
  frontier and defer following text; otherwise account for the larger layout
  while following text is retained. Skip the second layout when the first alone
  forces a cut. Count table height per rendered line. Wrap bounded table text only until overflow is known,
  not the invisible tail. Reserve margins and cues separately; tiny clamps show
  and charge only the cue rather than an isolated border.
  When code or math blocks interrupt an open table, retain its headers and rows
  and replace its previously charged layout cost with the merged layout cost;
  do not truncate merely because a pipe row resumes. Charge completed layout
  only once a non-table line actually closes the table.
  A clipped pending slice also reports a closed table's source boundary when it
  lies within the kept prefix. If no blank boundary exists, the stream can commit
  that whole table to scrollback without a trailing blank, while open tables and
  incomplete frontier rows remain pending. A final delimiter prefix that can
  still become a code/math fence or table separator is not a commit boundary.
  Render-side height limits still use keptLines, and completed-layout accounting
  remains in place.
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
Markdown tail slicer or layout cache is introduced. A very short viewport can
still clip before a table interrupted by code/math reaches its closing line;
that legacy streaming case can remain pending until the character cap or
finalization. The closed-table boundary fix does not scan beyond the height walk.

## Validation and acceptance

- Reproduce literal **Color** using global qwen in an interactive terminal, then
  verify bold terminal cells without delimiters using the local bundled CLI.
- Use real Markdown rendering inside actual width-constrained Ink containers.
  Assert frame heights and overflow lifecycle for paragraphs, word wrapping,
  Chinese, lists, code gutters/tabs, narrow/long/asymmetric tables, and expansion.
  Pin tail visibility, minimum-budget first-block content, exact fits, pending
  assistant table cues, raw mode, bounded visual source, task lists, disabled
  gutters, runtime mode toggles, explicit shell caps, and tool-preview overflow
  cleanup after expansion, empty text, or unmount. Leading, internal, and trailing
  plain blank runs must not reject fitting Markdown; a pending-to-completed
  transition must preserve formatting and retain the completed trailing spacer.
  Huge pending/completed tool tables must fall back without a layout crash and
  keep their visible tail and overflow indicator. A fitting table resumed after
  code or math must retain its resumed rows and following text without a false
  viewport cue. At the regression viewport, a closed wide table followed
  immediately by prose, code, or math must commit before the character cap,
  preserve all source text, and leave a bounded pending tail; an open table must
  not commit a headerless fragment. Compare smaller viewports with the baseline
  rather than treating preexisting interrupted-table stalls as new regressions.
- Preserve shell caps, explicit plain text, and raw-file detail through regression
  tests. Run related tool, Markdown, table, estimator, MaxSizedBox, and streaming
  tests, plus build, bundle, typecheck, lint, and formatting checks.
- Verify recorded true/false declarations survive resumption even when the tool
  is missing or its current declaration differs. Cover legacy registered tools,
  unknown tools, standalone previews, ordinary errors, synthetic Mod output,
  and duplicate-call responses.
  Assert that oversized lines and necessarily clamped tables avoid the layout
  helpers, and that removing each shortcut fails those assertions. Cover legacy
  cancelled records and Mod denials/errors after successful native execution.
  The resumed LSP heading/list/table fixture must stay literal, while a declared
  Markdown result still formats. Reverting the renderer fallback must fail the
  unknown-mode regression.
- Distinguish component coverage from interactive E2E evidence; short-result
  Ctrl+S checks do not prove expansion of a long result.
