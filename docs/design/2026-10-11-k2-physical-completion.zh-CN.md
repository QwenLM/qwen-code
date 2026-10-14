# K2 物理完成与保留的释放回执

[English](2026-10-11-k2-physical-completion.md) | [简体中文](2026-10-11-k2-physical-completion.zh-CN.md)

2026-10-14 已调整首版范围：[常驻 Workspace 设计](2026-10-14-k2-resident-workspace.zh-CN.md)保留各 Workspace 的 Pod/PVC，支持逻辑 Session 切换。本文自动物理退役和卷复用延后；后续实现物理释放时仍须满足这些要求。

[标准结构适配](k2-canonical-schema-port.zh-CN.md)更新当前表及键。下文历史验收仍绑定其原 62 表/847 列候选，不授予本合并结构资格。
状态：私有进度实施候选。已实现 same-Connection DRAINED 验证、不可变 plan、stop intent、持久正常 DELETE attempts 和观测的 source prefixes。封存的 `1169bfd7` 候选已通过独立真实 Hosted/application-to-physical SQL 验收、完整 coordinator 窗口及窄私有 Main plan/status/replay。其 node source 与 Kubernetes 服务明示为协议/API 夹具。该验收仅适用于精确候选，不能资格化后续 Pod 构造变化或 ACK 部署。修订后的 exact host units 已通过自有 Linux 功能测试，runtime/CSI backend 明示为协议夹具。尚无合格 release writer、完整历史 release reader 或 public selector。本设计继续 #13395 和 Draft PR #13526，不授权在 ACK 安装。

## 问题与支持边界

Application DRAINED 关闭原 file handles，释放逻辑 Runtime Session，但 container 可能仍存在，kubelet 也可能仍持有原 CSI publication。复用物理卷必须取得连续的原 task/cgroup 和 publication/unpublication evidence，再原子改变 ownership。API 接受、NotFound、空 target 重试成功或 holder phase 都不能证明这一结果。

支持经过审阅的单个隔离节点，每个 owner 使用 fresh Session/request/slot/binding。保留原 immutable DRAINING intent、application DRAINED receipt 和 PUBLISHED association。Runtime generation 1、native epoch 1 与 shared holder revision 分开。完整 qualification 和 reuse 验收前不启用普通 Spring 或 public selection。

## 原 DRAINED authority

Physical store 在同一 transaction-bound Connection 上从 application store 获取 package-private 验证结果。结果只能在原 lock prefix、Session credential、binding/boot、typed application inventory、保存的 freeze/cut/finalize bytes 和实际 finalize response 全部匹配后私有构造。裸 broker application Authority 或 DRAINED 列不够。

操作独占十秒事务，拒绝 ambient composition。保留 placement → retention → sorted original slots/bindings → private Session/pin/context → alias/physical holder → immutable retirement/progress → native head/history/resources/refs → original Runtime Session/sorted executions → explicit secondary/source/physical catalog。等待锁后重新检查 DB time；source、Kubernetes、worker、protection RPC 均在 SQL locks 外。Physical 和历史读取不续原 writer，也不复用 application 的五分钟 settlement deadline。

## 不可变计划与显式物理目录

全新标准结构定义独立六列 `ma_csi_physical` record：retirement_id、binding_id、physical_key、record_version、record_bytes、record_sha256。当前 closed JSON format 为 `qwen-csi-physical-progress/1`，精确包含 format、retirementId、bindingId、physicalKey、stage、planBase64、planSha256、intent、attempts、observations。阶段为 PLANNED、INTENT、STOPPED、UNPUBLISHED；本版本没有 qualification 或 RELEASED 字段。每个 payload pair 必须同时缺失或同时存在；所有原字段和此前 attempt 不可变，仅允许将一次未知 reply 填入实际结果。

Record 上限 16 MiB，plan 64 KiB，每个 journal prefix 与 HTTP reply 1 MiB，attempts 八次、observations 两次。Checked version 从一开始，每次保存 intent、attempt、actual reply 或 stage observation 递增。同一 Pod resourceVersion 返回已保存 attempt，不再发送，包括未知或拒绝的 outcome。实际 source 已 STOPPED 时，仍可能需要正常删除 Pod，才能触发 CSI unpublication。

