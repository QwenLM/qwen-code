# K2 私有旧 publication producer 边界

[English](2026-10-10-k2-private-producer-boundary.md) | [简体中文](2026-10-10-k2-private-producer-boundary.zh-CN.md)

状态：两处边界已实现并在有界 producer 范围独立验收；完整 K2 仍开放。关联 #13395 / Draft PR #13526。后台 retention 独立提交；完整 K2 仍开放。

## 问题与范围

源码调查识别一个有条件的旧历史窗口：通用 publication producer 可能根据当前 parent 已是私有的持久 publication，授权 claim 并随后写 inline/object/operation/quota。独立真实 Java/MySQL 基线在显式把旧 ordinary 历史重关联到自然创建的私有 UUID 后复现六次 producer 成功；自然 private CREATE 本身不会建立这种旧历史。后续 PUT/read 拒绝不能撤销此前已提交 claim。共同 producer verifier 校验原 runtime、binding、writer 证据，却没有独立当前私有排除；旧 publication-writer helper 的四个消费者也需明确旧路径边界。

在共同 verifier 的 head/publication mutation 前拒绝 unsupported 旧私有 production，在旧 writer 的 head mutation 前拒绝。保留原 non-private deferred_v3、普通 missing-public-Session 及 native file result/receipt 路径。不新增 read/PUT callback、schema、终身 fence、inventory cut、DRAINED、finalize、物理 release 或公开 selector。已有 native 证据关闭的路径仍须保留；不能把共同 verifier 外所有方法都标作缺口。

## 持久目标与事务资格化

在 producerBindingAfterParentLocked，按保存 publication row 的 tenant/Session 调用当前 ManagedLegacySessionGuard.requireLegacyMutation；位置在原 retention R 后、requireLive/head/publication 锁前。保留全部 binding/key/token/epoch/claim 与锁后 tuple 复核。拒绝事务回滚可能的 R upsert 及所有改动，不写 blocker/quarantine 或修补 native authority。只改 tool_profile 而保留 runtime_request_key 仍拒绝。

lockPublicationWriter 的生产调用只有 Store.apply、Data.prepareAdmission candidate/install 与 Admission.commitReceipt。原 lockCsiOriginal 后、requireHeadForUpdate 前增加明确排除。支持的原同 DataSource 事务中，该 helper 已持 placement P 和 retention R；不加更早 P、新连接或全局 lockCsiOriginal guard。Native publishToolResult 与原 Hosted CSI receipt 不调用旧 wrapper。原 resolver 可能更早拒绝损坏 private authority，不能声称每次拒绝均实际观测新 guard。

共同 producer 保留原锁序。实际 Broker HTTP DISPATCH 消费者没有外层 Spring 事务：共同 verifier 的短事务先返回，后续 admitExecution/beginDispatch 才在 repository 事务内取 P，因此 G 已释放。外部任意延长 ambient DISPATCH 未资格化。CSI SETTLE 在共同检查前已持 P；non-k8s SETTLE 在共同 verifier 前早退，由两个已知完成消费者中的旧 writer 独立保护。此处不证明完整 all-writer 锁图。

## 消费者与已有 authority

共同 verifier 覆盖 Data claim/claimScan/beginFinish/install/installFinish/finishScan/heartbeat/recoverOperation 及 producer verification/dispatch；源码调查须封存准确生产索引与原事务。仅在后续 PUT 检查不足以保护 inline production。Store reserve/renew 另要求 native journal tool 证据，私有 closed file tools 不能构造通用 tool-publication journal。Fence/close_not_started 与两阶段 admission 独立依赖旧 writer。

通用 retention read/open/lease/PUT/quarantine 与 RecoveryReader 仍是独立后续工作。Managed Session native owner read 保留原 OPEN/RETURNED/UNKNOWN continuation，不改动。Lifecycle retirement/deletion 已有当前旧路径边界。原 native commit 用封闭 journal 证据拒绝 generic receipt 并回滚同事务，保留此既有检查。完整 membership/inventory 仍需全部独立 writer 的穷尽审计。

## 验证与验收

同步 EN/ZH 设计及 E2E plan 先于独立基线。Engineer 先尝试 global qwen discovery；私有 API 不可达时，明确使用有界封存真实 Java/JDBC fallback。自然 private CREATE 和不可变原 pin 建立私有 membership；注入的历史 publication/operation/handle/binding 明确为 adversarial fixture，不是 native authority。反射是组件 seam。私有准入及每个独立可达 continuation 保持完整 schema 全值精确不变、保留 native 历史/租约，且无新增对象 I/O。伪造 caller/binding tuple 不能替代持久目标；private profile 与保留 pin 两类均拒绝。拒绝传播原语义错误并回滚 tenant upsert。

普通 missing-Session、实际 producer capture/page/manifest/finish/admission/receipt/ACK 对照仍可用。实际支持的 CSI native file turn/result/receipt 精确重放保留原资源且不创建旧 projection 工作。专属完整 MySQL RC/预热 RR 保留 ConnectionID/isolation、当前 TRUE 等待、before/held/after 全值及每个改动 helper 的精确子锁顺序；native resolver 已持的 parent 锁须披露。测试不能证明外部任意 ambient 安全。

