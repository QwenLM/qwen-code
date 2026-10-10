# CSI 退休的持久化原 worker ACK 证据

[English](2026-10-03-csi-original-worker-ack.md) | [简体中文](2026-10-03-csi-original-worker-ack.zh-CN.md)

状态：2026-10-03，ACK1_IMPLEMENTED_AND_LOCALLY_VERIFIED，CLOSED_LOCAL。
Root 已完成连续两次干净自审；独立限定范围源码审查未发现确认的问题。
这是本地组件收口，不是正式 SDK 批准。可信 CSI 放置和 ACK-2 持久化现已实现，正在
[后续设计](2026-10-03-csi-durable-worker-ack.zh-CN.md)中验证资格。下面的历史 ACK-1
证据不验证这一增量。这是 [K2c](2026-10-01-managed-kubernetes-k2.zh-CN.md)
中继[收据/checkpoint 检查](2026-10-02-csi-receipt-checkpoint-evidence.zh-CN.md)之后的单条
publication 证据组件。这里 ACK 指 worker 对结果收据的确认，不是阿里云 Kubernetes
产品名。ACK-1 baseline 中的私有 CSI 创建门禁仅由后续可信 adapter 处理；公共 Hosted
CSI selection 仍然停用。

## 问题与当前行为

`ManagedToolExecutor.acknowledgeV3` 验证原 settled entry，并把精确收据记录在内存中。
entry 缺失返回 `unknown`；重启不会重建原 generation 的 journal。
`RuntimeBrokerService` 读取实际 publication receipt 并发送给原 lease，但不会在 RPC
后安装持久确认。Hosted caller 会检查返回的 `settled` 状态；仅 HTTP 外层的
`acknowledged: true` 不足以证明确认成功。

现有 CSI drain route 属于 boot-v3 worker 的原 Express app 和 executor。它封闭新入口并
返回保守观察。SQL retirement journal 独立保留原 binding、lease/handle 和 reservation，
holder 持续 DRAINING。已提交的 Session receipt 或 checkpoint 覆盖均不能证明原 worker
已经收到该收据。

Boot-v3 不包含 Java `runtimeBindingId` 或 `runtimeGeneration` 字段。原 capture entry
已有 `bindingGeneration`。新响应必须只描述 worker 实际知道的事实；其余 publication 与
binding 关系由 Java 从权威记录建立。

## 范围与不变量

最终目标是一条原 publication 的持久 committed receipt 确认。先交付专用 boot-v3 确认
和精确 Java protocol/transport；只追加的持久化属于后续 gated ACK-2 阶段。
不扩展闭合的通用 Tool v3 或 boot-v2 schema，不创建全局 retirement 状态机，不开放公共
CSI selector，也不新增面向用户的 `covered`、`verified`、expected-Pod 或 raw-proof 选项。

缺少确认、RPC 失败、entry 缺失、provenance 未解决或最终权威检查冲突时，retirement、
binding 和 holder 保持 DRAINING，active slot 仍属于原 binding。成功持久化后也保留该状态与
所有权。本组件不能声明
DRAINED、清除生命周期 blockers、释放存储或删除 Kubernetes 对象。一条 row 不能证明全部
execution、Session 或 publication 已覆盖。

合法 receipt ACK 会将 capture delivery 从 pending 改为 committed，并清除
`capture_uncommitted`，这是预期行为。它只确立原 receipt-acknowledgement 事实。
Shell、publication 和 MCP 生命周期 blockers 及 unknown 历史继续保留；ACK-1 仍不新增
持久 SQL evidence。

Checkpoint 覆盖仍是独立的 native authority 观察。Worker 不解析或认证 checkpoint；本 row
不包含 checkpoint 成功标志，也不能让过期的覆盖证据符合后续释放条件。

## 交付阶段

**ACK-1：当前先实现 worker 确认与 Java transport。** 实现有界 boot-v3 route、同步原
entry 确认、闭合 Java protocol、HTTP transport 和 original-runtime wrapper。使用真实
executor 验证实际 Java-to-native HTTP。该协议/worker 功能不依赖新增数据库表、
coordinator、command 或所谓 durable evidence。现有 retirement 所有权和 CSI provision
门禁保持不变。

