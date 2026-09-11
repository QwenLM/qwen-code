/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  stripDisplayControlChars,
  stripTerminalControlSequences,
} from '../utils/terminalSafe.js';

export const GOAL_STATE_VERSION = 2 as const;
export const GOAL_PROPOSAL_REASON_MAX_CHARACTERS = 8_000;
export const GOAL_PROPOSAL_REASON_MAX_BYTES = 16_000;
export const GOAL_CHECKPOINT_CLAIM_LIMIT = 32;
export const GOAL_CHECKPOINT_CLAIM_MAX_CHARACTERS = 2_000;
export const GOAL_CHECKPOINT_CLAIM_MAX_BYTES = 16_000;
export const GOAL_CHECKPOINT_SOURCE_REFERENCE_LIMIT = 32;
export const GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON =
  'The current Goal revision exceeded the bounded evidence catalog. Automatic retries cannot recover. Edit or replace the Goal before resuming it.';
export const GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON =
  'The current Goal revision exceeded the checkpoint verifier request limit. Automatic retries cannot recover. Edit or replace the Goal before resuming it.';
/**
 * How many consecutive stalled checkpoints a Goal may run before it stops.
 * Three matches the thrash bounds elsewhere in this family of runtimes: one
 * stalled checkpoint is a busy turn, two is a pattern, three is the loop.
 */
export const GOAL_CHECKPOINT_STALL_LIMIT = 3;

/**
 * How many consecutive autonomous turns a Goal may make no progress on before
 * it stops. Same three as the checkpoint stall bound, and for the same
 * reason: one quiet turn is a pause for thought, two is a pattern, three is
 * the loop.
 */
export const GOAL_NO_PROGRESS_TURN_LIMIT = 3;
/**
 * The stall stop for a Goal whose last stalled check could not fit the window
 * inside the checkpoint's claim bounds: a full claim list that still left
 * evidence behind, or well-formed claims over the byte or per-claim length
 * budget. Compaction itself cannot keep up -- the objective produces more
 * evidence than one window holds -- so narrowing it is the remedy.
 */
export const GOAL_CHECKPOINT_STALLED_REASON =
  'The current Goal revision ran three consecutive evidence checkpoints without relief: the evidence window overflowed every time, and the last check could not fit it within the checkpoint claim bounds, so every turn paid a checkpoint call and lost uncatalogued evidence. Automatic retries cannot recover. Edit or replace the Goal with a narrower objective before resuming it.';

/**
 * The stall stop for a Goal whose last stalled check answered with output that
 * is not usable claims at all. The objective may not be too wide -- the
 * checkpoint model is returning output the runtime cannot accept -- so the
 * capacity advice to narrow it would send the user to rewrite a Goal that was
 * never the problem.
 */
export const GOAL_CHECKPOINT_UNUSABLE_REASON =
  'The current Goal revision ran three consecutive evidence checkpoints without relief: the evidence window overflowed every time, and the last check answered with output that could not be folded into claims. Narrowing the objective does not fix this. Check that the checkpoint model returns the structured JSON it is asked for, or switch models, then resume the Goal; resuming starts a fresh evidence window.';

/**
 * The stall stop for a Goal whose last stalled check produced no answer to
 * judge. The runtime cannot tell why from here: the provider may be
 * unreachable or rate-limited, the check may have run past its own ceiling on
 * a window too large to verify in time, or the check itself may have failed.
 * The recorded failure says which, so this names every remedy that can apply
 * rather than blaming the provider.
 */
export const GOAL_CHECKPOINT_UNREACHABLE_REASON =
  'The current Goal revision ran three consecutive evidence checkpoints without relief: the evidence window overflowed every time, and the last check failed before the checkpoint verifier returned an answer. The recorded checkpoint failure says why: an unreachable or rate-limited provider, a check that did not finish within model.goalCheckpointTimeoutSeconds, or an error in the check itself. Fix the provider, raise that timeout, or narrow the objective so the window checkpoints in time, then resume the Goal; resuming starts a fresh evidence window.';

