# K2-A2：原生原 batch 预约

[English](2026-10-08-k2-native-batch-reservation.md) |
[简体中文](2026-10-08-k2-native-batch-reservation.zh-CN.md)

状态：私有原 reservation、resource 与完整 current batch read 已实现，并有
2026-10-08 的有界独立本地证据；剩余原生链路与目标环境资格尚未完成。变更前源码基线为
`d50fae9da9ffa2ecbf81e4a61b98f6ec56da0843`。原 input/wake、text/thought 对话、
流式模型记录、私有认证 Hosted 附着及 Java 文本入口已实现并有有界本地证据。
早期 input/wake 片段保留为各自范围的历史证据。这是
[原生文件链路](2026-10-07-k2-native-file-execution.zh-CN.md) 的下一项依赖，
属于完整 K2 目标与 Draft PR #13526。预约成功不替代原生 history、执行、消费、
退休或物理资格。Proposal #12380 与 tracker #13395 保持开放。

## 1. 问题与当前状态

在该基线，私有 proof 准入 genesis、activation install/renew、原 input/wake、一次性
初始 checkpoint、完整有界 text/thought message、原 model attempt/流式记录及
原子 turn settlement。私有 Hosted owner 使用固定原 Session 与 settled history
调用共享 runner，但没有 tool-turn callback。原 function-call Parts、file-history
intent 与 tool outcome 仍关闭，私有 worker 仍无获准的 native 文件 executor。

Hosted 在工具预约前提交 assistant，但在预约前准备 raw file history。它将每份
input 发布到内存 staging map，预约该调用，再发布 definition 与 tool intent。
`publish` 不是上传：input/definition 字节通常到后续原生事务才进入 DB。因此预约时
既不能用 supplied ref，也不能用假定存在的 STAGED DB row 证明字节。SQL 接受后、
tool intent 前崩溃，还会丢失随机 call/ref ID 及内存字节。

原 SQL reference 保存 Session、prompt、call 与 request digest，却不区分同 prompt
的两个 assistant batch。锁住调用者列出的 execution ID 不能证明没有漏掉已接受的
Read、Write 或 Edit。先筛 PREPARED 会隐藏已接受的冲突/终态 row。前一项有界修复前，
私有重试比较新生成的服务端候选 ID 与原 ID，精确请求重放也会被拒绝。

前一项有界 bugfix 在当前 live admission 检查之后比较不可变 request 身份。
本实现关闭无资源的通用私有准入，包括历史终态重试；精确重放改用独立的字节资格
私有入口。旧无资源 row 仅作为测试中的历史数据，用于验证已有 continuation 栅栏。

保留一个 native journal 和原 resource/execution 表，在 intent 前补齐持久 allocation
身份和原字节。不增加第二 batch authority、调用者 paths 或自报 prepared 标志。

## 2. 封闭预约与所有权

复用现有鉴权 `executions:prepare` 入口，增加独立精确私有形状。普通
Tool-v2/v3/provider 请求形状保留。私有请求只在原 envelope 增加
`inputBytesBase64` 与 `toolDefinitionBytesBase64`。Ref 元数据只在 reference 内
保存一次；文件不用 `runtimeProtocol: 3`、`inputDigest` 或 publication credential。
根据持久原 `csi-files-retirement/1` 请求选择分支，不用可选 caller profile 标志。

Base64 字段是资源内容，不是结构 ID。解码 canonical、非空 Base64，并按自身的
87384 字符编码上限和 65536 字节解码上限验证；不能让 512 字符 ID 校验器拒绝真实
declaration。

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

在已有鉴权 Broker origin 增加私有 `POST /executions:read-batch` 入口。
精确请求为 protocolVersion、requestId、harnessSessionId、runtimeSessionId、
promptId 和 batchId，不提供成员 IDs 或 paths。返回 protocolVersion、上述
owner/Session/prompt/batch 身份、原 runtime binding/generation 和全部 members。
每个 member 返回原 executionCallId、当前 state、完整持久 reference、
inputBytesBase64 和 toolDefinitionBytesBase64。返回前由同 Connection 的原
allocation reader 为这些字节建立资格。不放宽公开 Session Store 的 PUBLISHED
白名单，不新增通用 resource publish/read 权威。实际 private turn 在预约响应
不明时消费该读取，然后才判断是否缺失。

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

