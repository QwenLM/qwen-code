# K2：连接原生历史、worker 准入与文件执行

[English](2026-10-09-k2-native-history-integration.md) | [简体中文](2026-10-09-k2-native-history-integration.zh-CN.md)

状态：实现进行中，2026-10-09。Preparation 增量的父提交：
`b0d9888b444dcb15497abd83ec15182b65c2fae8`，Draft PR #13526。
前一增量已实现派生的原始 assistant 批次保留，以及先校验全部相关行再分组当前批次。
boot-5/handle-3 authority 传播依赖已通过有界软件验证。当前候选实现连接了
lease 认证的 bind/prepare 读回、原生 schema-2 initial/intent/prepared 接受、
原始资源的精确提升与关联、retained worker preparation 以及私有 Hosted 调用者。
独立有界软件运行先观察到实际 preparation，随后观察到完整 Read 正向链路，包括两份
原始 SETTLED/success 结果、第二次真实模型调用、消费和 Turn 落定。新的 Read/Write/Edit
混合运行还观察到真实文件效果、原始 preimage 保留、结果历史收口、第二次模型消费和
Turn 落定。精确派发重放没有重复 I/O，改变 payload 被拒绝。剩余失败测试组、平台、冷恢复、物理退休、公开
选择及完整 K2 验收继续开放；软件 fixture 证据不能解除这些门禁。
本设计细化
[原生文件执行设计](2026-10-07-k2-native-file-execution.zh-CN.md)与
[原始批次预留设计](2026-10-08-k2-native-batch-reservation.zh-CN.md)
中剩余的整体接线。完整 K2 目标、proposal #12380 和 tracker #13395 继续开放。

## 1. 当前缺口与要求的结果

已提交基线的私有 Hosted 调用者在完整原始 assistant 和已接受 Read/Write/Edit
分配之后停止。前一 preparation 增量在 input 前增加 initial history，并连接完整 intent 与原始
资源提升、worker preparation、持久 prepared 历史，然后以需要恢复的状态停止。
原生新提交与历史回放共享 history validator；same-Connection preflight 在
`commitResources` 前校验完整转换，最终接受校验原始关联。boot 5 增加 retained
composer/history 路由；boot 4 仍只用于构造。当前候选连接 native intent、execution
grant、worker 执行器及结果消费调用者。已观察 Read 与 Read/Write/Edit 混合正向链路；
剩余拒绝组、冷恢复与退休消费者仍未完成。

连接一条原始链路：READY Session 与已安装上下文 → 保留的空历史绑定 → 包含全部
已接受成员的原生 schema-2 intent → worker 读取当前原始证据并准备保留备份 →
原生 prepared → 原始 tool intent 与 dispatch checkpoint → 不可变 grant →
实际文件工具 → 完整 outcome 与 tool-result message → results-ready checkpoint →
实际 Hosted 消费与完成历史。分配、prepared 历史与 SQL SETTLED 是不同事实，
任何一个都不能单独完成 turn 或 K2。

## 2. 启动信任与私有读回

Boot 4 及其 version-2 原始资源 handle 继续只允许构造。不得在调用中增加可选
authority URL，也不得把旧 boot 重新解释为文件准入。引入执行 boot 5，字段严格为
`type`、`version`、`managedCsi`、`identity`、`context`、`storage`、`authority`；
保持 `managed-csi/2`、原始三字段 profile 身份、内层 boot 2 与已登记存储。
`authority` 仅含 `protocolVersion: 1` 和 `origin`。origin 是部署配置的规范 HTTPS
origin；HTTP 仅用于自有 loopback 验证。禁止 URL 凭据、路径、query、fragment 和
重定向。不得向 worker 传入调用方选择的 origin 或全局 Harness token。
规范 origin 必须与 URL origin 序列化完全相等：小写 scheme 与由字母/数字/连字符
label 组成的 ASCII DNS host、规范十进制 IPv4 或压缩的小写 IPv6（多 label DNS 的末
label 须以字母开头），不允许 DNS 尾点、默认端口、前导零端口或端口零；显式端口
范围为 1–65535。此私有 bootstrap 契约不支持 IDNA `xn--` label，因为 Java URI 与
Node URL 的 IDNA 校验规则不同。origin 最长 2048 字符。共享 Java/CLI fixture 验证相同的接受与拒绝
拼写。对于 HTTP，私有 `serve` 还在启动 listener 前要求其等于自有 listener 实际绑定
的确切 URI，不能将任意 loopback 验证服务器作为 authority。

Version-3 私有原始资源 handle 保留确切 authority 元组。provisioning producer
将其纳入规范 boot 字节、不可变 Secret、boot digest 与 handle identity。所有保存
handle、实时 API、attestation、transport 和重启比较，都从原始 seed 与保留的
authority 元组推导同一 boot。配置 origin 变化不能重写或接管旧 Secret。旧 handle
没有 authority 锚点，拒绝新的文件准入。这实现此前执行 bootstrap 的 authority
传播依赖，
不改变现有 boot-4 构造契约。
Informational ready 使用 version 5，字段严格为 `type`、`version`、`managedCsi`、
`identity`、`context`，不返回凭据，也不建立 authority origin。现有 CSI-v2 context/
attestation/drain envelope 与新读回、执行契约保持区分。现有 attestation 响应不
返回或独立证明 authority origin；精确的不可变 Secret、原 handle 与 boot-digest
比较固定该 bootstrap 字段。仍然需要当前原生读回及其按 action 执行的准入。

使用独立 `POST /internal/runtime-broker/csi/v1/native:read` handler。凭据是原始
每 Runtime lease token，对照加密持久化 seed 与当前原始 lease，以恒定时间比较
认证。该凭据仅认证此私有读回 handler，不能通过通用全局 Bearer handler，也不能
授权 Store 写入。handler 不得反向调用请求它的 worker，不得跨 HTTP 保持 SQL 锁，
以避免读回时出现 worker → Broker → 同一 worker 循环。

