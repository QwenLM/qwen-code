# Hosted Hook MessageDisplay 重载门禁 FG13f

[English](2026-10-21-hosted-hook-message-display-reload-f.md) | [简体中文](2026-10-21-hosted-hook-message-display-reload-f.zh-CN.md)

> 跟踪 #14449。FG13f 计划中的最后一格：MessageDisplay Hook 抑制回复后，
> 重载不得把它复活。

## 问题与范围

`MessageDisplay` Hook 是 fire-and-forget，但它的 `suppressOutput` 结果决定
回复文本与 parts 是否进入输出。Hosted 模型在提交 assistant 消息之前应用该
决策，因此持久化的历史应带一条空消息，而不是原始文本。

风险在持久化边界：重载会从 store 载入 Session 并重建下一次模型请求的历史。
若被抑制的文本被提交到任何位置，下一次请求（或公共台账）就会带上它。今天
没有 Hosted 格钉住这个边界；进程内模型测试只覆盖 `suppressOutput` 本身。

## 用例

`HostedHookMessageDisplayReloadIT` 的
`fg13fMessageDisplaySuppressionSurvivesReloadOnMySql`，在
`hosted-harness-mysql` 车道上只冷启一次：

| 步骤 | 发生什么                                                          |
| ---- | ----------------------------------------------------------------- |
| 1    | 一个 `MessageDisplay` 命令 Hook 返回 `{"suppressOutput": true}`。 |
| 2    | 模型流式输出回复 `FG13F_SECRET`；回合完成。                       |
| 3    | 读公共台账：该文本从未出现。                                      |
| 4    | 重启 Harness，从 store 重载 Session。                             |
| 5    | 提交第二个 prompt；检查模型请求的历史。                           |

期望：

- `hook.call` 与 `hook.suppress` 各一次；回合正常完成。
- 公共事件台账没有 `FG13F_SECRET` 行。
- 重载后下一次模型请求的历史不含 `FG13F_SECRET`，第二回合完成。

## 覆盖

`hosted-harness-model.test.ts` 钉住进程内的 `suppressOutput` 结果。本格补上
重载与持久化边界：已提交的消息、台账行与重建后的请求历史。

## 变异见证

- 抑制后仍提交原始文本：重载后的请求会带上 `FG13F_SECRET`。
- 把原始文本投到公共台账：台账断言变红。
- 跳过 Hook：没有 `hook.suppress` 事件，回复也不再被抑制。

## 非目标

- Stop Hook 的抑制与强制续跑：另开臂。
- FG13a 的 store 确认仍留在 #14449。

## 验证

证据来自 Linux 上的 `hosted-harness-mysql` 车道，MySQL 8.4 与委派的 cgroup
v2 根。`managed-agent-gate.yml` 在 `pull_request` 上只选 `fast` 档；完整套件
由维护者对 head 提交的首次批准触发，因此被跳过的车道不算通过。本格给共享
fork 增加 150 s。
