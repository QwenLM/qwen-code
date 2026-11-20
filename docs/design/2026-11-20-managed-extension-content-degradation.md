# Managed Extension Content-Only Component Degradation

[English](2026-11-20-managed-extension-content-degradation.md) | [简体中文](2026-11-20-managed-extension-content-degradation.zh-CN.md)

Status: proposed (issue #17714, option 2 endorsed by triage). Date: 2026-11-20.

## Problem statement

A managed extension runtime constructed without a `stage` dependency
(content-only form) rejects the entire apply when any package declares
`mcpServers` or `hooks`: `prepare()` throws `Extension process components are
unsupported.` after compiling every package
(`packages/cli/src/serve/managed-extension-runtime.ts:376-383`). The package's
`skills`, `commands`, `agents`, and `context` — all usable in this form — fail
with it, and the caller gets no per-component detail. Mixed skills-plus-hook
bundles are a natural publishing unit; the only workarounds today are forking
the package or admitting a full process-capable runtime.

## Current state

- The extension contract admits seven component kinds
  (`ManagedPackageComponent`: `skills, commands, agents, context, mcp, hooks,
settings`); the rejection is a runtime-policy gate, not a compile limit.
- MCP/Hook contributions are consumed only by the staging path
  (`managed-extension-manifests.ts`), which runs behind `stage`. Without
  `stage`, prepared catalogs are always `{ mcpServers: [], hookCatalog: null }`
  and `install` is a no-op: the components are structurally inert.
- The Java server is a validating forwarder for `extension-prepare`:
  `ManagedExtensionProtocol.response()` checks the envelope, `state`,
  `revision`, and `executionMode` only; the result's `packages` array passes
  through opaquely. Java never reads prepare-result package fields.
- The persisted effective bundle (`managed-extension-config-bundle`) is built
  by the TS harness (`hosted-extension-session.ts` `prepare()`), committed as
  an opaque resource, and read selectively in Java (`pin`, `contributionsRef`
  only). The one closed-key gate on bundle package entries is the core TS
  parser (`managed-extension-package.ts`, `keys(entry, ['pin', 'assetRoot',
'contributionsRef'], [])`).
- The session resource catalog builds its effective MCP list from
  `bundle.mcpServers` (empty in content-only); the per-package attribution map
  is a lookup, not a display list. Degraded packages therefore create no
  phantom MCP entries in the catalog today.
- The extensions management API snapshot
  (`ManagedExtensionManagementService.snapshot`) reports active `extensions`
  as bare pins; there is no degradation surface.
- No production content-only wiring or capability digest exists in this tree:
  the only production runtime construction
  (`managed-context-worker.ts:686-713`) always supplies `stage`, and
  `ManagedExtensionExecutionProfile` admits exactly two digests
  (`linux-cgroup`, `developer-process-group`). Stage-less construction exists
  in tests and is the form issue #17714 addresses.

## Goals and scope boundaries

Goals:

1. Content-only runtimes load and serve the supported contributions of every
   package instead of failing the whole apply.
2. Hooks/MCP stay fully inert (fail-closed preserved) and their non-activation
   is reported explicitly per package, never silently dropped.
3. The degraded state round-trips deterministically through exact re-prepare
   drift checks and restart recovery.

Out of scope:

- Executing hooks/MCP in content-only (triage-rejected option 1: it would erase
  the boundary between profiles).
- A third capability digest/execution mode and production content-only wiring
  (tracked by #17424). The `executionMode` enum is unchanged.
- Changes to the `config_install` record, the `config.bound` event payload, or
  the contributions manifest — all closed key sets stay untouched.
- The session resource catalog (already honest about effective MCP; no change
  needed).

## Proposed solution

### TS runtime and contract

- `ManagedExtensionPreparedPackage` and `ManagedExtensionPackageView` gain an
  optional `degradedComponents?: readonly ('mcp' | 'hooks')[]`. The field is
  omitted when empty; when present it is in canonical order `['mcp', 'hooks']`
  filtered by presence, with no duplicates.
- `prepare()` drops the whole-package throw. `preparedView()` derives the field
  per package: without `stage`, a package with non-empty
  `contributions.mcpServers` degrades `mcp`, and non-empty `contributions.hooks`
  degrades `hooks`. The persisted receipt keeps the full compiled
  contributions unchanged, so the exact re-prepare comparison
  (`Prepared extension package drifted.`) and catalog comparison stay green;
  the derivation is a pure function of `stage` presence plus contributions, so
  restart and re-prepare reproduce the identical view.
- The bundle parser accepts `degradedComponents` as an optional package-view
  key, validates values (unique members of `{mcp, hooks}`), and normalizes to
  canonical order.
- The harness `prepare()` copies the field from each prepared package into the
  published bundle package view.

### Java surfacing

- `ManagedExtensionManagementService.snapshot` adds an additive
  `degradedComponents` object to the snapshot, keyed by `extensionId`, valued
  by the package's degradation list, read from the **active** bundle only. The
  field is present only when at least one active package is degraded.
  `extensions` and `requestedExtensions` keep their bare-pin shapes; no
  existing consumer breaks.
- The new read site validates defensively in house style and mirrors the TS
  parser: the field must be an array of unique strings within `{mcp, hooks}`
  (an explicit `null` is corrupt, matching the parser), and the reported list
  is normalized to canonical `['mcp', 'hooks']` order so the API boundary is
  deterministic regardless of committed order; a malformed committed bundle
  is `corrupt()`.
- The published OpenAPI contract declares the field:
  `ManagedExtensionManagementSnapshot` gains an optional `degradedComponents`
  object (`maxProperties: 32`, values arrays of `mcp`/`hooks` with
  `maxItems: 2`, `uniqueItems: true`), keeping the schema
  `additionalProperties: false` honest for every public and WebShell
  extension-management operation that serves the snapshot. WebShell types are
  regenerated from the repository root
  (`npm run generate:managed-agent-api --workspace=packages/web-shell`), and a
  contract case commits a degraded active bundle so
  `ManagedAgentApiContractTest` schema-validates the degraded response — the
  gate fails without the schema property.
- `ManagedExtensionProtocol.response()` is unchanged: it already passes
  package fields through, and the TS harness validates pins on receipt.
- The local harness management snapshot (`GET /session/:id/extensions/management`)
  is intentionally unchanged: the Java-side snapshot is the deployment-facing
  reporting surface. Aligning the local surface is deferred to the
  content-only wiring work (#17424) if that surface needs the report.

## Design decisions and rationale

- **D1 — Derive at view time, not in the receipt.** Storing degradation in the
  receipt would fork the receipt format and the drift comparison; deriving it
  from `stage` presence plus the untouched contributions keeps both paths
  (fresh prepare, exact re-prepare, restart load) producing one identical view
  with zero receipt-format change.
- **D2 — Per-package optional field, canonical order, omitted when empty.**
  Additive and backward compatible: old runtimes emit nothing, new parsers
  accept absence, Java bundle readers already tolerate extra entry fields.
  Canonical order makes `JSON.stringify` comparisons deterministic.
- **D3 — Surface on the extensions management API, additively.** It is the
  deployment-facing extension configuration surface; a map keyed by
  `extensionId` reports exactly which components of which packages were not
  activated without changing the pin arrays consumers parse today. The
  resource catalog needs no change (its effective MCP list already excludes
  inert contributions), and record/event closed sets stay untouched.
- **D4 — `settings` are not a degraded component.** Settings are env-var
  declarations resolved at compile/preflight; their only runtime consumers are
  MCP stdio env and command-hook env, which are inert together with the
  degraded components. They continue to load as data; no separate marker.
- **D5 — No new capability digest or mode.** Content-only production wiring is
  #17424's scope; this change makes the runtime contract degrade gracefully
  within the existing forms so that wiring can land without a protocol fork.

## Constraints

- Bundle inline capacity is 64 KiB
  (`managedSessionInlineResourceBytes('managed-extension-config-bundle')`).
  Measured worst case (32 packages all degraded with `["mcp","hooks"]`, 96 MCP
  selection entries, 16 base pins, 32 effective pins, widest identities):
  65107 bytes ≤ 65536, margin 429 bytes. The worst-case byte test fixture must
  include the new field.
- Prepare-result size limit (8 MiB) is unaffected.
- The prepare operation's closed key set in `ManagedExtensionProtocol`
  (request direction) is unchanged.

## Risks

- Thin worst-case byte margin (429 bytes): any future bundle field must re-run
  the byte-budget test. Mitigation: the updated worst-case fixture pins it.
- Version skew: an old TS harness parsing a new bundle rejects the unknown
  package-view key. Harness and runtime ship in one CLI binary; committed
  bundles are only re-parsed by the same or newer harness (recovery re-prepares
  from pins, not from package views). Java readers tolerate the field.
- A degraded package's hooks silently not running is the intended semantics;
  the explicit report is the mitigation against operator surprise.

## Validation plan

- Unit (TS): core parser acceptance/validation/normalization and the updated
  worst-case byte test; runtime tests for degradation derivation, mixed-package
  success, inert catalogs, exact re-prepare and restart determinism, and
  no-degradation with `stage`; harness test that the published bundle carries
  the field; harness-level integration test loading a mixed skills+hook package
  through the skill tool on the first Hosted turn with a stage-less runtime.
- Unit (Java): `ManagedExtensionManagementServiceTest` — snapshot surfaces the
  map for an active degraded bundle, omits it otherwise, keeps pin shapes,
  normalizes canonical order, and rejects malformed degradation fields
  (including explicit `null`) as corrupt.
- Contract gates (Java): `ManagedAgentApiContractTest` (with the degraded
  active-bundle case), `SurfaceRegistryGateTest`,
  `SurfaceAdmissionAcceptanceTest`, `ManagedSurfaceCaptureTest`, plus the
  CI-equivalent dual-execution Checkstyle.
- Build/typecheck: `npm run build && npm run typecheck`; focused vitest per
  package; focused Maven tests for the changed Java module.
- Full managed-server E2E (runtime jar + MySQL) is not required for this
  contract change; the harness-level supertest integration exercises the real
  HTTP apply path with a stage-less runtime.

## Acceptance criteria

1. Content-only prepare of a mixed skills+hook package succeeds; skills,
   commands, agents, and context are served; the prepare result and the
   committed bundle report `degradedComponents: ["hooks"]` (plus `"mcp"` when
   MCP servers are declared).
2. Hooks/MCP remain inert: catalogs empty, `install` a no-op, no process
   spawned.
3. Exact re-prepare and restart recovery return the identical view; drift
   checks stay green.
4. With `stage`, no `degradedComponents` is emitted and behavior is unchanged.
5. The extensions API snapshot shows the `degradedComponents` map for an active
   degraded configuration and omits it otherwise; pin array shapes unchanged.
6. The worst-case bundle with the new field stays ≤ 64 KiB; the byte test is
   updated and green.
7. Malformed degradation fields in a committed bundle (including explicit
   `null`) are rejected as corrupt by the Java read site; the reported list is
   in canonical order.
8. The published OpenAPI schema declares the optional field, the WebShell
   types are regenerated, and the degraded active-bundle contract case
   schema-validates the snapshot response (the gate fails without the schema
   property).

## Open questions

None blocking. Production content-only capability wiring remains tracked by
#17424.
