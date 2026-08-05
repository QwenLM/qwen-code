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
// refuses to start a round that no longer fits. Two quantities have to fit,
// not one: the tail (the last verification, compose-review, submission — the
// reserve) AND the round being admitted, whose cost the gate now measures
// instead of guessing — the loop's terminal round is by construction the one
// that starts closest to the boundary, so a gate that admits a round on the
// reserve alone re-creates the killed-mid-verification failure one round wide.
// Each admission is stamped on disk; the next admission reads the previous
// stamp and uses the observed round cost, falling back to a conservative
// constant for round 1 (which starts with the most headroom).
//
// The refusal is deterministic twice over: the builder exits 4 with no prompt
// built (there is no round to launch without it), and a `budget-stop.json`
// marker is written beside the prompt records so `compose-review` synthesizes
// the verdict-capping disclosure itself — the orchestrator's copy of the
// entry is a courtesy to the terminal reader, not the mechanism.
//
// A run with no deadline in its environment — every local run — is untouched.
// A malformed deadline fails OPEN (the gate stays silent): the outer kill
// still bounds the run, and a broken environment variable must degrade to
// today's behaviour, not wedge every budgeted review at round 1.

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promptRecordDir } from './prompt-record.js';

/** Unix seconds at which the review process will be killed. Set by CI. */
export const DEADLINE_ENV = 'QWEN_REVIEW_DEADLINE_EPOCH';

/** Override for the tail reserve, in seconds. */
export const RESERVE_ENV = 'QWEN_REVIEW_DEADLINE_RESERVE_SECONDS';

/**
 * What must still fit after the last reverse-audit round completes: the
 * verification of that round's findings, compose-review, anchor resolution
 * and the submission itself.
 *
 * Under the pipelined loop (SKILL.md Step 5), a round's verification
 * launches WITH the next round's auditors instead of sitting between
 * admissions — so the admission-to-admission span the gate measures
 * contains no verification pass, and the terminal round's verification has
 * exactly one cover: this reserve. That makes the reserve's sizing the
 * whole margin, not a top-up on an overlap the measurement already
 * carried — so the estimate refuses to be optimistic too: it prices the
 * round from the COSTLIEST span the run has measured (see
 * `expectedRoundSeconds`), because round costs do not climb smoothly —
 * each round re-reads the diff against a longer findings list, and a
 * repair relaunch lands mid-loop and makes one round the expensive one —
 * and the newest span alone under-predicts the next in exactly the runs
 * that end near the boundary. Over-reserving ends the loop at most one
 * round early, disclosed as a budget stop; under-reserving is #8368 —
 * killed mid-verification, holding every confirmed finding.
 *
 * Sized from the only tail measurement the record holds (#8368, +1699
 * lines): the loop ended with half an hour left and the outer kill found
 * round 5's verification STILL RUNNING — the tail had consumed more than 30
 * minutes and was nowhere through (compose, anchor resolution and
 * submission never started). No upper bound was ever measured, so the size
 * is insurance, not arithmetic: pipelining made this reserve the terminal
 * round's ONLY cover, and until pipelined runs measure their tails, the
 * reserve buys the unknown, not the known. Over-reserving ends the loop at
 * most one round early, disclosed as a budget stop; under-reserving is
 * #8368.
 *
 * This is only the fallback: the budget itself is
 * chosen outside the CLI (a repository variable, a workflow input, a
 * `/review --timeout=N` comment), so the review workflow passes a reserve
 * scaled to the budget it resolved rather than trusting this constant to fit
 * an arbitrary one. The workflow caps that scaled reserve at this same
 * number (`.github/workflows/qwen-code-pr-review.yml`) — keep the two in
 * sync. A local run has no deadline and no reserve at all.
 */
export const DEFAULT_RESERVE_SECONDS = 4800;

