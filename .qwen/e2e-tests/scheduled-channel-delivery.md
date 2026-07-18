# Scheduled Channel Delivery E2E Plan

## Scope

Verify that a daemon-owned scheduled task can deliver an already-produced
final response through the Channel worker without starting another Agent turn.
The implementation includes task persistence, `/loop` integration, final-turn
capture, durable outbox recovery, daemon-to-worker transport, and exact fresh
target admission from the merged #7109 observed-contact registry. Web Shell
loads those observations into one searchable input whose choices cover direct
chats, groups, and group topics; an exact observed ID can also be pasted.

## 2026-07-18 local E2E result

- **IM `/loop`: passed.** Two group-created tasks and one direct-chat-created
  task fired through the daemon scheduler, produced the exact marker, reached
  the delivery outbox, and were acknowledged as delivered. The first direct
  run exposed that DingTalk's reply conversation ID is not a stable proactive
  recipient ID; after retaining the adapter-provided direct delivery ID, the
  direct path passed as well.
- **Hosted/headless client: passed.** A task created through the
  workspace-qualified scheduled-tasks REST route fired and delivered to its
  selected observed group. The client owned no timer or Channel credential.
- **Web Shell: passed for observed direct and group targets.** The real daemon
  exposed one direct chat and two groups. The browser picker rendered all
  three, accepted an exact direct ID, accepted a selected group option, created
  both tasks, and rendered the correct target kind and ID on each task card.
  The two future-dated test tasks were deleted after verification.
- **Group topic: component E2E only.** The current real observation registry
  contained no topic, so the mapper/form/card path is covered by browser-level
  component tests without fabricating a platform observation.
- **Compatibility: passed.** Existing tasks without `delivery` remain valid;
  IM, Web Shell, and headless clients all converge on the daemon-owned durable
  task store and scheduler. CLI/headless integrations use the same qualified
  REST contract rather than owning a second timer.

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
4. Verify the merged #7109 provider exposes only fresh observed targets and
   direct-message entries retain a routable chat ID distinct from user identity.
5. Through the Web Shell picker, create direct and group tasks, verify their
   stored targets and card presentation, then remove the future-dated fixtures.
6. Verify a hosted client uses the workspace-qualified REST route and owns no
   local timer, task store, daemon token, or Channel credential.
7. Stop the daemon before a deadline; verify the documented deployment
   boundary (no exact fire without an external wake-up) and catch-up behavior
   after restart.