/**
 * What the last stalled checkpoint check ran into, which decides the advice
 * the stop carries. `capacity`: the check could not fit the window within the
 * claim bounds (a full claim list that left evidence behind, or claims over
 * the byte or length budget). `unusable`: it answered with output that is not
 * usable claims. `unreachable`: no answer arrived to judge.
 */
export type GoalCheckpointFailureShape =
  | 'capacity'
  | 'unusable'
  | 'unreachable';

/** The `lastReason` a checkpoint stall stop records for its last failure. */
export function goalCheckpointStalledReason(
  shape: GoalCheckpointFailureShape,
): string {
  switch (shape) {
    case 'capacity':
      return GOAL_CHECKPOINT_STALLED_REASON;
    case 'unusable':
      return GOAL_CHECKPOINT_UNUSABLE_REASON;
    case 'unreachable':
      return GOAL_CHECKPOINT_UNREACHABLE_REASON;
    default: {
      const exhaustive: never = shape;
      return exhaustive;
    }
  }
}

/**
 * Longest `lastCheckpointFailure` a record keeps. A provider error can carry a
 * whole response body, and the record is journaled on every checkpoint check.
 */
export const GOAL_CHECKPOINT_FAILURE_MAX_CHARACTERS = 500;

/**
 * Makes a checkpoint failure safe to keep as a one-line diagnostic: terminal
 * control sequences and bidi overrides removed, every run of whitespace (line
 * breaks included) collapsed to one space, and the result capped by code
 * point. Collapsing runs before the cap, so the bound spends its code points
 * on the message rather than on a response body's indentation. The value is
 * journaled, handed to the model, and rendered on every Goal surface, so it is
 * cleaned once where it is written rather than trusted to each reader.
 */
export function capGoalCheckpointFailure(text: string): string {
  const oneLine = stripDisplayControlChars(stripTerminalControlSequences(text))
    .replace(/\s+/g, ' ')
    .trim();
  const codePoints = [...oneLine];
  return codePoints.length <= GOAL_CHECKPOINT_FAILURE_MAX_CHARACTERS
    ? oneLine
    : `${codePoints.slice(0, GOAL_CHECKPOINT_FAILURE_MAX_CHARACTERS - 1).join('')}…`;
}

/**
 * Whether a Goal surface should show checkpoint health, decided once so every
 * card and summary agrees. A completed Goal never does: its checkpoints no
 * longer matter, and the terminal snapshot keeps whatever the record carried.
 * A running stall streak always does, whatever the status, because it is
 * still the truth about the evidence window a resume re-enters. A failure that
 * spent no stall shows only while the Goal is active: once the Goal stops or
 * pauses for another reason, that diagnostic explains nothing about the stop
 * and would read as though it did.
 */
export function goalCheckpointHealthVisible(goal: {
  status?: string;
  checkpointStalls?: number;
  lastCheckpointFailure?: string;
}): boolean {
  if (goal.status === 'complete') return false;
  if ((goal.checkpointStalls ?? 0) > 0) return true;
  return (
    (goal.status ?? 'active') === 'active' &&
    Boolean(goal.lastCheckpointFailure?.trim())
  );
}

/**
 * Default autonomous spend window armed on a newly created Goal, in model
 * tokens on the `tokensUsed` metric (`totalTokenCount` summed per model call,
 * so a call's full input context counts every time it is sent).
 *
 * The meter bills Goal-turn model calls only -- per-turn side queries and
 * checkpoint-verifier calls are unmetered -- so real provider spend at a
 * stop runs above this window.
 *
 * This is an authorization quantum, not a cost estimate: it bounds how much
 * autonomous continuation one explicit user action (create, or a later
 * resume) pays for before the Goal stops and asks again. Sized to a few hours
 * of continuous turn cadence -- the runaway session this bound exists for
 * burned ~8.6M tokens in half an hour before a human killed it, so a healthy
 * long run reaches this ceiling late and a stuck loop reaches it unattended.
 */
export const GOAL_DEFAULT_TOKEN_BUDGET = 30_000_000;