**ACK-2：先解决可信原 provenance，再实现持久证据。** 首先建立并审查 coordinator 如何
获取可信、已持久化的原 Pod identity。[ACK-2 后续设计](2026-10-03-csi-durable-worker-ack.zh-CN.md)现已实施下述 private authority plan、两阶段 RPC/最终事务、append-only migration 和实际单 publication caller；这些部分在历史 ACK-1 基线中为 NOT_IMPLEMENTED。不能加入不可达 public method、仅返回 unsupported 的 command/table
占位，或把 package-private fake-authority 正向结果称为生产持久化。D1–D6 是 ACK-2 验收组，与 ACK-1 结果分开；当前证据与剩余资格限制见后续设计。

## 闭合 wire 契约

ACK-1 已实现 `POST /internal/managed-runtime/csi/v1/acknowledge`，仅在 boot-v3 worker 注册，并
加入其 owned-route 清单。所有权是原 persisted-workspace worker，使用该 boot 的 token、
lease ID 和 epoch 认证；不存在 primary runtime 或 replacement worker 回退。

请求和响应均包含以下必填键，没有可选键：

| 键                | 值与权威来源                                                          |
| ----------------- | --------------------------------------------------------------------- |
| `protocolVersion` | `1`                                                                   |
| `managedCsi`      | `"managed-csi/1"`                                                     |
| `workerAck`       | `"managed-csi-original-worker-ack/1"`，与 drain/status 区分           |
| `retirementId`    | 规范小写 UUID，必须等于 executor 已有 seal                            |
| `context`         | 下述无凭证原 managed-context attestation tuple                        |
| `storage`         | 下述原 boot-v3 CSI tuple                                              |
| `pod`             | 仅 `uid`、`namespace`、`nodeName`，来自实际启动身份                   |
| `reference`       | 仅 `sessionId`、`promptId`、`callId`、`argsDigest`                    |
| `acknowledgement` | 仅 `executionCallId`、`manifest`、`deliveryStatus`、`historyRevision` |

响应另须包含 `state: "ACKNOWLEDGED"` 和 `captureIdentity`；请求禁止这两项。
`captureIdentity` 精确使用现有 `ToolResultExpectedIdentity` 的键：`tenantId`、
`sessionId`、`turnId`、`executionCallId`、`callId`、`invocationDigest`、
`bindingGeneration`、`captureId`、`revision`。它来自原 entry 的 capture sink identity，
不能回显请求。第一片 capture 契约要求 `revision: 1`。

`context` 仅包含 `protocolVersion: 3`、`managedContext: "managed-context/1"`、
`runtimeInstanceId`、`runtimeIncarnation`、`leaseId`、`epoch`、`provisionRequestId`、
`tenantId`、`workspaceId`、`workspaceGeneration`、`storageId`、`mountRoot`、
`capabilityDigest`、`isolationClass`。复用现有 context 校验器并要求 workspace isolation；
不输出 `token` 或 endpoint。

`storage` 仅包含 `clusterDomain`、`namespace`、`pvcUid`、`pvUid`、`driver`、
`volumeHandle`、`backendDomain`、`diskSerial`、`physicalKey`、
`registrationRevision`、`reservationId`、`reservationRevision`。复用 CSI 校验器，包括
`driver: "diskplugin.csi.alibabacloud.com"` 和 physical-key 推导。
`reservationRevision` 是原 boot 的 RESERVED revision，不是后续 SQL DRAINING revision；
Java 分别与各自权威记录核对。

本片仅接受 `deliveryStatus: "committed"`、完整原 capture 和非空原 manifest。Manifest
使用现有闭合 durable reference（`resourceId`、`kind`、`schemaVersion`、`byteLength`、
`digest`），要求 `kind: "managed-tool-result-manifest"`、schema version 1、长度 1–65536 字节。
`historyRevision` 是正 safe-integer receipt 事件序号，不是 SQL journal revision；持久
证据分别保存两者。

保持现有字段校验：Java long generation/revision 使用规范十进制字符串，epoch 和 receipt
sequence 使用 safe integer，stable ID 保持 UTF-8/NFC 限制，digest 语法严格，Pod 保持原
UID/namespace/node-name 规则。不能把畸形输入规范化后视为匹配。请求和响应各限制为
16 KiB；超限 tuple 返回未解决，不能截断。复用有界 JSON 处理与闭合语义校验。Java 必须拒绝
非法 UTF-8、重复键和尾随 token；可用已有 Jackson 依赖实现该专用严格 reader，而不改变旧
context/V3 parser。错误响应不能成为正向 ACK。

