# Fleet Shepherd: close bot PRs whose merge would change nothing

[English](2026-09-18-fleet-shepherd-noop-close.md) | [简体中文](2026-09-18-fleet-shepherd-noop-close.zh-CN.md)

Date: 2026-09-18
Status: proposed — implemented in the PR that adds this document; awaiting review

## Problem

The autofix bot opens a PR per issue it claims. When another PR lands the same
fix on `main` first, the bot PR becomes a no-op: merging it would not change a
single byte. GitHub still shows it as an ordinary open PR, so the review bot
keeps reviewing it, the autofix loop keeps posting "no changes needed" rounds
on it, and a maintainer eventually notices and closes it by hand.

Since July every bot PR that was closed without merging was closed by a human.
The three strict no-ops from September show the cost:

| PR     | Became a no-op    | Closed by hand    | Open as a no-op | Bot rounds spent meanwhile |
| ------ | ----------------- | ----------------- | --------------- | -------------------------- |
| #11379 | 2026-09-08 11:19Z | 2026-09-08 22:56Z | 11 h            | 8                          |
| #11376 | 2026-09-09 14:47Z | 2026-09-17 11:26Z | 188 h           | 5                          |
| #12109 | 2026-09-17 16:09Z | 2026-09-18 02:47Z | 10 h            | 2                          |

Nothing in the automation can close such a PR today. The autofix agent lane
holds no GitHub write credentials (it said so itself on #11376), the loop's
push-and-report step has the bot PAT but no close path, and `stale.yml` only
acts after 60 + 30 days. The Fleet Shepherd walks the bot fleet every 15
minutes with the bot PAT and already owns the fleet's other levers (conflict
dispatch, stale-base sync, liveness, takeover auto-release), so it is the
natural home for one more.

## Detection: GitHub's own test merge

For every mergeable PR GitHub computes a test merge commit, exposed in GraphQL
as `potentialMergeCommit`. Its first parent is the base side. If the test
merge's tree equals that parent's tree, merging the PR adds nothing — `main`
already carries every hunk the branch proposes. One GraphQL read per
mergeable PR, no checkout.

The recipe was checked against the record before being automated:

- The three no-ops above all read equal-tree (they also showed
  `changed_files = 0`).
- Every mergeable PR in the open fleet at the time read as having changes,
  agreeing with a local `git merge-tree --write-tree origin/main <head>`.
- #10452, a bot PR closed as a _duplicate_ of another open PR, reads as having
  changes. A twin of something still open is not a no-op; it stays a human
  call, and this lever must not touch it.

`changed_files == 0` from the PR object is the cheaper signal, but it only
turns zero once `main` has been merged into the branch. The tree comparison
catches the no-op before any sync happens.

Anything short of a proven equal-tree answer — a null test merge (GitHub is
still computing it; every branch sync resets it), missing parents, an API
failure, unparsable output — is reported as _unreadable_, never as "has a
diff" and never as "no-op". The lever it feeds closes PRs, so the read fails
closed.

## The lever

The no-op close takes two ticks, both marker-deduped per head SHA and both
posted as the bot:

1. **Notice.** When the probe proves a no-op and no bot notice for this head is
   on the PR, post a bilingual notice: what was detected, that the PR closes
   on the next tick unless the head moves, and that `autofix/skip` keeps it
   open. Marker: `<!-- fleet-shepherd noop-notice sha=<head> -->`.
2. **Close.** On a later tick, if the notice for this head is present, the
   probe still proves a no-op, and a live read shows the PR still open at the
   same head, close it with a bilingual closing comment. Marker:
   `<!-- fleet-shepherd noop-close sha=<head> -->`.

A push between the two ticks moves the head, which voids the notice and
starts the pair over. A head that regains a diff simply never re-enters the
lever.

The lever sits in the fleet walk after the conflict lever and before the
stale-base sync, gated on a `MERGEABLE` snapshot only: `CONFLICTING` has no
test merge, and `UNKNOWN` means GitHub is still computing one. It deliberately
does not wait for checks to finish. A sync the shepherd itself just performed
starts a review run that would spend hours on an empty diff; closing the PR
is what cancels it.

Rails, identical in kind to the conflict lever's:

