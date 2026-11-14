# Managed Agent Server pre-production convergence

[English](2026-11-12-managed-agent-preproduction-convergence.md) | [简体中文](2026-11-12-managed-agent-preproduction-convergence.zh-CN.md)

- Status: **Proposed** — pending maintainer review. Rebased onto current main
  after the tier-1 convergence merged: #17058 (OSS read-path probe removal,
  object-storage decoupling, K1 deletion, the slice-1 `defaultCandidate` fix, and
  uniform pool strict mode), #17064 (single executable jar — supersedes the
  earlier "retain the classifier jars" framing below; the operator tools survive
  as admin subcommands), #17047 (pack-aware readers) and #17044 (ratchet trim).
  Slice 1's fix landed via #17058; its embedding regression assertion is retained
  here. Slice 2 (dead-tag release repair removal) is implemented in this PR
  (pending review). Slice 3
  is dropped (see below). Slices 4–8 remain.
- Date: 2026-11-12
- Scope: `packages/managed-agent-server/**`, its packaging/release scripts, the
  web-shell generated client, and the Java SDK surface.
- Related: amends the module matrix in
  [Managed Agent Server Maven modules](2026-10-29-managed-agent-maven-modules.md);
  builds on the verification ratchet trim in PR #17044 (whose design doc
  `2026-11-12-managed-verification-ratchet-trim.md` lands with that PR).

## Problem and motivation

A seven-dimension over-design review (session `2667d1f1`, 2026-11-12) found that
`managed-agent-server` carries roughly 412k lines of Java across 14 Maven
modules, with tests about 1.8× production code. The dominant cost is not any
single bad decision but accumulated structural ceremony: single-implementation
interface mirrors, micro-modules with no dependency-isolation benefit, two HTTP
servers, parallel API surfaces, per-iteration fat JARs, and source-text ratchets
that pin comments and deleted tables.

The review's third recommendation tier ("medium/long-term restraint") assumed a
running production system and therefore framed every change as "stop the
bleeding without breaking existing deployments, data, or released artifacts."
**That premise no longer holds.** The maintainer has confirmed:

1. The service is **not in production**; there is no live state to protect.
2. **No released `managed-runtime` artifact (v0.26.x) has any user.**
3. Host embedding **is a real, committed usage** (see Locked decisions).
4. Only **one** of the two public API surfaces should survive for now.

With no historical baggage, the correct frame shifts from "restraint" to
"convergence by redesign": several structures previously judged load-bearing
are removable, and the single-V1 schema baseline is at its cheapest editing
window. This document records what may be removed, what must survive, and a
sliced plan that keeps each step independently verifiable.

## Current state (verified against current main)

