# Scheduled Channel Delivery E2E Plan

## Scope

Verify that a daemon-owned scheduled task can deliver an already-produced
final response through the Channel worker without starting another Agent turn.
The implementation includes task persistence, `/loop` integration, final-turn
capture, durable outbox recovery, and daemon-to-worker transport. Selecting an
arbitrary observed group through Web Shell remains gated on #7109 integration.

## Baseline

1. Build current `main` plus this branch and start `qwen serve` with one
   configured Channel and an isolated `QWEN_RUNTIME_DIR`.
2. Confirm the Channel worker and workspace runtime are healthy.
3. From an accepted IM conversation, create `/loop add` with a near-future cron.
4. Confirm the task appears in the workspace scheduled-task API with a shared
   session binding and the exact current-chat delivery target.

## Local transport verification

1. Let the loop fire and record the Agent prompt count.
2. Verify one outbox record is created only after a clean final answer.
3. Verify exactly one message reaches the originating conversation using the
   adapter's proactive formatting.
4. Verify the worker acknowledgement occurs only after the adapter resolves.
5. Verify delivery creates no new Agent session, prompt, webhook task, or model
   call.
6. Verify `/loop list`, `/loop show`, and `/loop cancel` operate on the durable
   task while the shared conversation session remains available.

## Negative cases

- Unknown or stopped worker retries as `channel_worker_unavailable`.
- Mismatched Channel/target or unsupported target returns
  `channel_delivery_invalid` before a platform call.
- Adapter/platform send failure returns `channel_delivery_failed` with a
  sanitized message.
- Expired IPC returns `channel_delivery_timeout`.
- A saturated worker returns `channel_delivery_queue_full`.
- Worker shutdown waits for an in-flight delivery only for the bounded drain
  window and never starts another Agent turn.

## Recovery and client compatibility

1. Force a transient platform error; verify only delivery retries and the Agent
   prompt runs once.
2. Restart the daemon after Agent completion but before delivery; verify outbox
   recovery sends the stored final text.
3. Verify Web Shell can read tasks containing additive `delivery` and
   `sessionBinding` fields and still edits other fields without clearing them.
4. After #7109 lands, wire its observed-target admission provider, create a task
   through Web Shell/hosted BFF, and verify an owned task session delivers to
   the selected group.
5. Verify a hosted client uses the workspace-qualified REST route and owns no
   local timer, task store, daemon token, or Channel credential.
6. Stop the daemon before a deadline; verify the documented deployment
   boundary (no exact fire without an external wake-up) and catch-up behavior
   after restart.
