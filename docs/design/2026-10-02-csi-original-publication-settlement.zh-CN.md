# CSI 退役期间的原 publication 结算

[English](2026-10-02-csi-original-publication-settlement.md) | [简体中文](2026-10-02-csi-original-publication-settlement.zh-CN.md)

状态：已实现并通过本地验证，限定范围审查已完成。这是
[dispatch 授权前置项](2026-10-02-csi-dispatch-authorization.zh-CN.md)之后的
[K2c](2026-10-01-managed-kubernetes-k2.zh-CN.md) 分片。

## 问题与基线行为

CSI 退役会原子封口原 binding，并将物理 holder 保留在 DRAINING。Worker
准入随后拒绝新工作，同时保留原结果路径。改动前，publication producer 要求 READY，
包括对象 I/O 后的最终数据库安装。因此，原先已授权的执行无法在封口后完成 capture。
其授权字段对已持久化，但没有 publication consumer 使用它。

Producer 准入与 dispatch grant 校验原先共用一个检查。全局放开会同时允许新工作。
结果 candidate 与 Session receipt 使用独立事务路径；原结果可能需要在封口后创建
第一个唯一 candidate，所以禁止所有新 candidate 同样不正确。现有 repository
通过独立连接读取，不能保证 publication 写入与退役之间的原子性。

## 目标与范围

允许在已提交原封口之前获得授权的同一执行完成有界 capture，随后完成原 FINISHED
结果、Broker SETTLED 结果、唯一 admission candidate 和原 Session receipt。
保留现有 LOCAL 行为，以及全部 publication 大小、容量、摘要、过期和所有权检查。
CSI 退役仍为 DRAINING，保留 holder 和 active slot。

本片不计划增加 HTTP 请求标志、grant、token、worker boot 字段、迁移或公共 selector。
本片不认证全部持久化权威、严格 drain、DRAINED、checkpoint 恢复、物理释放或新的
ACK 资格。授权 marker 证明封口前获得许可，不证明进入或完成执行。

Registration 是既有不可变数据库权威。Retirement snapshot 固定其 alias/revision
和物理身份，没有对每个 registration JSON 字段保存独立 digest。Consumer 会校验
已保存 registration 及其列，并依赖 register API 的不可变约束；不能认证对具有
数据库特权者直接一致替换整行的检测能力。

## 原身份与授权

解析已保存的封闭 publication binding，将 tenant、workspace、Harness Session、
Runtime Session、binding ID/generation、turn、tool call、publication ID、
request digest 和 argument digest 与实际 Broker 记录逐项匹配。CSI 要求原生 JDBC
repository 与 publication 共享 DataSource。调用方传入的状态或未加锁的发现读取
不能授予许可。

在调用方事务内锁定原 active parent，并从数据库加载 registration、物理 holder
和 retirement。复用完整退役身份校验：reservation、provision seed、registration
revision、physical key、handle、lease digest、attestation 和 sealed version。
缺失、格式异常、替换或不一致的证据均关闭准入。保存的 authorized dispatch
generation 必须匹配该执行的 claim；保存的 binding version 必须严格小于 journal
的 sealed binding version。缺少证据的旧行仍可读取，但不能取得 CSI 收尾许可。

DRAINING 期间，仅原 EXECUTING 或 CANCEL_REQUESTED 执行可以追加有界原输出并完成
capture。PREPARED、DISPATCHING、UNKNOWN 和 ABANDONED 不能生产。SETTLED 执行仅可
回放已完成的相同 producer operation；不能创建新 segment、resource、seal 或 finish。
精确回放仍需匹配原 scope 与已保存 operation 身份。新 grant reserve、renew 和
dispatch 安装继续要求 READY。

## Candidate 与 receipt 结算

