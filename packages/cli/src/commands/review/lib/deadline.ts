/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The reverse-audit loop's clock.
//
// The iterative reverse audit (Step 5) is the one stage of a review whose cost
// is open-ended: each round is a fan-out (one auditor per chunk on a 3B plan),
// each round's findings go back through verification, and the loop runs until
// two consecutive dry rounds or the 5-round cap. On a PR where every round
// finds something, that is the whole budget. Measured on a real CI run
// (#8368, +1699 lines): the audit loop ran to the 5-round cap, consumed 3.5 of
// the job's 4 budgeted hours, and the outer GNU-timeout kill arrived while
// round 5's findings were still being verified — the review died holding
// every confirmed finding it had, and nothing reached the pull request.
//
// So a time-budgeted run tells the CLI its deadline, and the round *builder*
// refuses to start a round that no longer fits. The refusal is deterministic
// and lands where the orchestrator already looks (the command it must run to
// get the next round's prompts), which is what makes it a termination rule
// rather than advice: there is no round to launch without the builder.
//
// A run with no deadline in its environment — every local run — is untouched.
// A malformed deadline fails OPEN (the gate stays silent): the outer kill
// still bounds the run, and a broken environment variable must degrade to
// today's behaviour, not wedge every budgeted review at round 1.

/** Unix seconds at which the review process will be killed. Set by CI. */
export const DEADLINE_ENV = 'QWEN_REVIEW_DEADLINE_EPOCH';

/** Override for the tail reserve, in seconds. */
export const RESERVE_ENV = 'QWEN_REVIEW_DEADLINE_RESERVE_SECONDS';

/**
 * What must still fit after the last reverse-audit round is *refused*: the
 * verification of the previous round's findings, compose-review, anchor
 * resolution and the submission itself. Sized from the measured #8368
 * cadence — each audit round plus its verification took 28-53 minutes, and
 * the run needed roughly 15 more to compose and post — so one hour keeps a
 * refused round's whole tail affordable. On the default 180-minute CI budget
 * this leaves the loop about two hours, roughly three rounds; a local run
 * has no deadline and no reserve at all.
 */
export const DEFAULT_RESERVE_SECONDS = 3600;

export interface BudgetExhausted {
  /** Whole seconds until the deadline; can be negative when already past. */
  remainingSeconds: number;
  /** The reserve that remaining time failed to clear. */
  reserveSeconds: number;
}

/**
 * Decide whether another reverse-audit round still fits the review's time
 * budget. Returns `null` when it does — or when no (well-formed) deadline is
 * present, which is every local run.
 */
export function reverseAuditBudgetExhausted(
  env: NodeJS.ProcessEnv,
  nowMs: number = Date.now(),
): BudgetExhausted | null {
  const raw = env[DEADLINE_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const deadline = Number(raw);
  if (!Number.isFinite(deadline) || deadline <= 0) return null;

  let reserve = DEFAULT_RESERVE_SECONDS;
  const reserveRaw = env[RESERVE_ENV];
  if (reserveRaw !== undefined && reserveRaw.trim() !== '') {
    const r = Number(reserveRaw);
    if (Number.isFinite(r) && r >= 0) reserve = r;
  }

  const remainingSeconds = Math.floor(deadline - nowMs / 1000);
  if (remainingSeconds >= reserve) return null;
  return { remainingSeconds, reserveSeconds: reserve };
}

/**
 * The refusal, spelled as the termination rule it is. Printed to stderr by
 * `agent-prompt` alongside exit code 4; the disclosure sentence is the exact
 * `unreviewedDimensions` entry the orchestrator must carry into Step 6, so
 * the text that caps the verdict is this command's, not a paraphrase.
 */
export function reverseAuditBudgetMessage(
  spent: BudgetExhausted,
  round: number | undefined,
): string {
  const minutesLeft = Math.max(0, Math.floor(spent.remainingSeconds / 60));
  const reserveMinutes = Math.round(spent.reserveSeconds / 60);
  const which = round !== undefined ? `round ${round}` : 'the next round';
  return (
    `BUDGET: ${minutesLeft} minute(s) remain before this review's deadline — ` +
    `inside the ${reserveMinutes}-minute reserve kept for the last ` +
    `verification, compose-review and submission — so no further ` +
    `reverse-audit round will be built. This is the loop's termination rule, ` +
    `not an error: do not rebuild ${which} and do not relaunch auditors. ` +
    `Add exactly this entry to unreviewedDimensions — ` +
    `\`reverse audit — stopped before ${which} by the review time budget\` — ` +
    `and proceed to Step 6 with the findings already confirmed. Spend what ` +
    `time remains only on verifying findings already in hand, composing, and ` +
    `submitting. A review that stops here still reports everything it ` +
    `proved; a review that runs past its deadline is killed holding all of it.`
  );
}
