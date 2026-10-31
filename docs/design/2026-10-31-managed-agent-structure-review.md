# Managed Agent Structure Review and Refactor Proposal

[English](2026-10-31-managed-agent-structure-review.md) | [简体中文](2026-10-31-managed-agent-structure-review.zh-CN.md)

- Status: Proposal. This document changes no code.
- Date: 2026-10-31
- Scope: `packages/managed-agent-server`
- Analyzed revision: `9ebd2de171`; figures rechecked against `origin/main`
  `e7fe14ee83` where the two differ. Line counts are a snapshot and will drift.

## Problem statement

The Managed Agent server grew from its first design (2026-09-19) to roughly
136,000 lines of production Java in about two months (289 commits touching the
module since 2026-09-01). The external boundaries are strong and
machine-enforced. The internal structure has accumulated two kinds of sediment
that get permanently expensive at the first formal release:

1. God classes in `persistence` and `runtime-broker`, mirrored by god test
   files.
2. A telescoping overload chain for session creation that is already frozen
   into the `contracts` module.

The first release is the last moment when `contracts` can change freely. This
proposal spends that window on the two highest-leverage corrections and lists
the remaining debt as follow-up slices.

## Current state

### Module layout

One Maven reactor, six production modules plus a non-published verification
module. Boundaries are enforced by
`verification/src/test/java/com/alibaba/qwen/code/managedagent/architecture/ModuleArchitectureTest.java`
(ArchUnit): no split packages, no duplicate classes, implementation modules
cannot see each other, `contracts` and `runtime-broker` are Spring-free,
`contracts`/`control-plane`/`runtime-broker` are SQL-free, and `contracts` may
not even touch `java.net.http` or `ProcessBuilder`.

| Module           | Responsibility                                     | Production lines |
| ---------------- | -------------------------------------------------- | ---------------- |
| `contracts`      | Interfaces, shared values, protocol rules          | ~24.0K           |
| `persistence`    | JDBC repositories, schema, atomic SQL operations   | ~57.4K           |
| `control-plane`  | Session/Workspace/Channel/automation orchestration | ~20.1K           |
| `adapters`       | Harness SDK, HTTP, OSS, Git, process provisioning  | ~15.5K           |
| `server`         | HTTP endpoints, Spring assembly, preflight         | ~12.6K           |
| `runtime-broker` | Runtime execution, binding, leases, recovery       | ~6.4K            |
| `verification`   | All tests; never installed or published            | ~245K            |

Other measured facts: 187 HTTP mappings, all on the API package's 23
controllers (30 classes including filters and resolvers); 38 tables in the
1,272-line V1 schema baseline; a 2,006-line module README; 200+ English
design documents under `docs/design/` (nearly all paired with Chinese
versions); a test-to-production ratio of about 1.8:1; exactly one SpotBugs
exclusion; zero `TODO`/`FIXME` markers in production code.

### What works well and must be preserved

- The ArchUnit module gate described above.
- The OpenAPI file as the single contract source, pinned by
  `ManagedAgentApiContractTest` and `SurfaceRegistryGateTest`, with WebShell
  types generated from the same file.
- Durable admission, writer lease/generation checks, and the pre-release V1
  schema policy (edit in place, refuse foreign catalogs, no Flyway repair).
- Real MySQL 8.4 integration and fault-recovery profiles in CI.
- Bilingual design documentation for every slice.

### Structural debt

**D1. God classes.** The largest production classes:

| Class                              | Module         | Lines | Notes                                                                                                        |
| ---------------------------------- | -------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| `ManagedAgentStore`                | persistence    | 7,751 | 300+ methods, 7 public setters                                                                               |
| `RuntimeBrokerService`             | runtime-broker | 6,329 | 230+ methods; cooldown and hold inventory extracted (`ExecutionObservationCooldown`, `RuntimeHoldInventory`) |
| `ManagedSessionStore`              | persistence    | 3,931 |                                                                                                              |
| `WorkspaceCsiApplicationInventory` | persistence    | 3,319 |                                                                                                              |
| `ToolPublicationDataStore`         | persistence    | 2,709 |                                                                                                              |
| `QwenHostedHarnessConnector`       | adapters       | 2,328 |                                                                                                              |
| `ManagedAgentService`              | control-plane  | 2,120 |                                                                                                              |
| `HarnessCoordinator`               | control-plane  | 1,770 |                                                                                                              |

