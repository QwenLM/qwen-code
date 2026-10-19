# 私有 CSI Session 与 SQL 权威拆分

[English](2026-10-12-csi-session-authority-block.md) | [简体中文](2026-10-12-csi-session-authority-block.zh-CN.md)

## 状态与来源

这是供维护者评审的 feature 拆分。来源为 PR #13526 的
`4088e2455c2c9cb922fe42987d8f29f3ed2a6c49`，拆分基线为主干
`18f80f56666a347a2b67b2ef98099cc58356b253`。保留 #13899 已合并的 worker
及本地进程拒绝边界，以及 #13894 的 publication 加锁修复。原提案分支不变。
验证结果必须标明实际执行的拆分候选。

## 问题与当前状态

主干已有基于 descriptor 的私有文件 worker，并在本地进程 runtime 中拒绝该能力。
Worker 的正向测试使用明确的 authority fixture。主干尚未把持久化的私有 Session、
原 activation 和原生日志接到 worker 的 context 及执行证据。

原提案包含该连接，但与 Hosted 执行、冷恢复、应用退役和物理完成混在一起。
整文件复制共享源码还会覆盖主干后续修复。本拆分沿完整 READY 授权链展开，保留普通行为。

## 目标与边界

- 通过显式 operator 命令创建私有 Session，在事务中固定原 request、context、
  storage、profile 和身份。
- 仅准入原始 writer 和首次 activation；校验建立每个有限文件调用的已提交日志及资源。
- 持久化精确 SQL 执行 grant，并按同一原 Session 认证 worker context、history
  preparation 和 execution 回读。
- 保留有界资源读取 ownership 及失败证据。
- 保留普通 Session、publication、runtime 和工具行为。

公开 CSI 选择、Hosted runner、替代 writer、冷恢复、DRAINING continuation、
terminal cut、finalization、物理 stop/unpublish、release 和 reuse 不在本次范围内。
私有不支持的路径在改变 ownership 或调用 worker 前拒绝。原生日志 parser 可以校验
message、model-attempt 和 tool-result record，因为它们是文件授权的输入；
这不引入 Hosted 执行入口。

## 拟议改动

| 层               | 改动与消费者                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 私有创建         | 显式 Session 命令、request key 持久化，以及 Managed Agent store 中已注册 storage/context 资格校验。普通 selector 不变。                                      |
| 原身份           | 共享 CSI boot/request 身份、managed Session guard，以及 Broker binding/Session repository 校验。每次准入使用选定的原 binding。                               |
| 原生日志         | Managed Session Store commit preflight/acceptance 与 activation/history proof。Resource、journal head、writer 和 activation 仍是单一事务权威。               |
| SQL 执行         | Native tool reservation、完整 batch 成员、dispatch checkpoint，以及 binding/execution repository 中的不可变 grant 持久化。Reservation 不等于 authorization。 |
| Worker transport | 选定 Session adapter 与 HTTP transport 中的认证 native readback route、context 安装、history 和有限文件执行。                                                |
| 资源读取         | 持久化 OPEN/RETURNED/UNKNOWN 读 ownership，并重查原 writer、resource 字节/metadata 和 delivery 边界。不确定读取仍有记录。                                    |
| Schema           | 为 request pin、首次 activation、native authorization 和 resource-read ownership 使用新的未发布 migration。已发布 migration 不变。                           |

主要影响 `packages/managed-agent-server` 和
`packages/managed-agent-server`。既有共享 store、transport、schema 和
configuration 仅接入必要 CSI 增量；从固定来源拆出私有类及测试。保留主干已有
workspace execution lease schema，以及后续普通 reader、collection、definition、
rename 和 cancellation 行为。

## 决策与约束

### 单一原 owner

Capability digest 与 configuration 标识私有文件 profile。创建固定规范 request key
和 context revision 1。准入要求持久化的原 Session、binding generation、storage、
boot/Pod 身份、lease 与 installed context 一致。未知、歧义、变化、draining 或
替代身份均拒绝，不回退到 primary runtime。本次仅支持首次原 writer 和 activation；
writer 过期后不能换新 owner。

### 单一 SQL 权威