闭合请求包含 `protocolVersion`、`requestId`、`action`、`identity`、`context`、
`installedContext`、`subject`。`context` 重复原始非秘密 boot incarnation、lease、
epoch 与 provision 身份。安装上下文重复原始 operation、固定 Session、digest 与
binding。bind 的 `subject` 为 null；prepare 为原始 intent ref；execute 为原始
execution call ID，不提供成员集合、paths 或新 grant。action 严格为 `bind`、
`prepare`、`execute`，分别执行不同资格校验。
`context` 使用现有完整 `ManagedContextAttestationResponse` 字段：
`protocolVersion`、`managedContext`、`runtimeInstanceId`、`runtimeIncarnation`、
`leaseId`、`epoch`、`provisionRequestId`、`tenantId`、`workspaceId`、
`workspaceGeneration`、`storageId`、`mountRoot`、`capabilityDigest`、
`isolationClass`。`installedContext` 使用现有闭合 installation request：
`protocolVersion`、`managedContext`、`operationId`、`sessionId`、`contextDigest`、
`binding`，包含原 binding 的全部七个字段。operation ID 是现有从原 Runtime
Session 派生的 name UUID。Broker 从持久原始 owner 推导预期 binding，不相信请求。

读回在原始选定 Runtime 内按持久 owner 作用域执行。在原始 parent、pin、native
head 与当前 SQL 锁下，比较 boot-5 authority/handle、profile、Session、provision
seed、lease/incarnation/epoch、原始安装上下文和 READY 准入。缺失、歧义、过期、
draining、替换或移除的 authority 一律拒绝。旧签名响应、调用方 ref 或提供的 receipt
不能替代当前读取。

闭合响应字段严格为 `protocolVersion`、`requestId`、`action`、`identity`、`context`、
`installedContext`、`head`、`evidence`。`head` 严格包含 `revision`、`sequence`、
`digest`，从已验证的当前原生 head 复制。按 action 闭合 evidence 联合：

- Bind：仅含 `kind: "ready"`，不添加 grant 或物理 bind 声明。
- Prepare：严格为 `kind: "intent"`、`intentRef`、`resources`、`members`。返回资源
  包括原始已提交 intent；members 按接受的本地 ordinal 顺序包含原始十一字段
  execution reference，包括 Read，调用方不能用子集选择此列表。
- Execute：严格为 `kind: "authorization"`、`executionReference`、`preparedRef`、
  `authorizationRevision`、`authorizationSequence`、`grant`、`resources`。
  `preparedRef` 仅在完整验证的纯 Read batch 中可以为 null。新私有 grant shape
  定义如下；返回资源包含原始 input、declaration 以及需要的 prepared record。

新私有 grant 严格包含 `protocolVersion: 1`、`runtimeBindingId`、`bindingGeneration`、
`authorizedBindingVersion`、`executionCallId`、`dispatchGeneration`、
`authorizationRevision`、`authorizationSequence`、`executionReference`、`intent`、
`checkpointRef`、`preparedRef`、`identity`、`context`、`installedContext`。
generation 与 binding-version counter 使用规范的正无符号十进制字符串；原生
revision 和 sequence 使用安全正整数。execution reference 是原始十一字段
reference。`intent` 严格包含 `revision` 和 `sequence`，定位原 journal 中唯一的
原生 `tool.intent`。两者均为安全正整数，分别严格小于 `authorizationRevision`
和 `authorizationSequence`：完整 dispatch checkpoint 是更晚的 transaction。
该定位不是资源 reference，不向响应资源闭包添加资源。`checkpointRef` 是原始
完整 dispatch checkpoint，不是 worker preparation 准入。prepared 可空规则与所有重复字段必须匹配响应和
原始合格 authorization。dispatch 授权时持久保存这份确切的联合证据；现有仅含
两个 dispatch-generation/binding-version 列的 marker 不足。共享 Java/CLI codec 已实现此 wire shape；
当前候选也连接不可变 grant 持久化、原生 execute 准入和 retained worker 执行消费者，
详见第 6.5–6.7 节。通用 Tool-v3
grant 不提供该证明。

每个 resource entry 严格包含 `reference`、`bytesBase64`；reference 使用既有闭合
资源元数据。每个资源仅出现一次，所有返回资源均为该 action 必需，所有必需资源
均须出现。保留原始字节，不嵌入已解析 payload JSON。成员集合和 grant 都不能由
请求 worker 提供。route 与 worker 接线前，共享 codec fixture 必须覆盖三个确切
shape、重复/额外/缺失字段、action/kind 不一致及 prepared 可空规则。响应是事务内
证据观察，不是操作结束后仍有效的签名 bearer capability；worker 仅在保留并加入
生命周期的操作中使用它，响应到达后再次检查本地 seal。单个资源保持 64 KiB 上限，完整
响应采用明确的总字节与成员界限，超限拒绝而非截断。worker 使用证据前，将每项身份
与 boot 和已安装上下文比较。界限为 request 16 KiB、response 8 MiB、最多 4096
个成员；原生 history resource 仍限制在 64 KiB。发送端与流式接收端均在 JSON 解码
前执行字节限制。原资源以确切 Base64 字节传输，结构 counter 语法不能拒绝原始
model/tool payload 内合法的任意 JSON 数值。读回成功仅准入该已加入生命周期的操作，不能执行其他
call，也不能报告 RELEASED。

## 3. 原生历史与资源提升

保持原生文件设计现有 schema-2 根、目录身份、保留 preimage pin、projection 和
`idle → intent → prepared → idle` 语法。bind 使用实际保留 backend 的空观察；
启动与 attestation 不创建独占历史目录。bind 响应丢失后加入同一个保留 promise。
任意历史 projection 不能证明物理绑定，后续 worker 使用必须匹配其原始 backend
观察与目录身份。未绑定或孤立的 backend 证据阻断退休。

新接受与历史回放共用一个转换校验器。向现有 native prefix 增加派生 history 与
冻结批次证据，并贯穿每个 input、message、model、activation 和 settlement 转换。
当前 pending batch 推进后仍保留历史 assistant/function 身份。这些状态来自原始
journal 的派生，不另设持久 ledger。只有合格完成能退休 pending batch；续租、
另一 model attempt 或 schema-1 清理不能擦除它。