私有生产调用方已经位于 `hosted-csi-session.ts`，由认证私有附着和 Java 文本命令
进入，见[私有 Hosted 附着](2026-10-08-k2-private-hosted-attachment.zh-CN.md)。
它使用部署固定的 Store origin、原 warmed Broker binding、
`LocalManagedSessionAuthority.open`、原 input admission 和 sink-backed message。
在这个实际调用方加入有限私有 tool turn 并传给 `runHostedHarnessTurn`；不另造
runner、可选 profile flag、公开 selector 或普通 create/load 路径。

保留原 Session model-slot guard、null Hook operation 和实际 modelScope/流式记录。
新的私有工具实现应满足共享 model 与 turn runner 实际消费的 public methods；普通
Hosted 继续使用现有实现。当前具体 callback 类型不得迫使私有实现构造普通
prompt-scoped Runtime ownership、raw preparation 或 turn-finish release。

真实 model caller 保留完整 Parts，并在 tool callback 前将每个原 function Part ID
替换为对应已收集 request 的 ID。使用现有 callback 一次提交这个原 assistant，
返回的 UUID 标识该 batch。`partIndex` 索引完整 Parts，`ordinal` 索引 function
requests 并保留确定拒绝空位。基础 file declaration array 已恰为 Read/Write/Edit。
持久化实际最终 advertised declaration，包含完整 `name`、`description` 和
`parametersJsonSchema`；普通实现会为 mutation description 追加备份语义。
仅有 name 的对象或重建的较窄 declaration 不是原 advertised bytes。在选择封闭
function-Part grammar 前，通过独立 baseline 采集实际 producer 字节。

私有 producer 宣告同一有限基础 declarations，并对 Write/Edit 使用已有的非 MCP
备份描述。与普通调用方共享该有限 declaration 转换，不为取得它而实例化普通
turn。Java 固定完整已观测 declaration 契约，不能接受仅符合三个名称的任意 schema。

独立 d50fae9 producer baseline 采集了五项原 Parts（thought、可见文本和三个
function calls）、三个非 UUID request IDs 及完整 1850 字节 declaration array。
这些 supplied FunctionDeclarations 与 OpenAI SDK wire 不同：本次采集中已有
SDK 从 Read/Edit parameters 移除了 `additionalProperties: false`。保留两套
观测。持久 definition 固定完整 supplied declaration，不声称其字节等于经过
转换的 SDK 请求。

原 function ID 不必是 UUID。它是重新写入保留的完整 Parts 的收集请求 ID，
与 Runtime call UUID 和可选 provider ID 分离。不能丢弃 provider 装饰字段，
也不能凭推断放行。校验已观测的私有 producer grammar，并保留完整 message
resource、parent、已接纳 input 和原 model attempt 作为证明。

共享 fold 必须区分最终文本 assistant 和带待处理 function 请求的 assistant。
在派生的 conversation prefix 中保留后者的原 UUID、有序 functions、part 位置
和局部 ordinals。待处理工作禁止普通 turn settlement、替换 input、新 model
attempt 或另一个 assistant 清除该义务。fresh acceptance 与完整历史回放执行
同一规则；仅在 TypeScript 暂停不能代替 SQL fence。后续合格的 result consumption
才允许原 conversation 继续，allocation 本身不允许。

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

历史首项有界 conversation 片段仅接纳真实原 `submitInput` 事务。它按顺序包含
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

该历史片段不接纳消息、model attempt 或 settlement。后续私有文本/流式 turn 已为
这些真实生产方提供资格，包括原 settlement。本实现加入原 function Parts 与
pending-batch 栅栏；后续工具 checkpoint phase 仍关闭。Input/wake 与空 checkpoint 本身仍不识别 assistant batch，不预约
文件调用，也不授予 worker I/O。

先连接原 conversation 准入及原子持久预约，包括完整成员恢复；再由 schema2
intent/prepared 和可信 worker readback 消费同一证据。最后将同一 composer/history
接到真实 execution、完整 outcomes/results/messages、checkpoint 和 Hosted
`consumed=true`，保留原 retained evidence。不宣称第一步完成 A2，不把预约 receipt
作为后续 grant。

