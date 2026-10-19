# K2 已结算原 owner：应用切点与最终收尾

[English](2026-10-11-k2-settled-application-cut.md) | [简体中文](2026-10-11-k2-settled-application-cut.zh-CN.md)

[标准结构适配](k2-canonical-schema-port.zh-CN.md)取代原 migration/表/键描述，拒绝旧清单格式及旧数据库；历史验收不能资格化合并候选。
状态：应用实现候选，尚未资格化。私有 generic 组件在 `446e6a93c4d5ce07d9d6091b4431112965e278f7` 通过有界本地验证，该结果不资格化此应用协议。关联 #13395、Draft PR #13526。这是退役交接中的应用部分；物理停止、CSI unpublish、release、卷复用和公开选择仍有独立验收门槛。

## 问题与首条支持路径

原私有文件 runtime 能完成一个 turn，却不能退休该已完成应用。Hosted 拒绝 activation release，SQL live decoder 拒绝 terminal suffix，worker drain 不检查完整库存就固定返回 BLOCKED，通用 Runtime Session release 也拒绝 CSI。原 native continuation 和 binding control claim 仍可修改 DRAINING 原对象。被 catch 的续约失败或空 pending Set 不能证明完成。

首条正向路径从一个完整 settled、仍存活的原 Hosted owner 开始：generation-1 binding/writer、epoch-1 activation、原 bare Pod、未压缩 inline native history，仅 Read/Write/Edit 效果。Pending model/tool round、取消、UNKNOWN result、未解决 read/PUT、不支持的 ledger、替换 owner 或缺失原 authority 均阻断。不发新 model request、recovery activation、dispatch、file preparation 或旧 publication/ACK 来把 pending prefix 变成 settled。普通 deferred_v3 ACK 证据不资格化这条私有文件路径。

## 一个原退休权威

在全新标准结构的 `ma_operation` CSI_RETIREMENT 行上保存类型化 nullable application progress。保持 row.phase 与 identity_json 原字节 DRAINING，保持 binding、holder DRAINING，slot 保持占用及原 active binding 不变。Application format 为 qwen-csi-application-retirement/1。字段为 progress_format、progress_version、progress_stage、settlement_deadline_ms、frozen_request_bytes/sha256、cut_bytes/sha256、finalize_receipt_bytes/sha256。每个字段都有下文真实 coordinator、writer gate、finalizer 或 retry 消费者；不新增第二套 release ledger 或 caller completion boolean。

阶段为 SETTLING → FROZEN → CUT → DRAINED；精确 progress version 分别为 1、2、3、4，SQL authority 与 Hosted status reader 都核对该对应关系。BLOCKED 是保留最后持久阶段的报告条件。原 beginRetirement 中用溢出检查过的 DB startedAt + 300000 ms 固定 deadline，并与 intent insertion、binding seal、holder DRAINING 在原 Connection/commit 持久化 SETTLING/version 1。这是新格式五分钟的 application settlement 预算，与十秒 SQL transaction、三十秒 RPC 上限分别计算。更早的当前 writer/activation expiry 仍有效。旧行保留 NULL progress、不 backfill；缺失、部分、未知、损坏 progress 均阻断此应用路径。Retry 不初始化或后移 deadline。

在每次 Hosted completion attempt 中，后续每个 status response 都必须保留已观测到的非 NULL frozen-request、cut digest，progress version 也不能倒退。响应冲突时，在发送下一退役命令前拒绝。摘要一致的已推进响应可以跳过完成阶段；初始 DRAINED response 仍是只读重试，不 acquire writer。此客户端检查补充 server 的 immutable row 验证，不授予物理释放资格。

原 holder revision 来自已保存 reservation。DRAINING 必须等于其经过检查的精确 next revision，包括后续周期 reserved 4 → draining 5。它与 runtime generation 1、writer generation 1、activation epoch 1 及 application progress version 相互独立。当前 admission 不产生 physical RELEASED outcome。

