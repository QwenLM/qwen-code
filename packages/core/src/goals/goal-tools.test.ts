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
  GetGoalTool,
  UpdateGoalTool,
  type GoalToolConfig,
} from './goal-tools.js';
import { goalTurnContext } from './goal-turn-context.js';
import {
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

  it('returns only the bounded worker view for the captured permit', async () => {
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
        createdAt: 10,
        updatedAt: 20,
      },
    };
    const getGoalForWorker = vi.fn().mockResolvedValue({
      goalId: 'goal-1',
      revision: 3,
      objective: 'Ship Goal v3',
      evidenceCursor: { recordId: 'cursor-1' },
      evidenceCatalog: {
        entries: [
          {
            uuid: 'evidence-1',
            provenance: 'tool_result',
            turnId: 'turn-4',
            preview: '12 tests passed',
            proofKind: 'external_fact',
          },
        ],
        lineageTurnIds: ['turn-4'],
      },
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
      evidenceCatalog: {
        entries: [
          {
            uuid: 'evidence-1',
            provenance: 'tool_result',
            turnId: 'turn-4',
            preview: '12 tests passed',
            proofKind: 'external_fact',
          },
        ],
        lineageTurnIds: ['turn-4'],
      },
      verifierFeedback: 'retry: missing edge case',
    });
    expect(String(result.llmContent)).not.toContain('must not leak');
    expect(result.returnDisplay).toBe('Active goal · revision 3');
  });
});

