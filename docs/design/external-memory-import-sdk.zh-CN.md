# 外部记忆导入 SDK

[English](external-memory-import-sdk.md) | [简体中文](external-memory-import-sdk.zh-CN.md)

## 问题与范围

daemon 已实现[外部记忆导入 API v1](external-memory-import-api.zh-CN.md)，
但 TypeScript SDK 尚无类型化入口。DataAgent 需要通过它让用户选择本地 Codex
记忆、查看预览并管理导入任务。本次公开已有契约；目标记忆目录浏览和手动导入可用性另行推进。

## 设计

在 `WorkspaceDaemonClient` 增加七个方法：`previewMemoryImport`、
`submitMemoryImport`、`listMemoryImports`、`getMemoryImport`、
`getMemoryImportSource`、`cancelMemoryImport` 和 `retryMemoryImport`。
全部要求 `memory_import_v1`，访问选定工作区的 `/memory/import` 路由。
批次与章节标识符分别编码，不隐式回退主工作区。

复用已有认证 JSON 请求方法并设置 `mode: 'rest'`，因为这些端点没有 ACP HTTP 映射。
能力发现仍可使用已配置传输。变更操作接受既有可选客户端 ID。
提交直接返回持久化任务回执，不轮询、不自动重新提交；响应不确定时由调用方保留幂等键。

在 `daemon/types.ts` 定义 SDK 自有协议类型，并从两个 SDK 入口导出。
类型对应现有来源、章节、估算、预览、选择、提交、任务条目、任务结果和任务契约，
不引入 CLI/Core 运行时依赖。任务列表直接返回数组，保留来源读取返回单个章节，
不增加响应包装层。

通过 `DaemonHttpError` 保留 HTTP 状态和正文，增加可选的原始 `retryAfter`
字符串，以保留运行时不可用或恢复失败时的 `Retry-After` 响应头。
已有三参数构造方式继续有效。SDK 不解释该值，也不自动重试可能付费的操作。

实现涉及 daemon client、协议类型、HTTP 错误、公开导出、SDK 定向测试和 SDK 使用说明。
不修改 daemon 路由、记忆处理、可用性策略、包依赖或 DataAgent 界面。
已有服务端继续负责信任、持久化、预算和来源限制。

## 验证与验收

只使用合成内容。先确认已安装 CLI 的离线预览基线，再通过本地 HTTP 服务验证 SDK，
适用时使用本地构建 daemon。验证本次传输层扩展不需要生产记忆或付费模型。

- 七个方法均使用选定工作区、准确 HTTP 方法与正文，以及既有认证和客户端 ID 规则。
- ACP 传输用于能力发现，导入请求走原生 REST；缺少能力时不发送导入请求。
- 预览、202 任务回执、数组列表和章节读取保留既有契约。
  含保留字符的标识符不能改变路由。
- HTTP 400/404/503/500 保留状态和正文，503 保留 `Retry-After`。
  响应丢失不自动重试，不改写调用方幂等键。
- 两个公开入口均导出方法和完整协议类型。
- 提交前完成全量构建、bundle、类型检查、定向单测、格式检查及两轮干净自审。

协议没有待定决策。能力位不保证具体工作区可用，调用方必须处理服务端拒绝。
DataAgent 界面端到端验收、生产模型质量及非 macOS 平台执行属于后续验证，
不作为本次 SDK 改动已完成的声明。
