# Palette Reference

## Categorical

Use these first for independent categories:

```text
#1d4ed8 blue
#b45309 orange
#166534 green
#7c3aed purple
#0891b2 cyan
#be123c rose
```

Start with three to five colors. If the chart needs more categories than that,
prefer direct labels, grouping, faceting, or filtering over adding more hues.

## Sequential

Use one hue ramp for ordered magnitude:

```text
#eff6ff #bfdbfe #60a5fa #2563eb #1e3a8a
```

The lightest and darkest ramp endpoints are for backgrounds, area fills, and
labels. When choosing exact line, point, or bar mark colors, validate the marks
you actually use rather than the full ramp.

## Diverging

Use a diverging ramp only when there is a meaningful center such as zero,
target, or baseline:

```text
#b91c1c #fca5a5 #f8fafc #93c5fd #1d4ed8
```

The center and endpoint colors provide range context. For exact chart marks,
validate the selected mark colors and add direct labels or another encoding when
the validator reports `WARN`.

## Validation

Run the validator whenever exact mark colors are chosen:

```bash
node <skill-base-directory>/scripts/validate_palette.js '#1d4ed8,#b45309,#166534' --mode light
```

The validator's 2.5:1 contrast floor is a practical chart-mark heuristic, not a
WCAG AA guarantee. Use 3:1 or higher when chart marks must satisfy WCAG 2.1
non-text contrast without relying on labels or secondary encodings.

The validator also enforces OKLCH lightness bands so marks are neither too pale
nor too dark for the selected surface, even when contrast alone looks adequate.
