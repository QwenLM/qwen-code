# K2-A2：原生原 batch 预约

[English](2026-10-08-k2-native-batch-reservation.md) |
[简体中文](2026-10-08-k2-native-batch-reservation.zh-CN.md)

状态：batch 预约仍为提案，尚未实现或验证。源码基线为
`b23b4c22a8b1fbc2e790f8c424ae9466186a6b66`。下文有界 input/wake 前置依赖
已实现并完成独立本地验证。这是
[原生文件链路](2026-10-07-k2-native-file-execution.zh-CN.md) 的下一项依赖，
属于完整 K2 目标与 Draft PR #13526。预约成功不替代原生 history、执行、消费、
退休或物理资格。Proposal #12380 与 tracker #13395 保持开放。

## 1. 问题与当前状态

当前私有 proof 准入 genesis、activation install/renew、原 input/wake 和一次性初始 checkpoint。
通用数字事务 hash 已可验证，但 committed assistant、file-history intent 与 tool
outcome 尚无私有语义准入。Worker 不构造文件 history 或 executor。

Hosted 在工具预约前提交 assistant，但在预约前准备 raw file history。它将每份
input 发布到内存 staging map，预约该调用，再发布 definition 与 tool intent。
`publish` 不是上传：input/definition 字节通常到后续原生事务才进入 DB。因此预约时
既不能用 supplied ref，也不能用假定存在的 STAGED DB row 证明字节。SQL 接受后、
tool intent 前崩溃，还会丢失随机 call/ref ID 及内存字节。

原 SQL reference 保存 Session、prompt、call 与 request digest，却不区分同 prompt
的两个 assistant batch。锁住调用者列出的 execution ID 不能证明没有漏掉已接受的
Read、Write 或 Edit。先筛 PREPARED 会隐藏已接受的冲突/终态 row。前一项有界修复前，
私有重试比较新生成的服务端候选 ID 与原 ID，精确请求重放也会被拒绝。

前一项有界 bugfix 已在所有现有 live admission 检查之后，将已有重试比较改为
不可变 request 身份；只读返回原 receipt 的当前状态，不再分配或授予权限。
这不代表下文所提 batch/reference/resource 契约已实现。

保留一个 native journal 和原 resource/execution 表，在 intent 前补齐持久 allocation
身份和原字节。不增加第二 batch authority、调用者 paths 或自报 prepared 标志。

## 2. 封闭预约与所有权

复用现有鉴权 `executions:prepare` 入口，增加独立精确私有形状。普通
Tool-v2/v3/provider 请求形状保留。私有请求只在原 envelope 增加
`inputBytesBase64` 与 `toolDefinitionBytesBase64`。Ref 元数据只在 reference 内
保存一次；文件不用 `runtimeProtocol: 3`、`inputDigest` 或 publication credential。
根据持久原 `csi-files-retirement/1` 请求选择分支，不用可选 caller profile 标志。

| Reference 字段      | 原生产方及含义                                                  |
| ------------------- | --------------------------------------------------------------- |
| `sessionId`         | 固定原 Runtime Session，也是 owner/Harness Session              |
| `promptId`          | 原 prompt/turn UUID                                             |
| `callId`            | 一次分配的 Runtime call ID，与 model function ID 不同           |
| `argsDigest`        | 原名称，指精确 payload JSON UTF-8 的 SHA-256，带 `sha256:` 前缀 |
| `batchId`           | 已提交原 assistant message 的 UUID                              |
| `functionCallId`    | 该 assistant 的原 function call ID                              |
| `partIndex`         | 原 message 中唯一 function-call part 位置                       |
| `ordinal`           | 原 request list 位置，保留拒绝空位                              |
| `inputRef`          | 原封闭 `managed-tool-input` durable ref                         |
| `toolDefinitionRef` | 原封闭 `managed-tool-definition` durable ref                    |

请求 reference 恰为这十字段；持久 reference 只额外加入已有
`dispatchMode: "deferred"`。每个 ref 保留已有精确 `resourceId`、`kind`、
`schemaVersion`、`byteLength`、`digest` 形状，schema 1、bare lowercase SHA-256，
64 KiB inline 上限。结构位置为非负 safe integer。Envelope 的 Session、turn、call
与 digest 必须和 reference 一致。Idempotency 仍为 `<runtimeSessionId>:<callId>`。

