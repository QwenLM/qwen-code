# 本地 Managed 模型目录

[English](managed-local-model-catalog.md) | [简体中文](managed-local-model-catalog.zh-CN.md)

## 问题与范围

本地 `qwen serve --managed` 适配层为 Hosted Harness 执行继承了用户模型配置，却没有配置 Java 模型目录，也没有提供新建任务模型预设。即使本地已经配置模型，页面仍只显示服务端默认模型。主干已有 Session 模型目录与审批协议。本次将本地启动器接到这些协议，并为 WebShell 创建增加可选初始模型选择，详见[创建模型设计](2026-10-22-managed-initial-model-selection.zh-CN.md)。不新增提供方凭据传输或远程部署行为，也不修改已有 Session。

## 设计

启动时读取与 Hosted Harness 相同的部署配置：遵循所选 `QWEN_HOME`、系统配置与提供方协议声明，忽略工作区配置及环境文件加载。复用现有模型注册表解析配置路由。仅纳入在注册表所有协议和路由中 ID 唯一的对话模型，排除内置 OAuth 目录和专用 fast/image/voice/vision 模型。复用已有 CLI 生成配置解析器，遵循鉴权类型及环境变量优先级。默认模型能唯一匹配目录时将其排在第一位，否则保留内置 `qwen-code` 默认预设，避免其他已配置提供方悄然替换当前默认。其余模型保持配置顺序。未配置模型时保留已有默认选项。由于现有 Hosted 模型固定机制会拒绝歧义 ID，共用 ID 的路由不进入目录。

通过启动器控制的 `SPRING_APPLICATION_JSON` 数组，仅向 Java 传递 `{modelId,label}` 条目和允许的模型 ID。允许使用已有 `hosted-workspace-shell/1` 定义配置。启动器继续过滤继承的 Spring 和 Managed 服务端覆盖配置，保留签名的回环地址边界。

本地新任务使用内置 `qwen-code` Agent，将每个已配置模型作为独立 `modelId` 发布，不再注册会以编译后询问策略限制权限菜单的自定义 AgentDefinition。保留定义模型和工具配置白名单，使已有自定义 Session 可用；管理路由继续不对外开放。

通过已鉴权的同源 `/managed/boot` 返回 `{agentId: "qwen-code",modelId,label}` 预设，独立客户端验证模型选项唯一后传入 provider，并兼容原有 `{agentId,label}` 预设。新任务分别选择宿主目录模型和审批策略；创建请求通过能力检查后，在首轮之前同时保存这两项选择。已有 Session 使用独立的 Java Session 模型目录及其空闲状态、版本和 Workspace 授权校验。模型固定解析与缓存凭据继续由 Hosted Harness 负责。boot、定义和模型目录均不包含凭据、提供方 URL 或签名材料。

## 约束与风险

目录是启动时快照，修改配置后需重启本地服务。缓存凭据由已有执行逻辑校验，启动时不请求提供方。仅内置 OAuth 的模型和有歧义的模型 ID 保留已有默认执行路径，不作为显式选项。移除已配置模型不会重写历史定义或 Session；历史固定配置不再可解析时执行会拒绝继续。Runtime worker 保持独立 `QWEN_HOME`，本次不向其中复制配置或凭据。浏览器存储及产品身份保持不变。

## 验证与验收

定向测试覆盖本地配置作用域、协议路由与歧义 ID、专用模型过滤、选定模型排序、仅元数据序列化、模型与审批独立选择、原子创建与重试、不支持的准入及 boot 验证。完成构建、类型检查和相关包测试。在使用两个受控模型端点的隔离部署中，新建任务选择 B，观察 `request.model=B`；空闲 Session 切换到 A，观察下一轮 `request.model=A`；刷新以及更换服务进程后重新读取选择。验证目录和 boot 不包含提供方地址或秘密，未鉴权浏览器无法读取 boot。仅在验证通过后更新现有本地预览，并确认原 Workspace/Session 数据保留。
