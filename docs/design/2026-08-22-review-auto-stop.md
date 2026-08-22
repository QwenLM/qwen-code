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
evidence, and both ways to resume.

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

## Where it lives

- `.github/scripts/review-auto-stop.mjs` — the decision, as a pure function.
- `.github/scripts/review-auto-stop.test.mjs` — its tests, registered in
  `HELPER_TESTS`.
- `.github/workflows/qwen-code-pr-review.yml` — the gate that calls it.
