---
name: web-shell-charts
description: Produce Qwen Code Web Shell renderable ECharts code blocks using the echarts-fulldata fenced-code format. Use when the user asks for charts or visual data output that should render directly in Web Shell.
when_to_use: When the user asks to create, show, render, or visualize a chart in Qwen Code Web Shell, especially with ECharts or the echarts-fulldata fenced-code format.
---

# Web Shell Charts

Use this skill to emit charts that a Web Shell host can render from Markdown
code blocks.

## Output Contract

Emit a fenced code block with the language tag `echarts-fulldata`:

```echarts-fulldata
const option = {
  title: { text: 'Weekly orders' },
  tooltip: { trigger: 'axis' },
  xAxis: { type: 'category', data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
  yAxis: { type: 'value' },
  series: [{ type: 'bar', data: [120, 200, 150, 80, 240] }],
};
```

The code block body must define `option` as an Apache ECharts option object.
The renderer decides how to load ECharts and execute the block.

## Rules

- Put all chart data inside the code block. Use `dataset.source`, `series.data`,
  or other inline option fields. Do not reference local files, URLs, DOM nodes,
  global app state, or network requests.
- Keep the block deterministic and side-effect free. Do not use `fetch`,
  `import`, timers, random data, `document`, `window`, or filesystem access.
- Prefer plain object/array data. Avoid functions in the option unless the user
  explicitly needs custom ECharts callbacks and the host is known to allow them.
- Close the Markdown fence normally so the Web Shell can render after the fence
  closes or streaming finishes.
- Use the simplest chart that answers the question. Include clear titles, axis
  labels, units, and readable number formats.
- If the data is too large, aggregate or sample it before producing the chart
  and explain that reduction outside the code block.
- If a chart cannot be produced safely, explain the reason in normal Markdown
  and do not emit an `echarts-fulldata` block.

## Response Shape

For chart answers, use this order:

1. One short takeaway sentence.
2. One `echarts-fulldata` fenced code block containing the complete option.
3. Optional notes about data reduction, assumptions, or how to read the chart.

Do not wrap the chart block in another Markdown container.
