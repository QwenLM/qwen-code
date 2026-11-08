# Managed Session 静态 Skills

[English](2026-10-19-managed-session-skills.md) | [简体中文](2026-10-19-managed-session-skills.zh-CN.md)

## 问题与当前状态

Managed AgentDefinition 已能发布有界静态 Skill 目录。每个 Session 固定定义
revision 和 digest，Hosted Harness 通过 `skill` 工具加载已发布正文。Managed Web
Shell 尚未查询该目录或启用输入框的 Skills 菜单。开头的 `/name` 当前只是普通
提示词文本，Plan 模式也排除了这个只加载指令的工具。

## 范围与归属

展示已有 Session 目录，并为绑定 Workspace 的 Session 接通选择与实际加载，覆盖
本机和 SSH Workspace。控制面读取不可变定义，Harness 加载指令，Workspace 工具
保留既有 Runtime 归属和审批策略。不增加文件系统 Skill 发现、安装、动态激活、
参数展开、模型覆盖、MCP 配置或文件引用能力。

## 方案

### Session 目录

增加 `POST /api/agent/web-shell/v1/session-skills/query`，接收已有 Session 请求
形状，返回 `skills`，每项只含 `name` 和 `description`。这是持久 Session 作用域
的读取，采用 `READER_ACTOR` 规则：先要求 actor、租户内可见 Session 和当前
Workspace 读取授权，再访问固定定义。复用 `pinnedContent` 和现有 Skill 校验，
包含 digest 校验。绝不查询最新 AgentDefinition，也不连接 Runtime。内置 Agent
和未发布 Skills 的定义返回空目录。快照只读子会话的 Harness 不提供 Skills，
因此也返回空目录。固定版本缺失或不一致时显式失败。

同步 OpenAPI、生成的 Web Shell 类型、接口注册表和准入契约测试。不迁移数据库，
不增加持久状态。

### 输入框

Java provider 提供可选目录读取能力。Session 作用域 Hook 在打开 Skills 菜单时
查询，缓存成功的不可变结果，作用域变化时取消请求，并忽略其他 Session 的迟到
响应。复用 ChatEditor 已有的 Skills 子菜单、加载、错误、空状态和 `/name` 插入。
请求失败后重新打开会重试。尚未分配 Session ID 的新会话不猜测定义进行查询。
其他 Workspace 能力继续由既有接口控制。

### 显式调用与加载

首次模型请求前识别连续位于开头、与固定目录精确匹配的 `/name` token。通过
现有 Hosted 工具执行器，将去重后的选择作为纯 `skill` 批次加载。保留用户提示词
和附件，将合成的 assistant 调用和工具结果写入日志，再把结果交给模型。因此，
即便模型原本会直接回答，也必须先在模型上下文中包含已发布正文。不匹配的 slash
文本保持现有含义。剩余提示词是任务输入，不是 Skill 参数或激活配置。

先执行正常的 Session 和提示词 Hook，再加载技能。复用 PreToolUse、PostToolUse、
批次 Hook、拒绝行为和内联大小限制。加载不执行脚本、不扩大权限，也不调用
Runtime 文件系统。恢复通过现有 Skill 恢复路径使用已提交的调用和结果；续行
模型或工具时不能再次合成激活。将 `skill` 加入公开 Plan 只读集合，同时保留
纯 Skill 批次以及写入、Shell 和计划审批限制。

## 涉及范围

Managed Agent API、服务、模型记录及契约测试；Web Shell 生成 API、Java client、
provider、Session 输入框和目录 Hook；Hosted Skill 目录、模型循环、Plan 策略
及定向测试。本方案扩展已有的[静态 Skill 设计](2026-10-15-managed-agent-extension-config.zh-CN.md)。

## 验证与验收

1. revision 2 修改目录后，revision 1 创建的 Session 仍列出并加载 revision 1；
   新 Session 使用 revision 2。
2. reader 可以读取；缺少 actor、无授权、跨租户或已删除的 Session 在访问目录前
   被拒绝；空目录有明确 UI 状态。菜单响应不包含正文或宿主路径。
3. 菜单选择前置调用文本。首次确定性模型请求包含选定正文的工具结果、原任务
   和附件。
4. 显式调用遵守 Hook，按名称去重，并始终受已发布目录约束。普通提示词和模型
   自主调用 Skill 保持原行为。
5. Plan 模式允许静态指令加载，继续拒绝写入和 Shell。恢复不会重放已完成激活。
6. 切换 Session、变更 provider、请求失败及迟到响应都不能显示上个 Session 的
   Skills。

可执行计划和结果存放于 `.qwen/e2e-tests/managed-session-skills.md`。执行定向
Java 和 TypeScript 测试、API 生成、Java 验证、根目录 build/typecheck/bundle、
改动文件 lint/格式检查和两轮完整 diff 自审。区分环境及进程测试限制与已验证行为。

## 开放问题

本切片没有待定问题。发布和安装新 Skills 仍是输入框以外的管理任务。
