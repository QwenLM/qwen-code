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
// two consecutive dry rounds or the plan's round cap (5, or 3 for a huge
// diff). On a PR where every round
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

import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parsePositiveIntegerEnv } from '@qwen-code/qwen-code-core';
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
 * The slice of the tail that composing and submitting a review need on
 * their own, with no verification in it. The reserve above covers the
 * terminal round's verification PLUS this; a review that stops verifying at
 * this boundary still composes and posts everything it has proved.
 *
 * A distinct, smaller floor exists because the two costs fail differently.
 * A round's verification scales with its finding count and — on a security
 * PR whose findings are shell/git bypasses re-checked with real filesystem
 * E2E — with the per-finding cost, without bound; compose-review is one CLI
 * call and the submission a handful of `gh` calls, both bounded. So the
 * verification is what a wall runs into, and the fix is to gate the
 * VERIFIER on this floor: below it, no verify shard is built, the
 * findings in hand keep their `— [unverified]` tag (compose-review caps the
 * verdict on it), and compose still runs. Measured: PR #8687, a 4 269-line
 * cross-worktree git guard, ran the audit to a correct budget stop with
 * ~110 minutes left, then a single hand-rolled re-verification agent
 * re-running a 15-family bypass battery with real bash+git consumed all of
 * it — the wall hit mid-verification, compose never ran, and ~20
 * E2E-confirmed Critical bypasses were never posted. Twenty minutes is
 * insurance sized like the reserve, not arithmetic: compose + anchor
 * resolution + submit has no measured upper bound, and over-reserving only
 * ends verification a shard early, disclosed as an unverified tag.
 */
export const DEFAULT_COMPOSE_FLOOR_SECONDS = 1200;

/** Override for the compose floor, in seconds. */
export const COMPOSE_FLOOR_ENV = 'QWEN_REVIEW_DEADLINE_COMPOSE_FLOOR_SECONDS';

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

/**
 * The runtime's concurrent-agent slots — the pool every fan-out launch
 * shares. The core tool scheduler runs the orchestrator's parallel `agent`
 * calls under this cap (default 10), the review workflow does not override
 * it, and an `agent-prompt` subprocess inherits the orchestrator's
 * environment — so the gate and the launches it gates read the same pool.
 */
export const TOOL_CONCURRENCY_ENV = 'QWEN_CODE_MAX_TOOL_CONCURRENCY';
export const DEFAULT_TOOL_CONCURRENCY = 10;

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
 * The costliest of `stamps`' admission-to-admission spans — each span ends
 * at the next stamp, the last at `endMs` — floored at the observation
 * floor; `null` when there are no stamps.
 */
function costliestSpanSeconds(
  stamps: RoundStamp[],
  endMs: number,
): number | null {
  if (stamps.length === 0) return null;
  let maxSeconds = 0;
  for (let i = 0; i < stamps.length; i++) {
    const end = i + 1 < stamps.length ? stamps[i + 1].atMs : endMs;
    maxSeconds = Math.max(
      maxSeconds,
      Math.round((end - stamps[i].atMs) / 1000),
    );
  }
  return Math.max(MIN_OBSERVED_ROUND_SECONDS, maxSeconds);
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
  return costliestSpanSeconds(stamps, nowMs) ?? DEFAULT_ROUND_SECONDS;
}

