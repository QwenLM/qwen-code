# Telemetry exporter protocol split (lazy SDK phase 2)

- Status: implemented
- Issue: QwenLM/qwen-code#7264 (candidate 1), follow-up to #4748
- Predecessor: `2026-07-19-lazy-telemetry-sdk-loading.md` (facade / impl split)

## Problem

Phase 1 moved the whole telemetry SDK behind a dynamic `import()`, so
telemetry-off processes load nothing. But telemetry-**on** processes still load
`sdk-impl.ts`'s full static closure, which bundles both OTLP protocol chains
regardless of which one the config selects:

| Cluster                                                                                                              | Size (metafile, de962a5ecf + phase 1) | Needed by                            |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------ |
| gRPC chain (`@grpc/grpc-js`, `protobufjs`, `@grpc/proto-loader`, `exporter-*-otlp-grpc`, `long`, `lodash.camelcase`) | 1121 KiB / 125 modules                | `otlpProtocol: 'grpc'` only          |
| HTTP chain (`exporter-*-otlp-http`)                                                                                  | 23 KiB / 17 modules                   | `otlpProtocol: 'http'` only          |
| Shared OTLP layer (`otlp-transformer`, `otlp-exporter-base`)                                                         | 915 KiB / 41 modules                  | both OTLP protocols, **not** outfile |

The metafile shows two static importers of the OTLP surface outside the
exporter packages themselves:

1. `sdk-impl.ts` (its `CompressionAlgorithm` import) — removed by moving
   exporter construction into the protocol modules.
2. `@opentelemetry/sdk-node` itself — its `utils.js`/`sdk.js` eagerly
   `require()` every exporter package (otlp proto/http/grpc × 3 signals,
   zipkin, prometheus) to support `OTEL_*_EXPORTER` env-based
   auto-configuration. qwen-code never reaches those code paths: it always
   passes explicit `spanProcessors` / `logRecordProcessors` (an empty array
   still short-circuits the env fallback). Handled by a bundle-time stub,
   see below.

With both cut, the split drops the entire OTLP surface from the outfile
path, the gRPC chain from the HTTP path, and the HTTP chain from the gRPC
path.

The 2C4G benchmark for phase 1 showed why this matters: with telemetry on
(outfile), the dynamic load of sdk-impl competes for CPU with session setup on
2 cores (`config_construction`/`bootstrap` +50 ms), eating most of the −50 ms
import-chain win. Shrinking what actually loads shrinks that contention.

## Design

Two new modules own exporter construction, loaded via dynamic `import()` from
`startTelemetrySdk` only on their respective config branch:

- `packages/core/src/telemetry/sdk-exporters-grpc.ts`
  - Imports the three gRPC exporters + `CompressionAlgorithm` +
    `PeriodicExportingMetricReader`.
  - `createGrpcExporters(endpoint)` → `{ spanExporter, logExporter, metricReader }`,
    all gzip-compressed, matching current construction exactly.
- `packages/core/src/telemetry/sdk-exporters-http.ts`
  - Imports the three HTTP exporters + `PeriodicExportingMetricReader` +
    `LogToSpanProcessor`.
  - `createHttpExporters({ tracesUrl, logsUrl, metricsUrl, logToSpan })` →
    `{ spanExporter?, logExporter?, metricReader?, logToSpanProcessor? }`.
    The logs→spans bridge decision (logs endpoint absent, traces present)
    moves here with it, since the bridge constructs an HTTP trace exporter.

`sdk-impl.ts` changes:

- Drops all six exporter imports and `CompressionAlgorithm`; exporter
  variables are typed against the SDK interfaces (`SpanExporter`,
  `LogRecordExporter`) it already depends on.
- `startTelemetrySdk` becomes `async`. Branch order is preserved:
  - gRPC without a base endpoint still returns `undefined` **before** any
    protocol module loads.
  - HTTP URL validation (`validateUrl`) stays in `sdk-impl.ts`; the HTTP
    module is only imported when at least one signal URL survives validation.
  - The outfile branch touches neither protocol module.
- The facade awaits `startTelemetrySdk` (it already runs inside the
  single-flight async closure, so no caller-visible change).

`esbuild.config.js` gains `sdkNodeExporterStubPlugin`: when — and only when —
the importer is `@opentelemetry/sdk-node`, the exporter packages resolve to a
stub whose constructors throw. Our protocol modules keep resolving the real
packages. sdk-node only touches these bindings inside its env-driven
configuration functions, which qwen-code's explicit processor arguments make
unreachable for traces and logs; the one reachable path
(`OTEL_METRICS_EXPORTER=otlp` etc.) now throws inside `NodeSDK.start()` —
caught by the facade's existing try/catch — instead of silently exporting to
a default localhost endpoint. Env-based exporter selection was never a
supported qwen-code configuration surface.

What each configuration loads after the split (measured static closure of
each bundled entry chunk):

| Config    | Loads                                             | Skips                |
| --------- | ------------------------------------------------- | -------------------- |
| outfile   | sdk-impl closure only (975 KiB)                   | both protocol chains |
| OTLP http | + HTTP chain closure (1.2 MiB incl. shared layer) | gRPC cluster         |
| OTLP grpc | + gRPC chain closure (1.9 MiB incl. shared layer) | HTTP exporters       |

## Guard

`scripts/check-serve-fast-path-bundle.js` gains a check rooted at the
`sdk-impl` chunk: its static import closure must not reach any
`FORBIDDEN_OTLP_PROTOCOL_PACKAGES` member — the gRPC cluster
(`@grpc/grpc-js`, `@grpc/proto-loader`, `protobufjs`,
`exporter-*-otlp-grpc`) plus `@opentelemetry/otlp-transformer`, which sits
in the shared serialization layer both protocol chains pull in and so also
catches a static re-import of the HTTP module. This locks the protocol
split the same way the phase 1 blacklist locks the facade split.

## Testing

- `sdk.test.ts` keeps its `vi.mock` setup unchanged: vitest interception
  applies to the protocol modules' imports of the same exporter packages, so
  existing constructor-argument assertions carry over.
- Acceptance follows the #4748 discipline: 30 paired serial cold starts on the
  2C4G host, telemetry on (outfile), control = phase 1 build, candidate =
  this change, reporting channel.initialize and process→first-session P50/P95.

## Alternatives rejected

- **Per-exporter (per-signal) modules**: three more modules for no measurable
  gain — the three signals of one protocol are always configured together.
- **Moving URL validation into the HTTP module**: would defer `diag` warnings
  for invalid URLs behind a module load and change the no-valid-URL path from
  "no import at all" to "import then no-op".
