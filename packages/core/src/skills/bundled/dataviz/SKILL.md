---
name: dataviz
description: Design guidance for charts, graphs, dashboards, maps, and data visualizations, including a local palette validator.
when_to_use: When creating or revising charts, graphs, dashboards, maps, plots, inline SVG, D3, Plotly, Recharts, matplotlib, or any Artifact page that visualizes data.
allowedTools:
  - read_file
---

# Dataviz

Use this skill before producing a chart, dashboard, map, or data visualization.

## Workflow

1. Identify the analytic task: comparison, trend, distribution, relationship,
   ranking, part-to-whole, geography, or status monitoring.
2. Choose the simplest chart form that answers that task. Read
   `references/choosing-a-form.md` when the form is not obvious.
3. Write the finding into the title, subtitle, axis label, or direct annotation.
   A viewer should know what changed, what is high or low, or what decision the
   chart supports.
4. Pick colors from `references/palette.md`, or validate any custom palette with
   the script below.
5. Check `references/anti-patterns.md` before finalizing the design.

## Palette Validation

Resolve paths relative to the skill base directory shown above this skill body.
Do not assume `$QWEN_SKILL_ROOT` is set for normal shell commands.

Run:

```bash
node <skill-base-directory>/scripts/validate_palette.js '#1d4ed8,#b45309,#166534' --mode light
```

Treat `FAIL` as a required palette change. Treat `WARN` as acceptable only when
the chart also uses labels, shape, texture, ordering, or another secondary
encoding.

## Mark Rules

- Use categorical palettes for unordered groups; use sequential or diverging
  ramps only for ordered values.
- Prefer direct labels over legends when the chart has a small number of series.
- Keep gridlines subtle and fewer than the data marks.
- Avoid dual axes unless both series share a clearly explained transformation.
- Do not rely on color alone for critical distinctions.
- Keep dashboards scan-friendly: align cards, use consistent number formats,
  and reserve saturated color for important state changes.