describe('UpdateGoalTool', () => {
  it('exposes the exact evidence and non-terminal response contract', () => {
    const tool = new UpdateGoalTool(makeConfig({}));
    const schema = tool.schema.parametersJsonSchema as {
      properties: {
        reason: { maxLength?: number };
        evidenceRefs: {
          description?: string;
          items?: { description?: string };
          maxItems?: number;
        };
        blockerKind: { description?: string };
      };
    };

    expect(tool.description).toContain('call get_goal in the current turn');
    expect(tool.description).toContain('evidenceCatalog.entries[].uuid');
    expect(tool.description).toContain(
      'never goalId, turnId, or lineageTurnIds',
    );
    expect(tool.description).toContain(
      'Do not tell the user the Goal is complete',
    );
    expect(tool.description).toContain(
      'call get_goal, wait for its result, and call update_goal in a later model step',
    );
    expect(tool.description).not.toContain('in that same response');
    expect(tool.description).toContain(
      'Do not add progress or completion commentary',
    );
    expect(tool.description).toContain(
      'end the turn without additional user-facing text',
    );
    expect(tool.description).not.toContain(
      'say the proposal is awaiting independent verification',
    );
    expect(schema.properties.evidenceRefs.description).toContain(
      'evidenceCatalog.entries[].uuid',
    );
    expect(schema.properties.evidenceRefs.items?.description).toContain(
      'not a turnId',
    );
    expect(schema.properties.evidenceRefs.maxItems).toBe(100);
    expect(schema.properties.reason.maxLength).toBe(
      GOAL_PROPOSAL_REASON_MAX_CHARACTERS,
    );
    expect(schema.properties.blockerKind.description).toContain(
      'three consecutive Goal turns',
    );
    expect(schema.properties.blockerKind.description).toContain(
      'exact same reason text',
    );
  });

  it('rejects lineage turn ids before recording a proposal', async () => {
    const recordTerminalProposal = vi.fn();
    const getGoalForWorker = vi.fn().mockResolvedValue({
      goalId: permit.goalId,
      revision: permit.revision,
      objective: 'Reply test until the user types qqq',
      evidenceCursor: { recordId: 'goal-created' },
      evidenceCatalog: {
        entries: [
          {
            uuid: 'user-input-qqq',
            provenance: 'real_user',
            turnId: permit.turnId,
            preview: 'qqq',
            proofKind: 'user_input',
          },
        ],
        lineageTurnIds: [permit.turnId],
      },
    });
    const getSnapshotForPermit = vi.fn(() => ({
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: permit.goalId,
        revision: permit.revision,
        objective: 'Reply test until the user types qqq',
        status: 'active' as const,
        evidenceCursor: { recordId: 'goal-created' },
        turnCount: 3,
        activeTimeMs: 100,
        createdAt: 1,
        updatedAt: 2,
      },
    }));
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
        reason: 'The user typed qqq',
        evidenceRefs: [permit.turnId],
      }),
    );

    const result = await invocation.execute(new AbortController().signal);

    expect(JSON.parse(String(result.llmContent))).toEqual({
      proposalRecorded: false,
      readyForVerification: false,
      goalLifecycleChanged: false,
      invalidEvidenceRefs: [permit.turnId],
      error:
        'evidenceRefs must use values from the latest get_goal evidenceCatalog.entries[].uuid; call get_goal and retry. Do not use goalId, turnId, or lineageTurnIds.',
    });
    expect(result.returnDisplay).toBe(
      'Goal proposal was not recorded because its evidence is not current. Read the current Goal and retry.',
    );
    expect(result.returnDisplay).not.toContain('turnId');
    expect(result.returnDisplay).not.toContain('uuid');
    expect(recordTerminalProposal).not.toHaveBeenCalled();
  });

  it('rejects completion that omits current delivered output', async () => {
    const recordTerminalProposal = vi.fn();
    const getGoalForWorker = vi.fn().mockResolvedValue({
      goalId: permit.goalId,
      revision: permit.revision,
      objective: 'Output ZQPX one character per turn',
      evidenceCursor: { recordId: 'goal-created' },
      evidenceCatalog: {
        entries: [
          {
            uuid: 'tool-result-1',
            provenance: 'tool_result',
            turnId: 'turn-1',
            preview: 'tests passed',
            proofKind: 'external_fact',
          },
          {
            uuid: 'letter-x',
            provenance: 'assistant_output',
            turnId: permit.turnId,
            preview: 'X',
            proofKind: 'delivered_output',
          },
        ],
        lineageTurnIds: ['turn-1', permit.turnId],
      },
    });
    const getSnapshotForPermit = vi.fn(() => ({
      v: 2 as const,
      activity: 'running' as const,
      goal: {
        goalId: permit.goalId,
        revision: permit.revision,
        objective: 'Output ZQPX one character per turn',
        status: 'active' as const,
        evidenceCursor: { recordId: 'goal-created' },
        turnCount: 3,
        activeTimeMs: 100,
        createdAt: 1,
        updatedAt: 2,
      },
    }));
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
        reason: 'All characters were delivered',
        evidenceRefs: ['tool-result-1'],
      }),
    );

    const result = await invocation.execute(new AbortController().signal);

    expect(JSON.parse(String(result.llmContent))).toEqual({
      proposalRecorded: false,
      readyForVerification: false,
      goalLifecycleChanged: false,
      uncitedCurrentDeliveredOutput: ['letter-x'],
      error:
        'The completion proposal omitted delivered output from the current Goal turn. Call get_goal after delivering the final output, then retry update_goal with the returned evidenceCatalog UUIDs.',
    });
    expect(recordTerminalProposal).not.toHaveBeenCalled();
  });

  it('rejects completion when the evidence catalog is truncated', async () => {
    const recordTerminalProposal = vi.fn();
    const runtime = {
      getGoalForWorker: vi.fn().mockResolvedValue({
        goalId: permit.goalId,
        revision: permit.revision,
        objective: 'Ship Goal v3',
        evidenceCursor: { recordId: 'goal-created' },
        evidenceCatalog: {
          entries: [
            {
              uuid: 'output',
              provenance: 'assistant_output',
              turnId: permit.turnId,
              preview: 'done',
              proofKind: 'delivered_output',
            },
          ],
          lineageTurnIds: [permit.turnId],
          truncated: true,
        },
      }),
      getSnapshotForPermit: vi.fn(() => ({
        v: 2 as const,
        activity: 'running' as const,
        goal: {
          goalId: permit.goalId,
          revision: permit.revision,
          objective: 'Ship Goal v3',
          status: 'active' as const,
          evidenceCursor: { recordId: 'goal-created' },
          turnCount: 1,
          activeTimeMs: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      })),
      recordTerminalProposal,
    };
    const invocation = goalTurnContext.run(permit, () =>
      new UpdateGoalTool(makeConfig(runtime)).build({
        status: 'complete',
        reason: 'done',
        evidenceRefs: ['output'],
      }),
    );

    const result = await invocation.execute(new AbortController().signal);

    expect(JSON.parse(String(result.llmContent))).toMatchObject({
      proposalRecorded: false,
      readyForVerification: false,
      error: expect.stringContaining('not provably exhaustive'),
    });
    expect(recordTerminalProposal).not.toHaveBeenCalled();
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
          'Continue this turn without claiming the Goal is complete or blocked. A repeated-blocker audit requires the same blocker mode and exact same reason text across three consecutive Goal turns, with current evidence cited on each turn.',
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

  it('requires a non-empty reason and stable evidence references', () => {
    const { runtime } = {
      runtime: {} as GoalRuntime,
    };
    const tool = new UpdateGoalTool(makeConfig(runtime));

    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'complete',
          reason: 'x'.repeat(GOAL_PROPOSAL_REASON_MAX_CHARACTERS),
          evidenceRefs: ['evidence-1'],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'complete',
          reason: 'é'.repeat(GOAL_PROPOSAL_REASON_MAX_BYTES / 2),
          evidenceRefs: ['evidence-1'],
        }),
      ),
    ).not.toThrow();
    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'complete',
          reason: '   ',
          evidenceRefs: ['evidence-1'],
        }),
      ),
    ).toThrow(/reason/i);
    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'blocked',
          reason: 'Waiting for authority',
          evidenceRefs: [],
        }),
      ),
    ).toThrow(/evidence/i);
    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'blocked',
          reason: 'Waiting for authority',
          evidenceRefs: ['   '],
        }),
      ),
    ).toThrow(/evidence/i);
    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'complete',
          reason: 'Focused tests passed',
          evidenceRefs: ['same-reference', ' same-reference '],
        }),
      ),
    ).toThrow('evidenceRefs must contain unique stable evidence references');
    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'complete',
          reason: 'x'.repeat(GOAL_PROPOSAL_REASON_MAX_CHARACTERS + 1),
          evidenceRefs: ['evidence-1'],
        }),
      ),
    ).toThrow(/characters/i);
    expect(() =>
      goalTurnContext.run(permit, () =>
        tool.build({
          status: 'complete',
          reason: '界'.repeat(
            Math.floor(GOAL_PROPOSAL_REASON_MAX_BYTES / 3) + 1,
          ),
          evidenceRefs: ['evidence-1'],
        }),
      ),
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
