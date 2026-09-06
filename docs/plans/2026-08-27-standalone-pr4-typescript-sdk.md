# Standalone PR4 TypeScript SDK Implementation Plan

## Scope

Build the TypeScript SDK surface for the `standalone_sessions_v1` daemon API introduced by PR #10179. This stage changes only `packages/sdk-typescript` plus this implementation plan. WebUI, WebShell, daemon routes, and standalone lifecycle semantics remain out of scope.

The implementation is stacked on PR #10179 at `fbd3bf32bd207424e39bb7063728807f873d1668`. Before publication against `main`, rebase onto the merged PR3 result and re-audit the final route contract.

## Public API

- Add narrow standalone session, restored session, summary, lookup, list, working-directory, metadata, batch, and creation-recovery types.
- Add capability-gated `DaemonClient` methods for create, list, exact lookup, load, resume, repair, rename, export, archive, unarchive, and delete.
- Let create accept an optional caller UUID; otherwise generate a UUID before the request. Never retry the create request.
- On a structured `standalone_creation_outcome_unknown` response, malformed successful response, or transport-level unknown outcome, perform one exact lookup and throw an error containing the generated UUID and the observed recovery state.
- Add `DaemonSessionClient` standalone create/load/resume factories and store an explicit restore strategy. Reattach workspace sessions by cwd and standalone sessions through the dedicated route.
- Runtime-validate every new JSON response before exposing it to consumers.

## Compatibility and failure behavior

- Every standalone method first requires `standalone_sessions_v1`; an old daemon fails before any standalone route is called.
- Standalone request types cannot express `workspaceCwd`, source, scope, branch, or worktree overrides.
- Exact lookup preserves the daemon's `202 creating`, `200 existing`, and `404 standalone_session_not_found` contract.
- A definite HTTP rejection remains a `DaemonHttpError`. Only an unknown create outcome is wrapped with recovery context.
- Browser code uses `globalThis.crypto.randomUUID()` and introduces no Node-only import.
- Existing workspace methods and the default workspace restore behavior remain source-compatible.

## Verification

- Request-shape tests for every route, including query encoding and client identity headers.
- Capability-absence tests proving no standalone request is sent.
- Create tests for generated and caller UUIDs, canonical response identity, structured outcome unknown, transport timeout, malformed success, and `202/200/404` lookup recovery.
- Runtime-validation tests for malformed sessions, summaries, working-directory results, metadata, and batch results.
- `DaemonSessionClient` tests for standalone create/load/resume and standalone versus workspace reattach.
- Public export type checks, TypeScript package tests, typecheck, lint, formatting, Node/browser builds, repository build, and repository typecheck.

## Audit decisions

- Keep HTTP ownership in `DaemonClient` and session-bound recovery in `DaemonSessionClient`; do not add another standalone client object.
- Keep validators in one standalone-specific leaf module to avoid expanding the already-large general daemon type file and to keep runtime checks reusable without UI dependencies.
- Perform exactly one automatic exact lookup after an unknown create result. Do not poll, load, resume, or issue a second create automatically; the caller retains control over further recovery.
- Do not cache capability results in PR4. Existing SDK capability checks are live probes, and adding cache invalidation would broaden this stage.