每个 mutation consumer 在阻塞依赖锁后及最终写入前取得同 Connection 的新 DB 时间；与 deadline 相等即过期。SETTLING 中原 writer/activation/dispatch 的新延期不得超过 deadline；旧 expiry 已超过它时，不用 max/min 算式悄悄缩短或接受。FROZEN 禁止所有新续约。有效 deadline 不恢复已过期 writer/activation。Cut 使用原 writer 与历史 terminal predecessor，不把 released activation 当作 live。Postcut observation 使用不可变 cut/receipt authority，无需 live renewal。

## 现有 owner 屏障与精确准备

在 /session/:id/internal-csi/retire 增加经过认证的 primary-listener、live-session-owner route。按完整 Session scope、原 binding、retirement ID 选择现有 owner，不 attach/acquire 新 owner。它在任何 await 前同步 latch retirement，关闭 attach/text/history，并在排队普通任务实际开始时拒绝；exact retry 返回同一 pending operation，不同 retirement 冲突。Retirement operation 不加入自身等待的 Set，防止 self-join；其它 owner 继续工作。

任务离开 Set 后仍保留失败。必须在已有 then(() => undefined) mapping 和 catch 前保存 authority.renewActivation 的原 Promise<ActivationState | undefined>；owner.renewing 当前是映射后的 Promise<void>，不能区分成功 activation 事实与 no-op。关闭 activation timer，join 原始 renewal promise，拒绝 undefined/no-op 或 rejection。先关闭 HTTP writer renewal admission/rescheduling，再 join 原 renewal promise，保留 grant 与真实 outcome。不调用 stopLocal、seal、assertWritable 或 ensureWriter 准备关闭。StopLocal 在 join 前禁用 requireGrant，可能把成功 renewal 转成被吞的失败。Owner.managed.activation 是安装身份；join 后的当前 expiry 必须取 authority.currentActivation。

仅 join 并核实实际存在的 renewal。没有在途 renewal 时，等待已准入任务后使用当前原 activation/grant，不发起新续约，也不把没有 promise 当成返回 undefined 的续约结果。 关闭原 writer 时也关闭 pending-append settlement 准入。等待已有 renewal 后，先 join 已发起的 acquisition，再检查原 generation；等待 renewal 的 settlement 必须在发起新 acquisition 前重新检查准入。

同步关闭普通 authority admission，在已准入工作 join 后的原 serial 边界内只准备一次 release。若 append 结果仍未确定，在发布 boundary 或编码 release 前拒绝；同时检查 writeFailure/recoveryBlocked、真实 active activation，用当前 committedSequence/lastRecordUuid 构造 boundary body，保留当前 activation expiry，并使用现有 record/marker encoder 与本地 staged-resource store。Release 包含一个 activation.changed event、两个 record、一个 managed-activation-boundary resource。准备不发送 HTTP、不续约、不持久 append。缓存 prepared result，persist 失败重试也不能生成新 UUID/ref/time。CSI 通用 release/close 继续拒绝。

将现有 HTTP commit-body 构造提为实际被 ordinary append 与此准备调用的 private shared routine。Ordinary append 仍先 ensure writer；retirement preparation 使用已 join grant，不调用 ensureWriter。保存完整 UTF-8 JSON body，包含全部 record、resource bytes、ID、time、parent link、digest 与原 metadata。Request 的 latestCheckpointResourceId 为 null；真实 predecessor checkpoint 单独 pin，继续保留在 durable head。

## 私有 coordinator 协议

在原 Managed Session operator authentication 下提供窄 retirement endpoints。POST freeze 接收 format、retirementId 与 canonical base64 frozen body bytes；POST cut 消费同一 exact frozen digest；POST finalize 消费持久 cut identity；GET status 只读。Body/frozen envelope 不含裸 bearer token。原 header 认证并以持久 token hash 核原身份；retry authentication 不发新 grant。Duplicate/unknown field、trailing token、非 canonical base64、超预算 bytes 拒绝。完整但不支持或不一致的持久库存返回 HTTP 409 与 csi_application_inventory_blocked；它不是无效 request body。