Build/typecheck/bundle、定向 producer/publication/ack/native 检查、Java static/package、独立验证与两轮干净完整 diff 审查后提交。Native review 因配置额度 HTTP403 仍无结论，保持 Draft/maintainer 评审开放。保留全部失败观察，仅清理独立登记的自有资源。

## 风险与开放问题

通用草稿尚未实现，因为已知普通 ambient preflight read 后续首次取 P；在该处添加 R→negative G 未资格化，提前 R→P 也没有解决 production P→R 消费者，且 ordinary apply/admission 已存在 R→P。本增量不加入绕过。独立基线已建立明确的旧持久历史夹具；候选覆盖下列晚到 continuation，完整 writer inventory 与 generic callback 仍须单独资格化。此增量不能完成 K2。

## 受影响文件

两处生产变更仅限 packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/store/ToolPublicationStore.java 的共同 verifier，以及相邻 ManagedSessionStore.java 的旧 writer wrapper。同目录 publication、data/admission、acknowledgement 和 native owner 测试验证兼容；额外测试文件取决于基线可达性。不计划修改 runtime-broker 或 TypeScript 生产代码。

## 已执行基线

共同 producer A 窗口记录十条完整观察：自然 private CREATE、六次 producer 成功（inline content、空 prefix/seal、unavailable finish、保留 pin 的 content、缺 tenant 的 content），以及三次既有拒绝（伪造 key、reserve、renew）。全值覆盖62表/827列；Java/wrapper/只读 auditor 退出0，110项谓词通过。明确披露不受支持的 stamped ordinary 历史重关联，其不是 native binding/journal authority。独立 B 基线在真实 installed native writer 下记录24次调用；fence、完整 close_not_started、prepareAdmission 对额外 unsupported 旧历史写入，原 native 前缀精确保留。Reserve/renew 已有拒绝。Native inline genesis 的 generic readResource 是独立对照，没有 native read history。基线记录时，有值的 native read 历史、晚到 continuation race、ordinary/native 对照及候选资格化仍待完成。新增12个本地行为用例在共同 guard 前失败（未拒绝或触发物理 adapter）；保留原 Maven 退出1。共同 guard 后全部128项 publication 单元用例通过，含14个新增拒绝/持久目标对照。Native wrapper 单元先被继承的54表断言阻挡；保留动态完整 schema 快照和必需表身份后，实际到达缺少拒绝的断言并在 writer guard 前失败。两个原退出1均保留。基线记录时新增 wrapper guard 尚未取得最终候选验收。不宣称新增 native authority、物理证明或审查结论。

## 已执行候选与限制

封存候选包含两个 guard 和未改变的已发布 migration history。独立验证保留56条实际观察、3851项记录数据检查、16项额外 native 值检查，覆盖62表/828列。六个共同 producer 缺口及 install/installFinish/自然 heartbeat/过期 recovery 均以 csi_managed_mutation_unavailable 拒绝，完整持久值不变，无对象存储调用。缺失 R upsert 回滚，保留 request pin 仍属私有。

真实 installed native writer 保留 inline publish 成功与精确 replay、owner read OPEN→RETURNED，以及独立 JDBC 故障产生的 UNKNOWN 和租约。旧 writer/fence/完整 close/finish/首次 prepare writer 拒绝时该证据精确保留。prepareAdmission 更早的 generic inline validation 仍临时创建/删除 generic lease；这里证明持久状态不变，不能声称没有 SQL 尝试。第二 install 阶段及 wrapper 独立等待资格化仍 UNKNOWN。共同 producer 在 RC 与预热 RR 均有精确当前 TRUE 父行等待证据：先 R，后父行，尚未取其自己的 head/publication 锁。

普通 missing-public-Session 和同 DataSource ambient 对照成功。新 ordinary fullflow 完成 reserve/PUT/finish/admission/receipt/replay/verification/projection；Java 退出0及错误 class-load wrapper 退出1均保留。全部14个原窗口及失败 observer/audit 退出保留；独立 closing audit 绑定 sources、products、实际 origins 和自有资源释放。新 native file turn/receipt/ACK/物理证明仍 UNKNOWN。producer 证据不验收 generic read 或完整 all-writer 锁图。

提交源码的238项定向 Java 测试通过，failure/error/skip 均零，Checkstyle/SpotBugs 无问题，build/typecheck/bundle 成功。独立报告 SHA256 为3a531ddaa83f22837ef966d8eb087614cbc7702cc44ebd1d35816ae624402eb7；candidate freeze 为3e82cdd164966c879fcab4e50c505b9a5e853ec29cb0c63af25bcea6791f0988。它们绑定 working source/products，不能用 donor HEAD 标签替代。Native reviewer quota403 无 verdict，Draft/maintainer 评审与完整 K2 保持开放。
