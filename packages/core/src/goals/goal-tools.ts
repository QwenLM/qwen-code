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
   * `summary` (default) keeps the payload small on every read: checkpoint
   * claims collapse to a count (their previews are already catalog entries),
   * and entries from earlier turns carry previews capped at
   * SUMMARY_PREVIEW_BYTE_LIMIT. `full` returns the whole catalog and the
   * checkpoint verbatim. Entry uuids are identical in both views.
   */
  view?: 'summary' | 'full';
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
  | 'tokenBudget'
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

  constructor(private readonly config: GoalToolConfig) {
    super(
      GetGoalTool.Name,
      ToolDisplayNames.GET_GOAL,
      `Read the current Goal identity, objective, evidence cursor, and bounded evidence-reference catalog for this permitted Goal turn. The default "summary" view keeps every read small: checkpoint claims are reported as a count (each claim is already an evidenceCatalog entry with its own preview), entries from this turn and checkpoint entries keep full previews, and entries from earlier turns carry previews shortened to ${SUMMARY_PREVIEW_BYTE_LIMIT} bytes. Every entry uuid is present in both views and is valid for update_goal; request view "full" only when a shortened preview is not enough to decide what to cite. Outside a permitted Goal turn it reports "active": false together with "lastGoal", a scalar summary (goalId, revision, status, turnCount, activeTimeMs, tokensUsed, plus tokenBudget and lastReason when recorded) of the session's most recent Goal, so a Goal that has already stopped can still be inspected. It never returns uncited transcript history or changes Goal state. Use the result silently; do not narrate or acknowledge the retrieval to the user.`,
      Kind.Read,
      {
        type: 'object',
        properties: {
          view: {
            type: 'string',
            enum: ['summary', 'full'],
            description: `summary (default): checkpoint claims as a count, full previews only for this turn and checkpoint entries, ${SUMMARY_PREVIEW_BYTE_LIMIT}-byte previews for earlier turns. full: the whole catalog and checkpoint verbatim. Uuids are identical in both.`,
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
      ...(goal.tokenBudget === undefined
        ? {}
        : { tokenBudget: goal.tokenBudget }),
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
    let autoCitedCurrentDeliveredOutput: string[] = [];
    const evidenceEntries = view.evidenceCatalog?.entries;
    if (evidenceEntries) {
      const normalizedEvidenceRefs = this.params.evidenceRefs.map((reference) =>
        reference.trim(),
      );
      const validEvidenceRefs = new Set(
        evidenceEntries.map((entry) => entry.uuid),
      );
      const invalidEvidenceRefs = normalizedEvidenceRefs.filter(
        (reference) => !validEvidenceRefs.has(reference),
      );
      if (invalidEvidenceRefs.length > 0) {
        const error =
          'evidenceRefs must use values from the latest get_goal evidenceCatalog.entries[].uuid; call get_goal and retry. Do not use goalId, turnId, or lineageTurnIds.';
        return {
          llmContent: JSON.stringify({
            proposalRecorded: false,
            readyForVerification: false,
            goalLifecycleChanged: false,
            invalidEvidenceRefs,
            error,
          }),
          returnDisplay:
            'Goal proposal was not recorded because its evidence is not current. Read the current Goal and retry.',
        };
      }
      const citedEvidenceRefs = new Set(normalizedEvidenceRefs);
      // The verifier judges a completion against this turn's delivered output,
      // so it has to be cited. Asking the model to cite it cannot converge:
      // assistant output is `delivered_output` stamped with this same turn, so
      // every attempt to comply — reading the catalog, then calling back —
      // emits text that becomes another uncited entry, and the required set
      // grows by one per retry. Refusing produced runs that proposed
      // completion until a human paused them.
      //
      // Nothing about the list needs the model's judgment: it is exactly the
      // entries computed here. Fold them in instead of demanding they be
      // repeated back. Both sets are drawn from the same catalog and are
      // disjoint by construction, so the union cannot exceed
      // GOAL_EVIDENCE_REFERENCE_LIMIT, which is that catalog's own entry cap.
      autoCitedCurrentDeliveredOutput =
        this.params.status === 'complete'
          ? evidenceEntries
              .filter(
                (entry) =>
                  entry.proofKind === 'delivered_output' &&
                  entry.turnId === permit.turnId &&
                  !citedEvidenceRefs.has(entry.uuid),
              )
              .map((entry) => entry.uuid)
          : [];
    }
    const proposal: GoalTerminalProposal = {
      status: this.params.status,
      reason: this.params.reason.trim(),
      evidenceRefs: [
        ...this.params.evidenceRefs.map((reference) => reference.trim()),
        ...autoCitedCurrentDeliveredOutput,
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
      // Reported so the proposal the verifier sees is not a surprise, and so a
      // model that wants to cite this turn's output explicitly can see it was
      // already covered rather than calling back to add it.
      ...(autoCitedCurrentDeliveredOutput.length > 0
        ? { autoCitedCurrentDeliveredOutput }
        : {}),
      nextAction: receipt.readyForVerification
        ? 'End this turn without user-facing text. Do not claim the Goal is complete or blocked. The Goal status card will report the independent verification result.'
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
      'Propose that the current Goal is complete or blocked. Before calling, call get_goal in the current turn and cite only values from evidenceCatalog.entries[].uuid, never goalId, turnId, or lineageTurnIds. If completion depends on user-facing content delivered in the current turn, emit only the content required by the objective, then call get_goal, wait for its result, and call update_goal in a later model step with the returned delivered_output UUID. Do not add progress or completion commentary when the objective requires an exact output format. For blocked proposals, use authority when a user or maintainer decision or permission is required, external when an unavailable external resource or capability is evidenced, repeated for the same evidenced blocker with the exact same reason text across three consecutive Goal turns, and infeasible when a cited external_fact (a tool result, not your own text) shows the objective cannot be satisfied as written -- it contradicts itself, names a target that verifiably does not exist, or needs an action no tool can perform; infeasible is not for difficulty, uncertainty, information you could still obtain, or wanting to ask, and its reason must state what was checked and why no in-scope work could satisfy the objective. Omitting blockerKind follows the repeated-blocker audit. Core records at most one proposal for the exact permitted turn and queues eligible proposals for independent verification. This tool never changes the Goal lifecycle or claims a terminal result. Do not tell the user the Goal is complete or blocked. If this tool reports readyForVerification, end the turn without additional user-facing text; otherwise continue the turn without claiming a terminal result. The Goal status card reports the independent verification result.',
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
              'Exact values from the latest get_goal evidenceCatalog.entries[].uuid.',
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
  | { applied: false; reason: string };

/**
 * Sets an approved proposal as the session Goal. Called by the client once
 * the proposing turn has ended; never from inside a turn.
 *
 * Re-reads the snapshot because `/goal` may have changed the session since
 * the dialog: an active Goal is never replaced (someone is already running
 * it), a stopped one is replaced through its expected version, and no Goal
 * creates.
 */
export async function applyPendingGoalProposal(
  runtime: ProposeGoalRuntime,
  proposal: PendingGoalProposal,
): Promise<ApplyPendingGoalProposalResult> {
  const objective = proposal.objective.trim();
  const current = runtime.getSnapshot().goal;
  if (current?.status === 'active') {
    return {
      applied: false,
      reason: `A Goal became active (revision ${current.revision}) before the approved proposal could be set.`,
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
      error instanceof GoalInvalidTransitionError ||
      error instanceof GoalPersistenceUnavailableError
    ) {
      return { applied: false, reason: error.message };
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
export const PROPOSE_GOAL_NOT_APPROVED_MESSAGE =
  'The Goal was not set: the user did not approve it. Do not ask why and do not propose the same or a reworded objective again.';
export const PROPOSE_GOAL_NO_TURN_MESSAGE =
  'The Goal was not set: this call is not attributable to a turn, so its approval could not be bound to one. Hand the user a `/goal set <objective>` line instead.';
export const PROPOSE_GOAL_PENDING_MESSAGE =
  'Another approved Goal proposal is already waiting for this turn to end. Do not propose another one.';

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

  constructor(
    params: ProposeGoalToolParams,
    private readonly config: ProposeGoalToolConfig,
  ) {
    super(params);
  }

  /**
   * The description is the one piece of the confirmation every host shows
   * (the Web Shell does not forward an `info` prompt), so the objective has
   * to be in it.
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
    return {
      type: 'info',
      title: 'Set this as the session Goal?',
      prompt: `${proposalPromptHeadline(current)}\n\n${this.params.objective.trim()}`,
      renderPromptAsPlainText: true,
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
    if (!this.config.setPendingGoalProposal({ objective, turnKey })) {
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
            description: `The objective to propose, written so the Goal verifier can judge it from the transcript (e.g. "Outcome: … Done when: 1) npm test exits 0 (paste the summary line) … Must not: … Budget: stop as blocked after 20 turns. On block: …"). At most ${PROPOSE_GOAL_OBJECTIVE_MAX_CHARACTERS} characters; the user reads all of it in the approval dialog.`,
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
    return null;
  }

  protected createInvocation(
    params: ProposeGoalToolParams,
  ): ToolInvocation<ProposeGoalToolParams, GoalToolResult> {
    return new ProposeGoalInvocation(params, this.config);
  }
}
