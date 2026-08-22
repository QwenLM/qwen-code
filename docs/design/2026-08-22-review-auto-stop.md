# Caller-side convergence enforcement for automatic reviews

## What this is

The `/review` pipeline measures whether a pull request's review loop is
settling and says so in the posted body. It owns no threshold and stops
nothing — that is the governance rule this whole line of work is built on
(issue #9278): **the tool measures, the caller decides.**

This is the caller's half. This repository reads the telemetry the pipeline
already publishes and applies **its own** number to one question: should the
automatic review keep firing on every push?

## What it does not do

- **It never blocks a review anyone asked for.** The check lives in
  `delay-automatic-review`, a job reached only by `opened` and `synchronize`.
  `@qwen-code /review` and a requested review go around it. Stopping the
  treadmill is not refusing to review.
- **It never fails closed.** Telemetry that will not parse, a round the
  listing could not fetch, a gap in the round numbers, a posture that changed
  underneath the numbers, a missing Node — every one of them keeps reviewing.
  A caller that silences reviews when it cannot read its own evidence is
  worse than one with no rule at all.
- **It withholds nothing already found.** Reviews already posted stand.

## The rule

From the last posted reviews by this account, read each ledger marker's
`round`, `fresh` (findings reported for the FIRST time — not the round's
whole output, which only rises while an unfixed blocker keeps being
re-posted) and `floor`. Then, over a window of `W` consecutive rounds:

| Condition                                        | Decision                                  |
| ------------------------------------------------ | ----------------------------------------- |
| fewer than `W + 1` readable rounds               | keep reviewing (unevaluable)              |
| any round in the window recorded no `fresh`      | keep reviewing                            |
| the rounds are not consecutive                   | keep reviewing (a trend over unseen work) |
| the newest round produced no first-time findings | keep reviewing (settled)                  |
| two different posting floors inside the window   | keep reviewing (posture change)           |
| every step non-shrinking across `W` rounds       | **stop the automatic trigger**            |

Every clause mirrors a reading the pipeline itself refuses to call
divergence. The only thing this repository adds is `W`.

When it stops, the PR gets one upserted comment naming the measurement, the
evidence, and how to resume.

## How a pause lifts

Not by pushing. While the pause holds, `review-pr` never runs for
`opened`/`synchronize`, so no round is posted, so no new marker joins the
window — the evidence the rule measures is frozen, and every later push
re-decides the identical stop. The only thing that moves it is a review on a
path the gate cannot reach: `@qwen-code /review`, a requested review,
`ready_for_review`, `reopened`. Once such a round posts a marker whose
first-time count falls, the window is no longer flat and the pushes after it
are automatic again.

The notice says exactly this, because an author who reads "push once and it
lifts by itself" waits forever — which is the same silent-stop confusion the
notice exists to prevent.

When the pause does lift, the same comment is superseded in place (the
`--update-only` upsert, which mints nothing where no notice exists): a
recovered pull request must not keep advertising a pause that is over. The
supersede is skipped when the listing produced no readable round, because a
pause needs `W + 1` of them and such a pull request has never been paused.

## Configuration

| Repository variable         | Default | Meaning                                                                        |
| --------------------------- | ------- | ------------------------------------------------------------------------------ |
| `REVIEW_AUTO_STOP_WINDOW`   | `3`     | Consecutive non-shrinking rounds tolerated before the automatic trigger stops. |
| `REVIEW_AUTO_STOP_DISABLED` | unset   | `true` turns the rule off entirely.                                            |

Both are read in `delay-automatic-review`. Neither exists in the pipeline —
they are the caller's, and changing them changes no verdict, no finding, and
no posted review.

## Why the number is not a round count

The obvious rule — "stop after round N" — is the one the measured data
rejects. Two pull requests that ran this feature's own review loop to
completion (#9461 and #9623) each took nine rounds, and #9461's rounds 6 and
7 still produced 5 and 2 Critical findings. A round-count bar would have cut
those off. The trend is the signal; the count is not.

## Three runtime traps, all fail-open, all silent

Every round of this feature has shipped green and broken, and always for the
same reason: fail-open failures leave no mark. They are pinned by tests now,
and they are the things to check before editing the step.

1. **The listing must not use `--paginate --jq`.** `gh` applies the filter
   per page and concatenates the outputs, so a pull request past 100 reviews
   emits two JSON documents rather than one array. `JSON.parse` rejects it,
   the fallback reads "no rounds carry a marker", and the rule keeps
   reviewing — permanently inert on exactly the long diverging loops it
   exists for, while working on every pull request short enough that the
   treadmill is still bearable. Use `--paginate` alone and slurp with
   `jq -s`, this repository's convention everywhere else.
2. **The notice body must contain the marker it is looked up by.**
   `upsert-bot-comment.sh` finds a prior comment only through
   `contains($marker)`. A body without the marker never matches, so every
   stop POSTs a new comment — and a paused pull request re-decides the same
   stop on every push, so the duplicates are unbounded, on exactly the
   long-diverging loops this rule targets. The marker is one shell variable
   used for both the body and the lookup key, so the two cannot drift.
3. **The notice must be posted with `CI_BOT_PAT`.** It is an issue comment,
   the job holds no `issues: write`, and `upsert-bot-comment.sh` opens by
   resolving its author scope through `gh api user` — an endpoint a
   `GITHUB_TOKEN` cannot call at all. Under the job token every stop was
   silent on the pull request, which is the one failure mode the notice
   exists to prevent. The two reads stay on the job token.

## Where it lives

- `.github/scripts/review-auto-stop.mjs` — the decision, as a pure function.
- `.github/scripts/review-auto-stop.test.mjs` — its tests, registered in
  `HELPER_TESTS`. The later half of the file replays the shipped `run:` block
  against a stubbed `gh` that paginates the way the real one does and keeps a
  comment store across runs; a unit test over the decision alone cannot see
  any of the traps above.
- `packages/cli/src/commands/review/lib/ledger-auto-stop-contract.test.ts` —
  the only coupling between the marker this pipeline writes and the second,
  hand-copied reader that consumes it. It feeds real `serializeLedger` output
  through the real gate, so a producer-side format change cannot leave the
  gate silently reading zero rounds.
- `.github/workflows/qwen-code-pr-review.yml` — the gate that calls it.