`ManagedAgentStore` mixes session admission, turns, events, item/message
projection, worktrees, MCP management, definition pins, skills, and extension
projection. Its 7 public `set*`/`configure*` methods are mutable post-
construction wiring: the bean can be observed before it is fully assembled.
`RuntimeBrokerService` mixes provisioning, binding CAS, leases, cancellation,
recovery scans, and extension commands in a single class; the observation
cooldown and the tool-hold inventory are the first concerns delegated to
extracted collaborators (see the P1 extraction slices below). Tests mirror
the shape: `RuntimeBrokerServiceTest` is 8,002
lines and `HarnessCoordinatorTest` is 4,910 lines.

**D2. Telescoping session-creation API.** `insertWorkspaceSessionCommand` has
9 overloads in both `AgentStateStore` (contracts) and `ManagedAgentStore`
(persistence). Each capability slice (approval mode, plan mode, skills, public
children, model selection, extension pins, worktree plan) appended one
parameter and one delegating overload. The longest signature takes 20
parameters. The hosting interface `AgentStateStore` declares roughly 150
methods, so every consumer sees every capability.

**D3. Heavy protocol engines in contracts.** `CsiNativeActivationProof`
(2,038 lines) is a complete JSON canonicalization/digest/proof engine with its
own `ObjectMapper`; `ManagedExtensionRecords` is 1,799 lines; `ApiModels` is a
1,102-line single-file record container. Sharing byte-level protocol rules
between Server and Broker is correct, but the `runtimebroker` root package
still holds 45 flat files next to its existing subpackages.

**D4. Configuration surface.** `ManagedAgentProperties` is 1,114 lines with
36 `@DurationUnit` annotations; the server config package holds 21 classes.
The `MIN_V3_RESULT_WINDOW` javadoc in `RuntimeBrokerService` documents a real
binding trap: the same suffix-less number binds as seconds in the server
property and as milliseconds in other consumers. Today the trap is managed by
comments and a startup sweep. The per-field units are themselves a pinned
binding contract: `ManagedAgentPropertiesTest` walks all 36 Duration fields
and pins nine millisecond exceptions (including `Auth.allowedDrift`),
`Retention.maxAge` in days, and seconds for the rest, so "unify the units" is
a configuration behavior change, not an internal cleanup. (#15939 began
generating the configuration reference from metadata; that work is
complementary, not a substitute.)

**D5. Documentation navigability.** The 2,006-line README is an encyclopedia,
and the 200+ design documents are chronological strata. There is no single
cross-cutting "how the system works today" tour.

## Goals

- G1: Collapse the session-creation overload chain into one parameter-object
  API before the first release freezes `contracts`.
- G2: Give `ManagedAgentStore` and `RuntimeBrokerService` internal seams along
  aggregate/concern lines, without behavior changes.
- G3: Keep every existing gate green: ArchUnit, OpenAPI contract,
  SurfaceRegistry, Checkstyle, SpotBugs, and the CI test profiles.

## Non-goals

- No public or WebShell API change; the OpenAPI file is untouched.
- No schema change; the V1 baseline is untouched.
- No security-semantics change (tenant isolation, signed auth, lease/generation
  checks, revalidation windows).
- No new features, no module-boundary change, no new dependencies.

## Proposed solution

### P0 — `SessionCreationCommand` (contracts, pre-release window)

