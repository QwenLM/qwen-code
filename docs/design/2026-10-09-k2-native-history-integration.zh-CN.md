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
的 Flyway 迁移。首轮候选在派发前暴露 Agent 迁移遗漏；V57 添加可空列，不为任何
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

基线私有 Hosted initializer 要求新 authority、writer generation 1 和 activation epoch 1。
基线 Store 拒绝过期的 CSI writer；基线 native history 重放也固定原始 writer，尚无 takeover
语法。因此只读证据匹配不能被报告为真正的 Hosted 冷恢复。该交付必须先校验原始持久尾部，
再执行带 fencing 的 writer/activation 转移，按照各原始 receipt 的固定消息身份恢复，
并在不重新派发工具的前提下继续既有 Harness 模型循环。第 6.8.1 节描述实现此转移的本地候选，
第 7.7 节在有界本地运行中验证了 receipt-complete C1 续接；其余冷窗口与目标集群
验收仍待完成。普通 load 的 legacy history parser 与恢复路径保持不变。

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

#### 6.8.1 合格的存活 Session writer 冷恢复

状态：已实现；receipt-complete 续接在 `6d304d299ff09c920d455bc9562960e39b8c7815`
上通过了第 7.7 节记录的有界本地 C1 观察。此交付针对所有 SQL execution 与不可变 receipt
已落定、最后 message/resolve 尚未收口的原有限文件批次。下方其他冷窗口仍须完成，
这不代表完整 K2 验收。

保留既有私有 Main text 入口、原始 request/session 和准确 prompt。新 Main 进程重新
核对并 attest 原 provisioned handle 与 READY Runtime Session，不创建新 Pod、worker、
binding 或 file-history 实例。新 Hosted boot ID 是新的 journal writer 身份，不是
保留文件 worker 的身份；准入必须同时保留这两种身份。

在同一事务 Connection 的既有 placement-domain、原 binding/session 与 journal-head
锁下，先校验有界、完整 native history 以及全部关联 execution/resource 行，再修改
writer。要求原私有 profile、ACTIVE/READY、未 compact 且完整的 journal、固定 first
activation、原加密 runtime handle/context，以及唯一原 READY Runtime Session。
验证完整原批次，包括 ordinal 缺口、全部十一字段引用、input/declaration/prepared
字节、不可变 grant 及其原 intent/dispatch revision、原始 result 和 receipt history。
每个关联 execution 必须 SETTLED、具有完整 success/error result、原始非空授权且未
取消。首个窗口还要求每个原 receipt 已持久化。PREPARED、executing、UNKNOWN/ABANDONED、
legacy 混入、遗漏/孤立成员、字节变化、分页/预算失败、retirement cut 或不支持的
continuation 均拒绝，不能修改 head、journal、resource、grant 或 result。

用数据库时间要求旧 writer 与旧 activation 均已过期；仍存活的旧 owner 继续阻止替换。
只有 CSI 专用资格通过后才复用既有 writer 更新：递增 writer generation，设置新 boot
ID/token 与租约，保留已提交 journal、checkpoint 和 activation epoch。不授予新的
execution 权限。这是专门的 cold-admission 路径，不是普通 live dispatch/receipt
准入上的 allow-expired 选项。

writer acquire 与 successor activation install 是两个事务。中间只有合格 successor
install 可以 append，普通 native mutation 仍须不可用。重新读取既有 authority，不
发布新 definition/root、不要求新 journal。activation install 重查原尾部与当前存活
writer，使用新 activation ID，准确递增最后已 install epoch 一次。claim 后尚未
install 就崩溃，须待其自然过期，再由另一个合格 claim 替换；未使用的 writer generation
可以跳过，已 install 的 activation epoch 不能跳过。

