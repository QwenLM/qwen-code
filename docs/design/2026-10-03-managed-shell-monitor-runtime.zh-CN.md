# Managed 后台 Shell 与 Monitor 运行时（H3）

[English](2026-10-03-managed-shell-monitor-runtime.md) | [简体中文](2026-10-03-managed-shell-monitor-runtime.zh-CN.md)

状态：实现进行中。本 PR 已落地：记录体与其引用闭包、cgroup supervisor 与 worker 侧后台准入、detached 结果家族、维护路由与 Broker 两行账本、托管后台退出腿、`monitor_run` 资源闭包、Monitor 记录漏斗与其去抖观测环（通知同事务）、输出背压、可重放的启动 attach、完成后证据留存（据此回答 `shell-status`/`shell-terminate`）、busy 检查前结算可证退出的 release 扫掠、Session 级 Shell publisher，以及按 release 排序的后台排空。另在任务事件车道落地：任务事件路由在两个表面翻为 `partial`，包括有界的每任务 SQL 事件 journal、Artifact 可见性屏障下的持久保留 floor、解冻的 output cursor 与 §6.1 契约流量。另有：cgroup watch 执行器与 monitor 路由和注册表、只读 rebuild 漏斗动词、Legacy 通知信封，以及内嵌 wake 调度器——Monitor 通知在 Session 空闲时作为普通文本回合运行、忙碌的回合期间在 journal 排队，并在关闭路径上不经模型按取消结算。仍为设计：`child_run` 与 `monitor_run` 提交启用、rebuild driver、output 与 Artifact 事件生产者，以及 Linux 物理验收。本文是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 H3 切片，即 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段，承接 H1（[MCP](2026-09-28-managed-mcp-runtime.zh-CN.md)）与 H2（[Hooks](2026-09-30-managed-hooks-runtime.zh-CN.md)）。引用基准为 #12827 所固定提交上的[扩展运行时设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md)第 3、9、10、12、13、14 节、[工具与历史设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-tools-history.md)的 Monitor 工具契约、[恢复操作设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-recovery-operations.md)的进程所有权与恢复规则，以及仓库内的 H0a（[任务契约](2026-09-27-managed-agent-task-contract.zh-CN.md)）、H0b（[记录契约](2026-09-27-managed-extension-record-contract.zh-CN.md)）与 H0c（[authority](2026-09-27-managed-extension-authority.zh-CN.md)）设计——本文收齐这些文档挂给 H3 的全部义务。

## 问题与范围

两项 Legacy 能力完全运行在内存状态上：`BackgroundShellRegistry`，其凭据是输出文件、best-effort 状态 sidecar 与 PID；以及 `MonitorRegistry`，其保留的输出路径至今没有 writer（参考设计第 2 节）。两者都活不过 Harness 替换或 Runtime 丢失，也都无法证明其进程做过什么。H3 把二者接入 Managed 路径：持久记录、真实的进程 owner、日志 Artifact、Runtime hold、stop/drain，以及要么重新 attach 原进程、要么准确阻塞的恢复。这是第一个产生用户可见任务的 H 阶段切片，因此它同时映射 H0c 留在 `planned` 的任务事件路由。

与 H1、H2 相同，实现扩展既有的私有 Hosted Workspace profile。生产环境的 AgentBundle 启用仍属另行处理。

以下各项由各自契约明确延后，不在本切片内：

- **公开的任务取消。** `cancelSessionTask` 与 `cancelWebShellTask` 保持 `planned`，留给 H4–H5 取消切片（#12847 的 A6/A7）。H3 通过 Monitor stop、Shell terminate 操作以及 Session 关闭排空来停止自己的任务，绝不走公开路由。
- **`send_input`。** `TaskActionCapability` 的该值保持保留；向后台 Shell 写入交互输入属后续切片。
- **Detach。** 显式 detach 的后台进程要活过 Session 关闭，必须先迁移到独立 durable owner（参考设计 §9）。H3 的所有进程归属于其 Session；Session 关闭一律 terminate 并 drain。detach 属后续工作。
- **跨 boot 的进程 attach。** W0e 刻意在主机重启后退役登记；主机重启会终结 Linux 上 H3 能 attach 的所有进程。主机重启后 H3 要做的是准确阻塞，并让可重建的 Monitor 重新开始，见下文「恢复」。

