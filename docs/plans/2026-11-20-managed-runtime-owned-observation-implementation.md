# Managed Runtime-Owned Background Observation — Implementation Plan & Handoff (Phase 3b)

[English](2026-11-20-managed-runtime-owned-observation-implementation.md) | [简体中文](2026-11-20-managed-runtime-owned-observation-implementation.zh-CN.md)

Status: in progress. Canonical design: [`docs/design/2026-11-19-managed-runtime-owned-observation.md`](../design/2026-11-19-managed-runtime-owned-observation.md) (PR #17912). This plan tracks the implementation against design §9's four slices and records exactly what has landed, what remains, and the contracts each remaining step must preserve. Continue in a fresh session per slice (do not resume a large transcript).

## Landed (verified, committed)

Commit `f577250f41` — `feat(managed-agent): worker-owned background capture and delivery outbox (Phase 3b slice 1)`. Six files. This is the foundational vertical core of Slice 1: the worker-owned capture, the delivery outbox, the resident Harness applier, generation-fenced publisher replacement, and held mode on push failure.

Files:

- `packages/core/src/managed-runtime/managed-delivery-entry.ts` (new): the `managed-delivery/1` entry contract — `output` / `observation` / `terminal` kinds, per-run `deliverySeq`, entry-carried resources with `published` (segment content) vs `referenced` (page/manifest/observation/notification) shapes, and a strict parser. Request limit 512 KiB.
- `packages/core/src/managed-runtime/local-shell-stream-capture.ts`: additive options `segmentBytes` (default 1 MiB), `segmentsPerPage` (default 512), `onRevision(ref)` hook fired after every manifest revision; new `flushPartial(stream)` for idle flush. Defaults preserve the foreground lane byte-for-byte.
- `packages/cli/src/serve/managed-background-delivery.ts` (new): `WorkerDeliveryResourceStore` (local ref computation + insertion-order `since(marker)`), `BackgroundDeliveryRun` (ordered outbox, byte budget with async room gate → pipe backpressure, reserved terminal slot, `appliedThrough`/`stagedThrough`, attached/held push loop), `WorkerBackgroundCaptureSink` (256 KiB segments, 1024/page, idle flush, output/terminal entries), `WorkerMonitorPolicy` (line split + debounce/idle/maxEvents, worker-assigned sequence, notification resources built locally).
- `packages/cli/src/serve/managed-shell-publisher.ts`: registry constructor takes `{ enabled, workspaceId }`; registration accepts a same-or-newer `writerGeneration` (older → 409); `prepare` routes background+capability to `prepareWorkerOwned` (computes the deterministic `captureId` locally); `accept` returns the terminal receipt for worker runs.
- `packages/cli/src/serve/hosted-shell-publisher.ts`: `deliver` operation + `applyDelivery`/`applyDeliveryEntry` — publishes carried resources idempotently, advances `outputRef`, applies observations, settles the record exactly as `finalizeBackground` does; per-run `appliedThrough` watermark; contiguity enforced.
- `packages/cli/src/serve/managed-background-delivery.test.ts` (new): capture→outbox→applier→settle, idempotent re-delivery, generation fencing.

Verification (all green): new suite 3/3; `managed-shell-publisher.test.ts` + `hosted-shell-publisher.test.ts` 54/54; `hosted-shell-publisher.background.test.ts` 26/26; core `local-shell-stream-capture.test.ts` 13/13. Legacy lanes are unchanged when the capability is off (registry defaults to `enabled:false`).

### Key contracts already pinned

- `captureId = sha256(JSON.stringify([sessionKey, executionCallId, bindingGeneration])).slice(0,32)`, `sessionKey = {tenantId, workspaceId, sessionId}`. The worker computes it from `capture.tenantId/sessionId` + `observation.workspaceId`; the applier's admission recomputes the same value.
- Segment content resource ID = `sha256(JSON.stringify([captureId, streamId, ordinal]))`; seal uses `'seal'`. `ResourceToolResultSegmentStore` is reused verbatim over the worker-local resource store, so segment/seal behavior is identical.
- An entry carries every resource introduced since the previous entry (`WorkerDeliveryResourceStore.since(marker)`); the manifest revision's `onRevision` hook snapshots them. Republish under same ID+digest is a no-op.
- A failed push is never `failCapture()`; it switches to held and keeps entries. The terminal entry bypasses the byte budget so a forced stop always produces exit proof.

## Slice 1 — remaining

1. **Wire the Monitor policy into the worker monitor path.** `WorkerMonitorPolicy` exists but is not yet attached. The executor's monitor start (`managed-runtime-tool-executor.ts`, monitor lane ~1713) and `ManagedMonitorWatcher` must, when the capability is on, construct the policy beside the watcher, pass `startSequence` from the committed `monitor_run.observationSequence` watermark, and route stdout chunks to `policy.onChunk`. The Harness `HostedMonitorLoop` becomes applier-only for observation entries (its timers/Broker stop round trip go away in capability mode). The terminal entry's `monitorStopReason` must reflect the policy's quota/idle/natural reason.
2. **Advertise the capability and enable the registry in production.** Add `runtime-observation/1` to the worker capabilities (attestation contract `managed-runtime-attestation-contract.ts` + Java `ManagedContextProtocol`/`RuntimeAttestation` capability set), and construct `ManagedShellPublisherRegistry` with `{ enabled: <capability>, workspaceId: boot.workspaceId }` in `managed-context-worker.ts`. Gate per design §4.11: the worker-owned capture is gated only by the worker capability, not the server setting.
3. **Characterization tests.** Prove the worker-owned capture publishes segment/page/manifest objects byte-for-byte equivalent to the Harness capture (except segment size and page capacity), and the same final Artifact (design §10 "Capture equivalence"). Add a Harness-restart test: continuous background output, kill+reload Harness, one capture, no `producer_lost`, every byte exactly once, valid manifest chain.

## Slice 2 — Broker staging (untouched)

Design §4.5–§4.7. Touchpoints mapped:

- **Schema**: add `ma_runtime_stage` keyed by `(execution_call_id, delivery_seq)` to `persistence/src/main/resources/db/managed-schema/V1__managed_schema.sql`; register it in `contracts/.../schema/ManagedSchemaContract.TABLES`; update `verification/.../managedschema/ManagedSchemaTest` (BUSINESS_KEYS / entity exclusion sets). Row carries kind, binding+generation, entry metadata, wake-worthy flag.
- **Resource owner kind**: add `RUNTIME_STAGE` ref owner kind; staging writes `REFERENCED` resources under it and segment bytes in the `PUBLISHED` shape (`persistence/.../JournalResourceWrites.java:117,159`). Stage refs ride with their entry; deleted only after the entry's journal commit.
- **Transport**: new `observation-pull` operation on `RuntimeTransport`/`HttpRuntimeTransport` (lease-fenced, long poll, `ackThrough`), route in `ManagedContextProtocol`; worker answers `attached` with no entries when attached. Single-puller claim per binding (reuse the Broker operation-claim shape); worker keeps only the newest long poll per run.
- **Staging transaction**: one transaction writes carried resources + one `ma_runtime_stage` row per entry + (for wake-worthy entries) pulls `wake_retry_at` to now and sets `is_wake_pending=1` + settles the `ma_tool_execution` row from terminal evidence (`RuntimeExecutionRecovery.settleUnprovenBackgroundRows` rules). Acknowledge only after commit.
- **Manifest-closure walk (TS)**: `http-managed-session-store.ts:3993` `isReferenceContainer` gains `managed-tool-result-manifest`, so a draining Harness commits the manifest with its pages' nested `JOURNAL` refs collected server-side (no in-memory staged set).
- **Wake hint fence**: seal (`JournalWriterLifecycle.java:421`) writes `is_wake_pending = journalPending OR EXISTS(uncommitted wake-worthy staged row)` and keeps `wake_retry_at ≤ now` when such a row exists; backstop `recordPending(candidate,false)` (`JdbcWakeRecoveryStore.java:314`) clears only when no wake-worthy staged row exists. Staged candidate skips journal proof, loads via passive `recoverForWake`.
- **Re-attach-then-drain (TS)**: on load, register publisher first; worker reports `stagedThrough` per run; Harness drains staged entries in order then accepts pushes from `stagedThrough+1`; acknowledge deletes rows up to applied point. Durable adoption for publisher/detach/drain/cancel routes (adopt from durable records like `reclaimParkedMcp`, `RuntimeBrokerService.java:554`), surviving Broker restart/replica.

## Slice 3 — background suspension (untouched)

Design §4.8–§4.11. Touchpoints mapped:

- **Eligibility**: exempt the background terms of `suspensionLiveWork` (`hosted-harness-session.ts:5059,5063,5075-5088`) run-by-run via `hasBackgroundHoldEvidence` (`hosted-turn-cleanup.ts:242`); require the binding worker to advertise `runtime-observation/1` at admission (never teardown). Everything else still blocks.
- **Seal certificate**: suspension seal `wake` gains `backgroundHeld:true`; new head column `wake_seal_background` written under the writer fence/revision check; cleared on any writer acquisition. Recovery `ready` arm accepts unsettled `runtime_state`/`HOSTED_CLEANUP` only when `wake_seal_revision = journal_revision AND wake_seal_background`. `HostedCleanupRetryCoordinator.java:128` skips debts on such a head.
- **Probe-only release**: both suspension drain paths (`hosted-harness-session.ts:5170,5172`) run probe-only; `held` counts as success only for a confirmed background execution of the current binding+generation; foreground debt still fails. Keep the mount for background-only holds (`RuntimeExecutionRecovery.java:370-394` tolerance).
- **Detach with final ack**: publisher step waits in-flight pushes, detaches through the Broker carrying final `appliedThrough`; Broker deletes staged rows up to that point in the same transaction; worker switches to held.
- **Reclamation guard**: `reclaimParkedMcp` checks active background executions before `transport.reclaimMcp` and refuses without closing connections (`RuntimeBrokerService.java:587`); remove the incidental settlement sweep.
- **Drain-only exit wake**: terminal entry marks wake; load drains staging and settles run with no input committed (no model turn); re-seal/suspend if nothing else pending.
- **Delete cleanup**: delete/retirement removes `ma_runtime_stage` rows + `RUNTIME_STAGE` refs (`ManagedSessionRetirementStore`).
- **Rollout gates**: setting `qwen.managed-agent.runtime-observation.enabled` (default off) advertised as `runtimeObservation` in the writer grant beside `wakeDispatch`; worker capability; per-run evidence. Pull runs regardless of the setting once suspended.

## Slice 4 — acceptance & measurement (untouched)

Design §7, §10. Real-process + MySQL 8.4 fault matrix (H2 alone is not acceptance): capture equivalence, Harness restart, idempotent delivery, re-attach/drain with in-flight pull, first observation while suspended (transport off, empty journal), detach→seal window, monitor policy stops while suspended, quiet exit settlement within one pull interval + one silent load, forced stop under backpressure, bounds/watermark wake, suspension eligibility matrix, reclamation refusal, worker loss while suspended, fencing across Broker restart/replica, deleting a suspended Session. Measurement sets the pull wait, staged-bytes watermark, hard cap, and outbox budgets (design §11 open questions).

## Verification commands

```bash
npm run build && npm run typecheck
cd packages/cli && npx vitest run src/serve/managed-background-delivery.test.ts
cd packages/cli && npx vitest run src/serve/hosted-shell-publisher.background.test.ts
cd packages/core && npx vitest run src/managed-runtime/local-shell-stream-capture.test.ts
# Java (managed-agent-server): follow packages/managed-agent-server/AGENTS.md Maven verification.
```

## Notes / gotchas

- The applier requires the capture registered via `HostedShellPublisher.register()` even in worker mode (the prepare RPC is skipped, but `applyDelivery` looks up the registered capture). Production registers it at background admission in `hosted-workspace-tool-turn.ts`.
- Test resource stores must land bytes in the session resource root layout (`<runtimeBaseDir>/resources/<sessionId>/<kind>/<resourceId>`) and read via `session.resources`, or the authority's `verifyExtensionResources` refuses the record refs.
- `LocalManagedSessionResourceStore.publish` always generates a UUID; a `DurableToolResultResourceStore` that honors client-chosen IDs must write the layout directly (see the test double).
- Do not rebase/force-push an active PR in this repo; merge `origin/main` instead.