/** The `lastReason` a Goal stops with when `tokensUsed` reaches its budget. */
export function goalTokenBudgetReason(tokenBudget: number): string {
  return `The Goal spent its autonomous token budget (${tokenBudget.toLocaleString('en-US')} tokens). Resume the Goal to authorize another budget window, or clear it.`;
}

/**
 * Whether `tokensUsed` has reached the armed ceiling. One predicate serves
 * both the runtime's stop condition and the reducer's re-arm condition, so
 * the stop/re-arm cycle cannot desynchronize.
 */
export function isGoalTokenBudgetSpent(
  goal: Pick<GoalRecord, 'tokensUsed' | 'tokenBudget'>,
): goal is Pick<GoalRecord, 'tokensUsed' | 'tokenBudget'> & {
  tokenBudget: number;
} {
  return goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget;
}

/** The `lastReason` a Goal stops with when `turnCount` reaches its budget. */
export function goalTurnBudgetReason(turnBudget: number): string {
  return `The Goal ran its Goal-turn budget (${turnBudget.toLocaleString('en-US')} ${turnBudget === 1 ? 'turn' : 'turns'}). Resume the Goal to authorize another window of turns, or clear it.`;
}

/**
 * Whether the Goal has finished as many turns as its budget allows. Shaped
 * like `isGoalTokenBudgetSpent` and used the same way: one predicate serves
 * the runtime's stop condition and the reducer's re-arm condition.
 */
export function isGoalTurnBudgetSpent(
  goal: Pick<GoalRecord, 'turnCount' | 'turnBudget'>,
): goal is Pick<GoalRecord, 'turnCount' | 'turnBudget'> & {
  turnBudget: number;
} {
  return goal.turnBudget !== undefined && goal.turnCount >= goal.turnBudget;
}

/**
 * The budget as the setting spells it. Minutes are the unit the setting takes
 * and the unit a stop is worth reporting in; a sub-minute budget only arises
 * in tests, and reporting one as `0 minutes` would read as unbounded.
 */
function formatGoalActiveTimeBudget(activeTimeBudgetMs: number): string {
  const minutes = activeTimeBudgetMs / 60_000;
  if (minutes >= 1) {
    const rounded = Math.round(minutes);
    return `${rounded.toLocaleString('en-US')} ${rounded === 1 ? 'minute' : 'minutes'}`;
  }
  const seconds = Math.max(1, Math.round(activeTimeBudgetMs / 1_000));
  return `${seconds.toLocaleString('en-US')} ${seconds === 1 ? 'second' : 'seconds'}`;
}

/** The `lastReason` a Goal stops with when its active time reaches its budget. */
export function goalActiveTimeBudgetReason(activeTimeBudgetMs: number): string {
  return `The Goal ran its active-time budget (${formatGoalActiveTimeBudget(activeTimeBudgetMs)}). Resume the Goal to authorize another window of time, or clear it.`;
}

/**
 * Whether the Goal has been active for as long as its budget allows.
 *
 * Takes the elapsed figure rather than computing it: active time keeps
 * accruing while the Goal is `active`, so the caller holds the clock (see
 * `elapsedActiveTime`). A stopped Goal's elapsed time is its committed
 * `activeTimeMs`, which is what makes the re-arm on resume well defined.
 */
export function isGoalActiveTimeBudgetSpent(
  goal: Pick<GoalRecord, 'activeTimeBudgetMs'>,
  elapsedActiveMs: number,
): goal is Pick<GoalRecord, 'activeTimeBudgetMs'> & {
  activeTimeBudgetMs: number;
} {
  return (
    goal.activeTimeBudgetMs !== undefined &&
    elapsedActiveMs >= goal.activeTimeBudgetMs
  );
}

/**
 * Which bound a `usage_limited` Goal ran into.
 *
 * Only the enumerated bounds are typed: they are the ones a caller has to
 * branch on. The evidence kinds mark a window a plain resume cannot simply
 * re-enter; the budget kinds mark a spent authorization that a resume re-arms.
 * Every other route to `usage_limited` is an operational failure that carries
 * prose in `lastReason` and nothing to key off.
 */
export type GoalLimitKind =
  | 'evidence_catalog'
  | 'checkpoint_request'
  | 'token_budget'
  | 'turn_budget'
  | 'time_budget';

