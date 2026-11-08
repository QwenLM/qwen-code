# Review: Critical direction/baseline axes and the convergence floor (#10291)

Date: 2026-08-27
Issue: #10291 — `Critical` is one bit carrying three axes; add
direction/baseline fields so the convergence floor can actually floor.

## Problem

The convergence posture (`floor: critical`, from round 6 or on the
flat-trend signal) is the review loop's only damper, and on #9659 it stopped
damping at round 17: new Criticals per round ran 7, 5, 3, 5, 4, 1, 6 over
rounds 17–23 with near-zero false positives. The floor could filter nothing
because the `Critical` class collapsed three orthogonal merge decisions into
one bit — which way the defect fails, what it is measured against, how often
it triggers. Of the ~25 findings the issue classified (31 new in all across
the seven rounds), about 6 certified falsely (a wrong result presented as
correct); the other ~19 were fail-closed corners on defenses
added in earlier rounds, most of them zero-regression against the merge base
(before the PR, a sparse checkout had no incremental review either).

## Design

### Two fields, one deferral shape

Findings gain two optional enum fields, stated by the Step 4 verifier off the
witness that confirmed the finding:

- `direction`: `certifies-falsely` (the code produces a wrong result it
  presents as correct — a wrong output, a silent corruption, a bypassed
  check, a decision over state nobody read) | `fails-closed` (refuses,
  wedges, crashes or degrades to its own absence without a wrong result).
- `baseline`: `regression` (the merge base handles the trigger correctly; the
  change breaks it — the A/B's base arm is correct) | `new-surface` (the
  failing path does not exist at the merge base — the change adds the
  feature, defense or branch the defect lives in).

At a floor resolved to `critical` (explicit, `auto` from round 6, or `auto`
with `flatRounds` at its bar), **a Critical that is `fails-closed` AND
`new-surface` is recorded, not requested** — a typed deferral like a
Suggestion's. Every other Critical posts: `certifies-falsely` at either
baseline, `regression` in either direction, and any Critical with a missing
or self-contradicting axis. The rounds-2–5 code-age rule never touches a
Critical. The issue's optional third axis (trigger frequency) is not
carried.

Replaying #9659 under the rule: the ~6 certification-direction findings
still block, the ~19 fail-closed corners route to follow-up, and the loop
plausibly settles around round 19 instead of 23.

### Carriers

| Surface                                      | Form                                                                                           | Reader                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Findings artifact (`qwen review findings`)   | `direction` / `baseline` enums, refused when misspelled                                        | report, `report_findings`, the compose state                                                             |
| `report_findings` tool (core)                | same optional enums in the schema                                                              | TUI / Web Shell / ACP display (pass-through)                                                             |
| Drafted Critical comment                     | claim-line bracket tags `[fails-closed] [new-surface]` beside the id, copied from the artifact | `floorEnforcedReroute` (backstop), `buildLedger` (marker) — claim line only                              |
| Typed deferral entry (`deferredSuggestions`) | `severity: "Critical"` + both axes                                                             | `splitDeferralChannel` — deferred only when licensed                                                     |
| Ledger marker                                | `d: 'c' \| 'f'`, `b: 'r' \| 'n'` per finding; unknown values normalise to absent               | next round's side-file work-list table (`Critical (fails-closed, new-surface)`), autofix tooling (#9907) |

### The licence

The Critical split reads the ENFORCEMENT resolution of the floor
(`criticalFloorInEffect`), computed once per compose and threaded to the
ledger build, the body composer and the mechanism-health check. A Critical
entry arriving when the floor is not in effect is relocated into the body
Criticals and posts — the fail-toward-posting direction every arm of the
floor takes. A deferred Critical never caps, never withholds the anchor,
leaves the work list. Its relation to the closure mint (#9905) follows the
mint's existing id join, in three shapes: a Critical posted earlier and
deferred now carries its `R` id in the title, so the mint reads a re-post
and does not close it; a Critical deferred on discovery — the dominant
shape in the #9659 replay — carries no id any posted work list held (its
artifact id is a `D` id), so that round's mint fails closed exactly as it
already does for a discovery-deferred Suggestion; a re-deferral of a
once-posted Critical is the same case one round later. The latter two are
the pre-existing doctrine for any id-less deferral entry, not a horizon
this feature adds; carrying the round's deferred ids in the marker would
let a re-deferral join by them and is left for a follow-up.

### Trust boundaries

- Tags are read off the claim line's head slot only — the machine tokens
  before the title, like `[probe]`: a title that merely quotes a tag is
  prose, the body's tail is writable surface, and a forged pair in either
  would otherwise defer a drafted Critical.
- An axis carrying both of its tags reads as unclassified — the backstop
  never guesses a blocker out of the posting set.
- The marker fields decide nothing in code; a spelling this version does not
  know is normalised away (like the stand-in flag `k`), never used to reject
  the entry.
- The verifier is told to omit an axis its witness cannot settle. The
  artifact and the typed channel refuse a misspelled axis rather than
  silently reading it as absent (which would post a deferrable blocker
  without anyone seeing the drop).

### Disclosure

- The deferral list line names a deferred Critical and its tags:
  `src/sparse.ts:12 — [review] Critical [fails-closed] [new-surface] …`.
- The deferral header adds why: "N Critical(s) among them are deferred by
  their axes — fails-closed on new surface, …". Bilingual.
- The floor-enforcement note and `submit`'s stderr line count moved
  Suggestions and moved Criticals separately.
- The verdict line says "N finding(s) deferred" (was "non-Critical
  finding(s)").
- The relocation note reads "a Critical is deferred only as fails-closed on
  new surface at a critical floor; this one posts".

## Implementation outline

1. `core/tools/report-findings.ts`: `FINDING_DIRECTIONS`, `FINDING_BASELINES`,
   schema fields, pass-through; `ReportedFinding` type; core exports.
2. `cli/commands/review/findings.ts`: `DIRECTIONS`/`BASELINES`, `Finding`
   fields, strict validation, round-trip, terminal render.
3. `cli/commands/review/lib/ledger.ts`: `LedgerFinding.d`/`.b`, normalisation,
   `axesOf` renderer.
4. `cli/commands/review/compose-review.ts`: axis-tag readers, typed-entry
   axes, licensed split, Critical reroute arm (seam counts adjusted per
   severity), ledger stamping via `readClaim`, disclosures, verdict wording,
   `deferrableFindingsInline`.
5. `submit.ts` (stderr wording), `pr-context.ts` (work-list table),
   `lib/agent-briefs.ts` (verify brief states the axes).
6. SKILL.md / posting.md (the model-side contract), DESIGN.md.

## Explicitly not done

- **No trigger-frequency axis.** Named optional in the issue; a "corner" is a
  judgement no witness settles.
- **No auto-filed issues.** `submit` is the only write path; a deferred
  Critical's record is the posted deferral line and the artifact's
  `D<round>-<n>` entry, and filing the follow-up issue stays with the author.
- **No Web Shell rendering.** The renderer ignores the new fields; nothing
  it displays is decided by them.
