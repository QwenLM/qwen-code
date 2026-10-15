# EventTransport MQ2: Java producer/consumer wiring

[English](2026-10-12-managed-agent-event-transport-mq2.md) | [简体中文](2026-10-12-managed-agent-event-transport-mq2.zh-CN.md)

> **Status:** Proposed phase plan. This is phase **MQ2** of the cross-node
> EventTransport design
> ([2026-10-04-managed-agent-event-transport](2026-10-04-managed-agent-event-transport.md),
> §7), tracked under [#12380](https://github.com/QwenLM/qwen-code/issues/12380).
> Every gate the parent design put in front of MQ2 is now closed: MQ1's seam
> landed ([#13909](https://github.com/QwenLM/qwen-code/pull/13909)), the §5.1
> LiteTopic verification resolved at doc level
> ([#13927](https://github.com/QwenLM/qwen-code/pull/13927)) and on a real
> 5.5.1 staging broker, and the §11 routing and wake-carrier decisions landed
> ([#13933](https://github.com/QwenLM/qwen-code/pull/13933)).

## Problem

MQ2 is the phase that turns the named seam into a wired transport: an
outbox-drained MQ producer, wake and materialization consumers, consumer
dedup by committed sequence, all behind a default-off configuration flag.
Taken as one diff it is far past one reviewable PR — the envelope contract
extension, a Java mirror of the frozen contract, a new publication point on
the authoritative commit path, a broker client with a brand-new dependency
family (gRPC), two consumer roles, and a real-broker E2E. This document
decomposes MQ2 into four sub-slices, each independently reviewable and
independently revertable, ordered so that no slice carries an unexercised
dependency into the next.

## Current state

Read on `23add5ef9d` (2026-10-12, main tip after #13933).

- **MQ1 seam (public event stream).** `CompositeCommittedEventPublisher` is
  the sole `CommittedEventPublisher` bean — hub first, then
  `List<EventTransport>` (empty by default), per-transport
  `RuntimeException` isolation, drop log carrying tenant/session/sequence
  identity. It sits on the public `managed_agent_event` stream only.
- **Authoritative journal commit path.** `ManagedSessionStore.commit`
  (`@Transactional`) inserts journal facts into `qwen_managed_session_journal_tx`
  and advances `qwen_managed_session_journal_head`. There is **no**
  after-commit publication point anywhere on this path — the design's second
  wire does not exist yet, and MQ1's scope boundaries forbid relabeling the
  hub seam as covering it.
- **Envelope contract (#13498).** Frozen TS contract
  (`managed-event-envelope-v1.schema.json` + fixtures): ten fields (`v`,
  `tenantId`, `workspaceId`, `sessionId`, `stream`, `sequence`, `eventId`,
  `kind`, `occurredAt`, `payloadRef.digest`), forbidden-field set, closed
  object. The v1 stream vocabulary names **only** `authoritative_journal`.
  **No Java mirror exists** — a Java producer renaming a key or changing the
  digest canonicalisation would pass every existing test (review R1-3 on
  #13927). The house pattern for a Java fixture consumer exists
  (`ManagedMcpRecordContractTest` and siblings read
  `packages/core/src/managed-runtime/contracts/*.fixtures.json` directly).
- **No RocketMQ/gRPC dependency anywhere** in `sdk-java`. The client to add
  is `org.apache.rocketmq:rocketmq-client-java:5.1.0`, which is a **shaded**
  artifact: its build relocates `io.grpc` and `com.google` into private
  namespaces (its README distinguishes it from the `noshade` variant), so the
  Spring Boot BOM never re-aligns those embedded classes and there is no
  version conflict to disprove. The gate is therefore empirical, not
  version-table-based: add the shaded artifact, prove the dependency tree and
  packaging stay clean, and prove the server starts and round-trips a message
  against a real broker.
- **Outbox precedents.** SQL-side drain loops already exist
  (`SessionMessageRelayStore`, `ChildResultRelayStore`,
  `ManagedExtensionRecordStore`'s delivery line) — the MQ producer is a
  latency shortener over the same discipline, never the truth.

## Design: four sub-slices

### MQ2a — Java mirror of the frozen envelope (no broker, no TS change)

Land the Java mirror of the frozen v1 contract: a Java derivation producing
the identical ten-field envelope from a committed journal record, with a
fixture consumer that reads the frozen TS fixtures and proves the Java output
matches — the contract-first house pattern. No TS contract change, no broker
client, no configuration, no behavior change; the mirror is exercised only by
its tests (a structural non-enablement proof, mirroring the TS side). The
`public_event` stream extension is **not** this slice — it belongs to MQ2c,
where the public-event wire actually lands.

Rationale for first: it is the only slice with zero external dependency, it
pins the Java side to the frozen contract before any producer exists, and it
is what lets every later slice's review read a diff instead of re-deriving
canonicalisation rules.

### MQ2b — journal-facts publication point + LiteTopic producer

Add the authoritative wire: an after-commit publication point on
`ManagedSessionStore.commit` that hands the committed journal facts to a
transport, and a `LiteTopicEventTransport` implementation publishing
`authoritative_journal` envelopes via `rocketmq-client-java` (gRPC), behind
`qwen.managed-agent.event-transport.enabled` (default off). The dependency
proof is empirical, not version-table-based: the shaded artifact's tree
packages cleanly and the server starts and round-trips a message against a
real broker. The broker capability check runs at startup and fails fast on
mismatch (#13200 hardening).

### MQ2c — public-event wire + wake/materialization consumers

Extend the frozen envelope vocabulary with the `public_event` stream (the
tracked contract extension the MQ1 seam's lane needs), then a second
`EventTransport` implementation carries the public `managed_agent_event`
stream (the MQ1 seam's lane) as `public_event` envelopes, and the two
consumer roles land: a wake consumer attempting activation through the
Session Authority fence, and a materialization consumer triggering the
existing `MessageMaterializer` path. Consumer topology follows the §11
routing decision: a shared bootstrap group for pending-activation wakes plus
owner-side dynamic per-Session subscription. Every consumer dedups on
`(tenantId, sessionId, stream, sequence)` against the SQL watermark. During
an owner handoff a stale subscription can coexist briefly (lease expiry
without a clean unsubscribe); the stale subscriber's fenced no-op ACK still
advances the group offset, so the new owner can miss that notification and
must recover the pending item by SQL reconciliation — never by assuming the
MQ delivered it. (As built, that reconciliation is not a generic scan; see
"Where a missed or burned wake recovers" under MQ2d.)

**As built.** The contract extension is recorded in
[2026-10-06-managed-event-envelope](2026-10-06-managed-event-envelope.md)
(additive inside v1; a `public_event` kind is the public event type, checked
by shape; the digest binds a nine-field row; `workspaceId` is the Session's
binding, or for an unbound Session its journal's workspace). The wiring:

- **Producers.** `LiteTopicPublicEventTransport` is the MQ1 seam's
  `EventTransport`: it copies the borrowed batch onto a bounded single-thread
  queue (a full queue drops the batch with its identity logged), resolves the
  Session's workspace once it exists (both sources are written once and never
  updated, so a found value is cached), and sends to the Session's own
  LiteTopic, which the journal envelopes share;
  `stream` tells them apart. The journal producer also sends every
  `wake.requested` envelope to the wake bootstrap LiteTopic. Both producers
  share one RocketMQ producer and isolate a synchronously refused send.
- **Lanes.** Two LITE groups bound to the topic: the wake bootstrap group,
  in which every node subscribes the one bootstrap LiteTopic (it is consumed
  in order by one member at a time), and the owner group, which each node
  subscribes to the Sessions its Harness writes — the connector's
  attachments narrowed by SQL to ACTIVE journals whose writer is this
  node's Harness under an unexpired lease, since an attachment outlives a
  lapsed lease or a takeover (`OwnerSubscriptions` reconciles that set every
  `owner-reconcile-interval`, default 1 s, and subscribes at once after a
  wake activation). Both lanes share one listener, which acknowledges every
  message: a LiteTopic is consumed in order, so a FAILURE would hold every
  later notice behind a retry, and no outcome is recovery-relevant.
- **Wake consumer.** A journal `wake.requested` is attempted only when SQL
  shows it: the Session and its journal exist, the envelope's workspace is
  the journal's, the sequence is committed, the Session is `ACTIVE` and its
  journal `ACTIVE` or `SEALED`, and no writer holds it — an `ACTIVE` journal
  under an unexpired lease (database time), as `hasLiveWriter` decides, so a
  sealed journal's leftover lease does not count. The wake is then claimed
  on the Session event stream's wake watermark
  (`ma_event_stream.wake_covered_sequence`) — a redelivered,
  duplicated or older wake is refused even when two nodes race. Those checks
  and the claim run on the listener; the load runs on a small bounded pool,
  so one slow load never holds the ordered bootstrap lane. The load takes the
  relay verbs' new-work admission (Workspace checks, then the takeover load
  for a Session another control-plane process attached), and the Harness's
  writer acquisition is the activation fence; a failed load counts as fenced
  only when SQL then shows another live writer. A Session this node already
  holds is not reloaded.
- **Materialization consumer.** A `public_event` at or below the message
  projection's covered sequence is a no-op. Above it, the Session gets one
  queued batch on a single materialization thread — notices that arrive
  while it is queued fold into it — and
  `MessageMaterializer.materializeNotified` runs that batch through the same
  store call as the scheduled pass, never bypassing that pass's backoff.
- **Configuration.** `qwen.managed-agent.event-transport.*` gains
  `wake-bootstrap-lite-topic`, `wake-bootstrap-group`, `owner-group` and
  `owner-reconcile-interval`; the whole configuration class is conditional
  on `enabled`, so a flag-off deployment still creates no transport bean.

Not in MQ2c: the real-broker fault rows (MQ2d), receiver-side digest
verification of journal facts (the consumers act on SQL, not on the body),
and a new generic SQL wake scan (the existing relay scans and the loaded
Session's own wake pump stay the backstop).

### MQ2d — real-broker E2E in CI

A new failsafe profile plus a CI job with a RocketMQ 5.5.1 service
container, running the §8 fault-injection rows that MQ2's exit check names:
duplicate and reorder injection are no-ops, post-commit SSE latency p95 does
not regress, and a flag-off deployment is byte-identical. One acceptance row
is the owner-handoff window: with a stale subscription and a new owner
coexisting, the old owner does no side effect and ACKs, and the new owner
still discovers and processes the pending item via SQL reconciliation without
receiving the MQ notification. The local machine has no container runtime, so
this slice is CI/cloud only by construction. (As built below: the broker
runs natively, so the gates run locally too, and the handoff row proves the
stale acknowledgement consumed nothing in SQL — what then recovers the wake
is named under "Where a missed or burned wake recovers".)

**As built.** No service container: `scripts/rocketmq-lite-broker.sh` runs
the 5.5.1 binary release natively (NameServer, a broker with `enableLmq`,
`enableMultiDispatch` and the RocksDB store, and the gRPC proxy), checks the
download against a pinned SHA-512, and creates the LITE topic and every LITE
group the server and the gates subscribe in — the same script on a laptop
(Linux or macOS) and on CI, so the gates are reproducible locally after all.
The `event-transport-broker-gates` profile runs only `EventTransportBrokerGate`
(the `*IT` families stay with their own jobs), and the SDK Java job
`EventTransport broker gates / RocketMQ 5.5.1 / Java 21` boots the broker,
runs the profile, checks the failsafe reports (`event-transport` family) and
uploads them with the broker's logs and the latency record. On a workstation
the proxy and the broker's HA port listen on every interface (RocketMQ has
no bind option for them), so the script says to run it only on a trusted
network. The application
runs whole — both producers, both lanes, the owner reconciliation — on H2,
with only the Harness stood in for. The rows:

- **Round trip.** Journal and public envelopes reach the Session's
  LiteTopic as the contract's canonical bytes, and the wake rides the
  bootstrap lane too.
- **Duplicate and reorder injection.** A wake sent twice, or an older wake
  after a newer one, activates once; the watermark holds the higher
  sequence. On the owner lane, a duplicated or older public notice reaches
  the consumer and runs no materialization batch.
- **Owner lane.** Of two Sessions this node holds an attachment for, only
  the one whose journal this node's Harness writes gets subscribed.
- **Owner handoff.** A stale subscriber in the owner group (its writer
  lapsed, another writer holds the journal) receives the wake, loads
  nothing, claims nothing and acknowledges. Once it unsubscribes, the new
  owner subscribes and never receives that notice — the acknowledgement
  advanced the group's offset — while an unacknowledged notice sent to the
  same lite topic before it subscribed reaches it as backlog, and so does a
  later notice, so the
  absence is the acknowledgement's doing. The wake stays unclaimed in SQL,
  so once the journal is free a later notice still activates it. On a
  Session the new owner holds, its Harness runs the wake input from the
  journal — the notice was never the carrier.
- **Post-commit latency.** The deployed composite (hub, then the public
  transport) and a flag-off composite (hub only) publish the same batches,
  interleaved: the committing thread's publish time and the hub
  subscriber's delivery time may not grow by a millisecond at p95 locally.
  Shared CI runners use a 20 ms allowance for scheduler noise; the raw
  measurements are still recorded. The journal wire's after-commit hand-off
  stays under 20 ms at p95. In three
  local runs (macOS, 300 rounds each) the transport added 13–186 µs at p95
  and the journal hand-off measured 0.35–1.5 ms; CI writes its own figures
  to `target/event-transport-latency.json`.
  Diagnostics run in a separate 300-round burst after the uninstrumented
  latency gate, including when that gate fails. They retain the original
  on-before-off order without per-round broker drains. The gate keeps its
  existing 1 ms local / 20 ms CI allowance and original aggregate report.
  `event-transport-latency-diagnostics.json` contains the instrumented
  aggregate; `event-transport-latency-samples.json` retains publish, hub-read
  and journal wall/CPU samples, including warm-up sequences 1–75.
  `event-transport-latency-stages.json` contains hub and transport timings
  inside the production publisher, correlated by session, sequence, thread
  and transport count. `event-transport-latency.jfr` records those events,
  execution samples, lock waits and GC pauses. Production events are disabled
  by default. Instrumented figures describe a diagnostic run and are never
  used for the latency assertions; subscriber delivery includes the whole
  publish call and subsequent read, not the instant the hub became ready.
  Separate percentiles must not be subtracted to attribute individual stages.
  Evidence is saved even when assertions fail, and diagnostic errors do not
  replace the original gate failure. The workflow runs daily or by manual
  dispatch against the selected branch; opening a PR does not run this suite.
- **Misconfiguration fails startup.** A NORMAL (not LITE) topic, which the
  subscription probe alone passes, is refused by a new send probe — one
  synchronous message to the probe's own lite topic — before any envelope
  is dropped; a probe group nobody pre-created fails the subscription probe.
  The probe group is now a property (`capability-probe-group`), and every
  `mqadmin` command the code prints names the cluster; without a cluster or
  broker, mqadmin creates nothing.
- **Flag off.** Pinned structurally rather than through the broker:
  `EventTransportConfigurationTest` proves a flag-off context holds no
  producer, consumer, transport or consumer store, and the rest of the
  module's suites run flag-off.

**Where a missed or burned wake recovers.** No generic scan loads a Session
that has a committed, unconsumed wake. A wake whose notice is lost — or
whose claim ended without a load, because the load failed, the pool was
full, or this node already held an attachment — recovers exactly as it does
with the flag off: through the ledger of the source that committed the
input, where that source has one (the public Turn dispatcher, until the Turn
is terminal; the session message relay's consume loop; the child result
relay; the automation scanner), or through any later load of the Session,
whose wake pump then runs what the journal holds. The transport never makes
this worse: the claim watermark refuses only its own and older sequences, so
a claimed wake never blocks a later one. Those ledgers have gaps that
predate it, though: a channel inbound input and a Monitor or background-shell
notification have no scheduled re-drive at all; the message relay, the child
result relay and the automation scanner each give up after 64 failed
attempts; a child result past `mark_accepted` is not reloaded if the parent
loses its writer; and a fired automation occurrence is reloaded by its own
scanner only when a later slot of the same definition fires or reconciles,
which a disabled, retired or blocked definition — or one whose next cron slot
is far off — does not do soon. Closing them belongs to those sources, not to
the transport.

## Key decisions

1. **The broker producer hangs off the authoritative journal commit path,
   not the MQ1 hub seam.** The parent design's §3 is explicit that the two
   wires are distinct and MQ2 wires the second; the envelope v1 stream
   vocabulary (`authoritative_journal` only) points the same way. The MQ1
   `EventTransport` seam carries the public event stream, which MQ2c wires
   as the `public_event` envelope extension.
2. **The Java mirror lands before any broker client.** A producer without a
   pinned contract is unreviewable; the fixture consumer makes "Java matches
   the frozen envelope" a test, not a claim.
3. **Default-off, structurally.** Flag-off produces no `EventTransport` bean,
   so the composite's transport list is empty and the deployment is
   byte-identical — the MQ2 exit check becomes an inspectable property.
4. **Consumer dedup keys on the SQL watermark, never the broker.** Per the
   invariants, an MQ offset is never recovery evidence; consumers re-read
   the durable watermark from SQL.

## Scope boundaries

- No enablement by default anywhere; the flag is off in every shipped
  configuration.
- No multi-node fault matrix (that is MQ3:
  [2026-10-14-managed-agent-event-transport-mq3](2026-10-14-managed-agent-event-transport-mq3.md)).
- No change to the commit path's transaction shape; the publication point is
  after-commit only, and publication failure never blocks the local
  post-commit SSE (#12380 constraint).
- No relabeling: the MQ1 hub seam is not asserted to cover the journal wire.

## Validation

- MQ2a: the Java fixture consumer goes red if an envelope key is renamed in
  the fixture file, or a forbidden-field negative fixture is accepted.
- MQ2b: flag-off deployment byte-identical; flag-on publishes envelopes a
  real broker receives (single-broker, staging or CI).
- MQ2c: consumer dedup makes a redelivered envelope a no-op; a stale wake
  for a fenced Session is a no-op.
- MQ2d: the §8 fault rows named by the MQ2 exit check run green in CI,
  including the owner-handoff recovery row — the old owner's fenced no-op
  ACK advances the group offset, and the new owner still discovers and
  processes the pending item via SQL reconciliation without the MQ
  notification. As built, the row proves the new owner never receives that
  notice and the wake stays unclaimed in SQL, where a later notice still
  activates it; the reconciliation itself is each input source's ledger
  (see MQ2d).
