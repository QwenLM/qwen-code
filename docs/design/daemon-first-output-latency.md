# Daemon first-output latency

- **Tracking**: #7757
- **Background**: #7264
- **Scope**: daemon/ACP client-observable latency
- **Status**: Phase 1 measurement design

## Decision and scope

The first PR is measurement-only: an opt-in benchmark, pure classification/statistics helpers, tests, and versioned artifacts. It does not change production startup behavior.

A separate Provider-preparation prototype is allowed only if the single-bundle baseline passes its gate. Publishing that prototype then requires distinct control and candidate bundles to pass every latency, resource, functional, and cleanup gate in this document. A valid negative result ends the work.

The benchmark measures process spawn through first model-derived output while keeping local preparation, Provider request arrival, first output, first answer text, and terminal completion separate. The existing production `ttft_ms` remains unchanged: it still measures Provider dispatch to first visible content and does not absorb lazy loading or local prompt preparation.

Out of scope are TUI/Web Shell/editor rendering, prompt caching, compression, model thought/tool behavior, network preconnection, real-model latency optimization, production telemetry changes, public lifecycle APIs, protocol fields, configuration, and feature flags.

## Repository and runner contract

| Path                                                               | Responsibility                                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `integration-tests/cli/qwen-daemon-first-output-benchmark.test.ts` | Opt-in runner, fake Provider, isolated process lifecycle, baseline/compare protocols, and artifact writing |
| `integration-tests/cli/_first-output-benchmark.ts`                 | Pure event tracking, classification, percentiles, paired bootstrap, and decision inputs                    |
| `integration-tests/cli/_first-output-benchmark.test.ts`            | Deterministic tests for the pure contract                                                                  |
| `integration-tests/fake-openai-server.ts`                          | Existing fake Provider with opt-in connection closing for unbiased cold/warm measurements                  |

The runner is disabled unless `QWEN_FIRST_OUTPUT_BENCHMARK=1`. Its two input modes are mutually exclusive:

- **Baseline**: `BENCHMARK_CLI_PATH`.
- **Comparison**: both `BENCHMARK_CONTROL_CLI_PATH` and `BENCHMARK_CANDIDATE_CLI_PATH`.

`BENCHMARK_POST_SESSION_DWELL_MS` is comparison-only, accepts exactly `0`, `100`, or `500`, and defaults to `0`. `BENCHMARK_MEASURED_PAIRS` is also comparison-only and accepts exactly `10` or `30`; it defaults to `10` for the 500 ms diagnostic and `30` otherwise. A 500 ms run requires 10 pairs and the 0/100 ms runs require 30, so a diagnostic cannot be mislabeled as decision-bearing. Formal Phase 2 runs invoke the runner separately for the three dwell scenarios; samples from different dwell values are never pooled. Missing or mixed modes, identical comparison bundles, unreadable paths, unsupported dwell or pair counts, and mismatched dwell/sample plans fail as `invalid_configuration` before sampling.

The dwell is anchored to SSE readiness rather than session readiness. The SSE connect sits between the two, so anchoring to `sessionReady` would let a slow connect consume the whole window and silently reduce a 100 ms scenario to an immediate-prompt run that still reported its configured dwell. `sseReadyToPromptMs` records the idle window each sample actually received.

Millisecond-scale figures are only meaningful when nothing else competes for the host, so the runner is excluded from the shared integration config and has its own serial config at `integration-tests/vitest.firstoutput.config.ts` (`fileParallelism: false`, serial execution, `retry: 0`). The pure helper tests continue to run in the shared suite. Run the benchmark with:

```text
QWEN_FIRST_OUTPUT_BENCHMARK=1 QWEN_SANDBOX=false BENCHMARK_CLI_PATH=... \
  npx vitest run --config integration-tests/vitest.firstoutput.config.ts
```

Artifacts are written below `.qwen/investigations/daemon-first-output-benchmark/`, outside the integration harness's disposable run directory. This keeps successful, failed, and negative-result runs after global teardown without requiring `KEEP_OUTPUT`.

## Measurement contract

### One clock

All latency timestamps use `performance.now()` in the parent harness. No duration combines daemon, ACP-child, Provider, or wall clocks.