native history 按原 writer/activation 分段重放。genesis 与首个 activation 仍为
generation/epoch 1。renew 保留原段的 writer、activation、install reference 并递增
renewal sequence。successor install 在严格更大的 writer generation 下开始下一个
epoch。旧 transaction 行与原 grant revision 保持不变。普通 live 读取要求锁定 head
与最后 install 段一致；只有专门 cold claim/install 路径识别尚未 install 的 claim。
历史重放不能让所有旧行改名为当前 writer ID。

CSI 的 existing-command replay 在返回旧 receipt 前，除既有准确 transaction 比较，
还必须验证当前 head writer ID、generation/token 与存活租约。renew 与 publication
保留相同当前 head fencing。普通 legacy replay 语义保持不变。接管后捕获的旧 writer
请求必须拒绝，包括 byte-exact replay、renew 和合法 publication；畸形请求不是 fencing
证据。

#### 6.8.2 在模型门禁前修复

首个恢复消费者读取已有持久 receipt 与其原 outcome resource，保留
history.messageId、timestamp、model 和 parts。逐字节核对已有 tool-result message，
按原 ordinal 顺序仅补写缺失原 message，再 resolve 其原 in-progress checkpoint 成员。
不能另分配 execution、重新 prepare/dispatch、替换 result 或改写旧 grant。

私有修复必须发生在共享 Harness runner 之前。当前 harness.run 的模型门禁会拒绝
await_runtime，在 run 内才执行的 callback 太晚。合格 successor activation 的临时
handle 可以修复原 receipt/checkpoint，然后收口保留 schema2 result history：保持
backup/snapshot/path 身份，只改变原 mutation plan 允许的 fingerprint。仅从保留 worker
取得 snapshot，不 bind、clear 或重建 history。

私有 text 恢复分支必须匹配持久原 prompt ID 与 input/admission 字节。它跳过 submitInput
及重复 user message，投影修复后的原 history，以全部原 response Parts 作为
resumeFromToolResults，从 results_ready 进入既有 Harness/模型循环。变化的 prompt
拒绝。CSI tool turn 仅确认 result-history 义务已闭合，不再执行批次。实际后续模型请求
必须包含所有原已接受结果，包括本地拒绝 ordinal 缺口前后的 Read 成员。

consumption 发生在实际后续模型尝试成功后。successor 消费 settled result 时，应镜像
既有 Harness 对 checkpoint activation identity 的接续，所有其他 checkpoint group 和
原 outcome reference 保持准确。完成原 assistant、turn_settled、idle 链。已提交模型
output 后重启须完成原 attempt，不能发送第三次模型请求；该窗口仍独立验收。

当前私有 read-batch 返回 reference/input/declaration/state，不返回原始 SETTLED result
和持久 grant。因此 receipt-absent 恢复还需要单独合格的原认证 readback，以及持久、
只落定一次的 outcome/message 身份。observer 不能以随机 ID 充当权威、重建正向 SQL 行，
也不能用 retirement export 授予存活 Session 的 takeover。

#### 6.8.3 冷恢复验收与实现边界

| 独立验证窗口                              | 必须观察的行为                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 最后 receipt 已提交，message/resolve 缺失 | 真实旧 Main/Hosted 退出、保留 worker、新 boot ID、数据库自然过期、合格 successor、原修复、实际 model2、消费/结算；零新文件 dispatch/I/O。 |
| 旧 owner 存活                             | 合法 replacement acquire 拒绝，完整原 SQL/文件不变。                                                                                      |
| 有真实 Write 效果的 UNKNOWN               | 原 UNKNOWN 与剩余 PREPARED 成员阻止 takeover；不 replay、替换 result 或重复变更。                                                         |
| SETTLED 但 receipt 缺失                   | 读取合格原 raw result/grant，仅一次持久 outcome/receipt；observer 不提供正向行或消息权威。                                                |
| message 或 resolve 之后                   | 重复恢复保留准确原身份，不重复 journal message/result 或文件效果。                                                                        |
| claim 后、activation install 前           | 实际 acquire 后崩溃，待自然过期，再校验另一个 claim，仅 install 下一 activation epoch；中间不修改 journal。                               |
| 接管后的旧 owner                          | 捕获的准确旧 transaction/renew 及合法原 generation publication 拒绝，无无关表变化。                                                       |
| model2 output 已提交、consumed 之前       | 保留原 attempt/output，不发 model3、不做文件 I/O 即结算。                                                                                 |

