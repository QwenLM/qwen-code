# Publication 先锁 placement 再锁 retention

[English](2026-10-11-publication-lock-order-split.md) | [简体中文](2026-10-11-publication-lock-order-split.zh-CN.md)

## 问题和范围

Publication mutation 可能先获取 retention 锁，再由 Session writer 路径
获取 placement 锁。Admission 则先锁 placement 再锁 retention，并发事务
因此可能以相反顺序相互等待。外层事务也可能将 preflight 锁一直保留到后续
admission 调用。

从 PR #13526 拆出锁顺序增量，并适配当前主干。覆盖普通和已有 K1 publication
流程的 mutation、admission preparation、admission installation 和
verification quarantine。私有 CSI Session guard、新 producer 限制、
generic retention、native 执行和退役资格仍为独立后续工作。

## 决策和契约

选择 placement 前，读取实际持久化 publication 并验证其 scope、规范 binding
摘要、publication ID 和原始 Runtime 身份。新 reservation 使用已校验的
candidate binding。JDBC Runtime repository 共用数据库时，同时检查持久化
tenant、Workspace、generation 和 provisioner 字段以及发现的 binding。

先锁 placement，再锁 retention、quota 和 Session writer。参与已有事务的
preflight 在可能保留后续锁之前获取同一已校验 placement。独立 preflight
保留已有事务边界。沿用 K1 retention 路径时复用已校验的原始 Runtime。

仓库内 HTTP controller 调用这些 store 时没有外层事务。外层事务契约针对
store 组合，由测试拥有的事务验证；它不证明 controller 管理的事务或完整
HTTP E2E 覆盖。

Publication 行加锁后，比较完整 binding 和摘要是否与 preflight 目标一致。
Admission 和 quarantine 的加锁行查询也限定原始 tenant、Workspace 和
Session。过期或冲突的目标应拒绝，不能操作另一条 publication。

不改变路由、schema、公开选择入口或私有 CSI 执行权限。已校验目标缺少已有
placement guard 时允许重建。如果外层调用者捕获后续失败并提交事务，此
metadata 可能保留；这不证明 admission 成功，也不证明发生了文件效果。

## 风险和范围

普通 `apply` 和 `prepareAdmission` 现在会等待租户级 placement guard，
包括独立事务的 HTTP 调用。因此，长时间持有 placement 锁也会延迟同一租户
其他 Workspace 的 publication。

K1/CSI mutation 现在先通过共享 guard 获取 placement，再执行已有退役检查。
第一次获取没有 statement timeout，因此锁等待由 InnoDB 的
`innodb_lock_wait_timeout` 限制，而不是退役路径的 10 秒 query timeout。

## 验证和验收

用固定主干基线和候选执行相同并发调度。确认竞争 placement 的事务不会与
publication mutation 或 admission preflight 死锁。覆盖独立事务和外层事务。
验证持久行 scope、binding key、publication ID、摘要、持久 Runtime tenant、
Workspace、generation 和 provisioner 冲突会在选择 placement 前拒绝，
在拒绝的事务内以及回滚后检查 guard 和 producer 状态。记录普通外层 receipt
实际执行的 SQL，检查 placement 先于 retention，并保留精确重放和 outcome
字节。普通缺少 Session 的 reservation 和精确重放继续可用。

分别验证发现态 binding 和持久化 Runtime 的 generation 冲突，确保每个
比较都会在获取 placement 前拒绝。

在 `mysql-integration` 下，与持有 placement 的同租户真实普通 Session
authorization 竞争。覆盖外层 receipt、同一外层事务的 admission 加 receipt、
独立 admission、独立 renew 和外层 renew。在 InnoDB 报告竞争事务的锁等待后
才释放 placement 持有者。断言竞争的 JDBC 连接先请求 placement，再请求
retention，排除独立 preflight 在其他连接上已释放的锁。被测事务提前失败时
必须报告其原始原因。将独立 `apply` 或 `prepareAdmission` 中的 placement
与 retention 顺序颠倒时，必须在顺序断言处失败。Receipt 用例也保留精确
重放和 outcome 字节。

执行受影响 publication/admission 测试、Java 静态检查、打包、根目录
build/typecheck、独立数据库验证和两次干净的完整 diff 自审。报告实际数据库
隔离级别和调度。H2 测试不能单独证明 MySQL 竞争行为。本拆分不证明完整 K2、
物理释放、CSI unpublish、卷复用或 generic retention 闭合。