| Timestamp                  | Client-observable definition                                                       |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `processSpawnAt`           | Immediately before daemon `spawn`                                                  |
| `sessionReadyAt`           | Successful session response fully read and validated                               |
| `sseReadyAt`               | First SSE epoch callback observed; the dwell anchor                                |
| `promptStartedAt`          | Immediately before starting the non-blocking prompt request                        |
| `promptAcceptedAt`         | HTTP `202` body validated, including top-level `promptId` and replay cursor        |
| `providerRequestArrivalAt` | Fake Provider accepts the measured request, before its fixed delay                 |
| `providerReadyAt`          | Fixed 50 ms delay has elapsed, immediately before the response stream is available |
| `firstModelOutputAt`       | First qualifying SSE event for the accepted top-level `promptId` parsed            |
| `firstAnswerTextAt`        | First qualifying answer-text event parsed; nullable                                |
| `terminalAt`               | Matching `turn_complete` or `turn_error` parsed                                    |

The raw timestamps produce these exact metrics:

| Metric                              | Calculation                                     |
| ----------------------------------- | ----------------------------------------------- |
| `processToSessionReadyMs`           | `sessionReadyAt - processSpawnAt`               |
| `sseReadyToPromptMs`                | `promptStartedAt - sseReadyAt`, diagnostic      |
| `promptToProviderRequestArrivalMs`  | `providerRequestArrivalAt - promptStartedAt`    |
| `promptToFirstModelOutputMs`        | `firstModelOutputAt - promptStartedAt`          |
| `promptToFirstAnswerTextMs`         | `firstAnswerTextAt - promptStartedAt`, nullable |
| `providerReadyToFirstModelOutputMs` | `firstModelOutputAt - providerReadyAt`          |
| `promptToTerminalMs`                | `terminalAt - promptStartedAt`                  |
| `processToFirstModelOutputMs`       | `firstModelOutputAt - processSpawnAt`           |

`promptAcceptedAt` is diagnostic, not a latency origin: a Provider request or event may precede receipt of the HTTP `202`. Missing required timestamps, non-finite values, or negative durations invalidate the sample. The harness owns the 30-second SSE-readiness deadline; the SDK connect timeout is recorded and set five seconds later so timer ordering cannot change `sse_connect_timeout` into another failure code.

### Prompt and event correlation

The SSE collector is active before the prompt, or resumes from the cursor preceding it, and buffers a fixed number of events until the `202` yields the accepted top-level `promptId`. The acceptance envelope must contain a non-empty `promptId` and a non-negative integer `lastEventId`; a legacy synchronous result is recognized only by its `stopReason`, while any other malformed response is rejected. A prompt acceptance timeout aborts the underlying request before sample teardown. The collector then evaluates buffered and live events in original arrival order and accepts only an exact top-level ID match. Earlier, absent-ID, and unrelated prompt events are ignored; on buffer overflow the tracker latches the failure and stops buffering, so the sample is invalidated and the excess events are dropped.

Provider requests do not carry the daemon `promptId`. Each isolated fake Provider therefore permits only one expected measured request at a time and matches its unique fixed-length prompt sentinel. Its timestamp can be buffered before the `202`; an extra, missing, early, or concurrent request fails the sample.

The first qualifying event determines `firstOutputAt`:

| Event                                | Kind                                     |
| ------------------------------------ | ---------------------------------------- |
| Non-empty `agent_message_chunk` text | `answer_text`, and first-answer boundary |
| Non-empty `agent_thought_chunk` text | `thought_text`                           |
| Well-formed initial `tool_call`      | `tool_call`                              |

Non-empty means decoded text length is greater than zero; text is not trimmed or rewritten. Replay/status frames, local discrete messages (including slash-command and background-notification output), user echo, role- or usage-only chunks, compression diagnostics, malformed updates, and `tool_call_update` do not count. `turn_error` always fails. `turn_complete` before qualifying output also fails. The pure tracker allows valid thought- or tool-first turns with a null answer metric, while the live fake Provider must produce its known answer sentinel.

## Fake Provider and isolation

The loopback-only OpenAI-compatible fake Provider records request arrival, validates the request/model, waits for a configured 50 ms timer, records the actual elapsed delay and `providerReadyAt`, emits one streamed answer sentinel, and completes normally. Benchmark responses explicitly use `Connection: close`, so the warm turn cannot gain from a TCP connection opened by the cold turn; network preconnection remains outside the measured optimization. The delay separates local pre-request work from response/event propagation; it does not model a real latency distribution. Pure tests cover thought- and tool-first fixtures without adding nondeterminism to live runs.

Every baseline process and every comparison arm gets a fresh daemon/ACP process tree, workspace, home and `QWEN_HOME`, ephemeral daemon/Provider ports, event collector, and request ledger. Samples run serially.

Node compile caches are empty at formal-run start, isolated by bundle and mode, populated only by excluded warmups, and then reused only by that same bundle. The artifact records each cache directory for provenance, but a clean run removes it during teardown, so the recorded path is not expected to exist afterwards. Control and candidate never share them. Warmup observations remain in the artifact with `measured: false`.