export function isGoalLimitKind(value: unknown): value is GoalLimitKind {
  return (
    value === 'evidence_catalog' ||
    value === 'checkpoint_request' ||
    isGoalBudgetLimitKind(value)
  );
}

/**
 * Whether the bound is a spent authorization rather than a wall the Goal ran
 * into. Resuming a Goal stopped by one of these is the user granting another
 * window, so the resume clears the stop prose and re-arms the ceiling; the
 * evidence kinds instead need a fresh evidence window to make progress.
 */
export function isGoalBudgetLimitKind(
  value: unknown,
): value is 'token_budget' | 'turn_budget' | 'time_budget' {
  return (
    value === 'token_budget' ||
    value === 'turn_budget' ||
    value === 'time_budget'
  );
}

/** The limit a `usage_limited` reason denotes, for reasons that denote one. */
export function goalLimitKindForReason(
  reason: string,
): GoalLimitKind | undefined {
  if (reason === GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON) {
    return 'evidence_catalog';
  }
  if (reason === GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON) {
    return 'checkpoint_request';
  }
  return undefined;
}

export const PAUSED_GOAL_SYSTEM_REMINDER =
  '<system-reminder>\nThe Goal is paused. Do not continue its objective unless the user resumes it. Treat this message as ordinary conversation.\n</system-reminder>';

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usage_limited'
  | 'complete';

export type GoalActivity = 'idle' | 'running' | 'verifying';

export interface TranscriptCursor {
  recordId: string | null;
}

export interface GoalExpectedVersion {
  goalId: string;
  revision: number;
}

export interface GoalTurnPermit extends GoalExpectedVersion {
  turnId: string;
}

export type GoalEvidenceProofKind =
  | 'user_input'
  | 'delivered_output'
  | 'external_fact';

export function isGoalEvidenceProofKind(
  value: unknown,
): value is GoalEvidenceProofKind {
  return (
    value === 'user_input' ||
    value === 'delivered_output' ||
    value === 'external_fact'
  );
}

export interface GoalEvidenceCheckpointClaim {
  id: string;
  proofKind: GoalEvidenceProofKind;
  claim: string;
  sourceRefs: string[];
}

export interface GoalEvidenceCheckpoint {
  checkpointId: string;
  createdAt: number;
  claims: GoalEvidenceCheckpointClaim[];
}

