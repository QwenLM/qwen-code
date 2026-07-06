/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonEvent,
  NonBlockingPromptAccepted,
  DaemonTranscriptBlock,
  DaemonUiSessionActions,
  PromptResult,
} from '@qwen-code/sdk/daemon';
import {
  DaemonSessionProvider,
  useDaemonActions,
  useDaemonConnection,
  useDaemonSessionNotices,
  useDaemonPendingPermissions,
  useDaemonPromptStatus,
  useDaemonStreamingState,
  useDaemonTranscriptBlocks,
  useDaemonTranscriptState,
  useDaemonWorkspaceEventSignals,
  type DaemonSessionProviderProps,
  type DaemonConnectionState,
  type DaemonSessionActions,
  type DaemonSessionNotice,
  type DaemonWorkspaceEventSignals,
} from './DaemonSessionProvider.js';
import { DaemonWorkspaceProvider } from '../workspace/DaemonWorkspaceProvider.js';
import {
  clearSidechannelMidTurnInjected,
  getSidechannelMidTurnInjected,
} from '../midTurnInjectedSidechannel.js';

interface MockSession {
  sessionId: string;
  workspaceCwd: string;
  clientId: string;
  state?: Record<string, unknown>;
  hasActivePrompt?: boolean;
  client?: MockClient;
  lastEventId?: number;
  setLastEventId: (lastEventId: number | undefined) => void;
  prompt: (
    req: unknown,
    signal?: AbortSignal,
  ) => Promise<PromptResult | NonBlockingPromptAccepted>;
  submitPrompt: (
    req: unknown,
    signal?: AbortSignal,
  ) => Promise<NonBlockingPromptAccepted>;
  removePendingPrompt: (promptId: string) => Promise<{ removed: boolean }>;
  cancel: () => Promise<void>;
  setModel: (modelId: string) => Promise<{ modelId: string }>;
  heartbeat: () => Promise<{ ok: boolean }>;
  shellCommand: (command: string, signal?: AbortSignal) => Promise<unknown>;
  context: () => Promise<{
    v: 1;
    sessionId: string;
    workspaceCwd: string;
    state: Record<string, unknown>;
  }>;
  supportedCommands: () => Promise<{
    v: 1;
    sessionId: string;
    availableCommands: unknown[];
    availableSkills: string[];
  }>;
  respondToSessionPermission: () => Promise<boolean>;
  close: () => Promise<void>;
  detach: () => Promise<void>;
  updateMetadata: (metadata: {
    displayName?: string;
  }) => Promise<{ displayName?: string }>;
  replaySnapshot: {
    compactedReplay: DaemonEvent[];
    liveJournal: DaemonEvent[];
  };
  events: (opts?: {
    signal?: AbortSignal;
    maxQueued?: number;
  }) => AsyncGenerator<DaemonEvent, void, unknown>;
}

interface MockClient {
  createOrAttachSession: (req: unknown) => Promise<MockSession>;
  capabilities: () => Promise<unknown>;
  workspaceProviders: () => Promise<unknown>;
  listWorkspaceSessions: () => Promise<unknown[]>;
  closeSession: () => Promise<void>;
  setSessionApprovalMode: () => Promise<{ mode: string }>;
  workspaceMcp: () => Promise<unknown>;
  workspaceMcpTools: () => Promise<unknown>;
  restartMcpServer: () => Promise<unknown>;
  workspaceSkills: () => Promise<unknown>;
  workspaceTools: () => Promise<unknown>;
  setWorkspaceToolEnabled: () => Promise<unknown>;
  workspaceMemory: () => Promise<unknown>;
  readWorkspaceFile: () => Promise<unknown>;
  writeWorkspaceMemory: () => Promise<unknown>;
  listWorkspaceAgents: () => Promise<unknown>;
  getWorkspaceAgent: () => Promise<unknown>;
  createWorkspaceAgent: () => Promise<unknown>;
  deleteWorkspaceAgent: () => Promise<void>;
  getPendingPrompts: (
    sessionId: string,
    opts?: { clientId?: string },
  ) => Promise<unknown>;
  removePendingPrompt: (
    sessionId: string,
    promptId: string,
    opts?: { clientId?: string },
  ) => Promise<{ removed: boolean }>;
  branchSession: (
    sessionId: string,
    req: { name?: string },
    clientId?: string,
  ) => Promise<{
    sessionId: string;
    displayName: string;
    clientId?: string;
  }>;
}

const sdkMocks = vi.hoisted(() => {
  const sessions: MockSession[] = [];
  const capabilities = vi.fn();
  const workspaceProviders = vi.fn();
  const listWorkspaceSessions = vi.fn();
  const closeSession = vi.fn();
  const setSessionApprovalMode = vi.fn();
  const workspaceMcp = vi.fn();
  const workspaceMcpTools = vi.fn();
  const restartMcpServer = vi.fn();
  const workspaceSkills = vi.fn();
  const workspaceTools = vi.fn();
  const setWorkspaceToolEnabled = vi.fn();
  const workspaceMemory = vi.fn();
  const readWorkspaceFile = vi.fn();
  const writeWorkspaceMemory = vi.fn();
  const listWorkspaceAgents = vi.fn();
  const getWorkspaceAgent = vi.fn();
  const createWorkspaceAgent = vi.fn();
  const deleteWorkspaceAgent = vi.fn();
  const getPendingPrompts = vi.fn();
  const removePendingPrompt = vi.fn();
  const branchSession = vi.fn();

  class MockDaemonClient {
    constructor(_opts: unknown) {}

    createOrAttachSession = vi.fn((req: unknown) =>
      MockDaemonSessionClient.createOrAttach(this, req),
    );
    capabilities = capabilities;
    workspaceProviders = workspaceProviders;
    listWorkspaceSessions = listWorkspaceSessions;
    closeSession = closeSession;
    setSessionApprovalMode = setSessionApprovalMode;
    workspaceMcp = workspaceMcp;
    workspaceMcpTools = workspaceMcpTools;
    restartMcpServer = restartMcpServer;
    workspaceSkills = workspaceSkills;
    workspaceTools = workspaceTools;
    setWorkspaceToolEnabled = setWorkspaceToolEnabled;
    workspaceMemory = workspaceMemory;
    readWorkspaceFile = readWorkspaceFile;
    writeWorkspaceMemory = writeWorkspaceMemory;
    listWorkspaceAgents = listWorkspaceAgents;
    getWorkspaceAgent = getWorkspaceAgent;
    createWorkspaceAgent = createWorkspaceAgent;
    deleteWorkspaceAgent = deleteWorkspaceAgent;
    getPendingPrompts = getPendingPrompts;
    removePendingPrompt = removePendingPrompt;
    branchSession = branchSession;
    dispose = vi.fn();
  }

  function takeSession(client: unknown): MockSession {
    const session = sessions.shift();
    if (!session) throw new Error('No mock daemon session queued');
    session.client = client as MockClient;
    return session;
  }

  class MockDaemonSessionClient {
    static createOrAttach = vi.fn(
      async (client: unknown, _req: unknown): Promise<MockSession> =>
        takeSession(client),
    );
    static load = vi.fn(
      async (
        client: unknown,
        _sessionId: string,
        _opts?: unknown,
        _clientId?: string,
      ): Promise<MockSession> => takeSession(client),
    );
  }

  return {
    sessions,
    capabilities,
    workspaceProviders,
    workspaceSkills,
    MockDaemonClient,
    MockDaemonSessionClient,
    workspaceMcpTools,
    getPendingPrompts,
    removePendingPrompt,
    branchSession,
    reset() {
      sessions.length = 0;
      capabilities.mockReset();
      capabilities.mockResolvedValue({
        workspaceCwd: '/mock-workspace',
        features: [],
      });
      workspaceProviders.mockReset();
      workspaceProviders.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        providers: [],
      });
      listWorkspaceSessions.mockReset();
      listWorkspaceSessions.mockResolvedValue([]);
      closeSession.mockReset();
      closeSession.mockResolvedValue(undefined);
      setSessionApprovalMode.mockReset();
      setSessionApprovalMode.mockResolvedValue({ mode: 'default' });
      workspaceMcp.mockReset();
      workspaceMcp.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        servers: [],
      });
      workspaceMcpTools.mockReset();
      workspaceMcpTools.mockResolvedValue({
        v: 1,
        serverName: 'mock',
        tools: [],
      });
      restartMcpServer.mockReset();
      restartMcpServer.mockResolvedValue({ restarted: true });
      workspaceSkills.mockReset();
      workspaceSkills.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        skills: [],
      });
      workspaceTools.mockReset();
      workspaceTools.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        acpChannelLive: true,
        tools: [],
      });
      setWorkspaceToolEnabled.mockReset();
      setWorkspaceToolEnabled.mockResolvedValue({ ok: true });
      workspaceMemory.mockReset();
      workspaceMemory.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        files: [],
      });
      readWorkspaceFile.mockReset();
      readWorkspaceFile.mockResolvedValue({ path: 'QWEN.md', text: '' });
      writeWorkspaceMemory.mockReset();
      writeWorkspaceMemory.mockResolvedValue({ ok: true });
      listWorkspaceAgents.mockReset();
      listWorkspaceAgents.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        agents: [],
      });
      getWorkspaceAgent.mockReset();
      getWorkspaceAgent.mockResolvedValue({ agent: undefined });
      createWorkspaceAgent.mockReset();
      createWorkspaceAgent.mockResolvedValue({ ok: true });
      deleteWorkspaceAgent.mockReset();
      deleteWorkspaceAgent.mockResolvedValue(undefined);
      getPendingPrompts.mockReset();
      getPendingPrompts.mockResolvedValue({ pendingPrompts: [] });
      removePendingPrompt.mockReset();
      removePendingPrompt.mockResolvedValue({ removed: true });
      branchSession.mockReset();
      branchSession.mockResolvedValue({
        sessionId: 'branch-session',
        displayName: 'Branch Session',
        clientId: 'branch-client',
      });
      MockDaemonSessionClient.createOrAttach.mockReset();
      MockDaemonSessionClient.createOrAttach.mockImplementation(
        async (client: unknown, _req: unknown): Promise<MockSession> =>
          takeSession(client),
      );
      MockDaemonSessionClient.load.mockReset();
      MockDaemonSessionClient.load.mockImplementation(
        async (client: unknown, _sessionId: string): Promise<MockSession> =>
          takeSession(client),
      );
    },
  };
});

vi.mock('@qwen-code/sdk/daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@qwen-code/sdk/daemon')>();
  return {
    ...actual,
    DaemonClient: sdkMocks.MockDaemonClient,
    DaemonSessionClient: sdkMocks.MockDaemonSessionClient,
  };
});

