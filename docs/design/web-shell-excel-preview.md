# Web Shell Excel preview

[English](web-shell-excel-preview.md) | [简体中文](web-shell-excel-preview.zh-CN.md)

## Problem and scope

Workspace artifacts, @file references, and incoming/uploaded XLSX files currently
reach download-only or unsupported states. Add the same read-only right-panel
preview to all three paths. Support `.xlsx` and its standard MIME type; legacy
`.xls`, macro workbooks, and other Office formats retain their existing behavior.
No editing, formula calculation, external links, charts, or backend conversion.

## Design

Reuse the existing workspace-owner-bound byte reader and attachment Blob paths.
Keep ownership checks, cancellation, freshness keys, and download behavior.
Identify spreadsheets before binary/source fallbacks, including source cards and
attachment previews. Missing artifacts must not trigger reads.

A lazily imported spreadsheet component owns loading, errors, sheet selection,
virtual scrolling and download. An inline Vite worker loads ExcelJS only when this
component is opened; its code must stay outside initial app/library entry chunks.
The inline worker avoids a separate worker asset contract for embedded hosts.
Terminate it on close, input changes, or a 30-second parsing timeout. Hosts must
permit blob workers; failure shows a download fallback. The first-party VS Code
webview explicitly grants `worker-src blob:` without widening `script-src`.

The worker initially returns only worksheet names. Selecting a sheet requests its preview projection; the page retains only
the selected sheet and ignores outdated responses. Keep the parsed workbook in
the worker until the preview closes or the input changes, with a 30-second
timeout for each request. ExcelJS still parses the whole XLSX on initial load:
on-demand sheet projection avoids transferring every sheet to the main thread,
but does not provide streaming parsing or bound the worker's workbook memory.

Worksheet selection uses horizontal Excel-style tabs at the top, built from
the shared Tabs primitive, with rounded top corners and muted inactive tabs.
The active tab uses blue text and a background matching the panel, with its bottom
border hidden to join a narrow panel-colored gap above the grid. Allow horizontal
overflow and keyboard arrow navigation, and reset scrolling when switching sheets.
Mount at most 50 tabs at a time, with previous/next group buttons; retain every
worksheet and its original index. Arrow keys cross groups and Home/End reach the
first/last worksheet. Group navigation scrolls the active tab into view without
moving keyboard focus. Disable worksheet controls after a preview failure until
retry. Download failures have a separate status and do not discard
a successful preview; a new download attempt clears the previous download error.
The row-number gutter defaults to a 56 px minimum and grows
with the row-number digits in the current font, using tabular numerals.

ExcelJS reads workbook data. Use the small SSF formatter for Excel number formats
instead of implementing a custom number-format parser. Preserve formula cached
results (including zero/false), errors, rich text as plain text, and formulas
without results as explicitly uncalculated. Format typed hyperlink labels through
the same value formatter and display them only as plain text. Do not execute formulas or hyperlinks.
Use a white cell canvas so document colors remain readable in dark mode.
Show basic explicit RGB colors, bold/italic text, alignment, and merges; complex
styles/themes and embedded objects are outside this preview's fidelity guarantee.
If an explicit foreground or fill cannot be represented, fall back both colors
to black on white together. Uncalculated annotations inherit the cell text color.

Limit preview input to 10 MiB and each selected sheet to 100,000 grid cells,
including empty positions inside the content/merge extent. Ignore peripheral
formatting-only cells when finding this extent; keep original coordinates and
merged placeholders. Iterate ExcelJS 4.4.0 sparse row/cell storage directly and
read normalized merge bounds without serializing the entire worksheet model;
revalidate these private structures when upgrading ExcelJS. Replace independent worksheet-count, row-count and
column-count caps with this budget: retain all columns and as many complete rows
as fit within floor(100,000 / column count). Empty sheets have no preview rows.
Show the truncation notice only when the selected sheet exceeds that budget.
The 100,000-cell default balances content and response time: synthetic mixed-cell
production measurements showed about 88 ms to switch sheets on the test machine,
and 260 ms under page CPU 4× throttling, versus 419 ms for 200,000 cells. These
measurements are not a universal responsiveness or memory guarantee. Use the existing
TanStack virtualizer for continuous vertical scrolling, rendering visible rows
with a small overscan and measuring wrapped row heights. Native table spacer
rows preserve the scroll extent and sticky headers; stable column widths prevent
horizontal layout changes as rows mount. Clip merges at the rendered window,
retaining the original master value and row/column coordinates. Remount the table
on sheet changes to reset scroll position and row measurements. Remove pagination
controls. The cell budget bounds projection size, while row virtualization reduces
mounted rows; neither limits ZIP expansion; the worker is cancellable but is not
a hard memory sandbox. Before ExcelJS expands merges, reject workbooks with more
than 100,000 merged cells in total or 10,000 merged ranges across all worksheets.
These separate load-time budgets include off-screen sheets and prevent compact
merge declarations from allocating unbounded cells or doing unbounded pairwise
intersection checks. A worker-local hook wraps ExcelJS 4.4.0's private
`_parseMergeCells`, applies only to registered preview workbooks, and retains
separate budgets for concurrent loads. Keep the exact ExcelJS version pinned and
revalidate this hook on upgrades. Invalid merge addresses fail closed. Rejection
keeps the original downloadable. These guards do not bound general ZIP expansion
or non-merge workbook memory. Download retains the existing separate file-size policy.

ExcelJS's prebuilt browser bundle includes packages outside its runtime dependency graph. Supplement the extension notices with original license texts for those embedded packages, verified against the pinned sourcemap sources. Notice generation checks the bundle hash and version so an upgrade requires reviewing this inventory.

## Affected areas

- ArtifactPanel routing, artifact type detection and shared preview components.
- Client translations, dependencies/lockfile, lazy worker build and package checks.
- Collocated parser/component tests and browser E2E coverage.

## Validation and acceptance

Check the global CLI baseline before implementation, then run focused unit tests,
root build/typecheck/bundle and browser E2E. Use real XLSX bytes with a mock daemon
for deterministic UI checks and label screenshots accordingly. Verify artifact,
@file, pending upload, persisted attachment and incoming Blob paths; sheet switching,
formats/formulas/errors, merges, malformed/oversized inputs, downloads and ownership
changes. Verify bounded mounted rows, scrolling to the last retained row and
back, wrapped text, and merges crossing the virtual window. Verify worksheets
beyond the twentieth, rows beyond 2,000, columns beyond 50, and exact/over-budget
truncation including empty cells. Compare large-sheet
rendering with the paginated and full-render baselines. Inspect actual screenshots.
Check built app and library chunks to ensure
ExcelJS is absent from initial entries and its lazy worker is published correctly.
Check huge merged ranges, exact/over-limit area and count, accumulation across
sheets, concurrent load isolation, and peripheral empty formatting. Verify the
first-party webview CSP permits blob workers while restrictive third-party hosts
still receive the download fallback. Verify bounded tabs with thousands of
worksheets, navigation across groups, six-digit row numbers in a wide font,
independent download failures, and sparse distant formatting without hole scans.

Compare the browser sourcemap package inventory with generated notice headers and verify the supplementary original license texts are included. Reject a changed ExcelJS bundle until its inventory is refreshed.

## Open questions

None for this scope. Full Excel layout fidelity and additional formats are deferred.
