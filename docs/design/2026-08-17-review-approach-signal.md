# Review approach signal — saying when the approach, not the patch, is the open question

## The problem, as measured

One change to `extractAndStripMeta` took three attempts across two pull
requests before it landed:

| PR    | approach                                                  | rounds | findings         | source diff |
| ----- | --------------------------------------------------------- | ------ | ---------------- | ----------- |
| #9097 | add a `timeout` to the vm call                            | 3      | 18 (9 Critical)  | grew ~5x    |
| #9136 | run the walk inside the vm, then a child process per call | 6      | 56 (12 Critical) | grew ~4x    |
| #9325 | stop evaluating; parse the literal                        | 1      | —                | —           |

Every one of those 74 findings was individually correct. Each round found a
real hole the previous patch did not cover: a getter deferring its work to the
host, a serializer sharing a lexical scope with the literal it walked, a
promise reaction under `microtaskMode`, unbounded allocation. The review was
not wrong at any point.

It was, however, structurally unable to reach the conclusion that mattered.
Every finding is anchored to a `file:line` inside the current diff — that is
what a finding _is_. So the review could say where an approach leaks, but never
that a different approach would retire all of the leaks at once. The fix that
worked deleted the mechanism, and all 74 findings went with it.

The signal that something was structurally wrong did exist. `did not converge
within the reverse-audit round cap` was emitted four times across the two PRs.
It is filed as a coverage gap — "we did not finish looking" — rather than as a
conclusion about the change. Nothing was responsible for reading it as "stop
patching".

## What this adds

One advisory paragraph, and one clause on the terminal verdict line, when a PR
has taken enough rounds _and_ grown enough since the review first measured it.

It fires when all of:

- this round confirmed at least one finding (the pre-cap verdict, `baseEvent`, is not `APPROVE`)
- the round is at or past the threshold (default 5; `review.approachRounds`)
- a baseline exists from an earlier round
- the source diff is past the module's existing non-trivial floor (100 lines)
- the diff has grown by at least `APPROACH_GROWTH_FACTOR` (3x) since the baseline

This round's reverse-audit round-cap stop rides along as a corroborating
clause when present. It is never a trigger on its own.

## Design decisions

**It is not a finding.** Findings are what the autofix loop consumes, and the
loop patching each finding in turn is the pattern being interrupted. A finding
here would be fixed rather than read. This addresses the human deciding what
happens next, so it is a body paragraph and a verdict-line clause.

**It never moves the verdict.** No cap, no event change, no blocker. A PR that
is legitimately large and legitimately iterated must pay nothing for a false
positive beyond one paragraph. This mirrors `lowSignal`, the existing
disclosure-only field it is modelled on.

**It never fires on `APPROVE`.** An approve is convergence. The convergence
posture composes a deferrals-only late Approve deliberately, as the loop's stop
signal; telling that PR to reconsider itself would contradict the outcome the
loop is steering toward, in the same body.

**The baseline is a baseline, not the previous round's size.** #9136 went 228 →
920 source lines across six rounds — about 1.3x per round, which no per-round
delta would notice, but 4.0x cumulatively. `Ledger.src0` records the first
round's measurement and is carried forward unchanged, so a diff that shrinks
cannot rewrite its own baseline and erase the growth already on record.

**One setting, not two.** `review.approachRounds` is the knob an operator would
reach for — it maps to a policy number the repo already uses, and raising it far
enough silences the signal. The growth factor stays a module constant beside
`LOW_SIGNAL_SRC_DIFF_LINES`, which is exactly how the sibling disclosure's own
threshold is expressed.

## What this does not do

**It cannot see across pull requests.** Every cross-round mechanism is keyed to
one PR: the marker rides that PR's review bodies, the side file is named for its
number, and recovery walks only its reviews. #9097 → #9136 → #9325 as three
attempts at one fix is not detectable by any extension of this machinery. Of the
motivating incident, only #9136's own six rounds and 4x growth would have fired.
#9097, at three rounds, would not have.

**It does not count repeated non-convergence.** The round-cap marker is written
per run and fenced to that run's plan epoch, precisely so a stale stop cannot cap
a verdict that did not stop. Summing it across rounds needs a second persisted
counter — a forgeable monotone tally with no code to re-assert it against. The
paragraph therefore claims only what is true of _this_ round.

**It is retroactively blank.** No PR in flight carries a baseline, and unknown
marker keys are dropped on read. The signal stays silent until a PR has posted
two rounds after this ships. The `src0 > 0` arm is what makes the absent case
degrade to silence rather than to a false "no growth".

**The round counter fails open.** Any failure recovering the side file reads as
round 1, so a force-push or an account switch silently disarms the signal. That
direction is deliberate: an advisory signal should fail toward silence.

**Growth is measured in source lines, excluding tests.** This is consistent with
`lowSignal` and the topology metric, and it means a PR that balloons purely in
test code will not trip the growth arm. This is the one genuinely contestable
metric choice here; `diffLines` would catch more and also fire more often.

## Trust

`src0` is untrusted body data, like every other marker field. Unlike a finding,
a bare number has nothing to re-assert it against: a forged small value fires
the paragraph, a forged large one silences it. The entire blast radius is one
advisory paragraph — it never reaches a verdict, a cap, or an event.