Session Store prefix 为 /internal/managed-session-store/v1/sessions/{sessionId}，提供 POST /csi-retirement:freeze、/csi-retirement:cut、/csi-retirement:finalize 与 GET /csi-retirement。每个请求带 exact workspaceId/retirementId；Hosted retire request 还带 tenantId/workspaceId/bindingId，并使用已有 primary listener authentication。私有 application store 负责 fresh bounded transaction，使用同一 configured DataSource、binding/session repository 与 worker HTTP transport；Spring controller 与既有私有 Main 测试 composition 必须调用同一 store，不能以另一套 test-only cut 实现验收。Retire operator 从已审阅原 runtime request 和当前持久 retirement scope 定位，再调用 selected Hosted route，不先 RuntimeAccess.resolve/acquire。这些名称是新增 API 设计，不冒充 baseline command。

PreparedCommitSha256 是未修改既有 commit-body UTF-8 bytes 的 SHA-256；frozenRequestSha256 是持久 server envelope bytes 的 SHA-256，二者分开。Envelope 包含 exact body base64/digest、独立派生原 identity/pin/token hash、exact pre-cut observation bytes/hash；不把 server facts 加进 CommitTransactionRequest，也不只留在 coordinator 内存。Frozen_request_bytes/sha256 保存完整 envelope。Pre-cut observation 绑定 preparedCommitSha256；freeze 返回 envelope hash 后，cut/finalization 才绑定 frozenRequestSha256，避免 observation hash 环，同时精确保留 body 与 server facts。

Server 在任何 terminal write 前冻结完整既有 commit body，以及独立派生的原 identity、writer hash、predecessor head/checkpoint/activation pin 与 worker candidate inventory。在关闭 worker admission 前，bounded planning transaction 先核 original authority、完整 settled prefix，并用 terminal pure proof/已验证 frozen resource overlay 检查完整候选 suffix，不写 terminal。在 SQL 外取得绑定 retirement 和该 prepared request digest 的原 worker pre-cut observation。第二个 fresh bounded transaction 重验全部当前 authority/membership、deadline、候选 exact 两 record/一 resource 和原 observation，再 CAS 持久 FROZEN、exact request/observation bytes/hash。RPC 与 filesystem work 在 SQL 外。语义相同但 UUID/ref/time 不同的 body 冲突。Timeout 保留原 prepared request，重试前观察持久结果。无效 suffix 在不可变冻结前拒绝；cut 仍在唯一写入前独立重验。

Cut 是 TerminalProof 的真实消费者：只接受保存的 request，以原 decoder 验完整 active predecessor，以 terminal 验唯一 release suffix；按原 schema 写 exact resource/ref/transaction，更新 head 并保留 checkpoint，从当前锁定 membership 生成完整不可变 cut，在同 Connection/commit 原子保存 CUT 和 head SEALED。将 terminal write 与 cut 合并，避免额外的持久 ACTIVE-terminal 中间窗口，同时保留此前持久 FROZEN request。普通 commit/generic seal 不获得 terminal permission。保留 writer_id、token hash、lease 字段；SEALED 与 CUT 撤销写权限。

Terminal delta 的 writtenAt 使用库存对 SQL DATETIME 单元的固定 UTC 表示。写入前，在原 Connection 上将实际共享 Timestamp 绑定到 CAST(? AS DATETIME(6))，并以库存相同的 UTC Calendar 解码；随后五个声明的时间单元均绑定同一 Timestamp。这保留 JDBC 时区转换与 SQL 精度，不通过读回当前行来制造期望 delta。writtenAt 是 image 值，不是排序或过期 authority。Terminal metadata 保留严格值与类型验证，并比较 canonical JSON，使解码为 IntNode 或 LongNode 的相同整数值保持相等。

