# K2 私有通用 read、PUT 与 callback 边界

[English](2026-10-10-k2-private-generic-retention.md) | [简体中文](2026-10-10-k2-private-generic-retention.zh-CN.md)

状态：实现前独立复现基线，并修复两项实测回归后，通用路径实现已按准确固定 Java 源码完成有界独立验收。关联 #13395、Draft PR #13526，完整 K2 与 maintainer 架构评审仍开放。

## 问题与现有行为

通用 resource reader 建立通用交付租约、验证 bytes 并更新 last_verified_at，却没有排除持久私有 Session。通用 publication stream、PUT admission 有同样缺口。既有 ReadLease.check 依赖内存身份和旧 SQL lease，close 只按 ID 删除；PUT completion 写 UNKNOWN/RETURNED，不重新资格化当前 publication/attempt。Quarantine/abandon callback 虽锁 publication，却不检查其当前私有 parent 或复核完整目标 tuple。

Native owner reader 已使用独立原 authority 与持久 OPEN/RETURNED/UNKNOWN 历史，通用路径不能替代。仅修改 profile 而保留原 request pin 时，历史仍是私有。

## 目标与范围

在新 lease、metadata 写入或物理 I/O 前拒绝 unsupported 通用私有 read/open/PUT admission。独立拒绝旧私有 lease check/cleanup、PUT completion、quarantine/abandon mutation，保留每个私有值。资格化真实持久 publication/object/attempt 或精确保存的 lease hashes，不能仅信 caller JSON/claim memory。

保留普通 missing-public-Session、资源验证、原 non-private deferred_v3 publication 及支持的 ambient 事务行为。已退休普通 Session 仍可清理旧 lease、结算已开始 PUT。后台 collector/quota 独立；此增量不新增 schema、native reader/publication 权限、application cut、drain、finalize、物理 release 或公开 selector。

## 资格化与事务锁序

使用原同 DataSource 的 TransactionTemplate，加入支持的 ambient caller。每个独立 admission/check/close/completion 开始或加入短事务：发现持久目标 → retention tenant → 当前 FOR UPDATE TRUE exclusion → 该操作必需的 head/publication/lease/attempt 子锁 → 精确 tuple 复核。私有语义拒绝抛异常并回滚可能的 tenant upsert；不晚取 placement、不换 REQUIRES_NEW connection、不全局改 lockSession/requireLive。

通用 resource metadata 使用自己的参与事务：head/grant 和当前锁定 resource 读取前先 R→G，再完整校验 resource scope/storage 和执行 last_verified_at UPDATE。Standalone lease 准入短事务已经提交时，仅该准入不足以保护后续 metadata。只将已验证 resource 快照返回给后续 I/O，不把 standalone SQL 事务扩展到 I/O；原 scope/credential 检查仍必需；通用 lease admission 还独立排除私有。Owner-native reader 及其直接 same-UUID lease completion 不实例化通用 ReadLease，保留原 continuation 路径。

Store.requireEvidence 真实在 apply 原事务中、已持 retention tenant、原 placement/parent 和 head/publication 后调用通用 reader；exclusion 复用已持域，不能在子锁后新增 placement parent。独立 ReadLease.check 也不能先取 TRUE parent：失败后的 cleanup 可能在同 ambient 事务首次取 tenant，产生反向边。因此 check/close 均 retention tenant → 当前 TRUE exclusion。

支持结论限定真实同 DataSource wiring 与已知消费者。已持未知子锁 caller、错配 manager、raw promotion、未来 same-ID reassociation 不能凭方法名被资格化。独立完整 schema RC/预热 RR 须保留精确 connection、isolation、held-lock 观察；源码不能证明完整部署锁图。

## 准入与持久身份

read(String/JsonNode) 在 head 锁与 lease INSERT 前排除当前目标。readPublication 在 admission TransactionTemplate 外发现真实 tenant/workspace/Session tuple，再在该事务的 R→G→head 下锁定并完整复核原 publication 后发 lease。独立调用的目标发现不能在等待 R 前建立提前的 RR read view：独立 MySQL 对照已复现将发现移入 template 后，普通退休提交仍会新增 lease。恢复原快照位置并保留完整锁内目标复核；不为普通 readPublication 增加新的 retention-state 限制。任意已预热 ambient 快照仍不在资格化声明中。

