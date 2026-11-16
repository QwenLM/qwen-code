# 外部 Workspace 内容型子 Agent

[English](2026-11-16-external-content-child-agents.md) | [简体中文](2026-11-16-external-content-child-agents.zh-CN.md)

## 状态与基线

针对 #17247 的本地实现已完成，集成验收待完成。开发基线为 #16023 的 `bd8c5c76011ad3c9011ef3a265a6eea44a86a935`，它提供 Workspace 隔离的外部 binding、独立 Runtime 成员、共享执行锁和存储级退役。此前置尚未合入 main。本增量不合并或替代该前置，不声称完成部署验收。

## 目标与支持范围

新增精确 Hosted profile `hosted-workspace-external-files/2`：普通外部文件读取、写入、编辑和 glob，静态套件 Skill 与命令、包引用及单层公开子 Agent。在已有 Workspace 共享 worker 上支持前台和后台子任务。`/1` 保持现有四个文件工具合同。不新增 Shell、MCP、Hooks、执行型命令插值、秘密设置、子 Workspace、快照、嵌套、团队或工作流。静态命令参数替换复用既有内容路径，拒绝 `!{`、`@{` 预处理。本切片不包含 Session 工作目录修改，父子使用相同的已保存上下文。

准入要求显式开启默认关闭的 `harness.workspaceContentAgentsEnabled`，并正向协商精确 profile、公开子 Agent 和 Harness lifecycle V2。同时要求开启既有 Workspace 文件、子 Agent 和扩展目录配置，使用 Workspace 隔离，关闭进程型扩展执行。关闭准入开关后，保留此目录配置仍可重启，并保留已保存 `/2` 会话的恢复路径。内容支持不启用进程型扩展执行 profile。保留 `public_child_agents_version=1` 既有公开子 Agent 合同；profile 资格与 public-shell 判定分离。

## 内容配置与资源

复用现有 `config_install` 链，以 `kind=hosted-extension-config`、`formatVersion=2` 表示仅内容配置。保留操作身份、revision 校验、前驱引用和 prepare/commit/active 转换。版本 1 保留原 Runtime/Harness 双方进程激活。版本 2 每阶段要求一个真实 Harness 内容 ACK，不伪造 Runtime ACK 或进程 owner。

内容 bundle 和 root 使用明确的正文版本 2 及 `executionMode=content-only`，保留资源外层 schema version 1。固定包摘要、贡献清单和不可变 archive/资产。内容 root 绑定 Session 定义及 Workspace 身份，不绑定进程 Runtime owner。父更新配置或 child 继承时保留完整引用闭包。

`extension://` 读取和 glob 走固定内容源，沿用有界 archive 解包、摘要和成员校验。包资源只读，不进入 Workspace 文件历史。普通文件访问始终使用解析出的外部 worker。两类路径都不回退到 Harness cwd、用户扩展或其他包。不支持的已启用包组件与显式工具在激活或创建 child 前失败。

首个内容切片每包最多快照 256 个文件、8 MiB 资产字节，使用 64 KiB 资源分块和分页索引。文本读取要求合法 UTF-8；不支持的二进制引用和容量超限明确失败。配置引用总量仍受现有 Session Store 事务限制。内部 writer 鉴权的 `content-package:query`、`content-package:read` 操作只交付属于精确配置的 manifest/archive，不交付 settings；公开 HTTP 路由不变。

## 启动身份、模型与审批

复用既有公开 launch 信封及包描述 pin。child 在自己的加密身份下继承父模型配置。不同的显式模型在启动前拒绝，不引入 wildcard provider 或环境默认回退。

持有父行锁时校验快照来源审批 revision 和有效模式，再把完整权限规则复制到 child 不可变初始策略。规则非空时 child 自有审批 revision 从 1 开始，否则保留 0。恢复读取 child 自己保存的策略，父后续修改不影响它。

完成身份及作用域授权后，先按 request digest 和已提交 child lineage 匹配已有创建回执，再执行可变的新建资格校验。即使父后来修改配置或策略，回放仍返回原 child 及 pins。真正新建仍校验父当前配置、策略、开放状态和执行授权。

## 共享 Runtime、中继与清理