Candidate 创建和 receipt 提交使用单独的原结果检查。DRAINING 时要求原 Broker
SETTLED 结果与不可变 FINISHED terminal result 相等，并匹配原身份和封口前 marker。
递归比较完整保存的 Broker JSON tree。数字叶节点按十进制数值比较，遵循 Broker
既有 JSON 值身份：`1` 等于 `1.0`，负零等于零。每个字段、数组位置、字符串和
非数字类型仍严格匹配。不能将已保存小数重新解析为 double；`0.5` 必须与
`0.50000000000000000001` 不同。原 terminal 字节和 digest 仍独立固定。
第一个 candidate 可以在封口后创建，使用现有唯一 admission slot。拒绝不同 outcome、
第二个身份或替换 candidate。现有 committed 与 blocked admission 语义保持不变；
部分 capture 不能变成正常完成交接。

继续要求原 Session writer ID/generation、有效 writer lease、active activation
ID/epoch 和 recovery 状态。关闭或替换 writer/activation 会拒绝后续结算；本设计不
创建新 owner。Receipt 提交原子安装精确的原 outcome/manifest 引用和 tool.receipt
事务，随后将该 publication 标记为 REFERENCED。回放必须匹配原 journal revision
与 sequence。
结果 admission 保留原 writer 授权和固定 publication 证据；FINISHED 后不额外要求
producer token 或仍为 OPEN、未过期的 producer grant。增加该要求可能永久阻断
已完成原结果。Producer 写入继续要求原 grant 有效。

## 事务与锁顺序

所有参与的 CSI publication 写入在 publication 锁之前获取现有退役锁顺序：
placement domain、active binding slot、binding、registration、物理 holder、
retirement、原 execution；随后是 publication tenant、Session head、publication、
operation 和 object 行。权威读取使用同一个 Spring 事务连接。不得将独立提交的
inspect 或拒绝 ambient transaction 的退役命令作为证明。新 CSI reservation
也需要 parent 锁和写入前 READY 复查，避免与已提交封口竞争。

对象 I/O 期间不持有 SQL 锁。初始 claim 和最终安装均重新获取原授权检查。
锁等待后重新读取数据库时间，保留过期、claim epoch、token、容量和 quarantine
行为。Candidate 验证与 receipt 提交在外部读取后重复原结果检查。最终对象安装
通过加锁读取 candidate 行的当前状态，避免 MySQL REPEATABLE READ 旧快照将并发
隔离的对象重新标为 VERIFIED。晚到的 upload
本身不能安装新 VERIFIED resource 或 receipt。仅隔离原无效对象的失败路径继续
保守处理，不得将其误称为离线只读检查。

仅公开原生 JDBC execution repository 的同连接 FOR UPDATE reader 和 DataSource
身份检查。CSI store 的 package-private 方法返回已锁原 binding 与既有 retirement：
READY 要求原 RESERVED holder 且没有 intent；DRAINING 要求完整已提交 intent 校验。
Grant store 向 producer claim 调用方返回实际 execution 和封闭 binding；SETTLED
调用方必须走独立的精确 SUCCEEDED 回放分支。其他 producer SQL stage 拒绝 SETTLED。
Candidate 和 receipt 使用独立原 settled-result 检查，保留 grants → data → admission
依赖方向。不增加可配置 provider 或替代权威。

CSI 分阶段 producer/admission 公共调用在 claim 或对象 I/O 前拒绝 ambient Spring
transaction，避免原短 TransactionTemplate stage 意外跨对象 I/O 保留 SQL 锁。
内部检查要求调用方已绑定的事务连接。错误清理先锁原 publication，再锁其 operation，
保留原 claim-epoch 条件；它不能授权成功或释放 CSI holder。LOCAL ambient 行为保留。

## 验证与验收

记录全局 CLI baseline，对未暴露的边界使用自有私有 Java/DB fixture。Baseline
必须使用真实 CSI registration/reservation 和已提交 retirement journal，不得将
LOCAL DRAINING fixture 称为 CSI 证明。通过生产 API 完成 prepare、reserve、
authorize、seal 和 settle，不通过 fixture SQL 伪造授权或结算。

