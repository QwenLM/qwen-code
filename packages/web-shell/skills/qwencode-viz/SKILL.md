---
name: qwencode-viz
description: >
  为支持 Qwen Code Web Shell 自定义 code block renderer 的客户端生成可渲染图表输出。仅当当前客户端明确支持 `echarts-fulldata` fenced code block 渲染、用户要求“画图/图表/可视化/用 ECharts 展示/在 Web Shell 中渲染图表”，或宿主产品显式要求输出 Web Shell 图表块时使用；不支持该 renderer 的 CLI、ACP 或普通 Markdown 客户端不要使用本 skill。
---

# Qwen Code Visualization Skill

这个 skill 用于让模型输出 **Qwen Code Web Shell 可渲染的图表块**。它只定义
模型输出契约，不负责加载或执行图表运行时。宿主客户端必须已经注册
`echarts-fulldata` renderer。

## 使用前提

使用本 skill 前确认当前客户端满足以下条件：

- 运行在 Qwen Code Web Shell 或等价的 Web Shell 宿主中。
- 宿主已经注册 `echarts-fulldata` fenced code block renderer。
- 用户希望看到可视化图表，而不是普通 Markdown 表格或代码块。

如果任一条件不满足，不要输出 `echarts-fulldata` block；改用普通 Markdown、
表格或文字说明。

## 输出契约

输出一个 fenced code block，language tag 必须是 `echarts-fulldata`。

block body 必须是 **一个合法 JSON 对象**，可直接用 `JSON.parse` 解析。这个
JSON 对象就是 Apache ECharts option。

```echarts-fulldata
{
  "title": { "text": "Weekly orders" },
  "tooltip": { "trigger": "axis" },
  "xAxis": {
    "type": "category",
    "data": ["Mon", "Tue", "Wed", "Thu", "Fri"]
  },
  "yAxis": { "type": "value" },
  "series": [
    { "type": "bar", "data": [120, 200, 150, 80, 240] }
  ]
}
```

## 安全规则

- 只输出 JSON 数据，不输出 JavaScript。
- 不要输出 `const option = ...`、表达式、注释、尾逗号、函数或回调。
- 不要要求宿主使用 `eval`、`new Function` 或 script injection。
- 不引用本地文件、URL、DOM、全局变量、网络请求、随机数、计时器、
  `document`、`window` 或文件系统。
- 所有图表数据都放在 JSON option 里，例如 `dataset.source` 或
  `series.data`。
- 数据量太大时先聚合或抽样，并在 block 外说明处理方式。

## 回答格式

需要图表时按以下顺序回答：

1. 一句简短结论，说明图表表达的核心信息。
2. 一个 `echarts-fulldata` fenced code block，里面是完整 JSON ECharts option。
3. 可选补充说明，例如口径、数据聚合或阅读提示。

不要把图表 block 放进其它 Markdown 容器中。

## 图表建议

- 趋势：优先用 line chart，x 轴为时间，y 轴为指标。
- 排名：优先用 bar chart，按指标降序排列。
- 结构占比：类别较少时用 pie chart；类别较多时用 bar chart。
- 多指标对比：优先用 grouped bar 或多条 line，不要堆太多系列。
- 标题、坐标轴、单位和图例要清晰。

## 不确定时

如果数据不足以画图，或客户端是否支持 renderer 不明确，先用普通 Markdown
说明原因，不要猜测性输出 `echarts-fulldata` block。
