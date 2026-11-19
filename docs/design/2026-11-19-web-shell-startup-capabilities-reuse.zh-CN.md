# Web Shell 启动阶段复用 `/capabilities` 探测响应

[English](2026-11-19-web-shell-startup-capabilities-reuse.md) | [简体中文](2026-11-19-web-shell-startup-capabilities-reuse.zh-CN.md)

## 问题

在独立版 Web Shell 与 Desktop 启动过程中，工作区和会话界面就绪之前会串行发起两次 `GET /capabilities` 请求：

1. `StandaloneAuth` 先请求 `GET /capabilities` 校验连通性与 Bearer 凭证，仅检查 `response.ok` 后即丢弃 JSON 响应体并挂载子组件。
2. `StandaloneAuth` 放行后，`DaemonWorkspaceProvider` 才挂载，并在首轮 effect 中立即通过 `DaemonClient.capabilities()` 发起第二次 `GET /capabilities`。

仅跳过 `DaemonWorkspaceProvider` 的请求并不足以消除第二次请求：侧边栏加载会话列表时会传入 `sortBy`，触发 `DaemonClient.requireCapability('session_last_user_prompt_sort')`；若 `DaemonClient` 内部预检缓存未同步预热，仍会补发一次 `GET /capabilities`。

## 设计决策

- **由 `StandaloneAuth` 将校验后的响应透传给 `DaemonWorkspaceProvider`**：`StandaloneAuth` 收到 `200 OK` 后，清除响应头/鉴权超时，最多再等待 250 ms 读取可选的 JSON 响应体，并将有效的运行时能力对象通过 `children(token, initialCapabilities)` 传递给 `StandaloneApp` 与 `FocusedDaemonWorkspaceProvider`。
- **通过 `DaemonClientOptions.initialCapabilities` 在构造阶段预热缓存**：`DaemonClient` 将缓存写入逻辑抽离为 `applyCapabilitiesCache()`，在构造函数检测到有效的字符串数组 `features` 时直接预热 60 秒 TTL 的 `capabilityFeatures` 预检缓存（服务 `requireCapability`）和 `cachedSessionRestoreTimeoutMs`（服务 `limits.sessionRestoreTimeoutMs`）。构造注入既避免运行期竞态与销毁后回写，又天然兼容旧版 peer `@qwen-code/sdk`（未知构造选项会被无害忽略）。
- **`DaemonWorkspaceProvider` 同步初始化首屏状态**：当 `autoConnect` 开启且 `initialCapabilities` 匹配初始 `{ baseUrl, token, transport }` 时，直接将 `status` 初始化为 `'connected'`、填充 `capabilities` 与 `getCapabilities()`，跳过首轮 `client.capabilities()` 请求，同时保持 `refreshCapabilities()`、断线恢复和 StrictMode 延迟销毁语义不变。

## 约束与安全守卫

- **过滤不完整的冷启动 bootstrap 与 managed 响应**：单工作区冷启动阶段 `bootstrapApp` 返回的 `/capabilities` 缺少 `workspaces` 等运行时字段，`managed-web-serve` 仅返回不含 `features` 与 `workspaces` 的 `{ mode: 'managed' }`。`StandaloneAuth` 仅在响应体同时包含字符串数组 `features` 和数组 `workspaces` 时才复用该对象；其余情况照常放行鉴权门禁但不透传 `initialCapabilities`，安全回退到 `DaemonWorkspaceProvider` 正常拉取。
- **限定初始 origin 与 token 的一次性消费**：`FocusedDaemonWorkspaceProvider` 仅在未离开过 `bootOrigin` 且 `effectiveToken === bootToken` 时透传 `bootCapabilities`，一旦切往其他 daemon 或更换 token 即永久失效。`DaemonWorkspaceProvider` 通过 ref 仅在初始 `{ baseUrl, token, transport }` 命中时消费一次种子，不将 `initialCapabilities` 放入 `useMemo` 依赖数组，避免父组件重渲染重建 `DaemonClient`，切 host 或切 token 后均会正常重新请求。
- **不做持久化**：复用的能力数据仅在本次启动的内存链路中传递，不会写入浏览器存储跨刷新复用。

- **限制可选响应体等待**：10 秒鉴权超时仅用于等待响应头。确认 2xx 后，响应体失败或卡住不会撤销鉴权；250 ms 后仅取消当前探测并不带 seed 挂载，由工作区正常请求能力。正常完整响应仍保留单请求快路径。探测退役会清除响应体定时器；迟到的成功或失败不能更新新目标或重启鉴权循环。

## 不在范围内

- 外部 SDK 调用方使用 `negotiateTransport()` 时的多步探测逻辑（当前 `qwen serve` 仅通告 `transports: ['rest']`，Web Shell 使用默认 `RestSseTransport`）。
- Chrome 扩展侧边栏加载 iframe 前的 `/health` + `/capabilities` 探测，以及 VS Code 远程窗口扩展宿主侧的 pre-auth Host 门禁探测。

## 验证

- `DaemonClient.test.ts` 单测：验证传入 `initialCapabilities` 后 60 秒 TTL 内 `requireCapability()` 零请求复用、超过 60 秒后自动刷新、`limits.sessionRestoreTimeoutMs` 生效，以及畸形输入被安全忽略。
- `StandaloneAuth.test.tsx`、`DaemonWorkspaceProvider.test.tsx`、`availability-lifecycle.test.tsx` 与 `main.test.tsx` 单测：验证从 `StandaloneAuth` 到 `DaemonWorkspaceProvider` 再到 `listWorkspaceSessionsPage(..., { sortBy })` 的完整启动链路仅发起 1 次 `GET /capabilities`，并验证 bootstrap/managed 响应、切换 host、切换 token 与 `refreshCapabilities()` 仍正常发起新请求。
