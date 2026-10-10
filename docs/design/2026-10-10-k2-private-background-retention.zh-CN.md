# K2 私有后台 retention 边界

[English](2026-10-10-k2-private-background-retention.md) | [简体中文](2026-10-10-k2-private-background-retention.zh-CN.md)

状态：已实现并完成有界独立基线/候选资格化。
Native review 无结论；maintainer 评审与完整 K2 仍开放。
基线 `bc2ba382a2a163abd8c3331d4b3939097c4997f2`。
关联 #13395 和 Draft PR #13526。完整 K2 尚未完成。

## 问题与现有行为

普通 collector 最多发现 32 条 RETIRING/DELETING publication，领取一条，
每次对象 DELETE 前续租，然后确认 SQL collection。各阶段都没有排除持久私有
Session。只在 confirm 检查已经太晚：物理 DELETE 先于确认。确认还清除 inline
bytes、held 容量和过期 Session read 租约。Renew/defer 当前没有独立事务或目标检查。

普通 reservation 会 fence 租户内所有过期 OPEN publication，释放其 held 容量。
合法普通 caller 不能授权修改另一个私有 Session。排除私有目标后，其 held 容量
及 active captures 仍必须计入配额总量。

## 目标与范围

在 discovery、claim、renew、defer、confirm 冻结 unsupported 私有历史 publication，
包括既有 claim；普通跨 Session expiry 排除其真实存储目标。保留没有公开 Managed
Agent Session 的普通 journal 及原 deferred_v3 publication。现有 generated
`csi_guard` 在私有文件 profile 或保留 `runtime_request_key` 时为 TRUE；只修改
profile 不能消除边界。

这是旧路径排除，不授予原生 authority。不新增 native collector、schema、公开
switch、read/PUT 能力、application cut、worker finalize、DRAINED、物理
stop/unpublish、RELEASED 或复用。通用 publication/resource read、PUT、
quarantine/error 回调属于后续工作。即使租约过期，OPEN/UNKNOWN 原生 read 历史
仍未解决。

## Collector discovery 与事务

为完整 RETIRING/DELETING OR predicate 加括号，在 ORDER BY/LIMIT 32 前，
按每条 publication 的真实 tenant/Session 关联 NOT EXISTS 私有 filter。Java 中
跳过会使普通工作永远被 32 条不可变私有记录挡住。发现只是公平性提示，不是写入权限。

每项 mutation 使用短事务。Peek 当前持久 publication tuple，先锁 retention
tenant，再调用现有 `ManagedLegacySessionGuard.isPrivate` 当前 FOR UPDATE
TRUE probe，然后才锁 head/publication。私有拒绝把事务标记 rollback-only，返回
既有无工作结果；可能的 tenant upsert 也必须回滚，不写 blocker 或 retry 时间。
普通检查后锁 head 与精确 publication，再比较其 tenant/Session 与 peek。消失或
tuple 冲突不提交任何写入。

Claim 身份来自已锁行。Renew/defer/confirm 每次重新从存储 publication 获取目标，
核对 claim 的 tenant/Session、owner、generation；claim JSON 不是目标 authority。
Renew 在每次物理 DELETE 前资格化，defer 在错误路径也独立资格化；confirm 在
cursor、inline/resource 清理、quota、过期租约删除前检查。对象 DELETE 保持在
SQL 外。已启用 `runOnce` 在 claim 前拒绝 ambient transaction 或已绑定 DataSource，
避免事务跨对象 I/O；禁用 collection 继续返回无工作。

Collector 锁序为 retention tenant → 当前 TRUE exclusion → head → publication。
它不请求 placement 或原生准入，与现有旧 result completion 顺序一致。私有 TRUE
probe 可等待原 Session，但之后不会再请求原生 parent。

## 锁兼容与目标建立

Placement 和 publication retention tenant 是不同的锁。现有 native writer
采用 placement → retention tenant → 原 parent → head；私有 CREATE 和 Broker
pin 验证在自有事务内采用 placement → Session pin，没有随后取 retention tenant，
其锁在后续 writer 事务前已释放。CREATE 分配全新 UUID。当前 production 不通过
修改 profile、request pin 或 identity 将既有普通 Session 提升或重新关联为私有。

普通 publication apply 和 DataStore 两阶段已有 retention tenant → placement
路径。改成 placement-first collection 会新增反向等待，并要求更广修改，包括
普通 ambient 兼容。本设计保留 collector 的原 tenant 顺序，仅在子锁前加 TRUE
exclusion。

Protocol0 DELETE 先 negative TRUE probe，再取 retention tenant，但不会向该
gap INSERT/promote Session。全新 exact forced-index 实验测量四组 RC/预热 RR
时序，包含已有 FALSE 或 missing Session。Old actor 真实等待 collector tenant，
collector 对相同 negative key 和邻接已有 TRUE key 的 probe 均先于释放返回。
RR negative `X,GAP` 和 positive `X,REC_NOT_GAP` 共存；RC negative 后未保留
Session record/gap 锁。缩减表全值不变，SQL 无错误，自有资源已清理。这是两表
测量，不证明完整产品锁图。完整产品资格化还须独立执行支持路径，并保留所有
失败。本设计不授权 raw SQL guard promotion。