Cut 固定完整 predecessor inventory 与唯一声明的 terminal delta，不把后续合法协议输出与 freeze 前值直接全等比较。Progress version/stage、frozen envelope、cut 与 receipt 输出分别按显式 CAS transition 验证；cut bytes 不包含自身 bytes/hash。Completion 按 predecessor 加 exact saved terminal delta 核 head/resource/transaction，按 saved CUT authority 核 progress；其余每条库存行保持逐值稳定，membership 双向完整。不以宽泛忽略字段列表放过未声明变化。

仅为此真实 cut/finalization/retry consumer 提供独立 terminal-history result，保留完整已验证 predecessor 与一个 exact terminal suffix，检查 history/resource budget，拒绝 release 后每个 suffix。Live history、NativeHead、execution authorization、cold restore、ordinary replay 保持 active-only。Postcut retry 在任何 live assertion 前读取 saved cut/sealed head，返回相同既有证据或冲突，不 acquire、renew、append、ACK。

## 原 Connection、锁序与 writer 收口

所有 freeze/cut/completion transaction 拒绝 ambient composition，使用原 DataSource/target Connection，整体事务截止十秒；query timeout 不超过剩余事务时间。Nonlocking discovery 仅定位。候选 prefix 为 P → R → 完整 sorted slots/bindings → indexed private pin/full request/context → registration → physical holder → immutable intent/progress → head/history/resources/refs → Runtime Session/executions → publication/read/output/secondary inventory。等待后重新检查当前 membership、所有字段和 DB time。锁内无 RPC、独立事务、snapshot authority 或 late parent acquisition；认可前必须实际 MySQL RC/RR 测量此锁序。

在已验证 original prefix 处安装显式 same-Connection progress gate，不放入纯值 Original.requireContinuation。真实生产消费者为 SessionStore renew/commit/blockRecovery/publishToolResult/native read completion；execution compareAndSet/claimDispatch/renewDispatch/requestCancel；RuntimeAccess snapshot RPC 前后；binding claim/renew/release/CAS；owner/worker admission。无 intent 的 READY 保留当前 admission。DRAINING 必须有有效 SETTLING progress 才能做原允许 continuation，并保留不可变 pre-seal authorization ceiling。FROZEN/CUT/DRAINED 拒绝这些 mutation；唯一 terminal write 为 cut 的 exact frozen consumer。

Binding-only control writer 先发现 identity，再在原 binding lock 前进入 P/R/original/progress，绝不在已持 binding 后新增 P。缺失、不可信、歧义 private authority 拒绝，普通 non-CSI control 保留。Immutable sealedBindingVersion、current control record_version、progress_version 分开。关闭 RuntimeAccess snapshot RPC 前的 admission，同时 worker latch，防止晚到请求排入未跟踪 history observation。此前准入 continuation 必须在 freeze 前 join，否则 BLOCKED。

已接纳但尚未完成的 turn 在 beginRetirement 后，可能仍需读取当前 durable checkpoint 来消费已经返回的结果。因此 SETTLING 只允许读取该原 current checkpoint resource，必须以完整 live native prefix 的非 null 原 input 与 epoch-1 activation 证明。保留既有 OPEN→RETURNED/UNKNOWN read 和 delivery-lease 协议，以不可变 sealed binding ceiling 绑定原授权，并要求 delivery expiry 位于 settlement deadline 内。其它 resource、已 settled turn、过期 authority 和 FROZEN/CUT/DRAINED 均拒绝新 read。这种 continuation 不授予新 input、execution 或 model request。

## 完整当前库存

