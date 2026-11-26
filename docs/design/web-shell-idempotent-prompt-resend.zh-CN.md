# Web Shell 幂等消息重发

[English](web-shell-idempotent-prompt-resend.md) | [简体中文](web-shell-idempotent-prompt-resend.zh-CN.md)

## 问题

消息的 POST 已发出但 `202` 响应丢失（断网、超时、网关 `5xx`）时，Web Shell 无法判断 daemon 是否已接收。此前会在输入框上方显示“送达不确定”横幅和“恢复本地副本 / 丢弃本地副本”，在用户选择前锁定输入框，恢复前还要 `window.confirm`。即使回合已明显开始执行，横幅仍不消失。大部分 `4xx` 拒绝也被误判为不确定。

## 现状

daemon 已支持按可选 `idempotencyKey` 对 `POST /session/:id/prompt` 去重（按会话的环形缓存；重复请求返回原 `promptId` 并带 `deduplicated: true`）。daemon 版 Web Shell 从未发送该 key。

## 目标与范围

- 通过安全重试，让大多数响应丢失对用户不可见。
- 结果仍未知时按聊天软件呈现：消息留在会话中，左侧显示红色 `!`；悬停提示“重发”，点击即重发。
- 结果未知时绝不锁定输入框。
- 不包含：daemon 改动、managed-agent 流程。

## 设计

### 幂等与自动重试

- 调用方每次提交生成一个 key（`createPromptIdempotencyKey`），通过 `sendPrompt` / `submitPrompt` / `sendDetachedPrompt` 传递 `idempotencyKey`。
- 存在 key、失败不属于明确拒绝、请求未取消且会话未变化时，`sendPrompt` 在 400 ms 和 1200 ms 后用同一请求（同一 key、同一已上传附件引用）静默重试。
- 明确拒绝：HTTP `400/401/403/404/409/413/429/501`、`DaemonPendingPromptLimitError`、`PromptDispatchCancelledError`。只有这些情况会删除已上传附件。
- `turn_error` 后的回合重试生成新 key（daemon 仍记着原回合的 key），仅在该重试本身结果不确定时复用这个重试 key。

### 消息级重发

- 发送失败或不确定时，在绑定到对应用户消息块的失败记录上保存 `{ idempotencyKey, reason: 'failed' | 'uncertain' }`。
- `UserMessage` 在气泡左侧渲染 20 px 红色圆形 `!` 按钮，提示文案为“重发”（失败）或“可能未送达，点击重发”（不确定）。点击后以 `optimisticUserMessage: false`、`bindBlockId` 和同一 key 重发。
- 适用于主输入框、消息内联编辑和分屏面板。

### 自动消除

回合运行期间隐藏该标记；当用户消息块获得 `promptId`，或其后出现新的可回退用户块、assistant、thought 或 tool 块时清除。后台通知不会清除它。

## 约束与风险

- daemon 去重缓存在内存中；daemon 重启后重发可能再次执行，与此前手动重发行为一致。
- 忽略 `idempotencyKey` 的 daemon 在重发时仍是至少一次语义。

## 验证与验收

- 单元测试：错误分类；会话 actions 的重试、退避、取消与附件清理；`UserMessage` 标记；`MessageList` 透传；App 与 ChatPane 流程（输入框不锁定、同 key 重发、自动消除）。
- 验收：不再出现“本地副本”横幅或确认弹窗；不确定的发送让消息带 `!` 留在会话中；重发已被接收的消息不会启动第二个回合。