### 当前整合片段

实现已连接共享 fresh/history fold 的原 function-call assistant 资格、实际私有
Hosted callback、原子 allocation/resources 和完整 current batch read。任何预约前
固定全部获接纳成员的 resource IDs 与精确字节，丢失响应后继续保留。返回 SDK 前
克隆有限 declarations 并固定完整 supplied 字节；持久 SQL reference 同时执行
严格 UTF-8、重复键及尾随 JSON 检查。通用 repository admission 与 HTTP/service
入口均执行 persisted-private 契约，旧无资源私有形状已关闭。独立本地观测及其
限制记录在第 6 节。

在固定 Runtime Session 锁之前，使用同一个 JDBC Connection 返回派生的原
conversation/batch proof。先枚举并锁 resource rows，再锁 Runtime Session 和所有
潜在相关 execution rows；比较包含终态与冲突身份的完整成员。原表和 journal 继续
作为权威。

allocation 成功本身不结算 native turn。在 intent、prepared、tool intent/checkpoint
及 worker grant 消费该精确 proof 前，新持久 reference 仍不可 claim，私有
preparation/dispatch/文件 I/O 继续关闭。使用共享 recovery-required 异常路径保留原
未解决 input/assistant 与已接受资源；不能让 generic error 将 allocation 变为普通
settlement。完整目标仍要求原 intent promotion、真实文件执行/结果/consumption 和
物理退休/交接，本片段是这些步骤的依赖。

完整 batch read 为持久原 owner 恢复 allocation bytes 和身份。它不授予新的
进程 boot，也不把当前仅创建的私有 attachment 变成 cold-owner adoption 入口。
为该 owner recovery 建立资格仍属于后续 continuation 实现。

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
worker I/O 为零。这仅验证有界前置依赖。下述矩阵仍为验收要求；当前 allocation
子集有后文记录的有界证据，intent/grant、并发与目标环境资格仍开放。

| 组        | 必须观察的行为                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份/重放 | 同请求返回原 execution ID/resources；改变 tuple/bytes 冲突，无第二 row 或替换资源                                                           |
| 原子性    | 任一资源或 row 插入失败回滚完整新 allocation；已接受 row 在丢失回复后保留精确原字节                                                         |
| 成员      | Current read 包含全部状态并拒绝冲突身份；后续 intent/grant 校验须拒绝漏 Read、额外/重复/外来或无效状态成员、改变 function/part 及迟到插入   |
| 资源      | 单独内存 staged ref 不足；公开无关联 PUBLISHED input 继续拒绝；私有 allocation read 校验精确持久 refs/字节；后续 intent 提升/关联须原子提交 |
| 恢复      | Intent 前崩溃恢复原完整 allocation/ref/bytes；成员不明阻断且不重分身份；schema1 cleanup 不得丢掉 schema2 preparation                        |
| 并发      | 真实 parent/head 竞争、current RC/warmed RR 完整观察成员；SQL 锁不跨 worker I/O                                                             |
| 兼容      | 普通 Tool-v2/v3/provider reference 与 result publication 兼容；公开/旧私有门禁保持关闭                                                      |

执行相关 focused tests、build、typecheck、适用 bundle 与 Java 静态检查；随后独立
test-engineer 验证、两轮完整自审和仓库实际 review workflow。H2、本地 fixture 或
预约绿灯不证明 MySQL 竞争、Linux CSI、真实 worker grant、完整 K2 或维护者批准。

### 当前有界变更后证据

独立本地运行完成八个不同组：普通 bundle Read；完整三成员私有 allocation/read；
首个及第二个成员接受后丢失响应；第二份资源插入及 execution 插入故障回滚；首次
预约前退休；以及跨越 100-row 分页的 101 成员 batch。250 项私有标记谓词是这些组内
的检查，不是 250 个独立场景。实际私有 attachment、Java 文本 producer、Node
owner/model SDK/共享 runner、native HTTP transaction 与 Broker HTTP/JDBC
路径产生原 assistant 和 allocation。专属确定性模型响应、编译的 provisioning
fixture、synthetic Kubernetes 元数据、Spring MockMvc 和 H2 是明确测试接缝。
本次未执行 Linux CSI、MySQL 或云上 worker。

