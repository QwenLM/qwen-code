/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolDisplayNames, ToolNames } from '../tools/tool-names.js';
import type { ToolInvocation, ToolResult } from '../tools/tools.js';
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
  STALE_GOAL_TURN_MESSAGE,
  type GoalRuntime,
  type GoalWorkerView,
} from './goal-runtime.js';
import { goalTurnContext } from './goal-turn-context.js';
import {
  type GoalBlockerKind,
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