正例从 READY 开始，reserve 并校验原 grant，记录原生 dispatch 授权，执行退役封口，
完成 producer 输出，结算 Broker 结果，在封口后创建第一个唯一 candidate，最后
提交并回放原 receipt。核对全部身份和字节；holder 与 slot 保留在 DRAINING。
覆盖 inline 和延迟对象存储路径。

负例覆盖缺失或冲突的 journal/marker/身份、封口先于授权、旧行、新 reserve/renew/
install、错误执行或 candidate、UNKNOWN/ABANDONED、Session/activation 替换、
grant 过期、晚到最终安装和通用 CAS 伪造。观察 MySQL 在 seal/publication 两种
顺序下的真实锁等待、rollback 与独立进程 reload。重跑相关 LOCAL publication
回归、迁移测试、build/typecheck/bundle 和两项 Java checkstyle。检查独立原始
证据，完成两轮干净自审与分片审查后，才能声明本片完成。

## 实施入口与后续

写入口包括两个 grant 事务、十五个 data 事务和一个 receipt 事务。Producer claim、
最终安装、scan heartbeat 和 operation recovery 使用原授权检查；admission 两个
stage 与 receipt 提交使用原结果检查。Quarantine 保持单向失败写入；abandonment
仅清理原 operation claim。后续离线持久化 inventory 与物理退役 coordinator
仍是独立工作。

## 已验证证据

2026-10-02，原 CSI 数据库 baseline 复现了五项断言。最终实现通过 173 个 Broker
和 102 个 Managed Server 聚焦测试、两项 Java checkstyle，以及根目录
build/typecheck/bundle。最终独立验证通过 41 组：28 组 H2、六组数值/当前 terminal
补验、六组 MySQL 和一组 MySQL REPEATABLE READ quarantine 竞争。

实际独立 JVM 观察了 publication 先进入和 seal 先进入的 RECORD 锁等待。
原已授权输出在两种顺序下均完成；封口后的 renew 被拒绝。SQL trigger 使最终
admission 安装回滚，随后精确重试及独立 JVM reload 成功。完整原 capture、SETTLED
结果、首个 candidate 和已提交/回放 receipt 匹配；holder 和 slot 保留在 DRAINING。
并发校验失败后，等待中的最终阶段恢复时仍保留 candidate 为 QUARANTINED，没有
安装 root。

已记录复现促成事务 proxy、当前 quarantine/terminal 检查、最终对象当前读取，以及
精确数字比较的修复。最终数字链在真实 JDBC reload 后允许 `1.0`、`0.0` 和 `-0.0`，
拒绝 `0.6` 和上述不同的高精度值。失败的 helper 尝试单独保留。最终验证期间
源码/class/resource 和依赖 SHA 稳定；自有数据库、进程、端口与临时数据均已清理。
冻结的 ACK worker archive 未变化。

MySQL consumer 验证显式使用 UTC JVM、driver 和数据库 session。既有 publication
lease 转换会在 dispatch 校验前拒绝 CST JVM/UTC driver 的组合；本次结果不认证
该组合。正式 medium-effort SDK 目录审查包含此前改动，在 15 分钟（900343 ms）后
超时，没有报告或结论，不构成批准。本地分片也不认证 Linux/ACK 执行、持久
checkpoint/ACK/MCP 结算、DRAINED 或物理释放。

最终限定范围审查核对冻结的 Java 改动及对应原始证据，确认已报告的三个缺陷均
已修复，本片没有仍成立的已确认缺陷。两轮干净自审覆盖完整分片 diff；最终文档
和状态记录另行核对。此本地结论不替代正式审查结论。

另外两组 MySQL receipt 锁等待补验单独通过。晚到的 CANDIDATE verifier 不能
隔离已 VERIFIED 对象；VERIFIED 对象读取失败会隔离 publication 并阻止 receipt
提交。提出的 receipt 快照缺陷未在这些真实路径中复现，无需代码修改；原 41 组
证据保持不变。
