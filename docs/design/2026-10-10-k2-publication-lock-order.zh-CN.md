# K2 publication 先 placement 后 retention

[English](2026-10-10-k2-publication-lock-order.md) | [简体中文](2026-10-10-k2-publication-lock-order.zh-CN.md)

状态：先决增量已实现；独立基线与候选验证已验收。关联 #13395 / Draft PR #13526。
通用私有 retention 与聚合退役仍为独立增量。

## 问题与支持范围

普通 publication apply 与两个 prepareAdmission SQL 阶段首次先取得 tenant
retention 行 R，再通过旧 writer 取得 placement 行 P。Session、lifecycle、
migration 与 native admission 已经先 P 后 R。两个普通 ambient preflight，
prepareAdmission 与 commitReceipt，也在首次 P 前读取 generic resource。
给这些读取增加当前私有 parent 检查 G，会在后续 P 前保留 G。源码识别这些边，
实际 MySQL 调度仍须建立可达行为。

仅在这些已知 publication 编排中前置 P，保留原 REQUIRED 事务、manager 与
DataSource。纯 generic reader 和 callback 将保持先 R 后 G，不取得 P。本方案
不拒绝普通 ambient 调用，不改变 isolation。进入前已持 R/G 的外部 caller、
跨 tenant 外层组合或不支持的 custom manager 仍未资格化。不声称每一种公开
API 组合均无等待环。

## 选择 P 前资格化目标

Store 提供一个小型 publication 专属前缀。已有 publication 通过原 JdbcTemplate
无 FOR UPDATE 读取。要求真实 row tenant/workspace/Session、scope key 与
publication ID 匹配目标；解析准确 binding，验证 binding digest，要求 binding
key 与 publication ID 匹配该行。新 reservation 改用经过 contract 校验的
candidate。Reservation replay 在选择 P 前还须资格化已有行及 candidate digest。
其无锁查询须区分 absent/new 与 present/replay，不能要求新 reservation 已有行。

通过原 repository 发现 original runtime，要求其 tenant/workspace、binding ID
与 generation 匹配已资格化 binding。支持的同 DataSource
JdbcRuntimeBindingRepository 还须通过原绑定 JdbcTemplate 无子锁读取
binding_id、tenant_id、workspace_id、runtime_generation、provisioner_kind；
要求这些持久值与发现的 runtime 和 binding 一致。Repository 原 findById
使用另一连接，不能说成原事务读取。不新增 read-only RR snapshot、discovery
连接或 child FOR UPDATE。

仅为已资格化 tenant 选择 P。每个 SQL 阶段内保留已资格化 expected runtime
给原 native locking helper，取得 P 后不发现并追随第二 tenant。原 JDBC native
锁在原 Connection 复核 slot 与 current sameIdentity。包括 receipt 阶段在内，
之后每次 original-runtime discovery 仍须在任何 native P 前检查目标 scope。
Binding 或 row 变化则拒绝；之后锁定的 publication、writer、token、epoch
和 execution 检查仍是权威。无锁 discovery 是调度前缀，不授予 native 权限。

apply 后续锁定行须先与发现的 binding/digest 比较再使用。
原 candidate/install/receipt 锁定查询须保留目标 tenant/workspace/Session predicates，
读取 binding_json/binding_digest。重新计算锁定 JSON digest，同时匹配持久 digest
和原 finished binding。不能在 R 前锁 publication，也不为这个比较在子锁后新增查询。

普通 custom repository 保留原 repository discovery 与身份校验，不要求存在
SQL binding 行。其外部 mutation 或跨连接行为不会因此取得受支持 native JDBC
保证。不统一拒绝既有 ordinary 调用。

## 已知编排的变化

| 入口                               | 拟议前缀与保留行为                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| applyLocked                        | 资格化 candidate 或持久 publication/runtime，取得 P，再走 original runtime 锁、R、旧 writer 及原锁定 publication/evidence 检查。                        |
| prepareAdmission candidate/install | 扩展原 settled-result 前缀，资格化持久 tuple/runtime，并在 ordinary 早退及 R 前取得 P。Native locking 使用保留 expected runtime。两个阶段均修改。       |
| prepareAdmission ambient preflight | 纯 outcome size/schema 检查后、finished 首次 generic read 前，在参与 REQUIRED callback 执行同一 publication 前缀。Standalone preflight 保留短读取序列。 |
| commitReceipt ambient preflight    | 纯 request/root 检查后、首次 admission resource read 前，在参与 REQUIRED callback 执行 publication 前缀。保留 finished/manifest/receipt 校验。          |
| commitReceipt SQL stage            | 在原首次 P 前资格化持久 publication/runtime，再保留原 Session/native、settled-result、R、writer、resource 和 receipt 检查。                             |

参与 preflight 的 callback 返回不会提交或释放 P。该 P 覆盖支持的外层
preflight、candidate、有界 object I/O、install 或 receipt 及 cleanup，直到原
外层事务完成。Standalone writer 各阶段自行先 P 后 R。Ambient caller 原物理
I/O 保持可观察；新连接或 savepoint 不能替代该 caller 持有锁的资格化。

