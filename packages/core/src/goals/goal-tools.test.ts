/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { ToolDisplayNames, ToolNames } from '../tools/tool-names.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import {
  createGoalRuntime,
  type GoalJournal,
  type GoalRuntime,
  type GoalTurnHost,
} from './goal-runtime.js';
import { GetGoalTool, UpdateGoalTool } from './goal-tools.js';
import { goalTurnContext } from './goal-turn-context.js';
import type {
  GoalStateRecordPayloadV2,
  GoalTurnPermit,
  TranscriptCursor,
} from './goal-protocol.js';

const permit: GoalTurnPermit = {
  goalId: 'goal-1',
  revision: 3,
  turnId: 'turn-4',
};

function makeConfig(runtime: Partial<GoalRuntime>) {
  return {
    getGoalRuntime: vi.fn(() => runtime as GoalRuntime),
  } as unknown as Config;
}

function fakeGoalJournal(): GoalJournal {
  return {
    getTranscriptCursor(): TranscriptCursor {
      return { recordId: null };
    },
    async recordGoalState(
      recordUuid: string,
      payload: GoalStateRecordPayloadV2,
    ): Promise<ChatRecord> {
      return {
        uuid: recordUuid,
        parentUuid: null,
        sessionId: 'session-1',
        timestamp: new Date(0).toISOString(),
        type: 'system',
        subtype: 'goal_state',
        provenance: 'goal_control',
        cwd: '/tmp',
        version: 'test',
        systemPayload: payload,
      };
    },
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
    } as unknown as Config;
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
      fullTranscript: ['must not leak'],
    });
    const getSnapshot = vi.fn(() => structuredClone(snapshot));
    const tool = new GetGoalTool(makeConfig({ getGoalForWorker, getSnapshot }));
    const invocation = goalTurnContext.run(permit, () => tool.build({}));

    const result = await invocation.execute(new AbortController().signal);

    expect(invocation.getDescription()).toBe('Read the current goal');
    expect(getGoalForWorker).toHaveBeenCalledWith(permit);
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
        evidenceRefs: {
          description?: string;
          items?: { description?: string };
        };
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
      'call get_goal in that same response before update_goal',
    );
    expect(tool.description).toContain(
      'Do not add progress or completion commentary',
    );
    expect(schema.properties.evidenceRefs.description).toContain(
      'evidenceCatalog.entries[].uuid',
    );
    expect(schema.properties.evidenceRefs.items?.description).toContain(
      'not a turnId',
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
    const getSnapshot = vi.fn(() => ({
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
      makeConfig({ getGoalForWorker, getSnapshot, recordTerminalProposal }),
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

  it('rejects stale delivered-output evidence before recording a proposal', async () => {
    const recordTerminalProposal = vi.fn();
    const getGoalForWorker = vi.fn().mockResolvedValue({
      goalId: permit.goalId,
      revision: permit.revision,
      objective: 'Output ZQPX one character per turn',
      evidenceCursor: { recordId: 'goal-created' },
      evidenceCatalog: {
        entries: [
          {
            uuid: 'letter-z',
            provenance: 'assistant_output',
            turnId: 'turn-1',
            preview: 'Z',
            proofKind: 'delivered_output',
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
    const getSnapshot = vi.fn(() => ({
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
      makeConfig({ getGoalForWorker, getSnapshot, recordTerminalProposal }),
    );
    const invocation = goalTurnContext.run(permit, () =>
      tool.build({
        status: 'complete',
        reason: 'All characters were delivered',
        evidenceRefs: ['letter-z'],
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
          evidenceRefs: ['same-reference', 'same-reference'],
        }),
      ),
    ).toThrow(/unique|duplicate/i);
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
    const config = { getGoalRuntime } as unknown as Config;
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

  it.each(['missing snapshot API', 'mismatched session snapshot'] as const)(
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
        ...(scenario === 'mismatched session snapshot'
          ? {
              getSnapshot: vi.fn(() => ({
                v: 2 as const,
                activity: 'running' as const,
                goal: {
                  goalId: 'new-goal',
                  revision: 1,
                  objective: 'new session',
                  status: 'active' as const,
                  evidenceCursor: { recordId: 'new-cursor' },
                  turnCount: 0,
                  activeTimeMs: 0,
                  createdAt: 1,
                  updatedAt: 1,
                },
              })),
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