1. Add one record to `contracts` (session package):

   ```java
   public record SessionCreationCommand(
           String tenantId, String actorId, String idempotencyKey,
           String requestDigest, String agentId, String requestedRevision,
           String title, List<Map<String, Object>> input, String payloadDigest,
           WorkspaceSelection selection, String requestedApprovalMode,
           boolean approvalSelectionSupported, Boolean requestedPlanMode,
           boolean planModeSupported, List<Map<String, Object>> skills,
           boolean publicChildrenSupported, String modelId,
           List<ManagedExtensionPackages.Pin> extensionPins,
           Set<String> extensionLifecycleProfiles,
           SessionWorktreeStore.Plan worktree) {
   }
   ```

   The component list is exactly today's longest overload, named once at the
   definition site. Two limits are explicit. First, the canonical constructor
   remains positional: swapping two same-typed arguments (for example
   `tenantId` and `actorId`, both `String`) still compiles, so the record
   converges the store API but does not eliminate misordering risk at
   construction sites. If eliminating that risk is a goal, P0 must also ship
   a named-construction path — a builder with per-component methods, such as
   `SessionCreationCommand.builder().tenantId(...).actorId(...).build()` —
   which P0 ships: every migrated call site uses named construction rather
   than the positional canonical constructor. Second, adding a component
   changes the canonical constructor signature, so existing construction
   call sites break at source and binary level and must be updated in the
   same change; the pre-release hard cut makes this acceptable now, not after
   the first release. P0's committed scope is converging the store overload
   chain, including migrating every construction call site.

2. Replace the 9 overloads in `AgentStateStore` and `ManagedAgentStore` with a
   single `Admission insertWorkspaceSessionCommand(SessionCreationCommand)`.
   Hard cut, no deprecated bridge: the release has not happened, the module
   gate makes every caller enumerable, and a bridge would keep the chain alive.
   Update all callers in the same change.

3. Split `AgentStateStore` into role interfaces. Landed (2026-10-31) as six
   roles — `SessionAdmissionStore`, `SessionLifecycleStore`,
   `SessionQueryStore`, `SessionPolicyStore`, `EventProjectionStore`,
   `TurnExecutionStore` — with `AgentStateStore` kept as a composite that
   extends them, so implementations and tests keep the whole surface and
   nested records/constants resolve through inheritance (imports of nested
   types must name the owning role). A role-composition pin keeps the
   composite empty and owns no surface of its own. Consumer audit
   (call-level, corrected after review): 18 single-role consumers inject
   their role directly — lifecycle (`RenameEvidence`, `TurnInputEvidence`,
   `ChildLifecycleAdmissions`, `ActionResponseCoordinator`,
   `ContextCompressionCoordinator`, `ContextCompressionService`,
   `ManagedTaskCancelService`, `OperationReconciler`), query
   (`ManagedRuntimeCoordinator`,
   `SessionRecoveryService`, `ManagedExtensionCommandVerifier`,
   `ManagedSessionStore`), policy (`ManagedMcpManagementService`,
   `ManagedExtensionManagementService`), event projection
   (`MessageMaterializer`, `ReplayFloorAdvancer`, `ManagedToolResultStore`),
   and turn execution (`SessionWorktreeService`). Most of the remaining
   consumers span roles or forward the store into multi-role dependencies
   (Harness and broker wiring) and keep the composite.
   Four more are single-role but stay on the composite as deferred
   migrations, recorded here for P1: `ChildWorkspaceService`,
   `WorkspaceRuntimeResolver` and `ManagedAutomationService` (query), and
   `TaskCancelCoordinator` (lifecycle) — their `this(...)` calls are
   constructor delegation within the same class, not forwarding.
   `AcceptanceEvidence.settle` now takes `SessionLifecycleStore` directly,
   which also let `OperationReconciler` narrow. Narrower
   injection spreads further as P1 splits the implementation along the same
   seams. Interface segregation first, implementation split later (P1).

4. Add a pin test in `verification`, in the style of `SurfaceRegistryGateTest`:
   assert that `AgentStateStore` (and its successor role interfaces) declare
   exactly one method named `insertWorkspaceSessionCommand`. The count may
   ratchet down, never up.

### P1 — Decompose the two god classes (follow-up slices)

- `ManagedAgentStore`: split by aggregate — admission/commands, events and
  projection, turn/message queries, worktrees, definitions/skills — sharing
  the same `JdbcTemplate` and transaction manager. The module README already
  permits connection-sharing SQL helpers to stay in one package.
  Replace the 7 public setters with constructor injection; express any real
  cycle with `ObjectProvider` or `@Lazy` instead of mutable wiring. Split the
  mirrored test files in the same slices. Setter investigation (2026-10-31):
  the setters are Spring `@Autowired(required = false)` optional-dependency
  injection — four optional (`lifecycle`, `definitions`, `sessionWorktrees`,
  `journalEventTransport`), two required (`extensionPackages`,
  `creationSkills`), and `worktreeFiles` configured manually. Converting them
  to constructor `ObjectProvider` injection is a large change to this central
  7,700-line class with ~30 test wiring sites, and its correctness depends on
  Spring runtime assembly that the manual-setter unit tests do not fully
  exercise; it warrants a dedicated design pass and full integration
  verification before implementation, not an incremental slice.
