# Managed Session：记录格式、提交与协议限额

[English](managed-agent-session-storage.md) | [简体中文](managed-agent-session-storage.zh-CN.md)

更新日期：2026-09-23。原 2026-09-11 的实现记录使用源码基线 `a836081466`、方案 `2ec07afb72`；保留这些历史状态，不冒充本轮重新验证。补充设计基线为 `code_agent@1478e7b632eb237bc3f40ea574ce90782e1cf4c3`，集成参考 draft `bad721f22fcd8cfad9ec22e98f69fec75b20b6f0`，本地 `f5088d2e`。本轮仅文档，第 2.3、2.4、7.1 节均为待实现、未验收的补充契约。本文是全量目标的规范性设计，补齐[私有协议](managed-agent-control-protocol.zh-CN.md)原有的格式和限额冻结项。§1 的三个 subtype 与 header 字段、§2 的共用字段规则、§3/§3.1 的封闭 kind 与 domain、§5 的记录与事务限额已作为 `packages/core/src/managed-runtime/managed-session-records.ts` 落地；§4 的事务提交（先事件后 marker、`previousCommitDigest` 链、幂等键、写失败停止推进、完整前缀恢复扫描）由 `managed-session-authority.ts` 的 `LocalManagedSessionAuthority` 通过既有 `SessionWriterLease` 实现并有定向单测。原未完成范围包括 lock schema 3 的认证换锁、§2.1 资源仓库、RestoreBundle、坏尾恢复、目录/标题等各适配器与投影，以及四处普通 factory 接线；其中 lease 截断能力的原已实现记录完整保留在 §4，不等于完整恢复验收。现有公开签名仍按[268 项兼容映射](managed-agent-session-method-map.md)保留。

## 1. 唯一载体与版本决策

普通 Managed 继续使用所属 workspace/runtimeBaseDir 的原 Session JSONL 路径，不新建一份竞争历史。增加三种 ChatRecord system subtype：`managed_session_header_v1`、`managed_session_event_v1`、`managed_session_commit_v1`。`uuid/parentUuid/sessionId/timestamp` 保留原字段；event 内的领域内容是唯一事实，普通 user/assistant/tool/Goal/artifact 内容由 reader 投影产生，不再同时追加等价旧记录。legacy 和实验日志保持原格式。

header 记录 `formatVersion=1, minimumReader=managed-session/1, sessionKey, engine=managed, definitionRef, rootSnapshotRef, createdBy, baseTranscriptProof?`。历史导入保留已封存的旧记录前缀，header 引用其长度、hash 和活动尾；新事件从 sequence=1 起，所有新读者同时重建前缀与已提交增量。创建空会话只提交 header，不触发 prompt 或工具。

兼容保护不依赖旧 reader 理解新 subtype。Managed authority 的物理 writer 使用新增 lock schema 3，active/封存状态都保持该 schema；Managed 关闭保留经过核验的 sealed 3 锁，只有支持它的 authority 可以认证接管，不能按旧 release 删除为无锁。当前 schema 1/2 reader 对未知 schema 报 malformed 并拒绝，作为基线旧二进制的防写屏障。旧二进制的纯展示可能忽略新 subtype，须明确“不支持此版本”，不能把它的部分视图作为完整恢复依据。

schema 3 的取得必须保持旧 writer 也认识的排他屏障，不能先调用普通 `release()` 留出无锁窗口。现有 `readOwnedLock` 同时钉住 inode 与锁文件原始字节，因此不能改写锁后继续使用旧 lease；原 `sealForHandoff` / `takeOverSealed` 的认证交接使用 `<lockPath>.claim` 和精确文件替换，旧 acquire 在安装锁前后都会检查该 claim。schema 3 升级扩展这条交接路径，创建新 lease，不改变旧 lease 的自持检查。

容器升级顺序固定为：无活动执行且旧 writer 已排空、封存 → authority 取得同一 `.claim` → 核验旧 sealed 锁与 transcript 前缀，持久化原 operationId 的 plan/proof 和 schema-3 candidate → 在 claim 内按原身份保护替换主锁并同步文件/目录 → 以新 schema-3 lease 提交 header 与迁移完成事务 → 确认主锁及日志持久后按精确 owner 释放 claim。plan 保存原锁/前缀 proof、目标 owner/schema/candidate 摘要与阶段，只有校验依据，没有排他能力；排他来自 claim 与 schema-3 主锁。旧二进制在 claim 取得前可能赢得竞争，此时升级不得改写文件，返回冲突并重新排空核验。claim 存在期间旧 writer 拒绝取得锁；claim 撤除后 schema-3 主锁继续防写。

每个同步/替换窗口的崩溃都保留原 plan、claim、candidate 和已核验副本。新 authority 只有核验原 owner 已退出及全部身份/proof 后，才能认证接管 claim 并续做；不得先删 claim 再重试。schema 3 尚未发布时可在同一屏障内核验并恢复原封存锁；schema 3 已发布或新格式已有写入时，只沿新格式完成或保持 blocked，不降回 schema 2。无法证明阶段或 owner 时保留屏障；不以 lease 超时、空 PID 查询或前缀 hash 代替接管证明。该升级只处理既有 Managed 的记录容器，不原地转换 legacy engine。

迁移完成使用已注册 history_maintenance 的 `operation=format_upgrade, phase=committed`，保存原/新格式和完整源前缀 proof；其受控 recordRef 可作为 §2.2 的 restoreProofRef。早于 header 的 plan 只是该操作的交接材料，不是第二份会话日志，也不能单独当作已提交恢复起点。

锁 schema 3 增加 `formatVersion`，封存分型另有 `lastCommitSequence, committedPrefixHash`；原 owner、进程开始身份与 sealed transcript proof 保留。active 锁不逐次重写这些提交摘要，日志 commit marker 才是当前位置；封存先 flush 日志、核验完整前缀，再原子替换并同步锁及父目录。崩溃在二者之间由新 authority 认证原 active owner 和日志，不把陈旧锁摘要当最新提交。未知版本不能回收为 stale。更老、绕过 writer 协议的程序不在兼容保证内。格式转换生成独立新 Session 的方案见[工具与历史](managed-agent-tools-history.zh-CN.md)，不原地切换 executionEngine。

保留 sealed schema-3 锁会直接影响既有维护编排：归档、取消归档、删除、重命名和 fork 走的是同一把锁文件的 maintenance-lease 分支，对未知 schema 判 malformed 后整个操作失败。因此这些路径必须先认识 schema 3（能读取封存分型、核验 `lastCommitSequence/committedPrefixHash`、并在完成后写回同 schema），才允许启用 Managed 写能力；否则该 Session 的维护操作明确拒绝并说明原因。不允许用“按旧 release 删锁变无锁”绕过，那会同时丢掉封存证明和防写屏障。维护操作对 Managed 会话的准入还须遵守 §3 的 lifecycle 矩阵：活动会话先关闭，未知物理 owner 时不推进到 closed/deleted。