/**
 * What the ADMISSION itself commits, in seconds — `expectedRoundSeconds`,
 * except when the round being admitted launches while its predecessor is
 * still in flight: the convergence pair's second member, built in the same
 * response as the first. The predecessor's stamp is fresher than the
 * observation floor — nothing has measured the round yet, and no elapsed
 * time has paid for it — so the admission must cover BOTH members' wall,
 * not just its own. That wall is the pair's two fan-outs sharing the
 * tool-concurrency pool: ceil(2C/N) waves against one round's ceil(C/N),
 * for C auditors on a pool of N, and the first never exceeds twice the
 * second — so the price is the single-round estimate scaled by exactly
 * those waves: one round's price when the pool holds both members at once
 * (the 3A shape, and a 3B pair whose chunks fit), more as the pool
 * serializes them, and never beyond the two-round bound whatever the pool.
 * Pricing the second member off the just-written first stamp instead — a
 * seconds-old span clamped to the floor — committed the pair at one
 * round's price for up to two rounds' wall, and near the deadline the
 * pair consumed the reserve and hit the outer timeout before posting.
 *
 * The price deliberately covers the pair's AUDITOR fan-outs only: the pair
 * launches in the same response as the Step 4 verifier shards, which share
 * the same pool waves, and if they stretch the batch past the priced waves
 * the extra wall is bounded by the verifier batch's own wave count — one
 * wave for any normal finding set — which the reserve the gate holds ahead
 * of every admission is there to carry.
 *
 * One ledger shape the price does not correct: the pair stamps rounds 1
 * and 2 seconds apart, so after the pair returns, the span from round 2's
 * stamp to the next admission covers the pair's whole wall, and every solo
 * round after it prices at up to twice its true cost. Accepted
 * conservatism: an over-priced gate refuses a round near the deadline that
 * would have fit — a capped verdict that still posts — never the
 * killed-before-compose shape the gate exists to prevent.
 */
