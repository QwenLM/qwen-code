# Managed Agent 全量设计与交付覆盖表

更新日期：2026-09-11；生产源码基线 `a836081466`，上一轮核心设计 `4cacfbd0ed`。本稿将 daemon 默认替换的 C01～C18 全部纳入详细设计，包括原先延期能力。设计覆盖、源码实现、产品验收分别记录；本轮只交付设计，不改变首阶段默认启用范围、不重跑历史产品、不操作当前预览或用户数据。

## 1. 完整目标与边界

普通 daemon 的新会话最终通过统一 Session 接口使用完整 Managed Agent：Session 保存权威状态；Harness 复用原 Agent；Runtime 执行所属环境的本地操作；coordinator 负责准入、激活、接管和关闭。Web Shell、REST、ACP、SDK、Channels、定时、Goal/Live、子任务/记忆和旧会话操作都在覆盖表中；不再把延期实现解释为延期设计。

全量指本仓库 daemon 能力的完整迁移及明确的平台/故障契约，不承诺任意外部副作用 exactly-once、任意进程快照或任意旧二进制可写新格式。恶意进程安全沙箱、SaaS多租户平台、Kubernetes/VM部署模板和独立CLI/TUI默认引擎仍在原目标边界外；执行环境接口及扩展条件已经定义，不需以它们作为本地daemon迁移前置。

两条全局口径与上面的目标边界同级，各专项不得各自放宽：

- **执行 continuation 依赖 checkpoint 与原回执恢复。** 仅有展示/领域事件不能重建完整 Agent 内部状态；已引用 checkpoint 缺失或损坏时必须阻塞。新建及已提交历史维护的合法无 checkpoint 起点采用存储 §2.2 的初始化分型，不是失败降级。状态外置后不要求原 handle 永久存活，合作式替换仍须安全点，崩溃恢复须核验原调用。理由与范围见[全局架构](managed-agent-session-harness-runtime.md)§7。
- **执行保证是 at-most-once 派发，不是外部副作用 exactly-once。** 派发次数由稳定 executionCallId、门禁与回执去重控制且可证明；某次已派发操作在外部世界发生几次不可观测，started 无终态一律保持未知。见[私有协议](managed-agent-control-protocol.md)§5。

首版可恢复范围限于原 coordinator 与原 Runtime binding 存活时更换 Harness；daemon/worker 自身重启后的未决副作用保持 recovery_blocked，跨进程接管所需的持久 binding 与门禁账本属于[恢复与运行](managed-agent-recovery-operations.md)的后续切片。

## 2. 统一接口与实现关系

| 接缝                                  | 目标实现/组合                                                                        | 固定边界                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| SessionRepository / 兼容查询          | LocalSessionRepository复用目录、transcript reader及维护能力；legacy与Managed格式适配 | 列表/历史无需完整Harness；展示容错不授予执行资格                             |
| SessionAuthority / RecordSink         | 单writer本地Managed authority，旧record sink适配保留原best-effort                    | 物理日志、强提交、幂等、epoch与领域事实唯一；不把全部旧void方法改成Promise   |
| SessionExecutor                       | LegacySessionExecutor与ManagedSessionExecutor，Bridge创建时固定选择                  | 同Session不热切engine；公开返回、同步准入、队列、权限与close沿原契约         |
| HarnessFactory / Handle               | 完整QwenAgent/ACP Session/LlmChat适配；实验ResidentRunner保留实验入口                | 一个handle一次activation；接口能力声明可恢复范围，不强迫legacy假装支持detach |
| RuntimeProvider / RuntimeReceiptStore | Local/owned/remote provider使用相同工具、gate与回执契约，按平台配置实际process owner | 不推进模型，不持有模型凭据，不把旧Map或新PID当恢复证明                       |
| coordinator / 领域适配                | 单Session激活与共享容量；schedule/child/channel/history等domain命令和outbox          | 不产生第二模型循环或第二Session日志；跨Session使用幂等接收，不假装跨文件事务 |

接口首先是代码和生命周期边界，不要求立即拆成多个部署服务。首版保持daemon承载authority、可共享的完整ACP host、独立Tool-only worker。未来更换持久后端、Harness位置或Runtime载体时，必须实现相同提交/权限/恢复契约，并通过同一契约测试。

