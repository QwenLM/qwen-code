# Palette Reference

## Categorical

Use these first for independent categories:

```text
#2563eb blue
#d97706 orange
#7c3aed purple
#0891b2 cyan
#be123c rose
#4d7c0f green
```

Start with three to five colors. If the chart needs more categories than that,
prefer direct labels, grouping, faceting, or filtering over adding more hues.

## Sequential

Use one hue ramp for ordered magnitude:

```text
#eff6ff #bfdbfe #60a5fa #2563eb #1e3a8a
```

## Diverging

Use a diverging ramp only when there is a meaningful center such as zero,
target, or baseline:

```text
#b91c1c #fca5a5 #f8fafc #93c5fd #1d4ed8
```

## Validation

Run the validator whenever exact mark colors are chosen:

```bash
node <skill-base-directory>/scripts/validate_palette.js "#2563eb,#d97706,#4d7c0f" --mode light
```