## 2. 字段与编码规则

以下为所有新 validator 共用的规则；不改变旧 DTO 的宽松展示读取。

| 类型                        | 规范                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| StableId                    | 非空 UTF-8 字符串，最多 512 字节，拒绝 NUL/控制字符；tenant/workspace/session 另取既有解析器和此上限的交集，不能借新协议扩大旧 ID                                                                                                                                                                                                          |
| Sequence / revision / epoch | 非负 safe integer；正式事件从 1 起；加一溢出前停止准入，不回绕。expectedSequence 可为 0                                                                                                                                                                                                                                                    |
| Digest                      | lowercase SHA-256 hex，64 字符；业务 JSON 复用现有 managed canonical JSON 排序/编码，资源用实际 bytes；新 validator 另拒绝非有限数字、原始 JSON 重复键、循环和 prototype 特殊键，不声称旧解析器已有全部检查                                                                                                                                |
| Time / deadline             | UTC Unix 毫秒 safe integer；期限只约束相应操作，不推断物理工作已结束；恢复不延长原 deadline                                                                                                                                                                                                                                                |
| SessionKey                  | tenantId/workspaceId/sessionId 全部必需；路由从可信连接解析，payload 只做一致性校验                                                                                                                                                                                                                                                        |
| CommandMeta                 | v=1、operation、commandId、SessionKey；写命令有 contentDigest；执行命令带 expectedSequence，actor 分为 Harness activation fence、原 Runtime receipt binding、OperationGrant 三种明确资格，用户提交/取消不伪造 Harness fence                                                                                                                |
| DurableRef                  | resourceId/kind/schemaVersion/byteLength/digest；所有权和访问方式由 authority registry 解析，不接受绝对路径或模型提供的 URL；落盘位置、枚举与回收规则见 §2.1                                                                                                                                                                               |
| Event                       | v=1、sequence/eventId、SessionKey、kind、occurredAt；Harness 推进记录必需 ActivationSubject/scopeId/activationId/epoch；turn subject 保留 turnId，hook_operation subject 保留 operationId/occurrenceId；原回执引用原 InvocationBinding；模型外领域维护使用 OperationGrant 审计绑定，不虚构活 activation，payload 按 kind 的封闭 union 校验 |
| Transaction                 | transactionId、commandId/operation/contentDigest、first/lastSequence、eventCount、eventsDigest、previousCommitDigest；commit marker 自含上述摘要与 actor 的非敏感审计来源                                                                                                                                                                  |
| RestoreBundle               | formatVersion、SessionKey、engine、throughSequence、baseProjectionRef、checkpointRef、restoreBasis、restoreProofRef、tailPage、pendingCommandsRef、config/definition refs、recoveryStatus；checkpoint/null 的合法组合见 §2.2                                                                                                               |

订阅 cursor 编码为 `session-events/1` 加 Session 身份、sequence 和 projection revision；由服务端校验，不跨 Session 复用。原 Bridge eventEpoch、整数 eventId、transcript UUID 仍由传输适配映射。所有 optional 字段在类型表中明确允许缺省；其他未知字段拒绝。新命令包含媒体/大历史时引用完整资源，不把模型 `Content` 转纯文本。

### 2.1 资源仓库的落盘、枚举与回收

`DurableRef` 的 wire 字段不变。所属 workspace 的可信 registry 为 resourceId 做唯一预留，并绑定为 `session_owned {sessionKey}` 或 `workspace_owned {workspaceKey}`，保存生产者、持有引用和访问策略；该归属由服务端建立，调用方不能通过 payload 自报 owner。Session authority 只管理自身引用，通过受权的 workspace registry 解析共享配置和 pinned 内容。无 Session 的配置/内容操作使用真实 WorkspaceKey，不创建假 Session。

| 事项       | v1 规则                                                                                                                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根目录     | `session_owned` 在原 workspace/runtimeBaseDir 下的 `resources/<sessionId>/`；`workspace_owned` 在同一受控根的 `workspace-resources/`，由 workspace 控制 owner 持有，允许在 Session 创建前存在。不使用系统临时目录；workspace 资源不随某个 Session 移动或删除                 |
| 命名       | `resourceId` 是服务端生成的不透明 StableId，路径为 `<root>/<kind>/<resourceId>`；不接受调用方给定路径片段，不用内容 digest 命名（避免跨 Session 去重把生命周期耦合起来）                                                                                                     |
| 枚举权威   | Session 已提交事件/保留 checkpoint 的引用闭包，以及 workspace 已安装配置、显式用户 pin 和跨 Session 持有项共同决定可达性；各 owner 保存自己的事实，不复制 Session 历史。目录扫描只发现候选孤儿，不能据缺少 Session 引用推断 workspace 资源可删                               |
| 回收       | 实际资源 owner 仅在零保留引用、零在途读取、无未结算 invocation/outbox/恢复依赖时执行；Session 删除只注销自己的持有项。workspace owner 在取得各来源持久释放证明后才能扣除引用，不以 Session 文件缺失或断连视为释放；Harness、Runtime、客户端不能直接删                        |
| 已发布孤儿 | 资源发布成功而所属 owner 的引用事务未提交时，带发布 owner 与 commandId。Session owner 核验无 marker，workspace owner 核验无其控制提交；还须原生产者已退出、无任何合法持有/未决引用，才可回收。不设 TTL，不由旁路进程清理                                                     |
| 归档与移动 | Session 私有目录与 transcript 使用同一维护 plan，逐文件原子操作与可恢复阶段保护；不声称跨文件瞬时原子。部分完成保留必要原副本及可读映射，核验全部闭包后才发布完成；workspace 资源保留独立位置，完整导出包按授权收齐实际 bytes                                                |
| 删除       | 先封准入并按 §3 关闭、排空自有工作，只有 closed/archived 才能到 `deleting`。持久记录注销本 Session 引用和 tombstone/清理计划，再清理可回收的私有资源并提交 `deleted`。显式 pin、workspace 已安装配置和其他 Session 引用继续保留；删除中的 unknown 保持 `deleting` 和恢复材料 |
| 读取       | 按可信 SessionKey 或 WorkspaceKey 解析 resourceId 的真实 owner，核验访问用途、持有项及 digest/byteLength。Session 私有 ref 不可直接跨 Session 使用；workspace ref 仅在所属控制授权或目标 Session 已取得授权持有项时可读；同 workspace 或知道 ID 不构成授权                   |

Runtime 侧的临时输出目录不是资源仓库。需要跨 Harness 恢复的物理结果必须先转存进上述仓库并核验可读，authority 才 ACK 回执；否则该回执按未持久处理，见[私有协议](managed-agent-control-protocol.zh-CN.md)的回执保留规则。

