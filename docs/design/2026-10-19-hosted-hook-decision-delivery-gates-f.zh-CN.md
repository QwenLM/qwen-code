# Hosted Hook 决策投递门禁 FG13f

[English](2026-10-19-hosted-hook-decision-delivery-gates-f.md) | [简体中文](2026-10-19-hosted-hook-decision-delivery-gates-f.zh-CN.md)

## 问题与范围

Issue #14449 跟踪 FG13。FG13a 覆盖了 command、catalog 与 HTTP Hook 的丢回复；
本切片开始 **FG13f（决策与输出投递）**，先补 deny 最先遇到的一臂：worker 已结算
deny 之后，回复丢失。

deny 是一个决策，不是可以重新推导的结果。worker 会持久化它；回复丢失时必须通过
记录自身的 status 解析出同一个决策，而不是再跑一次工具。

## 决策

1. **复用 FG13a 的丢回复装置。** 该格丢弃第一条已结算的 `hook-status` 回复（结果为
   deny）；`running` 回执直通，随后读取同一 operation 得到相同决策。
2. **夹具新增 deny 模式。** `hook-deny` 写 `hook.deny` 并返回
   `permissionDecision: deny`，确保该格走的是真实决策，而不是换了个标签的 allow。
3. **一格。** 回复丢失后仍必须只有一次物理调用、一条已持久化的 deny，且工具不运行。

## 用例

| 用例              | 注入                                                                                                   | 期望                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deny-reply-lost` | `PreToolUse` 命令 Hook 返回 deny；broker 代理在 worker 已结算后丢弃第一条已结算的 `hook-status` 回复。 | 恰好一次物理调用；丢弃后记录先落 `recovery_blocked` / `outcome_unknown`；随后读取同一 operation 以 `outcome=success` 且 `permissionDecision=deny` 结算；工具绝不读取文件；代理日志记录这次丢弃。 |

## 变异见证

- `deny-reply-lost`：把被丢弃的已结算 status 回复当成已完成回执（或在重试时重跑命令）。
  工具会运行，或出现第二次 `hook.call`，于是“未知状态 / 无文件证明 / 只调用一次”的断言失败。

## 非目标

FG13f 其余部分（`failClosed` 失败回复、超大输出、回执上限与 16 个运行名额、被抑制的
`MessageDisplay` 重载）、FG13b、FG13e 与本地非托管 Hook 仍留在 #14449。

## 验证

在 Linux、MySQL 8.4 与委派 cgroup v2 根上跑完整的 `hosted-harness-mysql` 车道即证据。
Checkstyle 与 CI fork 预算守卫随新用例移动。被跳过的用例不算通过。
