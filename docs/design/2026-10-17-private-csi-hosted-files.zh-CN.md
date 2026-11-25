# 私有 CSI Hosted 文件 Turn

[English](2026-10-17-private-csi-hosted-files.md) | [简体中文](2026-10-17-private-csi-hosted-files.zh-CN.md)

## 状态与问题

本次拆分基于 #14081 已合入的主干 `95b8d377a`，来源为 #13526 在
`b0e9cfca44a156a766476fda9205267988403dc0` 的正常文件 Turn 实现。
现有私有 Session 能运行文本 Turn，原文件 worker、保留文件历史的 backend 和原生
SQL 准入已经存在，但 Hosted 入口尚未将其接到模型工具调用。源分支的测试结果不能
作为本次拆分的验收证据。

## 范围与约束

为预先创建且处于 READY 的原私有 CSI Session 接入 `read_file`、`write_file` 和
`edit`。保持 writer generation 1、activation epoch 1、原 Runtime binding 及既有
私有 capability digest。保留 #14081 的文本入口、认证、budget directive 拒绝、
诊断、精确 prompt 重试和本地停止行为。

不引入替代 writer、冷恢复、应用 cut/finalize、远端 seal、物理停止、卸载、释放、
卷复用或公开 CSI 选择。不需要 schema migration 或部署变化。操作不确定时阻止
owner 并保留义务，不重放文件修改，也不丢弃证据。

## 执行与持久化

原 activation 安装后绑定原 worker 的空保留历史，在暴露已接入 Session 前，通过
既有 file-history domain 持久保存准确观察。文件 Turn 前产生正常 Harness
checkpoint，只声明三个受支持的文件工具。

保留 assistant Parts、function ID、Part 位置、准确 input 和工具定义字节。派发前
预留全部已接受 batch。文件修改须先提交 preparation intent，请求原 worker
准备备份，并持久保存观察，随后由 tool intent 和 dispatch checkpoint 授权执行。
只读调用不需要修改准备。

在 Runtime 预留前拒绝非法输入、根目录及超限输入。为每个被拒绝的原 function ID
持久保存明确错误结果；全部被拒绝的 batch 仍可继续模型回合，不伪造 Runtime
工作。原生 reader 根据原始调用及完整输入大小核实准确的拒绝原因，每项拒绝只接受
一次；已准入的工作仍须提供 receipt 证明。修改历史关联到最新提交的拒绝消息，
同时保持原始 batch 身份。批次身份比较 message ID、content reference 和 calls；
拒绝进度不会改变该身份，也不会阻止其余调用被预留。正常预留请求响应回合取消；
prepare 响应丢失或取消后，仍独立读取一次成员身份，上限为五秒。回读失败或回包
不合法时保留原始 preparation 或取消错误，不据此授权再次派发。
发布历史前检查完整持久化 envelope 的大小，包括面向 reader
的快照副本。容量拒绝保留不确定工作，不截断证据，也不重放修改。

经认证 Broker 在固定原 Runtime Session 上执行。保留每份完整 Broker outcome
及转换后的 tool-result message，再完成相应 Harness wait。发布 receipt 前校验
原生结果的封闭 schema，包括错误元数据及 text/media Parts；拒绝外部提供的
functionResponse 或 functionCall，不保存原生 reader 无法验证的 outcome。将结果返回模型前保存
工作后的 file-history 观察；仅在模型消费结果后标记 consumed，并结算正常
continuation，不释放 Runtime。超限、不完整或不确定结果阻止 Session。取消和
本地停止不能证明远端工作从未执行。

在标记文件结果 consumed 前，将最终 assistant 正文与成功的 model-attempt 事件
一并提交，保留原流式 message ID 和 Parts，不再写入第二份 assistant record。
模型继续失败或最终提交不确定时保留未消费结果并阻止 owner。

在 authority 队列内，使用最终 state 字节和 covered sequence 分配 Harness
checkpoint 的 command ID 和 content digest。activation 续租可能在 checkpoint
构造与提交之间推进 journal，命令必须准确描述实际发布的 checkpoint。

## 集成与归属

既有私有路由继续为经过认证的 loopback operator 路由，owner map 指向原 live
Session。Broker 请求保持 tenant、Workspace、Harness Session、Runtime Session、
binding 和 generation，选定 worker 验证其已安装 context。不允许回退 primary
runtime 或本地执行。

实现将 Hosted 文件 Turn adapter、history client 和 receipt writer 放在文本
producer 旁，仅在必要处扩展私有文本 Turn runner 和 attachment 初始化。仅当正常
producer 必须时调整共享 model/Harness 接口。累计分支的恢复、退役和通用 Hosted
重构不进入本次拆分。测试覆盖这些 consumer，并以实际 producer 字节验证原生 SQL
reader，不另造一种 journal 形状作为验收。

## 验证与验收

先对全局安装 CLI 做 dry-run，再使用自有 inference、Broker 和 Store HTTP fixture
验证构建后 CLI，覆盖三种文件调用、准确 input/result 身份、修改准备、重试、拒绝、
停止和清理。明确标注每个 fixture 边界；HTTP fixture 不能验收 Linux CSI worker
或 MySQL 事务。

执行 root build、typecheck、bundle 和受影响 CLI/Core 单元测试；受影响时执行
原生 Java producer 到 SQL 接纳测试及模块静态检查。事务和并发变化必须使用可丢弃
MySQL 8.4 检查。Linux、MySQL 和部署后完整链路中不可用的检查分别报告。完整 diff
经过两轮干净自审及独立代码评审。

验收要求正常文件 Turn 完整闭环、保留备份和结果、原 ownership 不变、准确重试不再
修改文件、错误身份和未支持工具被拒绝，以及本地清理等待已进入工作。物理退役和
安全复用继续作为 #13526 的独立工作。

## 开放问题

有界拆分没有开放问题。新增恢复、安装或物理释放要求需单独设计和评审。
