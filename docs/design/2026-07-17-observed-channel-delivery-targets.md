# Workspace-scoped observed channel contacts

## Problem

Daemon-managed channel workers receive platform user, group, and topic identifiers on inbound messages, but the identifiers are transient. Authenticated workspace clients need a read API that lists recently observed IM contacts so a user can select a complete platform delivery target without manually finding or retyping identifiers.

## Scope

This change observes accepted inbound messages, persists a bounded relationship graph per daemon workspace, and returns complete platform identifiers for DingTalk, Feishu, Telegram, and WeCom channels.

It does not change webhook configuration or proactive delivery, query a platform directory, claim to return complete group membership, observe bot output, or backfill historical traffic. Standalone `qwen channel start` is unchanged.

## Ownership and persistence

The daemon workspace runtime owns the registry:

```text
$QWEN_HOME/channels/daemon/<workspaceHash>/observed-contacts.json
```

`QWEN_HOME` is process-level, but `<workspaceHash>` partitions data by canonical workspace path. The registry is not stored in the workspace checkout and is not shared as one process-global graph. Its directory uses mode `0700` where supported; the atomic JSON file uses mode `0600`.

The registry stores at most 500 relationship observations across all channels and conversations in the workspace. Each observation contains `channelName`, a user identity, an optional group identity, an optional topic identity, and `lastObservedAt`. The deduplication key is `[channelName, user.id, group?.id, topic?.id]`. A noisy conversation can therefore evict older observations from another conversation. Observations older than the maximum 365-day readable window are removed on the next accepted write.

## Observation boundary

Recording occurs after the shared inbound preflight accepts a real IM message and before command or Agent handling begins. Direct/group policy, mention, sender allowlist, and pairing rejection therefore happen before persistence.

The same `Envelope` object is recorded at most once. A later message refreshes the matching relationship timestamp and labels. Persistence is best-effort: a sanitized error is logged without identifiers, and accepted message handling continues.

The registry never stores message text, message IDs, attachments, payloads, credentials, webhook requests, proactive sends, or bot output.

## Relationship model

```ts
interface ObservedChannelContactObservation {
  user: { id: string; label: string };
  group?: { id: string; label: string };
  topic?: { id: string; label: string };
}
```

- A direct message records a top-level user from the complete platform `senderId`.
- A group message records the group from the complete platform `chatId` and the observed user inside that group.
- A threaded group message also records the topic from `threadId` and the observed user inside that topic.
- A user seen only in groups does not appear in top-level `users`. If the same user also sends a direct message, it appears both at the top level and under the relevant groups.
- `groups[].users` and `groups[].topics[].users` mean users observed in those conversations. They are not authoritative platform membership lists.
- Sender labels use the sanitized inbound display name, falling back to the complete user ID. Group labels use a sanitized name when the accepted inbound envelope supplies one; DingTalk maps `conversationTitle` and Telegram maps `chat.title`. Feishu and WeCom group labels, and all topic labels, fall back to their complete IDs.

Feishu maps `root_id` to `threadId`; Telegram maps `message_thread_id` to `threadId`. Current DingTalk and WeCom envelopes do not expose a stable topic identifier, so their observations stop at the group level.

## Freshness

People, conversations, and relationships change. The read API filters observations rather than presenting the registry as permanent truth:

- default freshness: seven days;
- caller override: `freshWithinSeconds`, from 1 second through 365 days;
- user, group-user, topic-user, group, and topic timestamps are derived independently from recent observations;
- passive observation cannot immediately detect a leave, deletion, or rename that produces no new message, so stale relationships disappear only when they exceed the requested window.

## Read API

Primary workspace:

```http
GET /workspace/channel/observed-contacts?freshWithinSeconds=604800
Authorization: Bearer <daemon token>
```

Selected registered workspace:

```http
GET /workspaces/:workspace/channel/observed-contacts?freshWithinSeconds=604800
Authorization: Bearer <daemon token>
```

Example:

```json
{
  "users": [
    {
      "channelName": "feishu-main",
      "label": "Example User",
      "id": "ou_complete_user_id",
      "lastObservedAt": "2026-07-17T08:00:00.000Z"
    }
  ],
  "groups": [
    {
      "channelName": "feishu-main",
      "label": "oc_complete_chat_id",
      "id": "oc_complete_chat_id",
      "lastObservedAt": "2026-07-17T08:05:00.000Z",
      "users": [
        {
          "label": "Example User",
          "id": "ou_complete_user_id",
          "lastObservedAt": "2026-07-17T08:05:00.000Z"
        }
      ],
      "topics": [
        {
          "label": "om_complete_root_id",
          "id": "om_complete_root_id",
          "lastObservedAt": "2026-07-17T08:05:00.000Z",
          "users": [
            {
              "label": "Example User",
              "id": "ou_complete_user_id",
              "lastObservedAt": "2026-07-17T08:05:00.000Z"
            }
          ]
        }
      ]
    }
  ]
}
```

Responses use `Cache-Control: no-store`. The primary route reads only the primary workspace partition. The qualified route requires an exact registered, trusted runtime and never falls back to primary for unknown, untrusted, bootstrapping, draining, or removed workspaces.

A missing registry returns an empty graph. Malformed data returns a sanitized `500` with code `channel_observed_contacts_unavailable`. Delete the workspace's `observed-contacts.json` file to reset a malformed or unsupported registry; accepted traffic recreates it. Invalid freshness returns `400 invalid_freshness`.

Clients discover the route through the `workspace_channel_observed_contacts` serve capability. The route is read-only and is registered after daemon bearer authentication.

## Compatibility

Webhook parsing, requests, target resolution, and delivery are identical to `main`. This API only exposes observed identifiers; callers decide how to use them. The registry begins at schema version 1 because the earlier opaque-reference prototype was never released.

## Test strategy

- Base-channel tests cover the preflight boundary, topic normalization, Envelope deduplication, and non-blocking persistence failures.
- Store tests cover direct-versus-group semantics, group/topic relationships, freshness, refreshes, bounds, permissions, and malformed data.
- Route tests cover complete identifiers, no-store responses, freshness validation, exact workspace ownership, and sanitized failures.
- Server tests cover bearer authentication and capability advertisement.
- Webhook regression tests verify no behavior differs from `main`.
