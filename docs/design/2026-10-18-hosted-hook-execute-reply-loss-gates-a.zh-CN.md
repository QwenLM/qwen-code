# Hosted Hook execute 丢回复门禁 FG13a

[English](2026-10-18-hosted-hook-execute-reply-loss-gates-a.md) | [简体中文](2026-10-18-hosted-hook-execute-reply-loss-gates-a.zh-CN.md)

## 问题与范围

Issue #14449 跟踪 Hosted Hook 两个域的 Stage F 故障门禁轮次。FG13c 覆盖 owner
重启矩阵，FG13d 覆盖取消与超时；本切片开始 **FG13a（丢回复）**，先补命令 Hook
最先遇到的一臂：worker 已接收操作之后，`hook-execute` 的回复丢失。

派发回复是唯一会让“丢失的应答”看起来像“丢失的调用”的地方。回执已经在 worker
手里，因此重试必须通过 owner 的状态解析同一个操作，而不是再派发一条命令。

## 决策

1. **复用 FG13d 的装置与 broker 代理。** 新类沿用只含 Hook 的定义、打包 Harness、
   durable worker 与转发代理。前三格各丢弃一条具名 broker 控制回复、其余请求直通；
   HTTP 格改为丢弃端点响应。
2. **两个命令格的重试走状态轮询，而不是第二次 execute。** 派发回复丢失时，Harness
   会按记录自身的 `runtimeSessionId` 回落到 `hook-status`，这正是物理调用保持一次
   的原因。
3. **四格、各自一套夹具。** 前两格都让 solo 命令保持 1 秒后放行；派发回复丢失
   必须通过 status 解析，status 回复丢失必须先保持未知，直到同一 owner 的后续
   轮询把它结算。两者都不得增加第二次物理调用。第三格在注册提交前丢弃 catalog
   回复：准入失败后协调器重试该 Turn，重试必须只注册一次，且保持定义里 pin 的
   catalog 修订。第四格向本地 HTTP 端点发送请求并丢弃端点回复：回执保持未知，
   工具不会运行，请求绝不重发。

## 用例

| 用例                 | 注入                                                                                     | 期望                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute-reply-lost` | `PreToolUse` 命令 Hook 运行中；broker 代理在 worker 已接收后丢弃 `hook-execute` 的回复。 | 恰好一次物理调用；重试通过 owner 状态解析同一操作；记录结算 `settled` 且 `outcome=success`；放行结果只到达模型一次；代理日志记录这次丢弃。                           |
| `status-reply-lost`  | 同样的 solo 命令；broker 代理在派发后丢弃一次 `hook-status` 轮询的回复。                 | 丢失的轮询无法证明结束，因此记录先落 `recovery_blocked` / `outcome_unknown`；随后对同一 owner 的轮询把它结算为 `success`，物理调用仍恰好一次，代理日志记录这次丢弃。 |
| `catalog-reply-lost` | broker 代理丢弃第一次 `hook-catalog` 控制调用的回复，此时注册尚未提交。                  | 准入失败，协调器重试该 Turn；重试只结算一条 `hook_registration`，修订等于定义里 pin 的值；Hook 恰好运行一次，代理日志记录这次丢弃。                                  |
| `http-reply-lost`    | `PreToolUse` HTTP Hook 向本地端点发起请求；端点消费请求后丢弃回复。                      | 端点只收到一次请求；记录保持 `recovery_blocked` / `outcome_unknown`；工具不会运行；端点绝不被再次调用。                                                              |

## 变异见证

每个见证必须在合入前让自己的用例变红。

- `execute-reply-lost`：改破坏这条格真正走到的兜底——让丢失的派发回复直接得到
  `outcome_unknown`，而不是回落到回执查询（例如去掉 `fire` 里的 `hook-status`
  兜底）。记录因此永不结算，`settled` 断言失败。execute 的 operation-id 幂等
  是另一个见证：显式重放 `hook-execute`。
- `status-reply-lost`：去掉 `fire` 循环里如实记录 unknown 的提交分支（轮询无法
  证明结束时写 `recovery_blocked` / `outcome_unknown` 的那一支）。记录会停在
  `running`，状态断言失败。
- `catalog-reply-lost`：把丢失的 catalog 回复当成空 catalog 吞掉，让 `configure`
  在未注册 pin 的情况下继续。Turn 因此没有 Hook 可跑，`hook.call` 与“只有一条注册”
  两条断言都会失败。另一个见证：在注册提交前就把 catalog 缓存进内存，重试直接读
  缓存，于是没有已结算的 `hook_registration`，单记录断言失败。
- `http-reply-lost`：把丢弃的 HTTP 回复当成已完成回执，或对请求重试。记录因此结算，
  且/或端点计数变成 2，未知状态与“只请求一次”的断言都会失败。

## 非目标

FG13a 其余部分——`hook-cancel`、`dispatch_started` 与结果提交的 store ack——仍留在
#14449。同样不在范围：FG13b、FG13e、FG13f、本地非托管 Hook、Windows/macOS，以及
#13133 的设计项。

## 验证

在 Linux、MySQL 8.4 与委派 cgroup v2 根上跑完整的 `hosted-harness-mysql`
车道即证据。Checkstyle 与 CI fork 预算守卫随新用例一起移动；pin 名单不变。
被跳过的用例不算通过。