每个既有 lease.check 当前资格化其内部原 tenant/Session，再核对持久 ID、tenant_key、session_key、retirement generation、expiry。Close 锁精确 lease，拒绝 hash tuple 冲突，DELETE 包含全部身份 predicate。私有旧 lease 不变；普通 expired/retired lease 仍可删除，普通 absent lease 可幂等 close。内存 closed latch 跟随事务完成：SQL 成功后才临时标为 pending，并通过 afterCompletion 在 rollback 或未知结局时复位。参与 REQUIRED callback 返回不等于 outer commit；private 或 SQL 拒绝保留可重试 latch。验证 close→outer rollback→close 能删除恢复的原 row。该 latch 不是 native read completion 证据。

Check/close 取得 R→当前 G→精确 lease；它们不读取或修改 journal head，因此省去此次新增的冗余 head 锁。Admission/publication/metadata 保留 head 锁。Check 在取得精确 lease 锁之后，用一条语句同时读取数据库时间和原无锁 retirement 结果，保留锁后 expiry 时点、不新增 retirement 行锁、不减少任何物理交付 guard。实际 8 MiB HTTP 下载复现 442 次 check、3408 条语句，而原代码为 750，超过不变的 2800 上限。降低查询开销后必须让全量及 4096-byte adapter read 的原测试通过，不能缓存 check、修改 guard 时点或提高阈值。

PUT admission 发现真实 publication，在 head/子写入前资格化，再复核完整 tuple/caller key；requireLive、PINNED 保留为准入条件。独立调用在物理 PUT 前提交一个新的 IN_FLIGHT attempt；既有支持的普通 ambient 路径可能跨 I/O 保持 caller 事务，本增量不为其新增 fresh-boundary 语义。

每次 completion 独立发现真实 attempt 的 scope/publication/object key 及 publication 当前目标；资格化后锁 publication/attempt，和准入身份逐项比较，仅将自己的 IN_FLIGHT attempt 结算 UNKNOWN/RETURNED；更新零行必须拒绝，不能静默成功。Completion 不新增 requireLive/PINNED：I/O 中普通退休仍保留原完成语义。新 retry 成功不能解决另一 UNKNOWN。私有拒绝保留旧 attempt；成功路径资格失败必须传播，阻止随后 catalog install。

SQL 排除不能撤销已准入旧物理 I/O；冻结 IN_FLIGHT/UNKNOWN 仍是 blocker，不证明物理完成或 writer 停止。

## Cleanup 与主错误

lockRetainedPublication 当前资格化真实目标，锁后复核 tenant/workspace/Session/scope/publication，保留 PINNED/RETIRING 条件；仅覆盖其真实 quarantineResource、DataStore.abandonScan、quarantine、quarantineCandidate 消费者。quarantineResource 还锁并复核 object slot/resource/object key，之后才写 publication/object。

私有 callback 拒绝对 caller 可见。已有主失败时，cleanup 拒绝或 SQL 失败作为 suppressed，保留原 exception 对象/类型/信息。PUT UNKNOWN completion、finish/publish 的 candidate quarantine 当前缺少保护，须采用既有 suppressed 模式。成功完成拒绝仍是错误，不能静默允许 DataStore.install。

DataStore.verify 当前在 retention.open 前探测 bucket versioning。将原 preflight 移到已资格化 readPublication lease 准入和 lease.check 后，保留 versioning 校验及原 guarded object open。Bucket probe 作为物理调用单独计数；constructor 启动 probe 不属于单次准入。旧已准入 invocation 可能已经有物理 I/O，不能撤销。

## 组件与下游消费者

| 组件                          | 变更与消费者                                                                                                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ManagedSessionStore           | 通用 readResource 边界；Store checkpoint/args verification 与普通 owner fallback 消费它，native owner admission/completion 独立。                                                                                                   |
| ToolPublicationRetentionStore | 通用 read/open/ReadLease/PUT completion 和精确 retained publication/object 检查；DataStore stream/read/scan/verify、ArtifactReader/Service、ResultProjector 消费 lease；DataStore object-backed admission/finish/publish 消费 PUT。 |
| ToolPublicationDataStore      | Finish/publish candidate quarantine 保留主错，既有 abandon/corrupt/replay suppression 保留，不在本增量重设计 claim/install/heartbeat authorizer。                                                                                   |
| 定向测试                      | 自然 private CREATE 后明确注入历史行/句柄/attempt；普通 missing-Session/deferred_v3、expired cleanup、retired completion、身份冲突与 suppression 对照。                                                                             |

