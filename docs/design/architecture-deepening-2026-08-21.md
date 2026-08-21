# Architecture deepening pass

## Goal

Improve locality and leverage in five high-churn seams without changing user-visible behavior:

1. make ACP transport-safety policy a deep internal module;
2. make workspace runtime and trust selection a single route policy;
3. remove the CLI-local ACP compatibility re-export shim;
4. centralize Web Shell prompt-admission and retry transitions;
5. centralize WebUI session-attachment ownership transitions.

This is a staged refactor. Each stage must remain independently testable and must preserve the existing public package and daemon protocols.

## Behavioral Invariants

### ACP transport safety

- Bounded daemon channels keep the existing frame, queue, active-handler, and byte limits.
- Invalid, cyclic, accessor-backed, or oversized values continue to fail closed before entering an unbounded SDK queue.
- Request errors exposed to SDK logging remain redacted, while unbounded public bridges retain their existing error text.
- A transport-budget failure retires the channel exactly once and triggers the existing teardown path.

### Workspace-qualified routes

- Workspace selectors continue to accept registered ids and portable absolute paths.
- Missing or inactive runtimes keep the existing `workspace_mismatch` and `workspace_runtime_unavailable` responses.
- Trusted-only routes keep returning `untrusted_workspace` without invoking their operation.
- Read routes retain their permissive cwd fallback; mutation routes retain fail-closed cwd handling.
- Route registration and middleware order in `createServeApp()` do not change.

### ACP imports

- The CLI's public exports remain available from the same CLI entrypoint.
- Internal callers import implementation and types from their owning `@qwen-code/acp-bridge` subpath.
- Startup fast paths do not acquire new ACP value imports.

### Prompt admission and retry

- Stale session owners cannot commit, retry, or restore prompt state.
- Definitely rejected, admitted, and unknown admission outcomes keep their existing UI behavior.
- Failed-message retry and turn-error retry keep their existing transcript-identity checks.
- The first extraction owns state transitions only; React rendering and daemon transport remain in `App.tsx`.

### Session attachment

- A superseded load cannot attach, detach, or report errors for the current session.
- Load watchdogs and detach cleanup remain idempotent.
- Same-session refresh, cross-session switching, missing sessions, and controlled session props retain current behavior.
- The first extraction owns pending-load and attachment epochs only; transcript replay and SSE projection stay in the provider.

## Module Direction

The new internal modules must not import their former composition roots. `bridge.ts`, `spawnChannel.ts`, `App.tsx`, and `DaemonSessionProvider.tsx` remain adapters that bind deep policy to their existing runtimes.

The new interfaces should expose decisions and transitions, not React setters, Express responses, SDK connection objects, or broad dependency bags. A proposed module fails the deletion test if removing it merely inlines a few predicates into its caller.

## Staging

1. Move ACP value projection, budgets, redaction, and guard lifecycle behind one internal transport-safety module; retain bridge and spawn-channel integration tests.
2. Add trusted workspace resolution to the existing route policy and migrate qualified routes incrementally.
3. Replace CLI-local shim imports with owning package subpaths, preserve CLI public re-exports, then delete the shim.
4. Extract the prompt-admission attempt and retry transition model, then adapt existing App callbacks to it.
5. Extract pending session-load ownership and attachment epochs, then adapt actions and the provider effect to the shared model.

## Verification

- ACP bridge: `bridge.test.ts`, `spawnChannel.test.ts`, package typecheck.
- Serve routes and imports: `workspace-route-runtime.test.ts`, affected route tests, `fast-path.test.ts`, `server-default-bridge-wiring.test.ts`, CLI typecheck.
- Web Shell: focused prompt admission and retry cases in `App.test.tsx`, package typecheck.
- WebUI: `actions.test.ts`, `attachment-lifecycle.test.ts`, focused attachment and session-switch cases in `DaemonSessionProvider.test.tsx`, package typecheck.
- Repository: build, typecheck, formatting/lint checks for changed files, and two clean diff-audit passes.

## Non-goals

- Splitting large files to meet a line-count target.
- Changing REST, ACP, SSE, or React context contracts.
- Reordering Express middleware or route registration.
- Rewriting transcript replay, right-panel orchestration, or daemon runtime disposal in this pass.
- Introducing a generic state-machine framework or a new dependency.
