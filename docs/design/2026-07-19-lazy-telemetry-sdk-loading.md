# Lazy-load the OpenTelemetry SDK off the ACP child startup path

- **Issue**: #4748 (Optimize daemon cold start and qwen serve fast-path latency)
- **Status**: implemented
- **Date**: 2026-07-19
- **Depends on**: #7182 (TUI module removal), the metafile audit below

## Problem

`channel.initialize` (~1035ms P50 on 2C4G) is the dominant cost of the daemon's
cold first Session, and ~67% of it is module loading in the ACP child. A
metafile audit of the post-#7182 bundle (commit `de962a5ecf`, esbuild metafile
with `DEV=true`) shows the ACP child's eager static closure is **17.24 MiB /
2420 modules**, of which the OpenTelemetry cluster is the single largest
coherent block:

| group                                                                  | bytes (post-tree-shake) |
| ---------------------------------------------------------------------- | ----------------------- |
| `@grpc/grpc-js`                                                        | 577 KiB                 |
| `@opentelemetry/otlp-transformer`                                      | 479 KiB                 |
| `protobufjs` + `long` + `@grpc/proto-loader`                           | 305 KiB                 |
| `@opentelemetry/sdk-metrics` / `sdk-node` / `sdk-trace-*` / `sdk-logs` | ~260 KiB                |
| `@opentelemetry/instrumentation-*` + `instrumentation`                 | ~132 KiB                |
| remaining `@opentelemetry/*` (exporters, propagators, resources, …)    | ~250 KiB                |
| **total telemetry cluster**                                            | **2.16 MiB**            |

Every byte of this is evaluated at ACP child startup even though:

1. Telemetry is **disabled by default** — the common case pays the full module
   tax for code that `initializeTelemetry()` then refuses to run
   (`!config.getTelemetryEnabled()` early-return at `sdk.ts:202`).
2. Even when enabled, nothing needs the SDK before the first span/log/metric,
   which is always after `initialize` has been ACK'd.

For calibration: #7182 removed 1.16 MiB and cut ACP import time 115→52ms
(-63ms). This cluster is nearly 2× that size, so an effect in the same order
is plausible — subject to the issue's measurement gate (below).

## Why the import chain is eager

`sdk.ts` statically imports everything at top level (`sdk.ts:13-32`): six OTLP
exporters (gRPC + HTTP × traces/logs/metrics), `NodeSDK`, batch processors,
`PeriodicExportingMetricReader`, and both instrumentations. `sdk.ts` itself is
reached statically from the core barrel via `telemetry/index.ts`, and cannot be
made wholly lazy because two hot-path modules statically depend on its cheap
state getter:

- `telemetry/loggers.ts:80` → `isTelemetrySdkInitialized()` (gates every log)
- `telemetry/session-tracing.ts:31` → same (gates every span helper)

So the split must separate the **cheap state facade** from the **heavy SDK
assembly**, not just wrap six exporter imports in `await import()` — the
`NodeSDK` / instrumentation / sdk-metrics imports (~0.7 MiB) are equally
removable and live in the same file.

## Design

### File split inside `packages/core/src/telemetry/`

**`sdk.ts` (stays; becomes the facade — no heavy imports).** Keeps, unchanged
in name and semantics, everything other modules statically reach:

- module state: `sdk`, `telemetryInitialized`, `telemetryShutdownPromise`,
  `activeMetricReader` (typed via `import type` so no runtime load)
- `isTelemetrySdkInitialized()`, `refreshSessionContext()`,
  `shutdownTelemetry()`, `forceFlushMetrics()`
- `resolveHttpOtlpUrl()` (exported, pure; no heavy deps)
- the `diag.setLogger(...)` side effect (only needs `@opentelemetry/api`,
  which is already ubiquitous and cheap — 56 KiB, also used by
  `loggers.ts`/`metrics.ts`)

Its only `@opentelemetry/*` runtime import is `@opentelemetry/api`.