## 记录

### 后台 Shell：`child_run` 加 `kind: "shell"`

参考设计 §3.1 把后台 Shell 指派给既有 `child_run` 域、`kind=shell`。`child_run` 已是封闭 v1 域索引中的名字，因此不提升索引版本。本切片定义 `managed-child_run` 记录体（schema 版本 1），只含后台 Shell 所需内容；H4 再以它自己的体版本把 `kind` 扩展到 `child_agent`/`workflow`/`team`。Shell 记录携带：

- Shell 自身身份（`shellId`）、所属 Session scope，以及启动调用 pin：`commandRef`（启动调用的 args，含命令与目录，其 digest 即命令 digest）——workspace generation 与工具 profile 的 revision 由启动调用自身的固定上下文携带，记录体不为它们单独设键；
- 进程身份：拥有该进程的 Runtime binding 与 generation（位于 run block，与 Monitor 的携带方式一致），以及 `startReceiptRef`——在 supervisor 真正启动进程之前为 null（与 Monitor 的 start receipt 规则一致）。不存 `processId` 键：跨重启的稳定身份是 supervisor 从执行身份派生的 cgroup unit 名；
- `status`：run block 状态加上 Shell 专有的停止标记——首个 revision 以 `reserved/admitted` 打开；专门的 `stopRequested` 标志（一旦置位，不可清除）携带 stop 请求；标志已置位而 execution 未结算时，任务的 Runtime state 投影为 `draining`（即 H0c 的欠账「run block 不携带 stop 请求，由 H3 补上」）。以 `stop_requested` 结束必须携带该标志。该标志还定决终结的家族：跟随已提交请求的终结以 `cancelled`（`stop_requested`）结算；只有被证据证明为自然的终结（退出码或信号、事先无请求）才以 `exited` 结算；
- 输出身份：`outputRef`，一个 `managed-tool-result-manifest` 版本 1 引用，随日志页发布递增 revision；以及「任务事件」一节所述的输出游标；
- 终态账目：有据可查时的退出码或信号，以及封闭的 stop reason——仿照 Monitor 的规则：`settled` 由 `exited` 关闭，`failed` 由 `start_failed`/`process_failed`/`quota_exceeded` 关闭，`cancelled` 由 `stop_requested` 关闭——各自注明它可关闭的状态及所需证据。

Shell 的 run 只记启动调用的 `executionCallId`：没有 `effectId`、`dispatchId`、`deliveryId`，也没有 pin 之外的 `definition`。Shell 没有 delivery 状态线、不进 outbox：它的完成经任务投影观察，它的输出经 Artifact 读取——正如 Monitor 经水位记录而非 delivery 通知。Shell 记录的 revision 规则仿照 H0b fixture 已固定的 Monitor 规则：身份与 pin 永不改变；输出只增不减；已 settled 的 Shell 绝不重开。start receipt 与 Monitor 的 rebuild 规则有意不同：设置一次、永不改变——更晚 generation 下的 re-attach 沿用原 receipt，因为它所证明的进程从未重启，而变更 receipt 会被当作重跑的形态拒绝。（只有启动新 watch 的 Monitor rebuild 才签发新 receipt。）

### Monitor：启用 `monitor_run`

H0b 契约已固定 `monitor_run` 记录体及其 revision 与 rebuild 规则，H0c 已在两侧交付投影与 fixture，但保持该域关闭。H3 负责：

1. 把 `monitor_run` 加入 `MANAGED_SESSION_ENABLED_DOMAINS`；
2. 补上契约已经点名的物理侧：`startReceiptRef` 背后的 Runtime start receipt、`observationSequence`/`lastObservationRef` 背后的观测、`outputRef` 背后的输出 manifest，以及推进 `notifiedThrough` 的通知输入；
3. 执行契约留给 H3 的部分：rebuild 策略（只有纯观测命令允许重新 watch）、stop 流程（先封观测，再取消进程，再收尾输出，最后提交终态 revision），以及 H0b 第 6 个开放问题——覆盖多个观测的一条通知从 `outputRef` 背后的输出中取得各观测的摘要，因此记录仍按每个被接受观测提交一次 revision，而不是按通知提交。

记录体本身无任何改动；H0b 的 568 个 fixture 与 H0c 的投影、链条 fixture 必须原样继续通过。

