# 完整私有 CSI 冷恢复

[English](2026-10-19-private-csi-complete-recovery.md) | [简体中文](2026-10-19-private-csi-complete-recovery.zh-CN.md)

## 状态与问题

本候选从累计 PR #13526 的 `1a6529b73c007044d9d04e0614fbc30ebe13c0ac`
提取，独立基于 #14523 合入后的 main。当前拆分候选尚待验证；累计分支的历史证据
不赋予本候选验收资格。

主干可在原 writer 和 activation 到期后恢复首个回执完整的私有文件 batch，但会拒绝
已结算 execution 缺少耐久回执，或最终完整模型输出已提交、结果尚未消费的窗口。
重复文件操作或重新请求模型都不能安全恢复这些窗口。

## 范围与决策

保留原无 deadline prompt、READY Runtime、worker、binding、不可变 execution grant
及完整成功/错误结果。所有 execution 必须 SETTLED 且未取消。保留已合入的确定性拒绝
前缀、provider ordinal、已有 outcome/message 准确身份、inline 容量限制及原子完整输出。
PREPARED、执行中、UNKNOWN、不完整或外来成员、活跃 owner 和不支持的尾部继续拒绝。

缺失回执恢复在原认证私有 batch read 上携带当前已安装的 writer/activation tuple。
SQL 在原 Connection 上独立校验整个原 batch、持久 grant 和 result。原 preparation read
继续只返回原字段，不返回完整结果字节。仅已安装的合格后继能读取有界的原 result/grant
字节；两种读取均不授予 prepare、execute 或 dispatch 权限。

Hosted 在首次耐久写入前校验完整修复计划。已有回执继续决定消息 UUID、timestamp、model
和 Parts。缺失回执通过既有原子 outcome/receipt 发布建立一次身份；中断重试复用该已提交
身份。只补缺失消息和原未 resolve checkpoint。原拒绝结果保留身份及 provider 顺序，
不得重复文件副作用。

完整输出恢复必须具有原子输出事务、准确 model attempt/checkpoint/route、assistant 消息、
完整且未消费的工具成员及已关闭历史。仅有 output marker 不足以恢复。后继绕过模型 runner，
消费原结果并仅结算一次，不新建 assistant 身份或模型请求。普通无工具最终输出及主干共享
turn outcome 行为保持。

Writer claim 和 activation install 仍为独立事务。按数据库时间自然到期后，可替代尚未安装
activation 的废弃 claim，不跳过已安装 epoch。过期 owner 不得读取恢复字节、renew、重放
或发布。READ COMMITTED 和预热 REPEATABLE READ 并发 claim 必须仅有一个胜者，并保留
所有无关行和文件。

## 组件与边界

私有 recovery helper、有界 batch reader、attachment 和 CSI text runner 与 native SQL
batch/read/receipt 及 cold-tail 准入一同修改。共享模型/activation 仅在真实恢复消费者需要时
改动。不改 schema，不增加公开 selector、凭据、替代 worker、应用退役、物理释放或卷复用。

独立的应用退役切片仅支持已正常结算的原始 generation-1/epoch-1 owner；恢复后 owner 的
退役不在两个切片范围内。

## 验证与验收

先用全局 CLI 执行基线，准确记录不可达私有路由；内部路径不可达时采用真实 native/Hosted
脚本回退。验证原成功/错误结果、混合接受/拒绝 ordinal、整 batch 预检、容量拒绝、缺失回执、
重复中断及已有身份复用。验证完整输出恢复不请求模型、不执行文件操作，拒绝 marker-only 或
被修改证据。

运行包内针对性测试、根 build/typecheck/bundle 及完整 Java verify。使用一次性 MySQL 8.4
验证 cold acquire、拒绝时全表镜像和 RC/RR 竞争。真实进程死亡与注入 callback/重开 authority
分别记录。平台前置条件可用时运行对应 Hosted/fault 回归，明确披露不可用或失败的检查。

审阅完整拆分 diff，直到连续两次自审干净。仍需维护者独立架构评审；原生 Linux mount、CSI、
部署 confinement 和云环境资格分别验收。
