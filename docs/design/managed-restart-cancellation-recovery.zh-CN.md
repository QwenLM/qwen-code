# Managed 重启取消恢复

[English](managed-restart-cancellation-recovery.md) | [简体中文](managed-restart-cancellation-recovery.zh-CN.md)

## 问题与范围

进程验收发现三个相连缺口：瞬态 HTTP 续租重试耗尽后后台调度停止；writer 过期后未收到接纳回复的请求无法取消；恢复被终态拒绝时仍只调用普通取消，未接管 parked Turn。公共失败没有结算原生输入，因此现有关闭检查正确地继续阻断。

本次修复这些路径，不启用 Full Access、不重放 Shell、不恢复过期 writer、不绕过空闲日志检查，也不添加公共 API 字段。完整写租约停机后的自动续聊仍不在范围内。

## 决策

1. 保持健康续租频率。传输错误或可重试 5xx 耗尽单次请求预算后，仅在原 grant 仍有效时以一秒间隔重排。过期、明确拒绝或开始 seal 后停止，包括关闭与在途续租竞态。不隐式获取替代 grant。activation 心跳事务耗尽三次请求后，可在提交开始时的原 writer 租约内继续原样重试，保留相同事务身份、字节及摘要；普通事务仍最多尝试三次。租户锁争用保留共享请求预算，不允许经 activation 重试重新开启预算。提交回复保留并发 writer 续租取得的较晚期限。不可恢复的日志追加失败后停止后台 writer 保活；已知可回滚的非提交拒绝除外。不清除 authority 的写失败锁存。
2. 缺少接纳 epoch 不代表未接纳。只有仍持有效调度 claim 的 owner，在锁定 Session 与原 head，证明 writer 已 seal 或过期，且作用域匹配、未压缩的完整日志空闲后，才可取消不明确请求。在同一事务撤销提交标记并取消。缺失、外来或不完整证据继续阻断；已接纳的原生输入不能走此捷径。
3. 恢复被终态拒绝前，普通取消若返回 `hosted_turn_recovery_required`，须通过取消接管和原 checkpoint/activation/prompt 完成收束。清理失败继续可重试，避免公共 Turn 先进入终态，使原执行再也不可达。
4. `await_runtime` 中结果未知的快照可以尝试取消原 execution 身份。该能力不允许继续运行或重试执行。Runtime 取消仍须观察到终态结果，或保留既有 abandoned/unobserved 区分，才能写入结算。结果未知的 agent/command 等待仍不具备取消条件。

## 约束与风险

保留租户、actor、Workspace、调度 owner、writer 代际及 Runtime 身份检查。不削弱 `requireIdleJournal`，不凭 HTTP202、超时或租约过期认定已停止。永久不可达 Runtime 仍可能阻塞清理；重试必须保留不确定性。跨包 SDK、Harness 与 Java 消费者须一起验证。

## 验证与验收

- 分开保留失败基线测试和前次真实 Linux 证据。
- 覆盖 writer 与 activation 续租预算耗尽、原样重试、并发续租期限不回退、不可恢复追加后停止保活、可回滚拒绝、明确拒绝/过期、seal 竞态及健康频率不变。
- 覆盖有效/过期/sealed writer、已接纳原生输入、压缩/缺失 head、丢失调度 claim。
- 覆盖 parked 取消接管、瞬态清理拒绝、未知 Runtime 取得停止证据与仍未知两种结果、不重放 execute 及公共终态唯一。
- 构建、类型检查并测试受影响 TypeScript 消费者；运行 SDK/server 校验、独立 MySQL 和对应 Hosted 恢复 profile。
- 独立重复真实 Linux/MySQL Java/Harness 替换，核对原 Worker 身份、文件/marker 精确字节、取消/关闭及物理释放。保持原演示不动并恢复测试资源。
