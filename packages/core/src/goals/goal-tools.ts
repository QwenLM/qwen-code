/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolDisplayNames, ToolNames } from '../tools/tool-names.js';
import type {
  ToolCallConfirmationDetails,
  ToolInvocation,
  ToolResult,
} from '../tools/tools.js';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import { ApprovalMode } from '../config/config.js';
import { StructuredToolError } from '../tools/priorReadEnforcement.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { promptIdContext } from '../utils/promptIdContext.js';
import {
  GoalConflictError,
  GoalInvalidTransitionError,
} from './goal-reducer.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
} from '../tools/tools.js';
import {
  GOAL_RUNTIME_DISPOSED_MESSAGE,
  GoalPersistenceUnavailableError,
  STALE_GOAL_TURN_MESSAGE,
  type GoalRuntime,
  type GoalWorkerView,
} from './goal-runtime.js';
import { goalTurnContext } from './goal-turn-context.js';
import {
  type GoalBlockerKind,
  type GoalControlRequest,
  GOAL_PROPOSAL_REASON_MAX_CHARACTERS,
  type GoalRecord,
  type GoalSnapshotV2,
  type GoalTerminalProposal,
  type GoalTurnPermit,
  validateGoalProposalReason,
} from './goal-protocol.js';

export interface GoalToolConfig {
  getGoalRuntime(): GoalRuntime;
}

export interface GetGoalToolParams {
  /**
   * @deprecated `get_goal` no longer returns an evidence catalog, so there is
   * nothing for a view to select. Accepted and ignored so a model still
   * following the older contract is not refused.
   */
  view?: 'summary' | 'full';
}

export interface UpdateGoalToolParams {
  status: 'complete' | 'blocked';
  reason: string;
  /**
   * @deprecated The verifier judges a proposal from the tail of the Goal's
   * transcript, not from references the model cites. Accepted and ignored.
   */
  evidenceRefs?: string[];
  blockerKind?: GoalBlockerKind;
}

export type GoalToolResult = ToolResult;

/**
 * Parameters the Goal tools used to take and no longer advertise. A model
 * that learnt the older contract, or that sees its own earlier calls in the
 * conversation, may still send them; they are dropped before the schema is
 * checked, so the call is served rather than refused for an unknown key.
 */
function withoutDeprecatedParams<T extends object>(
  params: T,
  names: readonly string[],
): T {
  // Anything that is not an object is left for the schema check to describe.
  if (typeof params !== 'object' || params === null) return params;
  if (!names.some((name) => name in params)) return params;
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => !names.includes(key)),
  ) as T;
}

type LastGoalSummary = Pick<
  GoalRecord,
  | 'goalId'
  | 'revision'
  | 'status'
  | 'turnCount'
  | 'activeTimeMs'
  | 'tokensUsed'
  | 'tokenBudget'
  | 'turnBudget'
  | 'activeTimeBudgetMs'
  | 'lastReason'
>;

type GetGoalRuntime = Pick<GoalRuntime, 'getGoalForWorker'> & {
  getSnapshotForPermit?: GoalRuntime['getSnapshotForPermit'];
};

type UpdateGoalRuntime = Pick<
  GoalRuntime,
  'getGoalForWorker' | 'recordTerminalProposal'
> & {
  getSnapshotForPermit?: GoalRuntime['getSnapshotForPermit'];
};

class GetGoalInvocation extends BaseToolInvocation<
  GetGoalToolParams,
  GoalToolResult
