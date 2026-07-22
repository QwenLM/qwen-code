/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ToolDisplayNames, ToolNames } from '../tools/tool-names.js';
import type { ToolInvocation, ToolResult } from '../tools/tools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
} from '../tools/tools.js';
import type { GoalRuntime, GoalWorkerView } from './goal-runtime.js';
import { goalTurnContext } from './goal-turn-context.js';
import {
  type GoalSnapshotV2,
  type GoalTerminalProposal,
  type GoalTurnPermit,
} from './goal-protocol.js';

export type GetGoalToolParams = Record<string, never>;

export interface UpdateGoalToolParams {
  status: 'complete' | 'blocked';
  reason: string;
  evidenceRefs: string[];
  blockerKind?: 'authority' | 'external' | 'repeated';
}

const STALE_GOAL_TURN_MESSAGE = 'Goal turn permit is no longer valid';

type GetGoalRuntime = Pick<GoalRuntime, 'getGoalForWorker' | 'getSnapshot'>;

type UpdateGoalRuntime = Pick<
  GoalRuntime,
  'getGoalForWorker' | 'getSnapshot' | 'recordTerminalProposal'
>;

class GetGoalInvocation extends BaseToolInvocation<
  GetGoalToolParams,
  ToolResult
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

  async execute(): Promise<ToolResult> {
    if (!this.runtime || !this.permit) {
      const message = 'No active Goal is available for this turn.';
      return {
        llmContent: JSON.stringify({ active: false }),
        returnDisplay: message,
      };
    }

    const view = await workerViewForPermit(this.runtime, this.permit);
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
  ToolResult
> {
  static readonly Name = ToolNames.GET_GOAL;

  constructor(private readonly config: Config) {
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
  ): ToolInvocation<GetGoalToolParams, ToolResult> {
    const contextPermit = goalTurnContext.getStore();
    const permit = contextPermit ? structuredClone(contextPermit) : undefined;
    const runtime = permit ? this.config.getGoalRuntime() : undefined;
    return new GetGoalInvocation(params, runtime, permit);
  }
}

class UpdateGoalInvocation extends BaseToolInvocation<
  UpdateGoalToolParams,
  ToolResult
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

  async execute(): Promise<ToolResult> {
    if (!this.runtime || !this.permit) {
      throw new Error('No active Goal is available for this turn');
    }
    const permit = this.permit;

    const view = await workerViewForPermit(this.runtime, permit);
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
      const citesDeliveredOutput = evidenceEntries.some(
        (entry) =>
          citedEvidenceRefs.has(entry.uuid) &&
          entry.proofKind === 'delivered_output',
      );
      const uncitedCurrentDeliveredOutput = citesDeliveredOutput
        ? evidenceEntries
            .filter(
              (entry) =>
                entry.proofKind === 'delivered_output' &&
                entry.turnId === permit.turnId &&
                !citedEvidenceRefs.has(entry.uuid),
            )
            .map((entry) => entry.uuid)
        : [];
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
    const receipt = this.runtime.recordTerminalProposal(this.permit, proposal);
    const snapshot = snapshotForPermit(this.runtime, this.permit);
    const payload = {
      proposalRecorded: receipt.recorded,
      readyForVerification: receipt.readyForVerification,
      goalLifecycleChanged: false,
      nextAction:
        'End this turn without user-facing text. Do not claim the Goal is complete or blocked. The Goal status card will report the independent verification result.',
    };
    let returnDisplay: string;
    if (!receipt.recorded) {
      returnDisplay =
        'A Goal proposal is already recorded for this turn; no terminal lifecycle change was committed.';
    } else if (
      receipt.readyForVerification &&
      snapshot.goal?.goalId === this.permit.goalId &&
      snapshot.goal.revision === this.permit.revision &&
      snapshot.goal.status === 'active'
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
  ToolResult
> {
  static readonly Name = ToolNames.UPDATE_GOAL;

  constructor(private readonly config: Config) {
    super(
      UpdateGoalTool.Name,
      ToolDisplayNames.UPDATE_GOAL,
      'Propose that the current Goal is complete or blocked. Before calling, call get_goal in the current turn and cite only values from evidenceCatalog.entries[].uuid, never goalId, turnId, or lineageTurnIds. If completion depends on user-facing content delivered in the current turn, emit only the content required by the objective and call get_goal in that same response before update_goal, then cite the returned delivered_output UUID. Do not add progress or completion commentary when the objective requires an exact output format. Core records at most one proposal for the exact permitted turn and queues eligible proposals for independent verification. This tool never changes the Goal lifecycle or claims a terminal result. Do not tell the user the Goal is complete or blocked after this tool returns; say the proposal is awaiting independent verification.',
      Kind.Think,
      {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['complete', 'blocked'] },
          reason: { type: 'string', minLength: 1 },
          evidenceRefs: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            maxItems: 12,
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
    if (!params.reason.trim()) return 'reason must not be empty';
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
  ): ToolInvocation<UpdateGoalToolParams, ToolResult> {
    const contextPermit = goalTurnContext.getStore();
    const permit = contextPermit ? structuredClone(contextPermit) : undefined;
    const runtime = permit ? this.config.getGoalRuntime() : undefined;
    return new UpdateGoalInvocation(params, runtime, permit);
  }
}

function snapshotForPermit(
  runtime: { getSnapshot: () => GoalSnapshotV2 },
  permit: GoalTurnPermit,
): GoalSnapshotV2 {
  const getSnapshot: unknown = runtime.getSnapshot;
  if (typeof getSnapshot !== 'function') {
    throw staleGoalTurnError();
  }
  const snapshot = getSnapshot.call(runtime);
  if (
    snapshot.goal?.goalId !== permit.goalId ||
    snapshot.goal.revision !== permit.revision
  ) {
    throw staleGoalTurnError();
  }
  return snapshot;
}

async function workerViewForPermit(
  runtime: Pick<GoalRuntime, 'getGoalForWorker'>,
  permit: GoalTurnPermit,
): Promise<GoalWorkerView> {
  try {
    return await runtime.getGoalForWorker(permit);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'Goal runtime has been disposed' ||
        error.message === STALE_GOAL_TURN_MESSAGE)
    ) {
      throw staleGoalTurnError();
    }
    throw error;
  }
}

function staleGoalTurnError(): Error {
  return new Error(STALE_GOAL_TURN_MESSAGE);
}

function projectWorkerView(
  view: GoalWorkerView,
  snapshot: ReturnType<GetGoalRuntime['getSnapshot']>,
) {
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