**`sdk-impl.ts` (new; the heavy half).** Receives verbatim: the six OTLP
exporter imports, `NodeSDK`, `BatchSpanProcessor`, `BatchLogRecordProcessor`,
`PeriodicExportingMetricReader`, both instrumentations, `CompressionAlgorithm`,
`resourceFromAttributes`, `SessionIdSpanProcessor`, `parseOtlpEndpoint`,
`validateUrl`, `normalizeOtlpPrefix` + prefix matching, the propagator gate,
and the body of today's `initializeTelemetry()` from the resource build
onward. It exports one function:

```ts
export function startTelemetrySdk(config: TelemetryRuntimeConfig):
  | {
      sdk: NodeSDK;
      metricReader: PeriodicExportingMetricReader | undefined;
    }
  | undefined;
```

returning `undefined` on the existing "gRPC without base endpoint" skip path.
`file-exporters.ts` and `log-to-span-processor.ts` move behind `sdk-impl.ts`
too (they are only imported by `sdk.ts` today, and pull `sdk-logs`/
`sdk-metrics`/`sdk-trace-base`).

### `initializeTelemetry` becomes async

In the facade:

```ts
let telemetryInitPromise: Promise<void> | undefined;

export function initializeTelemetry(
  config: TelemetryRuntimeConfig,
): Promise<void> {
  if (telemetryInitialized || !config.getTelemetryEnabled()) {
    return Promise.resolve();
  }
  telemetryInitPromise ??= (async () => {
    const { startTelemetrySdk } = await import('./sdk-impl.js');
    const started = startTelemetrySdk(config);
    if (!started) return;
    sdk = started.sdk;
    // sdk.start() + telemetryInitialized = true + setSessionContext +
    // setShellTracePropagation + initializeMetrics — same order as today,
    // same try/catch that only logs.
  })().finally(() => {
    telemetryInitPromise = undefined;
  });
  return telemetryInitPromise;
}
```

Key properties:

- **Disabled path stays synchronous and free** — the `getTelemetryEnabled()`
  check runs before the dynamic import, so default-config users never load
  the 2.16 MiB cluster at all. This is the actual win for the ACP child.
- Single-flight guard (`telemetryInitPromise`) keeps the function idempotent
  under concurrent callers, matching today's `telemetryInitialized` recheck.
- `shutdownTelemetry()` needs no changes: it operates on the facade's `sdk`
  variable and already no-ops when `!telemetryInitialized`.

### Call-site treatment (all three production callers)

1. **`packages/core/src/config/config.ts:2192`** (Config constructor —
   synchronous context; this is the path the ACP child takes since
   `deferTelemetryInitialization` is false for ACP mode, see
   `packages/cli/src/config/config.ts:2075`). Fire-and-forget with a logged
   catch:

   ```ts
   void initializeTelemetry(this).catch(...)
   ```

   Risk analysis: the only consequence of late start is that spans/logs
   emitted in the gap are dropped by the `isTelemetrySdkInitialized()` gates —
   which is _already_ the behavior for the entire pre-constructor window and
   for the interactive TUI path, where telemetry init is deferred to a
   background task (`startup-prefetch.ts:259`). No new failure mode.

   Behavior change (intentional, documented): on the non-deferred paths — the
   ACP child and headless `-p` runs, where `deferTelemetryInitialization` is
   false — telemetry was previously fully registered by the time the
   synchronous `initializeTelemetry` call returned; it now settles
   asynchronously, so the existing drop window widens by the dynamic-import
   cost (~50–150ms). We do _not_ `await` here on purpose: awaiting would put
   the 2.16 MiB import back on the ACP child's critical path and undo the win.
   Callers that need telemetry guaranteed-ready before proceeding (the daemon
   runtime, caller 3) `await` explicitly.

2. **`packages/cli/src/startup/startup-prefetch.ts:261`** (deferred task
   runner). Change the task closure to return the promise
   (`() => initializeTelemetry(config)`) so `runDeferredTask`'s existing
   error handling observes rejections. Semantics otherwise unchanged.