数据库时间 fencing 与 claim/install 竞争使用全新自有 MySQL；H2/单元 fixture 不能
赋予 InnoDB isolation 资格。真实 READ COMMITTED 与预热 REPEATABLE READ 竞争须分别
观察。首个 receipt 窗口只是增量，不是全部冷恢复或完整 K2。

影响层为私有 Hosted session/tool turn/history 消费者、native activation/conversation/
checkpoint proof、同 Connection activation/execution 准入，以及 Managed Session
writer/commit/publication fencing。同批更新 collocated tests 与双语设计。复用既有
Main transport、保留 worker、原 ledgers 和共享 Harness，不另建公开 recovery selector
或第二授权 ledger。聚合 writer 收口、物理终止/NodeUnpublish、释放/复用与目标集群资格
仍为独立门禁，并保留既有审查边界。

#### 6.8.4 receipt 缺失前的合格 SETTLED 结果

状态：候选实现已允许具备原始资格的 SETTLED 成员缺失 receipt；新鲜 C4 正向验收仍待完成。基线 `ca75a90014bb6c92e9c1a06dcdbdb9c01b8613b5` 在新建自有 MySQL 8.4.11 完成 Flyway 53–58 后复现该缺口：最后 Main GET 返回包含 settled 结果的 200，在交付 Hosted 前扣留响应；已有两个 receipt/message，最后 receipt/message/resolve 不存在。只终止已登记原 owner 并等待自然过期后，实际 native acquire 返回 409 `csi_native_execution_unavailable`，该事务前后全部 57 表精确相同。原三条 execution/result/grant 行以及 execute/effect 观察保持一致。producer 在完整 auditor 前 exit 1，原因是 observer 跨 JVM 逐字节比较启动请求序列化；完整 JSON 值与其它帧字段均相等，仅顶层 key 顺序不同。该 aggregate 继续保留为失败，只提供已复现的拒绝证据，不能当作正向恢复验收。

候选实现与 live tool turn 共享原 accepted-input 规范化及 atomic receipt publication。新 cold reader 使用已安装 successor fence，对原 result/grant 做严格有界解码，并在任何写入前验证整个 batch。receipt-complete 路径不增加 batch read。本地中断回归核验新耐久 receipt 在重试时保留首次身份，但不验收 C5 进程断点或完整 K2。

保留专用 cold writer 与 successor install 资格检查。每个相关成员仍须为 SETTLED，具有完整原 success/error 结果、原持久 immutable native grant 且未取消。将每个已存在 receipt 与同一 SQL 结果核对；允许明确缺失的 receipt，但不能把它当作 execution 不存在。保留原单个 pending batch、首个模型输出、完整 resource/reference inventory、无 deadline prompt 与数据库自然过期约束。PREPARED、执行中、UNKNOWN、遗漏/孤儿成员及不支持的 continuation，仍须在 writer authority 改变前拒绝。

仅为 SETTLED 成员扩展原鉴权私有 `executions:read-batch` 响应。完整可选 `recoveryOwner` 携带 `writerId`、`writerGeneration`、`activationId`、`activationEpoch`；四项均须与已锁定的当前存活已安装 head 匹配。从私有 Hosted publication owner 与已安装 activation 填入，不能来自旧 checkpoint。原六字段 preparation 请求保持不变，不接收 result/grant bytes。这是现有可信私有 Broker 边界中的状态 fence，不是新 credential，也不证明进程隔离。同一事务 Connection 必须先核验原 binding/READY Session、完整成员/resources、当前存活已安装 head 与每条原持久 result/grant，再返回有界的 `result_json`、`native_authorization_json` UTF-8 bytes。这些是数据库保存的序列化 bytes，不宣称保留了序列化前 Worker HTTP 原响应 bytes。未安装的 claim 或旧 owner 不具有读写资格。该响应不给 dispatch，不调用 prepare/execute，不新增公开 selector 或替换 Worker。

