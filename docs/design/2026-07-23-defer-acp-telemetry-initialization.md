# Defer ACP telemetry initialization until after protocol initialization

- **Issue**: #7264 candidate 2
- **Scope**: telemetry-enabled ACP child startup
- **Status**: implemented and validated

## Problem

An ACP child currently starts telemetry from the `Config` constructor. The call is fire-and-forget, but loading and evaluating the telemetry implementation and configured exporter chain still competes for the same event loop and CPU as CLI bootstrap, ACP module loading, bootstrap config initialization, and the protocol `initialize` handler. On a constrained host, candidate 1's measurements showed that this contention adds work back to the user-visible initialization window.

Telemetry events already use an initialized gate: events emitted before the SDK finishes starting are dropped. Deferring the start therefore extends an existing loss window rather than introducing a new buffering or ordering model.

## Design

ACP configuration sets the existing `deferTelemetryInitialization` option. This suppresses the constructor's fire-and-forget start without changing the default, headless, stream-JSON, interactive TUI, or daemon runtime paths.

`runAcpAgent` uses the existing message-observation hook on its NDJSON transport to remember the JSON-RPC ID of an incoming `initialize` request. The hook runs after the parsed request is enqueued but before its pending read continuation can handle it. For outgoing messages, the same hook runs only after the encoded response has been successfully written to the underlying stdout stream. When a successful response with the remembered ID is observed, the child starts telemetry through the existing single-flight facade and clears the remembered ID.

This creates a transport-defined boundary: telemetry loading cannot begin before the initialization response write resolves. It does not depend on event-loop scheduling assumptions.

## Ownership and downstream consumers

The ACP child has one process-global telemetry SDK and one bootstrap `Config`. The deferred option is config-scoped, while the eventual initializer is process-global and single-flight. Per-session configs continue sharing that process-global SDK and do not own independent telemetry runtimes.

The affected consumers are:

- **ACP bootstrap child**: changes from constructor-started telemetry to response-write-started telemetry.
- **ACP session creation and prompts**: retain the existing initialized gates; very early events may now be dropped for longer while SDK loading finishes.
- **Ordinary interactive TUI**: retains post-first-render startup through `startPostRenderPrefetches`.
- **Headless and stream-JSON CLI**: retain constructor startup.
- **`qwen serve` parent/daemon runtime**: retains its explicit deferred core-runtime initialization and shutdown.
- **Process exit cleanup**: retains `Config.shutdown()`. A child that disconnects before a successful protocol initialization never starts telemetry. If disconnect races a just-started import, the initializer's internal catch prevents an unhandled rejection and the ACP outer path still exits the process; current config cleanup does not promise to flush an SDK that has not finished initializing.

## Failure and compatibility behavior

- Telemetry disabled remains a facade no-op after the response and loads no heavy telemetry modules.
- A malformed or rejected `initialize` request does not start telemetry. A later valid initialize request can still start it.
- A stdout write failure does not run the sent-message hook, so telemetry is not started for a response the client did not receive.
- Repeated or unrelated JSON-RPC responses cannot start telemetry because the request ID and successful-response shape must both match; the remembered ID is consumed once.
- SDK loading remains fire-and-forget and best-effort. Its existing implementation catches import, assembly, and startup failures.
- No protocol shape, capability, authentication timing, provider selection, MCP behavior, or telemetry configuration surface changes.

## Alternatives rejected

- **Start inside `QwenAgent.initialize()`**: this is before the handler returns and therefore before the SDK can serialize or write the response.
- **Use `queueMicrotask`, `setImmediate`, or a timer after the handler returns**: none proves that the SDK's private write queue has completed, and a timer adds an arbitrary latency policy.
- **Wrap or fork `AgentSideConnection`**: unnecessary because the package-local NDJSON stream already exposes post-write message observations.
- **Wait until the first session response**: could remove more contention but widens the dropped-event window beyond candidate 2 and never initializes telemetry for an idle initialized channel.
- **Buffer early telemetry**: materially changes telemetry semantics and memory ownership; candidate 2 explicitly accepts dropped early events.

