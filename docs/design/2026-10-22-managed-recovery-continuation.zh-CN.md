# Managed 恢复收敛与继续使用

[English](2026-10-22-managed-recovery-continuation.md) | [简体中文](2026-10-22-managed-recovery-continuation.zh-CN.md)

## 状态与问题

基于主干 `21337f0e5131` 实现，本地 macOS 验证已完成。Linux 物理 Workspace 与 cgroup 验收仍未验证。继续由现有 Hosted 取消、接管、原命令对账和清理机制负责执行。取消受理不等于 Turn 已有持久终态。基线中，部分已可能提交后的失败会在原生输入结清前结束 Java 派发，WebShell 则仅根据 Java Turn 状态推断能否发送。

## 决策

首版优先在原 Session 安全继续，无法继续时提供可编辑的文字交接。不增加通用恢复操作、表、迁移、MCP/Hook 续跑能力、历史克隆或模型摘要。生命周期退场与跨主机 HA 保持独立范围。

请求失败善后取消前，先在原 Turn 的有效派发租约下持久化仅做取消善后的恢复标记，使取消受理到终态投递之间的崩溃不会丢失意图。覆盖的所有 Hosted Workspace 已可能提交后的终态失败，都必须等待原 journal 终态及可准入的 continuation 边界；后者既可以是有效的下一轮检查点，也可以是可证明尚未形成 continuation 的初始状态。ACK、超时、租约到期和 SQL FAILED 均不能证明这些条件。并发用户取消保持现有优先级，原故障诊断保留在现有错误信息中。

未知结果保持停泊，只检查原身份，不重新提交输入或启动工具。原生终态已存在时只补投影与清理欠账。清理可以晚于 Java 终态，但只要仍阻挡下一轮就禁止发送。不重置永久受阻的 journal。历史 Java 终态若不能通过现有授权安全结清，则保持需运维处理；不改变 CANCEL 对终态的现有语义。

标记复用 `hosted_runtime_recovery_blocked` 和现有 Turn 错误信息。领取到标记后，先处理善后，再考虑任何普通 runtime 恢复或输入提交。重新检查只提前 `retry_after`，保留重试计数与有效 owner。证明原生结清后，在有效派发租约下通过既有 projector 回放原 journal 尚未消费的尾部；迁移 event epoch 时保留已消费水位，不得跳到 attachment 尾部。真实的完成／取消／错误终态负责结算 Java 及命令账本，并包含并发用户取消。尾部不可读时继续停泊，不以合成失败替换。停泊仍保留原故障诊断。常驻实例的取消接管若没有待恢复的 runtime 工作，仍需发送取消请求；其 ACK 同样必须通过执行证据门禁。Workspace 取消使用协商后的 `targeted-cancel/1` 协议，将原 prompt 身份保留到请求实际送达时：取消请求携带 `promptId`，取消接管加载携带 `cancellationPromptId`。任何可能产生副作用的加载或取消之前都要先验证能力；冷加载和迟到接管均不得以当前 Turn 替代原目标。原输入已结清时，迟到取消请求只幂等应答，不得中断后续 Turn。原终态已非最新时，目标取消接管加载直接拒绝，防止迟到应答替换后续恢复快照；尚未结清的原输入必须是唯一未结算的普通输入，已有排队唤醒输入不妨碍只结清它，也不得成为取消目标。原终态仍为最新时才返回安全 attachment，并在异步验证期间保持常驻实例的准入门禁。未知或不兼容目标保持受阻；对旧 Harness 不得默默降级为 Session 级取消。Legacy 的 Session 级取消保持既有行为。Managed-runtime 取消和继续的成功重放只有在持有的 Runtime 属于原 prompt 时才能重试手回；A 的终态重放不能释放 B 已恢复的 Runtime。这不扩展继续执行能力，也不改变其他已有继续失败分支的手回策略。

## 恢复视图与接口