现有 preparation reader 继续读取 reference/input/declaration/state。cold reader 必须在写入任何 outcome 或 resolve 成员前，验证整个返回 accepted batch 的原 scope、execution/reference 身份、input/declaration bytes、ordinal gap 与存储 grant 关系。每条存储 result/grant 在解析前限制为 64 KiB，整个 Base64 响应限制为 8 MiB；Hosted 在流式读取响应时执行该限制。在任何 publication、message 或 resolve 写入前，先构造并验证整个修复计划，包括已有 history 身份/parent 链与全部 outcome/message inline 预算。结果/grant 缺失、无效或超限，须在部分修复前拒绝。若所有 receipt 已存在，保留原 receipt-only 恢复路径，不增加该 readback。已有 receipt 仍是精确 `history.messageId`、timestamp、model 与 Parts 的 authority。

receipt 尚不存在时，原随机 message ID 或 timestamp 也尚未耐久建立。合格 successor 使用原 accepted function 身份、首个 model route 与正常 result converter，在首个 atomic outcome publication 加 receipt 事务中建立一次新 history 身份。native commit 独立将结果与原 SQL settlement、immutable grant 再核验。若该事务响应丢失，之后恢复以已提交原 outcome 为 authority；已有 receipt 绝不生成新身份。这项一次性耐久规则不宣称单次 C4 window 已实测重复中断；重复 message/resolve cut 归 C5。

所有原 receipt/message/resolve 完成后，恢复才能关闭保留的 schema2 result history，并进入实际 model2/consumed/settlement/idle 链。原 SQL result/grant bytes、计划 mixed fixture 前两条固定 outcome 身份、working/backup bytes/device/inode、原 Worker request/effect 计数及完整 batch 成员均须保持精确。C4 不新增 execution、tool intent 或文件修改。完整 K2、C8 模型输出恢复、物理退役、安全卷复用与 Linux/云上资格，仍是独立门禁。

新鲜测试计划仅在实际 Main/Broker 返回 final Edit 终态 GET-execution 200 `settled` 及 result，且三条原 SQL 成员均 SETTLED 后，切断该响应交付。不能使用 accepted `:start` 响应或仅 Worker 200 代替。只杀已登记旧 Main/Hosted，保留原 Worker/数据库/文件，等待数据库时钟自然过期，再进入精确原 prompt。实现前，预期 cold acquire 拒绝，且实际 acquire 事务前后所有表/文件不变；更早的原 binding 启动 reconcile 须单独核验。实现后，要求原私有 readback、一次新 atomic final outcome/receipt、原前两条身份保留、实际 model2 包含三个 accepted 结果，且没有 model3 或重复文件 I/O。测试 fixture 证据不能验收物理释放或完整 K2。

受影响 consumer 是专用 JDBC 冷准入、原私有 batch read、私有 Hosted cold receipt repair 与 native receipt commit qualification。普通 preparation/live execution、legacy continuation 保持当前门禁。Java 与 CLI 聚焦回归覆盖 result/grant 缺失/格式错误/不匹配、成员不完整、cancelled/UNKNOWN、已有 receipt 身份与 inline-size 拒绝；新鲜自有 MySQL 观察提供 C4 行为证据。

#### 6.8.5 结果消费前的完整模型输出