首条私有路径也不支持已安装的 JournalEventTransport。通用 commit 在 SQL 提交后发布 native CSI record，异步外部发送不持有原退役屏障。Private CREATE 和原 request resolve 同时拒绝已启用配置及已安装 port，包括 flag 关闭但安装 custom port 的情况。安装此 port 时，私有 live Session Store 访问与 application retirement 必须在授予 writer authority 或修改 journal/progress 前拒绝；普通 after-commit publication 和 replay 行为保持不变。Retained 只读历史凭据检查不依赖此 live port。Port 缺席只是部署前提，不能证明既往或在途 broker record 已消失；不能仅关闭 flag 就资格化曾向该 transport 发布的 scope。

使用有界、显式原 schema catalogue，不写反射全数据库 framework。每张表明确独立 discovery predicate、sorted key、supported values 或 any-row BLOCKED、producer 与 empty-set insertion fence。Aggregate current evidence 的 MAX_ROWS=4096、MAX_BYTES=32 MiB；超限、不明 association 阻断。 独立的 retained-retirement inventory 保持 32 MiB 解码总量与 48 MiB JSON 总量限制；receipt 和 Session snapshot export 的 128 MiB 解码与 192 MiB JSON 上限不扩大该库存。以 raw original Session/binding/harness/runtime identity 与独立派生 scope hash 做 OR discovery，不只查 live state、不用隐藏损坏/孤儿 child 的 parent inner join。

接受集合覆盖原 Session/creation/config/request pin；registration/holder/intent/slot/binding/control fence；唯一原 logical Runtime Session；全部 execution/native authorization/result/receipt/message/file-history membership；whole journal 与全部 resource/ref；全部 publication operation/object/seal/unmatched ACK；`ma_request_receipt` 中每条原生 `CSI_RESOURCE_READ` 回执；output read lease、PUT attempt、output retirement/retention/quarantine/GC 字段；不支持的 extension/task/action/automation occurrence+command/child/channel/recovery/migration history。正常 private CREATE 的 exact command/scope、值为零的 consumer progress、唯一 session.created public event 是有效创建事实，不授予任意 public history 权限。不支持 secondary row 或 configured provider/MCP/Hook/Shell/approval 阻断首条路径。Global definition 必须 pin 或明确不相关，不虚构 empty collection。

在 journal/resource chain 与其中 embedded snapshot projection 中验证合法 native file_history。首条路径中任何原相关 `ma_session_record` 行（包括 domain=file_history）均阻塞：当前 RECORD_BODIES 没有 file_history projector，只有非空 projected body 才调用 applyRevision。[显式库存附录](2026-10-11-k2-settled-application-cut-inventory.zh-CN.md) 列出当前 33 表/749 列应用目录、独立发现、真实主键/namespace 及 producer gate；该覆盖只有静态检查，仍需运行资格化。

Automation create 当前先 claim command，之后 downstream private Harness 才拒绝。必须在实际 Session-bound claim transaction 内按真实持久 target 增加 current private exclusion，并保留 rollback；service snapshot check 不足。保留普通 command idempotency 与 existing-schedule control。Command schema 无 Session 列，orphan command 要独立 request/key/result provenance 关联；不能把不明 tenant command 悄悄声明为无关。Child/channel bare store 的实际 caller 已拒绝或新建另一 ordinary Session 时，不报告未确认的可达 new-entry 缺口；不支持历史仍独立发现并阻断。

OPEN/UNKNOWN native read、IN_FLIGHT/UNKNOWN PUT 阻断。RETURNED read 要验 exact original identity/completion，不能代表资源成功消费。Generic delivery lease 不存在/过期不能证明 I/O 已 join。Fresh supported lane 要证明已部署 generic exclusion 与真实原 owner/worker barrier；缺完整 authority 的历史 generic activity 不支持。Native prefix、SQL execution row、原 worker entry/result/history/backup 必须双向完全匹配。在另有真实 native consumer 资格化前，旧 publication/ACK 阻断此私有路径。

## 原 worker observation 与版本化 finalize

