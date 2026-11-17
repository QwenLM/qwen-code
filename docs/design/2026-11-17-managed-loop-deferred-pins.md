# Managed /loop deferred review pins

- Status: proposed
- Date: 2026-11-17
- Related: [Managed loop skill asset](2026-11-14-managed-loop-skill-asset.md) (#17272), [skill E2E CI wiring](2026-11-14-managed-loop-skill-asset.md) (#17433, #17470), [scheduled-fire E2E](2026-11-17-managed-loop-fire-e2e.md) (#17506)
- 中文版本: [2026-11-17-managed-loop-deferred-pins.zh-CN.md](2026-11-17-managed-loop-deferred-pins.zh-CN.md)

## Problem statement

The merged managed `/loop` slices carry review findings that were recorded as deferred under the convergence posture — acknowledged, not fixed in their rounds. Six of them are confirmed still valid on current main and are small, self-contained hardening fixes. This PR closes exactly those six; the rest of the deferred backlog (design-doc stale claims, dead Java branches, child-catalog code gaps, other probes) is left for separate follow-up.

## The six fixes

1. **Fake-model minted-id extraction pin (#17470).** Re-pointing the clear-leg pin to the assertion-side `createdScheduleId` left the fake model's own `createdId` extraction (the delete fixture's id source) unpinned. Added meta-test pins on the fake-side `const createdId = /asch_…/.exec(createResultText)` and its structured `tool_call_id === 'loop-cron-create'` filter, so a fabricated or substring extraction reddens the fast suite.
2. **Classifier narrowing executable witness (#17470).** The block-schema narrowing was pinned only as text (`'shouldBlock' in blockProperties`); an additive fallback that answers `shouldBlock:false` for any `respond_in_schema` query re-created the mis-answer of unrelated side queries (title, tool-use summary, next speaker) while staying green. Extracted the decision into a top-level pure `classifierBlockAnswer(blockProperties)` (returns the stage-exact answer for a block schema, `undefined` otherwise), used by both the skill and fire fakes, and executed it in the meta-test against block (stage 1/2) and non-block schemas. The additive-fallback mutation reddens the non-block directions.
3. **Sentinel allow-list (#17272).** The union/wakeup sentinel guard was a deny-list of the two known non-expanding forms (`<<loop.md>>`, `<<autonomous-loop>>`), so a newly added sentinel would ship undetected. Inverted to an allow-list: a body may carry only the wakeup-expanded `<<loop.md-dynamic>>` / `<<autonomous-loop-dynamic>>` forms (cron: none). Extracted as the pure `assertSentinelsExpanded(body, profile)` and executed against a hostile body with a brand-new sentinel.
4. **`Nd` cron semantics (#17272).** The interval table claimed `0 0 */N * *` means "every N days"; it is a day-of-month step (days 1, 1+N, … resetting at each month start), not a rolling N-day cadence. Corrected the bundled SKILL.md table row and added a caveat naming the month-boundary reset; updated the generator's managed substitution to the accurate UTC wording; regenerated the sidecars.
5. **Parsing rule inventory pin (#17272).** The drift guard checks source→body coverage, so a rule deleted from the bundled source is invisible to it. Added a parity test pinning the exact Parsing rule inventory (`Empty input`, `Leading interval token`, `Trailing "every" clause`, `Prompt-only input`), so a deletion reddens.
6. **Single-source profile set (#17272).** The profile list `['union', 'cron', 'wakeup']` was hand-kept in six test loops. Exported `MANAGED_LOOP_PROFILES` as the single source, derived `ManagedLoopProfile` from it, and replaced the hand-kept full lists; the `Record<ManagedLoopProfile, …>` asset map and the parity `it.each` now force coverage of every profile, so an added or removed profile cannot drift.

## Design decisions

- **Executable guards over text pins.** Fixes 2 and 3 follow the established pattern (assertCallerImportReplaced, assertScheduledFireWitness): a top-level pure declaration the meta-test loads and executes, so severing or drifting the guard reddens an assertion rather than merely failing a text match.
- **Allow-list, not deny-list.** Fix 3 fails closed on any unknown sentinel; the two expanding forms are the closed set a Managed body may teach.
- **Content fix flows through the generator.** Fix 4 edits the bundled source and the generator's substitution together and regenerates the committed sidecars, so the byte-for-byte parity test stays the oracle; no hand-edited sidecar.
- **No production runtime change.** managed-loop-skill.ts is generator/test-only (no runtime import); the only artifact a running Session reads is the sidecar JSON, copied to the Java classpath at build. The classifier helper lives in the E2E runner's fake model, not the shipped CLI.

## Files affected

| File                                                                                            | Change                                                                                    |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/core/src/skills/bundled/loop/managed-loop-skill.ts`                                   | MANAGED_LOOP_PROFILES + derived type; Nd substitution; assertSentinelsExpanded allow-list |
| `packages/core/src/skills/bundled/loop/managed-loop-skill.test.ts`                              | profile single-source; Parsing inventory pin; sentinel allow-list executable test         |
| `packages/core/src/skills/bundled/loop/SKILL.md`                                                | Nd table row + month-boundary caveat                                                      |
| `packages/core/src/managed-runtime/contracts/managed-loop-skill-{cron,union,bundled-body}.json` | regenerated                                                                               |
| `scripts/run-managed-agent-server-e2e.ts`                                                       | classifierBlockAnswer helper; both fakes use it                                           |
| `scripts/tests/managed-agent-server-e2e.test.js`                                                | fake createdId pins; classifier executable test                                           |

## Scope boundaries

Only the six named deferred items. The remaining ~64 deferred entries (doc stale claims, dead Java branches, child-catalog gaps, other probes) are out of scope and need their own triage against current code. No Java source change; no new CI arm.

## Acceptance criteria

- Core parity suite green (30 tests), including the inventory, allow-list, call-site, sidecar-set and caveat pins and the regenerated-sidecar byte-for-byte parity.
- Scripts meta suites green (181 tests), including the fake createdId pins and the executable classifier narrowing.
- Mutation witnesses: the additive-fallback classifier mutation reddens the non-block directions; the deny-list sentinel revert reddens the new-sentinel direction; a fabricated fake createdId reddens its pin; a deleted Parsing rule reddens the inventory pin. Each restored byte-equal returns green.
- Real packaged-stack `--loop-skill` and `--loop-fire` arms green with the regenerated sidecars (jar rebuilt).

## Round-1 review refinements

The first review round hardened the six fixes against second-order drift (each witnessed by a mutation that reddens the new assertion and restores green):

- **Caveat accuracy + pin (R1-1).** The month-boundary gap is _at most_ N days (exactly N when the month length is a multiple of N), not strictly shorter; the caveat now says "at most N days and often shorter" and states the N ≤ 31 bound above which the step degenerates to the 1st of each month. A parity pin requires the corrected phrases in the cron and union bodies, so deleting or rewording the caveat reddens.
- **Producer single-source (R1-2).** The regenerator now derives its targets from `MANAGED_LOOP_PROFILES` (filename `managed-loop-skill-<profile>.json`), and a parity assertion requires the committed sidecar set (excluding `bundled-body`) to equal the declared profile set — a stray or orphaned sidecar reddens.
- **Guard sources the runtime constants (R1-3).** `EXPANDING_SENTINELS` is built from `LOOP_SENTINEL_DYNAMIC` / `AUTONOMOUS_SENTINEL_DYNAMIC` (the constants the wakeup fire actually expands), so a runtime rename reddens the parity build instead of silently whitelisting a token nothing expands. The body templates and SKILL.md prose keep the literals; the guard fail-closes on any drift from the constants.
- **Call-site pin (R1-4).** A build-level test injects a brand-new sentinel into the Input section (carried verbatim into every profile) and requires `buildManagedLoopSkill` to reject it, so inlining a deny-list back into the build while keeping the export reddens.
- **Statement-anchored count pins (R1-5, R1-6).** The classifier and fake-createdId call-site pins count both arms (`toHaveLength(2)`), anchored to the full statement (trailing `;` / `?.[0];`) so an additive `?? { shouldBlock: false }` fallback or a fabricated id in either arm breaks the match; each arm's own create-call filter (`loop-cron-create` / `loop-fire-create`) is pinned separately.

## Open questions

None blocking.
