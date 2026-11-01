# Managed Agent Store Constructor Wiring

[English](2026-11-01-managed-agent-store-wiring.md) | [简体中文](2026-11-01-managed-agent-store-wiring.zh-CN.md)

- Status: Implemented locally; focused verification passed, full CI qualification remains pending.
- Date: 2026-11-01
- Baseline: `06c1f989715fa812fc26258525ef97627c15b855`.
- Scope: `ManagedAgentStore` dependency assembly and its direct verification fixtures, independently of PR #16029.

## Problem and current state

The [structure review](2026-10-31-managed-agent-structure-review.md) identifies seven public setters on the Session store. Three are required Spring dependencies (`WorktreeFiles`, `ManagedSessionSkills`, `ExtensionPackages`); four are optional (`WorkspaceLifecycleStore`, `ManagedAgentDefinitionStore`, `SessionWorktreeStore`, `JournalEventTransport`). The constructor also creates a standalone skills store which Spring subsequently replaces. The object can therefore exist before its dependency assignment is complete.

There is an eighth injected dependency: optional, lazy `ManagedExtensionRecordStore` field injection. It has a real cycle back through `AgentStateStore`. The skills store also has its own existing lazy resource-store dependency. The other immediate dependency constructors have no eager edge back to the Session store: lifecycle uses providers for runtime resources, definitions is JDBC/digests, worktrees uses JDBC/registry/storage guard, extension packages uses its catalog/registry/archive dependencies, and journal transport uses its messaging dependencies.

## Goals and boundaries

Make all eight dependency references final, assign them through construction and remove all seven setters and the injected field. Preserve required/optional Spring resolution, the lazy record-store cycle boundary, qualifiers, transactions, SQL, protocol bytes and feature-disabled behavior. Do not change adjacent stores' injection, split business logic, change schema/routes or introduce a dependency container, builder or generic provider abstraction in production.

## Construction design

Use one explicitly `@Autowired` constructor containing the existing seven inputs, the three required dependencies and the five optional dependencies. Required dependencies remain ordinary constructor parameters so missing Spring beans still fail startup. Optional dependencies use `@Nullable` and retain the existing null guards in business methods. Inject the record store as `@Lazy @Nullable`: the lazy proxy remains unresolved during construction, preserving the original lazy field behavior and avoiding eager resolution of its `AgentStateStore` back-reference. Do not resolve that proxy or call a dependency from the constructor.

The constructor stores the injected skills instance directly; it no longer manufactures a temporary replacement. Preserve the existing qualified JDBC, mapper and clock parameters and every settings-derived field. The optional definitions, lifecycle, worktree and transport references remain concrete objects, avoiding providers whose repeated resolution could change the current null checks or dependency identity.

Keep the existing seven-argument standalone constructor because two production private-CSI helpers construct a minimal store outside Spring. It delegates once to the complete constructor, supplies the same standalone skills implementation and leaves integrations absent as before. Spring selects only the annotated complete constructor. This is an existing concrete use case, not a new compatibility ladder: no setter bridge or further constructor overload is added.

## Consumers and test fixtures

Production component scanning continues to construct the store; the private-CSI helpers retain their existing standalone construction. The test fixture that previously added local worktree files after construction becomes a constructor factory. Its default form constructs the same standalone skills behavior and local worktree adapter. A second test-only form accepts the definitions and lifecycle objects actually configured by existing tests; those callers now provide them before construction. Keep the same transactional wrapper, settings, JDBC instance and test assertions.

Migrate every `VerificationFixtures.configure(new ManagedAgentStore(...))` call to that factory. Bare standalone constructors used by read-only/private fixtures remain valid. Move the few definitions/lifecycle setup statements before factory construction; when a lifecycle fixture uses a result-store provider back-reference, register the result store after constructing the Session store, as required by that existing provider graph. Do not mutate final fields reflectively or rebuild a constructed store to emulate a setter.

## Validation

Add real Spring context tests with circular references disabled. Cover all required dependencies present, each required dependency missing, optional dependencies absent, the actual record-store/Session-store cycle, lazy target resolution and transaction-proxy identity. Assert the store has no injected fields or dependency-mutating methods and that all eight dependency fields are final. Required-bean checks must exercise Spring resolution, not just constructor annotations.

Reuse the application-context admission and skills tests, definition/approval tests and lifecycle fixtures affected by setup migration. Include a representative existing complete application context so the real component assembly is exercised alongside the minimal context. Keep SQL/repository algorithms unchanged and compare method bodies outside the constructors and removed setters. Run focused Java tests and Checkstyle under the module's shared 10-minute local verification budget using JDK 21 and a source-matching SDK; full Java/SpotBugs and platform/integration qualification remain CI work. This internal assembly refactor needs no global CLI baseline or TypeScript build.

Documentation verification checks both complete language versions, relative links and formatting. Self-audit the complete diff, including mechanically migrated fixtures, until two consecutive clean passes. Record selected tests and unrun gates separately; local context/H2 passes do not establish MySQL, Hosted or production acceptance.

## Risks, acceptance and open questions

The principal risks are making an optional bean required, eagerly resolving the record-store cycle, injecting a raw early reference instead of the transactional proxy, or changing manual fixture behavior. Preserve the lazy annotation rather than replacing it with eager `getIfAvailable`, and pin the runtime bean graph in tests. The standalone constructor's deliberately absent integrations are unchanged; the complete Spring constructor still requires its three beans.

Acceptance requires all seven public setters and field injection gone, eight final dependency fields, no change to business method bodies or SQL, migrated direct callers, successful required/optional/cycle/proxy context tests and affected regression tests, complete synchronized bilingual designs and two clean self-audit passes. No product decision is open; full CI acceptance remains pending until its required gates run on the accepted revision.
