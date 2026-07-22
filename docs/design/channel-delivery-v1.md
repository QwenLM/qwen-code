# Channel Delivery V1

## Goal

Allow scheduled tasks, daemon prompts, and a direct Notify API to send text to an explicit IM target through the Channel Worker that owns the selected workspace. Delivery is immediate and best effort: there is no durable outbox, replay, retry, or global final-answer hook.

## Public contract

```ts
interface ChannelDelivery {
  kind: 'channel';
  target: {
    channelName: string;
    type: 'user' | 'chat';
    id: string;
  };
}
```

Scheduled task creation and `POST /session/:id/prompt` accept an optional top-level `delivery`. Direct notification uses:

```http
POST /workspace/notify
POST /workspaces/:workspace/notify

{
  "text": "alert text",
  "delivery": {
    "kind": "channel",
    "target": {
      "channelName": "dingtalk",
      "type": "user",
      "id": "platform-user-id"
    }
  }
}
```

The daemon normalizes the public target at its trust boundary to the internal worker request `{ deliveryId, channelName, target: { type, id }, text }`. Text must be non-empty and is bounded to 100,000 UTF-16 code units before IPC.

## Execution boundaries

Scheduled tasks and Prompt own their final-answer semantics. A Session captures final text only when the current invocation carries delivery metadata. It submits one reverse control request only after a successful `end_turn` with non-empty text. Cancellation, Agent failure, and token-limit termination do not send. Empty successful output emits a skipped result. The delivered text is the full turn's assistant prose (all non-thought text parts), not only the terminal message block; inter-tool narration is included.

Prompt admission remains `202`; Agent completion remains `turn_complete` or `turn_error`. Channel completion is a later `channel_delivery_result` event and never converts Agent success into `turn_error`.

Notify bypasses Session and Agent. It waits for one worker delivery attempt and maps invalid input to 400, unavailable or full workers to 503, timeout to 504, and adapter failure to 502. A timeout has an unknown delivery outcome and is not retried.

Webhook remains an independent asynchronous path with its own secret and `202` worker-admission contract. It may reuse `ChannelBase` sending primitives and error classification, but not Prompt/Notify control flow. Background notification prompts remain local Agent work and do not automatically send to IM.

## Workspace ownership

The daemon binds the workspace when constructing each ACP bridge. Prompt admission records the daemon-issued delivery ID and pinned target, while scheduled delivery is authorized from the persisted task. The child callback must match that authorization and cannot choose `workspaceCwd` or replace the target. The host callback closes over the canonical workspace and routes only to that workspace's worker group. Missing, bootstrapping, draining, stopped, or removed owners return `channel_worker_unavailable`; there is no fallback to the primary runtime and no lazy worker startup.

## Reliability and privacy

Authorization is consumed before worker availability is checked, so a transient worker blip after consume drops that single delivery permanently; this is consistent with the immediate, best-effort, no-retry contract.

This V1 has no persistence, startup replay, historical scan, retry, or idempotency guarantee. Existing tasks without delivery never send. Existing scheduler catch-up behavior is unchanged. Normal executions carry delivery only when the task already contains it; the synthetic historical missed-one-shot batch explicitly clears delivery so enabling Channel later cannot create a burst of old alerts.

Delivery result events and logs include correlation identifiers, source, status, and sanitized error data. They never include message text, target IDs, credentials, or webhook secrets. `delivered` means the adapter accepted the send, not that a user read it.

## Capability

The daemon advertises `channel_delivery` when it supports the contracts and routes. This is protocol support, not a live-health assertion for any worker or adapter.