独立源码索引记录所有 SDK Java 直接生产消费者。RecoveryReader 独立 object-open、producerBinding/apply、DataStore claim/claimScan/beginFinish/install/installFinish/finishScan/inline admission/heartbeat/recoverOperation、AdmissionStore receipt ingestion、lifecycle retirement 与 native writers 不自动经过此 guard。须分别评估既有 authority 和 inventory，才能声明 all-writer closure；不能只因不经过此 helper 就重复加屏障。

## 验证与验收

按 feat-dev 顺序。先全局 qwen discovery，再明确使用有界 Java/JDBC fallback，因公开 CLI 没有这些私有 selector。独立封存源/products/dependencies。自然 CREATE 建立私有 parent；unsupported 历史 publication/resource/lease/attempt 和反射旧句柄/callback 是独立准备，不能称自然准入的 native authority。

基线须观察实际 generic lease/metadata/attempt/quarantine 变化或物理 adapter 调用。候选私有拒绝须全部 base-table 值精确不变，包含 native OPEN/UNKNOWN 历史，新私有 read/PUT 调用为零。覆盖保留 pin、真实持久 tuple 对伪造 caller/attempt/lease 身份、旧 lease check/close、新 publication read/open/PUT、success/UNKNOWN completion 和全部 cleanup。私有反射是组件 seam，不是公开 runtime execution。

普通对照须实测 missing-public-Session、Store.requireEvidence 支持的 ambient verification、publication/object read、expired/retired lease cleanup、PUT I/O 中退休的 completion、UNKNOWN+retry 历史、原 non-private deferred_v3 finish/receipt/ACK。错误路径私有拒绝须保留主对象并附精确 suppressed；成功路径拒绝阻止 install。

专属完整 schema MySQL RC/预热 RR 验证当前 TRUE contention/子锁顺序、精确 ConnectionID/held-lock 及 before/held/after 全值审计。Raw fixture association/promotion 仅是 adversarial current-read probe。Build/typecheck/bundle、Java 定向测试/static/package、独立候选验收及两轮干净完整 diff 自审后提交。Native review 配置额度已耗尽（HTTP403/无结论），不能用测试批准替代；保持 PR Draft 和 maintainer 架构评审开放。

已完成有界验证：374 项定向 Java 测试通过，无 failure/error/skip；Checkstyle/SpotBugs、打包及 Node build/typecheck/bundle 通过。不变的下载预算在两种 adapter read size 下均为 2523 条语句，保留 442 次 check、精确 8 MiB bytes，无残留 lease。独立固定候选 MySQL 验证记录 126 条 raw/120 条有效观察，不称 120 个业务测试；474 份完整 62 表/828 列快照、172 个 attribution 阶段保留六条排除观察。四个完整 ambient prepare/receipt 并发调度使用 RC、inline prerequisite、零物理调用；current TRUE 与 missing-placement 纯错误对照另覆盖 RC/预热 RR。实际普通 receipt/replay/recording ACK 和有界 native owner-read 兼容通过。十四个专属 database/user 有独立 post-DROP 零计数及进程/资源 absence。报告 SHA256 为 dc37dd750a89b7411dc63a59a307331fe217ff0e11ae331aeb7bea066d5e4017。SDK 独立 source-byte binding 仍为 UNKNOWN；Node origins 仅绑定复制产物。这是 component/recording 证据，不代表新的完整 native turn、物理 CSI/S3 或云 ACK 验收。

## 风险与开放问题

Publication ordering 前置增量在已知 writer stage 的 R 前、generic preflight 前取得 P；该有界先决增量已独立接受并提交为 `9d1fc2b607c324799e1fdebf259efe4fa548ad2c`，有 90 个有效数据库用例、170 项原 JUnit 测试及两轮干净提交自审。本完整同步设计先于基线安装；将 generic R→G 在两个完整 ambient prepare/receipt 编排中与 fresh CREATE、P→R peer 资格化。不引入 late P、新连接绕过、统一 ambient 拒绝或任意 pre-held child 保证。

独立基线在实现前观察到真实 lease/metadata/attempt/callback 变更、close latch 回滚及 SQL 错误覆盖主错误的缺口。已完成报告记录 75 条 raw/71 条有效预期观察，包含已复现缺陷，不称全绿业务测试。修复前 RR 与下载预算回归及 observer 失败均保留；固定候选验收使用新独立封存输入。旧句柄与历史行明确为 adversarial seam。普通 ambient 兼容与晚物理 I/O 限制继续可见。此增量完成后仍缺完整 writer 资格化/inventory、terminal JDBC/cut 消费、immutable cut、原 finalize/DRAINED 和合格 ACK physical source/release/reuse/public enablement。
