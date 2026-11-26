# 跨 Java 实例读取常驻 Harness 状态

[English](2026-11-26-managed-harness-unattached-status.md) | [简体中文](2026-11-26-managed-harness-unattached-status.zh-CN.md)

## 范围

在多个 Managed Agent Java 实例后面运行 external runner 时，只有持有 Harness attachment 的实例能读取实时证据，导致恢复视图可能不一致。读请求不能加载 Session，因为加载可能延长驻留时间或取得 writer。此次只改恢复 GET 和单 Session 投影，适用于共享 Harness 或 Harness 池的 Java 实例。

## 设计

受 bearer token 保护的私有 Harness status 路由允许不带 attachment ID 读取常驻 Session。如果提供了 ID，仍必须匹配。Java SDK 提供对应的无 attachment 读取。external Workspace 没有本地 attachment 时，控制面使用该读取；Harness 池只查询持久化记录中的活跃 owner，不改投其他成员。Session 不常驻时不提供实时证据。读取失败或证据不匹配不能放行发送。原有的持久化证明、精确 prompt 匹配和活跃 Turn 闸门保持不变。

如果活跃 Turn 的原生终态已写入日志，恢复视图会显示等待结算。对于其他带恢复意图的活跃 Turn，可以读取 external runner 的实时证据。读取不会加载 Session、延长其驻留或取得 writer。显式恢复 recheck、协调器回放、请求准入以及接管路径保持不变。另行调查其他 Java 实例仍存活时的接管行为。

## 验收

对同一 Session 和 prompt，有无本地 attachment 的实例应给出相同的恢复视图，包括 SQL 写入终态失败和带恢复意图的活跃 Turn。活跃 Turn 仍阻止新输入。验证无 attachment 的读取不会建立 attachment 或改变 placement，以及未知 Session 和错误 client ID 仍被拒绝。
