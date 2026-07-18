# Scheduled Channel Delivery E2E Plan

## Scope

Verify that a daemon-owned scheduled task can deliver an already-produced
final response through the Channel worker without starting another Agent turn.
The current implementation phase covers only the daemon-to-worker transport;
task persistence, final-turn correlation, and UI target selection are added in
later phases of the design.

## Baseline

1. Run the globally installed `qwen serve` with one configured Channel.
2. Confirm the current daemon scheduled-task API can create and run a task.
3. Confirm the task result remains in its task session and is not proactively
   sent to a selected IM conversation.
4. Confirm daemon-managed Channel `/loop` is not yet backed by the durable task
   API. Record this as the expected pre-change gap, not a test failure.

## Local transport verification

1. Build the repository and start local `qwen serve` with the same Channel
   configuration and an isolated `QWEN_RUNTIME_DIR`.
2. Resolve a test conversation already accepted by the Channel configuration.
3. Invoke the daemon's internal delivery test seam with a unique `deliveryId`,
   the configured `channelName`, target snapshot, and fixed text.
4. Verify exactly one message reaches the selected conversation with the
   adapter's normal proactive formatting.
5. Verify the parent request completes only after the adapter send completes.
6. Verify no new Agent session, user prompt, webhook task, or model call is
   created by delivery.

## Negative cases

- Unknown or stopped worker returns `channel_worker_unavailable`.
- Mismatched Channel/target or unsupported target returns
  `channel_delivery_invalid` before a platform call.
- Adapter/platform send failure returns `channel_delivery_failed` with a
  sanitized message.
- Expired IPC returns `channel_delivery_timeout`.
- A saturated worker returns `channel_delivery_queue_full`.
- Worker shutdown waits for an in-flight delivery only for the bounded drain
  window and never starts another Agent turn.

## Later full-flow verification

After durable task integration lands:

1. Create a task through IM `/loop`; verify it appears in the workspace
   scheduled-task API and uses the original shared Channel session.
2. Create a task through Web Shell/hosted BFF with an admitted observed target;
   verify it uses an owned task session.
3. Let both tasks fire and verify execution status and delivery status are
   independent.
4. Force a transient platform error; verify only delivery retries and the Agent
   prompt runs once.
5. Restart the daemon after Agent completion but before delivery; verify outbox
   recovery sends the stored final response reference.
6. Stop the daemon before a deadline; verify the documented deployment
   boundary (no exact fire without an external wake-up) and catch-up behavior
   after restart.
