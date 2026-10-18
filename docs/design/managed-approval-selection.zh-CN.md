# 托管审批策略切换与 Shell Full Access

[English](managed-approval-selection.md) | [简体中文](managed-approval-selection.zh-CN.md)

## 状态与范围

本次改动已实现，基于托管 WebShell 审批选择器与模型切换改动；Linux 部署验收仍待完成。内置、公开、绑定 Workspace 的 `qwen-code` 会话可在创建时选择 `default`、`auto-edit` 或 `yolo`，并在空闲时修改下一轮使用的策略。已保存 AgentDefinition 保持编译后的创建策略；当 Harness 同时支持 `agent-definition-approval-selection/1` 时，[符合条件的已有会话现可覆盖后续用户回合策略](2026-10-17-managed-definition-approval-selection.zh-CN.md)。部署默认值、Shell 准入、工具种类、Runtime 权限与恢复拒绝语义保持原状。

仅会话记录上的 owner 且当前持有 Workspace OPERATOR 权限时可以修改策略。活动回合、未决 Action、未完成操作、保留的未收尾执行和恢复工作均阻止变更。切换保留历史、Workspace 和草稿。

## 持久状态与执行

原有 `ma_session.approval_mode` 保持不可变，继续标识 Harness 定义。可空的 `selected_approval_mode` 与从零开始的 `approval_revision` 保存当前覆盖。每个新受理且符合条件的用户回合，在与策略变更相同的会话锁下冻结有效模式和修订。旧会话没有覆盖；没有快照的旧回合仅在会话没有覆盖时沿用原定义策略，发生切换后缺少快照则拒绝执行。

变更在一个事务内校验 owner、授权、Workspace 事实、空闲状态和预期修订，再保存覆盖、递增修订、写入按操作者和会话隔离的幂等回执，并产生 `session.approval.changed`。相同回执重放不会再次变更。并发发送和切换由会话锁排序。

SDK 在 `approval-selection/1` 能力下，通过可选 `approvalSelection: {mode, revision}` 传递正修订。Java 对修订零及旧回合始终省略该字段，由已确认的不可变定义提供初始策略，避免 Harness 能力升级改变同一 prompt 的重试身份；新回合仍在 SQL 冻结模式和修订零。Harness 将其保存到现有 `managed-admission` 资源，驻留和冷重复准入均核对快照，执行、Hook 和恢复从同一份已提交输入读取。可变会话覆盖或其他回合不能替换它。发生过变更的会话不能交给缺少该能力的 Harness 执行。无效或不完整快照拒绝执行，不回退。

`yolo` 跳过普通工具审批。Hook 的明确 deny/ask 决定保留现有语义，可切换会话继续提供 Actions。新的可切换内置 Full Access 定义保留部署配置的审批超时，供之后需询问的回合使用；未保存超时的旧定义保留 10 分钟默认值。已保存定义的创建序列化保持原状：新旧自定义初始 yolo 文件会话均保留该默认值，初始 default/auto-edit 会话保留已存的配置超时。Shell 结果捕获、持久回执、取消和不确定副作用恢复复用现有执行链。Shell 部署默认值仍要求 `default` 或 `auto-edit`，Full Access 通过会话显式选择开启。包括被动恢复加载在内，所有可能执行的连接均检查 Harness 能力，专用取消和生命周期收尾路径仍可使用。

## 接口与页面

增加 owner 范围的 WebShell `session-approval/query` 和 `session-approval/change` 操作。查询返回 `approvalMode`、`approvalRevision`、`availableApprovalModes` 和变更能力。变更接收 `sessionId`、`approvalMode`、`expectedRevision`、`idempotencyKey` 和 `requestId`，返回已提交模式、修订和 `replayed`。同键不同内容、过期修订和忙碌会话返回 409；继续遵守现有 403/404 隔离规则。不新增公开 REST 变更操作。

WebShell 摘要返回当前有效 `approvalMode`、`approvalRevision` 和不可变 `initialApprovalMode`。待确认创建核对初始策略，避免后来切换导致误判。共享模式菜单使用服务端支持列表。策略变更未确认时，锁住发送和策略、模型、cwd 修改。浏览器持久保存原意图和幂等键，用原意图重试不确定结果，读回至少达到响应修订的摘要后解锁。旧摘要不能覆盖较新的修订。

## Schema 与上线

在前置 V4 工作区创建和 V5 模型选择迁移之后添加共享 schema V6，同步初始化和结构校验。旧数据默认修订为零，不改写初始策略。先升级 Harness，再于维护窗口迁移并更新全部 Java/Broker 读写端，最后发布 WebShell。回滚版本必须识别已有覆盖和回合快照，保留新 schema 与回执。已保存定义的扩展复用 V6，不增加迁移，因此 schema 校验无法隔离忽略自定义覆盖的旧 Java：启用前必须停止或隔离全部旧 Java/Broker catalog 使用者，自定义覆盖发生后不得回滚到这些二进制。

## 验证与验收

验证三种模式的文件与 Shell 矩阵，并在同一会话完成 `default → yolo → auto-edit`，核对真实副作用、输出、历史、刷新和重启证据。覆盖 owner/OPERATOR、撤权、跨租户、自定义定义、忙碌与恢复拒绝、并发发送/切换的原子性、重复和丢失响应、过期标签页、旧创建重放及显式 Hook 交互。SDK 与 Harness 测试覆盖快照解析、能力拒绝、驻留/冷重放身份及续跑保留原策略。MySQL 8.4 验证迁移、事务和持久快照。执行相关包测试、build/typecheck/bundle、Java 验证、API 契约门禁、连续两轮干净自审和独立审查。物理恢复和租约过期修复不属于本功能验收。

## 本地验证与剩余部署门禁

在 macOS、Node 22.22.3、JDK 21.0.8、Maven 3.9.14 和独立 MySQL 8.4.11 环境中，相关 TypeScript 测试及 build/typecheck/bundle、Java SDK/Broker/server 验证、schema 初始化和校验，以及 18 项真实 MySQL 策略事务测试均已通过。独立源码审查发现并复核了上文的修订零重放修复。CI 结果与这些本地证据分开记录。

测试工程师使用真实 Java/Broker/Harness/worker 进程、Chrome 和确定性本地模型完成验收：一次文件写入和一条 Shell 命令在三种模式下分别产生 2/0/1 次普通审批，副作用精确且各执行一次，历史保留，owner/权限/忙碌/回执检查通过；响应丢失后刷新并确认原请求、草稿保留和 390px 菜单完整性均通过。仅重启 Harness 后，有覆盖的会话和修订零对照都保留策略并完成新回合。

macOS 进程测试使用仓库显式物理别名 SQL 测试 fixture，同时保留真实挂载和工具，关闭原生与持久 Runtime 恢复。完整重启 Java 后可读回正确策略，但有覆盖及修订零会话在预热旧的非持久 Runtime 绑定时均超时；未改动的 Hosted MySQL profile 在本机首个工具回合也收到 Broker 409。这些门禁不能算通过，也未归类为本次回归。发布前仍需部署测试通道验证 Linux 原生存储注册、整个 JVM 的持久恢复、不确定副作用的进程故障验收，以及真实上游模型调用；本次不包含租约或 Runtime 恢复修复。