恢复独立于 Session 生命周期和 Turn 结果。视图包含 `state`、`reasonCode`、公开 `turnId`、`nextTurnAllowed`、允许的操作及已知的下次检查时间，状态为 `recovering`、`awaiting_evidence`、`cleanup_pending`、`ready` 和 `operator_required`。Ready 要求 Java 无活跃 Turn、原生输入持久结清、continuation 可准入，且无阻挡的历史标记或清理欠账。读取错误不得证明 ready。

| 状态                | 证据与行为                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `recovering`        | 已有取消或恢复驱动正在推进，继续阻挡新输入。普通健康活跃 Turn 使用 `turn_active`，不展示恢复面板。                                  |
| `awaiting_evidence` | 原执行或结算未确认，只能重新检查原取消／对账驱动。                                                                                  |
| `cleanup_pending`   | 输入已有持久终态与可用 continuation，但文件历史或 runtime 清理阻挡准入；保留已确认结果。                                            |
| `ready`             | 四项准入条件均满足，不再提供重新检查或取消。                                                                                        |
| `operator_required` | 证据不可读、不兼容或永久受阻。冷态终态可以提供仅核验证据后清理的重新检查；永久受阻 journal 和已明确未结清的历史终态不能使用此入口。 |

增加只读公开恢复查询和 WebShell adapter。查询不得加载 Session、获取 Runtime、调用模型、停止执行或解锁。既有资源读取可能维护已持有的 writer 租约和读取校验元数据，但不会获取新的 writer 或执行 owner。扩展私有 Harness 状态响应及 SDK reader，提供明确的结算和准入证据；旧 Harness 缺字段不能证明已就绪。Session 响应增加可选恢复描述，保留现有生命周期状态。

增加针对原 Turn 的公开 recheck POST 及 WebShell adapter。重复请求合并，只唤醒已有对账、取消与清理；202 仅表示已安排，不表示停止或 ready。保持现有 claim、generation、重试预算及租户/Session 身份；旧请求不得操作后续 Turn。原 Turn 若在复查请求途中安全结清，则返回重新核验后的 ready 视图；目标已变或结果仍未证明时继续拒绝。查询沿用 Session 读授权，变更沿用取消/清理授权，同步 OpenAPI、SurfaceRegistry、SDK 和生成的 WebShell 类型。