/**
 * The admission estimate for a round nothing has measured yet — round 1, or
 * a record dir that lost its stamps. Thirty minutes covers a measured
 * small-PR round (~17 min, #8456) with margin; a large PR's first round may
 * exceed it, but round 1 starts with the most headroom, and every later
 * admission uses the previous round's observed cost instead of this.
 */
export const DEFAULT_ROUND_SECONDS = 1800;

/** Floor for an observed round cost — a quick same-round rebuild is not a round. */
const MIN_OBSERVED_ROUND_SECONDS = 600;

interface RoundStamp {
  round: number | null;
  atMs: number;
}

const STAMPS_FILE = 'budget-rounds.json';
const STOP_FILE = 'budget-stop.json';

/**
 * Slack for the run-epoch fence below: absorbs the sub-millisecond skew
 * between a file mtime (fractional) and `Date.now()` (integral) when a
 * record is written moments after the plan. Real cross-run gaps are minutes
 * to hours; two seconds is noise against them.
 */
const RUN_EPOCH_SLACK_MS = 2000;

/**
 * The run's epoch: records older than this predate the run and are ignored.
 *
 * The stamps and the stop marker key on the plan path, which is stable per
 * PR — but every run rewrites the plan at its Step 1 capture (`fetch-pr` /
 * `plan-diff` / `capture-local`), so the plan's own mtime dates the run. A
 * budgeted run killed by the outer deadline leaves its records behind (the
 * Step 9 cleanup never ran, and the workflow's start-of-run sweep removes
 * worktrees, not these files); without the fence the next review of the
 * same PR would price its rounds off the previous run's stamps (an
 * hours-old stamp reads as an hours-long round and refuses round 1 of a
 * fresh budget) and cap its verdict on a stop that did not happen in this
 * run. An unstatable plan disables the fence — fail open, like every other
 * malformed input this module reads.
 */
function runEpochMs(planPath: string): number {
  try {
    return statSync(planPath).mtimeMs - RUN_EPOCH_SLACK_MS;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
}

/**
 * The admission stamps written so far THIS RUN, oldest first. Unreadable →
 * empty; a stamp older than the plan's own capture belonged to a previous
 * run of the same PR and is dropped (see `runEpochMs`).
 */
export function readRoundStamps(planPath: string): RoundStamp[] {
  try {
    const raw = readFileSync(
      join(promptRecordDir(planPath), STAMPS_FILE),
      'utf8',
    );
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const epoch = runEpochMs(planPath);
    return parsed.filter(
      (e): e is RoundStamp =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as RoundStamp).atMs === 'number' &&
        (e as RoundStamp).atMs >= epoch,
    );
  } catch {
    return [];
  }
}

/**
 * Record an admission. One stamp per round: a per-chunk rebuild of a round
 * already admitted must not shrink the observed cost of the round before it.
 * Write errors are swallowed for the same reason `recordPrompt` swallows
 * them — a read-only tmp dir must not stop a review being built.
 */
export function stampRound(
  planPath: string,
  round: number | undefined,
  nowMs: number = Date.now(),
): void {
  try {
    const stamps = readRoundStamps(planPath);
    if (round !== undefined && stamps.some((s) => s.round === round)) return;
    stamps.push({ round: round ?? null, atMs: nowMs });
    const dir = promptRecordDir(planPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, STAMPS_FILE), JSON.stringify(stamps));
  } catch {
    // Informational bookkeeping; the gate falls back to its constant.
  }
}

/**
 * What the round about to be admitted is expected to cost, in seconds: the
 * COSTLIEST round the run has measured (admission-to-admission — its audit
 * fan-out and the orchestration around it; under the pipelined loop a
 * round's verification overlaps the NEXT round instead of sitting between
 * admissions, so it is not in this measure, and the terminal round's
 * verification is exactly what the deadline's reserve covers) when a stamp
 * exists, else the conservative constant. The costliest, not the newest:
 * the reserve is the terminal round's only cover, and the run's own worst
 * span is the evidence of what a round can cost — a newest-only estimate
 * nets a mid-loop repair relaunch away the round after it lands, in
 * exactly the runs that end near the boundary. A stamp of the SAME round
 * is ignored — that is a rebuild, and measuring it would report a round
 * as cheap because its prompts were built twice quickly.
 */