Counts below are whole-repository scans; figures affected by the tier-1 merges
(#17058 / #17064 / #17075) are re-measured against the merging tree.

- **Interfaces.** 136 production interface names (97 top-level files); only 9
  have more than one production implementation. All 41 `*Store`/`*Repository`
  interfaces have exactly one production JDBC implementation (35 direct, 6 via
  the `ManagedSessionStore` role-interface inheritance). There is no production
  `InMemory*Repository`. `ToolPublicationObjectStore` is a genuine SPI (8 test
  fakes, reused by 5 subsystems).
- **Settings mirrors.** `ManagedAgentSettings` (20 interfaces, 252 lines) plus
  `SshSettings` (3) = 23 read-only mirrors of `ManagedAgentProperties`
  (1,076 lines, 21 nested classes). 62 production files import
  `ManagedAgentSettings`. `configuration-descriptions.json` generates the
  configuration reference doc; `release-managed-agent-reference.yml` runs
  `generate-managed-agent-configuration-reference.mjs --check` as a drift gate
  over the two committed pages.
- **Structural cause.** `ModuleArchitectureTest` forces
  `control-plane`/`persistence`/`runtime-*` to depend only on themselves plus
  `contracts`; `ClassSizeRatchetTest` forces splitting classes ≥800 lines in
  `persistence`/`runtime-broker` (global ceiling 2,549, monotonic). Splitting a
  class then needing cross-module visibility manufactures a new `contracts`
  interface. The mirrors are a product of these two gates, not of discipline.
- **API surfaces.** `SurfaceRegistry` enumerates 234 route constants across
  Public, WebShell, and internal surfaces. The two public surfaces are a
  capability split, not isomorphic mirrors: Public is read/manage-oriented
  (`PUBLIC_TURN_GET/LIST/EVENTS`, workspace list/get) while WebShell carries the
  interactive write side. At least 24 WebShell capability names have no Public
  twin (`TURN_SUBMIT`, `TURN_CANCEL`, `SESSION_APPROVAL`, `SESSION_MODEL_CHANGE`,
  `WORKSPACE_CREATE/REGISTER/FILES_*`, `TRANSCRIPT`, `EVENT_STREAM`, …). The
  web-shell UI consumes a generated client
  (`packages/web-shell/scripts/generate-managed-agent-api.mjs`); the Java SDK
  exposes the Public operations; the README documents business-host flows on
  `/v1/agents`.
- **HTTP.** `RuntimeBrokerHttpServer` (1,063 lines) is a hand-written JDK
  `HttpServer` on a third port; `csi-retirement:worker-authority` is registered
  on both it and the Tomcat internal connector.
- **preflight.** 4,393 production lines across 5 files plus 5,513 test lines
  across 6 files (~9,900 total) serve `--check`: `ServerEnvironment` (1,095,
  `StackWalker` format sniffing at :229), `ManagedAgentPreflight` (2,486,
  `YamlWalk` comment AST at :794), `HarnessBrokerUrl` (410, WHATWG subset shared
  with `packages/cli/src/serve/managed-runtime-broker-url.fixtures.json`),
  `ServiceAccount` (194, user-space `namei`).
- **Packaging.** A single `exec` repackage remains (#17064 removed the six
  classifier fat-JAR executions; the operator tools survive as admin
  subcommands). The maintenance family is 13 classes / 1,402 lines, referenced
  by `scripts/package-managed-agent-reference.mjs`, e2e tests, and the README.
- **Ratchets.** `verification/pom.xml` is 831 lines with 17 profiles and
  ~435 lines of near-duplicate Failsafe XML. The v0.26.5 pom pin
  (`scripts/patches/managed-runtime-v0.26.5-verification.patch` and its
  meta-test) was removed by the dead-tag release-repair cleanup, so profile
  dedup is no longer blocked by a pin. `ManagedSchemaCatalog` (630 lines;
  1,198 across the `managedschema` package) re-parses the canonical DDL with
  indentation-sensitive regexes at startup.
- **Registered providers, not dead code.** All five `runtime-*` modules register
  a `RuntimeProviderFactory` via `META-INF/services`, so they are
  ServiceLoader-discovered providers, not statically wired beans.
  `runtime-kubernetes` (kind `kubernetes-workspace`) is the resident-workspace /
  CSI provisioner (`KubernetesRuntimeProviderFactory`), actively developed and
  load-bearing; `runtime-external` registers `ExternalRuntimeProviderFactory`
  (`external-scratch` functional, `external-workspace` intentionally fail-closed).
  The earlier K1 scratch provisioner (`KubernetesRuntimeProvisioner`) and the
  `JdbcRuntimeBrokerSchema` alias were subsequently removed as genuinely dead /
  redundant (#17058, #17075). Removing a remaining provider is a capability
  decision, not cleanup.

## Goals

- Remove structure that exists only to serve past deployments, releases, or
  data, and structure whose only purpose is internal ceremony.
- Collapse the module/interface surface to what the committed embedding
  contract and a single public API actually require.
- Simplify `--check` to fail-fast validation over canonical input.
- Keep every step independently reviewable and verifiable; keep full gates in
  CI per the module verification policy.

## Non-goals

- No change to correctness invariants (see below).
- No performance-motivated storage change without a benchmark (the EVENT fact
  ledger and OSS hot paths have read-side justification; "no historical
  baggage" does not mean "no measurement").
- No new feature, no new extension point beyond what the locked decisions
  require.
- No implementation in this document; it is a plan for review.

## Locked decisions

| #   | Decision                                                                                                                                                                                          | Consequence                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Host embedding is real. Upper-layer code uses `@Configuration(proxyBeanMethods=false)` + `@Profile("qwen-embedded")` + `@Import(ManagedAgentConfiguration.class)` (class lives in the host repo). | `contracts` survives as a clean, Spring-free, embeddable API module; SPI whitespace and bean isolation are preserved.                                                                                                               |
| D2  | Keep only one public API surface.                                                                                                                                                                 | Keep **Public**; absorb the interactive capability set into it; migrate the generated web-shell client; delete the WebShell arm.                                                                                                    |
| D3  | No released `managed-runtime` artifact has users.                                                                                                                                                 | The v0.26.5 release-repair patch and its pom-pinning meta-tests may be deleted, unblocking profile deduplication.                                                                                                                   |
| D4  | Host (`data-agent`) modifications are authorized ("上层可以改").                                                                                                                                  | Refactoring need not preserve host-imported fully-qualified names; internal packages/classes may be renamed or reorganized, with the host migrated in lockstep. Host coupling is coordinated migration work, not a hard constraint. |

### Why keep Public rather than WebShell (D2)

Public is already anchored by the Java SDK, the OpenAPI contract, and the README
business flows. Keeping WebShell instead would require rewriting the OpenAPI
spec and retargeting the Java SDK. The cost of keeping Public is designing the
~24 interactive capabilities into the public contract; pre-production is the
only cheap window to do that.

### Host coupling (verified against the data-agent release branch)

Inspection of the upper-layer repo (`data-agent`, release branch
`releases/20261112155816552_…`, commit `6897e7fc5`) corrects two earlier
assumptions:

- **The host does not read `ManagedAgentSettings`.** Zero imports of the
  `managedagent.settings` package. The 23 Settings mirrors can be deleted
  without breaking the host.
- **But the host depends on a broad internal surface, not just contracts SPIs
  and DTOs.** 29 host main-source files import `com.alibaba.qwen.code.*`,
  including `config.ManagedAgentProperties` (injected by type in
  `ManagedRuntimeService` and the workspace/business configurations),
  control-plane services, `persistence.*` and `repository.*` classes,
  `runtimebroker.*` internals, and **both Public and WebShell `ApiModels`
  records** (`ManagedRuntimeController`, `ManagedRuntimeService`).

Consequences (with D4, these are authorized migration tasks, not blockers):

- **D2 / Slice 4:** WebShell is not consumed only by the generated web-shell
  client; the host uses WebShell model records in-process. Deleting the WebShell
  arm requires migrating the host as well as the UI, after Public gains the
  interactive capabilities. The host change is authorized (D4), so this is a
  coordinated cross-repo migration rather than a reason to keep WebShell.
- **Slice 5:** Because the host may be changed (D4), module consolidation may
  rename packages and relocate classes (including `ManagedAgentProperties`)
  freely, updating the host's imports in lockstep. The verified import list above
  is the migration checklist. The only sequencing rule is compile-time: the host
  builds against qwen-code, so each qwen-code API change must land together with
  the matching host update.

## Invariants that must survive (not historical baggage)

These prevent real failure modes or are documented module review rules; they
are preserved in every slice:

- Lease fencing, UNKNOWN reconcile, and runtime attestation (boot id / inode).
- Journal digest chain, idempotent receipts, replay floor, and the CHAR(64)
  hash-key index layer (`session_scope_key` prefix predicates are load-bearing;
  removing them forces full-lane scans).
- Runtime lock-order tests (`StoreLockTraceTest`, `*LockContractMySqlIT`) —
  behavior, not text.
- Catalog refusal of legacy, partial, and foreign schemas; no Flyway
  repair/history edits to bypass refusal (module AGENTS.md).
- Tenant isolation, actor checks, Workspace grants, and internal credentials on
  every retained route; durable SQL admission/recovery with writer
  lease/generation checks.
- The OpenAPI contract, `SurfaceRegistry`, and contract tests
  (`ManagedAgentApiContractTest`, `SurfaceRegistryGateTest`) kept consistent for
  the surviving surface.
- Embedding isolation: `defaultCandidate = false`, `@ConditionalOnMissingBean`
  back-off, and `@Autowired(required=false)` SPI points.

## Proposed solution: eight slices

Ordered by dependency and risk. Each slice is a separate PR (or small PR
series) with its own focused verification; CI owns the full gates.

### Slice 1 — Embedding isolation fix (ratchet trim tracked separately)

- Fix the missing `defaultCandidate = false` on `sessionWorktreeScheduler`
  (a real embedding bug: it competed for the host's by-type `TaskScheduler`).
  **Implemented and verified locally**: `ManagedAgentEmbeddingTest` 8/8
  (including a new `dedicatedSchedulersAreNotDefaultCandidates` regression
  assertion), all 15 modules compile, Checkstyle (both executions) and SpotBugs
  green.
- The verification ratchet trim (Javadoc pin, lock inventory, legacy-table
  TSVs; −1,301 lines) is the merged PR #17044; it is not duplicated here.
- The former "dead code" deletion targets were re-examined: the K1 scratch
  provisioner (`KubernetesRuntimeProvisioner`) and the `JdbcRuntimeBrokerSchema`
  alias were genuinely dead / redundant and removed (#17058, #17075); the
  remaining `runtime-kubernetes` (`kubernetes-workspace` CSI) and
  `runtime-external` providers are registered, load-bearing capabilities, not
  dead code. Dropping a remaining provider is a separate capability decision.

### Slice 2 — Release repair removal (requires D3); packaging reclassified

- **Done — old-tag release repair removed.** Deleted all three repair patches
  (`v0.26.3-tests`, `v0.26.5-javadoc`, `v0.26.5-verification`), the two
  conditional workflow repair steps (`RELEASE_TAG == v0.26.3 / v0.26.5`), and
  their meta-tests in `managed-runtime-release.test.js` (−396 lines). These only
  ran when re-releasing dead tags, so removal does not affect future releases.
  This abandons the v0.26.3 managed-runtime backfill (locked decision D3); the
  `managed-runtime-0263-test-repair` runbook is retired accordingly. The
  workflow-wide guard forbidding disabling the Javadoc gate is retained as its
  own test. Verified: release meta-tests 48/49 (the one failure is a pre-existing
  environmental `semver` resolution issue in a temp fixture, unrelated),
  Prettier + ESLint green.
- **Deferred — profile deduplication.** Removing the pom-pinning meta-test
  unblocks deduplicating the 17 verification profiles' shared Failsafe XML, but
  that touches CI lane definitions and is left as a separate careful change.
- **Reclassified — maintenance tools are not dead code.** The 12 offline
  operator entry points (recovery, migration, CSI operations, lease recovery)
  are catalogued by `package-managed-agent-reference.mjs`, exercised by
  `managed-agent-server-e2e.test.js` and
  `integration-tests/helpers/hosted-operator-recovery-driver.ts`, and documented
  in the README. The classifier fat JARs are distinct operator tools, not
  redundant duplicates. They are retained; consolidating them into a single
  subcommand entry point would be a separate product/refactor decision, not
  dead-code cleanup.

### Slice 3 — HTTP unification: not feasible as framed (dropped)

Investigation shows the standalone `RuntimeBrokerHttpServer` is deliberate, not
redundant ceremony:

- It is started by `EmbeddedRuntimeBroker` (the host-embedded broker, independent
  of the internal Tomcat connector) and by `WorkspaceCsiRuntimeMain`, a bare
  standalone `main` with **no Spring context and no Tomcat**. The CSI runtime
  process cannot "mount routes on the internal Tomcat connector" because it has
  no Tomcat.
- The broker face has its own security/lifecycle: one global Bearer token,
  loopback-only by default, a bounded dedicated thread pool, an 8 MB request
  cap — distinct from the internal surface's writer-credential auth and the
  `InternalSurfaceConfiguration` routing filter.
- The `csi-retirement:worker-authority` "duplicate" is two different
  implementations on two ports (Spring `WorkspaceCsiApplicationController` →
  `store.workerAuthority`; broker → a per-session registered readback), not a
  trivial dedup.

Unifying would require adding Spring/Tomcat to the standalone CSI runtime,
forcing the internal connector on every embedder, reconciling two auth models,
and migrating the cross-language worker broker URL — a major redesign, not a
1,063-line deletion. **Dropped as framed.** If a single internal listener is
still wanted, it needs its own design effort; otherwise the dual server stands.

### Slice 4 — Single public API contract (requires D2; largest design task)

- Design the interactive capability set (turn submit/cancel, approval, model
  change, workspace create/register/files, transcript, event stream, …) into
  the Public OpenAPI contract.
- Update `SurfaceRegistry` and `managed-surface.txt`; run
  `ManagedAgentApiContractTest` and `SurfaceRegistryGateTest`.
- Regenerate the web-shell client
  (`npm run generate:managed-agent-api --workspace=packages/web-shell`),
  migrate UI consumers, **and migrate the host's in-process WebShell model
  usage** (`ManagedRuntimeController` / `ManagedRuntimeService` in data-agent),
  then delete the WebShell records, controllers, and parallel orchestration arm.
  Deletion is gated on both consumers being off WebShell (see Host coupling).
- Verification: contract + surface gates; affected web-shell consumer tests;
  root build/typecheck for the cross-language change.

### Slice 5 — Module consolidation (amends the Maven-modules design)

- Merge `control-plane` + `persistence`; fold the zero-isolation `runtime-*`
  micro-modules into `runtime-broker`/`adapters`. Keep `contracts` (pure) and
  `server` (assembly, exposes `ManagedAgentConfiguration`) separate.
- Delete the ~33 pure JDBC mirror interfaces as their seams become
  intra-module; eliminate the 23 Settings mirrors by relocating
  `ManagedAgentProperties` into the merged core module (core may use Spring;
  contracts stays pure). Update `ModuleArchitectureTest` to the new matrix and
  amend `2026-10-29-managed-agent-maven-modules.md`.
- Host coupling (verified; D4 authorizes host changes): the upper layer does not
  read `ManagedAgentSettings`, so the mirrors can be deleted; it injects
  `ManagedAgentProperties` by type and imports many internal packages. With D4 the
  merge may rename packages and relocate classes freely, updating the host's
  imports in lockstep (see Host coupling for the migration checklist).
- Verification: full reactor build; `ModuleArchitectureTest`; focused consumer
  tests; embedding smoke (host `@Import` still wires).

### Slice 6 — preflight simplification

- Require canonical `http(s)://host:port` at the config entry; delete the
  WHATWG subset and the shared URL fixtures (or move validation to the Node
  side). Replace `StackWalker` format sniffing with Spring's ConfigData API;
  keep value-based secret detection (URL user-information passwords and
  `?password=`/`?token=` parameters under any key) while removing only the
  YAML/comment AST and path machinery — a key-name-only scan would miss a
  credential in e.g. `spring.datasource.url` and lose the `chmod 600` warning;
  test `ServiceAccount` access as the service identity rather than root
  user-space `namei`.
- Rationale: the URL parity contract is only needed while arbitrary URL
  spellings are accepted; pre-production can refuse them.
- Verification: rewritten preflight tests over canonical input; `--check`
  smoke.

### Slice 7 — Schema redesign (time-sensitive)

- Use the single-V1 in-place editing window (module AGENTS.md: edit V1 in place
  until the first formal release; no V2+). Redesign tables where useful.
- Replace the indentation-sensitive regex catalog with a robust parser or
  Flyway-native metadata comparison **while preserving refusal of legacy,
  partial, and foreign catalogs**.
- Preserve all category-C invariants (digest chain, hash-key index layer,
  fencing).
- Verification: real MySQL `mysql-integration` cases for changed
  SQL/transaction/recovery behavior; catalog refusal tests; recreate dev
  catalogs after baseline changes.

### Slice 8 — Protocol generation trim: not dead bloat (dropped as framed)

The v2/v3/v4 generations are not redundant evolutionary layers; each serves a
distinct live subsystem, and the TS worker speaks all three:

- **v2** (`/internal/managed-runtime/v2/*`): external-runtime publications
  (`managed-external-publication.ts`).
- **v3** (`/internal/managed-runtime/v3/*`): hosted-harness bootstrap,
  activation, shell, extensions, and context control (7 TS files).
- **v4** (`/internal/managed-runtime/v4/*`): the latest tool execution
  (`managed-runtime-tool-v4-routes.ts`, CSI workspace tools).

Trimming any generation breaks a live subsystem. Collapsing them into one
protocol would be a major cross-language redesign across multiple runtime
kinds, not a deletion. **Dropped as framed.** A unified protocol is a separate
design effort if ever wanted; the multi-version surface is functional diversity
(external / hosted / CSI), not ceremony.

## Design decisions and rationale

- **Keep `contracts` pure and separate.** It is the host-compile boundary that
  makes D1 safe; its ArchUnit purity rules are retained, not removed.
- **Mirrors die by relocation, not by decree.** The Settings mirrors exist
  because `control-plane` cannot see `server`'s Spring properties. Merging the
  modules and moving the properties class removes the seam honestly.
- **Class-size ratchet may be relaxed.** It is a product of the historical
  store decomposition and a structural source of interface proliferation; with
  no production it can be removed or relaxed (decision deferred to Slice 5).
- **One surface, capability-complete.** The surviving Public surface must be a
  superset of today's two surfaces' capabilities, not a subset.

## Constraints

- Follow the module verification policy: JDK 21 / Maven ≥3.8.9, focused local
  tests within the shared 10-minute budget, full gates in CI, real MySQL for
  SQL/transaction/recovery changes, root build/typecheck for cross-language
  changes.
- Preserve the library-reuse, tenant-isolation, durable-SQL, and lease/generation
  review rules in the module AGENTS.md.
- Update both language versions of this design and of the amended Maven-modules
  design in the same change.

## Risks

- **Slice 4 scope creep.** Designing a complete interactive public contract is
  the largest task; bound it to the measured capability gap and resist adding
  speculative endpoints.
- **Slice 5 blast radius.** Module consolidation touches many files and the
  embedding wiring; it must follow a stable surface (Slice 4) and keep an
  embedding smoke check.
- **Slice 7 invariant erosion.** Schema redesign must not weaken catalog
  refusal or drop the hash-key index layer; refusal and lock-order tests are
  the guard.
- **Hidden host coupling.** The upper layer may read Settings interfaces or
  depend on a WebShell route not visible in this repo; confirm before Slice 4/5.

## Validation plan

- Per slice: focused tests for changed consumers plus the named gates above;
  record command, tested state, and outcome.
- Cross-language slice (4): root build/typecheck and affected consumer
  tests; CI retains full cross-language gates.
- SQL/recovery slice (7): real MySQL evidence locally within budget; full
  `mysql-integration` / Hosted / fault profiles in CI.
- Acceptance is pending until the required CI gates pass on the accepted
  revision; report local passes, failures, skips, and CI gaps separately.

## Acceptance criteria

- The surviving structure matches the locked decisions: one public surface,
  a pure embeddable `contracts`, no released-artifact repair path, no
  migration/recovery tooling without a service object.
- All category-C invariants and their tests remain green.
- Embedding (`@Import(ManagedAgentConfiguration.class)`) still wires and
  isolates beans; the `sessionWorktreeScheduler` isolation bug is fixed.
- Each slice lands with its focused evidence and passing CI gates; both
  language versions of this design and the amended Maven-modules design stay
  aligned.

## Open questions

- Exact Public/WebShell capability mapping (name-based comparison flags ≥24
  WebShell-only names; some may have differently named Public twins). Slice 4
  must produce a route-by-route mapping before deletion.
- Whether to relax or delete `ClassSizeRatchetTest` (deferred to Slice 5).
- Whether to drop the external runtime provider as a capability decision.
  `runtime-kubernetes` is the `kubernetes-workspace` CSI / resident-workspace
  provisioner (actively developed) and is load-bearing, not a removal candidate.
  `runtime-external` offers `external-scratch` (functional) and
  `external-workspace` (intentionally fail-closed pending step 3b/3c); removing
  it drops the external-runtime capability. Neither is dead code.