Plan 从已验证的原 request、binding、registration/reservation、handle/boot、application baseline/freeze/cut/finalizer 和完整十九列 PUBLISHED source association 派生，固定 source identity/incarnation、node、ARM/BOUND/publication prefixes、Pod UID、原 image/container、target 和全部依赖 cursors。Revision 使用十进制字符串，exact serialized source configuration 用 Base64 保存，unsigned kernel start values 不经过 floating point 或 signed long 转换；原 strict configuration decoder 验证恢复后的 bytes。

当前 nested plan 为 `qwen-csi-physical-plan/3`。其中 `ownershipReleaseInventorySha256` 固定下文三个 ownership row 变化之后的精确 application inventory 期望像。投影从私有验证的 DRAINED inventory 开始，检查原 binding/slot/holder 关联及 checked counters，保留其余所有行、字段、键与 membership；不执行 SQL 写入，也不授予物理权限。第四行 physical progress record 及最终回执需要 qualified evidence，不能预先计算其结果。本候选拒绝已保存的 version-one 和 version-two plan；应使用其原 binary 完成，不改写原 bytes、hash 或 stop-intent 依赖。

Plan 还固定 `historicalReleaseInventorySha256`，它从该 ownership 投影结果派生确定性的原历史读取集合期望像。除共享 physical holder 外，保留所有 ORIGINAL 行的完整内容，排除 OTHER 行与无关 context。原 tenant placement/retention 身份，以及原 workspace generation/storage/config/policy/state 仍被固定；workspace display name 不属于此读取集合。Context 列掩码固定在代码中，以 canonical 字节表示，调用者不能选择。投影保留 catalogue schema、typed key 与原行的每个 cell，包括空的原 request slot 和 released binding。这是历史 reader 的期望像前置项，不是 SQL reader、release receipt 或物理 capability。

读取时除核对已保存 hash，还要求 saved plan bytes 等于已验证 expected plan 的精确编码。JSON 值相同但 whitespace、字段顺序或 escaping 改变，也必须拒绝，不能在重试时据此建立新 plan hash 或 stop-intent 依赖。

Physical 表具有独立显式 typed catalog 和 validator，在同 Connection 的 application closure 之后读取。当前 application catalog 为 inventory/2 的 33 表 738 列，见[标准结构适配](k2-canonical-schema-port.zh-CN.md)。DRAINED 前，companion 必须具有精确六列 schema，并且不存在匹配 retirement、binding 或 physical-key 的行。完整 DRAINED image 验证后，任何 companion row 必须匹配原 plan 与 exact stored bytes/hash/version；foreign/duplicate row 或 schema drift 均拒绝进度。当前 expected image 只允许声明的 insert、append 或一次 pending-outcome replacement，不向已部署 DB 回填 positive state。原 worker-ACK 表在本 lane 中不支持，不提供物理资格；qualified release 需要另外实现的 format 与 validator。

## Stop intent 与精确正常 DELETE

向固定认证的原 source 请求 STOP_INTENT 前提交 immutable plan。RPC 后重新取得共同 prefix，保存逐字扩展原 publication 的 exact prefix/head，并匹配原 retirement ID 和 plan hash。Reply 丢失只能与未变化的原 stream reconciliation，不能通过改变 ARM、source incarnation 或 plan 修复未知结果。

SQL 外读取 exact original Pod，佐证 node/protection/source pins。发送前保存每个 DELETE attempt：ordinal、namespace/name、canonical original UID、新观测的不透明 resourceVersion、exact request bytes/hash。只支持 gracePeriodSeconds=30、propagationPolicy=Background 与 UID/RV 双 preconditions。UID 替换或 Pod 缺失时保留 ownership。

Kubernetes client 必须暴露准备好的 immutable request，保存实际有界 HTTP status 和原 response bytes。发送必须使用 coordinator 已保存的同一份 bytes。HTTP 200/202 仅表示接受请求；404、409、redirect 和其他拒绝结果保留，但不能当成完成。Transport loss、timeout、truncated/oversized body 或 send 与 outcome 保存之间的 crash 留下 ambiguous attempt。后续 RV 产生另一个 attempt，不覆盖原请求或补造 reply；普通 GET/CREATE/PATCH 的错误语义保持不变。

