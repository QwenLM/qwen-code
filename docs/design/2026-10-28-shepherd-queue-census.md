# Fleet Shepherd: read-only Actions queue census

[English](2026-10-28-shepherd-queue-census.md) | [简体中文](2026-10-28-shepherd-queue-census.zh-CN.md)

Status: implemented in this PR. Sampling and reporting only; no lever, no issue
filing, no thresholds.

## Problem

The repository's Actions queue backs up for hours at a time, and nothing in the
repository reports it. Measured on 2026-10-28 between 13:47 and 14:24 (Beijing):
229–233 runs queued against 19–33 in progress, with a live median wait of about
146 minutes.

The Fleet Shepherd already runs every 15 minutes on a hosted runner and already
maintains a single dashboard issue, but its queue awareness is limited to
`ZOMBIE_QUEUED_MINUTES`, which watches this loop's own autofix dispatches. A
repo-wide backlog is invisible until someone opens the Actions tab.

Autofix cannot discover this on its own: its inputs are issue labels, PR reviews,
comments, and a scheduled scan of open PRs. None of them reads a queue metric.

## Goals

- Make the repo-wide queue observable on a surface a maintainer already reads.
- Report enough attribution to tell an in-repo cause (event fan-out, PR-stage
  budget) from an out-of-repo one (pool capacity, a GitHub incident).
- Answer "is it draining?" honestly, not with a depth delta.

## Non-goals

- No lever. The census never dispatches, reruns, cancels, or deletes anything.
- No issue filing and no alert thresholds. Whether a backlog is worth acting on,
  and which side can fix it, stays a human call. Filing an evidence-bearing issue
  for the in-repo class is a deliberate follow-up, not part of this change.
- No new scheduled lane. The census rides the shepherd's existing tick.

## Design

One census block in the shepherd's run step, plus one dashboard section.

**Enumeration.** `GET /repos/{repo}/actions/runs?status=queued&per_page=100&page=N`,
up to `QUEUE_MAX_PAGES` (5) pages, stopping at the first short page. A second
read takes the `in_progress` total. Both use the workflow token, whose `actions`
scope is guaranteed, as the liveness reads already do.

**Two populations.** Runs at least `QUEUE_AGED_HOURS` (24) old are the aged tail;
the rest are live. A single `aged()` jq predicate feeds the split, the wait
distribution, and both breakdowns, so they cannot disagree about which population
they describe. Unknown age is not evidence of an aged run.

**Reported.**

- Depth (`total_count`), in-progress count, enumerated count, live/aged split.
- Wait since creation, p50 and max, over live runs only.
- Aged-tail banner with the oldest `created_at`.
- Top 5 workflows and top 6 events by queued count, live runs only.
- Trend against the previous tick: digested / new / still queued.

**Trend state.** The previous tick's queued run-id set rides in the dashboard
body as `<!-- fleet-shepherd queue-sample: ts=… ids=… -->`, parsed the same way as
the existing liveness watermark. The marker is written only for a complete,
readable enumeration **that read at least one run**; otherwise the previous
marker is carried forward verbatim, so a complete-but-empty tick cannot erase
the baseline.

## Self-starvation and the rescue lane

Measuring the queue exposed a second defect in the workflow that reports it: the shepherd had stopped running. In the thirty runs before 2026-10-28 16:00 Beijing, eighteen were cancelled, every one of them within a second of the next run's creation, and nothing completed between 14:13 and 15:19.

The mechanism is a concurrency-group property, but not total starvation. A group keeps one _active_ run, and a newer pending run **cancels** the older pending one — `cancel-in-progress: false` protects only runs that have already started. The run that got past the group therefore waits out the pool while later arrivals replace each other behind it. Measured on the same day: two scheduled runs sat `queued` for 120 and 135 minutes across eight or nine later arrivals, then both ran, with 22 and 28 seconds of work. So throughput is pool-bound — roughly one landing per pool latency — and the loop is not dead, it is throttled to about one tick every two hours. Depth alone reads "queued" either way, which is exactly the reading that hides it.

That bound is what the fixes target, within a limit worth stating plainly: the loop was throttled, not dead, so a lane that waits for a 240-minute silence would NOT have fired for the 66-minute gap the incident showed. The rescue lane exists for the dead case — completions stopping altogether — and it does not make the merely-slow case faster.

