import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend } from '@craft-agent/shared/agent/backend';
import type { Workspace } from '@craft-agent/shared/config';
import { RPC_CHANNELS, type FileAttachment } from '@craft-agent/shared/protocol';
import {
  loadSession,
  saveSession,
  sessionPersistenceQueue,
} from '@craft-agent/shared/sessions';
import { saveWorkspaceConfig } from '@craft-agent/shared/workspaces';
import type { AgentEvent, Message } from '@craft-agent/core/types';
import {
  createManagedSession,
  SessionManager,
  setSessionPlatform,
} from './SessionManager.ts';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

setSessionPlatform({
  appRootPath: process.cwd(),
  resourcesPath: process.cwd(),
  isPackaged: false,
  appVersion: 'test',
  imageProcessor: {
    getMetadata: async () => null,
    process: async (input) =>
      Buffer.isBuffer(input) ? input : Buffer.from(''),
  },
  logger,
  isDebugMode: false,
});

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  expect(condition()).toBe(true);
}

describe('Qwen native history loading', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('deduplicates concurrent agent creation for one managed session', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    tempRoots.push(workspaceRoot);

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    };
    const managed = createManagedSession(
      {
        id: '260508-concurrent-agent',
        lastMessageAt: Date.now(),
        permissionMode: 'allow-all',
      },
      workspace,
    );
    type TestManagedSession = ReturnType<typeof createManagedSession>;
    const manager = new SessionManager();
    const fakeAgent = {
      dispose: () => {},
      destroy: () => {},
    } as unknown as AgentBackend;
    let createCalls = 0;

    const managerInternals = manager as unknown as {
      createAgentForManagedSession: (
        session: TestManagedSession,
      ) => Promise<AgentBackend>;
      getOrCreateAgent: (session: TestManagedSession) => Promise<AgentBackend>;
    };

    managerInternals.createAgentForManagedSession = async (session) => {
      createCalls += 1;
      await Promise.resolve();
      session.agent = fakeAgent;
      return fakeAgent;
    };

    const getOrCreateAgent = managerInternals.getOrCreateAgent.bind(manager);

    const [firstAgent, secondAgent] = await Promise.all([
      getOrCreateAgent(managed),
      getOrCreateAgent(managed),
    ]);

    expect(createCalls).toBe(1);
    expect(firstAgent).toBe(fakeAgent);
    expect(secondAgent).toBe(fakeAgent);
  });

  it('hides unresolved stripped Qwen canonical mirrors from session lists', () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    tempRoots.push(workspaceRoot);

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    };
    const unresolvedSdkSessionId = '8390af4d-5db6-4e4c-b7e8-040d002690c7';
    const placeholderSdkSessionId = 'bbc6bd08-a4f7-4b50-b605-51dbe51ea2de';
    const resolvedSdkSessionId = '12eb7d24-4c31-4ff5-8a9b-f243f9fd1b28';
    const manager = new SessionManager();

    const unresolved = createManagedSession(
      {
        id: unresolvedSdkSessionId,
        sdkSessionId: unresolvedSdkSessionId,
        llmConnection: 'qwen-code',
      },
      workspace,
    );
    const placeholder = createManagedSession(
      {
        id: placeholderSdkSessionId,
        sdkSessionId: placeholderSdkSessionId,
        name: '新聊天',
        messageCount: 0,
        llmConnection: 'qwen-code',
      },
      workspace,
    );
    const resolved = createManagedSession(
      {
        id: resolvedSdkSessionId,
        sdkSessionId: resolvedSdkSessionId,
        name: 'Qwen code 现在有心跳机制吗',
        lastMessageAt: Date.parse('2026-05-08T09:30:02.013Z'),
        llmConnection: 'qwen-code',
      },
      workspace,
    );

    (
      manager as unknown as { sessions: Map<string, typeof unresolved> }
    ).sessions.set(unresolved.id, unresolved);
    (
      manager as unknown as { sessions: Map<string, typeof placeholder> }
    ).sessions.set(placeholder.id, placeholder);
    (
      manager as unknown as { sessions: Map<string, typeof resolved> }
    ).sessions.set(resolved.id, resolved);

    expect(
      manager.getSessions(workspace.id).map((session) => session.id),
    ).toEqual([resolvedSdkSessionId]);
  });

  it('lists provider-native sessions from the workspace default working directory', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'));
    tempRoots.push(workspaceRoot, projectRoot);

    const sessionId = 'fd2803fd-1070-41da-b7c0-10d978f7128c';
    const createdTimestamp = Date.parse('2026-04-26T09:58:00.000Z');
    const timestamp = Date.parse('2026-04-26T10:12:13.000Z');
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        permissionMode: 'allow-all',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    let listCalls = 0;
    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          listSessions: async (options?: { cwd?: string }) => {
            listCalls += 1;
            expect(options?.cwd).toBe(projectRoot);
            return {
              sessions: [
                {
                  sessionId,
                  cwd: projectRoot,
                  title: 'qwen native conversation',
                  createdAt: new Date(createdTimestamp).toISOString(),
                  updatedAt: new Date(timestamp).toISOString(),
                },
              ],
            };
          },
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });

    const pushedEvents: Array<{
      channel: string;
      target: unknown;
      args: unknown[];
    }> = [];
    manager.setEventSink((channel, target, ...args) => {
      pushedEvents.push({ channel, target, args });
    });

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };

    await (
      manager as unknown as {
        doRefreshExternalSessionsForWorkspace: (
          workspace: Workspace,
        ) => Promise<void>;
      }
    ).doRefreshExternalSessionsForWorkspace(workspace);

    const imported = loadSession(workspaceRoot, sessionId) as ReturnType<
      typeof loadSession
    > | null;
    expect(listCalls).toBe(1);
    expect(imported?.workspaceRootPath).toBe(workspaceRoot);
    expect(imported?.sdkCwd).toBeUndefined();
    expect(imported?.workingDirectory).toBeUndefined();
    expect(imported?.name).toBeUndefined();
    expect(imported?.permissionMode).toBeUndefined();
    expect(imported?.llmConnection).toBeUndefined();
    expect(imported?.connectionLocked).toBeUndefined();
    expect(imported?.createdAt).toBeUndefined();
    expect(imported?.lastUsedAt).toBeUndefined();
    expect(imported?.lastMessageAt).toBeUndefined();
    expect(
      (
        imported as
          | (ReturnType<typeof loadSession> & {
              messageCount?: number;
            })
          | null
      )?.messageCount,
    ).toBeUndefined();
    expect(imported?.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    });

    const header = JSON.parse(
      readFileSync(
        join(workspaceRoot, 'sessions', sessionId, 'session.jsonl'),
        'utf8',
      ).split('\n')[0],
    ) as Record<string, unknown>;
    expect(header).not.toHaveProperty('sdkCwd');
    expect(header).not.toHaveProperty('workingDirectory');
    expect(header).not.toHaveProperty('name');
    expect(header).not.toHaveProperty('tokenUsage');

    const [listed] = manager.getSessions(workspace.id) as Array<{
      sdkCwd?: string;
      workingDirectory?: string;
      name?: string;
      createdAt?: number;
      lastUsedAt?: number;
      lastMessageAt?: number;
    }>;
    expect(listed?.sdkCwd).toBe(projectRoot);
    expect(listed?.workingDirectory).toBe(projectRoot);
    expect(listed?.name).toBe('qwen native conversation');
    expect(listed?.createdAt).toBe(createdTimestamp);
    expect(listed?.lastUsedAt).toBe(timestamp);
    expect(listed?.lastMessageAt).toBe(timestamp);
    expect(pushedEvents).toContainEqual({
      channel: RPC_CHANNELS.sessions.LIST_CHANGED,
      target: { to: 'all' },
      args: [workspace.id],
    });
  });

  it('does not persist existing Qwen provider metadata during list refresh', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'));
    tempRoots.push(workspaceRoot, projectRoot);

    const sessionId = 'fd2803fd-1070-41da-b7c0-10d978f7128c';
    const timestamp = Date.parse('2026-04-26T10:12:13.000Z');
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          listSessions: async () => ({
            sessions: [
              {
                sessionId,
                cwd: projectRoot,
                title: 'qwen native conversation',
                updatedAt: new Date(timestamp).toISOString(),
              },
            ],
          }),
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: projectRoot,
        workingDirectory: projectRoot,
        name: 'qwen native conversation',
        createdAt: timestamp,
        lastUsedAt: timestamp,
        lastMessageAt: timestamp,
        llmConnection: 'qwen-code',
        thinkingLevel: 'medium',
      },
      workspace,
    );
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    const queue = sessionPersistenceQueue as unknown as {
      enqueue: (session: unknown) => void;
    };
    const originalEnqueue = queue.enqueue;
    let enqueueCalls = 0;
    queue.enqueue = () => {
      enqueueCalls += 1;
    };

    try {
      await (
        manager as unknown as {
          doRefreshExternalSessionsForWorkspace: (
            workspace: Workspace,
          ) => Promise<void>;
        }
      ).doRefreshExternalSessionsForWorkspace(workspace);
    } finally {
      queue.enqueue = originalEnqueue;
    }

    expect(enqueueCalls).toBe(0);
    expect(managed.lastUsedAt).toBe(timestamp);
    expect(managed.lastMessageAt).toBe(timestamp);
  });

  it('does not clear Qwen provider titles from stripped local headers', () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'));
    tempRoots.push(workspaceRoot, projectRoot);

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: Date.now(),
    };
    const manager = new SessionManager();
    const managed = createManagedSession(
      {
        id: '260531-qwen-title',
        sdkSessionId: '260531-qwen-title',
        sdkCwd: projectRoot,
        workingDirectory: projectRoot,
        name: 'Qwen generated summary',
        llmConnection: 'qwen-code',
        lastMessageAt: Date.now(),
      },
      workspace,
    );

    const changed = (
      manager as unknown as {
        applyExternalSessionMetadata: (
          session: typeof managed,
          header: { name?: string },
        ) => boolean;
      }
    ).applyExternalSessionMetadata(managed, {});

    expect(changed).toBe(false);
    expect(managed.name).toBe('Qwen generated summary');
  });

  it('removes provider-native mirrors once a Craft session owns the same SDK session ID', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'));
    tempRoots.push(workspaceRoot, projectRoot);

    const craftSessionId = '260429-dynamic-crystal';
    const sdkSessionId = '07db68e4-c974-4720-9a30-b089cd2665d5';
    const olderTimestamp = Date.parse('2026-04-29T01:40:50.344Z');
    const newerTimestamp = Date.parse('2026-04-29T03:41:13.728Z');

    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: olderTimestamp,
      updatedAt: newerTimestamp,
    });

    await saveSession({
      id: craftSessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId,
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      name: '无敌',
      createdAt: newerTimestamp - 30_000,
      lastUsedAt: newerTimestamp,
      lastMessageAt: newerTimestamp,
      permissionMode: 'allow-all',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
      messages: [
        {
          id: 'local-user',
          type: 'user',
          content: '/compact',
          timestamp: newerTimestamp - 10_000,
        },
        {
          id: 'local-info',
          type: 'info',
          content: 'Response interrupted',
          timestamp: newerTimestamp,
        },
      ],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    });

    await saveSession({
      id: sdkSessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId,
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      name: '无敌',
      createdAt: olderTimestamp - 30_000,
      lastUsedAt: olderTimestamp,
      lastMessageAt: olderTimestamp,
      permissionMode: 'ask',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
      messages: [
        {
          id: 'mirror-user',
          type: 'user',
          content: '/compact',
          timestamp: olderTimestamp - 1_000,
        },
        {
          id: 'mirror-assistant',
          type: 'assistant',
          content: 'done',
          timestamp: olderTimestamp,
        },
      ],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    });

    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          listSessions: async () => ({
            sessions: [
              {
                sessionId: sdkSessionId,
                cwd: projectRoot,
                title: '无敌',
                updatedAt: new Date(olderTimestamp).toISOString(),
              },
            ],
          }),
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: olderTimestamp,
    };
    const craftManaged = createManagedSession(
      {
        id: craftSessionId,
        sdkSessionId,
        sdkCwd: projectRoot,
        workingDirectory: projectRoot,
        name: '无敌',
        createdAt: newerTimestamp - 30_000,
        lastUsedAt: newerTimestamp,
        lastMessageAt: newerTimestamp,
        messageCount: 2,
        llmConnection: 'qwen-code',
        connectionLocked: true,
        model: 'qwen3-coder-flash',
        thinkingLevel: 'medium',
      },
      workspace,
    );
    const mirrorManaged = createManagedSession(
      {
        id: sdkSessionId,
        sdkSessionId,
        sdkCwd: projectRoot,
        workingDirectory: projectRoot,
        name: '无敌',
        createdAt: olderTimestamp - 30_000,
        lastUsedAt: olderTimestamp,
        lastMessageAt: olderTimestamp,
        messageCount: 2,
        llmConnection: 'qwen-code',
        connectionLocked: true,
        model: 'qwen3-coder-flash',
        thinkingLevel: 'medium',
      },
      workspace,
    );
    (
      manager as unknown as { sessions: Map<string, typeof craftManaged> }
    ).sessions.set(craftSessionId, craftManaged);
    (
      manager as unknown as { sessions: Map<string, typeof mirrorManaged> }
    ).sessions.set(sdkSessionId, mirrorManaged);

    await (
      manager as unknown as {
        doRefreshExternalSessionsForWorkspace: (
          workspace: Workspace,
        ) => Promise<void>;
      }
    ).doRefreshExternalSessionsForWorkspace(workspace);

    const sessions = manager.getSessions(workspace.id);
    expect(sessions.map((session) => session.id)).not.toContain(craftSessionId);
    expect(sessions.map((session) => session.id)).toContain(sdkSessionId);
    expect(sessions.filter((session) => session.name === '无敌')).toHaveLength(
      1,
    );
    expect(loadSession(workspaceRoot, craftSessionId)).toBeNull();
    expect(loadSession(workspaceRoot, sdkSessionId)?.sdkSessionId).toBe(
      sdkSessionId,
    );
  });

  it('syncs Craft session titles to Qwen custom titles through the provider rename hook', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'));
    tempRoots.push(workspaceRoot, projectRoot);

    const timestamp = Date.parse('2026-04-26T10:12:13.000Z');
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const renameCalls: Array<{
      sessionId: string;
      title: string;
      cwd?: string;
    }> = [];
    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          renameBackendSession: async (
            sessionId: string,
            title: string,
            options?: { cwd?: string },
          ) => {
            renameCalls.push({ sessionId, title, cwd: options?.cwd });
            return true;
          },
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: '260429-fix-session-names',
        name: 'Fix session names',
        sdkSessionId: 'fd2803fd-1070-41da-b7c0-10d978f7128c',
        sdkCwd: projectRoot,
        workingDirectory: projectRoot,
        llmConnection: 'qwen-code',
      },
      workspace,
    );

    await (
      manager as unknown as {
        syncExternalBackendTitleIfSupported: (
          managedSession: unknown,
          title: string,
        ) => Promise<void>;
      }
    ).syncExternalBackendTitleIfSupported(managed, managed.name!);

    expect(renameCalls).toEqual([
      {
        sessionId: 'fd2803fd-1070-41da-b7c0-10d978f7128c',
        title: 'Fix session names',
        cwd: projectRoot,
      },
    ]);
  });

  it('skips placeholder provider-native sessions with no renderable history', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'));
    tempRoots.push(workspaceRoot, projectRoot);

    const sessionId = '4b0597de-374c-42c2-a032-58351d825115';
    const timestamp = Date.parse('2026-04-24T05:41:59.862Z');
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    let loadCalls = 0;
    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          listSessions: async () => ({
            sessions: [
              {
                sessionId,
                cwd: projectRoot,
                title: null,
                updatedAt: new Date(timestamp).toISOString(),
              },
            ],
          }),
          loadSessionMessages: async (
            requestedSessionId: string,
            options?: { cwd?: string },
          ) => {
            loadCalls += 1;
            expect(requestedSessionId).toBe(sessionId);
            expect(options?.cwd).toBe(projectRoot);
            return [];
          },
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };

    await (
      manager as unknown as {
        doRefreshExternalSessionsForWorkspace: (
          workspace: Workspace,
        ) => Promise<void>;
      }
    ).doRefreshExternalSessionsForWorkspace(workspace);

    expect(loadCalls).toBe(1);
    expect(loadSession(workspaceRoot, sessionId)).toBeNull();
    expect(
      manager
        .getSessions(workspace.id)
        .some((session) => session.id === sessionId),
    ).toBe(false);
  });

  it('uses provider-loaded first prompt when listed Qwen title is localized new chat', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'));
    tempRoots.push(workspaceRoot, projectRoot);

    const sessionId = 'fce51ed2-6768-4f67-ac22-c168d0b234de';
    const timestamp = Date.parse('2026-05-08T09:30:02.013Z');
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const nativeMessages: Message[] = [
      {
        id: 'qwen-user-1',
        role: 'user',
        content: 'Git merge main 是不是把 main 分支的改动合并过来？',
        timestamp,
      },
      {
        id: 'qwen-assistant-1',
        role: 'assistant',
        content: '是的。',
        timestamp: timestamp + 1_000,
      },
    ];
    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          listSessions: async () => ({
            sessions: [
              {
                sessionId,
                cwd: projectRoot,
                title: '新聊天',
                createdAt: new Date(timestamp).toISOString(),
                updatedAt: new Date(timestamp + 1_000).toISOString(),
              },
            ],
          }),
          loadSessionMessages: async () => nativeMessages,
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };

    await (
      manager as unknown as {
        doRefreshExternalSessionsForWorkspace: (
          workspace: Workspace,
        ) => Promise<void>;
      }
    ).doRefreshExternalSessionsForWorkspace(workspace);

    const [imported] = manager
      .getSessions(workspace.id)
      .filter((session) => session.id === sessionId);
    const persisted = loadSession(workspaceRoot, sessionId);

    expect(imported?.name).toBe(
      'Git merge main 是不是把 main 分支的改动合并过来？',
    );
    expect(imported?.lastMessageAt).toBe(timestamp + 1_000);
    expect(imported?.messageCount).toBeUndefined();
    expect(persisted?.name).toBeUndefined();
    expect(
      (
        persisted as
          | (ReturnType<typeof loadSession> & { messageCount?: number })
          | null
      )?.messageCount,
    ).toBeUndefined();
  });

  it('applies token usage returned with provider-loaded Qwen history', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'));
    tempRoots.push(workspaceRoot, projectRoot);

    const sessionId = '260602-qwen-token-usage';
    const sdkSessionId = '0f3f06ba-df67-4a4c-8874-e2a9d4afed65';
    const timestamp = Date.parse('2026-06-02T09:30:02.013Z');
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const nativeMessages: Message[] = [
      {
        id: 'qwen-user-1',
        role: 'user',
        content: 'hello',
        timestamp,
      },
      {
        id: 'qwen-assistant-1',
        role: 'assistant',
        content: 'hi',
        timestamp: timestamp + 1_000,
      },
    ];
    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          loadSessionMessages: async () => ({
            messages: nativeMessages,
            tokenUsage: {
              inputTokens: 240,
              outputTokens: 40,
              totalTokens: 240,
              contextTokens: 240,
              costUsd: 0,
              contextWindow: 1_000_000,
            },
          }),
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId,
        name: '新聊天',
        createdAt: timestamp,
        lastUsedAt: timestamp,
        lastMessageAt: timestamp,
        messageCount: 0,
        llmConnection: 'qwen-code',
        thinkingLevel: 'medium',
      },
      workspace,
    );
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    const loaded = await manager.getSession(sessionId);

    expect(loaded?.tokenUsage).toMatchObject({
      inputTokens: 240,
      contextTokens: 240,
      contextWindow: 1_000_000,
    });
  });

  it('does not repeatedly reload empty Qwen canonical history for the same external timestamp', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'));
    tempRoots.push(workspaceRoot, projectRoot);

    const sessionId = '260510-empty-qwen-native';
    const sdkSessionId = '7b4ffd3f-c8ad-4a6d-9b37-3309335bb12c';
    const timestamp = Date.parse('2026-05-09T17:03:17.731Z');
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId,
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      name: 'empty native history',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      permissionMode: 'allow-all',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      thinkingLevel: 'medium',
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    });

    let loadCalls = 0;
    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          loadSessionMessages: async (
            requestedSessionId: string,
            options?: { cwd?: string },
          ) => {
            loadCalls += 1;
            expect(requestedSessionId).toBe(sdkSessionId);
            expect(options?.cwd).toBe(projectRoot);
            return [];
          },
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId,
        sdkCwd: projectRoot,
        workingDirectory: projectRoot,
        name: 'empty native history',
        createdAt: timestamp,
        lastUsedAt: timestamp,
        lastMessageAt: timestamp,
        messageCount: 0,
        llmConnection: 'qwen-code',
        connectionLocked: true,
        thinkingLevel: 'medium',
      },
      workspace,
    );
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    await manager.getSession(sessionId);
    await manager.getSession(sessionId);

    expect(loadCalls).toBe(1);
  });

  it('uses workspace default cwd when opening a stripped Qwen canonical session', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'));
    tempRoots.push(workspaceRoot, projectRoot);

    const sessionId = '260508-你好-2';
    const sdkSessionId = '8390af4d-5db6-4e4c-b7e8-040d002690c7';
    const timestamp = Date.parse('2026-05-08T09:30:02.013Z');
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    let observedCwd: string | undefined;
    const nativeMessages: Message[] = [
      {
        id: 'qwen-user-1',
        role: 'user',
        content: '你好',
        timestamp,
      },
    ];
    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          loadSessionMessages: async (
            _sessionId: string,
            options?: { cwd?: string },
          ) => {
            observedCwd = options?.cwd;
            return nativeMessages;
          },
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId,
        name: '新聊天',
        createdAt: timestamp,
        lastUsedAt: timestamp,
        lastMessageAt: timestamp,
        messageCount: 0,
        llmConnection: 'qwen-code',
        thinkingLevel: 'medium',
      },
      workspace,
    );
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    const loaded = await manager.getSession(sessionId);

    expect(observedCwd).toBe(projectRoot);
    expect(loaded?.messages.map((message) => message.content)).toEqual([
      '你好',
    ]);
    expect(loaded?.messageCount).toBeUndefined();
  });

  it('persists only local visual overlays for Qwen canonical sessions', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    tempRoots.push(workspaceRoot);

    const sessionId = '260602-qwen-visual-overlay';
    const timestamp = Date.parse('2026-06-02T06:06:21.236Z');
    const attachment: NonNullable<Message['attachments']>[number] = {
      id: 'attachment-1',
      type: 'image',
      name: 'rabbit.png',
      mimeType: 'image/png',
      size: 1024,
      storedPath: join(
        workspaceRoot,
        'sessions',
        sessionId,
        'attachments',
        'rabbit.png',
      ),
      thumbnailBase64: 'data:image/png;base64,thumb',
    };
    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        llmConnection: 'qwen-code',
        lastMessageAt: timestamp + 2_000,
        thinkingLevel: 'medium',
      },
      workspace,
      {
        messagesLoaded: true,
        messages: [
          {
            id: 'qwen-user-text',
            role: 'user',
            content: '普通文字',
            timestamp,
          },
          {
            id: 'qwen-user-image',
            role: 'user',
            content: '这个呢',
            timestamp: timestamp + 1_000,
            attachments: [attachment],
          },
          {
            id: 'qwen-assistant-image-preview',
            role: 'assistant',
            content:
              '图1\n\n```image-preview\n{"src":"/tmp/generated.png"}\n```',
            timestamp: timestamp + 2_000,
          },
        ],
      },
    );
    const manager = new SessionManager();
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    (
      manager as unknown as {
        persistSession: (session: typeof managed) => void;
      }
    ).persistSession(managed);
    await manager.flushSession(sessionId);

    const persisted = loadSession(workspaceRoot, sessionId);
    expect(persisted?.messages.map((message) => message.id)).toEqual([
      'qwen-user-image',
      'qwen-assistant-image-preview',
    ]);
    expect(persisted?.messages[0]?.attachments).toEqual([attachment]);
    expect(persisted?.messages[1]?.content).toContain('```image-preview');

    const header = JSON.parse(
      readFileSync(
        join(workspaceRoot, 'sessions', sessionId, 'session.jsonl'),
        'utf8',
      ).split('\n')[0],
    ) as Record<string, unknown>;
    expect(header).not.toHaveProperty('messageCount');
  });

  it('flushes local visual overlays when sending Qwen messages with attachments', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    tempRoots.push(workspaceRoot);

    const sessionId = '260602-qwen-send-visual-overlay';
    const timestamp = Date.now();
    const attachment: NonNullable<Message['attachments']>[number] = {
      id: 'attachment-1',
      type: 'image',
      name: 'subscription.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      storedPath: join(
        workspaceRoot,
        'sessions',
        sessionId,
        'attachments',
        'subscription.jpg',
      ),
      thumbnailBase64: 'data:image/jpeg;base64,thumb',
    };
    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: workspaceRoot,
        workingDirectory: workspaceRoot,
        name: 'existing qwen title',
        llmConnection: 'qwen-code',
        lastMessageAt: timestamp,
      },
      workspace,
      { messagesLoaded: true },
    );
    const manager = new SessionManager();
    const fakeAgent = {
      async *chat(): AsyncGenerator<AgentEvent> {
        yield { type: 'complete' } as AgentEvent;
      },
      getModel: () => 'mimo-v2.5',
      setAllSources: () => {},
      getSessionId: () => sessionId,
      destroy: () => {},
      dispose: () => {},
    } as unknown as AgentBackend;

    const managerInternals = manager as unknown as {
      sessions: Map<string, typeof managed>;
      getOrCreateAgent: (session: typeof managed) => Promise<AgentBackend>;
    };
    managed.externalMessagesLoadedThroughAt = timestamp;
    managerInternals.sessions.set(sessionId, managed);
    managerInternals.getOrCreateAgent = async (session) => {
      session.agent = fakeAgent;
      return fakeAgent;
    };

    let sendError: unknown;
    void manager
      .sendMessage(sessionId, '这个是什么图片', undefined, [attachment])
      .catch((error) => {
        sendError = error;
      });

    await waitUntil(() => {
      const persisted = loadSession(workspaceRoot, sessionId);
      return persisted?.messages[0]?.attachments?.length === 1;
    });

    expect(sendError).toBeUndefined();
    const persisted = loadSession(workspaceRoot, sessionId);
    expect(persisted?.messages).toHaveLength(1);
    expect(persisted?.messages[0]?.content).toBe('这个是什么图片');
    expect(persisted?.messages[0]?.attachments).toEqual([attachment]);
  });

  it('flushes queued local visual overlays for Qwen sessions with attachments', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    tempRoots.push(workspaceRoot);

    const sessionId = '260602-qwen-queued-visual-overlay';
    const timestamp = Date.now();
    const attachment: NonNullable<Message['attachments']>[number] = {
      id: 'attachment-1',
      type: 'image',
      name: 'subscription.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      storedPath: join(
        workspaceRoot,
        'sessions',
        sessionId,
        'attachments',
        'subscription.jpg',
      ),
      thumbnailBase64: 'data:image/jpeg;base64,thumb',
    };
    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: workspaceRoot,
        workingDirectory: workspaceRoot,
        name: 'existing qwen title',
        llmConnection: 'qwen-code',
        lastMessageAt: timestamp,
      },
      workspace,
      { isProcessing: true, messagesLoaded: true },
    );
    const manager = new SessionManager();
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    await manager.sendMessage(sessionId, '这个是什么图片', undefined, [
      attachment,
    ]);

    const persisted = loadSession(workspaceRoot, sessionId);
    expect(persisted?.messages).toHaveLength(1);
    expect(persisted?.messages[0]?.content).toBe('这个是什么图片');
    expect(persisted?.messages[0]?.attachments).toEqual([attachment]);
  });

  it('offers live image attachments to Qwen mid-turn injection', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    tempRoots.push(workspaceRoot);

    const sessionId = '260602-qwen-midturn-live-visual';
    const timestamp = Date.now();
    const liveAttachment: FileAttachment = {
      type: 'image',
      path: join(workspaceRoot, 'subscription.jpg'),
      name: 'subscription.jpg',
      mimeType: 'image/jpeg',
      base64: 'base64-image',
      size: 1024,
    };
    const storedAttachment: NonNullable<Message['attachments']>[number] = {
      id: 'attachment-1',
      type: 'image',
      name: 'subscription.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      storedPath: join(
        workspaceRoot,
        'sessions',
        sessionId,
        'attachments',
        'subscription.jpg',
      ),
      thumbnailBase64: 'data:image/jpeg;base64,thumb',
    };
    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: workspaceRoot,
        workingDirectory: workspaceRoot,
        name: 'existing qwen title',
        llmConnection: 'qwen-code',
        lastMessageAt: timestamp,
      },
      workspace,
      { isProcessing: true, messagesLoaded: true },
    );
    const enqueueCalls: Array<{
      message: string;
      attachments?: FileAttachment[];
      metadata?: { messageId?: string; optimisticMessageId?: string };
    }> = [];
    managed.agent = {
      enqueueMidTurnMessage: (
        message: string,
        attachments?: FileAttachment[],
        metadata?: { messageId?: string; optimisticMessageId?: string },
      ) => {
        enqueueCalls.push({ message, attachments, metadata });
        return true;
      },
      destroy: () => {},
      dispose: () => {},
    } as unknown as AgentBackend;
    const manager = new SessionManager();
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    await manager.sendMessage(
      sessionId,
      '这个是什么图片',
      [liveAttachment],
      [storedAttachment],
      { optimisticMessageId: 'optimistic-1' },
    );

    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]).toEqual({
      message: '这个是什么图片',
      attachments: [liveAttachment],
      metadata: {
        messageId: expect.any(String),
        optimisticMessageId: 'optimistic-1',
      },
    });
    expect(managed.messageQueue[0]?.midTurnPending).toBe(true);
    expect(managed.messageQueue[0]?.attachments).toEqual([liveAttachment]);
    expect(managed.messageQueue[0]?.storedAttachments).toEqual([
      storedAttachment,
    ]);
  });

  it('acknowledges Qwen mid-turn queued messages by messageId', () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    tempRoots.push(workspaceRoot);

    const sessionId = '260602-qwen-midturn-messageid-ack';
    const timestamp = Date.now();
    const storedAttachment: NonNullable<Message['attachments']>[number] = {
      id: 'attachment-1',
      type: 'image',
      name: 'subscription.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      storedPath: join(
        workspaceRoot,
        'sessions',
        sessionId,
        'attachments',
        'subscription.jpg',
      ),
      thumbnailBase64: 'data:image/jpeg;base64,thumb',
    };
    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: workspaceRoot,
        workingDirectory: workspaceRoot,
        name: 'existing qwen title',
        llmConnection: 'qwen-code',
        lastMessageAt: timestamp,
      },
      workspace,
      { isProcessing: true, messagesLoaded: true },
    );
    managed.messages.push({
      id: 'message-1',
      role: 'user',
      content: '这个是什么图片',
      timestamp,
      isQueued: true,
      attachments: [storedAttachment],
    });
    managed.messageQueue.push({
      message: '这个是什么图片',
      storedAttachments: [storedAttachment],
      messageId: 'message-1',
      optimisticMessageId: 'optimistic-1',
      midTurnPending: true,
    });

    const events: unknown[] = [];
    const manager = new SessionManager();
    manager.setEventSink((_channel, _target, event) => {
      events.push(event);
    });
    const onMidTurnMessagesDrained = (
      manager as unknown as {
        createMidTurnMessagesDrainedCallback: (
          managedSession: unknown,
        ) => (messageIds: string[]) => void;
      }
    ).createMidTurnMessagesDrainedCallback(managed);

    onMidTurnMessagesDrained(['message-1']);

    expect(managed.messageQueue).toHaveLength(0);
    expect(managed.messages[0]?.isQueued).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'user_message',
        sessionId,
        status: 'accepted',
        optimisticMessageId: 'optimistic-1',
        workspaceId: workspace.id,
        message: expect.objectContaining({
          id: 'message-1',
          isQueued: false,
        }),
      }),
    );
  });

  it('does not text-match identified Qwen mid-turn queued messages', () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    tempRoots.push(workspaceRoot);

    const sessionId = '260602-qwen-midturn-text-collision';
    const timestamp = Date.now();
    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: workspaceRoot,
        workingDirectory: workspaceRoot,
        name: 'existing qwen title',
        llmConnection: 'qwen-code',
        lastMessageAt: timestamp,
      },
      workspace,
      { isProcessing: true, messagesLoaded: true },
    );
    managed.messageQueue.push(
      {
        message: 'duplicate response',
        messageId: 'message-with-id',
        midTurnPending: true,
      },
      {
        message: 'duplicate response',
        midTurnPending: true,
      },
    );

    const manager = new SessionManager();
    const onMidTurnMessagesDrained = (
      manager as unknown as {
        createMidTurnMessagesDrainedCallback: (
          managedSession: unknown,
        ) => (messageIds: string[]) => void;
      }
    ).createMidTurnMessagesDrainedCallback(managed);

    onMidTurnMessagesDrained(['duplicate response']);

    expect(managed.messageQueue).toHaveLength(1);
    expect(managed.messageQueue[0]?.messageId).toBe('message-with-id');
  });

  it('offers plain text follow-ups to Qwen mid-turn injection after visual messages', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    tempRoots.push(workspaceRoot);

    const sessionId = '260602-qwen-midturn-text-after-visual';
    const timestamp = Date.now();
    const storedAttachment: NonNullable<Message['attachments']>[number] = {
      id: 'attachment-1',
      type: 'image',
      name: 'subscription.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      storedPath: join(
        workspaceRoot,
        'sessions',
        sessionId,
        'attachments',
        'subscription.jpg',
      ),
      thumbnailBase64: 'data:image/jpeg;base64,thumb',
    };
    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: workspaceRoot,
        workingDirectory: workspaceRoot,
        name: 'existing qwen title',
        llmConnection: 'qwen-code',
        lastMessageAt: timestamp,
      },
      workspace,
      { isProcessing: true, messagesLoaded: true },
    );
    const enqueueCalls: Array<{
      message: string;
      attachments?: FileAttachment[];
      metadata?: { messageId?: string; optimisticMessageId?: string };
    }> = [];
    managed.agent = {
      enqueueMidTurnMessage: (
        message: string,
        attachments?: FileAttachment[],
        metadata?: { messageId?: string; optimisticMessageId?: string },
      ) => {
        enqueueCalls.push({ message, attachments, metadata });
        return true;
      },
      destroy: () => {},
      dispose: () => {},
    } as unknown as AgentBackend;
    const manager = new SessionManager();
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    await manager.sendMessage(
      sessionId,
      'also summarize the visible text',
      undefined,
      [storedAttachment],
      { optimisticMessageId: 'optimistic-text' },
    );

    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]).toEqual({
      message: 'also summarize the visible text',
      attachments: undefined,
      metadata: {
        messageId: expect.any(String),
        optimisticMessageId: 'optimistic-text',
      },
    });
    expect(managed.messageQueue[0]?.midTurnPending).toBe(true);
    expect(managed.messageQueue[0]?.storedAttachments).toEqual([
      storedAttachment,
    ]);
  });

  it('keeps image attachments queued when live base64 is unavailable', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    tempRoots.push(workspaceRoot);

    const sessionId = '260602-qwen-midturn-stored-visual';
    const timestamp = Date.now();
    const liveAttachment: FileAttachment = {
      type: 'image',
      path: join(workspaceRoot, 'subscription.jpg'),
      name: 'subscription.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
    };
    const storedAttachment: NonNullable<Message['attachments']>[number] = {
      id: 'attachment-1',
      type: 'image',
      name: 'subscription.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      storedPath: join(
        workspaceRoot,
        'sessions',
        sessionId,
        'attachments',
        'subscription.jpg',
      ),
      thumbnailBase64: 'data:image/jpeg;base64,thumb',
    };
    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: workspaceRoot,
        workingDirectory: workspaceRoot,
        name: 'existing qwen title',
        llmConnection: 'qwen-code',
        lastMessageAt: timestamp,
      },
      workspace,
      { isProcessing: true, messagesLoaded: true },
    );
    const enqueueCalls: string[] = [];
    managed.agent = {
      enqueueMidTurnMessage: (message: string) => {
        enqueueCalls.push(message);
        return true;
      },
      destroy: () => {},
      dispose: () => {},
    } as unknown as AgentBackend;
    const manager = new SessionManager();
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    await manager.sendMessage(
      sessionId,
      '这个是什么图片',
      [liveAttachment],
      [storedAttachment],
      { optimisticMessageId: 'optimistic-1' },
    );

    expect(enqueueCalls).toEqual([]);
    expect(managed.messageQueue[0]?.midTurnPending).toBe(false);
    expect(managed.messageQueue[0]?.attachments).toEqual([liveAttachment]);
    expect(managed.messageQueue[0]?.storedAttachments).toEqual([
      storedAttachment,
    ]);
  });

  it('keeps non-image attachments queued for the next turn', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    tempRoots.push(workspaceRoot);

    const sessionId = '260602-qwen-midturn-pdf';
    const timestamp = Date.now();
    const liveAttachment: FileAttachment = {
      type: 'pdf',
      path: join(workspaceRoot, 'report.pdf'),
      name: 'report.pdf',
      mimeType: 'application/pdf',
      base64: 'base64-pdf',
      size: 1024,
    };
    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: workspaceRoot,
        workingDirectory: workspaceRoot,
        name: 'existing qwen title',
        llmConnection: 'qwen-code',
        lastMessageAt: timestamp,
      },
      workspace,
      { isProcessing: true, messagesLoaded: true },
    );
    const enqueueCalls: string[] = [];
    managed.agent = {
      enqueueMidTurnMessage: (message: string) => {
        enqueueCalls.push(message);
        return true;
      },
      destroy: () => {},
      dispose: () => {},
    } as unknown as AgentBackend;
    const manager = new SessionManager();
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    await manager.sendMessage(sessionId, 'read this pdf', [liveAttachment]);

    expect(enqueueCalls).toEqual([]);
    expect(managed.messageQueue[0]?.midTurnPending).toBe(false);
    expect(managed.messageQueue[0]?.attachments).toEqual([liveAttachment]);
  });

  it('merges local visual overlays into provider-loaded Qwen messages', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'));
    tempRoots.push(workspaceRoot, projectRoot);

    const sessionId = '260602-qwen-visual-restore';
    const timestamp = Date.parse('2026-06-02T06:06:21.236Z');
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const attachment: NonNullable<Message['attachments']>[number] = {
      id: 'attachment-1',
      type: 'image',
      name: 'rabbit.png',
      mimeType: 'image/png',
      size: 1024,
      storedPath: join(
        workspaceRoot,
        'sessions',
        sessionId,
        'attachments',
        'rabbit.png',
      ),
      thumbnailBase64: 'data:image/png;base64,thumb',
    };
    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      thinkingLevel: 'medium',
      messages: [
        {
          id: 'local-user-image',
          type: 'user',
          content: '这个呢',
          timestamp,
          attachments: [attachment],
        },
        {
          id: 'local-assistant-image-preview',
          type: 'assistant',
          content:
            '生成完成\n\n```image-preview\n{"src":"/tmp/generated.png"}\n```',
          timestamp: timestamp + 1_000,
        },
      ],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    });

    const nativeMessages: Message[] = [
      {
        id: 'qwen-user-1',
        role: 'user',
        content: '这个呢',
        timestamp,
      },
      {
        id: 'qwen-assistant-1',
        role: 'assistant',
        content: '生成完成',
        timestamp: timestamp + 1_000,
      },
    ];
    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          loadSessionMessages: async (
            requestedSessionId: string,
            options?: { cwd?: string },
          ) => {
            expect(requestedSessionId).toBe(sessionId);
            expect(options?.cwd).toBe(projectRoot);
            return nativeMessages;
          },
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        lastMessageAt: timestamp + 1_000,
        llmConnection: 'qwen-code',
        thinkingLevel: 'medium',
      },
      workspace,
    );
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    const loaded = await manager.getSession(sessionId);

    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.messages[0]?.id).toBe('qwen-user-1');
    expect(loaded?.messages[0]?.attachments).toEqual([attachment]);
    expect(loaded?.messages[1]?.id).toBe('qwen-assistant-1');
    expect(loaded?.messages[1]?.content).toContain('```image-preview');
    expect(loaded?.messageCount).toBeUndefined();
  });

  it('repairs legacy Qwen sessions with orphaned image attachments', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'));
    tempRoots.push(workspaceRoot, projectRoot);

    const sessionId = '260602-qwen-legacy-orphaned-image';
    const timestamp = Date.now();
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      thinkingLevel: 'medium',
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    });

    const attachmentsDir = join(
      workspaceRoot,
      'sessions',
      sessionId,
      'attachments',
    );
    mkdirSync(attachmentsDir, { recursive: true });
    const attachmentId2 = '22222222-2222-4222-8222-222222222222';
    const imagePath2 = join(
      attachmentsDir,
      `${attachmentId2}_screenshot-2.jpg`,
    );
    const thumbPath2 = join(attachmentsDir, `${attachmentId2}_thumb.png`);
    writeFileSync(imagePath2, Buffer.from('image-2-bytes'));
    writeFileSync(thumbPath2, Buffer.from('thumbnail-2-bytes'));

    const attachmentId1 = '11111111-1111-4111-8111-111111111111';
    const imagePath1 = join(
      attachmentsDir,
      `${attachmentId1}_screenshot-1.jpg`,
    );
    const thumbPath1 = join(attachmentsDir, `${attachmentId1}_thumb.png`);
    writeFileSync(imagePath1, Buffer.from('image-1-bytes'));
    writeFileSync(thumbPath1, Buffer.from('thumbnail-1-bytes'));

    const nativeMessages: Message[] = [
      {
        id: 'qwen-user-1',
        role: 'user',
        content: '这个是什么图片',
        timestamp,
      },
      {
        id: 'qwen-assistant-1',
        role: 'assistant',
        content: '这是你的 Apple 账户订阅页面截图。',
        timestamp: timestamp + 1_000,
      },
    ];
    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          loadSessionMessages: async () => nativeMessages,
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        lastMessageAt: timestamp + 1_000,
        llmConnection: 'qwen-code',
        thinkingLevel: 'medium',
      },
      workspace,
    );
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    const loaded = await manager.getSession(sessionId);

    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.messages[0]?.attachments).toEqual([
      {
        id: attachmentId1,
        type: 'image',
        name: 'screenshot-1.jpg',
        mimeType: 'image/jpeg',
        size: Buffer.from('image-1-bytes').length,
        storedPath: imagePath1,
        thumbnailPath: thumbPath1,
        thumbnailBase64: Buffer.from('thumbnail-1-bytes').toString('base64'),
      },
      {
        id: attachmentId2,
        type: 'image',
        name: 'screenshot-2.jpg',
        mimeType: 'image/jpeg',
        size: Buffer.from('image-2-bytes').length,
        storedPath: imagePath2,
        thumbnailPath: thumbPath2,
        thumbnailBase64: Buffer.from('thumbnail-2-bytes').toString('base64'),
      },
    ]);
    expect(
      loadSession(workspaceRoot, sessionId)?.messages[0]?.attachments,
    ).toHaveLength(2);
  });

  it('removes existing empty placeholder mirrors from provider-native sync', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'));
    tempRoots.push(workspaceRoot, projectRoot);

    const sessionId = '5ed6265d-321d-4dc4-b186-8c69de6e20ba';
    const timestamp = Date.parse('2026-04-24T05:41:59.862Z');
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      name: '(session)',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      permissionMode: 'ask',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    });

    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          listSessions: async () => ({
            sessions: [
              {
                sessionId,
                cwd: projectRoot,
                title: '(session)',
                updatedAt: new Date(timestamp).toISOString(),
              },
            ],
          }),
          loadSessionMessages: async () => [],
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: projectRoot,
        workingDirectory: projectRoot,
        name: '(session)',
        createdAt: timestamp,
        lastUsedAt: timestamp,
        lastMessageAt: timestamp,
        messageCount: 0,
        llmConnection: 'qwen-code',
        connectionLocked: true,
        model: 'qwen3-coder-flash',
        thinkingLevel: 'medium',
      },
      workspace,
    );
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    await (
      manager as unknown as {
        doRefreshExternalSessionsForWorkspace: (
          workspace: Workspace,
        ) => Promise<void>;
      }
    ).doRefreshExternalSessionsForWorkspace(workspace);

    expect(loadSession(workspaceRoot, sessionId)).toBeNull();
    expect(
      manager
        .getSessions(workspace.id)
        .some((session) => session.id === sessionId),
    ).toBe(false);
  });

  it('repairs placeholder mirrors that only captured slash command output', async () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), 'craft-managed-workspace-'),
    );
    const projectRoot = mkdtempSync(join(tmpdir(), 'qwen-code-project-'));
    tempRoots.push(workspaceRoot, projectRoot);

    const sessionId = 'b1e2b1a0-8ea5-4af5-85ba-dff6232c9c02';
    const invocationTimestamp = Date.parse('2026-03-25T07:36:47.100Z');
    const resultTimestamp = Date.parse('2026-03-25T07:36:53.143Z');
    const output =
      'This may take a couple minutes. Sit tight!Insight report generated successfully!';
    saveWorkspaceConfig(workspaceRoot, {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      defaults: {
        defaultLlmConnection: 'qwen-code',
        workingDirectory: projectRoot,
      },
      localMcpServers: { enabled: true },
      createdAt: invocationTimestamp,
      updatedAt: invocationTimestamp,
    });

    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      sdkCwd: projectRoot,
      workingDirectory: projectRoot,
      name: '(session)',
      createdAt: invocationTimestamp,
      lastUsedAt: resultTimestamp,
      lastMessageAt: resultTimestamp,
      permissionMode: 'ask',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
      messages: [
        {
          id: 'old-output',
          type: 'assistant',
          content: output,
          timestamp: resultTimestamp,
        },
      ],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    });

    const nativeMessages: Message[] = [
      {
        id: 'qwen-slash-1',
        role: 'user',
        content: '/insight',
        timestamp: invocationTimestamp,
      },
      {
        id: 'qwen-output-1',
        role: 'assistant',
        content: output,
        timestamp: resultTimestamp,
      },
    ];
    let loadCalls = 0;
    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          listSessions: async () => ({
            sessions: [
              {
                sessionId,
                cwd: projectRoot,
                title: '(session)',
                updatedAt: new Date(resultTimestamp).toISOString(),
              },
            ],
          }),
          loadSessionMessages: async (
            requestedSessionId: string,
            options?: { cwd?: string },
          ) => {
            loadCalls += 1;
            expect(requestedSessionId).toBe(sessionId);
            expect(options?.cwd).toBe(projectRoot);
            return nativeMessages;
          },
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: invocationTimestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: projectRoot,
        workingDirectory: projectRoot,
        name: '(session)',
        createdAt: invocationTimestamp,
        lastUsedAt: resultTimestamp,
        lastMessageAt: resultTimestamp,
        messageCount: 1,
        lastMessageRole: 'assistant',
        llmConnection: 'qwen-code',
        connectionLocked: true,
        model: 'qwen3-coder-flash',
        thinkingLevel: 'medium',
      },
      workspace,
    );
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    await (
      manager as unknown as {
        doRefreshExternalSessionsForWorkspace: (
          workspace: Workspace,
        ) => Promise<void>;
      }
    ).doRefreshExternalSessionsForWorkspace(workspace);

    const repaired = await manager.getSession(sessionId);
    await manager.flushSession(sessionId);

    expect(loadCalls).toBe(1);
    expect(
      repaired?.messages.map((message) => [message.role, message.content]),
    ).toEqual([
      ['user', '/insight'],
      ['assistant', output],
    ]);
    const persisted = loadSession(workspaceRoot, sessionId) as
      | (ReturnType<typeof loadSession> & {
          messageCount?: number;
          preview?: string;
          lastMessageRole?: string;
          lastFinalMessageId?: string;
        })
      | null;
    expect(persisted?.messages).toHaveLength(0);
    expect(persisted?.sdkCwd).toBeUndefined();
    expect(persisted?.workingDirectory).toBeUndefined();
    expect(persisted?.name).toBeUndefined();
    expect(persisted?.createdAt).toBeUndefined();
    expect(persisted?.lastUsedAt).toBeUndefined();
    expect(persisted?.lastMessageAt).toBeUndefined();
    expect(persisted?.llmConnection).toBeUndefined();
    expect(persisted?.connectionLocked).toBeUndefined();
    expect(persisted?.messageCount).toBeUndefined();
    expect(persisted?.preview).toBeUndefined();
    expect(persisted?.lastMessageRole).toBeUndefined();
    expect(persisted?.lastFinalMessageId).toBeUndefined();

    const header = JSON.parse(
      readFileSync(
        join(workspaceRoot, 'sessions', sessionId, 'session.jsonl'),
        'utf8',
      ).split('\n')[0],
    ) as Record<string, unknown>;
    expect(header).not.toHaveProperty('tokenUsage');
  });

  it('backfills an already-loaded empty local session from provider-native history', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-qwen-history-'));
    tempRoots.push(workspaceRoot);

    const sessionId = '43a34475-6e06-4a79-8536-84eb354f6584';
    const timestamp = Date.parse('2026-04-25T05:31:09.794Z');
    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      sdkCwd: workspaceRoot,
      workingDirectory: workspaceRoot,
      name: 'hi again, please reply with pong',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      permissionMode: 'ask',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    });

    const nativeMessages: Message[] = [
      {
        id: 'qwen-1',
        role: 'user',
        content: 'hi again, please reply with pong',
        timestamp,
      },
      {
        id: 'qwen-2',
        role: 'assistant',
        content:
          'The user is just saying hi and asking me to reply with "pong". Simple greeting-like interaction.',
        timestamp: timestamp + 1,
        isIntermediate: true,
      },
      {
        id: 'qwen-3',
        role: 'assistant',
        content: 'pong',
        timestamp: timestamp + 2,
      },
    ];

    let loadCalls = 0;
    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          loadSessionMessages: async (
            requestedSessionId: string,
            options?: { cwd?: string },
          ) => {
            loadCalls += 1;
            expect(requestedSessionId).toBe(sessionId);
            expect(options?.cwd).toBe(workspaceRoot);
            return {
              messages: nativeMessages,
              availableCommands: [
                { name: 'project:fix', description: 'Run project fix' },
              ],
              availableSkills: ['commit'],
            };
          },
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });
    const events: unknown[] = [];
    manager.setEventSink((_channel, _target, event) => {
      events.push(event);
    });

    const workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: workspaceRoot,
        workingDirectory: workspaceRoot,
        name: 'hi again, please reply with pong',
        createdAt: timestamp,
        lastUsedAt: timestamp,
        lastMessageAt: timestamp,
        messageCount: 0,
        llmConnection: 'qwen-code',
        connectionLocked: true,
        model: 'qwen3-coder-flash',
        thinkingLevel: 'medium',
      },
      workspace,
      {
        messagesLoaded: true,
      },
    );
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    const session = await manager.getSession(sessionId);

    expect(loadCalls).toBe(1);
    expect(
      session?.messages.map((message) => [
        message.role,
        message.content,
        message.isIntermediate ?? false,
      ]),
    ).toEqual([
      ['user', 'hi again, please reply with pong', false],
      [
        'assistant',
        'The user is just saying hi and asking me to reply with "pong". Simple greeting-like interaction.',
        true,
      ],
      ['assistant', 'pong', false],
    ]);
    expect(loadSession(workspaceRoot, sessionId)?.messages).toHaveLength(0);
  });

  it('backfills a lazy-loaded empty local session from provider-native history', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-qwen-history-'));
    tempRoots.push(workspaceRoot);

    const sessionId = 'd0dec6b6-5565-42df-a667-9fdb2c1d8893';
    const timestamp = Date.parse('2026-04-24T09:24:14.927Z');
    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      sdkCwd: workspaceRoot,
      workingDirectory: workspaceRoot,
      name: '# Commit and Push...',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      permissionMode: 'ask',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    });

    const nativeMessages: Message[] = [
      { id: 'qwen-1', role: 'user', content: '# Commit and Push', timestamp },
      {
        id: 'qwen-2',
        role: 'assistant',
        content: '按照 `/commit` 流程开始执行。先检查仓库状态。',
        timestamp: timestamp + 1,
      },
      {
        id: 'qwen-3',
        role: 'tool',
        content: 'Running Bash...',
        timestamp: timestamp + 2,
        toolName: 'Bash',
        toolUseId: 'tool-status',
        toolStatus: 'completed',
        toolResult: 'On branch main',
      },
      {
        id: 'qwen-4',
        role: 'assistant',
        content: 'PR 已创建：https://github.com/QwenLM/qwen-code/pull/3593',
        timestamp: timestamp + 3,
      },
    ];

    let loadCalls = 0;
    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          loadSessionMessages: async (
            requestedSessionId: string,
            options?: { cwd?: string },
          ) => {
            loadCalls += 1;
            expect(requestedSessionId).toBe(sessionId);
            expect(options?.cwd).toBe(workspaceRoot);
            return {
              messages: nativeMessages,
              availableCommands: [
                { name: 'project:fix', description: 'Run project fix' },
              ],
              availableSkills: ['commit'],
            };
          },
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });
    const events: unknown[] = [];
    manager.setEventSink((_channel, _target, event) => {
      events.push(event);
    });

    const workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: workspaceRoot,
        workingDirectory: workspaceRoot,
        name: '# Commit and Push...',
        createdAt: timestamp,
        lastUsedAt: timestamp,
        lastMessageAt: timestamp,
        messageCount: 0,
        llmConnection: 'qwen-code',
        connectionLocked: true,
        model: 'qwen3-coder-flash',
        thinkingLevel: 'medium',
      },
      workspace,
    );
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    const session = await manager.getSession(sessionId);

    expect(loadCalls).toBe(1);
    expect(
      session?.messages.map((message) => [
        message.role,
        message.content,
        message.toolName ?? '',
      ]),
    ).toEqual([
      ['user', '# Commit and Push', ''],
      ['assistant', '按照 `/commit` 流程开始执行。先检查仓库状态。', ''],
      ['tool', 'Running Bash...', 'Bash'],
      [
        'assistant',
        'PR 已创建：https://github.com/QwenLM/qwen-code/pull/3593',
        '',
      ],
    ]);
    expect(session?.availableCommands).toEqual([
      { name: 'project:fix', description: 'Run project fix' },
    ]);
    expect(session?.availableSkills).toEqual(['commit']);
    expect(events).toContainEqual({
      type: 'available_commands_update',
      sessionId,
      availableCommands: [
        { name: 'project:fix', description: 'Run project fix' },
      ],
      availableSkills: ['commit'],
      workspaceId: workspace.id,
    });
    const persisted = loadSession(workspaceRoot, sessionId);
    expect(session?.createdAt).toBe(timestamp);
    expect(
      (session as typeof session & { lastUsedAt?: number })?.lastUsedAt,
    ).toBe(timestamp + 3);
    expect(session?.lastMessageAt).toBe(timestamp + 3);
    expect(persisted?.messages).toHaveLength(0);
    expect(persisted?.createdAt).toBeUndefined();
    expect(persisted?.lastUsedAt).toBeUndefined();
    expect(persisted?.lastMessageAt).toBeUndefined();
  });

  it('does not reload Qwen native history between repeated edits of the latest user message', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-qwen-edit-'));
    tempRoots.push(workspaceRoot);

    const sessionId = '1d537f0f-330f-48fc-bfbb-2b9e4c3b5e00';
    const timestamp = Date.parse('2026-05-09T09:00:00.000Z');
    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      sdkCwd: workspaceRoot,
      workingDirectory: workspaceRoot,
      name: 'editable qwen session',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      permissionMode: 'ask',
      llmConnection: 'qwen-code',
      connectionLocked: true,
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    });

    const nativeMessages: Message[] = [
      {
        id: `qwen-${sessionId}-1`,
        role: 'user',
        content: 'first prompt',
        timestamp,
      },
      {
        id: `qwen-${sessionId}-2`,
        role: 'assistant',
        content: 'first answer',
        timestamp: timestamp + 1,
      },
      {
        id: `qwen-${sessionId}-7`,
        role: 'user',
        content: 'second prompt',
        timestamp: timestamp + 2,
      },
    ];

    let loadCalls = 0;
    const manager = new SessionManager({
      createExternalSessionAgent: () =>
        ({
          loadSessionMessages: async () => {
            loadCalls += 1;
            return nativeMessages;
          },
          destroy: () => {},
          dispose: () => {},
        }) as unknown as AgentBackend,
    });

    const workspace: Workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: workspaceRoot,
        workingDirectory: workspaceRoot,
        name: 'editable qwen session',
        createdAt: timestamp,
        lastUsedAt: timestamp,
        lastMessageAt: timestamp,
        messageCount: 0,
        llmConnection: 'qwen-code',
        connectionLocked: true,
      },
      workspace,
    );

    let rewindCalls = 0;
    let chatCalls = 0;
    const activeAgent = {
      rewindToUserTurn: async (targetTurnIndex: number) => {
        rewindCalls += 1;
        expect(targetTurnIndex).toBe(1);
      },
      async *chat(): AsyncGenerator<AgentEvent> {
        chatCalls += 1;
        yield { type: 'complete' } as AgentEvent;
      },
      getModel: () => 'qwen3-coder-flash',
      setAllSources: () => {},
      getSessionId: () => sessionId,
      destroy: () => {},
      dispose: () => {},
    } as unknown as AgentBackend;

    const managerInternals = manager as unknown as {
      sessions: Map<string, typeof managed>;
      getOrCreateAgent: (session: typeof managed) => Promise<AgentBackend>;
    };
    managerInternals.sessions.set(sessionId, managed);
    managerInternals.getOrCreateAgent = async (session) => {
      session.agent = activeAgent;
      return activeAgent;
    };

    await manager.updateMessageContent(
      sessionId,
      `qwen-${sessionId}-7`,
      'second prompt edited once',
    );
    await waitUntil(() => chatCalls === 1 && !managed.isProcessing);
    const firstEditedTimestamp = managed.messages.findLast(
      (message) => message.role === 'user',
    )?.timestamp;
    expect(firstEditedTimestamp).toBeGreaterThan(timestamp + 2);

    await manager.updateMessageContent(
      sessionId,
      `qwen-${sessionId}-7`,
      'second prompt edited twice',
    );
    await waitUntil(() => chatCalls === 2 && !managed.isProcessing);
    const secondEditedTimestamp = managed.messages.findLast(
      (message) => message.role === 'user',
    )?.timestamp;

    expect(loadCalls).toBe(1);
    expect(rewindCalls).toBe(2);
    expect(secondEditedTimestamp).toBeGreaterThan(firstEditedTimestamp ?? 0);
    expect(
      managed.messages.map((message) => [message.role, message.content]),
    ).toEqual([
      ['user', 'first prompt'],
      ['assistant', 'first answer'],
      ['user', 'second prompt edited twice'],
    ]);
  });

  it('uses the built-in Qwen Code connection for provider-native sessions missing llmConnection', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-qwen-history-'));
    tempRoots.push(workspaceRoot);

    const sessionId = '9c451e20-8efe-477b-8f88-928990b29e2c';
    const timestamp = Date.parse('2026-04-24T09:24:14.927Z');
    await saveSession({
      id: sessionId,
      workspaceRootPath: workspaceRoot,
      sdkSessionId: sessionId,
      sdkCwd: workspaceRoot,
      workingDirectory: workspaceRoot,
      name: 'legacy qwen session',
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastMessageAt: timestamp,
      permissionMode: 'ask',
      model: 'qwen3-coder-flash',
      thinkingLevel: 'medium',
      messages: [],
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        costUsd: 0,
      },
    });

    const nativeMessages: Message[] = [
      { id: 'qwen-1', role: 'user', content: 'legacy qwen session', timestamp },
      {
        id: 'qwen-2',
        role: 'assistant',
        content: 'loaded through built-in qwen-code',
        timestamp: timestamp + 1,
      },
    ];

    let resolvedConnectionSlug: string | undefined;
    const manager = new SessionManager({
      createExternalSessionAgent: (_workspace, backendContext) => {
        resolvedConnectionSlug = backendContext.connection?.slug;
        return {
          loadSessionMessages: async () => nativeMessages,
          destroy: () => {},
          dispose: () => {},
        } as unknown as AgentBackend;
      },
    });

    const workspace = {
      id: 'workspace-qwen',
      name: 'qwen-code',
      slug: 'qwen-code',
      rootPath: workspaceRoot,
      createdAt: timestamp,
    };
    const managed = createManagedSession(
      {
        id: sessionId,
        sdkSessionId: sessionId,
        sdkCwd: workspaceRoot,
        workingDirectory: workspaceRoot,
        name: 'legacy qwen session',
        createdAt: timestamp,
        lastUsedAt: timestamp,
        lastMessageAt: timestamp,
        messageCount: 0,
        model: 'qwen3-coder-flash',
        thinkingLevel: 'medium',
      },
      workspace,
    );
    (
      manager as unknown as { sessions: Map<string, typeof managed> }
    ).sessions.set(sessionId, managed);

    const session = await manager.getSession(sessionId);

    expect(resolvedConnectionSlug).toBe('qwen-code');
    expect(session?.messages).toHaveLength(2);
    expect(loadSession(workspaceRoot, sessionId)?.messages).toHaveLength(0);
  });
});