### 读者兼容

实现中段依据第 5 轮跨版本矩阵推翻并替换了早前的门禁决定。门禁的前提——「仍有认得 Session 却拒绝 `monitor_run` 域名的 reader」——并不成立：`monitor_run` 自 #12837（v0.24.7 起可用）就是已知且可解析的域，v1 reader 打开持有 `monitor_run` 记录的 Session 不会报错。header 不可变，要求令牌无法在日志内抬升，因此新 Session 的盖章就是混版本故事的全部。每个新 Session 继续盖 `minimumReader: managed-session/1`——若对每个新 Session 都盖 v2，回滚或新旧混跑会丢掉其间创建的所有 Session，而任何已部署二进制都不需要这层保护。盖章仅当某次改动真的会让旧 reader 在扫描中途失败时才抬升；且只有在能读取它的 reader 先发布一个版本之后才写入。启用清单仍是域的唯一闸门。

`child_run` 在每个 managed-session/1 读者上都能解析，但只有 H3 理解其记录体：旧 writer 拒绝提交它（其 `MANAGED_EXTENSION_RECORD_BODIES` 没有该体）。不对称的风险在 server 一侧：旧 Java store 会静默放行未知域的事件，而按 H0c 第 7 个开放问题，事后才获得记录体的 server 看到的第一个 revision 不是 start，会拒绝它并停掉 writer。因此 server 必须先于任何能提交该域的 writer 获得 `child_run` 记录体：`child_run` 在 `MANAGED_SESSION_ENABLED_DOMAINS` 中保持关闭，直到一个发布同时携带两侧且 server 先行部署——即 H1、H2 已经采用的顺序。除已启用域常量与该部署顺序外，不存在别的运行时准入开关。

### 资源闭包

Java store 只有在记录体点名的每个资源都随提交在场时才会提交该体；点名了 Session 不持有的资源的体会被拒绝（H0c 第 3 个开放问题）。对 `child_run`，这一要求在本 PR 发布时双侧即成立：writer 在发布前逐一读取 `commandRef`、`startReceiptRef`、`outputRef`，server 的提交时检查列出同三项，因此一次失败的检查停掉 writer，而不是提交一个 store 必然拒绝的引用；不豁免任何资源种类。`monitor_run` 在其启用时承担同项义务，而 H0c 时代 fixture 欠下的前置已由本 PR 偿清：两套 rig 都已用真实发布的引用重建（按被引身份记忆化的同类占位体），两侧 store 都在提交时读取 monitor 的四条引用，且各有一条专门的见证钉住该检查——点名了提交之外资源的 run 会被拒绝。

## Runtime 所有权

### 每个任务一个物理 owner，每个进程一条 execution

与 Legacy 路径相同，每个后台 Shell 与每个 Monitor watch 都是 managed-runtime worker 的子进程（TypeScript 实现）；Java 控制面不监督任何进程。H3 替换掉两处拒绝门——`ManagedToolExecutor`（“Managed Runtime does not admit background shell execution”）与 `executeV3`（“Background Shell capture is unavailable”）——代之以 Managed 准入路径；对 v2 式直接派发，`RuntimeBrokerService` 的前台专用检查保持不变。

Shell 的启动原样复用 Shell 工具的 approval、preflight 与执行门禁，然后把进程交给下文 supervisor，并以持久 handle 作为工具结果返回。工具结果结算；物理工作不结算。账本承载两行，因为账本只在 execution 结算时记录结果：启动调用是按前台长度结算、交付 handle 的 execution；后台进程本身在启动时另准一条 execution——该行不携带模型结果，因此「结果当且仅当结算」的不变式不被触碰——并保持非终态，从而以 `hasActiveByRuntimeSession` 与 `hasActiveByBinding` 持有 Runtime，直到进程被证明退出或丢失。status、read-output、terminate、kill 都是针对同一 execution 的操作：模型发起的（Monitor 的 stop 调用、一次 status 读取）与任何工具调用一样走当前 activation，而 owner 侧的维护操作（恢复对账、关闭触发的停止）挂在 `OperationGrant` 下，沿用 Hook async 模式：它们携带原 `targetOperationId`，校验 Session、进程 owner 与 generation，绝不创建新的模型回合。terminate 只凭证据（退出，或下文 cgroup 空检查）结算 execution；无法证明的结局保持 active 并继续持有，这正是 #12670 的卡住语义——存在未决后台工作的 Runtime 既不能 release，也不会被悄悄回收。