私有命令为 `physical <status|plan|intent|delete|observe> <reviewed-runtime-json> <reviewed-node-json> <retirement>`，选择原 tenant/Session/request/binding，使用保留的原 writer credential 与固定 source configuration，并关闭自有 HTTP clients。Status 与 plan 只访问 SQL，在加载 Kubernetes/source client credentials 之前返回；plan 在事务内将经过审阅的 node 与原 stored association 匹配，且核对先于任何 physical record 的插入或变更。在外部 intent、DELETE 或 observation 操作前，coordinator 在 SQL 外佐证原 node UID/boot/Ready condition 和受保护 volume。没有 release action、Spring route 或 Hosted public selector。已保存 intent 或最终 UNPUBLISHED state 可以返回 durable progress，不再发变更 source 或 DELETE 的请求。

## Source evidence 与部署资格

Physical verifier 要求 saved publication 的 exact raw-prefix extension、未变化的 source identity/incarnation、original scope，以及全部原 ARM/BOUND/custody/publication records。当前 journal/4 reader 要求显式 retained Pod-parent coverage、不同的 parent inode，以及与原 leaf/PID/start tuple 一起保持同 filesystem 的原身份。合成 v3 fixture 和 cross build 不资格化 native parent lifetime 或首次执行。STOP_INTENT 必须绑定 plan；ORIGINAL_STOPPED 必须绑定持续持有的原 task、pidfd/cgroup identities、custody、publication、intent。UNPUBLISH_BEGIN/OK 必须显式依赖该 durable stop 和原 publication，并保持同一 pinned caller/backend chain。缺少 custody/publication 的晚到 intent、BLOCKED scope、gap、replacement process 或变更依赖均拒绝完成。

Protocol decoding、认证 transport 与 ResourceGuard corroboration 不等于 deployment qualification。Qualification 必须消费实际经过审阅的 executable/configuration/namespace/LSM facts、出生即 nondelegated confinement、Pod CREATE/gate/binding/exec/ephemeral/DELETE actor 限制、独占 frontend/registrar/backend 接线，以及未变化的 runtime/plugin/boot。当前没有完整安装 contract 的生产消费者；operator boolean、自签 statement、test fixture 或 journal hash 不能授予权限。实际 consumer 与安装资格化前，progress recording 保持 DRAINING holder，release 关闭。

[原 ACK 部署候选](../../deploy/k2-evidence/ack-existing-cluster/README.zh-CN.md) 提供本地 renderer，以及新隔离 Node 的已知 CSI addon 排除、冷安装和撤销顺序，保留原 DaemonSet 与共享节点。本地表达式求值通过 20 个请求映射案例；实际 API schema/defaulting、执行、policy 修改权限与完整 Pod/host confinement 仍待完成。此组件不能授予物理 capability。

同一目录可为专用 namespace 输出五个 worker 访问守卫：精确的原 gated CREATE、coordinator-only gate removal、明确拒绝额外进程与驱逐入口、只允许 scheduler 绑定到隔离 Node，以及只允许 coordinator 使用原 UID/RV 正常删除。CREATE/gate 规则枚举固定的 API schema，但实际 typechecking、准入执行与 actor 仍未资格化。这些规则不覆盖直接 kubelet/runtime/static-Pod 入口或准入配置写入者，也不单独证明 runtime 从出生起受限；安装 consumer 授予释放前仍须建立这些边界。

Evidence 创建候选将 worker 的 `runtimeClassName` 与 RuntimeClass handler
固定为 `qwen-k2-runc-v1`。实际 Java producer 必须在 gated 与已开 gate 的模板中
设置它；每次读回应拒绝缺失、变更或向非 evidence 模板注入该字段。NodeEvidence
在 ARM 之前以及 gate/publication 的每次核对中读取真实 node.k8s.io/v1
RuntimeClass，要求固定 name/handler，且不允许 overhead 或 scheduling 改写。
离线 CREATE/gate renderer 必须要求同一字段。可部署的 class 对象只选择 handler，
不会安装 handler，也不证明实际 shim executable、effective options、实际消费的
OCI inputs 或出生即 confinement。授予任何物理 capability 前仍须完成这些安装与
生产者 consumer。

## 原子释放与单调计数

最终同 Connection 事务验证完整 original application/physical image 和 qualification，再精确改变四行：

| 行                       | 唯一允许变化                                                        |
| ------------------------ | ------------------------------------------------------------------- |
| 原 physical record       | RELEASED、checked version+1、immutable final receipt bytes/hash     |
| 原 runtime binding       | binding_state=RELEASED、checked record_version+1                    |
| 原 request-specific slot | active_binding_id=NULL，保留 last_generation                        |
| 原 physical holder       | csi_phase=RELEASED、checked csi_revision+1，只清六个 CSI owner 字段 |

