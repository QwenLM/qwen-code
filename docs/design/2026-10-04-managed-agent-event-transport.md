---

# EventTransport: MQ Distribution for the Managed Agent Control Plane

[English](2026-10-04-managed-agent-event-transport.md) | [简体中文](2026-10-04-managed-agent-event-transport.zh-CN.md)

**Status: design reserved — 设计预留·未交付.** Nothing described in this
document is implemented. There is no `EventTransport` interface, no MQ client,
no consumer, and no multi-node wake anywhere in the repository. Every
architecture statement below is a forward-looking design reserve, not a
description of running code; each such section says so again in its heading.
This document changes no production behavior and ships no production code.

Part of [#12380](https://github.com/QwenLM/qwen-code/issues/12380), claiming
its deferred "optional MQ/Redis transport … later design scope". Follows the
Stage H tracker [#12827](https://github.com/QwenLM/qwen-code/issues/12827);
implementation phases are gated on
[#13300](https://github.com/QwenLM/qwen-code/issues/13300) (H0c review
follow-ups) and [#13265](https://github.com/QwenLM/qwen-code/issues/13265)
(H3 background Shell and Monitor runtime, which settles the durable task-event
and cancel semantics the wake path carries).
Canonical upstream design: the pinned extension-runtime document at
`6891216`,
[managed-agent-extension-runtime.md](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md)
(section 1 and the architecture flow).
Related in-repo design: the
[storage and event architecture](2026-09-20-managed-agent-storage-event-architecture.md)
already sketched a conceptual Java
`EventTransport { publish(CommittedBatch); consume(ConsumerSpec, BatchHandler) }`
with "RocketMQ or Redis Streams", explicitly left as "proposed follow-up work"
("external EventTransport, PostgreSQL adapter, multi-instance wakeup … remain
proposed follow-up work"). This document is the detailed successor for that
deferred scope, narrowed to the #12380 claim.
Baseline: `main` at `5ddfacc9d4` (2026-10-04).

## 1. Problem and scope

The Managed Agent proposal assigns the Java control plane the product-level
durable resources: definition revisions, run records, Session routing, the
outbox, lease generations, quotas, and public projections. Today the whole
post-commit distribution path is single-process: on the Java side the
after-commit fan-out is the in-process `SessionEventHub`, and on the TypeScript
side session activation is the in-process `EmbeddedHarnessScheduler` over
file-backed activation leases. Neither can notify another Java node.

Shared-SQL **projection** materialization between Java nodes is **covered
today, at the projection layer** — `MessageMaterializer` polls on a
scheduled SQL scan (default 100 ms) and runs its `materializeNextBatch`
projection batch; a projection worker on node B recomputes the committed
rows node A wrote, in one poll interval. That strict limitation is also the
shape of the remaining need: the existing path only recomputes projections —
it **does not wake a Harness**, and no `wake.requested` activation,
delivery receipt, or `domain.committed` fact reaches another node through
it (the in-process `EmbeddedHarnessScheduler` inside each host keeps wake
local; the in-process hub's `SessionEventHub` buffer likewise stays local).
What is **still absent** is the distribution of committed facts on commit:
for a background Shell follow-up routed to node A, node B's Harness never
gets woken — not by the scan (which recomputes projection batches only),
not from the journal (whose facts persevere in-session only), and no
activation generator exists between them. The earlier statement that a
materialization worker on B "learns nothing" was accurate only at the
wake-delivery layer; at the projection layer, the shared-SQL read is the
counter-evidence this paragraph already corrected.

The canonical design already names the missing element. Its architecture flow
reads (verbatim):

```text
外部事件 / 定时触发 / 子任务结果 / Monitor 变化
                    │
                    ▼
Java 可信入口 → SQL 事务提交领域记录 + outbox + WakeIntent
                    │ after commit
                    ├──────────────→ EventTransport → 物化 / 跨节点唤醒
                    ▼
              Session Authority
```

This document designs the **introduction of that `EventTransport`**, with
RocketMQ LiteTopic as the candidate production implementation and Redis Streams
as the retained alternative named by #12380. The transport distributes
notifications of already-committed facts — wake intents and committed record
pointers — so that a sibling Java node can attempt activation (through the
Session Authority's activation fence) or run materialization without any
database polling.

**Scope of this slice (now).** Design only: the invariants, the conceptual
message envelope, a verified candidate comparison, a phase plan with explicit
gates, and a deployment fault matrix. No code changes accompany this document.

**Out of scope (permanently, for this slice).**

- Any MQ client, producer, consumer, or configuration wiring.
- A second synchronous event path. The browser-facing path stays
  `Harness SSE → Java bounded batch → SQL commit → Java SSE → browser`;
  per #12380, "MQ is not on the synchronous frontend path or the authority
  for model history", and "MQ delay cannot block local post-commit SSE".
- PostgreSQL support, broader orchestration, and the H0/H1–H6 capability
  slices themselves.
- The event-envelope wire schema versioning machinery: the envelope is pinned
  by a separate TypeScript contract slice (shared fixtures, Java fixture
  consumer) that follows the pattern of
  `packages/core/src/managed-runtime/contracts/`.
- Real-broker acceptance on a developer machine. There is no local container
  runtime; every real-broker check belongs to CI or a cloud environment.

## 2. Invariants

These invariants are taken verbatim (concept-for-concept) from section 1 of
the pinned extension-runtime design and from the #12380 ownership table. They
bind every later phase of this slice; a design detail that violates one of
them is wrong regardless of broker capability.

1. **MQ distributes only already-committed facts.**
   _"MQ 只分发已经提交的事实，不成为 Session 真相或浏览器游标。"_
   Every message a producer sends is derived from rows committed in the same
   SQL transaction. The transport never becomes the Session's truth, and it
   never becomes the browser's cursor: SSE cursors and replay floors stay
   SQL-sequence-based exactly as they are today.

2. **Every asynchronous capability is a durable resource plus a trigger
   intent.** _"所有异步能力都是'持久资源 + 触发意图'。内存 callback、
   Promise、PID、notified=true、本地 sidecar 或 MQ offset 都不是恢复凭据。"_
   An MQ offset, a stream position, an ACKed delivery, or a consumer's
   in-memory progress is never recovery evidence. Recovery always replays from
   SQL: the committed event sequence, the extension-record delivery line, and
   the activation store. The transport only shortens the delay until a
   consumer looks at that truth.

3. **The SQL outbox stays the source of truth.**
   Domain intent, necessary resource references, the outbox, and the wake
   intent commit in the same Session transaction where possible —
   _"领域 intent、必要资源引用、outbox 和 WakeIntent 尽量在同一 Session 事务
   提交；跨 Session 使用发送方 outbox、接收方幂等接受与 ACK，明确不承诺跨库
   原子。"_ The Java schema already encodes the delivery line of a Stage H
   record in `qwen_managed_session_extension_record`
   (`delivery_target`/`delivery_state`), written by the committing
   transaction itself. MQ publication is strictly after commit and strictly
   a projection of those rows.

4. **`domain.committed` stays the single extension-domain commit carrier.**
   _"已有 `domain.committed` 保持唯一扩展领域提交载体。"_ The transport does
   not introduce a second domain-commit channel; it carries pointers to
   commits, never new commits.

5. **Consumers are idempotent under re-delivery, keyed by committed
   sequence.** A re-delivered, duplicated, or reordered message must be a
   no-op against the durable watermark: the consumer's decision key is the
   committed `(tenantId, sessionId, sequence)` read from SQL, not anything the
   broker reports. This mirrors the existing `SessionEventHub` discipline
   (`overflowed` → subscriber re-reads the store).

6. **Unknown side effects are not blindly retried.**
   _"未知副作用不盲重试。"_ A wake whose target Session is already assigned,
   fenced to another epoch, or settled is a no-op; activation admission and
   the activation fence decide, not the message.

### Ordering, per key

The ordering key is `(tenantId, sessionId)`. The design **explicitly does not
require ordered MQ delivery** of those keys: correctness rests on the
committed per-Session sequence and on consumers reconciling against SQL, so
an unordered at-least-once transport cannot corrupt a Session — it can only
waste latency. Per-key FIFO (one Session = one LiteTopic, or one Redis
stream) is used, if the selected broker verifiably provides it, purely as a
latency optimization that shrinks how often a consumer must re-read the
store. No phase gate may depend on a FIFO guarantee this document could not
verify.

## 3. Current state: seams and gaps

Evidence is in Appendix A; every path below was read on `5ddfacc9d4`.

- **Java after-commit seam — EXISTS, and it is only half of the lane.**
  `CommittedEventPublisher` (one method, `publish(List<EventRecord>)`) is
  injected into `ManagedAgentStore` and invoked from a Spring
  `TransactionSynchronization.afterCommit()` hook
  (`ManagedAgentStore.java` lines 2403–2411). Its only implementation is
  `SessionEventHub`, an in-process per-Session bounded buffer
  (capacity 512, overflow flagged so subscribers re-read the store) feeding
  the Java SSE path. **But this seam sits on the public `managed_agent_event`
  stream.** The authoritative Session journal — `domain.committed`,
  `wake.requested`, tool receipts and the commit markers an EventTransport
  must carry — is committed by `ManagedSessionStore.commit` against the
  private journal (`qwen_managed_session_journal_tx`), a different code path
  and a different family of events. An `EventTransport` producer adapter
  therefore needs TWO wires, not one: the after-commit hub fan-out for the
  public event stream, and a publication point on the authoritative Session
  commit transaction for journal facts (same-transaction commit, after-commit
  drain) — the MQ2 phase wires the second and never relabels the first as
  covering it.
- **Dedicated transport abstraction — DOES NOT EXIST IN CODE.** A code search
  for `EventTransport`/`eventTransport`/`RocketMQ` returns zero matches
  outside design documents. There is no transport configuration property, no
  outbox-drain loop aimed at a broker, and no multi-node wake consumer. The
  name exists only in the 2026-09-20 storage-and-event design (conceptual
  interface, proposed follow-up work — see the header).
- **TypeScript embedded scheduler — NO seam by design.**
  `EmbeddedHarnessScheduler` pumps activations from
  `FileManagedActivationStore` leases inside one process and schedules
  recovery wake-ups with in-process timers (`scheduleRecoveryWake()`). The
  committed `wake.requested` record kind exists in
  `managed-session-records.ts` and is committed with its Session input in one
  transaction (Session authority). The multi-node deployment unit named by
  the proposal and by the canonical design is the Java control plane, so the
  transport seam is defined Java-side; this document does not add a broker to
  the embedded TypeScript path.
- **Record/projection plumbing ready for distribution.** `EventRecord` already
  carries the distributable identity fields (`tenantId`, `sessionId`,
  `sequence`, `eventId`, `turnId`, `type`, `createdAt`, schema/projection
  versions); the extension record store persists a per-record delivery line
  (outbox state) next to each committed revision; `MessageMaterializer`
  performs the async Item/Snapshot materialization that the design's
  "物化" consumer would trigger on other nodes.

## 4. Envelope contract (conceptual) — 设计预留·未交付

The envelope below is **conceptual and will be pinned by a separate TypeScript
contract slice** (versioned schema plus fixtures, a TypeScript gate test, and
a Java fixture consumer — the house pattern for cross-language contracts). The
fields and prohibitions here are the design inputs to that slice.

```text
ManagedEventEnvelope/1 (concept):
  envelopeId       stable id of this publication occurrence (dedup hint only)
  tenantId         routing + dedup key part
  sessionId        routing + ordering key part
  sequence         committed per-Session event/record sequence
  kind             durable record/event kind, e.g. 'domain.committed',
                   'wake.requested', or the committed change the envelope
                   announces
  commitEpoch      committed epoch the enclosed facts belong to
                   (activation/lease generation family; consumers fence on it)
  committedAt      database commit timestamp (advisory; DB clock only)
  payloadRefs      identity references (record resource id, payloadRef,
                   artifact refs) — what consumers pull from SQL/object stores
  schemaVersion    envelope schema version

Explicitly forbidden in any envelope:
  secret material (tokens, credentials, SecretHandles); local absolute paths;
  raw PIDs; runtime endpoint identities (pods, addresses); model history or
  tool payload bytes; browser-visible cursor state.
```

Rationale for the prohibitions, per invariant 1 and #12380 ("Full tool bytes
do not belong in token-event rows, SSE frames, or MQ payloads"): the envelope
is a pointer that shortens latency. Anything whose disclosure would widen the
trust boundary, or whose reconstruction the broker could fake, is read back
from the authoritative store by the receiving node.

## 5. Candidate analysis — 设计预留·未交付

### 5.1 Verification ledger

Only this much is **verified from public documentation** (fetched 2026-10-04
from the Apache RocketMQ documentation front page, `rocketmq.apache.org/docs/`):

- Apache RocketMQ documents a **"Million-Scale LiteTopics"** feature: millions
  of lightweight, per-session topics with minimal resource overhead, aimed
  explicitly at AI-Agent session management, built on RocksDB indexing for
  fine-grained state isolation and lifecycle management.
- One AI-Agent conversation session maps to one LiteTopic; application servers
  stay stateless and a reconnecting client resumes a session from a
  breakpoint.
- Per-LiteTopic consumer-level **Suspend/Resume** operations exist, enabling
  millisecond-level per-session rate limiting and anomaly isolation.
- A **"Lite Mode Subscription"** is documented as a lighter subscription model
  for AI scenarios (lower resource consumption than traditional
  subscriptions).

**UNVERIFIED** (not checked into this design as facts; to be re-verified from
broker/client documentation or a staging deployment before phase MQ2 starts):

1. LiteTopic delivery guarantee (at-least-once? at-most-once?) and retry /
   redelivery semantics — the direct doc pages are absent (404) at fetch time.
2. LiteTopic ordering semantics (whether per-topic FIFO is guaranteed).
3. LiteTopic consumer-group model and offset management, retention, and
   per-topic lifecycle (creation/deletion API surface, limits, quotas).
4. Java client availability and version pins for LiteTopic in our deployment
   baseline; commercial (Aliyun) LiteTopic limits and pricing.
5. RocketMQ classic semantics (at-least-once consumption with ACK/retry,
   ordered messaging per message group) are well documented for classic
   topics, but **their carry-over to LiteTopic is UNVERIFIED**.

For Redis Streams, standard and documented semantics apply (treated as
verified for the purpose of this table): per-stream FIFO; consumer groups via
`XREADGROUP` with `XACK`; re-delivery of un-ACKed entries through the pending
entries list (`XPENDING`/`XCLAIM`/`XAUTOCLAIM`); explicit retention
(`XTRIM`). Deployment concerns (durability under AOF settings, memory cost of
millions of streams, cluster scaling) are listed as characteristics, not as
verified guarantees for any particular Redis deployment.

### 5.2 Capability table

| Capability                                            | RocketMQ LiteTopic                                                      | Redis Streams                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Per-Session addressing (one topic/stream per Session) | Designed for it (million-scale, per-session)                            | Possible; one stream per key, memory cost grows with live streams |
| At-least-once delivery                                | UNVERIFIED for LiteTopic; classic RocketMQ consumption is at-least-once | Yes via consumer groups + PEL re-delivery                         |
| Per-key ordering                                      | UNVERIFIED (not required by design; see §2)                             | Yes, per-stream FIFO                                              |
| Re-delivery / crash recovery of consumers             | UNVERIFIED                                                              | Yes via `XAUTOCLAIM`/`XCLAIM` after a timeout                     |
| Consumer groups (multi-node workers, wake fan-in)     | UNVERIFIED for LiteTopic                                                | First-class                                                       |
| Suspend/Resume per Session (backpressure, quarantine) | Documented (per-topic consumer-level)                                   | Manual (stop reading the group key)                               |
| Retention & lifecycle of millions of queues           | Documented as designed for it; API/limits UNVERIFIED                    | Operator-managed (`XTRIM`, key expiry); risk of unbounded growth  |
| Broker as Session truth risk                          | Same architectural risk both ways; invariants 1–3 forbid it regardless  | Same                                                              |
| Ops profile                                           | Broker cluster; Java client                                             | Single Redis / cluster; already in many deployments               |
| Named by #12380                                       | Yes ("RocketMQ or Redis Streams")                                       | Yes                                                               |

### 5.3 Selection

**Candidate production implementation: RocketMQ LiteTopic**, because its
documented model (per-Session lightweight topic, stateless application
servers, breakpoint resume, per-Session Suspend/Resume) matches the wake
distribution shape (one active routing per Session, millions of mostly-idle
Sessions) far better than running one Redis stream per Session would. **Redis
Streams stays the documented alternative** named by #12380 and is the
fallback if MQ2-start verification (§7) fails LiteTopic on delivery or
ordering semantics. This selection follows the 2026-09-20 storage-and-event
design's operational guidance: prefer an existing RocketMQ platform rather
than deploying MQ only for SSE, keep SQL batch scanning as the no-MQ
materialization path, and never run Redis as a second default message
dependency alongside RocketMQ. Because §2 requires no ordering and §4 forbids
truth on the broker, the final choice can be swapped behind the same seam
without touching Session semantics.

## 6. Delivery and consumer idempotence — 设计预留·未交付

Producer path (design reserve): after a Session's SQL transaction commits,
the store's existing after-commit fan-out also hands the committed envelopes
to the configured transport producer. Publication failure or delay never
blocks the local post-commit SSE (#12380 constraint); the durable delivery
line in SQL remains complete, and any missed notification is recovered by
SQL-side scans, exactly as a missed in-process `SessionEventHub` publish is
today (overflowed → re-read).

Consumer path (design reserve): on each Java node, wake consumers attempt
Session activation through the Session Authority — the activation fence and
the lease generation decide; the envelope only accelerates the attempt.
Materialization consumers trigger the same materialization the in-process
path performs (`MessageMaterializer` today, single-node). Every consumer:

- dedups on `(tenantId, sessionId, stream, sequence)` against the durable
  watermark it re-reads from SQL, where `stream` names one of the two
  independent sources and is carried on the envelope: `public_event` rows,
  whose `sequence` is the row's `sequence_id` allocated from
  `managed_agent_session.last_sequence`, and `authoritative_journal` facts
  (`domain.committed`, `wake.requested`, receipts, commit markers), whose
  `sequence` is the record's own journal-commit sequence from
  `qwen_managed_session_journal_tx` — two counters that never compare across
  streams, so an envelope always names its stream;
- on a sequence gap, re-reads the Snapshot-plus-tail from SQL before applying
  anything newer (the `SessionEventHub overflowed` discipline, generalized);
- writes no recovery-relevant state whose durability depends on the broker;
- treats a wake for a settled, re-routed, or differently-fenced Session as a
  no-op. Below-stream dedupe keys are never unified: one `sequence` without
  a source is not an identity.

## 7. Phase plan and gates

| Phase                                   | Content                                                                                                                                                                                                                       | Prerequisite                                                                                                                           | Exit check                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MQ0 (now)**                           | this design; conceptual envelope; verified selection matrix; scope claim filed on the #12380 tracker                                                                                                                          | none; runs in parallel with the H lanes                                                                                                | bilingual design merged; tracker issue records the claimed slice; zero code changes                                                                                         |
| **MQ1 — introduce the seam**            | name and extract the `EventTransport` adapter behind the existing after-commit hook; default composition keeps today's in-process `SessionEventHub` fan-out; smallest possible diff, no behavior change, no broker dependency | #13300 (H0c review follow-ups) merged and #13265 (H3) semantics for durable task events/cancel settled, so the envelope keys are final | existing commit-path and SSE tests unchanged and green; no new runtime dependency; deployment with the seam behaves identically                                             |
| **MQ2 — Java producer/consumer wiring** | outbox-drain → MQ producer; wake + materialization consumers; consumer dedup by committed sequence; behind a default-off configuration flag (`qwen.managed-agent.event-transport.*`)                                          | MQ1; broker semantics re-verified per §5.1 ledger (LiteTopic UNVERIFIED items resolved, else Redis Streams)                            | single-broker E2E in CI/cloud env: duplicate and reorder injection are no-ops; post-commit SSE latency p95 does not regress; flag-off deployment is byte-identical behavior |
| **MQ3 — deployment fault matrix**       | §8 matrix executed against a two-node control plane plus broker, in CI or a cloud environment (no local container runtime exists)                                                                                             | MQ2                                                                                                                                    | all matrix rows green, including flag rollback; results attached to the tracker issue                                                                                       |

The separate TypeScript contract slice that pins the envelope schema lands
into MQ1 (gate test + Java fixture consumer), keeping the contract-first
house pattern. MQ2+ may **not** start with UNVERIFIED rows open against the
selected broker.

## 8. Deployment fault matrix — 设计预留·未交付

| Fault                                             | Required behavior                                                                                                                                                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate delivery of one envelope                | Consumer dedup `(tenantId, sessionId, stream, sequence)` against the SQL watermark; the duplicate is a no-op. Activation enqueue stays idempotent. The `stream` is the delivered lane (`public_event` from `last_sequence`, `authoritative_journal` from the journal-commit sequence). |
| Reordered delivery within one Session             | The per-stream sequence watermark + gap detection; consumer re-reads Snapshot-plus-tail from SQL before applying anything newer. A later record never lands ahead of an unseen earlier one from MQ alone.                                                                              |
| Broker redelivery after processed-but-ACK-lost    | Same as duplicate delivery.                                                                                                                                                                                                                                                            |
| Consumer crash before processing                  | Broker redelivers (per selected broker's at-least-once path — must be verified in §5.1 before MQ2); the Session is woken late but from SQL truth.                                                                                                                                      |
| Consumer crash after a local effect, before ACK   | Duplicate path on restart; every local effect is idempotent on committed identities.                                                                                                                                                                                                   |
| Producer crash between SQL commit and publish     | Message never sent; the committed SQL delivery line is still complete. Recovery comes from SQL-side scans (overflow/re-read discipline), as today for `SessionEventHub`. MQ is not recreated as an outbox of truth.                                                                    |
| Broker short outage                               | Producer retries with bounded buffer; local post-commit SSE unaffected; wake latency degrades only.                                                                                                                                                                                    |
| Broker long outage                                | Transport consumers idle; Sessions are still discoverable by SQL scans and lease-fencing; no capability data loss because no truth lives on the broker.                                                                                                                                |
| Clock skew between Java nodes                     | Fencing and leases use the database clock (the house lease pattern); envelope `committedAt` is advisory only.                                                                                                                                                                          |
| Stale wake after a Session re-route or epoch bump | Activation fence rejects; no-op.                                                                                                                                                                                                                                                       |

## 9. Constraints and risks

- **Nothing here may appear on the synchronous frontend path.** SQL failure
  surfaces with bounded backpressure (#12380); MQ failure must surface only as
  wake/materialization delay.
- **Do not let the broker become the browser cursor.** SSE replay cursors and
  the persisted replay floor stay SQL-based (V14 `managed_event_replay`
  pattern).
- **LiteTopic semantics risk.** §5.1 lists UNVERIFIED delivery/ordering
  items; if verification fails, MQ2 falls back to Redis Streams under the same
  seam rather than relaxing the invariants.
- **Wake-intent carrier.** The canonical design names `WakeIntent`; the repo
  today carries the committed `wake.requested` record kind, and #12827's open
  question 3 (Session inbox vs new record) stays unsettled until #13300 lands.
  This design intentionally does not pick the carrier.
- **Scope hygiene.** Each phase records its slice and exclusions on the
  tracker, per #12380's claiming rule.

## 10. Validation plan and acceptance criteria

This slice's validation is documentation-only:

- [x] Canonical invariants quoted verbatim from the pinned `6891216` design
      and restated as binding rules (§2).
- [x] Every "current state" claim backed by a repository path read on
      `5ddfacc9d4` (§3, Appendix A); the seam verdict is evidence-based.
- [x] Broker capability claims split into verified vs UNVERIFIED, with fetch
      sources and dates (§5.1).
- [x] Bilingual pair kept structurally aligned (README rules).
- [ ] Bilingual design merged; tracker issue (draft at
      `.qwen/issues/managed-agent-event-transport-mq.md`) filed by its owner,
      recording the claimed slice on #12380's snapshot.

## 11. Open questions for the tracker issue

1. Wake-intent carrier: keep the committed `wake.requested` record as the
   wake envelope source, or a distinct WakeIntent record (supersedes #12827
   question 3 once #13300 lands)?
2. Which node consumes a Session's envelopes — a consumer-group-per-Session
   routing scheme, or hash-partitioned wake workers? (Decision needed before
   MQ2 consumer wiring.)
3. LiteTopic §5.1 UNVERIFIED items: who runs the broker-docs/staging
   verification, and where are the results pinned?
4. Envelope naming/fields: folded into the separate TypeScript contract
   slice; this document's §4 is its input, not its output.

## Appendix A. Code inventory (evidence for the seam verdict)

Read on `5ddfacc9d4` (2026-10-04). One line per resident responsibility.

| Path                                                                                        | Resident responsibility                                                                                                          | Transport seam?                  |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `packages/sdk-java/managed-agent-server/.../store/CommittedEventPublisher.java`             | one-method after-commit fan-out interface `publish(List<EventRecord>)`                                                           | **YES — this is the seam**       |
| `packages/sdk-java/managed-agent-server/.../store/ManagedAgentStore.java` (lines 2403–2411) | invokes `eventPublisher.publish(events)` from `TransactionSynchronization.afterCommit()`                                         | seam call site                   |
| `packages/sdk-java/managed-agent-server/.../service/SessionEventHub.java`                   | sole implementation: in-process per-Session bounded buffers (cap 512), `overflowed` → re-read store; feeds Java SSE              | in-process only                  |
| `packages/sdk-java/managed-agent-server/.../store/StoreModels.java` (`EventRecord`)         | committed event identity: `tenantId, sessionId, sequence, eventId, turnId, type, …, createdAt, schemaVersion, projectionVersion` | —                                |
| `packages/sdk-java/managed-agent-server/.../store/ManagedExtensionRecordStore.java`         | Stage H record persistence; checks `domain.committed`; per-record delivery (outbox) line                                         | NO (persistence, no publication) |
| `packages/sdk-java/managed-agent-server/.../db/migration/V18__managed_extension_record.sql` | `qwen_managed_session_extension_record` incl. `delivery_target`/`delivery_state` written in the committing transaction           | NO (SQL truth)                   |
| `packages/sdk-java/managed-agent-server/.../db/migration/V14__managed_event_replay.sql`     | persisted replay floor backing SSE cursor recovery                                                                               | NO                               |
| `packages/sdk-java/managed-agent-server/.../service/MessageMaterializer.java`               | async Item/Snapshot materialization (the "物化" consumer's current in-process form)                                              | NO                               |
| `packages/core/src/managed-runtime/managed-session-inbox.ts`                                | durable Session inbox (`tenantId/sessionId/messageId`, states admitted/processing/finished)                                      | NO                               |
| `packages/core/src/managed-runtime/managed-session-records.ts`                              | committed record index incl. `wake.requested` and `domain.committed` kinds                                                       | NO                               |
| `packages/core/src/managed-runtime/managed-session-authority.ts`                            | commits Session input + wake intent in one transaction; reads the task projection                                                | NO                               |
| `packages/core/src/managed-runtime/embedded-harness-scheduler.ts`                           | single-process activation pump over file leases; `scheduleRecoveryWake()` in-process timer                                       | NO (process-local by design)     |
| `packages/core/src/managed-runtime/managed-activation-store.ts`                             | activation descriptors, leases, fences, epochs                                                                                   | NO                               |
| `packages/core/src/managed-runtime/managed-extension-projection.ts`                         | `ManagedSessionTaskView` projection incl. outbox/delivery state                                                                  | NO                               |

**Verdict: PARTIAL.** A Java after-commit seam exists
(`CommittedEventPublisher`, currently exactly one in-process implementation);
a dedicated `EventTransport`/wake abstraction exists nowhere in code (code
search yields zero matches; the 2026-09-20 design sketch is a document, not
code) and must be introduced at MQ1 behind that seam.
The TypeScript embedded scheduler is process-local by design and gains no
broker dependency from this slice.
