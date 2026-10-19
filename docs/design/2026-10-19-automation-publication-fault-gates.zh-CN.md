# FG11f：automation wake turn 发布期的对象存储故障

状态：提案。第 1 片（进程内故障臂）与第 2 片（发布者死亡）在此定界，均未实现。

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
  或内部 team lead 时下发 `captureBytes`（`:1082`）。
- `ToolPublicationRetentionStore` 通过
  `ToolPublicationObjectStore.putIfAbsent` 写入；写入抛错时把 `OBJECT_PUT`
  操作置为 `UNKNOWN`（`:630-641`）；对未决写入的后续尝试以
  `tool_output_put_unresolved` 拒绝。

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

| 故障臂                       | 在 `putObject` 注入                                                      | 预期                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fail-before-write`          | 抛 `OSSException`（`InternalError`），不写对象                           | 操作留在 `UNKNOWN`；下一次尝试读对象对账，读不到，以 `409 tool_output_put_unresolved` 拒绝。工具结果如实失败或未知，Shell 不被重跑                                                  |
| `drop-ack-after-write`       | 先写入对象，再抛 `ClientException`，让调用方分不清「已提交」与「已丢失」 | store 保留对象、`OBJECT_PUT` 停在 `UNKNOWN`，调用内不重试（`abandonScan` 只释放 claim）。是否有下一次尝试取决于调用方，因此断言只钉：对象按字节一致可读、工具结果如实、Shell 不重跑 |
| `timeout`                    | 静默超过 `operation-timeout`，再抛 `SocketTimeout`，不写对象             | 与 `fail-before-write` 同样被拒绝；wake turn 的 Workspace lease 被释放；一次 run、一次 Turn、一次执行                                                                               |
| `publisher-death`（第 2 片） | 在子 JVM 内扣住 put，随后 SIGKILL                                        | 重启后 run 从 journal 恰好结算一次；已提交的对象对账为 `RETURNED`，不存在的则被拒绝；Shell 不被重跑，lease 被释放                                                                   |

两种形态刻意不同：`fail-before-write` 钉住拒绝
（`tool_output_put_unresolved`）与如实失败；`drop-ack-after-write` 钉住
「丢失的 ack 绝不靠**重写对象**或重跑 Shell 恢复」——对象已在，后续尝试靠
读取它完成对账。只注入一种形态会漏掉对账路径的另一半。

`publisher-death` 需要进程在 capture 中途死亡，因此使用子 JVM 夹具
（`HostedAutomationCrashFixtureMain`）而不是进程内类。第 1 片覆盖前三个臂。

## 断言

每个臂断言同样的四条性质，只有故障可见的部分不同：

1. **一次 run、一次 Turn。** `ma_session_record` 中该会话只有一条
   `automation_run`，且模型桩对该 occurrence 只看到一次 prompt（按次数，
   不按时序窗口）。
2. **不靠重跑恢复。** `ma_tool_execution` 对这次 Shell 调用只有一行。丢失
   ack 绝不能换来第二次执行。
3. **结果如实。** 对象存在时，按字节与期望一致、经 store 可读；否则工具
   结果显式失败或未知，绝不伪造成功。
4. **恰好结算一次。** occurrence 恰好进入一次终态，wake turn 的 Workspace
   lease 被释放（没有留下的 `READY` owner 行继续持有）。

第 2 片在跨越 kill 后重复第 1、2、4 条。

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