在 `commitResources` 前，same-Connection 私有 preflight 读取有界候选与当前
prefix，先锁原始 resource inventory，再锁固定 Runtime Session 和全部可能相关
execution row，校验整个目标转换。intent 对每个已接受成员（包括 Read）比较原始行
的不可变字段、完整 assistant Parts、ref、原始 input、definition、request digest、
function/part/local ordinal 与 mutation paths。随后仅将这些确切 PUBLISHED/
MYSQL_INLINE 资源提升为 REFERENCED。现有 `commitResources` 建立下一 revision
关联，最终 native acceptance 用原始关联检查同一转换。任何失败都同时回滚提升、
关联、journal 与 head；此前接受的 allocation 与 PUBLISHED 字节保留。不得用新 ID
修复已引用资源。

intent collector 包含每个 invocation 的 input/definition；prepared 再加入原始
intent ref。历史前驱仍通过各自原始 revision 校验，不在每个新事务递归复制完整链。
HTTP resource collector、recovery reader 与 checkpoint snapshot 使用同一有限
闭包规则。scope、state、metadata、字节、hash 与原始 revision 关联仍是必要条件。

## 4. 完整成员、回放与锁序

按原始 binding OR Harness owner OR Runtime Session 枚举相关行，稳定排序、每页
100 行，保持现有 4096 条拒绝上限，包含所有状态。先将每行不可变原始 batch 与派生
历史 prefix 比较，再按原始 assistant UUID 分组。SQL 仅筛当前 batch 会隐藏外来或
冲突行；将所有历史行都解释为当前 pending batch 则会阻断合法第二批。

冻结前，新的 intent 仅准入字节完全合格的 PREPARED 当前成员；冻结后，匹配重试
读取原始 receipt/ref，新成员或非同一成员拒绝。阶段感知的当前 reader 区分未关联
PUBLISHED allocation 与具有确切 native 关联的 REFERENCED 证据，不把 resource
verifier 放宽为两种 state 的白名单。intent 前的 terminal、UNKNOWN、abandoned 或
cancelled 成员不能消失以形成较小的成功 intent。

保持锁序：原始 placement/retention/slot/binding/pin parent → native head/journal
与 resource inventory → 不可变 retirement 证据 → 固定 Runtime Session → 完整
稳定 execution 顺序。新 commit 与 reservation 使用同一个 parent fence，late
insertion 无法与完整成员观察竞争。所有权威读取都在原始 Connection 上采用带锁的
current read，包括已预热的 REPEATABLE READ。独立事务或缓存准入不足；SQL 锁
不得跨 worker I/O。
在所有可能阻塞的锁之后、接受或授权之前，重新读取数据库时间并校验 writer/
activation/admission。等待 resource/execution 锁前有效的 lease，此时可能已过期。

## 5. Worker 准备、grant 与 Hosted 完成

在第一个 await 前登记私有操作。当前读回后，在 bind、preimage I/O 或 invocation
前再次检查本地 seal。按原始 intent resource ID 和 digest 去重 prepare，在 I/O 前
安装一个保留 promise。匹配重试加入，身份变化冲突；失败保留原始 backup/orphan
证据并阻断，而非再次复制。执行器接收准备文件的同一个 composer history 对象。

SQL seal 与 worker seal 是两个不同屏障。worker 开始前 seal 拒绝新 I/O；原生
prepared 接受前 seal 留下未解决原始 intent。seal 前 pending operation 继续被加入
生命周期并对 drain 可见，其观察不能成为 seal 后 dispatch grant。Cancel、timeout、
身份丢失或 not-started result 不清除原生 preparation。

每个 tool intent 将原始十一字段 SQL reference 与不可变 resource 字节连接到原生
assistant 和 prepared history。任何 dispatch 前，完整 `await_runtime` checkpoint
冻结全部已接受 intent。纯 Read batch 同样冻结完整分配，只是不需要 backup intent。
按 execution/function/part 与 assistant 身份派生 local 到 cumulative ordinal 映射，
保留 refusal gap 和较早 checkpoint item。不得将 assistant batch UUID 与累计
checkpoint batch ID 混同。

worker 执行针对原始不可变 grant 再次进行私有当前读回；三个工具名或较早的
preparation 响应不足。实际工具使用时保持有限 lookup 与所有保留 descriptor/path/
inode 检查。保留完整原始 inline result、持久 outcome、message 和 checkpoint
覆盖；超限或省略结果阻断 settlement。此 profile 禁用普通 ACK 清空与 Runtime
Session release。只有实际后续 Hosted model continuation 才能把 `consumed=false`
改为 true，SQL SETTLED 不能代替。中断结果与 preparation 保留为 blocker。

冷 owner 恢复复用原始 call、ref、字节与当前合格 checkpoint，不得重铸 ID、创建
另一独占目录、接管没有 authority 的旧 boot 或构造 idle tail。固定原始 Runtime
Session 和存储 holder 保持到合格退休。

## 6. 受影响组件与实现顺序

| 组件           | 必须连接的消费者                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bootstrap      | `WorkspaceCsiRuntimeProvisioner`、`WorkspaceCsiRuntimeIdentity`、`ManagedCsiFilesProtocol`、container boot reader、CSI file envelope、transport、共享 fixture 与重启比较 |
| Admission      | 独立 Broker HTTP 认证/路由、Broker service、原始 JDBC/seed/lease/context/current prefix 与完整 allocation reader                                                         |
| Native history | `CsiNativeActivationProof`、`JdbcCsiActivationAdmission`、`CsiNativeToolReservation`、`ManagedSessionStore`、extension application 与原始 resource association           |
| Closure 与恢复 | HTTP nested-resource collection、`WorkspaceRecoveryReader`、original file checkpoint、CSI snapshot/inventory 与 schema 感知 Hosted reader                                |
| Execution      | 私有 worker、保留 composer/history、有限 executor、原始 intent/checkpoint/grant、outcome/result/consume 与原始 Hosted harness callback                                   |

先实现验证 native schema/promotion 与锚定的读回，作为这条连接链的依赖；随后连接
实际 producer 与 worker preparation，再连接完整 execution 和 consumption。继续
完成冷恢复、全部 writer cut、DRAINED、物理 stop、NodeUnpublish、RELEASED、reuse
及部署/目标环境验证。依赖完成不能替换完整目标，也不能开放公共 Hosted/Spring
CSI selection。