- `RuntimeBrokerService`: extract module-internal collaborators for recovery
  scanning, cancellation, tool holds, and observation cooldown; the service
  becomes a facade. The module already exists, so no cross-module contract
  moves. This is the lowest-risk, highest-readability split. The observation
  cooldown is the first seam extracted (2026-10-31,
  `ExecutionObservationCooldown`): it owns the only state it touches and has
  no lifecycle of its own. The tool-hold inventory followed the same day
  (`RuntimeHoldInventory`): the durable pagination and RELEASED filter move
  verbatim, while the service keeps the admission, tenant resolution and
  error-mapping boundary. Recovery scanning was investigated next and proved
  entangled — `scanExecutions` drives `reconcileInContext`, and the
  background-process settle family owns the `SessionContext` in-memory index
  and the CAS settle loop — so extracting it now would create a collaborator
  with a dozen injected callbacks rather than a clean seam; it waits for the
  reconciliation path to become its own collaborator. Cancellation follows
  the same rule: extract only where the seam is clean. Known coverage gap
  carried into the reconciliation slice:
  the stamp-before-in-flight-slot-drop ordering in `lookupOnce` has no test
  pinning it (a pre-existing gap, identical at the base); pin it when the
  reconciliation path becomes its own collaborator and the ordering is a
  seam-level contract rather than a private lambda's internal sequence.
- Reconciliation, recovery scanning and cancellation are **not** clean
  standalone seams (investigated 2026-10-31). Unlike the cooldown and the
  hold inventory — which own their state — these paths share the service's
  core mutable state and lifecycle machinery: the `sessions`, `liveBindings`
  and `reconciliations` concurrent maps, the binding-lifecycle helpers
  (`requireAnswerableBinding`, `requireLiveBinding`, `invalidateBinding`,
  `provisioner.isUsable`), and the CAS execution settle
  (`absorbRuntimeStatus` → `settleUnstartedBackgroundSiblings`). Extracting
  any of them now would inject a dozen maps/helpers/callbacks into a
  "collaborator" that is the god class under another name. The prerequisite
  is a **shared-state registry** slice: move the three maps and the
  binding-lifecycle helpers behind a `RuntimeBindingRegistry` (or similar)
  that owns them, leaving the service to delegate. Once that registry
  exists, reconciliation/recovery/cancellation depend on a narrow owner
  instead of the service's internals and become extractable, and the M6
  ordering becomes a seam-level contract a test can pin. This registry
  slice is larger and riskier than the two clean seams and should be
  designed and reviewed on its own before implementation.
- Apply the same treatment to `ManagedSessionStore` and
  `QwenHostedHarnessConnector` afterwards, each as its own slice.

### P2 — Hygiene (opportunistic)

- Subpackage the 45 flat files in the `runtimebroker` contracts root; split
  `CsiNativeActivationProof` into stateless per-protocol classes without
  changing any digest or canonicalization byte. Record the rule "contracts
  engine classes must be stateless protocol rules" in the module AGENTS.md.
- Duration binding: the per-field units are a pinned, security-relevant
  contract (nine millisecond fields including `Auth.allowedDrift`,
  `Retention.maxAge` in days, the rest in seconds). `auth.allowed-drift=120000`
  means two minutes today; reinterpreting it as seconds would widen the
  signature-replay window to 33h20m, and rejecting suffix-less values would
  refuse configurations the binding tests currently accept. Uniform binding
  is therefore a configuration behavior change with compatibility and
  migration obligations — out of scope for this no-behavior-change proposal,
  and any such unification needs its own proposal with a migration strategy
  and validation plan. The in-scope work preserves each field's existing unit
  and acceptance semantics while making the contract more visible, for
  example by surfacing per-field units in the generated configuration
  reference.