新增固定 application-finalization contract 的不可变 boot version；不原地升级已 pin boot4/5 worker。Request/response 绑定 original boot、lease、Pod、mount、Session、retirement、frozen digest、cut digest。保留 managed-csi/2 file admission protocol，独立 finalization format 为 qwen-csi-file-finalize/1。旧 worker 报 unsupported，不能造 receipt。

具体新 discriminator 为 handle version 4、boot version 6 和固定 finalization format pin。WorkspaceCsiRuntimeProvisioner 仅在新 original CREATE 选择；RuntimeIdentity 从持久 handle 重建 exact version，HttpRuntimeTransport 的 expected boot/attestation/history 消费同一 discriminator。TS boot/ready parser、worker route allowlist、Java native file-history identity check 显式接受新 contract。Existing handle 永远重建其原 boot4/5 bytes；仅把 authority factory 默认 5 改成 6 不足且禁止用于 replay。不接受 worker 自选 upgrade。

Pre-cut observation 先关闭新 installation/execute/preparation/history/snapshot admission 与 executor start，join 真实 preparation、operation、observationTail、executor/history control、backend/composition tail，保留全部失败。它绑定 retirement 和 preparedCommitSha256，不能绑定尚不存在的 frozenRequestSha256/cut digest；freeze 在 server envelope 保存 exact observation bytes/hash，cut 消费这些事实。枚举真实 executor entry 的完整 result identity/bytes、真实 history、retained backup directory/leaf/FD identity，纳入相关 registry/configured unsupported activity。Fixed zero、allSettled fulfillment、关闭 admission 前捕获的 Set、通用 worker.close 都不资格化。

CUT 后 finalize 在 DB lock 外接收相同持久 cut。Readback 用不可变 cut authority，不调用 native execute/fresh live readback。双向比较真实 local membership 与 cut。任何 close 前，重新读取原 executor 与 composition inventory，要求与已保存 pre-cut observation 的全值一致，包括工作文件 pin、backup membership 与打开的 FD；不一致时缓存失败，不能开始清理。只执行 cut 允许的局部 cleanup，验证实际 backend handle/tail 已关闭，为同 cut retry 保存首次 exact finalization receipt；不悄悄删除或还原 retained filesystem history。部分 cleanup/error/unknown 保留 blocker；replacement worker 或丢失内存 receipt 不当作已完成原 finalize。Listener 可提供 exact status/result/finalize retry，全部新 mutation 继续关闭。

## 原子应用完成与重试

原 receipt 真实合格后，completion 重新取得当前原 authority、exact CUT 与完整稳定 inventory，核完整 receipt/original worker association。在同 Connection 保存 exact receipt，通过窄 Broker repository operation 仅 CAS 原 logical Runtime Session READY→RELEASED，并 CAS progress CUT→DRAINED；每个 update count 必须为一，任何失败全部 rollback。CSI 的 generic Runtime Session CAS/release 继续拒绝。

保持 immutable intent DRAINING，保留 binding/physical holder/slot、原 handle/lease、registration reservation。DRAINED 只完成应用 obligation。观察该已提交 completion 后只 dispose selected Hosted owner 的本地句柄，不另 append/seal。Exact retry 在 current/acquire/assertWritable 前读取 immutable cut/sealed head/receipt 和原 released logical Session。Deadline 不让已提交结果失效，也不授予过期后的新 mutation；cut 后 worker 失败保持 CUT/BLOCKED 和 ownership。

## 受影响组件与验证

候选实现已把生产 application store 接入 Spring 的私有 Session Store controller 和选定的 private Main listener。两者使用同一个 coordinator 和配置的 JDBC DataSource；worker 回读认证保留的原 seed/lease token，并比较完整持久化 request，不走 live admission。worker 发送现有 internal filter 所需的准确原 tenant header。Worker request digest 使用共享 canonical JSON 合同，prepared body、observation、frozen envelope、cut 和 receipt 则保留原字节摘要。