describe('DaemonSessionProvider', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    sdkMocks.reset();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    vi.unstubAllGlobals();
  });

  it('exposes idle connection state without auto connect', async () => {
    let connection: DaemonConnectionState | undefined;
    let blocks: readonly DaemonTranscriptBlock[] | undefined;

    function Harness() {
      connection = useDaemonConnection();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />);

    expect(connection).toEqual({ status: 'idle' });
    expect(blocks).toEqual([]);
  });

  it('keeps capabilities handshake failures out of the transcript', async () => {
    sdkMocks.capabilities.mockRejectedValue(
      Object.assign(new Error('GET /capabilities: HTTP 400'), { status: 400 }),
    );
    let connection: DaemonConnectionState | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      connection = useDaemonConnection();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });

    await act(async () => {
      await flushPromises();
    });

    expect(connection).toMatchObject({
      status: 'error',
      error: 'GET /capabilities: HTTP 400',
    });
    expect(blocks).toEqual([]);
  });

  it('connects without creating a session by default', async () => {
    sdkMocks.workspaceProviders.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/mock-workspace',
      initialized: true,
      approvalMode: 'yolo',
      providers: [],
    });
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
    });

    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).not.toHaveBeenCalled();
    expect(connection).toMatchObject({
      status: 'connected',
      workspaceCwd: '/mock-workspace',
      currentMode: 'yolo',
    });
    expect(connection).not.toHaveProperty('sessionId');
  });

  it('populates skill slash commands during deferred connect (before first prompt)', async () => {
    sdkMocks.workspaceProviders.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/mock-workspace',
      initialized: true,
      providers: [],
    });
    sdkMocks.workspaceSkills.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/mock-workspace',
      initialized: true,
      skills: [
        {
          kind: 'skill',
          status: 'ok',
          name: 'review',
          description: 'Review a GitHub pull request',
          level: 'bundled',
          modelInvocable: true,
        },
      ],
    });
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
    });

    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).not.toHaveBeenCalled();
    expect(connection?.status).toBe('connected');
    expect(connection).not.toHaveProperty('sessionId');
    expect(connection?.skills).toEqual(['review']);
    expect(connection?.commands).toEqual([
      expect.objectContaining({
        name: 'review',
        description: 'Review a GitHub pull request',
      }),
    ]);
  });

  it('warns when deferred workspace providers fail', async () => {
    const error = new Error('providers unavailable');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sdkMocks.workspaceProviders.mockRejectedValueOnce(error);
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
    });

    expect(connection).toMatchObject({
      status: 'connected',
      workspaceCwd: '/mock-workspace',
      models: [],
    });
    expect(warn).toHaveBeenCalledWith(
      '[DaemonSessionProvider] workspaceProviders failed in deferred connect:',
      error,
    );
  });

  it('warns when deferred workspace skills fail', async () => {
    const error = new Error('skills unavailable');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sdkMocks.workspaceSkills.mockRejectedValueOnce(error);
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
    });

    // Skills failing must not block the deferred connect: providers still
    // resolve and the connection reports connected, just without skill commands.
    expect(connection).toMatchObject({
      status: 'connected',
      workspaceCwd: '/mock-workspace',
    });
    expect(connection).not.toHaveProperty('commands');
    expect(warn).toHaveBeenCalledWith(
      '[DaemonSessionProvider] workspaceSkills failed in deferred connect:',
      error,
    );
  });

  it('preserves a concurrently created session during deferred connect', async () => {
    const providers = createDeferred<unknown>();
    sdkMocks.workspaceProviders.mockReturnValueOnce(providers.promise);
    sdkMocks.sessions.push(createMockSession({ sessionId: 'created-session' }));
    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
    });
    await act(async () => {
      await actions?.createSession();
    });
    expect(connection).toMatchObject({ sessionId: 'created-session' });

    providers.resolve({
      v: 1,
      workspaceCwd: '/mock-workspace',
      initialized: true,
      providers: [],
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'created-session',
      clientId: 'client-1',
    });
  });

  it('can create a session after connecting from the empty state', async () => {
    sdkMocks.sessions.push(
      createMockSession({ sessionId: 'lazy-session' }),
      createMockSession({ sessionId: 'lazy-session' }),
    );
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
    });
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).not.toHaveBeenCalled();

    await act(async () => {
      await actions?.createSession();
    });

    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionScope: 'thread',
        workspaceCwd: '/mock-workspace',
      }),
      expect.any(String),
    );
  });

  it('can send immediately after creating a session from the empty state', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      v: 1,
      workspaceCwd: '/mock-workspace',
      features: ['client_heartbeat'],
    });
    const createdSession = createMockSession({
      sessionId: 'lazy-session',
      supportedCommands: vi.fn(async () => ({
        v: 1 as const,
        sessionId: 'lazy-session',
        availableCommands: [
          {
            name: '/context',
            description: 'Show context',
            input: null,
          },
        ],
        availableSkills: ['review'],
      })),
      events: async function* createdSessionEvents() {
        yield {
          v: 1,
          id: 1,
          type: 'turn_complete',
          timestamp: '2025-01-01T00:00:00.000Z',
          sessionId: 'lazy-session',
          data: { promptId: 'prompt-1', stopReason: 'end_turn' },
        };
      },
    });
    sdkMocks.sessions.push(createdSession);
    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
    });
    const providerActions = requireActions(actions);

    let result: Promise<PromptResult> | undefined;
    await act(async () => {
      await providerActions.createSession();
    });
    let attach: Promise<void> | undefined;
    act(() => {
      attach = providerActions.attachSession();
    });
    await act(async () => {
      await flushPromises();
    });
    await attach;
    expect(connection?.commands?.map((command) => command.name)).toContain(
      '/context',
    );
    expect(connection?.skills).toContain('review');
    expect(connection?.capabilities).toMatchObject({
      features: ['client_heartbeat'],
    });
    expect(createdSession.detach).not.toHaveBeenCalled();

    await act(async () => {
      result = providerActions.sendPrompt('hello');
      await flushPromises();
    });

    expect(createdSession.submitPrompt).toHaveBeenCalledTimes(1);
    result?.catch(() => {});
  });

  it('reuses the workspace capabilities request when nested in a workspace provider', async () => {
    sdkMocks.sessions.push(createMockSession());
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <DaemonWorkspaceProvider baseUrl="http://127.0.0.1:4170">
          <DaemonSessionProvider suppressOwnUserEcho>
            <Harness />
          </DaemonSessionProvider>
        </DaemonWorkspaceProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection?.status).toBe('connected');
    expect(sdkMocks.capabilities).toHaveBeenCalledTimes(1);
  });

  it('uses session context models over workspace provider defaults', async () => {
    sdkMocks.workspaceProviders.mockResolvedValue({
      v: 1,
      workspaceCwd: '/mock-workspace',
      initialized: true,
      current: {
        authType: 'USE_OPENAI',
        modelId: 'workspace-default(USE_OPENAI)',
      },
      providers: [
        {
          kind: 'model_provider',
          status: 'ok',
          authType: 'USE_OPENAI',
          current: true,
          models: [
            {
              modelId: 'workspace-default(USE_OPENAI)',
              baseModelId: 'workspace-default',
              name: 'Workspace Default',
              contextLimit: 10_000,
              isCurrent: true,
              isRuntime: false,
            },
          ],
        },
      ],
    });
    sdkMocks.sessions.push(
      createMockSession({
        context: vi.fn(async () => ({
          v: 1 as const,
          sessionId: 'session-1',
          workspaceCwd: '/mock-workspace',
          state: {
            models: {
              currentModelId: 'session-current(USE_OPENAI)',
              availableModels: [
                {
                  modelId: 'session-current(USE_OPENAI)',
                  name: 'Session Current',
                  description: 'Session-scoped model',
                  _meta: { contextLimit: 20_000 },
                },
              ],
            },
          },
        })),
      }),
    );
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection?.currentModel).toBe('session-current(USE_OPENAI)');
    expect(connection?.contextWindow).toBe(20_000);
    expect(connection?.models).toEqual([
      expect.objectContaining({
        id: 'session-current(USE_OPENAI)',
        label: 'Session Current',
        contextWindow: 20_000,
      }),
    ]);
  });

  it('falls back to provider context window for session context models', async () => {
    sdkMocks.workspaceProviders.mockResolvedValue({
      v: 1,
      workspaceCwd: '/mock-workspace',
      initialized: true,
      current: {
        authType: 'USE_OPENAI',
        modelId: 'workspace-default(USE_OPENAI)',
      },
      providers: [
        {
          kind: 'model_provider',
          status: 'ok',
          authType: 'USE_OPENAI',
          current: true,
          models: [
            {
              modelId: 'workspace-default(USE_OPENAI)',
              baseModelId: 'workspace-default',
              name: 'Workspace Default',
              contextLimit: 10_000,
              isCurrent: true,
              isRuntime: false,
            },
            {
              modelId: 'session-current(USE_OPENAI)',
              baseModelId: 'session-current',
              name: 'Session Current',
              contextLimit: 20_000,
              isCurrent: false,
              isRuntime: false,
            },
          ],
        },
      ],
    });
    sdkMocks.sessions.push(
      createMockSession({
        context: vi.fn(async () => ({
          v: 1 as const,
          sessionId: 'session-1',
          workspaceCwd: '/mock-workspace',
          state: {
            models: {
              currentModelId: 'session-current(USE_OPENAI)',
              availableModels: [
                {
                  modelId: 'session-current(USE_OPENAI)',
                  name: 'Session Current',
                },
              ],
            },
          },
        })),
      }),
    );
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection?.currentModel).toBe('session-current(USE_OPENAI)');
    expect(connection?.contextWindow).toBe(20_000);
    expect(connection?.models).toEqual([
      expect.objectContaining({
        id: 'session-current(USE_OPENAI)',
        label: 'Session Current',
      }),
    ]);
    expect(connection?.models?.[0]?.contextWindow).toBeUndefined();
  });

  it('falls back to provider models when session context only has current model', async () => {
    sdkMocks.workspaceProviders.mockResolvedValue({
      v: 1,
      workspaceCwd: '/mock-workspace',
      initialized: true,
      current: {
        authType: 'USE_OPENAI',
        modelId: 'workspace-default(USE_OPENAI)',
      },
      providers: [
        {
          kind: 'model_provider',
          status: 'ok',
          authType: 'USE_OPENAI',
          current: true,
          models: [
            {
              modelId: 'workspace-default(USE_OPENAI)',
              baseModelId: 'workspace-default',
              name: 'Workspace Default',
              contextLimit: 10_000,
              isCurrent: true,
              isRuntime: false,
            },
            {
              modelId: 'session-current(USE_OPENAI)',
              baseModelId: 'session-current',
              name: 'Session Current',
              contextLimit: 20_000,
              isCurrent: false,
              isRuntime: false,
            },
          ],
        },
      ],
    });
    sdkMocks.sessions.push(
      createMockSession({
        context: vi.fn(async () => ({
          v: 1 as const,
          sessionId: 'session-1',
          workspaceCwd: '/mock-workspace',
          state: {
            models: {
              currentModelId: 'session-current(USE_OPENAI)',
            },
          },
        })),
      }),
    );
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection?.currentModel).toBe('session-current(USE_OPENAI)');
    expect(connection?.contextWindow).toBe(20_000);
    expect(connection?.models?.map((model) => model.id)).toEqual([
      'workspace-default(USE_OPENAI)',
      'session-current(USE_OPENAI)',
    ]);
  });

  it('does not use provider context window for an unmatched session model', async () => {
    sdkMocks.workspaceProviders.mockResolvedValue({
      v: 1,
      workspaceCwd: '/mock-workspace',
      initialized: true,
      current: {
        authType: 'USE_OPENAI',
        modelId: 'workspace-default(USE_OPENAI)',
      },
      providers: [
        {
          kind: 'model_provider',
          status: 'ok',
          authType: 'USE_OPENAI',
          current: true,
          models: [
            {
              modelId: 'workspace-default(USE_OPENAI)',
              baseModelId: 'workspace-default',
              name: 'Workspace Default',
              contextLimit: 10_000,
              isCurrent: true,
              isRuntime: false,
            },
          ],
        },
      ],
    });
    sdkMocks.sessions.push(
      createMockSession({
        context: vi.fn(async () => ({
          v: 1 as const,
          sessionId: 'session-1',
          workspaceCwd: '/mock-workspace',
          state: {
            models: {
              currentModelId: 'runtime-only(USE_OPENAI)',
            },
          },
        })),
      }),
    );
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection?.currentModel).toBe('runtime-only(USE_OPENAI)');
    expect(connection?.contextWindow).toBeUndefined();
  });

  it('adds daemon goal status metadata to the transcript', async () => {
    const session = createMockSession({
      events: async function* goalStatusEvents() {
        yield {
          id: 11,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '' },
              _meta: {
                goalStatus: {
                  kind: 'set',
                  condition: 'ship goal sync',
                  setAt: 1234,
                },
              },
            },
          },
        };
      },
    });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(blocks).toEqual([
      expect.objectContaining({
        kind: 'status',
        text: '',
        source: 'goal',
        data: {
          kind: 'set',
          condition: 'ship goal sync',
          setAt: 1234,
        },
      }),
    ]);
  });

  it('routes mid_turn_message_injected frames to the sidechannel and transcript', async () => {
    // The frame seeds the dedupe sidechannel and also normalizes into a
    // transcript status block so consumers can show the inserted message.
    clearSidechannelMidTurnInjected();
    const session = createMockSession({
      events: async function* midTurnEvents() {
        yield {
          id: 21,
          v: 1,
          type: 'mid_turn_message_injected',
          originatorClientId: 'client-mt',
          data: { sessionId: 'mt-session', messages: ['also check the tests'] },
        };
      },
    });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });

    // Seeded the dedupe sidechannel (with the envelope-level originatorClientId).
    expect(getSidechannelMidTurnInjected()).toEqual([
      {
        sessionId: 'mt-session',
        messages: ['also check the tests'],
        originatorClientId: 'client-mt',
      },
    ]);
    expect(blocks).toMatchObject([
      {
        kind: 'status',
        text: 'Inserted message: also check the tests',
        source: 'mid_turn_message_injected',
        data: {
          sessionId: 'mt-session',
          messages: ['also check the tests'],
        },
      },
    ]);
    clearSidechannelMidTurnInjected();
  });

  it('publishes action error notices when no session is connected', async () => {
    let actions: DaemonUiSessionActions | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let notices: readonly DaemonSessionNotice[] = [];

    function Harness() {
      actions = useDaemonActions();
      blocks = useDaemonTranscriptBlocks();
      notices = useDaemonSessionNotices().notices;
      return null;
    }

    await renderWithProvider(<Harness />);
    const providerActions = actions;
    if (!providerActions) throw new Error('actions were not initialized');

    await act(async () => {
      await expect(providerActions.sendPrompt('hi')).rejects.toThrow(
        'Daemon session is not connected',
      );
    });
    expect(blocks).toEqual([]);
    expect(notices).toMatchObject([
      {
        category: 'user_action',
        operation: 'send_prompt',
        message: 'Prompt failed: Daemon session is not connected',
      },
    ]);

    await act(async () => {
      await expect(providerActions.cancel()).rejects.toThrow(
        'Daemon session is not connected',
      );
    });
    expect(blocks).toEqual([]);
    expect(notices).toMatchObject([
      { operation: 'send_prompt' },
      {
        category: 'user_action',
        operation: 'cancel_prompt',
        message: 'Cancel failed: Daemon session is not connected',
      },
    ]);

    await act(async () => {
      await expect(providerActions.setModel('qwen-plus')).rejects.toThrow(
        'Daemon session is not connected',
      );
    });
    expect(blocks).toEqual([]);
    expect(notices).toMatchObject([
      { operation: 'send_prompt' },
      { operation: 'cancel_prompt' },
      {
        category: 'user_action',
        operation: 'switch_model',
        message: 'Set model failed: Daemon session is not connected',
      },
    ]);

    await act(async () => {
      await expect(
        providerActions.respondToPermission('perm-1', {
          outcome: {
            outcome: 'selected',
            optionId: 'allow',
          },
        }),
      ).rejects.toThrow('Daemon session is not connected');
    });
    expect(blocks).toEqual([]);
    expect(notices).toMatchObject([
      { operation: 'send_prompt' },
      { operation: 'cancel_prompt' },
      { operation: 'switch_model' },
      {
        category: 'user_action',
        operation: 'submit_permission',
        message: 'Permission response failed: Daemon session is not connected',
      },
    ]);
  });

  it('prevents double submit while a prompt is running', async () => {
    const accepted = createDeferred<NonBlockingPromptAccepted>();
    const turnComplete = createDeferred<void>();
    const session = createMockSession({
      submitPrompt: vi.fn(() => accepted.promise),
      events: createTurnCompleteEvents(turnComplete),
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    const providerActions = requireActions(actions);

    let firstPrompt: Promise<unknown> | undefined;
    await act(async () => {
      firstPrompt = providerActions.sendPrompt('first');
      await flushPromises();
    });

    await act(async () => {
      await expect(providerActions.sendPrompt('second')).rejects.toThrow(
        'A prompt is already in progress',
      );
    });

    accepted.resolve({ promptId: 'prompt-1', lastEventId: 10 });
    turnComplete.resolve();
    const runningPrompt = firstPrompt;
    if (!runningPrompt) throw new Error('prompt was not started');
    await act(async () => {
      await expect(runningPrompt).resolves.toEqual({ stopReason: 'end_turn' });
    });
    expect(session.submitPrompt).toHaveBeenCalledTimes(1);
  });

  it('returns the prompt id from submitPrompt', async () => {
    const session = createMockSession({
      submitPrompt: vi.fn(async () => ({
        promptId: 'pending-1',
        lastEventId: 10,
      })),
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    await expect(
      providerActions.submitPrompt('queued prompt'),
    ).resolves.toEqual({ promptId: 'pending-1' });
  });

  it('removes an accepted pending prompt when submitPrompt was already aborted', async () => {
    const controller = new AbortController();
    controller.abort(createAbortError());
    const removePendingPrompt = vi.fn(async () => ({ removed: true }));
    const session = createMockSession({
      submitPrompt: vi.fn(async () => ({
        promptId: 'pending-1',
        lastEventId: 10,
      })),
      removePendingPrompt,
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    await act(async () => {
      await expect(
        providerActions.submitPrompt('queued prompt', {
          signal: controller.signal,
          optimisticUserMessage: false,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    expect(removePendingPrompt).toHaveBeenCalledWith('pending-1');
  });

  it('removes an accepted pending prompt when submitPrompt is aborted', async () => {
    const controller = new AbortController();
    const submitPrompt = vi.fn(async (_req: unknown, signal?: AbortSignal) => {
      expect(signal).toBeUndefined();
      controller.abort(createAbortError());
      return { promptId: 'pending-1', lastEventId: 10 };
    });
    const removePendingPrompt = vi.fn(async () => ({ removed: true }));
    const session = createMockSession({
      submitPrompt,
      removePendingPrompt,
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    await act(async () => {
      await expect(
        providerActions.submitPrompt('queued prompt', {
          signal: controller.signal,
          optimisticUserMessage: false,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    expect(removePendingPrompt).toHaveBeenCalledWith('pending-1');
  });

  it('reports a notice when aborted submitPrompt cleanup fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const controller = new AbortController();
    const removeError = new Error('delete failed');
    const session = createMockSession({
      submitPrompt: vi.fn(async () => {
        controller.abort(createAbortError());
        return { promptId: 'pending-1', lastEventId: 10 };
      }),
      removePendingPrompt: vi.fn(async () => {
        throw removeError;
      }),
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonSessionActions | undefined;
    let notices: readonly DaemonSessionNotice[] = [];

    function Harness() {
      actions = useDaemonActions();
      notices = useDaemonSessionNotices().notices;
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    await act(async () => {
      await expect(
        providerActions.submitPrompt('queued prompt', {
          signal: controller.signal,
          optimisticUserMessage: false,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    expect(warn).toHaveBeenCalledWith(
      '[submitPrompt] removePendingPrompt failed after abort',
      removeError,
    );
    expect(notices).toMatchObject([
      {
        category: 'user_action',
        operation: 'send_prompt',
        code: 'daemon.send_prompt.pending_cleanup_failed',
      },
    ]);
    warn.mockRestore();
  });

  it('returns safe pending prompt results when no session is connected', async () => {
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />);
    const providerActions = requireActions(actions);

    await expect(providerActions.getPendingPrompts()).resolves.toEqual({
      pendingPrompts: [],
    });
    await expect(
      providerActions.removePendingPrompt('pending-1'),
    ).resolves.toEqual({ removed: false });
  });

  it('routes stale-session pending prompt removal through the daemon client', async () => {
    const session = createMockSession({
      sessionId: 'session-current',
      clientId: 'client-current',
      removePendingPrompt: vi.fn(async () => ({ removed: true })),
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    await expect(
      providerActions.removePendingPrompt('pending-old', {
        sessionId: 'session-old',
      }),
    ).resolves.toEqual({ removed: true });

    expect(session.removePendingPrompt).not.toHaveBeenCalled();
    expect(sdkMocks.removePendingPrompt).toHaveBeenCalledWith(
      'session-old',
      'pending-old',
    );
  });

  it('rejects stale-session pending prompt refreshes', async () => {
    const session = createMockSession({ sessionId: 'session-current' });
    sdkMocks.sessions.push(session);
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    await expect(
      providerActions.getPendingPrompts({ sessionId: 'session-old' }),
    ).rejects.toThrow('Session changed before pending prompts refresh');
  });

  it('keeps prompt loading active after non-blocking prompt acceptance', async () => {
    const turnComplete = createDeferred<void>();
    const session = createMockSession({
      submitPrompt: vi.fn(async () => ({
        promptId: 'prompt-1',
        lastEventId: 10,
      })),
      events: async function* acceptedPromptEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        await Promise.race([
          turnComplete.promise,
          new Promise<void>((resolve) =>
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          ),
        ]);
        if (opts.signal?.aborted) return;
        yield {
          v: 1,
          id: 11,
          type: 'turn_complete',
          timestamp: '2025-01-01T00:00:00.000Z',
          sessionId: 'session-1',
          data: { promptId: 'prompt-1', stopReason: 'end_turn' },
        };
      },
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let streamingState: ReturnType<typeof useDaemonStreamingState> = 'idle';
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      actions = useDaemonActions();
      streamingState = useDaemonStreamingState();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('hello');
      await flushPromises();
    });
    expect(streamingState).toBe('waiting');

    turnComplete.resolve();
    const pendingPrompt = promptResult;
    if (!pendingPrompt) throw new Error('prompt was not started');
    await act(async () => {
      await expect(pendingPrompt).resolves.toEqual({
        stopReason: 'end_turn',
      });
    });
    expect(streamingState).toBe('idle');
    expect(
      blocks.some((block) => block.kind === 'user' && block.text === 'hello'),
    ).toBe(true);
    expect(
      blocks.some(
        (block) =>
          block.kind === 'debug' &&
          block.text.includes('turn_complete (unrecognized daemon event)'),
      ),
    ).toBe(false);
  });

  it('shows waiting state when a queued prompt starts before assistant output', async () => {
    const turnComplete = createDeferred<void>();
    const session = createMockSession({
      events: async function* queuedPromptEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          v: 1,
          id: 11,
          type: 'pending_prompt_started',
          timestamp: '2025-01-01T00:00:00.000Z',
          sessionId: 'session-1',
          data: {
            sessionId: 'session-1',
            promptId: 'prompt-queued',
            text: 'queued hello',
          },
        };
        await Promise.race([
          turnComplete.promise,
          new Promise<void>((resolve) =>
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          ),
        ]);
        if (opts.signal?.aborted) return;
        yield {
          v: 1,
          id: 12,
          type: 'turn_complete',
          timestamp: '2025-01-01T00:00:01.000Z',
          sessionId: 'session-1',
          data: { promptId: 'prompt-queued', stopReason: 'end_turn' },
        };
      },
    });
    sdkMocks.sessions.push(session);
    let streamingState: ReturnType<typeof useDaemonStreamingState> = 'idle';

    function Harness() {
      streamingState = useDaemonStreamingState();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });
    expect(streamingState).toBe('waiting');

    await act(async () => {
      turnComplete.resolve();
      await flushPromises();
    });
    expect(streamingState).toBe('idle');
  });

  it('settles non-blocking prompts when turn completion arrives before acceptance returns', async () => {
    const accepted = createDeferred<NonBlockingPromptAccepted>();
    const turnComplete = createDeferred<void>();
    const session = createMockSession({
      submitPrompt: vi.fn(() => accepted.promise),
      events: async function* acceptedPromptEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        await Promise.race([
          turnComplete.promise,
          new Promise<void>((resolve) =>
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          ),
        ]);
        if (opts.signal?.aborted) return;
        yield {
          v: 1,
          id: 11,
          type: 'turn_complete',
          timestamp: '2025-01-01T00:00:00.000Z',
          sessionId: 'session-1',
          data: { promptId: 'prompt-1', stopReason: 'end_turn' },
        };
      },
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let streamingState: ReturnType<typeof useDaemonStreamingState> = 'idle';

    function Harness() {
      actions = useDaemonActions();
      streamingState = useDaemonStreamingState();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('hello');
      await flushPromises();
    });
    expect(streamingState).toBe('waiting');

    await act(async () => {
      turnComplete.resolve();
      await flushPromises();
    });
    expect(streamingState).toBe('idle');

    const pendingPrompt = promptResult;
    if (!pendingPrompt) throw new Error('prompt was not started');
    await act(async () => {
      accepted.resolve({ promptId: 'prompt-1', lastEventId: 10 });
      await expect(pendingPrompt).resolves.toEqual({
        stopReason: 'end_turn',
      });
    });
  });

  it('allows the next prompt after a turn completes before acceptance returns', async () => {
    const firstAccepted = createDeferred<NonBlockingPromptAccepted>();
    const secondAccepted = createDeferred<NonBlockingPromptAccepted>();
    const firstTurnComplete = createDeferred<void>();
    const secondTurnComplete = createDeferred<void>();
    const submitPrompt = vi
      .fn()
      .mockReturnValueOnce(firstAccepted.promise)
      .mockReturnValueOnce(secondAccepted.promise);
    const session = createMockSession({
      submitPrompt,
      events: async function* acceptedPromptEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        await Promise.race([
          firstTurnComplete.promise,
          new Promise<void>((resolve) =>
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          ),
        ]);
        if (opts.signal?.aborted) return;
        yield {
          v: 1,
          id: 11,
          type: 'turn_complete',
          timestamp: '2025-01-01T00:00:00.000Z',
          sessionId: 'session-1',
          data: { promptId: 'prompt-1', stopReason: 'end_turn' },
        };
        await Promise.race([
          secondTurnComplete.promise,
          new Promise<void>((resolve) =>
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          ),
        ]);
        if (opts.signal?.aborted) return;
        yield {
          v: 1,
          id: 12,
          type: 'turn_complete',
          timestamp: '2025-01-01T00:00:01.000Z',
          sessionId: 'session-1',
          data: { promptId: 'prompt-2', stopReason: 'end_turn' },
        };
      },
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let streamingState: ReturnType<typeof useDaemonStreamingState> = 'idle';

    function Harness() {
      actions = useDaemonActions();
      streamingState = useDaemonStreamingState();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    let firstPrompt: Promise<unknown> | undefined;
    await act(async () => {
      firstPrompt = providerActions.sendPrompt('/directory');
      await flushPromises();
    });
    expect(streamingState).toBe('waiting');

    await act(async () => {
      firstTurnComplete.resolve();
      await flushPromises();
    });
    expect(streamingState).toBe('idle');

    let secondPrompt: Promise<unknown> | undefined;
    await act(async () => {
      secondPrompt = providerActions.sendPrompt('next prompt');
      await flushPromises();
    });
    expect(submitPrompt).toHaveBeenCalledTimes(2);

    const pendingFirstPrompt = firstPrompt;
    if (!pendingFirstPrompt) throw new Error('first prompt was not started');
    await act(async () => {
      firstAccepted.resolve({ promptId: 'prompt-1', lastEventId: 10 });
      await expect(pendingFirstPrompt).resolves.toEqual({
        stopReason: 'end_turn',
      });
    });
    expect(streamingState).toBe('waiting');

    await act(async () => {
      secondTurnComplete.resolve();
      await flushPromises();
    });
    const pendingSecondPrompt = secondPrompt;
    if (!pendingSecondPrompt) throw new Error('second prompt was not started');
    await act(async () => {
      secondAccepted.resolve({ promptId: 'prompt-2', lastEventId: 11 });
      await expect(pendingSecondPrompt).resolves.toEqual({
        stopReason: 'end_turn',
      });
    });
    expect(streamingState).toBe('idle');
  });

  it('rejects the prompt when turn_error arrives before acceptance returns', async () => {
    const accepted = createDeferred<NonBlockingPromptAccepted>();
    const turnError = createDeferred<void>();
    const submitPrompt = vi.fn().mockReturnValueOnce(accepted.promise);
    const session = createMockSession({
      submitPrompt,
      events: async function* acceptedPromptEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        await Promise.race([
          turnError.promise,
          new Promise<void>((resolve) =>
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          ),
        ]);
        if (opts.signal?.aborted) return;
        yield {
          v: 1,
          id: 11,
          type: 'turn_error',
          timestamp: '2025-01-01T00:00:00.000Z',
          sessionId: 'session-1',
          data: {
            promptId: 'prompt-1',
            message: 'Something went wrong',
            code: 'internal_error',
          },
        };
      },
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let streamingState: ReturnType<typeof useDaemonStreamingState> = 'idle';

    function Harness() {
      actions = useDaemonActions();
      streamingState = useDaemonStreamingState();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('fail me');
      await flushPromises();
    });
    expect(streamingState).toBe('waiting');

    await act(async () => {
      turnError.resolve();
      await flushPromises();
    });
    expect(streamingState).toBe('idle');

    const pending = promptResult;
    if (!pending) throw new Error('prompt was not started');
    await act(async () => {
      accepted.resolve({ promptId: 'prompt-1', lastEventId: 10 });
      await expect(pending).rejects.toThrow('Something went wrong');
    });
  });

  it('sends image prompt content through the daemon action', async () => {
    const turnComplete = createDeferred<void>();
    const submitPrompt = vi.fn(async () => ({
      promptId: 'prompt-1',
      lastEventId: 10,
    }));
    const session = createMockSession({
      submitPrompt,
      events: createTurnCompleteEvents(turnComplete),
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = actions;
    if (!providerActions) throw new Error('actions were not initialized');

    await act(async () => {
      const promptResult = providerActions.sendPrompt('describe', {
        optimisticUserMessage: false,
        images: [{ data: 'base64-image', mimeType: 'image/png' }],
      });
      await flushPromises();
      turnComplete.resolve();
      await expect(promptResult).resolves.toEqual({ stopReason: 'end_turn' });
    });

    expect(submitPrompt).toHaveBeenCalledWith(
      {
        prompt: [
          { type: 'text', text: 'describe' },
          { type: 'image', data: 'base64-image', mimeType: 'image/png' },
        ],
      },
      expect.any(AbortSignal),
    );
  });

  it('passes retry prompts through the daemon action', async () => {
    const turnComplete = createDeferred<void>();
    const submitPrompt = vi.fn(async () => ({
      promptId: 'prompt-1',
      lastEventId: 10,
    }));
    const session = createMockSession({
      submitPrompt,
      events: createTurnCompleteEvents(turnComplete),
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = actions;
    if (!providerActions) throw new Error('actions were not initialized');

    await act(async () => {
      const promptResult = providerActions.sendPrompt('retry this', {
        optimisticUserMessage: false,
        retry: true,
      });
      await flushPromises();
      turnComplete.resolve();
      await expect(promptResult).resolves.toEqual({ stopReason: 'end_turn' });
    });

    expect(submitPrompt).toHaveBeenCalledWith(
      {
        prompt: [{ type: 'text', text: 'retry this' }],
        retry: true,
      },
      expect.any(AbortSignal),
    );
  });

  it('submits permission selections with optional answers', async () => {
    const respondToSessionPermission = vi.fn(async () => true);
    const session = createMockSession({
      respondToSessionPermission,
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = actions;
    if (!providerActions) throw new Error('actions were not initialized');

    await act(async () => {
      await expect(
        providerActions.submitPermission('permission-1', 'proceed_once', {
          name: 'Alice',
        }),
      ).resolves.toBe(true);
    });

    expect(respondToSessionPermission).toHaveBeenCalledWith('permission-1', {
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
      answers: { name: 'Alice' },
    });
  });

  it('exposes pending permission blocks', async () => {
    const session = createMockSession({
      events: async function* permissionEvents() {
        yield {
          id: 12,
          v: 1,
          type: 'permission_request',
          data: {
            requestId: 'permission-1',
            sessionId: 'session-1',
            title: 'Ask user 1 question',
            toolCall: {
              toolCallId: 'tool-1',
              rawInput: {
                questions: [
                  {
                    header: 'Name',
                    question: 'Student name?',
                    options: [{ label: 'Alice' }],
                  },
                ],
              },
            },
            options: [
              {
                optionId: 'proceed_once',
                name: 'Submit',
                kind: 'allow_once',
              },
            ],
          },
        };
        await Promise.resolve();
      },
    });
    sdkMocks.sessions.push(session);
    let requests: ReturnType<typeof useDaemonPendingPermissions> = [];

    function Harness() {
      requests = useDaemonPendingPermissions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requestId: 'permission-1',
      sessionId: 'session-1',
      title: 'Tool permission',
      toolCall: {
        toolCallId: 'tool-1',
      },
    });
  });

  it('exposes workspace event signals from daemon session events', async () => {
    const session = createMockSession({
      events: async function* workspaceEvents() {
        yield {
          id: 21,
          v: 1,
          type: 'memory_changed',
          data: {
            scope: 'workspace',
            filePath: '/mock-workspace/QWEN.md',
            mode: 'append',
            bytesWritten: 12,
          },
        };
        yield {
          id: 22,
          v: 1,
          type: 'agent_changed',
          data: {
            change: 'updated',
            name: 'reviewer',
            level: 'project',
          },
        };
        yield {
          id: 23,
          v: 1,
          type: 'tool_toggled',
          data: {
            toolName: 'Bash',
            enabled: false,
          },
        };
        yield {
          id: 24,
          v: 1,
          type: 'settings_changed',
          data: {
            key: 'ui.theme',
            scope: 'workspace',
            value: 'Qwen Dark',
          },
        };
        yield {
          id: 25,
          v: 1,
          type: 'mcp_server_restarted',
          data: {
            serverName: 'chrome-devtools',
            durationMs: 42,
          },
        };
      },
    });
    sdkMocks.sessions.push(session);
    let signals: DaemonWorkspaceEventSignals | undefined;

    function Harness() {
      signals = useDaemonWorkspaceEventSignals();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });

    expect(signals).toMatchObject({
      memoryVersion: 1,
      agentsVersion: 1,
      toolsVersion: 1,
      settingsVersion: 1,
      mcpVersion: 1,
      initVersion: 0,
      authVersion: 0,
    });
  });

  it('treats prompt abort during cancel as cancellation and keeps busy until cancel completes', async () => {
    const cancel = createDeferred<void>();
    const assistantChunk = createDeferred<void>();
    const secondTurnComplete = createDeferred<void>();
    let submitPromptCalls = 0;
    const session = createMockSession({
      submitPrompt: vi.fn((_req: unknown, signal?: AbortSignal) => {
        submitPromptCalls += 1;
        if (submitPromptCalls > 1) {
          return Promise.resolve({ promptId: 'prompt-2', lastEventId: 11 });
        }
        return new Promise<NonBlockingPromptAccepted>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(createAbortError()), {
            once: true,
          });
        });
      }),
      cancel: vi.fn(() => cancel.promise),
      events: async function* assistantThenIdleEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        await assistantChunk.promise;
        yield {
          id: 10,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'streaming' },
            },
          },
        };
        await Promise.race([
          secondTurnComplete.promise,
          new Promise<void>((resolve) =>
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          ),
        ]);
        if (opts.signal?.aborted) return;
        yield {
          v: 1,
          id: 12,
          type: 'turn_complete',
          timestamp: '2025-01-01T00:00:00.000Z',
          sessionId: 'session-1',
          data: { promptId: 'prompt-2', stopReason: 'end_turn' },
        };
      },
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      actions = useDaemonActions();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    let promptResult: Promise<unknown> | undefined;
    let cancelResult: Promise<void> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('cancel me');
      await flushPromises();
      assistantChunk.resolve();
      await flushPromises();
    });
    expect(blocks).toMatchObject([
      { kind: 'user', text: 'cancel me' },
      { kind: 'assistant', text: 'streaming', streaming: true },
    ]);

    await act(async () => {
      cancelResult = providerActions.cancel();
      await flushPromises();
    });

    const cancelledPrompt = promptResult;
    if (!cancelledPrompt) throw new Error('prompt was not started');
    await expect(cancelledPrompt).resolves.toEqual({
      stopReason: 'cancelled',
    });
    await act(async () => {
      await expect(providerActions.sendPrompt('blocked')).rejects.toThrow(
        'A prompt is already in progress',
      );
    });

    cancel.resolve();
    const pendingCancel = cancelResult;
    if (!pendingCancel) throw new Error('cancel was not started');
    await act(async () => {
      await pendingCancel;
    });
    expect(session.cancel).toHaveBeenCalledTimes(1);
    expect(blocks[0]).toMatchObject({ kind: 'user', text: 'cancel me' });
    expect(blocks[1]).toMatchObject({
      kind: 'assistant',
      text: 'streaming',
      streaming: false,
    });
    await act(async () => {
      const afterCancelPrompt = providerActions.sendPrompt('after cancel');
      await flushPromises();
      secondTurnComplete.resolve();
      await expect(afterCancelPrompt).resolves.toEqual({
        stopReason: 'end_turn',
      });
    });
    expect(session.submitPrompt).toHaveBeenCalledTimes(2);
    expect(
      blocks.some(
        (block) => block.kind === 'error' && block.text.includes('AbortError'),
      ),
    ).toBe(false);
  });

  it('ends assistant streaming when prompt fails with a non-abort error', async () => {
    const prompt = createDeferred<NonBlockingPromptAccepted>();
    const assistantChunk = createDeferred<void>();
    const session = createMockSession({
      submitPrompt: vi.fn(() => prompt.promise),
      events: async function* assistantThenIdleEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        await assistantChunk.promise;
        yield {
          id: 11,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'partial' },
            },
          },
        };
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let notices: readonly DaemonSessionNotice[] = [];

    function Harness() {
      actions = useDaemonActions();
      blocks = useDaemonTranscriptBlocks();
      notices = useDaemonSessionNotices().notices;
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('fail later');
      await flushPromises();
      assistantChunk.resolve();
      await flushPromises();
    });
    expect(blocks).toMatchObject([
      { kind: 'user', text: 'fail later' },
      { kind: 'assistant', text: 'partial', streaming: true },
    ]);

    prompt.reject(new Error('network down'));
    const failedPrompt = promptResult;
    if (!failedPrompt) throw new Error('prompt was not started');
    await act(async () => {
      await expect(failedPrompt).rejects.toThrow('network down');
    });

    expect(blocks).toMatchObject([
      { kind: 'user', text: 'fail later' },
      { kind: 'assistant', text: 'partial', streaming: false },
    ]);
    expect(notices).toMatchObject([
      {
        category: 'user_action',
        operation: 'send_prompt',
        message: 'Prompt failed: network down',
      },
    ]);
  });

  it('does not insert abort errors from shell commands into the transcript', async () => {
    const session = createMockSession({
      events: createIdleEvents(),
      shellCommand: vi.fn(async () => {
        throw createAbortError();
      }),
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonSessionActions | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      actions = useDaemonActions();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });

    await act(async () => {
      await expect(
        requireActions(actions).sendShellCommand('echo ok'),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });
    expect(blocks.some((block) => block.kind === 'error')).toBe(false);
  });

  it('keeps cancellation turn errors in the transcript', async () => {
    const session = createMockSession({
      events: async function* cancellationTurnErrorEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          id: 11,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'working' },
            },
          },
        };
        yield {
          id: 12,
          v: 1,
          type: 'turn_error',
          data: {
            promptId: 'prompt-1',
            message: 'Request was aborted.',
          },
        };
        if (opts.signal?.aborted) return;
      },
    });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });

    expect(blocks).toEqual([
      expect.objectContaining({
        kind: 'assistant',
        text: 'working',
        streaming: false,
      }),
      expect.objectContaining({
        kind: 'error',
        text: 'Request was aborted.',
        source: 'turn_error',
      }),
    ]);
  });

  it('exposes prompt cancellation events as transcript blocks', async () => {
    const session = createMockSession({
      events: async function* promptCancelledEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          id: 11,
          v: 1,
          type: 'prompt_cancelled',
          data: {
            sessionId: 'session-1',
            reason: 'user_cancel',
          },
        };
        if (opts.signal?.aborted) return;
      },
    });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });

    expect(blocks).toMatchObject([
      {
        kind: 'prompt_cancelled',
        reason: 'user_cancel',
      },
    ]);
  });

  it('keeps forward-failed prompt cancellations out of blocks', async () => {
    const session = createMockSession({
      events: async function* forwardFailedPromptCancelledEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          id: 11,
          v: 1,
          type: 'prompt_cancelled',
          data: {
            sessionId: 'session-1',
            reason: 'forward_failed',
          },
        };
        yield {
          id: 12,
          v: 1,
          type: 'turn_error',
          data: {
            sessionId: 'session-1',
            message: '无效的api key',
            code: '-32603',
          },
        };
        if (opts.signal?.aborted) return;
      },
    });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });

    expect(blocks).toEqual([
      expect.objectContaining({
        kind: 'error',
        text: '无效的api key',
        source: 'turn_error',
      }),
    ]);
  });

  it('exposes catchingUp on resume and clears it on replay_complete', async () => {
    // Resume subscriptions (session carries a Last-Event-ID) get a
    // deterministic catch-up indicator: `catchingUp` arms on connect and
    // clears when the daemon's `replay_complete` sentinel arrives.
    const replayDrained = createDeferred<void>();
    const session = createMockSession({
      lastEventId: 5,
      events: async function* resumeThenIdle(
        opts: { signal?: AbortSignal } = {},
      ) {
        // First a replayed history frame, then the sentinel, then idle.
        yield {
          id: 6,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'replayed' },
            },
          },
        };
        yield {
          v: 1,
          type: 'replay_complete',
          data: { replayedCount: 1, lastReplayedEventId: 6 },
        };
        replayDrained.resolve();
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });
    sdkMocks.sessions.push(session);

    const states: DaemonConnectionState[] = [];
    function Harness() {
      const connection = useDaemonConnection();
      states.push(connection);
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await replayDrained.promise;
      await flushPromises();
    });

    // While catching up we surface catchingUp:true; after replay_complete
    // it clears to a plain connected state.
    expect(states.some((s) => s.status === 'connected' && s.catchingUp)).toBe(
      true,
    );
    const last = states[states.length - 1];
    expect(last?.status).toBe('connected');
    expect(last?.catchingUp).toBeFalsy();
  });

  it('does not re-arm catchingUp after injecting replay for a resumed session', async () => {
    const session = createMockSession({
      lastEventId: 5,
      replaySnapshot: createTextReplaySnapshot('replayed transcript'),
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(session);

    const states: DaemonConnectionState[] = [];
    let blocks: readonly DaemonTranscriptBlock[] = [];
    function Harness() {
      const connection = useDaemonConnection();
      states.push(connection);
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });

    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'replayed transcript' },
    ]);
    expect(states.every((s) => !s.catchingUp)).toBe(true);
    expect(states[states.length - 1]).toMatchObject({
      status: 'connected',
      sessionId: 'session-1',
      catchingUp: undefined,
    });
  });

  it('never sets catchingUp on a fresh subscription (no Last-Event-ID)', async () => {
    // A first-time attach has no resume cursor → the daemon emits no
    // replay_complete → arming catchingUp would stick forever. The Provider
    // only arms it when session.lastEventId is defined.
    const session = createMockSession({
      lastEventId: undefined, // fresh subscribe, live tail
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(session);

    const states: DaemonConnectionState[] = [];
    function Harness() {
      states.push(useDaemonConnection());
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });

    expect(states.some((s) => s.status === 'connected')).toBe(true);
    expect(states.every((s) => !s.catchingUp)).toBe(true);
  });

  it('clears prompt state and transcript when reconnect attaches a different session', async () => {
    const firstEvents = createClosableEvents();
    const firstSession = createMockSession({
      sessionId: 'session-a',
      submitPrompt: vi.fn(
        (_req: unknown, signal?: AbortSignal) =>
          new Promise<NonBlockingPromptAccepted>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(createAbortError()),
              { once: true },
            );
          }),
      ),
      events: async function* missingSessionEvents() {
        await firstEvents.closed.promise;
        yield* [];
        throw Object.assign(new Error('missing session'), { status: 404 });
      },
    });
    const secondTurnComplete = createDeferred<void>();
    const secondSession = createMockSession({
      sessionId: 'session-b',
      submitPrompt: vi.fn(async () => ({
        promptId: 'prompt-1',
        lastEventId: 10,
      })),
      events: createTurnCompleteEvents(secondTurnComplete),
    });
    sdkMocks.sessions.push(firstSession, secondSession);
    let actions: DaemonUiSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    const providerActions = requireActions(actions);

    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('old prompt');
      await flushPromises();
    });
    expect(blocks).toMatchObject([{ kind: 'user', text: 'old prompt' }]);

    firstEvents.close();
    await act(async () => {
      await wait(20);
      await flushPromises();
    });

    expect(connection).toMatchObject({
      status: 'disconnected',
      error: 'missing session',
    });
    expect(connection?.missingSession).not.toBe(true);
    expect(connection?.sessionId).toBeUndefined();
    const abortedPrompt = promptResult;
    if (!abortedPrompt) throw new Error('prompt was not started');
    await expect(abortedPrompt).resolves.toEqual({ stopReason: 'cancelled' });

    await act(async () => {
      await expect(providerActions.sendPrompt('new prompt')).rejects.toThrow(
        'Daemon session is not connected',
      );
    });
    expect(secondSession.submitPrompt).not.toHaveBeenCalled();
  });

  it('reuses the same session client after a normal SSE stream end', async () => {
    const events = vi.fn(async function* reusableEvents(
      opts: { signal?: AbortSignal } = {},
    ) {
      if (events.mock.calls.length === 1) {
        const event: DaemonEvent = {
          id: 5,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'hello' },
            },
          },
        };
        yield event;
        return;
      }
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) {
          resolve();
          return;
        }
        opts.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
      yield* [];
    });
    const session = createMockSession({ events });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await wait(5);
      await flushPromises();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledTimes(2);
    expect(blocks).toMatchObject([{ kind: 'assistant', text: 'hello' }]);
  });

  it('does not inject replay snapshot again after a normal SSE stream end', async () => {
    const events = vi.fn(async function* replayThenReusableEvents(
      opts: { signal?: AbortSignal } = {},
    ) {
      if (events.mock.calls.length === 1) {
        return;
      }
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) {
          resolve();
          return;
        }
        opts.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
      yield* [];
    });
    const session = createMockSession({
      replaySnapshot: {
        compactedReplay: [
          {
            id: 1,
            v: 1,
            type: 'session_update',
            originatorClientId: 'client-1',
            data: {
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'replayed prompt' },
              },
            },
          },
          {
            id: 2,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'replayed answer' },
              },
            },
          },
          {
            id: 3,
            v: 1,
            type: 'turn_complete',
            data: { stopReason: 'end_turn' },
          },
        ],
        liveJournal: [],
      },
      events,
    });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await wait(5);
      await flushPromises();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledTimes(2);
    expect(blocks.filter((block) => block.kind === 'user')).toHaveLength(1);
    expect(blocks.filter((block) => block.kind === 'assistant')).toHaveLength(
      1,
    );
    expect(blocks).toMatchObject([
      { kind: 'user', text: 'replayed prompt' },
      { kind: 'assistant', text: 'replayed answer', streaming: false },
    ]);
  });

  it('injects replay snapshot on initial session load', async () => {
    const session = createMockSession({
      replaySnapshot: {
        compactedReplay: [
          {
            id: 1,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'initial replay' },
              },
            },
          },
          {
            id: 2,
            v: 1,
            type: 'turn_complete',
            data: { stopReason: 'end_turn' },
          },
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'initial replay', streaming: false },
    ]);
  });

  it('keeps replayed non-turn events from marking a prompt as waiting', async () => {
    const session = createMockSession({
      replaySnapshot: {
        compactedReplay: [
          {
            id: 1,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'initial replay' },
              },
            },
          },
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(promptStatus).toBe('idle');
  });

  it('keeps restored active prompts streaming after replay completes', async () => {
    const replayDrained = createDeferred<void>();
    const session = createMockSession({
      hasActivePrompt: true,
      lastEventId: 5,
      events: async function* restoredPromptThenReplayComplete(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          v: 1,
          type: 'replay_complete',
          data: { replayedCount: 0, lastReplayedEventId: 5 },
        };
        replayDrained.resolve();
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });
    sdkMocks.sessions.push(session);
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await replayDrained.promise;
      await flushPromises();
    });

    expect(promptStatus).toBe('streaming');
  });

  it('keeps restored active prompts streaming after an SSE stream end', async () => {
    const streamEnded = createDeferred<void>();
    const events = vi.fn(async function* restoredPromptThenStreamEnd(
      opts: { signal?: AbortSignal } = {},
    ) {
      for (const event of [] as DaemonEvent[]) yield event;
      if (events.mock.calls.length === 1) {
        streamEnded.resolve();
        return;
      }
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) {
          resolve();
          return;
        }
        opts.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
    });
    const session = createMockSession({
      hasActivePrompt: true,
      events,
    });
    sdkMocks.sessions.push(session);
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 1000,
    });
    await act(async () => {
      await streamEnded.promise;
      await flushPromises();
    });

    expect(promptStatus).toBe('streaming');
  });

  it('keeps local prompts active when a restored prompt completes', async () => {
    const accepted = createDeferred<NonBlockingPromptAccepted>();
    const releaseRestoredComplete = createDeferred<void>();
    const restoredCompleteDelivered = createDeferred<void>();
    const releaseLocalComplete = createDeferred<void>();
    const localCompleteDelivered = createDeferred<void>();
    const session = createMockSession({
      hasActivePrompt: true,
      submitPrompt: vi.fn(() => accepted.promise),
      events: async function* restoredPromptCompleteDuringLocalPrompt() {
        await releaseRestoredComplete.promise;
        yield {
          id: 6,
          v: 1,
          type: 'turn_complete',
          data: { promptId: 'restored-prompt', stopReason: 'end_turn' },
        } satisfies DaemonEvent;
        restoredCompleteDelivered.resolve();
        await releaseLocalComplete.promise;
        yield {
          id: 7,
          v: 1,
          type: 'turn_complete',
          data: { promptId: 'local-prompt', stopReason: 'end_turn' },
        } satisfies DaemonEvent;
        localCompleteDelivered.resolve();
      },
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      actions = useDaemonActions();
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = requireActions(actions).sendPrompt('local prompt');
      accepted.resolve({ promptId: 'local-prompt', lastEventId: 10 });
      await flushPromises();
      releaseRestoredComplete.resolve();
      await restoredCompleteDelivered.promise;
      await flushPromises();
    });

    expect(promptStatus).not.toBe('idle');

    await act(async () => {
      releaseLocalComplete.resolve();
      await localCompleteDelivered.promise;
      await flushPromises();
    });
    await expect(promptResult).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('keeps restored active prompts busy after shell commands finish', async () => {
    const session = createMockSession({
      hasActivePrompt: true,
      shellCommand: vi.fn(async () => undefined),
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonSessionActions | undefined;
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      actions = useDaemonActions();
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await requireActions(actions).sendShellCommand('echo ok');
      await flushPromises();
    });

    expect(promptStatus).not.toBe('idle');
  });

  it('settles restored active prompts when turn_complete arrives', async () => {
    const turnCompleted = createDeferred<void>();
    const session = createMockSession({
      hasActivePrompt: true,
      lastEventId: 5,
      events: async function* restoredPromptThenTurnComplete() {
        yield {
          id: 6,
          v: 1,
          type: 'turn_complete',
          data: { promptId: 'restored-prompt', stopReason: 'end_turn' },
        };
        turnCompleted.resolve();
      },
    });
    sdkMocks.sessions.push(session);
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await turnCompleted.promise;
      await flushPromises();
    });

    expect(promptStatus).toBe('idle');
  });

  it('settles restored active prompts when turn_error arrives', async () => {
    const turnErrored = createDeferred<void>();
    const session = createMockSession({
      hasActivePrompt: true,
      lastEventId: 5,
      events: async function* restoredPromptThenTurnError() {
        yield {
          id: 6,
          v: 1,
          type: 'turn_error',
          data: {
            promptId: 'restored-prompt',
            message: 'failed',
            code: 'error',
          },
        } satisfies DaemonEvent;
        turnErrored.resolve();
      },
    });
    sdkMocks.sessions.push(session);
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await turnErrored.promise;
      await flushPromises();
    });

    expect(promptStatus).toBe('idle');
  });

  it('settles restored active prompts when prompt_cancelled arrives', async () => {
    const promptCancelled = createDeferred<void>();
    const session = createMockSession({
      hasActivePrompt: true,
      lastEventId: 5,
      events: async function* restoredPromptThenPromptCancelled() {
        yield {
          id: 6,
          v: 1,
          type: 'prompt_cancelled',
          originatorClientId: 'client-1',
          data: {
            sessionId: 'session-1',
            reason: 'user_cancel',
          },
        } satisfies DaemonEvent;
        promptCancelled.resolve();
      },
    });
    sdkMocks.sessions.push(session);
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await promptCancelled.promise;
      await flushPromises();
    });

    expect(promptStatus).toBe('idle');
  });

  it('keeps local prompts active when a restored prompt is cancelled', async () => {
    const accepted = createDeferred<NonBlockingPromptAccepted>();
    const releaseRestoredCancel = createDeferred<void>();
    const restoredCancelDelivered = createDeferred<void>();
    const releaseLocalComplete = createDeferred<void>();
    const localCompleteDelivered = createDeferred<void>();
    const session = createMockSession({
      hasActivePrompt: true,
      submitPrompt: vi.fn(() => accepted.promise),
      events: async function* restoredPromptCancelDuringLocalPrompt() {
        await releaseRestoredCancel.promise;
        yield {
          id: 6,
          v: 1,
          type: 'prompt_cancelled',
          originatorClientId: 'client-2',
          data: { sessionId: 'session-1', reason: 'user_cancel' },
        } satisfies DaemonEvent;
        restoredCancelDelivered.resolve();
        await releaseLocalComplete.promise;
        yield {
          id: 7,
          v: 1,
          type: 'turn_complete',
          data: { promptId: 'local-prompt', stopReason: 'end_turn' },
        } satisfies DaemonEvent;
        localCompleteDelivered.resolve();
      },
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      actions = useDaemonActions();
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = requireActions(actions).sendPrompt('local prompt');
      accepted.resolve({ promptId: 'local-prompt', lastEventId: 10 });
      await flushPromises();
      releaseRestoredCancel.resolve();
      await restoredCancelDelivered.promise;
      await flushPromises();
    });

    expect(promptStatus).not.toBe('idle');

    await act(async () => {
      releaseLocalComplete.resolve();
      await localCompleteDelivered.promise;
      await flushPromises();
    });
    await expect(promptResult).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('does not revive settled restored active prompts after SSE reconnect', async () => {
    const turnCompleted = createDeferred<void>();
    const reconnected = createDeferred<void>();
    const events = vi.fn(async function* restoredPromptThenReconnect(
      opts: { signal?: AbortSignal } = {},
    ) {
      if (events.mock.calls.length === 1) {
        yield {
          id: 6,
          v: 1,
          type: 'turn_complete',
          data: { promptId: 'restored-prompt', stopReason: 'end_turn' },
        } satisfies DaemonEvent;
        turnCompleted.resolve();
        return;
      }
      reconnected.resolve();
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) {
          resolve();
          return;
        }
        opts.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
    });
    const session = createMockSession({
      hasActivePrompt: true,
      events,
    });
    sdkMocks.sessions.push(session);
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await turnCompleted.promise;
      await reconnected.promise;
      await flushPromises();
    });

    expect(promptStatus).toBe('idle');
  });

  it('reloads restored active prompts after epoch reset', async () => {
    const reloaded = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-epoch-active',
      hasActivePrompt: true,
      events: async function* restoredPromptEpochReset() {
        yield {
          id: 6,
          v: 1,
          type: 'state_resync_required',
          data: { reason: 'epoch_reset' },
        } satisfies DaemonEvent;
      },
    });
    const reloadedSession = createMockSession({
      sessionId: 'session-epoch-active',
      hasActivePrompt: true,
      events: createPendingEvents(reloaded),
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await reloaded.promise;
      await flushPromises();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledWith(
      expect.anything(),
      'session-epoch-active',
      { workspaceCwd: '/mock-workspace' },
      expect.any(String),
    );
    expect(promptStatus).toBe('streaming');
  });

  it('clears restored active prompts when epoch reload is idle', async () => {
    const reloaded = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-epoch-idle',
      hasActivePrompt: true,
      events: async function* restoredPromptEpochReset() {
        yield {
          id: 6,
          v: 1,
          type: 'state_resync_required',
          data: { reason: 'epoch_reset' },
        } satisfies DaemonEvent;
      },
    });
    const reloadedSession = createMockSession({
      sessionId: 'session-epoch-idle',
      hasActivePrompt: false,
      events: createPendingEvents(reloaded),
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await reloaded.promise;
      await flushPromises();
    });

    expect(promptStatus).toBe('idle');
  });

  it('keeps restored active prompts streaming after retriable SSE errors', async () => {
    const streamFailed = createDeferred<void>();
    const session = createMockSession({
      hasActivePrompt: true,
      events: async function* restoredPromptThenRetriableError() {
        for (const event of [] as DaemonEvent[]) yield event;
        streamFailed.resolve();
        throw new Error('network reset');
      },
    });
    sdkMocks.sessions.push(session);
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 1000,
    });
    await act(async () => {
      await streamFailed.promise;
      await flushPromises();
    });

    expect(promptStatus).toBe('streaming');
  });

  it('keeps locally submitted prompts active after retriable SSE errors', async () => {
    const accepted = createDeferred<NonBlockingPromptAccepted>();
    const streamFailed = createDeferred<void>();
    let callCount = 0;
    const events = vi.fn(async function* localPromptThenRetriableError(
      opts: { signal?: AbortSignal } = {},
    ) {
      callCount += 1;
      if (callCount === 1) {
        yield {
          id: 5,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'working' },
            },
          },
        } satisfies DaemonEvent;
        streamFailed.resolve();
        throw new Error('network reset');
      }
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) {
          resolve();
          return;
        }
        opts.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
    });
    const session = createMockSession({
      submitPrompt: vi.fn(() => accepted.promise),
      events,
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      actions = useDaemonActions();
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    const providerActions = requireActions(actions);

    await act(async () => {
      void providerActions.sendPrompt('keep running');
      accepted.resolve({ promptId: 'prompt-1', lastEventId: 10 });
      await streamFailed.promise;
      await wait(20);
      await flushPromises();
    });

    expect(events).toHaveBeenCalledTimes(2);
    expect(promptStatus).not.toBe('idle');
  });

  it('keeps restored active prompts streaming after resync requests', async () => {
    const resyncSeen = createDeferred<void>();
    const reloaded = createDeferred<void>();
    const session = createMockSession({
      sessionId: 'session-restored-resync',
      hasActivePrompt: true,
      events: async function* restoredPromptThenResync() {
        resyncSeen.resolve();
        yield {
          id: 6,
          v: 1,
          type: 'state_resync_required',
          data: { reason: 'epoch_reset' },
        } satisfies DaemonEvent;
      },
    });
    const reloadedSession = createMockSession({
      sessionId: 'session-restored-resync',
      hasActivePrompt: true,
      events: createPendingEvents(reloaded),
    });
    sdkMocks.sessions.push(session, reloadedSession);
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1000,
      maxReconnectDelayMs: 1000,
    });
    await act(async () => {
      await resyncSeen.promise;
      await reloaded.promise;
      await flushPromises();
    });

    expect(promptStatus).toBe('streaming');
  });

  it('does not infer active prompts from replayed user turns without terminal events', async () => {
    const session = createMockSession({
      replaySnapshot: {
        compactedReplay: [
          {
            id: 1,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'replayed prompt' },
              },
            },
          },
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';

    function Harness() {
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(promptStatus).toBe('idle');
  });

  it('finishes replayed assistant streaming when replay ends with turn_error', async () => {
    const session = createMockSession({
      replaySnapshot: {
        compactedReplay: [
          {
            id: 1,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'partial replay' },
              },
            },
          },
          {
            id: 2,
            v: 1,
            type: 'turn_error',
            data: { message: 'model overloaded' },
          },
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    let streamingState: ReturnType<typeof useDaemonStreamingState> = 'idle';
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      streamingState = useDaemonStreamingState();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(streamingState).toBe('idle');
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'partial replay', streaming: false },
      {
        kind: 'error',
        text: 'model overloaded',
        source: 'turn_error',
      },
    ]);
  });

  it('finishes each completed turn in replay snapshots', async () => {
    const session = createMockSession({
      replaySnapshot: {
        compactedReplay: [
          {
            id: 1,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'first done' },
              },
            },
          },
          {
            id: 2,
            v: 1,
            type: 'turn_complete',
            data: { stopReason: 'end_turn' },
          },
          {
            id: 3,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'second done' },
              },
            },
          },
          {
            id: 4,
            v: 1,
            type: 'turn_complete',
            data: { stopReason: 'end_turn' },
          },
        ],
        liveJournal: [
          {
            id: 5,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'still running' },
              },
            },
          },
        ],
      },
    });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(blocks.filter((block) => block.kind === 'assistant')).toMatchObject([
      { text: 'first done', streaming: false },
      { text: 'second done', streaming: false },
      { text: 'still running', streaming: true },
    ]);
  });

  it('does not let replay state events overwrite fresh connection status', async () => {
    sdkMocks.workspaceProviders.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/mock-workspace',
      initialized: true,
      current: { authType: 'openai', modelId: 'provider-model' },
      providers: [
        {
          kind: 'model_provider',
          status: 'ok',
          authType: 'openai',
          current: true,
          models: [
            {
              modelId: 'provider-model',
              name: 'Provider Model',
              contextLimit: 1000,
              isCurrent: true,
            },
            {
              modelId: 'fresh-model',
              name: 'Fresh Model',
              contextLimit: 2000,
              isCurrent: false,
            },
          ],
        },
      ],
    });
    const session = createMockSession({
      context: vi.fn(async () => ({
        v: 1 as const,
        sessionId: 'session-1',
        workspaceCwd: '/mock-workspace',
        state: {
          modes: { currentModeId: 'fresh-mode' },
          models: { currentModelId: 'fresh-model' },
        },
      })),
      supportedCommands: vi.fn(async () => ({
        v: 1 as const,
        sessionId: 'session-1',
        availableCommands: [
          {
            name: 'fresh-command',
            description: 'Fresh command',
            input: null,
            _meta: { source: 'builtin' },
          },
        ],
        availableSkills: ['fresh-skill'],
      })),
      replaySnapshot: {
        compactedReplay: [
          {
            id: 1,
            v: 1,
            type: 'approval_mode_changed',
            data: { next: 'stale-mode' },
          },
          {
            id: 2,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'available_commands_update',
                availableCommands: [
                  {
                    name: 'stale-command',
                    description: 'Stale command',
                    input: null,
                    _meta: { source: 'builtin' },
                  },
                ],
                availableSkills: ['stale-skill'],
              },
            },
          },
          {
            id: 3,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'replayed answer' },
              },
            },
          },
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    let connection: DaemonConnectionState | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      connection = useDaemonConnection();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assistant',
          text: 'replayed answer',
        }),
      ]),
    );
    expect(connection).toMatchObject({
      currentMode: 'fresh-mode',
      currentModel: 'fresh-model',
      contextWindow: 2000,
      skills: ['fresh-skill'],
    });
    expect(connection?.commands?.map((command) => command.name)).toEqual([
      'fresh-command',
      'fresh-skill',
    ]);
  });

  it('uses providers current model when session context has no model', async () => {
    sdkMocks.workspaceProviders.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/mock-workspace',
      initialized: true,
      current: { authType: 'openai', modelId: 'provider-default' },
      providers: [
        {
          kind: 'model_provider',
          status: 'ok',
          authType: 'openai',
          current: true,
          models: [
            {
              modelId: 'provider-default',
              name: 'Provider Default',
              contextLimit: 4096,
              isCurrent: true,
            },
          ],
        },
      ],
    });
    const session = createMockSession({
      context: vi.fn(async () => ({
        v: 1 as const,
        sessionId: 'session-1',
        workspaceCwd: '/mock-workspace',
        state: { modes: { currentModeId: 'default' } },
      })),
    });
    sdkMocks.sessions.push(session);
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection).toMatchObject({
      currentModel: 'provider-default',
      contextWindow: 4096,
    });
  });

  it('seeds tokenCount from the latest replay usage on attach', async () => {
    const session = createMockSession({
      replaySnapshot: {
        compactedReplay: [
          {
            id: 1,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'old answer' },
                _meta: { usage: { inputTokens: 11_000, totalTokens: 12_000 } },
              },
            },
          },
          {
            id: 2,
            v: 1,
            type: 'turn_complete',
            data: { stopReason: 'end_turn' },
          },
          {
            id: 3,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'latest answer' },
                _meta: { usage: { inputTokens: 23_000, totalTokens: 25_000 } },
              },
            },
          },
          {
            id: 4,
            v: 1,
            type: 'turn_complete',
            data: { stopReason: 'end_turn' },
          },
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection?.tokenCount).toBe(23_000);
    expect(connection?.tokenUsage).toEqual({
      inputTokens: 23_000,
      totalTokens: 25_000,
    });
  });

  it('keeps the in-memory tokenCount across SSE re-subscribe when replay has no usage', async () => {
    const events = vi.fn(async function* usageThenReusableEvents(
      opts: { signal?: AbortSignal } = {},
    ) {
      if (events.mock.calls.length === 1) {
        const event: DaemonEvent = {
          id: 5,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'counted' },
              _meta: { usage: { inputTokens: 7_000, totalTokens: 7_500 } },
            },
          },
        };
        yield event;
        return;
      }
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) {
          resolve();
          return;
        }
        opts.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
      yield* [];
    });
    const session = createMockSession({ events });
    sdkMocks.sessions.push(session);
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await wait(5);
      await flushPromises();
    });

    // The stream ended once and the provider re-subscribed on the same
    // session object; its (empty) original replay snapshot must not reset
    // the live count.
    expect(events).toHaveBeenCalledTimes(2);
    expect(connection?.tokenCount).toBe(7_000);
    expect(connection?.tokenUsage).toEqual({
      inputTokens: 7_000,
      totalTokens: 7_500,
    });
  });

  it('resets tokenCount when reconnect attaches a different session without replay usage', async () => {
    const firstEvents = createClosableEvents();
    const firstSession = createMockSession({
      sessionId: 'session-usage-a',
      events: async function* usageThenGoneEvents() {
        const event: DaemonEvent = {
          id: 5,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'counted' },
              _meta: { usage: { inputTokens: 7_000, totalTokens: 7_500 } },
            },
          },
        };
        yield event;
        await firstEvents.closed.promise;
        yield* [];
        throw Object.assign(new Error('missing session'), { status: 404 });
      },
    });
    const secondSession = createMockSession({
      sessionId: 'session-usage-b',
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(firstSession, secondSession);
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await flushPromises();
    });
    expect(connection?.tokenCount).toBe(7_000);
    expect(connection?.tokenUsage).toEqual({
      inputTokens: 7_000,
      totalTokens: 7_500,
    });

    firstEvents.close();
    await act(async () => {
      await wait(20);
      await flushPromises();
    });

    expect(connection).toMatchObject({
      status: 'disconnected',
      error: 'missing session',
    });
    expect(connection?.missingSession).not.toBe(true);
    expect(connection?.sessionId).toBeUndefined();
  });

  it('bumps workspace event signals from replay snapshot events', async () => {
    const session = createMockSession({
      replaySnapshot: {
        compactedReplay: [
          {
            id: 1,
            v: 1,
            type: 'memory_changed',
            data: {
              scope: 'workspace',
              filePath: '/mock-workspace/QWEN.md',
              mode: 'append',
              bytesWritten: 12,
            },
          },
          {
            id: 2,
            v: 1,
            type: 'agent_changed',
            data: {
              change: 'updated',
              name: 'reviewer',
              level: 'project',
            },
          },
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    let signals: DaemonWorkspaceEventSignals | undefined;

    function Harness() {
      signals = useDaemonWorkspaceEventSignals();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(signals).toMatchObject({
      memoryVersion: 1,
      agentsVersion: 1,
      toolsVersion: 0,
      mcpVersion: 0,
      initVersion: 0,
      authVersion: 0,
    });
  });

  it('finishes passive assistant streaming when no prompt action is active', async () => {
    vi.useFakeTimers();
    try {
      const session = createMockSession({
        events: async function* passiveAssistantEvents(
          opts: { signal?: AbortSignal } = {},
        ) {
          yield {
            id: 9,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'passive' },
              },
            },
          };
          await new Promise<void>((resolve) => {
            if (opts.signal?.aborted) {
              resolve();
              return;
            }
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
        },
      });
      sdkMocks.sessions.push(session);
      let blocks: readonly DaemonTranscriptBlock[] = [];

      function Harness() {
        blocks = useDaemonTranscriptBlocks();
        return null;
      }

      await renderWithProvider(<Harness />, { autoConnect: true });
      await act(async () => {
        await flushPromises();
      });
      expect(blocks).toMatchObject([
        { kind: 'assistant', text: 'passive', streaming: true },
      ]);

      await act(async () => {
        vi.advanceTimersByTime(3000);
        await flushPromises();
      });

      expect(blocks).toMatchObject([
        { kind: 'assistant', text: 'passive', streaming: false },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finishes replayed assistant streaming when replay completes', async () => {
    vi.useFakeTimers();
    try {
      const session = createMockSession({
        events: async function* replayEvents(
          opts: { signal?: AbortSignal } = {},
        ) {
          yield {
            id: 9,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'replayed' },
              },
            },
          };
          yield {
            v: 1,
            type: 'replay_complete',
            data: { lastEventId: 9, replayedCount: 1 },
          };
          await new Promise<void>((resolve) => {
            if (opts.signal?.aborted) {
              resolve();
              return;
            }
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
        },
      });
      sdkMocks.sessions.push(session);
      let blocks: readonly DaemonTranscriptBlock[] = [];
      let streamingState: ReturnType<typeof useDaemonStreamingState> = 'idle';

      function Harness() {
        blocks = useDaemonTranscriptBlocks();
        streamingState = useDaemonStreamingState();
        return null;
      }

      await renderWithProvider(<Harness />, { autoConnect: true });
      await act(async () => {
        await flushPromises();
      });

      expect(streamingState).toBe('idle');
      expect(blocks).toMatchObject([
        { kind: 'assistant', text: 'replayed', streaming: false },
      ]);

      await act(async () => {
        vi.advanceTimersByTime(3000);
        await flushPromises();
      });

      expect(streamingState).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates a fresh thread session without cancelling the previous session', async () => {
    const firstSession = createMockSession({ sessionId: 'session-a' });
    const secondSession = createMockSession({ sessionId: 'session-b' });
    sdkMocks.sessions.push(firstSession, secondSession);
    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({ sessionId: 'session-a' });

    await act(async () => {
      await actions?.newSession();
      await wait(5);
      await flushPromises();
    });

    expect(connection).toMatchObject({ sessionId: 'session-b' });
    expect(firstSession.cancel).not.toHaveBeenCalled();
    expect(firstSession.close).not.toHaveBeenCalled();
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).toHaveBeenCalledTimes(1);
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach.mock.calls[0]?.[1],
    ).toMatchObject({
      workspaceCwd: '/mock-workspace',
      sessionScope: 'thread',
    });
  });

  it('creates a session from the active session client when already attached', async () => {
    const firstSession = createMockSession({ sessionId: 'session-a' });
    const secondSession = createMockSession({ sessionId: 'session-b' });
    sdkMocks.sessions.push(firstSession, secondSession);
    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({ sessionId: 'session-a' });
    const activeClient = firstSession.client;
    if (!activeClient) throw new Error('session client was not attached');
    sdkMocks.MockDaemonSessionClient.createOrAttach.mockClear();

    await act(async () => {
      await actions?.createSession();
      await flushPromises();
    });

    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).toHaveBeenCalledTimes(1);
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach.mock.calls[0]?.[0],
    ).toBe(activeClient);
    expect(connection).toMatchObject({ sessionId: 'session-a' });
  });

  it('clears the current session without creating a replacement session', async () => {
    const firstSession = createMockSession({ sessionId: 'session-a' });
    sdkMocks.sessions.push(firstSession);
    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });
    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({ sessionId: 'session-a' });
    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).not.toHaveBeenCalled();

    await act(async () => {
      await actions?.clearSession();
    });

    for (let i = 0; i < 10 && connection?.status !== 'connected'; i++) {
      await act(async () => {
        await wait(5);
        await flushPromises();
      });
    }

    expect(connection).toMatchObject({ status: 'connected' });
    expect(connection).not.toHaveProperty('sessionId');
    expect(blocks).toEqual([]);
    expect(firstSession.detach).toHaveBeenCalledTimes(1);
    expect(firstSession.close).not.toHaveBeenCalled();
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).not.toHaveBeenCalled();
  });

  it('keeps workspace skill slash commands after clearing so /review still autocompletes', async () => {
    const firstSession = createMockSession({
      sessionId: 'session-a',
      supportedCommands: vi.fn(async () => ({
        v: 1 as const,
        sessionId: 'session-a',
        availableCommands: [],
        availableSkills: ['review'],
      })),
    });
    sdkMocks.sessions.push(firstSession);
    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });
    await act(async () => {
      await flushPromises();
    });
    expect(connection?.commands?.map((command) => command.name)).toContain(
      'review',
    );
    expect(connection?.skills).toContain('review');

    await act(async () => {
      await actions?.clearSession();
    });
    for (let i = 0; i < 10 && connection?.sessionId !== undefined; i++) {
      await act(async () => {
        await wait(5);
        await flushPromises();
      });
    }

    // Clearing returns to the deferred pre-first-prompt state (no sessionId),
    // but the workspace-scoped skill command must survive so '/rev' + Tab keeps
    // completing '/review' in the new session before its first prompt creates a
    // session (matches the initial deferred-connect guarantee from #6153).
    expect(connection).not.toHaveProperty('sessionId');
    expect(connection?.commands?.map((command) => command.name)).toContain(
      'review',
    );
    expect(connection?.skills).toContain('review');
    // The session-scoped raw snapshots are still dropped so the next session
    // refetches instead of reusing stale metadata.
    expect(connection).not.toHaveProperty('supportedCommands');
    expect(connection).not.toHaveProperty('context');
  });

  it('drops preserved commands when the next session reports an empty list', async () => {
    const firstSession = createMockSession({
      sessionId: 'session-a',
      supportedCommands: vi.fn(async () => ({
        v: 1 as const,
        sessionId: 'session-a',
        availableCommands: [
          { name: 'cmd-a', description: 'Command A', input: null },
        ],
        availableSkills: ['review'],
      })),
    });
    const emptySession = createMockSession({
      sessionId: 'session-b',
      supportedCommands: vi.fn(async () => ({
        v: 1 as const,
        sessionId: 'session-b',
        availableCommands: [],
        availableSkills: [],
      })),
    });
    // session-a loads on mount; the detached session created after the clear
    // pops session-b next.
    sdkMocks.sessions.push(firstSession, emptySession);
    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });
    await act(async () => {
      await flushPromises();
    });
    expect(connection?.commands?.map((command) => command.name)).toContain(
      'cmd-a',
    );

    await act(async () => {
      await actions?.clearSession();
    });
    // The preserved list keeps autocompleting through the clear (commands is
    // still present here)...
    expect(connection?.commands?.map((command) => command.name)).toContain(
      'cmd-a',
    );

    // ...but once the next session's supported-commands fetch comes back empty,
    // that fulfilled snapshot is authoritative — the stale commands must not
    // survive it.
    const providerActions = requireActions(actions);
    await act(async () => {
      await providerActions.createSession();
    });
    let attach: Promise<void> | undefined;
    act(() => {
      attach = providerActions.attachSession();
    });
    await act(async () => {
      await flushPromises();
    });
    await attach;

    expect(connection).toMatchObject({ sessionId: 'session-b' });
    expect(connection?.commands).toEqual([]);
    expect(connection?.skills).toEqual([]);
  });

  it('keeps preserved commands when the next supported-commands fetch fails', async () => {
    const firstSession = createMockSession({
      sessionId: 'session-a',
      supportedCommands: vi.fn(async () => ({
        v: 1 as const,
        sessionId: 'session-a',
        availableCommands: [
          { name: 'cmd-a', description: 'Command A', input: null },
        ],
        availableSkills: ['review'],
      })),
    });
    const failingSession = createMockSession({
      sessionId: 'session-b',
      supportedCommands: vi.fn(async () => {
        throw new Error('supported-commands unavailable');
      }),
    });
    sdkMocks.sessions.push(firstSession, failingSession);
    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });
    await act(async () => {
      await flushPromises();
    });
    expect(connection?.commands?.map((command) => command.name)).toContain(
      'cmd-a',
    );

    await act(async () => {
      await actions?.clearSession();
    });

    // A skipped or failed fetch is not authoritative — unlike a fulfilled empty
    // snapshot it must not clobber the preserved list. supportedCommands()
    // rejecting here leaves supportedCommands === undefined, so the commands
    // survive rather than being wiped.
    const providerActions = requireActions(actions);
    await act(async () => {
      await providerActions.createSession();
    });
    let attach: Promise<void> | undefined;
    act(() => {
      attach = providerActions.attachSession();
    });
    await act(async () => {
      await flushPromises();
    });
    await attach;

    expect(connection).toMatchObject({ sessionId: 'session-b' });
    expect(connection?.commands?.map((command) => command.name)).toContain(
      'cmd-a',
    );
    expect(connection?.skills).toContain('review');
  });

  it('ignores streamed events from a session after it is cleared', async () => {
    const streamStarted = createDeferred<void>();
    const releaseOldEvent = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-a',
      events: async function* staleEvents() {
        streamStarted.resolve();
        await releaseOldEvent.promise;
        yield {
          id: 1,
          v: 1,
          type: 'session_update',
          sessionId: 'session-a',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'stale output' },
            },
          },
        };
      },
    });
    sdkMocks.sessions.push(firstSession);
    let actions: DaemonSessionActions | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      actions = useDaemonActions();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });
    await act(async () => {
      await streamStarted.promise;
      await flushPromises();
    });

    await act(async () => {
      await actions?.clearSession();
    });
    releaseOldEvent.resolve();
    await act(async () => {
      await flushPromises();
    });

    expect(blocks).toEqual([]);
  });

  it('clears connection state before detach resolves', async () => {
    const detached = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-a',
      detach: vi.fn(() => detached.promise),
    });
    sdkMocks.sessions.push(firstSession);
    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });
    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({ sessionId: 'session-a' });

    let clearPromise: Promise<void> | undefined;
    act(() => {
      clearPromise = actions?.clearSession();
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection).toMatchObject({ status: 'connected' });
    expect(connection).not.toHaveProperty('sessionId');
    detached.resolve();
    await act(async () => {
      await clearPromise;
      await flushPromises();
    });
    expect(firstSession.detach).toHaveBeenCalledTimes(1);
  });

  it('clears connection state when detaching the current session fails', async () => {
    const detachError = new Error('detach failed');
    const firstSession = createMockSession({
      sessionId: 'session-a',
      detach: vi.fn(async () => {
        throw detachError;
      }),
    });
    sdkMocks.sessions.push(firstSession);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });
    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({ sessionId: 'session-a' });

    await act(async () => {
      await expect(actions?.clearSession()).resolves.toBeUndefined();
    });

    expect(connection).toMatchObject({ status: 'connected' });
    expect(connection).not.toHaveProperty('sessionId');
    expect(blocks).toEqual([]);
    expect(firstSession.detach).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      '[DaemonSessionActions] detach on clear failed:',
      detachError,
    );
  });

  it('uses session-scoped client IDs when switching between loaded sessions', async () => {
    const firstSession = createMockSession({
      sessionId: 'session-a',
      clientId: 'client-a',
    });
    const secondSession = createMockSession({
      sessionId: 'session-b',
      clientId: 'client-b',
    });
    const firstSessionReloaded = createMockSession({
      sessionId: 'session-a',
      clientId: 'client-a',
    });
    sdkMocks.sessions.push(firstSession, secondSession, firstSessionReloaded);
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });
    sdkMocks.MockDaemonSessionClient.load.mockClear();

    const loadB = requireActions(actions)
      .loadSession('session-b')
      .catch(() => undefined);
    await act(async () => {
      await wait(5);
      await flushPromises();
    });
    await loadB;

    const loadA = requireActions(actions)
      .loadSession('session-a')
      .catch(() => undefined);
    await act(async () => {
      await wait(5);
      await flushPromises();
    });
    await loadA;

    const loadCalls = sdkMocks.MockDaemonSessionClient.load.mock.calls;
    expect(loadCalls[0]?.[1]).toBe('session-b');
    expect(loadCalls[0]?.[3]).not.toBe('client-a');
    expect(loadCalls[1]?.[1]).toBe('session-a');
    expect(loadCalls[1]?.[3]).toBe('client-a');
  });

  it('reuses the branched session client when switching after branch', async () => {
    window.sessionStorage.clear();
    const sourceSession = createMockSession({
      sessionId: 'session-a',
      clientId: 'client-a',
    });
    const branchedSession = createMockSession({
      sessionId: 'session-b',
      clientId: 'client-b',
    });
    sdkMocks.branchSession.mockResolvedValue({
      sessionId: 'session-b',
      displayName: 'Branch 1',
      clientId: 'client-b',
    });
    sdkMocks.sessions.push(sourceSession, branchedSession);
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });
    sdkMocks.MockDaemonSessionClient.load.mockClear();

    const branch = requireActions(actions).branchSession('Branch 1');
    await act(async () => {
      await wait(5);
      await flushPromises();
    });
    await expect(branch).resolves.toEqual({
      sessionId: 'session-b',
      displayName: 'Branch 1',
    });

    expect(sdkMocks.branchSession).toHaveBeenCalledWith(
      'session-a',
      { name: 'Branch 1' },
      'client-a',
    );
    const loadCalls = sdkMocks.MockDaemonSessionClient.load.mock.calls;
    expect(loadCalls[0]?.[1]).toBe('session-b');
    expect(loadCalls[0]?.[3]).toBe('client-b');
  });

  it('exposes daemon capabilities on the connection state', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      v: 1,
      mode: 'http-bridge',
      features: ['client_heartbeat', 'workspace_memory'],
      modelServices: ['qwen'],
      workspaceCwd: '/mock-workspace',
    });
    sdkMocks.sessions.push(createMockSession());
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });

    expect(connection?.capabilities).toMatchObject({
      features: ['client_heartbeat', 'workspace_memory'],
      workspaceCwd: '/mock-workspace',
    });
  });

  it('exposes the restored session display name on the connection state', async () => {
    sdkMocks.sessions.push(
      createMockSession({ state: { displayName: 'Named session' } }),
    );
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });

    expect(connection).toMatchObject({
      sessionId: 'session-1',
      displayName: 'Named session',
    });
  });

  it('updates the connection display name from metadata events', async () => {
    sdkMocks.sessions.push(
      createMockSession({
        events: async function* metadataEvents(
          opts: { signal?: AbortSignal } = {},
        ) {
          yield {
            id: 9,
            v: 1,
            type: 'session_metadata_updated',
            data: {
              sessionId: 'session-1',
              displayName: 'Updated session',
            },
          };
          await new Promise<void>((resolve) => {
            if (opts.signal?.aborted) {
              resolve();
              return;
            }
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
        },
      }),
    );
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });

    expect(connection).toMatchObject({
      sessionId: 'session-1',
      displayName: 'Updated session',
    });
  });

  it('recovers internally when the daemon requests a state resync', async () => {
    const firstSession = createMockSession({
      sessionId: 'session-resync',
      events: async function* resyncEvents() {
        yield {
          id: 11,
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'slow_client',
            lastDeliveredId: 10,
            earliestAvailableId: 15,
          },
        };
      },
    });
    const reloadedSession = createMockSession({
      sessionId: 'session-resync',
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);
    let connection: DaemonConnectionState | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      connection = useDaemonConnection();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await wait(20);
      await flushPromises();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledWith(
      expect.anything(),
      'session-resync',
      { workspaceCwd: '/mock-workspace' },
      expect.any(String),
    );
    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'session-resync',
    });
    expect(blocks).toEqual([]);
  });

  it('marks the connection unhealthy after repeated heartbeat failures', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      v: 1,
      mode: 'http-bridge',
      features: ['client_heartbeat'],
      modelServices: [],
      workspaceCwd: '/mock-workspace',
    });
    const heartbeat = vi.fn(async () => {
      throw new Error('heartbeat lost');
    });
    sdkMocks.sessions.push(
      createMockSession({
        heartbeat,
        events: createIdleEvents(),
      }),
    );
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      heartbeatIntervalMs: 1,
      heartbeatFailureThreshold: 2,
    });

    await act(async () => {
      await wait(50);
      await flushPromises();
    });

    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(connection).toMatchObject({
      status: 'disconnected',
      error: 'heartbeat lost',
    });
  });

  it('clears stale sessions on terminal HTTP heartbeat errors', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      v: 1,
      mode: 'http-bridge',
      features: ['client_heartbeat'],
      modelServices: [],
      workspaceCwd: '/mock-workspace',
    });
    const heartbeat = vi.fn(async () => {
      throw Object.assign(new Error('session gone'), { status: 410 });
    });
    sdkMocks.sessions.push(
      createMockSession({
        heartbeat,
        events: createIdleEvents(),
      }),
    );
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      heartbeatIntervalMs: 20,
      heartbeatFailureThreshold: 1,
    });

    await act(async () => {
      await wait(50);
      await flushPromises();
    });

    expect(heartbeat).toHaveBeenCalled();
    expect(connection).toMatchObject({
      status: 'disconnected',
      error: 'session gone',
      errorStatus: 410,
      missingSession: true,
      capabilities: {
        workspaceCwd: '/mock-workspace',
        features: ['client_heartbeat'],
      },
    });
    expect(connection?.sessionId).toBeUndefined();
  });

  it('uses recent HTTP status when heartbeat threshold ends with transport failure', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      v: 1,
      mode: 'http-bridge',
      features: ['client_heartbeat'],
      modelServices: [],
      workspaceCwd: '/mock-workspace',
    });
    const heartbeat = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('session gone'), { status: 410 }),
      )
      .mockRejectedValue(new Error('heartbeat lost'));
    sdkMocks.sessions.push(
      createMockSession({
        heartbeat,
        events: createIdleEvents(),
      }),
    );
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      heartbeatIntervalMs: 1,
      heartbeatFailureThreshold: 2,
    });

    await act(async () => {
      await wait(10);
      await flushPromises();
    });

    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(connection).toMatchObject({
      status: 'disconnected',
      error: 'session gone',
      errorStatus: 410,
      missingSession: true,
    });
    expect(connection?.sessionId).toBeUndefined();
  });

  it('clears prompt state on terminal HTTP heartbeat errors', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      v: 1,
      mode: 'http-bridge',
      features: ['client_heartbeat'],
      modelServices: [],
      workspaceCwd: '/mock-workspace',
    });
    const heartbeat = vi.fn(async () => {
      throw Object.assign(new Error('session gone'), { status: 410 });
    });
    const session = createMockSession({
      heartbeat,
      submitPrompt: vi.fn(
        (_req: unknown, signal?: AbortSignal) =>
          new Promise<NonBlockingPromptAccepted>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(createAbortError()),
              { once: true },
            );
          }),
      ),
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let streamingState: ReturnType<typeof useDaemonStreamingState> = 'idle';

    function Harness() {
      actions = useDaemonActions();
      streamingState = useDaemonStreamingState();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      heartbeatIntervalMs: 1,
      heartbeatFailureThreshold: 1,
    });
    const providerActions = requireActions(actions);

    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('still running');
      await flushPromises();
    });

    await act(async () => {
      await wait(50);
      await flushPromises();
    });

    expect(streamingState).toBe('idle');
    const runningPrompt = promptResult;
    if (!runningPrompt) throw new Error('prompt was not started');
    await expect(runningPrompt).resolves.toEqual({
      stopReason: 'cancelled',
    });
  });

  it.each([401, 403])(
    'enters auth-error state on %d heartbeat auth failures',
    async (status) => {
      sdkMocks.capabilities.mockResolvedValue({
        v: 1,
        mode: 'http-bridge',
        features: ['client_heartbeat'],
        modelServices: [],
        workspaceCwd: '/mock-workspace',
      });
      const heartbeat = vi.fn(async () => {
        throw Object.assign(new Error('Unauthorized'), { status });
      });
      sdkMocks.sessions.push(
        createMockSession({
          heartbeat,
          events: createIdleEvents(),
        }),
      );
      let connection: DaemonConnectionState | undefined;

      function Harness() {
        connection = useDaemonConnection();
        return null;
      }

      await renderWithProvider(<Harness />, {
        autoConnect: true,
        autoReconnect: true,
        heartbeatIntervalMs: 1,
        heartbeatFailureThreshold: 1,
        reconnectDelayMs: 1,
        maxReconnectDelayMs: 1,
      });

      await act(async () => {
        await wait(20);
        await flushPromises();
      });

      expect(heartbeat).toHaveBeenCalled();
      expect(connection).toMatchObject({
        status: 'error',
        error: 'Unauthorized',
        errorStatus: status,
      });
      expect(connection?.sessionId).toBeUndefined();
    },
  );

  it('ignores stale connect attempts after provider props change', async () => {
    const staleLoad = createDeferred<MockSession>();
    const staleSession = createMockSession({ sessionId: 'session-a' });
    const activeSession = createMockSession({ sessionId: 'session-b' });
    sdkMocks.MockDaemonSessionClient.load
      .mockImplementationOnce(async () => staleLoad.promise)
      .mockImplementationOnce(async () => activeSession);
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={true}
          sessionId="session-a"
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });
    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4171"
          autoConnect={true}
          sessionId="session-b"
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({ sessionId: 'session-b' });

    staleLoad.resolve(staleSession);
    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({ sessionId: 'session-b' });
  });

  it('rejects interrupted session loads as AbortError during cleanup', async () => {
    const session = createMockSession({ events: createIdleEvents() });
    sdkMocks.sessions.push(session);
    let actions: DaemonSessionActions | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      actions = useDaemonActions();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });
    sdkMocks.MockDaemonSessionClient.load.mockImplementationOnce(async () => {
      throw createAbortError();
    });

    await act(async () => {
      const loadPromise = requireActions(actions).loadSession('session-b');
      await expect(loadPromise).rejects.toMatchObject({
        name: 'AbortError',
      });
      await flushPromises();
    });
    expect(blocks).toEqual([]);
  });

  it('clears transcript immediately for default session switches', async () => {
    const nextSession = createDeferred<MockSession>();
    const currentSession = createMockSession({
      replaySnapshot: createTextReplaySnapshot('old transcript'),
    });
    sdkMocks.sessions.push(currentSession);
    let actions: DaemonSessionActions | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      actions = useDaemonActions();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'old transcript' },
    ]);
    sdkMocks.MockDaemonSessionClient.load.mockImplementationOnce(
      async () => nextSession.promise,
    );

    const loadPromise = requireActions(actions)
      .loadSession('session-b')
      .catch(() => undefined);
    await act(async () => {
      await flushPromises();
    });

    expect(blocks).toEqual([]);
    nextSession.resolve(
      createMockSession({
        sessionId: 'session-b',
        replaySnapshot: createTextReplaySnapshot('new transcript'),
      }),
    );
    await act(async () => {
      await loadPromise;
      await flushPromises();
    });
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'new transcript' },
    ]);
  });

  it('loads controlled sessionId changes', async () => {
    const nextSession = createDeferred<MockSession>();
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'session-a',
        replaySnapshot: createTextReplaySnapshot('old transcript'),
      }),
    );
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });
    expect(connection).toMatchObject({ sessionId: 'session-a' });
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'old transcript' },
    ]);
    sdkMocks.MockDaemonSessionClient.load.mockClear();
    sdkMocks.MockDaemonSessionClient.load.mockImplementationOnce(
      async () => nextSession.promise,
    );

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={true}
          sessionId="session-b"
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection).toMatchObject({
      sessionId: 'session-b',
      loadingTranscript: true,
    });
    expect(blocks).toEqual([]);
    nextSession.resolve(
      createMockSession({
        sessionId: 'session-b',
        replaySnapshot: createTextReplaySnapshot('new transcript'),
      }),
    );
    await act(async () => {
      await wait(5);
      await flushPromises();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledWith(
      expect.anything(),
      'session-b',
      { workspaceCwd: '/mock-workspace' },
      expect.any(String),
    );
    expect(connection).toMatchObject({ sessionId: 'session-b' });
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'new transcript' },
    ]);
  });

  it('clears transcript loading after replay before metadata finishes', async () => {
    const providers = createDeferred<unknown>();
    const commands =
      createDeferred<Awaited<ReturnType<MockSession['supportedCommands']>>>();
    const context =
      createDeferred<Awaited<ReturnType<MockSession['context']>>>();
    sdkMocks.workspaceProviders.mockReturnValueOnce(providers.promise);
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'session-a',
        replaySnapshot: createTextReplaySnapshot('restored transcript'),
        supportedCommands: vi.fn(() => commands.promise),
        context: vi.fn(() => context.promise),
      }),
    );
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });
    await act(async () => {
      await flushPromises();
    });

    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'restored transcript' },
    ]);
    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'session-a',
      loadingTranscript: undefined,
    });

    providers.resolve({
      v: 1,
      workspaceCwd: '/mock-workspace',
      initialized: true,
      providers: [],
    });
    commands.resolve({
      v: 1,
      sessionId: 'session-a',
      availableCommands: [],
      availableSkills: [],
    });
    context.resolve({
      v: 1,
      sessionId: 'session-a',
      workspaceCwd: '/mock-workspace',
      state: {},
    });
    await act(async () => {
      await flushPromises();
    });
  });

  it('ignores stale metadata after switching to another session', async () => {
    const providersA = createDeferred<unknown>();
    const commandsA =
      createDeferred<Awaited<ReturnType<MockSession['supportedCommands']>>>();
    const contextA =
      createDeferred<Awaited<ReturnType<MockSession['context']>>>();
    sdkMocks.workspaceProviders.mockReturnValueOnce(providersA.promise);
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'session-a',
        replaySnapshot: createTextReplaySnapshot('session a transcript'),
        supportedCommands: vi.fn(() => commandsA.promise),
        context: vi.fn(() => contextA.promise),
      }),
      createMockSession({
        sessionId: 'session-b',
        replaySnapshot: createTextReplaySnapshot('session b transcript'),
      }),
    );
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });
    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({ sessionId: 'session-a' });
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'session a transcript' },
    ]);

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={true}
          sessionId="session-b"
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({
      sessionId: 'session-b',
      loadingTranscript: undefined,
    });
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'session b transcript' },
    ]);

    providersA.resolve({
      v: 1,
      workspaceCwd: '/mock-workspace',
      initialized: true,
      providers: [],
    });
    commandsA.resolve({
      v: 1,
      sessionId: 'session-a',
      availableCommands: [],
      availableSkills: [],
    });
    contextA.resolve({
      v: 1,
      sessionId: 'session-a',
      workspaceCwd: '/mock-workspace',
      state: { models: { currentModel: 'stale-model' } },
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection).toMatchObject({ sessionId: 'session-b' });
    expect(connection?.currentModel).not.toBe('stale-model');
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'session b transcript' },
    ]);
  });

  it('loads controlled sessionId on mount without creating a session', async () => {
    sdkMocks.sessions.push(createMockSession({ sessionId: 'session-a' }));
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledWith(
      expect.anything(),
      'session-a',
      { workspaceCwd: '/mock-workspace' },
      expect.any(String),
    );
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).not.toHaveBeenCalled();
    expect(connection).toMatchObject({ sessionId: 'session-a' });
  });

  it('marks controlled sessionId load as loading transcript before load returns', async () => {
    const pendingSession = createDeferred<MockSession>();
    sdkMocks.MockDaemonSessionClient.load.mockImplementationOnce(
      async () => pendingSession.promise,
    );
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });

    expect(connection).toMatchObject({
      status: 'connecting',
      sessionId: 'session-a',
      loadingTranscript: true,
    });

    pendingSession.resolve(createMockSession({ sessionId: 'session-a' }));
    await act(async () => {
      await flushPromises();
    });
  });

  it('does not create a session when sessionId is undefined', async () => {
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
    });

    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).not.toHaveBeenCalled();
    expect(connection).toMatchObject({
      status: 'connected',
      workspaceCwd: '/mock-workspace',
    });
    expect(connection).not.toHaveProperty('sessionId');
  });

  it('clears the current session when sessionId becomes undefined', async () => {
    const session = createMockSession({ sessionId: 'session-a' });
    sdkMocks.sessions.push(session);
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });
    expect(connection).toMatchObject({ sessionId: 'session-a' });

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={true}
          sessionId={undefined}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });

    expect(session.detach).toHaveBeenCalledOnce();
    expect(connection).not.toHaveProperty('sessionId');
  });

  it('does not clear a deferred session created after an empty controlled render', async () => {
    sdkMocks.sessions.push(
      createMockSession({ sessionId: 'created-session' }),
      createMockSession({ sessionId: 'created-session' }),
    );
    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
    });

    await act(async () => {
      await actions?.createSession();
      await flushPromises();
    });

    expect(connection).toMatchObject({ sessionId: 'created-session' });
    expect(sdkMocks.MockDaemonSessionClient.createOrAttach).toHaveBeenCalled();
  });

  it('does not retry a failed controlled session load until the host changes it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sdkMocks.sessions.push(createMockSession({ sessionId: 'session-a' }));
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
      sessionId: 'session-a',
    });
    expect(connection).toMatchObject({ sessionId: 'session-a' });
    sdkMocks.MockDaemonSessionClient.load.mockClear();
    sdkMocks.MockDaemonSessionClient.load.mockRejectedValueOnce(
      new Error('not found'),
    );

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={true}
          autoReconnect={false}
          sessionId="missing-session"
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={true}
          autoReconnect={false}
          sessionId="missing-session"
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect when event processing options change', async () => {
    const session = createMockSession({ events: createIdleEvents() });
    sdkMocks.sessions.push(session);

    function Harness() {
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={true}
          sessionId="session-1"
          includeRawEvent={false}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={true}
          sessionId="session-1"
          includeRawEvent={true}
          suppressOwnUserEcho={false}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).not.toHaveBeenCalled();
  });

  it('clears the session when reconnect is disabled after SSE stream end', async () => {
    const session = createMockSession({ events: createClosedEvents() });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    const providerActions = requireActions(actions);

    await act(async () => {
      await flushPromises();
    });

    expect(connection).toMatchObject({ status: 'disconnected' });
    expect(blocks).toEqual([]);
    await act(async () => {
      await expect(providerActions.cancel()).rejects.toThrow(
        'Daemon session is not connected',
      );
    });
  });

  it('clears stale sessions on terminal HTTP stream errors', async () => {
    const session = createMockSession({
      events: async function* terminalErrorEvents() {
        await Promise.resolve();
        yield* [];
        throw Object.assign(new Error('session gone'), { status: 410 });
      },
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    const providerActions = requireActions(actions);

    await act(async () => {
      await flushPromises();
    });

    expect(connection).toMatchObject({
      status: 'disconnected',
      error: 'session gone',
    });
    expect(connection?.missingSession).not.toBe(true);
    expect(connection?.sessionId).toBeUndefined();
    await act(async () => {
      await expect(providerActions.cancel()).rejects.toThrow(
        'Daemon session is not connected',
      );
    });
  });

  it.each([401, 403])(
    'breaks out of the reconnect loop on %d auth failures even when autoReconnect is true (wenshao CRIT #1)',
    async (status) => {
      let loadAttempts = 0;
      sdkMocks.MockDaemonSessionClient.load.mockImplementation(async () => {
        loadAttempts += 1;
        throw Object.assign(new Error('Unauthorized'), { status });
      });

      let connection: DaemonConnectionState | undefined;
      function Harness() {
        connection = useDaemonConnection();
        return null;
      }

      await renderWithProvider(<Harness />, {
        autoConnect: true,
        autoReconnect: true, // ← critical: must NOT loop
        sessionId: 'session-auth',
        reconnectDelayMs: 1, // keep timing tight in case it does loop
        maxReconnectDelayMs: 1,
      });

      await act(async () => {
        await flushPromises();
      });
      // Give any potential reconnect timer a window to fire.
      await act(async () => {
        await wait(20);
        await flushPromises();
      });

      expect(connection).toMatchObject({
        status: 'error',
        error: 'Unauthorized',
      });
      // No sessionId on auth-failure terminal state.
      expect(connection?.sessionId).toBeUndefined();
      expect(loadAttempts).toBe(1);
      expect(
        sdkMocks.MockDaemonSessionClient.createOrAttach,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([404, 410])(
    'does not create a replacement session when requested sessionId returns %d',
    async (status) => {
      sdkMocks.MockDaemonSessionClient.load.mockRejectedValueOnce(
        Object.assign(new Error('session gone'), { status }),
      );

      let connection: DaemonConnectionState | undefined;
      function Harness() {
        connection = useDaemonConnection();
        return null;
      }

      await renderWithProvider(<Harness />, {
        autoConnect: true,
        autoReconnect: true,
        sessionId: 'missing-session',
        reconnectDelayMs: 1,
        maxReconnectDelayMs: 1,
      });

      await act(async () => {
        await wait(30);
        await flushPromises();
      });

      expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledOnce();
      expect(
        sdkMocks.MockDaemonSessionClient.createOrAttach,
      ).not.toHaveBeenCalled();
      expect(connection).toMatchObject({
        status: 'disconnected',
        error: 'session gone',
        errorStatus: status,
        missingSession: true,
        capabilities: {
          workspaceCwd: '/mock-workspace',
          features: [],
        },
      });
      expect(connection?.sessionId).toBeUndefined();
    },
  );

  it.each([401, 403])(
    'preserves transcript and clears prompt state on %d auth failures from the SSE stream',
    async (status) => {
      const streamFailure = createDeferred<void>();
      const session = createMockSession({
        submitPrompt: vi.fn(
          (_req: unknown, signal?: AbortSignal) =>
            new Promise<NonBlockingPromptAccepted>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(createAbortError()),
                { once: true },
              );
            }),
        ),
        events: async function* authFailureEvents() {
          await streamFailure.promise;
          yield* [];
          throw Object.assign(new Error('Unauthorized'), { status });
        },
      });
      sdkMocks.sessions.push(session);
      let actions: DaemonUiSessionActions | undefined;
      let connection: DaemonConnectionState | undefined;
      let blocks: readonly DaemonTranscriptBlock[] = [];

      function Harness() {
        actions = useDaemonActions();
        connection = useDaemonConnection();
        blocks = useDaemonTranscriptBlocks();
        return null;
      }

      await renderWithProvider(<Harness />, {
        autoConnect: true,
        autoReconnect: true,
        reconnectDelayMs: 1,
        maxReconnectDelayMs: 1,
      });
      const providerActions = requireActions(actions);

      let promptResult: Promise<unknown> | undefined;
      await act(async () => {
        promptResult = providerActions.sendPrompt('keep transcript');
        await flushPromises();
      });
      expect(blocks).toMatchObject([{ kind: 'user', text: 'keep transcript' }]);

      streamFailure.resolve();
      await act(async () => {
        await wait(20);
        await flushPromises();
      });

      const runningPrompt = promptResult;
      if (!runningPrompt) throw new Error('prompt was not started');
      await expect(runningPrompt).resolves.toEqual({
        stopReason: 'cancelled',
      });
      expect(connection).toMatchObject({
        status: 'error',
        error: 'Unauthorized',
      });
      expect(blocks[0]).toMatchObject({
        kind: 'user',
        text: 'keep transcript',
      });
      expect(blocks).not.toContainEqual(
        expect.objectContaining({
          kind: 'error',
          text: 'Unauthorized',
        }) as DaemonTranscriptBlock,
      );
      expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
      await act(async () => {
        await expect(providerActions.sendPrompt('after auth')).rejects.toThrow(
          'Daemon session is not connected',
        );
      });
    },
  );

  it.each([
    [
      'cancel',
      (actions: DaemonUiSessionActions) => actions.cancel(),
      'Cancel failed: Cancel timed out after 30000ms',
    ],
    [
      'setModel',
      (actions: DaemonUiSessionActions) => actions.setModel('qwen-plus'),
      'Set model failed: Set model timed out after 30000ms',
    ],
    [
      'respondToPermission',
      (actions: DaemonUiSessionActions) =>
        actions.respondToPermission('perm-1', {
          outcome: { outcome: 'selected', optionId: 'allow' },
        }),
      'Permission response failed: Permission response timed out after 30000ms',
    ],
  ])('times out hung %s actions', async (_name, invoke, expectedError) => {
    vi.useFakeTimers();
    try {
      const session = createMockSession({
        cancel: vi.fn(() => new Promise<void>(() => {})),
        setModel: vi.fn(() => new Promise<{ modelId: string }>(() => {})),
        respondToSessionPermission: vi.fn(() => new Promise<boolean>(() => {})),
        events: createIdleEvents(),
      });
      sdkMocks.sessions.push(session);
      let actions: DaemonUiSessionActions | undefined;
      let blocks: readonly DaemonTranscriptBlock[] = [];
      let notices: readonly DaemonSessionNotice[] = [];

      function Harness() {
        actions = useDaemonActions();
        blocks = useDaemonTranscriptBlocks();
        notices = useDaemonSessionNotices().notices;
        return null;
      }

      await renderWithProvider(<Harness />, { autoConnect: true });
      const providerActions = requireActions(actions);

      let actionResult: Promise<unknown> | undefined;
      let actionError: Promise<unknown> | undefined;
      await act(async () => {
        actionResult = invoke(providerActions);
        actionError = actionResult.catch((error: unknown) => error);
        await flushPromises();
      });
      await act(async () => {
        vi.advanceTimersByTime(30_000);
        await flushPromises();
      });

      const pendingAction = actionResult;
      if (!pendingAction) throw new Error('action was not started');
      const observedError = await actionError;
      expect(observedError).toBeInstanceOf(Error);
      expect((observedError as Error).message).toBe(
        expectedError.replace(/^.*?: /, ''),
      );
      expect(blocks.some((block) => block.kind === 'error')).toBe(false);
      expect(notices.at(-1)).toMatchObject({ message: expectedError });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reloads stale transcript after epoch-reset resync', async () => {
    const startEpochReset = createDeferred<void>();
    const epochResetDelivered = createDeferred<void>();
    const reloaded = createDeferred<void>();
    const sessionRef: { current?: MockSession } = {};
    const setLastEventId = vi.fn((lastEventId: number | undefined) => {
      if (sessionRef.current) {
        sessionRef.current.lastEventId = lastEventId;
      }
    });

    const session = createMockSession({
      lastEventId: 50,
      setLastEventId,
      events: async function* epochResetThenReplay(
        opts: { signal?: AbortSignal } = {},
      ) {
        await startEpochReset.promise;
        if (opts.signal?.aborted) return;
        epochResetDelivered.resolve();
        yield {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'epoch_reset',
            lastDeliveredId: 50,
            earliestAvailableId: 1,
          },
        };
      },
    });
    const reloadedSession = createMockSession({
      sessionId: session.sessionId,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 1,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'fresh replayed' },
              },
            },
          },
          {
            id: 2,
            v: 1,
            type: 'turn_complete',
            data: { promptId: 'prompt-1', stopReason: 'end_turn' },
          },
        ],
        liveJournal: [],
      },
      events: createPendingEvents(reloaded),
    });
    sessionRef.current = session;
    sdkMocks.sessions.push(session, reloadedSession);

    let actions: DaemonUiSessionActions | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let awaitingResync = false;
    function Harness() {
      actions = useDaemonActions();
      blocks = useDaemonTranscriptBlocks();
      awaitingResync = useDaemonTranscriptState().awaitingResync;
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);
    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('stale local');
      await flushPromises();
    });
    expect(blocks).toMatchObject([{ kind: 'user', text: 'stale local' }]);

    await act(async () => {
      startEpochReset.resolve();
      await epochResetDelivered.promise;
      await flushPromises();
    });

    expect(setLastEventId).toHaveBeenCalledWith(0);

    await act(async () => {
      await reloaded.promise;
      await flushPromises();
    });

    expect(awaitingResync).toBe(false);
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'fresh replayed' },
    ]);
    const pendingPrompt = promptResult;
    if (!pendingPrompt) throw new Error('prompt was not started');
    await expect(pendingPrompt).resolves.toEqual({
      stopReason: 'cancelled',
    });
  });

  it('reloads the session snapshot after ring-evicted resync', async () => {
    const reloaded = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-ring-evicted',
      lastEventId: 10,
      events: async function* ringEvictedEvents() {
        yield {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 10,
            earliestAvailableId: 12,
          },
        };
      },
    });
    const reloadedSession = createMockSession({
      sessionId: 'session-ring-evicted',
      replaySnapshot: {
        compactedReplay: [
          {
            id: 12,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'loaded history' },
              },
            },
          },
        ],
        liveJournal: [],
      },
      events: async function* reloadedIdleEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        reloaded.resolve();
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        yield* [];
      },
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);

    let blocks: readonly DaemonTranscriptBlock[] = [];
    let awaitingResync = false;
    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      awaitingResync = useDaemonTranscriptState().awaitingResync;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await reloaded.promise;
      await flushPromises();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledWith(
      expect.anything(),
      'session-ring-evicted',
      { workspaceCwd: '/mock-workspace' },
      expect.any(String),
    );
    expect(awaitingResync).toBe(false);
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assistant',
          text: 'loaded history',
        }),
      ]),
    );
    expect(blocks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'error',
          text: expect.stringContaining('State resync required'),
        }),
      ]),
    );
  });

  it('settles active prompts from replay snapshot after ring eviction', async () => {
    const ringEvicted = createDeferred<void>();
    const reloaded = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-ring-active-prompt',
      lastEventId: 10,
      submitPrompt: vi.fn(async () => ({
        promptId: 'prompt-1',
        lastEventId: 10,
      })),
      events: async function* ringEvictedEvents() {
        await ringEvicted.promise;
        yield {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 10,
            earliestAvailableId: 12,
          },
        };
      },
    });
    const reloadedSession = createMockSession({
      sessionId: 'session-ring-active-prompt',
      replaySnapshot: {
        compactedReplay: [
          {
            id: 12,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'replayed answer' },
              },
            },
          },
          {
            id: 13,
            v: 1,
            type: 'turn_complete',
            data: { promptId: 'prompt-1', stopReason: 'end_turn' },
          },
        ],
        liveJournal: [],
      },
      events: async function* reloadedIdleEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        reloaded.resolve();
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        yield* [];
      },
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);

    let actions: DaemonUiSessionActions | undefined;
    let streamingState: ReturnType<typeof useDaemonStreamingState> = 'idle';
    let blocks: readonly DaemonTranscriptBlock[] = [];
    function Harness() {
      actions = useDaemonActions();
      streamingState = useDaemonStreamingState();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    const providerActions = requireActions(actions);

    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('ring prompt');
      await flushPromises();
    });
    expect(streamingState).toBe('waiting');

    await act(async () => {
      ringEvicted.resolve();
      await reloaded.promise;
      await flushPromises();
    });

    const pendingPrompt = promptResult;
    if (!pendingPrompt) throw new Error('prompt was not started');
    await act(async () => {
      await expect(pendingPrompt).resolves.toEqual({
        stopReason: 'end_turn',
      });
    });
    expect(streamingState).toBe('idle');
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assistant',
          text: 'replayed answer',
          streaming: false,
        }),
      ]),
    );
  });

  it('rejects active prompts from replay turn_error after ring eviction', async () => {
    const ringEvicted = createDeferred<void>();
    const reloaded = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-ring-active-error',
      lastEventId: 10,
      submitPrompt: vi.fn(async () => ({
        promptId: 'prompt-1',
        lastEventId: 10,
      })),
      events: async function* ringEvictedEvents() {
        await ringEvicted.promise;
        yield {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 10,
            earliestAvailableId: 12,
          },
        };
      },
    });
    const reloadedSession = createMockSession({
      sessionId: 'session-ring-active-error',
      replaySnapshot: {
        compactedReplay: [
          {
            id: 12,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'partial error replay' },
              },
            },
          },
          {
            id: 13,
            v: 1,
            type: 'turn_error',
            data: {
              promptId: 'prompt-1',
              message: 'model overloaded',
              code: 'overloaded',
            },
          },
        ],
        liveJournal: [],
      },
      events: async function* reloadedIdleEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        reloaded.resolve();
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        yield* [];
      },
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);

    let actions: DaemonUiSessionActions | undefined;
    let streamingState: ReturnType<typeof useDaemonStreamingState> = 'idle';
    let blocks: readonly DaemonTranscriptBlock[] = [];
    function Harness() {
      actions = useDaemonActions();
      streamingState = useDaemonStreamingState();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    const providerActions = requireActions(actions);

    let promptResult: Promise<unknown> | undefined;
    let promptError: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('ring prompt');
      promptError = promptResult.catch((error: unknown) => error);
      await flushPromises();
    });
    expect(streamingState).toBe('waiting');

    await act(async () => {
      ringEvicted.resolve();
      await reloaded.promise;
      await flushPromises();
    });

    const pendingPrompt = promptResult;
    const observedPromptError = promptError;
    if (!pendingPrompt) throw new Error('prompt was not started');
    if (!observedPromptError) throw new Error('prompt was not observed');
    await act(async () => {
      await expect(observedPromptError).resolves.toMatchObject({
        message: 'model overloaded',
      });
    });
    expect(streamingState).toBe('idle');
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assistant',
          text: 'partial error replay',
          streaming: false,
        }),
        expect.objectContaining({
          kind: 'error',
          text: 'model overloaded',
          code: 'overloaded',
          promptId: 'prompt-1',
          source: 'turn_error',
        }),
      ]),
    );
  });

  it('does not settle unaccepted prompts from historical replay turns', async () => {
    const accepted = createDeferred<NonBlockingPromptAccepted>();
    const ringEvicted = createDeferred<void>();
    const reloaded = createDeferred<void>();
    const realTurnComplete = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-ring-unaccepted-prompt',
      lastEventId: 10,
      submitPrompt: vi.fn(() => accepted.promise),
      events: async function* ringEvictedEvents() {
        await ringEvicted.promise;
        yield {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 10,
            earliestAvailableId: 12,
          },
        };
      },
    });
    const reloadedSession = createMockSession({
      sessionId: 'session-ring-unaccepted-prompt',
      replaySnapshot: {
        compactedReplay: [
          {
            id: 12,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'old replay answer' },
              },
            },
          },
          {
            id: 13,
            v: 1,
            type: 'turn_complete',
            data: { promptId: 'prompt-old', stopReason: 'end_turn' },
          },
        ],
        liveJournal: [],
      },
      events: async function* reloadedEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        reloaded.resolve();
        await Promise.race([
          realTurnComplete.promise,
          new Promise<void>((resolve) =>
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          ),
        ]);
        if (opts.signal?.aborted) return;
        yield {
          id: 14,
          v: 1,
          type: 'turn_complete',
          data: { promptId: 'prompt-new', stopReason: 'end_turn' },
        };
      },
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);

    let actions: DaemonUiSessionActions | undefined;
    let streamingState: ReturnType<typeof useDaemonStreamingState> = 'idle';
    function Harness() {
      actions = useDaemonActions();
      streamingState = useDaemonStreamingState();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    const providerActions = requireActions(actions);

    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('ring prompt');
      await flushPromises();
    });
    expect(streamingState).toBe('waiting');

    await act(async () => {
      ringEvicted.resolve();
      await reloaded.promise;
      await flushPromises();
    });
    expect(streamingState).toBe('responding');

    const pendingPrompt = promptResult;
    if (!pendingPrompt) throw new Error('prompt was not started');
    await act(async () => {
      accepted.resolve({ promptId: 'prompt-new', lastEventId: 10 });
      await flushPromises();
      realTurnComplete.resolve();
      await expect(pendingPrompt).resolves.toEqual({
        stopReason: 'end_turn',
      });
    });
    expect(streamingState).toBe('idle');
  });

  it('keeps own user messages when replay rebuilds after ring eviction', async () => {
    const reloaded = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-own-user-replay',
      lastEventId: 10,
      events: async function* ringEvictedEvents() {
        yield {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 10,
            earliestAvailableId: 12,
          },
        };
      },
    });
    const reloadedSession = createMockSession({
      sessionId: 'session-own-user-replay',
      clientId: 'client-1',
      replaySnapshot: {
        compactedReplay: [
          {
            id: 12,
            v: 1,
            type: 'session_update',
            originatorClientId: 'client-1',
            data: {
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'own replayed prompt' },
              },
            },
          },
        ],
        liveJournal: [],
      },
      events: async function* reloadedIdleEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        reloaded.resolve();
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        yield* [];
      },
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);

    let blocks: readonly DaemonTranscriptBlock[] = [];
    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      suppressOwnUserEcho: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await reloaded.promise;
      await flushPromises();
    });

    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'user',
          text: 'own replayed prompt',
        }),
      ]),
    );
  });

  it('skips malformed replay events without dropping later replay history', async () => {
    const reloaded = createDeferred<void>();
    const malformedReplayEvent = {
      id: 12,
      v: 1,
      type: 'session_update',
    } as DaemonEvent;
    Object.defineProperty(malformedReplayEvent, 'data', {
      get() {
        throw new Error('bad replay payload');
      },
    });

    const firstSession = createMockSession({
      sessionId: 'session-bad-replay',
      lastEventId: 10,
      events: async function* ringEvictedEvents() {
        yield {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 10,
            earliestAvailableId: 12,
          },
        };
      },
    });
    const reloadedSession = createMockSession({
      sessionId: 'session-bad-replay',
      replaySnapshot: {
        compactedReplay: [
          malformedReplayEvent,
          {
            id: 13,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'after malformed replay' },
              },
            },
          },
        ],
        liveJournal: [],
      },
      events: async function* reloadedIdleEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        reloaded.resolve();
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        yield* [];
      },
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);

    let blocks: readonly DaemonTranscriptBlock[] = [];
    let notices: readonly DaemonSessionNotice[] = [];
    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      notices = useDaemonSessionNotices().notices;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await reloaded.promise;
      await flushPromises();
    });

    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assistant',
          text: 'after malformed replay',
        }),
      ]),
    );
    expect(blocks.some((block) => block.kind === 'error')).toBe(false);
    expect(notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'protocol',
          operation: 'normalize_event',
          code: 'daemon.replay_event_malformed',
          message: 'Skipped malformed replay event',
        }),
      ]),
    );
  });

  it('retries when ring-evicted reload fails once', async () => {
    const reloaded = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-ring-retry',
      lastEventId: 10,
      events: async function* ringEvictedEvents() {
        yield {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 10,
            earliestAvailableId: 12,
          },
        };
      },
    });
    const reloadedSession = createMockSession({
      sessionId: 'session-ring-retry',
      replaySnapshot: {
        compactedReplay: [
          {
            id: 12,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'history after retry' },
              },
            },
          },
        ],
        liveJournal: [],
      },
      events: async function* reloadedIdleEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        reloaded.resolve();
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        yield* [];
      },
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);
    sdkMocks.MockDaemonSessionClient.load
      .mockRejectedValueOnce(new Error('temporary load failure'))
      .mockImplementation(
        async (client: unknown, _sessionId: string): Promise<MockSession> => {
          const session = sdkMocks.sessions.shift();
          if (!session) throw new Error('No mock daemon session queued');
          session.client = client as MockClient;
          return session;
        },
      );

    let blocks: readonly DaemonTranscriptBlock[] = [];
    let awaitingResync = false;
    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      awaitingResync = useDaemonTranscriptState().awaitingResync;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await reloaded.promise;
      await flushPromises();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(3);
    expect(awaitingResync).toBe(false);
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assistant',
          text: 'history after retry',
        }),
      ]),
    );
  });

  it('accepts live events after ring-evicted reload reconnects', async () => {
    const reattachDelivered = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-reattach',
      lastEventId: 10,
      events: async function* ringEvictedThenReload() {
        yield {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'ring_evicted',
            lastDeliveredId: 10,
            earliestAvailableId: 12,
          },
        };
      },
    });
    const secondSession = createMockSession({
      sessionId: 'session-reattach',
      lastEventId: 10,
      events: async function* reattachedLive(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          id: 12,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'after reattach' },
            },
          },
        };
        reattachDelivered.resolve();
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted) {
            resolve();
            return;
          }
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
    });
    sdkMocks.sessions.push(firstSession, secondSession);

    let blocks: readonly DaemonTranscriptBlock[] = [];
    let awaitingResync = false;
    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      awaitingResync = useDaemonTranscriptState().awaitingResync;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await reattachDelivered.promise;
      await flushPromises();
    });
    expect(blocks).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'error',
          text: expect.stringContaining('State resync required'),
        }),
      ]),
    );

    expect(awaitingResync).toBe(false);
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assistant',
          text: 'after reattach',
        }),
      ]),
    );
  });

  it('preserves session and uses delta resume after a retriable SSE error', async () => {
    let callCount = 0;
    const events = vi.fn(async function* retriableEvents(
      opts: { signal?: AbortSignal } = {},
    ) {
      callCount += 1;
      if (callCount === 1) {
        yield {
          id: 5,
          v: 1 as const,
          type: 'session_update' as const,
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'before error' },
            },
          },
        } satisfies DaemonEvent;
        throw new Error('network timeout');
      }
      // Second call: delta resume succeeds with new content
      yield {
        id: 6,
        v: 1 as const,
        type: 'session_update' as const,
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' after resume' },
          },
        },
      } satisfies DaemonEvent;
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) {
          resolve();
          return;
        }
        opts.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
    });
    const session = createMockSession({ events });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await wait(20);
      await flushPromises();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
    // events() was called twice: first threw, second succeeded
    expect(events).toHaveBeenCalledTimes(2);
    // Transcript preserved content from before the error and appended delta
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'before error after resume' },
    ]);
  });

  it('routes session_died errors to notices, not transcript', async () => {
    const session = createMockSession({
      events: async function* sessionDiedEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          id: 11,
          v: 1,
          type: 'session_died',
          data: {
            message: 'Session terminated unexpectedly',
          },
        };
        if (opts.signal?.aborted) return;
      },
    });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let notices: readonly DaemonSessionNotice[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      notices = useDaemonSessionNotices().notices;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });

    // session_died should be a notice, not a transcript error block
    expect(blocks.some((b) => b.kind === 'error')).toBe(false);
    expect(notices).toMatchObject([
      {
        category: 'connection',
        code: 'daemon.session_died',
      },
    ]);
  });

  it('stops reconnect loop on session_closed (user deleted session) even when autoReconnect is true', async () => {
    // When the user deletes a running session, the server publishes
    // session_closed on SSE. The provider must NOT auto-reconnect and
    // create a new session — that would undo the user's delete action.
    const session = createMockSession({
      events: async function* sessionClosedEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          id: 1,
          v: 1,
          type: 'session_closed',
          data: { reason: 'client_close' },
        };
        if (opts.signal?.aborted) return;
      },
    });
    sdkMocks.sessions.push(session);

    let connection: DaemonConnectionState | undefined;
    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });

    await act(async () => {
      await flushPromises();
    });
    // Give any potential reconnect timer a window to fire and
    // React state updates to flush.
    await act(async () => {
      await wait(100);
      await flushPromises();
    });
    await act(async () => {
      await flushPromises();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
    // Connection should be disconnected with no sessionId.
    expect(connection?.status).toBe('disconnected');
    expect(connection?.sessionId).toBeUndefined();
  });

  it('aborts in-flight prompt when session_closed arrives mid-stream', async () => {
    // Exercises the most complex new code path: session_closed with
    // reason 'client_close' arriving while a prompt is actively streaming.
    // Verifies the abort path fires, the prompt rejects, and no
    // auto-recreate happens.
    const promptBlocked = createDeferred<void>();
    const session = createMockSession({
      submitPrompt: vi.fn(
        (_req: unknown, signal?: AbortSignal) =>
          new Promise<NonBlockingPromptAccepted>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => reject(createAbortError()),
              {
                once: true,
              },
            );
            promptBlocked.resolve();
          }),
      ),
      events: async function* midStreamCloseEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        // Wait for the prompt to start, then yield session_closed
        await promptBlocked.promise;
        yield {
          id: 1,
          v: 1,
          type: 'session_closed',
          data: { reason: 'client_close' },
        };
        if (opts.signal?.aborted) return;
      },
    });
    sdkMocks.sessions.push(session);

    let actions: DaemonUiSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;
    let promptStatus: string | undefined;
    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      promptStatus = useDaemonPromptStatus();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    const providerActions = requireActions(actions);

    // Fire a prompt — it will block until abort
    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('long task');
      await flushPromises();
    });

    // Wait for the session_closed event to arrive and be processed
    await act(async () => {
      await flushPromises();
    });
    await act(async () => {
      await wait(100);
      await flushPromises();
    });

    // The prompt should have been aborted
    await expect(promptResult).resolves.toEqual({ stopReason: 'cancelled' });
    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
    expect(connection?.status).toBe('disconnected');
    expect(connection?.sessionId).toBeUndefined();
    // Teardown set promptStatus to 'idle' — without the explicit
    // setPromptStatus('idle') in the userDeletedSession block, this
    // would remain 'waiting' (sendPrompt's own handler is blocked
    // because sessionRef.current was cleared before the catch runs).
    expect(promptStatus).toBe('idle');
  });

  it('reloads after epoch reset instead of consuming same-stream session_closed', async () => {
    const epochResetDelivered = createDeferred<void>();
    const reloaded = createDeferred<void>();
    const session = createMockSession({
      sessionId: 'session-epoch-closed-tail',
      events: async function* epochResetThenClose() {
        epochResetDelivered.resolve();
        yield {
          v: 1,
          type: 'state_resync_required',
          data: {
            reason: 'epoch_reset',
            lastDeliveredId: 50,
            earliestAvailableId: 1,
          },
        };
        yield {
          id: 1,
          v: 1,
          type: 'session_closed',
          data: { reason: 'client_close' },
        };
      },
    });
    const reloadedSession = createMockSession({
      sessionId: 'session-epoch-closed-tail',
      events: createPendingEvents(reloaded),
    });
    sdkMocks.sessions.push(session, reloadedSession);

    let connection: DaemonConnectionState | undefined;
    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });

    await act(async () => {
      await epochResetDelivered.promise;
      await reloaded.promise;
      await flushPromises();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(2);
    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledWith(
      expect.anything(),
      'session-epoch-closed-tail',
      { workspaceCwd: '/mock-workspace' },
      expect.any(String),
    );
    expect(connection?.status).toBe('connected');
    expect(connection?.sessionId).toBe('session-epoch-closed-tail');
  });

  it.each(['idle_timeout', 'last_client_detached'] as const)(
    'does NOT stop reconnect on session_closed with reason "%s"',
    async (reason) => {
      // session_closed with idle_timeout or last_client_detached should
      // NOT prevent reconnection — these are server-initiated closes,
      // not user deletions. The provider should preserve the session
      // handle and attempt to resume on the next iteration.
      const session = createMockSession({
        events: async function* nonClientCloseEvents(
          opts: { signal?: AbortSignal } = {},
        ) {
          yield {
            id: 1,
            v: 1,
            type: 'session_closed',
            data: { reason },
          };
          if (opts.signal?.aborted) return;
        },
      });
      sdkMocks.sessions.push(session);

      let connection: DaemonConnectionState | undefined;
      function Harness() {
        connection = useDaemonConnection();
        return null;
      }

      await renderWithProvider(<Harness />, {
        autoConnect: true,
        autoReconnect: true,
        reconnectDelayMs: 1,
        maxReconnectDelayMs: 1,
      });

      await act(async () => {
        await flushPromises();
      });
      await act(async () => {
        await wait(50);
        await flushPromises();
      });

      // Connection should still have the original sessionId — the
      // provider did NOT exit the loop, it preserved the session
      // for delta resume.
      expect(connection?.sessionId).toBe('session-1');
    },
  );

  it('does NOT stop reconnect on session_closed without reason field', async () => {
    // Defensive: if the server sends session_closed without a reason
    // field (older daemon versions), treat it as non-client_close and
    // let the normal reconnect path handle it.
    const session = createMockSession({
      events: async function* noReasonEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          id: 1,
          v: 1,
          type: 'session_closed',
          data: {},
        };
        if (opts.signal?.aborted) return;
      },
    });
    sdkMocks.sessions.push(session);

    let connection: DaemonConnectionState | undefined;
    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });

    await act(async () => {
      await flushPromises();
    });
    await act(async () => {
      await wait(50);
      await flushPromises();
    });

    // Session preserved — not treated as user deletion.
    expect(connection?.sessionId).toBe('session-1');
  });

  it('routes stream_error to notices with connection category', async () => {
    const session = createMockSession({
      events: async function* streamErrorEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          id: 11,
          v: 1,
          type: 'stream_error',
          data: {
            message: 'Upstream provider disconnected',
          },
        };
        if (opts.signal?.aborted) return;
      },
    });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let notices: readonly DaemonSessionNotice[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      notices = useDaemonSessionNotices().notices;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(blocks.some((b) => b.kind === 'error')).toBe(false);
    expect(notices).toMatchObject([
      {
        category: 'connection',
        code: 'daemon.stream_error',
      },
    ]);
  });

  it('routes model_switch_failed to notices with user_action category', async () => {
    const session = createMockSession({
      events: async function* modelSwitchFailedEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          id: 11,
          v: 1,
          type: 'model_switch_failed',
          data: {
            message: 'Model not found',
          },
        };
        if (opts.signal?.aborted) return;
      },
    });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let notices: readonly DaemonSessionNotice[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      notices = useDaemonSessionNotices().notices;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(blocks.some((b) => b.kind === 'error')).toBe(false);
    expect(notices).toMatchObject([
      {
        category: 'user_action',
        operation: 'switch_model',
        code: 'daemon.switch_model.failed',
      },
    ]);
  });

  it('keeps turn_error in transcript instead of routing to notices', async () => {
    const session = createMockSession({
      events: async function* turnErrorEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          id: 11,
          v: 1,
          type: 'turn_error',
          data: {
            promptId: 'prompt-1',
            message: 'API rate limit exceeded',
          },
        };
        if (opts.signal?.aborted) return;
      },
    });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let notices: readonly DaemonSessionNotice[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      notices = useDaemonSessionNotices().notices;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });

    // turn_error should stay in transcript as an error block
    expect(blocks).toMatchObject([
      {
        kind: 'error',
        text: 'API rate limit exceeded',
        source: 'turn_error',
      },
    ]);
    // Should not create a notice
    expect(notices).toEqual([]);
  });

  it('routes client_evicted to notices with connection category', async () => {
    const session = createMockSession({
      events: async function* clientEvictedEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          id: 11,
          v: 1,
          type: 'client_evicted',
          data: {
            reason: 'Another client connected',
          },
        };
        if (opts.signal?.aborted) return;
      },
    });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let notices: readonly DaemonSessionNotice[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      notices = useDaemonSessionNotices().notices;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(blocks.some((b) => b.kind === 'error')).toBe(false);
    expect(notices).toMatchObject([
      {
        category: 'connection',
        code: 'daemon.client_evicted',
      },
    ]);
  });

  async function renderWithProvider(
    children: ReactNode,
    props: Partial<DaemonSessionProviderProps> = {},
  ) {
    const defaultSessionId =
      props.autoConnect === true &&
      !Object.prototype.hasOwnProperty.call(props, 'sessionId') &&
      sdkMocks.sessions.length > 0
        ? sdkMocks.sessions[0]?.sessionId
        : undefined;

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={false}
          {...(defaultSessionId ? { sessionId: defaultSessionId } : {})}
          {...props}
        >
          {children}
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });
  }
});