export interface GoalRecord {
  goalId: string;
  revision: number;
  objective: string;
  status: GoalStatus;
  evidenceCursor: TranscriptCursor;
  turnCount: number;
  activeTimeMs: number;
  /**
   * Model tokens billed to this Goal so far, summed across its turn windows.
   *
   * Measured from the same session token source as `/stats`. Verification and
   * checkpoint side queries run between turn windows and are not included.
   * Zero on Goals recovered from a transcript written before the field existed.
   */
  tokensUsed: number;
  /**
   * The ceiling `tokensUsed` may reach before autonomous continuation stops
   * and the Goal waits for the user. Armed at creation from the runtime's
   * grant; a resume or edit of a Goal whose ceiling is spent moves it forward
   * (`tokensUsed + grant`) -- the spent meter itself is never reset. Absent
   * on Goals persisted before budgets existed: those stay unbounded.
   */
  tokenBudget?: number;
  /**
   * The count `turnCount` may reach before autonomous continuation stops and
   * the Goal waits for the user. Every finished Goal turn contributes to the
   * count, including user-driven turns, although those turns are not rejected
   * at the ceiling. Armed and re-armed exactly like `tokenBudget` (`turnCount
   * + grant` on the resume of a spent Goal), and absent by default.
   */
  turnBudget?: number;
  /**
   * The ceiling on `activeTimeMs` -- wall time while this Goal stays `active`,
   * including waits and idle time between turns -- before autonomous
   * continuation stops. Armed and re-armed like the other budgets, and absent
   * by default. Time paused, blocked, stopped, or outside a running process
   * does not count against it.
   */
  activeTimeBudgetMs?: number;
  /**
   * The turn that delivered this spend window's wind-down hand-off. A spent
   * budget grants one more continuation before it stops the Goal, so the
   * model can hand off instead of being cut mid-thought; this marks that
   * turn as finished. Stamped by the turn's own `turn_finished` record, so a
   * restart mid-hand-off (marker absent, hand-off never delivered) grants the
   * hand-off again, while a restart after it (marker present) does not.
   * Cleared whenever the budget is re-armed.
   */
  windDownTurnId?: string;
  createdAt: number;
  updatedAt: number;
  evidenceCheckpoint?: GoalEvidenceCheckpoint;
  /**
   * Consecutive checkpoint checks that failed to relieve an overflowing
   * evidence window: the checkpoint came back full (see
   * `isGoalCheckpointStalled`), the verifier result could not be folded
   * into claims at all, or the check itself failed -- a provider error or
   * a verifier that never answered before its timeout. Persisted on the
   * record rather than held in memory so a daemon restart or session
   * resume cannot launder the count; absent means zero. Reset by any
   * checkpoint check that finds room, and by every control action that
   * starts a different evidence window: edit, replace, and the resume of
   * an evidence-limited Goal.
   */
  checkpointStalls?: number;
  /**
   * What the most recent failed checkpoint check ran into, as a one-line
   * diagnostic (`ErrorName: message`, or the runtime's own phrase for a full
   * claim list), capped at GOAL_CHECKPOINT_FAILURE_MAX_CHARACTERS. Set by
   * every check that fails, whether or not it spends a stall, and kept on the
   * record the stall breaker stops, so the stop can be diagnosed from the
   * record alone. Cleared by a check that succeeds and by every control
   * action that clears `checkpointStalls`; a check that proves nothing either
   * way (a turn that recorded no evidence) leaves it as it was.
   */
  lastCheckpointFailure?: string;
  /**
   * Consecutive autonomous turns that recorded neither a tool result nor a
   * terminal proposal. A model that only restates status never reaches the
   * verifier and never spends a checkpoint, so nothing else bounds it short
   * of the token budget. Persisted like `checkpointStalls` so a restart
   * cannot launder the count; absent means zero. Reset by any turn that
   * records a tool result or a proposal, by a turn the user's own text
   * drove, and by edit, replace, and resume.
   */
  noProgressTurns?: number;
  lastReason?: string;
  /**
   * Set alongside `lastReason` whenever the runtime stops a Goal at one of the
   * enumerated bounds. `lastReason` stays the human-readable half; this is the
   * half state transitions are allowed to read.
   */
  limitKind?: GoalLimitKind;
}

export interface GoalSnapshotV2 {
  v: typeof GOAL_STATE_VERSION;
  goal: GoalRecord | null;
  activity: GoalActivity;
  clearedGoal?: GoalOrder;
}

export interface GoalOrder {
  goalId: string;
  revision: number;
  updatedAt: number;
}

/**
 * What a session with no reachable Goal runtime looks like.
 *
 * `getGoalRuntimeReady()` rejects when goal persistence is unavailable —
 * permanently, once a malformed transcript record has set a sticky recovery
 * error. For anything that only reads or reduces goal state, the honest
 * answer is "no goal", not a failed request: the caller asked what the goal
 * is, and the answer is nothing.
 */
export function emptyGoalSnapshot(): GoalSnapshotV2 {
  return { v: GOAL_STATE_VERSION, goal: null, activity: 'idle' };
}

/** True while any new model send must carry the runtime's exact turn permit. */
export function goalRequiresExactPermit(snapshot: GoalSnapshotV2): boolean {
  return (
    snapshot.goal !== null &&
    (snapshot.goal.status === 'active' || snapshot.activity === 'running')
  );
}

export type GoalControlRequest =
  | { action: 'create'; objective: string }
  | {
      action: 'replace';
      objective: string;
      expectedGoalId: string;
      expectedRevision: number;
    }
  | {
      action: 'edit';
      objective: string;
      expectedGoalId: string;
      expectedRevision: number;
    }
  | {
      action: 'pause';
      expectedGoalId: string;
      expectedRevision: number;
      /**
       * Why the Goal is being paused, in the user's words rather than the
       * model's. A pause without one clears `lastReason`: a stopped Goal
       * showing the previous turn's verifier rejection reads as the reason
       * it stopped, which it is not.
       */
      reason?: string;
    }
  | {
      action: 'resume';
      expectedGoalId: string;
      expectedRevision: number;
    }
  | {
      action: 'clear';
      expectedGoalId: string;
      expectedRevision: number;
    };