### 6.1 首个完整接线交付：原始 preparation

下一生产边界是完整 preparation 链路，而非独立 codec 或 validator。实际私有入口
以 `WorkspaceCsiRuntimeAccess` 构造 `RuntimeBrokerService(access, provider,
access, ...)`；修改普通 Workspace transport 不能连接此路径。保持通用 control
拒绝，仅在此 access 与 Broker service 准入闭合的私有 history operation。

私有 `serve` 入口从部署配置读取 `K2_RUNTIME_BROKER_ORIGIN`，按第 2 节规则校验，
将保留元组传给 provisioning。同一自有 server 上的独立 lease 认证读回 handler 已连接 bind/prepare；execute 返回 501。
生产 HTTPS 可代理现有 loopback listener；不向 worker 安装全局 Hosted 凭据。
reconciliation 从已保存 handle 重建 boot，不读取新进程环境来替换它。

`hosted-csi-session` 初始化顺序如下：

1. Acquire 原始固定 Runtime Session 并安装其 context。
2. 打开原始 native authority，提交第一 activation。
3. 发起 private bind；worker 在首次调用 retained composer 前读取当前原始证据。
4. 从返回的真实空观察提交初始 schema-2 idle，使用稳定 bind command 与实际 domain receipt。
5. 开始正常 input/model 处理；对修改文件的 assistant batch，分配全部已接受
   Read/Write/Edit 成员，提交已验证 intent 与原资源提升，调用 private prepare，
   再提交 prepared。

第一条 conversation record 尚不存在时，初始 history projection 没有 conversation
parent。Session、cwd 和 version 来自原始 authority；后续 projection 接实际最后
conversation record。不调用需要 conversation 且不返回 receipt 的旧 schema-1 helper。
私有 helper 返回 `commitDomainRecord` 的原始 `{ receipt, recordRef, revision }`。
wrapper 仍由 authority 产生，唯一 `domain.committed` event 不带 activation subject。
对照实际 Harness producer 验证 initial checkpoint 语义；增加 history 不能静默放宽
无关 checkpoint 字段。

### 6.2 Broker 到 worker 的 history 契约

仅为 boot 5 增加 `POST /internal/managed-runtime/csi/v2/file-history`，使用原始
lease token 认证。闭合 envelope 严格为 `protocolVersion: 2`、`managedCsi`、
`identity`、`context`、`installedContext`、`operation`；identity 与完整 context
元组遵循第 2 节。bind/snapshot operation 严格为 `kind: "csi-file-history"`、
`version: 1`、`action`；prepare 额外含 `preparationRef`，指向原始已提交 schema-2
intent ref。不接受调用方 paths、state 或 membership。Broker 仅在当前原始 owner
验证后转发，worker 对 bind/prepare 各自重新读取当前 native 证据。

成功响应使用相同六个 envelope 字段，另加 `observation`。operation 完整原样返回；
observation 严格为 `state`、`backupDirectory`、`retainedBackups`，来自 retained
composer，不添加 authority wrapper、revision、native receipt、grant 或退休声明。
提交 history 前验证完整 envelope 与观察。request 上限 16 KiB，完整 response 上限
64 KiB，超限拒绝而非截断；可提前判断容量时必须在文件效果前拒绝。

在等待读回前安装 bind promise；匹配重试加入该 promise 与同一批 descriptor，失败
不能打开第二个目录。prepare 同样按原 intent ID/digest 加入，完整成员与修改路径
从 native readback 推导。snapshot 仅观察已保留 composition；本地或 SQL seal 后仍
可观察它，但不能新建 backend、调用 prepare 或取得新准入。失败或不完整的观察保持
blocker，不能提交为 idle 或成为退休证据。close/drain 加入全部已准入操作。
Broker snapshot 使用原始 continuation fence，可以允许保留中的 DRAINING owner；
不能新 acquire Session，也不能使用仅 READY 的 bind/prepare 准入。此例外仅允许
观察原始保留 composition，不写入，也不 fallback 到其他 runtime。

### 6.3 Snapshot 演进与 dispatch 边界

Snapshot 按 prompt 建立，不按 assistant batch 建立。现有 history service 在同一
prompt 的下一 batch 扩充最后 snapshot。prepared 校验保留其 prompt ID、timestamp
和全部已有 backup entry，仅允许新的修改路径扩充最后 snapshot；更早 snapshot
不变。新 prompt 追加一个 snapshot，在 I/O 前检查 100 项上限。已有 retained backup
pin 字节完全不变，包括已跟踪路径不需要新 preimage 的情形。当前 file fingerprint
仅能通过已验证的执行/完成链改变，preparation 不能虚构这些效果。

前一 preparation-only 交付以持久 prepared blocker 结束。下面保留该交付的
dispatch 拒绝边界；第 6.5–6.7 节描述已连接完整 intent/checkpoint/grant 准入的当前候选。在公开 Broker 入口路径与 JDBC mutation
边界明确拒绝没有该 grant 的私有 dispatch authorization/start/execute。在已调查的
基线中，`authorizeDispatch` 只验证原始 READY/session/activation，不关联 native
tool intent 或 dispatch checkpoint。真实的十一字段 allocation 已在 claim 处以
`csi_execution_continuation_unavailable` 拒绝，未观察到文件执行绕过。本增量在
Broker claim 前与 JDBC 写入 authorization marker 前加入
`csi_file_dispatch_unavailable` 拒绝。保持其他 profile 行为。历史 continuation
测试明确植入旧持久 marker，不能产生新 native grant，也不能证明当前 dispatch。
此交付不接受 completed idle、不清空 preparation、不消费 result，也不 release
Runtime Session。
私有 start 在 claim dispatch 前拒绝，保留原始 PREPARED row；JDBC 后备边界在写入
authorization marker 前拒绝已 claim 的私有 call。拒绝不证明执行不存在，也不能
擦除已有 UNKNOWN 义务。