复用 #16023 的普通 Workspace capability digest 和 binding-generation 物理 holder。父子保留各自 Harness 身份、prompt 派生 Runtime 身份、上下文和凭据。校验已提交 lineage 及相同租户、Workspace generation、存储和 child cwd；执行授权来自该 child 所属根会话 owner，不向无关 Workspace 成员借权。

先持久化清理义务，再提前 acquire。模型执行前建立真实 READY 成员/context，包含纯文本和 Skill-only child；文件历史初始化和文件访问保持延迟。Runtime 成员与文件初始化分别跟踪，保证每种退出都清理。普通 Workspace worker 可复用多上下文，执行锁只覆盖未决工具执行，不覆盖模型等待。无需额外 Runtime 状态或合成成员。

中继从原创建回执的 child Session 和 turn 解析精确 prompt 及历史 Runtime 成员，不选择最早/最新 turn 或最新 Workspace binding。可用性读取要求匹配的 READY 身份。历史派发修复使用原关联及原 turn 的持久派发/终态事实，不重新激活已释放或 LOST binding。准入前 child 失败及时到达父会话。

child 取消与关闭只停止、释放自己的工作和成员。父 turn 取消使用既有来源 prompt 停止屏障。关闭根 A 时级联其 child 并释放自身成员，不排空根 B 使用的共享 worker。只有存储退役才能凭原 generation 和停止回执停止 worker、清除物理 holder。永久结构性恢复拒绝沿用 #17273 的终态 decline；服务不可达仍按瞬态处理。不重放结果未知的文件副作用，也不把它当成停止证明。

## 交付、验证与发布

先交付内容配置和资源支持并保持准入关闭，再接通 profile 门禁、child 策略/模型继承、提前成员建立、精确中继和生命周期。双语设计与 E2E 报告同步更新。复用现有公开/WebShell 路由及能力字段，不新增公开 HTTP 接口。Java SDK 的既有 lifecycle V2 选择器也接纳精确 `/2` profile。

验证 `/1` 回归边界；不可变内容/摘要/路径和跨租户拒绝；父读取 → 前台 child Skill/引用/写入/读取 → 父重读；纯文本和 Skill-only child；父 turn 结束后的后台完成；多个独立根及 child 只 provision 一次；child/根关闭隔离；父更新及幂等回放；重启和 acquire/attach/release 丢响应；旧 generation 和 UNKNOWN 写入。

运行定向 TypeScript/Java 检查、根 build/typecheck/bundle，以及模块共享本地预算内适用的真实 MySQL/worker/Hosted 路径。完整 CI/fault 与预发套件验收分别记录证据，记录各组件实际版本。先部署兼容组件，再为新会话启用 `/2`；关闭新准入不改写已有 pins。回滚到不识别 `/2` 的二进制前先结算存量 `/2` 会话。

## 实现与证据

实现涉及 `packages/cli/src/serve/` 的 profile 准入、内容激活及 child 工具，`packages/core/src/managed-runtime/` 的配置合同、不可变资产及 HTTP 存储，Managed Agent server 各模块的准入、鉴权、资源保留、精确成员身份及生命周期，以及 Java SDK 的既有 Hosted 生命周期选择器。不新增数据库迁移或公开 API。

本地证据包含 301 项 Core 测试、19 项 CLI 定向用例、3 项 Java SDK 阶段变体和 24 项打包 Harness HTTP 协商/准入检查。另有 Java 组件检查及选定真实 MySQL 身份/锁用例通过。最终 Java 生产模块编译和 Checkstyle 通过，但修正后的 deny 策略继承与原始 bootstrap MySQL 回归方法，未能在共享 600 秒预算内重跑（已耗时 597.473 秒）。改进后的 Java ACK 数量测试也待 CI 验证。

这些检查尚未证明完整 Spring/MySQL/Harness/外部 worker 链路。真实父子文件副作用、后台交付、独立根关闭隔离和重启/故障恢复仍需集成证据。需要现有完整 CI 门禁及合适的外部 worker 夹具/环境；完成这些验收前保持准入关闭。

## 未决决策

已约定首版没有未决产品决策。后续实现及测试证据必须区分已验证行为和待验收内容。
