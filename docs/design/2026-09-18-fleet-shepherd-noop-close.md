# Fleet Shepherd: close bot PRs whose merge would change nothing

[English](2026-09-18-fleet-shepherd-noop-close.md) | [简体中文](2026-09-18-fleet-shepherd-noop-close.zh-CN.md)

Date: 2026-09-18 (revised 2026-09-19 after review rounds 1–2)
Status: proposed — implemented in [#12150](https://github.com/QwenLM/qwen-code/pull/12150); awaiting review

## Problem

The autofix bot opens a PR per issue it claims. When another PR lands the same
fix on `main` first, the bot PR becomes a no-op: merging it would not change a
single byte. GitHub still shows it as an ordinary open PR, so the review bot
keeps reviewing it, the autofix loop keeps posting "no changes needed" rounds
on it, and a maintainer eventually notices and closes it by hand.

Of the 54 bot PRs closed without merging since July, 45 were closed by a
human. Triage's pre-stage already closes a bot PR at open time when its whole
diff is subsumed by a merged fix for its linked issue (#10788, #11018), but
nothing closes one that becomes — or is only recognised as — a no-op later.
Three such no-ops from September show the cost:

| PR     | Detectable as a no-op | Closed by hand    | Open as a no-op | Autofix-bot comments from then on |
| ------ | --------------------- | ----------------- | --------------- | --------------------------------- |
| #11379 | 2026-09-08 11:19Z     | 2026-09-08 22:56Z | 11 h            | 8                                 |
| #11376 | 2026-09-09 14:47Z     | 2026-09-17 11:26Z | 188 h           | 5                                 |
| #12109 | 2026-09-17 16:09Z     | 2026-09-18 02:47Z | 10 h            | 2                                 |

"Detectable" is the first head commit whose tree equals a `main` tree — the
moment the detection below can see it (see _Which `main`_).

Nothing in the automation closes such a PR once triage has run. The autofix agent lane
holds no GitHub write credentials (it said so itself on #11376), the loop's
push-and-report step has the bot PAT but no close path, and `stale.yml` only
acts after 60 + 30 days. The Fleet Shepherd walks the bot fleet every 15
minutes with the bot PAT and already owns the fleet's other levers (conflict
dispatch, stale-base sync, liveness, takeover auto-release), so it is the
natural home for one more.

## Detection: GitHub's own test merge

For every mergeable PR GitHub builds a test merge commit, exposed in GraphQL
as `potentialMergeCommit`. Its first parent is the base side; its second
parent is the head side, and the probe requires it to equal the fleet
snapshot's head — anything else reads as `head-moved` — so an equal-tree
verdict is bound by construction to the head a notice would name, whatever
GitHub's rebuild timing does. If the test merge's tree equals its base
parent's tree, merging the PR adds nothing — that `main` already carries
every hunk the branch proposes. One GraphQL read per mergeable `autofix/*`
PR, no checkout.

The recipe was checked against the record before being automated:

- The three no-ops above all read equal-tree (they also showed
  `changed_files = 0`).
- Every mergeable PR in the open fleet at the time read as having changes,
  agreeing with a local `git merge-tree --write-tree origin/main <head>`.
- #10452, a bot PR closed as a _duplicate_ of another open PR, reads as having
  changes. A twin of something still open is not a no-op; it stays a human
  call, and this lever must not touch it.

**Which `main`.** The one the test merge was built against, which is not
necessarily today's. GitHub builds the test merge when the PR's head moves, and
rebuilds it against a newer `main` only some of the time: across the open PRs
it was seen rebuilding in batches after some `main` pushes with no head move
(one PR whose head last moved in July carried a test merge built in
September), but not reliably: on 2026-09-19 six of 15 bot PRs were rebuilt
within two minutes of a `main` push and the other nine not at all, and a day earlier 15
of 16 lagged `main`, by up to 21 commits and some 60 shepherd ticks of reads. What triggers
a rebuild is not documented and was not found. The verdict is therefore "a
no-op against the `main` the test merge was built against", and the probe reads
that base commit so the notice and the closing comment can quote it. Two
consequences:

- A PR that is _born_ a no-op (#11379: `main` already had the fix when the PR
  opened) is seen on the next tick.
- A PR that _becomes_ a no-op because a twin lands later is seen once GitHub
  next rebuilds its test merge — normally no later than the first tick after
  its head next moves (one tick more if GitHub is still building the test
  merge): the loop's own merge of `main`, a conflict resolution, or the
  shepherd's stale-base sync. That is how #11376 and #12109
  became visible: #11376's fix had landed on `main` 2 h 36 m before the merge
  commit in the table; #12109 became a no-op through its own conflict
  resolution. They then sat for 188 h and 10 h, which is the part this lever
  removes.

`changed_files == 0` from the PR object is a cheaper but weaker signal: it
needs `main` to have been merged into the branch, so it misses a born no-op
whose branch predates the fix, which the tree comparison sees.

Anything short of a proven equal-tree answer is never reported or acted on as
a no-op, and never reported as "has a diff". The lever it feeds closes PRs, so
the read fails closed: the lever is deferred and no PR is closed. The PR's
other levers do not depend on the probe and proceed as for any PR, so a dead
probe never takes the sync down with it. The probe names which non-answer it
got, because a dead probe must not look like the benign wait:

| `NOOP_STATE`    | Meaning                                                                                                                                                                                                         | Reported as                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `no-test-merge` | GitHub has not built the test merge yet (every head move resets it)                                                                                                                                             | row note only — benign                                  |
| `head-moved`    | the PR's head moved since the fleet snapshot, or the test merge was built from an older head (its head-side parent is not the snapshot head) — either way the verdict is not about the head a notice would name | row note only — benign; the next tick sees the new head |
| `api-failure`   | `gh` exited non-zero: a lost PAT scope, a rate limit, a renamed field                                                                                                                                           | row note, counted, warned with `gh`'s own error         |
| `unparsable`    | the body is not JSON, carries no `pullRequest` node, no head or no close-event count, or the test merge has no tree or no base parent (shape drift)                                                             | row note, counted, warned                               |

Failures are counted per tick (`no-op probe failures` in the dashboard header,
`noop_probe_failures` in the tick summary) and raise one `::warning::` per
tick naming the first cause, so a probe that is broken for the whole fleet
cannot hide behind per-row notes for weeks.

## The lever

The no-op close takes two steps on separate ticks, both posted as the bot:

1. **Notice.** When the probe proves a no-op and no usable bot notice for this
   head is on the PR, post a bilingual notice: what was detected and against
   which `main` commit, that the PR closes on a later tick unless the head
   moves — no sooner than 10 minutes from the notice, usually within about
   20 — what can postpone it (a live autofix run for the PR, an unreadable
   state, the per-tick close cap), that `autofix/needs-human` parks it for a
   human, and that `autofix/skip` keeps it open. `autofix/skip` is the
   fleet-wide opt-out, not a no-op-lever switch: the PR leaves the shepherd's
   snapshot entirely — no dashboard row, no conflict dispatch, no stale-base
   sync — until the label is removed. Marker:
   `<!-- fleet-shepherd noop-notice sha=<head> -->`, deduped per head SHA
   within `NOOP_NOTICE_MAX_AGE_SEC`.
2. **Close.** On a later tick, if the newest notice for this head is inside
   its age window, the probe still proves a no-op, and a live read shows the
   PR still open at the same head, close it, then post a bilingual closing
   comment as a separate write. Marker:
   `<!-- fleet-shepherd noop-close sha=<head> -->`.

A push between the two steps moves the head, which voids the notice and
starts the pair over. A head that regains a diff simply never re-enters the
lever.

**The notice's age window.** Tick spacing is not a contract: over 399 gaps
between 400 consecutive scheduled ticks the median was about 950 s and the
minimum 427 s, and the review measured a queued successor released 75 s after a
delayed tick ended — about 2 minutes from notice to close. So the reaction
window the notice promises is enforced on the notice's own timestamp rather
than assumed from the schedule. The close waits until the notice is at least
`NOOP_NOTICE_GRACE_SEC` (600) old. It is 600 rather than the 900 of one
schedule interval because 44% of real gaps are under 900 s but only 7.5% are
under 600 s — 900 would push nearly half of all closes to a third tick for no
human benefit, where 600 does so for about one close in ten. A notice older
than `NOOP_NOTICE_MAX_AGE_SEC` (86400) has spent its warning — it sat through
a long deferral, or through an `autofix/skip` that was removed more than a day
after it — so it is treated as absent and a fresh notice is posted first,
which costs one more tick. Inside that day a standing notice still counts. A
notice that exists but cannot be dated defers the lever.

**At most once per PR.** Nothing automated reopens PRs in this repository, so
a PR that was closed before and is open again was reopened by a human —
whoever closed it: this lever, triage's pre-stage, or a maintainer (among 214
bot PRs since July there is exactly one reopen, by a human). From then on the
lever leaves that PR to the human, at the same head or any later one — the
closing comment says so. The evidence is the PR's own close events, which the
probe counts in the same GraphQL call (`filteredCount` of `CLOSED_EVENT`;
`totalCount` ignores the filter and would read every PR as closed before); it
does not depend on the closing comment having been posted. This is what makes
reopening a usable recovery for the stale-verdict risk below, and it also
covers a PR someone else closed in the instant before the lever's own close. The close and its comment are still two writes,
close first: a bundled `gh pr close --comment` posts the comment before
closing, and a "Closed as a no-op" comment for a close that then failed would
be false text, re-posted on every tick.

**Autofix branches only.** The lever acts on `autofix/*` branches. The bot
account also carries PRs that a person or another agent is driving — more than
a third of its PRs since July — and nothing here can see that work in progress
the way it can see a `review-address` run, so a branch that matches `main`
for a moment (a placeholder, a first push) is not this lever's to close. All
three motivating no-ops were `autofix/issue-*` branches.

**Parked PRs are exempt.** A PR carrying `autofix/needs-human` is one the loop
stopped on and handed to a human (merge / close / split / re-engage). It is
neither noticed nor closed by this lever: a close would drop it from the
open-only awaiting-human table and decide for the human it is waiting on. The
dashboard row still reads `no-op vs main`, so the human's decision is one
click. The label is checked on the fleet snapshot (no further read is spent)
and again on the live labels before either write.

The lever sits in the fleet walk after the conflict lever and before the
stale-base sync, gated on a `MERGEABLE` snapshot only: `CONFLICTING` has no
test merge, and `UNKNOWN` means GitHub is still computing one. A branch
already proven contained in `main` is closed rather than synced — a sync would
only buy CI and a review run on an empty diff. It deliberately does not wait
for checks to finish either: the review run a fresh sync just started would
spend hours on an empty diff, and closing the PR is what cancels it.

Rails, identical in kind to the conflict lever's:

- Only the bot's own notice counts; a human pasting the marker cannot pull the
  close forward.
- The comment history is read across all pages and merged. GitHub returns
  comments oldest-first, so a first-page read would never see the bot's own
  notice on a long thread and would re-post it every tick without ever
  closing.
- A live `review-address` job for this PR defers both writes — its push would
  land on a closed PR. The lever finds it by listing the autofix runs that
  _are_ live (status-filtered: in progress, queued, pending, waiting,
  requested — through the Runs API, whose status filter is server-side on
  every gh version; `gh run list --status` rejects `pending` from gh's
  client-side allow-list before 2.65.0) and reading their jobs, once per tick
  and only when a flagged PR reaches a write. The set it finds is echoed to
  the tick log, so a multi-day deferral names what it waits on. The statuses are listed out and back before any jobs are
  read, so a run that changes status once during the sweep — a queued job
  getting its runner, a run re-queuing between two of its jobs — is caught by
  one of the two passes. What the rail cannot see: two changes within those
  few seconds, and an address leg that does not exist yet — it is a matrix leg
  created only when its run's `build-cli` job finishes, minutes after the run
  chose its targets — and its answer, taken once per tick, is as old as the
  fleet walk. The address job re-checks that the PR is still open once — after
  its setup steps, before it touches the PR — so a leg that reaches that check
  after the close stops itself. A leg already past that check is not covered:
  the close then lands under a working agent, whose push goes to a closed no-op
  PR. That is accepted — the window is at most about a minute per tick, the PR
  changes nothing, and the branch stays in place. Any failed or unparsable
  read, a failed de-duplication of the run ids, and any full page of 100 (the cut would drop the oldest
  runs — the long address jobs), is unknown busy-state: it defers, and raises
  one warning per tick, naming gh's first error line. It deliberately does not reuse the shepherd's shared busy-set, which
  is built from the newest 50 autofix runs: that workflow starts about 60 runs
  an hour, so a run holding a 1–3 h address job scrolls out of the window
  while the job is still working (observed on 2026-09-18: #11989's job ran
  14:25–15:57Z and was gone from the busy line after the 14:36Z tick). An
  unreadable comment history defers the lever too.
- The per-tick close budget (`MAX_NOOP_CLOSES_PER_TICK`, 3) caps closes only —
  notices are uncapped — and is checked before the live reads. The live
  `autofix/skip` recheck precedes both writes, and an unreadable label state
  or a payload without a labels list fails closed (no write).
- The notice rides the live label read's payload for a last-moment state
  and head check: a PR a human closed or pushed to since the fleet snapshot
  gets no notice (the snapshot can be half a minute old by the time a flagged
  PR reaches its write).
- The live head is re-read right before the close; a closed PR or a moved
  head means no close.
- Every write goes through `act()`: dry-run performs nothing, and a failed
  write never advances a counter or a marker.
- The dashboard row shows `no-op vs main` with the lever's outcome. The header
  and the tick summary report notices, closes and probe failures.

## Out of scope

- **Orphaned PRs.** Ten of the seventeen open autofix PRs on 2026-09-18 had
  their linked issue closed by a human (mostly recovered CI incidents) while
  still carrying a real diff; #10455's issue was even closed by another
  merged PR. Those are not no-ops. Whether the remaining diff is still wanted
  is a human decision, and this lever leaves them alone.
- **Duplicates of open PRs** (the #10452 shape) — same reason.
- **The linked issue.** A no-op close does not touch the issue or its
  `autofix/in-progress` label; the closing comment asks a human to confirm
  `main` resolves it if it is still open. This is not a regression — the same
  stranding happens today when a human closes the no-op by hand — and
  returning the issue to automation is a follow-up with two halves (see
  below).
- **Seeing a later twin sooner.** Detecting a no-op the moment the twin lands
  would need the merge computed against the current `main`. GitHub rebuilds
  test merges on its own schedule, and the shepherd, being checkout-free, does
  not compute one itself.
- **Preventing the birth.** Re-checking that the target still reproduces at
  a freshly fetched base before the agent writes a patch would have avoided
  #11379 outright. That belongs to the issue phase of `qwen-autofix.yml` and
  is a separate change.

## Constraints and risks

- **The verdict is as old as GitHub's last build of the test merge.** Nothing
  the lever controls bounds that age — at worst it is the time since the last
  head push — so a close deferred for hours by a live run, or the re-notice
  path after 24 h, can act on an old verdict. It can only be wrong if `main`
  has since _reverted_ exactly the content the branch carries, in which case
  the closed PR would have had a diff again. The recovery is to reopen the PR
  — a reopened PR is never closed by this lever again — and each comment quotes
  the `main` commit its own verdict is against (the notice and the closing
  comment can name different commits if GitHub rebuilt in between). The
  notice's age window and the live head read bound the race with a push;
  nothing bounds this, by design.
- **A verdict can flip back on the same head.** If GitHub rebuilds the test
  merge against a `main` that no longer contains the branch's content, the PR
  reads as having changes again and leaves the lever. A notice already posted
  for that head stays on the PR and is not retracted; it still counts for a
  day, so if the verdict flips back inside `NOOP_NOTICE_MAX_AGE_SEC` the close
  proceeds on it, and after that a fresh notice comes first.
- **A parked or reopened no-op is no longer synced.** A PR that reads as a
  no-op takes this lever's branch of the walk even when the lever then leaves
  it to a human, so the stale-base sync below it never runs for that PR while
  the verdict stands. That is harmless for a true no-op; for a wrong verdict
  it means the human who reopened the PR also has to move its head (or wait
  for GitHub to rebuild the test merge) before the row changes.
- **`autofix/skip` hides the PR from the whole shepherd, not just this
  lever.** The label the notice offers drops the PR from the fleet snapshot:
  no dashboard row, no conflict dispatch, no stale-base sync, no red-CI
  report. If real work lands on the branch later, the PR carries a live diff
  invisibly until someone opens the PR page and removes the label. The
  visible park is `autofix/needs-human`: its row stays on the dashboard.
- **A non-answer does not pause the other levers.** On a tick where the probe
  gives no answer for a PR that already carries a notice, the stale-base sync
  can still fire and move the head, which voids the notice: one more notice,
  one more tick, and one sync spent on a branch that was a no-op. Pausing the
  sync on a probe failure would instead let a dead probe disable syncing for
  the whole fleet, which is the worse trade.
- **A close that was not ours.** `gh pr close` on a PR that someone closed in
  the instant between the live read and the call is a silent success, so the
  tick would count a close it did not perform. The window is the gap between
  two consecutive API calls and the end state is identical (PR closed, comment
  posted), so it is accepted rather than engineered around.
- **Cost.** One GraphQL call per mergeable `autofix/*` PR per tick (about 15 PRs every 15
  minutes) on top of the compare call the walk already makes; comment history
  is read only for PRs the probe flags, the timestamp conversion runs only
  for a flagged PR that already carries a notice, and the live-run listing
  (nine status-filtered Runs API reads plus one `gh run view` per live
  run, on the workflow token rather than the PAT) is spent at most once per
  tick, only when a flagged PR reaches a write.
- **Workflow size.** The lever grows `qwen-fleet-shepherd.yml` past its
  recorded baseline; the baseline is bumped in the same PR, well under the
  470 KB gate.

## Validation

- `scripts/tests/qwen-fleet-shepherd-workflow.test.js` pins the lever's
  placement, markers, pagination and page merge, ordering of rails, the
  per-PR reset of the probe state, counters, the guards of both summary warnings and
  dashboard wiring, and replays the probe and the lever verbatim under
  `set -eo pipefail` with a fake `gh`. For the probe: equal-tree (with its
  base commit), differing, closed before versus never closed, no test merge
  yet, an API failure with and without a message (first non-blank stderr
  line, capped at 200 characters and stripped of CR, even when the body
  printed is equal-tree), a verdict for another head and a test merge
  built from another head (the head-side parent binding, a missing one
  included), twelve unparsable shapes including answers without a
  usable close-event count, and the first-cause bookkeeping across two
  failures. For the lever:
  the notice step and its exact promises in both languages (the floor rendered
  from the variable), the close step as two ordered writes, a failed close
  posting no comment, a lost closing comment, a PR that was closed before (and
  an unknown answer), a human-forged notice, a stale notice for another head,
  comments with a null body or author, a two-page comment history, dry-run; a notice that is too new / exactly old enough / from the future /
  too old / exactly at the limit, the newest of several notices, and three
  undatable shapes under a date shim that keeps GNU's `date -d ""` trap; a
  parked PR from the snapshot and from the live labels on either write path,
  an unparsable label payload or one without a labels list, a moved head, an already-closed
  PR, unreadable live head / comments / garbled comment page / labels on
  either path, a live address job in a running, queued or pending run on
  either step versus a job for another PR or a completed one, six shapes of
  unreadable live-run state (a failing de-duplication step among them), a full listing page, several live jobs spread
  over runs and statuses with all listings made before any jobs read, the
  workflow token on every run read, the once-per-tick listing, the exhausted budget
  (which spends no live read) with and without a
  notice, the live skip label on either path, and a failed notice post.
  The rail's input contract is pinned against `qwen-autofix.yml` itself — the
  `review-address` job carries no job-level `name:`, its matrix has the
  single dimension `target`, and the targets object emits `pr` first — and
  the rail's fixture job names are built from that key order, so a
  producer-side drift fails the suite instead of silently disarming the rail.
  The row-note tail is replayed too, on an idle row and on one another lever
  already wrote on.
- A mutation matrix over those behaviours — each rail, bound, counter and
  wiring point planted one at a time in the workflow — is killed by the suite.
- The probe was also run verbatim against the live API: the hand-closed
  no-ops read `noop` with their base commit, a PR with a close event reads as
  closed before while an open never-closed PR does not, a conflicting PR reads
  `no-test-merge`, and a nonexistent PR reads `api-failure` with `gh`'s
  message.
- First production ticks are observable on the Fleet Shepherd Dashboard
  (`no-op notices`, `closes` and `no-op probe failures` counters,
  `no-op vs main` rows) and can be rehearsed with the workflow's `dry_run`
  dispatch input, which exercises the real GraphQL read and the real fleet
  walk while performing no write.

## Acceptance criteria

- A bot PR on an `autofix/*` branch whose test merge tree equals its base parent's tree receives one
  bot notice, and is closed on a later tick — no sooner than the grace period
  — if its head has not moved, with both markers present and the dashboard
  reflecting it.
- No PR with a real diff, a conflicting or still-computing merge state, a
  failed probe, an address run the tick's live-run listing can see (a leg
  created after the listing, or one already past its own open-check, is an
  accepted window — see Rails), the skip label, the needs-human label or a
  branch outside `autofix/*` is closed, and no PR is closed as a no-op twice.
- A probe that fails is visible as a count and a warning, distinct from the
  benign wait for a test merge.
- A PR that reads as a no-op is never given a stale-base sync while the
  verdict stands — whether the lever closes it, defers it, or leaves it to a
  human (see Constraints and risks).
- Existing shepherd behaviour (conflict dispatch, sync, liveness, takeover
  pool, awaiting-human table) is unchanged for a PR that does not read as a
  no-op; a PR that does takes the lever's branch of the walk instead of the
  stale-base sync. The full script test suite is green.

## Follow-ups

- Return the linked issue to automation when a no-op PR is closed while the
  issue is still open. Releasing the `autofix/in-progress` claim is only half
  of it: the autofix scan's exclusion string also carries `-linked:pr`, so an
  issue that had a bot PR opened against it stays excluded whatever its labels
  say. Both halves have to be addressed together.
- Surface orphaned PRs (linked issue closed by someone else, diff still
  present) on the dashboard as a human decision, without closing them.
- Re-check reproduction at a fresh base in the autofix issue phase before a
  patch is written.