## Verification

Unit tests cover ACP config deferral and the exact transport ordering: no start on receipt, unrelated response, error response, or failed write; one start after the matching successful response has been written. Existing transport tests prove sent hooks run after the underlying write and are skipped on write rejection.

The release bundle is exercised through the real ACP parent/child path with telemetry enabled and disabled. Compatibility checks cover cold and preheated channels, concurrent first sessions, legacy single-session mode, early disconnect, cleanup, and outfile record production.

The change lands only if it passes #7264's 2C4G gate: 30 alternating paired serial cold starts reporting `channel.initialize`, child process to initialize response, cold session request, process to first session, peak RSS, preheated behavior, and telemetry on/off compatibility. Because work moves later rather than disappearing, the gate must report both initialization and first-session timing; a gain that is merely repaid before the first session is not treated as a successful optimization.

## Results

The control was `origin/main` at `14f1f2bb365280a6e1d4a45b452f7992f1928187`; the candidate was the same commit plus this exact working-tree change. Both release bundles were built from the same lockfile and tested on the supplied Linux host with 2 vCPUs, approximately 3.5 GiB RAM, no swap, and bundled Node.js 22.23.1.

With outfile telemetry enabled, 30 alternating paired cold starts produced:

| Metric                               | Control P50 / P95  | Candidate P50 / P95 | P50 delta    |
| ------------------------------------ | ------------------ | ------------------- | ------------ |
| `channel.initialize`                 | 968.0 / 1029.2 ms  | 923.8 / 958.9 ms    | **-44.2 ms** |
| Child process to initialize response | 973.8 / 1034.9 ms  | 928.9 / 964.2 ms    | **-44.9 ms** |
| Cold `POST /session`                 | 1284.9 / 1348.2 ms | 1285.7 / 1330.0 ms  | +0.7 ms      |
| Process to first session             | 1908.0 / 1986.9 ms | 1907.0 / 1978.0 ms  | -1.0 ms      |
| Peak RSS                             | 414.1 / 446.4 MiB  | 410.6 / 438.6 MiB   | -3.6 MiB     |

The paired distribution showed `channel.initialize` faster in 28 of 30 pairs with a -53.0 ms paired-median delta. Cold session request and process-to-first-session remained neutral: their paired-median deltas were -13.2 ms and +0.4 ms respectively, with wins split 17/30 and 15/30. The change therefore improves the direct ACP initialization boundary without imposing an end-to-end regression when a session is requested immediately; it does not claim a cold process-to-session improvement.

The formal 30-pair preheated run had two isolated candidate session outliers, so the preheated phase was repeated for another 30 pairs. In the replication, `channel.initialize` improved from 963.2 / 1018.0 ms to 906.9 / 940.8 ms P50/P95. The already-preheated session request changed from 81.7 / 86.0 ms to 83.4 / 90.4 ms, while process-to-session remained neutral at 3694.1 / 3721.9 ms versus 3694.3 / 3719.0 ms. The first run's outliers did not recur; the replication's paired session median was +1.8 ms and process-to-session median was -0.6 ms. RSS moved in opposite directions across the two preheated runs, so no preheated memory change is claimed.

Candidate functional runs passed concurrent first sessions, telemetry disabled with zero records, and legacy single-session mode. Every telemetry-enabled run reported a valid startup profile, and every run exited without a residual process. Two telemetry-enabled live-prompt smokes against the available OpenAI-compatible endpoint both completed and produced non-empty telemetry outfiles. Direct bundled-ACP smoke tests also passed both early-disconnect boundaries: EOF before initialize exited cleanly without starting telemetry, while EOF immediately after a successful initialize response exited cleanly after creating the outfile, with no stderr output in either case.

Raw host artifacts are under:

- `/root/qwen-7264-c2-20260723/results/formal/2026-07-23T03-03-41.303Z`
- `/root/qwen-7264-c2-20260723/results/preheated-replication/2026-07-23T03-12-45.750Z`
- `/root/qwen-7264-c2-20260723/results/prompt-smoke/2026-07-23T03-23-26.883Z`
