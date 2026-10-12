# ACP 资源链接描述

[English](2026-10-12-acp-resource-link-description.md) | [简体中文](2026-10-12-acp-resource-link-description.zh-CN.md)

状态：实现与本地验证已完成；交付与应用验收待完成。

## 问题与范围

ACP 为会话记录消费者保留完整的原始 `resource_link`，但模型只收到 URI
和名称。调用者无法通过标准 `description` 字段提供有用的参考上下文。本次
改动让非文件链接的描述对模型可见，不读取对应资源。

只修改 `packages/cli/src/acp-integration/session/Session.ts` 及其同目录测试。
会话持久化、replay、SDK schema、文件解析、权限和产品 UI 沿用现有契约。
Qwen 不解释应用专属 URI scheme、metadata、回调路由或任务关系。

## 投影方式

为每个非空且不全为空白的 `description` 收集一个独立文本 part：第一行为
`Resource link: <uri>`，下一行为 `Description: <description>`。保留描述原文，
保留现有 URI/name 标记和现有 parts 的顺序。`promptLast` 为 true 时，在现有
parts 前放置描述；否则放在其后，沿用解析器的参考上下文顺序。合成后的 parts
继续经过现有媒体 bridge 转换。

没有描述、描述为空或全为空白，以及 `file://` 链接的模型输入与原行为一致。
`_meta`、annotations、title 等链接字段不参与模型投影。描述属于普通参考
内容，不授予权限，也不成为可信指令。

对于发送协作请求与结果的应用，description 可以说明引用含义，链接自身的
metadata 可以记录关联关系。Qwen 不识别或执行应用的 request/reply 协议。
鉴权、关联和防止回复循环仍由应用负责。

## 验证与验收

同目录测试覆盖普通链接、请求与结果描述示例、多条描述、自定义命令参考上下文、
没有有效描述的链接保持原行为、不透明 metadata，以及本地和 SSH 文件链接。
现有原始链接记录
测试继续独立于模型展开验证持久化。

独立测试人员已完成 `npm run build`、`npm run typecheck` 和
`npm run bundle`，随后运行完整的同目录 Session 测试：
`cd packages/cli && npx vitest run src/acp-integration/session/Session.test.ts`。
1,246 项全部通过，包括 description 为 null 的边界。

构建后的 0.25.1 CLI 通过了本地 loopback OpenAI mock 的 9 个 ACP 场景：
普通引用、请求、结果、缺失、null、空字符串、空白、不透明 metadata 和文件。
捕获的模型请求与实际 ACP 回复确认描述只出现一次，原文和 URI/name 内容保留。
文件场景通过客户端仅允许指定测试文件的文件系统接口验证。全局 `qwen`
二进制不可用，因此不声明已运行全局基线；本次验证未使用真实模型服务或应用回调。

本地 E2E 计划保留在 Git 忽略的
`.qwen/e2e-tests/2026-10-12-acp-resource-link-description.md` 路径。
不修改依赖或外部 API 契约。

验收要求：描述只进入模型一次；原有 URI/name parts 保持完整；空白描述和
metadata 不增加模型内容；现有文件处理保持不变。待发送队列恢复和应用自动
回复属于独立工作。

## 开放问题

本次投影改动没有开放问题。部署和应用集成需要使用包含本改动的 Qwen 构建。