## 3. 全量能力覆盖

下表“已定义”表示本次设计已作选择并列出接口、状态、失败/迁移和验收，不表示对应代码完成。旧专项的实现证据仍由总方案单独维护，不累加成“全量已验证”。

| 能力                      | 详细设计与关键决定                                                                                                                                               | 实现阶段 / 验收索引               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| C01 完整Agent             | [Harness](managed-agent-harness.md)：完整模型循环、原prompt/压缩/预算/停止、九组checkpoint、正式调用ID；不改用精简Runner                                         | R2.S2/S3；H01/H02/H05/H06         |
| C02 owner/双通道          | [兼容映射](managed-agent-session-method-map.md)、[引擎](managed-session-execution-engine.md)：创建固定owner、真实回执、共用准入                                  | R1保留，R2.3/R3；U01/U06          |
| C03 有效配置/初始化       | [配置与扩展](managed-agent-config-extensions.md)：RootSnapshot、有效版本、全部来源和动态变更、真实初始化consumer                                                 | R2.1/2.2与R5；E01/E02             |
| C04 全部内置工具          | [工具与历史](managed-agent-tools-history.md)：工具族清单、分阶段效果/模型归属、漏注册拒绝、完整原生语义                                                          | R2保留已迁移工具，R5扩大；T01/T02 |
| C05 审批与问答            | [客户端](managed-agent-client-surfaces.md)、[协议](managed-agent-control-protocol.md)：领域action、票与最终持久决定、原参数绑定、失联策略                        | R2.S3/R3；H03/U03                 |
| C06 媒体/产物             | [媒体](managed-agent-media.md)、[工具与历史](managed-agent-tools-history.md)：模型与物理处理分离、资源pin/授权、完整内容和取消                                   | R5；T03/T04/U04                   |
| C07 Skills/指令           | [配置与扩展](managed-agent-config-extensions.md)：可信根和文件版本、模型展开、脚本Runtime执行及热更新                                                            | R5；E03                           |
| C08 MCP                   | [配置与扩展](managed-agent-config-extensions.md)：stdio/http、工具/resources/prompts、鉴权与动态版本、未知效果恢复                                               | R5；E04/E05                       |
| C09 Hooks                 | [配置与扩展](managed-agent-config-extensions.md)：触发矩阵、命令/HTTP/模型owner、输入输出和次数、取消/失败                                                       | R5；E06/E07                       |
| C10 Channels              | [自动任务与交付](managed-agent-automation.md)：事件接收、Session路由、附件、持久delivery outbox和unknown策略                                                     | R5；A01/A02                       |
| C11 定时/内部继续         | [自动任务与交付](managed-agent-automation.md)：手动persistent/per_run、自动fresh child/原队列、Goal/Live、run锁与去重                                            | R5；A03/A04/A05                   |
| C12 child/background/记忆 | [自动任务与交付](managed-agent-automation.md)、[子作用域](managed-agent-child-scopes.md)：稳定child运行、父接受、团队/任务板/信箱、后台进程和记忆发布            | R5；A06/A07                       |
| C13 物理历史/撤销         | [工具与历史](managed-agent-tools-history.md)：maintenance gate、文件前后像与操作日志、部分失败恢复，不称跨文件原子                                               | R5；T05/T06                       |
| C14 旧会话/fork/转换      | [存储](managed-agent-session-storage.md)、[工具与历史](managed-agent-tools-history.md)：schema guard、旧前缀、独立新Session转换、原owner保留                     | R2.S1/R5；S02/S06/T07             |
| C15 事件/用量/通知        | [客户端](managed-agent-client-surfaces.md)：正式sequence与兼容bus、attempt用量、终态/物理holds、通知去重                                                         | R2.S2/R3/R5；U04/U05/U07          |
| C16 Runtime/生命周期      | [coordinator](managed-agent-coordinator.md)、[恢复与运行](managed-agent-recovery-operations.md)：四factory、原binding接管、retired清理、共享预算                 | R2.S2/S3/2.3/R5；C01～C08/O02/O05 |
| C17 故障/平台/观测        | [恢复与运行](managed-agent-recovery-operations.md)：持久phase、Windows Job/Linux cgroup/进程组、远端挑战、具体性能门槛                                           | R3/R5；O01～O07                   |
| C18 默认切换/回退         | [实施计划](../plans/2026-09-09-managed-daemon-default.md)、[客户端](managed-agent-client-surfaces.md)：按purpose/config/profile证据扩大，新建开关不改变已有owner | R4/R5；U01/U06/O07                |