The child starts from a minimal environment allowlist. It uses fixed locale/timezone, isolated writable paths, disabled telemetry/update checks, dummy Provider configuration, and cleared real credentials and proxy variables. The artifact records only deliberately supplied non-secret values.

Formal comparisons use release bundles built from the same lockfile on the same idle 2-vCPU Linux host. The artifact records resolved paths, SHA-256 hashes, source revisions when available, Node/OS/CPU/memory, and load metadata. Filesystem page cache and scheduler noise cannot be flushed reliably, so AB/BA ordering and the order-sensitivity gate are mandatory.

## Phase 1: single-bundle cold/warm baseline

Run 2 excluded warmup processes, then 50 measured processes. Each measured process:

1. creates a fresh `sessionScope: thread` session and sends one immediate fixed-length prompt (`cold`);
2. waits for its validated terminal;
3. keeps the first session open, creates a distinct `sessionScope: thread` session on the same ACP child process; and
4. sends one same-length prompt with a distinct sentinel (`warm`).

The runner records the ACP child PID after both turns and invalidates the sample unless exactly one unchanged child served them. Only after the second turn does it close both sessions. The second session therefore has a fresh per-session lazy Provider wrapper but warm ACP process-wide ESM/runtime caches. The pair bounds the one-time local cost of a process's first trip through the prompt path, without conversation-history confounding. Provider construction is one component of that cost; the first prompt also pays for the first daemon route hit, the first ACP IPC round trip, JIT warm-up, and any unrelated lazy import. The delta is therefore an upper bound on what preloading the Provider could recover, not an estimate of Provider loading, and a passing gate does not establish that the Provider accounts for any particular share of it. Attribution is what the Phase 2 paired comparison tests. Both sessions still construct their own Provider on prompt, so work the prototype may move into the dwell is not credited; the gate is conservative. Second-session process-to metrics are diagnostic.

The baseline expects exactly two Provider requests per process. All 50 cold/warm pairs must be valid. Cold and warm share a process, so their deltas are paired rather than independent samples, and the gate is decided on the paired median with its seeded bootstrap 95% interval:

```text
providerDelta[i] =
  cold promptToProviderRequestArrivalMs[i] -
  warm promptToProviderRequestArrivalMs[i]

providerDeltaCiLow = lower bound of the 95% CI of median(providerDelta)
```

Phase 1 passes when either:

```text
providerDeltaCiLow >= 25 ms
```

or:

```text
providerDeltaCiLow >= 10% * P50(cold promptToFirstModelOutputMs)
```

The lower bound rather than the point estimate must clear the threshold, so a delta that only just exceeds it cannot authorize a prototype on the strength of noise. The difference of the two P50s is still recorded for continuity but no longer decides anything. Cold is always the first session, so the pair cannot be order-balanced the way a Phase 2 comparison is; this is a known limitation of the construct, not an omission.

Otherwise the artifact is retained and production work stops.

## Comparison and statistics

Each comparison dwell uses 2 excluded warmup pairs followed by 30 measured pairs, except the explicitly diagnostic 500 ms scenario, which uses 10 and always reports an inconclusive top-level outcome. Odd pairs run control then candidate (AB); even pairs run candidate then control (BA). Each arm has fresh state, and every recorded delta is `candidate - control`, so negative latency is faster.

Failed arms remain in raw output and invalidate their pairs. They are not replaced. Sampling stops after the first invalid process or completed pair. The outer Vitest deadline is derived conservatively from the largest legal sample plan and every fixed lifecycle timeout, with scheduler margin, so even legal near-deadline samples cannot preempt artifact writing. Emergency teardown has its own fixed hook deadline. There is no outlier deletion, winsorization, subset selection, or Vitest retry. Any invalid primary pair invalidates the formal run.

For each metric, report nearest-rank P50/P90/P99 and mean for each arm, paired median delta, wins/ties, and AB/BA subgroup medians. P90/P99 are descriptive only at 30 pairs; no P95 or tail-latency conclusion is made without at least 100 pairs.

Two definitions of median coexist deliberately and a reader comparing columns should expect them to differ on an even number of samples. The per-arm `p50` is nearest-rank, so it is always an observed value. The paired `median delta`, and the medians resampled inside the bootstrap, average the two middle values on even counts. A Markdown row can therefore show a `p50` and a `median delta` that do not reconcile arithmetically without either being wrong.

