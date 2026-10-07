# K2 补全：聚合退役与安全 CSI 交接

[English](2026-10-06-kubernetes-k2-retirement-handoff.md) | [简体中文](2026-10-06-kubernetes-k2-retirement-handoff.zh-CN.md)

状态：补全设计、本地 K2-A1 原型与进行中的 K2-A2 实现，更新于 2026-10-07。
原生边界观测器已实现；私有 CREATE/request 固定点已在本地实现并验证。
原 binding/Session/writer guard 正在本地实现。
完整 A2 准入关闭与 K2-B 到 K2-D 仍待完成；本文不声明完整 K2 或新增云上验收完成。
实现基线为 main
`4bffa678bced8b14c25c85e3ba4226b7b752414d`，已包含以
`69d5db2ff2424da01ac6f14e4c484773aae7204c` 合入的
[PR #13289](https://github.com/QwenLM/qwen-code/pull/13289)。剩余工作由
[issue #13395](https://github.com/QwenLM/qwen-code/issues/13395) 跟踪；保留
[proposal #12380](https://github.com/QwenLM/qwen-code/issues/12380) 开放。
本文是[原 K2 设计](2026-10-01-managed-kubernetes-k2.zh-CN.md)的补全计划，
不替换其注册、挂载来源与原 publication 契约。

## 1. 目标与首个支持场景

K2 要让正常运行的原 worker 完成工作、解除其 CSI 挂载，并将同一注册卷交给新的
runtime generation，同时不丢失结果、不允许两个 writer 同时写入。底层使用
Kubernetes。阿里云 ACK 是一种验证环境，并非 runtime API 的必要依赖；worker ACK
表示结果确认，与云服务名称无关。不同 CSI driver 和部署保护仍须分别验收。

首个正向验收场景刻意收窄为：一个注册的 RWOP 文件系统卷，一个 restart policy 为
Never 的原 bare Pod，一个原 Runtime Session 与持久 Session activation，以及一个
显式版本化的纯文件 capability profile。支持 `read_file`、`write_file` 和 `edit`，
结果必须完整保存在 inline 资源中，Session history 未压缩。这些是当前共享 `ToolNames`
中的标识。首批不接纳 Shell、worker provider、Hook、MCP、后台执行、restore、
对象存储历史或省略的结果。新 worker 在同一健康 Node 上运行；跨节点交接须后续单独
验证，不能从本次测试推导。

此限制描述新的 profile，暂名 `csi-files-retirement/1`。现有完整 profile 的 worker
必须继续报告原有生命周期 blocker。不得重新解释既有 capability digest，也不能静默
降低调用方请求的能力。请求包含不支持的能力时，在创建 Pod 或挂载存储之前失败。

正常 CSI 交接、K1 LOST 恢复（F2）和完整 Shell/MCP/provider 生命周期支持是不同的
交付项。实现正常 K2 退役不以 F2 为前提；节点失联或执行结果不确定仍阻塞本流程。

## 2. 基线已实现的内容

| 权威来源         | 已实现                                                                              | K2 补全缺口                                           |
| ---------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 注册与物理所有权 | 可信 alias 共用一个 physical-key 所有权行；CREATE 前预留                            | 多轮释放、预留之间单调递增的所有权 revision           |
| 原 Pod           | 可信 API 身份、对象保护、固定的挂载观测                                             | 原进程停止与原 target unpublish 的合格证据源          |
| Retirement       | 原子 dispatch seal 与原不可变 intent；保留 slot 和 holder                           | 完整工作清单、聚合 `DRAINED`、原子 `RELEASED`         |
| Worker           | 原 generation 的 seal、status、result/cancel/ACK；保守的 `QUIESCENT` 观测           | 绑定持久聚合截点的最终变更屏障                        |
| Publication      | 封口前授权、原结果/receipt 结算、单 publication checkpoint 检查、原 worker 持久 ACK | 完整 publication 成员清单与聚合证明；ACK 不是物理停止 |
| 文件工具         | v2 Broker result 持久化；Hosted 写入 outcome 和 journal/checkpoint 状态             | 独立于 publication receipt 的 v2 文件结果结算验证器   |
| 公开选择         | Local-process Workspace 路径                                                        | 显式 CSI profile、身份、resolver 与 transport 接线    |

基线中两个细节决定了本设计。第一，现有 ACK 要求原 Runtime Session 为 `READY`，
持久 Session 的原 writer 与 activation 均 active 且未过期。因此必须先收集 ACK，
再释放这些权威。第二，CSI store 当前仅接受初始 `RELEASED` revision 0、`RESERVED`
revision 1、`DRAINING` revision 2；retirement reader 也仅接受 `DRAINING`。
支持交接必须同时更新这些校验器及其消费者。

基线文件结果不走 deferred-v3 publication ACK。`hosted-workspace-tool-turn.ts`
持久化转换后的 function response 和 `managed-tool-outcome`，然后调用
`resolveAwaitRuntime`。过大的结果可能变成 `outputOmitted` response。该调用成功
返回，或将空 publication 传给 publication 验证器，都不能证明文件结果已被最新
checkpoint 覆盖。

历史云上测试只证明其记录版本的行为。
[d24d3f5b 的云上报告](https://github.com/QwenLM/qwen-code/pull/13289#issuecomment-5971605565)
不能作为合入提交或本文提案的完整 K2 验收。

## 3. 权威与进度模型

保留 `managed_workspace_execution_lease` 为唯一物理所有权权威，既有 binding/active
slot 为 placement 权威，`managed_workspace_csi_retirement` 为退役 journal。
保持原 `identity_json` 字节不变：已保存 ACK 绑定其 digest。不再建立第二套 execution、
publication、receipt 或 ACK ledger。

在原身份之外增加有 revision 的进度和有界证据引用。拟议 retirement 阶段为：

| 阶段       | 含义                                                                                              | 能否重新分配存储？            |
| ---------- | ------------------------------------------------------------------------------------------------- | ----------------------------- |
| `DRAINING` | 新准入已封口；允许原结算继续。可选的不可变 application cut 记录持久结算已完成                     | 不能                          |
| `DRAINED`  | application cut 已提交，原 worker 已 finalize，Runtime Session 已关闭；所有允许的工作均已持久入账 | 不能                          |
| `RELEASED` | 原停止与 unpublish 合格证据已接受，并在同一事务释放原 binding/slot/physical holder                | 可以，由新的 reservation 取得 |

`BLOCKED` 是带稳定 reason code 的观测条件，不是第四个阶段，也不是撤销封口的理由。
Worker 的 `QUIESCENT` 是观测，不是 journal 的 `DRAINED`。单独的 worker ACK、Pod
phase、lease 过期、active count 为零或等待超时，都不授权上述任何转换。

聚合 manifest 绑定：retirement/registration/reservation 身份及 revision；
binding/generation；原 runtime/lease/Pod handle digest；profile 与 capability
digest；完整排序的成员清单；每个 execution 的 version/result digest；每个 Session
head、activation 与最新 checkpoint；适用的 publication/receipt/resource 身份与
ACK digest；sealed worker invocation/history inventory digest；原 worker finalization
response。保存规范化的有界字节及 digest，不接受
用户提供的 `allSettled=true` 一类标志。

不可变 application cut 与后续 worker finalization receipt 分开保存，避免循环 digest。
Finalization 引用 cut digest；`DRAINED` 引用两者。物理证据引用相同 retirement 与
原创建身份。重试只能返回该身份首次提交的证据，或因冲突失败。

## 4. 封住准入并建立完整成员清单

### 4.1 私有 CREATE 与原 request 固定点

私有操作入口为 `WorkspaceCsiSessionMain create <reviewed-csi-session-json>`，
使用 `K2_JDBC_URL`、`K2_JDBC_USER`、`K2_JDBC_PASSWORD` 和 `K2_AGENT_REVISION`。
它不启动 worker，也不经过公开 Session CREATE。封闭且有界的输入包含已审查的
`registration`、可信 `actorId`、`idempotencyKey`、可选 `requestedRevision` 和
`title`，以及显式 `workspace` 选择。重复键、额外字段、尾随 token 和超过 32 KiB
的输入均拒绝。

一个全新、十秒有界、使用原 connection 的事务先锁住租户 placement domain，验证
持久化的不可变 CSI registration，串行化已有 creation scope，再使用现有 Workspace
访问与创建权威。新建要求 storage 与 registration 一致、Workspace 为 ACTIVE、具有
读取与创建权限，并使用固定 `csi-files-retirement-tools/1` 与
`csi-files-retirement-policy/1` 引用。先分配 Session UUID，再导出以 Session 隔离的
`kubernetes-workspace` request。远端 mount root 来自 registration，不在宿主机解析
文件系统。V48 增加可空 `runtime_request_key`，不为旧数据回填成功证据；CREATE 将它与
`tool_profile=csi-files-retirement/1` 同时插入。

Capability digest 是精确 `CsiFilesRetirementProfile.CAPABILITY_MANIFEST` UTF-8
字节的 SHA-256：profile 为 `csi-files-retirement/1`，工具按 `read_file`、
`write_file`、`edit` 排列，包含经过认证的 file history、invocation protocol 2，以及
保留结果至 finalize。Request 身份复用已有长度前缀 managed-context 编码器，不使用
规范化 JSON；规范化 JSON 仅用于私有 CREATE 命令独立的幂等 digest。

精确重放复用原 Session，验证持久化 request 固定点，不因 agent revision 或
Workspace registry 变化重写身份。冲突、registration/pin 损坏、权限缺失或插入失败会
回滚整个命令。旧的绑定及非绑定 CREATE 保持原 profile 和空 request pin。该入口当前
只持久化未启动 Session；打开执行前仍须完成下文的原 binding 准入检查和 worker/Harness
组合接线。CREATE 固定点本身不是准入关闭、application cut、DRAINED 或挂载授权。
首个 profile 只接受 Workspace 根目录选择（`cwdRelative="."`）。子目录执行留待
后续支持，不会静默映射到已注册的 mount root。

### 4.2 协同准入与成员清单

当前本地 guard 批次使用调用方原事务与 current locking read，顺序为 placement
domain、排序的 slot、binding history、持久 Session pin。从 Session 冻结 context
重建原 request，要求精确一个原 slot 与 generation-1 binding；缺失、冲突、孤立或
replacement 权威都拒绝。Legacy profile 判别扫描完整匹配的上游 history，检查是否
存在冲突的新 capability；保留两个 binding 候选即可检测歧义，但不能以最初两行
抽样证明 CSI 权威不存在。保留全部已锁 slot，完成上游引用枚举。
Binding history 还按每个 slot 的 request key 和 active-binding 引用枚举，
不依赖其 isolation key。相同 request key 的第二代记录即使携带冲突的 isolation key，
仍须阻塞原 writer；只按 Session isolation key 筛选会遗漏该历史。
最初两个之后的普通 slot 也可能指向 foreign CSI binding；即使该 binding 的
isolation key 不同，这种冲突引用仍须阻塞 legacy fallback。不存在冲突 CSI 权威的
多个普通 slot 保持原 legacy 行为。

原生 Session mutation 组合共享 fence 的顺序为 placement domain → 既有 retention
tenant → 完整 slot/binding history 与 Session pin → journal head。外层 publication
receipt 事务在原结算、tenant 和 head 锁之前先取同一个 fence，覆盖首次提交与
REFERENCED 重放。这避免嵌套原生 commit 引入的旧 LOCAL tenant/domain 逆序，并保持
删除和结果投影既有的 tenant-before-Session 顺序。不能用普通 profile 快照跳过完整的
current CSI 判别。既有 retention 等待与整体事务 deadline 仍需资格验证。

首批生产消费者为 binding provision、Runtime Session admission 与直接 CAS、原生
writer acquire/renew/recovery/commit/resource publication，以及普通 release。
此 profile 只允许原 UUID Runtime Session，released 历史仍参加成员检查。Worker RPC
后的 acquire completion 必须再次检查准入。缓存 acquire 与最终 acquire 返回在父锁下
以 current read 检查已有 READY Session；该检查不会插入或更新缺失、已改变的 Session。
结果读取和结算 continuation 保留单独的 DRAINING 语义。原生 writer generation 固定为 1：精确
live reacquire 合法，过期接管与通用 seal 拒绝。普通 Runtime Session release 在 worker
RPC 前拒绝，包含已保存的 RELEASING 重试。该本地批次仍需完成下述 execution、
activation、Managed Agent、retention 及完整异步协调；它不是完整
准入闭包，也不授权挂载或执行 worker。

将既有 binding fence 扩展到新 Runtime Session、execution、publication、activation、
turn 和生命周期配置的生产准入路径。退役可完成原 continuation，但不能在它们结算期间
接受新 turn。Worker 也必须在最终异步变更/启动边界执行相同区分。

首个 profile 在 CREATE 时固定一个 Session 和 capability/provision identity，隔离为
`session`，使用该精确 Session 身份。Java warm-up 在 Harness 打开前启动，但不会
等待完成；失败、禁用或异步 warm-up 都不能保证原 binding 已存在。TypeScript tool-turn
warm-up 则发生在持久 Session 打开之后。初始 provision request 不要求 activation，
也不能将 binding 缺失视为 LOCAL Session。新 profile 缺少原 binding 时保持未启动；
在该权威可用前，writer 准入明确拒绝。

在既有权威上增加两个固定点：新 profile CREATE 时不可变的
`managed_agent_session.runtime_request_key`，以及接受首个 activation 的同一事务中
一次性固定的 `qwen_runtime_binding.first_activation_journal_revision`。复用已有
版本化 `tool_profile`。从原 journal transaction 校验 activation ID、epoch 和 writer；
派生缓存不是另一套权威。Genesis/首个 writer 可以早于该固定点，execution 授权不能。
同一父级准入锁下证明此前没有已授权 execution，包括历史 terminal 记录。此 profile
拒绝任何后续 replacement activation。

在调用方原连接中按 placement domain → 排序的 request slot → binding history →
持久 Session/retention/head 顺序解析精确 CREATE request。检查歧义和孤立权威，
不能选择首个 Session 匹配，也不能假定当前 active binding 就是原 binding。即使
binding 缺失，也须读取持久 Session profile。MySQL read-committed 和 repeatable-read
下，准入敏感成员检查均使用 current locking read；先前的 consistent read 或
isolation-key 索引不提供父级 fence。旧 profile 保持现有契约。
[MySQL locking-read 契约](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)
要求活跃事务；普通读取不足以保护后续相关变更。因此资格验证须建立真实锁等待，
并在等待后检查已提交的退役状态，包括已预热 RR snapshot 的情况。

为新身份显式扩展当前仅支持 workspace 的私有 CSI adapter 及其 ACK transport 检查；
保持原 `workspace`/null 契约。后续公开 resolver 消费同一身份，不转换本地路径，
也不从当前请求推断 Session。

分别枚举以下来源，再按完整原身份关联：

1. 该 binding/generation 的所有 Runtime Session，包括 released 记录。
2. 所有 Session 的全部七种 Broker execution 状态，而非仅 active 工作。
3. 原 publication 及 admission/receipt/resource/ACK 记录，包括无匹配 execution 的记录。
4. 持久 Session head、activation、journal/checkpoint 与 file-history 尾部工作。
5. Worker 待开始准备、调用历史，以及已配置或已使用的 provider/Hook/MCP/Shell/publication 生命周期记录。

孤立记录、意外的第二个 Session/activation、冲突关联、不支持的记录、缺页或超界都产生
blocker。零 execution 不能证明零 publication 或零生命周期活动。确实为空的 Session
也需要原生初始状态/journal 验证；缺少选定 publication 不构成该证明。

复用 repository 的 inventory 边界，但将 JDBC reader 扩展为一个新的 consistent
snapshot。现有逐页 `findByBinding` 不是快照。采用确定性排序和完整 manifest digest。
初始固定上限为每页 100 行、每类清单 4,096 条，同时保留 checkpoint verifier 的
32 MiB decoded/48 MiB JSON 上限。超界即阻塞，不截断、抽样或自动提高限制。

Writer 审计包括 Broker Session/execution 的 findOrCreate、admit、authorize、
异步 acquire 完成和普通 release；Session Store 的 acquire/renew/seal/recovery/
commit/publish；Managed Session 的 turn、lifecycle、cwd/configuration 变更；以及
retention retirement/collector claim/confirm。新 profile 的每项变更在子锁之前取得
相应父级 guard。精确原重试和 cut 前所需结算保持可用；内部 repository seam、旧
profile 合法的 writer 接管都不应被声称为 HTTP bypass。

只有所有生产 writer 都参与父级 fence，成员集合才算封闭。明确列出并测试这些 writer，
包括直接调用 repository `findOrCreate` 的路径，以及持久 Session/retention 变更路径。
提交 cut 前，在对应锁下重新枚举，比较完整成员和 revision。不完整扫描的 hash 不是 fence。

## 5. 证明应用结算

### 5.1 Execution 分类

| 原记录                                         | 必须采取的处理                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `PREPARED`，从未授权                           | 通过原有受 fence 保护的路径取消；证明无 dispatch 授权，保存原 not-started outcome 及覆盖它的 journal 状态 |
| `DISPATCHING`、`EXECUTING`、`CANCEL_REQUESTED` | 等待或取消原工作；不制造终态结果                                                                          |
| `SETTLED`，支持的 v2 文件工具                  | 按下述文件结果路径验证                                                                                    |
| `SETTLED`，deferred-v3 publication             | 验证原 publication、精确 receipt、最新 checkpoint 与原 worker 持久 ACK                                    |
| `UNKNOWN`、`ABANDONED`                         | 阻塞正常退役，即使 active execution 计数为零                                                              |
| 其他模式、缺失或冲突结果                       | 阻塞；不在新 worker 上重放                                                                                |

本文不会让丢失响应的 v2 dispatch 变得可恢复，其不确定性仍是 blocker。通用 cancelled
状态也不能证明执行从未开始。

### 5.2 v2 文件结果证明

在既有原生 receipt/checkpoint verifier 旁增加专用验证器。导出有界的原 Session
快照，不要求 publication。将完整原 Broker result、execution 身份、request digest
和 terminal status，与 Hosted 转换得到的精确 `managed-tool-outcome` 和
`tool_result` 对应。复用或提取该确定性转换，不在 Java 中另写近似转换。

通过 captured head 重放原生 journal，证明最新 checkpoint 已消费原结果和完整 tool
batch，没有未覆盖的后续 tool 或待完成 history/undo，并且预期 file-history snapshot
已提交。校验资源字节、hash、引用与 quarantine 状态。SQL journal revision 和事件
sequence 是两个不同坐标。保留原生 turn-completion checkpoint 规则，包括合法的伴随
事件；不能要求 checkpoint 覆盖其自身更晚的提交事件。

首个 profile 中，省略结果、对象存储结果、压缩历史或不支持的结果都阻塞。文件工具的
明确错误可以结算，前提是完整原错误结果及其 effects/history 均已入账；错误本身不证明
没有副作用。v2 结果不需要伪造 publication ACK。空 ACK obligation 必须由独立
publication 枚举证明。

### 5.3 Publication 与生命周期义务

每个支持的 deferred-v3 publication 都复用既有 original-only settlement、精确已提交
`tool.receipt`、最新原生 checkpoint 和持久 ACK 契约。仅有 `FINISHED`、`REFERENCED`
或 Broker `SETTLED` 均不充分。完成全部 ACK 调用时，原 Runtime Session 仍须为
`READY`，原持久 writer/activation 仍有效。读取旧 ACK 是历史证据，不能跳过新的权威
与资源校验。

不能因为一个 publication 收到 ACK，就清掉既有 capture、publisher、provider、Hook、
MCP 或 Shell blocker。现有完整 profile 在其完整生命周期清单和最终结算契约得到验证前
仍不具备资格。尤其是最新 MCP `released` 记录不能替代此前 configuration/operation/
drain 历史。M5c 的普通主机进程组工作可为未来 Shell 证明提供基础，但不证明 Kubernetes
容器停止或 CSI unpublish。

### 5.4 Application cut 与 worker finalization

按以下顺序执行，RPC 和 replay 期间不持有数据库锁：

1. 提交原 retirement/seal，再封住原 worker；保留原 result/cancel/settlement 路径，按需续约原 writer。不能创建 replacement activation 来补旧 ACK。
2. 枚举、完成原结果、提交 checkpoint，收集全部必要 ACK。取得 worker 候选观测：没有 pending start、调用、history 尾部工作或生命周期 blocker。
3. 通过原 Harness 新的 CSI retirement-close 操作，停止新 Session 变更和 activation 续约，等待已准入 continuation/renewal 完成，再由仍有效的原 writer 提交原生 `releaseActivation` boundary。不能调用通用 close：它还会在 coordinator 提交 cut 前封住 journal。
4. 重新导出、语义验证原历史，包括精确的 terminal activation boundary 及资源。在新的有界事务中加锁，重验成员、原 writer、当前 head、结果与资源。提交不可变 application cut，原子 seal journal/撤销 writer 权威，并记录最终 sealed head pin。Retention、writer 获取、activation 替换与普通 release 都须遵守 retirement fence。Runtime Session 保持 `READY` 供 worker finalization 使用。
5. 携带 cut digest 调用原 worker 新版本的 `finalize` 操作。它原子比较 sealed invocation/history inventory 与 cut，并检查最终变更屏障；原尾部工作未结束时等待或拒绝，并永久拒绝后续变更。之后仅允许原 read/status/result 和相同 finalization 重试。
6. 重新校验并保存 finalization receipt，通过窄 CSI repository 操作关闭原 Runtime Session，在同一事务标记 `DRAINED`。保留 binding slot、handle 与 physical holder。Harness 本地 dispose 停止续约并释放本地资源，不再追加 activation boundary 或改变 cut 的 journal head。

第 3 步只在全部原结算与必要 ACK 成功后执行。Terminal boundary 必须绑定精确的已结算
prefix，不接受普通工作后缀或 replacement activation。新的 cut verifier 显式处理此
boundary，不能声称更早的结果 checkpoint 覆盖了后来的 activation event。Boundary 与
cut 之间崩溃时，仅允许仍有效的原 writer 继续；过期或 boundary 不完整就阻塞，不能新建
activation 或重跑 live ACK。Cut 之后发生崩溃/冲突时，保持携带相同 cut 的 `DRAINING`；
恢复原 finalization，绝不重新开放 Session 或换另一个 manifest。若 worker 无法确认，
报告 blocker 并保留所有权。新协议 fixtures 必须拒绝不同 cut、Pod、generation 或
profile。现有 boot-v3/`managed-csi/1` worker 不能原地升级为此契约。

从 terminal boundary 开始使用范围严格的历史验证器。现有 live ACK helper 要求持久
Session 为 ACTIVE、activation 有效、Runtime Session 为 READY；这些条件在关闭过程中
会有意失效。Cut 前要求原 writer 和精确原生 boundary；cut 后要求已提交 cut 和最终
sealed head。验证已提交 receipt/resource/ACK pin 未变及当前 quarantine，不重新取得
writer。语义验证器在可信 coordinator 的固定 bundle 中运行，不接受 worker 提供的
`matched` 标志；其结果还须与当前加锁的权威重新核对。

使用 Session close/archive/delete/cwd-change 原有持久 lifecycle operation identity
接入。通用 `SessionLifecycleCoordinator` 在 Workspace close 前先关闭 Harness，并等待
writer 退出，不能原样用于 CSI。CSI 按上述顺序执行，达到要求的 retirement 阶段再完成
原 lifecycle operation，不增加第二套 Session lifecycle ledger。

## 6. 建立物理证据

### 6.1 必需的来源与部署验证

`DRAINED` 后，使用 UID 前置条件请求正常删除精确的原 bare Pod，在发请求前保存 stop
intent。不将 force-delete、按名称删除 replacement、lease 过期或 Pod 消失当作证明。
Kubernetes 的 [Pod 生命周期文档](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
明确指出，API 删除可能先于实际终止。

首选证据源是部署方管理、范围有限的 node/CSI evidence collector，与原容器 runtime
和 CSI plugin 接通。从 Pod 创建之前开始观测，将成功 publication 持久化，并持续覆盖
termination 和 unpublish。本文不引入通用节点管理 agent、特权 tool worker、worker
hostPath 或 worker CRI socket。以 read-only 方式挂载 socket，不等于容器 runtime API
只读。

Collector 是新增的可信接入要求，不是已有能力，也不授权安装特权集群软件。物理阶段
交付前，部署 owner 和维护者须验证证据来源、权限约束以及固定的 driver/runtime image。
若没有可信来源，可以先实现聚合阶段，物理 release 保持关闭。不得以当前用于诊断的
`KubernetesCsiLogReader` 替代。

Collector 到 coordinator 之间使用身份认证的传输，并将只追加的来源记录持久保存在退役
Pod 和卷之外。绑定 source principal/version、Node UID/boot identity、runtime
task/sandbox identity、原 Pod UID/container/image identity、plugin Pod/container/
image incarnation、原 publish target、registration/physical key 与 publication
cursor。签名只能认证 collector；来源验收还必须证明观测真实且完整。

### 6.2 Stop 与 unpublish 契约

`OriginalStopped` 证明原容器及其容器边界内的后代均已终止，在已验证的 bare-Pod 契约下
不会重启或再创建 writer，并且匹配预先记录的 runtime/cgroup identity。只有 Node UID
却没有 boot identity，或使用被复用的 PID，都不充分。初始 profile 不允许逃离边界的
进程、额外容器或不支持的准入变更。节点失联、重启、runtime 替换或观测缺口均阻塞。

`OriginalUnpublished` 证明原 writer 终止之后，精确的原 `volume_id` 和 `target_path`
完成了成功的 `NodeUnpublishVolume`，并与此前成功的 `NodePublishVolume` 关联。
[固定版本 CSI 规范](https://github.com/container-storage-interface/spec/blob/e6fc13ea4d529db12e211ef79c924ee3186c39d5/spec.md)
定义了这一 target 范围的幂等操作。空 target 重试、无关 target、`NodeUnstageVolume`、
detach 或 VolumeAttachment 消失，都不能独立补足缺失的原 publication 证据链。同节点
复用时可以保留 staging 和 attachment。

在来源的保留策略删除记录前持久化证据。通过 runtime/plugin 接入验证因果顺序；不同
来源的墙上时钟时间戳不足以排序。拒绝来源替换、截断、缺口、未知 parser version 和不
支持的重启。Coordinator 重启后只能续接已验证连续的原 stream；collector/plugin
重启在首批验证范围中阻塞。Kubernetes [日志文档](https://kubernetes.io/docs/concepts/cluster-administration/logging/)
说明日志 API 仅返回最新轮转段，因此反复检查 API 身份并比较相同前缀，不能证明完整的、
绑定原 incarnation 的事件历史。

## 7. 原子释放、重试与迁移

语义 replay 与外部资源/来源校验在 SQL commit 之前完成。保留现有锁顺序：

1. Tenant placement domain → active slot → 原 binding。
2. Registration alias → 共享 physical holder → retirement。
3. 原 Runtime Session → 排序的 execution。
4. Tenant quota/retention → 排序的持久 Session head → publication。
5. Receipt/finish/journal/resource 权威 → ACK 与 retirement evidence。

保留既有十秒 SQL timeout，锁等待后按新的数据库时间重验 deadline。超时回滚，不证明卷
空闲。事务内不执行 Kubernetes、worker RPC 或对象 I/O。

最终事务重新检查已提交的 cut、finalization、原 stop/unpublish 记录、全部原身份/
revision，以及当前资源 quarantine/protection 状态。随后在同一连接、同一事务中把
retirement 标为 `RELEASED`、将原 binding 设为终态、仅清除其 active slot，并仅释放其
physical holder。增加窄 repository 方法；不能放宽通用 sealed-binding CAS，也不能
从 Workspace release 事务内部调用另起事务的通用 CAS。

历史 retirement/evidence 记录不清除原身份。所有权 revision 每次转换递增：初始
released 0 → reserved 1 → draining 2 → released 3 → 下次 reserved 4，依此类推。
保存并比较实际原 reservation/drain revision；同一变更移除所有 reader、snapshot
exporter 和 ACK consumer 中固定 1/2 的假设。无需引入没有消费者的所有权 `ACTIVE`
阶段。

新 reservation 使用新的 reservation UUID、runtime generation 和 Pod，不能继承旧
ACK 或 release receipt。跨 tenant alias 仍在同一 physical key 上串行。不能持 SQL
锁等待，也不能因 busy 自动改选其他 storage profile。

丢失 release 响应时，即使卷已归他人，重试也只返回已提交的原 release receipt。历史
查询不应要求当前仍为 `DRAINING` holder，但也不能变更新 holder，或为已释放 retirement
提交新 ACK。缺少原 handle、CREATE 不确定仍阻塞；“没有 handle”不证明从未挂载。

实现时使用下一个可用 migration 版本。保留旧 LOCAL 行、现有 CSI identity 字节和 ACK
digest。不回填 `DRAINED`、`RELEASED` 或正向证据。在所有 coordinator writer/reader
支持新 schema 和 revision 前不启用新 profile；启用前退出旧 coordinator。既有完整
profile retirement 仍关闭，除非其完整证据符合明确支持的契约。

## 8. 公开接线、所有权与诊断

公开选择是最后阶段。经过审核的 operator registration 选择已验证 CSI profile 与部署。
Tenant 输入只提供获授权的 Workspace/storage reference，不提供原始 PVC/driver/
handle、endpoint 或 proof。`ManagedAgentProperties`、`EmbeddedRuntimeBroker`、
Workspace resolution 和 Hosted profile guard 必须对 Session 隔离与 capability
identity 一致。Java server 不能通过主机本地文件系统解析远端 Workspace。保持
local-process 行为；不支持的 CSI 必须拒绝，不能回退到 primary/local runtime。

为当前仅支持 LOCAL 的 `WorkspaceExecutionStore`、`WorkspaceStorageKindGuard`
及 transport claim/release 路径增加独立 CSI 分支，不削弱 LOCAL 检查。显式 profile 还
须贯穿 `ManagedAgentStore`、`QwenHostedHarnessConnector`、Hosted Session create/load、
`HostedWorkspaceBroker.acquire` 与 tool-intent 构造。纯文件创建不仅拒绝不支持的工具
请求，还须拒绝 Hook catalog。

| 接口面                                  | 所有权与执行边界                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Operator registration 与 collector 验证 | Deployment/registration 范围；普通 Session 无此权限                                                           |
| Workspace 选择与文件执行                | Selected-runtime 范围；匹配注册存储、Session、profile 和 generation                                           |
| Result、checkpoint 结算与 ACK           | 原结算/ACK 使用 live authority；terminal boundary 后历史验证，cut 前要求原 writer，cut 后要求固定 sealed head |
| Retirement 推进与 release               | 持久原 Workspace/binding generation；特权 coordinator 推导所有 endpoint 与 pin                                |
| Worker seal/finalize                    | 精确原 runtime/Pod generation；调用方不能指定 replacement worker                                              |
| 物理证据接入                            | 已验证 deployment source 范围；不属于 tool/runtime HTTP 权限                                                  |

从私有 service/offline coordinator 操作开始，聚合验证不需要新增公开 admin HTTP 路由。
建议提供 inspect 和按 retirement ID 有界推进。一次推进最多恢复到下一个安全转换；调度
方可重试原 ID。调用者不能提交 manifest、credential、成功标志或目标 URL。

报告 phase、证据阶段、blocker code、有界计数与是否可重试。区分
`pending_original_work`、`unsupported_profile`、`unresolved_checkpoint`、
`original_authority_expired`、`source_gap`、`physical_stop_unproven`、
`unpublish_unproven` 与 `release_conflict`。日志/audit 可保存受保护的身份 digest 与
source cursor；普通错误不暴露 bearer token、storage handle 或原始文件结果。

## 9. 实现阶段与影响文件

| 阶段  | 交付                                                                              | 退出条件                                                          |
| ----- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| K2-A1 | 有界完整快照、execution 分类和 v2 文件/原生 checkpoint verifier                   | 复现当前缺口；拒绝过期、不完整、孤立证据；不增加 release 路径     |
| K2-A2 | 新闭合文件 profile、原 Session 准入 fence、application cut 和 worker finalization | 原正常文件工作达到聚合 `DRAINED`；保留完整 profile 的全部 blocker |
| K2-B  | 合格的 pre-CREATE 物理 collector 接入与 stop/unpublish receipt                    | Coordinator 重启后保留真实原来源证据；来源替换/缺口测试仍拒绝     |
| K2-C  | 单调所有权周期与原子释放/新 reservation                                           | 两个独立 coordinator 安全交接同一卷；崩溃/竞争矩阵通过            |
| K2-D  | 已验证 profile 的公开 Spring/Hosted 选择                                          | 公开文件流程和错误使用选定 CSI runtime；完整集成验收通过          |

K2-A1 可以立即使用现有权威与 fixture 开始，不依赖新的云实验。K2-B 来源验证可与 K2-A
同时调查，但 K2-C 的正向验收依赖两者。F2 保持独立；K1 既有 LOST/tenant placement
guard 在独立验收前保留。

预期实现范围如下；当前 K2-A1 已修改快照 store、私有证据入口、原生校验器和
共享结果转换：

- `packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/store/`：扩展 `WorkspaceCsiReservationStore`、`WorkspaceCsiCheckpointSnapshotStore`、`WorkspaceCsiWorkerAckStore` 和 publication/resource 权威；增加小型 aggregate coordinator 与增量 migration/evidence 表示。
- `packages/sdk-java/runtime-broker/src/main/java/com/alibaba/qwen/code/runtimebroker/`：binding/Session/execution repository 的快照与同连接转换边界、`WorkspaceExecutionProfile`，以及精确原 stop intent 处理。
- `packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/service/`：CSI provisioner、identity、resource guard、Workspace resolver/transport 与 embedded Broker；Spring 配置和 Hosted connector/store profile 校验。
- `packages/core/src/managed-runtime/`：原生文件结果/checkpoint 证明及同步 capability 契约；保留现有 receipt verifier 语义。
- `packages/cli/src/serve/`：`managed-context-worker.ts`、`managed-runtime-tool-executor.ts`、CSI envelope/routes、Hosted Session/Broker/tool-turn 准入和确定性文件 outcome 转换；共享 Java/TS fixtures 覆盖新协议，不放宽旧 fixtures。
- Deployment qualification adapter：具体打包方式和权限审查属于 K2-B。不向通用 Broker 加入特定云 CLI 调用。

只构造、注册新 profile 允许的 worker 工具和路由，并约束 executor lookup；仅修改向
模型声明的工具列表不充分。现有无条件构造的 Shell、provider、Hook、MCP 与 publisher
不能给新 profile 留下隐藏的生命周期义务。保留已验证的 file-history 子集：当前
`raw-file-history` 在进入 provider 生命周期代码前复用 provider control route。只保留
或提取文件工具需要且已认证的 file-history action，保持 seal 后仅允许 snapshot 的限制。
禁止 provider 生命周期不能移除 Write/Edit 的 history 依赖。为闭合 envelope 的变化在
两种语言中分配明确的新 wire version 和 digest；旧 boot/profile parser 继续拒绝额外字段。

### 9.1 本地 K2-A1 进度

本地原型在一个新的 MySQL repeatable-read、read-only consistent snapshot 中导出
有界 SQL/原生应用观测，包含已释放的 RuntimeSession、全部七种 execution 状态、
独立 publication 子记录、持久 ACK、原生 Session 与资源引用。缺失 Session 历史
显式阻塞。原生 v2 文件证明复用实时 Hosted response 转换，要求原 intent、模型调用、
outcome、tool-result 消息、已消费 checkpoint 与已结算 file history 相互匹配。
对象存储或特殊 response part 仍未验证。

私有 Java 入口支持 `inventory <retirement>` 和
`file-checkpoint <retirement> <execution>`。私有 TypeScript 证据入口识别两种
快照格式与 inventory 格式；清单输出为 `observed`，包含 digest、数量、逐 execution
观测和 blocker。退出码零只表示观测已解析，不能证明准入已封口或退役成功。
此原型不执行 release 变更，没有新的公开 profile 或物理 collector。SQL/原生观测
不证明 worker 待开始工作或完整生命周期成员。原始输出包含保留的工具与历史数据，
应存放在操作者的私有证据目录。

针对性原生测试覆盖已消费和原子 turn-complete 证据、错误模型/定义/结果、待处理
history、全部 execution 状态、孤立成员和不一致资源。必需的真实 MySQL 8.4 测试
确认：跨越并发提交的第一次快照保留 102 个成员与旧 SEALED head；新的快照看到
103 个成员与新 ACTIVE head。独立 test-engineer 复现并验证了 JDBC 时间类型映射
修复。原生 fixture 使用真实 Session/journal/checkpoint API，但 Broker result 与文件
fingerprint 为合成数据；SQL 并发 fixture 的 journal 仅为映射数据。另一次真实 MySQL
Java→TypeScript round-trip 将原生 journal 字节通过生产 Session Store 提交，导出原
Java JSON，直接在已构建私有证据入口重放：唯一 execution 匹配且无 blocker，
object/ref/checksum/语义 journal 矛盾均拒绝。该保留的 round-trip 不是 CI 每次重生成
的 golden contract。这些测试只验证快照和证明组件，不执行真实 worker 文件操作，
不能替代 K2 云上卷交接验收。

## 10. 验证与验收

以下是计划，不是测试结果。行为实现前，使用 `test-engineer` 与仓库 E2E 流程复现每项
基线缺口，并形成可执行案例。运行 package-focused 测试、Java 契约、根 build/typecheck
及适用 bundle，再对实际拟提交 commit 自审与独立审查。

| 分组            | 必须观察到的结果                                                                                                                                |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 准入竞争        | 新 Session/turn/activation/dispatch 在每个异步边界都不能越过 seal；原结算仍可工作                                                               |
| 成员完整性      | 多页全状态扫描、孤立 publication、第二个 Session/activation、并发插入/更新都不能制造虚假的空或完整证据                                          |
| 文件结算        | 真实读写编辑与明确错误；精确原生转换、完整 tool batch 和最新 checkpoint；省略结果、pending history、compaction 与 resource quarantine 均阻塞    |
| Publication ACK | 检查每个原 publication；ACK 先于 Session/writer 释放；replacement Pod、旧 writer、被改 receipt 或仅历史 ACK 均不能通过                          |
| Finalization    | Activation boundary/cut 崩溃及在途续约保留原 prefix；pending start 与 history 竞争拒绝 finalize；cut 后崩溃恢复相同 cut；原权威过期不能制造结算 |
| 数据库          | 真实 MySQL 独立连接/进程；锁等待、等待后 deadline 重验、rollback、restart、损坏及各 release 崩溃边界；不出现 slot/holder 半释放                 |
| 物理来源        | 真实原 cgroup/task stop 与 target unpublish；错误 target/UID/boot/image、轮转、丢事件、collector/plugin 重启和节点失联均阻塞                    |
| 交接            | 新 worker 读到精确旧卷内容；旧 worker 不能写；同卷并发 alias 仅一个胜者；多轮 reservation 可用                                                  |
| 公开选择        | 仅已验证 CSI profile；两独立卷互不阻塞；同卷 Session 串行；无 local/primary 回退                                                                |
| 回归/升级       | 保留 LOCAL、K1 scratch、完整 profile、migration、旧 ACK 字节与历史查询；混合版本不能开启 release                                                |

完整正向实验使用隔离注册的临时卷、两个独立 coordinator 进程，以及位于退役 worker
之外的持久 MySQL。固定准确 commit、bundle/image digest、migration、cluster/runtime/
CSI version、collector version 和全部原对象身份。在 cut、finalization、stop receipt、
unpublish receipt、release commit 的前后验证 coordinator 重启。展示新 worker 的内容，
并独立证明旧 writer 被排除；仅新挂载成功不够。

仅操作测试拥有的对象。交接期间保留 PVC/PV；只在最终清理时通过已保存 UID 检查后删除，
并验证实际回收。记录清理结果和证据缺口。CI、fixture、worker 内 H2、普通日志探针或旧
云上测试，都不能替代完整集成验收。公开启用要求维护者审查与 K2-A 至 K2-D 全部关卡通过。

## 11. 已作决策与剩余验证

本提案决策：复用既有权威；区分 v2 文件证明与 publication ACK；只在原结算完成后冻结；
区分 `DRAINED` 与物理 release；原子释放；从显式版本化的窄 profile 开始；公开接线和 F2
后置。不引入新的通用存储框架、operator/CRD 或不确定工作的自动恢复。

K2-B 前，部署 owner 与维护者必须选定并验证实际 node/runtime/plugin 证据来源及其最小
权限接入方式。K2-D 前，维护者必须审核公开 configuration/profile API 与支持的部署矩阵。
这些是实现关卡，不表示当前 ACK 集群或其他 CSI driver 已满足要求。跨节点交接、更广的
history/resource 格式，以及 Shell/provider/Hook/MCP profile，都需要在首个正常纯文件
交接之后单独验收。

K2-A1 验证后的下一项实现是 K2-A2：验证闭合文件 profile 与原 Session 变更 fence，
然后持久化 application cut 和精确 worker finalization。不放宽任何 release 门禁。
