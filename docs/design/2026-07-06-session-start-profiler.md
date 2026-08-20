# Session Start Profiler

## Summary

This change adds an internal, opt-in profiler for `GeminiClient.startChat()` so #6312 follow-up work can identify the remaining per-session initialization hotspot before choosing an optimization.

It does not change session behavior, public protocol fields, SDK behavior, CLI flags, config schema, telemetry schema, or startup profiler semantics.

## Measurement Shape

The profiler is enabled only when `QWEN_CODE_PROFILE_SESSION_START=1`.

When enabled, core writes JSONL records under `Storage.getRuntimeBaseDir()/session-start-perf/`. Daily JSONL filenames use the UTC date from the record timestamp. Each record includes a timestamp, `SessionStartSource`, success flag, total duration, bounded stage durations, and small aggregate counts such as history length and rendered snapshot count. The #4748 daemon profiling follow-up adds an optional opaque Session ID when the caller supplies one so this detail record can be joined to the cross-process trace.

The measured stages follow the existing `startChat()` sequence: tool registry warm, resumed deferred-tool reveal scan, deferred reminder setup, initial chat history build, skill reminder dedup seeding, agent reminder dedup seeding, system instruction build, `GeminiChat` construction, orphan tool-use repair, SessionStart hook, optional SessionStart context apply, and `setTools()`.

## Safety Boundaries

The output intentionally excludes prompts, model responses, hook output, tool names, file paths, and working directories. Its only optional identifier is the opaque Session ID used to correlate an opt-in record with daemon telemetry; it does not add user, tenant, or workspace identity. Stage names are static code-owned strings.

All profiler writes are best-effort. File-system failures are swallowed so profiling cannot break or slow a session through error handling.

The JSONL writer uses restrictive permissions and `O_NOFOLLOW` on the profile file. Parent-directory replacement remains best-effort because Node does not expose a portable fd-relative append path here; the runtime directory is treated as same-user diagnostic storage, not a boundary against a local same-user attacker.

When disabled, the helper performs no file writes and does not read the high-resolution clock.

`failedStage` only records stages that throw through the profiler wrapper. Stages whose underlying helpers catch and suppress their own errors, such as agent reminder dedup seeding and the SessionStart hook, remain successful from the profiler's perspective.

## Non-Goals

This change does not optimize `GeminiClient.initialize()` or `startChat()`.

It does not implement Part B extension caching, Part C skill body lazy-loading, command snapshot caching, or any daemon protocol changes.

The next optimization should be chosen only after collecting stage breakdowns from this profiler and comparing them with extension-heavy or skill-heavy fixtures where relevant.
