# K2 规范 schema 下的完整输出恢复验收

[English](2026-10-18-k2-canonical-complete-output.md) | [简体中文](2026-10-18-k2-canonical-complete-output.zh-CN.md)

## 状态与问题

本文记录当前 schema 下 C8 有界真实进程验收及其计划。原子持久化最终输出及冷恢复已按[主要 K2 设计](2026-10-09-k2-native-history-integration.zh-CN.md)实现。其中历史上的有界进程结果早于规范 schema 和当前组合，不能证明当前 schema 已通过验收。当前 C6 在 receipt 切点之前复现了生产者与校验器的上下文窗口元数据不一致。配对规范 C6 文档已记录其修正、合并后的模块检查及全新完整进程链通过；独立的全新 C8 运行及审计现已通过，结果记录如下。

C8 必须恢复所有者死亡前已实际提交、但尚未消费结果的完整最终 assistant 响应。现有的单独 attempt marker 不足以证明完整输出。本次增量用于增加进程证据，只有复现出生产缺陷时才修正生产代码；不会增加恢复许可。

## 组合与边界

采用[规范 C6](2026-10-18-k2-canonical-cold-process.zh-CN.md)所声明的相同组合：fixture JVM 中的当前生产 provisioner、Broker 和持久化 Store；实际打包的 text Main 与 Hosted 进程；独立运行的已构建生产文件 worker；应用全部当前迁移的自有一次性 MySQL 8.4；以及本地确定性 SSE 模型。每个 text 所有者具有隔离 home、原始 prompt 身份、记录的 boot ID 和登记的操作系统进程身份。

保留本地 Kubernetes API、placement、mount、proc-FD 和 Darwin 的明确边界。worker 只绑定一次，使用已经存在且验证过本机可达性的非 loopback 地址。使用默认生产 HTTP transport 和现有 JDK 代理行为，不重映射目标地址，也不修改系统网络。这不构成原生 CSI mount、已部署 Server、内核约束、actor 闭包、物理退役或卷复用验收。

启动前冻结源码、编译产物、辅助类、实际使用的同工作树 Java SDK classpath、已安装 Node 依赖、JDK 配置及明确的运行输入。源码未提交时，记录父提交和工作树补丁。加载的 Node 文件必须属于固定输入集合；执行后比较整个集合。这些哈希用于限定输入，不证明原生不可变性，也不证明操作系统及动态加载器输入的闭包。

## 故障切点

原始所有者必须产生两次真实模型请求。第一次对真实自有文件请求有限的 Read/Write batch；两项实际 execution、原始 outcome 引用和结果历史必须完成 settled。第二次返回包含完整 Parts 和 usage 的最终 assistant 文本。透明 Store 代理仅在实际 SQL 事务提交后、向 Hosted 交付前，扣住原始成功的上游响应。

切点必须是原始 `hostedModelAttempt` / `*:output_committed` 事务，其中恰好包含相邻的 `model.attempt`、`message.committed` 事件及其 commit marker。attempt 为 `output_committed`，assistant 消息指向同一个 attempt。必须保留完整原始 assistant resource、流式消息身份、UUID、时间戳、model、parent、Parts、route、输入 checkpoint、usage 引用及其原始字节和摘要。第一次工具调用响应中的单独 marker 绝不能触发此切点。

切点上的 checkpoint 为 `results_ready`，所有原始 tool item 均为 `settled` 且未消费，file-history preparation 为 null，不存在消费或 turn settlement。对登记的原始 Main 和 Hosted 进程都执行 SIGKILL，回读退出，并保留 worker、数据库和文件。观察数据库时间，直到未经修改的 60000 ms writer 和 activation lease 都自然到期。不得更新到期字段、注入时钟、seal、release、追加 journal，或创建原生 authority 来推进场景。

## 恢复与守恒

使用完全相同的原始 prompt ID 和文本，启动一组新的实际打包 Main/Hosted 进程。它必须真实取得 writer generation 2、安装 activation epoch 2、读取原始完整输出尾部，并绕过模型运行器。随后由生产路径消费一次原始结果、记录 `turn_settled`、settle 原始 turn，并返回可接受下一轮的状态。最终必须为原始 prompt 返回 completed、`end_turn` 的 `turn_result`。

整个场景只能存在两次模型请求及两项原始工具 execution。恢复不得产生第三次请求、新 model attempt、最终 assistant 身份、tool intent、execution、receipt、工具修复消息或文件副作用。最终 checkpoint 必须为 `before_model`，pending owners 为空，attempt、tools、Runtime 和 approval 状态为 null，同时保留原始 prompt 和 turn 身份。