六个字段是 csi_reservation_id、csi_registration_key、csi_registration_revision、binding_id、runtime_generation、csi_provision_request_id。保留其余所有 bytes，包括原 seed/handle/lease、binding timestamps 与 stop/loss/drain evidence、slot identity、holder maintenance/protection，以及 immutable intent/application/source rows。Runtime Session 已在 application completion 释放，不是第五次写。每个 CAS 必须影响一行；overflow、timeout、unexpected image 或任一 CAS 零行全部回滚。不能放宽 generic sealed-binding CAS；terminal binding/slot write 前，只有完整实际 validator 能 mint 窄 private physical capability。

Shared holder 按 RELEASED%3=0、RESERVED%3=1、DRAINING%3=2 与 MAX=9007199254740990 转换；后续每个周期都使用实际保存的 revision 和 checked increments。

当前候选只接纳初始 ownership 周期，即 revisions 0 至 2。独立仅 store 的 H2 fault test 复现旧缺口：人工注入 RELEASED revision 3，全部 retirement/physical proof 表仍为空，却变成 RESERVED revision 4。后续周期的 holder 读取现会在 reservation、replay 或 alias registration 写入前拒绝。counter 算术仍已泛化，但非零 released counter 不能代替 qualified historical outcome。只有完整 historical validator 与 qualified release writer 一同完成时，才替换这个临时门槛；它不代表成功实现复用。

## 历史回执与下一 owner

首个历史 SQL 组件在明确只读的 REPEATABLE_READ Connection 上复用生产 native
journal 语义。从实际 SQL row 取得原 binding facts，包括真实 DRAINING 或 RELEASED
状态，无锁读取原 genesis 到 terminal 的完整链、resources、refs 和 SEALED head，
不检查已过期 writer lease。还要求实际 immutable DRAINED retirement 与 frozen
bytes、原 seal/registration/handle association、完整 execution allocation 与
native receipt，并核每份 saved grant 的 checkpoint、prepared reference 和原
installed context；与 live 路径共用生产语义检查。历史 seal 读取排除 shared
holder；live 读取保留原 holder 检查、locks 与 authority。返回的 terminal
proof 仅是 native 语义结果；receipt replay 或 reuse 前仍须完成 application、
固定 membership、credential 与 qualified physical outcome
校验。本组件不授写权限，也不会独立开放 historical 或 public selector。

配套 application 组件重新检查保存 baseline 的 typed association 与 native membership、closed frozen envelope 与 commit 编码、完整 pre-cut worker observation、精确 cut/finalizer，以及重建的 released history image。使用真实 RELEASED binding facts，不构造 live authority。保留的 reservation、handle 和完整原 lease identity 使用与 live producer 相同的 serializer。非法或溢出的 settlement timestamp 返回稳定的 identity unavailable 错误；时间算术成功不授予后续历史资格。保存的 ORIGINAL 行不能在固定 context 表之外重标为 CONTEXT；直接原 identity 和已声明的 JSON 引用不能藏为 OTHER。固定原 identity 集合只构造一次，OTHER 行不会播种 baseline 校验。嵌套 JSON 解码只适用于实际 retirement identity 根级的 resource-handle 字符串与 native tool-input wrapper，不按相似字段名解码任意业务内容。

固定主键 reader 与 live 路径共用 typed decoder，在只读 REPEATABLE_READ Connection 上检查全部 schema，包括空表。按完整 typed PK 绑定查询，比较原行全部原始值和三个固定 context masks，不读取 shared holder 值。SQL 与语义处理共用组件十秒期限。独立 credential helper 保留原 bound policy、token grammar 和 constant-time retained-hash 检查，不发 SQL、不加锁、不续租。这些组件尚未接公开 route 或 release/reuse consumer；完整额外引用 audit、scoped binary/protocol candidate 解码、外层 fresh transaction、immutable physical plan/outcome 资格化与生产接线仍须完成。固定主键或凭据 unit tests 成功不授予历史 receipt 资格。

Release 后 live application guard 无法读取旧回执：原 slot 已清空，shared holder 可能属于新 owner。增加 persisted-workspace/original-retirement read route，使用原 Session/tenant credential 和保留的 writer-token hash，在有界 snapshot 中只验证声明的 immutable original historical read set 与原 released delta，逐字返回已提交原 receipt。不发 source/API/worker RPC，不 acquire/renew，不新增 evidence，不写任一 owner。