操作校验原 connection 和 transaction。锁顺序从 placement、retention 开始，随后
锁 managed parent/native head 及原 runtime/execution record。Adapter 不持 parent
SQL 锁跨 worker I/O；调用前后校验同一个 original。READ COMMITTED 与预热的
REPEATABLE READ 都必须通过 locking read 看到冲突的当前状态。

Journal proof 校验精确 durable resource 字节、身份、链、reference、checkpoint
和完整 accepted batch 成员。接受真实 producer 的 native message 与数值编码。
Worker path、input bytes 与 preparation evidence 来自已提交 record，不信调用者
标志。不可变 grant 固定原 dispatch generation 和授权 journal revision/sequence。
重试不能用新 head 或新 owner 替换它。

### 普通查询预算与兼容性

已有的普通 Session 加锁读取直接检查生成列 `csi_guard`，同时保留请求 pin 的拒绝边界，不再重复读取同一 Session。没有现成父行读取的变更继续使用专用加锁检查。placement、retention 和 Session 的锁顺序保持不变。

MQ wake claim 在插入或推进 `journal_wake` 进度、调度 Hosted activation 之前使用相同的持久化 legacy 变更守卫。私有 writer 租约到期不会准入 legacy claim：私有 profile 与持久化 request pin 都在改变 Session、journal head 或既有进度前拒绝。普通 wake claim、重投去重和 activation 保留主干行为。

普通 publication 在分配读取租约和 PUT attempt 时拒绝私有 Session。Session 的 profile 与请求 pin 在创建时确定，支持的 API 不会将普通 Session 转换为私有 Session。已准入租约继续检查到期与退役，close 只清除该租约；已准入 PUT 必须记录 RETURNED 或 UNKNOWN，不能因再次准入而丢失物理写入证据。这些收尾操作无需再次锁 journal head。collector 的私有检查和锁顺序继续保留。主干的预算断言不变：空 materialize tick 为 4 条语句，完整批次为 35 条、末批为 17 条，受测 publish 路径为 6 次 head 加锁读取。

身份实现由 Broker 与 Server 共享；旧 `com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeIdentity` 保留已公开的 `verify`、`boot` 与 `expectedPod` 静态方法，并委托给 Broker 实现。旧入口标记为 deprecated，不复制身份验证逻辑。新增的 Broker API 与本 feature 仍需 maintainer 评审。

与主干整合时保留普通 Monitor control 分类、准确 watch ownership、exit-evidence 收尾与 hold-row 栅栏。私有 CSI history dispatch 继续要求原 READY owner 及独立 control 栅栏。所有通用 control（包括 Monitor）在 transport 前拒绝私有 CSI Runtime。这是两条既有路径，整合不新增私有 Monitor 或 Hosted 入口。

主干公开 Shell/MCP 生命周期使用协议 2，Files 保留协议 1。普通 close/delete 能力沿用主干按 profile 判断的行为，两种协议的完成均保留 placement→retention→Session 锁顺序。私有 CSI 继续拒绝 close/delete；新增 resource-drain 路径在 cleanup 准入、reconcile 或 Session release 前检查持久化 binding profile。这不增加私有生命周期、DRAINING continuation、finalization 或物理复用资格。

普通 projection 完成从已持久化 result 行导出加锁范围，保持 tenant、私有守卫、head、publication、公共 Session、result 的顺序。取得当前 result 行后先检查 LEASED 状态和 claim generation；已结束的工作返回 false，不再解析已失效的 source JSON。活跃 claim 在任何写入前仍需完整 stored-source、scope 与 caller-claim 一致性证明。私有拒绝边界从持久化 owner 导出，不能借用外来 caller 的 tenant。

两个私有 operator repackage 产物采用 `csi-session` 与 `csi-runtime` classifier。普通 Server 镜像选择器显式排除它们，继续要求唯一 unclassified 主 JAR；这不增加镜像中的私有执行入口或 Kubernetes 部署。升级验证将 canonical active V1/V2 纳入准确新增清单，继续逐行比较既有 Flyway history。并发测试在准确的当前 schema 和表中观察被请求的行锁：MySQL 使用 `performance_schema.data_lock_waits`/`data_locks`，MariaDB 使用 `information_schema.INNODB_LOCK_WAITS`/`INNODB_LOCKS`。轮询间隔允许 InnoDB information-schema 缓存刷新，避免保留等待前的快照。五秒期限、future 保持阻塞、拒绝与无副作用断言均保持不变。