本专用 wire 契约中的每个 numeric field 都必须使用匹配 `[1-9][0-9]*` 的规范正 JSON
integer token，并满足原 safe-integer 与字段范围限制。包括外层 `protocolVersion`、context
的 `protocolVersion` 和 `epoch`、manifest 的 `schemaVersion` 和 `byteLength`、receipt
的 `historyRevision`，以及响应 capture 的 `revision`。拒绝小数和指数 token，即使数学值
为整数：`1.0`、`1e0` 以及 `5.0000000000000001` 均非法。仅检查已舍入的 JavaScript
number 无法执行此规则。十进制字符串 generation/revision 字段仍按原规范保持 string。

仅 ACK route 新增 Express `verify` callback：使用 fatal UTF-8 解码、现有 native
duplicate-key checker，以及 Node 22 `JSON.parse` reviver 的 `context.source` 检查
integer-token 表达式和 safe-integer 范围。Java 专用严格 reader 先扫描 integer token，
再执行闭合校验。Java 还必须在 `post` 前用该 reader 预检自身 encoded request；Map 值若
被序列化为非规范 numeric token，必须产生零 HTTP 请求。不改变通用 V3/context JSON parser。

## Worker 确认

围绕现有 ACK 检查新增一个 CSI 专用同步 executor 操作。变更前要求同一已安装 retirement
seal；本 route 不隐式 seal 或更换 retirement ID。必须存在原 V3 entry、精确 reference、
settled result、完整 capture、实际 capture identity 和匹配的 committed receipt。
`not_started` result 不能合格。

CSI 操作按精确字段值比较闭合 receipt 和 manifest，仅忽略 JSON 属性顺序。现有通用
`acknowledgeV3` 使用 `JSON.stringify`，该行为保持不变。如果 acknowledgement 已存在，
要求它与请求及实际 capture 满足闭合语义相等，并要求实际 captured delivery status 已是
committed。这包括 native publisher 的 `accept` 路径直接保存的 acknowledgement，其
manifest 属性顺序可能不同。完整 prospective-response 限长检查后，只读返回确认，不调用
generic setter，也不改写任何 entry 字段。已有 ACK 而实际 capture 未 committed 时返回
409 冲突。仅首次 ACK 使用实际 entry 的 manifest 字段顺序构造已验证 receipt，再调用
generic setter。不能只为通过字符串比较而改写 entry 的 manifest、acknowledgement 或 result。

调用 ACK setter 前，必须从已验证原事实构造完整 prospective 正向响应，序列化并检查其
UTF-8 字节长度不超过 16 KiB。响应包含额外 capture identity，仅限制请求大小不够。
序列化或响应超限失败必须保持 acknowledgement 和 result 都不变。首次 ACK 只有在此后才
调用 `acknowledgeV3`，要求其返回 settled 且存储 receipt 匹配。已有合格 ACK 不执行任何
变更。两条路径均输出同一份已验证响应字节。字节检查后不能追加字段或重新读取可变 entry 数据。

以上步骤在同一同步操作内完成。不 await resolver 或 publisher，不 prepare capture、
install grant、创建 entry 或启动工具。

此前 ACK 成功或响应丢失后，可以再次确认同一 receipt。不同 receipt/reference/retirement
冲突。缺失、重启、unknown、不完整或 blocked 状态均不返回正向确认。畸形请求返回 400；
原身份/状态冲突返回 409；认证及 body-limit 失败保留现有 401/413 行为。每个正向响应都具有
`Cache-Control: no-store` 和 JSON content type。

ACK 不要求聚合状态先到 `QUIESCENT`。Shell、publication、provider 和 MCP 生命周期 blockers
本就会在结果 settled 和 receipt ACK 后保留；等待它们消失会让本步骤依赖其他后续证明。
ACK 不能删除这些生命周期 blockers，也不能通过 generic close 重置它们。现有 status、cancel、
history controls 和 MCP release 保留原 admission 规则；普通 LOCAL close 和通用 V3 ACK
保持兼容。

## Java protocol 与 transport（ACK-1）

