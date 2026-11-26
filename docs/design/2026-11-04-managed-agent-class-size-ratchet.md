# Managed Agent class-size ratchet

[English](2026-11-04-managed-agent-class-size-ratchet.md) | [简体中文](2026-11-04-managed-agent-class-size-ratchet.zh-CN.md)

## Status and scope

- Status: implemented; enforcement is verification-only. Receipt-helper extraction preserves runtime validation while tightening the ceilings.
- Date: 2026-11-04; updated 2026-11-22
- Scope: `packages/managed-agent-server` — the `persistence` and `runtime-broker` production sources.
- Baseline: `origin/main` `14a5a2d98d`, after the store decomposition (#16090, #16142) and the broker extraction cluster landed.

This resolves the open question left by the [structure review](2026-10-31-managed-agent-structure-review.md): whether to introduce the class-size ratchet gate before P1 (to stop regrowth) or only after the splits land. At introduction, the two headline god classes were decomposed — `ManagedAgentStore` was a 1,170-line facade, `ManagedSessionStore` was a 357-line facade, and `RuntimeBrokerService` was a 4,270-line facade over nine collaborators — so the gate was introduced **after the splits landed**, to lock in those gains. The structure review's acceptance criteria already name this gate: "P1 complete when no class in `persistence` or `runtime-broker` exceeds the agreed size ratchet."

Combining upstream's extraction of provisioning failure handling with the move of the existing `sameReceipt` pure comparison into `RuntimeBrokerSupport` left the broker facade at 4,216 lines over ten collaborators at that original baseline. The receipt comparison body and its two acknowledgement call sites remained unchanged; the global and broker-specific ceilings both tightened to 4,216 then.

## Current landed state (2026-11-22)

The gate covers the `persistence/src/main/java` and `runtime-broker/src/main/java` roots. The current global ceiling is **2,481 lines**, matching `ToolPublicationDataStore` as the current largest class and its per-class pin. The next-largest actual class is `JdbcManagedExtensionRecordStore` at 2,095 lines (still carrying its earlier 2,170-line pin); `JdbcRuntimeBindingRepository` measures 2,087 lines and retains its earlier 2,319-line pin. Because pins are only lowered by explicit reviewed edits rather than auto-tightened, 21 of the 23 pinned entries currently sit above their class's measured size.

Adding the private `ossScope` helper grew `ToolPublicationDataStore` from 2,481 to 2,485 lines, above the then-current 2,483 ceiling established by #17478. On main, #18085 moved that scope helper to `ToolPublicationContract`, reduced the store to 2,482 lines, and lowered both the global maximum and that class's pin from 2,483 to 2,482. Here, replacing the three inline expressions with `ToolPublicationObjectKeys` calls does not change their line counts; deleting the resulting unused `ossScope` import is the one-line reduction from 2,482 to 2,481, and both ceilings follow that step. The persisted key layout is unchanged. The 4,216-line value and other class sizes in the preceding historical narrative describe the original design baseline, not today's ceilings.

## Problem

The decomposition moved responsibilities out of the god classes, but nothing stops them from growing back. Without a gate, a future capability slice can quietly re-accumulate thousands of lines into `ManagedAgentStore` or one of its aggregates, undoing the split one convenience method at a time. The overload-count ratchet (`SessionCreationCommandContractTest`) protects the session-creation API shape, but not class size. A class-size ratchet makes regrowth a visible, failing change instead of silent drift.

## Design

A single verification test, `ClassSizeRatchetTest` (in the `architecture` package next to `ModuleArchitectureTest`), walks the production source trees of `persistence/src/main/java` and `runtime-broker/src/main/java`, counts source lines per top-level class, and enforces four rules against a pin resource, `class-size-ratchet.properties`:

1. **Global ceiling.** No class exceeds `GLOBAL_MAX_LINES` (2,481 currently; 4,216 in the original design baseline). This is the "agreed size ratchet" of the acceptance criteria, seeded at the then-current largest class and tightened as decompositions land. It only ever lowers.
2. **Per-class ceiling.** Every class listed in the pin must have at most its pinned line count. Each entry is seeded at the class's size when pinned and lowered only by reviewed edits, so a pinned class cannot exceed its ceiling (a class that has since shrunk retains headroom up to its pin until that pin is manually tightened).
3. **Large classes must be pinned.** Any class at or above `LARGE_CLASS_THRESHOLD` (800 lines) that is not in the pin fails. A class therefore cannot silently grow into a large one; crossing 800 lines forces a conscious pin at its then-current size.
4. **No stale pins.** Every pin entry must map to an existing production class. Deleting or renaming a class forces its pin to be pruned, keeping the pin honest.

Line counts count newline characters, matching `wc -l`; `package-info.java` and `module-info.java` are excluded. Source roots are resolved through `VerificationFixtures.moduleRoot()` (the `managed.module.root` property the build already injects), so the gate works in the reactor and in CI.

### Thresholds and why

- **`LARGE_CLASS_THRESHOLD = 800`.** A round cutoff covering all current large aggregates and facades, and a threshold for making size growth explicit. Reaching 800 lines triggers a review of the class's size and ownership rather than being treated as an arbitrary architectural defect. Unpinned classes below 800 lines are free to change without tripping the gate, so ordinary edits to small helpers do not require pin updates; classes that were pinned and later shrank below 800 lines remain capped by their pin until removed.
- **`GLOBAL_MAX_LINES = 2481`.** This is the current maximum, matching `ToolPublicationDataStore` and its per-class pin; the next-largest actual class is `JdbcManagedExtensionRecordStore` at 2,095 lines. It remains the backstop for every class, pinned or new, and tightens as classes are decomposed.
- **Scope is exactly `persistence` + `runtime-broker`.** These are the two modules the acceptance criteria name. The `runtime-*` provider modules (`runtime-http`/`host`/`local`/`external`/`ssh`/`static`) are separate top-level modules and out of scope; `contracts`, `control-plane`, `adapters`, and `server` are likewise not ratcheted here.

### Ratchet discipline

Ceilings only ever go **down**. When a class shrinks, lower its ceiling in the pin; when a class is deleted or renamed, remove its entry; lower `GLOBAL_MAX_LINES` as the large classes are split. Raising a ceiling or the global maximum is a visible diff that review rejects — the same convention as the overload-count ratchet. The pin header documents this discipline next to the entries.

Exception (PR #16023): two pins rose above the base because the PR adds new
production surface to those classes. `JdbcRuntimeBindingRepository` gained
`findLatestForRequest` and `retireUnacquiredExternal` (the external-workspace
retirement path), growing 2319 → 2360. `RuntimeBrokerService` gained the
resident-external dispatch arms, growing 1909 → 2028. Both raises are the
minimum needed to cover the new code; the pins will tighten again when the
follow-up decomposition extracts the new surface.

## Verification

- Historical baseline verification: `ClassSizeRatchetTest` — `Tests run: 1, Failures: 0, Errors: 0` (JDK 21, isolated task repository). Checkstyle (which includes test sources) reports zero violations for the new test.
- Each rule is mutation-verified with a byte-level backup and sha256-verified restore:
  - Lower `ManagedAgentStore`'s ceiling to 100 → fails: "grew to 1170 lines, above its ratchet ceiling 100" (rule 2).
  - Remove `ManagedAgentStore`'s pin entry → fails: "reached 1170 lines (>= 800) but is not pinned" (rule 3).
  - Add a pin for a nonexistent class → fails: "stale ratchet pin … no longer maps to a production class" (rule 4).
  - Lower `GLOBAL_MAX_LINES` to 100 → fails: "… above the global ceiling 100" (rule 1).
  - After restore, the gate is green again.

- Receipt-helper extraction acceptance requires the source-size gate and the exact-receipt acknowledgement tests (`RuntimeSshAcknowledgementTest` and `RuntimeBrokerServiceTest`) in CI. The extraction changes method ownership, preserving the comparison body and acknowledgement locking.

## Harness lifecycle extraction (2026-11-26)

The existing drained-stop and Harness lifecycle delegation methods move from `RuntimeBrokerService` to its package-private `RuntimeHarnessLifecycle` collaborator, keeping the same public methods and the original `RuntimeDrainCoordinator` ownership. The facade ceiling lowers from 1977 to 1976. The global ceiling and other class pins are unchanged.

## Follow-up

- As each remaining large class is decomposed, lower its ceiling (or prune it) and lower `GLOBAL_MAX_LINES`; the structure-review ledger's acceptance criterion is met when no class exceeds the agreed ratchet.
- The gate deliberately does not auto-tighten pins; tightening is a reviewed edit, keeping the ratchet a conscious decision rather than a snapshot that silently drifts.

Related designs: [structure review](2026-10-31-managed-agent-structure-review.md), [store decomposition](2026-11-02-managed-store-decomposition.md).