> {
  constructor(
    params: GetGoalToolParams,
    private readonly runtime: GetGoalRuntime | undefined,
    private readonly permit: GoalTurnPermit | undefined,
    private readonly lastGoal: LastGoalSummary | undefined,
  ) {
    super(params);
  }

  getDescription(): string {
    return 'Read the current goal';
  }

  async execute(signal: AbortSignal): Promise<GoalToolResult> {
    if (!this.runtime || !this.permit) {
      return unpermittedGoalResult(this.lastGoal);
    }

    const view = await workerViewForPermit(this.runtime, this.permit, signal);
    signal.throwIfAborted();
    const snapshot = snapshotForPermit(this.runtime, this.permit);
    if (
      view.goalId !== this.permit.goalId ||
      view.revision !== this.permit.revision
    ) {
      throw staleGoalTurnError();
    }
    const payload = projectWorkerView(view, snapshot);
    return {
      llmContent: JSON.stringify(payload),
      returnDisplay: `Active goal · revision ${view.revision}`,
    };
  }
}

export class GetGoalTool extends BaseDeclarativeTool<
  GetGoalToolParams,
  GoalToolResult
> {
  static readonly Name = ToolNames.GET_GOAL;

  constructor(private readonly config: GoalToolConfig) {
    super(
      GetGoalTool.Name,
      ToolDisplayNames.GET_GOAL,
      'Read the current Goal during a permitted Goal turn: its objective, status, budget figures, and the verifier\'s feedback on the previous proposal when there is any. Outside a Goal turn it returns "active": false with "lastGoal", a summary of the session\'s most recent Goal. It never changes Goal state. Use the result silently; do not mention the retrieval to the user.',
      Kind.Read,
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    );
  }

  // The strip happens in `build`, on the object that then flows through the
  // schema check and into the invocation: the validator repairs values in
  // place (a number where a string is expected, say), and a repair made on
  // a copy would be thrown away. `validateToolParams` strips too, for a
  // caller that only validates; on a stripped object it is a no-op.
  override build(params: GetGoalToolParams) {
    return super.build(withoutDeprecatedParams(params, ['view']));
  }

  override validateToolParams(params: GetGoalToolParams): string | null {
    return super.validateToolParams(withoutDeprecatedParams(params, ['view']));
  }

  protected createInvocation(
    params: GetGoalToolParams,
  ): ToolInvocation<GetGoalToolParams, GoalToolResult> {
    const contextPermit = goalTurnContext.getStore();
    const permit = contextPermit ? structuredClone(contextPermit) : undefined;
    const runtime = permit ? this.config.getGoalRuntime() : undefined;
    return new GetGoalInvocation(
      params,
      runtime,
      permit,
      permit ? undefined : this.lastGoal(),
    );
  }

  /**
   * The session's most recent Goal, for a turn that holds no Goal permit.
   *
   * A Goal that reached a terminal status stops issuing permits, so every
   * later `get_goal` answered `{ active: false }` — the run's own turn count,
   * elapsed time and stop reason became unreadable at exactly the moment
   * someone wanted them. The runtime still holds that record and reading it
   * needs no permit, so report it. Scalars only: the objective and the
   * evidence checkpoint stay behind the permit.
   */
  private lastGoal(): LastGoalSummary | undefined {
    let runtime: GoalRuntime;
    try {
      runtime = this.config.getGoalRuntime();
    } catch {
      // A session with no reachable Goal persistence has no Goal to summarise.
      return undefined;
    }
    if (typeof runtime?.getSnapshot !== 'function') return undefined;
    const goal = runtime.getSnapshot().goal;
    if (!goal) return undefined;
    return {
      goalId: goal.goalId,
      revision: goal.revision,
      status: goal.status,
      turnCount: goal.turnCount,
      activeTimeMs: goal.activeTimeMs,
      tokensUsed: goal.tokensUsed,
      ...(goal.tokenBudget === undefined
        ? {}
        : { tokenBudget: goal.tokenBudget }),
      ...(goal.turnBudget === undefined ? {} : { turnBudget: goal.turnBudget }),
      ...(goal.activeTimeBudgetMs === undefined
        ? {}
        : { activeTimeBudgetMs: goal.activeTimeBudgetMs }),
      ...(goal.lastReason === undefined ? {} : { lastReason: goal.lastReason }),
    };
  }
}

