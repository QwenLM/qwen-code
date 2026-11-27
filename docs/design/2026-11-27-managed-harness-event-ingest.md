# Managed Harness Event Ingest

[English](2026-11-27-managed-harness-event-ingest.md) | [简体中文](2026-11-27-managed-harness-event-ingest.zh-CN.md)

Status: proposed design, 2026-11-27. Current-state claims are checked against `main` at `43dc924882`. The first slice in §10 is implemented in the same change. This design builds on [the stateless Harness design](2026-11-16-managed-stateless-harness.md) and [suspension placement release](2026-11-26-managed-suspension-placement-release.md).

## 1. Problem and current state

A running Turn has two owners. The Hosted Harness holds the Session's writer lease and runs the loop. The Java instance that claimed the Turn holds its `dispatch_owner` lease (60 s, renewed every 20 s), keeps the Harness event stream open for the whole Turn and records what it reads.

The dispatcher's work for one Turn is:

1. Claim the Turn (`AgentTurnExecution.claimTurn`).
2. Attach, take over or recover the Harness Session, bind the Turn to the Harness boot and submit or continue the prompt. This step also reconciles event epochs (`HarnessCoordinator.runClaimed`).
3. Record the admission: status `RUNNING` (unless the Turn is already `CANCELLING`), `harness_event_epoch` and `harness_last_event_id` (`recordAdmission`, `recordRecoveryAdmission`).
4. Open `GET /session/:id/events` from the Turn's cursor and run `consumeStream` until a terminal event, an Action park or a recovery block.

Step 4 is the only part that needs a Java instance for the whole Turn. `consumeStream` does the following:

| Duty           | Today                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Projection     | Each v1 envelope goes through `HarnessEventProjector`. Its source key is `bootId:eventEpoch:sourceId`, and `sourceId` is the journal sequence.                                                                                                                                                                     |
| Filtering      | Envelopes without an ID, or with another prompt's ID, are skipped.                                                                                                                                                                                                                                                 |
| Batching       | Text and reasoning deltas are grouped up to 75 ms, 64 events or 64 KiB. The first visible text and every other projected event are recorded at once. A terminal event ends its batch.                                                                                                                              |
| Recording      | `recordHarnessEvents` locks Session and Turn and checks `dispatch_owner`, the lease deadline and the event epoch. It then advances the cursor, appends public events and settles a terminal Turn in one transaction.                                                                                               |
| Retraction     | `message_retracted` flushes the pending batch, then calls `retractHarnessTurnOutput`, which may be bounded by `sourceBootId` and `sourceEventEpoch`.                                                                                                                                                               |
| Action park    | When the stream ends without a terminal event, the dispatcher calls `parkTurnForAction`. The park itself is decided from durable state: a sealed head, a released activation, `wake_seal_revision = journal_revision`, the parked prompt with its deadline, a requested Action, and no unfinished Action response. |
| Recovery block | Every 15 s the dispatcher reads Harness status. If no prompt is active, recovery is blocked and no event follows the cursor, it calls `markTurnRecoveryBlocked`. Part of the Harness's `recoveryBlocked` state lives only in memory (MCP recovery, pending Hook operations).                                       |
| Failure        | A stream error becomes a transient failure. The lease is released, and the next sweep re-drives the Turn through step 2 until its retry budget is exhausted.                                                                                                                                                       |

Consequences:

- If the dispatching Java instance dies, the Turn's public events stop until its lease lapses and another instance re-attaches. Recent multi-instance work, such as #18433, #18440, #18455 and #18463, exists to recover this second owner.
- Every running Turn holds one long-lived Java-to-Harness connection.
- Pull scheduling cannot start. A Harness that claims and continues a Turn would still need Java to connect back to it for the events.

## 2. Goals and scope

### Goals

- After admission, the Harness delivers the Turn's committed events to any Java instance, and no Java instance stays attached.
- Public events, retractions and terminal settlement stay identical to today's for the same journal.
- Killing the Java instance that admitted the Turn does not interrupt event delivery.
- A Harness that dies or stalls is detected by the same lease bound as today and recovered through today's path.
- Mixed versions and rollback are safe, and each Turn uses exactly one delivery path.

### Non-goals

