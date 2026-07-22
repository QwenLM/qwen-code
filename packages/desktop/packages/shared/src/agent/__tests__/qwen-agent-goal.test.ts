import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GoalControlRequest, GoalSnapshotV2 } from '../../protocol/dto.ts';
import {
  parseQwenGoalSnapshotV2,
  QwenAgent,
  QWEN_GOAL_CONTROL_METHOD,
  QWEN_GOAL_GET_METHOD,
} from '../qwen-agent.ts';

type BackendConfig = ConstructorParameters<typeof QwenAgent>[0];

const snapshot: GoalSnapshotV2 = {
  v: 2,
  goal: {
    goalId: 'goal-1',
    revision: 3,
    objective: 'Ship Goal v3',
    status: 'active',
    evidenceCursor: { recordId: 'record-1' },
    turnCount: 2,
    activeTimeMs: 4_000,
    createdAt: 1_000,
    updatedAt: 5_000,
  },
  activity: 'running',
};

function createAgent(): QwenAgent {
  const cwd = mkdtempSync(join(tmpdir(), 'qwen-agent-goal-'));
  return new QwenAgent({
    provider: 'qwen',
    workspace: {
      id: 'workspace-qwen',
      name: 'Qwen Workspace',
      slug: 'qwen-workspace',
      rootPath: cwd,
      createdAt: Date.now(),
    },
    session: {
      id: 'desktop-session',
      sdkSessionId: 'qwen-session',
      name: 'Qwen Session',
      workspaceRootPath: cwd,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      permissionMode: 'ask',
    },
    isHeadless: true,
  } as BackendConfig);
}

describe('QwenAgent Goal protocol v2', () => {
  it('accepts authoritative running snapshots and rejects legacy projections', () => {
    expect(parseQwenGoalSnapshotV2(snapshot)).toEqual(snapshot);
    expect(
      parseQwenGoalSnapshotV2({
        active: { condition: 'legacy', iterations: 1, setAt: 1 },
      }),
    ).toBeUndefined();
  });

  it('publishes session_update _meta.goalState outside an active prompt', () => {
    const agent = createAgent();
    const updates: GoalSnapshotV2[] = [];
    agent.onGoalStateChange = (value) => {
      updates.push(value);
    };

    (
      agent as unknown as {
        handleSessionUpdate(params: unknown): void;
      }
    ).handleSessionUpdate({
      sessionId: 'qwen-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: { goalState: snapshot },
      },
    });

    expect(updates).toEqual([snapshot]);
  });

  it('uses the Goal get and control ext methods with exact session concurrency fields', async () => {
    const agent = createAgent();
    const calls: Array<{ method: string; params: Record<string, unknown> }> =
      [];
    const internals = agent as unknown as {
      qwenSessionId: string | null;
      ensureProcess(): Promise<void>;
      ensureQwenSession(): Promise<void>;
      callAcp<T>(
        method: string,
        execute: (connection: {
          extMethod(
            method: string,
            params: Record<string, unknown>,
          ): Promise<unknown>;
        }) => Promise<T>,
      ): Promise<T>;
    };
    internals.qwenSessionId = 'qwen-session';
    internals.ensureProcess = async () => {};
    internals.ensureQwenSession = async () => {};
    internals.callAcp = async (_method, execute) =>
      execute({
        extMethod: async (method, params) => {
          calls.push({ method, params });
          return method === QWEN_GOAL_GET_METHOD
            ? { active: {}, goalState: snapshot }
            : { snapshot };
        },
      });

    expect(await agent.getGoalState()).toEqual(snapshot);

    const request: GoalControlRequest = {
      action: 'pause',
      expectedGoalId: 'goal-1',
      expectedRevision: 3,
    };
    expect(await agent.controlGoal(request)).toEqual({ snapshot });
    expect(calls).toEqual([
      {
        method: QWEN_GOAL_GET_METHOD,
        params: { sessionId: 'qwen-session' },
      },
      {
        method: QWEN_GOAL_CONTROL_METHOD,
        params: { sessionId: 'qwen-session', request },
      },
    ]);
  });

  it('rejects explicit reads when the ACP Goal method is unsupported', async () => {
    const agent = createAgent();
    const internals = agent as unknown as {
      qwenSessionId: string | null;
      ensureProcess(): Promise<void>;
      ensureQwenSession(): Promise<void>;
      callAcp<T>(
        method: string,
        execute: (connection: {
          extMethod(method: string, params: unknown): Promise<unknown>;
        }) => Promise<T>,
      ): Promise<T>;
    };
    internals.qwenSessionId = 'qwen-session';
    internals.ensureProcess = async () => {};
    internals.ensureQwenSession = async () => {};
    internals.callAcp = async (_method, execute) =>
      execute({
        extMethod: async () => {
          throw new Error('Method not found: qwen/control/session/goal/get');
        },
      });

    await expect(agent.getGoalState()).rejects.toThrow(
      'Qwen backend does not support Goal protocol v2',
    );
  });

  it('rejects explicit reads when ACP returns no strict Goal snapshot', async () => {
    const agent = createAgent();
    const internals = agent as unknown as {
      qwenSessionId: string | null;
      ensureProcess(): Promise<void>;
      ensureQwenSession(): Promise<void>;
      callAcp<T>(
        method: string,
        execute: (connection: {
          extMethod(method: string, params: unknown): Promise<unknown>;
        }) => Promise<T>,
      ): Promise<T>;
    };
    internals.qwenSessionId = 'qwen-session';
    internals.ensureProcess = async () => {};
    internals.ensureQwenSession = async () => {};
    internals.callAcp = async (_method, execute) =>
      execute({ extMethod: async () => ({ active: null }) });

    await expect(agent.getGoalState()).rejects.toThrow(
      'Qwen backend does not support Goal protocol v2',
    );
  });

  it('rejects a control when authoritative Goal persistence fails', async () => {
    const agent = createAgent();
    const internals = agent as unknown as {
      qwenSessionId: string | null;
      ensureProcess(): Promise<void>;
      ensureQwenSession(): Promise<void>;
      callAcp<T>(
        method: string,
        execute: (connection: {
          extMethod(method: string, params: unknown): Promise<unknown>;
        }) => Promise<T>,
      ): Promise<T>;
    };
    internals.qwenSessionId = 'qwen-session';
    internals.ensureProcess = async () => {};
    internals.ensureQwenSession = async () => {};
    internals.callAcp = async (_method, execute) =>
      execute({ extMethod: async () => ({ snapshot }) });
    agent.onGoalStateChange = async () => {
      throw new Error('Goal persistence failed');
    };

    await expect(
      agent.controlGoal({
        action: 'pause',
        expectedGoalId: 'goal-1',
        expectedRevision: 3,
      }),
    ).rejects.toThrow('Goal persistence failed');
  });
});
