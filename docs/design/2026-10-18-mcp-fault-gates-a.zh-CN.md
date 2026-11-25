# Hosted MCP 故障门禁 FG12a：应答丢失

[English](2026-10-18-mcp-fault-gates-a.md) | [简体中文](2026-10-18-mcp-fault-gates-a.zh-CN.md)

## 问题与范围

issue #14447 是 #12380 的 Stage F 轮次 FG12：为 Hosted MCP 的两个域
`mcp_configuration` 与 `mcp_operation` 补故障门禁。整轮有六道门禁
（FG12a–f）。本切片只实现 **FG12a，控制路径上的应答丢失**。

受门禁约束的性质：上游 MCP 控制已应答之后，丢失的应答必须通过**对原
operation id 的 status 查询**解决，绝不能再发一次 configure 或 invoke。
Runtime 会在同一代内合并重复 id，因此重发会掩盖第二次物理副作用；门禁
因此把**Broker 代理上的线上序列**作为主见证，而不只看 Runtime 的合并。

本切片交付三个 case：

| Case                  | 注入                                                 | 期望                                                                                                                         |
| --------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `configure-reply`     | 替换用的 `mcp-configure` 应答在 Runtime 应答后被丢弃 | 恰好一个 `mcp-configure` 控制，随后一次 `mcp-status` 查询；配置记录以替换版本 settle；没有第二次 configure                   |
| `resource-read-reply` | `resource_read` 的 `mcp-invoke` 应答被丢弃           | 恰好一个 `mcp-invoke`、一次 `mcp-status` 查询；操作记录 settle 且带 `resultRef`；fixture 恰好记录一次 `resource_read` 副作用 |
| `prompt-get-reply`    | `prompt_get` 的 `mcp-invoke` 应答被丢弃              | 同形状，恰好一次 `prompt_get` 副作用                                                                                         |

留给 #14447 后续切片：`mcp-cancel` 与 `mcp-release` 的应答丢失、Broker
owner-release ack、以及 MCP 工具调用的 start（走普通工具账本，不走 MCP
控制路径）；FG12b–f 全部。

## 现状

- 控制调用抛错时，`HostedMcpSession.dispatch()` 已经回退到 `lookup()`
  （`packages/cli/src/serve/hosted-mcp-session.ts`），而 `lookup()` 把任何
  失败都变成 `outcome_unknown`。
- Runtime 在同一代内合并重复的 operation id
  （`managed-mcp-runtime.ts`），这正是线上序列而非副作用计数成为主见证的
  原因。
- #14357 的 `HostedExtensionsIT` 证明了打包启动形态：真实 Harness、durable
  worker、真实 stdio MCP server 跑在 MySQL 上，以及 lifecycle v2 关闭。它
  从不丢应答，也从不创建 `mcp_operation`。
- `HostedMcpReplyLossIT` 复用该启动形态：in-JVM Spring、真实 MySQL schema、
  Broker 前置代理、真实 Harness 与 worker、stdio fixture。基线 turn 完成
  首次配置；Harness 私有的 `mcp/configurations` 路由只做**替换**
  （`expectedRevision` 必须等于当前 revision），所以被注入的 configure 是
  revision 2 的替换。

## 门禁账本

事实来源是 Broker 代理的 wire、经 JDBC 读取的 `mcp_configuration` /
`mcp_operation` 扩展记录，以及 stdio fixture 的副作用日志。每个 case 先
证明自己的注入生效：configure case 先断言被丢弃的控制已转发（代理侧
200）再出现查询；invoke case 断言副作用计数。

**变异见证。** 把 `dispatch()` 的回退从 `lookup()` 改成第二次
`broker.control()`，代理必须在本来该出现查询的位置看到第二次
`mcp-configure` 或 `mcp-invoke`。Runtime 的 id 合并会掩盖重复副作用，所以
见证是线上断言。该见证已跑红：把 `dispatch()` 的回退改成第二次 `broker.control()` 后，代理记录了两次
`mcp-configure`，门禁以 `Expected size: 1 but was: 2` 失败；还原源码并重新打包后复绿。

## 夹具设计

`HostedMcpReplyLossIT` 启动一套 in-JVM Spring（强制 MySQL，缺失即失败而非
跳过），种一个 workspace 与存储注册，把 Harness 的 broker 地址钉在一个
Java `HttpServer` 代理上，并以 `hosted-workspace-mcp/1` 启动打包 Harness。
代理转发全部端到端头（含 `X-Qwen-Lifecycle-*`），并在命中一个指定控制
kind 时：先转发、读完上游应答，然后**不写响应**直接关闭连接——这是连接级
丢失，不是 HTTP 拒绝。

会话按 FG8 的做法分两步创建：先用公开的
`insertWorkspaceSessionCommand` 建行（Broker 的 scope 解析器读它），再用
managed-session store 描述符在 Harness 上 `POST /session`。一个基线 turn
完成首次 MCP 配置。fixture 同时提供 `tools`、`resources` 与 `prompts`，两
种原始操作都可被发现，并把每次物理副作用写入 JSONL 证据文件。

证据落在 `target/fg12-cases/fg12a/<tenant>/`，由 CI 上传。

## 验收

- `mvn -DskipTests test-compile checkstyle:check` 干净。
- 该类在本机 JDK 21 + MariaDB 10.11 上绿（实测 5.1-7.4 s），且变异见证在合入
  前跑红。
- `scripts/tests/hosted-process-ci.test.js` 绿：fork 预算由 4484 s 移到
  4499 s，healthy 和由 3874 s 移到 3889 s。
- 本设计双语言同构交付。

## 待决问题

- cancel/release 两道门禁能否原样复用该代理（它们需要有在飞操作与
  lifecycle v2 关闭）。
- FG12c/d 是否需要只替换 Broker 的接缝；整仓 Spring 重启会替换存储守卫，
  而守卫无法为被占用的存储重新注册，这会在 Broker release 之前就挡住
  detach。
