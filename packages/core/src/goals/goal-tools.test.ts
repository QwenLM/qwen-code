/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ToolDisplayNames, ToolNames } from '../tools/tool-names.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import {
  createGoalRuntime,
  type GoalJournal,
  type GoalRuntime,
  type GoalTurnHost,
} from './goal-runtime.js';
import {
  type GetGoalToolParams,
  GetGoalTool,
  PROPOSE_GOAL_NO_TURN_MESSAGE,
  PROPOSE_GOAL_OBJECTIVE_MAX_CHARACTERS,
  PROPOSE_GOAL_PENDING_MESSAGE,
  PROPOSE_GOAL_PLAN_MODE_MESSAGE,
  PROPOSE_GOAL_UNAVAILABLE_MESSAGE,
  PROPOSE_GOAL_UNTRUSTED_MESSAGE,
  ProposeGoalTool,
  type PendingGoalProposal,
  type ProposeGoalToolConfig,
  applyPendingGoalProposal,
  formatProposeGoalRecoveryFailed,
  formatProposeGoalRecoveryNotStarted,
  UpdateGoalTool,
  type GoalToolConfig,
} from './goal-tools.js';
import { ApprovalMode } from '../config/config.js';
import { ToolConfirmationOutcome } from '../tools/tools.js';
import { ToolErrorType } from '../tools/tool-error.js';
import { promptIdContext } from '../utils/promptIdContext.js';
import { goalTurnContext } from './goal-turn-context.js';
import {
  emptyGoalSnapshot,
  GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
  GOAL_PROPOSAL_REASON_MAX_BYTES,
  GOAL_PROPOSAL_REASON_MAX_CHARACTERS,
  type GoalTurnPermit,
  type TranscriptCursor,
} from './goal-protocol.js';

