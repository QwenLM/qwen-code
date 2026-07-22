import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, Message } from '@craft-agent/core/types';
import type { AgentBackend } from '@craft-agent/shared/agent/backend';
import type { Workspace } from '@craft-agent/shared/config';
import type {
  GoalControlRequest,
  GoalSnapshotV2,
  SessionEvent,
} from '@craft-agent/shared/protocol';
import {
  loadSession,
  listSessions,
  sessionPersistenceQueue,
  writeSessionJsonl,
  type StoredSession,
} from '@craft-agent/shared/sessions';
import { createManagedSession, SessionManager } from './SessionManager.ts';

type TestManagedSession = ReturnType<typeof createManagedSession>;

const workspace: Workspace = {
  id: 'workspace-goal',
  name: 'Goal workspace',
  slug: 'goal-workspace',
  rootPath: '/tmp/goal-workspace',
  createdAt: 1,
};

const snapshot: GoalSnapshotV2 = {
  v: 2,
  goal: {
    goalId: 'goal-1',
    revision: 4,
    objective: 'Ship Desktop Goal v3',
    status: 'active',
    evidenceCursor: { recordId: null },
    turnCount: 2,
    activeTimeMs: 3_000,
    createdAt: 1_000,
    updatedAt: 4_000,
  },
  activity: 'idle',
};

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

function addSession(
  manager: SessionManager,
  managed: TestManagedSession,
): void {
  (
    manager as unknown as { sessions: Map<string, TestManagedSession> }
  ).sessions.set(managed.id, managed);
}