## 租户范围 reservation expiry

在既有 expiry UPDATE 中，用最小 correlated NOT EXISTS，检查每条 publication
实际 `tenant_id`/`session_id` 与 `csi_guard = TRUE`。两个容量 SUM 和 active
capture SUM 保持不变。普通 expiry、reservation replay、quota refusal 保留原行为。

UPDATE 在 `lockPublicationWriter` 返回后执行。该方法在真实事务 connection 上，
先获取 caller tenant 的 placement 锁及 retention tenant，再资格化 head。支持的
私有 CREATE 和 Broker pin 建立因此不能在持有此 placement 锁时穿过 expiry。
不在 head 后追加目标 parent 锁，也不增加未资格化的晚到 native resolver。本增量
不改变既有普通 ambient 行为。

该前提限定在支持的 `apply` 事务与 JdbcTemplate 使用同一 DataSource、通过原
transactional-connection 检查时。其非事务普通 fallback 不取 placement，正常
返回本身不是证明。验证须观察 expiry 前真实持有的 placement 行，不能从方法名
推断；错配 manager 不属于该已验证配置。

隔离 MySQL 8.4.11 实验只有三张缩减表。RC 与预热 RR DML 都看到旧 plain
SELECT 后已提交的私有 membership。RC 不等待未提交 raw guard promotion，会
fence 该 toy 行；RR 等待 Session 共享锁。显式反向 X-lock probe 在两个隔离级别
都死锁。这些是真实观察，不是产品验收，也不证明 raw promotion 是支持行为。
Filter 本身不足；产品的 placement 前提和配额总量须通过完整 schema 与实际
reserve caller 独立验证。

## 组件与兼容

| 组件                      | 变更与消费者                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| ToolPublicationCollector  | 分页前过滤；四个 mutation 阶段独立检查持久目标。Scheduled tick 和 runOnce 是生产入口。                  |
| ManagedLegacySessionGuard | 复用当前 TRUE exclusion，不全局修改 lockSession，不授予 native authority。                              |
| ToolPublicationStore      | 普通 reserve expiry 排除私有目标；controller grant 是 apply 消费者，既有 SUM 保留私有 quota。           |
| Collector/Store tests     | 私有历史 fixture、普通 journal-only/deferred_v3 对照、饥饿、伪造 claim、ambient 拒绝及真实 MySQL 观察。 |

缺失公开 Session 元数据继续兼容普通行为。缺失或冲突的私有原 authority 继续
冻结，不通过旧检查修复；既有 stale owner/generation/claim 检查仍必需。

## 验证与验收

按 feat-dev 顺序执行。先尝试全局 qwen discovery；公开 CLI 没有私有 Java
collector selector，使用显式有界 Java/JDBC fallback，独立复制并封存产品。
创建真实私有 Session 后，将注入的历史 publication/object/claim 明确标为
adversarial fixture，不能称自然原生 publication authority；每次观察独立划分
准备/恢复和实际调用。

基线须观察真实私有 DELETE 或 gc/inline/quota/lease 变化，以及实际普通 reserve
跨 Session expiry。候选须使每个私有行值完全不变，私有对象 DELETE 为零。覆盖
RETIRING/DELETING 两分支、超过 32 条排序靠前私有候选、改变 profile 保留 pin、
既有 claim、renew/defer/confirm、伪造 tuple、错误路径和 OPEN/UNKNOWN read/lease。

专属 MySQL READ COMMITTED 与预热 REPEATABLE READ 须观察子写入前当前
资格化、真实 connection/isolation/锁等待及所有发现的 base-table 值。验证实际
reserve 在 expiry 前持 placement、私有 held bytes/captures 继续计费。H2 不能
证明 MySQL 锁序。普通 missing-Session collection、active reader/UNKNOWN PUT
blocker、claim race、分页、DELETE 响应丢失、reserve replay/capacity，以及原
deferred_v3 completion/receipt 保留对照。

运行 build/typecheck/bundle、Collector/Retention/Publication/Acknowledgement
及边界定向测试、适用 Java static/package 检查、独立候选验证和两轮干净完整 diff
自审。Native review 当前因配置模型额度 HTTP403 没有结论，不能用 test-engineer
报告替代批准。保留每个原失败窗口，只独立清理注册的自有资源；保持 PR Draft 和
maintainer 架构评审开放。

## 独立基线与本地实现

