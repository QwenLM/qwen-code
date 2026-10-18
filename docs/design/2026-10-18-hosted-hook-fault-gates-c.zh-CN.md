# Hosted Hook 故障门禁 FG13c

[English](2026-10-18-hosted-hook-fault-gates-c.md) | [简体中文](2026-10-18-hosted-hook-fault-gates-c.zh-CN.md)

## 问题与范围

Issue #14449 跟踪 FG13，即 Hosted Hook 两个域 `hook_registration` 与
`hook_execution` 的 Stage F 故障门禁轮次。与 FG9、FG10 一样，本轮按切片落地。
本文档是第一个切片：**FG13c，owner 重启矩阵** ——
`docs/design/managed-agent-delivery-ledger.md:186` 与 #13129 都写明从未跑过的
唯一一项 Hook 专属内容。

托管命令 Hook 是背后有进程的决策门。命令跑在 Runtime worker 的委派 cgroup v2
单元里（`hook-command-cgroup.ts`），回执存在该 worker 的内存中
（`managed-hook-runtime.ts:516`）。因此哪个进程重启决定了结果：Harness 重启
可以通过记录原 owner 读到回执并如实结算；worker 丢失则不能，必须保持
`recovery_blocked` / `outcome_unknown`。

## Issue 要求先做的决定

1. **Spring/Broker 重启不在本切片。** 内嵌 Broker 与 JDBC 事实来源、cgroup
   观测同处 Spring 测试 JVM；杀掉它等于同时杀掉观察者，只能等下一次启动再断言。
   FG8c 已作同样决定（`2026-10-16-monitor-run-fault-gates-c.md:97`）。
   Harness 与 Broker 断连的各臂属于 FG9 的中继门禁，那里有专用代理。#13129 的
   "Broker/Runtime-owner" 措辞由本切片的 worker 丢失格子满足；独立 Broker
   重启需要另一套拓扑，属另一轮次。
2. **worker SIGKILL 后的孤儿 Hook 单元：断言，而非要求平台清理。**
   worker 被杀后，命令与其后代继续让单元保持有进程，且无 owner、无回执、无计时器。
   worker 丢失的格子会在清理前断言该状态，再由测试清理杀掉单元。这样钉住的是
   H2 已接受的限制本身，而不是要求产品回收单元（那是 #13133 的工作）。

## 测试装置

新增 `HostedHookFaultGatesIT`（Linux、`hosted-harness-mysql`），使用
`hosted-workspace-files/1` 上只含 Hook 的定义：

- 定义里没有 MCP server，因此 Hook 不跟随 MCP 的 owner
  （`hosted-harness-session.ts:4619-4625`）。
- 该 profile 支持 Hook，且关闭走 lifecycle 协议 1
  （`WorkspaceToolProfiles.java:26-33`），所以杀进程后的一次 Turn 重载会新建
  owner；恢复必须到达记录自身的 `runtimeSessionId`，而不是当前 activation。
- 打包 Harness、带内嵌 Broker 的进程内 Spring、真实 MySQL 8.4 schema、
  durable worker，以及委派的 cgroup v2 根。
- `HostedHookFaultProcess`（`src/test/resources/hosted-hook-fault-process.mjs`）
  记录 PID、start ticks、boot id 与 cgroup，可选带存活后代保持运行。

模型夹具只声明 files profile 的 `read_file`；由 IT 断言 Hook 阻断时不会返回文件
正文，因此"工具从未运行"是物理证据，而不是状态读数。

## 用例

| 用例                          | 注入                                                                           | 期望                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-kill-during-command` | `PreToolUse` 命令 Hook 带存活后代保持运行；SIGKILL Harness；启动替换 Harness。 | 恰好一次物理调用。替换者的 load 回答被杀 Harness 的调用；命令仍持有时新 prompt 返回 409。随后把 Session 重新 attach 到替换者（被动恢复 load），通过 Harness 的认证状态路由读取该操作——该路由向记录里的原 `runtimeSessionId` 取证，用 worker 内存中的回执结算记录。记录结算为 `settled` 且有 result；单元到达 `populated 0`，结算时 worker 与 generation 不变。 |
| `worker-kill-during-command`  | 同样的保持型 Hook；SIGKILL durable worker。                                    | 记录变为 `recovery_blocked` / `outcome_unknown`，绝不是 `settled` 或 `cancelled`。恰好一次物理调用。命令与后代作为无 owner 的有进程单元存活。关闭被拒（409 `turn_active` 或 503），Session 保持打开。generation 不被重铸。                                                                                                                                     |
| `command-kill`                | 命令运行中 SIGKILL，且无后代。                                                 | 在已保存的 `failClosed` 策略下得到 `non_blocking_error`：记录结算，读取绝不返回文件正文，模型看到 Hook 的阻断。单元为空。                                                                                                                                                                                                                                      |

## 变异见证

每个见证必须在切片合入前变红。

- `harness-kill-during-command`：让 `executionBroker` 与 `lookup` 都使用当前
  owner，而不是记录自身的 `runtimeSessionId`。记录无法再从原回执结算，
  `settled` 断言失败。
- `worker-kill-during-command`：删除回执不可用时、抛出
  `HostedHookRecoveryRequiredError` 之前的 `recovery_blocked` 提交。记录会停在
  `running`，状态断言失败。（这里删掉 owner 检查会被掩盖，因为任何查询失败都已
  回答 `outcome_unknown`；见证必须删掉那个如实提交。）
- `command-kill`：让 `failClosed` 放行非成功结果。阻断断言失败。

## 非目标

FG13a、FG13b、FG13d、FG13e、FG13f 仍留在 #14449。同样不在本切片：本地非托管
Hook、Windows/macOS、#13133 的设计项、snapshot 子会话的 Hook 策略（#14440），
以及 prompt Hook 的 provider 故障（崩溃行之外的部分）。

## 验证

证据是 Linux + MySQL 8.4 + 委派 cgroup v2 根上的完整 `hosted-harness-mysql`
车道；macOS 上的 H2 运行不能建立任何一格。Checkstyle、SpotBugs 与 CI fork
预算守卫随新类一起更新。跳过的一格不是通过的门禁。