const permit: GoalTurnPermit = {
  goalId: 'goal-1',
  revision: 3,
  turnId: 'turn-4',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function makeConfig(runtime: Partial<GoalRuntime>) {
  return {
    getGoalRuntime: vi.fn(() => runtime as GoalRuntime),
  };
}

function fakeGoalJournal(): GoalJournal {
  return {
    getTranscriptCursor(): TranscriptCursor {
      return { recordId: null };
    },
    async recordGoalState(): Promise<void> {},
  };
}

function fakeHost(): GoalTurnHost & { started: GoalTurnPermit[] } {
  const started: GoalTurnPermit[] = [];
  return {
    started,
    async startGoalTurn({ permit: startedPermit }) {
      started.push(structuredClone(startedPermit));
    },
    preemptGoalTurn: vi.fn(),
  };
}

async function activeRuntime() {
  const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
  const host = fakeHost();
  runtime.bindHost(host);
  await runtime.dispatch({ action: 'create', objective: 'Ship Goal v3' });
  return { runtime, permit: host.started[0]! };
}

async function execute(tool: GetGoalTool) {
  return tool.build({}).execute(new AbortController().signal);
}

describe('GetGoalTool', () => {
  it('uses the canonical Goal tool name', () => {
    const tool = new GetGoalTool(makeConfig({}));

    expect(ToolNames.GET_GOAL).toBe('get_goal');
    expect(ToolDisplayNames.GET_GOAL).toBe('Goal');
    expect(tool.name).toBe(ToolNames.GET_GOAL);
    expect(tool.displayName).toBe(ToolDisplayNames.GET_GOAL);
    expect(tool.shouldDefer).toBe(false);
    expect(tool.build({}).getDescription()).toBe('Read the current goal');
  });

  it('keeps both Goal tools visible and out of deferred search', () => {
    const config = {
      getMcpTransportPool: () => undefined,
      getDisabledTools: () => new Set<string>(),
      getVisibleTools: () => new Set<string>(),
      getGoalRuntime: () => undefined as never,
    } as unknown as Config & GoalToolConfig;
    const registry = new ToolRegistry(config);
    const getGoal = new GetGoalTool(config);
    const updateGoal = new UpdateGoalTool(config);
    registry.registerTool(getGoal);
    registry.registerTool(updateGoal);

    expect(getGoal.shouldDefer).toBe(false);
    expect(updateGoal.shouldDefer).toBe(false);
    expect(registry.getDeferredToolSummary()).toEqual([]);
    expect(
      registry.getFunctionDeclarations().map((declaration) => declaration.name),
    ).toEqual([ToolNames.GET_GOAL, ToolNames.UPDATE_GOAL]);
  });

  it('reports no active Goal outside a permitted Goal turn', async () => {
    const getGoalForWorker = vi.fn();
    const config = makeConfig({ getGoalForWorker });

    const result = await execute(new GetGoalTool(config));

    expect(result.error).toBeUndefined();
    expect(JSON.parse(String(result.llmContent))).toEqual({ active: false });
    expect(result.returnDisplay).toBe(
      'No active Goal is available for this turn.',
    );
    expect(getGoalForWorker).not.toHaveBeenCalled();
  });

  it('summarises the last Goal once it has stopped issuing permits', async () => {
    const getGoalForWorker = vi.fn();
    const config = makeConfig({
      getGoalForWorker,
      getSnapshot: () => ({
        v: 2 as const,
        activity: 'idle' as const,
        goal: {
          goalId: 'goal-1',
          revision: 3,
          objective: 'Ship Goal v3',
          status: 'usage_limited' as const,
          evidenceCursor: { recordId: 'record-1' },
          turnCount: 27,
          activeTimeMs: 1_763_705,
          tokensUsed: 4_500,
          tokenBudget: 30_000_000,
          turnBudget: 40,
          activeTimeBudgetMs: 1_800_000,
          createdAt: 1,
          updatedAt: 2,
          lastReason: GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
          evidenceCheckpoint: {
            checkpointId: 'checkpoint-1',
            createdAt: 2,
            claims: [
              {
                id: 'checkpoint-1:1',
                proofKind: 'external_fact' as const,
                claim: 'note-01.md exists',
                sourceRefs: ['record-1'],
              },
            ],
          },
        },
      }),
    });

    const result = await execute(new GetGoalTool(config));

    expect(result.error).toBeUndefined();
    expect(JSON.parse(String(result.llmContent))).toEqual({
      active: false,
      lastGoal: {
        goalId: 'goal-1',
        revision: 3,
        status: 'usage_limited',
        turnCount: 27,
        activeTimeMs: 1_763_705,
        tokensUsed: 4_500,
        tokenBudget: 30_000_000,
        // A stopped Goal's cadence ceilings are reported beside the token
        // one, so an inspection can see which allowance ran out.
        turnBudget: 40,
        activeTimeBudgetMs: 1_800_000,
        lastReason: GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
      },
    });
    expect(result.returnDisplay).toBe(
      'No Goal turn is permitted · last Goal usage_limited after 27 turns',
    );
    expect(getGoalForWorker).not.toHaveBeenCalled();
  });

  it('summarises a paused Goal outside a permitted turn', async () => {
    const config = makeConfig({
      getGoalForWorker: vi.fn(),
      getSnapshot: () => ({
        v: 2 as const,
        activity: 'idle' as const,
        goal: {
          goalId: 'goal-1',
          revision: 2,
          objective: 'Ship Goal v3',
          status: 'paused' as const,
          evidenceCursor: { recordId: 'record-1' },
          turnCount: 1,
          activeTimeMs: 750,
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 2,
        },
      }),
    });

    const result = await execute(new GetGoalTool(config));

    expect(JSON.parse(String(result.llmContent))).toEqual({
      active: false,
      lastGoal: {
        goalId: 'goal-1',
        revision: 2,
        status: 'paused',
        turnCount: 1,
        activeTimeMs: 750,
        tokensUsed: 0,
      },
    });
    expect(result.returnDisplay).toBe(
      'No Goal turn is permitted · last Goal paused after 1 turn',
    );
  });

  it('leaves checkpoint health out of the summary, whatever an earlier build recorded', async () => {
    // Goals no longer run evidence checkpoints. A record an earlier build
    // stopped on one still carries the streak and the failure; the model is
    // told why the Goal stopped, not about a mechanism that is gone.
    const config = makeConfig({
      getGoalForWorker: vi.fn(),
      getSnapshot: () => ({
        v: 2 as const,
        activity: 'idle' as const,
        goal: {
          goalId: 'goal-1',
          revision: 3,
          objective: 'Ship Goal v3',
          status: 'usage_limited' as const,
          limitKind: 'checkpoint_request' as const,
          evidenceCursor: { recordId: 'record-1' },
          turnCount: 5,
          activeTimeMs: 10,
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 2,
          checkpointStalls: 3,
          lastCheckpointFailure: 'Error: provider failed',
          lastReason: 'Three evidence checkpoints stalled.',
        },
      }),
    });

    const { lastGoal } = JSON.parse(
      String((await execute(new GetGoalTool(config))).llmContent),
    );

    expect(lastGoal).toMatchObject({
      status: 'usage_limited',
      lastReason: 'Three evidence checkpoints stalled.',
    });
    expect(lastGoal).not.toHaveProperty('checkpointStalls');
    expect(lastGoal).not.toHaveProperty('lastCheckpointFailure');
  });

  it('keeps the objective and the evidence checkpoint behind the permit', async () => {
    const config = makeConfig({
      getGoalForWorker: vi.fn(),
      getSnapshot: () => ({
        v: 2 as const,
        activity: 'idle' as const,
        goal: {
          goalId: 'goal-1',
          revision: 1,
          objective: 'SECRET_OBJECTIVE',
          status: 'complete' as const,
          evidenceCursor: { recordId: 'record-1' },
          turnCount: 2,
          activeTimeMs: 10,
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 2,
          evidenceCheckpoint: {
            checkpointId: 'checkpoint-1',
            createdAt: 2,
            claims: [
              {
                id: 'checkpoint-1:1',
                proofKind: 'delivered_output' as const,
                claim: 'SECRET_CLAIM',
                sourceRefs: ['record-1'],
              },
            ],
          },
        },
      }),
    });

    const result = await execute(new GetGoalTool(config));

    expect(String(result.llmContent)).not.toContain('SECRET_OBJECTIVE');
    expect(String(result.llmContent)).not.toContain('SECRET_CLAIM');
    expect(JSON.parse(String(result.llmContent))).toEqual({
      active: false,
      lastGoal: {
        goalId: 'goal-1',
        revision: 1,
        status: 'complete',
        turnCount: 2,
        activeTimeMs: 10,
        tokensUsed: 0,
      },
    });
  });

  it('reports no Goal when the session never had one', async () => {
    const config = makeConfig({
      getGoalForWorker: vi.fn(),
      getSnapshot: () => emptyGoalSnapshot(),
    });

    const result = await execute(new GetGoalTool(config));

    expect(JSON.parse(String(result.llmContent))).toEqual({ active: false });
  });

  it('reports no Goal when Goal persistence is unreachable', async () => {
    const config = {
      getGoalRuntime: vi.fn(() => {
        throw new Error('Goal persistence is unavailable');
      }),
    };

    const result = await execute(new GetGoalTool(config));

    expect(result.error).toBeUndefined();
    expect(JSON.parse(String(result.llmContent))).toEqual({ active: false });
    expect(result.returnDisplay).toBe(
      'No active Goal is available for this turn.',
    );
  });

  it('returns only the worker view for the captured permit', async () => {
    const snapshot = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-1',
        revision: 3,
        objective: 'Ship Goal v3',
        status: 'active' as const,
        evidenceCursor: { recordId: 'cursor-1' },
        turnCount: 4,
        activeTimeMs: 120,
        tokensUsed: 0,
        createdAt: 10,
        updatedAt: 20,
      },
    };
    const getGoalForWorker = vi.fn().mockResolvedValue({
      goalId: 'goal-1',
      revision: 3,
      objective: 'Ship Goal v3',
      evidenceCursor: { recordId: 'cursor-1' },
      verifierFeedback: 'retry: missing edge case',
      fullTranscript: ['must not leak'],
    });
    const getSnapshotForPermit = vi.fn(() => structuredClone(snapshot));
    const tool = new GetGoalTool(
      makeConfig({ getGoalForWorker, getSnapshotForPermit }),
    );
    const invocation = goalTurnContext.run(permit, () => tool.build({}));

    const result = await invocation.execute(new AbortController().signal);

    expect(invocation.getDescription()).toBe('Read the current goal');
    expect(getGoalForWorker).toHaveBeenCalledWith(permit);
    expect(getSnapshotForPermit).toHaveBeenCalledWith(permit);
    expect(JSON.parse(String(result.llmContent))).toEqual({
      active: true,
      snapshot,
      verifierFeedback: 'retry: missing edge case',
    });
    expect(String(result.llmContent)).not.toContain('must not leak');
    expect(result.returnDisplay).toBe('Active goal · revision 3');
  });

  it('collapses checkpoint claims to a count and ignores the deprecated view parameter', async () => {
    const snapshot = {
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: 'goal-1',
        revision: 3,
        objective: 'Ship Goal v3',
        status: 'active' as const,
        evidenceCursor: { recordId: 'checkpoint-9' },
        turnCount: 40,
        activeTimeMs: 120,
        tokensUsed: 0,
        createdAt: 10,
        updatedAt: 20,
        evidenceCheckpoint: {
          checkpointId: 'checkpoint-9',
          createdAt: 15,
          claims: Array.from({ length: 2 }, (_, index) => ({
            id: `checkpoint-9:${index + 1}`,
            proofKind: 'external_fact' as const,
            claim: `SECRET_CLAIM_TEXT ${index}`,
            sourceRefs: [`src-${index}`],
          })),
        },
      },
    };
    const tool = new GetGoalTool(
      makeConfig({
        getGoalForWorker: vi.fn().mockResolvedValue({
          goalId: 'goal-1',
          revision: 3,
          objective: 'Ship Goal v3',
          evidenceCursor: { recordId: 'checkpoint-9' },
        }),
        getSnapshotForPermit: vi.fn(() => structuredClone(snapshot)),
      }),
    );
    const read = async (params: GetGoalToolParams) => {
      const invocation = goalTurnContext.run(permit, () => tool.build(params));
      const result = await invocation.execute(new AbortController().signal);
      return JSON.parse(String(result.llmContent)) as Record<string, unknown>;
    };

    const payload = await read({});
    expect(payload).toEqual({
      active: true,
      snapshot: {
        ...snapshot,
        goal: {
          ...snapshot.goal,
          evidenceCheckpoint: {
            checkpointId: 'checkpoint-9',
            createdAt: 15,
            claimCount: 2,
          },
        },
      },
    });
    expect(JSON.stringify(payload)).not.toContain('SECRET_CLAIM_TEXT');
    expect(await read({ view: 'full' })).toEqual(payload);
  });

  it('advertises no parameters, and still serves a call that sends the old one', () => {
    const tool = new GetGoalTool(makeConfig({ getGoalForWorker: vi.fn() }));
    expect(tool.schema.parametersJsonSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    // `view` left the schema to stop paying for it on every request; a model
    // that still sends it is served, where any other unknown key is refused.
    expect(tool.validateToolParams({ view: 'full' })).toBeNull();
    expect(tool.validateToolParams({ verbose: true } as never)).not.toBeNull();
  });
});