在任何 SQL 事务之外，`RuntimeTransport` 仅向原 lease 发送专用请求。默认实现拒绝并返回
unsupported；HTTP 强制 `Redirect.NEVER`、原认证 headers、16 KiB response limit、严格
解码和包含响应体读取的单次总 deadline。`WorkspaceRuntimeTransport` 必须显式通过原
runtime guard 转发。不引入 acquire/renew/replacement 或新任务 admission。通用 V3
`settled`、`unknown`、外层 `acknowledged` 或 drain response 不能通过专用协议校验器。

专用严格 reader 将 `packages/sdk-java/runtime-broker/pom.xml` 中已有
`jackson-databind` 2.20.0 依赖从 test scope 改为 production scope，仅删除一行 scope。
保持现有版本 pin 和全局 legacy parser 不变。分别验证独立 Broker 实际解析出的 2.20.0
classpath 和 managed application 实际解析出的 2.21.4 classpath；一方通过不能证明另一方。
每次验证记录实际加载的 Jackson 版本与 code-source 路径。

现有三参数 `context` guard 假设 Session isolation，要求 request isolation key 等于
Harness Session ID。原样使用会拒绝 isolation key 为 null 的 workspace-isolated CSI
request。新增一个仅 dedicated ACK 使用的私有 `originalCsi` 分支：原三参数调用以
`originalCsi=false` 委托，保留原 guard；仅 ACK 请求新分支。该分支要求 workspace isolation
且 isolation key 为 null、kind 为 `kubernetes-workspace`、parent 为 DRAINING 且设置
`drainRequested`、原 Runtime Session 为 READY，并匹配原 request、seed、lease、context、
capture 和 Session pin。任何不匹配都在 delegate 前拒绝。它不授权新任务、不改变 generic
recovery admission，也不获取 ownership。审查每个 `context` caller，确保旧 control、status、
cancel、generic ACK 和 release 均未获得新分支。

协议接收精确比较所需的显式 original boot/storage/Pod expectation。Native HTTP fixture
可以提供 synthetic boot/Pod identity，但这仅验证协议边界。ACK-1 不从权威生产 CSI
placement 解析该 expectation，也不暴露新的 durable retirement command。后续 coordinator
必须提供合格身份，不能把响应中的 Pod tuple 当成自身的 expected 值。

## Java 权威边界与两阶段持久化（ACK-2）

本节 authority/persistence 内容不属于 ACK-1 范围，现已由链接的 ACK-2 后续设计实现。私有单 publication coordinator 的 store 操作保留在内部，并要求可信 provenance。命令仅接收
原 retirement 和 Session/publication selectors；从可信记录加载 registration、binding、
原 lease、receipt 和 expected worker identity。命令输入不接受 endpoint、token、Pod tuple、
response JSON 或 success boolean。

Coordinator 先在自己的数据库连接上准备不可变 authority plan。拒绝 ambient transaction
以及自定义/不同 DataSource repository。验证原 DRAINING retirement/holder、registration、
active slot、不可变 seed/handle/lease digest 和 attestation generation。原 execution 必须
SETTLED 且是 deferred-v3，实际持久化 authorization pair 必须早于 sealed binding version；
完整匹配 Session、turn、reference、request digest 和 publication scope。

复用现有 original-publication authorities，取得完整 Broker result、terminal/finish
operation、REFERENCED admission outcome/manifest 和精确 committed `tool.receipt`。
保持完整结果的数字语义和全部非数字字段。在最终事务之外使用现有资源权威检查资源字节。
普通 receipt verification 可能更新 verification/quarantine 状态，不能把它称为只读 snapshot
工作。联网前结束并释放全部数据库事务/锁。

Expected Pod tuple 必须来自可信、已持久化的原 CSI placement/attestation provenance。
历史 ACK-1 的 `WorkspaceCsiRuntimeProvisioner` 无法提供该 provenance；ACK-2 后续增量加入可信原身份，但不开放聚合 retirement。创建前的 null handle、
K1 scratch handle 或 worker 自报 Pod UID 均不合格。实际 ACK command 和 evidence insert 路径要求该持久化边界及其审查。组件 fixture 不能开放生产 admission，也不得
用可选 proof provider 或 caller approval flag 绕过缺口。

取得精确正向响应后，开启新的短事务，在同一 native JDBC connection 上按既有顺序重新加锁：

1. Placement domain → active slot → 原 binding。
2. Registration alias → physical reservation/holder → retirement journal。
3. 原 execution → tenant guard → 原 Session head → publication。
4. 原 receipt/journal、finish-operation、resource-object locks，沿 publication authority
   已有顺序取得。
