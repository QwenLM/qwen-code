# 批量 workspace 会话运行状态

[English](daemon-batch-session-live-state.md) | [简体中文](daemon-batch-session-live-state.zh-CN.md)

状态：与本文档一同为 [#12511](https://github.com/QwenLM/qwen-code/issues/12511) 实现。

## 问题与范围

daemon 已提供权威、仅来自内存的 `GET /workspaces/:workspace/sessions/live-state` 快照，但同时展示多个 workspace 的客户端必须逐个轮询。现有批量会话目录可能扫描持久历史，不适合高频刷新执行状态。本设计增加一个只读批量请求和 TypeScript SDK 方法。单 workspace 路由、逐会话 SSE 和 Web Shell 当前轮询行为保持不变；客户端迁移可另行实施。

## 归属与生命周期

`POST /sessions/live-state` 只接受 1–20 个显式、按顺序列出的已注册 workspace ID 或绝对路径。每个 selector 使用批量目录相同的公开注册 workspace 解析器：先按 ID，再按规范化路径。未知、内部和已移除 workspace 不回退到 primary。不提供 `all`，由客户端选择当前展示的 workspace。

每个成员必须对应活跃、未关闭且未变化的 runtime generation，并且必须可信，包括 secondary workspace。缺失或变化中的 generation 返回 `503 workspace_runtime_unavailable`；不可信 runtime 返回 `403 untrusted_workspace`；未知、内部或已移除 selector 返回 `404 workspace_not_found`；意外读取错误返回 `500 session_live_state_failed`。有效批量请求返回 HTTP 200，每个成员按请求顺序独立成功或失败。鉴权和请求准入仍是进程级的。成员读取不扫描持久目录、不启动 ACP 子进程或冷 runtime，也不写入状态。

## 快照契约

请求体为 `{ "workspaces": ["workspace-id", "/absolute/path"] }`。成功成员包含原始 `workspace` selector、规范化的 `workspaceId` 与 `cwd`，以及与单 workspace 接口完全一致的 `v`、`catalogVersion` 和 `sessions` 快照。错误成员包含原始 selector、可解析时的归属身份，以及 `error: { code, message, status }`；错误不会伪装成成功的空快照。格式错误的请求在读取成员前返回 HTTP 400 `invalid_session_live_state_batch_request`。响应使用 `Cache-Control: no-store`。

两个路由共用相同的状态投影和按 bridge 保存的上次暴露目录版本。首次暴露或版本变化时，在返回版本前失效 active 和 archived 持久目录缓存。`catalogVersion` 是目录相等性标记，并非易变状态序列：运行和等待状态变化即使不改变版本，也会出现在完整快照里。批量读取不保证跨 workspace 原子性，也不提供合并列表。

## 资源上限、能力发现与客户端

显式列表最多 20 项，每个 selector 最多 4096 字符，每个序列化后的成功成员最多 512 KiB。成员直接同步读取 bridge 内存，不需要磁盘读取线程池。批量 HTTP 请求使用现有读取限流档位。请求遥测记录批量路由和成员数量；与 workspace 相关的工作归属到各自解析出的 runtime。超大成员返回 `413 live_state_response_too_large`，不会静默截断。

独立公布 `workspace_session_live_state_batch` 能力。SDK 使用一次原生 REST 请求，支持传输取消和超时。调用方可预检一次 capability，旧 daemon 继续使用现有单 workspace 请求；SDK 不会暗中逐个重试。本次改动不将 Web Shell 轮询切换到批量方法。

## 验证与验收

覆盖一次请求返回 primary 和 secondary、原始 selector 与顺序、目录版本不变时的易变状态变化、成功与未知/不可信/不可用错误并存、generation 替换、内部 workspace 排除、无效输入、大小上限、与单项路由共享缓存失效、读取限流分类、SDK 单次请求和取消、能力发现、旧 daemon 的 404。通过构建、类型检查、聚焦单测和本地 bundle 的 daemon E2E 验证实现；全局 CLI 基线应显示新增路由尚不存在。

## 待讨论问题

维护者可调整路由名称或资源上限。未来 Web Shell 迁移可将本接口与页面可见性轮询或 SSE 校准结合，不改变快照语义。
