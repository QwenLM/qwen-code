# EventTransport MQ3: the deployment fault matrix

[English](2026-10-14-managed-agent-event-transport-mq3.md) | [简体中文](2026-10-14-managed-agent-event-transport-mq3.zh-CN.md)

> **Wake recovery update (2026-10-19):** The earlier source-ledger-only
> fallback described here is superseded by the
> [Hosted SQL wake scan](2026-10-18-hosted-wake-recovery.md). It discovers
> committed, unconsumed monitor/background Shell, channel, child/workflow,
> automation and Session-message inputs after writer loss. Public foreground
> Turns still belong to their dispatcher; private CSI and other sources retain
> their existing recovery paths. Real MQ-on and deployed/cross-platform scan
> acceptance remain unverified. The historical MQ gates below do not prove this
> new scan; its fault acceptance is specified in the linked design.

> **Status:** Implemented as a gate. This is phase **MQ3** of the cross-node
> EventTransport design
> ([2026-10-04-managed-agent-event-transport](2026-10-04-managed-agent-event-transport.md),
> §7), tracked under [#12380](https://github.com/QwenLM/qwen-code/issues/12380).
> Its prerequisite, MQ2, landed in four slices
> ([2026-10-12-managed-agent-event-transport-mq2](2026-10-12-managed-agent-event-transport-mq2.md)):
> MQ2a [#13940](https://github.com/QwenLM/qwen-code/pull/13940), MQ2b
> [#14029](https://github.com/QwenLM/qwen-code/pull/14029), MQ2c
> [#14080](https://github.com/QwenLM/qwen-code/pull/14080) and MQ2d
> [#14109](https://github.com/QwenLM/qwen-code/pull/14109). MQ3 changes no
> production code. Its rows assert the as-built behavior; where that differs
> from §8's required behavior, the findings below record it.

## Problem

MQ2 ran every row it named against one application on H2 with a stand-in
Harness. The parent design's §8 matrix is about deployments: more than one
control-plane node, processes that die at awkward points, a broker that stops
answering, clocks that disagree, and a flag that has to come off. Those rows
only mean something against real processes. MQ3 runs them against two
control-plane nodes, each with its own packaged Hosted Harness, sharing one
MySQL database and one RocketMQ 5.5 LiteTopic cluster. It records, row by row,
what the as-built transport does — including where that differs from §8's
"required behavior" text.

## Current state

Read on `a6af39188a` (2026-10-14).

- **Topology.** Every node joins the shared wake-bootstrap group on one
  bootstrap lite topic, and the shared owner group on the lite topic of each
  Session its own Harness writes. The listener returns — and the client
  acknowledges — after the SQL checks and the claim, with the load queued on a
  small pool.
- **Producers.** Both wires send asynchronously and catch every failure. The
  only retries are the client's own (three attempts in all, a three-second
  request timeout); there is no application retry and no outage buffer. The
  journal hand-off runs on the committing thread; the public hand-off copies
  the batch onto a 1024-batch queue, also on the committing thread.
- **Startup.** The capability probe, the send probe, the owner consumer and
  the bootstrap subscription all need a reachable broker; any failure fails
  the Spring context.
- **Clocks.** The wake decisions and the journal writer lease read the
  database clock. The Turn dispatch lease and the relay ledgers' leases are
  stamped with the JVM clock.
- **Fence.** No epoch travels with a wake. Past the checks every wake meets
  (a known Session, the journal's workspace, a committed sequence, a Session
  and journal not settled), a stale wake is refused only by a live writer or
  by the claim watermark.

## Design: the gate

`EventTransportMultiNodeGate` (profile `event-transport-multi-node-gates`,
SDK Java job "EventTransport multi-node gates / RocketMQ 5.5.1 + MySQL 8.4 /
Java 21", failsafe family `event-transport-multi-node`).

- **A node** is a packaged Hosted Harness (the CLI's hosted-harness serve
  profile, with a fake model) plus the whole application in its own JVM,
  started through `EventTransportNodeMain`. Each row starts its own nodes,
  writer lease 6 s and Turn dispatch lease 6 s, so a dead node's holds lapse
  within the row. All nodes of the class share one isolated MySQL database;
  each row uses a fresh tenant. A crash kills the node's JVM and its Harness
  with SIGKILL; a restart keeps the node's address.
- **Fault points** are test-only subclasses the node JVM swaps in for the
  production beans: the wake activator (halt on receiving a wake; halt after
  claiming it, before the listener returns), the journal wire (halt after the
  commit of a record that carries a wake, before it is handed to the broker)
  and the public wire (halt after committing the batch that carries
  `turn.completed`, before the hand-off). A fault is armed for one Session by
  a file and fires once across both nodes; a fired fault calls
  `Runtime.halt`, so nothing is acknowledged, flushed or shut down. A
  hold-load fault instead parks every load of its Session, on every node,
  until the gate releases it. The broker outage freezes the gRPC proxy with
  SIGSTOP, after checking that the recorded pid is the one listening on the
  endpoint. The clock-skew row moves the application JVM's wall clock with
  libfaketime (Linux, CI) and checks that it moved; the node's Harness keeps
  the host clock. Without libfaketime that row is skipped: the wake path reads
  no Clock bean, so nothing short of the JVM's own clock can test it.
- **Evidence.** Each node appends every wake decision, load outcome and
  hand-off it makes to its own evidence file. The gate asserts on that, on
  SQL (`ma_session_head` writer, generation and lease, `ma_event_stream`
  watermarks, the committed journal) and on the public API, and reads what
  reached the bootstrap lane — and, where a row watches it, the Session's own
  lane — through its own oracle group. Per-row logs and evidence are uploaded
  with the reports. Every wait fails fast once its row's timeout fires, and
  the rows' timeouts fit the fork's. The broker must be the run's alone.

## Rows

| §8 fault                                            | Injection                                                                                                                                                                              | What the gate asserts                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate, reorder, redelivery after a lost ACK     | With both nodes in the bootstrap group, a Session's committed wakes re-sent after its writer lapsed — the newer twice, then the older — with the load held until all three are decided | `SCHEDULED`, `DUPLICATE`, `DUPLICATE`, wherever they land; watermark = the newer; then one `ACTIVATED` through a real Harness load; writer generation +1, the writer is the activating node's Harness                                                                                                                           |
| Consumer crash before processing                    | The receiving node halts on the wake before reading anything                                                                                                                           | Nothing claimed; the broker hands the wake to the other node, which activates the Session once                                                                                                                                                                                                                                  |
| Consumer crash after a local effect, before the ACK | The receiving node claims the wake and halts before its listener returns                                                                                                               | The watermark holds the claim; the redelivery reaches the other node and is `DUPLICATE`; no load there; new input still runs there                                                                                                                                                                                              |
| Producer crash between commit and publish (journal) | The node whose Harness commits the Turn's input halts after the commit, before the wake is sent                                                                                        | The wake is committed, reaches neither the bootstrap lane nor the Session's and is never claimed; the Turn dispatcher settles the Turn on the other node, once                                                                                                                                                                  |
| Producer crash between commit and publish (public)  | The node recording the Turn's last batch halts after committing it, before the hand-off                                                                                                | No later notice follows, so only the other node's scheduled pass projects it: the committed `turn.completed` is served, the log has no gap, `covered_sequence = last_sequence`, and the items carry the input and the reply                                                                                                     |
| Broker short outage                                 | The proxy is frozen while a Turn runs                                                                                                                                                  | The Turn completes; both hand-offs on the committing thread stay under 250 ms; the next Turn's wake reaches the broker once the proxy is back                                                                                                                                                                                   |
| Broker long outage                                  | The proxy is frozen across a node restart                                                                                                                                              | Once sends are seen failing, a running node still serves Turns — a held Session's and a new Session's first — with both hand-offs under 250 ms; a node restarted with the flag on refuses to start; the same node, now alone, restarted flag-off starts and serves; after the outage, restarted flag-on, it carries wakes again |
| Clock skew between Java nodes                       | One node's JVM wall clock 10 minutes ahead, then another's 10 minutes behind                                                                                                           | Ahead: another node's live writer is still `OWNED`, nothing claimed; behind: a lapsed writer is still lapsed, the Session activates there, and the lease it is granted is live by database time                                                                                                                                 |
| Stale wake after a re-route                         | The Session moves to the other node's Harness; its old wake is re-sent                                                                                                                 | `OWNED` wherever it lands; the watermark stays empty, no load, the writer unchanged                                                                                                                                                                                                                                             |
| Flag rollback                                       | Both nodes restarted flag-off, then flag-on                                                                                                                                            | Flag off: Turns run as before, nothing reaches either lane, and a wake sent meanwhile stays unconsumed; flag on again: that wake is consumed and the next wake is published                                                                                                                                                     |

## Findings

Findings 1–3, 5 and 6 are where the as-built behavior differs from §8's
text; 4 and 7 are as-built properties the rows rest on.

1. **A crash with a wake in flight stalls the bootstrap lane for about two
   minutes.** LiteTopic gives a crashed member's unacknowledged message to
   another member only once the broker expires the dead client (its channel
   expiry, two minutes by default), and the lite topic's later messages wait
   behind it in order. Measured locally with a probe of two members of one
   group: the held message reached the other member after 124 s, and a
   message sent five seconds after the crash arrived with it; across the
   local runs of the gate's two crash rows the wake moved after 121–129 s.
   On the shared bootstrap lane that is every Session's wake, cluster-wide.
   Nothing is lost — every wake arrives late — and no input ledger depends on
   the lane. A node killed while holding no unacknowledged message did not
   hold the lane: the next wake reached the other node within the row's
   window. (§8: "broker redelivers; the Session is woken late" — true, but
   late is minutes, for every Session.)
2. **No producer retry buffer.** Against a hung proxy (frozen with SIGSTOP),
   the client's own attempts, three seconds each, ride out a pause of a few
   seconds — in the local short-outage runs, a Turn's worth of freeze,
   nothing was dropped — but an envelope sent while the proxy stays away
   longer is dropped with a `WARN` naming the event and is never sent later
   (13 journal and 4 public envelopes in one local run of the long-outage
   row). The commit path is untouched: both hand-offs on the committing
   thread stayed in single-digit milliseconds during the freezes. (§8:
   "producer retries with a bounded buffer" — not built; a wake lost in an
   outage recovers through its ledger.)
3. **Startup needs the broker.** A node restarted while the broker is down
   refuses to start on the capability probe, whose message leads with the
   LITE group and topic requirements and names the endpoints property only
   last; the way back is the flag. The long-outage row asserts this refusal,
   so a fix inverts it. (§8: "transport consumers idle" holds only for nodes
   already running.)
4. **A claim is never rolled back.** A crash after the claim burns that
   notice. The original source-ledger fallback is superseded for eligible
   committed wakes by the [Hosted SQL scan](2026-10-18-hosted-wake-recovery.md);
   the historical MQ3 gate does not establish that new scan's MQ-on acceptance.
5. **No epoch fence.** A stale wake is refused by a live writer or by the
   watermark; on a free Session with a higher sequence it loads it — harmless,
   because the wake pump runs only what the journal holds.
6. **The Turn dispatch lease is on the JVM clock.** A node whose clock runs
   ahead by more than the dispatch lease reads live claims as lapsed and takes
   Turns over; in a local run with a node ten minutes ahead it took a live
   Turn, hit the holding Harness's writer lease on every attempt and failed
   the Turn when its retries ran out. This is outside the transport — the
   clock-skew row keeps Turns away from the skewed node — and is recorded here
   because §8 claims the house lease pattern for every lease.
7. **A takeover of a Turn whose Harness stopped at the model call is
   refused.** In the runs of the journal producer-crash row the Turn was
   settled on the other node as failed (`managed_runtime_recovery_blocked`,
   reason `model_start`): a decline the Harness makes from the journal, which
   the transport plays no part in. The row asserts only that the Turn
   settles, once.

## Scope boundaries

- No production change. Findings 1–3 and 6 are recorded here for follow-up;
  finding 4's later recovery implementation and remaining acceptance are
  described in the Hosted wake design linked above.
- No sharding of the bootstrap lane, no shorter broker channel expiry and no
  producer buffer in this phase.
- Workspace-bound Sessions, tools and the runtime broker are not exercised:
  the rows use plain public Sessions, which keeps the gate portable. The
  public lane's duplicate and reorder rows stay with MQ2d's single-node gate,
  and the concurrent claim race with `EventTransportConsumerSqlTest`.

## Validation

- `EventTransportMultiNodeGate` runs locally (macOS, MySQL 8.4.7, RocketMQ
  5.5.1), where the clock-skew row is skipped for want of libfaketime, and in
  a new job of the SDK Java workflow (ubuntu-latest, a MySQL 8.4.6 service,
  libfaketime), which runs every row and fails on a skipped one. Like the
  rest of that workflow the job runs daily and on demand, not per pull
  request (#14205). Before this change was proposed the job's definition ran
  on a GitHub-hosted ubuntu-latest runner from a fork: all ten rows passed,
  the clock-skew row included.
- Mutation checks: each row is run against a deliberately broken build and
  must fail — the clock-skew row's on that Linux runner; the pull request
  lists the mutants and their results.
- `scripts/tests/event-transport-multi-node-ci.test.js` pins the job, the
  profile, the broker provisioning, the gate's required properties and its
  timeout budget to one another; the failsafe report check's
  `event-transport-multi-node` family fails the job unless the gate class ran
  in full.