5. 最后锁定单条 ACK evidence key，执行幂等插入/回读。

复用 `WorkspaceCsiReservationStore.lockPublication` 和完整 original SETTLED publication
guard；不引入 ACK-first 或 publication-first 锁序。锁等待后用于决策的所有可变 row 均使用
current locking read，包括 quarantine、referenced receipt/admission 和 finish/object
状态。按这些当前 row 重新验证 plan 的精确 pin 和响应。原 writer/activation 所有权和期限
检查保持现有 settlement 规则，并在等待之后执行；不为通过过期 plan 而获取新 owner。
无关的新 head revision 不必等于准备时的 head，但原 receipt 和原所有权必须仍有效。

最终事务不执行 worker RPC 或外部资源 I/O。任何晚到变化、过期、quarantine、原身份丢失或
插入失败均回滚，不留下 ACK evidence。RPC 成功而 commit 失败时，对同一原 worker 和
receipt 重试。Worker 内存可能已经确认，但 Java 不能因此跳过最终权威检查。

## Migration 与不可变幂等（ACK-2）

ACK-1 未创建 ACK table 或 schema 占位。ACK-2 在 10 月 5 日主线整合后的 V44
加入 `workspace_csi_worker_ack`（10 月 4 日整合时为 V43）；合入前仍须确认下一个未占用编号。
不重写 retirement migration（此次为 V42，10 月 4 日整合时为 V41，旧快照为 V29）的
retirement identity、其他已应用 migration 或历史 row。新增一张
`managed_workspace_csi_worker_ack` 表：

| 列                         | 含义                                         |
| -------------------------- | -------------------------------------------- |
| `retirement_id`            | 规范 UUID，联合主键第一项                    |
| `execution_call_id_hash`   | 精确合法 UTF-8 ID 的 SHA-256，联合主键第二项 |
| `execution_call_id`        | 原 ID，每次按 hash-key 查询后精确比较        |
| `evidence_json`            | 有界、闭合、不可变证据文档                   |
| `evidence_digest`          | 已存文档精确 UTF-8 字节的 SHA-256            |
| `recorded_at_epoch_micros` | 数据库观察时间，以整数 epoch 微秒表示        |

沿用现有 binary collation 约定，并在查询后拒绝 collation alias。不需要 phase、可变 ACK
boolean、重试计数、replacement identity 或二级查询索引。使用现有数据库 epoch 计算；
不能把 session-local `CURRENT_TIMESTAMP` 经不匹配的 JDBC 时区转换。记录时间是观察
时间，不是 worker stop 或 receipt 时间。

证据文档仅含 `schemaVersion: 1`、`original`、`confirmation`。`confirmation` 是已验证的
正向 wire response。`original` 仅含 `retirementIdentityDigest`、`bindingId`、
`bindingGeneration`、`sessionKey`、`publicationId`、`publicationBindingDigest`、
`authorizedDispatchGeneration`、`authorizedBindingVersion`、`finishOperationId`、
`terminalRef`、`outcomeRef`、`receiptJournalRevision`、`receiptSequence`。
`sessionKey` 仅含 `tenantId`、`workspaceId`、`sessionId`；resource refs 保持现有五字段。
Retirement digest 绑定已存不可变 retirement 的精确字节，包括原 handle/lease pin。
文档中的 SQL 整数身份值采用规范十进制字符串，并按权威取值范围验证；receipt sequence 还须
精确等于 wire 的 safe-integer 值。证据限制为 32 KiB；超限拒绝，不能删减字段。不复制凭证。

仅 coordinator 能到达已验证 insert 路径；不提供公开 `recordAck(true)` 或由调用者构造
proof 的提交 API。首次成功后 insert，并严格解码/回读完整 row。同 key 且已验证的
original/confirmation 语义完全一致时返回首条 row，不修改字节或时间。同 key 下不同 tuple
必须冲突。除了 digest 和索引 ID，还要解析并比较完整闭合文档；匹配 hash 或 JSON 重排本身
不是权威。损坏 JSON、未知 schema、非法 Unicode、字段不全和原始 ID alias 均拒绝。

进程/连接重启后可以读取已存 row 作为历史 ACK 事实，无需联系 worker，但不能冒称当前存活。
未保存 row 的重试需要新的有效 RPC。已保存 row 不能绕过后续聚合 consumer 对原身份、
checkpoint 和物理状态的重新检查。不能从历史 REFERENCED publication 回填 ACK row。

