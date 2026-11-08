# Takeover fleet visibility and cap-hit escalation

## Problem statement

As of 2026-08-11, 35 open PRs carry `autofix/takeover`. Two structural gaps:

1. **The takeover pool is invisible.** The Fleet Shepherd
   (`qwen-fleet-shepherd.yml`) enumerates only bot-authored PRs (3 today).
   The 35 human-authored takeover PRs appear on no dashboard; their state
   (working / paused / conflicting / idle-for-days) is knowable only by
   opening each PR.

2. **Cap-hit PRs die silently.** When a takeover PR reaches its round cap
   (100/100), or a circuit breaker (consecutive-failure, time-budget) stops
   it, the loop posts one comment and goes quiet. Five PRs have been paused
   since 2026-08-06 with no re-arm: #8213, #8396, #8416, #8439, #8443.
   Nothing escalates them — no label, no dashboard entry, no auto-release —
   so they hold the takeover label forever ("zombie takeover").

## Proposed changes

### A. `autofix/needs-human` label (qwen-autofix.yml)

A new maintainer-facing label meaning: _the loop has stopped on this PR; a
human must act (re-arm, split, merge, or close)_.

**Applied** in the review scan's cap-notice path (the single funnel every
terminal state passes through: round cap, consecutive-failure cap, and
time-budget cap all write a terminal `autofix-eval` marker with
`round=EFF_MAX_ROUNDS`, which the next scan sees as `ROUND >= EFF_MAX_ROUNDS`
and lands in the cap-notice branch). The label write is placed so it runs
even when the once-per-window notice comment is dedup'd — this backfills the
label onto the already-paused fleet via the regular scan rotation after
deploy (idle backoff defers PRs idle >24h to ~1 scan in 4 — expect hours,
not the first scan).

**Removed** wherever management resumes or a human takes over:

| Path                                                   | Site                 |
| ------------------------------------------------------ | -------------------- |
| `/takeover` re-arm on a managed PR                     | takeover-command job |
| `/takeover` fresh engage                               | takeover-command job |
| `/takeover stop`                                       | takeover-command job |
| Manual label engage / release acks                     | takeover-ack job     |
| `/retry` re-arm marker                                 | retry-command job    |
| Scan first-pickup engage ack (direct-label engagement) | review-scan job      |

Removal is best-effort with a warning on failure, mirroring the existing
`TAKEOVER_LABEL` DELETE pattern (404 tolerated). A stale `needs-human` left
behind by a failed removal is cosmetically wrong but harmless; the next
cap-stop reapplies it anyway.

A PR closed or merged while paused keeps `needs-human` — deliberately. No
closure removal path exists (the route drops commands on non-open PRs, every
enumeration is `--state open`, and there is no `pull_request: closed`
trigger), and the residue is inert: all consumers filter on open state, so
the label only marks the resolved escalation in the closed PR's own history.
All-state label queries should pair the label with a state filter.

Label creation follows the existing convention: `gh label create` (idempotent,
fixed color) before the first REST add, so a missing label never gets a random
color.

### B. Shepherd covers the takeover pool (qwen-fleet-shepherd.yml)

A second enumeration — open PRs with `autofix/takeover`, including forks —
drives a **second dashboard table** in the same edited-in-place issue:

| PR  | Author | Updated | State | Note |
| --- | ------ | ------- | ----- | ---- |

