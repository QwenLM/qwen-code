---
name: qwencode-viz
description: >
  Generate renderable chart outputs for clients that support the Qwen Code Web
  Shell echarts-fulldata renderer. Use only when the current Web Shell host has
  explicitly registered that renderer and the user asks for a chart,
  visualization, ECharts output, or Web Shell-rendered chart block.
---

# Qwen Code Visualization Skill

Use this skill to emit chart blocks that a Qwen Code Web Shell host can render.
This skill defines only the model output contract; it does not load or execute
the chart runtime. The host client must already have registered an
`echarts-fulldata` renderer.

## Preconditions

Use this skill only when all of these conditions are true:

- The active host is Qwen Code Web Shell, or an equivalent Web Shell client.
- The host has registered an `echarts-fulldata` fenced code block renderer.
- The user wants a visual chart, not just a plain Markdown table or code block.

If any condition is not met, do not emit an `echarts-fulldata` block. Use normal
Markdown, tables, or prose instead.

## Output Contract

Emit one fenced code block whose language tag is exactly `echarts-fulldata`.

The block body must be one valid JSON object that can be parsed directly with
`JSON.parse`. Do not emit JavaScript.

Preferred inline payload shape:

```echarts-fulldata
{
  "version": 1,
  "data": {
    "kind": "inline",
    "dimensions": ["day", "orders"],
    "source": [
      ["Mon", 120],
      ["Tue", 200],
      ["Wed", 150],
      ["Thu", 80],
      ["Fri", 240]
    ]
  },
  "option": {
    "title": { "text": "Weekly orders" },
    "tooltip": { "trigger": "axis" },
    "xAxis": { "type": "category" },
    "yAxis": { "type": "value" },
    "series": [{ "type": "bar", "encode": { "x": "day", "y": "orders" } }]
  }
}
```

Legacy dataset-backed ECharts option JSON is also accepted when an envelope is
not needed:

```echarts-fulldata
{
  "title": { "text": "Weekly orders" },
  "dataset": {
    "dimensions": ["day", "orders"],
    "source": [
      { "day": "Mon", "orders": 120 },
      { "day": "Tue", "orders": 200 }
    ]
  },
  "xAxis": { "type": "category" },
  "yAxis": { "type": "value" },
  "series": [{ "type": "bar", "encode": { "x": "day", "y": "orders" } }]
}
```

## Safety Rules

- Output JSON data only, not JavaScript.
- Do not output `const option = ...`, expressions, comments, trailing commas,
  functions, or callbacks.
- Do not ask the host to use `eval`, `new Function`, or script injection.
- Do not reference the DOM, globals, network requests, randomness, timers,
  `document`, `window`, or the filesystem.
- Put chart data in the envelope `data.source`, or in `dataset.source` for
  legacy option payloads.
- Avoid duplicating the same data in `xAxis.data`, `legend.data`, or
  `series.data` when `dataset` plus `encode` can express it.
- If the data is too large, aggregate or sample it first, and explain that
  treatment outside the block.

## Response Format

When a chart is appropriate, respond in this order:

1. One short takeaway describing the main point shown by the chart.
2. One `echarts-fulldata` fenced code block containing the complete JSON
   payload.
3. Optional notes such as metric definitions, aggregation choices, or reading
   guidance.

Do not nest the chart block inside any other Markdown container.

## Chart Guidance

- Trends: Prefer a line chart with time on the x-axis and the metric on the
  y-axis.
- Rankings: Prefer a bar chart sorted by the metric in descending order.
- Composition: Use a pie chart for a small number of categories; use a bar chart
  when there are many categories.
- Multi-metric comparisons: Prefer grouped bars or multiple lines, and avoid
  overcrowding the chart with too many series.
- Keep titles, axes, units, and legends clear.

## When Unsure

If there is not enough data to draw a chart, or if renderer support is unclear,
explain the reason in normal Markdown first. Do not guess by emitting an
`echarts-fulldata` block.