The fleet cadence drops from fifteen to thirty minutes and the concurrency key becomes an expression with three groups — `fleet-shepherd` for ticks, `fleet-shepherd-watchdog` for the rescue watch, and `fleet-shepherd-rescue` for rescued runs. Replacement, per this file's own model, applies to runs that have not started; a rescue is protected not by the group alone but by the guard that keeps at most one outstanding, so there is normally no newer pending arrival to replace it. What shortens recovery is that second serialized lane, not the cadence: doubling the interval halves the arrival rate — and with it pending churn against a shared queue — while changing the landing rate not at all. A second cron (`10,40 * * * *`) runs the same job in a watch mode that ends before any dashboard work: it reads this workflow's own run history and, when no fleet tick has completed for `SHEPHERD_STALE_MINUTES` (240) and no tick is in progress, sends one `repository_dispatch` of type `shepherd-rescue`.

One table decides the watch, and the code applies it once. A run belongs to a **live lane** if it is a scheduled tick, a live manual dispatch, or a rescue; the watch itself and a _dry_ manual run belong to neither column:

| run                                   | in flight (defers) | progress (resets the clock) |
| ------------------------------------- | ------------------ | --------------------------- |
| live lane, `status != completed`      | yes                | —                           |
| live lane, completed, not `cancelled` | —                  | yes, by `updatedAt`         |
| watch, or dry manual run              | never              | never                       |

**The rule is deliberately simple, and it carries one accepted cost.** Three rounds of trying to separate `pending`, `queued` and a _wedged_ `queued` produced a fix-induced critical each time: counting too little dispatched a rescue beside a tick that was about to start; counting too much silenced the lane; and an age cutoff could not tell a saturated pool from a wedge without borrowing the very threshold that triggers the rescue.

So: **a wedged holder suppresses the rescue for as long as it sits there.** That is a decision, not an oversight. The remedy is the one this file already documents — inspect `gh run view <id> --json jobs` and delete the wedged run, which the dashboard's wedge banner names. Automating it was judged worse than the manual step, because every automatic version tried so far misread a merely slow pool as a dead one.

Each row is a defect that was shipped and fixed. Counting the watch's own run made both gates permanently true and the rescue branch unreachable. Counting successes rather than completions re-dispatched a shepherd that fails on every tick. Ignoring a completed rescue re-armed another one every watch interval while the log said "none in window". Treating `queued` as neither state dispatched a second full tick beside one that had already passed the concurrency gate and was certain to start — two dashboards assembled from the same stale reads, the later blind edit discarding the other's watermark. And titling every manual dispatch like a dry run made a maintainer's documented recovery invisible, earning it a duplicate rescue minutes later; `dry_run` defaults to false, so only an explicitly dry manual run is excluded.

The title is the only field that separates the lanes, since both crons arrive as `event: schedule`. Runs created before this PR carry the workflow name, so that legacy title counts as a tick too — without it the first watch after merge would find no tick in the window and dispatch on the sentinel age. That arm can be dropped once the window rolls past this change. An unreadable _or empty_ history takes no action at all; a history with runs but no live lane inside it still fires, because that is evidence the lane produced nothing.

**The 240-minute threshold is derived from measurement, not from the interval.** Ordinary completions are 80-150 minutes apart here (live median wait 146 minutes; 120-135 minutes queueing for this job), so a threshold of two or three intervals would double a working shepherd — and did, in an earlier revision set at 75. 240 clears the worst measured gap. It accepts a detection window of 240-270 minutes (threshold plus up to one watch interval) and then roughly one further pool wait while the watch and the rescue are themselves scheduled; slower detection is the price of never firing on a merely slow loop.

## Decisions and rationale

**Set difference, not depth delta.** Depth is non-monotonic: it falls when runs
are cancelled and rises while the queue drains. Only "digested > new" means
drainage. Measured on 2026-10-20, a queue went 724 → 524 while 405 runs were
digested and 205 new ones arrived; an earlier window that looked identical was
pure churn.