export interface GoalStateResponse {
  snapshot: GoalSnapshotV2;
}

/**
 * Why a Goal is blocked.
 *
 * `authority` and `external` stop immediately on cited user or external
 * evidence. `repeated` (the default) needs the same evidenced blocker on
 * three consecutive turns. `infeasible` also stops immediately: the cited
 * external fact shows the objective cannot be satisfied as written, so no
 * amount of retrying would help -- waiting three turns to say so is the
 * runaway this kind exists to end.
 */
export type GoalBlockerKind =
  | 'authority'
  | 'external'
  | 'repeated'
  | 'infeasible';

export interface GoalTerminalProposal {
  status: 'complete' | 'blocked';
  reason: string;
  evidenceRefs: string[];
  blockerKind?: GoalBlockerKind;
}

export function isRepeatedBlockerProposal(
  proposal: GoalTerminalProposal,
): boolean {
  return (
    proposal.status === 'blocked' &&
    proposal.blockerKind !== 'authority' &&
    proposal.blockerKind !== 'external' &&
    proposal.blockerKind !== 'infeasible'
  );
}

/**
 * Appended to `lastReason` when an `infeasible` blocker is accepted, so the
 * stopped Goal tells the user what to do rather than only what went wrong.
 * The verifier's reason says why the objective cannot hold; this says that
 * resuming as-is will not change that.
 */
export const GOAL_INFEASIBLE_NEXT_STEP =
  'The objective cannot be satisfied as written; edit or replace the Goal with an objective the evidence allows before resuming it.';

export function validateGoalProposalReason(reason: string): string | null {
  if (!reason.trim()) return 'Goal proposal reason must not be empty';
  if ([...reason].length > GOAL_PROPOSAL_REASON_MAX_CHARACTERS) {
    return `Goal proposal reason exceeds ${GOAL_PROPOSAL_REASON_MAX_CHARACTERS} characters`;
  }
  if (
    new TextEncoder().encode(reason).byteLength > GOAL_PROPOSAL_REASON_MAX_BYTES
  ) {
    return `Goal proposal reason exceeds ${GOAL_PROPOSAL_REASON_MAX_BYTES} UTF-8 bytes`;
  }
  return null;
}

/** Upper bound on a pause reason, which a user reads in a card. */
export const GOAL_PAUSE_REASON_MAX_CHARACTERS = 500;

export function validateGoalPauseReason(reason: string): string | null {
  if (!reason.trim()) return 'Goal pause reason must not be empty';
  // The bound is in code points, but UTF-16 length is an upper bound on the
  // code-point count, so a short string is legal without counting at all.
  // Only a candidate that could still be over gets walked, and the walk stops
  // one past the limit -- this route is network-reachable and synchronous on
  // the CLI's event loop, so the work has to scale with the limit rather than
  // with whatever the caller sent.
  if (reason.length > GOAL_PAUSE_REASON_MAX_CHARACTERS) {
    let codePoints = 0;
    for (const _codePoint of reason) {
      if (++codePoints > GOAL_PAUSE_REASON_MAX_CHARACTERS) {
        return `Goal pause reason exceeds ${GOAL_PAUSE_REASON_MAX_CHARACTERS} characters`;
      }
    }
  }
  return null;
}

/**
 * The pause reasons every host shares.
 *
 * They are constants rather than per-host prose so that the same event reads
 * the same way in the TUI card, `/goal`, an ACP client, and a headless
 * `goal_state` event -- and so a test can assert on the event rather than on
 * one host's wording.
 */
export const GOAL_PAUSE_REASON_USER_INTERRUPT =
  'Interrupted by the user. Run /goal resume to continue.';
