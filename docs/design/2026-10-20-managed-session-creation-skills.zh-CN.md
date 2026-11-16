# Managed Session 创建时添加 Skills

[English](2026-10-20-managed-session-creation-skills.md) | [简体中文](2026-10-20-managed-session-creation-skills.zh-CN.md)

## 问题与范围

Managed Session 当前只能从已保存的 AgentDefinition 获取静态 Skills。创建 Session 时不能为单次对话添加指令，内置 `qwen-code` 也没有已保存的定义。本次为公开 API 和 WebShell 的 Workspace Session 创建增加可选静态 Skills，并复用已有 Skills 管理页面作为配置入口。

## 设计

创建请求接受可选 `skills` 数组，复用已有的 `name`、`description`、`body` 和可选 `base_directory` 字段。省略和空数组保持原行为。非空追加要求已授权的 Workspace 绑定，以及声明 `session-skills/2` 的 Harness。Skill 不改变工具、权限、模型或 Hook 配置。附件路径仍相对 Session 工作目录，通过选定 Runtime 访问。

准入时解析原 AgentDefinition pin，把其 Skills 与追加项连接，使用现有规则校验完整目录：最多 256 个不同名称、紧凑 JSON 不超过 2 MiB、描述不超过 4 KiB、正文不超过 512 KiB。同名拒绝。AgentDefinition 准入保留原有 16 条、32 KiB 正文、48 KiB 总量上限，更大的格式由 Session 创建能力控制。两种来源共用 `managed-agent-skills` 资源类型，其共享资源校验器统一使用 2 MiB 上限；较小的定义限制在准入时执行。请求摘要包含规范化后的追加项，同一个幂等键下修改内容会冲突；重试不会解析更新的定义。

在创建事务中，把最终目录及其 SHA-256 摘要保存到 Workspace 创建回执已有的 `result_json`。这是不可变的 Session 配置，不改变 AgentDefinition 身份，无须修改 SQL schema。通过现有 Session 索引读取回执，核验租户和 Session 身份并校验摘要。子会话在自身创建事务中复制最终目录，避免以后依赖父会话。没有快照的已有 Session 保持原定义读取行为。

Connector 将已保存目录发布为已有的不可变 `managed-agent-skills` 资源。Hosted create/load 新增顶层 `sessionSkillsRef`，为内置和自定义 Agent 携带同一引用。Hosted 将其保存到 `managed-definition`，核验字节，纳入资源闭包，并拒绝冲突 load，包括省略已保存引用。该最终目录存在时优先于定义的 Skill 目录，原 AgentDefinition、模型、审批选择和 Hook pin 保持不变。恢复与资源清单读取器遍历新引用，资源缺失或损坏明确阻塞加载。

只读 Session Skill 目录读取同一已保存的最终目录。其授权保持持久 Workspace 作用域：Session 可读、租户隔离、当前 Workspace 授权，以及只返回元数据。Session 创建也保持持久 Workspace 作用域，新增导出路由仅作用于明确选定的 daemon 工作区。

已有 Skills 页面作为配置来源，新建 Managed 会话前自动导入其中的启用项；上传和启用/停用仍在该页操作，移除单独的创建表单。App 在 Skills 页面与创建流程之间显式共享选定的 daemon Workspace。这是从可信来源导入静态指令，不表示 Java Workspace ID 对应同一文件系统或 Runtime。选定来源未知、不可信、启动中、排空或已移除时，不能回退到 primary daemon。

准入前，输入框的 Skills 菜单按需读取同一选定来源的元数据，列出所有已启用且允许用户调用的条目，包括仅手动调用的 Skills。重新打开菜单会刷新创建前列表；来源变化丢弃旧请求结果，读取失败明确展示。打开菜单不导出正文、不创建 Session。发送时仍重新读取完整快照，并冻结准确的创建请求。已准入 Session 只读取自身固定目录，不回退到实时来源。扩展与 MCP 保留各自独立的能力判断。

`/` 入口与加号菜单使用同一目录。Managed 输入框把每项 Skill 转成 Skills 分类的 slash 候选；输入 `/` 触发按需加载，输入 `/名称` 筛选结果。方向键移动，Tab、Enter 或点击只补全 `/<名称> `，不自动发送。该映射同时用于创建前来源和已有 Session 固定目录，不展示 daemon 内置命令。

新增经过认证的只读 `/workspaces/:workspace/config/skills/snapshot`，作用域为选定工作区，按需导出启用的指令正文。复用配置状态提供器中同一次 SkillManager 与禁用规则，拒绝不完整发现，并在异步读取后复核选定 generation。已有事件和状态响应仍仅返回元数据。不导入 frontmatter 中的权限、Hook、模型覆盖和来源文件系统路径。内容保持静态指令，附件目录不复制，也不冒充目标 Workspace 的路径。

