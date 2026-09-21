# 在已保存的历史中保留用户消息标签

[English](user-message-tag-replay.md) | [简体中文](user-message-tag-replay.zh-CN.md)

## 问题与范围

Web Shell 实时消息携带 `inputAnnotations`，但 ACP 记录用户消息时没有保存它们。因此，空闲会话刷新及磁盘历史回放只能恢复引用原文，无法恢复标签。通过现有 transcript payload 和回放 metadata 保存已提交的文件、MCP、扩展及自定义引用注解。

## 设计

- 为 `UserPromptRecordPayload` 添加可选、不透明的 `inputAnnotations`。Core 负责存储 UI metadata，不依赖 SDK UI 类型，也不把它加入模型输入。
- ACP 记录普通提示及延后记录的自定义 `/advisor` 提示时，将请求中的注解数组与展示文本一起快照保存。重试和继续使用原始记录。只复制注解字段，不保存无关请求 metadata。
- 共享 transcript 回放状态机通过用户更新的 `_meta` 转发已保存的注解数组。现有 SDK 归一化和 Web Shell 渲染逻辑恢复标签，覆盖历史分页及重新打开已保存会话。
- 沿用数组检查及渲染器的引用和位置校验。忽略缺失或非数组注解字段。不从原文推测引用；没有注解的旧记录继续显示原文。

## 消费方与约束

新字段由 ACP 写入，记录器原样存储，共享回放状态机读取；CLI 历史加载与分页以及 SDK chat-record 投影共同使用该状态机。TUI/headless 记录、会话标题、模型历史和附件预览保持现有输入。不新增路由、缓存、数据迁移或运行时归属变化。

## 验证与验收

- 复现真实提示记录及磁盘重载，区分全局 CLI 与当前 worktree 的行为，并明确任何模拟模型服务。
- 回归测试覆盖文件/MCP/扩展记录、快照归属、注解回放及模型文本不变。缺失或外层格式错误的 metadata 不应产生注解。
- 浏览器重载后从已保存记录恢复标签；长名称继续截断，外观与文件标签保持一致。
- 运行相关包测试、构建、打包、类型检查、格式及 lint 检查，并审阅完整 diff。