后续 completion 交付开放 model continuation 时，必须遵循现有 producer 顺序：
下一 model attempt 先完成，再调用 `consumeResults`。仅在完整 results-ready 闭合后
允许该 attempt，同时保留未消费义务。若等待 consumption 才准入用于消费的同一
attempt，会使正常 continuation 死锁。

### 6.4 原工具 intent 与纯 Read 会员冻结

对 `606d33529176aa139cf1c5d94b88d97b5f37832c` 的调查发现，execute codec
要求一个没有生产调用者发布的 `managed-tool-intent` 资源。实际 authority 的
`appendExecutionEvent` 将 `tool.intent` 追加到原 journal，仅返回 commit receipt，
没有资源 reference 或 journal revision。仅将实验性 execute grant 改为上述闭合
journal 定位。Prepare evidence 的 `intentRef` 与 `FileHistory.FrozenBatch.intentRef`
仍是原始 `managed-file_history` 资源，两者含义不变。codec 修正不开放 execute
readback、claim、authorization、worker 文件效果或结果消费。

原生 replay 已知每个原 transaction 的 revision 和每个 event 的 sequence。
在 replay 得到的 Prefix 中派生 execution 到 intent 的位置，不新建持久 intent
ledger。fresh acceptance 与 replay 共用校验器。授权时在同一加锁 Connection 中
定位唯一原事件，匹配其 activation、Session key、execution ID、assistant batch、
本地 ordinal、原始 input 与 declaration。将该位置持久保存在不可变联合 grant
中。worker 重新读回时对原 journal 验证已保存的位置，不能用调用方位置、当前
head 或重新生成的 grant 替代。

修改 batch 已通过 schema-2 history intent 冻结完整接受会员。纯 Read batch 必须
在首个原生 `tool.intent` 时冻结：在划分当前 batch 前，锁住完整原资源 inventory、
固定 READY Runtime Session 和全部相关 SQL execution rows。要求当前全部会员是
原始 PREPARED allocation，没有 dispatch marker、取消或 terminal/UNKNOWN 状态。
该 assistant batch 一旦存在任何 native intent，拒绝新 allocation，允许确切原
reservation 重试。原 execution rows 保留不可变身份与 reference，无需复制会员
或建立第二个 ledger。

每个 native intent 在同一 journal transaction 中仅验证和关联自身确切的原 input
与 declaration，提升此前未引用的纯 Read 资源。尚未进入 intent 的纯 Read 会员
字节保持原 allocation 的 PUBLISHED；已
进入的会员必须是 REFERENCED 并关联其确切原 intent revision。修改 history 的
关联继续保留原 history revision。不能泛化为接受两种状态，不能将未触及会员关联
到其他 intent。dispatch 前，完整 `await_runtime` checkpoint 必须强等三个集合：
原当前 batch SQL 会员、唯一 native intents、checkpoint 新增加的 pending items。
原 pending items 保持不变，按真实 Harness producer 的
`max(request.ordinal, nextOrdinal)` 派生累计 ordinal，保留 refusal gaps。不能过滤
cancelled、not-started、UNKNOWN 或 terminal 会员来缩小成功集合。

当前候选已实现原生 intent/checkpoint 校验与同 Connection preflight，再建立不可变
authorization，并连接有限 worker executor、原 outcomes、result messages、results-ready
与 consumption。下文记录有界 Read 和混合批次证据；剩余失败组、冷恢复与退休门禁仍须
完成。公开 selector 保持关闭，设计使用标准 Kubernetes 与 CSI，不要求 Alibaba ACK。

### 6.5 原生意图与完整 dispatch 检查点交付

状态：已实现，是第 6.6–6.7 节有界 Read 和混合批次验证的前置步骤。原生 intent 与
`await_runtime` 校验原始 grant 与有限 worker 执行；冷恢复和退休仍关闭。

将私有 Hosted callback 已有的 live Harness 传入工具回合。完整原预约 readback
以及变更批次 schema-2 prepared history 完成后，按 local ordinal 为每个接受会员
追加一个原 `tool.intent`。使用原 execution ID、assistant UUID batch、input 和
完整 advertised declaration 引用。authority command/event ID 均为
`tool-intent:${executionCallId}`，content digest 是 input 资源 digest。闭合 payload
仅有 `executionCallId`、`batchId`、`ordinal`、`toolDefinitionRef`、`argsRef` 和
`outcomeSource: runtime`。

在 native replay 中派生每个意图的实际 revision 和 sequence。fresh acceptance
传原 previous revision，replay 传 `rowRevision - 1`，不得从 sequence 猜 revision。
Prefix 保留派生 event payload 与合格 input digest，不持久化第二套会员账本。
纯校验按 local ordinal 匹配原 assistant call 与原 input/declaration bytes，不能
编造 SQL call UUID 或十一字段 reference；这些联接属于同 Connection SQL 预检。

资源关联前锁完整 inventory、固定 READY Session 以及所有状态的全部 related
execution rows。首意图前校验当前完整批次。一旦存在原 intent 就拒绝新分配，仍允许
原 allocation 精确重试。变更批次必须已有原 prepared history，input/declaration
仍通过原 history association 读取。只读批次仅晋升 entered member 的两个资源，
关联其实际 intent revision；unentered member 保持 PUBLISHED。预约 API 此前允许
会员共享资源，但实际 Hosted producer 每会员 publish 独立 ID；只读首意图前明确
拒绝任何跨会员共享，且必须先检查整批再晋升。不得放宽通用资源验收。

使用实际 `commitAwaitRuntimeBatch` producer 一次提交完整批次。binding 的
`attemptId`、`modelMessageId` 为原 assistant UUID，`invocationBindingId` 为
execution ID，`routeRef` 为原 input ref，`inputDigest` 为原 request digest 去掉
`sha256:`。使用已有私有 capability digest 与 `csi-files-retirement-policy/1`，
media version 和 progress cursor 均为 null。不接受空批次或编造的 checkpoint。

