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
MQ delivered it.

### MQ2d — real-broker E2E in CI

A new failsafe profile plus a CI job with a RocketMQ 5.5.1 service
container, running the §8 fault-injection rows that MQ2's exit check names:
duplicate and reorder injection are no-ops, post-commit SSE latency p95 does
not regress, and a flag-off deployment is byte-identical. One acceptance row
is the owner-handoff window: with a stale subscription and a new owner
coexisting, the old owner does no side effect and ACKs, and the new owner
still discovers and processes the pending item via SQL reconciliation without
receiving the MQ notification. The local machine has no container runtime, so
this slice is CI/cloud only by construction.

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
- No multi-node fault matrix (that is MQ3).
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
  notification.
