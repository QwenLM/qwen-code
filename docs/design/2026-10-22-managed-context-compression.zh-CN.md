# Managed 手动上下文压缩

[English](2026-10-22-managed-context-compression.md) | [中文](2026-10-22-managed-context-compression.zh-CN.md)

## 问题与边界

Issue #15080 要求让用户显式选择 Managed Session 历史的压缩时机。本切片提供仅空闲可用的持久 Operation，以及现有上下文用量弹层中的入口。复用 Core 压缩，不创建用户 Turn，不改变审批策略、不改写审计聊天记录，也不修改 Workspace 安装 revision。

当前 Hosted 模型路径从仅含普通消息的投影重建历史。模型投影必须包含压缩检查点，在重新打开和 writer 接管后也保持有效。大快照复用现有消息体分片格式，避免超过 64 KiB 内联资源限制。

## 准入与 API

绑定 Workspace 的 PUBLIC Session 允许 OPERATOR 和 OWNER 操作。执行中或排队的 Turn、审批、未结算 Hook、恢复以及冲突变更返回 session_context_busy。维护期间拒绝普通用户输入；自治输入留在现有持久队列，之后执行。

POST /v1/agents/sessions/{sessionId}/compress 接受 expected_compaction_revision 和 Idempotency-Key。WebShell 孪生接口为 POST /api/agent/web-shell/v1/sessions/compress，使用 camelCase 字段。HTTP 202 返回 context_compression Operation，通过现有操作查询接口读取。状态为 pending、running、recovery_blocked、completed 和 failed；完成结果为 compressed 或 noop。读取鉴权先于按 actor 隔离的重放，重放先于可变角色、能力、revision 和忙碌检查。不同内容复用键返回 idempotency_conflict。

最新 context.compacted 事件序号即 compactionRevision，初始为零，独立于 context_revision。Session 摘要发布此版本和当前压缩操作。WebShell 的 contextCompression 能力反映调用者授权。Public API 能力保持现有部署/支持语义；压缩 POST 始终重新鉴权。私有 Harness 增加 context-compression/1 和独立提交、状态接口；旧 Harness 失败关闭。

没有压缩投影的旧 Session 从经过校验的已提交 journal 前缀按需恢复。证据不可用时隐藏能力并省略 revision。回填与新提交单调推进投影，保留较新的主模型用量观测。

## 执行与持久化

Java ma_operation 记录 CONTEXT_COMPRESSION；预留 history_maintenance 域记录原生执行。来源历史截止位置、模型/provider 身份及参数保持不可变。PreCompact 和 PostCompact 使用各自稳定的 operation occurrence，originTurnId=null。包含新历史、摘要和压缩信息的候选在 PostCompact 前提交。Hosted 压缩不会从 Harness 主机读取最近文件字节。

窄 authority 提交接口原子追加 context.compacted 和最终维护结果。NOOP 和已知失败也保留结果，但不改变历史或 revision。SQL 在 journal 提交事务内投影压缩并使旧用量及资源引用失效。重放结果不能清除后来的观测。原始完整聊天记录继续可读。

在发送前及最终 SQL 事务中重新验证发起者的执行权限。原生接纳后撤销授权会保留候选与恢复屏障；恢复权限后可继续原操作。

Core 在现有压缩记录 payload 边界提供可等待的 observer，保留 pendingUserMessage、summaryPrefixLength 和 completedToolCallIds。自动和手动压缩共享模型历史恢复。已准备模型请求的恢复保持现有优先级。

工具结果恢复也保留最后一条工具调用消息之后记录的压缩快照。按快照声明移除恢复前缀中的待发送响应尾部，再通过现有 resume 路径发送一次。失败或取消的用户输入会被排除，包括嵌在旧快照原始尾部中的输入。

## 恢复

Harness 接纳未知时从原持久证据对账，不能盲目重投。已确认接纳的操作在隔离旧 writer 后恢复。终局直接重放；存在候选时继续 PostCompact 和应用，不重算模型。没有候选时，已开始的纯摘要 attempt 可以标记 abandoned，并用相同来源快照、provider pin 和已保存的 PreCompact 输出创建替代 attempt。模型计费可能重复，历史只提交一次。未知 Hook 执行查询原证据，不重复执行。迟到的旧 writer 丢失 fence 后不能保存候选或进入 PostCompact。

浏览器在提交前保存意图，响应不确定时复用原键，刷新后轮询，并接管其他标签页在摘要中发布的操作。发送和冲突控件在结算前保持禁用。成功后上下文占用变为未知，直到新的主模型请求提交真实观测；摘要请求用量不能代替上下文占用。

## 验证与部署

验证后续 Turn、重新打开和 Harness 接管实际使用压缩后的模型输入，同时保留聊天记录和工具配对。让压缩与 Turn、wake 输入、审批、模型/CWD 变更、关闭竞争。在候选持久化、PostCompact、最终提交和响应投递前后注入故障；迟到的旧摘要不能应用。覆盖 NOOP、API/Hook 失败、损坏分片和超过 64 KiB 的快照。

执行受影响的 Core、CLI、WebShell、SDK、Java 测试，根 build/typecheck/bundle、API 合约门禁、一次性 MySQL 并发检查和对应 Hosted 故障测试。明确记录无法执行的检查。新增 canonical schema 增量迁移，不改写已发布 baseline。先部署 schema 和 Java/Broker reader，再部署 Harness writer，最后部署 WebShell。回滚前停止新准入并结算已接纳操作。

## 默认选择

本切片不增加自定义压缩指令、忙碌会话压缩、压缩队列或新 slash-command 分发。没有待决产品问题；验证结果单独记录。
