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
  capPreviewBytes,
  GOAL_EVIDENCE_REFERENCE_LIMIT,
} from './goal-evidence.js';
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
  goalCheckpointHealthVisible,
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
  view?: 'summary' | 'full' | 'evidence';
  snapshotId?: string;
  cursor?: string;
  reference?: string;
  maxBytes?: number;
}

/**
 * Preview bytes an earlier-turn entry keeps in the summary view. Enough to
 * recognise what a record is ("12 tests passed", "wrote src/x.ts") without
 * re-sending the 240-byte preview on every read of a Goal that has been
 * running for a while -- one call used to cost the whole bounded catalog.
 */
const SUMMARY_PREVIEW_BYTE_LIMIT = 80;

export interface UpdateGoalToolParams {
  status: 'complete' | 'blocked';
  reason: string;
  evidenceRefs: string[];
  blockerKind?: GoalBlockerKind;
}

export type GoalToolResult = ToolResult;

type LastGoalSummary = Pick<
  GoalRecord,
  | 'goalId'
  | 'revision'
  | 'status'
  | 'turnCount'
  | 'activeTimeMs'
  | 'tokensUsed'
  | 'verificationUsageIncomplete'
  | 'tokenBudget'
  | 'turnBudget'
  | 'activeTimeBudgetMs'
  | 'checkpointStalls'
  | 'lastCheckpointFailure'
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

    const view = await workerViewForPermit(
      this.runtime,
      this.permit,
      signal,
      this.params,
    );
    signal.throwIfAborted();
    const snapshot = snapshotForPermit(this.runtime, this.permit);
    if (
      view.goalId !== this.permit.goalId ||
      view.revision !== this.permit.revision
    ) {
      throw staleGoalTurnError();
    }
    const payload = projectWorkerView(
      view,
      snapshot,
      this.permit,
      this.params.view ?? 'summary',
    );
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

  override get maxOutputChars(): number {
    // Pages and slices are bounded here; generic truncation would corrupt
    // their JSON cursors and completeness fields.
    return Number.POSITIVE_INFINITY;
  }

  constructor(private readonly config: GoalToolConfig) {
    super(
      GetGoalTool.Name,
      ToolDisplayNames.GET_GOAL,
      `Read the current Goal and one bounded page of its evidence directory. summary is the default; full keeps longer previews. Use snapshotId and nextCursor from a page to read older pages in the same frozen snapshot. Use reference (a raw record UUID), plus snapshotId and cursor for subsequent slices, to read original evidence. Check complete and sourceComplete: a preview or partial slice is not full proof. Refresh without snapshotId for a newer snapshot. Raw UUIDs remain valid throughout this Goal revision even after new tools run or entries leave the current page. Outside a permitted turn returns active:false and lastGoal. Use the result silently.`,
      Kind.Read,
      {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: ['summary', 'full', 'evidence'],
            description:
              'summary: current Goal and evidence page; full: full previews; evidence: page or original slice.',
          },
          snapshotId: {
            type: 'string',
            description: 'Snapshot ID returned with the evidence page.',
          },
          cursor: {
            type: 'string',
            description:
              'nextCursor from the same snapshot page or original slice.',
          },
          reference: {
            type: 'string',
            description: 'Read the original for this legal raw UUID.',
          },
          maxBytes: {
            type: 'integer',
            minimum: 4,
            maximum: 24000,
            description: 'Maximum UTF-8 bytes of one original slice.',
          },
        },
        additionalProperties: false,
      },
    );
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
      ...(goal.verificationUsageIncomplete
        ? { verificationUsageIncomplete: true as const }
        : {}),
      ...(goal.tokenBudget === undefined
        ? {}
        : { tokenBudget: goal.tokenBudget }),
      ...(goal.turnBudget === undefined ? {} : { turnBudget: goal.turnBudget }),
      ...(goal.activeTimeBudgetMs === undefined
        ? {}
        : { activeTimeBudgetMs: goal.activeTimeBudgetMs }),
      // A Goal the stall breaker stopped names the kind of failure in
      // `lastReason`; these two say how often and what exactly it was. They
      // follow the visibility rule every rendered card uses, so a Goal that
      // completed cleanly is not reported with a stale failure.
      ...(goalCheckpointHealthVisible(goal)
        ? {
            ...(goal.checkpointStalls
              ? { checkpointStalls: goal.checkpointStalls }
              : {}),
            ...(goal.lastCheckpointFailure === undefined
              ? {}
              : { lastCheckpointFailure: goal.lastCheckpointFailure }),
          }
        : {}),
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
    const invalidEvidenceRefs = this.params.evidenceRefs.filter(
      (reference) =>
        reference === permit.goalId ||
        reference === permit.turnId ||
        view.evidenceCatalog?.lineageTurnIds.includes(reference),
    );
    if (invalidEvidenceRefs.length) {
      return {
        llmContent: JSON.stringify({
          proposalRecorded: false,
          readyForVerification: false,
          goalLifecycleChanged: false,
          invalidEvidenceRefs,
          error:
            'Cite raw evidence UUIDs, not goalId, turnId, or lineageTurnIds.',
        }),
        returnDisplay:
          'Goal proposal was not recorded because its evidence references identify a Goal or turn instead of evidence.',
      };
    }
    const proposal: GoalTerminalProposal = {
      status: this.params.status,
      reason: this.params.reason.trim(),
      evidenceRefs: [
        ...this.params.evidenceRefs.map((reference) => reference.trim()),
      ],
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
        ? 'End this turn. Do not claim the Goal is complete or blocked before independent verification. The Goal status card will report the result.'
        : 'Continue this turn without claiming the Goal is complete or blocked. A repeated-blocker audit requires the same blocker mode and exact same reason text across three consecutive Goal turns, with current evidence cited on each turn.',
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
      'Propose that the current Goal is complete or blocked. Use get_goal to discover and read legal raw UUIDs from any page in this Goal revision; never cite goalId, turnId, or lineageTurnIds. If completion depends on user-facing content, deliver exactly the required content before calling update_goal; the verifier automatically receives all current-turn delivery. Do not add progress or completion commentary when the objective requires an exact output format. For blocked proposals, use authority when a user or maintainer decision or permission is required, external when an unavailable external resource or capability is evidenced, repeated for the same evidenced blocker with the exact same reason text across three consecutive Goal turns, and infeasible when a cited external_fact (a tool result, not your own text) shows the objective cannot be satisfied as written -- it contradicts itself, names a target that verifiably does not exist, or needs an action no tool can perform; infeasible is not for difficulty, uncertainty, information you could still obtain, or wanting to ask, and its reason must state what was checked and why no in-scope work could satisfy the objective. Omitting blockerKind follows the repeated-blocker audit. Core records at most one proposal for the exact permitted turn and queues eligible proposals for independent verification. This tool never changes the Goal lifecycle or claims a terminal result. Do not tell the user the Goal is complete or blocked. If this tool reports readyForVerification, the turn ends for independent verification; deliver any explicitly required final content before this call. Raw references stay valid across directory pages and later tools; the runtime automatically includes all current delivered output and subsequent actions in independent verification. Otherwise continue the turn without claiming a terminal result. The Goal status card reports the independent verification result.',
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
          evidenceRefs: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            maxItems: GOAL_EVIDENCE_REFERENCE_LIMIT,
            description:
              'Exact values from get_goal evidenceCatalog.entries[].uuid (including earlier pages).',
            items: {
              type: 'string',
              minLength: 1,
              description:
                'A transcript record uuid from evidenceCatalog.entries, not a turnId or lineageTurnId.',
            },
          },
          blockerKind: {
            type: 'string',
            enum: ['authority', 'external', 'repeated', 'infeasible'],
            description:
              'authority: a user or maintainer decision or permission is required; external: an evidenced external resource or capability is unavailable; repeated: the same evidenced blocker with the exact same reason text across three consecutive Goal turns; infeasible: a cited external_fact shows the objective cannot be satisfied as written (self-contradictory, names a target that verifiably does not exist, or needs an action no tool can perform) -- not difficulty, uncertainty, or obtainable information. Omission uses the repeated-blocker audit.',
          },
        },
        required: ['status', 'reason', 'evidenceRefs'],
        additionalProperties: false,
      },
    );
  }

  protected override validateToolParamValues(
    params: UpdateGoalToolParams,
  ): string | null {
    const reasonError = validateGoalProposalReason(params.reason);
    if (reasonError) return reasonError;
    if (
      params.evidenceRefs.length === 0 ||
      params.evidenceRefs.some((reference) => !reference.trim())
    ) {
      return 'evidenceRefs must contain non-empty stable evidence references';
    }
    const normalizedReferences = params.evidenceRefs.map((reference) =>
      reference.trim(),
    );
    if (new Set(normalizedReferences).size !== normalizedReferences.length) {
      return 'evidenceRefs must contain unique stable evidence references';
    }
    return null;
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
  query?: GetGoalToolParams,
): Promise<GoalWorkerView> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return await Promise.race([
      runtime.getGoalForWorker(permit, query),
      aborted,
    ]);
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