原完整 Parts、非 UUID function IDs、assistant/function/part 映射、457/663/726
字节 supplied definitions 及 raw input bytes 在预约与完整读取后保留。成功 allocation
仅改变原 resource/execution 表：资源保持 PUBLISHED/MYSQL_INLINE，无 revision
association、file grant 或 worker 文件调用。精确重放保留原 ID，全部 53 表不变。
丢失响应保留一项或两项原 allocation；两种插入故障回滚完整 allocation。完整读取
拒绝测试中的 reference/bytes 损坏及相关外来身份。七种 execution state 读取案例
使用明确恢复的 SQL state fixture，不是生产 state transition。

退休组先展示真实未 claim operation 的拒绝，再 claim 专属原 operation，并成功
将原 binding/reservation seal 到 DRAINING，之后 fresh prepare 才以
`runtime_admission_closed` 拒绝，无 allocation 或进一步表变化。这验证串行软件
准入 fence，不证明并发 MySQL 竞争、物理终止、DRAINED、NodeUnpublish 或 RELEASED。
三项 fresh 派生 input/attempt/assistant 请求通过 Node 结构解析后被 native admission
拒绝，但还有额外语义差异；input 保留了旧 wake subject/source-event 关联。没有成对
有效 nonpending control，不能单独证明 pending-only fence。Start probe 的
`runtime_payload_invalid` 是 parser 拒绝，不是 grant 资格。没有可用的有效 final
settlement suffix，也没有伪造该后缀。

首次真实验证暴露了 Base64 资源内容误用 512 字符结构 ID 校验的问题。改用资源专属
decoder 后完成后续各组。首次失败及测试工具 startup/envelope/retirement 设置失败
均与最终报告一起保留，不将失败悄然重标为成功。实际 Java load origins 分别验证
207 个 production classes、四个编译 test fixtures 及 22 个 nested SDK classes。
529 个唯一 Node origins 中，112 个在至少一个窗口没有 prelaunch anchor，只有
load-time/final 字节保障，不能追认其 prelaunch proof。

保留的最终报告 SHA-256 为
`7b5a3c848914f70544ee8fe95a1138ccd751ed11a95978980967fc67e619332e`，
其 965-artifact manifest SHA-256 为
`a6882e64581fa57d1c0b69fe144db1fa6f7352c7530b7207cbb01b38db301f6e`。
独立平台文字勘误将保留的环境纠正为 Darwin 25.6.0/arm64、Node 22/Java 21，不改
两项原始 artifact。专属 processes、ports、temporary roots 与 H2 resources 已清理；
input/artifact freeze 于 `2026-10-08T16:33:17.551568Z` 释放。证据留在 git-ignored
`.qwen/e2e-tests/` 工作 artifact 与 PR 报告，不验证后续原 intent/prepared、worker
grant/execution、consumption、RC/RR 竞争、Linux CSI 或完整 K2 验收。

## 7. 剩余决策与资格

本实现已选择上述持久 allocation 与精确 wire；不计划第二 batch ledger 或通用
resource-publish endpoint。内部私有 caller 已接入仅预约的 native tool callback；
原 function-call 资格、原子 resources/allocation 和完整 current read 已有上述
有界本地观测。实际私有 caller 已展示原完整 Parts、非 UUID function IDs、完整
supplied declarations 及 assistant/function/part 映射。精确 pending-only negative
隔离与后续 continuation 资格仍开放。Native intent、preparation、execution 与结果消费
仍关闭。
首次准入和历史 fold 必须用同一
grammar，并跨 activation renewal 保留上下文；kind allowlist 或只查 latest assistant
不能替代该验证。每个新增字段都须有真实生产和消费方。

Worker grant 仍需独立封闭的不可变 bootstrap trust、当前原 SQL/native readback、
local preparation barrier 与 seal race 语义。不能依赖 global Harness bearer、caller
URL、签名陈旧 snapshot 或单独 receipt。生产和消费接线并验证前不开放 worker
preparation/execution route。全部 writer/lifecycle、不可变 cut、聚合 DRAINED、
可信物理终止、NodeUnpublish、原子 RELEASED、安全复用和全新完整目标集群矩阵，
仍为完整 K2 设计的必需项。