接受 allocation 前解码并验证两份原字节。Input 为已有精确
`{harnessSessionId,runtimeSessionId,payloadJson}` wrapper；验证原角色，hash 精确
`payloadJson` 字符串，再解析其 `{toolName,input}` payload。外层资源 hash 是不同
的 digest。验证有限 Read/Write/Edit 契约和 model function/part 映射，包括原
file-path normalization。Definition 身份与字节须匹配所声明原工具，不得扩大有限
worker manifest。不重新序列化 payload 来计算 request digest。

入口属于 persisted-owner 范围。鉴权本身不是权限：原 request pin、原 activation/
conversation、当前 parent 和固定 READY Runtime Session 必须在同连接获资格。
公开 Hosted/Spring 选择及旧私有 worker 拒绝继续保留。

## 3. 原 allocation 与资源原子提交

使用原 DataSource/transaction，保持 parent 先锁：placement domain、tenant
retention、排序后的 request slot 与 binding history、原私有 Session pin、native
head/journal/resource proof、固定 Runtime Session，最后稳定 execution row 顺序。
字节在 SQL 前限制大小，不跨 worker 或其他网络 I/O 持有事务。

恢复从 execution row 发现 refs。在锁固定 Runtime Session/executions 前，先在
同连接稳定排序地枚举并锁原 Session 的 input/definition resource rows。枚举
execution 后，将其精确 refs 反向关联这份库存并验证 bytes。不得先锁 execution，
再反序获取 resource 锁。库存本身不把 PUBLISHED bytes 变为原生引用资格。

首次接受须验证 committed 原 assistant 和当前 native conversation。开启该路径前，
native conversation 准入须同时接入首次接受和完整历史 fold；不能只查新 message 而
跳过未合格前缀。Staged assistant 不得选择 batch。

同一事务将每份原 input/definition 以 `PUBLISHED`、`MYSQL_INLINE`、精确原
scope/ref/bytes 插入原 resource 表，并插入原 PREPARED execution reference。
复用 resource ID 时全部不可变元数据及 raw bytes 必须一致；不一致回滚资源和
execution。原 SQL row 在回复不确定后仍保存 refs。这一步不创建 `resource_ref`、
journal revision、dispatch authorization 或 file grant。

PUBLISHED input 只证明持久 allocation，不等于 REFERENCED 原生证据。已有公开
result-kind whitelist 不改。只有当前原 allocation 指向精确 input/definition ref 时，
才用窄私有资源验证和恢复读取。不把这些资源登记为可回收 publication object；
它们的原义务持续到合格私有 finalization。

精确幂等请求重新验证原不可变请求 tuple 后返回原 receipt/ID。比较 request identity，
不比较新服务端候选 ID，也不替换已接受 row。改变 refs、字节、assistant/function/
part、digest 或原角色即冲突。直接 generic repository mutation 不得绕过私有
资源/身份检查。

## 4. 完整成员、intent 与恢复

在提交 schema-2 history intent 前预约全部接受成员。私有 producer 拆开现有预约/
tool-intent loop：提交 assistant，固定 inputs/definitions 和 call ID，完成所有预约
尝试，提交 native history intent，取得合格原 preparation，提交 native prepared，
然后 tool intents 和 dispatch checkpoint。普通 producer 顺序保持不变。

Read-only batch 不创建 backup intent，仍先预约整批。它的第一个 native tool
intent 在同样完整成员 fence 下冻结 allocation；每个 tool intent 引用/提升自身
精确资源，dispatch checkpoint 必须匹配完整冻结 allocation 与全部 committed
intents 后才可执行成员。后续 reservation 不得扩大该 batch。Mixed batch 的
history intent 包含已接受 Read 成员，但 paths/backups 只从 mutation 推导。

在原连接按稳定 execution-hash 枚举所有潜在相关原 SQL allocation，每页 100，
超过已有 4096 条上限即拒绝。包括全部状态及冲突历史身份；核对精确原
binding/generation/owner/runtime/turn 和 reference `batchId`，再把完整选中集合
与全部 intent invocation 对照，包含 Read。不查 caller 提供的 ID 子集，也不在
比较前去掉非 PREPARED row。每个选中成员必须独立匹配 committed assistant、
原 bytes/refs 和该转换。不同 assistant UUID 区分同 prompt 的连续 batch。