**Completeness gates the marker.** A capped enumeration is a window, not a set.
Diffing a complete set against a capped one counts every run that merely left the
window as digested — manufactured drainage. Demonstrated live: diffing a
100-of-229 sample against a complete 232-run enumeration reported `new 145`,
an artifact of the partial baseline rather than a burst.

**The aged tail is excluded from waits and breakdown, but not from the trend.**
Measured on 2026-10-28, 81 of 231 queued runs were created on 2026-08-19 — the
500 KB workflow-size incident the shepherd's own comments record — and nothing sat
between 1 day and 70 days. Including them put p50 at 243m and max at 70 days, and
ranked `Qwen Triage Finalize` (26) and `Comment Attachment Guard` (13) into the
top 5 although neither had a single live queued run. Excluding them yields p50
146m / max 461m and a top 5 of PR Review 55, tui-parity 40, Managed Agent gate 11,
E2E Tests 9, Qwen Code CI 5. The trend still spans every enumerated run: "no
longer queued" is true whatever the age, and filtering there would report a run
crossing the age line as digested while it sits in the same queue.

**24 hours, not `ZOMBIE_QUEUED_MINUTES`.** The wedge threshold (30m) is tuned for
this loop's own dispatches and is deliberately generous. Applied to a repo-wide
queue whose live median wait is already hours, it would classify most live runs
as wedged. The two thresholds answer different questions and stay separate.

**Fail closed.** Any failed read — a page, `total_count`, the in-progress count,
the page merge, or a stat jq cannot compute — voids the whole census for the
tick. The section then says UNKNOWN, not zero, and the previous marker survives.
A census that reported an empty queue during an API outage would be worse than
no census. The stats carry `|| QUEUE_OK=false` rather than being bare
assignments: under `set -e` a single unparseable `created_at` would otherwise
abort the entire tick, taking every lever and the dashboard write down with a
read-only report.

**Workflow names are untrusted, and the rows are rendered without an
interpreter.** A run executes the workflow file of the branch it came from, so
whoever owns that branch chooses the `name` that appears in the run listing.
That is enough to establish the path: the autofix bot and any contributor with
write access can open a same-repo branch. Whether a fork PR also controls the
name is deliberately NOT claimed — this repository's own bridge notes record
fork-triggered runs executing the base branch's file. The
queue section is emitted before the liveness watermark that the next tick
recovers with `head -1`, so a name carrying a newline could end its row early and
place a forged watermark above the real one — and that watermark gates the
liveness dispatch. Workflow names therefore have CR, LF and TAB collapsed to
spaces, pipes escaped, and the comment delimiter broken (`<!--` becomes
`<\!--`) — that third step is what stops a name from opening an HTML comment
that would swallow the marker and everything below it. The rows join on real
newlines and print with
`printf '%s'` rather than `'%b'`, so no escape sequence is interpreted anywhere
downstream. The other dashboard tables keep `'%b'` with escaped separators
because their inputs cannot carry a newline; this one cannot, and the difference
is deliberate.

**Every page must be an array, and the merge de-duplicates.** A page body
without a `workflow_runs` array reads as a short final page, which would stamp a
truncated enumeration complete — the fail-open the completeness gate exists to
prevent — so an unexpected shape voids the sample. And because a run can leave
the already-read range between two page requests, the merge applies
`unique_by(.id)`. It repairs **one direction only**: an arrival between two
page requests duplicates the boundary run, inflating every count and the stored
id set, and de-duplication removes it. A _departure_ shifts rows forward so one
run is never read; that run is present in the previous set and absent here, so
the trend counts it as digested while it sits in the queue. De-duplication
cannot repair that, which is why the dashboard's trend line carries the caveat
instead. The previous id set is de-duplicated at the read site too, so a marker
written before this fix cannot double-count today.

**A positive depth with nothing enumerated is a disagreement, not an empty
queue.** A lagging count, or the last queued runs starting between the two
reads, used to render "the queue is empty at this tick" — the outage-read-as-
empty outcome the section forbids — and record an empty sample. It now reports
both numbers and says they disagree, and only a depth of zero may claim
emptiness.

**Capped, not `--paginate`.** A page cap bounds one tick's cost during a surge and
makes truncation an explicit, reported state instead of an implicit property of
GitHub's listing limit.