跨 owner 引用使用原 operationId 的持有登记与幂等接收：先由资源 owner 持久保留，再由目标 Session 提交 receipt/ref，最后确认接收；不承诺跨文件原子。ACK 丢失先查原提交，不能提前回收。fork/copy 对 Session 私有内容建立目标独立副本，对 workspace 内容建立目标独立授权持有项；源删除不损坏目标。pin 先在 workspace owner 下持久化不可变副本和用户保留项，Session 仅保存其 receipt；unpin 释放用户保留项，仍有其他引用时不得删 bytes。具体操作与配额见[工具与历史](managed-agent-tools-history.zh-CN.md)§5。

### 2.2 恢复基础与空检查点

`restoreBasis` 是 `checkpoint | initial | history_rewind | history_copy | format_upgrade` 的封闭集合，由 authority 根据当前活动历史与已提交维护证明选择，Harness 不得自选降级路径。

| restoreBasis                                   | 必需组合与准入                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| checkpoint                                     | checkpointRef 非空，restoreProofRef=null；校验九组状态、覆盖范围、版本与资源，并对账之后事件和原调用。已引用的 checkpoint 缺失/损坏或不匹配时 blocked，不能改为 null                                                                                                      |
| initial                                        | checkpointRef=null、restoreProofRef=null；header/create 与原输入/队列事实完整，尚无模型 attempt、工具意图或其他执行 continuation。允许新建空会话及首轮执行前冷恢复，不把运行过的会话当空会话                                                                              |
| history_rewind / history_copy / format_upgrade | checkpointRef=null、restoreProofRef 非空，引用该已提交操作的完整 proof；baseProjectionRef 指向所选目标的已验证历史/恢复基础。要求模型/工具关系、配置、预算、父链、资源及消费位置可重建，目标不含待续执行；copy 包括 fork/convert/import。缺项或未决副作用不允许使用本分支 |

后三类有合法兼容 checkpoint 时优先走 checkpoint 分支；null 不是读取失败的默认值。合法无 checkpoint 的恢复只初始化一个已证明的执行起点，不重演工具；下一有效 activation 的 Harness 先从该基础建立并提交新的 before_model checkpoint，才允许模型请求或新工具派发。维护 OperationGrant 只能提交维护 proof，不能制造 checkpoint；初始 create/read 不启动 Harness。模型 continuation 中的审批/工具等待仍须相应 checkpoint 和原回执；模型外的非工具 action 直接从 Session 事实恢复展示与决定，不为等待确认要求 Harness 或检查点。

<a id="restore-set"></a>

### 2.3 RestoreBundle 与跨存储 RestoreSet

RestoreBundle 是 authority 提供的**单 Session 执行恢复输入**，不是整个部署的灾备备份，也不以一个合法 checkpoint 自动授予恢复后的读取/执行资格。RestoreSet 是跨存储的一致备份集合；完整灾备创建、恢复、安全水位和副本删除规范性遵从[存储事件架构](2026-09-20-managed-agent-storage-event-architecture.zh-CN.md)第 9.1～9.4 节。本文固定它与本地 journal、资源和生命周期的接口，不另建 Session authority、通用服务或 MQ。

带版本 RestoreSet manifest 至少将下列内容绑定到同一个有证明的应用一致边界，不能只列位置或“最新”对象：

| 范围          | 必需证明                                                                                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Java SQL      | 一致备份及 binlog/GTID 边界，Session/Turn/Command、binding/执行账本、原幂等/提交及 Workspace 占用事实                                                                                        |
| qwen 私有状态 | journal 的完整已提交前缀和 revision、checkpoint 及覆盖关系、原命令/调用映射、真实模型消费的结果 bytes/转换和消费位置；不是从公开卡片/SSE 猜回模型输入                                        |
| 对象资源      | 实际后端、精确对象版本、digest、byteLength、访问/保留 owner 及完整引用闭包，含大工具结果、媒体、备份、pin/fork/export/发布 hold；delete marker 不能代替被引用版本                            |
| Workspace     | PVC/Workspace 快照、对应文件 history 与提交 proof、可信 storage identity 和绑定关系；物理键仍为 backend 域＋CSI driver＋opaque volumeHandle，不因 alias/tenant/Session/generation/子目录拆锁 |
| 运行兼容性    | Bundle、模板、build/格式/reader 版本及所需 key 版本引用；保存引用和兼容依据，不在 manifest 泄漏密钥/凭据                                                                                     |

首版 backup profile 使用维护屏障：封新输入、唤醒、派发和相关维护写入，排空写者与在途结果接收/提交，在安全边界 freeze/flush，再由各 owner 核验快照与引用并发布同一集合的 manifest。不能只 freeze 卷而让 SQL/journal 继续变化；未决效果不能合成为成功或未执行来凑边界。共同 timestamp、GTID 或单独 VolumeSnapshot 都不足以证明跨组件应用一致性，GTID 也不是外部副作用回执。无法冻结并证明一致的组合不支持自动续跑。

完整灾备开放前，必须有**备份之外且不能随业务 DB 回滚**的恢复资格、删除、key 撤销记录及其可验证的完整安全水位。优先复用已有受保护备份/审计存储，只保存这些窄事实，不复制 Session 日志；接口必须证明返回结果属于当前完整状态。签名/hash 只能证明内容，不能单独证明新鲜性；旧备份中“未删除”“仍有 key”“权限有效”都不能自证当前有效。单 Session 的 tombstone、sealed lock 或 RestoreBundle 不替代这一依据。

