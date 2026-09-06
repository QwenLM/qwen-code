# Round seeding — `@qwen-code /takeover from N`

Operator guide for the one parameterized takeover command. For the
implementation rationale behind each gate, see the design record:
[`qwen-autofix.md`](./qwen-autofix.md) — [af-007](./qwen-autofix.md#af-007)
(the parser) and [af-016](./qwen-autofix.md#af-016) (the marker).

## The problem it solves

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

## Usage

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

### Picking N

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

## Semantics

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

## What it does not do

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

## Accepted and rejected forms

The literal prefix must match `@qwen-code /takeover` byte-for-byte and the tail
must be a bare 1–2 digit integer. The command has to be the very first thing in
the comment: **no leading whitespace of any kind** — space, tab, or blank line.
The router prefilters on the _raw_ comment body with `startsWith`, so a body
with leading whitespace never starts a job at all, and the trim
that runs inside that job never gets the chance
([af-004](./qwen-autofix.md#af-004)). Trailing whitespace is harmless. Anything
else fails closed — no label, no seed, no partial effect, and, when the router
never started, not even a log line.

| Body                                 | Result                                      |
| ------------------------------------ | ------------------------------------------- |
| `@qwen-code /takeover from 4`        | engage, seed 4                              |
| `@qwen-code /takeover from 04`       | engage, seed 4 (read as decimal, not octal) |
| `@qwen-code /takeover from 0`        | engage, no seed — the explicit spelling     |
| `@qwen-code /takeover`               | engage, no seed                             |
| `@qwen-code /takeover stop`          | release                                     |
| `@qwen-code /takeover stop from 4`   | **nothing** — neither releases nor engages  |
| `@qwen-code /takeover from 100`      | **nothing** — 3 digits rejected             |
| `@qwen-code /takeover  from 4`       | **nothing** — double space                  |
| `please @qwen-code /takeover from 4` | **nothing** — must start the comment        |
| `  @qwen-code /takeover from 4`      | **nothing** — leading spaces                |
| blank line, then the command         | **nothing** — leading newline               |
| `@qwen-code /takeover from 4 please` | **nothing** — must end the comment          |

## Reading the result

Once the brake engages, the round report carries a `Deferred non-Critical
feedback` section whose preamble names the seed explicitly, for example:

> the round counter reached 5 (this window was seeded at round 4 by
> `@qwen-code /takeover from 4`, plus 1 change-producing round(s) since)

That wording exists so a maintainer seeing Critical-only fire on a PR the loop
has only run once can tell it from a misfire. The agent is told the same thing
in `SKILL.md`, so it treats an early engagement as ordinary rather than
suspicious.