状态：提议，C8 实现与验收尚待完成。当前 `model.attempt(output_committed)` 保存 attempt 标记、route/checkpoint ref 与 usage，完整 assistant Parts 却在消费结果后才取得。可见 delta 不能证明完整输出，也不能证明没有新 tool call。对这种仅有标记的旧形状继续拒绝 C8，不能追认为完整输出已耐久保存。

针对无 tool call 的私有 CSI final output，将现有 `model.attempt(output_committed)`、`message.committed` 连同原完整 ChatRecord 与 usage resources 放在同一 native journal 事务提交。保留实际 stream message ID 或首个耐久建立的 ID、timestamp、model、parent 和全部 Parts，包括 thought。消息绑定原 model attempt 与 input checkpoint。两个 event sequence 必须在 authority 的串行 commit 内分配；caller 预先计算会与 activation renewal 竞争。复用现有 message/resource 格式，不另加 output ledger 或 event。Hook、普通 Hosted 和新 tool call 路径保持既有行为。

native qualification 必须明确识别这一种双 event final-output 事务，并独立核验两个既有 body、attempt/route/checkpoint、原 scoped resources、完整 assistant Parts 与零 function call。只有该合格 final output 才允许 assistant 已提交时消费结果。原 results-ready 成员、receipt/outcome、SQL result/grant 与已闭合 schema2 history 保持精确；采用 successor activation 仅改变 checkpoint 许可的 activation 身份。

独立 C8 cold-tail 分类要求该原完整 final output、原成功 model2 attempt/input checkpoint、完整 SETTLED 且未 consumed 成员、原闭合 history，以及现有 scoped expiry/claim/install 证明。私有 text 恢复分支随后直接消费并结算原 turn，提交既有 turn-result/idle 链，返回原 assistant。它绕过 model runner，不新增第三次模型请求、attempt、assistant 身份、execution 或文件效果。正常 live 路径也须识别已原子提交的 assistant，避免外层再提交一次消息。具体 completion 接口须在实现前确定；必须由实际私有 CSI caller 填充，普通 consumer 有回归覆盖。

新鲜 C8 测试只能在实际 atomic full-output 事务提交后、结果消费前切断；仅终止已登记 Main/Hosted，保留原 Worker/DB/文件直到自然过期。要求实际模型请求总数精确为二，原完整 output/Parts/stream 身份精确，一次消费/结算，零重复文件 I/O。仅有 marker、Parts/thought/parent/model/attempt/checkpoint/scope 改变、新 tool call 或未闭合 history 均须拒绝。覆盖 commit 响应丢失、renewal 竞争中的 sequence 分配及普通 Hook/Hosted 兼容。此设计不接受尚未执行的 C8、物理释放、安全复用或完整 K2。

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

### 7.3 最终检查发现的拒绝与历史续接边界

完整 Broker 检查复现一处拒绝边界回归：内存 repository 能通过通用 dispatch 授权
私有有限 payload。保留既有负例，在 claim 前拒绝该路径。私有 dispatch 必须使用
原始 JDBC native 授权；有限 tool 名称本身不能选择或授权它。

显式 Agent gate 也复现一处历史续接回归：无条件 native inventory 校验在续约、取消
或结算前拒绝旧 resource-free 记录。保留原始 parent、Session、live lease、
owner/generation、authorization marker 和不可变 seal 检查。独立历史分支要求
完整锁定关联执行集合，包括 terminal 成员，都保留确切旧五字段 reference，且 SQL
native grant 为空。原始 prefix 不得有 batch、intent、receipt 或 file history；
resource inventory 不得有原生 input、declaration、outcome 或 file-history resource。
该分支的新授权继续拒绝。关联成员的 native grant/reference 或 native resource
阻断此分支，原始执行不变；删去 native reference 字段不能取得降级资格。原生续接
保留完整原始成员和不可变 grant 校验。这些历史 fixture 只验证续接边界，不证明
原生执行或 cold takeover。

### 7.4 当前 main migration 与 child admission 边界

