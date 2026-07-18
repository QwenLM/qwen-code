# Scheduled Channel Delivery for Durable Tasks

Status: Draft

Related: [#7152](https://github.com/QwenLM/qwen-code/issues/7152), [#7109](https://github.com/QwenLM/qwen-code/pull/7109), [#7103](https://github.com/QwenLM/qwen-code/issues/7103)

## Problem

Daemon-managed durable scheduled tasks can run unattended and retain their own
session history, but they cannot deliver a completed run to a selected IM
conversation. Channel loops can already deliver to the chat where the loop was
created, but that path has its own scheduler and store and cannot target a chat
selected by an authenticated daemon client.

#7109 adds a workspace-scoped API for recently observed users, groups, and
topics. It intentionally stops at discovery. A client can present a destination
picker, but there is no durable task contract or runtime path that turns the
selected identifier into reliable proactive delivery.

## Goals

- Let a daemon-managed durable task carry one optional Channel delivery target.
- Support both an originating IM conversation and a destination selected from
  #7109's observed-contacts API.
- Deliver the final response without another Agent turn.
- Keep task execution and message delivery as separate, observable states.
- Retry delivery without rerunning the scheduled work.
- Reuse existing Channel adapters and their proactive formatting and transport.
- Keep credentials, webhook URLs, and secrets out of scheduled-task storage.
- Preserve workspace ownership and daemon authentication boundaries.

## Non-goals

- Platform directory or authoritative group-membership lookup.
- Immediate detection of deleted chats, removed bots, or departed users.
- Multiple delivery targets per task in the first version.
- Streaming intermediate output to IM. Only the final response is delivered.
- Model-controlled automatic delivery through a `send_to_group` tool.
- Changing existing Channel webhook contracts.
- Migrating standalone `qwen channel start` loops in the first version.
- Exactly-once delivery across platform APIs that do not support idempotency.

## Existing boundaries

### Durable scheduled tasks

The daemon scheduled-task surface persists `DurableCronTask` records under the
workspace's Qwen runtime directory. A client-created task owns a dedicated
session, and the session transcript is its execution history. The scheduler
currently records that a fire was dispatched; it does not expose a durable,
correlated final-response delivery event.

### Channel workers

The daemon process owns scheduled sessions, while a daemon-managed Channel
worker owns the platform adapter, credentials, target validation, formatting,
and proactive transport. The parent and worker already use request/reply IPC
for webhook-triggered Channel work, but webhook handling starts an Agent turn
and is therefore the wrong contract for delivering an already-produced result.

### Observed contacts

#7109 exposes complete `channelName`, user ID, group ID, and topic ID values for
recent accepted inbound conversations. The registry is bounded and freshness
filtered. It is a discovery source, not a permanent routing database.

## Considered approaches

### 1. Extend durable tasks and add internal delivery IPC (recommended)

Persist the selected target with `DurableCronTask`, correlate a scheduled fire
with its terminal session turn, and send the final response to the Channel
worker through a dedicated internal delivery request.

This keeps one daemon task-management model, separates execution from
transport, and supports targets selected outside the current IM conversation.
It requires a new final-result correlation path and a small durable delivery
state machine.

### 2. Expose the Channel loop store through daemon APIs

Let authenticated clients create `ChannelLoop` records directly. This reuses
the existing `runLoopPrompt()` and `pushProactive()` path, but leaves two task
stores, two schedulers, and two management surfaces. The Channel worker also
has to remain the scheduler owner. This is useful as compatibility behavior,
not as the daemon's long-term task model.

### 3. Call the existing webhook endpoint after a run

The webhook endpoint authenticates an external event, resolves a configured
target, and starts a new unattended Agent turn. Calling it with a scheduled
result would run the Agent twice and make a delivery retry capable of repeating
the original work. It also introduces webhook secrets where the daemon already
has an authenticated internal boundary. This approach is rejected.

## Proposed task contract

The first version supports zero or one destination:

```ts
interface ScheduledChannelDeliveryTarget {
  channelName: string;
  kind: 'direct' | 'group';
  chatId: string;
  threadId?: string;
  label?: string;
}

interface DurableCronTask {
  // Existing fields omitted.
  delivery?: {
    type: 'channel';
    target: ScheduledChannelDeliveryTarget;
    when: 'success';
  };
}
```

`channelName`, `kind`, `chatId`, and optional `threadId` are the routing
snapshot. `label` is an optional sanitized display snapshot and never
participates in routing or authorization. No adapter credential is copied into
the task.

The task stores a snapshot rather than an observed-contact reference. A
selected observation can expire or be evicted, but that must not silently
rewrite or erase an existing schedule. At delivery time the runtime validates
the current Channel configuration and worker state, not continued presence in
the observation registry.

### Destination admission

There are two trusted admission paths:

1. **Current IM chat:** an accepted inbound `Envelope` supplies the target
   after the existing direct/group, mention, sender, and pairing gates.
2. **Daemon API:** an authenticated scheduled-task create or update request
   supplies a target that must exactly match a fresh entry returned by the
   workspace's observed-contacts registry.

The second check prevents an authenticated UI request from turning arbitrary
platform identifiers into an unreviewed outbound route. Admission is checked
when the target is created or replaced. Delivery does not require the
observation to remain fresh afterward.

## Run and delivery model

Each scheduled fire receives a stable `runId`. The run context follows the
prompt into the bound session so the daemon can correlate the terminal turn
with its originating task and fire.

The persisted run view distinguishes execution from delivery:

```ts
interface ScheduledTaskRunDelivery {
  status: 'pending' | 'sending' | 'succeeded' | 'failed' | 'skipped';
  attempts: number;
  lastAttemptAt?: number;
  nextAttemptAt?: number;
  lastError?: string;
}

interface ScheduledTaskRun {
  runId: string;
  executionStatus: 'queued' | 'running' | 'succeeded' | 'failed';
  delivery?: ScheduledTaskRunDelivery;
}
```

A successful Agent turn with a non-empty final response creates a pending
delivery. An execution failure, cancellation, or empty final response marks
delivery as skipped. Delivery failure never changes `executionStatus` from
`succeeded` to `failed`.

The run captures its delivery target when the fire starts:

- editing a task target affects future runs only;
- disabling a task stops future fires but does not cancel an already-running
  fire or its delivery;
- deleting a task cancels queued retries that have not started;
- an in-flight platform request cannot be recalled.

## Final-response correlation

The scheduler must not mark a delivery-ready result at prompt enqueue time.
Instead, it creates `runId`, attaches `{taskId, runId}` to the scheduled prompt
dispatch, and records terminal state when the bound session turn completes.

On successful completion, the daemon records a stable reference to the final
assistant response in the persisted session transcript. A delivery retry reads
the final response from that reference; it does not run the prompt again and
does not ask the model to send anything.

If the transcript entry cannot be recovered after a restart, the delivery is
marked failed with a sanitized error. The scheduler must not reconstruct an
answer by starting another Agent turn.

### Durable delivery outbox

Non-terminal deliveries live in a workspace-scoped outbox separate from the
bounded task run-history ring. Each entry stores the delivery and target
snapshots, transcript response reference, attempt state, and next retry time.
It does not duplicate the response text.

The outbox is authoritative while a delivery is pending or sending. Terminal
status is copied into the task's bounded run history, then the outbox entry is
removed. This prevents a frequent task from evicting a retryable delivery when
its run-history ring reaches its cap.

## Internal delivery contract

The parent daemon sends a dedicated request to the Channel worker supervisor:

```ts
interface ChannelDeliveryRequest {
  deliveryId: string;
  taskId: string;
  runId: string;
  channelName: string;
  target: {
    kind: 'direct' | 'group';
    chatId: string;
    threadId?: string;
  };
  text: string;
}
```

This is not an HTTP webhook and is not exposed as a model tool. The worker:

1. resolves the configured Channel instance by `channelName`;
2. rejects a disabled, removed, or unsupported target;
3. converts the delivery target to the adapter's proactive target shape;
4. calls a Channel-level proactive delivery method;
5. returns a structured success or failure result to the parent.

The public Channel-level method should wrap the existing protected
`pushProactive()` behavior so adapter formatting, chunking, access-token
handling, and platform-specific response validation remain in one place.

If the Channel is enabled but its worker is not running, the supervisor starts
it before delivery. An explicitly disabled or removed Channel is a
permanent target failure and must not be resurrected implicitly.

## Retry and idempotency

`deliveryId` is derived from `taskId`, `runId`, and a stable hash of the target.
The daemon persists delivery state before the first send.

The first version makes at most four attempts: the initial attempt followed by
retries with base delays of 30 seconds, 2 minutes, and 10 minutes plus up to 20%
jitter. Retries are limited to transient worker, network, rate-limit, and 5xx
failures. Invalid targets, disabled Channels, unsupported target kinds,
authentication failures, and platform-declared permanent recipient failures
fail immediately.

Where a platform supports an idempotency key, the adapter should use
`deliveryId`. Without platform support, a timeout after the remote platform
accepted a message is ambiguous and a retry can duplicate delivery. The run
history must expose that limitation rather than claiming exactly-once delivery.

Restart recovery scans persisted pending or retryable delivery records and
resumes them without rerunning the scheduled prompt.

## API and capability surface

Scheduled-task create, read, and update APIs accept and return `delivery`.
Update supports replacing or clearing the target. Validation errors distinguish
an unobserved target, unsupported target kind, missing Channel configuration,
and malformed routing fields.

A new `scheduled_task_channel_delivery` capability gates the field. Clients
should require both this capability and
`workspace_channel_observed_contacts` before showing an observed-target picker.
The delivery capability can still be useful for an origin-chat flow when the
picker capability is unavailable.

Run history returns delivery status, attempt count, timestamps, and a sanitized
error code/message. It does not return platform credentials or raw upstream
response bodies.

## IM-originated task creation and compatibility

The user-facing `channel_loop_create` tool remains the way a Channel user asks
for a scheduled task in the current conversation.

For daemon-managed Channels, its handler forwards creation to the parent daemon
and persists a durable task with the accepted current-chat target. This makes
the task visible through the daemon scheduled-task API and uses the same run
and delivery state machine as a client-created task.

Standalone `qwen channel start` keeps the existing `ChannelLoopStore` and
`ChannelLoopScheduler`. A daemon worker that advertises
`scheduled_task_channel_delivery` uses only the unified durable path for new
loops. An older daemon or worker keeps the old loop path. No creation request
writes the same schedule to both stores.

## End-to-end flow

```text
accepted IM Envelope                 authenticated daemon client
         |                                      |
         | current-chat target                  | observed-contacts selection
         +------------------+-------------------+
                            |
                            v
             durable task + admitted target snapshot
                            |
                            v
                 CronScheduler creates runId
                            |
                            v
             bound session completes final response
                            |
                            v
                durable delivery state: pending
                            |
                            v
             daemon -> Channel worker delivery IPC
                            |
                            v
                 adapter proactive platform send
                            |
                            v
              delivery succeeded / retry / failed
```

## Error handling

- **Target was never observed:** reject task creation or target update.
- **Observation later expires:** keep the task target; do not block delivery for
  freshness alone.
- **Channel removed or disabled:** permanent delivery failure.
- **Worker crashed:** restart an enabled worker and retry within the attempt
  budget.
- **Platform rejects recipient:** permanent delivery failure with sanitized
  platform error classification.
- **Transient network/rate limit/5xx:** retry only delivery.
- **Daemon restarts after Agent success:** recover delivery from the persisted
  run and transcript reference.
- **Daemon restarts during an ambiguous send:** retry according to adapter
  idempotency support and expose possible duplication when it cannot be ruled
  out.
- **Task deleted:** cancel pending retries; do not attempt to recall an in-flight
  or already-delivered message.

## Security and privacy

- All scheduled-task mutation and read routes remain behind daemon bearer
  authentication and exact trusted-workspace resolution.
- Route admission uses only contacts observed after existing Channel gates.
- Target identifiers are returned only on authenticated APIs and are not placed
  in routine daemon logs.
- Delivery errors use stable codes and sanitized messages; raw platform bodies
  remain adapter-local diagnostics.
- Credentials stay in Channel configuration and worker memory.
- The persisted target is the minimum routing snapshot required for future
  delivery. No message payload or observed membership list is copied into the
  task.

## Test strategy

### Task contract and routes

- Create, read, update, clear, and persist a single delivery target.
- Reject malformed, cross-workspace, unobserved, and unsupported targets.
- Preserve a target after the observation freshness window expires.
- Keep existing tasks without `delivery` backward compatible.

### Run correlation

- Correlate each scheduled fire with exactly one terminal bound-session turn.
- Mark execution and delivery states independently.
- Use the target snapshot captured at run start when the task is edited.
- Never create a delivery for failed, cancelled, or empty-response runs.

### Worker routing

- Route to the named configured Channel only.
- Reuse proactive adapter delivery without another Agent turn.
- Start an enabled stopped worker, but never resurrect a disabled Channel.
- Cover direct, group, and supported topic targets for each adapter.

### Retry and recovery

- Retry only transient delivery failures with the documented attempt budget.
- Do not rerun the scheduled prompt during a retry.
- Recover pending delivery after daemon restart.
- Cancel queued retries when the task is deleted.
- Expose ambiguous non-idempotent sends without claiming exactly once.

### Compatibility

- Existing webhook tests remain unchanged.
- Existing standalone Channel loops continue to work.
- Tasks without a delivery target preserve current scheduling behavior.

## Rollout

1. Land #7109 and gate the picker on its capability.
2. Add the durable task field, admission validation, run correlation, and
   delivery state view behind `scheduled_task_channel_delivery`.
3. Add parent-to-worker delivery IPC and adapter coverage.
4. Enable selected-target delivery for authenticated daemon clients.
5. Forward daemon-managed `channel_loop_create` to the unified durable path.
6. Keep standalone loop behavior unchanged and remove daemon compatibility
   code only after migrated tasks are accounted for.

## Required implementation boundaries

- `DurableCronTask` is the single schedule source of truth for daemon-managed
  tasks and loops.
- The non-terminal delivery outbox is workspace-scoped and separate from the
  bounded run-history ring.
- `scheduled_task_channel_delivery` is the client capability gate.
- Parent-to-worker delivery uses a dedicated `channel_delivery` request/reply
  message and never reuses the webhook task contract.
- Target admission happens when a target is created or replaced.
- A terminal session turn, not prompt enqueue, creates delivery work.
- Retry invokes only adapter-owned proactive transport and never Agent work.