恢复默认隔离：关闭派发、自动任务及 GC。先隔离旧 Java/Harness/Runtime writer 的提交和物理写权，再检查恢复集合、兼容版本、精确对象与完整安全水位。缺少/陈旧/不完整的安全证据时，恢复后的普通读取（历史、SSE、Range、export、资源下载）也 blocked，仅允许显式授权的隔离诊断；不能先恢复可见性后补删除校验。模型仅通过既定 authority/资源接口恢复，Harness 不挂 Workspace；真实卷访问服从[工具与历史 §4.4](managed-agent-tools-history.zh-CN.md#csi-volume-serialization)，物理 fencing 服从 [Endpoint](2026-09-21-managed-runtime-endpoint-recovery.zh-CN.md)第 17 节。

备份后至隔离旧 writer 之间的未知执行区间必须先查询原持久执行账本/结果和可验证外部证据；缺失区间不能完整枚举时扩大受影响 Session/Workspace 的 blocked 范围。恢复 DB 缺记录、404、超时或 Pod 不存在都不能推出现实未执行，不重新 prepare/execute 或创建 Runtime 来查询原调用。证明完整前缀及旧 owner 隔离后才可认定原操作未开始；已有副作用 UNKNOWN 仍按原恢复协议结算，不用快照/新 epoch 自动重放。

RestoreSet、安全水位证明及删除完成度是新增的版本化封闭记录，不把表中项目直接塞进当前 RestoreBundle/Event 或 strict Tool v2/attestation v2。实现前明确 producer/consumer、必需/可空字段、版本与引用闭包，并依 §3 协商 minimumReader/能力；恢复必需事实不能标为旧 reader 可忽略。旧 peer 不支持则拒绝对应恢复能力，本轮不修改既有 formatVersion=1、schema 或配置。

<a id="deletion-settlement"></a>

### 2.4 删除受理、引用结算与副本完成度

本节沿用原 operation、history_maintenance、lifecycle.changed 和真实资源 owner，不增加第二份可执行 Session 历史。完整副本清除及防旧备份复活规则同时受存储事件架构第 9.1～9.4 节约束。

1. 持久受理删除计划，立即封新输入、派发和普通读取。ACK 仅确认受理，在线撤读只确认不再交付新字节，不追回已发字节；两者都不表示执行停止或 deleted。
2. 保留原生命周期 `idle/active/recovery_blocked → closing → closed`，实际取消原工作、排空并取得可信停止证明后才能 closed；然后才允许 `closed/archived → deleting → deleted`。故障保留 intendedState/recovery_blocked；活动态不能直接跳 deleting/deleted，删除请求也不能用超时绕过未知物理 owner。
3. 核对原结果交付、在途 reader/模型消费、pin、fork/export 持有项、发布 hold、调查及 legal hold。撤权流立即终止并等真实句柄退出；合法保留项由原 owner 持久管理。系统按原 binding/operation 保留查询、取消、迟到回执收件和清理的窄资格，不恢复被撤权用户读取、不重新派发、不唤醒关闭的模型。冲突或 UNKNOWN 保留必要唯一证据，引用不明保持 pending/blocked。
4. 持久提交本 Session 引用注销、tombstone 与清理计划；跨 owner 先获得持久释放证明、按原 operationId 去重，再由真实 owner 以 revision/身份条件清理。文件不存在、网络 ACK 或对象 delete marker 不代替提交/清理证据。与 §2.1、工具与历史 §5 的先保全后接收、发布 hold、fork 独立引用和 pin/unpin 规则一致。
5. Session 只释放自己的引用，不删共享 Workspace/PVC、他人 fork、用户 pin、已安装配置或远端 publication。整体 Workspace/tenant 删除要另行鉴权并核验全部来源引用、reader、执行、hold 和副本；不能把单 Session delete 升格为卷删除授权。
6. 原 `deleted` 仍按既有 Session 终态及 owner 清理条件提交，不能缩减为受理/在线不可见，也不能悄悄扩成“所有备份和供应商副本都已消失”。独立记录下列完成度与未结义务；本 Session 必需清理仍受 hold/UNKNOWN 阻塞时不得提前 deleted。已独立保留在其他 owner 的合法引用不被 Session 终态消灭。

| 完成维度            | 证据与不能声称的结论                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| 在线撤读            | 新请求和既有流都按当前 ACL 封闭；不证明进程停止或副本擦除                                                       |
| 执行停止            | 可信监督者证明原进程/后代实际退出；节点/存储隔离另报，不伪造退出，也不证明外部副作用未发生                      |
| 在线清理            | 本 Session 引用与可回收在线资源按 owner 条件结算；不删除独立共享引用                                            |
| 备份待清理          | 明列 backup/snapshot/export/对象历史版本及恢复禁用依据；不能报告全部擦除                                        |
| hold 或供应商待确认 | 保存真实保留依据/审批及 provider 结论，不能用 API ACK 推定远端全部完成                                          |
| 完全完成            | 所有应删除副本或其全部可解密能力已按契约核验清除，且没有待清理/hold/供应商未知项；不以 Session deleted 单独推出 |

OSS delete marker 不代表全部历史版本已删；必须核对精确版本、复制副本、备份、快照、导出和供应商数据。cryptoshred 只有所有可解密副本及相关 key 版本/包装或备份恢复路径都已不可恢复时才成立，不能销毁他人共享 key，也不能同时承诺彻底擦除与这些数据的完整恢复。删除/key 撤销安全依据必须在灾备开放读取前核验生效。

RPO/RTO、保留期、具体 CSI 驱动和 vendor 删除契约尚未选定，不猜数值；未配置/未验证则关闭相关自动恢复或 GC。UNKNOWN 不是无限期保留敏感数据的法律依据，须交有权限的调查/合规保留流程处理；它也不是超时清理唯一证据的理由。新增完成度的公开投影在 D，完整跨故障域恢复及备份删除在 G/W1/O4；内部撤读、停止、引用和证据门槛不能等待 UI 上线。

## 3. 事件 union 与生产消费链

“合法生产者”指**发起命令的 actor**，不是执行写入的人。所有事件一律由 Session authority 在单 writer 队列内校验并追加；actor 只能请求，无法自行落盘，也不能替另一类 actor 记事实。三类 actor 与其可发起的 kind 固定如下，其余组合在副作用前拒绝：

- **当前 activation 的 Harness**（持 activation fence）：`model.attempt`、`message.committed`（用户输入形态由下表的输入投影适配产生）、`tool.intent`、`context.compacted`、`checkpoint.committed`，以及 `action.changed` 的 tool_call requested 分支。它经 `appendExecution`/`commitCheckpoint` 发起；authority 校验 fence 与 expectedSequence 后提交。
- **coordinator**（持 activation 管理资格）：`activation.changed`。它经 `claimActivation`/`completeActivationInstall`/`renewActivation`/`releaseActivation` 发起，epoch 与 phase 由 authority 判定并写入；coordinator 不能自己造 epoch，也不能代 Harness 提交 checkpoint 或终态。
- **可信入口与领域适配**：`input.accepted`（普通入口/内部触发；同事务的 `wake.requested` 由 authority 内部生成，入口只能请求唤醒，不能自行写该事实）、`cancel.requested`（用户或生命周期 owner）、`action.changed` 的非工具 requested 分支（按下文来源矩阵经 requestAction）及最终决定（原仲裁入口）、`tool.receipt`（原 Runtime 回执入口或注册领域/编排适配）、`config.bound`/`lifecycle.changed`（配置与维护 owner，持 OperationGrant）、`domain.committed`（注册领域适配）、`turn.settled`（authority 核验 Harness 提交的终态或恢复结算）。

其中 `tool.receipt` 的工作区物理分支只能经 `acceptRuntimeReceipt` 进入，不能由 Harness 的 `appendExecution` 顺带提交——Harness 不是物理结果的可信来源。

| kind / payload 必需字段                                                                                                           | 合法生产者                             | 主要消费者与原子要求                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| input.accepted：inputId/turnId/source/contentRef/deadline/admissionRef                                                            | 普通入口或可信内部适配                 | 队列、Harness、UI；与 wake.requested 同事务；UI 以同 inputId 合并受理与模型消费                                                                                                                                                                    |
| activation.changed：activationId/epoch/workerId/subject/phase/leaseDurationMs/expiresAt/installRef/boundaryRef                    | coordinator                            | 调度、Runtime gate、恢复；phase=installing/active/released/revoked：installing/active 必需 leaseDurationMs/expiresAt/installRef，前者 boundaryRef=null；released/revoked 必需 boundaryRef，expiresAt 为关闭时值，不准新执行                        |
| model.attempt：attemptId/routeRef/inputCheckpointRef/state/usageRef                                                               | 当前 Harness                           | 上下文与用量；state=started/output_committed/abandoned；started 的 usageRef=null，其余无 provider 用量也明确 null；正式输出与调用 ID 映射一起提交                                                                                                  |
| message.committed：messageId/role/contentRef/modelAttemptId?/parentMessageId                                                      | 当前 Harness或输入投影适配             | 原 user/assistant/tool 内容与 stopReason；保留完整内容 union 和工具批次 ordinal                                                                                                                                                                    |
| tool.intent：executionCallId/batchId/ordinal/toolDefinitionRef/argsRef/outcomeSource                                              | 当前 Harness                           | 权限和派发；生成无 provider callId 的稳定映射必须先提交，不能等 execute 后补                                                                                                                                                                       |
| action.changed：requestId/kind/source/inputRevision/optionsRef/state/decisionRef                                                  | 按来源矩阵请求；原仲裁作最终决定       | 问答/权限及非工具确认；source=tool_call/automation_run/team_plan/user_operation；state=requested/decided/cancelled/expired。decided 的 decisionRef 必须非空，其余为 null；取消/过期只由原生命周期 owner/受控期限处理提交，不把中间投票记成最终批准 |
| tool.receipt：executionCallId/ToolOutcomeRef/resultRef/resources/historyRevision                                                  | 原 Runtime 结算入口或注册领域/编排适配 | 模型和恢复；来源匹配工具定义，不能用 orchestration 冒充工作区物理成功                                                                                                                                                                              |
| checkpoint.committed：checkpointId/coveredSequence/previousCheckpointId/stateRef/boundary                                         | 当前 Harness                           | 恢复；九组字段见 Harness；引用闭包及覆盖前提核验后才 ACK。合法初始化的 before_model checkpoint 使用 boundary=null，不产生 HarnessBoundary 或终态                                                                                                   |
| context.compacted：compactionId/fromSequence/toSequence/summaryRef/replacedMessageIds/tokenCountsRef                              | 当前 Harness                           | 模型上下文重建与展示；原事件保留不删，压缩只追加覆盖范围；恢复按最新 compaction 组装上下文，展示仍可回放原始区段                                                                                                                                   |
| cancel.requested：requestId/target/reason/requestedBy                                                                             | 用户或原生命周期 owner                 | coordinator；原 invocation 取消与最终成功回执仍可分别记录                                                                                                                                                                                          |
| turn.settled：turnId/outcome/stopReason/resultRef/usageRef/pendingOwnersRef                                                       | authority 核验 Harness 或恢复结算      | 普通 turn_complete/turn_error、父任务和通知；同 turn 仅一个正式终态；工作完成与取消请求不混同                                                                                                                                                      |
| config.bound：revision/previousRevision/bundleRef/rootSnapshotRef；lifecycle.changed：operationId/from/to/reason/pendingOwnersRef | 配置/维护 owner                        | 配置单调 revision；lifecycle to=idle/active/closing/closed/archived/deleting/deleted/recovery_blocked，原状态按操作矩阵验证；未决 binding 保留受限结算，封闭后不能接新输入                                                                         |
| wake.requested：wakeId/reason/subject/sourceEventId/requiredSequence                                                              | authority 事务内部                     | 可重建调度索引；重复投递不重复创建领域输入                                                                                                                                                                                                         |
| domain.committed：domain/version/operationId/recordRef                                                                            | 注册领域适配                           | domain 的封闭集合以 §3.1 为唯一索引，使用各专项原名称和 schema，不另设 goal/todo/child_task/history_operation/memory 别名；未协商或未实现的 domain 拒绝，不能因列入目标表就启用。扩展遵循下文规则，禁止任意 append                                 |

追加、create、配置、维护、审批、activation 与领域命令全经过相同单 writer 条件提交。注册领域调用没有独立的第二个 Session 写入口。跨 Session 的父子事务使用持久 outbox 和接收去重，不能声称跨文件原子提交。

Action 请求的来源与资格固定如下。`requestAction` 只允许注册领域适配器为原已受理操作创建确认，不授予模型推进权，也不能调用该方法制造 tool_call；同 Session 的操作意图和 action 可同事务受理。跨 Session 先按原 outbox 接收固定身份，再创建 action，不借共享 workspace 越权。

| source         | 请求 actor 与核验依据                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tool_call      | 当前 Harness 通过 appendExecution，校验 activation fence、已提交 tool.intent/inputRevision；Runtime 权限另核验原 prepare/ref                                       |
| automation_run | 可信调度/手动运行适配器通过 requestAction，校验原 runId/occurrenceId、冻结 target 与该控制 Session 的授权；missed one-shot 确认不启动模型                          |
| team_plan      | 可信团队计划适配器通过 requestAction，校验原 team_plan 记录、childRunId/planRevision 及 leader 路由；模型产生的计划仍须原 activation 提交，不允许 adapter 伪造计划 |
| user_operation | 原已认证操作适配器通过 requestAction，核验原 operationId、实际 Session owner、originClientRef 和策略；模型不能自报为用户操作                                       |

最终决定统一经 resolveAction 进入原仲裁。请求创建者不因此获得批准权；版本变化、迟到、重复与过期按同一 requestId 的条件提交处理。action 的创建只发布等待投影，合法最终决定与必要后续输入/wake 或 outbox 才能推动原操作。没有 Session 的 workspace 维护继续原工作区交互，不为适配本表捏造 Session。

生命周期合法转换：create→idle；已受理输入使 idle→active；所有 turn 已终态且无运行队列使 active→idle；idle/active/recovery_blocked→closing，实际自有工作排空后 closing→closed；closed↔archived（unarchive 回 closed，不自动跑模型）；closed/archived→deleting→deleted。故障可使非 deleted 状态进入 recovery_blocked 并保存 intendedState，核验后恢复该合法阶段；有未知物理 owner 时不能 closing→closed 或 deleting→deleted。模型等待由 turn/checkpoint 表达，不改 lifecycle 为 closed。

**扩展规则。** 上表是封闭 union，reader 遇到未知的已提交 kind 一律判执行恢复失败（§4 规则 6），不跳过继续。因此新增 kind 或新增 `domain.committed` 的 domain 必须同时：提高 header 的 `minimumReader`（新读者要求）或在 `formatVersion` 内声明为“旧读者可安全忽略的附加事实”，二者取其一并写在本表；给出生产者、消费者和原子要求；更新 validator 与 §7 验收。不允许先加字段再补规范，也不允许用 `domain.committed` 当作绕过本规则的任意扩展口——它的 domain 集合同样封闭。选择“旧读者可忽略”这一档时，该 kind 不得承载恢复必需事实，否则旧读者会以不完整状态继续执行。

**旧 subtype 的归位。** 现有 transcript 还有若干不属于执行事实的 ChatRecord subtype，它们不新增顶层 kind，按下列方式落位，避免“既不在 union 里、又不许双写”的空档：会话标题与重命名归 `domain.committed` 的 `session_metadata`；`slash_command`、`at_command` 等用户输入形态与 UI 遥测、attribution 快照保留在 `message.committed` 的 `contentRef` 内容 union 中，reader 投影时还原原 subtype，不作为恢复必需事实；模型来源与父子记账已由 header、`config.bound`、`message.committed.parentMessageId` 和 checkpoint 覆盖，不另开记录。实时语音消息在 v1 没有对应归位，因此启用实时会话的入口继续固定 legacy，等[普通客户端专项](managed-agent-full-design.md)完成该切片后再纳入本表；在此之前不允许把它塞进 `message.committed` 充数。

**分支点不是执行 checkpoint。** 新 `branch_checkpoint` 保留完整原 ChatRecord（uuid、parentUuid、v1 systemPayload），由原 Harness/recorder 通过 `message.committed` 的 system 内容提交，branch/transcript reader 原样投影；不新增 kind/domain，不双写，维持 formatVersion=1 与 minimumReader=`managed-session/1`，既有 message reader 已支持此内容形态。`commitBranchCheckpoint` 的 operation、`recorder:<uuid>` 与原 JSON 字节 SHA-256 保持不变，使升级后的重试返回旧事务，不另加一条分支记录。compaction 的 replacedMessageIds 列出范围内所有 message 事件（包括分支 system 内容），原事件及展示分支点不删除。

历史已提交的 `checkpoint.committed` 若引用 schemaVersion=1 的 `managed-branch-checkpoint`，在热提交、冷开和投影时核验引用格式、资源长度/摘要、严格 JSON、record 的 sessionId/uuid/type/subtype、parentUuid 形态与 v1 payload；其 boundary 必须为 null，coveredSequence 为此前提交尾部。保留原事件、marker、资源及前驱，不改写日志。它只恢复分支展示并表明已有执行，不能更新 latestCheckpoint；没有执行状态时 blocked，不退回 initial。前驱只能引用已出现且在覆盖范围内的 checkpoint ID，拒绝重复 ID、悬空和向前引用；历史 state 可以引用已验证的 branch ID，后续新 state 则只连接上一个 state。所有 checkpoint 的 coverage 都不得超过本事务开始前的 committedSequence。`managed-checkpoint` 资源不按 ChatRecord 或 JSON 解码，分类阶段也不读取其字节；损坏或缺失的执行 state 仍在实际读取处失败，本片不改变该行为，正式的 blocked 映射随恢复切片交付。未知种类/版本明确失败。这里不宣称修复旧二进制，也不将分类隔离等同于 Harness 九组状态及尾部对账验收。

### 3.1 domain 注册索引

下列 30 个名称构成全量目标的 v1 集合，event version=1、recordRef.kind=`managed-<domain>`、schemaVersion=1。正文 schema、生产者和消费/原子要求归对应专项；实现须从此索引检查完整集合，不得重新发明同义名。阶段、用途与 capability 决定当前可用子集：解析器认识一个名称不表示该功能已实现或获准执行。延期能力继续原准入规则，不提前扩大默认范围。新 domain 或正文的不兼容改动必须遵守上面的 reader/version 扩展规则。

| 专项/正文来源                                          | domain                                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [配置与扩展](managed-agent-config-extensions.md)§7     | `config_install`、`workspace_initialization`、`skill_activation`、`mcp_configuration`、`mcp_operation`、`hook_registration`、`hook_execution` |
| [工具与历史](managed-agent-tools-history.zh-CN.md)§1.1 | `tool_stage`、`resource`、`publication`、`workspace_operation`、`history_rewind`、`history_copy`、`history_maintenance`                       |
| [自动任务](managed-agent-automation.md)§2              | `channel_route`、`channel_delivery`、`schedule`、`automation_run`、`child_run`、`child_acceptance`、`memory_job`                              |
| [自动任务](managed-agent-automation.md)§5              | `goal_state`、`todo_state`、`plan_mode`                                                                                                       |
| [自动任务](managed-agent-automation.md)§6.1            | `team_state`、`team_task`、`team_message`、`team_plan`、`session_message`                                                                     |
| 本节会话元数据                                         | `session_metadata`                                                                                                                            |

`session_metadata` 正文为原 operationId、revision、previousRecordRef（首次为 null）和原标题值/清除语义；由受权重命名入口通过 authority 提交，目录/标题 reader 消费。涉及物理维护的 history_maintenance 只引用该元数据结果，不存第二份可独立更改的标题。workspace 配置控制记录和 RuntimeReceiptStore 仍属各自 owner，本索引不要求把无 Session 事实写进 Session 日志。

## 4. 成功提交、损坏与重启

1. 在写入队列内验证 actor、scope、schema、幂等键、fence、sequence、容量和引用闭包。相同 operation+commandId 的原成功只返回原 receipt；业务内容不同报 conflict；未成功的 sequence 冲突可以重新读后提交同业务内容。
2. 大资源先写受控临时文件，流式算 hash，完成文件同步后原子发布并同步所属目录，再允许事务引用。失败不发 ACK。注意发布早于 commit marker：事务最终未提交时留下的是**已发布**孤儿，不是临时文件，因此不能靠临时目录清理兜底——它按 §2.1 的“已发布孤儿”规则，由实际 Session/workspace 资源 owner 在恢复扫描中按原 commandId、提交与全部持有项核验后回收。临时文件孤儿仍只由自身 owner 回收。
3. 连续追加 event records，再追加 commit marker。初版沿用现有 writer 的逐行 sync，不另实现未经证明的批处理提速；单 authority 队列保证不穿插其他事务。header/首次目录创建及必要改名同步父目录。逐行 sync 与“单事务最多 256 event”相乘决定最坏延迟：一次满额事务是 257 次 sync，单 Session 串行、且整个 authority 队列被它占住。因此 v1 加两条约束：一次逻辑事务的事件数应保持在个位数（典型 1～3 条，如 input+wake、model.attempt+message.committed），256 只是硬上限而非常规批量；满额事务的提交延迟预算按部署 profile 实测记录，超过 2 秒即视为该 profile 不适合逐行 sync，此时先降低单事务事件数或把内容移入资源，不得改为无证明的批量 sync，也不得为提速跳过 marker 前的同步。
4. 仅 marker 与全部事件/资源核对并完成同步后提升可见 committedSequence、投影和 ACK。现有 writer 的 strict append 已有文件 sync；新保证主要是多记录事务可见性、引用闭包与全部关键生产者等待，不能将其误写成原 writer 完全没有 sync。
5. ACK 丢失按原 commandId 找 marker；写失败停止新推进。完整已落盘 marker 可在恢复核验后确认，半行/无 marker 不构成受理或终态。
6. 读取完整已提交前缀，不把损坏中段或未知已提交 kind 跳过继续执行。尾部不完整事务只在独占 writer 下、确认没有 marker 且有完整前缀证明时截断；保留坏尾诊断副本。只读 owner/兼容探测不能触发修复。**实测补充（2026-09-11）**：现有 `SessionWriterLease.acquire` 会以 `SessionTranscriptChangedError` 拒绝在活动 writer 之外被改动过的 transcript，因此截断不能由 authority 直接改文件实现，必须作为 lease 能力提供。该能力已落地：`SessionWriterLease.truncateTo(byteLength)` 在同一 `runExclusive` 屏障与逐次归属校验下截断，并重建被钉住的 transcript 证明（滚动 hash 无法回退，故重读保留前缀重算）。authority 侧由 `LocalManagedSessionAuthority.recoverUncommittedTail` 显式发起：先扫描确认存在无 marker 的尾部与完整已提交前缀，把被丢弃字节另存为 `<transcript>.uncommitted-tail` 诊断副本，再截断。修复必须显式调用——`open()` 仍然报 `ManagedSessionUncommittedTailError` 并拒绝写入，只读 owner 与兼容探测不会触发修复。外部撕裂的尾部仍由 lease 在更低层先行拒绝，不进入 authority 的判定。
7. 不完整输入未 ACK 可由原 ID 重试；已经允许物理操作但回执未提交时，恢复查原执行账本，不能根据 Session 尾部缺失推导未执行。

Node 的 filehandle.sync 是文件同步操作；目录、文件系统和硬件的保证仍须按部署 profile 验证，不能宣称覆盖任意断电设备。[Node.js 22 文件 API](https://nodejs.org/docs/latest-v22.x/api/fs.html#filehandlesync)

## 5. 首版固定限额与兼容路径

下表的新值是本次设计决策，不是当前已生效配置；旧值来自上述源码基线。数值按编码后 UTF-8 bytes 计，媒体资源按原始 bytes 另计。新私有能力双方在握手公布 limits version=1，双方取较小值；低于一次最小合法 envelope 时拒绝安装。

| 项目                             | v1 选择                                                                                               | 超限/兼容行为                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Session control 单请求/响应      | 8 MiB，JSON 深度 64；最多 256 个事件/命令项                                                           | 大内容换 DurableRef/分页；不能截断后 ACK；旧公开 API 的既有输入额度不因内部变小而减少               |
| 单 event / commit marker         | event 1 MiB，marker 64 KiB；单事务最多 256 event/8 MiB                                                | 超长正式内容先存资源；不可拆开的业务事务超过上限则拒绝，无部分可见                                  |
| readEvents                       | 默认 100、最大 256 项，单页 8 MiB                                                                     | 下一 cursor 精确覆盖已返回位置；单事件引用已符合 1 MiB；持续订阅慢消费者断连后可续读                |
| blob/chunk                       | 每片原始 1 MiB；描述清单页 256 项/1 MiB；资源流式 hash                                                | base64 膨胀计入传输；不限制合法历史总长度为单帧大小；总准入沿原附件/工具/备份限制和下面存储保留规则 |
| Runtime v2 input                 | 保持 256 KiB / 深度 64                                                                                | envelope 不扩大参数权限；大文本仍遵守原工具 API；另有原生资源输入工具才可引用                       |
| Runtime manifest/control/history | 1 MiB / 64 KiB / 8 MiB                                                                                | history 增强协议分页/增量，旧 v2 单次限额不改；新增控制证明用 refs 避免塞满 manifest                |
| Runtime result/media/progress    | 普通 8 MiB；媒体沿现有 64 MiB 减 64 KiB 包络；进度 1 MiB 环                                           | 正式结果超 native/传输上限准确报错，原物理结果保留；新持久资源路径由相应能力协商启用                |
| 普通 Bridge 配额                 | 复用有效 maxSessions；默认 32，pending prompts 默认 5，mid-turn 20，queued inline attachments 100 MiB | legacy/Managed 共用已有配额与同步准入；不把“持久输入”变成无上限排队                                 |
| Session activation               | 一个推进者，lease 60s，每 20s 续租；控制 RPC 10s 截止                                                 | 续租失败封新工作；查询重试用原 ID；10s 不是工具执行或物理取消 deadline                              |
| 提交延迟与事务规模               | 常规事务 1～3 event（硬上限仍为 256）；满额事务提交延迟预算 2s，按部署 profile 实测                   | 超预算先降事务事件数或把内容移入资源；不得改为无证明的批量 sync，也不得跳过 marker 前同步           |
| 错误详情                         | code 128、message 4096 UTF-8 bytes，附最多 16 个结构化引用                                            | 不含环境/密钥/任意文件；外部旧错误时机与字段经适配保留                                              |

容量拒绝发生于 input ACK 前。已提交输入不因投影队列暂满消失：authority 保留 wake，并暂停新的 admission。存储不新增用户历史自动过期；新输入/资源分配先核对该作用域的实际磁盘预算，至少保留 64 MiB 结算空间（与 workspace 共用一次，不按每 Session 重复预留）。空间不足停止新增工作，已准入回执使用保留空间；若仍耗尽，明确 storage_unavailable 并保留原副本，不能提前 release。管理员已有更严格磁盘额度优先，无法满足预留的部署不启用 Managed 写能力。

## 6. 迁移与实现接缝

新建 Managed 在 create 前协商 writer schema/Session reader/Runtime 控制能力。旧 legacy 从不原地改 engine；旧实验目录只提供显式位置适配，不按端口变化重新分配普通历史。已存在 managed 旧格式在无执行时可升级记录容器，顺序按 §1 的封存、claim 屏障内认证换锁、header/迁移提交、释放 claim 执行；旧文件前缀保持字节一致。失败保留可核验屏障，不通过普通 release 变成无锁，也不“修复”为 legacy。

需同时改造 Core ChatRecord union/reader、SessionWriterLease schema/认证交接、`packages/cli/src/serve/server/session-archive.ts` 等 maintenance-lease 消费者（受 §1 的 sealed schema-3 影响的归档/删除/重命名/fork）、ChatRecordingService 的 Managed sink，CLI authority/client/coordinator，所有生产正式记录的 ACP Session/LlmChat/Goal/文件历史适配，目录/历史/SDK投影。`packages/core/src/services/sessionService.ts` 的同步目录与标题读取（statSync 加尾部读取）目前直接解析 legacy 记录形状，对 Managed 会话会得到空标题或误判，必须有明确的 Managed 投影适配；该适配的实现与开销在默认选择 Managed 之前必须结清，否则会话列表会静默降级。使用目录版本升级不意味着重写整个 Session 类。Schema/validator 源码随实现进入 Core；本表和各领域表为字段规范，不把“文档存在”记作编译验证。

## 7. 存储与协议验收

| 编号 | 操作与通过条件                                                                                                                                                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01  | 每个事件/marker/资源同步前后杀自有进程；读取只见完整事务，原 commandId 可查询，不重复正式内容                                                                                                                                                                                                         |
| S02  | schema 2 二进制尝试打开 active/closed Managed schema 3；拒绝写入，原 transcript/lock 字节不变                                                                                                                                                                                                         |
| S03  | 1 MiB/8 MiB/256 项/深度 64 的边界与 UTF-8/base64 膨胀；恰好边界合法，超限准确失败，旧合法大输入通过 refs 完整恢复                                                                                                                                                                                     |
| S04  | 慢订阅、投影丢失、分页中断；从 authority sequence 补齐，不启动 Harness、不重复终态                                                                                                                                                                                                                    |
| S05  | 磁盘不足、writer 丢失、坏中段、半尾、跨 scope ref；封新推进，保留未决原调用，探测保持只读                                                                                                                                                                                                             |
| S06  | 原用户前缀/父子链/压缩/Goal/artifact/通知/用量/文件历史恢复对照；展示容错与执行严格检查各自保持                                                                                                                                                                                                       |
| S07  | 分别覆盖 Session/workspace 资源：无 Session 时安装配置；两个 Session 持有同一配置/pin；删除来源 Session 后目标 fork、配置和用户 pin 仍可读，最后 unpin/释放并排空读取后才回收。跨 owner 登记/ACK 丢失与已发布孤儿不误删；归档/移动各阶段中断仍可恢复；跨 Session 私有裸 ref 拒绝                      |
| S08  | schema-3 的归档/取消归档/删除/重命名/fork 保留认证封存。旧二进制在 claim 前竞争成功则升级无写入并拒绝；claim/candidate/主锁/header/完成提交/claim 释放每个窗口杀进程，成功核验旧封存态并持有 claim 后，旧 writer 不能取得写权，新 authority 核验后可续做；未知 owner 留屏障，不先删 claim 或降 schema |
| S09  | 提交延迟与投影：常规 1～3 event 事务和 256 event 满额事务分别实测延迟并对照 2s 预算；会话列表/标题的同步读取对 Managed 会话给出正确投影，不返回空标题或误判 legacy                                                                                                                                    |
| S10  | 从 §3.1 逐项对照 30 个 domain 的专项 schema/producer/consumer；已启用者可提交并正确投影，已知未启用者拒绝，旧别名/未知 domain 拒绝。未知已提交恢复事实不跳过，新版本按 minimumReader 协商，不以全量索引当功能已验收                                                                                   |
| S11  | 无活 Harness 时创建 automation_run/team_plan/user_operation 确认并在重连后读到；合法决定实际推进原操作，重复不重跑。错 source/目标/版本、伪造用户或 leader、未经 tool.intent 的 tool_call 均拒绝；请求者不能自行批准                                                                                  |
| S12  | 新建空会话/首轮前冷恢复、合法 rewind/copy/升级无 checkpoint 的 proof 均可建立新 checkpoint 后完成新 Read/final；已有 checkpoint 丢失、损坏、伪造 null、残留 continuation 或未决副作用保持 blocked，不重演旧工具                                                                                       |

<a id="supplemental-storage-acceptance"></a>

### 7.1 补充设计阶段与正反验收

C/E＋W0＋必要 F 验收在线同卷占用、正常交接、原调用查询、丢 ACK/失联阻塞和必要安全边界，连接工具与历史 §4.4；D 提供恢复/撤权/删除完成度的公共投影与兼容，不推迟内部安全门槛。G/W1/O4 验收完整 RestoreSet、安全水位、跨故障域恢复和备份删除；缺少证据前不启用对应读取恢复、自动续跑或 GC。H 共享写 child 后置。原 S01～S12 与各历史实现记录保留，不把本轮文档修订算作新验收。

| 编号             | 正向通过条件                                                                                                                       | 反向拒绝条件                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| S13 一致集合     | 真正排空/freeze/flush 后，SQL/journal/checkpoint/实际模型消费结果、Workspace history、精确对象版本和 Bundle/build/key 闭包共同验证 | 只有 timestamp/GTID/VolumeSnapshot、缺对象版本/digest/长度/引用或版本不兼容均不开放恢复     |
| S14 安全水位     | 备份外不可随 DB 回滚的当前完整资格/删除/key 撤销依据通过，按剩余权限开放合法读取                                                   | 回滚至删除或撤权前、陈旧签名/水位或安全记录不全，普通读取也 blocked，仅授权隔离诊断         |
| S15 原执行区间   | 旧 writer 已隔离，按原身份查到并接收真实结果，模型消费位置保持一致                                                                 | 缺记录/404/超时就重放、未隔离旧 writer、未知区间不可枚举却继续均拒绝；不为查询新建 Runtime  |
| S16 生命周期     | 持久受理后按 closing/closed/deleting/deleted 原序列，窄收件不唤醒模型                                                              | ACK/在线撤读跳 deleted、未知 owner 提前 closed、迟到结果恢复用户读权均失败                  |
| S17 引用与共享卷 | reader 排空后 owner 条件清理；源删除后独立 fork/pin/配置/发布 hold 保持正确                                                        | 删除共享 PVC、未核对 export/legal hold、跨 owner 丢 ACK 清唯一副本均拒绝                    |
| S18 副本与 key   | 全部应删精确版本/备份/快照/导出/vendor 副本或全部可解密路径核验完成后才报告完全完成                                                | delete marker 当全部版本删除、共享 key 误删、未确认供应商清理或同时承诺擦除及完整恢复均失败 |
| S19 版本与能力   | 新封闭记录的 producer/consumer/引用、minimumReader 与能力协商一致，支持的 reader 正确恢复                                          | strict v2 偷加字段、未知恢复事实跳过、无能力 peer 自动降级均拒绝                            |
| S20 未定契约     | 选定并实测的 profile 按明确契约执行，未选能力准确关闭                                                                              | 猜 RPO/RTO/保留期、默认自动 GC、以 UNKNOWN 作为无限保留法律依据均拒绝                       |

正反路径均须验收，不能用全部 blocked 代替可用性证明。后续使用真实 MySQL/Kubernetes/CSI/对象版本及 key/vendor 契约验证，覆盖提交/快照/删除各窗口故障与重启；H2/fake Kubernetes 不能替代真实语义。本轮仅文档，未运行这些测试，不声明完整恢复/删除已实现或通过。
