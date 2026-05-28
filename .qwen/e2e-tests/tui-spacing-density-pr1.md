# TUI Spacing And Density PR1 Evidence Plan

## Goal

Provide before/after evidence that PR1 reduces visible row usage without
removing content or changing rendering scope.

## Fixed Conditions

- Terminal width: 100 columns.
- Compare the same prompt/output fixture before and after this PR.
- Strip ANSI control sequences before counting visible rows.
- Count only non-empty rendered terminal rows for the density metric.

## Scenarios

- Simple Q&A.
- File list output.
- Long shell output.
- File-read error output.
- Multi-block project inspection output.
- Diff output.
- Long streaming output.

## Metrics

For each scenario, record:

- Baseline visible row count.
- PR1 visible row count.
- Delta in rows.
- Notes for any scenario that gains rows because of wrapping or fixed-width
  content.

## Expected Results

- Simple Q&A: at least 1 fewer visible row.
- Expanded tool output: at least 1 fewer visible row per rendered tool result
  that previously had a blank header/result spacer.
- Multi-tool expanded groups: 1 fewer visible row between each adjacent tool
  entry.
- No scenario should lose user-visible content.

## PR Body Table

Use this table shape in the PR description. The current automated evidence uses
the representative fixtures below; broader end-to-end captures can reuse the
same conditions if a later PR needs screenshots or recordings.

| Scenario | Width | Baseline rows | PR1 rows | Delta | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| Simple Q&A | 100 | 2 | 1 | -1 | Assistant history item no longer starts with a spacer row |
| File list or shell output | 100 | 3 | 2 | -1 | Tool header and first result row are adjacent |
| File-read error | 100 | 3 | 2 | -1 | Error result uses the same tool header/result spacing |
| Project inspection | 100 | 7 | 5 | -2 | Three expanded tools no longer have blank inter-tool rows |
| Diff output | 100 | 3 | 2 | -1 | Diff renderer remains unchanged; only tool header/result spacing changes |
| Long streaming output | 100 | N + 2 | N + 1 | -1 | Content rows are unchanged; the extra header/result spacer is removed |
