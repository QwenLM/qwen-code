# Daemon attach

状态：已实现。

[English](2026-10-21-daemon-attach.md) | [简体中文](2026-10-21-daemon-attach.zh-CN.md)

## 范围

`qwen attach` 是连接本地 daemon 上既有 session 的文本终端客户端。它通过 TypeScript SDK 加载 session、渲染归一化后的 assistant/thought 文本，并把 stdin 的每一行作为 prompt 发送。第一版要求显式 session id；不提供 session 列表，也不交互处理权限请求。

## 命令

```bash
qwen attach --session <session-id> [--port <port>] [--workspace <path>] [--token <token>]
```

存在多个 discovery record 时用 `--port` 选择一个 daemon。`--workspace` 指定 session 所属的已注册 workspace；daemon 只服务一个 workspace 时会自动选择。bearer daemon 需要 `--token`、`QWEN_SERVER_TOKEN`，或 `daemon start --save-token` 写入的 sidecar。

## 行为

- 只选择一个 discovery record；无 daemon 或多 daemon 未指定 `--port` 均报错。
- 用 `DaemonSessionClient.load` 加载 session，已知目标 workspace 时一并传入。
- 先渲染 load 返回的 `compactedReplay` 与 `liveJournal` 快照，再启动 SSE 订阅，确保 attach 前的历史与进行中的回复可见。
- 在接收 stdin 前订阅 `GET /session/:id/events`，避免漏掉 model-switch、生命周期与 prompt 响应事件。
- 将净化后的 `assistant.text.delta` 与 `thought.text.delta` 写到 stdout；turn 结算（`turn_complete`/`turn_error`）或 prompt 结算时结束当前行；错误写 stderr。
- 其他归一化事件（工具调用、文件差异、生命周期通知）有意不渲染；attach 是纯文本终端客户端，不是完整的 Web Shell 转录器。
- stdin 的每个非空行作为单个 text content block，经 `POST /session/:id/prompt` 发送。
- Ctrl+C 或 Ctrl+D 关闭本地订阅、释放本客户端的 daemon 注册并退出。脱离终端不会取消已接受的 prompt；进行中的 turn 会在服务端继续执行。当本客户端是最后一个客户端且没有待处理的 turn 时，daemon 可能关闭该 session。

## 安全

- token 依次来自显式 flag、环境变量、pid-scoped sidecar；不会打印。
- 只有 `listenerIdentityVerified` 确认监听者确为记录中的 daemon 后，才会发送环境 `QWEN_SERVER_TOKEN` 或 sidecar token；显式 `--token` 由操作者提供，仍然允许。`auth: none` 的 daemon 不会收到任何环境 token。
- assistant/thought/permission/error 文本在写终端前经过 `sanitizeTerminalText`，模型提供的转义序列不能清屏或改写剪贴板。写入 stderr 的服务端错误信息同样经过净化。
- 命令复用 SDK 的 bearer-aware HTTP/SSE transport，重定向与 daemon 认证遵循既有客户端契约。

## 限制与后续

- 不含 session 发现/列表；操作者需从 Web Shell 或其它客户端取得 id。
- 文本客户端尚未处理权限请求；需要审批的工具仍应通过 Web Shell 完成，交互式权限选择属于后续工作。
- 仅渲染文本：tool card、diff、图片与附件尚未渲染。

## 验证

- 单测：目标选择、token 解析、命令注册。
- 实跑：对 Web Shell/SDK 创建的 daemon session 执行 attach，确认 assistant 文本与 prompt 往返。
