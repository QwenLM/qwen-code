# Hosted Hook 决策投递门禁 FG13f（剩余臂）

[English](2026-10-19-hosted-hook-decision-delivery-gates-f-remaining.md) | [简体中文](2026-10-19-hosted-hook-decision-delivery-gates-f-remaining.zh-CN.md)

> 承接 #14701。两条决策格都已落地：deny 臂在那里，`failclosed-reply-lost` 在
> #14803；其余各行见下方评估。

## 问题与范围

FG13f 覆盖决策与输出投递。#14701 钉住“已结算 deny 回复丢失”；本层补齐 #14449
跟踪的其余臂：`failClosed` 失败回复、超大的单条与聚合输出、`PermissionRequest`
上耗尽 4096 回执上限与 16 个运行名额、以及被抑制的 `MessageDisplay` 重载。

## 用例

`failclosed-reply-lost` 已在 `fg13fFailClosedReplyLossReplaysTheBlockedFailureOnMySql`
中实现；其余各行见「剩余臂」。

| 用例                     | 注入                                                                                                                                                    | 期望                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `failclosed-reply-lost`  | `failClosed` Hook 经夹具的 `hook-fail` 模式失败；broker 代理丢弃第一条已结算、携带该失败的 `hook-status` 回复。                                         | 一次物理调用；决策先于工具持久化；工具绝不运行；后续读取结算同一失败。 |
| `oversized-output`       | Hook 经 Hosted 路径返回超大的单条输出与超大的聚合输出。worker 侧上限已有单测，因此本格的对象是 harness 的聚合/结算上限与传输路径。两处上限都是 60 KiB。 | 在已保存策略下记为有界失败；记录不越界增长到 60 KiB 以上。             |
| `receipt-cap`            | 在 `PermissionRequest` 上耗尽 worker 的 4096 回执上限。                                                                                                 | 不论失败策略如何都拒绝；无第二次调用。                                 |
| `running-quota`          | 在 `PermissionRequest` 上耗尽 16 个运行名额。                                                                                                           | 拒绝为 `non_blocking_error`，因此只在 `failClosed` 下阻断。            |
| `message-display-reload` | `MessageDisplay` Hook 抑制输出；重载 Session。                                                                                                          | 被抑制的文本绝不出现在重放里。                                         |

## 前置条件

已解决。`hosted-hook-fault-process.mjs` 现在支持 `hook-fail`：记录 `hook.fail`
后以 1 退出且不给决策，因此结算回执是失败而不是 deny。

## 覆盖

main 上已有：`failClosed` 包装（`hosted-hook-session.test.ts`）、超大的 worker 侧上限
（`managed-hook-runtime.test.ts`：70 KiB 的 handler 返回对 60 KiB 的 `MAX_BYTES`，
回执小于 1 KiB）、以及回执上限与运行名额（4096 次操作的 worker 单测）。Hosted 各格补的是
传输路径、owner 重启与生命周期；聚合/结算上限同样已有进程内测试（见「剩余臂」）。
`failclosed-reply-lost` 补的是包装的 Hosted 路径：已结算的失败回复被丢弃，记录显示
`recovery_blocked` / `outcome_unknown`，随后一次 status 读取在工具运行前持久化包装
后的 block。对
`receipt-cap` 而言，这部分边际价值是投递——上限拒绝要跨过 broker 成为一次 deny——而不是
上限算术；4096 次 `hook-execute` 请求正是它单独预算的原因。

## 剩余臂

三行已有进程内覆盖，不再计划 Hosted 格：

- `oversized-output`：60 KiB 聚合/结算上限由 `hosted-hook-session.test.ts` 的
  “bounds combined ... decisions without losing denial” 钉住；它在 PreToolUse 与
  PermissionRequest 上各跑两个 36 KiB Hook，并覆盖丢失最终 marker 的恢复路径。
- `receipt-cap` 与 `running-quota`：4096 次操作的 worker 单测同时钉住两种拒绝及其结果。

再为它们补 Hosted 格只多出传输路径，却各占 150 秒共享 fork；因此暂缓，等出现
传输相关缺陷再补。这些臂仍由 #14449 跟踪。

`message-display-reload` 仍是计划：抑制是 Harness 模型里的展示状态，目前没有 Hosted
格钉住它经重载后仍被抑制。

## 变异见证

- `failclosed-reply-lost`：不再丢弃已结算的失败回复；记录会立即结算，永远读不到 `recovery_blocked`。去掉 `failClosed` 包装后结果只有 `success:false` 而没有 `decision:'block'`，工具会运行。丢失回复后重跑命令，`hook.call` 会计为两次。
- `message-display-reload`：保留被抑制文本。重载重放会包含它。

## 非目标

FG13 其余轮次（FG13a store ack、FG13b、FG13e）与本地非托管 Hook 仍留在 #14449。

## 验证

在 Linux、MySQL 8.4 与委派 cgroup v2 根上跑完整的 `hosted-harness-mysql` 车道即证据。
base 现在是 `main`，该车道会随 `pull_request` 重新触发。被跳过的用例不算通过。