describe('SessionManager Goal protocol v2', () => {
  it('forwards authoritative reads and exact concurrency controls to the backend', async () => {
    const manager = new SessionManager();
    const requests: GoalControlRequest[] = [];
    const agent = {
      getGoalState: async () => snapshot,
      controlGoal: async (request: GoalControlRequest) => {
        requests.push(request);
        return { snapshot };
      },
    } as unknown as AgentBackend;
    addSession(
      manager,
      createManagedSession({ id: 'session-goal' }, workspace, { agent }),
    );

    const request: GoalControlRequest = {
      action: 'pause',
      expectedGoalId: 'goal-1',
      expectedRevision: 4,
    };

    expect(await manager.getSessionGoalState('session-goal')).toEqual(snapshot);
    expect(await manager.controlSessionGoal('session-goal', request)).toEqual({
      snapshot,
    });
    expect(requests).toEqual([request]);
  });

  it('fails clearly when the backend does not support Goal controls', async () => {
    const manager = new SessionManager();
    addSession(
      manager,
      createManagedSession({ id: 'session-unsupported' }, workspace, {
        agent: {} as AgentBackend,
      }),
    );

    await expect(
      manager.getSessionGoalState('session-unsupported'),
    ).rejects.toThrow('This session backend does not support Goals');
    await expect(
      manager.controlSessionGoal('session-unsupported', {
        action: 'create',
        objective: 'Unsupported',
      }),
    ).rejects.toThrow('This session backend does not support Goals');
  });

  it('does not project or broadcast a Goal snapshot when strict persistence fails', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'goal-persist-first-'));
    tempRoots.push(workspaceRoot);
    const localWorkspace: Workspace = {
      ...workspace,
      id: 'workspace-persist-first',
      rootPath: workspaceRoot,
    };
    const previous: GoalSnapshotV2 = {
      ...snapshot,
      goal: snapshot.goal
        ? { ...snapshot.goal, revision: 3, status: 'paused' }
        : null,
    };
    const sessionId = 'session-persist-first';
    const sessionDirectory = join(workspaceRoot, 'sessions', sessionId);
    mkdirSync(sessionDirectory, { recursive: true });
    writeSessionJsonl(join(sessionDirectory, 'session.jsonl'), {
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      createdAt: 1,
      lastUsedAt: 1,
      goalState: previous,
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    } satisfies StoredSession);

    const manager = new SessionManager();
    const managed = createManagedSession(
      { id: sessionId, goalState: previous },
      localWorkspace,
      { messagesLoaded: true },
    );
    addSession(manager, managed);
    const projected: SessionEvent[] = [];
    manager.setEventSink((_channel, _target, event: SessionEvent) => {
      projected.push(event);
    });
    const internals = manager as unknown as {
      processEvent(session: TestManagedSession, event: AgentEvent): Promise<void>;
    };
    const originalFlushOrThrow = sessionPersistenceQueue.flushOrThrow;
    sessionPersistenceQueue.flushOrThrow = async (id: string) => {
      sessionPersistenceQueue.cancel(id);
      throw new Error('disk unavailable');
    };

    let failure: unknown;
    try {
      await internals.processEvent(managed, {
        type: 'goal_state',
        snapshot,
      });
    } catch (error) {
      failure = error;
    } finally {
      sessionPersistenceQueue.cancel(sessionId);
      sessionPersistenceQueue.flushOrThrow = originalFlushOrThrow;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('disk unavailable');
    expect(managed.goalState).toEqual(previous);
    expect(projected.filter((event) => event.type === 'goal_state')).toEqual([]);
    expect(listSessions(workspaceRoot)[0]?.goalState).toEqual(previous);
  });

  it('persists transient Goal activity as idle while keeping the live state', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'goal-transient-'));
    tempRoots.push(workspaceRoot);
    const localWorkspace: Workspace = {
      ...workspace,
      id: 'workspace-transient',
      rootPath: workspaceRoot,
    };
    const sessionId = 'session-transient';
    const sessionDirectory = join(workspaceRoot, 'sessions', sessionId);
    mkdirSync(sessionDirectory, { recursive: true });
    writeSessionJsonl(join(sessionDirectory, 'session.jsonl'), {
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      createdAt: 1,
      lastUsedAt: 1,
      goalState: snapshot,
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    } satisfies StoredSession);
    const manager = new SessionManager();
    const managed = createManagedSession(
      { id: sessionId, goalState: snapshot },
      localWorkspace,
      { messagesLoaded: true },
    );
    addSession(manager, managed);
    const projected: SessionEvent[] = [];
    manager.setEventSink((_channel, _target, event: SessionEvent) => {
      projected.push(event);
    });
    const running = { ...snapshot, activity: 'running' as const };
    const internals = manager as unknown as {
      processEvent(session: TestManagedSession, event: AgentEvent): Promise<void>;
    };
    await internals.processEvent(managed, {
      type: 'goal_state',
      snapshot: running,
    });
    await sessionPersistenceQueue.flushOrThrow(sessionId);
    expect(managed.goalState).toEqual(running);
    expect(
      projected.find((event) => event.type === 'goal_state'),
    ).toMatchObject({ snapshot: running });
    expect(listSessions(workspaceRoot)[0]?.goalState).toEqual(snapshot);
  });

  it('keeps an inspected existing Goal unchanged when strict persistence fails', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'goal-inspect-failure-'));
    tempRoots.push(workspaceRoot);
    const localWorkspace: Workspace = {
      ...workspace,
      id: 'workspace-inspect-failure',
      rootPath: workspaceRoot,
    };
    const previous: GoalSnapshotV2 = {
      ...snapshot,
      goal: snapshot.goal
        ? { ...snapshot.goal, revision: 3, status: 'paused' }
        : null,
    };
    const sessionId = 'session-inspect-failure';
    const sessionDirectory = join(workspaceRoot, 'sessions', sessionId);
    mkdirSync(sessionDirectory, { recursive: true });
    writeSessionJsonl(join(sessionDirectory, 'session.jsonl'), {
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      sdkCwd: workspaceRoot,
      workingDirectory: workspaceRoot,
      llmConnection: 'qwen-code',
      createdAt: 1,
      lastUsedAt: 1,
      goalState: previous,
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    } satisfies StoredSession);
    const manager = new SessionManager();
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: workspaceRoot,
        workingDirectory: workspaceRoot,
        name: 'New chat',
        llmConnection: 'qwen-code',
        goalState: previous,
      },
      localWorkspace,
      { messagesLoaded: true },
    );
    addSession(manager, managed);
    const inspectedMessages: Message[] = [
      {
        id: 'message-1',
        role: 'user',
        content: 'Inspect Goal',
        timestamp: 2,
      },
    ];
    const internals = manager as unknown as {
      upsertExternalListedSession(args: unknown): Promise<boolean>;
    };
    const originalFlushOrThrow = sessionPersistenceQueue.flushOrThrow;
    sessionPersistenceQueue.flushOrThrow = async (id: string) => {
      sessionPersistenceQueue.cancel(id);
      throw new Error('inspect disk unavailable');
    };

    let failure: unknown;
    try {
      await internals.upsertExternalListedSession({
        workspace: localWorkspace,
        info: {
          sessionId,
          cwd: workspaceRoot,
          title: 'New chat',
          updatedAt: new Date(2).toISOString(),
        },
        connectionSlug: 'qwen-code',
        defaultPermissionMode: 'ask',
        defaultThinkingLevel: 'medium',
        loadMessages: async () => ({
          messages: inspectedMessages,
          goalState: snapshot,
        }),
      });
    } catch (error) {
      failure = error;
    } finally {
      sessionPersistenceQueue.cancel(sessionId);
      sessionPersistenceQueue.flushOrThrow = originalFlushOrThrow;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('inspect disk unavailable');
    expect(managed.goalState).toEqual(previous);
    expect(listSessions(workspaceRoot)[0]?.goalState).toEqual(previous);
  });

  it('persists a discovered Goal when importing a new provider session', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'goal-import-success-'));
    tempRoots.push(workspaceRoot);
    const localWorkspace: Workspace = {
      ...workspace,
      id: 'workspace-import-success',
      rootPath: workspaceRoot,
    };
    const sessionId = 'session-import-success';
    const manager = new SessionManager();
    const internals = manager as unknown as {
      upsertExternalListedSession(args: unknown): Promise<boolean>;
    };

    await internals.upsertExternalListedSession({
      workspace: localWorkspace,
      info: {
        sessionId,
        cwd: workspaceRoot,
        title: 'New chat',
        updatedAt: new Date(2).toISOString(),
      },
      connectionSlug: 'qwen-code',
      defaultPermissionMode: 'ask',
      defaultThinkingLevel: 'medium',
      loadMessages: async () => ({
        messages: [],
        goalState: snapshot,
      }),
    });
    await sessionPersistenceQueue.flushAll();

    expect(
      manager.getSessions(localWorkspace.id).find((item) => item.id === sessionId)
        ?.goalState,
    ).toEqual(snapshot);
    const persisted = loadSession(workspaceRoot, sessionId);
    expect(persisted?.sdkSessionId).toBe(sessionId);
    expect(persisted?.thinkingLevel).toBe('medium');
    expect(persisted?.messages).toEqual([]);
    expect(persisted?.goalState).toEqual(snapshot);
  });

  it('does not leave a partial empty-message import when Goal persistence fails', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'goal-import-failure-'));
    tempRoots.push(workspaceRoot);
    const localWorkspace: Workspace = {
      ...workspace,
      id: 'workspace-import-failure',
      rootPath: workspaceRoot,
    };
    const sessionId = 'session-import-failure';
    const manager = new SessionManager();
    const internals = manager as unknown as {
      upsertExternalListedSession(args: unknown): Promise<boolean>;
    };
    const queue = sessionPersistenceQueue as unknown as {
      writer?: (session: StoredSession) => Promise<void>;
    };
    const originalWriter = queue.writer;
    queue.writer = async () => {
      throw new Error('import disk unavailable');
    };

    let failure: unknown;
    try {
      await internals.upsertExternalListedSession({
        workspace: localWorkspace,
        info: {
          sessionId,
          cwd: workspaceRoot,
          title: 'New chat',
          updatedAt: new Date(2).toISOString(),
        },
        connectionSlug: 'qwen-code',
        defaultPermissionMode: 'ask',
        defaultThinkingLevel: 'medium',
        loadMessages: async () => ({ messages: [], goalState: snapshot }),
      });
    } catch (error) {
      failure = error;
    } finally {
      queue.writer = originalWriter;
    }
    await sessionPersistenceQueue.flushAll();

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('import disk unavailable');
    expect(
      manager.getSessions(localWorkspace.id).some((item) => item.id === sessionId),
    ).toBe(false);
    expect(listSessions(workspaceRoot)).toEqual([]);
  });

  it('persists a Goal returned with an empty provider message load', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'goal-empty-load-'));
    tempRoots.push(workspaceRoot);
    const localWorkspace: Workspace = {
      ...workspace,
      id: 'workspace-empty-load',
      rootPath: workspaceRoot,
    };
    const sessionId = 'session-empty-load';
    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          loadSessionMessages: async () => ({ messages: [], goalState: snapshot }),
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: workspaceRoot,
        workingDirectory: workspaceRoot,
        llmConnection: 'qwen-code',
      },
      localWorkspace,
      { messagesLoaded: true },
    );
    addSession(manager, managed);
    const sessionDirectory = join(workspaceRoot, 'sessions', sessionId);
    mkdirSync(sessionDirectory, { recursive: true });
    writeSessionJsonl(join(sessionDirectory, 'session.jsonl'), {
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      sdkCwd: workspaceRoot,
      workingDirectory: workspaceRoot,
      llmConnection: 'qwen-code',
      createdAt: 1,
      lastUsedAt: 1,
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    } satisfies StoredSession);
    const internals = manager as unknown as {
      loadExternalSessionMessages(
        session: TestManagedSession,
      ): Promise<string>;
    };

    expect(await internals.loadExternalSessionMessages(managed)).toBe('empty');
    await sessionPersistenceQueue.flushAll();

    expect(managed.goalState).toEqual(snapshot);
    expect(listSessions(workspaceRoot)[0]?.goalState).toEqual(snapshot);
  });
});