Intent commit 与 reservation 共用 parent/native-head fence。接受 batch 后，
该 batch 新的非 identical reservation 拒绝；精确重放只返回原 receipt。此前未解决
intent/prepared batch 也阻止后续 assistant 逃避义务。Parent 锁将成员观察与新 row
插入串行化，不构成跨进程物理 I/O 授权。

Intent 事务显式收集 invocation input/definition refs，精确验证原 allocation 后，
原子地将其 PUBLISHED 资源提升为 REFERENCED，插入 revision association 并提交
native intent。当前 `commitResources` 不进行这种提升。以后所有 prepared/replay/
history reader 仍须验证原 revision/ref association、scope、bytes、length 与 hash。
拒绝 commit 会回滚提升和关联，但保留此前已接受 allocation/PUBLISHED resources。
Prepared revision 收集 `intentRef`，不把整条 predecessor chain 递归复制到每个事务。

冷恢复需要鉴权的 persisted-original-owner batch reader，在同样有界 current SQL/
native proof 下返回完整不可变 allocation identity/ref/state。现 execution `status`
不返回这些 refs。Selector 标识原 assistant，不提供成员集合。通过窄 allocation reader
读取两份原字节，复用精确 calls/refs；不得调用 `prepareRequests` 生成新身份。若没有
任何 allocation，合格 committed assistant 可开始一次分配；若已有任意 allocation，
先恢复全部已知原身份，再补足已证明从未接受的成员。

确定无 row 的预约拒绝保留 ordinal 空位。Timeout、lost response、unknown status
不算拒绝：必须由精确重试/current full-batch read 确认原 row，否则保持 pending，
阻断 dispatch。缺失、损坏或关联不明资源也阻断，不用新 resource UUID 修复。
只读重放不授予 seal 后新 dispatch。明确 continuation/seal 策略仍属于后续原生
grant/settlement 实现。

缺失 SQL member 不证明 model request 的拒绝原因。只有完整 current read 与
parent/head fence 证明缺失，并恢复不可变 assistant/function tuple 后，冷恢复才可
补 absent member。已接受但尚未 intent 的成员若 cancelled、not_started 或 UNKNOWN，
不得移除后提交更小 batch，也不得重标 PREPARED。它阻止新 intent/dispatch，直到
原合格 cancellation 或 retirement 路径结算义务；这一步不凭空补出该路径。

区分 local 与 cumulative ordinal。当前 `tool.intent`/history `batchId` 为 assistant
UUID；checkpoint 保留之前累计 batch ID 和 items。Current global ordinal 为
`max(localOrdinal, previousMaximum + 1)`，按接受顺序更新 maximum。Prior max 9，
接受 locals 0,2，对应 globals 10,11；无 prior items 时为 0,2。验证 model/part/
function/execution 映射，不把两种 batch ID 或 ordinal 角色等同。

## 5. 真实消费方与实现顺序

当前没有 TypeScript 私有 Harness 生产调用方。新增一个 checked-in 内部 runner，
消费经审阅的连接 descriptor 和原私有 CREATE/Session。Descriptor 提供连接资料，
不是 profile/grant 权威。复用原 warmed binding、`createHttpManagedSessionStores`、
`openManagedSession`、`createManagedHarnessHandle` 和 sink-backed message commit。
它真实构造 required private turn 分支并传给 `runHostedHarnessTextTurn`，不新增无人
设置的 optional private flag。公开 Hosted profile union/create/load、Spring CREATE、
ServeOptions 与 environment selector 保持不变。

使用原 `ManagedHookActivationController.runTurn` 的 Session model-slot guard 和
它的真实 modelScope。其 turn operation 为 null，不构造 Hook worker 或 replacement
activation。这样保留真实 main model-attempt events 与 ownership；不同 Harness
handle 本身不能串行整个 Session。Private native grammar 获资格前，此 runner
不能推进。不隐式要求 optional text-delta 或 Hook producer。

显式调用原 `submitInput`，由原 prompt blocks 与 admission bytes 将
input.accepted/wake.requested 同事务提交。Sink 写 user message 或空 initial
checkpoint 都不代表 input 获准。原 model caller 返回最终 assistant，不会代提交；
runner 必须把返回 message 与原 turn_result 通过 sink 提交。当前 no-tool 路径只返回
text/model，丢失 provider 完整 Parts；tool 路径保留真实 model-history Parts，却按
promptId warm 普通 Runtime Session。私有 caller 必须保留实际 Parts 并使用固定原
Runtime Session；private 字符串或空 tool callback 无法接通这些消费方。保留精确
message parent chain。Model function partIndex 指完整 parts 位置，ordinal 指
function requests 位置；tool definition 包含真实 name/description/
parametersJsonSchema，不能仅为 `{name}`。