比较切点、死亡、到期和完成时全部 35 张规范表的完整类型化镜像。保留原始 journal 前缀、不可变 resources、result/grant 字节、execution 行、完整 batch 成员以及 worker 请求和副作用计数。保留工作文件及备份的字节、device 和 inode。每个变化的 resource 校验时间戳都必须对应捕获的同 scope 成功 GET，以及实际 returned/verified read receipt 的数据库时间范围；未结束 resource-read lease 必须为零。不得放行无关时间戳漂移，也不得编造时区例外。新增 head、activation、read 和 consume/settlement 状态必须与实际成功的生产操作相符。

## 验证与清理

独立 test engineer 在 C6 修正门禁后运行新冻结的场景。保留原始 HTTP 请求和上游响应、模型请求、完整 SQL 镜像、journal/resources、数据库时钟样本、加载输入记录、进程身份和死亡回读、最终输出及清理证据。独立审计这些原始观察；仅有 coordinator 的 PASS 不足以验收。单独保留任何失败尝试，不得通过修改报告器将其改记为通过。

只停止登记的自有进程和端点，删除自有数据库和用户、data/socket 及 worker 临时树，并回读进程缺席、连接拒绝和存储删除。失败时必须保留阶段和原始产物，区分观察器或 fixture 失败与生产拒绝，并在准备新 scope 前完成自有资源清理。

## 当前规范版本的实测结果

2026-10-19，全新自有 scope `canonical-c8-41uvnl12` 在父提交 `6717ce88820dc99982b14350ae777669a42b2907` 加与已通过 C6 相同的五文件代码补丁上完成（SHA-256 `bc2a53e3debd17ed258e3eb333a41f0c69d8d659e6ed11cf698239da4480b035`）。真实原 model2 原子事务上游返回 200，包含两个事件、三个 record；其 3,470 个原始 record 字节及 event/commit/content 摘要均经独立重算。更早的 model1 单独 marker 事务正常交付。截留响应时，writer generation/epoch 为 1/1、revision 24/sequence 25，checkpoint 为 `results_ready`，两个原工具已 settled 且未消费。原 Main/Hosted 均实际因 SIGKILL 退出。保留原数据库、worker 和文件，111 个数据库时钟样本观察到未经修改的 60 秒 lease 自然到期。

后继真实取得 generation 2 并安装 epoch 2。它仅新增四个 journal 事务，分别安装 activation、消费结果、记录 turn settlement 和 settle turn；最终 revision/sequence 为 28/30，checkpoint 为 `before_model`。实际模型请求仍恰好两个。原 assistant Parts、usage、route/input-checkpoint 引用、stream UUID/parent/timestamp 及完整原 resource 字节，在提交、死亡、到期和完成时均保持。恢复未创建 model attempt、assistant/delta、tool 事件或 repair message。两条 native execution、十六个原 worker 请求、438 项观察到的文件操作，以及工作文件/备份的字节、device 和 inode 均完全一致。最终 Main 仅为原 prompt 输出一次 completed/end_turn 结果。

独立全镜像审计核对全部 35 张表：30 张完全不变，仅 head、四个 journal 行、五个新 resource、十一个 reference 及二十五个新增 read receipt 经各自真实 producer 改变。十一个旧 resource 行只改变校验字段，均由捕获的成功读取解释。35 个成功 GET 全部匹配 35 个 RETURNED receipt，符合实际数据库时间不等式及原 scope/token/body；没有未结束 read lease。这不是对时间戳的笼统放行。

前后检查覆盖 128,634 个文件和 187 个 symlink，无漂移；coordinator/worker/原始与后继进程实际加载文件均位于该闭包内，七份 helper 全部匹配归档输入。Runtime Boot 嵌入实际同工作树 SDK 字节。独立清理确认十一项场景进程身份和单独 preflight 进程缺席、八个端点关闭、十二个运行路径删除，没有自有 orphan。专属数据库/用户在 MySQL 正常关闭前删除，其 data/socket 已移除。Runner 与覆盖完整输出切点、全表镜像、读取、runtime/framing 及清理的五份独立审计报告均通过。本结果只接受一个有界当前 schema 的消费前 C8 场景，不覆盖全部后续切点或原生 K2。

## 验收与剩余工作

通过要求真实的原子完整输出切点、所有者实际进程死亡、lease 自然到期、generation-2/epoch-2 生产恢复、完全相同的原始完整输出身份、没有 model3 或重复副作用、一次 consume/settle/idle 链，以及独立验证的守恒和清理。现有 legacy marker-only 拒绝仍是必需边界；不得改写捕获的 payload，将其伪装成完整输出。

已消费或已 settled 的更晚切点、穷尽输出媒体、provider 作者身份、Linux/云端验收、原生 actor 约束及安装、物理退役和复用仍是独立工作。该本地场景不能证明完整 K2 已完成。