Monitor watch 形状相同：一条 execution 贯穿 watch 的生命周期并持有 Runtime；被接受的观测提交为 `monitor_run` revision；stop 为维护操作。Monitor 不占用活跃的模型回合，但占用 Runtime 的进程、日志与配额容量。

### 监督：Linux cgroup v2，沿用 H2

Managed Shell 与 Monitor 进程运行在每进程一个的专用 cgroup v2 unit 下，unit 在 spawn 前创建，使用 H2 的同一个委派根与变量：`QWEN_MANAGED_HOOK_CGROUP_ROOT` 在此承担 Runtime 进程隔离的部署开关而不再只是 Hook 特性的开关，原样复用 `hook-command-cgroup.ts` 及其启动证明 launcher。unit 名派生自执行身份，因此它就是跨 worker 替换的稳定进程身份：membership 在 `setsid` 与 detached 后代之后仍然保留，`cgroup.events` 报告 unit 内是否仍有进程（`populated`），`cgroup.kill` 是唯一被接受的停止手段；仅根进程退出绝不是证据。stop 先排空输出，在排空时限内先 TERM 再升级为 `cgroup.kill`，等待 `cgroup.events` 报告为空，然后结算；无法证明为空的 stop 继续持有。仅进程组绝不被接受为证据——与 H2 的决定一致。

在没有委派 cgroup v2 的平台上，Managed 后台 Shell 与 Monitor 准入在任何副作用发生之前准确拒绝——v3 结果以 `not_started` 结算并点名错误，即被证明未启动执行既有的持久形状；记录以 start_failed 落在被证明从未启动的执行上（`not_started_proven`，无 start receipt，无 stop 请求）。恢复设计中较弱的 macOS 进程组 profile 留作另行决定，本文不主张。

### 日志：有界捕获，每个任务一个 Artifact

后台 stdout/stderr 增量捕获，不按调用捕获。长开捕获延续 O1c 为前台 Shell 建立的 `managed-tool-result/1` 封装——在其契约上限内的有界分段与页、每任务一个持续增长的 manifest——但在任务生命周期内保持打开，而不是在退出时封存：

- 分段与页一旦持久即通过既有 v3 发布路由发布，读者不必等待进程退出；
- 每页在背压下闭合：分段进入有界 sink 期间，生产者在管道层暂停，与 O1c 相同，因此输出量大的进程内存仍有界；
- manifest 递增 revision；进程结束时最终 revision 封存 stream，捕获随之关闭；
- worker 替换**不**续传捕获：管道的读端随旧 worker 而死。替换者 attach 该 unit、监督仍存的进程至其终结，并把捕获封顶在最后已发布 revision——每个被保留的字节恰好出现一次，保留前缀绝不回卷；kill 之后仍在途的字节按此规则丢失并记为 capped，绝不悄悄吸收。

Java 侧，增长中的 manifest 在其仍 open 期间保持为私有 Session 资源——既有 `ManagedToolResultStore`/`ManagedArtifactService` 管线只投影 `sealed` 流——任务的唯一公开输出 Artifact 在最终 revision 落地（最终 revision 封口行，以 capture 身份为键、最早在前），并从任务的 `artifact_refs` 引用。`artifact_refs` 的 100 条上界由此结构性满足——一个任务只持有一个 manifest 持续增长的输出 Artifact——上界之外无须其他规则：任何投影轮转尚不存在，当真要被新增时，本切片选择拒绝轮转掉最旧引用而不是悄悄丢弃（当前决定，记入开放问题 2）。open 流的公开 pending 投影属于发布路径自身的后续扩展，本节不假设它。高量输出绝不变成 Session 事件：下文的任务事件路由提供带游标的有界输出块，完整文本放在 Artifact 中。

保留：O4 只覆盖前台 Shell 发布。H3 的后台发布加入同一个 Session 保留根，并显式声明在 O4 谱系扩展到后台流之前的覆盖缺口；前台收集器不会悄悄收集它们，Session 删除按同一有序关闭退役它们。

### 配额与准入

