# FG11f：automation wake turn 发布期的对象存储故障

[English](2026-10-19-automation-publication-fault-gates.md) | [简体中文](2026-10-19-automation-publication-fault-gates.zh-CN.md)

状态：第 1 片已交付。三条进程内故障臂——`fail-before-write`、
`drop-ack-after-write`、`timeout`——均已在打包栈上实跑绿。
第 2 片（发布者死亡）在此定界，尚未触碰。

Issue：#14446，FG11 tracker。tracker 的 gate 表把 FG11f 列为本轮欠的两片之一。
FG11c 已交付；本设计是剩余部分。

## 为什么

此前的 automation 门禁都止步于 automation 账本。FG11f 问的是另一个问题：
当对象存储出故障时，wake turn 发布的 **Shell 输出**会怎样，run 是否仍然恰好结算一次？

今天 CI 里没有任何东西回答它。内存版 OSS 桩
（`HostedGateTestSupport.stubPublicationOss`）接受每个对象，没有故障臂。
`ToolPublicationStoreTest` 在 H2 上注入失败写入。tracker 记载 `O4OssGate`
对真实 bucket 注入故障，但它是 opt-in、不在 CI 中。

本门禁钉住的生产接缝：

- `QwenHostedHarnessConnector.create` 在发布开启且会话 profile 为公开 Shell
  或内部 team lead 时下发 `captureBytes`（`create` 构建器）。
- `ToolPublicationRetentionStore` 通过
  `ToolPublicationObjectStore.putIfAbsent` 写入；写入抛错时把 `OBJECT_PUT`
  操作置为 `UNKNOWN`（`:630-641`）；重提会先读对象对账，只有读回无法证明该
  对象的尝试才以 `409 tool_output_put_unresolved` 拒绝。

## 夹具

用例落在 `HostedAutomationFaultGatesIT`：该类已经跑本域的打包栈——进程内
Spring（scanner 开启）、`HostedLifecycleRelay` 背后的真实 Harness、真实
MySQL schema 与模型桩。它的 `createSession` 本就建在工作区会话上
（`workspace-0` + `child`），因此不需要新夹具。它缺的是工具 profile：用例
自行从一份已存定义建会话，定义的 tools 指名
`hosted_profile: hosted-workspace-shell/1`，这也是服务端需要
`definition-tool-profiles` 的原因。

新用例启动时增加：

- `--qwen.managed-agent.definition-tool-profiles=hosted-workspace-shell/1`
  与 `--qwen.managed-agent.harness.workspace-shell-enabled=true`，使会话定义
  可以选择公开 Shell profile；
- `HostedGateTestSupport.toolPublicationArgs(port, bucket, bytes)`，与其他发布
  夹具相同的 16 项属性；
- 带故障计划的 OSS 桩，在启动前注册。

模型桩对该 wake turn 回一次 Shell 工具调用，再回一段最终文本。automation
定义指向该会话，于是 scanner 的 fire 唤醒 turn，Shell 输出被捕获并发布。

## 注入

桩扩展为可选的故障计划，而不是再注入一个 `ToolPublicationObjectStore`
bean。故障打在 `OSS` 客户端上，真实的 `AliyunToolPublicationObjectStore`
适配器仍在路径上，因此门禁同时覆盖它的错误映射
（`ToolPublicationStorageException`）；手写 store 会跳过这一段。

