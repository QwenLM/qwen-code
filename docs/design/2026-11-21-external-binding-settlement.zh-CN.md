# 结清历史 external 绑定

[English](2026-11-21-external-binding-settlement.md) | [简体中文](2026-11-21-external-binding-settlement.zh-CN.md)

## 问题与范围

历史 EPHEMERAL 绑定在平台资源已终止、或原请求尚未分配就被拒绝后，仍可能阻塞 placement。当前执行 profile 无法重建历史 boot 字节。本次只结清原绑定，不授权历史 profile 执行，也不替换存活 Worker。

## 决策

终态退役只对已保存的 provider、seed、request 与 handle 身份做结构校验。可信宿主必须独立重新观察原始分配确已终止。现有整个工作区的空闲、归属、版本、slot 和存储约束保持有效。

从未分配的取消是独立路径。宿主在同一分配互斥锁下，为精确原请求持久写入不可变 REJECTED 取消墓碑。所有后续分配在调用平台前先检查墓碑。已有任何分配回执（包括结果未知）均拒绝取消。

MAS 接受可信取消验证器，不接受客户端证据。检查 OWNER、已注册 EPHEMERAL 存储、精确工作区及绑定代次与版本、PROVISIONING 或 RECOVERY_BLOCKED 状态、无 lease、无 attestation、无存活绑定操作、无 runtime-session/tool 历史，且该绑定未占用存储。只释放原绑定及其精确 slot。较新绑定与 slot、其他绑定的 holder、工作区状态及业务会话保持不变。

两条路径在既有 WORKSPACE_RETIREMENT 审计中保存不可变且独立的证明类型。取消使用 version 2 plan 和 NEVER_ALLOCATED_AND_CANCELLED 证明，不伪造 Sandbox 或 Terminated 观察。不新增 DDL。宿主墓碑先提交，MAS 再释放；两次提交之间失败会安全保留已取消请求，并支持重试。

## 风险与验证

没有回执不等于没有资源，必须同时持久阻断未来分配。平台结果未知时拒绝取消。过期版本、错误身份、活动执行及错误归属均拒绝原生释放写入。执行 profile 准入保持不变。

定向回归覆盖历史终态身份可验证但仍不可执行、取消幂等、过期或错误证明、执行与 attestation 拒绝，以及其他 READY 绑定保持不变。宿主集成验证必须证明：原生释放前已持久取消请求、迟到的原请求无法再分配资源、原绑定达到 RELEASED，并且其他 READY 绑定保持不变。后续 Worker 必须达到实际 READY，仅受理创建请求不能通过此项验证。

## 状态

已实现，并补充退役/取消及 provider 的定向回归覆盖。退役/取消 27 项、provider 39 项已通过。完整仓库验证仍由独立 CI 门禁负责，这些定向结果不代表全量测试覆盖。