The paired-median 95% confidence interval uses 10,000 seeded bootstrap resamples of valid pair deltas with replacement; seed and iteration count are stored. Its bounds are the nearest-rank 2.5th and 97.5th percentiles. Each metric's seed is offset by its position in the metric list, so inserting or reordering a metric shifts the bootstrap bounds of every later metric and makes artifacts on either side of the change incomparable even for identical raw samples; the per-metric stored `seed` keeps this auditable. `orderSensitive` is true when AB and BA median deltas have opposite signs and either absolute median is at least 10 ms. Order sensitivity makes the run inconclusive rather than being averaged away.

A paired artifact's top-level outcome describes only its primary metric in that one scenario. It does not evaluate the cross-scenario, resource, functional, or publication gates and cannot by itself authorize a Phase 2 pull request.

## Failures, artifacts, and cleanup

Every classified lifecycle or sample failure is retained and has one primary code:

| Code                              | Trigger                                                          |
| --------------------------------- | ---------------------------------------------------------------- |
| `invalid_configuration`           | Invalid mode, path, dwell, environment, or bundle identity       |
| `daemon_boot_timeout`             | No listening endpoint before deadline                            |
| `daemon_exited_before_listen`     | Daemon exited before readiness                                   |
| `session_create_failed`           | Error or malformed session response                              |
| `sse_connect_timeout`             | SSE not established before deadline                              |
| `sse_stream_ended`                | SSE ended before matching terminal                               |
| `prompt_accept_timeout`           | Prompt request did not finish before deadline                    |
| `prompt_rejected`                 | Error or malformed `202` response                                |
| `legacy_prompt_response`          | Endpoint completed synchronously instead of returning `promptId` |
| `event_buffer_overflow`           | Fixed pre-acceptance buffer exceeded                             |
| `provider_request_count_mismatch` | Extra, missing, early, or concurrent fake request                |
| `unexpected_output_kind`          | Answer-only live benchmark first emitted another output kind     |
| `first_output_timeout`            | No qualifying output before deadline                             |
| `terminal_before_first_output`    | Clean terminal without qualifying output                         |
| `turn_error`                      | Matching error terminal                                          |
| `terminal_timeout`                | No terminal after output before deadline                         |
| `wrong_final_text`                | Answer differs from sentinel                                     |
| `cleanup_timeout`                 | Owned resources did not stop by deadline                         |
| `residual_process`                | Tracked daemon/ACP descendant survived cleanup                   |
| `harness_error`                   | Unclassified harness invariant or I/O failure                    |

The first causal lifecycle failure stays primary; SSE/session and process cleanup failures are recorded separately and still invalidate the pair. Non-finite or negative timings are retained as a harness failure but normalized to `null` before aggregation, and failed runs never contribute to percentile or gate calculations. Fixed timeouts, request limits, and buffer capacity are serialized. Diagnostic messages and bounded stdout/stderr tails do not affect decisions.

Each invocation writes schema-version-1 `daemon-first-output` JSON plus Markdown derived only from that JSON. It contains run/platform/bundle identity, sanitized configuration, warmups, every raw relative timestamp and metric, latched first-output/answer/terminal event types and correlation counts, Provider request counts, invalid samples and pairs, failures, cleanup results, statistics/bootstrap/order summaries, and gate inputs with explicit decision reasons. Phase 2 resource runs extend their validation evidence with RSS measurements. Classified sample failures stay in their fixed sample slots; invalid configuration or an unclassified harness failure produces a fatal artifact. Artifacts exclude credentials, tokens, and prompt content beyond the non-secret benchmark sentinel.

Cleanup always aborts and awaits SSE, closes live sessions, captures ACP/MCP descendant PIDs, sends `SIGTERM` to the owned process group while its leader is still known live, and escalates the group only if that same leader survives the fixed grace period. Captured descendants and an enumeration-completeness latch stay attached to the active resource through emergency cleanup. Once the leader exits, cleanup never probes or signals its numeric process-group ID again because POSIX may reuse it; it only verifies the retained descendant set and fails safely if a descendant survives or enumeration was incomplete. Provider sockets close only after process teardown, and temporary state is removed only after both are verified. Cleanup never uses process-name-wide killing. Any invalid process or completed pair stops sampling immediately while retaining the failure. If an owned process or listener cannot be verified as stopped, the runner records the temp root deferred to emergency cleanup, marks a not-started counterpart when needed to preserve an invalid pair, and makes emergency teardown failure visible rather than silently dropping its tracked resource. Emergency teardown retries tracked processes and Providers before deleting deferred temp roots or compile caches.

## Phase 2: best-effort Provider preparation

### Behavior and boundary

