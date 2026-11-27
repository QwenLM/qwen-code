# 跨 Java 实例读取常驻 Harness 状态

[English](2026-11-26-managed-harness-unattached-status.md) | [简体中文](2026-11-26-managed-harness-unattached-status.zh-CN.md)

## 范围

在多个 Managed Agent Java 实例后面运行 external runner 时，只有持有 Harness attachment 的实例能读取实时证据，导致恢复视图可能不一致。读请求不能加载 Session，因为加载可能延长驻留时间或取得 writer。此次只改恢复 GET 和单 Session 投影，适用于共享 Harness 或 Harness 池的 Java 实例。

## 设计

受 bearer token 保护的私有 Harness status 路由允许不带 attachment ID 读取常驻 Session。如果提供了 ID，仍必须匹配。Java SDK 提供对应的无 attachment 读取。external Workspace 没有本地 attachment 时，控制面使用该读取；Harness 池只查询持久化记录中的活跃 owner，不改投其他成员。Session 不常驻时不提供实时证据。读取失败或证据不匹配不能放行发送。原有的持久化证明、精确 prompt 匹配和活跃 Turn 闸门保持不变。

活跃 Turn 的公开视图使用已存储的 Turn 和日志。日志已有原生终态时，视图显示等待结算。无 attachment 状态查询用于非活跃 Turn，HTTP 请求和完整响应体共用一个超时上限，取两秒和已配置请求超时中的较小值。客户端首次协商能力时使用已配置的 Harness 请求超时。返回 null 时继续使用现有的日志就绪判断。响应不可读、超时或 prompt 不匹配时，禁止使用该回退。显式恢复 recheck 校验原 Turn，并通过 attachment 读取原 prompt 的 Harness 证据。

读取不会加载 Session、延长其驻留或取得 writer。协调器回放、请求准入以及接管路径保持不变。另行调查其他 Java 实例仍存活时的接管行为。

## 验收

让两个 Java 副本共用 MySQL 和 Hosted Harness，验证带恢复意图的活跃 Turn 在两个副本上的公开恢复视图均来自持久化状态，两边都阻止新输入。对 SQL 写入终态失败的同一 Session 和 prompt，对比有无本地 attachment 时的恢复视图。验证无 attachment 的读取不会建立 attachment 或改变 placement，响应体未完成时会超时且发送仍被阻止，以及未知 Session 和错误 client ID 仍被拒绝。
