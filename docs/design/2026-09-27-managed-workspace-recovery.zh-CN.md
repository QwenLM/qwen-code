# Managed Workspace 恢复与回收（W0e）

[English](2026-09-27-managed-workspace-recovery.md) | [简体中文](2026-09-27-managed-workspace-recovery.zh-CN.md)

状态：W0e-1/2/3 源码实现，2026-09-28。专用 Linux 物理重启验收仍待完成。基线：`e0b8bea9e0ba369a0661bc51cbbb9a27555aff48`。

关联：[路线图 #12380](https://github.com/QwenLM/qwen-code/issues/12380)、[丢失执行 #12670](https://github.com/QwenLM/qwen-code/issues/12670)、[本地 worker #12766](https://github.com/QwenLM/qwen-code/issues/12766)、[W0c-3](2026-09-26-managed-workspace-execution.zh-CN.md) 和 [W0d](managed-workspace-w0d-web-shell-binding.zh-CN.md)。

## 1. 问题与已核验基线

W0d 允许用户创建和查看固定的 Workspace 绑定。恢复必须在保留该绑定的同时安全释放物理资源。修改默认 Workspace 或重新选择目录都不是恢复操作。

生产本地进程 provisioner 报告持久类型 `local-process`，但 worker 归属只保存在内存。Broker 重启后，即使旧 worker 已退出，它仍观察为 `UNKNOWN`。默认对账截止期是四倍 30 秒操作租约。超时释放对账认领，但绑定仍为 `READY`。正常关闭会向持有的 worker 发送终止信号，却不退役持久绑定；Broker 崩溃可能留下仍存活的 worker。

仅供测试的可恢复 provisioner 记录 worker PID 和启动时间，可以驱动已合入的 Broker 对账路径，但它既不是生产身份存储，也不能证明所有写入者都已停止。它报告 `NOT_FOUND` 后，Broker 持久化 `LOST`，未终结执行便会永久钉住该代数。`reconcileExecution` 对孤立的 `EXECUTING` 记录返回 `IN_FLIGHT`，只为 `UNKNOWN` 记录查询证据。

在此基线上，使用真实 Broker JVM、全局 qwen 0.24.6 worker 和持久化 H2 运行了现有 `ProcessCrashFaultGateTest#aHostCrashPinsTheLostGenerationBehindTheUnsettledCall`。测试通过的是对缺陷的断言：`warm`/`acquire` 返回 `runtime_broker_runtime_lost`，`release` 返回 `runtime_reconciliation_required`，执行停留在 `EXECUTING`，没有重放或替代 worker。这是基线证据，不是恢复实现通过验证。该测试杀死指定进程，不能证明真实宿主机重启或包含逃逸子进程的隔离域已停止。

基线还存在无需 Broker 重启的不安全复用：存活 Broker 观察到 worker 死亡后，经 `invalidateBinding`/`failBinding` 将绑定改成 `FAILED`，即使仍有未解决调用或逃逸写入者也会创建替代者。另一种情况是旧 Broker 在其他 Broker 提交 `LOST` 后继续准入新执行，再沿同一失败路径退役已钉住的代数。W0e-1 关闭这两条路径，因此仅 worker 故障（包括 OOM 或 SIGKILL）会让 placement 一直不可用，直到获得独立停写证明；W0e-1 不提供该证明的生产来源。原有 `aWorkerKilledMidExecutionLeavesItUnknownWithoutEvidence` 和 `aReplacementWorkerRunsNothingUntilItsOwnContextIsInstalled` 故障门禁必须改为断言阻止替代，而非自动恢复。

## 2. 对 #12670 的建议决策

新增独立执行状态 `ABANDONED`：原 Runtime journal 永久不可用，结果仍未知，可以结束结果轮询。它不携带 `executionStatus`、result 或 `settledAt`。持久化 `abandonedAt`、原因 `runtime_lost` 及原代数丢失证据的引用。保留执行身份、幂等 key、请求摘要、reference、取消意图、序列和最后的 dispatch claim。`SETTLED` 继续表示有现有证据支持的执行结果。

原 Runtime 的权威丢失证据持久化后，`PREPARED`、`DISPATCHING`、`EXECUTING`、`CANCEL_REQUESTED` 和 `UNKNOWN` 都可以进入 `ABANDONED`。五种状态使用同一保守规则，不伪造成功、失败、取消或 `not_started` 结果。若原 `SETTLED` 结果先提交，则保留它。迟到完成、取消、续租、dispatch 接管和人工 UNKNOWN resolution 都不能修改已放弃记录。相同幂等 key 永不再次启动物理执行，包括新代数已经存在时。

**结束结果查询不代表允许复用资源。** 在取得独立、持久化的“旧执行域无法继续写入”证据之前，`LOST` 绑定及其 Runtime Session 继续被钉住。此门禁同时覆盖 legacy boot v1 和 managed boot v2；legacy placement 没有 Workspace holder 提供第二层保护。

保留 `isSettled()` 表示有结果的记录。为控制流增加明确的终态谓词，并区分结果等待计数与代数的物理复用门禁。不能全局替换所有 `!isSettled()` 检查，从而把 `ABANDONED` 变成隐式解锁。

建议先确定此规则，再启用 #12766 的持久生产接管。它不需要 Stage G 恢复 Hosted Turn：W0e 记录不确定性并回收资源，Stage G 决定逻辑 Turn 的继续执行、历史和用户处理。

## 3. 证据与授权

丢失和停止写入的证据必须绑定精确的 binding ID/generation、Runtime identity/incarnation、资源身份和宿主身份。证据带版本、来源与观察时间，回收后继续保留。来源是可信 provisioner 或宿主监督器，不能来自浏览器请求、客户端路径、猜测的 PID 或调用方提供的 `force` 标志。证据更新必须单调，不能覆盖冲突身份或降级已有停止证明。

| 观察                                                              | 结果查询                           | 物理复用                                                |
| ----------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------- |
| 网络失败、超时、认领过期、进程记录缺失或损坏                      | 保持未解决                         | 阻断                                                    |
| 精确 worker 身份被证明永久不存在                                  | 持久化丢失证据后可记录 `ABANDONED` | 等待停止写入的证明                                      |
| 来自可信 OS 来源的同宿主 boot identity 改变，且存在崩溃前持久记录 | 记录永久丢失                       | 证明旧执行域属于该宿主启动周期后可回收                  |
| 可信隔离监督器证明精确旧执行域为空且无法重新启动                  | journal 丢失时记录永久丢失         | 可回收                                                  |
| worker PID 消失、PID 复用、已发送 SIGTERM，或单次后代快照为空     | 至多证明 worker 丢失               | 阻断                                                    |
| 原 worker 关闭 Session activation gate 并报告无活动调用           | 保留真实 journal 结果              | 仅适用现有正常释放语义；不能证明逃逸 Shell 子进程已停止 |

首条成功的崩溃回收路径应面向现有单宿主、本地存储部署，验证真正的宿主机重启。没有可信 boot identity 的平台保持阻断。仅 Broker 重启时，可在完整身份检查后接管存活 worker 的原始 status/cancel/release。可信恢复/清理使用保存的归属与服务鉴权；新执行另行要求当前 actor grant。不自动恢复或重放 Hosted Turn。

当前工具 profile 包含 Shell，并允许分离的后代进程。根 PID/启动时间检查、进程组 kill 或 SQL epoch 都无法单独证明这些后代已停止。通用 worker 崩溃回收需要可整体终止的隔离域，或另行版本化的受限工具 profile。W0e 不会把已有冻结 profile 悄悄解释为仅文件工具。远端文件系统及外部副作用需要独立的隔离契约；本文的宿主重启证明仅覆盖管理员配置的本地存储。

它还要求可信工作负载无法安排记录域之外的写入者，包括重启后恢复的 cron、launchd 或 systemd 任务。boot identity 改变仅证明旧进程退出，不能证明外部调度器无法重新创建它们。无法建立该前提时，即使重启也继续阻断存储。

## 4. 持久恢复顺序与并发

恢复在每一步持久写入后都必须有界、幂等且可重启：

1. 为精确绑定代数认领对账。在 SQL 事务外观察；提交观察前重新核对 owner、代数和身份。`UNKNOWN` 在现有截止期内重试，身份冲突保持阻断。
2. 提交丢失证据和 `LOST`，阻止该代数新增 Runtime Session 和执行准入。旧 Broker 不能在此屏障后再插入 `ACQUIRING` 或 `PREPARED`。
3. 用状态/版本检查，分有限批次将剩余非终态执行标记为 `ABANDONED`。并发有效结算可先提交，迟到结算不能复活已放弃记录。缺少停止写入证据时保留所有物理占用。
4. 停止写入证明持久化后，在本地释放精确代数的 Runtime Session。不能向替代 Runtime 发 transport 请求为旧代数作答。逻辑 Managed Agent Session 及其 Workspace 绑定保持完整。
5. 对 managed storage，检查证据和原 holder 身份后，条件清除匹配的 holder。写入前后崩溃均可安全恢复；旧重试不能清除新 holder。撤销产品访问权可以阻止新工作，但不应阻止可信服务按保存的身份执行物理清理。
6. 持有绑定认领时，再次检查无活动引用且停止写入证明成立，退役旧绑定，再允许正常 provisioning。新的工具回合使用新 Runtime Session ID。回收不能为已有逻辑 Session 改选 Workspace、存储映射或配置。

SQL 并发边界必须实际实现，不能从 Java `synchronized` 推断。今天 Session 校验和执行插入是不同事务，迟到插入可能发生在 abandonment 扫描之后。新准入与丢失屏障必须锁定同一 binding-generation 行，并在插入事务内验证其状态。统一锁顺序为 binding、Runtime Session、execution；批量 execution 行按稳定 key 排序。屏障后拒绝新准入，但允许按身份读取已有幂等回执。绑定复用在同一屏障下完成最终引用检查。内存测试存储必须提供等价的共享协调边界。

服务端存储清理是停止证明持久化后的独立条件事务。SQL 事务不能跨 HTTP、进程终止或宿主观察。数据库失败意味着保留或重新核查占用，不能解释为清理成功。`FAILED` 绑定或通用 `releaseUnusableSession` 路径都不能绕过物理复用门禁，包括存活 Broker 的普通故障处理；`LOST` 只能经证据校验的原子恢复路径离开。

旧执行域被钉住时，placement 映射必须保持稳定。当前 placement key 包含目录、capability、isolation 和 provisioner；改变它们可能产生看不到旧绑定的新 slot。准入替代者前，必须将保存的原 placement 与可信部署映射比较，拒绝会绕过未回收执行域的变更，包括没有 storage holder 的 legacy placement。新 request key 下的空 slot 不构成放行依据。本切片要求在改变物理映射/profile 前停止相关工作并完成已验证清理；跨 placement key 的在线迁移需要另行提供物理资源门禁。

## 5. #12766 的生产本地 worker 身份

在 Workspace 根目录之外、管理员拥有的目录中，持久化带版本的每代资源记录。记录关联现有 provision seed、绑定代数、host/boot identity、worker PID/启动身份和已校验的回环 endpoint。令牌继续保存在现有加密 SQL seed 中，不能进入文件名、资源句柄或诊断输出。符号链接、权限、损坏及身份冲突均拒绝，不能当作资源不存在。缺失记录不构成证明。该目录不是针对恶意同 UID worker 的安全边界：当前部署假设工具可信。准入不可信工作负载前，需要 OS 隔离保护恢复权威，仅放在 Workspace 之外还不够。

身份协议必须覆盖创建进程到 Broker 持久化 `READY` 之间的窗口。仅复制测试辅助实现中启动后的 `Files.writeString` 会留下未登记 worker。复用现有 stdin boot 屏障：worker 在 EOF 后解析完整 boot 文档，之后才开放监听。spawn 前持久化 launch intent，写第一个 boot 字节前，原子发布并同步真实 `Process` 的 PID/start 身份。Broker 在此之前被杀只会留下空/不完整 boot，worker 不能准入工具。校验 ready 后，先发布 endpoint 再报告 provision 成功。崩溃后 endpoint 缺失仍属未解决，不能因此再启动一次。

持有同一 seed 的跨进程文件锁，覆盖 spawn、身份持久化、boot 和 ready。观察方无法取锁时返回 `UNKNOWN`，不能在迟到启动者仍可能启动时证明资源不存在。退役取得同一锁，并保留禁止该 seed 再启动的持久 tombstone。失败时终止可核验的已持有进程，保留身份/intent 直到其处置被证明；不能删除未解决记录。缺少新版身份的旧通用资源句柄保持不可恢复。配置的命令必须直接运行遵守此 boot 协议的可信 worker；不支持在 boot 前执行工具或继续持有其 stdin 的包装器。此方案不需要新的 boot wire version 或 worker 自登记路由。

存活进程只有在 PID/start/host 身份检查，以及 Runtime identity、lease、incarnation、scope 和 storage identity 的完整 placement attestation 后才能接管。每个 Session 的冻结 context 另行通过现有 context-install 与 activation receipt 验证，不属于 placement attestation envelope。读取记录不授予执行权，新执行的当前 grant、存储 holder、目录身份和 activation receipt 仍适用。并发 Broker 必须通过现有 binding claim 收敛。接管不生成新 token/epoch，也不能让旧 Broker 在丢失屏障后准入新执行。

不能同时要求无条件随父进程死亡退出，又要求透明接管存活 worker。本方案允许已登记 worker 在 Broker 故障后存活，供后续对账使用，每次尝试有界；未完成登记的启动必须失败关闭。关闭 Broker 时脱离可恢复 worker。显式退役必须先持久阻断精确代数并取得退役权，再请求终止并验证停止证据。adoption map 条目和短期对账 claim 不代表生命周期独占权：多个 Broker 可以观察同一 worker，因此关闭其中一个不能无条件杀死它。新启动和接管的 worker 都需要纳入资源计数。发送 SIGTERM、`close` 返回或删除内存条目，都不代表成功退役。自动回收仅为下一切片验证过的证明来源启用。

## 6. 接口、存储与消费方变更

| 层 / 已有消费方                                                                       | 计划变更                                                                           |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ToolExecutionRecord`、内存/JDBC 仓库                                                 | `ABANDONED` 不变量、放弃时间/原因、终态不可变、作用域计数与准入屏障                |
| `RuntimeBindingRecord`、仓库、`RuntimeBrokerService`                                  | 持久证据、有界放弃/释放、最终物理复用门禁、隔离迟到回调                            |
| `RuntimeSessionRepository` 实现                                                       | 原子的按代数准入与释放；不能在丢失后迟到插入                                       |
| `ExecutionReconciliation`                                                             | 从账本返回明确 `ABANDONED`，不询问新 worker                                        |
| `RuntimeBrokerHttpServer`                                                             | 进程丢失/释放后读取原终态记录；按保存的归属和 scope 校验，不要求存活的本地 Session |
| `broker-managed-runtime-provider.ts`、`managed-runtime-provider.ts`                   | 保留终态不确定性；结束轮询/重放，不展示伪造的 Tool 结果                            |
| `WorkspaceExecutionStore`、`WorkspaceRuntimeTransport`、`WorkspaceRuntimeProvisioner` | 基于精确停止证据条件清理 holder；新执行使用当前授权；清理使用保存身份              |
| `LocalProcessRuntimeProvisioner`、worker boot/ready 入口、embedded Broker 配置        | 版本化持久启动身份、接管与验证后的退役                                             |
| 独立 Broker schema、服务端 Flyway schema                                              | 用兼容默认值增加证据和放弃字段；共享 JDBC 契约测试                                 |

对已放弃结果保留现有私有 HTTP 错误 `runtime_broker_execution_unknown`，增加明确 terminal/reason 元数据，使已有调用方继续结束成功结果轮询。Java 对账使用新 outcome。一起审计 TypeScript adapter 的 inspect/reconcile/cancel 路径；未知结果不能变成 `settled`、成功或可自动重试。`:resolve` 不能把放弃转成伪造结果。不为描述 Broker 资源恢复而向 worker 工具协议增加 Runtime status 枚举。

当前 Session busy 检查仅使用 `runtimeSessionId`。恢复查询还必须包含 binding ID 与 runtime generation，并精确比较标识；不同 tenant 复用同一 ID 时不能相互阻断或清理。已有执行行已携带该元组，优先复用，避免引入无关的 tenant schema 重设计；更广泛的 busy-check 清理如有需要另行划定范围。

JDBC 的 `hasActiveByBinding` 和 `hasActiveByRuntimeSession` 谓词必须同时排除 `SETTLED` 与 `ABANDONED`；内存等价实现使用 `isTerminal()`。这些计数变化不能替代物理停写门禁。旧 Broker 可能把已放弃行报告为无效请求、身份冲突或对账失败，而非终态不确定性。

迁移保留现有 `UNKNOWN`、已结算结果及不可变 key。没有可信丢失/停止证据的旧行继续阻断。旧 Java 二进制无法读取新枚举值，因此写入新的 abandonment 记录前需要协调升级服务；不支持旧新 Broker 混用这些行。不能修改已执行的 Flyway migration。公共 Session/Workspace 响应不暴露物理路径和进程元数据。

## 6a. W0e-1 实现

本 PR 实现首个切片。证据 SPI 在原 Binding 增加两个可空 JSON 字段 `lossEvidence` 和 `stopEvidence`，保存版本、事实类型、来源、观察时间、宿主／写入域，以及原 seed 身份和 resource handle，不包含凭据。保留首次失联证据；后续停止证据必须对应同一个域。Execution 增加 `abandonedAt` 和 `lossEvidenceId`；唯一的放弃原因是 `runtime_lost`。先提交的真实结果获胜，不增加 worker Tool 协议状态。

Binding 仓库负责准入和恢复事务。生产 JDBC 仓库必须使用同一个 `DataSource`，不支持的仓库组合明确失败；自定义嵌入仓库需要实现新的原子方法。Session 和 Execution 插入先锁定原 Binding，再检查 Session。恢复依次锁定租户 placement guard、slot、Binding、Session 批次和 Execution 批次。每个事务最多处理 100 个 Execution 和 100 个 Session，保留原回执，并在退休前复查操作租约和剩余引用。后续调用继续未完成批次。

新增小型租户 guard 表，将新 placement 创建与失联标记串行化。Managed Workspace 存在尚未回收的 lost／blocked generation 时，不能通过更换映射或 profile key 创建新 placement；稳定域为 `(tenantId, workspaceId)`，不包含物理和 profile 字段。Legacy Workspace ID 可能由路径派生，因此未清理的 legacy 失联会保守地阻止该租户创建新 placement，直到完成清理；已有 placement 仍可读取。此限制也识别历史 durable FAILED 行，旧 `FAILED` 记录不能作为停写证明。尚未观察到失联、仍为 READY 的旧 Runtime 不支持在线配置迁移；部署必须在验证清理前保持映射稳定。

本地进程的 Managed 启动在持久化任何 lease 或已认证代数前进入 `RECOVERY_BLOCKED` 时，仍封闭自身 placement，但不阻止同 Workspace 的其他 placement：未就绪的 Binding 不可能准入 Session context 或工具写入者。已经持久化其中任一事实的 `RECOVERY_BLOCKED` Binding 仍阻止整个 Workspace 的新 placement；其他 provisioner 类型保持保守阻断。

升级已启用 Broker 的部署前，先暂停新准入并盘点带 seed 的历史 `FAILED` Binding。即使后来代数已是 `READY`，早前崩溃仍可能留下这类记录；新 guard 会拒绝该租户创建 placement。若存在此类记录，受影响流量必须保持停止，直到原写入域已被物理停止，且有保留证据的运维迁移可用。后续 `READY` Binding、删行或伪造停写回执都不能作为清理证明。本切片本身无法让含有这些记录的部署安全恢复准入。

W0e-1 的 Local provisioner 仅能为自身仍持有并已观察到退出的进程证明 journal 丢失，严格匹配 seed、lease 和 handle。它不证明子孙进程已停止，也不提供 Broker 重启后的 worker 接管。对仍存活的自有进程，短暂的 attestation 传输错误只使本次请求失败；Binding 保持 `READY`，下次调用重新认证。进程死亡或身份冲突仍会封闭 Binding，单次网络超时不会变成永久的物理失联证据。只有本地进程 provisioner 通过自有进程存活检查显式启用此重试，其他 provisioner 默认保持封闭。重启后缺少 ownership 仍不能提供证据。本切片没有生产 `WRITERS_STOPPED` 产生器，通过确定性 supervisor fixture 验证证据消费。Workspace storage holder 清理仍属于 W0e-3；仅有失联证据的恢复不会调用 transport release，也不会清除 holder。缓存 Session 的释放先检查持久状态，再检查存活性，确保已回收释放可幂等确认，而 LOST 代数不能走普通 transport 释放路径。Session 的最终释放在同一个代数锁下校验父 Binding 并更新 Session。正常 holder 释放在 SQL 事务内锁定并检查原 Binding 仍存活；迟到的停用响应不能在失联屏障后清除 holder。这仅保护普通清理，不启用 W0e-3 回收。

私有终态读取、取消和同键创建重试校验原保存的 Binding 与 Session 身份，要求服务鉴权，不依赖本地存活 Session，也不重新解析当前 actor 或映射。HTTP 保留 `runtime_broker_execution_unknown`，附带 `details.terminal: true` 和 `details.reason: runtime_lost`；TypeScript adapter 在 inspect、reconcile 和 cancel 路径保留这些信息，不对外投影物理证据。

Flyway V16 和独立 initializer 增加可空证据／放弃字段及 placement guard。升级测试在迁移前直接写入旧版 SQL 行，迁移后校验 PREPARED、UNKNOWN 和 SETTLED 回执。写入 ABANDONED 前仍需协调升级，不能混用旧二进制。

## 6b. W0e-2 实现

[本地持久接管实现](2026-09-27-local-runtime-adoption.zh-CN.md) 增加显式启用的 Linux 身份存储、带持久 PID/启动 tick 登记的 boot 屏障、永久启动锁和 Broker 重启后的接管。默认临时模式保留 W0e-1 行为。两种模式均不在仅 worker 死亡时证明写入者已停止；W0e-3 物理回收仍单独实现。

## 6c. W0e-3 实现

[可信本地重启实现](2026-09-28-local-reboot-recovery.zh-CN.md) 增加单独启用的同宿主 boot 证据、原 holder 清理、迟到 acquire 屏障和独立有界维护扫描。grant、产品 Session 或 Registry 改变后，清理仍使用原保存物理归属。loss 回执始终表示终态不确定性。真实 worker、SQL 和模拟 boot 身份测试覆盖完整链路；宣称物理验收前仍需专用 Linux 重启验证。

## 7. 交付顺序与边界

| 切片           | 交付内容                                                                                           | 退出条件                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| W0e-1 / #12670 | 执行终态不确定性、持久证据契约、准入与旧 Broker 屏障、存活 Broker 安全故障处理、条件清理、私有投影 | 仓库/HTTP/竞态测试通过；缺少停止证据仍阻止复用                                   |
| W0e-2 / #12766 | 生产持久启动身份与存活 worker 对账                                                                 | 真实进程重启/接管测试通过；身份不完整不产生重复 worker；不支持的停止证明继续阻断 |
| W0e-3          | 同宿主重启恢复、Workspace holder 清理、旧写入者故障门禁                                            | 真实 SQL、worker 与宿主/隔离证据在每个验收案例中证明安全推进或明确阻断           |

这些是实施切片，不是三项已经完成的功能。启用 W0e-2 接管前先合入 W0e-1。W0e 只有完成 W0e-3 才算结束；测试辅助实现通过不能证明生产 provisioner 已达标。

[Hosted 文件工具 PR #12831](https://github.com/QwenLM/qwen-code/pull/12831) 已覆盖私有受控 Read/Write/Edit 编排，并明确排除进程丢失恢复。集成前协调它保存的 execution identity 和未知结果消费路径。公开绑定消息执行、Stage G Turn 接管/历史结算、任意 Shell 隔离、Kubernetes 和产品身份传递仍属独立工作。`workspace_context` 保持 false；W0d 的窄能力 `workspace_binding` 保持不变。

## 8. 验收与证据

| 门禁                      | 必须观察到的结果                                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 丢失执行各状态            | 五种非终态都能以结果未知结束；已提交的 `SETTLED` 证据保持不变                                                    |
| 迟到回调 / claim          | 放弃后的完成、取消、续租和 resolution 不能修改或重新执行记录                                                     |
| 准入竞态                  | 在 Session/execution 插入前暂停，由第二个 Broker 提交丢失后恢复：插入被拒绝，已有回执仍可读取                    |
| 旧 Broker                 | 缓存 Session 不能向 LOST 代数准入或将其退役；缺少停写证明时迟到释放不能清除其 Session 或存储占用                 |
| 响应丢失 / 重试           | 每个恢复提交之后崩溃，按原身份重试：只有一个终态记录，无重复 worker 或执行                                       |
| Broker 重启后 worker 存活 | 重新证明完全相同身份；原 status/cancel/release 可用；不自动重放 Hosted                                           |
| 共享观察者关闭            | 一个 Broker 关闭只脱离 worker，另一个仍可使用原 worker；显式退役需要独立持久权限                                 |
| worker 消失但后代不明     | 证据充分时记录不确定终态；binding、Runtime Session 和存储仍不可复用                                              |
| 已验证宿主重启            | 持久化正确 boot/domain 证据，放弃未知结果，释放精确旧 holder，再在原 Workspace 执行新工作                        |
| 不可信证据                | 超时、缺失记录、PID 复用、错误宿主、incarnation 不符和目录改变都不能解锁或杀死其他进程                           |
| tenant / storage 隔离     | Runtime Session ID 复用和过时清理不能影响其他 binding/tenant；恢复后同存储仍串行                                 |
| 旧写入者                  | 无论 Broker 是否重启，逃逸/迟到 writer 仍可写入时替代者继续阻断；证明执行域死亡后，新 holder 开始后没有旧 marker |
| 配置 / 授权漂移           | 原绑定保持固定；撤权 actor 不能执行；可信清理不要求恢复该 actor 授权                                             |
| placement key 漂移        | 改变路径/profile/isolation/provisioner 不能通过新 slot 的 provisioning 绕过未回收执行域                          |
| 本地启动未认证            | 原 placement 保持封闭；该 Binding 未准入工具写入者，因此同 Workspace 的另一个 Session 可以启动                   |
| legacy / schema / HTTP    | boot v1 使用相同复用门禁；迁移保留回执；释放后能读取终态且不泄露物理身份                                         |

运行现有 Stage F 进程门禁、新仓库契约在 H2 和真实 MySQL/MariaDB 上的验证、Spring 到 worker 的 holder 恢复，以及受支持宿主重启或隔离域测试。反例使用真正逃逸的后代进程；仅 mock observation 不能证明物理安全。实现阶段运行仓库 build、typecheck、bundle、定向 TypeScript 测试、Java verification/Checkstyle，以及连续两轮干净的完整 diff 自审。详细本地测试计划保存在 `.qwen/e2e-tests/managed-workspace-w0e.md`。

## 9. 评审决策与剩余前提

建议接受 `ABANDONED` 表示终态不确定性，保留独立物理占用，并在生产本地恢复前实现 W0e-1。对应 issue 仍需记录并评审这项决策；本文不代表 maintainer 已接受。

W0e-2 选择 Linux machine/boot/PID/time namespace 身份与持久启动登记。真实进程测试在 Linux 使用原生身份，在 macOS 使用仅测试可用的身份。W0e-3 仍需在受支持宿主验证物理重启。若部署要求任意 Shell 后代存在时也能在仅 worker 死亡后自动恢复，则必须先选择可整体终止的隔离域。此前该路径正确的验收结果是明确阻断。这些前提不妨碍使用确定性的可信证据 fixture 设计和实现 W0e-1，但 fixture 不构成 W0e 完成证据。
