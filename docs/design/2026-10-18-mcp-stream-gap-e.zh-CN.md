# Hosted MCP 故障门禁 FG12e：事件流断流

[English](2026-10-18-mcp-stream-gap-e.md) | [简体中文](2026-10-18-mcp-stream-gap-e.zh-CN.md)

## 问题与范围

issue #14447 是 #12380 的 Stage F 轮次 FG12：为 Hosted MCP 的 `mcp_configuration` 与 `mcp_operation` 两个域补故障门禁。本切片在长 MCP 工具调用期间与配置替换期间断开公开与 WebShell 事件流，再用 `Last-Event-ID` / `afterSequence` 续传。

门禁要求不重复、不缺失；观察者断开既不会取消、也不会重新调用该操作，fixture 副作用计数保持 1。issue 指出 MCP 记录不产生 task 事件（H1 设计 `:27`），所以这道门禁很薄，可以并入 FG12f。

## 现状

- Harness 从 journal 发布公开与 WebShell 事件流；`Last-Event-ID` / `afterSequence` 从某个 sequence 续传。
- FG12c/d 的 rig 已有 `ext://hold` 长调用与 Broker 代理控制 hold；本切片复用该 rig。
- 具体流路由在实现时核实；WebShell 路由是否暴露是待决问题。

## 门禁账本

| Case                   | 注入                                             | 期望                                                           |
| ---------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `stream-gap-long-call` | 连接、启动被持有的 `ext://hold` 调用、断开、续传 | 事件连续（无缺口/重复）；副作用计数 1；不取消、不第二次 invoke |
| `stream-gap-replace`   | 配置替换期间断开，再续传                         | 事件连续；恰好一次 configure；revision 2                       |
| `web-shell-stream-gap` | WebShell 事件流变体                              | 同上；路由是否可用是待决问题                                   |

## 决策

1. **复用 FG12c rig。** 长调用用 `ext://hold`；配置替换用代理控制 hold。
2. **按最后观察到的 sequence 续传。** 使用 `Last-Event-ID` / `afterSequence`，断言续传序列连续、没有重复 event id。
3. **断开不得中止 turn。** fixture 副作用计数保持 1，wire 上没有第二次 `mcp-invoke` 或 `mcp-configure`。
4. **并入还是独立。** issue 认为这道门禁很薄。先核实公开与 WebShell 路由；若打包 Harness 不暴露 WebShell 流，就并入 FG12f 的投递格，而不是为它另搭一套 rig。
5. **只有路由支持时才独立成类。** `HostedMcpStreamFaultGatesIT` 会重钉六处 fork 账目；并入 FG12f 则不新增类、预算不变。

## 夹具设计

- 复用 FG12c boot；SSE 客户端带最后 event id 重连；hold fixture；代理 wire。
- 若独立，证据落在 `target/fg12-cases/fg12e/<tenant>/`；workflow 已上传 `target/fg12-cases/`。
- 在承诺 WebShell 用例之前先核实其路由。

## 预算

独立成类 -> 同一 diff 重钉六处 fork 账目。并入 FG12f -> 预算不变。

## 验收

- 续传序列无缺口、无重复；副作用计数为 1；没有第二次 configure/invoke。
- 两份设计文档保持同构。
- 若并入，FG12f 设计文档记录该流用例，本文档指向它。

## 待决问题

- 打包 Harness 暴露的公开/WebShell 流路由；两者是否都支持 `Last-Event-ID` 与 `afterSequence`。
- 并入 FG12f 还是独立；issue 自己已注明这道门禁很薄。