独立封存基线在专属 MySQL 8.4.11 上执行 20 个真实 Java 场景，先通过真实私有
CREATE，再明确注入 unsupported 历史行。公开 runOnce 回收 RETIRING 和 DELETING
私有行、调用记录 DELETE adapter、清除精确 inline bytes/quota 并删除过期租约。
42 条私有积压使前 32 条 retry/blocker 被修改并延迟普通工作，保留 request pin
也未阻止 collection。真实普通 reserve 在 RC 和预热 RR 下 fence 私有过期 OPEN；
六次实际 expiry statement 前，准确 connection 均在支持的同 DataSource 事务中
持有 placement X RECORD 锁。

唯一实际 Java 进程 exit 0；最终只读审计在全部 62 表、827 列检查 119 个 predicate
及 60 个附加身份/来源检查。原 launcher 和两次 offline audit 失败均保留，修正
审计预期没有重跑产品观察；已独立清理所有注册自有资源。Renew/defer/confirm
反射属于组件 seam，记录 DELETE adapter 不是实际对象存储或 CSI 证据。

本地变更新增完整括号 discovery filter、claim/renew/defer/confirm 的当前持久
目标资格化、enabled ambient 拒绝和最小普通 expiry exclusion；不新增 migration，
不改 quota SUM。单测还覆盖旧 discovery page、40 条混合 state 私有行、保留 pin、
伪造 claim tuple、私有 tenant upsert 回滚、ambient/bound connection 拒绝及两个
决定性私有配额维度。Build、typecheck、bundle 已通过。定向 Java verify 的
207 测试全部通过（Collector 50、Publication 114、Retention 18、Acknowledgement
25），Checkstyle/SpotBugs 均无发现。之前的 compile overload、重复 fixture
resource、indentation 失败及原退出码保留。

## 独立候选资格化

主封存候选在专属 MySQL 8.4.11 完成 52 个实际 Java 边界/对照场景，随后旧协议
fixture reset 因 observer 删除 binding 却保留 slot 而失败。实际 Java exit 仍为
1，缺失的最终 fixture snapshot 不作为验收。已完成场景的只读审计通过 559 项
predicate 及八项 closing 检查。私有 discovery/callback/保留 pin 拒绝保持全部
发现的 base-table 全值不变，无私有 DELETE。已观察普通 quota、active-reader
及 UNKNOWN PUT blocker、106 对象分页、DELETE 回复丢失后的重试、两个 collector
争 claim，以及 ambient/bound-source/disabled 对照。十次真实 reserve expiry
statement 在准确 connection 上持有 placement X RECORD 锁。

全新独立封存数据库补测原 non-private deferred_v3 producer/finish/admission/
receipt/projection 对照。实际 Java exit 0，核实 receipt revision/sequence 3、
原 `abc` bytes、READY projection、两个 artifact 与两条 RETURNED PUT attempt。
Wrapper exit 1 和首个 offline audit 失败保留：auditor 漏列正常 PUT attempt，
并漏计原 revision-2 reference。修正后的只读审计通过 86 项 predicate，在 17 表
逐项检查 37 条精确差异行并保持旧 reference；没有重跑产品观察，也没有向这个
普通组件 fixture 混入私有历史。

独立 R5/R3 候选窗口通过 21 个组件/对照场景、1,054 条 JDBC event、16 次监测
等待，SQL 无错误。八组私有 renew/defer/confirm/forged-renew RC/预热 RR
先持 retention tenant，在 head/publication 子锁或 mutation 前等待当前 TRUE
Session；before/held/after 完整值全等，tenant upsert 回滚，私有 DELETE 为零。
Missing-Session 普通组件和两组公开 runOnce 成功。四组 protocol0 negative-probe/
tenant prefix 时序未出现反向等待，RR missing-key supremum 锁按实际模式记录。
首 observer 窗口因多加 ambient wrapper 产生 UnexpectedRollbackException，
仍保留 exit 1；修正窗口使用全新数据库，没有把此前失败当作成功。

各窗口均发现 62 个 base table、827 列，核对封存 source/product/dependency 与
真实加载来源无漂移，并独立确认自有数据库/用户/服务、PID/group/listener/temp
清理。Root 随后只更新文档记录这些结果，观察的生产/测试产物没有改动。反射
callback、注入历史行、warming instrumentation、protocol0 组件 prefix 和记录
对象 adapter 明确作为 seam。任何窗口均不证明实际对象存储/CSI DELETE、任意
ambient 锁组合、完整部署锁安全、native authority 或完整 K2。

## 风险与开放问题

有界完整 schema 资格化覆盖已记录 callback 与对照。缩减 schema negative-probe 测量
不能推广到所有计划、cardinality、secondary index 或部署消费者。SQL 等待不是
完整生命周期证明。未来 same-ID association 在支持前须有终身 CREATE/read/PUT
barrier；剩余回调及完整不可变 inventory 须先封闭，才能建 application cut。
ACK 有诊断 collector，但尚未资格化为绑定原 incarnation/cut 的物理退役源。
完整停止、卸载、release、reuse 仍是后续验收 gate。