按 Session 计，拟在契约中固定、参照既有 worker 预算定尺寸的默认值：最多 8 个活跃后台 Shell、4 个活跃 Monitor，每 worker 合计最多 32 条活跃后台 execution；每任务日志字节受发布预算约束（达到日志预算的任务继续运行，但停止发布新输出页，并在下一次 status 中报告该上限；绝不悄悄丢弃）。Monitor 的观测提交按 Managed 最低去抖（1 s）限速，因此 10,000 条观测的记录上界同时把重开重放成本界定为 10,000 个小记录体——在验证中实测并报告；若实测需要，检查点链条留作后续。准入失败是已提交、在日志中可见的拒绝，不是静默丢弃：试图启动第 9 个 Shell 会把超配额拒绝作为其工具结果提交进 Session 日志，且不产生任何 `child_run` 记录。

### Session 关闭：先 terminate，再 drain，按序执行

分布式的关闭序列补上缺失的一步。Session 关闭时，在关闭 Harness activation 之前，Session authority 先封新准入，对该 Session 每个活跃的 Shell 与 Monitor 发出 stop 操作，并在有界的排空窗口内等待每个进程排空（cgroup 为空、输出封存、终态 revision 已提交）。之后关闭才继续到 activation 关闭，Broker 侧的 `drainClaimedBinding` 也查不到活跃 execution。stop 在窗口内无法证明 cgroup 为空时，绝不报成已停止——close 操作以既有的终态 `workspace_close_execution_unsettled` 结束，持有持续，Session 保持可重开。Runtime 已丢失的 Session 无法排空：进程保持未证明，close 操作按今天对未决 execution 的口径报告 `workspace_close_execution_unsettled`，记录保持其受阻持有。没有 detach 路径：关闭绝不在身后留下活进程。

## 任务投影与事件

### 投影

`background_shell` 与 `monitor` 两种任务种类按 H0c 的定义投影，并有本切片自有的两处补充：

- Runtime state 补上缺失的 `draining` 行：最新 revision 携带 stop 请求而 execution 尚未结算的记录投影为 `draining`；
- 按 #12847 A9 的决定，H3 触及的任何适配器中，Legacy `paused`/`pausing` 状态映射为 `waiting`；`TaskState` 保持八个值不变。

产生输出的任务声明 `read_output`；`cancel` 在取消切片之前不声明；`send_input` 保持保留。按契约 §6.1 的演示要求，任务所在 Session 必须先具备 `capabilities.artifacts`，才能准入产生输出的 Shell 或 Monitor。

### 任务事件路由

`listSessionTaskEvents` 与 `queryWebShellTaskEvents` 翻为 `partial`，`output_cursor`/`outputCursor` 随之一同解冻，契约次版本在合入时递增（v1.30+；对照 main 重编号，#13210 与 #13247 都在认领 v1.30）。事件种类为 `output`、`state_changed` 与 `artifact`，遵循已定契约：每个事件一个逻辑游标位置，游标按提交顺序分配，读者绝不会越过并发提交晚到的事件；持久保留 floor 在空保留集、重启与投影重建之后仍然存活。

存储：SQL 中按任务有界的事件账（本 PR 的 `V41` 表，main 的迁移表追上来时已按规则重编号），与产生该事件的提交在同一事务中写入——任务的一页日志持久时写入 output 块事件，任务视图真实变化时（即 H0c 公告点，去抖的 Observation revision 若未改任何视图则不发）写入 `state_changed` 事件，输出 Artifact 首次可见时写入 `artifact` 事件。floor 只推进到其完整文本已可在任务 Artifact 中持久读取、且经任务视图的 `artifact_refs` 可发现的事件之后（契约的可见性屏障）；归档失败绝不把 floor 推过未归档输出，积压上界就是上述按任务页预算加持有的事件行，生产者背压保证其有限。

`cursor_expired` 之后拼接所用的输出分段：一个输出事件的游标区间运行在 `managed-tool-result/1` 已命名的单一流内分段序号空间：（`captureId`、`streamId`、首个 `ordinal`）到同构三元组（不含尾端），并由页的 `firstOrdinal` 与 `segments[]` 逐字对应同一空间——因此从 floor 恢复的客户端对更早内容读 Artifact、对更新内容读事件流，既不重叠也无缺口。这收齐 H0a 的后续项「H3 定义稳定的输出分段」。

