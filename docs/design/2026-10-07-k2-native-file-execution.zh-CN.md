# K2-A2：原生文件执行完整链

[English](2026-10-07-k2-native-file-execution.md) | [简体中文](2026-10-07-k2-native-file-execution.zh-CN.md)

状态：完整文件组合设计；初始 checkpoint 门禁已在本地实现，并在自有 MySQL 上独立验证，
2026-10-07。调查基线为
[Draft PR #13526](https://github.com/QwenLM/qwen-code/pull/13526) 中的
`a6cc145edf2f586604c889b186dc10a20e534761`。该提交已实现原执行的 SQL
continuation；以下正常文件链尚未实现。本文补充
[K2 补全设计](2026-10-06-kubernetes-k2-retirement-handoff.zh-CN.md)，不声明完整
A2、聚合退役或新增云上验收完成。

## 1. 问题与范围

调查基线中，私有 `csi-files-retirement/1` 的 CREATE 与首次 activation 固定点已存在，但
通用 worker 构造 Shell/MCP/Hook/monitor/provider 组件，SQL reader 仅接受
genesis/install/renew。删除 control 拒绝或允许任意 checkpoint，不能安全连接这些权威。

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

当前备份使用 `Storage.getGlobalQwenDir()/file-history/<owner>`；Pod 的
`HOME=/tmp` 使其成为 emptyDir 依赖。为私有组合显式传入 backup root，legacy
caller 保持默认值。使用已注册卷内绑定原 Session 的保留目录，固定其目录身份，
拒绝符号链接/root 替换，禁止文件工具按词法或真实路径访问该子树。不能重定向
全局 `QWEN_HOME`。备份保留至原 finalize；不可用、中断或容量不足均阻断结算。
后续 cut/finalize 必须覆盖所保留备份字节及原生 history resource。
Write/Edit 必须要求已绑定并 prepared 的 history；不能使用 legacy executor
在没有 history 对象时仍执行 mutation 的 fallback。

Hosted 当前先调用 prepare，再提交 `pendingTurn`/`pendingMessageId`；这些字段
不是 preparation 准入。此 profile 必须在 worker I/O 前，向既有原生 file-history
domain 提交版本化的准确 preparation intent，绑定原 turn/message、invocation/input
ref 与排序路径。原 parent guard 仅在 READY 准入。Broker 在原 connection 核对
已提交字节，不信调用方标志或缓存 context。保持单一 journal 权威，不持 parent
SQL 锁跨 worker I/O。

提供独立于 provider lifecycle 的窄认证 history 分支：READY 允许首次空 bind、
已准入 prepare、snapshot，不允许 rewind/restore。Worker seal 后只允许对已绑定
原 history 做 idle snapshot。拒绝迟到 prepare，并保留其持久化未完成 intent 为
blocker。追踪已运行 preparation 至完成及最终 inventory，不能推断失败/拒绝 RPC
没有改变文件。

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