## 影响文件与交付边界

| 层次                               | 计划文件与消费者                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACK-1 worker 协议                  | `packages/cli/src/serve/managed-csi-envelope.ts`、`managed-csi-worker.ts`、`managed-runtime-tool-executor.ts`、`managed-runtime-attestation-worker.ts`，及其 focused collocated tests                   |
| ACK-1 Java transport               | Runtime-broker 的 `ManagedCsiProtocol.java`、`RuntimeTransport.java`、`HttpRuntimeTransport.java` 与 focused protocol/transport tests；managed-agent-server 的 `service/WorkspaceRuntimeTransport.java` |
| ACK-1 strict-reader 依赖           | `packages/sdk-java/runtime-broker/pom.xml`：已有 `jackson-databind` 依赖从 test scope 改为 production scope；分别验证独立 2.20.0 与 managed-application 2.21.4                                          |
| ACK-2 私有 coordinator 与 evidence | 新增 managed-agent-server `store/WorkspaceCsiWorkerAckStore.java`、`store/WorkspaceCsiWorkerAckMain.java`；仅按需在现有 CSI reservation/publication stores 加入 package-private authority 连接点        |
| ACK-2 持久化                       | 一条新 migration 及其实际 schema/migration test 入口；新增 `WorkspaceCsiWorkerAckStoreTest.java`                                                                                                        |
| ACK-1 共享契约                     | 在现有 CSI fixtures 旁新增有界 ACK fixture，由 Java/TypeScript 独立消费；不改通用 Tool v3 schema                                                                                                        |

ACK-1 行描述本历史增量；ACK-2 位置已由链接的后续设计实现，使用实际 authority 和证据校验，不是占位文件。
ACK-2 中除非存在实际第二消费者，否则 coordinator/store 保持在一起，不另抽象。审查全部新增读点、owned-route registry 和 transport wrappers。
不需要 checkpoint parser、额外 publisher proof interface 或公共 service route。

## 验证与验收

测试计划（本地验证制品，不提交）分别列出 global CLI
baseline、native worker HTTP、Java protocol、独占 H2/MySQL 持久化和后续生产资格验证。
通过生产 API 建立原 execution、capture、publication 和 receipt；验收正向链不能用 SQL
铸造 ACK 或用预制成功响应替代。仅使用 transport mock 的测试必须明确较窄证据范围。

ACK-1 要求真实 Java HTTP client 和 native worker executor，包括缺失/unknown/blocked/
not-started entry、tuple 变化、错误 seal、畸形/超限/deadline 失败、wrapper 和兼容性。
Synthetic boot/Pod 输入明确只是本地协议 fixture，不是可信生产 provenance。ACK-1 不实现
或测试 SQL ACK insert；独立检查现有 provisioner gate 和 durable schema 未改变。

实施阶段的 native 复现发送原始 receipt sequence `5.0000000000000001`，该值被舍入为 5，
错误返回 HTTP 200 ACKNOWLEDGED，并将 entry capture 从 pending 改为 committed。保留
复现属于失败证据，不是修复后验证。测试计划要求两种语言拒绝非法原始 token、不变更 ACK，
Java 对非法 encoded request 发出零 HTTP 请求；还需实际 native auto-accept 的 manifest
重排重试，以及单独标注的 existing-ACK 未 committed 负向场景。下述冻结后的本地 post
证据验证了两项已复现的 numeric/property-order 修复；原始失败记录保持不变。

验收还要求实际 workspace/null-isolation-key wrapper 正向链，拒绝错误 kind/state/session/
request/seed/lease/context/capture pin，并保证每个旧三参数 context consumer 行为不变。
检查两套实际解析出的 Jackson classpath，分别执行严格协议正向和负向测试，包括 fractional
numeric identity、重复键、非法 UTF-8/Unicode、尾随 token 和字节上限。POM scope 变更或
仅 test classpath 通过本身都不能证明生产资格。

ACK-2 D1–D6 验收要求可信 provenance；当前结果见链接的后续设计。须证明晚到过期/quarantine 和 authority
冲突插入零 row，并验证精确重试、独立进程回读、并发插入及实际 ACK 后 rollback。MySQL
测试必须观察真实锁等待及 repeatable read 下的 current row；仅 H2 不足以验证该行为。
检查 UTC/非 UTC 时间边界。不能用 package-private fake authority 替代实际 coordinator
正向链。各阶段独立保留原始断言、source/class/dependency hash、实际退出码和独占资源清理
证据。