路由翻转之前，§6.1 演示清单作为契约测试流量跑通：含空保留集在内的 floor 过期、游标后不可见、重启与重建后游标身份不变、Artifact 投影延迟与归档失败不丢输出、100 引用上界、`capabilities.artifacts` 准入门、分段拼接无重复。#12847 C15/C16 的 `PlannedTaskContractTest` 缺口在同一变更中补齐，因为事件 schema 此时才真正承重。

## 通知

Monitor 的每个被接受观测提交其 revision；到通知时机时，在同一事务中再提交一条通知输入及其 `wake.requested`——H0c 已有这套机制。H3 让 wake 真正生效：内嵌调度器把 Monitor 通知的 `wake.requested` 当作可运行的 Session activation，走 Session 的普通准入（忙碌的 Session 把输入排进 inbox，与 channel、Goal 输入相同），该回合消费通知并使其结算，从而让 `hosted_turn_recovery_required` 永不阻塞重开（H0c 第 6 个开放问题）。当该回合完全无法准入时（Session 正在关闭、已排空或永不打开），该输入按其自身幂等键不经模型调用结算——没有任何楔住的通知能把 Session 卡在不可重开上——既跑不了也结不了的余量以准确 blocked 呈现。通知输入按水位去重：恢复期间重投递的 revision 不重跑，因为 `notifiedThrough` 已经覆盖它。来自已撤销 generation 的迟到观测在 worker 路由处被拒绝，不可能进入提交。

## 恢复

恢复按恢复操作设计的分类，逐情形处理：

- **同 boot 的 worker 替换**（Broker 存活）：存活下来的 worker 由 durable provisioner 按今天的方式重新 adopt，无需任何新机制。真正死掉的 worker 才会被替换；替换后的 worker 按进程的 cgroup unit 重新 attach——unit 存在、记录的命令 digest 与 start receipt 相符、`cgroup.events` 显示有成员——监督其终结，并把捕获封顶在 manifest 的最后已发布 revision。unit 为空但无退出证据，或证据无法核验，是 `outcome_unknown`：记录进入 `recovery_blocked`/`runtime_lost`，execution 继续持有，什么都不重跑。被证明为空的 unit、输出已封存且有退出证据的，按 `exited` 结算。
- **主机重启**（#13211 起 trusted reboot recovery 默认开启）：旧 boot 的每个进程都已物理消失，但重启前的结局不可知。durable provisioning 的证据（`JOURNAL_LOST`/`WRITERS_STOPPED`，同一信任模型）驱动 binding 进入 LOST；H3 仍活跃的后台 execution 与其他未决 execution 一样挡住盲目清理（#12670 的卡住）。只有主机级的丢失证据（有证明的 boot 边界，如 `JOURNAL_LOST`/`WRITERS_STOPPED`）才允许既有的 `abandonByBinding` 回收路径随后释放账本行——被放弃的行清除 Runtime 持有，但那是账本结局、不是物理结局：H3 记录保持 `recovery_blocked`/`outcome_unknown`，因为进程是否在重启前退出不可知，放弃绝不投影为 settled。同 boot 的 worker 丢失是另一种证据，绝不放弃 H3 execution——它的持有持续，下一个 worker 按第一条的描述重新 attach；而今天的封闭两值丢失证据枚举只由 trusted 重启观测产生，因此回收路径本来就只能按主机级证据放弃——构造上此处不欠任何扩展。H3 不主张跨 boot attach。仍欠付的 W0e-3 精确 head 物理重启验收也必须按此形态覆盖 H3 的 execution；本文声明该义务，不虚构证明。
- **Broker 重启/对账**：机制不变；活跃 execution 继续持有其 Session 与 binding，对账按今天的口径按 generation 重授 claim。
- **不确定期间控制台发出的 stop/kill**：stop 请求是持久的（已提交的 revision）；迟到 generation 的答复对照记录对账，绝不当作新效果。