### READY 范围与失败行为

Adapter 仅准入 READY 工作。既有 retirement evidence 是拒绝条件，不是 DRAINING
continuation 权威。它不实现 release，也不宣称物理完成。失败或不确定读取保留
durable ownership evidence。不支持的 recovery 和 terminal 操作拒绝。

已合并的 worker 在有 execution 时拒绝 prepare，在 preparation 期间拒绝 execution。
Producer 必须在尝试 preparation 前停止为该 Session 发出 execution。本 adapter
不循环重试，也不推断通用 worker 409 可以安全重试；保留原证据及失败状态。
后续自动 producer 需要明确 retry 与 retirement 的契约，包括既有共用错误码。

### 取消和持久化结果容量

已授权的私有执行不能通过共享 Broker 路由取消。Service 在请求持久化取消前拒绝，
JDBC repository 在原 owner 资格校验后执行相同约束。未启动且未授权的取消，
以及普通 Runtime 的取消，保留原有语义。

执行 envelope 仍以 1 MiB 为上限。原生 outcome 同时保存精确 envelope 和转换后的
模型 history，可能重复文本和错误详情。64 KiB 以内继续使用 `managed-tool-outcome`；
更大的 outcome 使用仅含 `parts` 的 `managed-tool-outcome-chunks` JSON manifest，
按字节顺序引用 `managed-tool-outcome-part` 资源。除最后一个非空 part 外，每个
part 为 60 KiB。共需 2–69 个唯一 part，合计最多 4 MiB；先拼接再解析 UTF-8。
每个 manifest 和 part 均保留既有单资源 64 KiB 上限。

Producer 发布全部 part 和 manifest，将 manifest 用作 `toolOutcomeRef`，并将其
digest 用作 receipt 的 `contentDigest`。HTTP journal adapter 将 part 纳入同一
事务的资源清单，manifest 已提交时也必须纳入。Native proof 通过该 revision 的
SQL reference 校验每个 part 的 kind、长度和 digest，随后继续校验原有的闭合 body、
execution envelope 和 history。缺失、篡改、重复、过短、超限或外来 part 均拒绝。
该格式不启用 Hosted 执行，也不代表已完成剩余执行全链路验收。

### Migration history

当前运行时使用主干 `db/managed-schema` 的全新 32 表基线。
已发布 V1 保持字节不变。新增 V2 在 `ma_session` 保存 request pin 与生成的
私有分类，在 `ma_runtime_binding` 保存原 owner 首次 activation revision，
在 `ma_tool_execution` 保存不可变 native authorization。移除此前提议的旧 CSI
migration；归档迁移不进入运行时或测试 classpath。不为未合并 PR 预留版本，
#13526 保持不变。

初始化只接纳完整 canonical V1 或 V2 catalog。没有迁移历史的 V1 数据库应用同一
增量；有迁移历史的 V1 数据库通过 Flyway 升级。Server 按实际 catalog 版本
baseline 后迁移，保留既有 V1 history 与 checksum。部分、外来和旧 catalog
继续拒绝。

原生资源保留 tenant/session 二进制身份、计算的 scope/resource key、
`MANAGED_SESSION` head 与 `JOURNAL` ownership reference。
持久读取使用 `ma_request_receipt`，namespace 为 `SESSION_COMMAND`、operation
为 `CSI_RESOURCE_READ`，并使用独立 hash read scope。不可变 JSON evidence
与 OPEN/RETURNED/UNKNOWN 状态独立于临时 `ma_read_lease` 保留。普通回执消费者
继续按 namespace、operation 与 scope 隔离。Publication 锁顺序保持 placement
先于 retention 和 Session authority；普通消费者拒绝私有 Session。

整合的主干包含 #13642 的四个 canonical retention 索引。终态 JDBC sweep
保留私有 capability family 和带持久私有 pin 的 Session，并把已保存 native
authorization 视为引用。这只是对既有历史证据的清理拒绝，不增加私有 release
或终态转换。普通无引用终态历史仍按主干 retention 策略过期。

