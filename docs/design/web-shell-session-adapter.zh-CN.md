# Web Shell 独立会话适配器

[English](web-shell-session-adapter.md) | [简体中文](web-shell-session-adapter.zh-CN.md)

## 目标与范围

嵌入宿主可以通过自己的服务创建、恢复及提交独立会话，同时复用 Web Shell 的输入框和消息区。宿主可以分配会话 ID、省略工作目录，并通过自己的流报告回合终态。工作区会话及未提供适配器的宿主使用 daemon 路由。

## 客户端与会话归属

`WebShellWithProviders` 仅在显式指定 standalone 上下文且没有 `lockWorkspaceCwd`、`workspaceCwd` 或 `workspaceId` 时使用 `sessionAdapter`。工作区 provider 持有 `createClient` 返回的客户端。重新渲染时传入新的适配器对象会复用该客户端，卸载时释放客户端。客户端必须提供 `capabilities()`，否则独立会话视图显示能力错误。品牌信息可选。宿主负责可用性，因此 provider 跳过适配器客户端的 `DaemonAvailability` 轮询和暂停处理。

`create` 返回服务分配的会话 ID，并应用和验证请求的启动配置。`load` 恢复同一 ID 的客户端附着和历史。宿主可以使用 `@qwen-code/sdk/daemon` 的 `StandaloneSessionMetadata` 构造没有工作目录的会话。Web Shell 通过返回的会话客户端解除附着。继续会话、侧问和其他会话操作也使用该客户端。

## 消息提交生命周期

内置 REST 和 ACP 订阅在事件流建立后报告就绪。自定义订阅可以接收事件后调用 `onEventStreamReady`。前台提交等待订阅就绪，使空闲订阅能够接收首轮事件。宿主通过会话事件发送已受理的用户消息和助手内容，并在恢复历史时提供用户消息。

`submitPrompt` 返回已受理的 `promptId` 和 `completion` promise。最后一批 transcript 事件送达后结束 promise，流失败时拒绝 promise。匹配的 daemon 终止事件也可以先结算同一前台回合。Web Shell 在本地保留失败的输入供恢复，自动受理重试由宿主负责。导航后，detached 提交在受理时返回并释放附着，宿主继续运行该轮。

## 验收检查

- 在未声明独立会话 daemon 能力的服务上使用适配器打开独立会话。提交首问并看到宿主分配的会话 ID 和双方消息，刷新后追问时复用该会话。
- 在空闲的 REST、ACP HTTP 和 ACP WebSocket 订阅上提交。确认首问可以在收到任何消息之前发出，且没有终止事件时，completion 也能结算前台回合。
- 拒绝受理并验证 Web Shell 保留失败的输入且不自动重发。受理后中断事件流，验证失败只报告一次。在创建期间导航离开，验证 detached 附着在受理时释放。