**Monitor 重建。** 只有命令已知只读的 Monitor 才允许在 Runtime 丢失后重建：`OperationGrant` 下的维护相位在新 generation 启动新的 watch，提交新的 start receipt，并从已提交水位继续 `observationSequence`，保留 `runtime_lost` 理由，期间投影 `degraded`——即 H0b 的 rebuild 规则、fixture 所固定的形态，包括 rebuild 只能从 `outcome_unknown` 发起、绝不从已结算 execution 发起（H0b 第 5 个开放问题按设计的口径回答：H3 绝不把这样的运行退回 `running`/`waiting`；Shell 从 `outcome_unknown` 返回的唯一路径正是同一条经 cgroup unit 核验的 re-attach，以该证据为门，已结算 execution 同样绝不回头）。其余一切 Monitor 与一切无法 re-attach 的后台 Shell 保持阻塞；重新开始永远是新 activation 下的显式新调用，绝不属于恢复。

**与 LOST 卡死的相互作用。** 携带活跃 H3 execution 的 binding 进入 LOST 后，与任何未决 execution 一样继续钉住放置，直到其 execution 凭证据停止。当回收路径在其丢失证据下应用 `abandonByBinding` 时，被释放的行清除其持有，但 abandoned execution 绝不是关于其进程的物理证据：记录保持受阻状态，任何东西都不会把可能仍活的进程投影为已结算。

## 接口与兼容性

- **worker 协议。** 新增一条与 `ManagedHookProtocol` 同级的私有路由（`/internal/managed-runtime/v3/…`），kind 包括 shell-start/status/terminate/kill、monitor-start/status/stop 以及 read-output 流；恢复 kind 携带 `targetOperationId`，为 shell-status/terminate 与 monitor-stop（shell kill 是 terminate 的升级手段，不是独立的恢复 kind）。路由在新效果之前校验 Session、workspace generation 与 operation grant，与 Hook、MCP 路由一致。
- **envelope 家族。** 启动调用以 `captureStatus: 'detached'` 结算——`managed-tool-result/1` 的新 envelope capture 状态，其 capture 对象不带 reason、不带 manifest，因为输出活在记录的增量 manifest 上，而不在结果里。持久交付与之配对 `decision: 'blocked'`（handle 经 Session 历史到达模型，不经发布存储）；turn 接线落地时，replay 与恢复校验器在 complete 与 not-started 两族之外收到第三族，ack 恰与 null manifest 相配。启动调用的已提交拒绝以 `not_started` 加 null capture 结算，即持久未启动族既有的形状。
- **公开 API。** 任务事件路由在两个面都翻转 `planned`→`partial`，含各自 controller 与契约测试流量；不改动其他公开路由。PID、绝对路径、Runtime endpoint、cgroup 名都不出现在公开面上——`status` 投影只携带 Managed 状态，诊断信息是受权 Artifact 引用，与任务视图既有的承诺一致。不新增公开错误码：平台隔离拒绝是已记录的失败准入（`start_failed`，落在被证明从未启动的执行上），而不是传输错误。
- **Legacy 面不变。** daemon 的 `/session/:id/tasks`、`BackgroundShellRegistry`、`MonitorRegistry` 与 Legacy Shell/Monitor 工具保持原行为；本切片不迁移 Legacy Session，也不复用其内存注册表作为证据。
- **Flyway/契约。** 一个新 Flyway 迁移（任务事件账表，以及持有账目所需的 execution 账本列），取下一个空闲版本；契约次版本递增。两者都在合入时对照 main 重编号。
- **启用。** `monitor_run` 与 `child_run` 保持关闭，直到一个发布同时携带两侧且 server 先于 writer 部署——即「读者兼容」一节定下的启用清单闸门与部署顺序，其下没有任何隐藏的版本检查。

## 验收

把参考设计 §13 的 H3 门槛与本文能覆盖的 §14 条目落成可检查项：