历史验证保留 original intent/freeze/cut/finalizer、PUBLISHED association、physical plan/attempts/proofs/qualification、原 released binding/slot、terminal native rows 与原 Runtime Session/executions。验证必要的 placement/retention/context identity，但不将 current shared holder、无关 context 或 new-owner bytes 与旧 global snapshot 比较。损坏或不支持的 retained receipt 拒绝重放，不从当前 volume observation 重建。

使用新建的十秒只读 REPEATABLE_READ 事务，全部读取在同一 Connection 上，不使用 FOR UPDATE，也不初始化 context。不能放宽 live application authority 使其接纳 RELEASED：该入口要求原 slot 仍 active，而其 physical catalog 有意包含全部同 physical-key 行。历史 companion query 改按原 retirement/binding 定位，后续 owner 的 companion row 不得变成原历史行。复用固定 typed catalog 与 decoder，即使期望空表也核 schema；读取完整原 key 和强引用闭包。只查期望 key 无法发现新增 execution、native tail 或孤立 ref。共享 physical key、volume marker、tenant/storage，以及没有原 Session 的 scope 不能作为此闭包的根；锚定原 scope 的未知或矛盾引用仍拒绝。

Retained writer hash 必须在 frozen baseline head、frozen envelope、terminal transaction 和最终 SEALED head 中一致，再通过同一 credential policy 与 constant-time hash 比较匹配所提供的原 token。比较固定 history image 前，先重建完整原 application/native/finalizer 语义；image 算术本身不能验证 receipt。公开重放与内部旧 lineage 分类共用结构 validator，凭据层不同。内部分类不向新 owner 索取旧 writer token，也不返回旧 receipt 或秘密。

下一 owner 的 live inventory 必须在 generic physical-key/JSON mention expansion 前分类旧 lineage。只有完整验证的 immutable qualified RELEASED outcome 能确定 historical/OTHER membership。保留旧 proof rows 于 explicit catalog，不忽略它们，也不接受 phase flag；覆盖旧 retirement/source/binding/slot/execution/native rows 与跨 tenant aliases。Proof 缺失或损坏阻断复用；新 owner 获取 fresh reservation、ARM、Pod、custody，不能借任何旧 proof。

复用还须验证 current holder 精确等于最新 qualified released outcome，包括 checked counter 和六个空 ownership 字段。在取得写锁前发现候选历史 tenant，按确定 tenant 顺序获取 placement/retention roots，再按声明顺序锁 slots/bindings/aliases/holder/proofs，并重新核完整候选集合。不能持有新 tenant 的 physical holder 后再获取旧 tenant 的 placement 锁。公开历史 snapshot 独立于这些写锁。完整 consumer 与四行 writer 实现前，保留初始周期门槛。

历史 candidate scanner 使用同一固定 catalogue 和 typed decoder。第一类查询组合完整 expected PK 与精确原 identity predicates，任何 expected 之外的命中行均拒绝读取。第二类查询覆盖所有已声明 JSON 或 protocol-blob carrier，包括 foreign owner，不使用原始字符串子串预筛。两类查询按唯一完整 table/PK tuple 及未投影原始 bytes，共享 4096 行、32 MiB 和十秒预算；重复读取同一 tuple 必须保持全部 bytes 相同。共享 volume、alias 和 tenant/storage 不播种 predicates；只有仍含原 owner 强引用时才读取 current shared holder。Expected history 固定不变，candidate 不增加根或原行。未知 carrier format 在具体 owner-scoped decoder 实现前仍是 blocker。Source prefix 先验证整条 stream，再选择自己的 arm，已完成的先前 cycle 是被动历史。Frozen baseline 同样需要具体 carrier owner 检查，才可将其中 OTHER 行视为被动快照。

当前 scanner 候选与 baseline 验证共用一次构建的 immutable original reference map。Execution-call 与 idempotency hashes 只取已验证的原 execution 行；idempotency predicates 限于声明的 execution 表。Native journal records 验证保留的长度、digest、identity encoding 与 Session owner。Inline native resources 验证完整 scoped owner 与声明的 metadata。消息复用生产 message reader，包括 same-scope manifest 查询、按序重组与拒绝未被 manifest 覆盖的 parts。Source configuration 拒绝缺失、null、小数或字符串身份数字，同时保留完整 unsigned 64-bit 值。Publication objects 使用原 binding contract 与声明的 slots；result、page 和 manifest 复用生产 schema reader。声明为 opaque 的普通输出可存于外部，但外部结构化载荷仍是 blocker。Foreign frozen-retirement payload 使用下述 configured owner reader；不支持的 owner 阶段或 physical companion 仍是 blocker。这些检查属于实现候选，不是完整历史或物理资格。MySQL 查询请求 streaming rows 与剩余 query timeout；组件测试不能证明 driver 读取或 cursor close 的硬性期限。