| 接口                                                    | 作用域                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /v1/agents/sessions/{sessionId}/recovery`          | 只读所选 Session 的事实，不触发加载。                                                        |
| `POST /v1/agents/sessions/{sessionId}/recovery/recheck` | 请求体 `{turnId}`，只检查原最近 Turn。                                                       |
| `POST /session-recovery/query`                          | WebShell adapter，请求体 `{sessionId}`。                                                     |
| `POST /session-recovery/recheck`                        | WebShell adapter，请求体 `{sessionId,turnId}`。                                              |
| 私有 Hosted status                                      | 可选 `promptId` 将原生证据绑定原输入；定向读取不得清除 SDK 中更新一轮的 active-prompt 登记。 |

可选 Session 投影仅用于单 Session 读取；列表不逐个调用 Harness RPC。只有普通健康 Java 执行使用不显示面板的 `turn_active` 原因；恢复期间的原生忙碌转为 `harness_work_active`，避免隐藏准入限制。私有证据包含 `inputSettled`、`continuationReady` 与 `nextTurnAllowed`。检查点覆盖范围必须包含原终态前缀，且没有未结束的模型 attempt、工具、审批、子任务等待或其他待结算输入。工具调用与结果配对继续由既有 journal/checkpoint 权威机制保证。

没有 Java Turn 的 Session 也可能因改名而已有原生 journal。attachment 为冷态时，使用受限的只读初始状态证明：核验完整、未压缩的 journal 及其完整性，只接受 genesis、Session 激活与 Session 元数据事实，且没有检查点或执行输入；复读 head 排除变化中的视图。同一初始例外允许此前在可能提交前就已取消的 Java Turn，但必须核验完整 Java Turn 历史均无可能提交，且原生日志不存在或可证明为初始状态。只有从未绑定 Harness boot/epoch 时，无 head 才能作为初始证据；已有绑定身份却缺持久 head 的会话保持受阻，即使 warm 缓存报告 ready 也不能放行。最新一次未提交取消不能掩盖更早已提交的 Turn 或缺失的证据。未知事件或损坏证据保持受阻。此证明不获取 writer token、不锁行、不加载 Harness，保留重启后合法首条消息的准入。

初始证明还需将白名单 managed-definition 正文解析为 JSON 对象，因为原生冷加载必读该正文。摘要匹配本身不能证明这一必要凭证可读；此处不引入通用资源正文校验器。

显式重新检查遇到已核验的 Harness generation 变化时，沿用既有 connector 策略接纳新 generation，向调用方返回本次身份变化，不自动重发请求。后续显式重新检查再协商能力，并可进入仅清理加载。冷清理 attachment 发布前后均须通过当前 boot 校验；迟到的旧加载不能重新植入已逐出的缓存，也不能替换更新的 attachment。解析 attachment 和完成授权后，再获取当前 RPC client。恢复查询继续只读，不协商替代连接或加载 Session。

进程重启后，显式重新检查可以只加载原终态的清理工作。这要求协商 `recovery-cleanup/1`，旧 Harness 不能将请求默默解释为普通加载。清除历史标记或重试清理欠账前，核验原输入持久终态、就绪检查点或可证明的初始状态、无待结算输入及原 Workspace/generation。该路径不初始化扩展、不对账子任务、不唤醒 monitor/wake 循环，也不执行模型或工具。它保留仅供清理的 attachment，直至后续显式新工作加载将其升级；被动读取或改名加载保持该 attachment。损坏或未结清的证据直接拒绝，不改变 CANCEL 语义。

## WebShell 与文字交接

独立于执行 phase 展示受阻原因和有效操作，发送遵守恢复准入。持久化 Turn 取消幂等键，部署支持时跟踪原 durable operation；刷新和响应丢失不能产生另一条取消。只有确认终态才能显示已取消。页面可见时每五秒刷新未完成恢复，终态 SSE 到达立即刷新。

未启用 durable operations 时，已收到 ACK 的取消保留投递跟踪槽，直到同一原 Turn 有匹配的 ready 证据，或新读取的 Session 已选择后续 Turn。退休投递槽不表示原 Turn 已取消，也不开放发送；只有用户再次明确请求时，才取消后续 Turn。丢回复时保留原 Turn/key，durable operation 继续跟踪原操作直至取得操作终态。

新会话操作打开现有创建表单，预选仍有授权的 Workspace/cwd/Agent 并填入可编辑草稿，不自动创建或提交。确定性草稿最多 32 KiB UTF-8，优先保留来源身份、任务与最后用户请求、失败事实及最近已确认完成的用户/助手消息，明确提示截断和未知步骤。不复制部分输出、原始工具结果、未完成调用、审批、检查点/worker 身份或执行策略；交接始终作为普通用户引用文本。

以已完成 Turn 边界选取完整用户／助手消息。加入最近消息前，先为失败事实和截断提示预留空间；按 UTF-8 边界截断，超大的历史消息整条省略。来源标题和最后请求分别限长，为最近的完整历史保留容量。交接使用独立 composer 草稿作用域，保留无关新对话的草稿，避免插入后超过生成文字预算；已恢复的交接编辑内容继续可编辑。Agent 默认值仅在仍可用时保留，Workspace 回读和当前创建策略仍是权威。

继续使用现有创建幂等与 Workspace 准入。保留 READY binding 下普通 LOCAL/SSH_LOCAL 并发，包括 UNKNOWN 工具结果旁的无关 Session。LOST、DRAINING、OPERATOR_RECOVERY 和已证明的恢复屏障保持不变，新 Session 身份不能证明物理清理。

## 验证与验收

先以全局 CLI 确认基线；若该入口不能到达 Java 控制面路径，记录原因并使用聚焦测试脚本。覆盖取消受理早于原生结算、所有纳入的已提交失败、终态/清理提交前后崩溃、未知结果、无首个检查点的初始取消、owner/用户取消竞态和迟到响应，包括在后续 Turn 正在生成时重放原取消请求。确认无重复模型/工具副作用、旧 owner 不释放新资源，读取失败与旧 Harness 响应保持保守。

正向进程 fixture 将 Runtime Broker 及其 worker 放在独立进程中保持存活，只杀死并重启协调器／Session Store，并核验身份和原 binding generation 未变。重启同进程 Embedded Broker 属于另一种故障：其已有可信本机重启恢复开关要求 Linux。缺少该 Runtime 对账授权时，实际观察到的安全结果是保持受阻。本次变更不默认开启该开关，也不绕过平台门禁。

普通 LOCAL Workspace 执行沿用主干现有的共享 Storage 成员持有策略，独占 owner 行处于中性状态不能证明执行已释放。进程断言须核验唯一原成员、绑定身份与代际、Workspace 能力／profile、物理 Storage 和就绪 mount；独占持有仍保留原独占 owner 检查。共享 Storage 成员不代表不同 Session 共用 Runtime binding。

验证刷新后继续跟踪原取消、页面可见轮询、交接可编辑且不自动创建、源读取授权、UTF-8 上限、排除部分/工具内容和保持目标准入。运行受影响包测试、根构建/typecheck/bundle、Maven verify、MySQL 并发、API 契约及对应 Hosted 进程/故障测试，单列无法运行的检查。验收要求安全原会话能完成后续一轮，无法证明安全的会话保持受阻且能生成可用交接草稿。

2026-10-22 的最终本地结果按范围分别记录，不累计有重叠的重跑：

| 验证范围                          | 最终结果                                                                 |
| --------------------------------- | ------------------------------------------------------------------------ |
| 根目录 build、bundle 与 typecheck | 全部通过。                                                               |
| 原生 CLI 回归                     | 5 个文件、754 项测试，无失败或跳过。                                     |
| WebShell 回归                     | 7 个文件、479 项测试，无失败或跳过。                                     |
| 真实 Chromium                     | 使用受控 HTTP adapter 的 3 项场景通过，仅作为界面证据。                  |
| Java SDK verify                   | 403 项测试，无失败或错误，9 项配置性跳过。                               |
| 服务端完整单测/H2                 | 354 个类、5,280 项测试，无失败或错误，18 项已记录的条件性跳过。          |
| 真实 MySQL 8.4 集成               | 53 个类、1,067 项测试，无失败、错误或跳过。                              |
| 完整 Hosted 进程测试类            | 两个 JUnit 方法均通过，不使用场景选择器，实际覆盖全部 9 个窗口，无跳过。 |
| Java 静态检查                     | Checkstyle 违规为零；服务端 SpotBugs 缺陷与错误为零。                    |

真实取消收敛窗口在保留 Broker 和 worker 的情况下重启 Java，确认原工具仅执行一次、原终态得到投影，并在下一轮活跃期间重放原取消后，仍使同一 Session 的下一轮完成并输出 `FOLLOW_UP_OK`。确定性模型响应证明所覆盖的执行协议，不证明真实模型质量。`HostedRecoveryWedgeGate` 已执行，其唯一 Linux 物理 Workspace 测试在 macOS 上按条件跳过，不能计为 Linux 验收通过。仅限 Linux 的 `HostedShellLifecycleRecoveryIT` 与 `HostedExtensionsIT`，包括后者所需的 delegated cgroup，仍未验证。忽略的执行报告保留原始失败、主动中断、修正后的最终运行及平台后续命令。

## 交付

先实现执行证据、取消善后意图持久化和恢复接口，再完成 WebShell 操作、取消跟踪与交接。两种语言同步。永久 journal 修复与公开 Shell 生命周期扩展保持独立工作范围。

本版没有未决产品选择。主要风险为误判 ready、崩溃丢失取消善后标记、旧 owner 清理，以及误入普通加载路径。测试必须断言可观察副作用和原身份。本地 macOS 结果不能证明 Linux cgroup 专属验收；应明确记录跳过，不算作已通过的进程故障覆盖。[E2E 计划](../plans/2026-10-22-managed-recovery-continuation-e2e.zh-CN.md)定义场景与命令，本次详细执行证据保存在 `.qwen/e2e-tests/managed-recovery-continuation.md`。