export function expectedRoundSeconds(
  planPath: string,
  round: number | undefined,
  nowMs: number = Date.now(),
): number {
  const stamps = readRoundStamps(planPath).filter(
    (s) => round === undefined || s.round !== round,
  );
  if (stamps.length === 0) return DEFAULT_ROUND_SECONDS;
  let maxSeconds = 0;
  for (let i = 0; i < stamps.length; i++) {
    const end = i + 1 < stamps.length ? stamps[i + 1].atMs : nowMs;
    maxSeconds = Math.max(
      maxSeconds,
      Math.round((end - stamps[i].atMs) / 1000),
    );
  }
  return Math.max(MIN_OBSERVED_ROUND_SECONDS, maxSeconds);
}

export interface BudgetExhausted {
  /** Whole seconds until the deadline; can be negative when already past. */
  remainingSeconds: number;
  /** The tail reserve the remaining time failed to clear. */
  reserveSeconds: number;
  /** The admission estimate for the refused round itself. */
  expectedRoundSeconds: number;
}

/**
 * Decide whether another reverse-audit round still fits the review's time
 * budget: the remaining time must cover the round being admitted AND the
 * tail after it. Returns `null` when it does — or when no (well-formed)
 * deadline is present, which is every local run.
 */
export function reverseAuditBudgetExhausted(
  env: NodeJS.ProcessEnv,
  roundCostSeconds: number,
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
    // `r >= 0` (not `> 0`) is deliberate: 0 is the escape hatch that shrinks
    // the requirement to the round estimate alone, keeping only the refusal
    // of a round that cannot finish before the deadline itself.
    if (Number.isFinite(r) && r >= 0) reserve = r;
  }

  const remainingSeconds = Math.floor(deadline - nowMs / 1000);
  if (remainingSeconds >= reserve + roundCostSeconds) return null;
  return {
    remainingSeconds,
    reserveSeconds: reserve,
    expectedRoundSeconds: roundCostSeconds,
  };
}

export interface BudgetStop {
  /** The exact `unreviewedDimensions` entry, composed here so the text that
   * caps the verdict is this module's in both channels. */
  entry: string;
  /** The Chinese pair of `entry` — the posted body is bilingual. */
  entryZh: string;
  round: number | null;
  remainingSeconds: number;
  reserveSeconds: number;
  atMs: number;
}

/**
 * The phrase that identifies the budget-stop disclosure wherever it is
 * relayed. Exported so `compose-review` dedups the orchestrator's copy
 * against the marker's by the same text the entry itself is spelled with —
 * a reword of the entry moves its key along with it.
 */
export const BUDGET_STOP_PHRASE = 'review time budget';

/**
 * The disclosure as structural parts, both languages: compose-review renders
 * it through the same bilingual coverage path as every other structural gap.
 * The entry texts below are these parts joined, never the other way around.
 */
export function budgetStopDisclosure(round: number | undefined): {
  subject: string;
  reason: string;
  subjectZh: string;
  reasonZh: string;
} {
  const which = round !== undefined ? `round ${round}` : 'the next round';
  const whichZh = round !== undefined ? `第 ${round} 轮` : '下一轮';
  return {
    subject: 'reverse audit',
    reason: `stopped before ${which} by the ${BUDGET_STOP_PHRASE}`,
    subjectZh: '反向审计',
    reasonZh: `评审时间预算不足，未能开始${whichZh}`,
  };
}

/** The disclosure entry, spelled once for the marker AND the stderr message. */
export function budgetStopEntry(round: number | undefined): string {
  const d = budgetStopDisclosure(round);
  return `${d.subject} — ${d.reason}`;
}

