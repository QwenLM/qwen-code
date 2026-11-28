# Managed 控制面 attachment 恢复

[English](2026-11-26-managed-control-plane-attachments.md) | [简体中文](2026-11-26-managed-control-plane-attachments.zh-CN.md)

## 问题

多个 Java 控制面实例可以共用数据库并访问同一个 Hosted Harness，每个实例仍各自维护
Harness attachment 缓存。首个 Turn 记录 Harness boot ID 之前，管理请求可能已经打开
Harness Session。另一个实例随后尝试创建同一 Session，其普通 load 可能被持有该
Session 的 Harness 拒绝。

## 方案

Managed Harness 返回 `hosted_session_already_attached` 时，连接器可以被动加载匹配的
Session，沿用原 Session 身份、Store 描述符、工具配置和审批配置的校验。正常派发器
继续负责 Turn 准入。创建响应丢失时，先走现有 load 路径。该路径明确返回常驻冲突时，
再尝试被动加载。

审批响应可以先被动接入原 Managed Session，再投递决定。Runtime Skill 的候选项、
快照和归档在缓存缺失时走仅管理 attachment。这条加载路径检查是否有匹配的常驻
Session，并保留原 placement 和 Runtime binding 的校验。

活跃 Turn 的恢复视图使用已持久化的 Turn 和 journal 证据。显式恢复操作继续校验原
Harness 和 prompt。待清理操作和缺失的结算证据继续约束下一次提交。

## 范围与验收

使用两个独立 Java 连接器或实例、同一个 Session store 和同一个 Harness。覆盖首个
Turn 前的管理操作、无本地 attachment 节点上的取消和审批，以及两节点读取恢复状态。
验证请求到达原 Session，原生操作指向原 Turn 或 Action，SQL 状态仍阻塞时不会准入新
Turn。SSE 投递和 Runtime Broker 故障切换分别交付。恢复阻塞后的派发扫描仍需要原
Harness 事件流的引用。消除该依赖需要为所有 Hosted profile 提供只读 attachment。
