# PR 6635 Review Follow-ups Implementation Plan

## Goal

Close the correctness gaps in multi-workspace daemon-managed channel workers
without adding workspace-qualified channel control APIs.

## Implementation

1. Use one cwd resolver for parsing and ownership grouping. Resolve ordinary
   relative channel cwd values from the settings workspace and preserve
   absolute and home-relative behavior.
2. Resolve and validate the complete channel-to-workspace plan at listener
   startup. Reject unknown, ambiguous, untrusted, or uncanonicalizable owners
   before exposing a usable daemon handle, then freeze that plan for runtime
   creation.
3. Make the worker group the lifecycle boundary. Initial startup rolls back on
   partial failure; daemon-wide reload coalesces concurrent requests and stops
   the fleet if any restart fails; shutdown waits for reload completion.
4. Publish a newly built runtime app only after all workers are ready. Keep
   health degraded on startup failure.
5. Preserve single-workspace wire shapes while adding validated per-workspace
   pidfile, daemon-status, diagnostic, and SDK fields for multi-workspace mode.
6. Cover relative cwd semantics, canonicalization failures, trust validation,
   partial startup/reload failures, two-workspace orchestration, pid cleanup,
   status diagnostics, and compatibility behavior with focused tests.

## Verification

Run affected CLI and SDK tests, formatting and lint checks, then repository
build and typecheck. Exercise a two-workspace daemon-managed channel scenario
and audit the final diff for lifecycle races, compatibility regressions, and
unnecessary API surface.
