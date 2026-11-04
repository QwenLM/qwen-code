# Managed Agent class-size ratchet

[English](2026-11-04-managed-agent-class-size-ratchet.md) | [简体中文](2026-11-04-managed-agent-class-size-ratchet.zh-CN.md)

## Status and scope

- Status: implemented; enforcement is verification-only. Receipt-helper extraction preserves runtime validation while tightening the ceilings.
- Date: 2026-11-04; updated 2026-11-05
- Scope: `packages/managed-agent-server` — the `persistence` and `runtime-broker` production sources.
- Baseline: `origin/main` `14a5a2d98d`, after the store decomposition (#16090, #16142) and the broker extraction cluster landed.

This resolves the open question left by the [structure review](2026-10-31-managed-agent-structure-review.md): whether to introduce the class-size ratchet gate before P1 (to stop regrowth) or only after the splits land. At introduction, the two headline god classes were decomposed — `ManagedAgentStore` is a 1,170-line facade and `ManagedSessionStore` a 357-line facade, and `RuntimeBrokerService` is a 4,270-line facade over nine collaborators — so the gate is introduced **after the splits land**, to lock in those gains. The structure review's acceptance criteria already name this gate: "P1 complete when no class in `persistence` or `runtime-broker` exceeds the agreed size ratchet."

The subsequent move of the existing `sameReceipt` pure comparison into `RuntimeBrokerSupport` reduces the broker facade to 4,247 lines. Its two acknowledgement call sites and method body remain unchanged; the global and broker-specific ceilings both tighten to 4,247.

## Problem

The decomposition moved responsibilities out of the god classes, but nothing stops them from growing back. Without a gate, a future capability slice can quietly re-accumulate thousands of lines into `ManagedAgentStore` or one of its aggregates, undoing the split one convenience method at a time. The overload-count ratchet (`SessionCreationCommandContractTest`) protects the session-creation API shape, but not class size. A class-size ratchet makes regrowth a visible, failing change instead of silent drift.

## Design

A single verification test, `ClassSizeRatchetTest` (in the `architecture` package next to `ModuleArchitectureTest`), walks the production source trees of `persistence/src/main/java` and `runtime-broker/src/main/java`, counts source lines per top-level class, and enforces four rules against a pin resource, `class-size-ratchet.properties`:

1. **Global ceiling.** No class exceeds `GLOBAL_MAX_LINES` (4,247). This is the "agreed size ratchet" of the acceptance criteria, seeded at the current largest class (`RuntimeBrokerService`). It only ever lowers.
2. **Per-class ceiling.** Every class listed in the pin must have at most its pinned line count. The pin is seeded at each large class's current size, so a pinned class cannot grow at all.
3. **Large classes must be pinned.** Any class at or above `LARGE_CLASS_THRESHOLD` (800 lines) that is not in the pin fails. A class therefore cannot silently grow into a large one; crossing 800 lines forces a conscious pin at its then-current size.
4. **No stale pins.** Every pin entry must map to an existing production class. Deleting or renaming a class forces its pin to be pruned, keeping the pin honest.

Line counts count newline characters, matching `wc -l`; `package-info.java` and `module-info.java` are excluded. Source roots are resolved through `VerificationFixtures.moduleRoot()` (the `managed.module.root` property the build already injects), so the gate works in the reactor and in CI.

### Thresholds and why

- **`LARGE_CLASS_THRESHOLD = 800`.** A round line just below the smallest current large class (802). It captures every current aggregate and facade, and treats "reached 800 lines" as the point where a class becomes large enough to deserve an explicit, reviewed ceiling. Classes below it are free to change, so ordinary edits to small helpers do not trip the gate.
- **`GLOBAL_MAX_LINES = 4247`.** The tightest value that passes today (the current maximum). It is a backstop that no class — pinned or new — may exceed, and it ratchets down as the remaining large classes (`WorkspaceCsiApplicationInventory` 3,329, `ToolPublicationDataStore` 2,709, `JdbcRuntimeBindingRepository` 2,671, `ManagedExtensionRecordStore` 2,170, and the broker facade) are decomposed.
- **Scope is exactly `persistence` + `runtime-broker`.** These are the two modules the acceptance criteria name. The `runtime-*` provider modules (`runtime-http`/`host`/`local`/`external`/`kubernetes`/`ssh`/`static`) are separate top-level modules and out of scope; `contracts`, `control-plane`, `adapters`, and `server` are likewise not ratcheted here.

### Ratchet discipline

Ceilings only ever go **down**. When a class shrinks, lower its ceiling in the pin; when a class is deleted or renamed, remove its entry; lower `GLOBAL_MAX_LINES` as the large classes are split. Raising a ceiling or the global maximum is a visible diff that review rejects — the same convention as the overload-count ratchet. The pin header documents this discipline next to the entries.

## Verification

- Historical baseline verification: `ClassSizeRatchetTest` — `Tests run: 1, Failures: 0, Errors: 0` (JDK 21, isolated task repository). Checkstyle (which includes test sources) reports zero violations for the new test.
- Each rule is mutation-verified with a byte-level backup and sha256-verified restore:
  - Lower `ManagedAgentStore`'s ceiling to 100 → fails: "grew to 1170 lines, above its ratchet ceiling 100" (rule 2).
  - Remove `ManagedAgentStore`'s pin entry → fails: "reached 1170 lines (>= 800) but is not pinned" (rule 3).
  - Add a pin for a nonexistent class → fails: "stale ratchet pin … no longer maps to a production class" (rule 4).
  - Lower `GLOBAL_MAX_LINES` to 100 → fails: "… above the global ceiling 100" (rule 1).
  - After restore, the gate is green again.

- Receipt-helper extraction acceptance requires the source-size gate and the exact-receipt acknowledgement tests (`RuntimeSshAcknowledgementTest` and `RuntimeBrokerServiceTest`) in CI. The extraction changes method ownership, preserving the comparison body and acknowledgement locking.

## Follow-up

- As each remaining large class is decomposed, lower its ceiling (or prune it) and lower `GLOBAL_MAX_LINES`; the structure-review ledger's acceptance criterion is met when no class exceeds the agreed ratchet.
- The gate deliberately does not auto-tighten pins; tightening is a reviewed edit, keeping the ratchet a conscious decision rather than a snapshot that silently drifts.

Related designs: [structure review](2026-10-31-managed-agent-structure-review.md), [store decomposition](2026-11-02-managed-store-decomposition.md).