export function expectedAdmissionSeconds(
  planPath: string,
  round: number | undefined,
  fanOutWidth: number,
  env: NodeJS.ProcessEnv,
  nowMs: number = Date.now(),
): number {
  const stamps = readRoundStamps(planPath).filter(
    (s) => round === undefined || s.round !== round,
  );
  const last = stamps.length > 0 ? stamps[stamps.length - 1] : undefined;
  const predecessorInFlight =
    last !== undefined && nowMs - last.atMs < MIN_OBSERVED_ROUND_SECONDS * 1000;
  if (!predecessorInFlight) {
    return expectedRoundSeconds(planPath, round, nowMs);
  }
  const single =
    costliestSpanSeconds(stamps.slice(0, -1), last.atMs) ??
    DEFAULT_ROUND_SECONDS;
  const pool = parsePositiveIntegerEnv(
    env[TOOL_CONCURRENCY_ENV],
    DEFAULT_TOOL_CONCURRENCY,
  );
  const width = Math.max(1, Math.floor(fanOutWidth));
  const pairWaves = Math.ceil((2 * width) / pool);
  const roundWaves = Math.ceil(width / pool);
  return Math.ceil((single * pairWaves) / roundWaves);
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
 * The deadline epoch both gates read, or null when unset/malformed — the
 * fail-open contract in one place so the two gates cannot drift on it. A
 * missing, empty, non-finite or non-positive `QWEN_REVIEW_DEADLINE_EPOCH`
 * leaves the review ungated (the outer timeout still bounds it).
 */
function readDeadlineSeconds(env: NodeJS.ProcessEnv): number | null {
  const raw = env[DEADLINE_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const deadline = Number(raw);
  if (!Number.isFinite(deadline) || deadline <= 0) return null;
  return deadline;
}

/**
 * A non-negative seconds override from `env[key]`, or `fallback`. `>= 0`
 * (not `> 0`) is deliberate: 0 is a documented escape hatch on both gates.
 * A missing or malformed value falls back — never a silent zero.
 */
function readNonNegativeSeconds(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw !== undefined && raw.trim() !== '') {
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return fallback;
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
  const deadline = readDeadlineSeconds(env);
  if (deadline === null) return null;
  // 0 is the escape hatch that shrinks the requirement to the round estimate
  // alone, keeping only the refusal of a round that cannot finish at all.
  const reserve = readNonNegativeSeconds(
    env,
    RESERVE_ENV,
    DEFAULT_RESERVE_SECONDS,
  );

  const remainingSeconds = Math.floor(deadline - nowMs / 1000);
  if (remainingSeconds >= reserve + roundCostSeconds) return null;
  return {
    remainingSeconds,
    reserveSeconds: reserve,
    expectedRoundSeconds: roundCostSeconds,
  };
}

export interface ComposeFloorExhausted {
  /** Whole seconds until the deadline; can be negative when already past. */
  remainingSeconds: number;
  /** The compose floor the remaining time failed to clear. */
  composeFloorSeconds: number;
}

/**
 * Decide whether a verification shard still fits before the compose floor:
 * the deterministic backstop that keeps the terminal round's verification
 * from consuming the time compose-review and submission need. Returns
 * `null` when a verify build may proceed — or when no deadline is set (a
 * local run), so the gate is inert exactly where the reverse-audit gate is.
 *
 * This fires only when the reserve has already been spent down into the
 * compose floor — the reverse-audit gate keeps `reserve` (which includes
 * this floor) ahead of the last round, so a healthy run never reaches it.
 * It is the cover for the one span the reserve cannot bound: a terminal
 * verification whose cost the finding set made larger than the reserve
 * planned for.
 */
export function verifyBudgetExhausted(
  env: NodeJS.ProcessEnv,
  nowMs: number = Date.now(),
): ComposeFloorExhausted | null {
  const deadline = readDeadlineSeconds(env);
  if (deadline === null) return null;
  const floor = readNonNegativeSeconds(
    env,
    COMPOSE_FLOOR_ENV,
    DEFAULT_COMPOSE_FLOOR_SECONDS,
  );

  // A zero floor disables the gate ENTIRELY — the documented escape hatch.
  // Return before the comparison below: past the deadline `remainingSeconds`
  // is negative, and a comparison-only check would fire the "disabled" gate
  // exactly when it was asked to stand down.
  if (floor <= 0) return null;

  const remainingSeconds = Math.floor(deadline - nowMs / 1000);
  // STRICTLY greater: the floor is the bare time compose and submit need,
  // with nothing to spare. At exactly the floor, admitting a verifier and
  // letting it do any work crosses below it — so equality refuses, unlike
  // the reverse-audit reserve (which carries its own margin and admits at
  // exact cover).
  if (remainingSeconds > floor) return null;
  return { remainingSeconds, composeFloorSeconds: floor };
}

/**
 * The stderr line the verify gate prints on refusal — a termination rule
 * for the verification pass, not an error, spelled so the orchestrator
 * composes now rather than re-attempting the build.
 */
export function verifyBudgetMessage(spent: ComposeFloorExhausted): string {
  const minutesLeft = Math.max(0, Math.floor(spent.remainingSeconds / 60));
  const floorMinutes = Math.round(spent.composeFloorSeconds / 60);
  return (
    `VERIFY BUDGET: ${minutesLeft} minute(s) remain before this review's ` +
    `deadline — at or below the ${floorMinutes}-minute floor compose-review and ` +
    `submission need, so no verification shard will be built. This is a ` +
    `termination rule, not an error: do not rebuild the verifier. Proceed ` +
    `to Step 6 NOW and compose. Findings still carrying \`— [unverified]\` ` +
    `keep that tag: compose-review caps the verdict on it and never treats ` +
    `an unverified finding as a confirmed blocker — everything earlier ` +
    `rounds confirmed still posts. A review that stops verifying here ` +
    `reports what it proved; one that keeps verifying past this floor is ` +
    `killed before it posts anything.`
  );
}

export interface BudgetStop {
  /**
   * Which termination wrote this marker: the time budget (the reverse-audit
   * loop ran out of clock) or the round cap (it ran its full allotted
   * rounds without converging). `compose-review` picks the disclosure text
   * by this; an absent value reads as `time-budget` for back-compat.
   */
  cause?: 'time-budget' | 'round-cap';
  /** The round cap, when `cause` is `round-cap` — what `compose-review`
   * re-derives the disclosure from, the way it uses `round` for a time stop. */
  cap?: number;
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
 * The phrase identifying a ROUND-CAP disclosure wherever it is relayed —
 * the cap analogue of `BUDGET_STOP_PHRASE`, so `compose-review` dedups the
 * orchestrator's relayed copy against the marker's by shared text.
 */
export const ROUND_CAP_PHRASE = 'reverse-audit round cap';

/**
 * The round-cap disclosure as structural parts, both languages — the
 * analogue of `budgetStopDisclosure` for a loop that ran its full allotted
 * rounds without converging.
 */
export function roundCapStopDisclosure(cap: number): {
  subject: string;
  reason: string;
  subjectZh: string;
  reasonZh: string;
} {
  return {
    subject: 'reverse audit',
    reason: `did not converge within the ${ROUND_CAP_PHRASE} of ${cap}`,
    subjectZh: '反向审计',
    reasonZh: `在 ${cap} 轮的反审轮数上限内未收敛`,
  };
}

/** The round-cap entry, spelled once for the marker AND the stderr message. */
export function roundCapStopEntry(cap: number): string {
  const d = roundCapStopDisclosure(cap);
  return `${d.subject} — ${d.reason}`;
}

/** The Chinese pair of `roundCapStopEntry`. */
export function roundCapStopEntryZh(cap: number): string {
  const d = roundCapStopDisclosure(cap);
  return `${d.subjectZh}——${d.reasonZh}`;
}

/**
 * Persist a round-cap refusal beside the prompt records, so
 * `compose-review` caps the verdict on a loop that ran its full rounds
 * without converging — without depending on the orchestrator to relay the
 * entry. Same marker file and same swallow-on-write-error discipline as
 * `writeBudgetStop`; only one stop fires per run, whichever refusal comes
 * first — the same-run guard below enforces it, so a retry-past-cap after a
 * time-budget stop cannot flip the recorded cause.
 */
export function writeRoundCapStop(
  planPath: string,
  cap: number,
  round: number | undefined,
  nowMs: number = Date.now(),
): void {
  try {
    // First refusal wins: a same-run marker already on disk (its run-epoch
    // fence in `readBudgetStop` excludes previous runs') is left untouched,
    // so a time-budget stop followed by a retry that the cap then refuses
    // does not post two contradictory stop disclosures.
    if (readBudgetStop(planPath) !== null) return;
    const dir = promptRecordDir(planPath);
    mkdirSync(dir, { recursive: true });
    const stop: BudgetStop = {
      cause: 'round-cap',
      cap,
      entry: roundCapStopEntry(cap),
      entryZh: roundCapStopEntryZh(cap),
      round: round ?? null,
      remainingSeconds: 0,
      reserveSeconds: 0,
      atMs: nowMs,
    };
    writeFileSync(join(dir, STOP_FILE), JSON.stringify(stop, null, 2));
  } catch {
    // Refusing is the load-bearing half; the stderr entry still carries it.
  }
}

/**
 * Persist the refusal beside the prompt records, where `compose-review`
 * reads it back and synthesizes the verdict-capping disclosure without
 * depending on the orchestrator to relay a sentence. Write errors are
 * swallowed: the stderr instruction still carries the entry, and a gate
 * that cannot write must still refuse. First refusal wins here too — a
 * same-run marker already on disk is left untouched.
 */
export function writeBudgetStop(
  planPath: string,
  spent: BudgetExhausted,
  round: number | undefined,
  nowMs: number = Date.now(),
): void {
  try {
    if (readBudgetStop(planPath) !== null) return;
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
 * Remove any stop marker beside the prompt records. Called when the loop
 * reaches a clean end that outranks an earlier same-run refusal — a
 * CONVERGED exit after an over-cap round was refused: the marker would
 * otherwise survive (nothing else unlinks it) and cap a verdict the audit
 * legitimately converged. Missing file and unlink errors are swallowed —
 * the file was the thing to be rid of.
 */
export function clearBudgetStop(planPath: string): void {
  try {
    rmSync(join(promptRecordDir(planPath), STOP_FILE), { force: true });
  } catch {
    // Best-effort: a marker we could not remove still only caps a verdict,
    // never corrupts one, and the converged stderr is the load-bearing half.
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
    `and proceed to Step 6. Verify the last round's findings ONLY through ` +
    `\`agent-prompt --role verify\` (never a hand-rolled agent) — it is gated ` +
    `on the compose floor and will refuse once too little time remains, ` +
    `leaving any still-\`[unverified]\` findings tagged for compose-review to ` +
    `cap; when the deadline is within that floor, stop waiting on any ` +
    `verifier batch still out and compose with the tags in hand. Do NOT ` +
    `re-verify findings already confirmed in earlier rounds, and do NOT ` +
    `invent a fresh re-verification pass. Then compose and submit — a ` +
    `review that stops here still reports everything it proved; a review ` +
    `that runs past its deadline is killed holding all of it.`
  );
}