目录保留可选 `model_invocable` 和 `user_invocable`。仅用户调用的 Skill 仍算启用，支持用户开头的 slash 调用，但不向模型广告，也拒绝实际模型调用。用户不可调用的 Skill 可供模型使用，但不出现在 slash 菜单。更大的上限覆盖实测 42 个启用 Skill（约 928 KiB，最大正文约 395 KiB）。仅 `managed-agent-skills` 资源获得 2 MiB 行内上限，普通行内资源仍为 64 KiB。大正文在调用后先按当前模型的工具输出预算裁剪，再复用已有 Managed 消息分块保存模型实际可见的结果；后续 Turn 与冷恢复读取相同结果，不让原文绕过预算。完整原文仍在不可变目录资源中。开头的用户调用将来源随生成的 assistant 记录一并保存，中断批次在部分结果已提交时仍保留调用限制和共享输出预算；没有可信用户来源标记的记录按模型调用恢复。

完整数组随已有待确认创建请求保存到 IndexedDB，页面重载后不重新发现 Skills，以相同内容重试。准备完成时必须仍为原来源。管理页后续修改影响新 Session，已有 Session 目录保持固定。创建页链接回 Skills 管理，不重复管理控件。

## 涉及组件

公开及 WebShell 请求模型与 OpenAPI；Session 服务与创建持久层；Skill 快照读取器与目录；选定 daemon Workspace 导出与 Skills 页面来源共享；Hosted connector 与 Java SDK；Hosted 定义校验、资源遍历与执行；WebShell provider、创建时导入、待确认请求存储和翻译。

## 验证与验收

1. 两套 API 均允许内置和自定义 Workspace Session 添加合法 Skills。合并保留定义 Skills；同名与合计超限原子拒绝。
2. 相同幂等键返回原 Session，修改 Skill 字节冲突。定义更新、重连和子会话创建保留原快照。
3. 真实 Hosted 进程声明、加载并在推理前提供选定正文，包括开头的 `/name` 和 Plan 模式。冲突、缺失、损坏引用明确拒绝。
4. 未授权 actor 不能创建或读取目录。快照只读子会话不提供 Skills。未绑定请求拒绝追加，不兼容 Harness 拒绝准入。
5. 已有 Skills 页面控制启用项，创建时导入选定可信来源的所有启用项、排除停用项，保留手动与用户调用标记、拒绝来源漂移，并在待确认恢复中保留完整请求。创建前输入框列出已启用且允许用户调用的 Skills，重新打开会刷新列表，元数据失败明确展示且不创建 Session。
6. 执行定向 Java/TypeScript 测试、API 生成、build/typecheck/bundle、Maven verify、一次性 MySQL 集成和适用的 Hosted 进程测试。单独记录不可用环境。
7. 完成连续两轮干净自审和独立代码评审，再使用现有私有配置与数据库部署经过测试的本地产物。通过部署后的 UI/API 检查健康状态、已有 Session 和新增带 Skill 的 Session。

## 未决问题与状态

基于启用项的 Skills 流程已实现，并于 2026-10-20 部署到本地 Managed 服务。部署后的浏览器导入完整 42 项来源及一个临时的仅手动调用测试 Skill（共 43 项、950238 字节），页面重载后从 IndexedDB 恢复同一请求且不重新发现，并由真实 Kimi 模型返回测试 Skill 的精确结果。停用测试项影响新的导出，已有 Session 仍保留原快照；清理后原 42 项全部恢复原有启用状态。切换前后已有持久数据一致，已有 Session 仍可读取。

build、typecheck、bundle、受影响消费者测试、一次性 MySQL/Hosted profiles、18 组适用进程测试和 8 项部署 UI 检查均通过。最终完整 Java 运行共 5010 项，有 1 项心跳计时失败、0 错误、18 项跳过；未修改的该方法及整个 38 项测试类定向复跑通过，包括 Checkstyle 和 SpotBugs。原完整运行保留失败记录，不记为全绿。已完成两轮干净代码自审和独立评审。完整证据、恢复故障覆盖和平台/模型限制记录在 `.qwen/e2e-tests/managed-session-creation-skills.md`。

后续前端部署也补齐了创建前输入框菜单与启用来源的连接。部署后的新建菜单列出全部 42 项，选择后只插入 slash 指令而不发送，已验证重新打开刷新、过滤和错误恢复；已有 Session 仍显示原来的 43 项固定目录。菜单修复通过 146 项定向测试、根 build/typecheck/bundle、两轮干净自审和独立评审。

直接输入 `/` 选择 Skill 也于 2026-10-21 部署。一次完整浏览器验证覆盖新建草稿（42 项来源）和 Ready Session（43 项固定目录），名称筛选、方向键、Escape，以及 Tab/Enter/点击补全均通过，且不自动发送。未导出正文、未发送模型或创建请求、未修改配置，页面无错误。slash 映射通过 335 项定向测试、根 build/typecheck/bundle、两轮干净增量自审和独立评审。

创建时静态目录在 Session 生命周期中保持固定。安装与启用/停用复用已有 Skills 页面。Managed 执行 Runtime 直接发现目录和修改已准入 Session 目录不在本次范围内。
