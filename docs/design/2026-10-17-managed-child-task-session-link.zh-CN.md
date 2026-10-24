# Managed child 任务到 child Session 的链接（H4f F2）

[English](2026-10-17-managed-child-task-session-link.md) | [简体中文](2026-10-17-managed-child-task-session-link.zh-CN.md)

状态：已在本变更中实现。`child_agent` 或 `workflow` 任务会给出运行它的 child Session：`PublicTask.child_session_id` 与 `WebShellTask.childSessionId`，在契约 `1.55.0` 中提供。没有新路由、新授权规则、新迁移或新事件类型。

这是 [#13746](https://github.com/QwenLM/qwen-code/issues/13746) 的 F2，属于 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 H4f 切片，即 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段。[H4f 设计](2026-10-10-managed-task-cancel.zh-CN.md)（决策 9）为暴露 child 任务的输出留了两条路：把任务链接到其 child Session，或在 `read_output` 之后把 child 的输出作为任务事件转发。本变更选择链接。

## 问题

自 H4b 起，一次 child run 就是一个真实的任务。调用者可以列出它、观察它的 `state_changed` 事件，自 H4f 起还能取消它，却读不到它产出了什么。child 任务不公布 `read_output`，所以它的事件流里没有 `output` 事件；child 的最终文本也没有作为 Artifact 发布，所以它的 `artifact_refs` 一直为空。输出本身是存在的：就是 child Session 自己的对话记录。只是任务上没有任何字段说明是哪个 Session。

## 现状

在 `3bddf6e0bb`（契约 `1.51.0`，schema V6）上核实。

- **child Session ID 记在 run 的记录里。** 两种 child Session 类型的 `child_run` 记录体都带 `childSessionId`（`ManagedExtensionRecords.java:179`）。它起始为 null（`:1126`），只设一次（`:1191`），一旦 run 已 attach，或在 attach 之后结算，它就必须非空（`requireChildSession`，`:957`）。设置它的是 attach 修订（`childAttachBody`，`managed-child-operations.ts:460`），由结果中继在 child 绑定后发出（`ChildResultRelay.java:878`）。终态裁决也可能点名一个已登记但从未启动的 child（`managed-child-operations.ts:501`）。`child_run` 的 Shell 类型没有这个键。
- **任务行不带它。** `ma_session_record` 只存投影列（任务类型、状态、Runtime 状态、投递、时间）以及指向最新已提交记录体的 `record_resource_id`。任务视图只用这一行构建（`ManagedTaskService.publicTask`/`webShellTask`），且 `PublicTask.session_id` 总是父会话。
- **child Session 本来就对任务的读者可读。** child Session 是一个普通的 PUBLIC Session，插入时沿用父会话的租户与 `workspace_id`（`ManagedAgentStore.insertChildSession`，`:663`）。所有 Session 读取路由都经过 `requireReadableSession`（`ManagedAgentService.java:1600`），它只检查 Session 未删除、调用者能读其 Workspace。所以能读父会话任务的人，本来就能读 child 的 Session、Turn、item 与事件；Session 列表也不过滤 child。唯一缺的是 child 的 ID。
- **目前没有任何公开字段给出 child Session。** OpenAPI 里任何地方都没有 child Session 字段。

## 决策

1. **链接，而不是转发。** 任务视图增加一个可选字段，给出 child Session。调用者通过本来就提供这些内容的路由读取 child 的输出：Session、Turn、item、事件以及它们的 WebShell 镜像。转发会把对话记录复制进有界的任务日志，并受保留下限与 Artifact 可见性屏障约束，而 `read_output` 在任务生命周期内固定不变；链接不需要这些。
2. **只有两种 child Session 类型带它，并且只在记录给出 child 之后。** 当 run 最新已提交的记录体中 `childSessionId` 非空时，`child_agent` 与 `workflow` 任务带这个字段：从 attach 起，或在点名了已登记 child 的终态裁决上。在此之前字段缺省，`background_shell`、`monitor` 与 `automation_run` 也一样缺省。契约在两个任务 schema 上都把类型规则写成条件约束。`ma_session` 上的谱系边从登记时就存在，但 H4b 的规则是父会话在 attach 时得知 child、绝不靠推断，所以视图读记录而不读谱系。
3. **视图读已提交的记录体；不新增列。** 这个事实只存在于记录体里。投影列需要一次迁移（V7 已被一个在飞 PR 占用）、对迁移前已提交的行做回填，以及在每次修订时改写写入路径，换来的只是每个 child 任务少读一次内联资源。任务视图本来就对每个任务做一次查询（其事件游标位置），多出的这次读取保持同样的形态，且只针对 child 类型。只有两条视图路径会读它：取消准入的任务查找仍是纯投影读取。记录体只有在其 Session 退役后才会被回收，所以在读行与读记录体之间落下的修订会让上一版记录体仍可读，视图按那一版报告记录。
4. **不新增授权。** child 沿用父会话的 Workspace，所以能读任务的调用者集合与能读 child 的集合相同。这个链接只把 ID 暴露给本来就能在其可列出的 Session 中找到该 child 的调用者。
5. **不发布最终文本。** 把 child 的最终文本发布为任务 Artifact（任务面板设计的后续项）仍是单独的工作。想要最终答复的调用者读取 child 最新的助手 item。

## 契约变更（1.55.0）

- `PublicTask` 增加 `child_session_id`，`WebShellTask` 增加 `childSessionId`：可选、`format: uuid`、已提供（无标记）。两个 schema 各增加一个条件约束：除 `child_agent` 与 `workflow` 外的任何类型都禁止出现该字段。
- `info.description` 增加 v1.55 段落。
- 重新生成的 WebShell 类型增加 `childSessionId`。

## 验证

- **真实记录**（`ManagedExtensionRecordStoreTest`）：经 Session store 提交的 `child_agent` 链在 attach 之前，两个接口面都不给出 child；从 attach 起，两个接口面的详情与列表都给出它，结算后的 run 仍给出它。workflow 链以同样方式给出其 child。后台 Shell 行与 Monitor 任务都不给出。
- **契约**（`ManagedAgentApiContractTest`）：实际提供的 child 任务在公共路由上带 `child_session_id`，在 WebShell 路由上带 `childSessionId`，各自按其 schema 校验；记录尚未给出 child 的 workflow 任务不带该字段。`recordsMatchTheirSchemas` 把 DTO 分量与 schema 属性对齐钉住。
- **Schema**（`PlannedTaskContractTest`）：两种 child 类型都接受该字段及其缺省，格式错误的 ID 被拒绝，`background_shell`、`monitor` 与 `automation_run` 带该字段被拒绝，两个接口面都如此。去掉类型条件约束会让这些用例失败。
- **类型**：重新生成的 WebShell 类型通过其新鲜度测试，WebShell 包通过类型检查。
- **真实栈**（FG9，`HostedSessionRelayFaultGatesIT`，MySQL 8.4，打包的 Harness）：六个用例中，team 成员都作为其 lead 的 `child_agent` 任务运行。lead 的公开任务视图在 `child_session_id` 中给出成员的 child Session，它正是成员已提交的 `child_run` 记录所 attach 的那个 Session，并且该 Session 可经公开 Session 路由读取。两个字母均通过。
- **未运行：** MySQL 集成测试车道，以及在 Session 本身之外经由链接读取 child 的 Turn 与 Item。

## 后续工作

| 项                | 范围                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| WebShell 任务面板 | 在任务详情中展示链接，并从它打开 child Session 的对话记录。                                                                                 |
| 最终文本发布      | 把 child 的最终文本发布为任务 Artifact，使 `artifact_refs` 带上它（[任务面板设计](2026-10-12-managed-child-task-panel.zh-CN.md)的后续项）。 |