function requireActions<T>(actions: T | undefined): T {
  if (!actions) throw new Error('actions were not initialized');
  return actions;
}

function createTextReplaySnapshot(text: string): MockSession['replaySnapshot'] {
  return {
    compactedReplay: [
      {
        id: 1,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        },
      },
      {
        id: 2,
        v: 1,
        type: 'turn_complete',
        data: { stopReason: 'end_turn' },
      },
    ],
    liveJournal: [],
  };
}

function createMockSession(opts: Partial<MockSession> = {}): MockSession {
  const session = {
    sessionId: opts.sessionId ?? 'session-1',
    workspaceCwd: opts.workspaceCwd ?? '/mock-workspace',
    clientId: opts.clientId ?? 'client-1',
    state: opts.state ?? {},
    hasActivePrompt: opts.hasActivePrompt ?? false,
    lastEventId: opts.lastEventId,
    setLastEventId:
      opts.setLastEventId ??
      vi.fn((lastEventId: number | undefined) => {
        session.lastEventId = lastEventId;
      }),
    prompt:
      opts.prompt ??
      vi.fn(async () => ({
        stopReason: 'end_turn',
      })),
    submitPrompt:
      opts.submitPrompt ??
      vi.fn(async () => ({
        promptId: 'prompt-1',
        lastEventId: 0,
      })),
    removePendingPrompt:
      opts.removePendingPrompt ?? vi.fn(async () => ({ removed: true })),
    cancel: opts.cancel ?? vi.fn(async () => {}),
    setModel:
      opts.setModel ??
      vi.fn(async (modelId: string) => ({
        modelId,
      })),
    heartbeat: opts.heartbeat ?? vi.fn(async () => ({ ok: true })),
    shellCommand: opts.shellCommand ?? vi.fn(async () => undefined),
    context:
      opts.context ??
      vi.fn(async () => ({
        v: 1 as const,
        sessionId: opts.sessionId ?? 'session-1',
        workspaceCwd: opts.workspaceCwd ?? '/mock-workspace',
        state: {},
      })),
    supportedCommands:
      opts.supportedCommands ??
      vi.fn(async () => ({
        v: 1 as const,
        sessionId: opts.sessionId ?? 'session-1',
        availableCommands: [],
        availableSkills: [],
      })),
    respondToSessionPermission:
      opts.respondToSessionPermission ?? vi.fn(async () => true),
    close: opts.close ?? vi.fn(async () => undefined),
    detach: opts.detach ?? vi.fn(async () => undefined),
    updateMetadata:
      opts.updateMetadata ??
      vi.fn(async (metadata: { displayName?: string }) => metadata),
    replaySnapshot: opts.replaySnapshot ?? {
      compactedReplay: [],
      liveJournal: [],
    },
    events: opts.events ?? createIdleEvents(),
  };
  return session;
}