与 main `5ddd43815` 集成保留已发布的 Workspace role V53 和 child lineage
V54。仅 Draft CSI request、activation 和 native grant migration 使用
V55/V56/V57，SQL 字节不变；首个原生候选的 V55 grant migration 现为 V57。
更早未发布编号数据库不自动升级或回填。Root 私有创建保留原 creator/owner actor
字节与 request pin；公开 child admission 在 Service 操作前和 Store 锁定事务内
拒绝 CSI parent。普通 child consumption 仍通过共享 runner，发生在 completed
turn 持久落定之后。Migration 与验证要求见完整双语 lifecycle-main 集成设计。
这些集成检查不开放冷恢复或物理门禁。

后续与 main `e6e2c9efd` 合并，保留其已发布的 V55 channel instance migration。
实际已编译 Flyway schema test 复现了它与未发布 CSI request migration 的
V55 冲突。仅将三个 Draft CSI 文件顺延为 V56/V57/V58，SQL 字节和顺序完全
保持；已发布 V53/V54/V55 不变。全新构建清理旧 target resource，并校验完整
migration inventory、打包字节及截至 V58 的升级序列。更早未发布编号的数据库
仍不支持自动升级。本次 migration 修复不代表实现或验收 C4、C6、C8 或完整 K2。

### 7.5 当前提交的真实冷拒绝基线 B0

2026-10-09 对 `e8f11063463f846ab807764ede8e9aad272204f2` 完成一次全新自有 MySQL 冷重启。原 Read、Write、Edit 三项 SQL success 与 receipt 已持久化；最后 Edit receipt revision 23 已提交、message/resolve 尚未交付时，仅终止注册旧 Main/Hosted，保留原 worker、DB 与文件实例。新 Main/Hosted 使用原 request/session/prompt，等待数据库自然过期后重入。最早 native writer acquire 返回 409 `csi_original_writer_unavailable`；Hosted attach 的 503 `csi_operation_unavailable` 是独立包装结果。

未出现 model2、重复工具执行或新 journal 结果。完整原 execution/grant/result、23 个 transaction、27 个 resource、49 个 reference 保持；动态 schema 为 54 表、699 列，53/54 表在 cut 到 refusal 期间相同，binding 仅发生明确记录的原实例 reconciliation。计数为 1 个实际行为组、27 个 observer 检查、20 个离线谓词；不把后两者累计为新行为组。

原报告和 201 个证据文件已封存。root 独立验证 264 个 source/doc/test pin、4 个 product 和 SDK、44 次 PID/group 缺席检查、11 个关闭端口、原临时目录清理后解除本轮 freeze。本运行提供有界本地软件拒绝证据，不赋予正向冷恢复、目标 Linux CSI、物理释放或完整 K2 资格。随后独立的正向 C1 窗口记录在第 7.7 节。

### 7.6 本地冷恢复候选检查

首个本地候选实现第 6.8 节的 receipt-complete writer claim、successor activation 分段、模型门禁前的原 message/checkpoint 修复与当前 owner mutation fencing。全量 Node build、typecheck、bundle、聚焦 lint 和格式检查通过。首轮 build/typecheck 发现两处 durable-reference label 参数缺失，原失败保留；修正参数后检查通过。CLI 回归覆盖 21 文件，1292 项通过、26 项跳过；Core 回归覆盖 4 文件，158 项通过。新增本地修复测试通过本地 journal 和 mocked Broker 验证原 outcome/message 身份与变化 prompt 字节拒绝，不证明 SQL takeover 或实际 model2。

准确离线 Java 顺序完成 Broker 19 suites/78 tests、Agent 39 suites/778 tests，零 failure/error/skip；强制 package/install 和 Checkstyle/SpotBugs 检查通过。测试后的原 observer 因 standalone SDK 路径错误失败，原错误保留；仅修正离线 package bridge 核验，没有重跑 Maven。root 独立验证 107 个封存证据文件、12 个不变 candidate source/doc/test 路径、1179 个 compiled-class pin、4 个整包 embedded bridge、3 个 installed package bridge 与 8 次 PID/group 缺席检查后释放窗口。root inspector 对同一缺席路径的错误假设也另行保留，仅只读修正。