function unpermittedGoalResult(lastGoal: LastGoalSummary | undefined) {
  if (!lastGoal) {
    return {
      llmContent: JSON.stringify({ active: false }),
      returnDisplay: 'No active Goal is available for this turn.',
    };
  }
  return {
    llmContent: JSON.stringify({ active: false, lastGoal }),
    returnDisplay: `No Goal turn is permitted · last Goal ${lastGoal.status} after ${lastGoal.turnCount} ${lastGoal.turnCount === 1 ? 'turn' : 'turns'}`,
  };
}

class UpdateGoalInvocation extends BaseToolInvocation<
  UpdateGoalToolParams,
  GoalToolResult
> {
  constructor(
    params: UpdateGoalToolParams,
    private readonly runtime: UpdateGoalRuntime | undefined,
    private readonly permit: GoalTurnPermit | undefined,
  ) {
    super(params);
  }

  getDescription(): string {
    return `Propose that the Goal is ${this.params.status} for this permitted turn`;
  }

  async execute(signal: AbortSignal): Promise<GoalToolResult> {
    if (!this.runtime || !this.permit) {
      throw new Error('No active Goal is available for this turn');
    }
    const permit = this.permit;

    const view = await workerViewForPermit(this.runtime, permit, signal);
    signal.throwIfAborted();
    snapshotForPermit(this.runtime, permit);
    if (
      view.goalId !== this.permit.goalId ||
      view.revision !== this.permit.revision
    ) {
      throw staleGoalTurnError();
    }
    const proposal: GoalTerminalProposal = {
      status: this.params.status,
      reason: this.params.reason.trim(),
      ...(this.params.blockerKind
        ? { blockerKind: this.params.blockerKind }
        : {}),
    };
    signal.throwIfAborted();
    const receipt = recordTerminalProposalForPermit(
      this.runtime,
      this.permit,
      proposal,
    );
    const snapshot = snapshotForPermit(this.runtime, this.permit);
    const payload = {
      proposalRecorded: receipt.recorded,
      readyForVerification: receipt.readyForVerification,
      goalLifecycleChanged: false,
      nextAction: receipt.readyForVerification
        ? 'End this turn without user-facing text. Do not claim the Goal is complete or blocked. The Goal status card will report the independent verification result.'
        : 'Continue this turn without claiming the Goal is complete or blocked. A repeated-blocker audit requires the same blocker mode and exact same reason text across three consecutive Goal turns, each of which must show the blocker in its own tool results.',
    };
    let returnDisplay: string;
    if (!receipt.recorded) {
      returnDisplay =
        'A Goal proposal is already recorded for this turn; no terminal lifecycle change was committed.';
    } else if (
      receipt.readyForVerification &&
      snapshot.goal?.status === 'active'
    ) {
      returnDisplay =
        'Proposal queued for independent verification at the turn boundary; no terminal lifecycle change was committed.';
    } else if (snapshot.goal?.status === 'paused') {
      returnDisplay =
        'Proposal recorded while the Goal is paused; no terminal lifecycle change was committed.';
    } else {
      returnDisplay =
        'Proposal recorded for blocker audit; it is not yet ready for independent verification and no terminal lifecycle change was committed.';
    }
    return {
      llmContent: JSON.stringify(payload),
      returnDisplay,
      ...(receipt.readyForVerification ? { terminateTurn: true } : {}),
    };
  }
}

export class UpdateGoalTool extends BaseDeclarativeTool<
  UpdateGoalToolParams,
  GoalToolResult