- Only the bot's own markers count; a human pasting the marker text cannot
  pull the close forward.
- An unreadable comment history, an unknown busy-state (the autofix run
  snapshot or a jobs read failed), or a live `review-address` run for this PR
  defers the lever.
- The per-tick close budget (`MAX_NOOP_CLOSES_PER_TICK`, 3) is checked before
  the PAT-backed live label read; the live `autofix/skip` recheck precedes
  both writes, and an unreadable label state fails closed.
- The live head is re-read right before the close; a closed PR or a moved
  head means no close.
- Every write goes through `act()`: dry-run performs nothing, and a failed
  write never advances a counter or a marker.
- The dashboard row shows `no-op vs main` with the lever's outcome, and an
  unreadable probe is appended to the row rather than letting the PR read as
  merely idle. The header and the tick summary report notices and closes.

## Out of scope

- **Orphaned PRs.** Ten of the seventeen open autofix PRs on 2026-09-18 had
  their linked issue closed by a human (mostly recovered CI incidents) while
  still carrying a real diff; #10455's issue was even closed by another
  merged PR. Those are not no-ops. Whether the remaining diff is still wanted
  is a human decision, and this lever leaves them alone.
- **Duplicates of open PRs** (the #10452 shape) — same reason.
- **The linked issue.** A no-op close does not touch the issue or its
  `autofix/in-progress` label; the closing comment asks a human to confirm
  `main` resolves it if it is still open. Cleaning that up automatically is a
  follow-up.
- **Preventing the birth.** Re-checking that the target still reproduces at
  a freshly fetched base before the agent writes a patch would have avoided
  #11379 outright. That belongs to the issue phase of `qwen-autofix.yml` and
  is a separate change.

## Constraints and risks

- **Stale test merge.** GitHub recomputes the test merge lazily. A test merge
  computed against an older `main` that reads equal-tree still proves the
  branch had nothing over that `main`; the branch could only regain meaning if
  `main` later reverted the fix, in which case reopening the PR (or a fresh
  autofix run) is the right recovery. The two-tick pair and the live head
  read bound the race with a push; they do not attempt to bound this.
- **Cost.** One GraphQL call per mergeable PR per tick (about 15 PRs every 15
  minutes) on top of the compare call the walk already makes; comment history
  is read only for PRs the probe flags.
- **Workflow size.** The lever grows `qwen-fleet-shepherd.yml` past its
  recorded baseline; the baseline is bumped in the same PR, well under the
  470 KB gate.

## Validation

- `scripts/tests/qwen-fleet-shepherd-workflow.test.js` pins the lever's
  placement, markers, ordering of rails, counters and dashboard wiring, and
  replays `noop_merge()` and `noop_close_lever()` verbatim under
  `set -eo pipefail` with a fake `gh`: equal-tree, differing, null, missing
  parents, API failure and garbage for the probe; and for the lever, the
  notice tick, the close tick, a stale notice for another head, a
  human-forged marker, a moved head, an already-closed PR, unreadable live
  head / comments / labels, unknown busy-state, an in-flight address run for
  this PR versus another PR, the exhausted budget, the live skip label, a
  failed write on either tick, and dry-run.
- First production ticks are observable on the Fleet Shepherd Dashboard
  (`no-op notices` and `closes` counters, `no-op vs main` rows) and can be
  rehearsed with the workflow's `dry_run` dispatch input.

## Acceptance criteria

- A bot PR whose test merge tree equals its base parent's tree receives one
  bot notice, and is closed on a later tick if its head has not moved, with
  both markers present and the dashboard reflecting it.
- No PR with a real diff, a conflicting or still-computing merge state, an
  unreadable probe, an in-flight address run, or the skip label is closed.
- Existing shepherd behaviour (conflict dispatch, sync, liveness, takeover
  pool, awaiting-human table) is unchanged; the full script test suite is
  green.

## Follow-ups

- Release the linked issue's `autofix/in-progress` claim when a no-op PR is
  closed while the issue is still open.
- Surface orphaned PRs (linked issue closed by someone else, diff still
  present) on the dashboard as a human decision, without closing them.
- Re-check reproduction at a fresh base in the autofix issue phase before a
  patch is written.