这些是候选构建与回归检查。本 Codex 会话缺少必需的原生 review workflow 工具，不声称独立 review 或 maintainer approval 通过。独立全新 MySQL C1 窗口及其 C7 子集记录如下。该子集捕获原 receipt transaction（含原子 outcome publication）与 writer renewal 的实际 200，接管后原样重发相同请求字节。这是两个 mutation 谓词；transaction/publication replay 是一个合并谓词。此 inline CSI outcome producer 不使用独立 tool-result-content/page/manifest publication 入口，该入口仍未验收。这些检查不完成全部八个冷窗口、物理退休、安全复用或完整 K2。

### 7.7 有界正向 C1 与两个 C7 谓词

2026-10-09，一次全新自有 MySQL 运行使用干净已提交候选
`6d304d299ff09c920d455bc9562960e39b8c7815`。原混合 assistant 接纳 ordinal 0/2/3、
拒绝 ordinal 1；三份原 execution、不可变 grant、success result 和 receipt 均已持久化。
最后 Edit receipt 提交在 revision/sequence 23；响应在交付前被保留，最后结果消息和
resolve 尚未出现。仅 SIGKILL 已注册旧 Main 与 Hosted；原 worker、数据库、adapter、
provider、listener、runtime、boot/handle 和文件实例一直保留到清理。

原数据库时钟的 58 次只读采样证明 writer 与 activation 自然过期，未通过 SQL 改写过期时间
或提供正向行。新 Main/Hosted 使用原 prompt 的准确字节重入，writer generation 与已安装
activation epoch 均 1→2，原生 journal revision 23→34、committed sequence 23→35。
原 execution 行、grant/result 字符串、三份 receipt 和固定结果身份均未改变。缺失 Edit
消息在 sequence 25 修补，checkpoint 在 26 resolve，原 prepared history 在 27 收口。
第二模型 attempt 在 28 开始，output 在 30 提交，31 消费结果，32 提交最终 assistant，
33 提交 turn checkpoint，34 提交 turn event，35 提交 idle checkpoint。实际 model2
保留原四 call assistant、拒绝缺口和准确 accepted result Parts。模型请求仅两个且均完成，
没有 model3、新 bind/prepare/execute 或重复文件效果；工作/备份 bytes、device、inode
及原五次 mutating worker I/O 均保持。

两份原完整请求 wire buffer 在旧 owner 退出前分别观察到合法 200，接管后逐字节重放。
原 receipt transaction 及其原子 outcome publication、原 writer renewal 分别返回
409 `managed_session_writer_conflict`。每次拒绝均保持全部 54 表每行每列、699 列 schema、
文件和 worker 请求/I/O。原子 receipt/publication 只计一个合并谓词；未出现独立 publication
入口调用，不赋予该入口资格。

正向续接另仅允许已观察的 resource verification 与原 binding reconciliation metadata。
十二份原 resource 的 `last_verified_at` 递增，具有原 tenant/session/workspace 的真实
成功 GET 证据及原数据库时间界限。所有其余原 resource 列、原 journal transaction 和
resource reference 均准确保持。binding 仅改变六项已记录 reconciliation 列；在真实
同源 attestation 顺序和数据库界限下，两项 reconciliation generation 各 +1、record
version +4。这些例外绝不适用于 C7 拒绝。二十九次 observer snapshot 各使用一条自有
MySQL/InnoDB 只读 consistent Connection；其真实 REPEATABLE READ/read-only/autocommit
语义仅赋予 observer 资格，不证明生产 READ COMMITTED 或预热 REPEATABLE READ 竞争。