> {
  static readonly Name = ToolNames.UPDATE_GOAL;

  constructor(private readonly config: GoalToolConfig) {
    super(
      UpdateGoalTool.Name,
      ToolDisplayNames.UPDATE_GOAL,
      "Propose that the current Goal is complete or blocked. An independent verifier decides; this tool never changes the Goal's status. The verifier reads only the most recent records of this Goal's transcript (your visible output, tool results, the user's messages), so run the checks that prove every objective condition immediately before calling. If completion depends on content delivered in this turn, emit only what the objective requires first, with no progress or completion commentary. For blocked, set blockerKind: authority (a user or maintainer decision or permission is required), external (an evidenced external resource or capability is unavailable), or infeasible (a tool result, not your own text, shows the objective cannot be satisfied as written: it contradicts itself, names a target that verifiably does not exist, or needs an action no tool can perform; never for difficulty, uncertainty, information you could still obtain, or wanting to ask; the reason must state what was checked and why no in-scope work could satisfy the objective). The verifier may accept those three on the first turn they are proposed; a rejected proposal leaves the Goal running. Omit blockerKind, or set repeated, for the same blocker with the exact same reason text across three consecutive Goal turns, which is only sent to the verifier on the third. Never tell the user the Goal is complete or blocked: when the result reports readyForVerification, end the turn with no further text; otherwise keep working. The Goal status card reports the verdict.",
      Kind.Think,
      {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['complete', 'blocked'] },
          reason: {
            type: 'string',
            minLength: 1,
            maxLength: GOAL_PROPOSAL_REASON_MAX_CHARACTERS,
          },
          blockerKind: {
            type: 'string',
            enum: ['authority', 'external', 'repeated', 'infeasible'],
            description:
              'Which blocker a blocked proposal reports; the tool description says when each applies.',
          },
        },
        required: ['status', 'reason'],
        additionalProperties: false,
      },
    );
  }

  // See GetGoalTool.build for why the strip happens here as well.
  override build(params: UpdateGoalToolParams) {
    return super.build(withoutDeprecatedParams(params, ['evidenceRefs']));
  }

  override validateToolParams(params: UpdateGoalToolParams): string | null {
    return super.validateToolParams(
      withoutDeprecatedParams(params, ['evidenceRefs']),
    );
  }

  protected override validateToolParamValues(
    params: UpdateGoalToolParams,
  ): string | null {
    return validateGoalProposalReason(params.reason);
  }

  protected createInvocation(
    params: UpdateGoalToolParams,
  ): ToolInvocation<UpdateGoalToolParams, GoalToolResult> {
    const contextPermit = goalTurnContext.getStore();
    const permit = contextPermit ? structuredClone(contextPermit) : undefined;
    const runtime = permit ? this.config.getGoalRuntime() : undefined;
    return new UpdateGoalInvocation(params, runtime, permit);
  }
}

function snapshotForPermit(
  runtime: {
    getSnapshotForPermit?: (permit: GoalTurnPermit) => GoalSnapshotV2;
  },
  permit: GoalTurnPermit,
): GoalSnapshotV2 {
  const getSnapshotForPermit: unknown = runtime.getSnapshotForPermit;
  if (typeof getSnapshotForPermit !== 'function') {
    throw staleGoalTurnError();
  }
  try {
    return getSnapshotForPermit.call(runtime, permit);
  } catch (error) {
    throwNormalizedRuntimeError(error);
  }
}