1. 带着繁忙子进程树启动的后台 Shell 由其 cgroup unit 监督；stop 杀死根进程与全部后代、证明 unit 为空、封存输出并结算；kill 在 SQL 提交序列与 unit 的 `cgroup.events` 中可观测，绝不在 PID 文件中观测。（§14.3）
2. 输出量大的 Shell 以管道级背压发布有界分段；流式产出 1 GiB 期间 worker 峰值内存保持平坦；完整文本可带 digest 身份从 Artifact 读取，任何一行都不会变成 Session 事件。（§14.8）
3. 运行中 Shell 或活跃 Monitor 正在执行时，该 Runtime 对 workspace 关闭返回 `workspace_close_execution_unsettled`、对 Session release 返回 `runtime_session_busy`；stop 并 drain 之后两者都成功。（§13 hold）
4. 流中 sigkill worker：替换者 attach 同一 unit，若有存活进程则监督其终结，并把捕获封顶在最后已发布 revision——每个保留字节恰好出现一次，保留前缀的分段序号连续，kill 之后在途的字节绝不重发或悄悄吸收。主机重启模拟（trusted 恢复）：记录进入 `recovery_blocked`/`runtime_lost`，持有持续到凭证据回收，什么都不重跑。（§14.1、§14.3）
5. 高事件率的 Monitor 在去抖窗口内聚合，提交不超出其配额的观测，每次水位前进恰好通知一次、跨 worker 替换无重复，并以 `max_events`/`idle_timeout`/`stop_requested` 结束，与契约要求逐条一致。（§10、§14.8）
6. 只读 Monitor（如观察文件大小）在 Runtime 丢失后呈现 `degraded`，在新 generation 下重建并从其水位继续；同一故障中的副作用 Monitor 与每个 Shell 保持阻塞。（§10）
7. 任务事件路由：§6.1 演示清单在 MariaDB 与 MySQL 上以契约测试流量通过；`cursor_expired` 恢复在 property 式循环中拼接 Artifact 与事件且无重叠。重启、重建与归档都保持游标身份。（契约 §6.1）
8. 携带活跃 Shell 的 Session 关闭在 activation 关闭之前排空它们；对丢失 Runtime 的关闭报告 `workspace_close_execution_unsettled`，受阻记录保持可查。（§12 关闭顺序）
9. 任务事件的跨租户、跨 Session、跨 client scope 访问按契约返回 404/403；公开响应不暴露 PID/路径/endpoint/cgroup 名。（§14.9）
10. H3 的每种失败都能归类为 `not_started_proven`、已结算、可 attach 或 `unknown`/`corrupt` 之一；unknown 结局绝不报成成功，绝不自动重跑。（§14.10）

验证沿用 H1/H2 的形态：每个 store/协议/authority 改动配旁置单测；`child_run` 记录体及其链条的共享 fixture 双语回放；翻转路由与封闭事件 schema 的契约测试；故障门禁套件补上 H3 的 execution；运行报告中保留真实进程证据（精确 cgroup unit、退出证据、manifest digest 与 SQL 提交序列）。与 H2 的十一轮真实栈验证同样规格，在带委派 cgroup v2 的 Linux 主机上以精确合入 head 做物理验收。

## 开放问题

1. **`capabilities.artifacts` 对 Hosted Session 是否可能为 false。** 如果每个 Hosted profile 都已保证它，准入门只是契约演示；如果本地 profile 缺它，拒绝需要在 Session 创建诊断中有呈现路径。
2. **100 引用上界。** 每任务一个输出 Artifact 让它在实践中不可达；到达上界时投影应拒绝（大声失败）还是挂起（停止新 `artifact` 事件、继续发布输出）？本文选择拒绝，因为悄悄老化掉引用正是契约禁止的失败。
3. **受阻时的 stop。** 对 `recovery_blocked` Shell 的 stop 请求送不到 owner。H3 记录 stop 意图，但在 owner 应答或被回收之前不结算任何东西；是否由后续运营路由强制关闭此类记录，是取消切片的问题（参见 H0b 第 4 个开放问题）。

## 后续工作

| 切片                 | 范围                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| H4–H5                | `child_run` 的 `child_agent`/`workflow`/`team` 种类；outbox 派发器；含 `task_id`/`failure_code` 持久化的公开任务取消。 |
| send_input           | 向后台 Shell 写交互式 stdin；`TaskActionCapability.send_input` 路由。                                                  |
| Detach               | 把显式 detach 的进程迁移到独立 durable owner，使其活过 Session 关闭。                                                  |
| macOS 进程组 profile | 面向非 Linux 开发者的较弱监督主张；仅本地，绝不进 Hosted。                                                             |
| 重开成本检查点       | 若 10,000 记录体重放的实测结果需要，补 Monitor 链检查点。                                                              |
| Artifact→任务归属    | 为任务枚举更旧的 Artifact，解除对 100 引用上界的结构性依赖。                                                           |
