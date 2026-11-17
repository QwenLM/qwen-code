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

| File                                                                                            | Change                                                                                                          |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/skills/bundled/loop/managed-loop-skill.ts`                                   | MANAGED_LOOP_PROFILES + derived type; Nd substitution; assertSentinelsExpanded allow-list                       |
| `packages/core/src/skills/bundled/loop/managed-loop-skill.test.ts`                              | profile single-source; Parsing inventory; allow-list test; parser-derived Nd caveat; Java supply + routing sets |
| `packages/core/src/skills/bundled/loop/SKILL.md`                                                | Nd table row + month-boundary caveat                                                                            |
| `packages/core/src/managed-runtime/contracts/managed-loop-skill-{cron,union,bundled-body}.json` | regenerated                                                                                                     |
| `scripts/run-managed-agent-server-e2e.ts`                                                       | classifierBlockAnswer + mintedScheduleId helpers; both fakes use them                                           |
| `scripts/tests/managed-agent-server-e2e.test.js`                                                | fake createdId pins; classifier + minted-id executable tests; AST classifier-wiring pin                         |

## Scope boundaries

Only the six named deferred items. The remaining ~64 deferred entries (doc stale claims, dead Java branches, child-catalog gaps, other probes) are out of scope and need their own triage against current code. No Java source change; no new CI arm.

## Acceptance criteria

- Core parity suite green (32 tests), including the inventory, allow-list, call-site, sidecar-set, Java served-set and caveat pins and the regenerated-sidecar byte-for-byte parity.
- Scripts meta suites green (183 tests), including the fake createdId pins, the executable classifier narrowing, the executable minted-id extraction and the executed classifier-wiring scanner.
- Mutation witnesses: the additive-fallback classifier mutation reddens the non-block directions; the deny-list sentinel revert reddens the new-sentinel direction; a fabricated fake createdId reddens its pin; a deleted Parsing rule reddens the inventory pin; a post-gate sibling fallback reddens the classifier-wiring pin; a caveat bound of N ≤ 45 reddens the parser-derived assertion; deleting the Java `SHELL_V3` routing branch reddens the routing-target set. Each restored byte-equal returns green.
- Real packaged-stack `--loop-skill` and `--loop-fire` arms green with the regenerated sidecars (jar rebuilt).

## Round-1 review refinements

The first review round hardened the six fixes against second-order drift (each witnessed by a mutation that reddens the new assertion and restores green):

- **Caveat accuracy + pin (R1-1).** The month-boundary gap is _at most_ N days (exactly N when the month length is a multiple of N), not strictly shorter; the caveat now says "at most N days and often shorter" and states the N ≤ 30 bound (a step of 31 already collects only day 1, since 1+31 is past the day-of-month field maximum). A parity pin requires the corrected phrases in the cron and union bodies, so deleting or rewording the caveat reddens.
- **Producer single-source (R1-2).** The regenerator now derives its targets from `MANAGED_LOOP_PROFILES` (filename `managed-loop-skill-<profile>.json`), and a parity assertion requires the committed sidecar set (excluding `bundled-body`) to equal the declared profile set — a stray or orphaned sidecar reddens.
- **Guard sources the runtime constants (R1-3).** `EXPANDING_SENTINELS` is built from `LOOP_SENTINEL_DYNAMIC` / `AUTONOMOUS_SENTINEL_DYNAMIC` (the constants the wakeup fire actually expands), so a runtime rename reddens the parity build instead of silently whitelisting a token nothing expands. The body templates and SKILL.md prose keep the literals; the guard fail-closes on any drift from the constants.
- **Call-site pin (R1-4).** A build-level test injects a brand-new sentinel into the Input section (carried verbatim into every profile) and requires `buildManagedLoopSkill` to reject it, so inlining a deny-list back into the build while keeping the export reddens.
- **Statement-anchored count pins (R1-5, R1-6).** The classifier and fake-createdId call-site pins count both arms (`toHaveLength(2)`), anchored to the full statement (trailing `;` / `?.[0];`) so an additive `?? { shouldBlock: false }` fallback or a fabricated id in either arm breaks the match; each arm's own create-call filter (`loop-cron-create` / `loop-fire-create`) is pinned separately.

## Round-2 review refinements

The second round caught a fix-induced critical and four second-order gaps (each witnessed):

- **N ≤ 30, not N ≤ 31 (round-2 critical).** `0 0 */31 * *` already matches only day 1 (the step starts at day 1 and 1+31 is past the field maximum), so N = 31 is the degeneration itself, not the last safe value; the last step matching more than one day is `*/30` (`{1,31}`). The caveat, the parity pin and both design docs now state N ≤ 30; reverting to N ≤ 31 reddens the pin.
- **Java served-set pin (R2-1).** The profile single-source now crosses the TypeScript boundary: a parity assertion reads `ManagedLoopSkill.java`'s `sidecars()` keys and requires them (minus the provenance-only `bundled` key) to equal `MANAGED_LOOP_PROFILES`. That map only _supplies_ bodies; whether a workspace profile reaches one is decided by `forProfile()`'s hand-kept routing chain, which round 3 pins as well — the original rationale named the wrong mechanism (see Round-3).
- **Executable minted-id helper (R2-2).** The fake-side extraction is consolidated into a top-level pure `mintedScheduleId(messages, createCallId)` (returns `undefined`, never an invented id), used by both arms and executed in the meta-test against hostile histories; a source-spelling count alone missed a forged `?? 'asch_' + '0'.repeat(32)` fallback and blocked the consolidation. The call sites and the loud-failure `?? 'missing-schedule-id'` fallback are pinned.
- **Classifier gate pin (R2-3).** A count pin on `if (blockAnswer !== undefined) {` (both arms) closes the gate-widening spelling (`if (blockProperties !== undefined)` + `blockAnswer ?? {…}`) that restored the mis-answer with the assignment count still two.
- **Substituted-cell pin (R2-4).** The managed Nd fix's `sub()` replacement is pinned (`midnight UTC on days 1, 1+N, … of each month`, `not.toContain('every N days')`) plus the worked-example gaps, so reverting the replacement string and regenerating cannot teach "every N days" again with every gate green.

## Verification-report follow-up

The independent `/verify-pr` round on the first refined head reported two findings and a nit; all three are closed here:

- **N ≤ 31 off by one (low).** The same defect the second review round caught as a critical; fixed by the N ≤ 30 correction above.
- **Post-gate sibling fallback (coverage gap).** The statement-anchored count pins are blind to a fallback written _after_ the gate (`if (blockAnswer === undefined) return …allow…`): both counts stay two while the fire fake mis-answers side queries again, visible only in the packaged arm. The first response counted ingredients instead — the block-allow literal and the decision variable's references. Round 3 then showed a sibling that re-derives the allow through the helper under a _second_ binding adds neither ingredient, so those counts were blind as well, and that raw-text counts redden on prose that merely names the binding. Both were replaced by an AST wiring pin (see Round-3); the ingredient counts are gone, and the structural pin needs no comment reword to stay unambiguous.
- **Stale parity counts (nit).** The PR description and the acceptance criteria above now carry the current suite sizes (core 32, scripts meta 183) and the latest real-stack occurrence key.

## Round-3 review refinements

Round 3 posted three suggestions, all instances of one root cause: a pin that asserts spelling instead of the mechanism it claims to guard. Each is fixed structurally and witnessed.

- **Classifier wiring pinned as structure, not tokens (R2-3, fix-induced).** The ingredient counts could not see a post-gate sibling that re-derives the allow through `classifierBlockAnswer` under a second binding (neither the literal count nor the `blockAnswer` reference count moves), and they ran over raw source text, so a comment merely naming the binding reddened them with an opaque count mismatch. Replaced by `loopClassifierWiring`, an AST inventory of the two loop fakes: the `blockAnswer` bindings initialised from the helper with the schema's own properties, the `!== undefined` gates, the answer expression of every `respond_in_schema` `fakeToolCall` (collected regardless of call id, so a sibling cannot hide behind a new one) — exactly one per loop classifier call id, each the gated binding itself — and the count of `respond_in_schema` string literals, so a hand-built tool call bypassing `fakeToolCall` is visible too. The scanner is executed against a hostile fake, so it cannot be vacuous: a second-binding sibling is detected and prose naming the binding and the tool name changes no count. Witnesses: the reported sibling reddens the answer-site set while the old counts stay 1 and 6; a sibling under a different call id reddens the same set; a hand-built tool call reddens the literal inventory; a comment naming `blockAnswer`, `shouldBlock: false` and `respond_in_schema` stays green; the previously covered usage-line `?? { shouldBlock: false }` fallback still reddens, now naming the offending expression instead of a count.
- **The caveat's arithmetic derived from the shipped parser (R3-1).** The bound and the worked examples were hand-written prose pins — which is how `Keep N ≤ 31` survived two rounds. The test now derives the largest step whose `parseCron('0 0 */N * *').dayOfMonth` still collects more than one day (30) and the two boundary gaps from the `*/2` day set (30-day month → 2, 31-day month → 1), and requires the cron and union bodies to contain those derived values. Witness: rewriting the caveat to `Keep N ≤ 45` and regenerating the sidecars reddens the derived assertion.
- **The Java pin covers routing, not just supply (R3-2).** `sidecars()` only supplies bodies; `forProfile()`'s hand-kept chain decides which workspace profile reaches one, so a profile appended to the tuple passed every gate this PR adds while no profile routed to its body. The parity test now also requires the set of `key = "…";` routing targets to equal `MANAGED_LOOP_PROFILES`. Creator-less profiles route to null and assign no key, so `ManagedLoopSkillTest`'s null expectations are untouched. Witness: deleting the `SHELL_V3` → `wakeup` branch reddens the routing set while the sidecar-key assertion still passes.

## Open questions

None blocking.