function createIdleEvents(): MockSession['events'] {
  return async function* idleEvents(opts: { signal?: AbortSignal } = {}) {
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) {
        resolve();
        return;
      }
      opts.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    yield* [];
  };
}

function createPendingEvents(
  started: ReturnType<typeof createDeferred<void>>,
): MockSession['events'] {
  return async function* pendingEvents(opts: { signal?: AbortSignal } = {}) {
    started.resolve();
    await new Promise<void>((resolve) => {
      if (opts.signal?.aborted) {
        resolve();
        return;
      }
      opts.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    yield* [];
  };
}

function createTurnCompleteEvents(
  turnComplete: ReturnType<typeof createDeferred<void>>,
  promptId = 'prompt-1',
): MockSession['events'] {
  return async function* turnCompleteEvents(
    opts: { signal?: AbortSignal } = {},
  ) {
    await Promise.race([
      turnComplete.promise,
      new Promise<void>((resolve) =>
        opts.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      ),
    ]);
    if (opts.signal?.aborted) return;
    yield {
      v: 1,
      id: 11,
      type: 'turn_complete',
      timestamp: '2025-01-01T00:00:00.000Z',
      sessionId: 'session-1',
      data: { promptId, stopReason: 'end_turn' },
    };
  };
}

function createClosedEvents(): MockSession['events'] {
  return async function* closedEvents() {
    await Promise.resolve();
    yield* [];
  };
}

function createClosableEvents(): {
  events: MockSession['events'];
  close: () => void;
  closed: ReturnType<typeof createDeferred<void>>;
} {
  const closed = createDeferred<void>();
  return {
    events: async function* closableEvents() {
      await closed.promise;
      yield* [];
    },
    close: closed.resolve,
    closed,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value as T | PromiseLike<T>);
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}