按原 previous state 与实际 Harness 算法验证完整九组 checkpoint。identity 只更新
checkpoint、predecessor、covered sequence、activation 与 prompt/turn；resume
仅更新 `throughSequence`，包括 initial null `fileHistoryRef` 在内均继承；output
与 followUp 不变。continuation 为 `await_runtime`，approval 为 null。保留已有
attempt，否则使用首 pending assistant UUID/input ref fallback。保留全部旧
items/bindings，再追加当前完整集合。首次 `tools.batchId` 为
`batch-${first functionCallId}`，不同于 assistant UUID。累积 ordinal 按
`max(request.ordinal, nextOrdinal)` 派生，保留本地拒绝造成的缺口。新 items 为
in_progress、outcome null、consumed=false；新 bindings 为 dispatch、cursor null。
SQL 当前会员、唯一原生 intents 和新增 checkpoint items 必须相等，不能遗漏
cancelled/UNKNOWN/terminal rows。

同 command 重试必须先重放原 journal，再校验完整当前 SQL/resource 资格，然后返回
原 receipt。资源晋升、引用关联、journal transaction 与 head 在同 Connection
原子提交。阻塞锁后重新核对数据库 writer/activation 时间。下文已连接私有
dispatch/execute/outcome/result 消费者；冷恢复与退休门禁仍关闭。

本次验收要求全新实际 Hosted 到原 store 链到达完整 native intent/checkpoint，
保留原始 SQL/resource/journal 证据，验证精确重试、事务拒绝/回滚、普通 Read 回归
与自有资源清理。H2/Darwin seams 仅是有界软件证据；真实 MySQL 锁竞争、Linux CSI
及目标集群验收仍是独立开放要求。

### 6.6 首个验收点：真实 Read 执行与消费

状态：已观察有界软件 Read 正向链路。原始 producer 完成两次 Read、不可变 grant、
SETTLED/success SQL、outcome/receipt/tool 消息、第二次真实模型调用、结果消费与
Turn 落定。第 7.2 节后续混合运行和有界负向组补充了精确 dispatch 重试与拒绝证据；
剩余失败覆盖、完整 K2 和新的云上资格仍开放。
上面的原生 intent/checkpoint 接线是内部前置步骤。
首个验收点是一次实际 Hosted Read 完成授权、有限 worker I/O、原始 SQL 落定、不可变
outcome/receipt、tool-result 消息、results-ready、后续模型继续、消费和 Turn 落定。
Write/Edit 和冷恢复随后沿同一贯通路径推进；物理退休和公开选择继续保持现有门禁。

两条生产 schema 路径都必须创建原始执行授权列：独立 Broker schema 和 Agent Server
的 Flyway 迁移。首轮候选在派发前暴露 Agent 迁移遗漏；V55 添加可空列，不为任何
已有执行生成授权或改变其状态。

在写入原始授权标记的同一事务中，将一份不可变原生授权 JSON 持久化在原始
ToolExecution 行。它由重放后的原生意图、完整原始 dispatch 检查点、完整 SQL 成员和
不可变输入/声明字节、固定 READY Runtime Session、原始 binding/version 和安装上下文
共同导出。固定原始检查点的 journal 位置，即使后续部分结果推进了 head 也不改变。
重试不能从新 head 导出授权。首个已验证 Read 路径使用完全只读批次；包含变更的混合
批次必须使用第 6.7 节固定的原始 prepared-history 执行消费者。

worker 的私有 execute 请求仅携带原始 execution ID 和预期安装身份。新鲜、认证的
原生回读返回持久化授权和原始资源字节。在使用有限 executor 前，重新检查本地 seal 和
已绑定组合，比较原始输入摘要，并在保留 executor 中合流相同执行。操作在第一次 await
前登记并保留结果；普通 ACK 和 Session release 不能清除它们。拒绝、传输丢失或超大输出
留下未落定 blocker，不能伪造结果或创建替代调用。

重放的文本 stream 遵循既有 Hosted producer。assistant 消息 commit 清除当前消息身份，
但在模型轮次间保留 ordinal。可见 retraction 将它归零；新消息首个 delta 之前的重试也可能
在不产生持久 retraction 的情况下归零。因此，新消息首个 delta 接受零或原始累积 ordinal；
同一消息后续 delta 必须严格递增。command/event 相等性、消息身份、内容摘要及最终累积
文本仍保持准确。计数器由原始重放导出，不持久化到新 ledger。

实际 Hosted producer 将完整原始内联 Runtime 结果与模型响应记录在同一不可变 outcome。
SQL 验收在同一 Connection 联结原始 SETTLED 行与持久化授权。原生 receipt 先于准确的
原始 tool-result 消息和实际 Harness 结果检查点。检查点保留其他所有组和旧成员；仅合格
成员和 binding 落定。所有结果提交后才能开始下一次模型尝试。结果仅在该后续尝试完成后
变为 consumed，遵循实际 Hosted producer 顺序。SQL SETTLED 行本身不能授权消费或
Turn 落定。

验证复用已有基线，聚焦新增的 Read 行为、准确身份/原始结果、必要的拒绝联结和普通本地
回归。H2、确定性模型输入和 Darwin mount 替身必须报告为软件覆盖，不能算作
MySQL/Linux CSI 或云上 K2 验收。

### 6.7 Write/Edit 执行与 prepared history 收口

状态：实现已接通，并已通过有界真实混合批次软件验证。原 Main-owned transport 起初
仍有只读 guard，使 Write 在 worker I/O 前被拒绝；已修正这一准确消费者。
新的运行观察到 Read、Write、Edit 原始 SQL SETTLED/success、result-history 收口、
第二次模型消费及 Turn 落定。精确 start 重放复用原结果且没有 I/O，改变 payload 被拒绝。
第 7.2 节记录五个有界负向组，包括 prepared 字节损坏、post-history 观察失败和真实
逻辑 seal。响应丢失及更广泛的失败覆盖仍未获得资格。
接通此消费者前已通过有界 Read 正向继续链。
已接受的混合批次保留全部原始 Read/Write/Edit 成员，包括本地拒绝造成的 ordinal 缺口；
不能因接通变更而遗漏 Read 成员或重新分配调用。

