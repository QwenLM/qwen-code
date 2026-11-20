# Managed Runtime Worker Route Single Source

[English](2026-11-10-managed-runtime-route-single-source.md) | [简体中文](2026-11-10-managed-runtime-route-single-source.zh-CN.md)

## Status

Proposed. Implementation and verification land in the same PR as this document.

## Problem

The Managed Runtime worker admits HTTP requests through an outer raw gate
(`ownedManagedRuntimeRouteGate`) before they reach Express. The gate's allowlist
and the Express mounts are derived from **two parallel conditional
compositions**:

- `managed-runtime-attestation-worker.ts` builds the gate list with an inline
  ternary tree (~8 boolean conditions: boot version, capture publisher, remote
  publishers, workspace capability, measured digest, managed extensions, CSI
  boot, SSH runtime, external publication).
- `registerManagedContextRoutes` in `managed-context-worker.ts` re-derives
  overlapping conditions internally (publisher resolution, `requiresActivation`,
  `resident`, `foregroundOnly`, extension configuration) to decide what to mount.

The 2026-09 attestation incident (a route registered in Express but missing from
the outer gate's separate path list, yielding silent 404s) was fixed by sharing
frozen route constants and cross-language fixtures. The **activation logic**
remains duplicated. Drift fossils visible today:

- The gate's minimal boot-v2 branch contains a `boot.managedExtensions`
  conditional that can never be true (extensions force the full branch).
- For the resident capability digest with extensions, the gate admits
  `PUBLICATION_INSTALL_ROUTE` while the mount side never registers it
  (`remotePublisher` requires `!resident`). The direction is harmless
  (Express answers 404) but the two trees disagree.

The failure class to prevent: a route mounted under a new condition while the
gate's tree is not updated — a silent 404 that breaks functionality, exactly the
original incident.

## Current state

Route groups and their activation, as verified by reading the code at HEAD:

| Route group                     | Mount condition (context worker)                                                                                     | Gate condition (worker)                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| attest v3 + context             | always (boot v2)                                                                                                     | always in `MANAGED_CONTEXT_WORKER_ROUTES`                                          |
| activation, provider            | always                                                                                                               | always                                                                             |
| MCP ×2, hook, shell, monitor    | real routes unless `foregroundOnly`; otherwise 501 stubs (always mounted in some form)                               | always                                                                             |
| Tool v2 (`OWNED…` minus attest) | always                                                                                                               | always                                                                             |
| Tool v4                         | registrar returns early unless digest = `MEASURED_WORKSPACE_CAPABILITY_DIGEST`                                       | added iff digest = MEASURED                                                        |
| Tool v3 / tool-result           | `publisher` truthy                                                                                                   | added in full branch (equivalent for all reachable inputs)                         |
| Extension ×4                    | `extensionConfiguration && mcp && hooks && extensionProcesses` (equivalent to extensions present on reachable boots) | added iff `managedExtensions`                                                      |
| CSI attest/drain/ack            | `csiBoot`                                                                                                            | added iff `csiBoot`                                                                |
| SSH route                       | `sshRuntime` (worker level)                                                                                          | added iff `sshRuntime`                                                             |
| Shell publisher                 | `remotePublishers`                                                                                                   | added iff `remotePublishers`                                                       |
| Publication install             | `!(publication ?? capturePublisher) && requiresActivation && !resident`                                              | `!capturePublisher && !publication && (isWorkspaceToolCapability \|\| extensions)` |
| Boot v1 surface                 | attest v2 + tool routes + provider                                                                                   | `OWNED_MANAGED_RUNTIME_ROUTES + PROVIDER`                                          |

Invariant today: **gate ⊇ mounts** for every reachable configuration. The only
disagreement is publication-install under resident+extensions (gate superset).

## Goals

1. One pure derivation owns the worker's route surface. The gate consumes its
   route list; the mount side consumes its flags. No second condition tree.
2. Behavior-preserving for every reachable boot configuration, with one
   documented tightening (below).
3. A conformance test pins **mounts ⊆ gate** and **gate = plan** across a
   configuration matrix, so future drift fails CI instead of production.
4. Remove the dead minimal-branch conditional.

## Non-goals / scope boundaries

- The CSI file worker (`managed-csi-file-worker.ts`) keeps its co-located,
  version-only gate composition; it is a separate process type with a single
  mount function and no parallel tree.
- The external publication server gate already consumes
  `EXTERNAL_PUBLICATION_ROUTES` from the same module that registers it;
  unchanged.
- No protocol, fixture, or `packages/core` changes. Boot v1 surface unchanged.
- Leaf registrars may keep single-predicate identity guards (e.g. the v4
  registrar's measured-digest check). The single source owns **composition**,
  not every one-line guard; guards and plan flags use the same constants.

## Proposed solution

### Shared helper: `resolveManagedShellPublisherMode`

Lives in `managed-workspace-activation.ts` (not the new module) so the import
graph stays acyclic: the plan module imports the context worker's route
composite, and the context worker imports the helper from activation.

- Input: `capabilityDigest`, `managedExtensions` presence, and booleans for
  the effective capture flag and `remotePublishers`.
- Returns `{ resident, requiresActivation, remotePublisher, publisher,
installRoute }` derived from `requiresActivation` (workspace capability ∨
  resident ∨ extensions), `resident`, and the effective capture flag
  (`publication || capturePublisher`).

### New module: `managed-runtime-worker-routes.ts`

- `ManagedRuntimeWorkerRouteInput`: boot version (1|2), `capabilityDigest`,
  `managedExtensions` presence, `csi` presence, optional SSH route, and
  booleans for `capturePublisher`, `remotePublishers`, `publication`.
- `resolveManagedRuntimeWorkerRoutePlan(input)`: returns
  `{ routes, toolV4, toolResult, publicationInstall }`.
  - Boot v1: `OWNED_MANAGED_RUNTIME_ROUTES + MANAGED_RUNTIME_PROVIDER_ROUTE`.
  - Boot v2: `MANAGED_CONTEXT_WORKER_ROUTES` plus groups per the inventory
    table, with tool-result and publication-install driven by the shared
    publisher mode. The full/minimal branch split disappears: the composition
    is unconditional base + predicate-driven groups.
  - The extra booleans expose the publisher-mode-derived selections for
    assertions; mount sites consume the shared publisher mode directly.

### Worker (`managed-runtime-attestation-worker.ts`)

Compute the plan once after boot resolution and pass `plan.routes` to the gate.
The inline ternary tree and the dead conditional are deleted.

### Context worker (`managed-context-worker.ts`)

`registerManagedContextRoutes` consumes `resolveManagedShellPublisherMode` for
the remote publisher, the effective publisher, and the install-route
registration, instead of re-deriving them. The v4 registrar keeps its
unconditional call site and its internal measured-digest leaf guard; the plan
selects the same routes with the same constant, so no call-site parameter is
added. Extension, foreground-stub, and always-on mounts keep their
behavior-object-linked conditions, which the inventory proves equivalent to
the plan on reachable boots.

### Documented tightening

For resident digest + extensions without capture/publication, the gate stops
admitting `PUBLICATION_INSTALL_ROUTE` (it was never mounted). The response
changes from Express 404 to gate 404 — both 404, no functional client. This is
the only observable surface change; the conformance matrix pins it.

## Design decisions and rationale

- **Plan as data, not a registration framework.** Routes stay frozen constants;
  the plan only selects them. No per-route handler registry rewrite — that
  would touch every registrar for no additional safety.
- **Publisher mode shared, not duplicated.** It is the one derivation both
  sides genuinely re-computed; extracting it removes the last semantic fork.
- **mounts ⊆ gate as the tested invariant**, with gate = plan as the second
  assertion. Strict equality mounts = gate is not required: behavior-linked
  conditions (extension runtime objects) may refuse to mount while the plan
  admits; the gate superset direction is safe and today's status quo.
- **Behavioral oracle without internals:** the gate's 404 is an empty body;
  any response that passed the gate is distinguishable (Express 404 carries
  HTML, handlers carry JSON). Probing a booted worker classifies each route
  without exporting internal state.

## Files affected

- New: `packages/cli/src/serve/managed-runtime-worker-routes.ts`,
  `packages/cli/src/serve/managed-runtime-worker-routes.test.ts`.
- Edit: `packages/cli/src/serve/managed-runtime-attestation-worker.ts`,
  `packages/cli/src/serve/managed-context-worker.ts`,
  `packages/cli/src/serve/managed-workspace-activation.ts`.
- Docs: this pair; test plan under `.qwen/e2e-tests/`.

## Risks

- The plan input must faithfully capture `publication` presence (known to the
  worker before mounts); a wrong boolean silently moves the install route.
  Mitigation: the matrix includes publication × capture × digest combinations.
- Standalone callers of `registerManagedContextRoutes` (tests) must keep
  working: the publisher-mode helper defaults reproduce today's derivation.
- Gate tightening could break a test that pins Express-404 body shape for the
  resident+extensions install path; run the full managed serve test set.

## Validation plan

1. Focused unit tests: plan matrix (digest × extensions × capture ×
   remotePublishers × publication × CSI × SSH × boot version), publisher-mode
   truth table.
2. Behavioral conformance: boot the worker in-process per reachable
   configuration (temp mount roots, following
   `managed-runtime-bootstrap.process.test.ts` harness patterns), probe the
   route universe, assert passed-gate set = plan and mounted set ⊆ plan.
3. Existing suites: `managed-tool-result-admission`,
   `managed-runtime-bootstrap.process`, `managed-runtime-tool-v4-routes`,
   context-worker and CSI worker tests.
4. `npm run build && npm run typecheck`, lint, Prettier.

## Acceptance criteria

- No route-composition conditional remains in the worker's gate call; the plan
  is the only derivation.
- Plan output equals the pre-change gate list for every reachable configuration
  except the documented resident+extensions install tightening.
- Conformance matrix green; dead conditional removed; all existing focused
  suites pass; build/typecheck/lint clean.

## Open questions

- None blocking. If a future boot version adds route groups, the plan input
  grows a field and the matrix grows a row — the conformance test is the
  standing guard.