The current lazy generator memoizes one loader promise across generation, streaming, token count, and embedding. Preparation may start that same promise early; it must not add another loader/Provider, make any model/token/embed request, refresh credentials, or change eager validation and Qwen OAuth credential timing. An immediate prompt must join the same promise.

A rejected preparation promise remains memoized so the first prompt observes the same failure. The detached caller may attach a rejection observer only to prevent an unhandled rejection; it must not clear or replace the stored promise. The capability stays internal to Core and does not extend the public `ContentGenerator` contract.

The earliest allowed trigger is the ACP child's successful write of a `session/new` result:

1. observe the received request ID;
2. observe a sent response with the same ID and `result`;
3. rely on the existing observation occurring only after `writer.write(frame)` resolves; and
4. schedule one unref'ed `setImmediate` that starts, but does not await, preparation.

Failed responses, authentication, `session/load`, `session/resume`, and other RPCs do not trigger it. No sleep is used to guess response delivery. ESM import is not cancellable, so a closed session may allow an already-started import to finish; it must still issue no request, retain no external resource, and produce no unhandled rejection.

This boundary is only best-effort. The daemon still performs session ownership/config/source persistence work and serializes the outer HTTP response after the child write. Provider import can contend on a 2-vCPU host and regress `processToSessionReadyMs`; `setImmediate` creates no cross-process happens-before relation. Session non-inferiority is therefore blocking. If it fails, stop rather than tune a timer. An exact outer-response-finished signal would cross HTTP transport, daemon bridge, and ACP child and needs a separate design only if the measured value justifies that complexity.

### Publication gates

Use distinct release bundles on the reference host:

| Scenario                     | Required result                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Fake, 0 ms dwell, 30 pairs   | 95% paired-median CI upper bound for both `processToSessionReadyMs` and `promptToFirstModelOutputMs` is `<= +10 ms` |
| Fake, 100 ms dwell, 30 pairs | `processToFirstModelOutputMs` paired median is `<= -10 ms` and its 95% CI upper bound is `< 0`                      |
| Fake, 500 ms dwell, 10 pairs | Diagnostic upper bound only; cannot compensate for another failed gate or independently justify merge               |

Across the 0 and 100 ms fake runs, all 60/60 pairs must be valid, with zero preload-window Provider requests, zero residual processes, and no order sensitivity.

Measure whole-process-tree RSS for 1, 4, and 16 idle sessions after Provider preparation has settled and before any prompt. Both gates must pass:

- single-session candidate-minus-control P50 RSS `<= +10 MiB`;
- candidate-minus-control incremental growth from 1 to 16 live sessions `<= +0.5 MiB` per additional session:

```text
((candidateRss16 - candidateRss1) -
 (controlRss16 - controlRss1)) / 15
```

Each idle-session probe creates sessions serially, waits for preparation to settle, and sends no prompt before RSS measurement; any Provider request fails it. Pair count and ordering are fixed in the Phase 2 validation artifact before formal measurement.

Only after all fake/resource gates pass, run real-Provider external validity on the same host: 30 AB/BA pairs at 100 ms plus a 10-pair immediate smoke. Functional/auth/streaming/answer failures block. Network uncertainty is reported but cannot override fake-local conclusions in either direction.

## Validation and decision

Phase 1 pure tests cover answer/thought/tool classification; local/replay/diagnostic exclusions; exact and pre-`202` correlation; buffer overflow; terminal/error paths; nullable answer metrics; nearest-rank percentiles; deterministic bootstrap; delta sign; invalid-pair retention; order sensitivity; representative fatal artifacts; and JSON-to-Markdown rendering. An opt-in release-bundle smoke validates Provider wiring, lifecycle, artifact schema, and cleanup. Formal benchmarks are not default CI.

A Phase 2 candidate additionally tests trigger timing and RPC filtering, single-flight with an immediate prompt, zero Provider requests/credential refresh, memoized rejection, non-blocking response write, and safe shutdown. It must pass build, typecheck, affected unit/integration tests, and the full artifact gates.

```text
50-process cold/warm baseline valid and threshold met?
├─ no  → retain artifact; stop
└─ yes → prototype separately
         └─ fake 0 ms non-inferior?
            ├─ no  → retain artifact; stop
            └─ yes
               └─ fake 100 ms materially faster with CI < 0?
                  ├─ no  → retain artifact; stop
                  └─ yes
                     └─ 60/60 valid + request/cleanup/order/RSS gates pass?
                        ├─ no  → retain artifact; stop
                        └─ yes
                           └─ real-Provider runs functionally pass?
                              ├─ no  → retain artifact; stop
                              └─ yes → optimization PR may be published
```
