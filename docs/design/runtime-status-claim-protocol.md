# Runtime Status Claim Protocol

## Context

Runtime status files were originally a single canonical sidecar for external
observers. Project snapshot cleanup also needs them as conservative liveness
evidence, including when multiple processes resume the same session. Those
processes now hold independent canonical or sibling claims.

The canonical path is therefore only the preferred claim location. It is not
the complete claim set and does not prove ownership.

## Invariants

- A session's claims are every valid `*.runtime.json` record in the entry whose
  payload contains that session id.
- A claim written by another hostname cannot be classified with local PID
  APIs. Destructive callers must retain it, and claim acquisition must not
  displace it.
- An unreadable or unknown-schema claim cannot be proven dead. Liveness and
  claim-acquisition paths retain it; membership paths require a valid payload.
- A Config may refresh, move, or release only the exact claim path returned by
  claim acquisition.
- A Config that loses its claim after a best-effort write failure owns no
  runtime status file. It must not fall back to the canonical path.
- A demoted claim (`pid: 0`) is dead for liveness but remains valid membership
  evidence for a session moved by `/cd`.
- Transcript reads remain available when the cleanup lock infrastructure is
  unavailable. Cleanup remains fail-closed when it cannot acquire the lock.

## Scope

`runtimeStatus.ts` owns claim discovery and host-aware liveness semantics.
Config moves a runtime sidecar only when it holds the exact claimed path.
Storage, session membership, and worktree ownership consume the shared
runtime-status APIs instead of interpreting canonical paths or bare PIDs
independently.

The on-disk schema and external canonical filename remain unchanged. Process
start tokens and a separate cleanup lease format are intentionally out of
scope for this bug fix.
