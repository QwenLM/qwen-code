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

Publication 行加锁后，比较完整 binding 和摘要是否与 preflight 目标一致。
Admission 和 quarantine 的加锁行查询也限定原始 tenant、Workspace 和
Session。过期或冲突的目标应拒绝，不能操作另一条 publication。

不改变路由、schema、公开选择入口或私有 CSI 执行权限。已校验目标缺少已有
placement guard 时允许重建。如果外层调用者捕获后续失败并提交事务，此
metadata 可能保留；这不证明 admission 成功，也不证明发生了文件效果。

## 验证和验收

用固定主干基线和候选执行相同并发调度。确认竞争 placement 的事务不会与
publication mutation 或 admission preflight 死锁。覆盖独立事务和外层事务。
验证持久行 scope、binding key、publication ID、摘要、持久 Runtime tenant、
Workspace 和 generation 冲突会在选择 placement 前拒绝，并回滚 publication、
quota 和 journal 变更。普通缺少 Session 的 reservation 和精确重放继续可用。

执行受影响 publication/admission 测试、Java 静态检查、打包、根目录
build/typecheck、独立数据库验证和两次干净的完整 diff 自审。报告实际数据库
隔离级别和调度。H2 测试不能单独证明 MySQL 竞争行为。本拆分不证明完整 K2、
物理释放、CSI unpublish、卷复用或 generic retention 闭合。
