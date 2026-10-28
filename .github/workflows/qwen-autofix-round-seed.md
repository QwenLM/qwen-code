# Parameterized takeover commands

Operator guide for the two parameterized takeover forms — `from N` (round seed,
below) and `for N` (round budget, further down). For the implementation
rationale behind each gate, see the design record:
[`qwen-autofix.md`](./qwen-autofix.md) — [af-007](./qwen-autofix.md#af-007)
(the parser), [af-016](./qwen-autofix.md#af-016) (the seed marker) and
[af-159](./qwen-autofix.md#af-159) (the budget).

## Round seed — `@qwen-code /takeover from N`

### The problem it solves

The autofix loop stops implementing non-Critical feedback once a PR has
completed `CRITICAL_ONLY_AFTER_ROUND` (5) change-producing rounds. From there
only Critical findings, `Request changes` reviews, in-budget maintainer
feedback, failed checks, and base conflicts drive code changes; everything
else is recorded in a `Deferred non-Critical feedback` section and left for a
human.

That counter is **window-scoped**, and engaging takeover opens a fresh window.
So a PR that had already absorbed nine rounds of ordinary human review got five
more suggestion-capable rounds the moment it was managed — the loop grew the
diff on nice-to-haves at exactly the point it should have been converging.

`from N` lets you state what the loop cannot infer: how much review this PR has
already been through.

### Usage

```
@qwen-code /takeover from 4
```

Engages takeover **and** starts this counting window's round counter at 4. With
the threshold at 5, the Critical-only brake then engages after **one** more
change-producing round instead of a fresh five.

The bot confirms in its engage ack, and the seed rides as its own marker:

```
🤝 Takeover engaged: … This window's round counter starts at 4 (the rounds this
PR spent in review before takeover), so the Critical-only brake engages after 1
more change-producing round(s) instead of a full fresh 5. …

<!-- takeover-ack engaged -->
<!-- autofix-round-start 4 -->
```

Who may issue it is unchanged from the bare command: the PR author on an in-repo
PR (holding triage+ _at the time of the comment_), or any write+ collaborator.
The same refusals apply — a non-`main` base, `autofix/skip`, a fork without
maintainer-edit access, and a fork whose author lacks write+ on this repository
are all declined out loud.

#### Picking N (seed)

N is "how many review rounds has this PR already had", counted the way the loop
counts: **rounds that produced changes**, not individual comments or reviews. A
practical proxy is the number of times the author pushed a revision in response
to review.

You do not have to be precise. The seed only decides how much suggestion budget
remains, and you can always re-seed (below). When unsure, err toward the higher
number: the tail of a long-running PR is where suggestion churn hurts most, and
Critical findings, `Request changes` reviews, in-budget maintainer feedback,
failed checks, and base-conflict resolution keep flowing regardless of the
seed.

| You type | Counter starts at | Suggestion-capable rounds left                 |
| -------- | ----------------- | ---------------------------------------------- |
| `from 0` | 0                 | 5 — identical to a bare `/takeover`            |
| `from 3` | 3                 | 2                                              |
| `from 4` | 4                 | 1                                              |
| `from 5` | 5                 | 0 — Critical-only from the first managed round |

### Semantics

**The seed is a floor for an empty window, not an offset added to every round.**
The counter is `max(this window's round markers)`, falling back to the seed when
the window has none yet. The first managed round therefore records `N+1`, the
next `N+2`, and the seed stops mattering. It cannot double-count.

**The seed lives and dies with the counting window.** It is read from the engage
ack whose timestamp _is_ the window key, so a superseded window's seed can never
leak forward. Consequently:

- `@qwen-code /retry` opens a new window with **no** seed — the counter returns
  to 0 and the suggestion valve reopens. That is what re-arming means.
- A bare `@qwen-code /takeover` on an already-managed PR does the same.
- To re-arm a late-stage PR _without_ reopening the valve, re-issue the command
  **with its number**: `@qwen-code /takeover from 7`. On an already-managed PR
  this takes the re-arm path and says so ("the round counter restarts at 7 —
  rounds already spent on this PR").

**The seed is clamped strictly below the round cap.** The cap is 100 while
`autofix/takeover` is present and 10 without it. A seed at or past the effective
cap would park the PR at its cap on the very round it was taken over — stopping
the loop instead of starting it — so it is clamped to `cap - 1`. When that
happens, the Critical-only audit record cites the number you **typed**, plus a
note naming the clamp, so it never quotes a command nobody sent.

### What it does not do

**It does not seed the growth brake.** `CRITICAL_ONLY_AFTER_ROUND` is only one
of two brakes; the other trips when the diff grows past
`GROWTH_BUDGET_SRC_LINES` / `GROWTH_BUDGET_TEST_LINES` beyond the window's
baseline. That baseline is anchored at the window's first measured round, and a
pre-takeover baseline is not recoverable from anything the loop can read — so
diff growth is always measured **from engagement**, seeded or not.

**It does not change what Critical-only preserves.** Critical findings,
`Request changes` reviews, in-budget maintainer feedback, failed checks, and
base-conflict resolution all keep flowing. Only the suggestion channel stops.

**It does not shorten the round cap in any meaningful way.** Under takeover the
cap is 100, so a seed of 4 leaves 96.

## Round budget — `@qwen-code /takeover for N`

The bounded opposite of the seed. `from N` decides how much _suggestion_ budget
this window has; `for N` decides how many _rounds_ the loop may run at all.

```
@qwen-code /takeover for 2
```

Engages takeover and records a window round budget of 2 on the engage ack:

```
<!-- takeover-ack engaged -->
<!-- autofix-round-budget 2 -->
```

The effective cap for this window becomes `N` (it only ever lowers the takeover
cap of 100). When the counter reaches `N`, the loop **releases** the PR:

- it posts one bilingual "budget spent — released" note, per window;
- it removes `autofix/takeover`;
- it does **not** apply `autofix/needs-human` and does **not** post the paused
  "reached its round cap" notice — a finished budget leaves nothing stuck, so
  both would be false.

**A forced dispatch defers that release to the next non-forced scan.** If the
fleet shepherd dispatches a conflict round at the moment the budget finishes,
that pass has to answer the dispatch out loud, so it takes the paused path
(paused notice plus `autofix/needs-human`) and the next scheduled scan releases
— clearing that escalation label with it. The notices on the deferred pass
quote the attempts spent (N/N), not the change-producing round counter, which a
no-op-only engagement leaves at 0.

**Every finished attempt counts.** The budget is measured by the round's eval
marker, one per attempt: a no-op round writes one with its round number
unchanged, and a round that is cancelled or dies in setup writes one with the
round advanced by one and a sentinel timestamp. So a PR whose rounds keep
finding nothing still ends after N — that is the case a round counter cannot
express. The guarantee is one attempt per marker, and it assumes the marker
lands: the report step retries its post, but a comment-API outage that outlasts
those retries leaves a round uncounted, which delays the release rather than
ending it early.

**A crash or a timeout spends its attempt; a breaker parks.** A crashed or
timed-out round stamps the sentinel timestamp and only advances the round by
one, so it consumes an attempt and nothing else — one such round does not stop
anything. A breaker withholds the release (`autofix/needs-human` plus the paused
notice) when the engagement holds `TIMEOUT_WINDOW_CAP` (3) sentinel-stamped
rounds with silent-sandbox (idle) ones subtracted, when a round is past
`ROUND_START + attempts`, or when a convergence-break notice is newer than the
window key. Those are the breaker's own thresholds, unchanged by `for N`; read a
lasting pause on a budgeted PR as "a human should look", never as "the budget
finished" — the one transient pause is the deferred release above.

**A breaker stop is not a spent budget.** When the consecutive-failure, timeout
or convergence breaker stops the loop early, it stamps a terminal sentinel round
far past the real attempts and posts no extra marker — so the window is not
"spent", and the release note is not posted. A breaker asks for a human.

**An automatic re-arm rebases the growth window, and the budget rides along.**
A growth-audit round appends `autofix-rearm` for its own round accounting, and
suppressing it would pin the growth baseline and make every later round
Critical-only — so it is unconditional. It is not the only thing that re-anchors
that baseline (a base-branch update and the scan's heal ack do too). What keeps
the budget honest is its key: the budget and the attempts spent are counted per
engagement — a command opens one, that automatic re-arm does not — so the audit
rebases while the remaining budget still applies.

**A queued round from the same window is discarded once the budget is spent.** A
no-op leaves the round number UNCHANGED and the window key unchanged, so neither the
superseded-window nor the round-cap check would catch a round that was queued
before it; the address leg recounts the window's attempts and drops it.

**The budget is engagement-scoped, not window-scoped.** It is read from every
ack or re-arm at or after the anchor that carries it, excluding the automatic
growth-audit re-arm (whose comment carries that round's eval marker). So
`/retry` or a bare `/takeover` opens a new engagement with no budget (unbounded
takeover, as before), and a budgeted re-arm (`@qwen-code /takeover for 3` on an
already-managed PR) starts a fresh one at round 0 with a 3-round budget. Round
accounting is the read that stays window-keyed.

**Bot-authored PRs are the one exception.** They are managed without the label,
so releasing it would hand them back to standard ten-round management and the
budget would be a lie. They land on the existing paused path instead: paused
notice plus `autofix/needs-human`, and the fleet shepherd's auto-release ages the
label out. The budget stops them at N, and a SPENT one outlives that auto-release
(and a hand-removal, which leaves no marker either): the PR stays parked at N/N
until a new command moves the engagement. Only an explicit `stop` ends it, which
is why its ack says standard management continues.

**A budgeted re-arm also cancels queued work, conflicts included.** A conflict
round is normally exempt from the superseded-window discard because it stays
actionable, but a queued job carries the old cap: with a smaller budget it would
run past the new limit. The next scan re-selects the conflict under the new
window.

### Picking N

| You type | Rounds the loop may run | Typical use                                         |
| -------- | ----------------------- | --------------------------------------------------- |
| `for 1`  | 1                       | "clear this batch of review comments, then stop"    |
| `for 2`  | 2                       | one round plus a follow-up after CI comes back      |
| `for 5`  | 5                       | a small, deliberately bounded engagement            |
| `for 99` | 99                      | effectively unbounded; use bare `/takeover` instead |

`for 0` is **not** accepted: a zero-round engagement is what `/takeover stop`
already does, so it fails closed with the rest of the malformed bodies.

## Accepted and rejected forms

The literal prefix must match `@qwen-code /takeover` byte-for-byte and the tail
must be either `from N` or `for N` with a bare 1–2 digit integer. The command
has to be the very first thing in the comment: **no leading whitespace of any
kind** — space, tab, or blank line.
The router prefilters on the _raw_ comment body with `startsWith`, so a body
with leading whitespace never starts a job at all, and the trim
that runs inside that job never gets the chance
([af-004](./qwen-autofix.md#af-004)). Trailing whitespace is harmless. Anything
else fails closed — no label, no seed, no budget, no partial effect, and, when
the router never started, not even a log line.

| Body                                 | Result                                          |
| ------------------------------------ | ----------------------------------------------- |
| `@qwen-code /takeover from 4`        | engage, seed 4                                  |
| `@qwen-code /takeover from 04`       | engage, seed 4 (read as decimal, not octal)     |
| `@qwen-code /takeover from 0`        | engage, no seed — the explicit spelling         |
| `@qwen-code /takeover for 2`         | engage, 2-round budget                          |
| `@qwen-code /takeover for 02`        | engage, 2-round budget (decimal, not octal)     |
| `@qwen-code /takeover`               | engage, no seed, no budget                      |
| `@qwen-code /takeover stop`          | release                                         |
| `@qwen-code /takeover stop from 4`   | **nothing** — neither releases nor engages      |
| `@qwen-code /takeover for 0`         | **nothing** — a zero-round engagement is `stop` |
| `@qwen-code /takeover from 4 for 2`  | **nothing** — the two forms do not combine      |
| `@qwen-code /takeover from 100`      | **nothing** — 3 digits rejected                 |
| `@qwen-code /takeover for 100`       | **nothing** — 3 digits rejected                 |
| `@qwen-code /takeover  from 4`       | **nothing** — double space                      |
| `please @qwen-code /takeover from 4` | **nothing** — must start the comment            |
| `  @qwen-code /takeover from 4`      | **nothing** — leading spaces                    |
| blank line, then the command         | **nothing** — leading newline                   |
| `@qwen-code /takeover from 4 please` | **nothing** — must end the comment              |

### Reading the result

Once the brake engages, the round report carries a `Deferred non-Critical
feedback` section whose preamble names the seed explicitly, for example:

> the round counter reached 5 (this window was seeded at round 4 by
> `@qwen-code /takeover from 4`, plus 1 change-producing round(s) since)

That wording exists so a maintainer seeing Critical-only fire on a PR the loop
has only run once can tell it from a misfire. The agent is told the same thing
in `SKILL.md`, so it treats an early engagement as ordinary rather than
suspicious.