经审阅的 private Runtime operator 支持 `retire <reviewed-runtime-json> <retirement-id>`，核验原持久化退役与 runtime request 后只选择已有的 Hosted owner，不 resolve 或 attach runtime。`serve-retained <reviewed-runtime-json> <port> <retirement-id>` 仅为核验过的已保存 FROZEN/CUT/DRAINED 结果重启原 authority listener，不做 live resolution。原 worker 不可用或本地 cleanup receipt 丢失仍阻断。这些是私有运维命令，不开放公开 CSI 选择。

保存的 canonical SETTLING 库存按固定 catalogue 和完整 typed key 解码。后续每个预期像从它与明确的 progress、三个 terminal row、七个 head cell 和两个逻辑 Session cell 差异重建；当前行不充当预期差异。Final receipt 额外限制为 64 KiB，freeze 在推进不可变持久阶段前，为 terminal row、cut 和 receipt 预留行数与字节容量。应用事务按剩余十秒预算限制 raw prepared query timeout，在执行下一条查询前和提交前拒绝过期。

受影响组件包括 Hosted CSI owner/authority/HTTP store；既有 reservation、新 application store/controller 与 V72 progress；显式 Broker native progress/terminal-history/logical-completion consumer；RuntimeAccess、binding/execution continuation gate；file worker/executor/composer/backend 与新 boot/finalize envelope；双语 handoff 引用；collocated focused tests 和独立 E2E plan。

实现前，用实际构建 Hosted/Main/Broker/worker、专属 MySQL 独立复现缺 owner barrier、续约吞错、native DRAINING writer/control version、terminal live 拒绝、fixed BLOCKED worker drain、完整 current inventory 缺口。确认 global CLI 无 private selector并注明有界 Java/Node fallback。保留原失败、exact loaded inputs、全表值、实际等待和独立资源清理。

候选验收覆盖完整 settled Read/Write/Edit turn 后的 original freeze→durable exact request→atomic terminal/cut+SEALED→actual worker finalize→atomic logical RELEASED/DRAINED，文件效果与无关行不变，selected-owner isolation，task/renewal/metadata/read/PUT/control race，锁等待中过期，empty-set insert exclusion，unknown/orphan/unsupported blocker，每个 CAS rollback，crash/response-loss exact retry，原 active-only/cold/ordinary compatibility 与 全新结构拒绝旧数据库及保留像原字节验证。必须 build/typecheck/bundle、focused Java/Node test/static、独立全值 MySQL 验证及两轮干净 shipping audit。Native review 额度 HTTP403，无结论；保持 Draft 和 maintainer architecture review 开放。

## 后续门槛

来源资格化的 ACK node collector、连续 pre-CREATE runtime/cgroup custody、真实 CSI NodeUnpublish completion、atomic physical RELEASED、monotonic volume reuse、public selection 是后续工作。既有 loongcollector 诊断或对缺失物理事实的签名不能替代来源。申请 privileged deployment 前先准备具体 source adapter/deployment artifact。设计及计划测试都不声称尚未实际验收的应用或物理完成。

## 主干大结果格式兼容

原生执行结果完整读取上限为 1 MiB，HTTP response 保留额外 16 KiB 封装容量。原工具 outcome 允许 64 KiB inline，或使用明确的 `managed-tool-outcome-chunks` manifest 与 `managed-tool-outcome-part` 分片，按原描述重组成超过 64 KiB、至多 4 MiB 的完整 JSON。已有消息分片使用同一库存 owner 校验；两种格式各自保留原 decoder 的数量、长度、digest 与 UTF-8 检查。

Live 库存在一轮真实表扫描结束后重组完整内容，再将其中的类型化引用送入原发现闭包。最终验证只有成功完整 manifest 覆盖的 raw part 可以存在。Retained 扫描先处理 manifest，再处理分片；每个成员核对原 Tenant/Workspace/Session/scope、真实主键及完整 descriptor。缺失、重复、篡改、跨 owner、孤立分片和未声明格式均拒绝。完整重组不会授予执行、writer、安装或物理权限。
