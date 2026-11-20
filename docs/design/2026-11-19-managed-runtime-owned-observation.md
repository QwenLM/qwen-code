# Managed Runtime-Owned Background Observation (Phase 3b)

[English](2026-11-19-managed-runtime-owned-observation.md) | [简体中文](2026-11-19-managed-runtime-owned-observation.zh-CN.md)

Status: proposal, pre-implementation. Date: 2026-11-19; revised 2026-11-20 after design review and code-level verification against the merged 3a implementation. This is the separate 3b design that the [Phase 3 control-plane wake design](2026-11-19-managed-control-plane-wake.md) (#17805) calls for in §2 and §4.4–§4.6, checked against `main` at `4947118326`. It builds on 3a as amended by the [seal-time wake stamp addendum](2026-11-19-managed-control-plane-wake-seal-stamp.md) (#17869; implementation #17908). It answers parent §10 items 4–10 and replaces the parent's 3b mechanism where §12 says so. The parent's goal, its single-writer constraint (§5.3), its suspension-is-not-a-drain rule (§5.4) and its closed journal vocabulary (§5.5) are unchanged.

## 1. Problem and current state

Goal (parent §2): a Session whose only live work is a background Shell or Monitor can suspend while its processes keep running, their output stays durable, and a Monitor observation still wakes the Session to deliver its notification. Today such a Session cannot suspend, and four code facts shape what has to change. The first contradicts an assumption of the parent design.

### 1.1 The background capture lives in the Harness and cannot outlive it

The worker owns the process and its pipes, but every durable step of its output happens in the Harness:

- The worker forwards raw bytes to a loopback publisher that the Harness owns (`127.0.0.1:0` with a random bearer token, `hosted-shell-publisher.ts:185`). The descriptor reaches the worker through the Broker's `:publisher` route (`RuntimeBrokerService.java:1198`).
- The Harness feeds those bytes into a `LocalShellStreamCapture`, which buffers 1 MiB segments, publishes segments, pages and manifest revisions as Session resources, and keeps the stream's **running SHA-256** in process memory (`local-shell-stream-capture.ts:76,293`). Every manifest revision carries the digest of the whole stream so far.
- Each manifest revision is then committed to the `child_run`/`monitor_run` record (`advanceBackgroundManifest`, `hosted-shell-publisher.ts:666`).

A Node hash object cannot be exported and restored, and resource publication needs the live writer (`JournalResourceWrites.java:159`). So no other process can continue an open capture: a new Harness would have to re-read every published byte to rebuild the digest, and a suspended Session has no writer to publish with. The parent's plan to "re-open the direct publisher" on wake (§4.4) therefore cannot work as stated. Today this case never arises, because every Harness exit stops background work first: suspension refuses it (§1.3), and both close paths drain it (`hosted-harness-session.ts:9475,14723`). A Harness crash with a live worker leaves the push failing and the capture `producer_lost`.

Two more worker-side facts follow from this pipeline:

- **The capture fails permanently on publisher loss.** `RemoteShellCapture.append` turns any RPC failure into `failCapture()` (`managed-shell-publisher.ts:257-280`), after which writes are dropped and finalize reports `captureStatus: 'unavailable'`, `captureReason: 'producer_lost'`.
- **The worker cannot install a second publisher.** The worker's publisher registry answers `409 managed_runtime_identity_conflict` when a Session registers a descriptor that differs from the one it already holds (`managed-shell-publisher.ts:435-442`). A Harness reopened on the same Runtime Session therefore cannot take over delivery.

### 1.2 The Monitor's policy runs on Harness timers

`HostedMonitorLoop` runs in the Harness and owns every policy decision about a watch: it debounces lines into observations, arms the idle timeout, and enforces `maxEvents` (`hosted-monitor-loop.ts:377-414`). It also derives the notification identity at commit time, as `${monitorId}:notify:${sequence}` with `sequence = observationSequence + 1` (`hosted-monitor-notification.ts:77`, `hosted-monitor-session.ts:194-205`). After the Harness leaves, no idle timeout or quota stop fires, and a replayed observation would get a new identity.

### 1.3 What pins the Session, and what tears background work down

`suspensionLiveWork` blocks on the following terms (`hosted-harness-session.ts:5041-5091`):

- background cleanup debt (`:5059`);
- held Runtime turns (`:5063`);
- live monitor loops (`:5075-5080`);
- any non-terminal `child_run`/`monitor_run` record (`:5081-5088`).

Even if those terms were relaxed, two suspension teardown steps stop background work:

- The Runtime release drains. `releaseLeaseNow(session, false, true)` (`:5170`) calls `releaseHeldRuntime` with `drain = true`. It also treats any outcome other than `released`/`deferred` as a failure (`:11459`), so a verified background `held` fails the teardown.
- The cleanup retry drains too: `retryHostedCleanup(session, broker, true)` (`:5172`).

The owner close then asks for the mount back, and `releaseMountAfterSweep` refuses while a background process is live (`RuntimeExecutionRecovery.java:370-394`). Finally, the Phase 2 parked-owner reclamation closes the MCP connections before that refusal (`RuntimeBrokerService.java:587-606`). A reclamation attempt on a Session with live background work therefore disconnects its MCP servers for nothing.

### 1.4 The Broker can reach the worker, not the reverse

Three facts about the Broker matter here:

- **Only the Broker calls the worker.** It does so through `RuntimeTransport`, with lease-scoped credentials (`control`, `RuntimeTransport.java:138`), and the worker never calls the Broker. The lease already fences each call to the binding generation: a superseded worker is unreachable under the current lease.
- **Background settlement is operation-triggered.** The Broker settles a background execution only when a release, a reclamation, a maintenance settle or a drain runs its sweep (`settleUnprovenBackgroundRows`, `RuntimeExecutionRecovery.java:296`). No timer runs that sweep.
- **The Session context is process-local.** The routes that drive background work resolve the Runtime Session only from this Broker process's memory (`RuntimeBindingRegistry.requireSession`, `RuntimeBindingRegistry.java:157`) and answer `404 runtime_session_not_found` when it is absent, so they do not survive a Broker restart or a request landing on another replica.

A suspended Session's `child_run` and `monitor_run` projections keep their last committed state, because `runtime_state` is projected only from journal commits (`JdbcManagedExtensionRecordStore.java:1542,1566`).

## 2. Goals and scope

**In scope.**

- A Session whose only live work is verified background Shells and Monitors may suspend. Its processes keep running under their cgroups, and its output stays durable while no Harness holds the writer.
- A Monitor observation made while the Session is suspended wakes it, and the observation and its notification are each committed exactly once.
- A background exit settles promptly while the Session is suspended: the Broker settles the execution row from the pull, and a drain-only wake commits the journal settle without running a model turn.
- A reopened Harness continues the same capture: the same output Artifact keeps growing, with no `producer_lost`.

**Unchanged.**

- One journal writer. The Broker never commits to the journal.
- The closed journal kind vocabulary.
- The foreground capture lane.
- Every active-work, recovery, stream, client-files and lifecycle term of the suspension predicate.
- Close still terminates and drains background work.

**Out of scope.**

- A maintenance writer.
- A task-view read path for staged output; the exit converges through the drain-only wake instead (§4.7).
- `EXTERNAL` storage.
- Cross-boot process attach.
- Phase 4 parked approvals.

## 3. Overview

The design moves the capture to the process whose lifetime covers the stream. It replaces the parent's three-party channel handoff with a single ordered delivery stream that has two possible consumers:

```
            ┌──────────── worker (owns process, capture, Monitor policy) ────────────┐
            │  capture → delivery outbox: entries with deliverySeq 1,2,3… per run    │
            └───────────────┬───────────────────────────────────┬───────────────────┘
          attached: push    │                                   │  held: pull (lease-fenced)
                            ▼                                   ▼
       Harness applier (resident, same host)          Broker staging (SQL + staged resources)
       publishes resources, commits records,           marks wake on observations/exits,
       acks appliedThrough                              settles execution rows, acks stagedThrough
                            ▲                                   │
                            └────── wake: drain staged entries ─┘
```

- **The worker owns the background capture.** It builds the segments, pages and manifest revisions (§4.1), runs the Monitor policy (§4.2), and turns everything that must become durable into numbered **delivery entries** (§4.3). It drops an entry only after a consumer acknowledges that the entry is durable.
- **When a Harness is attached, the worker pushes to it.** The Harness applies each entry idempotently, through the writer it already holds (§4.4).
- **When no Harness is attached, the Broker pulls.** It pulls through the lease-fenced transport and writes the entries to a staging ledger (§4.5). An observation marks the Session for a notification wake; an exit marks it for a drain-only wake and settles the execution row immediately (§4.7).
- **On load, the Harness drains staging and re-attaches** (§4.6). The worker resumes pushing after the last staged entry, so there is no three-party freeze.

## 4. Mechanism

### 4.1 The worker owns the background capture

For the background lane (`capture.background === true`, i.e. `child_run(kind=shell)` and `monitor_run`), `LocalShellStreamCapture` runs in the worker instead of the Harness. The foreground lane is unchanged, and so is its fail-stop guarantee.

- **Content stays identical, with no Store access.** The worker builds exactly the `managed-tool-result/1` objects the Harness builds today — segments, pages, and manifest revisions with the running digest — so readers see the same content. Each object gets a worker-chosen resource ID: resource IDs are client-chosen today (`randomUUID()`, `http-managed-session-store.ts:836`), so the worker can compute every complete `ManagedSessionDurableRef` without contacting the Store.
- **Small segments, flushed often.** Background segments are at most 256 KiB, so every resource the capture produces fits one delivery request: the new delivery request limit is 512 KiB, up from today's 256 KiB publisher limit (`managed-shell-publisher.ts:43`), to allow for base64. A partial segment flushes after a short idle interval, so output becomes durable without waiting for the segment to fill. Background pages carry up to the protocol's 1,024 segments per page, twice today's `SEGMENTS_PER_PAGE = 512` (`local-shell-stream-capture.ts:43`); `maxPageBytes` bounds the page resource (the segment-descriptor JSON), not the content bytes, and 1,024 descriptors fit that bound — the characterization tests pin it. The protocol limits then accommodate 65,536 ordinals × 256 KiB = 16 GiB per stream, within the 64-page bound (`managed-tool-result.ts:33-45`).
- **A worker replacement caps the capture, as H3 decided.** The old worker's unacknowledged entries and its running digest are lost. The new worker publishes a capped final revision derived from the last durable manifest: the same pages, digest and byte length, with the tail marked missing. Capping appends no bytes, so it needs no hash state.

### 4.2 The Monitor's policy runs in the worker

The worker's monitor runtime takes over the Monitor policy that runs in the Harness today:

- line splitting, including the 4 KiB partial-line cap and skipping blank lines (`fanMonitorLines`, `hosted-shell-publisher.ts:623`);
- debounce windows, with the 1 s floor (`HostedMonitorLoop`);
- the idle timeout;
- `maxEvents`.

The worker assigns the observation sequence. It continues from the committed watermark that the start or rebuild passes in, so the notification identity `${monitorId}:notify:${sequence}` is fixed when the observation is made, not when it is committed. A quota or idle stop terminates the unit in the worker, which then emits the terminal entry with its stop reason. A model-initiated stop still goes through the Broker's `monitor-stop`. The Harness keeps only an applier for observation entries; the loop's timers and its Broker stop round trip go away.

### 4.3 Delivery entries

Each background run keeps an outbox of entries, in order, numbered by a per-run `deliverySeq` that starts at 1. Every entry carries the run's `executionCallId` and its `bindingId` and generation. **Each entry carries the complete resources it introduces.** There are no standalone resource entries, so an entry and the bytes it references are always staged together and deleted together:

| Kind          | Contents                                                                                       | Effect when applied                                                   | Already applied when                    | Wakes a suspended Session                    |
| ------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------- |
| `output`      | Manifest revision `r`, with the new segment bytes, the updated page and the manifest attached  | Publish the attached resources, then advance the record's `outputRef` | The record's manifest revision is ≥ `r` | Only above the staged-bytes watermark (§4.5) |
| `observation` | Monitor sequence `s`, its lines, and the small observation and notification resources attached | `observe` with the notification input, in one transaction             | `observationSequence` is ≥ `s`          | Yes (a notification turn)                    |
| `terminal`    | Exit evidence, the stop marker or reason, the final manifest resources, and the envelope       | The record's settle, as `finalizeBackground` does today               | The record is terminal                  | Yes (drain-only, §4.7)                       |

- **Two resource shapes, as today.** Segment bytes (`managed-tool-result-content`, including the seal) keep the shape `publishToolResult` writes today: a deterministic content-addressed ID, `PUBLISHED`, `MYSQL_INLINE`, no resource ref (`JournalResourceWrites.java:117`). Pages, manifests, observation and notification resources keep the `REFERENCED` shape with resource refs. Staging reproduces both shapes server-side (§4.5). A segment staged before its manifest commit has exactly the retention exposure a resident capture's segment has today, and no new one.
- **Retransmission is idempotent at every level.** Republishing a resource under the same ID and digest is a no-op. Each entry kind is deduplicated by a watermark the record already carries, so the record body needs no new field.
- **Memory is bounded, and a forced stop always gets through.** The outbox has a byte budget per run and per worker, sized above the largest single flush batch (with 256 KiB segments, a 4–8 MiB per-run budget is the starting point; §7 settles it). When it is full, the existing pipe backpressure pauses the process (`managed-runtime-tool-executor.ts:1745-1771`) until a consumer acknowledges more entries. A `terminal` entry has a reserved slot outside the byte budget: on a public task cancel, a Monitor policy stop, or a close drain, a worker whose outbox is full drops the unqueued tail, marks the capture `broken` with the stop reason, and emits `terminal` anyway. A full outbox must never keep a stopped process from producing its exit proof, or the stop call would wait forever on a process blocked on its own output pipes.
- **The worker drops an entry only after it is durable.** That means acknowledged as applied by the Harness, or as staged by the Broker.

### 4.4 Attached delivery: the resident Harness

While a Harness is registered and reachable, the worker pushes entries to it, in order, over the existing loopback publisher. The Harness applies each entry, publishing its resources first and then committing the record, and answers `appliedThrough`: the highest sequence that is durable or already found applied. Within one Harness lifetime the sequence must be contiguous. A gap is refused, and the worker re-sends from its oldest unacknowledged entry.

- **A failed push is not a capture failure.** For the background lane, a refused or unreachable push no longer calls `failCapture()`. It switches the run to held mode, and the entries stay in the outbox.
- **A newer Harness replaces the publisher.** Registration carries the Harness's writer generation, and the worker accepts a descriptor from the same or a newer writer generation for that Session in place of the conflict answer (§1.1). An older generation is refused.
- **An explicit detach hands delivery to the Broker.** The suspension teardown detaches its publisher through the Broker, and the worker switches the run to held mode. A Harness that dies without detaching produces the same result, through the push failure.

### 4.5 Held delivery: Broker staging

The Broker pulls entries through a new transport operation, `observation-pull`, on the existing lease-fenced channel. A pull names the run and its last acknowledged sequence, and it waits at most a bounded time for entries (a long poll). A worker in attached mode answers `attached` with no entries, so pulling an attached Session costs one round trip. The Broker pulls a binding only while it has an active background execution row.

**Exactly one Broker instance pulls a binding at a time.** The puller holds a claim on the binding — the same operation-claim shape the Broker already uses — and the worker keeps only the newest long poll per run, cancelling an older one. Without this, N replicas would each pull and stage the same bytes N times.

Because the pull runs under the binding's current lease, a superseded worker is unreachable. No worker-side credential, grant or revocation record is needed, which removes parent §10 item 5.

- **Staging is written in one transaction.** The Broker writes the entry's attached resources server-side under their worker-chosen IDs: `REFERENCED` resources get a ref under a new owner kind `RUNTIME_STAGE`; segment bytes are inserted idempotently in the `PUBLISHED` shape of §4.3. In the same transaction it inserts one row per entry into a new table, `ma_runtime_stage`, keyed by `(execution_call_id, delivery_seq)`. The row carries the entry kind, the binding and generation, the entry's metadata, and whether it wakes the Session. The Broker acknowledges a pulled entry only after that transaction commits: the next pull carries `ackThrough`.
- **Staged payloads are the durable source.** The resources hold the only copy of the bytes until the journal references them. The `RUNTIME_STAGE` ref holds each staged page, manifest, observation and notification resource against collection until the entry that carried it is committed; segments keep today's retention rules. The session-resource storage they use, including its object-store externalization, is the same one a journal commit would use. Nothing else needs to be rebuilt: the rows are the index.
- **Staging is bounded.** Each run is limited to 10,000 `observation` entries (the record's own bound), and each Session to a staged-bytes watermark. Above the watermark the Session is marked for wake, so a loud Shell drains through a short residency instead of filling SQL. At a hard cap the Broker stops pulling that run, and pipe backpressure stalls it until the Session wakes.
- **Staged entries are deleted only after they are committed.** The Harness's drain acknowledgement deletes rows and their `RUNTIME_STAGE` refs only up to the applied point (§4.6). Because every resource rides with the entry that references it, a stage ref is never deleted before the journal commit that replaces it. A generation change does not delete them.
- **Suspension outlives the Broker process.** The routes this design adds or leans on — publisher registration and detach, the drain acknowledgement, `observation-pull`, and the public task cancel — resolve the binding and Runtime Session from their durable records and adopt them, the way `reclaimParkedMcp` already does (`RuntimeBrokerService.java:554`), instead of requiring the Session in this process's memory (§1.4). A Broker restart or a request landing on another replica must not turn a suspended Session's detach, wake drain or cancel into a 404.
- **Deleting the Session deletes its staging.** A Session deleted or retired while suspended never drains again, so the delete/retirement path removes its `ma_runtime_stage` rows and their `RUNTIME_STAGE` refs, releasing the staged resources to normal collection.

### 4.6 Wake and drain

**How staging wakes the Session.** The same transaction that stages a wake-worthy entry pulls the Session head's `wake_retry_at` down to now and sets `is_wake_pending = 1`. The existing backstop scan then selects the head. Its candidate carries a `staged` flag, meaning an uncommitted wake-worthy row exists. A staged candidate skips the journal proof and loads through the passive `recoverForWake`, exactly as a stamped head does in 3a. The journal proof alone would see no pending input and clear the hint. The seal stamp is untouched: a staged entry only brings the due time forward.

**The hint writes are fenced against each other.** Staging's hint write and the writer seal both take the Session head row lock, and neither may clear a hint the other just set. The seal recomputes `pending` over the committed journal prefix only (3a), so it writes `is_wake_pending = journalPending OR EXISTS(an uncommitted wake-worthy staged row)` and, when such a row exists, keeps `wake_retry_at` at most now (`JournalWriterLifecycle.java:421`). A blind OR against the old hint is wrong in the other direction: a resident Harness consumes wake inputs without clearing the hint, and only the seal's recomputation clears it, so an unconditional OR would pin every Session that ever had a wake input. The backstop's own clearing write gets the same guard: `recordPending(candidate, false)` only clears when no wake-worthy staged row exists (`JdbcWakeRecoveryStore.java:314`). This closes the detach→seal window: the publisher detaches before the writer seal (§6), the Broker can stage a wake-worthy entry in between, and the seal must not overwrite its hint.

**What the load does.** After the load's existing recovery passes and before the turn pump runs, the Harness:

1. **Re-attaches first.** It registers its publisher through the Broker. The worker switches the run to attached and answers, for each run, `stagedThrough`: the last sequence the Broker acknowledged. Entries the worker handed to the Broker but saw no acknowledgement for stay in its outbox, and it pushes them again.
2. **Drains staging up to `stagedThrough`.** For each run, in `deliverySeq` order, it applies each staged entry exactly as a pushed one (§4.4): resources are already in the store, and records are committed in order. The commit path walks the manifest's page closure server-side — `isReferenceContainer` gains `managed-tool-result-manifest` (`http-managed-session-store.ts:3993`) — because a draining Harness has no in-memory staged set: today the nested `JOURNAL` refs for pages are collected from the resident store's staged map, and a drain that skipped the walk would commit the manifest while leaving its pages unreferenced. The Harness then acknowledges the drain, and the Broker deletes rows up to the applied point.
3. **Applies pushes after `stagedThrough`.** The first push it accepts for a run is `stagedThrough + 1`; a push that arrives before the drain finishes is refused as not ready, and the worker re-sends it. A pull that was in flight when the worker switched to attached may still commit rows above `stagedThrough`. Those rows duplicate entries the worker re-pushes. The next drain finds them applied and deletes them, and so does the suspension teardown, which acknowledges staging up to its applied point as part of the detach itself (§4.9).

There is no gap, because the worker drops an entry only after it is durable in one consumer. There is no double delivery, because every application checks a record watermark. A crash after the commit but before the deletion leaves rows that the next drain finds applied and deletes.

### 4.7 Settling a background exit through a drain-only wake

- **The pull settles the execution row.** When a background process ends, the worker emits a `terminal` entry. Staging that entry also settles the process's `ma_tool_execution` row in the same transaction, using the exit evidence from the current-generation worker (the same evidence and rules the status route uses today). A quiet Shell that exits while suspended therefore has its execution row settled within one pull interval, and no separate job is needed.
- **The journal settle needs the writer, so the exit wakes a drain-only load.** Settling the execution row alone frees nothing durable: the Runtime Session stays `READY` until its `RELEASED` record (`RuntimeHoldInventory.java:38`), retention refuses a binding with a non-released Runtime Session, an `execution_storage_key`, an owed `HOSTED_CLEANUP` ref, or an unsettled `child_run` record (`JdbcRuntimeRetention.java:247`, `ManagedRuntimeRetentionGuard.java:19,39,70`), and the public task projection advances only from journal commits (§1.4). The `terminal` entry therefore marks the Session for wake, and the load drains staging and settles the run exactly as a resident finalize would: the record's terminal revision, the cleanup confirmation, and the Runtime Session release. **No input is committed for it**, so the turn pump runs no model turn; the Session re-seals and suspends again if nothing else is pending. The journal, the cleanup debt, the physical Runtime and the public output Artifact converge within one scan period plus one silent load, and every existing retention and recovery guard closes on its own. Nothing reclassifies the run before its journal settle; the §4.8 exemptions cover the window.
- **One exit, one silent load.** A background run exits once, so the drain-only wake costs one short load per run, not a residency. A row from an old generation cannot change the current run.

### 4.8 Suspension eligibility, the seal and the recovery view

Eligibility, when the capability is on (§4.11):

- **Background terms are exempt run by run.** The background terms of `suspensionLiveWork` (`:5059,5063,5075-5088`) stop blocking for runs that pass the existing per-run evidence check `hasBackgroundHoldEvidence` (`hosted-turn-cleanup.ts:242`): a `child_run(kind=shell)` or `monitor_run` on the current binding and generation, with a start receipt, in `running` or `waiting` with `running_attached`.
- **The binding's worker must support the pull.** Eligibility also requires the binding's worker to advertise `runtime-observation/1` (§4.11). The check runs at suspension admission, never at teardown: a binding on an older worker — a rolling upgrade, a remote worker not yet updated — simply stays resident, because a detach that failed at teardown would block the whole Session.
- **Everything else still blocks.** That includes a `child_agent` or `workflow` run, `runtime_lost`, an old generation, foreground cleanup debt, and every other term (parent §4.5).

The seal certifies the background holds, extending the 3a stamp:

- **What the seal records.** The suspension seal's `wake` object gains `backgroundHeld: true` when the Session's only unsettled runs and cleanup debts are the verified background holds above. The Store writes it to a new head column, `wake_seal_background`, under the same writer fence and revision check as the stamp. Any writer acquisition clears it.
- **Recovery view.** The `ready` arm accepts unsettled `runtime_state` rows and `HOSTED_CLEANUP` refs only when `wake_seal_revision = journal_revision AND wake_seal_background`. The control plane cannot run the per-run evidence check, which reads the journal; the seal makes the Harness that can run it certify it.
- **Cleanup retry.** `HostedCleanupRetryCoordinator` skips debts on such a head instead of reloading it (`HostedCleanupRetryCoordinator.java:128`).

Both follow 3a's argument: the stamp is written by the writer that ran the check, at the exact revision, and nothing commits until an acquisition clears it.

### 4.9 Teardown: a probe-only release and a kept mount

- **A suspension release never drains.** Both suspension drain paths (`:5170,5172`) run in probe-only mode: they observe the holds and stop nothing. A `held` outcome counts as success only when the Broker confirms the hold is a background execution of this Session's current binding and generation. Foreground debt still fails the teardown. Close keeps its terminate-and-drain path unchanged.
- **Background work keeps the mount.** In suspension mode, a background-only hold keeps the mount membership instead of treating the `runtime_session_busy` refusal as recovery-required. This is the shape of Phase 2's park, and it covers both the Hook owner close and the MCP owner close that cannot park (parent §4.5).
- **The publisher is detached, not closed — and the detach carries the final acknowledgement.** The publisher step first waits for in-flight pushes to settle, then detaches through the Broker with the Harness's final `appliedThrough` as a parameter of the detach itself. The Broker deletes staged rows up to that point in the same transaction, and the worker switches the run to held mode (§4.4). One atomic step replaces a separate ack-then-detach race.

### 4.10 Reclamation guard and worker loss

- **Reclamation checks background work first.** `reclaimParkedMcp` checks for active background executions before `transport.reclaimMcp`, and refuses without closing any connection (`RuntimeBrokerService.java:587`). Live background work therefore extends the park until it ends. The guard also removes the incidental settlement sweep that reclamation used to trigger, which §4.7 makes unnecessary.
- **Worker loss while suspended is handled as today.** The binding becomes recovery-required, the processes stay unproven, and no fresh owner is minted. Staged entries came from a proven generation and record facts that happened, so the next load drains them; a drain is not a rerun. The capture is capped at the last durable manifest (§4.1), and the record parks on the existing `runtime_lost` path.

### 4.11 Rollout and rollback

Three things gate suspension of a background Session:

- the setting `qwen.managed-agent.runtime-observation.enabled` (default off), advertised as `runtimeObservation` in the writer grant beside `wakeDispatch`;
- a worker capability, `runtime-observation/1`, in the worker's capabilities, checked at admission (§4.8);
- the per-run evidence check (§4.8).

The worker-owned capture and the outbox of §4.1–§4.4 are gated only by the worker capability, not by the setting. They replace the background lane whenever the worker advertises the capability, because they are equivalent while resident and only remove `producer_lost` on a Harness restart.

Rollback:

- **Turning the setting off stops new background suspensions.** Already suspended Sessions keep being pulled and staged, because the pull runs wherever the Broker runs, regardless of the setting. They wake as usual.
- **Rolling back the worker is the last step.** It is safe only after the background runs that started under the capability have ended.

3b needs no 3a setting to suspend a background Session. But once a wake has committed a notification, re-suspending while that notification is still pending needs 3a's relaxed gate; without it the Session stays resident until the notification turn runs.

## 5. Decisions and rationale

1. **The capture moves to the worker.** This decision is what makes 3b feasible. The capture's correctness rests on a running digest that no other process can continue. The worker's lifetime covers the stream, and H3 already caps the stream when the worker is replaced. The alternatives cost more:
   - Rebuilding the digest on reopen re-reads the whole stream on every wake, up to the stream's protocol bound.
   - An exportable SHA-256 midstate needs a custom hash implementation and a persisted side record.
   - A new capture per Harness lifetime breaks the one-Artifact-per-task contract.
2. **The Broker pulls; the worker never calls out.** The pull reuses the lease-authenticated, generation-fenced transport. That replaces the parent's durable binding-scoped staging authorization (§10 item 5) and its renewal and revocation questions with nothing new. One puller claims a binding so replicas do not multiply the staging writes. The cost is pull latency and one long poll per binding with live background work; §7 measures both.
3. **One delivery sequence per run.** A single ordered stream with an acknowledgement point replaces the parent's received and durable byte positions, the three-party freeze, and the separate observation identity. The byte offsets stay internal to the worker's capture, and the observation sequence is assigned when the observation is made.
4. **Re-attach first, then drain up to the reported point.** The worker reports the boundary between what was staged and what it will re-push. That makes the handoff a two-party exchange with a known cut point instead of a freeze.
5. **Staged payloads are Session resources, carried by their entries.** Bytes are written once, to the storage the journal will reference. Pages and manifests ride with the entry that references them under `RUNTIME_STAGE` refs, so a stage ref is never deleted before the journal commit that replaces it; segments keep today's `PUBLISHED` shape and retention. The wake drain commits records and copies no bytes.
6. **The seal certifies background holds.** The control plane cannot re-derive the per-run evidence. A seal-time certificate, cleared on acquisition, is exactly 3a's argument applied to a second fact.
7. **Exits wake a drain-only load.** The execution row settles from the pull, but the Runtime Session release, the cleanup confirmation and the public Artifact all need the writer. A silent load — no input, no model turn — converges them within one scan period plus a load, once per run. Letting the Broker settle everything without a load would instead require rewriting the durable retention and recovery invariants (§4.7) and would leave the public task state stale until an unrelated wake.

## 6. Interaction with Phases 1, 2 and 3a

- **Eligibility.** 3b exempts the background terms run by run (§4.8). The Phase 1 active-work terms and 3a's pending-input gate are unchanged.
- **Teardown order.** The order is the same: wake → owners (park or keep) → lease and cleanup → publishers → writer seal → `stopLocal`. Two steps differ: the release is probe-only and the publisher is detached with its final acknowledgement instead of closed (§4.9).
- **Phase 2.** Parked MCP owners are reused as before. Reclamation refuses before disconnecting while background work is live (§4.10). An MCP owner that cannot park keeps its membership through the §4.9 tolerance.
- **3a.** A staged wake reuses the backstop, the passive `recoverForWake` and the transport fence. The seal stamp gains `backgroundHeld`, and the seal's hint write gains the staged-row guard (§4.6). A staged entry only brings the due time forward.
- **Bounded recovery.** The proof rests on writer fencing and is unaffected. A failed 3b teardown follows the existing drain-failure path.

## 7. Measurement (enablement gate)

These extend parent §7 item 5:

1. **Pull cost and latency**:
   - long-poll connections per Broker under the single-puller claim, and the CPU per idle pull;
   - time from observation to wake to turn start;
   - time from exit to execution-row settlement, and to the journal settle (scan plus silent load);
   - choosing the pull wait, the staged-bytes watermark and the hard cap.
2. **Loud output while suspended**: staging rows and bytes, how often the watermark wakes the Session, and whether backpressure engages.
3. **Drain cost**: load time with 1, 100 and 10,000 staged observations, and the burst of silent loads when many background runs exit together.
4. **Resident equivalence**: per-run throughput and latency through the worker-owned capture compared with today's Harness capture.

## 8. Constraints and risks

- **The worker-side capture is the largest change.** It needs characterization tests of today's manifest output first, so the move is provably byte-for-byte equivalent (except segment size and page capacity).
- **Pull is the only path while suspended.** If the Broker is down, staging stops and pipe backpressure eventually stalls background processes. This is bounded and visible, never a silent loss.
- **Staging holds the only copy of bytes the journal has not yet referenced.** Its refs ride with their entries and must survive retention and deletion ordering exactly as journal refs do; the delete/retirement path cleans up staging for a Session that never wakes (§4.5).
- **The Broker publishes Session resources.** Staging needs the same session-resource storage configuration as the Store, including object-store externalization. The Broker already shares the Store's database, but a deployment that runs it apart from the server must also share that storage.
- **A loud Shell never really suspends.** It cycles through watermark wakes. This costs nothing beyond today's residency, and §7 sizes it.
- **The drain-only wake is a load.** A fleet of background runs exiting together produces a burst of silent loads; the backstop's existing scan limit paces it, and §7 sizes it.
- **The certificate is only as good as the per-run evidence check.** That check already gates cleanup today.

## 9. Slicing

1. **Worker-owned capture and outbox, resident only.**
   - Contents: the capture and the Monitor policy move to the worker; delivery entries; the Harness applier; publisher replacement by writer generation; push failure leads to held mode.
   - External behavior: unchanged, except that a Harness restart continues the capture instead of reporting `producer_lost`.
2. **Broker staging.**
   - Contents: `observation-pull` with the single-puller claim and durable adoption; `ma_runtime_stage` with entry-carried `RUNTIME_STAGE` refs; the manifest-closure walk in the commit path; execution-row settlement from the pull; the staged wake arm and the seal/`recordPending` hint guards; the re-attach-then-drain protocol.
   - At this point the only path that uses it is a Harness crash; nothing suspends yet.
3. **Background suspension.**
   - Contents: the eligibility exemption (including the admission-time capability check) and `backgroundHeld` seal certificate; the recovery view and cleanup-retry changes; the probe-only release; keeping the mount; the detach with its final acknowledgement; the reclamation guard; the drain-only exit wake; staging cleanup on delete; the rollout gates.
4. **Acceptance and measurement.** The real-process and MySQL fault matrix, and the §7 measurement that sets the constants.

## 10. Acceptance

- **Capture equivalence.** For the same output, the worker-owned capture publishes segment, page and manifest objects that verify byte for byte against today's (except segment size and page capacity), and the same final Artifact.
- **Harness restart.** With a background Shell writing continuously, killing and reloading the Harness yields one capture, no `producer_lost`, every byte exactly once, and a valid manifest chain.
- **Idempotent delivery.**
  - Re-pushing any entry after its acknowledgement was lost changes nothing.
  - An out-of-order push is refused and recovered by re-sending.
  - Re-draining after a crash between commit and row deletion commits each observation and notification exactly once.
- **Re-attach and drain.** A pull in flight when the Session re-attaches, with continuous output, ends with the correct byte order and digest, one notification per observation, and no staging rows left. Every drained manifest's pages carry `JOURNAL` refs before the stage refs are deleted.
- **First observation while suspended.** A suspended Monitor's first line stages, wakes the Session through the staged arm even with the transport off and an empty journal, and delivers exactly one notification turn.
- **The detach→seal window.** An observation staged after the publisher detaches and before the writer seal still wakes the Session within the scan bound. A Session whose journal wake inputs are all consumed and that has no staged wake rows still clears its hint at seal and leaves the scan set.
- **Monitor policy.** Idle timeout and `maxEvents` stop a watch while its Session is suspended, and the stop reason is committed by the drain-only wake.
- **Quiet exit.** A background Shell that exits silently while suspended has its execution row settled within one pull interval. The drain-only wake then commits the terminal revision, confirms the cleanup, releases the Runtime Session and materializes the Artifact — within one scan period plus a load, with no model turn — after which the existing retention guard reclaims the binding with no special case.
- **Forced stop under backpressure.** A public task cancel, a Monitor policy stop, and a close drain each produce a `terminal` entry with a stop reason even when the outbox is full and the process is paused on its pipes; the capture is marked `broken`, and the stop call gets its exit proof.
- **Bounds.** Loud output while suspended triggers a watermark wake. At the hard cap, backpressure stalls the process and nothing is lost.
- **Suspension.**
  - A Session holding only a verified background Shell, Monitor or both suspends: the processes keep running, nothing is stopped, the mount and the holds stay, and the recovery view is `ready`.
  - A `child_agent`, a `workflow`, `runtime_lost`, an old generation, foreground debt, or a worker without the capability still blocks.
  - An explicit close still terminates and drains the work.
- **Reclamation.** Reclaiming a parked MCP owner with live background work refuses before closing any connection.
- **Worker loss while suspended.** The next load drains the staged entries, caps the capture at the last durable manifest, parks the record on `runtime_lost`, and starts no new process.
- **Fencing.** Pulls never reach a superseded generation. A Harness registration from an older writer generation is refused. A Broker restart or a second replica does not break detach, drain acknowledgement, pull or cancel: exactly one puller claims a binding, and the routes adopt from durable records.
- **Deleting a suspended Session.** Deleting or retiring a Session with staged rows removes the rows and their stage refs, and the staged resources become collectable.
- **MySQL and real processes.** The staging, settlement, wake and fault cases pass on MySQL 8.4 with a real Harness and worker. H2 alone is not acceptance.

## 11. Open questions

1. The pull wait, the staged-bytes watermark, the hard cap, and the per-run and per-worker outbox budgets (bounded below by the largest flush batch), chosen by §7.
2. Whether the task view should read staged output (not only the committed state) while suspended, decided by §7 and product need.
3. The background segment size (at most 256 KiB proposed) and the partial-segment flush interval, balanced against the request limit, the outbox budget and output visibility.
4. Whether an MCP owner Session that cannot park should simply be ineligible in the first cut, instead of using the §4.9 membership tolerance.

## 12. Parent sections answered or superseded

| Parent                                                                                 | Status                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §1.3 "Background work: the process is already Runtime-owned; the observation is not"   | Extended by §1.1: the capture itself is Harness-owned and cannot outlive it.                                                                                                                           |
| §4.4 capture rework, received vs durable, retransmission                               | Replaced by §4.1 and §4.3–§4.4: the worker owns the capture, and delivery entries are idempotent with a durable acknowledgement.                                                                       |
| §4.4 coordinated drain-then-open                                                       | Replaced by §4.6, re-attach then drain up to the reported point.                                                                                                                                       |
| §4.4 stable observation identity, staging rows as the wake marker                      | §4.2 (worker-assigned sequence) and §4.6 (staged arm of the backstop, with the hint-write fence).                                                                                                      |
| §4.4 raw payload as a durable source                                                   | §4.5: staged resources ride with their entries under `RUNTIME_STAGE` refs, deleted only after the entry's commit.                                                                                      |
| §4.4 proactive settlement, exited-pending-commit                                       | §4.7: the pull settles the execution row; a drain-only wake settles the journal, the cleanup and the Runtime Session.                                                                                  |
| §4.4 durable binding-scoped authorization                                              | Withdrawn: the Broker pulls under the existing lease (§4.5, §5 item 2).                                                                                                                                |
| §4.4 task view, rollout                                                                | §4.7, §4.11.                                                                                                                                                                                           |
| §4.5 eligibility, probe-only release, mount handback, reclamation, reopen, worker loss | §4.8–§4.10, with the reclamation ordering correction.                                                                                                                                                  |
| §4.6 3b items                                                                          | §4.8 seal certificate `backgroundHeld` and §4.7 drain-only exit wake.                                                                                                                                  |
| §10 items 4–10                                                                         | 4 → §4.5 and §11; 5 → withdrawn; 6 → §4.7 (the exit converges within one scan period plus a silent load; no staged-overlay read path); 7 → §4.2 and §4.3; 8 → §4.3–§4.6; 9 → §4.1 and §4.4; 10 → §4.9. |
| §11 slices (2)–(5)                                                                     | Replaced by §9 slices 1–4.                                                                                                                                                                             |
