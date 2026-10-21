# Hosted event stream liveness (#14135)

[English](2026-10-18-hosted-event-stream-liveness.md) | [简体中文](2026-10-18-hosted-event-stream-liveness.zh-CN.md)

Status: implemented in this change. Delivers [#14135](https://github.com/QwenLM/qwen-code/issues/14135), the heartbeat half of [#13302 item 2](https://github.com/QwenLM/qwen-code/issues/13302#issuecomment-6117110640) (decision 3 in #12380), and finding 1 of [H4f](2026-10-10-managed-task-cancel.md)'s real-stack acceptance. The model, tool and Turn operation budgets stay with #13302 item 2.

## Problem

A Hosted Harness event stream that goes half-open was read forever. This happens when the Harness dies behind a network partition, or when its pod moves to another node. The Java Turn reader (`HarnessCoordinator.readStream`) blocked in `HarnessEventStream.next`, and nothing ended that read except a local close. #13877 made the close lock-free, so a generation adoption that some later call noticed did end it. A partition with no generation change, or a restart that no other call touched, still left the reader parked, and the Turn's coordinator wait with it.

## Current state before this change

#13314 landed both halves of the mechanism on 2026-10-16:

- **Harness:** `GET /session/:id/events` writes a `: keepalive` comment every 15 seconds, so a Turn that commits no event still puts bytes on the wire. The route also sends `X-Accel-Buffering: no`, so a buffering proxy does not hold them back.
- **Java:** `HarnessEventStream` runs an idle watchdog bounded by the builder's `sseIdleTimeout` (45 seconds by default; `Duration.ZERO` disables it). It charges silence only while a consumer is parked in `next()`, and every byte the reader pulls, keepalive comments included, resets it.

Four things were still missing:

- The client armed the bound against any Harness. One that predates the keepalive is silent through every quiet phase of a healthy Turn, so in a rolling upgrade the bound would abort those streams over and over.
- The abort was a generic `DaemonTransportException`. Its message was the only thing that told it apart from a reset socket.
- The watchdog checked every half bound, so an abort could land up to 67.5 seconds after the last byte.
- No probe ran on the packaged chain.

## Decisions

1. **Numbers.**
   - The Harness keepalive stays at 15 seconds, the cadence of the primary route.
   - The client bound stays at 45 seconds, three keepalive periods. So two keepalives can go missing in a row, and the third gap still has a full period of slack.
   - The watchdog now checks every tenth of the bound (4.5 seconds at the default, never more often than every 100 ms). An abort therefore lands 45 to 49.5 seconds after the last byte.
   - Measured on the packaged chain: see Validation.
2. **Capability.**
   - The Harness advertises the keepalive as the `event-keepalive/1` entry of `hostedHarness.features` in `GET /capabilities`.
   - The client arms the watchdog only when that entry is present. Against a Harness without it, the read stays unbounded, as before the keepalive, whatever `sseIdleTimeout` says.
   - The other direction of a rolling upgrade already works: an older client's SSE reader skips comment frames.
   - `event-keepalive/1` is informational, like `model-selection/1`. It does not enter the operator-set capability digest.
3. **Liveness outcome.**
   - The abort is `HostedHarnessStreamIdleException`, a `DaemonTransportException` that carries the bound. It is thrown to the reader parked when the bound expired, and to any caller that arrives after it.
   - `HarnessCoordinator` treats it like any transient stream failure. The Turn is scheduled for a retry, and the retry re-attaches through the existing recovery load and resumes the stream from the recorded cursor.
   - The silence never settles or cancels the Turn. As for every failure after admission, retries without journaled progress count toward `max-post-admission-retries`, and the Turn ends as `hosted_harness_unavailable_after_admission` only when they run out.
   - Operators tell the outcomes apart by the `failure=` label of `Managed Turn coordination will retry …`:

     | Label                              | Meaning                                                                       |
     | ---------------------------------- | ----------------------------------------------------------------------------- |
     | `HostedHarnessStreamIdleException` | The liveness timeout.                                                         |
     | `IllegalStateException`            | The Harness ended the stream before a terminal event.                         |
     | `DaemonTransportException`         | A reset or refused connection.                                                |
     | `DaemonProtocolException`          | A protocol error. This one fails the Turn as `hosted_harness_protocol_error`. |

4. **Other Hosted streams.** None needs the same treatment:
   - **Java to the Harness:** the events route is the only long-lived stream. Every other `HostedHarnessClient` call is a request bounded by `request-timeout` (30 seconds) or `load-timeout` (120 seconds).
   - **The Harness to the Spring Store:** every call is a request with its own per-attempt deadline (`AbortSignal.timeout` in `http-managed-session-store.ts`).
   - **Spring's public SSE:** it already writes `keepalive` comments (`ManagedEventStreamService`). Bounding its silence belongs to each public client.
   - **The Harness's model stream:** it has its own idle bound (`QWEN_STREAM_IDLE_TIMEOUT_MS`, 240 seconds), which is one of #13302's model budgets.

## Boundaries

- No public REST API, contract version or schema change. The Java SDK gains one public class, `HostedHarnessStreamIdleException`.
- A liveness timeout proves only that the stream went silent. It never proves that the work stopped, and it never authorizes a replay. The re-attach resumes from the recorded cursor, and an ambiguous recovery stays recovery-blocked, as before.
- The non-hosted `DaemonSessionClient` keeps its own watchdog, unchanged.
- The Spring server keeps the SDK default bound; there is no new property. A deployment behind an intermediary with a shorter idle timeout than 15 seconds needs that intermediary changed, not the bound.

## Validation

- **SDK unit tests** (`HostedHarnessClientTest`, `HarnessEventStreamCloseTest`):
  - An idle peer fails with the typed outcome and its bound.
  - A keepalive-only peer outlives the bound (probe 1 against a fake peer).
  - A consumer stall between reads is not charged (probe 3's delay inside tolerance).
  - The abort lands inside the published window (probe 3's delay past it).
  - A Harness without `event-keepalive/1` keeps the read unbounded (probe 6).
  - Each check was mutation-tested: dropping the gate, a half-bound tick, and each of the three untyped throw sites each fail exactly the test that names them.
- **Coordinator unit test** (`HarnessCoordinatorTest.anIdleStreamRetriesTheAdmittedTurnWithoutSettlingIt`): pins that the outcome schedules a retry, never fails or cancels the Turn, and logs the typed label.
- **Packaged chain** (`HostedEventStreamLivenessIT`): Spring on MySQL 8.4, the packaged Hosted Harness, and a TCP relay between them that can hold the events connection half-open or stall it. It runs the shipped numbers.

  Four runs, three on JDK 25 and one on JDK 21 (MySQL 8.4.6, Linux x86_64), measured:
  - **A quiet Turn (probe 1).** The keepalive gaps at the relay were 14,999 to 15,000 ms through a 55-second quiet phase. No idle retry fired, the Turn kept its one stream, and the model ran once.
  - **A SIGKILL behind a half-open relay (probe 2).** The idle retry fired 48.0 seconds after the last byte reached Spring (48,017 to 48,044 ms), inside the 45 to 49.5 second window. The reader was released, and the Turn went to a retry.
  - **A cancel during a quiet read (probe 4).** The Turn settled as `CANCELLED` through the cancel command, with no idle retry.
  - **A stalled stream with a live Harness (probe 5).** The stream timed out once and re-attached once. The model ran once, and the Turn completed once.
  - **The class** took 214.4 to 215.0 seconds.
  - **Negative control.** With the watchdog never armed, probe 2 fails with `idle retry timed out`. That reproduces the original finding.

## Follow-up work

None for this item. The operation budgets remain #13302 item 2.
