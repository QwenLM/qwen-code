# Scheduled Channel Delivery Runtime Plan

> Base: `origin/main` (`053f82275`). This plan builds on the already-landed
> branch commits for proactive Channel delivery IPC and admitted durable-task
> targets. It does not copy code from PR #7109.

## Goal

After a durable scheduled prompt finishes successfully, persist its final
assistant text as delivery work, let the daemon send it through the selected
Channel worker, and retry only that send after transient failure or restart.

## Boundary

- The session child executes the scheduled prompt and owns final-text capture.
- A per-workspace delivery outbox is the cross-process handoff.
- The daemon owns retry timing and Channel-worker delivery.
- The Channel worker only performs transport; it never runs the Agent prompt.
- No selected-target picker or #7109 registry implementation is added here.

### Task 1: Durable delivery outbox

Status: implemented.

Files:

- Add `packages/core/src/services/scheduled-delivery-outbox.ts`
- Add `packages/core/src/services/scheduled-delivery-outbox.test.ts`
- Export the public types/helpers from `packages/core/src/index.ts`

Contract:

- One record per `deliveryId = taskId:firedAt`.
- Store workspace-local target snapshot, final text, attempt count, next retry,
  sanitized last error, and state (`pending`, `sending`, `retryable`,
  `delivered`, `failed`).
- Cross-process read-modify-write uses a file lock plus atomic replace.
- Enqueue is idempotent; the same fire cannot create duplicate records.
- Claim leases recover stale `sending` records after daemon restart.
- Bound file and record sizes; reject malformed/corrupt state instead of
  silently replacing it.

Verification:

- RED tests for idempotent enqueue, claim, success, transient failure, permanent
  failure, stale-lease recovery, malformed file, and cross-process-safe update.
- GREEN focused Vitest run in `packages/core`.

### Task 2: Correlate a cron fire with its final answer

Status: implemented with `firedAt` as the stable run identity.

Files:

- Modify `packages/core/src/services/cronScheduler.ts`
- Modify `packages/core/src/services/cronScheduler.test.ts`
- Modify `packages/cli/src/acp-integration/session/Session.ts`
- Modify `packages/cli/src/acp-integration/session/Session.test.ts`

Contract:

- `CronJob` carries the persisted optional delivery snapshot.
- `CronQueueItem` carries `taskId`, the scheduler's minute stamp, and delivery.
- Capture only non-thought text from the final model turn after tool calls.
- Enqueue only after a clean, non-cancelled, non-empty completion.
- An outbox-write failure is logged and visible, but never reruns the Agent.

Verification:

- RED/GREEN scheduler round-trip tests for delivery metadata.
- RED/GREEN Session tests proving a successful cron result enqueues once and an
  error/cancel does not enqueue.

### Task 3: Daemon outbox dispatcher

Status: implemented.

Files:

- Add `packages/cli/src/serve/scheduled-delivery-dispatcher.ts`
- Add `packages/cli/src/serve/scheduled-delivery-dispatcher.test.ts`
- Extend `packages/cli/src/serve/channel-worker-manager.ts`
- Extend manager tests
- Wire lifecycle in `packages/cli/src/serve/run-qwen-serve.ts`

Contract:

- Poll every workspace outbox with a bounded interval and one active claim per
  workspace.
- Route through the exact workspace/channel group and existing
  `channel_delivery` IPC.
- Mark success only after the worker adapter resolves.
- Classify unavailable/timeout/rate-limit/network as retryable with bounded
  exponential backoff; invalid/disabled/rejected targets are permanent.
- Shutdown stops new claims and lets the current claim settle within a bound.

Verification:

- RED/GREEN dispatcher tests for success, retry, permanent failure, no Agent
  execution, restart recovery, workspace routing, and shutdown.

### Task 4: Capability and status projection

Status: capability and public client types implemented; run-history delivery
projection remains follow-up work. Selected-target admission remains off until
#7109 supplies the observed-target provider.

Files:

- Extend scheduled-task view/run history with sanitized delivery state.
- Turn on `scheduled_task_channel_delivery` only when admission and dispatcher
  are both installed.
- Update design and E2E documents.

Verification:

- REST tests for default-off and fully-wired capability states.
- End-to-end test: create admitted task, fire once, observe one group send,
  restart around a transient failure, then observe delivery retry without a
  second prompt execution.
