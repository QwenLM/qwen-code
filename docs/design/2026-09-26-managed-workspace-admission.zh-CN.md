# Managed Workspace Session 准入（W0b）

[English](2026-09-26-managed-workspace-admission.md) | [简体中文](2026-09-26-managed-workspace-admission.zh-CN.md)

状态：基于分阶段 Spring 控制面 [#12692](https://github.com/QwenLM/qwen-code/pull/12692) 开发中。本切片依赖 W0a 的 [Workspace 绑定契约](2026-09-25-managed-workspace-binding-contract.zh-CN.md)，不启用绑定 Session 的 Turn 执行。

## 决策与边界

公开和 WebShell 创建路由接受显式注册的 Workspace ID 和可选相对目录。没有 Workspace 选择的请求保留现有未绑定 Session 行为；内部创建 API 可以将省略的选择解析为租户默认 Workspace。这样不会悄悄把旧调用方转到新执行引擎。显式 `null`、格式错误的对象、无效目录，或包含不成对 Unicode surrogate 的 Workspace ID，在计算请求 digest 或持久化前拒绝。选择 Workspace 要求可信 Servlet principal 实现 `AuthenticatedTenantActor`；租户 header 或请求体不能自称 actor。在 W0c 能安全执行之前，绑定创建拒绝非空初始输入。

Registry 由管理员填充 SQL，按租户隔离，并以精确的 Workspace ID 为键。它存储 W0a 的 generation、storage ID、显示名、状态、`configRef` 和 `policyRef`；独立授权表存储 actor 的读/创建权限，默认表存储租户默认值。没有公开的 Registry 写接口或调用方提供的主机路径。解析、Session 插入与创建回执在同一事务完成。显式选择绝不回退到默认值；省略选择遇到不可用的默认值返回 `workspace_required`。

## 持久绑定与重试

绑定 Session 保存 W0a 的七字段 `ContextBinding`：租户 ID、Workspace ID、generation、storage ID、规范化相对目录、冻结的上下文配置引用，以及值为 1 的 context revision。绑定 digest 由 W0a 代码派生，绝不接受调用方提供的值。准入时把 `configRef` 和 `policyRef` 冻结在 Session 行中。`contextConfigRef` 是二者 UTF-8 字节以 NUL 分隔后的 SHA-256，前缀为 `sha256:`。W0a 校验不允许两个引用包含 NUL。加载 Session 时校验保存的二者仍派生出相同引用。后续执行切片必须解析冻结的引用，而非当前 Registry 的值。

创建命令以租户、已认证 actor 字节和幂等键为键。请求 digest 覆盖调用方意图，包括选择被省略还是显式给出以及规范化目录；不覆盖当前默认值。重试先查原命令，再考虑 Registry 解析；它检查当前读权限，并在默认 Workspace、generation 或状态改变后仍返回原 Session 和绑定。不同请求 digest 返回 `idempotency_conflict`。

## 访问权限与执行门禁

绑定 Session 的 GET/list、事件、item、transcript 和 SSE 要求当前读权限。列表在分页之前过滤；SSE 在投递前重新检查。无读权限的直接请求返回 404。绑定 Turn 的提交/取消和 Session 生命周期修改继续不可用，不写命令，也不调用 Hosted Harness/Broker。Store 拒绝直接写入绑定 Turn 和生命周期命令；恢复调度在调用 Hosted Harness 前使任何已持久化的绑定 Turn 失败；嵌入式 Broker 拒绝把绑定 Session 解析到全局 Workspace。无读权限的 actor 在这些不可用 HTTP 操作上也得到 404。未绑定旧路径行为不变。

本切片只实现准入和读取：不向 worker 安装上下文，不验证节点挂载，不提供物理跨 Workspace 隔离，也不证明 Runtime 停止/卸载/移交。W0c 必须让 `cwdRelative` 和 `contextRevision` 不进入共享 Workspace Runtime 的放置身份，并在物理与协议检查通过之前保留执行门禁。

## 验证与剩余门禁

H2 测试覆盖公开准入、七字段持久化和派生 digest、Registry 变化后的原绑定重试、actor 权限撤销、Store 绕过防护及旧路径行为。Coordinator 和 Broker 测试覆盖恢复及全局 Runtime 解析的失败关闭。MySQL 仍须验证租户/actor/Workspace 键的精确大小写，以及默认值变化后跨 JVM 重试。请求评审前还需通过构建、类型检查、SQL 迁移检查及开放式差异自审。独立 Spring 服务不提供生产级可信 actor 适配器；真实认证入口和绑定执行端到端是独立部署门禁，Java 单元测试不能替代它们。