- Moving claim, attach, takeover, recovery admission or epoch reconciliation (steps 1 to 3) off the dispatcher. Those move with pull scheduling.
- Capacity-aware Harness selection. Fresh submissions keep the pool's round robin, and a busy member still answers `hosted_session_open_busy`. Claims gated by free capacity arrive with pull scheduling.
- Delivering events by ingest for Turns admitted through recovery, cancellation or Action-park continuation. These keep the stream in this design.
- Changing cancel delivery, the public event API, `EventTailPoller` or the projection code.
- Moving the dispatch lease to database time (#14248). It stays as it is.
- A schema migration, a message queue or a Java projection of journal commits.

## 3. Design decisions

| Decision                  | Choice                                                                                                                                                                         | Rationale                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership after admission | The dispatcher records the admission and sets `dispatch_owner = 'harness:' + bootId` in the same transaction                                                                   | Every existing guard (`dispatch_owner = ? AND dispatch_lease_until >= ?`) keeps working unchanged. Dispatcher owners are UUIDs, so the prefix cannot collide. |
| Lease holder              | Each ingest request from the Harness renews the Turn lease. With no events, the Harness sends a heartbeat at the lease renewal interval.                                       | `findDispatchable` keeps detecting a dead or stalled owner through a lapsed lease. No new sweep predicate is needed.                                          |
| Route                     | `POST /internal/managed-session-store/v1/sessions/{sessionId}/events:ingest`                                                                                                   | The Harness already holds the Store address and writer token for each resident Session. Any Java instance serves the route.                                   |
| Authentication            | The writer credential, placement and writer incarnation are checked as for other writer routes. The incarnation is either live or the sealed incarnation of a clean seal.      | Only the Session's writer can push. Turn correctness still rests on the `dispatch_owner` CAS.                                                                 |
| Payload                   | Today's v1 envelopes in journal order                                                                                                                                          | One projection implementation. Java applies the same per-envelope logic as `consumeStream`.                                                                   |
| Ordering                  | `afterSequence` and `throughSequence`. Envelopes at or below the cursor are ignored, and a gap returns the committed cursor.                                                   | Equals today's monotonic source-ID rule, plus explicit gap repair.                                                                                            |
| Opt-in                    | The dispatcher requests ingest in the prompt submission (`eventDelivery`) only when `qwen.managed-agent.event-ingest.enabled=true` and the Harness advertises `event-ingest/1` | The decision is per Turn. Rollback is per admission.                                                                                                          |
| End markers               | `end: "parked"` after the seal, `end: "recovery_blocked"` when the Harness is blocked                                                                                          | Replaces stream-end inference and the status poll with the evidence the Harness already has. Java runs the existing checks.                                   |
| Cancel                    | The CANCELLING lane may claim a Harness-owned Turn and continues on today's stream path                                                                                        | Cancel delivery and its proofs do not change. The Harness's next request is refused, and it stops.                                                            |
| Recovery-blocked Turns    | Marked through the existing method. The existing observation lane then handles them on the stream.                                                                             | A rare path keeps its current behavior.                                                                                                                       |

## 4. Ingest protocol

### Request

```json
{
  "workspaceId": "...",
  "writerId": "...",
  "writerGeneration": 7,
  "eventEpoch": "...",
  "turnId": "...",
  "promptId": "...",
  "afterSequence": 120,
  "throughSequence": 131,
  "events": [
    {
      "v": 1,
      "id": 121,
      "type": "session_update",
      "promptId": "...",
      "data": {}
    }
  ],
  "end": "parked"
}
```

The writer ID is the Harness boot ID: a Harness refuses a Store descriptor whose writer is not its own boot, so the request carries no separate boot ID.

`events` holds every envelope the Session journal projects in `(afterSequence, throughSequence]`, including other prompts' envelopes, as `GET /session/:id/events` would stream them. A request carries at most 64 envelopes. `events` may be empty for a heartbeat. `end` is optional.

Java decodes each envelope with the rules of the SDK stream decoder, so the projector sees the same values as it does from the stream:

- `v` must be 1, `type` must be non-empty, `id` must be positive, increasing and inside the range, and `data` must be present.
- Integers narrow to the smallest of `int`, `long` and `BigInteger`, and decimals decode as `BigDecimal`.
- Duplicate keys are refused.

### Handling

1. **Authenticate.**
   - Verify the tenant, Workspace and Session credentials and the writer token.
   - Require the current placement and a writer incarnation that is live by database time.
   - A request with `end: "parked"` may instead present the sealed incarnation of a clean seal, under the same writer ID, generation, token-hash and placement checks as the clean-sealed release arm.
2. **Resolve the Turn.** Load the Turn by `turnId` and require its `prompt_id` to match `promptId`.
   - If `harness_event_epoch` differs from `eventEpoch` while the Turn is active, the admission is not recorded yet: answer `managed_event_ingest_not_ready`.
   - If `dispatch_owner` is not `harness:` + `writerId`, or the lease has lapsed: answer `managed_event_ingest_not_owner`.
3. **Check the cursor.**
   - If `afterSequence` is greater than `harness_last_event_id`, answer `managed_event_ingest_cursor_mismatch` with the committed cursor.
   - If `throughSequence` is at or below the cursor, acknowledge without writing.
4. **Record.** Walk the envelopes in order with the `consumeStream` rules:
   - Skip foreign and ID-less envelopes.
   - Group deltas up to 64 events or 64 KiB.
   - Record each other projected event, each retraction and each terminal event in its own call to the existing `recordHarnessEvents` or `retractHarnessTurnOutput`, with owner `harness:` + `writerId` and source keys `writerId:eventEpoch:sourceId`.
   - Each call keeps its current transaction, lock order and checks. A failure part-way leaves a committed prefix. The Harness resends the same request, and the envelopes already at or below the cursor are ignored.
   - Transaction boundaries can differ from the stream's, because a request is its own batch. The recorded events do not differ.
5. **Advance and renew.** If the Turn is not terminal, advance the cursor to `throughSequence` (the trailing envelopes were filtered) and renew the lease through `renewTurn` with the Harness owner.
6. **End.**
   - `parked` requires the cursor to equal the head's committed sequence, then calls `parkTurnForAction` with the Harness owner.
   - `recovery_blocked` requires the same cursor condition, then calls `markTurnRecoveryBlocked` with `HARNESS_RECOVERY_BLOCKED`.
   - Both methods clear `dispatch_owner` under their current predicates. When the cursor is short or a predicate refuses, the reply is `managed_event_ingest_end_refused`, and the Turn later recovers when its lease lapses.
7. **Reply.** Report the cursor reached. If the request recorded the Turn's terminal event, the reply also carries `terminal: true`.

### Reply

The reply is `{ "cursor": 131, "leaseRenewAfterMillis": 20000, "terminal": false }`.

| Reply                                                                        | Harness action                                                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Success with `terminal: false`                                               | Continue from `cursor`                                                                                            |
| `managed_event_ingest_cursor_mismatch`                                       | Re-read the journal from the returned cursor                                                                      |
| `managed_event_ingest_not_ready`                                             | Retry with backoff, for no longer than the lease duration                                                         |
| `terminal: true`, `managed_event_ingest_not_owner` or a writer fence refusal | Stop pushing for this admission                                                                                   |
| `managed_event_ingest_end_refused`                                           | Flush through the committed sequence and retry if the cursor was short; otherwise stop pushing for this admission |
| Transport failure                                                            | Resend the same request                                                                                           |

## 5. Dispatcher changes

- **Submission.** For a fresh prompt submission with ingest enabled and `event-ingest/1` advertised, the submission body carries `eventDelivery: { "mode": "ingest", "turnId": "..." }`.
  - A fresh submission is a drive in which the Turn has no recorded admission (`harness_event_epoch` is null) and `submit` succeeds. It covers a new Turn's first drive and its retries before any admission was recorded, including a resubmission after a withdrawn submission mark.
  - A submit answered with `hosted_prompt_recovery_required` is not fresh, and neither is any drive of a Turn that already has an event epoch.
  - Delivery is decided per admission, so one Turn can start on ingest and finish on the stream after a recovery.
- **Admission and hand-off.** `recordAdmission` gains a hand-off variant. In the same transaction it sets `dispatch_owner = 'harness:' + bootId` and `dispatch_lease_until = now + lease`. The dispatcher closes its renewal before the hand-off and returns without opening the stream. `releaseTurnLease` in `coordinate`'s `finally` then matches nothing. A Turn that is already `CANCELLING` when its admission is recorded is not handed off. The dispatcher continues on today's cancellation path, and the Harness's pushes get `not_owner`.
- **Unchanged paths.** Recovery admission, continuation, cancellation and recovery-blocked observation open the stream as today, and their Turns remain dispatcher-owned.
- **Cancel take-back.** `findDispatchable` and `claimTurn` also admit `status = 'CANCELLING' AND dispatch_owner LIKE 'harness:%'`. The claimer becomes the owner and runs today's cancellation path, including `cancelOriginalTurn` and the stream. The cursor is shared, so the take-back neither loses nor duplicates events.
- **Lease lapse.** A lapsed Harness-owned lease is an ordinary lapsed lease. The sweep claims the Turn, and today's attach, takeover and recovery admission take it from there.

## 6. Harness changes

- **Capability.** `event-ingest/1` joins the contract features. A pool still requires identical features.
- **Pusher.** A per-Session pusher runs while an ingest admission is active.
  - It reuses the `eventEnvelope` projection and `streamedDeltaIds` seeding of the events route, and reads `authority.readEvents` from its cursor at the same 250 ms cadence.
  - It starts at the admission's `lastEventId`.
  - It posts through a new `ingestEvents` method on the Session Store client.
  - It stops on a reply with `terminal: true`, on `not_owner`, a writer fence refusal, or an acknowledged end marker.
- **Park.** After the seal is confirmed and before the placement is released (#18404), the pusher flushes through the committed sequence and posts `end: "parked"` with the sealed incarnation. If this fails, the suspension continues, and the lapsed lease leads to today's recovery.
- **Recovery block.** The condition is the one Java polls today: no active prompt for the Turn, `recoveryBlocked`, and the cursor at the committed sequence. When it holds, the pusher posts `end: "recovery_blocked"`.

## 7. Compatibility and rollout

| Control plane         | Harness                  | Behavior                                                 |
| --------------------- | ------------------------ | -------------------------------------------------------- |
| Flag off, any version | any                      | Stream, as today                                         |
| Flag on               | without `event-ingest/1` | Stream, as today                                         |
| Flag on               | with `event-ingest/1`    | Ingest for fresh submissions; stream for the paths in §5 |

- **Enable.** Turn the flag on only after every control-plane instance serves the ingest route.
- **Disable.** Turning the flag off affects new admissions only. Harness-owned Turns finish through ingest, which stays served.
- **Binary rollback.** Roll back the control-plane binary only after Harness-owned Turns have drained. If one has not, its pushes fail and its lease lapses, and the Turn recovers through today's path at the cost of one recovery.
- **Harness rollback.** A Harness without the feature never receives `eventDelivery`.

## 8. Failure and race semantics

| Window                                                  | Required outcome                                                                                                                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness pushes before the admission is recorded         | `not_ready`; retried; accepted after the hand-off. A Turn already `CANCELLING` when admitted is not handed off, and its pushes get `not_owner`                                                                                |
| Acknowledgement lost after commit                       | The resend is acknowledged without writing, or only its unrecorded tail is recorded                                                                                                                                           |
| Requests arrive out of order                            | A request that overtakes its predecessor gets `cursor_mismatch`, and the Harness resends from the committed cursor                                                                                                            |
| Failure part-way through a request                      | The committed prefix stands, and the resent request records only the rest                                                                                                                                                     |
| Admitting Java instance dies after the hand-off         | With a Store address that survives the instance, no effect: any instance serves the next request. With the reference chart's loopback Store (§12, risk 6), the Harness is cut off and the Turn recovers when its lease lapses |
| Harness dies or stops pushing                           | The lease lapses within 60 s, and the sweep recovers the Turn as today. Takeover already waits on the 60 s writer lease.                                                                                                      |
| Cancel during ingest                                    | The CANCELLING lane takes the Turn back, and the Harness's next request gets `not_owner`                                                                                                                                      |
| Stale Harness after takeover                            | The writer fence refuses it, or the `dispatch_owner` CAS refuses it                                                                                                                                                           |
| A heartbeat overlaps a recording                        | Both serialize on the Turn row lock and guard on `dispatch_owner` and the lease deadline, not on `version`, so neither invalidates the other                                                                                  |
| Park marker lost                                        | The lease lapses, and today's recovery handles the sealed, unparked Turn, as when a dispatcher dies between stream end and park                                                                                               |
| Cursor short of the committed sequence at an end marker | The marker is refused. The Harness flushes and retries, or the lease lapses.                                                                                                                                                  |

## 9. Affected files

### Control plane

- `server/.../api/ManagedSessionStoreController.java`: the `events:ingest` route.
- `persistence/.../JournalWriterLifecycle.java` and `JdbcManagedSessionStore.java`: ingest authentication, live or clean-sealed.
- `persistence/.../AgentTurnExecution.java`: the admission hand-off, the CANCELLING take-back predicates in `findDispatchable` and `claimTurn`, and cursor advance without events.
- `control-plane/.../HarnessCoordinator.java`: request ingest and hand off after a fresh submission. The per-envelope logic of `consumeStream` moves to a class shared by the stream and the ingest handler.
- `adapters/.../QwenHostedHarnessConnector.java` and `contracts/.../HarnessConnector.java`: `eventDelivery` on submit, and feature detection.
- `ManagedAgentProperties.java`, `application.yml`: `qwen.managed-agent.event-ingest.enabled` (default `false`).

### Harness and Store client

- `packages/core/src/managed-runtime/http-managed-session-store.ts`: `ingestEvents`.
- `packages/cli/src/serve/hosted-harness-contract.ts`: `event-ingest/1`.
- `packages/cli/src/serve/hosted-harness-session/turn.ts`: accept `eventDelivery`.
- `packages/cli/src/serve/hosted-harness-session/event-ingest.ts` (new): the pusher. `observation-routes.ts` exports the envelope projection.
- `packages/cli/src/serve/hosted-harness-session/session-suspension.ts` and the Action-parking flow: the `parked` marker between seal and release.

### Tests

- Java: ingest authentication, including a superseded writer, a wrong boot and the clean-sealed arm; cursor, retry, gap and partial-failure cases; parity with `recordHarnessEvents` for deltas, retractions, bounded retractions and terminals; hand-off and take-back CAS; lease lapse leading to recovery. Cover both H2 and MySQL 8.4.
- TypeScript: pusher cadence, heartbeat, the reply table in §4, the order of park marker, seal and release, and the recovery-blocked condition.
- Real process: two Java instances and one Harness on MySQL 8.4 (§10).

## 10. Validation plan

The work ships in three slices. The first two are inert in production.

1. **Java route.** The ingest route and handling, with nothing requesting ingest. Test it with direct requests.
2. **Harness pusher.** The pusher, `ingestEvents` and the end markers. It activates only on `eventDelivery`, so it is inert until slice 3.
3. **Enablement.** The flag, the submission field, the hand-off, the cancel take-back, and the real-process scenarios below.

Real-process scenarios, with two Java instances serving one Store address and a Harness on MySQL 8.4:

- Run the same scripted Turns, including deltas, a retraction, tool calls and a terminal, with ingest and with the stream. Compare the public events, apart from sequence numbers and timestamps.
- Kill the Java instance that admitted the Turn mid-Turn. Reconnect public SSE from its last cursor on the other instance. Deltas, retractions and the single terminal must match, and no stream is reopened.
- Reorder two requests, drop an acknowledgement after commit, and terminate the Harness after a journal commit but before ingest. Then compare as above.
- Kill the Harness mid-Turn. The lease lapses, and the Turn recovers through takeover as today.
- Cancel a Harness-owned Turn. The take-back settles it once.
- Park a Turn on an Action and approve it, and drive a recovery block. Compare both with the stream path.
- Measure ingest request rate, lock waits and first-visible-text latency against the stream at the same load.

Run focused Java and TypeScript tests within the module budget. The root build and typecheck are required, and the full profiles run in CI.

## 11. Acceptance criteria

- With the flag off, or with a Harness that lacks the feature, behavior is byte-for-byte today's.
- For the same journal, ingest and stream produce identical public events, retractions and terminal settlement.
- After the hand-off, no Java instance holds a Harness event stream for the Turn, and killing the admitting instance does not interrupt it.
- A Turn is never recorded by both paths. After a take-back or a lease lapse, and for any stale push, the `dispatch_owner` CAS refuses the Harness's writes.
- A dead Harness is recovered within today's lease bound and through today's recovery path.
- Cancel, Action park and recovery block keep their current outcomes and exactly-once settlement.
- No schema migration, public route or projection change is introduced.

## 12. Risks and open questions

1. **Request rate.** Each running Turn sends about one request per 250 ms tick while it produces events, plus a heartbeat every 20 s. The heartbeat replaces the dispatcher's renewal. Measure against the stream before default-on. The pusher starts at the admission cursor; envelopes it resends are ignored under the cursor rules.
2. **Two lock families.** Store authentication locks the placement guard, Session root and head. The recording calls keep their Session-root, Turn, event-stream order. Authentication must finish, or keep the same root-first order, before recording starts ([lock simplification](2026-11-02-managed-agent-lock-simplification.md)).
3. **Sealed-arm marker.** `parked` is the only request accepted from a sealed incarnation. The Harness must post it before the placement release, and implementation must confirm the seal appends no journal event after the final flush. If it does, or the marker is refused or lost, the Turn keeps its Harness owner until the lease lapses, and today's recovery then handles the sealed, unparked Turn.
4. **Scope of ingest.** Recovery admissions and continuations remain on the stream. This includes the continuation of an approved Action. Pull scheduling replaces them, because the Harness that claims the work also delivers its events.
5. **Clock.** The Turn lease still runs on Java instance clocks (#14248), and ingest widens the exposure: one instance writes the lease, and whichever instance serves a later request renews and checks it. An instance whose clock runs ahead can refuse a healthy renewal, and the Turn then recovers by lease lapse; one that runs behind can accept a just-expired lease. Bound the skew between instances, or move the lease to database time, before default-on.
6. **Store address.** The kill-Java scenario needs a Store address that survives one instance. The reference chart serves the Store on loopback inside the Java Pod, so killing that Java instance also cuts its Harness off from the Store.
