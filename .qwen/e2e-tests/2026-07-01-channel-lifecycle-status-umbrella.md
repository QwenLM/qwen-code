# Channel Lifecycle Status Umbrella Coverage

Date: 2026-07-01

## Support matrix

| Channel | Supported lifecycle events | Native surface | `started` behavior | `text_chunk` behavior | Terminal behavior | Unsupported / no-op reason | Exact test files |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Telegram | `started`, `completed`, `cancelled`, `failed` | Typing indicator | Starts the existing per-chat typing loop once. Duplicate `started` events do not add another loop. | Ignored by the lifecycle hook. Response content continues through the normal reply path. | Stops the typing loop on any terminal event and leaves no stale interval behind. | `tool_call` has no native status surface and does not need adapter UI. | `packages/channels/telegram/src/TelegramAdapter.test.ts` |
| Weixin | `started`, `completed`, `cancelled`, `failed` | Typing indicator | Calls `setTyping(chatId, true)` once for the active chat. Duplicate `started` events do not restack typing state. | Ignored by the lifecycle hook. Response content continues through the normal send path. | Calls `setTyping(chatId, false)` on terminal events. Failed start attempts clear local state so a later `started` can retry. | `tool_call` has no separate status surface and no extra message should be sent. | `packages/channels/weixin/src/WeixinAdapter.test.ts` |
| DingTalk | `started`, `completed`, `cancelled`, `failed` | Eye reaction on the inbound message | Attaches the existing eye reaction once when a conversation id is available. | Ignored by the lifecycle hook. Response content continues through the normal send path. | Recalls the eye reaction on terminal events, including late-resolving attach races after cancellation. | Direct robot webhook chats do not expose the conversation id needed for reactions, so lifecycle status is a no-op there. `tool_call` also has no UI in scope. | `packages/channels/dingtalk/src/DingtalkAdapter.test.ts` |
| Feishu | `started`, `completed`, `cancelled`, `failed` | Streaming card status label | Keeps the card in its running state and reserves space for the running label while the existing card stream is active. | Not consumed directly by the lifecycle hook. Content streaming remains owned by the existing response/card stream hook. | Finalizes the card status label as completed, cancelled, or failed without overwriting the streamed answer body. | `tool_call` stays hidden because the card already uses the answer stream plus terminal status labels only. | `packages/channels/feishu/src/adapter.test.ts`, `packages/channels/feishu/src/markdown.test.ts` |
| QQ Bot | None | None | No-op. | No-op. QQ Bot still streams reply chunks through outbound message sends, but not through lifecycle status updates. | No-op. | The channel has no typing or task-status endpoint, and `QQChannel` leaves `onPromptStart`, `onPromptEnd`, and `onTaskLifecycle` empty by design. | `packages/channels/qqbot/src/send.test.ts`, `packages/channels/qqbot/src/api.test.ts` |
| Plugin example | None | WebSocket protocol messages only | No-op for lifecycle status. | Streams response chunks over the mock protocol's `chunk` message type from `onResponseChunk`, outside lifecycle status handling. | Sends the final outbound message on response completion, outside lifecycle status handling. | The mock channel demonstrates transport wiring only; it has no native typing, reaction, or status surface. | `integration-tests/channel-plugin.test.ts` |

## Verification commands

### Adapter and package coverage referenced above

- `cd packages/channels/telegram && npx vitest run src/TelegramAdapter.test.ts`
- `cd packages/channels/weixin && npx vitest run src/WeixinAdapter.test.ts`
- `cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts`
- `cd packages/channels/feishu && npx vitest run src/adapter.test.ts src/markdown.test.ts`
- `cd packages/channels/qqbot && npx vitest run src/send.test.ts src/api.test.ts`
- `cd integration-tests && npx vitest run channel-plugin.test.ts`

### Branch verification required for this doc-only update

- Run the review-provided grep check against this file pair.
- `git diff --check`