## Constraints

- The shepherd is checkout-free by design; the census is inline bash and jq, and
  reads no repository file.
- The workflow file is subject to the size ratchet in
  `.github/scripts/check-workflow-size.sh`; `.github/workflows/.size-baseline` is
  updated in this PR.
- Cost per tick: at most 6 API calls, on the hosted runner the shepherd already
  uses. At the measured depth the enumerated payload is about 3.6 MB.
- `depth` and `enumerated` can differ by a run or two: the depth is the API's
  count at page 1, and runs keep arriving while later pages are read.

## Risks

- Dashboard body growth. A complete 500-run id set adds roughly 6 KB to a body
  that is edited in place; GitHub's issue-body limit is 65536 characters.
- The aged tail is identified by age alone. The list carries no job state, so the
  banner tells the reader to check `gh run view <id> --json jobs` before deleting
  anything — an offline runner pool keeps live jobs queued just as long.
- A workflow name containing `|` is escaped, so it cannot split the row; the
  residual backslash-before-pipe renders as an extra cell rather than a broken
  table. Cosmetic either way.

## Validation

Unit coverage in `scripts/tests/qwen-fleet-shepherd-workflow.test.js`, following
the file's existing convention of extracting the program from the workflow and
replaying it against fixtures with real `jq` and a PATH-stubbed `gh`:

- Contract: read-only, repo-wide, workflow token, page cap, fail-closed wording.
- Enumeration: short page, exactly-full page followed by an empty one, cap reached
  (no sixth request), env-tuned cap, failed page, failed in-progress read,
  unreadable `total_count`, empty queue, aged split, and a payload jq cannot
  parse.
- Trend: churn versus drainage, complete drainage, no previous sample, trailing
  separator, and a run crossing the age line still counting as still queued.
- Distribution and breakdown: p50/max, unknown age dropped, top-5 ordering, the
  corpse-cohort fixture that reproduces the misattribution measured live, and a
  hostile-name fixture (embedded newline carrying a forged liveness watermark,
  carriage return, tab, pipe, backslash) asserting one row per workflow and no
  line that parses as a marker.
- Marker: recorded when complete, carried forward when unreadable or capped,
  absent when there is nothing to carry.

The rescue watch adds contract cases over the three trigger literals and the three groups, plus a behavioral replay of the watch decision: stale and idle dispatches once, a fresh completion does not, an in-progress run defers, a pending-only queue does not, an outstanding rescue defers, a failed or empty history takes no action, a failed dispatch is surfaced, and the staleness threshold is the env value.

Fourteen mutations were each confirmed to fail the suite: keeping aged runs in the
breakdown, dropping the completeness gate on the trend, dropping it on the
marker, stopping on a full page, sorting the fan-out ascending, turning one stat
back into a bare assignment (which aborts the whole replay under `set -e` — the
failure the `|| QUEUE_OK=false` guards exist to prevent), dropping the
control-character collapse, dropping the pipe escaping, and rendering the rows
with `'%b'` again; and, on the rescue lane, putting rescued runs back in the tick group, measuring staleness from `createdAt`, dropping the outstanding-rescue guard, letting a pending run defer the rescue, and dispatching on an empty history.

Live read-only rehearsal against `QwenLM/qwen-code` on 2026-10-28 produced the
figures quoted above, including a real set difference against a snapshot taken
25 minutes earlier.

## Acceptance criteria

- The dashboard carries an `## Actions queue` section on every readable tick.
- An API failure reports UNKNOWN and preserves the previous sample.
- A capped enumeration reports a floor, records no sample, and claims no trend.
- Waits and breakdown exclude the aged tail; the banner reports its size and age.
- A workflow name cannot break out of its row or place a line that parses as a
  dashboard marker.
- The census itself introduces no write, dispatch, or scheduled lane. The
  rescue lane is the one deliberate exception, documented in its own section
  above: one `shepherd-rescue` dispatch and one watch cron.

## Open questions

- Thresholds and issue filing for the in-repo class are deferred until the
  dashboard has produced a few days of real data.
- Whether the aged tail should be cleaned up is a separate operational decision;
  this change only makes it visible.