Focused tests、build/typecheck/bundle 和适用 lint/checkstyle 的本地结果如下。本组件已完成
连续两次干净 root 自审及独立精确范围源码 review。不声明正式批准、CSI 创建、真实 Linux mount、
云上执行或物理 release 合格。

2026-10-03 记录的 ACK-1 验证：

| 证据                                                             | 本地结果                                                                                                                          | 范围                                                                                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Root 构建和 focused 检查                                         | Build/typecheck/bundle/ESLint/Prettier 均 exit 0；CLI 377 tests、Broker 74 tests、managed server 28 tests；Java Checkstyle exit 0 | 冻结组件检查，与独立执行计数分开                                                                                                                 |
| Java → built native，Jackson 2.20.0                              | 三条链通过：17 + 17 + 18 = 52 group executions                                                                                    | Dedicated-first、ordinary-ACK-first、native autoaccept manifest 重排；raw SHA `c605bf34d73408a7a9b845a0dbcf7b849e81579302d6b8d72cf5082732c88428` |
| Java → built native，使用 Jackson 2.21.4 的 managed dependencies | 同样三条链通过：17 + 17 + 18 = 52 group executions                                                                                | 已检查实际 loaded version/CodeSource；raw SHA `366245d7abcf68cf8633a81bf67c5726c3a5db786c4876cab93f528c31a481df`                                 |
| 完整性与清理                                                     | 每轮全部 15,978 frozen inputs 未变化；root 复查 60 个独占 PID 不存在、18 个端口关闭                                               | 独占临时目录已删除；root readback 不算新增产品执行                                                                                               |
| 自审 / code review                                               | 两次干净 root 自审；独立限定范围审查未发现确认的问题                                                                              | 仅 ACK-1 组件；不声明正式 SDK 批准、full K2 或 ACK-2 验收                                                                                        |

独立 post 报告（本地验证制品，不提交）链接两份 raw 结果，
并列出已执行拒绝项及更广计划中未执行的项目。两套 classpath 合计 104 次 group execution，
不是 104 个 unique scenario。实际 Java 请求到达原 native executor；已检查原 capture
identity 和两项因果修复。existing-ACK 未 committed 控制明确是手工 counterfactual，
不能称为自然状态转移。Root readback（本地验证制品，不提交）
的 SHA 为 `b3a97ea3e7dceab15e04f456efceaf15ea37e9e1fc98175e86eac0bca5edf4ea`。

Post 使用 synthetic boot/Pod identity 和本地 native capture，不能证明可信 CSI provenance
或 container/Linux startup，也未打开数据库。Provisioner/migration 检查仅为源码观察。
Wrapper、全字段 numeric/Unicode、response-overflow 和网络生命周期矩阵须保持各自 focused
test/review 范围，不合并进独立 post 计数。Holder DRAINING 以及全部 ACK-2/MCP/
stop-unpublish/physical-release 限制保持不变。

本地收口记录见 root 自审（本地验证制品，不提交）和独立限定范围 review（本地验证制品，不提交）。Review 固定的是收口前 design/plan 字节；后续仅更新状态及链接，没有 source 或 test 变化。其结论只覆盖本 ACK-1 增量，不覆盖累积 worktree。

## 后续限制与未解决前置条件

可信、已持久化的原 CSI Pod/worker provenance 与 durable coordinator 现已实现，
正在[后续设计](2026-10-03-csi-durable-worker-ack.zh-CN.md)中验证资格，其证据与 ACK-1
分开记录。不接受用户提供的 proof 配置。

后续还须枚举全部原 inventory、重新检查 receipt/checkpoint 覆盖，并验证完整 MCP
configuration/operation/release 历史。最新 `released` 或 resolved close promise 不能
抹掉 unknown 历史，也不能替代 strict MCP drain。认证 worker ACK 和本地 QUIESCENT
不能证明原 Pod/container/后代终止，也不能证明有序、可信的 CSI NodeUnpublish。CSI log
reader 仍仅提供资格验证输入。只有后续经审查的 consumer 才能合并全部合格证据并原子释放
精确原 holder。本片不执行上述任何转移。