不可变授权为变更批次固定原始 frozen prepared-history 引用。重放导出 prepared 事件的
sequence 及其唯一原始 commit revision；资源资格使用该 revision，不能使用后来的
工具意图、dispatch 或当前 head revision。各 input/declaration 保留自己的原始关联。
后续成员改变工作文件后，grant 与准确执行引用仍保留同一 prepared 引用。
不另建授权或 history ledger。

准备与执行必须使用已绑定 worker composition 内的同一 retained ManagedRuntimeFileHistory
实例。仅保留 storage、缺少该 history 实例的 worker 在 invoke 前拒绝。首次 I/O 前联结
不可变 prepared body 与原始缓存 preparation observation，再由既有 history 执行路径
检查 preimage 并串行变更。不能要求后续每个成员的新鲜全 Workspace 观察仍等于旧 preimage：
第一个合法变更已改变这些文件。相同 execution 重试合流 retained executor，不能重复
Write 或 Edit。响应丢失或执行后的 history 更新失败保持 UNKNOWN/未落定，直到原始结果
获得资格。

所有原始 receipt 和 tool-result 消息提交、实际 Harness 达到 results_ready 后，Hosted
获取 result history snapshot，在第二次模型尝试前提交
`csi-file-history:result:${batchId}`。结果投影的 parent 是最后一个原始 tool-result UUID。
preparation 变为 null；backup directory、retained backups、snapshot identity 与
file-key 集合保持固定。只有原始 prepared mutation plan 中路径的 fingerprint 可以变化。
同 Connection 准入联结完整原始 SQL 成员、持久 grant、原始 result、receipt、message 和
results-ready checkpoint；initial history 与 result history 是不同转移。
未收口的 preparation 阻止下一次模型尝试。

验收要求真实 Write/Edit 效果与原始 preimage、完整混合批次消费、result-history 收口、
第二次真实模型请求包含原始结果，以及 Turn 落定。重复 dispatch 不重复 I/O。变化的 prepared
字节、遗漏成员、响应丢失、post-history 失败，以及 prepare/dispatch 前 seal 都必须保持
blocker。helper fixture 或手动插入 idle snapshot 不能证明此门禁通过。

### 6.8 冷恢复证据与退休消费者

状态：导出保留已实现；native retirement 资格与真正冷恢复仍计划中。一轮自有 MySQL
运行复现了四份导出都遗漏原始 `native_authorization_json`，以及非持久化字段
`lifecycleAuthority:null` 导致更早的 inventory scope conflict。exporter 现在通过
既有 JSON row encoder 导出原始授权列，并且仅输出原持久化的六个 placement 字段。
它不重建 authority，也不放宽 scope reader。原始 file-checkpoint reader 仍仅接受
旧五字段引用、仅 converted 结果的 outcome 与 schema1 history。
因此，新的 native settled 行不能借用该 reader 的旧验收作为证明。

完整执行导出保留原始不可变 native authorization JSON。保留原始 result 和全部相关
session、publication、receipt、checkpoint、ACK 与
operation 行；不能从 snapshot 的最新 head 重建 grant。native file-checkpoint 分支
必须校验准确十一字段引用、原始 grant 与 input/declaration/history 关联、完整批次成员、
含原始 result 和固定 history 的 outcome、原始 receipt、准确 tool-result 消息，以及
consumed/settled checkpoint 链。它支持 schema2 history，并保留 legacy 记录的既有分支。
缺字段、分页不完整、未知状态、损坏字节或预算耗尽均产生 unresolved 观察，不能部分成功。

冷恢复首先分类原始持久链。SETTLED 执行复用原始结果与 receipt，不再次 invoke 工具；
UNKNOWN 执行不能因为 process 或 Pod 消失而变成可重试。prepared 变更保留原始 backup
和执行身份，直到原始效果/结果获得资格。恢复证据本身不授权替代 worker 或物理卷交接。

当前私有 Hosted initializer 要求新 authority、writer generation 1 和 activation epoch 1。
原始 Store 拒绝过期的 CSI writer；native history 重放也固定原始 writer，尚无 takeover
语法。因此只读证据匹配不能被报告为真正的 Hosted 冷恢复。该交付必须先校验原始持久尾部，
再执行带 fencing 的 writer/activation 转移，按照各原始 receipt 的固定消息身份恢复，
并在不重新派发工具的前提下继续既有 Harness 模型循环。普通 load 的 legacy history parser
与恢复路径保持不变。

snapshot exporter 要求真实 MySQL/InnoDB 一致的只读快照。此前的 H2 软件贯通运行
不能赋予该消费者资格。验证使用新的自有本地 MySQL 数据库与原始 logical retirement cut，
不从已清理 fixture 重建正向 SQL，也不放宽 engine 检查。

应用收口仍要求完整原始 inventory 与不可变 cut 后每个 writer/lifecycle operation 落定。
只有独立可信证据证明准确原始 writer/后代终止及每项 CSI NodeUnpublish，才能赋予物理
退休资格。聚合 DRAINED、原子 RELEASED 与同卷安全复用仍是独立门禁。
实现该转移前必须选定并审查 stop/unpublish 权威；Pod 消失、租约过期、NodeNotReady 或
普通 HTTP release 都不充分。既有 operator 清理不是该权威。

验收须从真实 consumed Read/Write/Edit Turn 后的新鲜原生 snapshot 开始，再重启证据
reader，不能重建 grant 或 result。正向和拒绝组覆盖混合/多批次、不完整 inventory、变化的
原始引用、结果响应丢失与 UNKNOWN 成员。真实 MySQL isolation 和 Linux CSI/目标集群
退休仍是独立资格要求；此设计不授权创建新云资源。

## 7. 验证与验收

生产编辑前，由 test-engineer dry-run 全局 CLI 与实际当前原始 producer，记录真实
缺口，不合成正向 assistant、intent、prepared history 或 grant。仅将保留 utility
作为重新 hash 的输入使用，使用新自有 root/process/DB 并明确 fixture 边界。启动前
锚定实际 Node chunk 与 Java origin；若无法完整预锚定，保留只有加载时证据的限制。