该调用方验证持久 reserved profile、精确 genesis definition
`{engine,sessionId,toolProfile}` 和 root `{cwd}`。使用原有限三工具 digest/manifest，
不增加 manifest。Private acquire 用该 digest；private Runtime Session 跨 turn
固定为原 owner UUID，不用 promptId。Private 分支用 schema2 history/control、
私有 capability/policy bindings 和原 retained ACK/finish 语义，绝不调用普通
turn-finish release。仅向 extras 传 private 字符串不能闭合这些消费方。实际 model
declarations、execution 和 `consumeResults` 通过原 model caller 接通。

| 层                      | 必须连接的消费方                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Private Hosted producer | 内部私有 profile/三工具构造、assistant commit、预约前 definition/input bytes、一次性 allocation/recovery、history intent 前完整预约 loop |
| Broker 入口             | 精确私有 HTTP/body parser/service 分支、固定原 Session、不可变 candidate resources、原 receipt replay；普通 prepare 不改                 |
| 原 JDBC                 | 同连接 native conversation 资格、PUBLISHED resources/PREPARED row 原子提交、完整成员 current read、history-intent 预约 fence             |
| Session Store           | 窄 allocation-resource verifier/read/recovery 与 intent 原子提升；已有公开 result publication 不改                                       |
| Native history          | 首次 commit、replay 和完整 fold 共用 assistant/refs/membership 及 schema2 idle→intent→prepared→idle 规则                                 |
| Wire/continuation       | 严格私有十一字段 reference 消费，验证后投影原 Tool-v2 wire；旧精确形状保持独立                                                           |
| Checkpoint/recovery     | Snapshot 保留原完整私有 reference，schema-aware proof/resource closure；schema2 禁止 legacy schema1 pending cleanup                      |

具体源码消费方包括 `hosted-workspace-tool-turn.ts`、
`hosted-workspace-broker.ts`、`http-managed-session-store.ts`、
`original-file-checkpoint.ts`、`RuntimeBrokerHttpServer`、
`RuntimeBrokerService`、`JdbcRuntimeBindingRepository`、
`JdbcToolExecutionRepository`、`HttpRuntimeTransport`、
`JdbcCsiActivationAdmission`、`ManagedSessionStore`、`WorkspaceRecoveryReader` 和
`WorkspaceCsiCheckpointSnapshotStore`。

已实现的首项有界 conversation 片段仅接纳真实原 `submitInput` 事务。它按顺序包含
`input.accepted` 与 `wake.requested`，发生时间相同，均无顶层 subject。封闭 payload
绑定同一个原 prompt/input UUID、`hosted-harness` 来源、`input` wake reason、原 accepted
事件 ID/sequence 和嵌套 turn subject。Deadline 为 null 或原有界时间戳。Command ID 为 prompt UUID，content digest 为原
`managed-input` 字节的裸 SHA-256；原 `managed-admission` 内容精确为
`{promptId,digest}`，其中 digest 为同一 hash 加 `sha256:` 前缀。Input 字节包含非空
text block 数组，每项封闭为 `{type:"text",text}` 且 text 非空。保留任意文本，包括
Unicode、换行与超过结构 ID 长度限制的文本；每份原资源仍以 64 KiB 为限。事务摘要匹配
不能代替这些检查或原 revision/ref 关联。

Fresh 接纳仍在原 READY binding、native writer 和 live activation 栅栏内。Fresh 与
historical 共用一项转移校验，完整历史从原 journal 派生并保留已接受 input UUID，不新增
权威表或信任调用方 projection。不得在未结算 input 上叠加另一个 fresh input。一次性
空 Harness checkpoint 可以在 input/wake 后按实际 coverage 提交，turn/prompt identity
仍为 null；activation renew 保留 input/checkpoint。非 checkpoint metadata 不复述
head 保留的 checkpoint。Replay 以完整原历史派生同一状态且只读，包括 DRAINING；不会
将当前 READY 或当前到期时间重新施加于历史事件。DRAINING 中的新 input 仍拒绝。

