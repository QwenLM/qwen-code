# Web Shell Table Selection Statistics

## Summary

Add a read-only statistics strip to advanced Web Shell markdown tables. When a
user selects cells, the existing toolbar will show selected, non-empty, and
numeric counts. If the selection contains numeric values, it will also show
sum, average, minimum, and maximum.

The standalone daemon Web Shell enables advanced markdown tables so the new
statistics and the existing table interactions are available in that surface.

## Goals

- Make quick numerical inspection possible without copying data into Excel.
- Keep statistics aligned with the existing visible-cell selection and TSV
  copy behavior.
- Reuse the table's existing number parser so sorting, filtering, and
  statistics agree.
- Preserve recognizable percent and currency formatting when the selected
  numeric cells use one consistent format.

## Non-goals

- Formula evaluation, unit conversion, date statistics, or editable cells.
- Discontiguous selections or statistics over filtered-out and hidden cells.
- User-configurable metrics, popovers, or new dependencies.

## Behavior

Statistics are computed from the selected rectangle in `visibleRows` and the
currently visible column order. Blank cells count as selected but not
non-empty. Text cells count as non-empty but not numeric. Arithmetic metrics
use numeric cells only, and are hidden when no numeric cells are selected.

The toolbar renders compact inline metrics. It retains the existing TSV copy
action and wraps naturally on narrow screens.

Uniform percent selections display arithmetic results as percentages. Uniform
currency selections retain their common currency symbol. Mixed numeric formats
fall back to locale-formatted plain numbers.

## Implementation

Add a pure selection-statistics helper alongside the existing selection and
clipboard helpers. The component derives its result with `useMemo`; no new
mutable state is required. Add small formatting helpers for locale-aware
numbers, percentages, and common currency symbols.

The enhanced table limit is 500 rows by 50 columns, so a full-selection scan is
bounded at 25,000 cells. The existing animation-frame throttling for drag
selection keeps recomputation within the current interaction cadence.

## Verification

Unit tests cover numeric, mixed text/blank, currency, percent, reordered,
hidden-column, filtered, updated-data, and localized selections. A daemon Web
Shell browser check verifies drag selection, live metric updates, and wrapping
in the rendered UI.
