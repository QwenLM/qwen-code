# Hosted Hook 决策投递门禁 FG13f（剩余臂）

[English](2026-10-19-hosted-hook-decision-delivery-gates-f-remaining.md) | [简体中文](2026-10-19-hosted-hook-decision-delivery-gates-f-remaining.zh-CN.md)

> 堆叠层 2/2，基于 #14701 的分支。deny 臂已在该 base 中；下列用例是本层的计划，
> 在各自测试落地前不宣称已实现。

## 问题与范围

FG13f 覆盖决策与输出投递。#14701 钉住“已结算 deny 回复丢失”；本层补齐 #14449
跟踪的其余臂：`failClosed` 失败回复、超大的单条与聚合输出、`PermissionRequest`
上耗尽 4096 回执上限与 16 个运行名额、以及被抑制的 `MessageDisplay` 重载。

## 用例（计划）

| 用例                     | 注入                                                                                   | 期望                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `failclosed-reply-lost`  | `failClosed` Hook 失败；broker 代理丢弃第一条已结算、携带该失败的 `hook-status` 回复。 | 一次物理调用；决策先于工具持久化；工具绝不运行；后续读取结算同一失败。 |
| `oversized-output`       | Hook 返回超大的单条输出与超大的聚合输出。                                              | 在已保存策略下记为有界失败；记录不越界增长。                           |
| `receipt-cap`            | 在 `PermissionRequest` 上耗尽 worker 的 4096 回执上限。                                | 不论失败策略如何都拒绝；无第二次调用。                                 |
| `running-quota`          | 在 `PermissionRequest` 上耗尽 16 个运行名额。                                          | 拒绝为 `non_blocking_error`，因此只在 `failClosed` 下阻断。            |
| `message-display-reload` | `MessageDisplay` Hook 抑制输出；重载 Session。                                         | 被抑制的文本绝不出现在重放里。                                         |

## 变异见证

- `failclosed-reply-lost`：在回复到达后才应用决策，或重跑命令。工具会运行，或出现第二次调用。
- `oversized-output`：接受超大输出。有界失败断言失败。
- `receipt-cap`：再放一条回执进来，或直接服务该请求。拒绝断言失败。
- `running-quota`：把拒绝归类为 blocking。它在 allow 策略下也会阻断。
- `message-display-reload`：保留被抑制文本。重载重放会包含它。

## 非目标

FG13 其余轮次（FG13a store ack、FG13b、FG13e）与本地非托管 Hook 仍留在 #14449。
