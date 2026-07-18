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
