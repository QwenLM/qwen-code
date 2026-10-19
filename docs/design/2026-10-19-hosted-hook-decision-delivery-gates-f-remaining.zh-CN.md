# Hosted Hook 决策投递门禁 FG13f（剩余臂）

[English](2026-10-19-hosted-hook-decision-delivery-gates-f-remaining.md) | [简体中文](2026-10-19-hosted-hook-decision-delivery-gates-f-remaining.zh-CN.md)

> 承接已合入 main 的 #14701。deny 臂已在其中落地；下列用例是本层的计划，
> 在各自测试落地前不宣称已实现。

## 问题与范围

FG13f 覆盖决策与输出投递。#14701 钉住“已结算 deny 回复丢失”；本层补齐 #14449
跟踪的其余臂：`failClosed` 失败回复、超大的单条与聚合输出、`PermissionRequest`
上耗尽 4096 回执上限与 16 个运行名额、以及被抑制的 `MessageDisplay` 重载。

## 用例（计划）

| 用例                     | 注入                                                                                                                                                    | 期望                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `failclosed-reply-lost`  | `failClosed` Hook 失败；broker 代理丢弃第一条已结算、携带该失败的 `hook-status` 回复。夹具需要先补失败模式（见「前置条件」）。                          | 一次物理调用；决策先于工具持久化；工具绝不运行；后续读取结算同一失败。 |
| `oversized-output`       | Hook 经 Hosted 路径返回超大的单条输出与超大的聚合输出。worker 侧上限已有单测，因此本格的对象是 harness 的聚合/结算上限与传输路径。两处上限都是 60 KiB。 | 在已保存策略下记为有界失败；记录不越界增长到 60 KiB 以上。             |
| `receipt-cap`            | 在 `PermissionRequest` 上耗尽 worker 的 4096 回执上限。                                                                                                 | 不论失败策略如何都拒绝；无第二次调用。                                 |
| `running-quota`          | 在 `PermissionRequest` 上耗尽 16 个运行名额。                                                                                                           | 拒绝为 `non_blocking_error`，因此只在 `failClosed` 下阻断。            |
| `message-display-reload` | `MessageDisplay` Hook 抑制输出；重载 Session。                                                                                                          | 被抑制的文本绝不出现在重放里。                                         |

## 前置条件

`failclosed-reply-lost` 需要 `hosted-hook-fault-process.mjs` 的失败模式。夹具目前只会
回答 allow/deny 并以 0 退出，因此本层的首个提交补上该失败模式；这一格不是对着一个
不存在的夹具做计划。

## 覆盖

main 上已有：`failClosed` 包装（`hosted-hook-session.test.ts`）、超大的 worker 侧上限
（`managed-hook-runtime.test.ts`：70 KiB 的 handler 返回对 60 KiB 的 `MAX_BYTES`，
回执小于 1 KiB）、以及回执上限与运行名额（4096 次操作的 worker 单测）。Hosted 各格补的是
进程内测试看不见的部分：harness 聚合/结算上限、传输路径、owner 重启与生命周期。对
`receipt-cap` 而言，这部分边际价值是投递——上限拒绝要跨过 broker 成为一次 deny——而不是
上限算术；4096 次 `hook-execute` 请求正是它单独预算的原因。

## 变异见证

- `failclosed-reply-lost`：在回复到达后才应用决策，或重跑命令。工具会运行，或出现第二次调用。夹具必须先补失败模式（见「前置条件」）。
- `oversized-output`：变异要打在见证点名的那一层。worker 侧上限已由 `managed-hook-runtime.test.ts` 钉住，撤回它会让那个单测变红，而不是本格。本格的见证是 harness 聚合/结算上限与传输路径。
- `receipt-cap`：再放一条回执进来，或直接服务该请求。拒绝断言失败。
- `running-quota`：把拒绝归类为 blocking。它在 allow 策略下也会阻断。
- `message-display-reload`：保留被抑制文本。重载重放会包含它。

## 非目标

FG13 其余轮次（FG13a store ack、FG13b、FG13e）与本地非托管 Hook 仍留在 #14449。

## 验证

在 Linux、MySQL 8.4 与委派 cgroup v2 根上跑完整的 `hosted-harness-mysql` 车道即证据。
base 现在是 `main`，该车道会随 `pull_request` 重新触发。被跳过的用例不算通过。