export const GOAL_PAUSE_REASON_COMMAND = 'Paused with /goal pause.';
export const GOAL_PAUSE_REASON_SESSION_TOKEN_LIMIT =
  'The session token limit was exceeded before the model request. Start a new session or increase sessionTokenLimit in settings.json before resuming the Goal.';
export const GOAL_PAUSE_REASON_STOP_HOOK_CAP =
  'A Stop hook blocked this session too many times in a row. Run /goal resume to continue.';
/**
 * A session that began closing while its Goal turn was in flight. The close
 * can still be abandoned -- a drain timeout or a failed flush releases the
 * gate and the session keeps serving -- so this states what is durably true
 * at the moment of the stop rather than asserting the session is gone.
 */
export const GOAL_PAUSE_REASON_SESSION_DISPOSED =
  'The session started closing before the turn finished. Run /goal resume to continue.';
/**
 * A headless run that ended while its Goal was still going. It is not a
 * failure, and it must not tell the reader to run a slash command in a
 * process that has already exited.
 */
export const GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED =
  'The headless run finished before the Goal did. Resume the Goal in a later run.';
/**
 * A Goal whose autonomous turns stopped producing anything to judge. The
 * next step is the user's: resume to try the same objective again, or edit
 * it into one the model can act on and then resume it -- editing alone
 * leaves a paused Goal paused.
 *
 * Runtime-emitted and headless-reachable, so it names no slash command; and
 * it says "nothing to judge" rather than "no tool results", because
 * `get_goal` and `update_goal` results are recorded but deliberately do not
 * count as progress.
 */
export const GOAL_PAUSE_REASON_NO_PROGRESS =
  'Three Goal turns in a row recorded nothing to judge and no proposal. Resume the Goal to try again, or edit its objective into one the model can act on and then resume it.';

function truncateGoalPauseReason(reason: string): string {
  const codePoints = [...reason];
  return codePoints.length <= GOAL_PAUSE_REASON_MAX_CHARACTERS
    ? reason
    : `${codePoints.slice(0, GOAL_PAUSE_REASON_MAX_CHARACTERS - 1).join('')}\u2026`;
}

/** The pause reason for a Goal turn that failed rather than being stopped. */
export function goalPauseReasonForFailure(message: string): string {
  const detail = message.trim();
  return truncateGoalPauseReason(
    detail
      ? `The Goal turn could not finish: ${detail}. Run /goal resume to continue.`
      : 'The Goal turn could not finish. Run /goal resume to continue.',
  );
}

/**
 * The pause reason for a headless Goal turn that died with an error. Same
 * register as `GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED` -- it names the failure
 * without claiming the run ended cleanly, and without pointing at a slash
 * command in a process that has already exited.
 */
export function goalPauseReasonForHeadlessFailure(message: string): string {
  const detail = message.trim();
  return truncateGoalPauseReason(
    detail
      ? `The headless run stopped: ${detail}. Resume the Goal in a later run.`
      : 'The headless run stopped before the Goal turn finished. Resume the Goal in a later run.',
  );
}

/** The pause reason for a headless run that hit one of its own budgets. */
export function goalPauseReasonForRunBudget(budget: string): string {
  const detail = budget.trim();
  return truncateGoalPauseReason(
    detail
      ? `The headless run stopped at its ${detail} budget. Resume the Goal in a later run.`
      : 'The headless run stopped at a budget. Resume the Goal in a later run.',
  );
}

export type GoalStateCause =
  | 'create'
  | 'replace'
  | 'edit'
  | 'pause'
  | 'resume'
  | 'turn_finished'
  | 'checkpoint'
  | 'verifier_accept'
  | 'verifier_reject'
  | 'complete'
  | 'blocked'
  | 'usage_limited'
  | 'clear'
  | 'migrated';

export interface GoalStateRecordPayloadV2 {
  v: typeof GOAL_STATE_VERSION;
  cause: GoalStateCause;
  snapshot: GoalSnapshotV2;
  checkpointPending?: {
    permit: GoalTurnPermit;
    recordUuid: string;
  };
  blockedAudit?: {
    fingerprint: string;
    count: number;
    turnIds: string[];
  };
}