function projectWorkerView(
  view: GoalWorkerView,
  snapshot: GoalSnapshotV2,
  permit: GoalTurnPermit,
  detail: NonNullable<GetGoalToolParams['view']>,
) {
  const full = detail === 'full';
  return {
    active: true,
    view: detail,
    snapshot: full ? structuredClone(snapshot) : summarizeSnapshot(snapshot),
    ...(view.evidenceCatalog
      ? {
          evidenceCatalog: full
            ? structuredClone(view.evidenceCatalog)
            : summarizeCatalog(view.evidenceCatalog, permit),
        }
      : {}),
    ...(view.evidence ? { evidence: structuredClone(view.evidence) } : {}),
    ...(view.verifierFeedback
      ? { verifierFeedback: view.verifierFeedback }
      : {}),
  };
}

/**
 * The checkpoint's claims are the largest thing a Goal record carries -- up to
 * 32 claims of up to 2,000 characters -- and every one of them is already in
 * the catalog as a `goal_checkpoint` entry with a preview and the same uuid.
 * The summary keeps the checkpoint's identity and drops the duplicate text.
 */
function summarizeSnapshot(snapshot: GoalSnapshotV2) {
  const goal = snapshot.goal;
  const checkpoint = goal?.evidenceCheckpoint;
  if (!goal || !checkpoint) return structuredClone(snapshot);
  // Collapse the claims to their count before cloning, not after: the claims
  // are the bulk of a checkpoint and none of them survives the summary.
  const { claims, ...checkpointRest } = checkpoint;
  return structuredClone({
    ...snapshot,
    goal: {
      ...goal,
      evidenceCheckpoint: { ...checkpointRest, claimCount: claims.length },
    },
  });
}

