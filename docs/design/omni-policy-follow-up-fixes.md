# Omni policy follow-up fixes

## Context

PR #10351 expands the Omni policy-tool pipeline. Its follow-up review found
several contract mismatches in build coverage, media-memory channels, visual
token budgets, and tool settings.

## Changes

- Keep audio in video clips so the derived video's acoustic channel remains
  truthful.
- Derive caption and summary channels from the source media version.
- Keep patch-grid resize results within the configured maximum pixel budget
  whenever the budget can hold at least one grid cell.
- Make `softClipBudget` configurable, accept zero-valued scene thresholds,
  and validate image crops against post-EXIF-rotation dimensions.
- Repair the new tests so they compile and isolate external media probing.

## Verification

- Run the directly affected core unit tests.
- Run the core build and repository typecheck.
- Review the complete diff twice after tests pass.
