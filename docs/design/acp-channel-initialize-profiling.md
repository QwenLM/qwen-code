# ACP Channel Initialize Profiling

## Summary

The daemon's `channel.initialize` span starts after the ACP child is spawned and
ends when the child returns its ACP initialize response. It therefore includes
Node and ESM startup, CLI bootstrap, ACP module loading, bootstrap
`Config.initialize()`, transport setup, and the initialize handler. The handler
itself only returns capabilities and is not expected to explain the observed
latency.

This design adds a fixed, opt-in child startup profile to the ACP initialize
response and copies the validated durations onto the existing parent
`channel.initialize` span. It does not change channel readiness, initialization
ordering, failure handling, or session behavior.

## Protocol

The bridge requests version 1 of the profile through initialize request
metadata:

```json
{
  "_meta": {
    "qwen.daemon.channelStartupProfile": { "v": 1 }
  }
}
```

Supporting children return the profile under the same top-level response
metadata key. The response contains only fixed duration fields, a completeness
flag, the response-build wall-clock timestamp, and the total child process to
response duration. It never contains paths, extension names, settings, or
other user-derived values.

The profile divides the child startup into non-overlapping top-level phases:

- process start to profiler readiness;
- Gemini module import;
- argument parsing;
- settings loading;
- Config construction;
- generic application initialization;
- ACP module import;
- bootstrap Config initialization;
- transport construction;
- initialize handler execution;
- unattributed time between the fixed phases.

Bootstrap Config initialization is split into initial extension refresh,
hooks, skills, final extension refresh, hierarchical memory, tool registry,
tool warmup, and residual time. The ripgrep probe is reported as a child of
tool registry time and is not subtracted again when calculating residual time.
Top-level unattributed time also includes the wait between transport setup and
the initialize request reaching the child handler.

All durations use `performance.now()` and are rounded to two decimal places.
The response-build epoch uses `performance.timeOrigin` plus the response mark
and is used only for the optional parent-side transport estimate.

## Collection lifecycle

The CLI dynamically initializes the ACP profiler only when the raw arguments
contain `--acp` or `--experimental-acp`, before importing the Gemini runtime.
The profiler stores the first timestamp for a finite union of mark names. It
does not perform file I/O, heap capture, telemetry initialization, or dynamic
event retention.

The core startup-event sink forwards fixed Config phase events to the ACP
profiler only while the ACP bootstrap Config is initializing. This prevents
later per-session Config initialization from contaminating the startup
profile. Skipped Config phases still emit adjacent start and end marks so a
successful startup can produce a complete profile in bare or safe mode.

The initialize handler freezes the profiler after building the first response,
whether or not the caller negotiated the profile. Missing marks produce
`complete: false`; collection never delays or fails the initialize response.

## Parent span enrichment

The bridge validates the response metadata before adding fixed numeric
attributes to the active `channel.initialize` span. Unknown profile versions
are ignored. Unknown fields are ignored. Known values must be finite,
non-negative, and no greater than 600 seconds. Invalid or missing known fields
are omitted and make the effective completeness flag false.

The optional response transport estimate is the parent receive time minus the
child response-build epoch. It is recorded only when finite, non-negative, and
no greater than the configured initialize timeout.

Profile parsing and telemetry enrichment are fail-open. A missing, malformed,
or unsupported profile must not change initialize success, channel teardown,
coalesced caller behavior, or retry behavior. New parents remain compatible
with old children because ACP metadata is extensible; new children return no
profile to old parents that do not opt in.

## Verification

Focused tests cover collector activation and freezing, fixed phase arithmetic,
payload size, protocol negotiation, malformed profiles, span enrichment,
telemetry failure isolation, Config event ordering, and the serve fast-path
bundle boundary. The release-built candidate is compared with the exact #6907
merge baseline on the representative 2C4G host with paired, alternating cold
runs before any optimization is selected.

## P0-B optimization decision

The 2C4G P0-A profile attributed 67.3% of child startup P50 to Gemini and ACP
module loading. CPU profiles then showed that source-module compilation was the
largest CPU cost and that the ACP static import graph loaded Ink, React, React
Reconciler, and Yoga even though the ACP child does not render a TUI.

The optional edges were existing UI-only dependencies rather than a new ACP
entry point. The ACP Session imported an API-error classifier through a React
hook; extension completion imported its data shape and result limit through a
render component; the command registry statically loaded UI support needed
only when `/init` asks for confirmation, approval mode enters auto mode, or
collapsed history expands. The optimization moves the two pure data helpers
out of render modules, makes the React type import type-only, and loads the
three interactive action dependencies only when those actions execute.

The ACP initialize response, startup ordering, Config initialization, command
registry contents, failure handling, and Session behavior remain unchanged. A
bundle-metafile check follows the ACP agent's static output closure and rejects
Ink, React, React Reconciler, or Yoga inputs while continuing to allow them
behind dynamic imports.

The causal comparison used release artifacts built from the same main commit,
`af6a9b640c5d9097c5151b8705dd73aee8e180d0`, with only this optimization
applied to the candidate. Two alternating cold runs produced 60 pairs after an
excluded warmup; a separate alternating preheated run produced 30 pairs. The
second cold run was started after the first run exposed two candidate-side
parent-listener stalls before the ACP path. No samples from either run were
discarded. The pooled cold P50 results were:

| Metric                    | Matched control | P0-B candidate |             Change |
| ------------------------- | --------------: | -------------: | -----------------: |
| ACP import                |       115.06 ms |       52.00 ms | -63.06 ms (-54.8%) |
| Child process to response |      1102.88 ms |     1041.09 ms |          -61.80 ms |
| `channel.initialize`      |      1098.25 ms |     1035.61 ms |          -62.64 ms |
| Process to first Session  |      2046.88 ms |     1980.03 ms |          -66.85 ms |
| Cold Session request      |      1358.95 ms |     1290.23 ms |          -68.72 ms |

All 60 cold profiles in each variant and all 30 preheated profiles in each
variant were complete. Every run exited cleanly, and concurrent first Sessions,
telemetry-disabled startup, and legacy default `single` behavior succeeded in
both functional rounds. In the pooled cold data, warm-Session P95 changed from
137.53 ms to 104.98 ms, first-health P95 from 962.99 ms to 824.14 ms, and
process-tree RSS P95 from 442.27 MiB to 435.70 MiB. In the preheated data,
Session P50 changed from 73.90 ms to 73.75 ms and P95 from 88.38 ms to 76.17 ms.

Transient host-wide stalls affected both variants and were retained. In the
first 30-pair run, two candidate parent-listener stalls raised first-health P95
from 803.82 ms to 1175.67 ms even though the health requests themselves took
6-11 ms and the changed ACP path had not started. The diagnostic retry reversed
the direction, with control/candidate first-health P95 of 1522.44/727.64 ms;
pooling all 60 retained pairs produced the values above. The exact P0-A merge
was also compared with the candidate as a secondary 30-pair check and
independently showed the same ACP-import reduction and no P95 regression.

The module-loading candidate therefore clears the P0-B gate: the selected
phase improves by more than 30% and 10 ms, while both `channel.initialize` and
process-to-first-Session P50 improve by more than 10 ms. Lazy top-level yargs
command builders were rejected because their selected-phase improvement did
not clear the 30% gate. Tool registry and warmup remain a separate descriptor
decoupling design; extension refresh, hierarchical memory, and transport were
too small to justify a P0 behavior change.