每个C项的详细接口见对应专项；表中验收编号只在所属文档命名空间内唯一，不与总表C编号或其他专项编号混算。18项没有以“以后再决定归属/协议”作为设计结论；实现出现新消费者时必须回到对应专项更新契约与覆盖。

## 4. 此前待定问题的决定

| 原缺口                                 | 本轮决定                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| schema、提交标记、载荷额度             | [存储规范](managed-agent-session-storage.md)确定ChatRecord subtype、lock schema 3、typed事件、事务可见性、引用闭包和数值表；源码validator按规范实现 |
| QWEN_HOME/system/extension/runtime来源 | RootSnapshot固定根/来源，EffectiveConfigRevision固定有效值；各层显式注入，不能逐Session改process.env或混用不同根                                    |
| 自动fresh child回执不明                | 持久run/outbox+目标runId接收去重；不明先查原目标，只有证明未受理才能切换原回父路径                                                                  |
| MCP/Hook/Skill边界与热变更             | 各域有明确definition/binding revision和执行owner；新调用采新有效版本，已批准/在途调用保留原版本，撤信任立即封工作                                   |
| worker/daemon重启                      | 独立持久RuntimeReceiptStore和phase状态；原settled恢复、原running认证attach、unknown明确blocked；工具专用reconcile不等于任意重跑                     |
| fork/rewind/跨engine转换               | 已验证历史/检查点边界、维护排他和资源闭包；合法 null 起点遵守存储 §2.2，转换创建新ID，物理回滚逐文件记录和可核验恢复；不原地改engine或掩盖部分失败  |
| Windows/Linux与性能                    | 原生process owner后端、存储profile和失败返回已定；固定基准方法及验收阈值，未实现/不合格profile不启用默认                                            |

这些决定不是对不可证明效果的保证。unknown、unsupported、部分失败是有定义的结果，需要完整客户端呈现和恢复操作；不得在全量覆盖表中把它们写成“执行成功”。

## 5. 全量实施顺序

维持R1～R5编号：R1已有owner/Bridge成果保留；R2.S1实现Session记录/兼容与类型，R2.S2接完整Harness和基础gate、A/D安全点，R2.S3接B/C持久等待与原Runtime接管；R2.1/2.2补严格配置和用途，R2.3/2.4接四factory；R3普通入口与故障验收；R4只启用有证据的有限范围。

R5拆为可审查的能力片：F1配置/Skills及剩余初始化；F2工具族和媒体/产物；F3定时/Goal/Live、child/background/记忆；F4 MCP；F5 Hooks；F6 Channels；F7历史/转换；F8 worker/远端恢复、平台与压力。每片使用本轮已定义契约，实现→定向测试→原入口与实际进程验收→更新允许范围。依赖关系以数据/执行契约为准：Channels交付依赖持久输入/终态和F3 outbox，跨worker接管依赖持久phase，物理rewind依赖备份/资源/maintenance，MCP/Hooks依赖版本化配置与gate。

设计可以并行审查，实现不为了“全量一次交付”把全部core重写成一片。F编号不取代R阶段或C能力编号；每个PR指出覆盖哪些C项、哪些场景仍未通过。

## 6. 完成判定与校验产物

设计完成的标准：每个C项都有职责、实际源码接缝、数据/命令、状态与版本、失败/恢复、迁移/回退、验收；跨域字段一致、链接与镜像可核对，公开方法覆盖无缺失。数值表、状态和不支持边界必须写明，不能以“可扩展接口”代替具体消费者。

实现完成的标准：对应validator/适配与真实生产者消费者已接线；普通入口及故障矩阵有冻结源码/构建证据；预览、用户数据与旧owner不受损；平台和性能满足各自门槛；C01～C18每个适用项均有实证。当前所有新设计仍处于待实现状态，已有专项绿色测试不替它们背书。

本轮文档验收检查完整链接、镜像、历史正文、268项公开方法覆盖以及全量C项到专项的映射。产品E2E按各专项的动作和观测实施时执行；不因文档有验收表就填“产品通过”。