Resource-read UUID 从原 read 行固定取根，其 read-lease 别名只适用于声明的 output read-lease 表。Execution keys 也保留各自 producer 的 namespace：managed result 使用 framed execution-call hash，publication writer 使用 raw UTF-8 execution-call hash。Publication binding identity 使用生产 canonical binding digest，而不是 raw JSON digest；JSON property order 的变化不能产生另一 binding identity。这些检查不将无关 runtime lease、局部 resource 或 transaction ID 升为全局根。

Saved-envelope 验证在接受重试前，还会重放自己 owner 的 typed native baseline。每个 journal transaction 必须属于精确 tenant/workspace/Session，组成连续 prefix，保留 record 长度与 digest，所有 resource 必须通过同一 scoped row 和对应 journal-revision ref 解析。生产 genesis、transaction、activation 与 continuation parser 重建 predecessor；共用 prepared-terminal decoder 将未提交候选的 framing、精确 boundary ref 与 bytes 和该 predecessor 对齐，live preflight 也使用同一 decoder。随后保存的 worker observation 必须通过完整 worker matcher。这里只以数据验证保存的原 prefix，不续租、不授写权限；它补充 foreign frozen owner consumer 所需的 prepared-proof 前提，不授 release/reuse 资格。

执行 grant decoder 也与已有 SQL reader 共用。历史数据入口要求 authorized binding version 严格早于封存版本，execution 属于原 owner，grant fields 完整且封闭，原 intent/prepared ref 精确匹配，并核对调用方提供的原派发 checkpoint 在 retained prefix 内及 identity/context/installed context 一致。文件 batch 的 prepared 必须早于该派发 checkpoint；JSON 类型错误在 map 转换前明确拒绝。这个 decoder 本身不证明 checkpoint 唯一性、execution 完整成员关系、owner 的真实 context 或 SQL 引用闭包；后续有界 owner reader 必须提供并验证这些事实，才能开放 foreign frozen 分类。

内部 application reader 现在自己新建只读 REPEATABLE_READ 事务，拒绝 ambient transaction 及不属于所配置 DataSource 的 Connection。先按真实主键读取完整 typed retirement/binding rows，以有界 row/byte decoder 解码，再在同一 Connection 上通过已有 snapshot repository 解密真实 binding。原 tenant/workspace/Session 和 retained writer credential 必须匹配。事务开启、owner 读取、解密、application 语义和最终 candidate audit 共用一个 elapsed deadline；最初读取的两条 owner rows 必须与最终固定 image 中的完整行一致，重复读取不能扩根。目前它仍是 application 组件，尚未接生产 route 或 qualified physical-outcome consumer，也不会自行返回已授权的物理回执。Foreign frozen carrier 归属属于有界实现候选；其完整验收以及 release/reuse 资格仍未完成。

最初的 typed owner 读取与最终 candidate 查询现在复用一个 scanner 实例，共用完整 key map、整行原始 byte budget、row count 和 elapsed deadline。已经读取过的 tuple 在后续读取中不能变化，重复 owner rows 不重置也不重复增加预算。固定的原 reference map 只在 image audit 开始时安装一次。Configured reader 现在从同一组已完成有界整行检查的真实 ResultSet rows 解码实际 execution DTO，保留完整主键，复用 native member、receipt 和 grant validators，不再使用旧的 partial native SQL helper。只有完整 fixed/strong-reference image 匹配后，才核对 prepared native proof、原 resource 发布与 revision 关联、从已重放 owner prefix 重建的唯一 dispatch checkpoints，以及真实 installed grant context。旧 helper 仍是独立组件，其此前测试不授完整历史或物理资格；新 consumer 也仍需完整正向与故障验收，才能支持 foreign frozen 分类或已授权回执。