记录的 compile/producer/offline-audit 三条命令均 exit 0，独立审计通过 237 项谓词；
这是一个行为组，不是另加 237 次运行。root 在解除窗口前独立检查原行/事件、315 项封存
artifact、414 个 source/observer/dependency pin 加 4 个 product pin、3908 个 closing
selected input 和 14 份历史引用。记录的 Node load 与终止时字节均吻合：2123 个唯一
路径含 474 个 prelaunch pin，另 1649 个仅有 load-before/terminal 比较；不声称整个 Node
依赖图事前闭包。原报告 inspector 对 SQL 列名和 Node audit 形状的错误假设均保留，
仅只读修正，没有重跑 producer 或替换原证据。

自有数据库和受限用户已删除，MySQL shutdown exit 0；22 个已注册进程组通过 44 次
PID/group 缺席检查，11 个端口全部关闭，自有临时 data/socket 目录已删除。root 在独立
验证后解除 source/product 观察窗口。

此轮仅接受有界本地 C1 和两个 C7 mutation 谓词。MockMvc transport、合成 Kubernetes/
attestation、Darwin mount/descriptor 适配和确定性 SSE 模型响应仍是限制。其他冷窗口、
独立 publication、生产 isolation 竞争、聚合 DRAINED、物理 writer/后代终止、CSI
NodeUnpublish、原子 RELEASED、安全卷复用、目标 Linux/云和公开 CSI 选择仍待完成。
原生独立 review 与 maintainer approval 也仍待完成。

### 7.8 因观察器协议错误停止的 C6 观察

在 `311b29ef5dec41f0a9da6d57885eade3ecd2e5fb` 上，首次 C6 launcher 因 root freeze 遗漏一个必需源码路径，在 javac 或产品/DB 启动前停止。原 freeze/错误与零资源记录均保留；root 独立解除该窗口后，才签发修正的新 scope。第二次 invocation 运行一个实际 producer：ignored helper 编译 exit 0，producer exit 1，完整 C6 auditor 未运行。

原三条 SETTLED/success 结果与 receipt 在 revision/sequence 23 耐久，final Edit message/resolve 尚缺。已登记旧 Main/Hosted 经 SIGKILL 退出；54 次原数据库时钟采样证明 writer/activation 自然过期。第二个真实 claimant 随后取得 generation 2，实际提交的 200 响应在交付/install 前被 held，再杀死其已登记 Main/Hosted。已安装 activation 仍为 epoch 1，journal revision/sequence 仍为 23，仅四个许可 head 列改变；原 scoped token hash 与所有原 execution/grant/result bytes 保持精确。after-acquire、after-crash 与 pre-drop final 的全部 54 表 snapshot 精确相同。

ignored Worker snapshot 协议仅接受 `/^[a-z-]+$/`，但新增标签 `cold-c6-after-claimant2-crash` 含数字。helper 拒绝该观察请求后退出；原错误、coordinator wait/join 错误和 outer exit 均保留。失败清理 inventory 不能代替缺失的 post-crash 存活 Worker snapshot 或 I/O 计数。尚未观察 claimant2 自然过期、claimant3 generation3/epoch2、实际 model2、消费/idle 与完整 auditor。C6 尚未验收，也不宣称产品拒绝。

root 独立核验 238 项封存 artifact、4407 个当前 selected input 加 4 个 product、4562 个 closing selected input 与 18 份历史 ref 后，解除失败窗口。记录的 Node load 与 load-before/terminal bytes 吻合，事前冻结范围仍具有 7.7 所述有界限制。自有数据库/用户已删除，MySQL shutdown exit 0，21 个已登记进程组通过 42 次缺席探测，11 个端口关闭，自有临时 data/socket 目录删除。修复观察器协议后仍须新鲜完整运行；此次部分观察不能验收 Linux CSI、物理释放或完整 K2。
