# 恢复回执完整的私有 CSI Turn

[English](2026-10-18-private-csi-receipt-recovery.md) | [简体中文](2026-10-18-private-csi-receipt-recovery.zh-CN.md)

状态：已实现的 Draft 待审候选。本改动接续 PR #14487，从累计 PR #13526 拆出首个冷恢复断点。有界本地 CLI/H2/MySQL 及真实私有接入检查通过；完整 K2 恢复、OS 进程崩溃及已部署 CSI 资格仍待完成。

## 问题与当前行为

原私有 Hosted 文件调用方可以完成 Read/Write/Edit，保存完整结果并提交回执。如果进程在全部原始结果消息和检查点提交前停止，新的 Hosted 进程无法继续：私有 SQL 准入拒绝替代 writer，调用方也要求全新日志及 writer generation、activation epoch 均为 1。已有写操作可能已经完成，因此不能通过重复文件操作来恢复。

PR #14487 合入前继续作为本 PR 的基线。它的正常执行、持久拒绝结果、完整结果容量检查及最终输出修复都是前置条件，拆分时必须保留。

## 范围与要求

支持一个原始、无 deadline 的 prompt 和一个已准入文件批次，要求所有关联执行均为 SETTLED，具有不可变 grant、完整 success/error 结果和原始持久回执。根据数据库时间，旧 writer 租约及旧 activation 必须均已过期。继续使用原 provision、READY Runtime Session、binding、mount、worker 和保留历史。

冷 claim 必须发生在最后一次原工具检查点 resolve 之前，该 resolve 会清除原生 pending batch。已经安装的后继重复修复时可以观察到 `results_ready`，但这不意味着支持 pending batch 被清除后的冷准入。

新 Hosted boot 取得更高 writer generation，安装恰好下一个 activation epoch，只补齐缺失的原始结果消息及检查点 resolve。随后将已保存工具响应交给现有模型循环，正常消费结果并结算。修复期间不分配、prepare、派发或重复任何执行。

缺失回执、executing/PREPARED/UNKNOWN/abandoned 成员、取消、外来成员、证据不完整、仍存活的 owner 及不支持的日志尾部均拒绝。最终模型输出已提交后的恢复属于独立断点，本切片继续拒绝。公开 CSI 选择、替代 worker、退役、远端释放、卸载及卷复用均在范围外。

## 设计

### 事务内 writer 与 activation 准入

使用已有私有 Session acquire 操作及凭据。改变 writer 前，在同一 Connection 上按现有 parent/head/resource/execution 锁顺序，校验有界完整原生日志、原始资源关联和关联执行清单。阻塞读取后使用当前数据库时间，检查回执完整尾部及两个过期租约。资格校验失败必须保持全部持久状态不变。

Writer claim 和后继 activation 安装继续是两个独立事务。未安装的 claim 不能发布资源、重放旧命令或修改原生日志，仅能进行已获资格的后继安装。中途崩溃的 claim 可以过期并被替代，但不能跳过已安装的 activation epoch。

按原始 writer/activation 分段重放日志。Genesis 保持 generation 1；续租保持在原安装段内；后继安装使用新 boot 和 activation ID、严格更高 writer generation 及下一个 activation epoch。绝不重写旧事务、grant 或回执身份。完全相同的旧命令重放也必须通过当前 writer 凭据及有效租约检查。普通 Session 语义保持不变。

### 私有 Hosted 恢复

获准的后继接入加载已有 authority，不发布新 definition/root，也不绑定另一个历史目录。核对原 prompt ID 和输入字节。在 Harness 模型门之前，完整预检有序回执批次、原始函数身份、outcome 字节、结果消息及检查点引用。

复用每份 outcome 持久保存的消息 UUID、时间戳、model 和 Parts。已有消息必须完全一致，且构成有序前缀。只追加缺失消息，只 resolve 原 in-progress 成员，保持 settled 引用不变。后续成员有误时，必须在任何修复写入之前拒绝。仅使用保留 worker 的 snapshot 关闭待完成文件历史义务。

让现有私有文本 runner 使用投影出的原 Turn 和已保存工具结果继续运行，不重复提交 input 或 user 消息。消费结果时采用后继 activation，保留其他检查点身份及原 outcome 引用。保留 PR #14487 的 inline 容量、取消及最终输出原子提交行为。

## 受影响组件

私有 Hosted 接入、回执恢复 helper、文本 runner 和文件工具消费者，与 Java 原生 activation proof、冷执行资格校验及 Managed Session writer 准入一起改动。增加同目录行为测试和连通的 Hosted/SQL 恢复见证。计划不改 schema、部署或公开 API 契约。

## 验证与验收

1. 确认全局安装 CLI 的基线；私有路由无法进入时如实记录，再将拆分候选与 PR #14487 比较。
2. 验证完整批次预检、原消息身份、重复恢复、prompt/证据变化拒绝、ordinal 间隙及没有新文件派发。
3. 验证 activation 分段重放、过期 owner 准入、存活 owner 和不完整尾部拒绝、旧 owner 的重放/续租/发布拒绝，以及安装前中断的 claim。准入失败保持原 SQL 状态不变。
4. 运行受影响包测试、root build/typecheck/bundle 和 Java verification。SQL 恢复使用一次性 MySQL 8.4 及对应 Hosted/fault 检查；单独 H2 或模拟传输不能资格化 InnoDB 或进程恢复。
5. 在可用条件下使用真实 Hosted producer 连接真实 SQL/Broker/worker consumer。明确记录 mount/placement facade，区分这些证据与原生 Linux CSI 或部署集群验收。

要求两轮完整 diff 自审连续 clean，并进行独立审查。不可用检查如实记录，不转换为成功验收。
当前 Codex 缺少仓库完整本地 `/review` 工作流所需的 Workflow 工具，该审查仍待完成。

## 风险与待决事项

改动跨越 CLI 及持久 Java 准入，需要维护者架构评审。PR #14487 尚未裁定的容量策略仍是前置条件，本拆分不代为决定。完整结果 body 继续保持 64 KiB 持久化上限。后续缺失回执和已提交最终输出断点需要单独审阅与验收。累计证据中的安装、物理释放或安全复用资格不转授本候选。
