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
   durable worker 与转发代理；只丢弃 `hook-execute` 控制调用的回复，其余请求直通。
2. **重试走状态轮询，而不是第二次 execute。** 派发回复丢失时，Harness 会按记录
   自身的 `runtimeSessionId` 回落到 `hook-status`，这正是物理调用保持一次的原因。
3. **两格、各自一套夹具。** 两格都让 solo 命令保持 1 秒后放行；派发回复丢失必须
   通过 status 解析，status 回复丢失必须先保持未知，直到同一 owner 的后续轮询
   把它结算。两者都不得增加第二次物理调用。

## 用例

| 用例                 | 注入                                                                                     | 期望                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute-reply-lost` | `PreToolUse` 命令 Hook 运行中；broker 代理在 worker 已接收后丢弃 `hook-execute` 的回复。 | 恰好一次物理调用；重试通过 owner 状态解析同一操作；记录结算 `settled` 且 `outcome=success`；放行结果只到达模型一次；代理日志记录这次丢弃。                           |
| `status-reply-lost`  | 同样的 solo 命令；broker 代理在派发后丢弃一次 `hook-status` 轮询的回复。                 | 丢失的轮询无法证明结束，因此记录先落 `recovery_blocked` / `outcome_unknown`；随后对同一 owner 的轮询把它结算为 `success`，物理调用仍恰好一次，代理日志记录这次丢弃。 |

## 变异见证

每个见证必须在合入前让自己的用例变红。

- `execute-reply-lost`：改破坏这条格真正走到的兜底——让丢失的派发回复直接得到
  `outcome_unknown`，而不是回落到回执查询（例如去掉 `fire` 里的 `hook-status`
  兜底）。记录因此永不结算，`settled` 断言失败。execute 的 operation-id 幂等
  是另一个见证：显式重放 `hook-execute`。
- `status-reply-lost`：去掉 `fire` 循环里如实记录 unknown 的提交分支（轮询无法
  证明结束时写 `recovery_blocked` / `outcome_unknown` 的那一支）。记录会停在
  `running`，状态断言失败。

## 非目标

FG13a 其余部分——`hook-catalog`、`hook-cancel`、`dispatch_started` 与结果提交的
store ack、以及 HTTP Hook 响应丢失——仍留在 #14449。同样不在范围：FG13b、
FG13e、FG13f、本地非托管 Hook、Windows/macOS，以及 #13133 的设计项。

## 验证

在 Linux、MySQL 8.4 与委派 cgroup v2 根上跑完整的 `hosted-harness-mysql`
车道即证据。Checkstyle、CI fork 预算守卫与 pin 名单随新类一起移动。被跳过的用例
不算通过。
