# K2-A2：原生文件执行完整链

[English](2026-10-07-k2-native-file-execution.md) | [简体中文](2026-10-07-k2-native-file-execution.zh-CN.md)

状态：完整文件组合设计；初始 checkpoint 门禁已在本地实现，并在自有 MySQL 上独立验证，
更新于 2026-10-08。实现基线为
[Draft PR #13526](https://github.com/QwenLM/qwen-code/pull/13526) 中的
`1b752436309beed109b6f47959d8bb3ec2994ca8`。该提交已实现原执行的 SQL
continuation 和保留原 descriptor 的文件工具/history；生产正常文件链尚未实现。本文补充
[K2 补全设计](2026-10-06-kubernetes-k2-retirement-handoff.zh-CN.md)，不声明完整
A2、聚合退役或新增云上验收完成。

## 1. 问题与范围

实现基线中，私有 `csi-files-retirement/1` 的 CREATE 与首次 activation 固定点已存在，但
旧入口 guard 在通用 worker 构建 Shell/MCP/Hook/monitor/provider 前拒绝保留私有 digest。
保留三工具 composer 已存在，但尚无生产 worker caller。SQL reader 接受
genesis/install/renew 与一次准确的空初始 checkpoint，尚未准入连通的文件执行链。
删除 control 拒绝或允许任意 checkpoint，不能安全连接这些权威。

真实 Hosted v2 链为 Write/Edit 的 file-history 准备 → Broker PREPARED → 原生
`tool.intent` → `await_runtime` checkpoint → 授权/worker 执行 → 内联
`managed-tool-outcome` → `message.committed` 工具结果 → `results_ready` →
工作后的 file-history snapshot。普通文件工作没有 Shell publication receipt。
资格验证以 `HostedWorkspaceToolTurn` 为源；本地 `ManagedRuntimeOutcomes`
使用另一种 receipt/outcome 形态。

支持原 Session 的 `read_file`、`write_file`、`edit`，保留内联资源及未 compact
的历史。排除 import/restore/rewind，以及 Shell/glob/v3/provider/Hook/MCP/
background/monitor/publication 配置。公开 CSI selector 继续禁用。K2-B 物理
stop/unpublish、K2-C release/多轮交接、K2-D 部署资格验证仍是后续必做工作。

## 2. 封闭 worker 身份与构造

下述 legacy 入口拒绝保持生效。独立基线观测到保留 digest 到达旧通用
factory，local-process 也在启动失败前创建子进程。Guard 在副作用前拒绝
stdin/container reader、直接旧 worker/factory 构造，以及本地 request 创建、
registration、provisioning、adoption、confirmation、release。Local operator
registration/stop evidence 也拒绝该私有 request。普通 profile digest 保留既有
路径。可复用 managed-context 数据 parser 与 CSI-v1 数据 schema 不变，它们
不授予执行权。当前构建变更已实现 boot4/CSI2 构造与四个封闭 route，并通过独立本地构建验证。
下述连通文件链仍是设计。该
[闭合构建组件](2026-10-08-k2-csi-file-worker-construction.zh-CN.md) 在原生准入接通前
保持 bind、prepare 与 mutation 不可用；构建不代表完整 A2 验收。

预留外层 boot version `4`、`managed-csi/2` 与 CSI v2 attestation/drain route。
包裹不变的封闭 managed-context boot v2 与已注册 storage tuple，增加只含
`profile`、`sessionId`、`capabilityDigest` 的封闭 profile identity。要求准确的
`csi-files-retirement/1` manifest digest、规范 CREATE Session UUID、session
isolation，并与内层 context digest 一致。V2 attestation/drain 回显该身份，Java
和 TypeScript 都对照不可变 request、Pod、registration 身份验证。旧 boot v3、
managed-context/1、CSI v1 record 保持封闭且不变。

新的封闭 ready/context-install/receipt 契约也携带该身份。Boot Session UUID
指持久化 Harness owner；首个私有 profile 显式选择相同值作为唯一 Runtime Session，
与既有 SQL guard 一致。两者身份角色不同，均须验证。私有 composer 跨 turn 复用
固定 Runtime Session，execution turn/prompt ID 仍独立；legacy Hosted 保持
prompt-scoped Runtime Session ID。不能为误用 legacy composer 放宽 SQL 身份
条件或增加第二个固定点。

外层 key 为 `identity`，准确三个字段来自不可变原 provision request。新 wire
契约与 legacy schema 分开；仅凭 protocol number 不能选择或授权此 profile。

| 契约                           | 准确外层字段与固定值                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container boot                 | `type: "boot"`、`version: 4`、`managedCsi: "managed-csi/2"`、`identity`、不变的 boot-v2 `context`、不变的 12 字段 `storage`                                                           |
| 信息性 ready                   | `type: "ready"`、`version: 4`、`managedCsi: "managed-csi/2"`、`identity`、不变的 ready-v2 `context`                                                                                   |
| Context attest/install/receipt | `protocolVersion: 2`、`managedCsi: "managed-csi/2"`、`identity`、`context` 内不变的封闭 managed-context-v3 request/response                                                           |
| Physical attestation request   | `protocolVersion: 2`、`managedCsi: "managed-csi/2"`、`identity`、`provisionRequestId`、`physicalKey`、`registrationRevision`、`reservationId`、`reservationRevision`                  |
| Physical attestation response  | `protocolVersion: 2`、`managedCsi: "managed-csi/2"`、`identity`、`context`、`storage`、`pod`、`mount`                                                                                 |
| Drain request                  | `protocolVersion: 2`、`managedCsi: "managed-csi/2"`、`identity`、`operation`、`retirementId`、`context`、`storage`、`pod`                                                             |
| Drain response                 | `protocolVersion: 2`、`managedCsi: "managed-csi/2"`、`identity`、`retirementId`、`context`、`storage`、`pod`、`state`、`workState`、`pendingStarts`、`pendingInvocations`、`blockers` |

使用 `/internal/managed-runtime/csi/v2/context-attest`、`/context`、`/attest`
与 `/drain`；后三者位于同一 CSI-v2 prefix。Kubernetes 资格验证对照真实 Pod 与
两种 HTTP attestation。Ready stdout 只提供信息，不能成为第二权威。Drain
保留 seal/status、`state: "DRAINING"` 与 `workState: "BLOCKED" | "PENDING" |
"QUIESCENT"`；counter 为原生非负 safe integer，blockers 为唯一排序字符串。
这是 worker 观测，不是聚合 DRAINED 或物理终止证据。

Attestation/drain route 为 selected-runtime scope；context installation 与
私有 history route 是该准确 runtime 内的 live-session-owner scope。认证原
lease/incarnation/epoch 后，再验证固定 owner 与已安装 context。缺失/draining/
removed 或身份不匹配按声明的拒绝/观测规则处理，不能 fallback 到 primary runtime。
不存在 process-global 的私有通用 control route。

Legacy boot 1/2/3 与 local-process provisioning 在构造通用完整 profile worker
之前拒绝保留的私有 manifest digest。新 profile 仅支持 container，不扩展旧 stdin
boot reader，也不启用 CSI-v1 publication ACK。其他有效 legacy profile 保持既有
行为。私有内层 context 固定 `cwd` 为 `.` 并要求已注册私有 configuration digest；
调用方选择的 context 不能扩大能力。

仅构造三个文件工具，同时限制 executor lookup 与工具声明；每次调用要求原
activation 和 context。安装必须匹配 boot 的 Session/profile 配置。在构造 runtime、
注册 route、启动 timer 前拒绝不支持的配置；忽略环境设置并不足够。

`read_file` 可能调用 PDF/vision helper。三个工具名称不能证明没有子进程。
必须验证其 joined lifetime 与结果保留；使用未验证的 helper 时明确报告 lifecycle
blocker。不能静默缩减既有 manifest 的文件格式后仍使用原 digest。首个正向场景
使用普通文本文件。

通过私有 CSI provisioner、boot producer、已保存 Secret 比较、resume、
attestation、installation、transport 显式接通 Session 身份。另一 Session 不能
复用 mount，也不能回退 legacy 本地解析。CSI v1 publication ACK 仍仅支持
workspace；文件链不制造 publication/ACK。后续 session-scoped publication ACK
需要独立封闭契约及资格验证。

## 3. File-history 存储与准入

Legacy 备份使用 `Storage.getGlobalQwenDir()/file-history/<owner>`；Pod 的
`HOME=/tmp` 使其依赖 emptyDir。已实现私有 backend 则在已注册卷内保留固定原
Session 目录；legacy caller 保持默认值。descriptor 使用边界核对目录身份、
no-follow path、保留 alias 和 backup-inode hardlink，不重定向全局 `QWEN_HOME`。
私有 composer 为实际文件工具与保留 history 注入同一个 backend；worker 准入
仍未连接。备份保留至原 finalize；不可用、中断或容量不足均阻断结算。后续
cut/finalize 必须覆盖所保留备份字节及原生 history resource。
Write/Edit 必须要求已绑定并 prepared 的 history；不能使用 legacy executor
在没有 history 对象时仍执行 mutation 的 fallback。

选择固定保留 prefix `.qwen-csi-file-history` 与规范 owner UUID leaf。私有 backend
使用具体 Linux directory-fd 实现，不接受调用方路径或环境选项。以
`O_DIRECTORY | O_NOFOLLOW` 打开并持有原 mount、保留 prefix、Session directory，
对照原 mount receipt 的 volume device/inode。每次只向 `/proc/self/fd/<dirfd>`
追加一个已验证 component。I/O 前后验证目录名称仍对应原身份并核实原 mount；
观测到不匹配后，本 lifetime 的 backend 永久 blocked，不替换/adopt，也不允许
非 Linux fallback。首次空 bind 可以在当前原 admission 下创建 Session directory，
该 metadata I/O 必须计入 drain；拒绝任何已存在的 Session 目录，包括空目录。

当前 CSI 挂载观察器已持续持有 no-follow 根目录 fd，并在发布每次挂载 receipt
前验证 fd 身份和命名根路径。并发观察共享原始打开操作；观察到根替换后，该生命周期
永久封锁。worker 启动失败和关闭都会关闭自有 fd，包括 executor 关闭失败的情况。
这是已接入现有观察器的根目录生命周期基础；组件文件工具、备份准备和库存已通过
保留 backend 借用同一原根。生产 worker 准入与退役库存仍未接通。POSIX 目录 fixture 测试不构成 Linux CSI/NVMe 执行、物理 writer 终止或
NodeUnpublish 资格。

本组件在将该根目录借给文件 I/O 之前，已为现有 owner 增加可 join 的 operation
lifetime。
每个操作在第一次 await 前登记，并在完整 callback 前后验证原根目录。close 或身份
检查失败时立即封锁新操作；保留唯一 close promise，等待全部已准入 callback 结束后，
仅关闭一次原 fd。身份检查失败时启动 close，但不能等待自身操作，否则会自等死锁。
callback 也不能 await 自己 owner 的 close。callback 抛错仍执行最终身份检查并释放
操作；该错误本身不证明挂载已替换。真实挂载观察器的第二次 mountinfo 读取和 receipt
比较使用同一 lifetime，同时 join 在取得根 fd 之前就已开始的观察。仍有这些观察在运行
时，close 不能返回。保留 backend 已通过同一 owner join fd-bound tool/history
callback 与格式 helper。原生 preparation 权威、物理 helper 终止和聚合 retirement
counter 仍需真实接线与资格验证，之后才能准入私有 worker。

从已打开普通文件 descriptor 复制 raw preimage bytes，以
`O_CREAT | O_EXCL | O_NOFOLLOW` 创建唯一 leaf。同一 descriptor 完成
stat/read/write/hash/chmod，处理短写，在发布 metadata 前 sync 文件和目录。
不能覆盖 retained leaf，不能 unlink 失败尝试。全部 backup 读取验证原 content
pin，不能只检查当前存在或重新计算 hash。Snapshot 与 orphan bytes 保留至具备
资格的原 finalize，失败尝试仍是 blocker。Legacy `copyFile` 非原子且出错时可能
删除目的，不能提供此私有契约。这些选择依据文档中的
[Linux directory-fd 行为](https://man7.org/linux/man-pages/man2/open.2.html) 与
[Node 22 FileHandle 操作](https://nodejs.org/docs/latest-v22.x/api/fs.html#class-filehandle)，
仍需真实 Linux 测试。

从私有 factory → executor → `ManagedRuntimeFileHistory` →
`ManagedToolFileHistory` → `FileHistoryService` 传递同一个具体 backend，含
previous-history rollback 构造。Legacy caller 不传，保持原默认值。私有 create、
fingerprint、validation、diff、snapshot、inventory 读取均使用此 backend；
rewind/restore 与 orphan cleanup 在破坏性 I/O 前拒绝。Wrapper 仅借用，原 factory
拥有可 join 的 tail 与 descriptor lifetime。

保留组件已连接 descriptor-bound text/format read、Write/Edit mutation 与 history
fingerprint/diff/validation。在实际 open/use 边界拒绝保留 prefix alias 与 retained
backup-inode hardlink，并通过原 source lifetime 保留格式/编码语义。已有普通文件
采用原位写入，不保证原子替换或并发 writer snapshot。独立 Darwin POSIX fixture
不能证明 Linux CSI 或物理 helper 终止。此设计保护声明的文件系统边界，不防御已
控制 worker memory、fd table 或 mount namespace 的 hostile actor。

bind 必须等原始 SQL/native READY 准入与固定 context 安装完成后，才延迟调用唯一
原 composer。startup/attestation 不能调用它：backend open 已创建 exclusive
history 目录。executor 必须直接接收 composer 的 history 对象；旧 raw bind 会
创建第二个 history，将准备与实际 Write/Edit 跟踪分开。

Hosted 当前先调用 prepare，再提交 `pendingTurn`/`pendingMessageId`；这些字段
不是 preparation 准入。此 profile 必须在 worker I/O 前，向既有原生 file-history
domain 提交版本化的准确 preparation intent，绑定原 turn/message、invocation/input
ref 与排序路径。原 parent guard 仅在 READY 准入。Broker 在原 connection 核对
已提交字节，不信调用方标志或缓存 context。保持单一 journal 权威，不持 parent
SQL 锁跨 worker I/O。

私有 file-history body 使用 `schemaVersion: 2`；durable resource ref、
`domain.committed` event、native marker 仍为 version 1。Root 准确字段为
`operationId`、`revision`、`previousRecordRef`、`schemaVersion`、`profile`、
`runtimeSessionId`、`state`、`backupDirectory`、`retainedBackups`、`preparation`、
`record`。前三个由 authority 提供。`state` 保留封闭 owner/snapshots/files
形态；`record` 保留普通 file-history reader projection，必须与
`state.snapshots` 一致。Legacy body schema 1 保持独立分支，不能充当私有
preparation 证据。

`backupDirectory` 准确为 `volumeDevice`、`volumeInode`、`directoryDevice`、
`directoryInode`，使用原打开 descriptor 的规范无符号十进制字符串。
按 name 排序的 `retainedBackups` 每项准确为 `name`、`device`、`inode`、
`byteLength`、`digest`、`mode`：已验证单叶名、规范 device/inode 字符串、safe
integer 字节数/mode、bare lowercase SHA-256 bytes digest。每个非 NULL retained
snapshot backup 恰有一个原 pin，跨 revision 不能更改或删除 pin。Native pin
描述成功认证的 preimage；sealed worker inventory 另行观测全部实际 leaf，含
未知/不完整 orphan 尝试，不能用认可当前字节代替先前 pin。

| History stage | 准确 preparation 与 transition                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 初始 idle     | `preparation: null`，空 state/pins、revision 1、NULL predecessor；原空 bind 观测                                                  |
| Intent        | `stage: "intent"`、`turnId`、`promptId`、`batchId`、`invocations`、`paths`；保留 previous idle state/directory/pins               |
| Prepared      | 相同不可变字段，`stage: "prepared"`，增加 `intentRef`；直接 predecessor 等于该原 intent ref，仅增加已认证 backup 与匹配观测 state |
| 完成 idle     | `preparation: null`；直接 predecessor 为对应 prepared record，保留 retained evidence，证明整个原 batch 的 results/history         |

每个 invocation 准确为 `executionCallId`、`callId`、`functionCallId`、`toolName`、
`partIndex`、`ordinal`、`requestDigest`、`inputRef`、`toolDefinitionRef`。纳入 batch
全部已准入 read/write/edit，身份唯一并按原 ordinal 递增，对照已提交 assistant
message 验证 part/function 身份。Input/definition ref 为不变的封闭 durable ref。

当前 assistant UUID 是 preparation/tool.intent batch ID；checkpoint 保留其累积
batch ID 和此前 items。intent ordinal 是当前已接受 request 的局部序号，含拒绝留下的
空隙。从具备资格的前一 checkpoint 最大序号和当前 accepted 顺序推导全局 ordinal，
逐成员校验 assistant/function/part/execution 身份。不能强制两种 batch ID 或 ordinal
角色相等、省略 accepted 成员或增加第二个权威 batch ledger。

`requestDigest` 是准确 payload JSON UTF-8 bytes 的 hash，带 `sha256:` prefix；
inputRef.digest 是外层 input resource 的 hash，两者不同。Paths 从这些准确原
input bytes 派生为排序去重的 Write/Edit path union，使用 JS 默认 sort/Java
natural String order，不能用 locale order。Preimage I/O 前，将整体 resource 限制
在既有 64 KiB inline 上限，snapshot 限制为 100。

一次分配 call，发布 input/definition，并在提交 intent **前**为已接受调用预留
SQL PREPARED row，随后调用 prepare。Reservation 不是 dispatch authorization，
此顺序避免增加后续 execution-identity 解析阶段。文件 reservation 保留封闭
Tool-v2 deferred reference，不能发送 `runtimeProtocol: 3`/`inputDigest`；当前
service 将该分支限制为 Shell/Monitor。Read-only batch 不需要 backup intent。
后续 mutation 的 tool intent 与 dispatch checkpoint 必须引用已提交 prepared record。

[原 batch 预约设计](2026-10-08-k2-native-batch-reservation.zh-CN.md) 明确私有封闭
reference 扩展、精确字节与 allocation 原子持久化、完整成员和冷恢复。当前
`publish` 只暂存内存，不是持久上传；普通 Tool-v2 形状保持不变。Read-only
allocation 在首个 native tool intent 冻结，并要求完整 dispatch checkpoint，
不创建 backup intent。

稳定 command 使用 `csi-file-history:bind:<owner>`、`:intent:<batchId>`、
`:prepared:<batchId>`、`:settled:<batchId>`，每个提交一个既有 file_history-domain
event。从准确 semantic field 派生 contentDigest，排除 authority wrapper 与生成的
reader projection，返回真实 domain receipt/ref。恢复后的 retry 复用持久化 call/ref，
比较原 semantic bytes，不能制造新 batch 绕过不确定性。HTTP resource commit 与
read-only snapshot closure 都显式增加 schema-2 nested-ref collector，收集
invocation input/definition ref 与 intentRef；不能每次 transaction 递归整个
previousRecordRef 链。

提供独立于 provider lifecycle 的窄认证 history 分支：READY 允许首次空 bind、
已准入 prepare、snapshot，不允许 rewind/restore。Worker seal 后只允许对已绑定
原 history 做 idle snapshot。拒绝迟到 prepare，并保留其持久化未完成 intent 为
blocker。追踪已运行 preparation 至完成及最终 inventory，不能推断失败/拒绝 RPC
没有改变文件。

独立封闭 `csi-file-history` operation 使用 version 1。Bind/snapshot 只有
`kind`、`version`、`action`，prepare 增加 `preparationRef`。Broker 在原 connection
查找当前已提交 intent 与全部 SQL PREPARED row，对照 assistant/input/path/resource
membership 后派生 worker request。调用方不能提供权威 paths 或 prepared flag。
Transport 使用独立认证 CSI-v2 history route，匹配 boot identity 与已安装原 context，
不构造 ProviderWorker。Legacy raw-file-history request 保持不变。

Worker 去重是原 lifetime 内按准确 intent resource ID/digest 保存的观测，在第一次
await 前登记 retained promise。准确 retry join 原 operation 或返回 retained result；
内容变化冲突，失败不能重新 copy。此工作计入 seal 与 inventory。SQL 和 worker
admission 是两个独立 barrier：seal 先于首次 worker start 则拒绝；seal 先于 native
prepared commit 则持久化 intent 保持未解决。最小分支不授予新 prepare，也不授予
post-seal prepared 权威。Worker seal 后只允许已运行 preparation 的只读观测。
Cancel、timeout、SQL not_started、worker 身份丢失均不能清除未解决 intent。

Hosted load/resume/idle/cancel/history、workspace read-only recovery、原
file-checkpoint proof、native CSI inventory 都必须增加 schema-aware pending
reader。既有 cancelled-turn cleanup 写 schema 1 并置 pendingTurn NULL，对 schema 2
禁用。Parser 丢弃未知 pending 字段，或 terminal reader 只检查最新 record，都会
丢失义务；必须 fold 并验证整个同 domain revision 链。

## 4. 原生 journal 与原 continuation

扩展严格 reader 至真实文件 transaction/resource 形态，验证 UTF-8、重复/尾随
字段、原 parent UUID/sequence 链、递归排序 JSON 的 events/commit digest、原
writer generation 1、activation epoch 1、resource identity/digest/size。
结构性 counter 仍为严格原生 JSON 整数；任意 tool/message payload 的数值遵循真实
producer canonical 编码，不能一律限制为整数。保留有界 history 与 statement 超时。

重放完整原 history，在非 activation transaction 间保留原 install 与同身份 renewal。
从具备资格的 event 推导最新 checkpoint 并对照 head，取代永远要求 NULL 的条件。
验证 checkpoint identity、covered prefix、predecessor、activation、tool batch、
runtime binding、引用资源。保留 resource/journal/head 原子提交及相同命令只读 replay。

首个实现门禁只在 READY 接纳一次真实初始 `before_model` checkpoint。它只有一个
`checkpoint.committed` event，无 prior checkpoint，boundary 为 NULL，subject 是
原 activation。covered sequence 等于当前已提交 prefix；definition/config revision
和 input digest 分别等于原 header 的 definition/root ref ID 与 definition digest。
验证完整封闭 checkpoint：初始 recording、pending work、tool/runtime/attempt/approval
group、output/follow-up state 均为空。核对 state ref、完整 events hash 与 commit marker。
Replay 在随后同身份 activation renewal 间保留此 checkpoint，并将推导出的 resource ID
与 journal head 对照。重复初始 checkpoint、后续 phase 或无关 event 仍被拒绝。
此基础阶段不代表文件闭环具备资格；下表描述后续目标行为。

| 操作                                                            | READY                                                             | DRAINING                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| 原 activation renewal                                           | 准确既有 renewal                                                  | 原 writer/activation 有效时允许相同 renewal           |
| 初始 checkpoint、input/model message、preparation intent        | 验证 profile 与原生形态                                           | 拒绝新增工作                                          |
| Tool intent / dispatch checkpoint                               | 关联准确原 PREPARED execution/input；authorization 另行仅限 READY | 拒绝新 dispatch                                       |
| Result message / outcome checkpoint                             | 关联原 intent/execution                                           | 仅限不可变 seal 前已授权原工作                        |
| 工作后 history                                                  | 对照原已准入 batch/snapshot                                       | 相同 pre-seal batch 完成，无 pending preparation/undo |
| Replacement activation、recovery、普通 release、generic control | 保持私有拒绝                                                      | 保持私有拒绝                                          |

在原 connection 按原 parent → native history → 不可变 retirement identity →
Runtime Session → 排序 execution 加锁。要求原 Session、lease、owner、input、
dispatch generation、authorization。核对多调用 batch 的全部成员，含 terminal
history；单个 execution 匹配不足。关联来自原 journal/input/checkpoint 字节与
Broker record，不能使用 `continuation=true` 或只信 phase 标签。缺失、歧义、
orphan、UNKNOWN、不支持或超限证据均拒绝并保留 holder。以真实 parent 锁等待
验证 RC 与预热 RR。

## 5. Hosted 完成与 retention

Hosted declaration、intent binding、transport、checkpoint runtime binding 填入
私有 digest/configuration；legacy Workspace digest 不能授权此 profile。完整保留
内联结果，超限/省略 output 阻断退役。Settlement 资格验证比较 Broker 原 result、
正常转换、持久化 outcome/message 与 checkpoint coverage。
此 profile 禁止普通 v2 ACK 清除 input/result 字节；legacy disposal acknowledgement
不能实现 until-finalize。

`resolveAwaitRuntime` 写入 `consumed=false`；真实 consumer 在后续 Hosted model
完成后才置 true，当前文件 verifier 要求该消费。不能从 SQL SETTLED 伪造。
正常正向测试在 READY 经过真实消费边界；seal 中断执行时验证原 result 持久化，
并报告剩余未消费/turn-lifecycle blocker。已准入原 Harness turn 的 continuation
资格属于 A2 writer closure，新开 turn 不能隐藏此缺口。

Hosted 普通 finish 会调用 Broker release。私有 profile 必须保留原 Runtime Session
与 holder，供后续 retirement-close / cut / finalize，不调用 legacy release，也不
报告物理关闭。Retention 与 generic recovery 在具备资格的聚合 cut 前不能删除
这些资源。SQL terminal state、QUIESCENT 观测、文件 RPC 成功均不是 application
settlement 或卷释放。

## 6. 实现顺序与受影响 consumer

实现连通的私有组合后验证；分离的 parser、worker、SQL fixture 通过不能证明正常链。

| 层           | 必须修改和验证的既有 consumer                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| 身份         | Java `ManagedCsiProtocol`、provisioner/identity/transport；TS CSI envelope、container boot、attestation/drain      |
| Worker       | managed-context 文件组合、executor/factory/lookup、history route、backup service；不构造完整 profile lifecycle     |
| 原生权威     | `CsiNativeActivationProof`、`JdbcCsiActivationAdmission`、Session Store commit/resource/read、原 checkpoint proof  |
| Hosted       | `HostedWorkspaceToolTurn`、Broker client/profile declaration、preparation-intent producer、工作后 history consumer |
| 剩余 closure | Managed Agent turn/Session/lifecycle 与 retention writer、总体 deadline、retirement-close/finalize                 |

两种语言设计与 E2E plan 随实现更新；先预留 wire 值，再修改 producer/consumer。
不包含公开 selector/部署变化。

## 7. 验证与验收

记录全局 `qwen` 基线及真实 native producer 字节在当前路径的拒绝。随后在明确拥有
的目录启动真实 file-only HTTP worker，使用真实 Hosted producer 与 SQL authority，
让 read/write/edit 经过准入、文件副作用、原 result、message/history、checkpoint。
隔离 MySQL 验证原子回滚与锁；H2 不能证明其锁性质。本地目录测试不验证 Linux
NVMe/CSI provenance 或云上交接。

覆盖错误身份/digest/context/Pod、未知字段/数值形态、排除工具/route、备份保留子树/
符号链接、备份失败/容量、准确/冲突 replay、多调用部分结果、超限/省略 output、
RC/预热 RR seal 竞争、迟到 prepare、过期 writer/activation、原 Session 保留。
观察字节与真实文件，不能只检查成功返回。更新同一个 Draft PR 前完成 rebuild/
typecheck/bundle、focused test、独立验证、自审与仓库 review。

文件组合的验收要求完整 READY 链与所规定的 DRAINING 持久化/拒绝边界；仅完成初始
checkpoint 门禁属于实现进展。剩余 Harness
writer、聚合 cut、原 finalize、物理 stop、NodeUnpublish、原子 release、新云上
多轮 handoff 仍需生产证据。本地 fixture、CI 通过、review 超时均不证明完整 K2
或 maintainer 批准。
