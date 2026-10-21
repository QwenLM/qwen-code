# Hosted MCP 故障门禁 FG12f：工具调用期间的流缺口

[English](2026-10-18-mcp-stream-f-gap.md) | [简体中文](2026-10-18-mcp-stream-f-gap.zh-CN.md)

## 问题与范围

Issue #14447 要求补一道「长 MCP 工具调用期间、以及配置替换期间」的公开流 / WebShell 流断连续传门禁。FG12e 已确认 MCP 原始操作夹具不产生任务事件，因此这道门禁必须走模型驱动的工具调用路径；本切片就是那道门禁，也是本轮最后一个字母。

被验证的可观察契约是 Spring 事件存储的序列：客户端在某个事件之后断连、带着最后看到的游标重连，必须恰好收到剩余事件——不缺口、不重复；同时进行中的 MCP 工具调用恰好完成一次。

## 现状

- 公开流是 `GET /v1/agents/sessions/{sessionId}/events`；`stream=true` 或 `Accept: text/event-stream` 选择 SSE。游标来自 `Last-Event-ID` 请求头，缺头时用 `after` 查询参数。SSE 帧携带 `id`（序列）、`event`（类型），`data` 的 JSON 正文里 `sequence` 与帧 id 相等。
- WebShell 流是 `POST /api/agent/web-shell/v1/events/stream`，请求体带 `sessionId` 与 `afterSequence`，没有请求头游标；两条路由是两套机制。
- 两条流回放的都是 Spring 事件存储，不是 Harness journal。
- `HostedExtensionsIT.modelReply()` 已经会为发现的 MCP 工具发 `tool_calls`，并经公开 events API 提交 turn；`HostedSessionRelayFaultGatesIT` 已有 SSE 观察者，会校验每帧 `id`/`event` 与 `data.sequence` 一致，并支持关闭后带游标重连。
- MCP 夹具唯一的工具 `append` 立即应答，无法把一次调用跨断连挂住。

## 决策

1. **一个新类、三个用例。** 门禁类为 `HostedMcpStreamGapIT`，含公开路由用例、WebShell 路由用例与配置替换用例。不新增夹具账目，除类本身外不新增预算账目。
2. **教会现有夹具「挂住」，按工具参数区分。** `append` 工具只在 `value: "EXT_HOLD"` 时等待其工作目录里出现释放标记后再应答，并记录这次等待；其余取值保持现行行为，既有扩展门禁不受影响。
3. **两套续传机制、两个用例。** 公开用例用 `Last-Event-ID` 续传，WebShell 用例用 `afterSequence` 续传。只写一个用例会把其中一套机制钉死、另一套静默漏掉。
4. **断言是跨连接的并集。** 每条路由都断言：同一个序列不会同时出现在两条连接上；续传后看到的序列严格大于续传前看到的最后一个；工具结果事件在并集中恰好出现一次。被忽略的游标会以三种不同方式让用例变红，因此不可能靠空游标通过。
5. **配置替换搭同一次挂住的调用。** 第三个用例在调用挂住期间向 Agent 提交新的 MCP server 修订，然后释放：流跨替换保持连续、进行中的调用结果不丢、运行中的 Session 仍固定在它启动时的修订上、夹具的物理追加恰好一次。Harness 私有的配置路由无法承担这件事：它要求 Broker 为自己的 Session 签发的 client id，而 Spring 创建的 Session 从不暴露该值，因此只会返回 `hosted_session_not_found`。运行期 MCP 连接替换因此不在本切片覆盖范围内，作为缺口记录，不作宣称。
6. **预算按实测重钉。** 新类进入共享 fork，因此六个账目按实现结束时本机实测的用例运行时间移动，不按估算：三个用例在 JDK 21 + MySQL 8.0.46 上、合并后基线实测 121.1 s，按 2 倍预算 242 s，健康总和由 5743 s 升至 5985 s，fork 由 6353 s 升至 6585 s，Verify 步升至 120 分钟。

## 验收

- 三个用例在 MySQL 8.x 车道上全绿；任意一套游标被忽略都会使其变红。
- 变异见证：忽略续传游标，公开用例必须在重复序列上变红，而不是超时。
- 扩展夹具既有的门禁保持全绿。
- 共享 fork 预算在同一 diff 内重钉到 workflow、Maven profile、元测试及其注释链。
- 同一改动内同步双语设计文档。

## 待决问题

- WebShell 路由是否需要补一个请求头游标以对齐公开路由。本门禁不依赖它，客户端目前把游标放在请求体里。
- 通用的 turn 级续传门禁是否应放在 MCP 之外。本切片只主张 MCP 工具调用路径。
