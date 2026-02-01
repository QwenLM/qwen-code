# 关键数据流

> 描述关键交互流程（可用文字或序列图）。

## 浏览器工具调用（MCP）

1. Qwen CLI 触发 MCP tool call
2. Native Server 路由到 Extension（Native Messaging）
3. Extension 调用 Content Script / Chrome APIs
4. 结果回传至 Native Server → Qwen CLI