## 验证与验收条件

1. 先 dry-run 全局 CLI；若全局 CLI 无法到达私有 Java operator，则使用自有 SQL/API
   fallback。
2. 验证私有创建与准确 replay、变化 request 拒绝、原 activation/renewal，以及
   替代 writer 拒绝。
3. 将已提交 native intent/checkpoint/resource 接到实际 SQL grant 和认证 worker
   回读。缺失成员、字节变化、外来 credential、错误 context 或过期 authorization
   必须在文件效果前拒绝。验证准确重试和 retained history。
4. 使用两个独立数据库连接，在两种支持的 isolation level 下验证当前状态 fence，
   并校验 placement 先于 retention。
5. 验证资源读取，包括不确定 delivery、lease 过期和 metadata/bytes 变化；
   不清除 ownership evidence。
6. 对比普通对照，运行受影响 Java 测试、静态检查、migration 检查、仓库
   build/typecheck/bundle 及相关 worker 测试。
7. 完成连续两次干净的完整 diff 自审与独立评审。

Darwin 上的正向私有 worker 执行需要明确记录 Linux metadata/procfs translation。
该证据不资格化原生 Linux CSI、Kubernetes、SQL producer 部署或安全物理复用。
原提案上的测试不资格化拆分分支。

### 已观察证据与待完成验收

16 项原生 activation proof 测试使用标准 Surefire `Test` 后缀，由普通 Server 测试发现自动收集。两个 Server CI lane 均在 Maven 运行前构建 Node producer 前置产物。这些基于 H2 的原生 proof 测试不能替代下述实际 SQL grant 到 worker 的验收。

本拆分已由外部操作转为 Ready，仍需 maintainer 评审。在 canonical schema 整合前，本地 build、typecheck、bundle、定向 Java 与 worker
测试已通过。独立自有 MySQL 8.4 测试应用了当时完整的旧 migration 清单，并观察到实际
私有 CREATE/replay、七个原生日志 commit 及其 replay、原 activation/renewal、
替代拒绝、普通对照、认证 adapter bind 回读，以及两种 isolation level 下的
当前状态 locking read。这些早期结果不资格化 canonical V1/V2 适配。独立回归还覆盖 retained request pin 与 worker 大小的
HTTP result 接收边界。每份报告记录实际候选及构建产物 hash。

Canonical 整合验证另行覆盖真实 MySQL V1 到 V2 升级以及无历史 V1/V2 catalog
的 baseline，保留 V1 history、普通数据与互不混同的二进制 tenant 身份。
自有 MySQL 测试覆盖私有创建与 collection 并发、两种 isolation level 下的
当前行拒绝，以及保存 OPEN/RETURNED/UNKNOWN 持久回执的原 owner 资源读取。
读取 fixture 提供原 READY 身份并显式注入 JDBC cleanup 故障；没有启动认证
worker，也没有生成 native SQL grant。普通 materialization 保留主干实际测量的
查询预算，包括空 tick 与写 snapshot 的批次。这些是 schema 与组件观察，
下述完整验收限制仍然有效。

这些观察尚未完成验收条件 3：实际 SQL execution grant、认证 execution 回读、
正向 worker 与 retained-history 效果尚未连起来执行。Resource delivery fault
目前有 H2 单测覆盖，没有独立 MySQL 端到端资格验证。Protocol fixture 和纯 proof
测试不能称为实际 SQL grant 或部署验证。PR 的独立测试报告区分这些证据层次；
rollout 前仍需维护者评审并完成剩余验收。

## 风险、后续与开放问题

这是较大的跨包 feature，需要按仓库 core infrastructure advisory 交给维护者做
架构评审，不授予生产 rollout 批准。Retained owner 在本次没有 release 路径；
operator 不能把逻辑成功当作 storage 可复用。

Hosted 接入、冷恢复、应用/物理聚合退役、安全 release/reuse，以及 producer 公平性
和错误分类仍是后续工作。原位文件 mutation 保留 #13899 已声明的失败语义；
本次不增加 crash-atomic replacement。拆分时保留已声明的私有 READY 边界，
不需要新增业务或架构决定。
