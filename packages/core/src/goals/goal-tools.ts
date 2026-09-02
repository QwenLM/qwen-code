/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolDisplayNames, ToolNames } from '../tools/tool-names.js';
import type { ToolInvocation, ToolResult } from '../tools/tools.js';
import { GOAL_EVIDENCE_REFERENCE_LIMIT } from './goal-evidence.js';
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
  GOAL_PROPOSAL_REASON_MAX_CHARACTERS,
  type GoalSnapshotV2,
  type GoalTerminalProposal,
  type GoalTurnPermit,
  validateGoalProposalReason,
} from './goal-protocol.js';

export interface GoalToolConfig {
  getGoalRuntime(): GoalRuntime;
}

export type GetGoalToolParams = Record<string, never>;

export interface UpdateGoalToolParams {
  status: 'complete' | 'blocked';
  reason: string;
  evidenceRefs: string[];
  blockerKind?: 'authority' | 'external' | 'repeated';
}

export interface GoalToolResult extends ToolResult {
  terminateTurn?: boolean;
}

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
  ) {
    super(params);
  }

  getDescription(): string {
    return 'Read the current goal';
  }

  async execute(signal: AbortSignal): Promise<GoalToolResult> {
    if (!this.runtime || !this.permit) {
      const message = 'No active Goal is available for this turn.';
      return {
        llmContent: JSON.stringify({ active: false }),
        returnDisplay: message,
      };
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
      'Read the current Goal identity, objective, evidence cursor, and bounded evidence-reference catalog for this permitted Goal turn. It never returns uncited transcript history or changes Goal state. Use the result silently; do not narrate or acknowledge the retrieval to the user.',
      Kind.Read,
      {
        type: 'object',
        properties: {},
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
    return new GetGoalInvocation(params, runtime, permit);
  }
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
      if (
        this.params.status === 'complete' &&
        view.evidenceCatalog?.truncated
      ) {
        return truncatedCatalogResult();
      }
      const uncitedCurrentDeliveredOutput = evidenceEntries
        .filter(
          (entry) =>
            entry.proofKind === 'delivered_output' &&
            entry.turnId === permit.turnId &&
            !citedEvidenceRefs.has(entry.uuid),
        )
        .map((entry) => entry.uuid);
      if (
        this.params.status === 'complete' &&
        uncitedCurrentDeliveredOutput.length > 0
      ) {
        return {
          llmContent: JSON.stringify({
            proposalRecorded: false,
            readyForVerification: false,
            goalLifecycleChanged: false,
            uncitedCurrentDeliveredOutput,
            error:
              'The completion proposal omitted delivered output from the current Goal turn. Call get_goal after delivering the final output, then retry update_goal with the returned evidenceCatalog UUIDs.',
          }),
          returnDisplay:
            'Goal proposal was not recorded because the current delivered output was not cited. Read the current Goal and retry.',
        };
      }
    }
    const proposal: GoalTerminalProposal = {
      status: this.params.status,
      reason: this.params.reason.trim(),
      evidenceRefs: this.params.evidenceRefs.map((reference) =>
        reference.trim(),
      ),
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
      'Propose that the current Goal is complete or blocked. Before calling, call get_goal in the current turn and cite only values from evidenceCatalog.entries[].uuid, never goalId, turnId, or lineageTurnIds. If completion depends on user-facing content delivered in the current turn, emit only the content required by the objective, then call get_goal, wait for its result, and call update_goal in a later model step with the returned delivered_output UUID. Do not add progress or completion commentary when the objective requires an exact output format. For blocked proposals, use authority when a user or maintainer decision or permission is required, external when an unavailable external resource or capability is evidenced, and repeated for the same evidenced blocker with the exact same reason text across three consecutive Goal turns; omitting blockerKind follows the repeated-blocker audit. Core records at most one proposal for the exact permitted turn and queues eligible proposals for independent verification. This tool never changes the Goal lifecycle or claims a terminal result. Do not tell the user the Goal is complete or blocked. If this tool reports readyForVerification, end the turn without additional user-facing text; otherwise continue the turn without claiming a terminal result. The Goal status card reports the independent verification result.',
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
            enum: ['authority', 'external', 'repeated'],
            description:
              'authority: a user or maintainer decision or permission is required; external: an evidenced external resource or capability is unavailable; repeated: the same evidenced blocker with the exact same reason text across three consecutive Goal turns. Omission uses the repeated-blocker audit.',
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

function truncatedCatalogResult(): GoalToolResult {
  const error =
    'The bounded evidence catalog is truncated, so current-turn output is not provably exhaustive. Continue in a new Goal turn with a smaller evidence set.';
  return {
    llmContent: JSON.stringify({
      proposalRecorded: false,
      readyForVerification: false,
      goalLifecycleChanged: false,
      error,
    }),
    returnDisplay:
      'Goal proposal was not recorded because its evidence catalog is truncated.',
  };
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
    ...(view.evidenceCatalog
      ? { evidenceCatalog: structuredClone(view.evidenceCatalog) }
      : {}),
    ...(view.verifierFeedback
      ? { verifierFeedback: view.verifierFeedback }
      : {}),
  };
}