| 故障臂                       | 在 `putObject` 注入                                                      | 预期                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fail-before-write`          | 抛 `OSSException`（`InternalError`），不写对象                           | 操作留在 `UNKNOWN`；下一次尝试读对象对账，读不到，以 `409 tool_output_put_unresolved` 拒绝。工具结果如实失败或未知，Shell 不被重跑                                                                                                                                                                                                      |
| `drop-ack-after-write`       | 先写入对象，再抛 `ClientException`，让调用方分不清「已提交」与「已丢失」 | `OBJECT_PUT` 行短暂停在 `UNKNOWN`；重提仅凭该状态即被准入，此处没有 claim 可释放——`abandonScan` 只重置 capture 类操作，且 `OBJECT_PUT` 行插入时本就没有 claim owner。打包夹具里的调用方会以同一 operation 与同一份字节重提，store 随后读对象对账并结算为 `RETURNED`；断言钉住该终态、恰好一次物理 PUT、对象按字节一致可读、Shell 不重跑 |
| `timeout`                    | 静默超过 `operation-timeout`，再抛 `SocketTimeout`，不写对象             | 与 `fail-before-write` 同样被拒绝；wake turn 的 Workspace lease 被释放；一次 run、一次 Turn、一次执行                                                                                                                                                                                                                                   |
| `publisher-death`（第 2 片） | 在子 JVM 内扣住 put，随后 SIGKILL                                        | 重启后 run 从 journal 恰好结算一次；已提交的对象对账为 `RETURNED`，不存在的则被拒绝；Shell 不被重跑，lease 被释放                                                                                                                                                                                                                       |

两种形态刻意不同：`fail-before-write` 钉住拒绝
（`tool_output_put_unresolved`）与如实失败；`drop-ack-after-write` 钉住
「丢失的 ack 绝不靠**重写对象**或重跑 Shell 恢复」——对象已在，调用方的
重提靠读取它完成对账，断言钉的是最终 `RETURNED`，而不是「对象可读」就算过。
只注入一种形态会漏掉对账路径的另一半。

`publisher-death` 需要进程在 capture 中途死亡，因此使用子 JVM 夹具
（`HostedAutomationCrashFixtureMain`）而不是进程内类。第 1 片覆盖前三个臂。

## 断言

每个臂断言同样的四条性质，只有故障可见的部分不同：

1. **一次 run、一次 Turn。** `ma_session_record` 中该会话只有一条
   `automation_run`，且该 run 的持久 Turn 身份只有一个 Turn。模型桩的 prompt
   列表承载不了这条性质：Shell-then-final 会在同一个 Turn 内发两次模型请求。
   因此改为在 Harness journal 里按 occurrence 计数——`turn.settled` 事件的
   `turnId` 即该 run 的 automation 输入；或只计首次模型请求、排除 tool-result
   续轮。`ma_turn` 承载不了这条性质：automation 派发经 hosted 会话 journal
   提交输入，生产代码里 `ma_turn` 的插入点只有会话创建与公开输入准入。
2. **不靠重跑恢复。** `ma_tool_execution` 对这次 Shell 调用只有一行。丢失
   ack 绝不能换来第二次执行。
3. **结果如实。** 对象存在时，按字节与期望一致、经 store 可读；否则工具
   结果显式失败或未知，绝不伪造成功。
4. **恰好结算一次。** occurrence 恰好进入一次终态，wake turn 的 Workspace
   lease 被释放（没有留下的 `READY` owner 行继续持有）。

第 2 片在跨越 kill 后重复第 1、2、4 条。

## 夹具约束

第一条用例在打包栈上实跑后，暴露出夹具必须满足的三项要求。每项都花了一轮实跑才定位，记在这里避免重复试错：

- 开启 `harness.workspace-shell-enabled=true` 时，服务端默认的
  `approval-mode: yolo` 会被拒（`ManagedAgentProperties.validateWorkspaceFiles`），
  用例因此以 `default` 启动。
- 定义的工具指名 `hosted-workspace-shell/1` 时，准入拒绝 `yolo`
  （「Shell 定义必须以询问策略起步」，#13271）。用例以 `default` 存定义，
  并通过 `/api/agent/web-shell/v1/actions/{query,respond}` 应答 wake turn 的
  Shell 权限请求。
- 公开 Shell 的 wake turn 在任何故障臂之前就失败：非 durable broker 让
  Harness 得到 `409 workspace_unavailable`，换成 durable broker 加
  owner-private 状态目录后，turn 仍停在
  `WorkspaceExecutionStore.unavailable()`。应答 Shell 权限请求（即
  `HostedPublicWorkspaceIT` 驱动的 `actions/respond` 流程）也不改变结果。
  会话级 `authorize` 对普通会话与定义支撑的会话都通过，runtime session 也
  携带 Workspace 执行的能力摘要，因此拒绝位于 acquire/claim 路径内、尚未
  定位到具体分支；第 1 片必须先定位它，故障臂才有机会运行。

## 边界

- 故障臂打在对象存储，不打 Spring 与 OSS 之间的网络。`O4OssGate` 仍是唯一的
  真实 bucket 故障门禁。
- `publisher-death` 钉住发布者死亡，不钉 Harness 死亡。Harness 在 capture
  中途死亡属 FG11c 的 `turn-crash` 窗口。
- 审计点名的第二个缺口——stream gap（FG11e）——不在此处。

## 验收

- 每片在 JDK 21 + 真实 MySQL 8 上全绿，用 `-Phosted-automation-gates` 选择。
- 移除某个故障臂时，对应断言在其命名位置变红。
- 若该类运行时长变化，重组 `scripts/tests/hosted-process-ci.test.js` 的预算；
  第 1 片的类清单不变。
- 中英双语交付，结构一致。