State comes from the list payload (conflicting / ci red / checks in flight /
idle). PRs carrying `autofix/needs-human` get a `🛑 needs-human` state; for
those few PRs the shepherd additionally reads the comment stream (fail-closed)
to recover the terminal timestamp (latest `<!-- takeover-cap-reached -->`
notice) and the stop reason (first line of the latest terminal "AutoFix
stopped" headline, else "round cap reached").

**NON-GOAL:** the existing levers (conflict dispatch, stale-base sync) stay
scoped to the bot fleet. Takeover-PR conflicts are already the autofix scan's
job (`HAS_CONFLICT` selects them as targets), and `update-branch` on
contributor branches is out of scope for this change.

### C. Auto-release lever (qwen-fleet-shepherd.yml)

When a PR carries **both** `autofix/takeover` and `autofix/needs-human` and
its terminal timestamp is older than `AUTO_RELEASE_DAYS` (default 3, tunable
via the `QWEN_SHEPHERD_AUTO_RELEASE_DAYS` repo variable):

1. Post one bilingual summary — dedup'd by its
   `<!-- fleet-shepherd auto-release -->` marker (scoped to the current
   pause cycle): why it was released, the stop reason, and the human's
   options (merge / close / split + re-takeover).
2. Remove `autofix/takeover` (the loop disengages). A failed removal finds
   the marker and retries only the DELETE; a failed summary leaves both
   labels in place so the whole release retries next tick.
3. Keep `autofix/needs-human`: the PR still needs a human decision, and the
   label remains the filterable TODO list. It clears on re-engage/re-arm via
   the paths in (A).

Idempotency needs no marker comment: the lever's scope condition (both labels)
is false after the release, so it cannot re-fire. Per-tick cap
(`MAX_RELEASES_PER_TICK`, default 3) bounds blast radius; `live_skip` is
re-checked immediately before the mutation, mirroring every existing lever.

## Key design decisions

- **Label write lives in the scan, not the address leg.** Every terminal stop
  converges on `round=EFF_MAX_ROUNDS` markers, which the scan's cap branch
  already observes with comments loaded and PAT identity verified. One hook
  point covers all stop reasons, including future ones.
- **Pause reason comes from the terminal marker headline**, because the
  scan-side notice always says "round cap (N/N)" even when a breaker fired
  (observed on #8443: both comments present).
- **Bootstrap without a backfill job:** the label write runs even when the
  notice comment is dedup'd, so currently-paused PRs are labeled by the
  regular scan rotation after deploy — note the scan's idle backoff defers
  PRs idle >24h (exactly the paused population) to ~1 scan in 4, so expect
  the backfill within a few hours (median ~2h, p90 ~6h), not minutes.
- **Auto-release keyed on the notice timestamp**, not label age: labels carry
  no timestamps, and the notice is written by the same identity-verified path
  that applies the label. Resume evidence newer than the notice vetoes the
  release — the bot's re-arm/engage markers, a re-arm command comment, or a
  fresh `labeled` event. Command comments count only while FRESH
  (`RESUME_COMMAND_GRACE_SEC`, 2h) and UNSUPERSEDED by a refusal ack
  (`fork-refused` / `base-refused` / `skip-blocked`): an accepted command is
  acked within minutes; an ignored one (no route permission) simply expires;
  and no permission check is mirrored into the shepherd — the route's
  collaborator check is the authorization gate, and a mirrored copy would
  only drift.
- **The release lever gets its own enumeration** of the paused population
  (needs-human ∩ takeover, stalest-first) — not the takeover display window
  and not the needs-human display window: released PRs keep `needs-human`
  and age back into that display window, so feeding the lever from it would
  truncate exactly the fresh pauses that become release-eligible. All three
  enumerations cap at 100 with loud saturation warnings; a display
  enumeration failure degrades to an error row, and a paused-enumeration
  failure skips the lever for that tick — the dashboard write (which
  carries the liveness watermark) always runs.
- **The summary posts before the label removal**, dedup'd by its own marker
  scoped to the current pause cycle (only markers newer than the latest cap
  notice count), so a failed comment leaves both labels in place and the
  whole release retries next tick; a failed removal finds the marker and
  retries only the DELETE; and a re-armed-and-re-capped PR still gets its
  second summary.
- **Stale-label heal:** a fork PR released by hand gets no release ack (the
  route suppresses fork `unlabeled` events), so nothing else clears its
  `needs-human`. The shepherd watches the awaiting-human pool for a
  human-actor `unlabeled` event on the takeover label that is NEWER than the
  latest label-apply (a stale unlabel from an earlier takeover cycle must
  never heal this cycle's label), and clears the stale label — bounded per
  tick, skip-vetoed, and never triggered by the bot's own auto-release.
- **Shepherd timing:** 15-minute tick with a per-tick release cap — a backlog
  of expired PRs drains over a few ticks rather than one burst.

## Files affected

- `.github/workflows/qwen-autofix.yml` — env, cap-notice branch, six
  label-removal sites.
- `.github/workflows/qwen-fleet-shepherd.yml` — env, takeover enumeration,
  dashboard takeover table plus a read-only "Awaiting human" section
  (released PRs keep `needs-human` and would otherwise vanish from every
  surface), auto-release lever.

## Scope boundaries

- No changes to round caps, breakers, or review-bot behavior.
- No shepherd levers on takeover PRs other than auto-release.
- No notification/@-mention of maintainers (comment + label + dashboard only).
- `autofix/needs-human` on plain (non-takeover) bot PRs is applied by the same
  scan path and shown on the dashboard, but the auto-release lever never
  touches them (they have no takeover label to release).

## Open questions

- Default `AUTO_RELEASE_DAYS=3` — short enough to keep the pool clean, long
  enough for a maintainer to re-arm over a weekend? Adjustable without a
  deploy via the repo variable.
