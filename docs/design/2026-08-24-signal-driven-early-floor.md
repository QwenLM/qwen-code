# Signal-driven early severity floor (#9903)

Date: 2026-08-24
Issue: #9903 — act on the convergence/root-cause-clustering signal earlier
(auto-drop to `--severity-floor critical`) instead of only printing it.

## Problem

The convergence diagnosis (`packages/cli/src/commands/review/lib/convergence.ts`)
fires from round 3 when the same files keep producing first-time findings and
the new-finding rate is not falling, and its own `stem-surface` recommendation
already names the remedy: drop this PR's reviews to `--severity-floor
critical`. But nothing consumes that signal. Under `severityFloor: "auto"`
the floor resolves to critical on a fixed schedule — round 6
(`floorResolvesCritical` in `compose-review.ts`) — so rounds 3–5 keep posting
Suggestions inline at full volume while the body prints the advice. Each of
those rounds costs a full multi-hour review leg to re-derive the same
sibling set.

The issue's triage verdict fixed the shape: implement the **early-floor
variant** (the hard-gate variant is declined — the diagnosis keeps advisory
power), as a signal-driven early trigger on the existing `auto` posture
transition, at the same code site as the round-6 check, with a conservative
streak threshold and the drop disclosed in the round's post.

## Design

### The trigger signal

`volumeNotShrinking` — exactly the signal the `stem-surface` (floor-drop)
recommendation is matched to. The tool acts on the recommendation it already
prints, only when it prints it. A clusters-only recurrence with a falling
new-finding rate is a converging loop and never advances the trigger.

The measurement is the one the module already makes: `diagnoseConvergence`
reads FRESH drafts only, so carried-id re-posts of unfixed Criticals (steady
state) never count — the triage's first correctness constraint is inherited,
not re-implemented.

### The streak

A new ledger marker field, `flatRounds`: how many consecutive rounds the
first-time-finding rate did not fall. It advances on a firing round and
**resets on any non-firing round**. This is deliberately stricter than
`churnRounds`' carry-on-unmeasured: `churnRounds` arms a blocking Critical
where late filing loses the mechanism on exactly the churning PRs, while
`flatRounds` engages a disclosed, non-capping deferral posture where a false
engagement silently defers real Suggestions (the triage's second
constraint). A wiped streak costs one delayed engagement — the fail-open
direction every other input in this module family takes.

The engagement bar is **2 consecutive rounds** (`FLAT_STREAK_TO_ENGAGE`),
matching `CHURN_STREAK_TO_FILE`'s stated argument: two counted rounds is the
shortest window in which "not falling" is an observation rather than a
single step. In the issue's scenario (signal visible from round 3) the floor
engages at round 4 instead of round 6.

### Engagement and latch

The floor engages **on the round the streak reaches the bar** — `prevStreak
=== 1` and this round's signal fires — not the round after. Once the recorded
streak is at the bar it **latches**: later rounds engage on the recorded
streak alone, and the streak is pinned rather than re-measured.

The latch is forced by two failure modes of the alternative (re-measure every
round and stay engaged only while the streak holds):

- **The measurement dies under the floor.** Enforcement moves fresh
  Suggestions into the deferral channel, so the posted-set trend the signal
  reads goes quiet — not because the loop settled, but because the floor is
  working. Re-measuring would release the floor the round after it engaged.
- **Circularity through the `floorChanged` guard.** The volume signal
  refuses to compare two rounds that posted under different floors, and the
  floor this round posts under is the thing the trigger is deciding.
  Re-measuring against a pre-trigger floor assumption makes engagement flap
  at period two.

A latched round measures nothing, so neither failure mode is reachable. The
latch spans only rounds 4–5 in the typical case — round 6 engages
unconditionally — and the operator's explicit `--severity-floor suggestion`
still turns the posture off at any round (the trigger lives only in the
`auto` arm).

### Trust boundaries (mirroring `churnRounds`)

The marker rides a public, writable review body, so the recovered streak is
hardened exactly like the churn streak:

- clamped to the marker's own `round` at parse (`parseLedger`) and at
  side-file read (`prevLedgerFacts`) — a planted `flatRounds: 9999` cannot
  reach the bar off one honest round;
- a **foreign winner's streak is stripped** at the `pr-context` recovery
  seam — another account's marker cannot engage this account's floor;
- the side-file carry rules for anonymous recovery mirror the churn group's,
  so the latch does not drop when this account's own marker leaves the walk.

Worst case for a forged own-account-looking streak: Suggestions move into a
**disclosed** deferral list for the rest of the PR. Nothing is withheld from
the record, no verdict is capped, and the operator override disengages.

### Disclosure

A new `CriticalFloorKind`, `'auto-signaled'`, names the early engagement
everywhere the kind is read back, so the round where Suggestions move at
round 4 says why instead of presenting an unexplained posture change:

- the deferral header / floor-enforcement note states the trigger ("the
  first-time-finding rate has not fallen for N consecutive rounds");
- the convergence rendering's "already at the floor" wording covers the new
  kind.

### Model-side contract (SKILL.md)

The model cannot evaluate the deterministic trend itself — that is why the
module exists — so its Step 6 routing follows the **marker**: a recovered
`flatRounds` at the bar means the floor is critical and Suggestions route to
the deferral channel. On the round the streak first reaches the bar the
model still drafts under the old posture and the code backstop
(`floorEnforcedReroute`) moves the drafted Suggestions — precisely the
backstop's stated job — and the posted body discloses the move.

## Implementation outline

1. `lib/ledger.ts`: `Ledger.flatRounds`, serialized beside `churnRounds`
   (above the shed cascade, omitted at zero), parsed with the same
   clamp-to-round.
2. `pr-context.ts`: persist/recover `flatRounds` with the churn group's
   seam rules (foreign strip, anonymous carry).
3. `compose-review.ts`:
   - `prevLedgerFacts` recovers `flatRounds` (clamped, travels with round);
   - `composeReview` measures this round's `volumeNotShrinking` via the one
     `diagnoseConvergence` statement (pre-reroute — identical to post-reroute
     while the floor is not engaged, since no reroute is in flight), advances
     or resets the streak, pins it when latched;
   - `floorResolvesCritical` gains the signal arm: `auto` resolves critical
     when the streak is at/past the bar — as the new
     `CriticalFloorKind 'auto-signaled'`;
   - the #9410 residual-risk advisory's floor-engagement conjunct reads the
     caller's signal-inclusive enforcement state (`floorEnforcementEngaged`),
     not a schedule-only re-derivation: it surfaces from the signal-engaged
     round, not the round the schedule first proves (round 5, not round 7,
     in the scenario above);
   - the marker stamps `flatRounds` beside `churnRounds`.
4. `lib/convergence.ts`: `CriticalFloorKind` gains `'auto-signaled'` with
   rendering wording.
5. `SKILL.md`: `auto` floor rule gains the signal-driven trigger; Step 6
   routes on the marker's `flatRounds`; the deferral disclosure names it.

## Explicitly not done

- **No hard gate.** The "root cause not triaged / consider splitting the PR"
  blocker is the triage-declined variant; the existing churn-census
  non-convergence Critical already owns the blocking lane.
- **No release-on-settle.** Once latched, the floor stays engaged for the PR
  (round 6 would engage anyway). A self-releasing floor re-opens the
  oscillation and circularity the latch exists to avoid.
- **No new threshold vocabulary.** Bar = 2, the codebase's one existing
  streak constant's argument, restated — not a tuned number.