async function workerViewForPermit(
  runtime: Pick<GoalRuntime, 'getGoalForWorker'>,
  permit: GoalTurnPermit,
  signal: AbortSignal,
): Promise<GoalWorkerView> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return await Promise.race([runtime.getGoalForWorker(permit), aborted]);
  } catch (error) {
    return throwNormalizedRuntimeError(error);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function recordTerminalProposalForPermit(
  runtime: Pick<GoalRuntime, 'recordTerminalProposal'>,
  permit: GoalTurnPermit,
  proposal: GoalTerminalProposal,
) {
  try {
    return runtime.recordTerminalProposal(permit, proposal);
  } catch (error) {
    throwNormalizedRuntimeError(error);
  }
}

function throwNormalizedRuntimeError(error: unknown): never {
  if (
    error instanceof Error &&
    (error.message === GOAL_RUNTIME_DISPOSED_MESSAGE ||
      error.message === STALE_GOAL_TURN_MESSAGE)
  ) {
    throw staleGoalTurnError();
  }
  throw error;
}

function staleGoalTurnError(): Error {
  return new Error(STALE_GOAL_TURN_MESSAGE);
}

function projectWorkerView(view: GoalWorkerView, snapshot: GoalSnapshotV2) {
  return {
    active: true,
    snapshot: structuredClone(snapshot),
    ...(view.verifierFeedback
      ? { verifierFeedback: view.verifierFeedback }
      : {}),
  };
}

// ── propose_goal ────────────────────────────────────────────────────────────

/**
 * Upper bound on a proposed objective. The whole text is shown in the
 * approval dialog, so it has to stay readable there; the /goal-draft contract
 * (Outcome / Done when / Must not / Budget / On block / Context) fits in
 * well under this.
 */
export const PROPOSE_GOAL_OBJECTIVE_MAX_CHARACTERS = 1500;

export const formatProposeGoalRecoveryNotStarted = (objective: string) =>
  `The approved Goal was not started because the turn did not finish normally. To start it, run:\n/goal set ${objective}`;

export const formatProposeGoalRecoveryFailed = (objective: string) =>
  `The approved Goal could not be started. Check the Goal status before trying again, or run:\n/goal set ${objective}`;

export interface ProposeGoalToolParams {
  objective: string;
}

/**
 * A Goal the user approved in the `propose_goal` dialog, waiting for the
 * turn that proposed it to end. Setting it mid-turn would leave the rest of
 * that turn without a Goal permit (see `client.ts`, "An active Goal requires
 * an exact turn permit"), so the tool only parks it here and the client
 * applies it at the same boundary a typed `/goal set` takes effect.
 */
export interface PendingGoalProposal {
  objective: string;
  reviewedGoal: Pick<GoalRecord, 'goalId' | 'revision'> | null;
  /** Plan mode revokes approval even after the host takes the proposal. */
  approvalSignal?: AbortSignal;
  /**
   * The `prompt_id` of the turn whose dialog approved it. Only that turn's
   * terminal boundary may set or discard the Goal; unrelated frames leave it
   * parked for its owner. A new real user query clears any stale approval.
   */
  turnKey: string;
}

export interface ProposeGoalToolConfig extends GoalToolConfig {
  getGoalRuntimeReady(): Promise<GoalRuntime>;
  isTrustedFolder(): boolean;
  getApprovalMode(): ApprovalMode;
  hasPendingGoalProposal(): boolean;
  setPendingGoalProposal(proposal: PendingGoalProposal): boolean;
}

type ProposeGoalRuntime = Pick<GoalRuntime, 'getSnapshot' | 'dispatch'>;

export type ApplyPendingGoalProposalResult =
  | { applied: true; goal: GoalRecord }
  | { applied: false; reason: string; kind: 'changed' | 'unavailable' };

/**
 * Sets an approved proposal as the session Goal. Called by the client once
 * the proposing turn has ended; never from inside a turn.
 *
 * Re-reads the snapshot because `/goal` may have changed the session since
 * the dialog: only the reviewed Goal can be replaced, through its expected
 * version, and a reviewed empty session can only create a new Goal.
 */
export async function applyPendingGoalProposal(
  runtime: ProposeGoalRuntime,
  proposal: PendingGoalProposal,
): Promise<ApplyPendingGoalProposalResult> {
  if (proposal.approvalSignal?.aborted) {
    return {
      applied: false,
      kind: 'changed',
      reason:
        'The approved Goal was not started because its approval was revoked. Ask for a new draft when you are ready to start.',
    };
  }
  const objective = proposal.objective.trim();
  const current = runtime.getSnapshot().goal;
  if (current?.status === 'active') {
    return {
      applied: false,
      kind: 'changed',
      reason: `A Goal became active (revision ${current.revision}) before the approved proposal could be set.`,
    };
  }
  if (!matchesReviewedGoal(current, proposal.reviewedGoal)) {
    return {
      applied: false,
      kind: 'changed',
      reason: PROPOSE_GOAL_CHANGED_MESSAGE,
    };
  }
  const request: GoalControlRequest = current
    ? {
        action: 'replace',
        objective,
        expectedGoalId: current.goalId,
        expectedRevision: current.revision,
      }
    : { action: 'create', objective };
  try {
    const response =
      request.action === 'replace'
        ? await runtime.dispatch(request, { refuseIfActive: true })
        : await runtime.dispatch(request);
    const goal = response.snapshot.goal;
    if (!goal) {
      return {
        applied: false,
        kind: 'unavailable',
        reason: 'The Goal runtime accepted the request but reported no Goal.',
      };
    }
    return {
      applied: true,
      goal,
    };
  } catch (error) {
    if (
      error instanceof GoalConflictError ||
      error instanceof GoalInvalidTransitionError
    ) {
      return { applied: false, kind: 'changed', reason: error.message };
    }
    if (error instanceof GoalPersistenceUnavailableError) {
      return { applied: false, kind: 'unavailable', reason: error.message };
    }
    throw error;
  }
}

export const PROPOSE_GOAL_PLAN_MODE_MESSAGE =
  'Keep planning; propose the Goal after the plan is approved.';
export const PROPOSE_GOAL_UNTRUSTED_MESSAGE =
  'Goals can only be set in trusted workspaces. Tell the user to trust the folder with /trust and then run /goal set themselves.';
export const PROPOSE_GOAL_UNAVAILABLE_MESSAGE =
  'This session cannot persist Goals, so no Goal can be set.';
/**
 * Defensive only: the model never reads this.
 *
 * A declined dialog resolves as `ToolConfirmationOutcome.Cancel`, and the
 * scheduler settles the call as `cancelled` without ever entering
 * `execute()` -- the model is handed the scheduler's own cancellation
 * notice instead. The guard below stays for a host that one day runs
 * `execute()` after a cancelled confirmation, so a decline can never fall
 * through to parking an approval. It is deliberately not exported: nothing
 * outside this module should assert on a string the model cannot receive.
 * What actually keeps the model from re-proposing is the tool description.
 */
const PROPOSE_GOAL_NOT_APPROVED_MESSAGE =
  'The Goal was not set: the user did not approve it. Do not ask why and do not propose the same or a reworded objective again.';
export const PROPOSE_GOAL_NO_TURN_MESSAGE =
  'The Goal was not set: this call is not attributable to a turn, so its approval could not be bound to one. Hand the user a `/goal set <objective>` line instead.';
export const PROPOSE_GOAL_PENDING_MESSAGE =
  'Another approved Goal proposal is already waiting for this turn to end. Do not propose another one.';
const PROPOSE_GOAL_CHANGED_MESSAGE =
  'The Goal changed after the proposal was shown. The approved proposal was not applied; review the current Goal before proposing again.';

function matchesReviewedGoal(
  current: GoalRecord | null,
  reviewed: PendingGoalProposal['reviewedGoal'] | undefined,
): boolean {
  if (reviewed === undefined) return false;
  return reviewed === null
    ? current === null
    : current?.goalId === reviewed.goalId &&
        current.revision === reviewed.revision;
}

function activeGoalMessage(revision: number): string {
  return `A Goal is already active (revision ${revision}); this tool does not replace a running Goal. Hand the user a \`/goal edit <objective>\` line to tighten it or a \`/goal set <objective>\` line to replace it, and stop.`;
}

function proposalPromptHeadline(current: GoalRecord | null): string {
  if (current) {
    return `Replace the ${current.status} Goal and start working toward this objective? Approving sets it like /goal set: after each turn an independent verifier checks the transcript, and Qwen Code keeps working until it is met.`;
  }
  return 'Set this as the session Goal? Approving sets it like /goal set: after each turn an independent verifier checks the transcript, and Qwen Code keeps working until it is met.';
}

class ProposeGoalInvocation extends BaseToolInvocation<
  ProposeGoalToolParams,
  GoalToolResult
> {
  private approved = false;
  private reviewedGoal: PendingGoalProposal['reviewedGoal'] | undefined;

  constructor(
    params: ProposeGoalToolParams,
    private readonly config: ProposeGoalToolConfig,
  ) {
    super(params);
  }

  /**
   * Include the objective for hosts that show only the tool description.
   */
  getDescription(): string {
    return `Propose Goal: ${this.params.objective.trim()}`;
  }

  /**
   * Consent for an autonomous loop cannot come from a permission rule or an
   * approval mode: a bare `propose_goal` allow rule, YOLO, or AUTO_EDIT
   * (which auto-approves `info` confirmations) would otherwise set a Goal
   * the user never saw.
   */
  override requiresUserInteraction(): boolean {
    return true;
  }

  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  /**
   * Why a proposal cannot be shown right now, or `undefined` when it can.
   * Checked before the dialog so the user is never asked to approve a Goal
   * that could not be set, and again in `execute()` because `/goal` can
   * change the session while the dialog is open.
   */
  private async blocker(): Promise<
    { message: string; type: ToolErrorType } | undefined
  > {
    if (this.config.getApprovalMode() === ApprovalMode.PLAN) {
      return {
        message: PROPOSE_GOAL_PLAN_MODE_MESSAGE,
        type: ToolErrorType.EXECUTION_DENIED,
      };
    }
    if (!this.config.isTrustedFolder()) {
      return {
        message: PROPOSE_GOAL_UNTRUSTED_MESSAGE,
        type: ToolErrorType.EXECUTION_DENIED,
      };
    }
    if (this.config.hasPendingGoalProposal()) {
      return {
        message: PROPOSE_GOAL_PENDING_MESSAGE,
        type: ToolErrorType.EXECUTION_DENIED,
      };
    }
    let runtime: ProposeGoalRuntime;
    try {
      runtime = await this.config.getGoalRuntimeReady();
    } catch {
      return {
        message: PROPOSE_GOAL_UNAVAILABLE_MESSAGE,
        type: ToolErrorType.EXECUTION_DENIED,
      };
    }
    const current = runtime.getSnapshot().goal;
    if (current?.status === 'active') {
      return {
        message: activeGoalMessage(current.revision),
        type: ToolErrorType.EXECUTION_DENIED,
      };
    }
    return undefined;
  }

  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const blocker = await this.blocker();
    if (blocker) {
      throw new StructuredToolError(blocker.message, blocker.type);
    }
    const current = this.config.getGoalRuntime().getSnapshot().goal;
    this.reviewedGoal = current
      ? { goalId: current.goalId, revision: current.revision }
      : null;
    return {
      type: 'info',
      title: 'Set this as the session Goal?',
      prompt: `${proposalPromptHeadline(current)}\n\n${this.params.objective.trim()}`,
      renderPromptAsPlainText: true,
      hideAlwaysAllow: true,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        this.approved = outcome !== ToolConfirmationOutcome.Cancel;
      },
    };
  }

  async execute(_signal: AbortSignal): Promise<GoalToolResult> {
    if (!this.approved) {
      return this.errorResult(
        PROPOSE_GOAL_NOT_APPROVED_MESSAGE,
        ToolErrorType.EXECUTION_DENIED,
      );
    }
    const blocker = await this.blocker();
    if (blocker) return this.errorResult(blocker.message, blocker.type);

    const objective = this.params.objective.trim();
    const current = this.config.getGoalRuntime().getSnapshot().goal;
    if (
      this.reviewedGoal === undefined ||
      !matchesReviewedGoal(current, this.reviewedGoal)
    ) {
      return this.errorResult(
        PROPOSE_GOAL_CHANGED_MESSAGE,
        ToolErrorType.EXECUTION_DENIED,
      );
    }
    // Parked, not dispatched: the client sets it when this turn ends. Doing
    // it here would strip the rest of the turn of its Goal permit. The
    // approval is bound to this turn's prompt id so no other frame can
    // apply it.
    const turnKey = promptIdContext.getStore();
    if (!turnKey) {
      return this.errorResult(
        PROPOSE_GOAL_NO_TURN_MESSAGE,
        ToolErrorType.EXECUTION_DENIED,
      );
    }
    if (
      !this.config.setPendingGoalProposal({
        objective,
        turnKey,
        reviewedGoal: this.reviewedGoal,
      })
    ) {
      return this.errorResult(
        PROPOSE_GOAL_PENDING_MESSAGE,
        ToolErrorType.EXECUTION_DENIED,
      );
    }
    const payload = {
      approved: true,
      objective,
      ...(current ? { replacesGoalId: current.goalId } : {}),
      next: 'The user approved the Goal. It is set the moment this turn ends: reply with one sentence acknowledging it and stop. Do not call more tools and do not begin the objective; the Goal runtime starts the first Goal turn on its own.',
    };
    return {
      llmContent: JSON.stringify(payload),
      returnDisplay: `Goal approved · ${capDisplay(objective)}`,
    };
  }

  private errorResult(message: string, type: ToolErrorType): GoalToolResult {
    return {
      llmContent: message,
      returnDisplay: message,
      error: { message, type },
    };
  }
}

