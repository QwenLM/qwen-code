# CSI 退休前的持久派发授权

[English](2026-10-02-csi-dispatch-authorization.md) | [简体中文](2026-10-02-csi-dispatch-authorization.zh-CN.md)

状态：已实现并在本地验证，限定范围的独立审查未发现已确认的问题；正式审查超时，
没有结论。这是 [K2c](2026-10-01-managed-kubernetes-k2.zh-CN.md) 的前置条件，
之后才能允许 DRAINING 中的
[原 publication 结算](2026-10-02-csi-original-publication-settlement.zh-CN.md)。

## 问题与当前行为

execution 的 dispatch generation 记录 coordinator 认领，不代表执行授权。
认领在父级准入检查失败后可能成为 UNKNOWN。SETTLED 也可能来自派发前取消或
reconciliation。当前状态和时间戳均不能证明 CSI 封口前已授权。
目前 publication producer 要求 READY，因此父级进入 DRAINING 后，也会拒绝
原已授权 execution 的输出收尾。

## 拟议改动

在原 execution 行增加可空 `authorized_dispatch_generation` 与
`authorized_binding_version`。原子 `authorizeDispatch` 在 DISPATCHING 转为
EXECUTING 的同一事务中，记录当前 dispatch generation 和已锁定父记录的 version。
内存实现遵守相同的所有权检查。coordinator 认领、错误 owner、过期 version、取消、
关闭的 Session 或封口的父级都不能写入这对字段。

JDBC 沿用同一 DataSource 上具体 Session/execution repository 的要求。
内存证据要求两者都为原生内存 repository，使 Session 变更使用准入持有的同一
monitor。自定义或混合 CSI 组合拒绝。非 CSI 的自定义组合保留原未标记 CAS
路径及所有权 hook，不能提供 CSI 证据。

两个字段必须同时缺失或同时存在。dispatch generation 为正且匹配 execution 的
dispatch generation；binding version 非负。后续续租、取消、UNKNOWN、
reconciliation、结算和 abandonment 保留这对字段。普通插入与 execution CAS
不能增加、替换或擦除授权。仅原有原子派发准入边界可写入，不增加公开 setter。
CAS 同时比较实际 current 行与 expected、replacement 的授权，伪造 expected
也不能绕过这一限制。
授权专用 CAS 还要求实际 current 行为未取消的 DISPATCHING 且证据缺失。
调用方声明的状态不能为旧的未标记 EXECUTING 行追认授权。

授权检查核对保存的字段，并要求其 binding version 严格小于 retirement journal
的 sealed binding version。这仅回答是否在该 version 前获授权，不证明工具已进入、
输出完成、当前活性或存储可安全释放。后续 publication consumer 还必须匹配已提交的
原 retirement、binding/generation、publication grant、execution 和 Session writer。

## 兼容与影响文件

Managed server 的 Flyway V43（10 月 4 日整合时为 V42，原开发快照为 V30）增加可空列，不回填。私有 Broker schema 及增量
initializer 同时支持新库和已有库。旧行仍可读取，证据保持缺失；CSI 原任务结算
必须拒绝这类行，不能推断或补造授权。LOCAL 派发和结果行为保留现有规则。

改动涉及 execution record、JDBC 与内存 execution repository、两个 binding
repository 的原子授权、私有 schema 和 initializer、一项新 Flyway migration
及相邻测试。现有 caller 继续使用 `authorizeDispatch`，不增加 HTTP route 或
worker boot 字段。升级后的 JDBC repository 必须在 migration 完成后运行。

## 验证与验收

用全局 CLI 检查基线版本；CLI 无法暴露的 DB 边界使用私有 Java 测试脚本回退。
验证真实认领与授权的区别、派发与封口两种锁顺序、错误 owner/generation、
过期/取消/关闭 Session 的拒绝、回滚、独立进程重载、原结果路径中的证据保留、
损坏字段、新建/升级 schema 与 LOCAL 兼容。同时验证 JDBC 和内存实现。
执行 build、typecheck、bundle、聚焦测试与 checkstyle，独立核验 DB 证据，
再对整片进行自审与审查。

## 边界与后续

本前置片不放宽 publication 的 READY 门禁。原 producer finish、唯一 result
admission 与 receipt 结算属于下一 consumer 片，须分析事务和锁顺序。
retirement 保持 DRAINING；worker QUIESCENT 不足以证明持久结算。
不增加 DRAINED、物理释放、云端资格或公开持久 CREATE/selector。
旧行缺失证据属于兼容约束，不能选择从 terminal 状态重建授权。

## 已验证证据

2026-10-02，实施前 JDBC/H2 基线通过五项断言复现字段缺失和原 producer 被拒绝。
实现通过 224 个 Broker 和 84 个 Managed Server 聚焦测试、两个 Java checkstyle
以及根目录 build/typecheck/bundle。最初测试 fixture 的 capability digest 不合法，
最初 V30 也使用了 H2 不支持的多列 ADD；失败记录保留。修正 fixture、改成两条
ALTER 后，原行为断言全部通过。

独立验证通过 13 组 MySQL/原生内存检查和五项 H2 producer 断言。
独立 JVM 实际观察 MySQL RECORD 锁等待的两种顺序：授权先提交 pair `[1, 2]`，
随后 sealed version 为 `3`；封口先完成则拒绝授权，原未标记 claim 不变。
AFTER UPDATE trigger 使整个授权事务真实回滚，再以原任务重试成功。
冻结的 V29 二进制先创建旧行，再执行真实 V30 migration；未回填，原 LOCAL holder、
Hook 和 projection 行保留。独立首轮最后一组的 LOCAL 快照范围过大，仅修正脚本
范围后重跑完整矩阵。生产源码/class/依赖和冻结 worker archive 的 SHA 均未变化；
所有自有 JVM、数据库、端口和临时数据均已清理。

H2 producer 检查确认即使已有 marker，DRAINING 仍被拒绝，前置片没有静默开放
后续 consumer。这属于本地组件证据，不构成新 ACK 资格或完整 K2 验收。

两轮干净自审及针对十二个文件分片的独立审查未发现已确认的问题。正式
medium-effort SDK 目录审查还纳入此前 K2 改动，在 15 分钟（900154 ms）后超时，
没有报告或结论。超时与限定范围的审查均不构成完整功能批准。验证与审查期间
生产源码保持冻结。