## 错误与同步 metadata

P 是同步 metadata，不提供 native authority。现代 writer acquisition 已经创建
它。旧历史缺 P 行时，early upsert 成功后在参与 callback 外发生纯 validation
错误，若普通外层 caller 捕获，该行可能提交。接受并明确测量这个仅 metadata
的 delta，保持 publication、journal 与 result 全值精确。不悄悄把所有捕获的
纯 validation 错误标成 rollback-only，也不声称完整数据库无写。原 writer/SQL
阶段失败保留 rollback-only 语义。

既有 private writer 排斥若在 SQL 阶段到达，会在参与事务内抛错，回滚该事务
P/R upsert 与私有值。更早的 CSI ambient 拒绝仍位于 callback 外。
新 scope 前缀自身不排斥当前私有 parent：将普通旧历史不受支持地关联到私有
Session，仍可能进入纯 preflight 错误，外层捕获后提交缺失 P 的 metadata delta。
Generic 私有 preflight 排斥属于下一增量。保留原 primary error；原 API 承诺时
把 cleanup 失败放入 suppressed；本增量不添加 G，不改这些 callback 规则。

## 验证与验收

实现前独立封存原源码/产物，在新专属 MySQL READ COMMITTED 与预热
REPEATABLE READ，以真实先 P 后 R 的 Session peer 测量三个首次先 R 后 P
路径。绑定源码 SQL latch 明确披露为组件 seam。观察真实 ConnectionID、
持有锁、等待及完整 before/held/after 值；源码中的环不等于观测到 deadlock。
保留所有非零 observer/product exit。

候选须在三个阶段均先取首次 P 再 R，在两个支持的 ambient preflight 中于
同一外层 Connection 的首次 generic read 前取得 P，并保留 ordinary
producer/admission/receipt/ACK 行为。检查 missing public Session、非私有
kubernetes-workspace、伪造 caller/binding、持久 digest 漂移、真实 runtime
scope/generation 冲突及 expected identity 变化。拒绝目标不能取得另一个 tenant
的 P。Existing/missing P、捕获纯 validation 与外层 commit/rollback 分别检查。

运行 build/typecheck/bundle、定向 Java 测试与 static/package 检查，再执行独立
候选调度和两轮干净完整 diff 自审。仅在这个有界先决步骤通过后，才可尝试
generic R→G，并把两个完整 ambient 路径与 fresh CREATE、P→R peer 验证。
外部任意 ambient 仍未资格化。配置 native review 无 verdict 时保持
Draft/maintainer review 开放。

## 受影响文件与剩余工作

ToolPublicationStore 负责 scope 前缀与 original-runtime 资格化；
ToolPublicationDataStore 和 ToolPublicationAdmissionStore 在已识别边界调用。
定向 publication、admission、acknowledgement 与 native 测试保留原对照。
本增量不计划 runtime-broker API、TypeScript、schema、generic callback 或
retirement 状态变化。

独立基线复现六个真实 MySQL 1213/40001 死锁（apply、candidate、install
各在 RC 和预热 RR），另有 16 个无 early P 的 ambient preflight 对照。候选六个
调度均先 P 后 R，双方成功。独立验证从 100 个记录用例中验收 90 个不同数据库
用例；十个资格不足的 fixture 对照明确排除。另运行 170 项未修改的定向 JUnit
测试。两份最终记录数据 audit 共通过 38,951 项数据检查，所有专属进程、数据库
和端口均释放。这些检查不计为额外测试。

验收对照包括两个 ambient preflight、原外层连接中的五个持久 runtime 列、
前缀后 binding 漂移、正确 receipt 与 replay、普通 custom repository、非私有
Kubernetes 历史及后续 native runtime discovery。Missing-P 纯错误外层提交
可能只留下 P metadata，包括不受支持地关联私有 parent 的普通历史。后续
receipt helper 可能重入同一个 original P，不声称完整路径仅有一次 P SQL。
MySQL observer 使用原封存产物且不用 Mockito；未修改的 H2 单测保留原
Mockito 变换，只把变换前文件来源绑定到该产物。

不可变验证报告位于
`.qwen/e2e-tests/k2-publication-lock-order-candidate1-20261010T131259Z-9f0cf6cd/verification-report.md`，
SHA256 `1e1e6620e3bc21efd88765e98e9e5d5c7d32a737d290b4f605aaef276c62555f`。
根验证通过 253 项定向 Java 测试、Checkstyle/SpotBugs/package 及 Node
build/typecheck/bundle。该 Java 输入使用独立 terminal 语义增量之前的 broker，
不把这份证据归到后续源码。Observer compile/audit 失败与排除用例均保留在
报告中；其中明确撤回基线关于旧 missing Session/isolation 导致 fixture 不适用
的解释。

Generic read/PUT/lease/callback 闭合、完整 writer inventory、immutable cut、
worker finalize、DRAINED、可信原物理来源、RELEASED/reuse 及完整 K2 验收
仍待完成。