Configured foreign frozen-owner consumer 现在仅支持实际 generation-one DRAINING binding、drainRequested=true，以及保存的 FROZEN/2、CUT/3 或 DRAINED/4 application progress。它在父读取的同一 Connection 上取得实际解密 binding，验证 retained identity、baseline、prepared prefix、worker observation、存在时的 cut/finalizer、完整 members/receipts/grants 和 installed context。Owner image 保留完整原 holder，以及三个固定 context masks；窄 fixed-key/strong-reference 查询比较该像，不递归扫描 carriers、不改变父读取已固定的 roots，也不扩大其 expected rows。父读取仍用自己的原 roots 审查 active envelope、prepared records、observation、cut 与 receipt；仅已证明 owner 的 OTHER baseline rows 作为被动快照。

DRAINED 前，consumer 要求 retirement、binding 和 physical key 对应的 physical companion 域具有精确 schema 且为空，所有整行读取共用 scanner 的预算与时限。DRAINED 时支持没有 companion，或者通过 UNPUBLISHED 验证的唯一原 progress record。Expected plan 由完整保存的 DRAINED image、实际 binding/intent/payloads 和已验证的不可变 PUBLISHED source 重建，与 live 私有 authority wrapper 共用同一个数据 producer。字段插入顺序、编码、全部 plan/3 digests，以及 live locks/credentials/authority 保持原样。Record 必须具有逐字相同的 expected plan 和 closed progress metadata，active payloads 不能引用父读取的原 roots。PLANNED 保持 version one 和空 intent/attempts/observations；后续记录复用 live decoder 的完整写入计数、prefix 与 attempt 校验。

Physical declaration 独立于 33 表 inventory/2 持久 codec；同卷 foreign companion 使这一有限范围成为 unsupported，不进入 application image，也不判为额外 application 行。新 companion reader 复用 production progress decoder 校验 INTENT/STOPPED/UNPUBLISHED，保留精确 plan、写入计数、普通 DELETE bytes 和完整 source-prefix 依赖。Decoded plan、source configuration、request 和观测的 JSON reply 均检查父读取的固定 roots。空 API reply 没有结构化引用；非空 reply 必须是 strict JSON object，否则仍是 unsupported。Reply 不证明停止或释放。完整 stream 验证后，仅当前已验证 source scope 是 active，closed source grammar 的全部 owner 引用都位于该 scope；之前完成的 arm 属于 passive history；含后续 arm 的 prefix 超出这一有限 owner 范围并拒绝。RELEASED foreign owner 和原 qualified physical outcome 仍未实现。

保留的 legacy DRAINED tuple 使用 source protocol/1，而此 consumer 要求/4，三个 ordinary callback controls 因而在 saved-envelope 验证前按预期拒绝，不是正向验收。组件 SQL/projection/minimal-plan codec 测试不证明完整正向 frozen owner、当前 producer plan，也不授物理、释放或复用资格。当前格式的 no-companion 和 sole-PLANNED owner 控制使用显式派生数据，已通过独立 configured callback；封存的 78bd01 候选随后通过独立 global/active 阶段数据验收，全部物理资格仍待完成。

Configured application 组件现在还在同一个只读 snapshot 和共享预算内，扫描完整独立六列 physical table，包括空表 schema。Candidate 不播种父读取的 roots；已知 foreign record 必须解析到真实 retained owner，并通过同一个非递归 DRAINED/sole-progress consumer。未知 owner 和原 qualified outcome 仍是 unsupported，原 physical record 不判作额外 application 行。最终报告的 accounting 包含这些完整 raw rows，以及重复 owner/member 读取，重复行不重复计费。这一 global candidate coverage 属于实现候选；封存的 78bd01 候选通过当前格式 owner/global 数据控制，完整 qualified physical 闭包仍待完成。

Saved-prefix reader 将 activation_head_revision 与完整 predecessor journal revision 比较。Live producer 在普通 commit 保留已是 current 的 activation columns 时也会推进这一 freshness stamp，因此它不等于最后一次 activation event revision。完整 replay 独立核 activation identity、worker、epoch、expiry 和 checkpoint。当前格式派生控制保留原 native bytes，复现了原错配（最后 activation event 为 2、当前 head 和 stamp 为 47）。修复后，独立 same-DataSource 的 no-companion 与 sole-PLANNED callback 通过，返回 baseline bytes 精确相同，查询全部关闭；完整 26 字段 plan 也与独立 byte oracle 相同。这些都是显式派生的普通数据控制；封存的 78bd01 候选随后通过 global/active 阶段数据验收，全部物理资格仍待完成。