/** The Chinese pair of `budgetStopEntry` — the marker carries both. */
export function budgetStopEntryZh(round: number | undefined): string {
  const d = budgetStopDisclosure(round);
  return `${d.subjectZh}——${d.reasonZh}`;
}

/**
 * Persist the refusal beside the prompt records, where `compose-review`
 * reads it back and synthesizes the verdict-capping disclosure without
 * depending on the orchestrator to relay a sentence. Write errors are
 * swallowed: the stderr instruction still carries the entry, and a gate
 * that cannot write must still refuse.
 */
export function writeBudgetStop(
  planPath: string,
  spent: BudgetExhausted,
  round: number | undefined,
  nowMs: number = Date.now(),
): void {
  try {
    const dir = promptRecordDir(planPath);
    mkdirSync(dir, { recursive: true });
    const stop: BudgetStop = {
      entry: budgetStopEntry(round),
      entryZh: budgetStopEntryZh(round),
      round: round ?? null,
      remainingSeconds: spent.remainingSeconds,
      reserveSeconds: spent.reserveSeconds,
      atMs: nowMs,
    };
    writeFileSync(join(dir, STOP_FILE), JSON.stringify(stop, null, 2));
  } catch {
    // See above: refusing is the load-bearing half.
  }
}

/**
 * The budget-stop marker, if THIS RUN wrote one. Unreadable → null; so is a
 * marker older than the plan's own capture — a previous run's refusal, left
 * behind by a kill before cleanup, must not cap a verdict on a stop that
 * did not happen in this run (see `runEpochMs`). A marker without a numeric
 * `atMs` cannot prove which run it belongs to and is treated the same way —
 * only this module writes markers, and it always dates them.
 */
export function readBudgetStop(planPath: string): BudgetStop | null {
  try {
    const raw = readFileSync(
      join(promptRecordDir(planPath), STOP_FILE),
      'utf8',
    );
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as BudgetStop).entry !== 'string' ||
      typeof (parsed as BudgetStop).atMs !== 'number' ||
      (parsed as BudgetStop).atMs < runEpochMs(planPath)
    ) {
      return null;
    }
    return parsed as BudgetStop;
  } catch {
    return null;
  }
}

/**
 * The refusal, spelled as the termination rule it is. Printed to stderr by
 * `agent-prompt` alongside exit code 4; the disclosure sentence matches the
 * `budget-stop.json` marker byte for byte, so both channels cap the verdict
 * with one text.
 */
export function reverseAuditBudgetMessage(
  spent: BudgetExhausted,
  round: number | undefined,
): string {
  const minutesLeft = Math.max(0, Math.floor(spent.remainingSeconds / 60));
  const reserveMinutes = Math.round(spent.reserveSeconds / 60);
  const roundMinutes = Math.round(spent.expectedRoundSeconds / 60);
  const which = round !== undefined ? `round ${round}` : 'the next round';
  return (
    `BUDGET: ${minutesLeft} minute(s) remain before this review's deadline — ` +
    `not enough for the ~${roundMinutes}-minute round being asked for plus ` +
    `the ${reserveMinutes}-minute reserve kept for its verification, ` +
    `compose-review and submission — so no further reverse-audit round will ` +
    `be built. This is the loop's termination rule, not an error: do not ` +
    `rebuild ${which} and do not relaunch auditors. A budget-stop marker has ` +
    `been recorded and compose-review will disclose it and cap the verdict ` +
    `itself; also add exactly this entry to unreviewedDimensions so the ` +
    `terminal report says it too — ` +
    `\`${budgetStopEntry(round)}\` — ` +
    `and proceed to Step 6 with the findings already confirmed. Spend what ` +
    `time remains only on verifying findings already in hand, composing, and ` +
    `submitting. A review that stops here still reports everything it ` +
    `proved; a review that runs past its deadline is killed holding all of it.`
  );
}
