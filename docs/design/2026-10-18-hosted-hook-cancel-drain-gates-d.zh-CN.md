# Hosted Hook 取消与超时门禁 FG13d

[English](2026-10-18-hosted-hook-cancel-drain-gates-d.md) | [简体中文](2026-10-18-hosted-hook-cancel-drain-gates-d.zh-CN.md)

## 问题与范围

Issue #14449 跟踪 Hosted Hook 两个域的 Stage F 故障门禁轮次。FG13c 覆盖了
owner 重启矩阵；本切片是 **FG13d 的前半部分：取消与超时**，补齐
`HostedExtensionsIT` 没有覆盖的 “cgroup 执行 / drain” 其余部分。

托管命令 Hook 跑在 Runtime worker 的委派 cgroup v2 单元里，命令还可能留下
后代进程。因此取消或超时必须对整个单元发信号，在后代忽略优雅信号时升级到
`cgroup.kill`，并且只有单元清空后才报告终态（`hook-command-cgroup.ts:227-248`、
`hookRunner.ts:1415-1439`）。

## 决策

1. **复用 FG13c 的装置。** 新类沿用 `HostedHookFaultGatesIT` 的只含 Hook 定义、
   打包 Harness、durable worker 与委派 cgroup 根，测的是同一条 owner 路径。
2. **夹具增加忽略 TERM 的后代。** 只发 SIGTERM 无法清空仍被后代占据的单元；
   夹具子进程在 `hook-ignore-term` 模式下安装 `SIGTERM` handler。
3. **三个独立用例，各自一套夹具。** 取消、超时与 worker 停止时取消分别启动自己的
   Spring、Harness 与 worker，一格的停顿不会掩盖另一格。三格均保留
   `@Timeout(300)`，该类按 350 s 计入预算。
4. **取消与状态探针都走 Harness 路由。** 两者都通过认证的
   `/session/:id/hooks/operations/:operationId` 路由并携带契约头，与 FG13c 的
   状态探针同一入口。

## 用例

| 用例                         | 注入                                                                                    | 期望                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancel-held-command`        | `PreToolUse` 命令 Hook 带一个忽略 SIGTERM 的后代保持运行；通过 Harness 路由取消该操作。 | 命令收到 SIGTERM；后代存活，因此只有宽限期后的 `cgroup.kill` 能清空单元。记录结算为 `cancelled` 且只在那之后报告；单元到达 `populated 0`；恰好一次物理调用；`failClosed` 把取消结果变成阻断，工具不运行。 |
| `timeout-held-command`       | 同样的保持型命令，Hook 超时 2 s，后代忽略 SIGTERM。                                     | 命令超时，输出不被采用，记录结算为 `outcome=timeout`，单元被杀并到达 `populated 0`，模型看到阻断而不是文件正文。                                                                                          |
| `cancel-with-stopped-worker` | 同样的保持型命令；对 durable worker 发 SIGSTOP，再通过 Harness 路由取消。               | 取消被记录，但 owner 无法应答：记录停在 `recovery_blocked` / `outcome_unknown`，命令与后代继续占据单元，且不会发生第二次调用。                                                                            |
| `cancel-with-dropped-reply`  | 同样的保持型命令；broker 代理在 worker 中止后丢弃 `hook-cancel` 控制调用的回复。        | 取消已记录，因此同一 owner 的后续状态轮询会结算它：记录为 `cancelled`、单元只 drain 一次、恰好一次物理调用，代理日志证明这次丢弃。                                                                        |

## 变异见证

每个见证必须在合入前让自己的用例变红。

- `cancel-held-command`：删掉 `CommandCgroup.terminate` 里的 `cgroup.kill`
  兜底（只保留 SIGTERM 一轮）。后代继续占据单元，`populated 0` 断言失败，
  记录也无法如实报告 `cancelled`。
- `timeout-held-command`：超时分支跳过终止，单元被留在运行状态；cgroup 断言
  失败，而记录仍会结算 `timeout`。
- `early-terminal`（两格）：在 `processUnit.terminate` 返回前先发布结果，使
  记录在单元仍被占据时就进入终态。`awaitTerminalDrained` 检查首次终态观测，
  两格都会因单元非空而失败。
- `cancel-with-stopped-worker`：去掉 `status()` 里如实记录 unknown 的提交分支
  （owner 无法应答时写 `recovery_blocked` / `outcome_unknown` 的那一支）。
  记录会停在 `running`，状态断言失败。
- `cancel-with-dropped-reply`：破坏取消派发的 operation-id 幂等（或移除解析同一
  occurrence 的状态轮询）。重试会产生第二次物理调用，或记录停在未知态；一次
  调用或 `cancelled` 断言失败。

## 非目标

FG13d 其余部分——派发前取消、以及带 `SessionEnd`/`SessionDelete` 的 DELETE
异步 drain——仍留在 #14449。同样不在范围：FG13a、FG13b、FG13e、FG13f、本地
非托管 Hook、Windows/macOS，以及 #13133 的设计项。

## 验证

在 Linux、MySQL 8.4 与委派 cgroup v2 根上跑完整的 `hosted-harness-mysql`
车道即证据。Checkstyle、CI fork 预算守卫与 pin 名单随新类一起移动。被跳过的
用例不算通过。
