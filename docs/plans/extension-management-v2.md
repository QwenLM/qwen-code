# Extension Management V2 Implementation Plan

## Delivery order

1. Add `ExtensionStore`, policy migration, global generation, artifact journals,
   rollback/forward recovery, and V1 projection. Route all `ExtensionManager`
   mutations through it and make install activation atomic.
2. Add the daemon operation coordinator, global catalog/mutation routes,
   workspace projection/activation routes, targeted/all-runtime reconciliation,
   and the primary-workspace V1 adapter.
3. Add SDK models and polling helpers, watcher generation recovery, CLI/TUI
   callers, capability negotiation, protocol documentation, and E2E coverage.

`extension_management_v2` is advertised only when all three layers are wired.

## Required invariants

- `state.json` is the only commit point and generation never decreases.
- No production caller writes a final extension directory directly.
- Install commits its initial activation policy with the artifact.
- Update preserves identity and activation; uninstall is idempotent at the API.
- Workspace routes mutate policy/runtime only, never artifact ownership.
- Global mutation reconciles all local runtimes; workspace mutation reconciles
  one target.
- Runtime refresh failure cannot roll back committed global state.
- Preparation concurrency is two across legacy and V2 routes; commit
  concurrency is one and FIFO by preparation completion order.
- Preparation never mutates final artifacts or runtime, and every successful
  handle is committed once or disposed.
- Same-artifact stale updates fail with `extension_conflict`; unrelated
  artifact and activation commits do not invalidate prepared work.
- Reconciliation occupies neither queue and applied generation never moves
  backwards.
- V1 routes and capability remain usable by old SDK clients.
- Secrets are redacted from operations, responses, and logs.

## Verification gates

Targeted unit tests cover store migration, policy precedence, concurrent store
instances, journal recovery, CLI scope behavior, daemon routing/trust/fanout,
two-slot preparation, preparation-ready commit ordering, queued abort,
same-artifact conflicts, watcher polling, SDK paths, and operation polling.
Repository completion gates are package builds, typecheck, lint, integration
daemon route tests, and the E2E plan in
`.qwen/e2e-tests/extension-management-v2.md`.

Before completion, audit architecture boundaries, crash/error paths,
compatibility, concurrency, redaction, tests, maintainability, and simpler
alternatives repeatedly until no new actionable issue is found.
