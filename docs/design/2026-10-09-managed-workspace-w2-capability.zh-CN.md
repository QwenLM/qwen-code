# W2 WebShell cwd 能力声明

[English](2026-10-09-managed-workspace-w2-capability.md) | [简体中文](2026-10-09-managed-workspace-w2-capability.zh-CN.md)

## 问题与范围

同一 Workspace 内切换 cwd 的持久化接口已经存在，但 WebShell Session 能力字段仍预留。浏览器需要明确的调用者支持与权限信号，才能提供操作入口。合并后的 W2 PR 中，BFF 部分仅实现 `capabilities.cwdChange`，在 OpenAPI v1.41 标记已实现并重新生成 WebShell 类型。[WebShell 设计](2026-10-09-managed-workspace-w2-webshell.zh-CN.md)说明同一 PR 交付的界面与恢复行为。能力变更不增加接口、表、operation 列表、公共能力或 WorkspaceContext 状态推导。

## 权限与实现

仅在 Workspace 文件执行已启用、Session 为 ACTIVE 且未删除、绑定 Workspace，以及调用者满足当前 cwd admission 权限时返回 true。#13545 合入后该权限基于角色：任何在 Workspace 上持有 OPERATOR 及以上角色的调用者，精确匹配 ACTIVE Registry 的 generation/storage，且 create-command actor 的 OPERATOR/OWNER 授权仍有效。admission、settlement 和能力读取共用 Registry facts 谓词。不能使用 `workspaceTurns`：cwd admission 不要求其 agent、执行 profile 或 Harness 就绪条件。

能力表示支持与权限，不保证 Session 空闲。任务、审批、保留 Runtime session、未完成 operation 和 revision CAS 仍由 admission 裁决。operation 查询独立沿用现有读取权限，因此 cwd 权限撤销后，仍有读取权限的调用者可以继续查询已接纳操作。

列表页对 cwd 与 Turn 两类候选 Session 的 Workspace 并集只做一次角色授权批量读取，对两类候选 id 并集只做一次执行 Registry facts 批量读取，各为一条 `IN` 查询。无候选、调用者无 OPERATOR 授权或部署关闭时跳过 facts 查询。启用能力的列表页在一条与二十条 Session 时均为五次查询；既有关闭部署查询预算保持不变。

## 协调与启用门槛

#13545 已先行合入，并将 cwd admission 迁移到 actor 角色模型（`atLeast(OPERATOR)`）；本切片的能力谓词与该谓词统一，而非沿用此前的 creator 身份基线。前端读取 BFF 能力，不推断 creator/角色。

整个合并后的前端/BFF PR 保持 draft，在 #13564 cwd 项目规则缓存修复及联合验收通过前不合入或部署。在一个既有 Hosted attachment 内，A→B 必须同时改变下一轮的实际写入目录与 QWEN.md/AGENTS.md 规则，无需重建 Session。确定性模型验证工具写入，不能证明规则采用。rewind 与会话内规则编辑不属于此切片。不增加额外前端发布开关。

## 验证与行为 E2E 计划

使用 JDK 21 运行 `ManagedCwdChangeOperationTest`、`ManagedCwdOperationContractShapeTest`、`ManagedAgentApiContractTest` 和 `Issue13181QueryBudgetTest`，再运行 Checkstyle。验证 ACTIVE/绑定/未删除条件、部署开关、creator 身份、授权撤销、Registry state/generation/storage、独立 agent/profile 条件与固定列表查询预算。公共预留字段必须继续不出现在已实现接口和生成类型中。

完成根目录 build、typecheck、bundle 后，使用本地 Node 和 bundle 运行 `HostedPublicWorkspaceIT#workspaceCwdChangeSettlesThroughBothSurfaces`。验证 public/BFF 完成、幂等重放、上下文事件/revision、根目录切换、非法/不存在路径、旧 revision 和其他调用者拒绝。切换后下一次真实工具写入必须落在 B，A 的 sentinel 保持不变。本地用例使用真实 Java/Broker/Harness/worker 进程、H2 与确定性 HTTP 模型，不覆盖真实 MySQL 等价性或 #13564 规则门槛。

发布验收还需在真实文件系统测试空格/中文与符号链接边界、执行中/待审批拒绝、双标签页 admission 竞争，以及上述同 attachment 规则场景。逐层记录实际证据；规则场景未完成时继续阻止启用。