Native input resource 是非空 text blocks 数组，而非 object。Scanner 现在与 native input admission 共用有界 inputBlocks decoder：strict UTF-8/JSON、最多 64 KiB、精确 type/text 字段、type=text 且文本非空。Literal input text 不播种 owner references。独立 global bootstrap 使用原样的 81-byte input resource 复现了原 object-only 拒绝，producer fixture regression 也在修复前复现。Unknown fields/kinds、空或错误 block、duplicate keys、trailing tokens 和超限 bytes 仍拒绝。新封存的 78bd01 候选通过 PLANNED、INTENT、pending/replied DELETE、STOPPED 和 UNPUBLISHED 的十二个实际 owner/global 控制，以及 24 个输入格式、43 个故障和四个完整 raw 预算控制。Source、stop/unpublish evidence 与 API reply 均明示为派生数据；没有执行或资格化完整 readApplication、RELEASED outcome、installation、物理释放、复用或公开选择。原 47 条 native transaction 与 body/pre-cut bytes 保持。

## 实施与验证顺序

Ownership 投影已独立编译，并使用此前封存的真实 application DRAINED tuple 验证：投影前重建的 digest 与原 production plan 完全一致。62 表、847 列、236 行中，精确改变三行、十一个单元，其余字段、键、membership 以及已释放的 Runtime Session 全部保留。独立 Java 覆盖 64 个不同 image 案例，并另用独立 binary codec 比较。另一个四案例 codec probe 复现了原实现接受 whitespace 改变但 JSON 值相同、重算 hash 匹配的 plan bytes，随后确认精确字节修复会拒绝这种变化，原 control 仍有效。该 ownership 投影 revision 的 Java 定向验证通过 82 项测试及静态检查。这些结果只覆盖 image 数学与该 plan-byte 修复，不授予 live Store 事务中的 plan/2、任何物理释放、历史重放、复用或公开选择资格。

封存的 `1169bfd7` 候选独立验收覆盖 21 个真实 MySQL Store 窗口、11 个使用实际认证 TLS source client 和实际 Kubernetes HTTP client 的完整 coordinator 窗口，以及三个原 Main plan/status/replay 进程。实际 Hosted 文件工具和原应用退役先生成 DRAINED，再推进物理进度。完整 typed 比较确认其余 63 表不变；真实 physical CAS 零行导致整个事务回滚。未知 DELETE 保留 attempt，同 RV 的 coordinator 重试新增 DELETE 为零，替换身份拒绝，后续 source observation 保存 STOPPED/UNPUBLISHED 而不释放 ownership。Status 与 plan replay 是 SQL no-op，零新增 RPC。Observer 原失败保留，分别用后续 attempt 修正。Source identity/publication 与 API 服务仍是夹具；这些检查不授予实际 ACK stop/unpublish、合格 release、复用或公开选择结果。

1. 实现准备好的正常 DELETE request 与 exact observed result，保留普通 API 语义。
2. 增加 same-Connection DRAINED extraction、physical catalog/plan、fixed-source intent 与 source-prefix 验证。Private coordinator 发送 DELETE 前先实现 durable attempts/outcomes。
   在 immutable plan 中固定并验证三行 ownership 投影，覆盖全部不变 bytes 比较及 counter exhaustion；这些检查不授予 release writer 资格。
3. 实现并资格化实际 installation/admission/confinement consumer；准备原 ACK isolated-node 的具体 artifacts 和撤销步骤后，再请求 privileged 安装。
4. 配套增加窄 four-row writer、retained receipt reading 和完整 release-proven historical classification，保持 default/public selection 关闭。
5. 验证实际 DRAINED tamper 拒绝、early/foreign source evidence、unknown/replaced DELETE、persistence crash windows、全部 four-CAS rollback、counter cycles/overflow，以及 final reply 丢失 → 跨 tenant 新 reserve → 旧 receipt bytes 相同且零 RPC/新 owner 写入。
6. 在获准的原 ACK lane 资格化 actual artifacts，完成 normal stop/unpublish/release/reuse。Public selection 启用前完成 required checks、两次 clean full-diff audit 和 maintainer review。

本地 API、SQL、Linux process fixtures 只支持声明的边界。原 ACK addon exclusion、实际 LSM/Pod admission、driver 接线尚未解决，不能由本地通过推断，也不能转移其他 artifacts 的资格。
