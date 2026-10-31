# Managed Web Shell 宿主接入

[English](2026-10-29-managed-host-webshell.md) | [简体中文](2026-10-29-managed-host-webshell.zh-CN.md)

## 问题与范围

非 React 宿主管理已有托管 Session，并仅提供有限 BFF。宿主需要官方对话与输入框，
且不能挂载 daemon 上下文或使用 Java 会话列表。本次改动限定在 Web Shell；传输、
鉴权、授权与真实浏览器验收由宿主实现。

## 契约与决策

`ManagedAgentWebShell` 接受 `managedAgentProvider?: ManagedAgentProvider` 和
`hostSessionOnly?: boolean`（默认 `false`）。注入 provider 时直接使用，不构造 Java
provider；省略时保留 Java 行为。

host-only 仅打开显式的 `sessionId`。没有 ID 时渲染空对话区域，不查询、自动选择或
创建会话。隐藏内部列表、New 与列表刷新。已有会话只通过 `getSession`、
`getTranscript`、`subscribeEvents` 加载，发送使用 `submitPrompt`。官方消息列表和
输入框保留 provider 能力，`canSend: false` 禁用发送，`canCancel: false` 不提供取消
操作或 Escape 提示，即使存储中存在旧取消请求也不会重试。没有模型切换能力时，
宿主视图隐藏模型选择器和固定模型提示，不把 Agent 身份当作模型。宿主 provider
必须省略不支持的可选 API。四 API provider 可为类型要求的列表、
创建、取消方法提供拒绝 stub，宿主路径不调用它们。通用 `submitPrompt` 回执要求
`sessionId` 与 `turnId`，`operationId` 可省略：宿主可能只公开事件流而没有持久化操作
查询 API。Java 仍校验自身真实 operation 身份；取消和取消恢复保持严格 operation
身份契约。

provider 的 `storageKey` 必须包含租户与账号身份。更换 scope 会清理选择、待确认请求、
对话和订阅；沿用旧 ID 时先丢弃该选择，等待宿主显式传入新选择。宿主待发送请求另按
Session ID 隔离。短期 token 刷新应保持 provider 身份稳定。品牌、主题、语言、portal
容器与 scoped CSS 均沿用已有实现。

`renderManagedAgentWebShell(container, props)` 创建 React root，返回
`{ update(nextProps), unmount() }`。更新替换完整 props 对象。宿主拥有容器并在销毁时
调用 `unmount()`。不引入 daemon provider、服务或替代对话页面。容器位于 ShadowRoot 时复用
已有 Web Shell 样式 adoption，unmount 时释放注入样式。

## 构建与约束

在 `packages/web-shell` 运行
`npx vite build --config vite.lib.config.ts --mode managed-host`。产物为
`dist/managed-host/index.js` 及相对 chunks。独立模式 bundle React、React DOM 与运行时
依赖，复用已有 CSS 隔离和注入插件。宿主需按 JavaScript MIME 类型提供完整产物目录，
无需 import map 或单独 CSS import。普通 default 与 transcript 构建保持既有入口和 external
规则。

## 验证与验收

React 集成测试覆盖已有 ID 的加载和发送、不访问列表/创建/daemon、无 ID 等待与清除、
只读能力和 scope 重置。既有 Java 测试作为兼容回归。恢复无条件列表 effect 会触发
host-only 请求断言失败；恢复无 ID 创建会触发无 ID 输入框断言失败。包内 typecheck 与
普通、managed-host 构建验证集成。本地 E2E 计划位于
`.qwen/e2e-tests/managed-host-webshell.md`，真实浏览器验收由宿主 agent 执行；此处不进行
浏览器或云端操作。