连接后的正向运行必须由生产调用者产生实际 Read/Write/Edit preimage、原始 history
revision 与资源提升、完整 grant、真实文件效果、原始 result、outcome/message/
checkpoint 闭包、consumption 与合格 idle tail。负向组覆盖 omitted Read、late
insert、多页/第二批、外来/变化身份、资源故障回滚、响应丢失、损坏 history/字节、
容量、prepare/dispatch 前 seal 和中断结果。真实 MySQL READ COMMITTED 与预热
REPEATABLE READ 锁竞争不同于 H2 或串行 seal；新 Linux CSI/目标集群证据不同于
POSIX fixture。

完整实现报告前执行 build/typecheck/bundle、聚焦 TS/Java 检查、独立验证、两轮干净
自审及仓库原生 review workflow。如有原生 workflow 限制必须明示；CI 或独立 helper
测试不能替代 maintainer approval。保持同一个 Draft PR，不自动 Ready、merge、
物理 release 或关闭 proposal。

### 7.1 已观察的 preparation 增量，2026-10-09

固定候选产物的一次独立运行完成普通本地 Read 和一条实际私有混合 assistant
链路。实际 provisioning 生成 boot5/handle3；Main 自有 Broker、原始
controller/store、Hosted shared runner 与同一 live worker 提交 initial history、
intent 和 prepared，均返回 HTTP 200。Traversal Read ordinal 1 拒绝后，三个
已接受 Read/Write/Edit 分配保留 ordinal 0/2/3。六个原始 input/declaration
resource 提升为 REFERENCED，具有确切 intent/prepared 关联。有限 commit closure
分别包含 1/7/8 个 resource，不在 prepared 中递归复制 initial 前驱。worker 使用
原始 lease 和 retained composition 读取原始已提交 intent。

既有文件的实际 29 字节 preimage 与 retained backup 相等；工作文件不变，新 Write
目标仍不存在。原始 head 达到 revision/sequence 12/12。三个分配仍为 PREPARED，
authorization marker 为空。Hosted text 在持久 prepared 后返回 503；没有 dispatch、
下一次 input、settled turn 或面向用户的执行成功。34 个原数据离线谓词与两个行为
组分开计数。producer 后的 53 张 SQL 表保持不变；自有 process、port、H2 和
retained handle 已清理。源码与产物在运行前固定，运行后无漂移；实际 loaded-origin
后审计不声称完整传递依赖的启动前覆盖。

本轮使用 H2、模拟 Kubernetes 对象、mocked pre-provision attestation、包裹实际
controller/store 的 MockMvc transaction/HTTP adapter、确定性模型 SSE、在自有
真实 handle 上实现的 Darwin mount/platform/fd shim，以及透明 worker URI proxy。
这是有界软件 preparation 证据，不是真实 MySQL isolation/锁竞争、物理 Linux CSI、
目标集群或完整 K2 验收。之前的失败运行单独保留：缺少 no-store 响应 header 和
错误的混合 assistant history guard 都已复现、修复并加入回归后，才完成本轮成功
运行。在该 preparation head，不可变 grant、执行、结果消费、冷恢复、writer cut 和物理
退休仍是下一批交付。
原生 review 所需 foreground workflow 工具不可用，因此该审查仍待完成；继续保持
Draft 和 maintainer review。

### 7.2 已观察的原生执行与导出增量，2026-10-09

后续私有 producer 通过既有 Hosted Harness 循环完成 Read 和混合 Read/Write/Edit。
原始 intent 先于完整 dispatch checkpoint；每个原始 SQL 执行取得不可变授权，以原始
result 落定，并提交含固定消息身份的 outcome。原始 receipt、tool-result 消息和 resolve
checkpoint 先于 result history、第二次模型请求、consumed checkpoint 和落定 Turn。
第二次请求包含全部原始结果。Traversal Read 被拒绝，已接受混合 ordinal 保留 0/2/3。
精确 start 重放返回原始结果，没有新 I/O；变化的 payload 被拒绝。

混合运行创建 17 字节文件，将原文件改为 32 字节，并保留真实 29 字节 preimage。
随后一轮自有 MySQL 8.4.11 运行观察到同样完整的三执行/模型链，然后调用原始 logical
retirement begin 和精确重试。它暴露两个 exporter 缺陷：遗漏原始 native 授权，以及
额外的 null authority scope 字段。窄修复后，一轮新的自有 MySQL 运行在四份导出中
保留每个原始 grant 对象，并输出原六字段 scope。新的 inventory reader 观察到恰好三个
SETTLED 成员，每个仍为 `original_file_execution_conflict`；三个独立 file reader
保留同样拒绝。导出和读取前后全部 53 张原 SQL 表不变。这只证明导出保留，不证明
native 恢复或物理退休。

五个有界负向 producer 组覆盖变化的 prepared readback 字节、遗漏批次成员、
post-history 观察失败，以及 history prepare 前和 dispatch 前的真实 worker seal。
前两组明确使用 wire fault fixture。post-history fault 在真实 Write 效果后发生，
对应 SQL 执行保持 UNKNOWN 且没有 result，不启动第二次模型。第一个 seal 拒绝
history prepare，保留 PREPARED 成员。dispatch seal 先异步受理 start，然后 worker
和 poll 拒绝，原始 Read 变成 UNKNOWN，没有工作文件 I/O。两个 seal 都报告
DRAINING/BLOCKED 且没有 physical release。此前有关 stream ordinal、result
checkpoint 选择、异步栈名称和同步 start 预期的观察器失败保留；ignored observer
修正仅对保留原输出离线核验，不算额外 producer 运行。

这些运行使用自有真实文件和实际 Java/Node 产品。MySQL 运行使用新的自有 server、
database 和受限 user。Kubernetes metadata/pre-provision attestation、Darwin 上的
Linux mount/fd mapping、确定性模型 SSE 和 MockMvc HTTP/transaction adapter 仍为
明确 fixture seam。自有 worker、server、database/user、端口和临时根已清理并独立
核验。MySQL 串行 producer/export 观察不证明并发 READ COMMITTED 或预热
REPEATABLE READ 竞争。新的 Linux CSI、目标集群资格、真正 cold takeover、
全部 writer 收口、聚合 DRAINED、可信物理 stop/NodeUnpublish、RELEASED 和安全
复用仍开放；原生 review 和 maintainer 范围审查仍待完成。