这段实现不接纳 user/assistant 消息、model attempt、turn 结算或后续 checkpoint phase。
这些真实生产方及转移仍需独立验证与所选真实私有 runner。原结算尚未获资格时，不能清除
或替换未结算 input 栅栏。Input/wake 与空 checkpoint 本身不识别 assistant batch、
不预约文件调用，也不授予 worker I/O。

先连接原 conversation 准入及原子持久预约，包括完整成员恢复；再由 schema2
intent/prepared 和可信 worker readback 消费同一证据。最后将同一 composer/history
接到真实 execution、完整 outcomes/results/messages、checkpoint 和 Hosted
`consumed=true`，保留原 retained evidence。不宣称第一步完成 A2，不把预约 receipt
作为后续 grant。

## 6. 验证与验收

源码编辑前运行全局 CLI 基线，记录实际 Java/CSI 入口缺口，需要时使用生产入口
脚本替代。使用真实 native assistant/input/definition/transaction producer、真实
Broker service/HTTP/JDBC 和 Session Store commit/read。注入 helper 返回值不证明
前缀获资格。

有界 input/wake 前置依赖已有独立本地证据，覆盖两种真实 producer 顺序：先 input/wake
再空 initial checkpoint，以及先 checkpoint 再长 Unicode/换行 input。Renewal 保留
input/checkpoint，精确重放保持全部 53 表只读，另一个未结算 input 和 DRAINING 中
fresh input 拒绝；摘要有效但语义不符及原 revision/bytes 损坏也拒绝。Historical
renewal replay 与真正 fresh renewal 分别验证。测试使用实际 native HTTP adapter/
collector 与生产 Spring transaction/JDBC 方法、专属 H2 fixture、synthetic Pod 元数据，
worker I/O 为零。这仅验证有界前置依赖；下述 batch 矩阵仍为必需且尚未验证。

| 组        | 必须观察的行为                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| 身份/重放 | 同请求返回原 execution ID/resources；改变 tuple/bytes 冲突，无第二 row 或替换资源                                    |
| 原子性    | 任一资源或 row 插入失败回滚完整新 allocation；已接受 row 在丢失回复后保留精确原字节                                  |
| 成员      | 漏 accepted Read、额外/重复/外来/终态 row、改变 function/part、迟到插入均拒绝；确定拒绝空位及同 prompt 双 batch 分开 |
| 资源      | 单独内存 staged ref 不足；无关联 PUBLISHED input 拒绝；intent 提升/关联原子且重新核对原 hash                         |
| 恢复      | Intent 前崩溃恢复原完整 allocation/ref/bytes；成员不明阻断且不重分身份；schema1 cleanup 不得丢掉 schema2 preparation |
| 并发      | 真实 parent/head 竞争、current RC/warmed RR 完整观察成员；SQL 锁不跨 worker I/O                                      |
| 兼容      | 普通 Tool-v2/v3/provider reference 与 result publication 兼容；公开/旧私有门禁保持关闭                               |

执行相关 focused tests、build、typecheck、适用 bundle 与 Java 静态检查；随后独立
test-engineer 验证、两轮完整自审和仓库实际 review workflow。H2、本地 fixture 或
预约绿灯不证明 MySQL 竞争、Linux CSI、真实 worker grant、完整 K2 或维护者批准。

## 7. 剩余决策与资格

本实现已选择上述持久 allocation 与精确 wire；不计划第二 batch ledger 或通用
resource-publish endpoint。上述内部私有 caller 已选定，尚未实现。开启 allocation
前，精确 native conversation grammar 仍须通过真实 producer fixtures 确认：message
envelope/content、user/prompt parent chain、assistant/function/part 映射，以及选定
caller 实际发出的 model-attempt/stream events。首次准入和历史 fold 必须用同一
grammar，并跨 activation renewal 保留上下文；kind allowlist 或只查 latest assistant
不能替代该验证。每个新增字段都须有真实生产和消费方。

Worker grant 仍需独立封闭的不可变 bootstrap trust、当前原 SQL/native readback、
local preparation barrier 与 seal race 语义。不能依赖 global Harness bearer、caller
URL、签名陈旧 snapshot 或单独 receipt。生产和消费接线并验证前不开放 worker
preparation/execution route。全部 writer/lifecycle、不可变 cut、聚合 DRAINED、
可信物理终止、NodeUnpublish、原子 RELEASED、安全复用和全新完整目标集群矩阵，
仍为完整 K2 设计的必需项。