- Slim the README to quickstart + module table + security boundary + index;
  move deep feature sections to their existing `docs/` pages. Add one
  bilingual cross-cutting architecture tour.

## Design decisions and rationale

- **Parameter record over more overloads.** The overload chain is the defect;
  a record names every argument once at the definition site and keeps the
  store method signature stable as capabilities grow. The record does not
  make construction positional-safe (same-typed swaps still compile), and
  each new component still changes the canonical constructor signature, so
  construction call sites and binary compatibility need handling in every
  extension — acceptable under the pre-release hard cut, not afterwards. A
  named-construction builder is the mechanism if misordering elimination
  becomes a goal; P0 ships it, and every migrated call site uses named
  construction.
- **Hard cut over a deprecated bridge.** Pre-release, simplicity-first wins;
  a bridge preserves the chain and doubles the contract surface during
  migration.
- **Interface split before implementation split.** Consumers get isolation
  immediately with near-zero behavioral risk; the risky physical split follows
  with the interface seams already in place.
- **Maintainer-initiated.** The root AGENTS.md hard-blocks external 500+ line
  core refactors. This proposal is maintainer-authored precisely so the P1
  slices can proceed under that rule.

## Constraints

- Module AGENTS.md verification policy applies: JDK 21, focused local tests
  within the shared 10-minute budget, full suites owned by CI. SQL-touching
  splits need real MySQL evidence; broker recovery splits need the Hosted/fault
  profiles in CI.
- `contracts` stays Spring-free, SQL-free, and HTTP-client-free; the ArchUnit
  gate must pass unchanged.
- Public routes, `SurfaceRegistry`, and the OpenAPI file must show zero diff;
  run `ManagedAgentApiContractTest` and `SurfaceRegistryGateTest` anyway as the
  regression gate.
- Byte-level protocol semantics (digests, canonicalization, signature inputs)
  are invariant across every slice.

## Risks

- **Diff size and review burden.** Mitigation: P0 ships alone; each P1
  aggregate is its own PR; no slice mixes refactor with behavior change.
- **Setter removal exposes initialization-order assumptions.** Mitigation:
  constructor injection makes the order explicit; the existing integration and
  recovery suites are the regression net.
- **Concurrent feature slices conflict with the split.** Mitigation: land P0
  first (it is the time-critical piece); schedule P1 slices between feature
  waves and rebase promptly.
- **Figure drift.** All counts are a snapshot at the analyzed revision; the
  acceptance criteria below are structural, not numeric.

## Validation plan

- P0: focused unit tests for the new record and every migrated caller;
  `mvn -Dtest=<affected> test checkstyle:check` locally within budget;
  `ManagedAgentApiContractTest`, `SurfaceRegistryGateTest`, and the new pin
  test; full `mvn verify` in CI.
- P1: focused tests per extracted class plus the mirrored split test files;
  `mysql-integration` cases for SQL-touching splits; Hosted/fault profiles in
  CI for broker recovery extraction.
- P2 documentation: Prettier and relative-link checks; both language versions
  updated in the same change.

## Acceptance criteria

- `contracts` declares exactly one `insertWorkspaceSessionCommand`, taking a
  `SessionCreationCommand`; the pin test is green and ratchets.
- `ManagedAgentStore` has no public setter/configure wiring; the two target
  god classes are decomposed (P1 complete when no class in `persistence` or
  `runtime-broker` exceeds the agreed size ratchet).
- Zero OpenAPI diff, zero schema diff, all ArchUnit/Checkstyle/SpotBugs gates
  green, CI full profiles green on the accepted revision.
- README and the architecture tour exist in both languages with reciprocal
  links (P2).

## Open questions

- Resolved (2026-10-31): `SessionCreationCommand` lives in the contracts
  session package next to `AgentStateStore`.
- Resolved (2026-10-31): P0 ships the named-construction builder, and every
  migrated call site uses it; the overload convergence and the builder landed
  in the same change. Role-interface segregation (P0 step 3) follows as a
  separate slice.
- Whether to introduce the class-size ratchet gate before P1 (to stop
  regrowth) or only after the splits land.
- Sequencing of P1 slices against in-flight feature work on the same classes.