function capDisplay(objective: string): string {
  const firstLine = objective.split('\n')[0] ?? objective;
  return firstLine.length > 96 ? `${firstLine.slice(0, 95)}…` : firstLine;
}

export class ProposeGoalTool extends BaseDeclarativeTool<
  ProposeGoalToolParams,
  GoalToolResult
> {
  static readonly Name = ToolNames.PROPOSE_GOAL;

  constructor(private readonly config: ProposeGoalToolConfig) {
    super(
      ProposeGoalTool.Name,
      ToolDisplayNames.PROPOSE_GOAL,
      `Propose a session Goal. The user approves or declines it in a dialog that no permission rule or approval mode skips, and only approval sets it. Propose only when the user asked for an outcome with a verifiable end state that spans several turns, or /goal-draft produced an objective; never to widen their request. If a Goal is active this tool refuses: give the user a \`/goal edit …\` or \`/goal set …\` line instead. A stopped Goal is replaced on approval. If the user declines you are not told why: do not ask, and do not propose the same or a reworded objective again. Write the objective on one line, at most ${PROPOSE_GOAL_OBJECTIVE_MAX_CHARACTERS} characters, so the verifier can judge it from the transcript alone: one outcome; numbered binary "Done when" checks that name a command and ask to paste its output; what must not change; a budget; what to do when blocked. After approval, acknowledge in one sentence and stop with no further tool calls; the Goal starts on its own when the turn ends. Not available in plan mode.`,
      Kind.Other,
      {
        type: 'object',
        properties: {
          objective: {
            type: 'string',
            minLength: 1,
            maxLength: PROPOSE_GOAL_OBJECTIVE_MAX_CHARACTERS,
            description: `The objective, on one line, at most ${PROPOSE_GOAL_OBJECTIVE_MAX_CHARACTERS} characters; the user reads all of it in the approval dialog.`,
          },
        },
        required: ['objective'],
        additionalProperties: false,
      },
    );
  }

  protected override validateToolParamValues(
    params: ProposeGoalToolParams,
  ): string | null {
    if (typeof params.objective !== 'string' || !params.objective.trim()) {
      return 'objective must be a non-empty string.';
    }
    if (params.objective.length > PROPOSE_GOAL_OBJECTIVE_MAX_CHARACTERS) {
      return `objective must be at most ${PROPOSE_GOAL_OBJECTIVE_MAX_CHARACTERS} characters.`;
    }
    if (/[\r\n]/.test(params.objective)) {
      return 'objective must be written on one line.';
    }
    return null;
  }

  protected createInvocation(
    params: ProposeGoalToolParams,
  ): ToolInvocation<ProposeGoalToolParams, GoalToolResult> {
    return new ProposeGoalInvocation(params, this.config);
  }
}