3. **`packages/cli/src/serve/run-qwen-serve.ts:2925`** (daemon runtime).
   **Must `await`.** The very next line calls `initializeDaemonMetrics()`,
   and OTel's `metrics.getMeter()` caches a noop meter permanently if called
   before the SDK registers the global MeterProvider — daemon metrics would
   silently die. The enclosing function is already async, so `await
core.initializeTelemetry(...)` is a one-word change. This adds the
   module-load cost to the _daemon runtime_ load (deferred, off the
   fast path) only when telemetry is enabled — acceptable, and strictly
   better than paying it in every ACP child.

   The same ordering hazard exists in principle for `initializeMetrics()`
   (`metrics.ts:409`), but that is called _inside_ the init promise after
   `sdk.start()`, so ordering is preserved by construction.

### Bundle guard extension

Extend `scripts/check-serve-fast-path-bundle.js`'s ACP-boundary check
(`findAcpImportBoundaryOffenders`) with a telemetry blacklist so the split
cannot silently regress:

```
@grpc/grpc-js, @grpc/proto-loader, protobufjs,
@opentelemetry/otlp-transformer, @opentelemetry/sdk-node,
@opentelemetry/exporter-trace-otlp-grpc, @opentelemetry/exporter-logs-otlp-grpc,
@opentelemetry/exporter-metrics-otlp-grpc,
@opentelemetry/instrumentation-http, @opentelemetry/instrumentation-undici
```

(`@opentelemetry/api`, `semantic-conventions`, `core`, `resources`, `api-logs`
stay off the blacklist — they are legitimately reachable from `loggers.ts`,
`metrics.ts`, and type-level exports.)

## What this does NOT change

- No behavior change when telemetry is enabled — same exporters, same
  processors, same instrumentation hooks, same shutdown/flush semantics.
- No public API removal: `initializeTelemetry`'s return type changes
  `void → Promise<void>`, which is source-compatible for existing
  fire-and-forget callers (all call sites are updated in the same commit
  anyway; this is a core-package change, maintainer-authored per AGENTS.md).
- `telemetry/index.ts` barrel exports keep the same names.

## Acceptance (issue #4748 measurement gate)

Byte counts do not convert to milliseconds; the change must pass the issue's
standing discipline before merging:

1. **2C4G, 30 serial cold starts**, telemetry disabled (default config):
   compare `channel.initialize` P50/P95 and process→first-Session P50 against
   the `de962a5ecf` baseline. Ship only if P50 improves beyond run-to-run
   noise.
2. **Telemetry-enabled functional pass**: OTLP gRPC and HTTP targets each
   receive traces/logs/metrics after the change (existing
   `sdk.test.ts` matrix, plus one manual end-to-end against a local
   collector); `--telemetry-outfile` file exporters still write.
3. **Daemon metrics**: with telemetry enabled, daemon Status metrics ring and
   `initializeDaemonMetrics()` gauges still report (guards the await at call
   site 3).
4. **Bundle guard**: `node scripts/check-serve-fast-path-bundle.js` green with
   the extended blacklist; re-run the closure audit
   (`.qwen/scripts/acp-closure-audit.mjs`) and record the new ACP closure
   total (expected ≈ 17.24 − ~2.0 MiB, minus whatever `@opentelemetry/api` and
   friends keep eager).
5. **Unit tests**: `sdk.test.ts` awaits `initializeTelemetry` (15 call sites);
   tests asserting exporter construction move to or mock `sdk-impl.ts`.

## Alternatives considered

- **Lazy-import only the six exporter classes, keep `initializeTelemetry`
  sync.** Rejected: leaves ~0.7 MiB (`NodeSDK`, instrumentations,
  `sdk-metrics`, batch processors) eager for no reason, and still forces the
  async boundary somewhere — the enabled path constructs exporters
  unconditionally, so the function goes async either way.
- **Make the whole `telemetry/sdk.ts` module dynamic.** Rejected:
  `loggers.ts` and `session-tracing.ts` gate every telemetry call on
  `isTelemetrySdkInitialized()`; making that gate async would poison dozens
  of hot synchronous call sites.
- **Skip telemetry entirely in the ACP child.** Rejected in the issue already
  (blanket skips change observable behavior for users who enable telemetry).