describe('UpdateGoalTool', () => {
  const activeSnapshot = () => ({
    v: 2 as const,
    activity: 'running' as const,
    goal: {
      goalId: permit.goalId,
      revision: permit.revision,
      objective: 'Deliver the result',
      status: 'active' as const,
      evidenceCursor: { recordId: 'goal-created' },
      turnCount: 3,
      activeTimeMs: 100,
      tokensUsed: 0,
      createdAt: 1,
      updatedAt: 2,
    },
  });

  it('exposes the transcript-tail evidence contract', () => {
    const tool = new UpdateGoalTool(makeConfig({}));
    const schema = tool.schema.parametersJsonSchema as {
      required: string[];
      properties: Record<
        string,
        { description?: string; enum?: string[]; maxLength?: number }
      >;
    };

    expect(tool.description).toContain(
      "only the most recent records of this Goal's transcript",
    );
    expect(tool.description).toContain(
      'run the checks that prove every objective condition immediately before calling',
    );
    expect(tool.description).toContain(
      'Never tell the user the Goal is complete or blocked',
    );
    expect(tool.description).toContain(
      'with no progress or completion commentary',
    );
    expect(tool.description).toContain('end the turn with no further text');
    expect(tool.description).not.toContain('evidenceCatalog');
    expect(tool.description).not.toContain('cite');

    expect(schema.required).toEqual(['status', 'reason']);
    expect(Object.keys(schema.properties)).toEqual([
      'status',
      'reason',
      'blockerKind',
    ]);
    expect(schema.properties['reason']!.maxLength).toBe(
      GOAL_PROPOSAL_REASON_MAX_CHARACTERS,
    );
    // The blocker rules live on the parameter they govern, once.
    const blockerKind = schema.properties['blockerKind']!;
    expect(blockerKind.enum).toContain('infeasible');
    expect(blockerKind.description).toContain('three consecutive Goal turns');
    expect(blockerKind.description).toContain('exact same reason text');
    expect(blockerKind.description).toContain('cannot be satisfied as written');
    expect(blockerKind.description).toContain(
      'a tool result (not your own text)',
    );
    expect(blockerKind.description).toContain(
      'never for difficulty, uncertainty, information you could still obtain, or wanting to ask',
    );
    expect(blockerKind.description).toContain(
      'why no in-scope work could satisfy the objective',
    );
    expect(tool.description).not.toContain('infeasible');
  });

  it('serves a proposal that still sends evidenceRefs, and refuses any other unknown key', () => {
    const tool = new UpdateGoalTool(makeConfig({}));
    expect(
      tool.validateToolParams({
        status: 'complete',
        reason: 'Delivered',
        evidenceRefs: ['an-old-habit'],
      }),
    ).toBeNull();
    expect(
      tool.validateToolParams({
        status: 'complete',
        reason: 'Delivered',
        citations: [],
      } as never),
    ).not.toBeNull();
    // A call with no arguments at all gets the schema's answer, not a throw.
    expect(tool.validateToolParams(undefined as never)).toMatch(/must/i);
    expect(
      new GetGoalTool(
        makeConfig({ getGoalForWorker: vi.fn() }),
      ).validateToolParams(null as never),
    ).toMatch(/must/i);
  });

  it('records the proposal without references and without reading a catalog', async () => {
    const recordTerminalProposal = vi.fn().mockReturnValue({
      recorded: true,
      readyForVerification: true,
    });
    const getGoalForWorker = vi.fn().mockResolvedValue({
      goalId: permit.goalId,
      revision: permit.revision,
      objective: 'Deliver the result',
      evidenceCursor: { recordId: 'goal-created' },
    });
    const getSnapshotForPermit = vi.fn(() => activeSnapshot());
    const tool = new UpdateGoalTool(
      makeConfig({
        getGoalForWorker,
        getSnapshotForPermit,
        recordTerminalProposal,
      }),
    );
    const invocation = goalTurnContext.run(permit, () =>
      tool.build({
        status: 'complete',
        reason: '  Focused tests passed  ',
        evidenceRefs: ['stale-reference-from-an-older-contract'],
      }),
    );

    const result = await invocation.execute(new AbortController().signal);

    expect(recordTerminalProposal).toHaveBeenCalledWith(permit, {
      status: 'complete',
      reason: 'Focused tests passed',
    });
    expect(JSON.parse(String(result.llmContent))).toEqual({
      proposalRecorded: true,
      readyForVerification: true,
      goalLifecycleChanged: false,
      nextAction: expect.stringContaining(
        'End this turn without user-facing text',
      ),
    });
    expect(result.terminateTurn).toBe(true);
  });

  it('records one proposal while leaving the Goal active', async () => {
    const { runtime, permit: activePermit } = await activeRuntime();
    const tool = new UpdateGoalTool(makeConfig(runtime));
    const invocation = goalTurnContext.run(activePermit, () =>
      tool.build({
        status: 'complete',
        reason: 'Focused tests passed',
        evidenceRefs: ['tool-result-1'],
      }),
    );

    const result = await invocation.execute(new AbortController().signal);

    expect(ToolNames.UPDATE_GOAL).toBe('update_goal');
    expect(ToolDisplayNames.UPDATE_GOAL).toBe('UpdateGoal');
    expect(JSON.parse(String(result.llmContent))).toEqual({
      proposalRecorded: true,
      readyForVerification: true,
      goalLifecycleChanged: false,
      nextAction:
        'End this turn without user-facing text. Do not claim the Goal is complete or blocked. The Goal status card will report the independent verification result.',
    });
    expect(result.returnDisplay).toContain(
      'queued for independent verification',
    );
    expect(result.terminateTurn).toBe(true);
    expect(runtime.getSnapshot().goal?.status).toBe('active');
  });

  it('keeps audit-only blocker proposals in the current turn', async () => {
    const { runtime, permit: activePermit } = await activeRuntime();
    const tool = new UpdateGoalTool(makeConfig(runtime));
    const build = () =>
      goalTurnContext.run(activePermit, () =>
        tool.build({
          status: 'blocked',
          reason: 'The same external blocker is still present',
          evidenceRefs: ['tool-result-1'],
          blockerKind: 'repeated',
        }),
      );

    const first = await build().execute(new AbortController().signal);
    const second = await build().execute(new AbortController().signal);

    for (const result of [first, second]) {
      expect(JSON.parse(String(result.llmContent))).toEqual({
        proposalRecorded: result === first,
        readyForVerification: false,
        goalLifecycleChanged: false,
        nextAction:
          'Continue this turn without claiming the Goal is complete or blocked. A repeated-blocker audit requires the same blocker mode and exact same reason text across three consecutive Goal turns, each of which must show the blocker in its own tool results.',
      });
      expect(result.terminateTurn).toBeUndefined();
    }
    expect(first.returnDisplay).toContain('blocker audit');
    expect(second.returnDisplay).toContain('already recorded');
  });

  it('rejects a second proposal in the same exact turn', async () => {
    const { runtime, permit: activePermit } = await activeRuntime();
    const tool = new UpdateGoalTool(makeConfig(runtime));
    const build = () =>
      goalTurnContext.run(activePermit, () =>
        tool.build({
          status: 'complete',
          reason: 'Focused tests passed',
          evidenceRefs: ['tool-result-1'],
        }),
      );

    await build().execute(new AbortController().signal);
    const second = await build().execute(new AbortController().signal);

    expect(JSON.parse(String(second.llmContent))).toEqual({
      proposalRecorded: false,
      readyForVerification: true,
      goalLifecycleChanged: false,
      nextAction:
        'End this turn without user-facing text. Do not claim the Goal is complete or blocked. The Goal status card will report the independent verification result.',
    });
    expect(second.returnDisplay).toContain('already recorded');
    expect(second.returnDisplay).not.toContain('Goal is complete');
    expect(second.terminateTurn).toBe(true);
  });

  it('rejects a proposal after pause invalidates its permit', async () => {
    const { runtime, permit: activePermit } = await activeRuntime();
    const invocation = goalTurnContext.run(activePermit, () =>
      new UpdateGoalTool(makeConfig(runtime)).build({
        status: 'blocked',
        reason: 'Needs authority',
        evidenceRefs: ['user-request-1'],
        blockerKind: 'authority',
      }),
    );
    await runtime.dispatch({
      action: 'pause',
      expectedGoalId: activePermit.goalId,
      expectedRevision: activePermit.revision,
    });

    await expect(
      invocation.execute(new AbortController().signal),
    ).rejects.toThrow('Goal turn permit is no longer valid');
    expect(runtime.getSnapshot().goal?.status).toBe('paused');
  });

  it('requires a non-empty reason and ignores evidence references', () => {
    const tool = new UpdateGoalTool(makeConfig({} as GoalRuntime));
    const build = (params: Parameters<typeof tool.build>[0]) =>
      goalTurnContext.run(permit, () => tool.build(params));

    expect(() =>
      build({
        status: 'complete',
        reason: 'x'.repeat(GOAL_PROPOSAL_REASON_MAX_CHARACTERS),
      }),
    ).not.toThrow();
    expect(() =>
      build({
        status: 'complete',
        reason: 'é'.repeat(GOAL_PROPOSAL_REASON_MAX_BYTES / 2),
      }),
    ).not.toThrow();
    expect(() =>
      build({ status: 'blocked', reason: 'Waiting for authority' }),
    ).not.toThrow();
    expect(() =>
      build({
        status: 'blocked',
        reason: 'Waiting for authority',
        evidenceRefs: [],
      }),
    ).not.toThrow();
    expect(() =>
      build({
        status: 'complete',
        reason: 'Focused tests passed',
        evidenceRefs: ['same-reference', ' same-reference '],
      }),
    ).not.toThrow();
    expect(() => build({ status: 'complete', reason: '   ' })).toThrow(
      /reason/i,
    );
    expect(() =>
      build({
        status: 'complete',
        reason: 'x'.repeat(GOAL_PROPOSAL_REASON_MAX_CHARACTERS + 1),
      }),
    ).toThrow(/characters/i);
    expect(() =>
      build({
        status: 'complete',
        reason: '界'.repeat(Math.floor(GOAL_PROPOSAL_REASON_MAX_BYTES / 3) + 1),
      }),
    ).toThrow(/UTF-8 bytes/i);
  });

  it.each(['edit', 'replace', 'clear', 'finish'] as const)(
    'rejects both delayed tools after %s invalidates the captured permit',
    async (action) => {
      const { runtime, permit: activePermit } = await activeRuntime();
      const config = makeConfig(runtime);
      const getInvocation = goalTurnContext.run(activePermit, () =>
        new GetGoalTool(config).build({}),
      );
      const updateInvocation = goalTurnContext.run(activePermit, () =>
        new UpdateGoalTool(config).build({
          status: 'complete',
          reason: 'Focused tests passed',
          evidenceRefs: ['tool-result-1'],
        }),
      );

      if (action === 'finish') {
        await runtime.finishTurn(activePermit);
      } else if (action === 'clear') {
        await runtime.dispatch({
          action,
          expectedGoalId: activePermit.goalId,
          expectedRevision: activePermit.revision,
        });
      } else {
        await runtime.dispatch({
          action,
          objective: 'Changed objective',
          expectedGoalId: activePermit.goalId,
          expectedRevision: activePermit.revision,
        });
      }

      await expect(
        getInvocation.execute(new AbortController().signal),
      ).rejects.toThrow('Goal turn permit is no longer valid');
      await expect(
        updateInvocation.execute(new AbortController().signal),
      ).rejects.toThrow('Goal turn permit is no longer valid');
    },
  );

  it('keeps the exact runtime captured at build across a session swap', async () => {
    const oldGetGoalForWorker = vi
      .fn()
      .mockRejectedValue(new Error('Goal runtime has been disposed'));
    const newGetGoalForWorker = vi.fn().mockResolvedValue({
      goalId: 'new-goal',
      revision: 1,
      objective: 'new session',
      evidenceCursor: { recordId: 'new-cursor' },
    });
    const oldRuntime = {
      getGoalForWorker: oldGetGoalForWorker,
      recordTerminalProposal: vi.fn(),
    } as unknown as GoalRuntime;
    const newRuntime = {
      getGoalForWorker: newGetGoalForWorker,
      recordTerminalProposal: vi.fn(),
    } as unknown as GoalRuntime;
    const getGoalRuntime = vi.fn().mockReturnValue(oldRuntime);
    const config: GoalToolConfig = { getGoalRuntime };
    const getInvocation = goalTurnContext.run(permit, () =>
      new GetGoalTool(config).build({}),
    );
    const updateInvocation = goalTurnContext.run(permit, () =>
      new UpdateGoalTool(config).build({
        status: 'complete',
        reason: 'done',
        evidenceRefs: ['evidence-1'],
      }),
    );
    getGoalRuntime.mockReturnValue(newRuntime);

    await expect(
      getInvocation.execute(new AbortController().signal),
    ).rejects.toThrow('Goal turn permit is no longer valid');
    await expect(
      updateInvocation.execute(new AbortController().signal),
    ).rejects.toThrow('Goal turn permit is no longer valid');
    expect(oldGetGoalForWorker).toHaveBeenCalledTimes(2);
    expect(newGetGoalForWorker).not.toHaveBeenCalled();
    expect(getGoalRuntime).toHaveBeenCalledTimes(2);
  });

  it('propagates unexpected worker-view errors from both tools', async () => {
    const unexpectedError = new Error('unexpected database failure');
    const getGoalForWorker = vi.fn().mockRejectedValue(unexpectedError);
    const runtime = {
      getGoalForWorker,
      recordTerminalProposal: vi.fn(),
    } as unknown as GoalRuntime;
    const config = makeConfig(runtime);
    const getInvocation = goalTurnContext.run(permit, () =>
      new GetGoalTool(config).build({}),
    );
    const updateInvocation = goalTurnContext.run(permit, () =>
      new UpdateGoalTool(config).build({
        status: 'complete',
        reason: 'done',
        evidenceRefs: ['evidence-1'],
      }),
    );

    await expect(
      getInvocation.execute(new AbortController().signal),
    ).rejects.toBe(unexpectedError);
    await expect(
      updateInvocation.execute(new AbortController().signal),
    ).rejects.toBe(unexpectedError);
    expect(getGoalForWorker).toHaveBeenCalledTimes(2);
    expect(runtime.recordTerminalProposal).not.toHaveBeenCalled();
  });

  it('honors cancellation before recording an update proposal', async () => {
    const workerRead = deferred<{
      goalId: string;
      revision: number;
      objective: string;
      evidenceCursor: { recordId: string };
    }>();
    const recordTerminalProposal = vi.fn();
    const getGoalForWorker = vi.fn(() => workerRead.promise);
    const runtime = {
      getGoalForWorker,
      getSnapshotForPermit: vi.fn(),
      recordTerminalProposal,
    };
    const invocation = goalTurnContext.run(permit, () =>
      new UpdateGoalTool(makeConfig(runtime)).build({
        status: 'complete',
        reason: 'done',
        evidenceRefs: ['evidence-1'],
      }),
    );
    const controller = new AbortController();
    const execution = invocation.execute(controller.signal);
    await vi.waitFor(() => expect(getGoalForWorker).toHaveBeenCalledOnce());

    controller.abort(new Error('cancelled'));

    await expect(execution).rejects.toThrow('cancelled');
    workerRead.resolve({
      goalId: permit.goalId,
      revision: permit.revision,
      objective: 'Ship Goal v3',
      evidenceCursor: { recordId: 'cursor' },
    });
    await Promise.resolve();
    expect(recordTerminalProposal).not.toHaveBeenCalled();
  });

  it.each(['missing snapshot API', 'stale snapshot API'] as const)(
    'fails both tools closed with a stable stale-permit error for a %s',
    async (scenario) => {
      const getGoalForWorker = vi.fn().mockResolvedValue({
        goalId: permit.goalId,
        revision: permit.revision,
        objective: 'old session',
        evidenceCursor: { recordId: 'old-cursor' },
      });
      const recordTerminalProposal = vi.fn().mockReturnValue({
        recorded: true,
        readyForVerification: true,
      });
      const runtime = {
        getGoalForWorker,
        recordTerminalProposal,
        ...(scenario === 'stale snapshot API'
          ? {
              getSnapshotForPermit: vi.fn(() => {
                throw new Error('Goal turn permit is no longer valid');
              }),
            }
          : {}),
      } as unknown as GoalRuntime;
      const config = makeConfig(runtime);
      const getInvocation = goalTurnContext.run(permit, () =>
        new GetGoalTool(config).build({}),
      );
      const updateInvocation = goalTurnContext.run(permit, () =>
        new UpdateGoalTool(config).build({
          status: 'complete',
          reason: 'done',
          evidenceRefs: ['evidence-1'],
        }),
      );

      await expect(
        getInvocation.execute(new AbortController().signal),
      ).rejects.toThrow('Goal turn permit is no longer valid');
      await expect(
        updateInvocation.execute(new AbortController().signal),
      ).rejects.toThrow('Goal turn permit is no longer valid');
      expect(recordTerminalProposal).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['get_goal', 'goalId'],
    ['get_goal', 'revision'],
    ['update_goal', 'goalId'],
    ['update_goal', 'revision'],
  ] as const)(
    'rejects a %s worker view with a mismatched %s after an exact snapshot check',
    async (toolName, mismatchedField) => {
      const matchingSnapshot = {
        v: 2 as const,
        activity: 'running' as const,
        goal: {
          goalId: permit.goalId,
          revision: permit.revision,
          objective: 'permitted goal',
          status: 'active' as const,
          evidenceCursor: { recordId: 'cursor-1' },
          turnCount: 1,
          activeTimeMs: 0,
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      };
      const getGoalForWorker = vi.fn().mockResolvedValue({
        goalId: mismatchedField === 'goalId' ? 'different-goal' : permit.goalId,
        revision:
          mismatchedField === 'revision'
            ? permit.revision + 1
            : permit.revision,
        objective: 'wrong worker view',
        evidenceCursor: { recordId: 'wrong-cursor' },
      });
      const recordTerminalProposal = vi.fn();
      const runtime = {
        getGoalForWorker,
        getSnapshotForPermit: vi.fn(() => structuredClone(matchingSnapshot)),
        recordTerminalProposal,
      };
      const config = makeConfig(runtime);
      const invocation = goalTurnContext.run(permit, () =>
        toolName === 'get_goal'
          ? new GetGoalTool(config).build({})
          : new UpdateGoalTool(config).build({
              status: 'complete',
              reason: 'done',
              evidenceRefs: ['evidence-1'],
            }),
      );

      await expect(
        invocation.execute(new AbortController().signal),
      ).rejects.toThrow('Goal turn permit is no longer valid');
      expect(recordTerminalProposal).not.toHaveBeenCalled();
    },
  );

  it.each(['get_goal', 'update_goal'] as const)(
    'normalizes disposal after the awaited %s worker read',
    async (toolName) => {
      const { runtime, permit: activePermit } = await activeRuntime();
      const originalGetGoalForWorker = runtime.getGoalForWorker.bind(runtime);
      vi.spyOn(runtime, 'getGoalForWorker').mockImplementation(
        async (runtimePermit) => {
          const view = await originalGetGoalForWorker(runtimePermit);
          runtime.dispose();
          return view;
        },
      );
      const recordTerminalProposal = vi.spyOn(
        runtime,
        'recordTerminalProposal',
      );
      const invocation = goalTurnContext.run(activePermit, () =>
        toolName === 'get_goal'
          ? new GetGoalTool(makeConfig(runtime)).build({})
          : new UpdateGoalTool(makeConfig(runtime)).build({
              status: 'complete',
              reason: 'done',
              evidenceRefs: ['evidence-1'],
            }),
      );

      await expect(
        invocation.execute(new AbortController().signal),
      ).rejects.toThrow('Goal turn permit is no longer valid');
      expect(recordTerminalProposal).not.toHaveBeenCalled();
    },
  );

  it('normalizes disposal from proposal recording', async () => {
    const runtime = {
      getGoalForWorker: vi.fn().mockResolvedValue({
        goalId: permit.goalId,
        revision: permit.revision,
        objective: 'permitted goal',
        evidenceCursor: { recordId: 'cursor-1' },
      }),
      getSnapshotForPermit: vi.fn(() => ({
        v: 2 as const,
        activity: 'running' as const,
        goal: {
          goalId: permit.goalId,
          revision: permit.revision,
          objective: 'permitted goal',
          status: 'active' as const,
          evidenceCursor: { recordId: 'cursor-1' },
          turnCount: 1,
          activeTimeMs: 0,
          tokensUsed: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      })),
      recordTerminalProposal: vi.fn(() => {
        throw new Error('Goal runtime has been disposed');
      }),
    };
    const invocation = goalTurnContext.run(permit, () =>
      new UpdateGoalTool(makeConfig(runtime)).build({
        status: 'complete',
        reason: 'done',
        evidenceRefs: ['evidence-1'],
      }),
    );

    await expect(
      invocation.execute(new AbortController().signal),
    ).rejects.toThrow('Goal turn permit is no longer valid');
  });

  it('does not expose Goal lifecycle controls through either invocation', async () => {
    const { runtime, permit: activePermit } = await activeRuntime();
    const dispatch = vi.spyOn(runtime, 'dispatch');
    const getInvocation = goalTurnContext.run(activePermit, () =>
      new GetGoalTool(makeConfig(runtime)).build({}),
    );
    const updateInvocation = goalTurnContext.run(activePermit, () =>
      new UpdateGoalTool(makeConfig(runtime)).build({
        status: 'complete',
        reason: 'done',
        evidenceRefs: ['evidence-1'],
      }),
    );

    await getInvocation.execute(new AbortController().signal);
    await updateInvocation.execute(new AbortController().signal);

    expect(dispatch).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().goal?.status).toBe('active');
  });
});

describe('ProposeGoalTool', () => {
  const TURN_KEY = 'user-turn-key';
  /** Runs the tool inside the prompt-id context established by the scheduler. */
  const execute = (invocation: ReturnType<ProposeGoalTool['build']>) =>
    promptIdContext.run(TURN_KEY, () =>
      invocation.execute(new AbortController().signal),
    );

  const objective =
    'Outcome: auth tests pass. Done when: 1) `npm test` exits 0 (paste the summary line). Must not: edit test files. Budget: stop as blocked after 20 turns. On block: report the blocker.';

  function proposeConfig(
    runtime: Partial<GoalRuntime> | (() => never),
    overrides: Partial<ProposeGoalToolConfig> = {},
  ): ProposeGoalToolConfig & {
    pending: () => PendingGoalProposal | undefined;
  } {
    let parked: PendingGoalProposal | undefined;
    const setPendingGoalProposal = vi.fn((proposal: PendingGoalProposal) => {
      if (parked) return false;
      parked = proposal;
      return true;
    });
    const getGoalRuntime =
      typeof runtime === 'function'
        ? runtime
        : vi.fn(() => runtime as GoalRuntime);
    return {
      getGoalRuntime,
      getGoalRuntimeReady: async () => getGoalRuntime(),
      isTrustedFolder: () => true,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      hasPendingGoalProposal: () => parked !== undefined,
      setPendingGoalProposal,
      pending: () => parked,
      ...overrides,
    };
  }

  function idleRuntime() {
    const runtime = createGoalRuntime({ journal: fakeGoalJournal() });
    const host = fakeHost();
    runtime.bindHost(host);
    return { runtime, host };
  }

  async function confirm(
    tool: ProposeGoalTool,
    outcome: ToolConfirmationOutcome,
    params = { objective },
  ) {
    const invocation = tool.build(params);
    const details = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    await details.onConfirm(outcome);
    return { invocation, details };
  }

  it('uses the canonical name, stays visible, and always goes through the dialog', async () => {
    const tool = new ProposeGoalTool(proposeConfig(idleRuntime().runtime));
    expect(tool.name).toBe(ToolNames.PROPOSE_GOAL);
    expect(tool.displayName).toBe(ToolDisplayNames.PROPOSE_GOAL);
    expect(tool.shouldDefer).toBe(false);

    const invocation = tool.build({ objective });
    // Consent for an autonomous loop cannot come from a rule or an approval
    // mode; YOLO and AUTO_EDIT would otherwise approve an `info` dialog.
    expect(invocation.requiresUserInteraction?.()).toBe(true);
    expect(await invocation.getDefaultPermission()).toBe('ask');
    expect(invocation.getDescription()).toContain(objective);
    // The decline clause is what keeps the model from re-proposing after a
    // refusal: the constant it would otherwise read never reaches it. Same
    // fragment as the bundled skill's copy in goal-draft/SKILL.test.ts, so the
    // two cannot drift apart unnoticed.
    expect(tool.description).toContain(
      'do not propose the same or a reworded objective again',
    );
    // The tool is declared in an interactive plan-mode session and refuses at
    // confirmation time there; the clause is the model's only static hint.
    expect(tool.description).toContain('Not available in plan mode.');
  });

  it('validates the objective', () => {
    const tool = new ProposeGoalTool(proposeConfig(idleRuntime().runtime));
    expect(tool.validateToolParams({ objective: '   ' })).not.toBeNull();
    expect(
      tool.validateToolParams({
        objective: 'x'.repeat(PROPOSE_GOAL_OBJECTIVE_MAX_CHARACTERS + 1),
      }),
    ).not.toBeNull();
    expect(
      tool.validateToolParams({ objective: 'Outcome: ship it.\nBudget: 20.' }),
    ).toBe('objective must be written on one line.');
    expect(tool.validateToolParams({ objective })).toBeNull();
  });

  it('prints each recovery command as a complete final line', () => {
    for (const message of [
      formatProposeGoalRecoveryNotStarted(objective),
      formatProposeGoalRecoveryFailed(objective),
    ]) {
      expect(message.split('\n').at(-1)).toBe(`/goal set ${objective}`);
      expect(message.match(/\/goal/g)).toHaveLength(1);
    }
  });

  it('keeps what the Goal tools cost every request inside a budget', () => {
    // get_goal and update_goal are registered in every session, Goal or not,
    // so their schemas ride along with every model request. The figure is
    // what the three tools cost today plus room for a sentence; growing past
    // it should be a decision, not drift.
    const tools = [
      new GetGoalTool(makeConfig({ getGoalForWorker: vi.fn() })),
      new UpdateGoalTool(makeConfig({})),
      new ProposeGoalTool(proposeConfig(idleRuntime().runtime)),
    ];
    const advertised = tools
      .map(
        (tool) =>
          tool.description + JSON.stringify(tool.schema.parametersJsonSchema),
      )
      .join('');

    expect(advertised.length).toBeLessThan(3_600);
  });

  it('shows the objective in a plain-text info dialog and parks it on approval', async () => {
    const { runtime, host } = idleRuntime();
    const config = proposeConfig(runtime);
    const tool = new ProposeGoalTool(config);

    const { invocation, details } = await confirm(
      tool,
      ToolConfirmationOutcome.ProceedOnce,
    );
    expect(details.type).toBe('info');
    if (details.type !== 'info') return;
    expect(details.renderPromptAsPlainText).toBe(true);
    expect(details.hideAlwaysAllow).toBe(true);
    expect(details.prompt).toContain('Set this as the session Goal?');
    expect(details.prompt).toContain(objective);

    const result = await execute(invocation);
    expect(result.error).toBeUndefined();
    const payload = JSON.parse(result.llmContent as string);
    expect(payload.approved).toBe(true);
    expect(payload.objective).toBe(objective);
    expect(payload.next).toContain('the moment this turn ends');
    expect(result.returnDisplay).toContain('Goal approved');

    // Parked, not set: setting it mid-turn would strip the rest of the
    // proposing turn of its Goal permit. The client applies it at the
    // turn boundary (see applyPendingGoalProposal below).
    expect(config.setPendingGoalProposal).toHaveBeenCalledTimes(1);
    expect(config.pending()).toEqual({
      objective,
      turnKey: 'user-turn-key',
      reviewedGoal: null,
    });
    expect(runtime.getSnapshot().goal).toBeNull();
    expect(host.started).toHaveLength(0);

    const applied = await applyPendingGoalProposal(runtime, config.pending()!);
    expect(applied.applied).toBe(true);
    if (!applied.applied) return;
    const goal = runtime.getSnapshot().goal;
    expect(goal?.goalId).toBe(applied.goal.goalId);
    expect(goal?.status).toBe('active');
    expect(goal?.objective).toBe(objective);
    // The runtime, not the tool, drives the first Goal turn.
    expect(host.started).toHaveLength(1);
  });

  it('does not silently replace an already approved pending proposal', async () => {
    const { runtime } = idleRuntime();
    const config = proposeConfig(runtime);
    const tool = new ProposeGoalTool(config);
    const firstObjective = 'Outcome: ship the first approved Goal.';
    const secondObjective = 'Outcome: ship a different Goal.';

    const first = await confirm(tool, ToolConfirmationOutcome.ProceedOnce, {
      objective: firstObjective,
    });
    const second = await confirm(tool, ToolConfirmationOutcome.ProceedOnce, {
      objective: secondObjective,
    });

    expect(await execute(first.invocation)).not.toHaveProperty('error');
    const secondResult = await execute(second.invocation);

    expect(secondResult.error?.type).toBe(ToolErrorType.EXECUTION_DENIED);
    expect(config.pending()?.objective).toBe(firstObjective);
    await expect(
      tool
        .build({ objective: 'Outcome: ask a third time.' })
        .getConfirmationDetails(new AbortController().signal),
    ).rejects.toThrow(PROPOSE_GOAL_PENDING_MESSAGE);
  });

  it('refuses when the parking slot is taken between the re-check and the park', async () => {
    // Two approved invocations in one turn can both pass the
    // hasPendingGoalProposal() re-check before either parks; the set-once
    // slot refuses the second, and execute() must surface that refusal
    // instead of reporting "approved".
    const { runtime, host } = idleRuntime();
    const config = proposeConfig(runtime, {
      hasPendingGoalProposal: () => false,
      setPendingGoalProposal: vi.fn(() => false),
    });
    const tool = new ProposeGoalTool(config);

    const { invocation } = await confirm(
      tool,
      ToolConfirmationOutcome.ProceedOnce,
    );
    const result = await execute(invocation);

    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_DENIED);
    expect(result.llmContent).toBe(PROPOSE_GOAL_PENDING_MESSAGE);
    expect(config.setPendingGoalProposal).toHaveBeenCalledTimes(1);
    expect(runtime.getSnapshot().goal).toBeNull();
    expect(host.started).toHaveLength(0);
  });

  it('refuses to park an approval it cannot bind to a turn', async () => {
    const { runtime, host } = idleRuntime();
    const config = proposeConfig(runtime);
    const tool = new ProposeGoalTool(config);
    const { invocation } = await confirm(
      tool,
      ToolConfirmationOutcome.ProceedOnce,
    );

    // No scheduler prompt-id context: the settle boundary could not tell this
    // approval apart from a stale one, so it is refused instead of parked.
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_DENIED);
    expect(result.llmContent).toBe(PROPOSE_GOAL_NO_TURN_MESSAGE);
    expect(config.setPendingGoalProposal).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().goal).toBeNull();
    expect(host.started).toHaveLength(0);
  });

  it('refuses if a host runs it anyway after a cancelled dialog', async () => {
    const { runtime, host } = idleRuntime();
    const config = proposeConfig(runtime);
    const tool = new ProposeGoalTool(config);

    // On the real path the scheduler settles a cancelled confirmation without
    // entering `execute()` at all -- that path is pinned by 'forwards the host
    // denial reason when a bounced edit confirmation is cancelled' in
    // coreToolScheduler.test.ts. What is checked here is the guard that stays
    // for a host which runs `execute()` anyway: the decline must refuse rather
    // than fall through to parking an approval.
    const { invocation } = await confirm(tool, ToolConfirmationOutcome.Cancel);
    const result = await execute(invocation);

    expect(config.setPendingGoalProposal).not.toHaveBeenCalled();
    expect(config.pending()).toBeUndefined();
    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_DENIED);
    // Not the bare 'The Goal was not set' prefix: PROPOSE_GOAL_NO_TURN_MESSAGE
    // shares it, so only this fragment tells the two refusal branches apart.
    expect(String(result.llmContent)).toContain('the user did not approve it');
    expect(runtime.getSnapshot().goal).toBeNull();
    expect(host.started).toHaveLength(0);
  });

  it('refuses before the dialog in plan mode, in an untrusted folder, and without persistence', async () => {
    const { runtime } = idleRuntime();
    const signal = new AbortController().signal;

    await expect(
      new ProposeGoalTool(
        proposeConfig(runtime, { getApprovalMode: () => ApprovalMode.PLAN }),
      )
        .build({ objective })
        .getConfirmationDetails(signal),
    ).rejects.toThrow(PROPOSE_GOAL_PLAN_MODE_MESSAGE);

    await expect(
      new ProposeGoalTool(
        proposeConfig(runtime, { isTrustedFolder: () => false }),
      )
        .build({ objective })
        .getConfirmationDetails(signal),
    ).rejects.toThrow(PROPOSE_GOAL_UNTRUSTED_MESSAGE);

    await expect(
      new ProposeGoalTool(
        proposeConfig(() => {
          throw new Error('no persistence');
        }),
      )
        .build({ objective })
        .getConfirmationDetails(signal),
    ).rejects.toThrow(PROPOSE_GOAL_UNAVAILABLE_MESSAGE);

    expect(runtime.getSnapshot().goal).toBeNull();
  });

  it('refuses before the dialog when Goal persistence failed to become ready', async () => {
    const { runtime } = idleRuntime();
    const config = proposeConfig(runtime);
    Object.assign(config, {
      getGoalRuntimeReady: vi
        .fn()
        .mockRejectedValue(new Error('restore failed')),
    });

    await expect(
      new ProposeGoalTool(config)
        .build({ objective })
        .getConfirmationDetails(new AbortController().signal),
    ).rejects.toThrow(PROPOSE_GOAL_UNAVAILABLE_MESSAGE);
  });

  it('refuses to replace an active Goal and points at /goal edit', async () => {
    const { runtime } = await activeRuntime();
    const tool = new ProposeGoalTool(proposeConfig(runtime));

    await expect(
      tool
        .build({ objective })
        .getConfirmationDetails(new AbortController().signal),
    ).rejects.toThrow('/goal edit');
    expect(runtime.getSnapshot().goal?.objective).toBe('Ship Goal v3');
  });

  it('rechecks the active Goal after the dialog before parking approval', async () => {
    const { runtime } = idleRuntime();
    const config = proposeConfig(runtime);
    const { invocation } = await confirm(
      new ProposeGoalTool(config),
      ToolConfirmationOutcome.ProceedOnce,
    );
    await runtime.dispatch({ action: 'create', objective: 'Typed by hand' });

    const result = await execute(invocation);

    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_DENIED);
    expect(config.pending()).toBeUndefined();
    expect(runtime.getSnapshot().goal?.objective).toBe('Typed by hand');
  });

  describe.each(['before approval', 'before settlement'] as const)(
    'rejects a changed reviewed target %s',
    (phase) => {
      it.each(['create', 'edit', 'replace', 'clear'] as const)(
        'preserves the result of a concurrent %s',
        async (action) => {
          const { runtime, host } = idleRuntime();
          const pauseCurrent = async () => {
            const current = runtime.getSnapshot().goal!;
            await runtime.dispatch({
              action: 'pause',
              expectedGoalId: current.goalId,
              expectedRevision: current.revision,
            });
          };
          if (action !== 'create') {
            await runtime.dispatch({ action: 'create', objective: 'Original' });
            await pauseCurrent();
          }
          const config = proposeConfig(runtime);
          const invocation = new ProposeGoalTool(config).build({ objective });
          const details = await invocation.getConfirmationDetails(
            new AbortController().signal,
          );
          if (phase === 'before settlement') {
            await details.onConfirm(ToolConfirmationOutcome.ProceedOnce);
            expect((await execute(invocation)).error).toBeUndefined();
          }

          if (action === 'create') {
            await runtime.dispatch({ action, objective: 'Concurrent' });
            await pauseCurrent();
          } else {
            const current = runtime.getSnapshot().goal!;
            const version = {
              expectedGoalId: current.goalId,
              expectedRevision: current.revision,
            };
            await runtime.dispatch(
              action === 'clear'
                ? { action, ...version }
                : { action, objective: 'Concurrent', ...version },
            );
            if (action === 'replace') await pauseCurrent();
          }
          const changed = runtime.getSnapshot().goal;
          const startedBefore = host.started.length;

          if (phase === 'before approval') {
            await details.onConfirm(ToolConfirmationOutcome.ProceedOnce);
            const result = await execute(invocation);
            expect(result.error?.type).toBe(ToolErrorType.EXECUTION_DENIED);
            expect(result.llmContent).toContain('changed after the proposal');
            expect(config.pending()).toBeUndefined();
          } else {
            const result = await applyPendingGoalProposal(
              runtime,
              config.pending()!,
            );
            expect(result).toMatchObject({
              applied: false,
              kind: 'changed',
              reason: expect.stringContaining('changed after the proposal'),
            });
          }
          expect(runtime.getSnapshot().goal).toEqual(changed);
          expect(host.started).toHaveLength(startedBefore);
        },
      );
    },
  );

  it('replaces a stopped Goal when the parked approval is applied', async () => {
    const { runtime, host } = idleRuntime();
    await runtime.dispatch({ action: 'create', objective: 'Ship Goal v3' });
    const paused = runtime.getSnapshot().goal!;
    await runtime.dispatch({
      action: 'pause',
      expectedGoalId: paused.goalId,
      expectedRevision: paused.revision,
    });
    expect(runtime.getSnapshot().goal?.status).toBe('paused');
    const startedBefore = host.started.length;
    const config = proposeConfig(runtime);
    const tool = new ProposeGoalTool(config);

    const { invocation, details } = await confirm(
      tool,
      ToolConfirmationOutcome.ProceedOnce,
    );
    if (details.type !== 'info') throw new Error('expected info');
    expect(details.prompt).toContain('Replace the paused Goal');

    const result = await execute(invocation);
    const payload = JSON.parse(result.llmContent as string);
    expect(payload.replacesGoalId).toBe(paused.goalId);
    expect(config.pending()?.reviewedGoal).toEqual({
      goalId: paused.goalId,
      revision: paused.revision,
    });
    expect(runtime.getSnapshot().goal?.goalId).toBe(paused.goalId);

    const applied = await applyPendingGoalProposal(runtime, config.pending()!);
    expect(applied).toMatchObject({ applied: true });
    const goal = runtime.getSnapshot().goal;
    expect(goal?.goalId).not.toBe(paused.goalId);
    expect(goal?.status).toBe('active');
    expect(goal?.objective).toBe(objective);
    expect(host.started.length).toBe(startedBefore + 1);
  });

  it('does not set a parked approval over a Goal that became active meanwhile', async () => {
    const { runtime } = idleRuntime();
    const config = proposeConfig(runtime);
    const tool = new ProposeGoalTool(config);
    const { invocation } = await confirm(
      tool,
      ToolConfirmationOutcome.ProceedOnce,
    );
    await execute(invocation);

    // The user typed `/goal set …` before the proposing turn ended.
    await runtime.dispatch({ action: 'create', objective: 'Typed by hand' });

    const applied = await applyPendingGoalProposal(runtime, config.pending()!);
    expect(applied.applied).toBe(false);
    if (applied.applied) return;
    expect(applied.kind).toBe('changed');
    expect(applied.reason).toContain('became active');
    expect(runtime.getSnapshot().goal?.objective).toBe('Typed by hand');
  });

  it('does not replace a paused Goal resumed ahead of the proposal dispatch', async () => {
    const { runtime } = idleRuntime();
    await runtime.dispatch({ action: 'create', objective: 'Paused by user' });
    const original = runtime.getSnapshot().goal!;
    await runtime.dispatch({
      action: 'pause',
      expectedGoalId: original.goalId,
      expectedRevision: original.revision,
    });

    const resumed = runtime.dispatch({
      action: 'resume',
      expectedGoalId: original.goalId,
      expectedRevision: original.revision,
    });
    const applied = applyPendingGoalProposal(runtime, {
      objective,
      turnKey: 'user-turn-key',
      reviewedGoal: { goalId: original.goalId, revision: original.revision },
    });

    await expect(resumed).resolves.toMatchObject({
      snapshot: {
        goal: {
          goalId: original.goalId,
          revision: original.revision,
          status: 'active',
        },
      },
    });
    await expect(applied).resolves.toMatchObject({
      applied: false,
      kind: 'changed',
    });
    expect(runtime.getSnapshot().goal).toMatchObject({
      goalId: original.goalId,
      objective: 'Paused by user',
      status: 'active',
    });
  });

  it('reports a conflict instead of throwing when the expected version moved', async () => {
    const { runtime } = idleRuntime();
    await runtime.dispatch({ action: 'create', objective: 'Ship Goal v3' });
    const first = runtime.getSnapshot().goal!;
    await runtime.dispatch({
      action: 'pause',
      expectedGoalId: first.goalId,
      expectedRevision: first.revision,
    });
    const paused = runtime.getSnapshot().goal!;
    const stale = {
      getSnapshot: () => ({
        ...runtime.getSnapshot(),
        goal: { ...paused, revision: paused.revision - 1 },
      }),
      dispatch: runtime.dispatch.bind(runtime),
    };

    const applied = await applyPendingGoalProposal(stale, {
      objective,
      turnKey: 'user-turn-key',
      reviewedGoal: { goalId: paused.goalId, revision: paused.revision - 1 },
    });
    expect(applied.applied).toBe(false);
    if (applied.applied) return;
    expect(applied.kind).toBe('changed');
    expect(runtime.getSnapshot().goal?.goalId).toBe(paused.goalId);
  });
});
