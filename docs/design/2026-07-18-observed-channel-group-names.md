# Observed channel group names

## Problem

The workspace-scoped observed-contact graph introduced by #7109 preserves complete platform group IDs, but every `groups[].label` currently falls back to that ID. Some inbound channel callbacks already carry a human-readable group name, and the adapters discard it before the shared observation boundary.

Users selecting a proactive-delivery target need the readable name alongside the complete, stable platform ID. The name is observational metadata, not a routing key.

## Scope

Add an optional group name to the shared inbound envelope and populate it only from metadata already present in an accepted inbound message.

- DingTalk maps the Stream callback's `conversationTitle`.
- Telegram maps the inbound chat's `title` for groups and supergroups.
- Feishu keeps the complete `chat_id` fallback because `im.message.receive_v1` does not include a chat display name.
- Other adapters keep the ID fallback unless their existing inbound payload has a documented group-name field.

This change does not call a platform directory, group-detail, or chat-info API; add permissions; alter routing or session identity; discover authoritative membership; observe bot output; or add topic names.

## Contract

`Envelope` gains one optional field:

```ts
chatName?: string;
```

The field describes the display name of `chatId` as observed on that message. It is ignored for direct messages. `chatId` remains the complete platform delivery key and continues to determine sessions, deduplication, and graph identity.

The common observation path uses a sanitized, non-empty `chatName` as the group label. Missing or unusable values fall back to the complete `chatId`. The existing registry store bounds persisted labels to 256 UTF-16 code units without splitting surrogate pairs.

## Refresh semantics

An accepted later message for the same channel, user, and group refreshes the observation. If it carries a different usable `chatName`, the existing store replacement semantics update the derived group label without creating another group node. Freshness remains `lastObservedAt`; names are not treated as permanent or authoritative.

A platform that omits a group name on a later message contributes the ID fallback for that observation. Graph derivation already selects the most recent observation, so the returned label represents the newest accepted evidence rather than a hidden long-lived name cache.

## Platform evidence

- DingTalk's Stream robot-message example includes `conversationTitle` in the inbound callback: [DingTalk Stream protocol](https://opensource.dingtalk.com/developerpedia/docs/learn/stream/protocol/#%E5%9B%9E%E8%B0%83%E6%8E%A8%E9%80%81).
- Telegram defines `Message.chat` as a `Chat`, whose `title` is available for group chats and supergroups: [Telegram Bot API — Chat](https://core.telegram.org/bots/api/#chat).
- Feishu's receive-message event enumerates `chat_id`, `chat_type`, and `thread_id`, but no chat display name: [Feishu Open Platform — Receive message](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive).

## Test strategy

- Base-channel tests prove usable group names propagate, unusable names fall back to complete IDs, direct messages ignore `chatName`, and later observations can refresh labels.
- DingTalk adapter tests prove `conversationTitle` enters the envelope without changing callback handling.
- Telegram adapter tests prove group and supergroup titles enter the envelope while private chats remain unchanged.
- Existing Feishu tests continue to prove the ID fallback path without API traffic.
- Focused store tests cover replacement by newer labels; no schema migration is needed because persisted observations already contain `group.label`.