function summarizeCatalog(
  catalog: NonNullable<GoalWorkerView['evidenceCatalog']>,
  permit: GoalTurnPermit,
) {
  let shortenedPreviews = 0;
  const entries = catalog.entries.map((entry) => {
    // Checkpoint claims are the compacted proof of everything before the
    // window, and this turn's entries are the ones a proposal cites next; both
    // keep their full preview. Earlier turns only need to be recognisable.
    if (
      entry.provenance === 'goal_checkpoint' ||
      entry.turnId === permit.turnId
    ) {
      return { ...entry };
    }
    const preview = capPreviewBytes(entry.preview, SUMMARY_PREVIEW_BYTE_LIMIT);
    if (preview !== entry.preview) shortenedPreviews += 1;
    return { ...entry, preview };
  });
  // Clone only what survives the summary; the entries above are rebuilt from
  // the originals, so cloning them first would allocate and drop the copy.
  const { entries: _entries, ...catalogRest } = catalog;
  return {
    ...structuredClone(catalogRest),
    entries,
    ...(shortenedPreviews > 0 ? { shortenedPreviews } : {}),
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
      `Propose a session Goal for the user to approve. The user sees the objective in an approval dialog and decides; only their approval sets the Goal. This tool never sets one on its own, and no permission rule or approval mode skips the dialog. Propose only when the user asked for an outcome with a verifiable end state that spans multiple turns ("make the tests pass", "migrate every call site", or after /goal-draft produced an objective), and never to widen scope: the objective must follow from their request. Write the objective so an independent verifier can judge it from transcript evidence alone: one outcome; numbered binary "Done when" checks that name a command and ask to paste its output; what must not change; a budget; what to do when blocked. At most ${PROPOSE_GOAL_OBJECTIVE_MAX_CHARACTERS} characters, on one line. One Goal is active at a time: if a Goal is active this tool refuses and you must hand the user a \`/goal edit …\` or \`/goal set …\` line instead; a stopped Goal (paused, blocked, complete, usage-limited) is replaced on approval. If the user declines you will not be told why: do not ask about it and do not propose the same or a reworded objective again. After approval the Goal is set the moment the current turn ends: acknowledge it in one sentence and stop, without further tool calls; the Goal runtime starts the first Goal turn on its own. Unavailable in plan mode, in subagents, and in headless runs.`,
      Kind.Other,
      {
        type: 'object',
        properties: {
          objective: {
            type: 'string',
            minLength: 1,
            maxLength: PROPOSE_GOAL_OBJECTIVE_MAX_CHARACTERS,
            description: `The objective to propose, written so the Goal verifier can judge it from the transcript (e.g. "Outcome: … Done when: 1) npm test exits 0 (paste the summary line) … Must not: … Budget: as model guidance, stop as blocked after 20 turns. On block: …"). At most ${PROPOSE_GOAL_OBJECTIVE_MAX_CHARACTERS} characters; the user reads all of it in the approval dialog.`,
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
