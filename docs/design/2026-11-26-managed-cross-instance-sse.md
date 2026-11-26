# Managed Cross-Instance Event Stream Wake-Up

[English](2026-11-26-managed-cross-instance-sse.md) | [简体中文](2026-11-26-managed-cross-instance-sse.zh-CN.md)

Status: implementation design, 2026-11-26. Current-state findings were checked against `main` at `baff3932e7`. This is one slice of running several Java control-plane instances behind a load balancer; it changes only how a Session event stream learns that new events exist. It implements the per-node watermark check sketched in [storage and event architecture §7.1](2026-09-20-managed-agent-storage-event-architecture.md#71-sse-and-multiple-instances), without the node-to-node notification in front of it.

## 1. Problem and current state

Every Session event is durable in SQL, and a stream connection resumes from its cursor on any instance. Only the "new events exist" signal is per process:

- The instance that runs a Turn writes its public events and, after commit, publishes them to the in-process `SessionEventHub`.
- A stream waits on that hub. When nothing arrives, it re-reads SQL after `qwen.managed-agent.events.poll-interval` (default 5 s).
- The MQ public-event lane only drives materialization on the receiving instance and never reaches its hub.

With several instances behind a load balancer, a stream connected to an instance that is not running the Turn sees streamed output in 5-second steps.

## 2. Goals and scope

Goals:

- A stream on any instance sees another instance's committed events within a few hundred milliseconds.
- No new infrastructure: no MQ, service discovery or node-to-node calls.
- No extra store reads for streams on the instance that wrote the events.
- Keep the existing cursor, replay, resync and fallback behavior.

Out of scope: the stream wire contract, the 5-second fallback setting, MQ EventTransport, and the other multi-instance gaps.

## 3. Design

### 3.1 Tail poller

Each instance runs one poller on its own thread, every 200 ms:

1. Take the Sessions that have a subscriber in this instance's hub. With none, read nothing.
2. Read their public event tails, `ma_event_stream.last_sequence` of the `SESSION` stream, in one query with `(tenant_id, session_id) IN (...)` pairs. A request over 500 Sessions is split into batches of 500.
3. For each tail that is new to the poller or larger than its last reading, notify the hub.

The poller forgets a Session once it has no subscriber, so a returning subscriber is notified again. A failed read is logged at debug level and the next tick tries again; streams fall back to their own poll interval meanwhile.

### 3.2 Hub notice

`notifyCommitted(session, lastSequence)` does nothing when the hub already holds events through that sequence, which is the case on the instance that published them. Otherwise it increments a per-Session notice counter and wakes waiters. A subscriber that sees a counter value it has not seen returns a delivery marked `overflowed`, the existing "read the store" signal, so the stream re-reads SQL from its cursor and resumes. The counter makes a notice that arrives while the stream is busy sending still take effect on its next wait, and only once.

## 4. Design decisions

| Decision                      | Choice                                                | Rationale                                                                                                                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signal source                 | Poll the durable tail in SQL                          | Needs no MQ or discovery; the tail is authoritative, so a missed tick only delays.                                                                                                                                                                                  |
| What the poller hands the hub | A notice; each stream re-reads from its own cursor    | Reuses the overflow path unchanged. The proposal in the multi-instance plan had the poller read events once and publish them; that would duplicate the stream's cursor, replay-floor and resync handling for the rare case of several local streams on one Session. |
| Notice bookkeeping            | Per-Session counter, per-subscription last-seen value | No lost wake-ups between a stream's read and its wait, and no busy loop.                                                                                                                                                                                            |
| Same-instance events          | Ignored when the hub already holds the tail           | The instance running the Turn adds no store reads.                                                                                                                                                                                                                  |
| Interval                      | Fixed 200 ms constant                                 | One indexed query per instance per tick, independent of the number of streams; no new setting until load testing asks for one.                                                                                                                                      |
| Thread                        | Dedicated single thread                               | Keeps the shared single-thread recovery scheduler free of a 5 Hz task.                                                                                                                                                                                              |

## 5. Risks and constraints

- Each instance with at least one open stream issues about five tail queries per second, regardless of how many streams it holds. The pairs match the leading columns of the stream table's business key, but index use at production scale has not been measured.
- A stream on a non-writing instance re-reads SQL once per tail change, at most once per tick, instead of receiving events from memory.
- A stream on a non-writing instance now sees events up to one tick (200 ms) plus one store read later than one on the writing instance.

## 6. Validation and acceptance

- H2 hub tests: a notice wakes a waiting subscriber with a store-read delivery; a notice that arrives before the wait is seen once; a notice for events the hub already holds is ignored; only open subscriptions are listed.
- H2 poller tests: a moved tail notifies and an unchanged one does not; no read without subscribers; a returning subscriber is notified again; a failed read does not stop later polls.
- Store tests on H2 and real MySQL 8.4 (`ManagedEventTailsMySqlIT`): tails are returned only for the requested tenant and Session pairs, and a request over the batch size is split correctly.
- Existing stream, replay and hub suites pass unchanged.
