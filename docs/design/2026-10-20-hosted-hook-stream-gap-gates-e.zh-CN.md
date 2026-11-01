# Hosted Hook 事件流断流门禁 FG13e

[English](2026-10-20-hosted-hook-stream-gap-gates-e.md) | [简体中文](2026-10-20-hosted-hook-stream-gap-gates-e.zh-CN.md)

> 跟踪 #14449。FG12f 的断流类覆盖的是一次 MCP 工具调用；本层补上跟踪项列在
> FG13e 下的 Hook 臂。

## 问题与范围

`PreToolUse` Hook 是一个带进程的决策门。该进程运行期间，回合会产出公共事件
（工具调用先宣告、后结算），公共流与 WebShell 流都必须恰好投递一次。被切断的
客户端用游标重连：公共路由用 `Last-Event-ID`，WebShell 路由用 `afterSequence`。

FG13e 要求：在 Hook 持有期间断流，两条路由都不丢帧、不重帧，拒绝只投递一次。
Hook 状态本身不在公共流上，所以这一格钉的是台账与断流，而不是 Hook 专属帧。

## 用例

`HostedHookStreamGapIT` 的 `bothStreamsResumeTheHeldHookTurnOnMySql`，在
`hosted-harness-mysql` 车道上只冷启一次：

| 步骤 | 发生什么                                                                               |
| ---- | -------------------------------------------------------------------------------------- |
| 1    | 一个 `PreToolUse` 命令 Hook 在 Runtime worker 里保持持有，直到测试显式释放，随后拒绝。 |
| 2    | 两个客户端从头读同一 Session 流：公共（SSE）与 WebShell（JSON 游标）。                 |
| 3    | Hook 已进入持有、两个客户端都已读到帧后，同时切断两个客户端。                          |
| 4    | Hook 的拒绝在两个客户端都不在线时落地；回合完成。                                      |
| 5    | 两个客户端各自带游标重连，读到台账尾部。                                               |

工具调用的起始帧只在调用离开 Hook 之后才发射，所以断流刻意发生在它之前：持有
期间写入的帧，正是被切断客户端会漏掉的那些。

期望：

- 两个续读视图都与台账前缀逐字节一致：序号 `1..n` 无空洞、无重复
  （`continueFrom`），两条路由各自成立。
- 联合视图至少比断流位置多出一帧（即两个客户端离线期间写入的帧），且回合只有
  一个 `turn.completed`。
- 一次物理 Hook 调用（`hook.call`）、一次拒绝（`hook.deny`），工具从未执行：
  模型只收到一条携带拒绝原因的工具结果，且从不包含证明文件的内容。

## 覆盖

已在 main 上：

- `HostedMcpStreamGapIT` 用被持有的 MCP 工具调用钉住两个游标。
- `ManagedEventReplayTest` 钉住 `Last-Event-ID`、`afterSequence`、追平到实时的
  交接与 store 回退，均无空洞、无重复。

本格补的是 Hook 持有中的回合：断流发生在 Runtime worker 进程持有决策之时，因此
断流期间落台账的行是工具调用的终态与回合完成，而不是 MCP 结果。游标机制是共用
的；Hook 车道是新的对象。

## 变异见证

- 忽略游标（从头重放）：每个视图都会重放被切客户端的帧，联合序号表在重复处变红。
- 只给续读客户端投实时帧：回合已经完成，该客户端永远读不到台账尾部；`continueFrom`
  的 90 秒等待耗尽，用例在该超时处变红（联合视图的空洞断言根本到不了）。
- 拒绝后仍让工具执行：模型请求会带上证明文件的内容，`doesNotContain(PROOF)` 变红。

## 非目标

- Stop 或 `MessageDisplay` 被抑制文本的重放：抑制属于决策/输出性质，由 FG13f 的
  `message-display-reload` 跟踪。
- FG13a 的 store 确认与 store 侧故障仍留在 #14449。
- 将共享机制移入 `HostedGateTestSupport` 是 #14921 跟踪的后续清扫，不属于本格：
  流与台账辅助（`Observer`、`ledger`、`served`、`camel`、`continueFrom`）、
  Spring 启动块（`startSpring`、`stop`），以及请求/等待辅助（`api`、`waitFor`、
  `quote`、`events`、`createSession`、`submit`、`turnStatus`、`awaitCompleted`）。

## 验证

证据来自 Linux 上的 `hosted-harness-mysql` 车道，MySQL 8.4 与委派的 cgroup v2
根。`managed-agent-gate.yml` 在 `pull_request` 上只选 `fast` 档；完整套件由维护者
对 head 提交的首次批准触发，因此被跳过的车道不算通过。
本格增加 150 s；叠加 main 的 FG12f 投递格（30→50 s，+20 s）与 FG11d
retire-at-intent（+18 s）后，合并台账为 healthy 9668 s、fork 10268 s、
Verify 182 分钟。
