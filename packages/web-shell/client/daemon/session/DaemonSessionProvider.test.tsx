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
  DaemonSseConnectReason,
  DaemonTranscriptBlock,
  DaemonTranscriptStore,
  DaemonUiSessionActions,
  DaemonUnrecognizedDiagnostic,
  GoalStateResponse,
  PromptResult,
} from '@qwen-code/sdk/daemon';
import {
  DaemonCapabilityMissingError,
  DaemonHttpError,
  DaemonStandaloneCreationOutcomeUnknownError,
  estimateDaemonTranscriptBlockBytes,
  UNRECOGNIZED_DIAGNOSTICS_LIMIT,
} from '@qwen-code/sdk/daemon';
import {
  DaemonSessionProvider,
  useDaemonActions,
  useDaemonConnection,
  useDaemonSessionNotices,
  useDaemonPendingPermissions,
  useDaemonPromptSettled,
  useDaemonPromptStatus,
  useDaemonStreamingState,
  useDaemonTranscriptBlocks,
  useDaemonTranscriptHistory,
  useDaemonTranscriptState,
  useDaemonTranscriptStore,
  useDaemonWorkspaceEventSignals,
  type DaemonSessionProviderProps,
  type DaemonConnectionState,
  type DaemonSessionActions,
  type DaemonSessionNotice,
  type DaemonPromptSettledEvent,
  type DaemonWorkspaceEventSignals,
} from './DaemonSessionProvider.js';
import {
  DaemonWorkspaceProvider,
  useOptionalDaemonWorkspace,
} from '../workspace/DaemonWorkspaceProvider.js';
import {
  clearSidechannelMidTurnInjected,
  getSidechannelMidTurnInjected,
} from '../midTurnInjectedSidechannel.js';
import { persistStableClientId } from './clientLifecycle.js';

interface MockSession {
  sessionId: string;
  workspaceCwd: string;
  clientId: string;
  state?: Record<string, unknown>;
  hasActivePrompt?: boolean;
  historyHasMore?: boolean;
  historyAnchorRecordId?: string;
  replayDegraded?: boolean;
  replaySnapshotComplete?: boolean;
  replayPartial?: boolean;
  replayError?: string;
  eventEpoch?: string;
  session?: Record<string, unknown>;
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
  removeMidTurnMessage: (messageId: string) => Promise<{ removed: boolean }>;
  cancel: () => Promise<void>;
  setModel: (modelId: string) => Promise<{ modelId: string }>;
  heartbeat: () => Promise<{ ok: boolean }>;
  shellCommand: (command: string, signal?: AbortSignal) => Promise<unknown>;
  goal: () => Promise<GoalStateResponse>;
  controlGoal: (request: unknown) => Promise<GoalStateResponse>;
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
  getTranscriptPage: (opts: unknown) => Promise<{
    events: DaemonEvent[];
    hasMore: boolean;
    nextCursor?: string;
    partial?: true;
    replayError?: string;
  }>;
  replaySnapshot: {
    compactedReplay: DaemonEvent[];
    liveJournal: DaemonEvent[];
  };
  consumeReplaySnapshot: () => {
    compactedReplay: DaemonEvent[];
    liveJournal: DaemonEvent[];
  };
  events: (opts?: {
    signal?: AbortSignal;
    maxQueued?: number;
    sseConnectReason?: DaemonSseConnectReason;
  }) => AsyncGenerator<DaemonEvent, void, unknown>;
}

interface MockClient {
  createOrAttachSession: (req: unknown) => Promise<MockSession>;
  capabilities: () => Promise<unknown>;
  workspaceProviders: () => Promise<unknown>;
  listWorkspaceSessions: () => Promise<unknown[]>;
  listStandaloneSessions: () => Promise<unknown[]>;
  closeSession: () => Promise<void>;
  setSessionApprovalMode: () => Promise<{ mode: string }>;
  workspaceMcp: () => Promise<unknown>;
  workspaceMcpTools: () => Promise<unknown>;
  restartMcpServer: () => Promise<unknown>;
  workspaceSkills: () => Promise<unknown>;
  workspaceAcpStatus: () => Promise<unknown>;
  workspaceAcpPreheat: () => Promise<unknown>;
  workspaceGit: () => Promise<unknown>;
  workspaceByCwd: (workspaceCwd: string) => Pick<MockClient, 'workspaceGit'>;
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
  removeMidTurnMessage: (
    sessionId: string,
    messageId: string,
    opts?: { clientId?: string },
  ) => Promise<{ removed: boolean }>;
  branchSession: (
    sessionId: string,
    req: { name?: string; atRecordId?: string },
    clientId?: string,
  ) => Promise<{
    sessionId: string;
    displayName: string;
    clientId?: string;
  }>;
  getSessionTranscriptPage: (
    sessionId: string,
    opts: unknown,
  ) => Promise<unknown>;
}

const sdkMocks = vi.hoisted(() => {
  const sessions: MockSession[] = [];
  const daemonClientOptions: unknown[] = [];
  const capabilities = vi.fn();
  const workspaceProviders = vi.fn();
  const listWorkspaceSessions = vi.fn();
  const listStandaloneSessions = vi.fn();
  const closeSession = vi.fn();
  const setSessionApprovalMode = vi.fn();
  const workspaceMcp = vi.fn();
  const workspaceMcpTools = vi.fn();
  const restartMcpServer = vi.fn();
  const workspaceSkills = vi.fn();
  const workspaceAcpStatus = vi.fn();
  const workspaceAcpPreheat = vi.fn();
  const workspaceGit = vi.fn();
  const workspaceByCwd = vi.fn((_workspaceCwd: string) => ({ workspaceGit }));
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
  const removeMidTurnMessage = vi.fn();
  const branchSession = vi.fn();
  const getSessionTranscriptPage = vi.fn();

  class MockDaemonClient {
    constructor(opts: unknown) {
      daemonClientOptions.push(opts);
    }

    createOrAttachSession = vi.fn((req: unknown) =>
      MockDaemonSessionClient.createOrAttach(this, req),
    );
    capabilities = capabilities;
    workspaceProviders = workspaceProviders;
    listWorkspaceSessions = listWorkspaceSessions;
    listStandaloneSessions = listStandaloneSessions;
    closeSession = closeSession;
    setSessionApprovalMode = setSessionApprovalMode;
    workspaceMcp = workspaceMcp;
    workspaceMcpTools = workspaceMcpTools;
    restartMcpServer = restartMcpServer;
    workspaceSkills = workspaceSkills;
    workspaceAcpStatus = workspaceAcpStatus;
    workspaceAcpPreheat = workspaceAcpPreheat;
    workspaceGit = workspaceGit;
    workspaceByCwd = workspaceByCwd;
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
    removeMidTurnMessage = removeMidTurnMessage;
    branchSession = branchSession;
    getSessionTranscriptPage = getSessionTranscriptPage;
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
    static resume = vi.fn(
      async (
        client: unknown,
        _sessionId: string,
        _opts?: unknown,
        _clientId?: string,
      ): Promise<MockSession> => takeSession(client),
    );
    static createStandalone = vi.fn(
      async (client: unknown, _opts?: unknown): Promise<MockSession> =>
        takeSession(client),
    );
    static loadStandalone = vi.fn(
      async (
        client: unknown,
        _sessionId: string,
        _opts?: unknown,
        _clientId?: string,
      ): Promise<MockSession> => takeSession(client),
    );
    static resumeStandalone = vi.fn(
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
    daemonClientOptions,
    capabilities,
    workspaceProviders,
    workspaceSkills,
    listStandaloneSessions,
    workspaceAcpStatus,
    workspaceAcpPreheat,
    workspaceGit,
    workspaceByCwd,
    MockDaemonClient,
    MockDaemonSessionClient,
    workspaceMcpTools,
    getPendingPrompts,
    removePendingPrompt,
    removeMidTurnMessage,
    branchSession,
    getSessionTranscriptPage,
    reset() {
      sessions.length = 0;
      daemonClientOptions.length = 0;
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
      listStandaloneSessions.mockReset();
      listStandaloneSessions.mockResolvedValue([]);
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
      workspaceAcpStatus.mockReset();
      workspaceAcpStatus.mockResolvedValue({ channelLive: true });
      workspaceAcpPreheat.mockReset();
      workspaceAcpPreheat.mockResolvedValue({
        ready: true,
        channelLive: true,
        durationMs: 1,
      });
      workspaceGit.mockReset();
      workspaceGit.mockResolvedValue({
        v: 1,
        workspaceCwd: '/mock-workspace',
        branch: 'main',
      });
      workspaceByCwd.mockReset();
      workspaceByCwd.mockImplementation((_workspaceCwd: string) => ({
        workspaceGit,
      }));
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
      removeMidTurnMessage.mockReset();
      removeMidTurnMessage.mockResolvedValue({ removed: true });
      branchSession.mockReset();
      branchSession.mockResolvedValue({
        sessionId: 'branch-session',
        displayName: 'Branch Session',
      });
      getSessionTranscriptPage.mockReset();
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
      MockDaemonSessionClient.resume.mockReset();
      MockDaemonSessionClient.resume.mockImplementation(
        async (client: unknown, _sessionId: string): Promise<MockSession> =>
          takeSession(client),
      );
      MockDaemonSessionClient.createStandalone.mockReset();
      MockDaemonSessionClient.createStandalone.mockImplementation(
        async (client: unknown): Promise<MockSession> => takeSession(client),
      );
      MockDaemonSessionClient.loadStandalone.mockReset();
      MockDaemonSessionClient.loadStandalone.mockImplementation(
        async (client: unknown): Promise<MockSession> => takeSession(client),
      );
      MockDaemonSessionClient.resumeStandalone.mockReset();
      MockDaemonSessionClient.resumeStandalone.mockImplementation(
        async (client: unknown): Promise<MockSession> => takeSession(client),
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

  it('does not rerender streaming state consumers for equivalent transcript updates', async () => {
    let store: DaemonTranscriptStore | undefined;
    let renderCount = 0;

    function Harness() {
      store = useDaemonTranscriptStore();
      useDaemonStreamingState();
      renderCount += 1;
      return null;
    }

    await renderWithProvider(<Harness />);
    const initialRenderCount = renderCount;

    act(() => {
      store?.appendLocalUserMessage('first');
      store?.appendLocalUserMessage('second');
    });

    expect(renderCount).toBe(initialRenderCount);
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
      gitBranch: 'main',
    });
    expect(connection).not.toHaveProperty('sessionId');
  });

  it('loads standalone sessions without workspace fallback or metadata calls', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/primary',
          primary: true,
          trusted: true,
        },
      ],
    });
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'standalone-1',
        workspaceCwd: '/private/standalone-1',
        session: {
          sessionId: 'standalone-1',
          workspaceCwd: '/private/standalone-1',
          sourceType: 'standalone',
          context: { kind: 'standalone' },
          projectlessOutputDirectory: '/output/standalone-1',
          workingDirectory: { state: 'ready' },
        },
      }),
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
      sessionId: 'standalone-1',
      sessionContext: { kind: 'standalone' },
    });
    await act(async () => {
      await vi.waitFor(() => expect(connection?.status).toBe('connected'));
    });

    expect(
      sdkMocks.MockDaemonSessionClient.loadStandalone,
    ).toHaveBeenCalledWith(
      expect.anything(),
      'standalone-1',
      { timeoutMs: 70_000 },
      expect.any(String),
    );
    expect(sdkMocks.MockDaemonSessionClient.load).not.toHaveBeenCalled();
    expect(sdkMocks.workspaceProviders).not.toHaveBeenCalled();
    expect(sdkMocks.workspaceSkills).not.toHaveBeenCalled();
    expect(sdkMocks.workspaceByCwd).not.toHaveBeenCalled();
    expect(connection).toMatchObject({
      sessionContext: { kind: 'standalone' },
      workspaceCwd: undefined,
      standaloneSession: {
        projectlessOutputDirectory: '/output/standalone-1',
        workingDirectory: { state: 'ready' },
      },
    });

    await act(async () => {
      await actions?.listSessions();
    });
    expect(sdkMocks.listStandaloneSessions).toHaveBeenCalledOnce();
  });

  it('resumes standalone sessions through the dedicated route', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
    });
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'standalone-resumed',
        workspaceCwd: '/private/standalone-resumed',
        session: {
          sessionId: 'standalone-resumed',
          workspaceCwd: '/private/standalone-resumed',
          sourceType: 'standalone',
          context: { kind: 'standalone' },
          projectlessOutputDirectory: '/output/standalone-resumed',
          workingDirectory: { state: 'ready' },
        },
      }),
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
      sessionContext: { kind: 'standalone' },
    });
    await act(async () => flushPromises());
    let resume!: Promise<void>;
    act(() => {
      resume = requireActions(actions).resumeSession('standalone-resumed', {
        sessionContext: { kind: 'standalone' },
      });
    });
    await act(async () => flushPromises());
    await expect(resume).resolves.toBeUndefined();

    expect(
      sdkMocks.MockDaemonSessionClient.resumeStandalone,
    ).toHaveBeenCalledWith(
      expect.anything(),
      'standalone-resumed',
      { timeoutMs: 70_000 },
      expect.any(String),
    );
    expect(sdkMocks.MockDaemonSessionClient.resume).not.toHaveBeenCalled();
    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'standalone-resumed',
      sessionContext: { kind: 'standalone' },
      workspaceCwd: undefined,
    });
  });

  it('keeps standalone working-directory failures target-scoped', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
    });
    sdkMocks.MockDaemonSessionClient.loadStandalone.mockRejectedValueOnce(
      new DaemonHttpError(
        409,
        { code: 'working_directory_compromised', retryable: false },
        'working directory compromised',
      ),
    );
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'standalone-broken',
      sessionContext: { kind: 'standalone' },
    });
    await act(async () => {
      await vi.waitFor(() => expect(connection?.status).toBe('error'));
    });

    expect(connection).toMatchObject({
      sessionId: 'standalone-broken',
      sessionContext: { kind: 'standalone' },
      standaloneSession: {
        errorCode: 'working_directory_compromised',
      },
    });
    expect(connection?.workspaceCwd).toBeUndefined();
    expect(
      sdkMocks.MockDaemonSessionClient.loadStandalone,
    ).toHaveBeenCalledOnce();
    expect(sdkMocks.MockDaemonSessionClient.load).not.toHaveBeenCalled();
  });

  it('loads Live sessions through the unique trusted runtime without exposing its cwd', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['multi_workspace_sessions'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/primary',
          primary: true,
          trusted: true,
        },
        {
          id: 'live',
          cwd: '/conversations',
          kind: 'live',
          primary: false,
          trusted: true,
        },
      ],
    });
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'live-1',
        workspaceCwd: '/conversations',
      }),
    );
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'live-1',
      sessionContext: { kind: 'live' },
    });
    await act(async () => {
      await vi.waitFor(() => expect(connection?.status).toBe('connected'));
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledWith(
      expect.anything(),
      'live-1',
      expect.objectContaining({ workspaceCwd: '/conversations' }),
      expect.anything(),
    );
    expect(sdkMocks.workspaceProviders).not.toHaveBeenCalled();
    expect(sdkMocks.workspaceSkills).not.toHaveBeenCalled();
    expect(sdkMocks.workspaceByCwd).not.toHaveBeenCalled();
    expect(connection).toMatchObject({
      sessionContext: { kind: 'live' },
      workspaceCwd: undefined,
    });
  });

  it('fails a Live load once when runtime ownership is ambiguous', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['multi_workspace_sessions'],
      workspaces: [
        {
          id: 'live-a',
          cwd: '/conversations/a',
          kind: 'live',
          primary: false,
          trusted: true,
        },
        {
          id: 'live-b',
          cwd: '/conversations/b',
          kind: 'live',
          primary: false,
          trusted: true,
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
      autoReconnect: true,
      sessionId: 'live-ambiguous',
      sessionContext: { kind: 'live' },
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await vi.waitFor(() => expect(connection?.status).toBe('error'));
      await flushPromises();
    });
    await act(async () => {
      await wait(20);
      await flushPromises();
    });

    expect(connection).toMatchObject({
      error: 'Daemon advertises multiple Live session runtimes',
      sessionContext: { kind: 'live' },
    });
    expect(sdkMocks.capabilities).toHaveBeenCalledOnce();
    expect(sdkMocks.MockDaemonSessionClient.load).not.toHaveBeenCalled();
    expect(
      sdkMocks.MockDaemonSessionClient.loadStandalone,
    ).not.toHaveBeenCalled();
  });

  it('rejects a non-workspace context combined with workspaceCwd before connecting', async () => {
    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      workspaceCwd: '/primary',
      sessionContext: { kind: 'standalone' },
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection).toMatchObject({
      status: 'error',
      error: 'standalone session context cannot include workspaceCwd',
    });
    expect(sdkMocks.capabilities).not.toHaveBeenCalled();

    await act(async () => {
      await expect(requireActions(actions).createSession()).rejects.toThrow(
        'standalone session context cannot include workspaceCwd',
      );
    });
    expect(
      sdkMocks.MockDaemonSessionClient.createStandalone,
    ).not.toHaveBeenCalled();
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).not.toHaveBeenCalled();
    expect(connection).toMatchObject({
      status: 'error',
      error: 'standalone session context cannot include workspaceCwd',
    });
  });

  it('does not start a controlled load for conflicting context props', async () => {
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'standalone-conflict',
      workspaceCwd: '/primary',
      sessionContext: { kind: 'standalone' },
    });
    await act(async () => flushPromises());

    expect(connection).toMatchObject({
      status: 'error',
      error: 'standalone session context cannot include workspaceCwd',
    });
    expect(
      sdkMocks.MockDaemonSessionClient.loadStandalone,
    ).not.toHaveBeenCalled();
    expect(sdkMocks.MockDaemonSessionClient.load).not.toHaveBeenCalled();
  });

  it('keeps a connected session attached when controlled props become conflicting', async () => {
    const activeSession = createMockSession({
      sessionId: 'workspace-active',
      workspaceCwd: '/workspace/active',
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(activeSession);
    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'workspace-active',
      sessionContext: { kind: 'workspace', cwd: '/workspace/active' },
    });
    await act(async () => {
      await vi.waitFor(() => expect(connection?.status).toBe('connected'));
    });
    sdkMocks.MockDaemonSessionClient.load.mockClear();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect
          sessionId="standalone-conflict"
          workspaceCwd="/workspace/active"
          sessionContext={{ kind: 'standalone' }}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => flushPromises());

    expect(connection).toMatchObject({
      status: 'error',
      error: 'standalone session context cannot include workspaceCwd',
    });
    expect(sdkMocks.MockDaemonSessionClient.load).not.toHaveBeenCalled();
    expect(
      sdkMocks.MockDaemonSessionClient.loadStandalone,
    ).not.toHaveBeenCalled();
    expect(activeSession.detach).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/session/workspace-active/detach'),
      expect.anything(),
    );

    await act(async () => {
      await expect(requireActions(actions).createSession()).rejects.toThrow(
        'standalone session context cannot include workspaceCwd',
      );
    });
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).not.toHaveBeenCalled();
    expect(
      sdkMocks.MockDaemonSessionClient.createStandalone,
    ).not.toHaveBeenCalled();
    expect(connection).toMatchObject({
      status: 'error',
      error: 'standalone session context cannot include workspaceCwd',
    });
    expect(activeSession.detach).not.toHaveBeenCalled();

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect
          sessionId="workspace-active"
          sessionContext={{ kind: 'workspace', cwd: '/workspace/active' }}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await vi.waitFor(() => expect(connection?.status).toBe('connected'));
    });

    expect(sdkMocks.MockDaemonSessionClient.load).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/session/workspace-active/detach'),
      expect.anything(),
    );
  });

  it('updates an empty controlled provider when its session context changes', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
    });
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
      sessionContext: { kind: 'workspace', cwd: '/primary' },
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(connection).toMatchObject({
          status: 'connected',
          sessionContext: { kind: 'workspace', cwd: '/primary' },
        }),
      );
    });

    sdkMocks.workspaceProviders.mockClear();
    sdkMocks.workspaceSkills.mockClear();
    sdkMocks.workspaceByCwd.mockClear();
    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect
          sessionContext={{ kind: 'standalone' }}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(connection).toMatchObject({
          status: 'connected',
          sessionContext: { kind: 'standalone' },
          workspaceCwd: undefined,
        }),
      );
    });

    expect(sdkMocks.workspaceProviders).not.toHaveBeenCalled();
    expect(sdkMocks.workspaceSkills).not.toHaveBeenCalled();
    expect(sdkMocks.workspaceByCwd).not.toHaveBeenCalled();
    expect(connection?.commands).toBeUndefined();
    expect(connection?.skills).toBeUndefined();
    expect(connection?.models).toBeUndefined();
    expect(connection?.providers).toBeUndefined();
    expect(connection?.currentModel).toBeUndefined();
    expect(connection?.currentMode).toBeUndefined();
    expect(connection?.gitBranch).toBeUndefined();
    expect(connection?.gitStatus).toBeUndefined();
    expect(
      sdkMocks.MockDaemonSessionClient.createStandalone,
    ).not.toHaveBeenCalled();
  });

  it('does not reconnect for an equivalent inline session context', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
    });

    function Harness() {
      useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
      sessionContext: { kind: 'standalone' },
    });
    await act(async () => {
      await flushPromises();
    });
    expect(sdkMocks.capabilities).toHaveBeenCalledOnce();

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect
          sessionContext={{ kind: 'standalone' }}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });

    expect(sdkMocks.capabilities).toHaveBeenCalledOnce();
  });

  it('keeps a baseUrl-only session when its connected id is echoed as a prop', async () => {
    const keepConnected = createDeferred<void>();
    const createdSession = createMockSession({
      sessionId: 'session-echo',
      events: createPendingEvents(keepConnected),
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
    await act(async () => requireActions(actions).newSession());
    await act(async () => {
      await vi.waitFor(() =>
        expect(connection).toMatchObject({
          status: 'connected',
          sessionId: 'session-echo',
        }),
      );
    });

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect
          sessionId={connection?.sessionId}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => flushPromises());

    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).toHaveBeenCalledOnce();
    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'session-echo',
    });
    expect(createdSession.detach).not.toHaveBeenCalled();
    keepConnected.resolve();
  });

  it('reloads a controlled standalone session once after a baseUrl change', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
    });
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'standalone-controlled',
        workspaceCwd: '/private/standalone-controlled',
        session: {
          sessionId: 'standalone-controlled',
          workspaceCwd: '/private/standalone-controlled',
          sourceType: 'standalone',
          context: { kind: 'standalone' },
          workingDirectory: { state: 'ready' },
        },
      }),
      createMockSession({
        sessionId: 'standalone-controlled',
        workspaceCwd: '/private/standalone-controlled',
        session: {
          sessionId: 'standalone-controlled',
          workspaceCwd: '/private/standalone-controlled',
          sourceType: 'standalone',
          context: { kind: 'standalone' },
          workingDirectory: { state: 'ready' },
        },
      }),
    );

    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'standalone-controlled',
      sessionContext: { kind: 'standalone' },
    });
    expect(
      sdkMocks.MockDaemonSessionClient.loadStandalone,
    ).toHaveBeenCalledTimes(1);

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4171"
          autoConnect
          sessionId="standalone-controlled"
          sessionContext={{ kind: 'standalone' }}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => flushPromises());

    expect(
      sdkMocks.MockDaemonSessionClient.loadStandalone,
    ).toHaveBeenCalledTimes(2);
    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'standalone-controlled',
      sessionContext: { kind: 'standalone' },
    });
    expect(sdkMocks.daemonClientOptions).toContainEqual({
      baseUrl: 'http://127.0.0.1:4171',
      token: undefined,
    });
    expect(
      sdkMocks.MockDaemonSessionClient.createStandalone,
    ).not.toHaveBeenCalled();
  });

  it('settles a workspace load when the daemon reports a canonical cwd', async () => {
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'workspace-canonical',
        workspaceCwd: '/private/tmp',
        events: createIdleEvents(),
      }),
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
    let loadPromise!: Promise<void>;
    await act(async () => {
      loadPromise = requireActions(actions).loadSession('workspace-canonical', {
        workspaceCwd: '/tmp',
      });
      await flushPromises();
    });
    await expect(loadPromise).resolves.toBeUndefined();

    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'workspace-canonical',
      sessionContext: { kind: 'workspace', cwd: '/private/tmp' },
      workspaceCwd: '/private/tmp',
    });
  });

  it('does not inherit a failed controlled target in a baseUrl-only provider', async () => {
    sdkMocks.MockDaemonSessionClient.load.mockRejectedValueOnce(
      new Error('load failed'),
    );
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    let failedLoad!: Promise<void>;
    await act(async () => {
      failedLoad = requireActions(actions).loadSession('failed-target', {
        workspaceCwd: '/failed-target',
      });
      void failedLoad.catch(() => undefined);
      await flushPromises();
    });
    await expect(failedLoad).rejects.toThrow('load failed');

    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'primary-target',
        workspaceCwd: '/mock-workspace',
        events: createIdleEvents(),
      }),
    );
    let primaryLoad!: Promise<void>;
    await act(async () => {
      primaryLoad = requireActions(actions).loadSession('primary-target');
      await flushPromises();
    });
    await expect(primaryLoad).resolves.toBeUndefined();

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenLastCalledWith(
      expect.anything(),
      'primary-target',
      { workspaceCwd: '/mock-workspace', timeoutMs: 70_000 },
      expect.any(String),
    );
  });

  it('creates a fresh standalone session without the generic route', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
    });
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'standalone-fresh',
        workspaceCwd: '/private/standalone-fresh',
        session: {
          sessionId: 'standalone-fresh',
          workspaceCwd: '/private/standalone-fresh',
          sourceType: 'standalone',
          context: { kind: 'standalone' },
          projectlessOutputDirectory: '/output/standalone-fresh',
          workingDirectory: { state: 'ready' },
        },
      }),
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
      sessionContext: { kind: 'standalone' },
    });
    await act(async () => {
      await actions?.newSession();
      await vi.waitFor(() => expect(connection?.status).toBe('connected'));
    });

    expect(
      sdkMocks.MockDaemonSessionClient.createStandalone,
    ).toHaveBeenCalledOnce();
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).not.toHaveBeenCalled();
    expect(connection).toMatchObject({
      sessionId: 'standalone-fresh',
      sessionContext: { kind: 'standalone' },
      workspaceCwd: undefined,
      standaloneSession: {
        projectlessOutputDirectory: '/output/standalone-fresh',
        workingDirectory: { state: 'ready' },
      },
    });
  });

  it('surfaces direct standalone create recovery without retrying', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
    });
    const sessionId = '019cf000-0000-7000-8000-000000000003';
    const originalError = new DaemonHttpError(
      503,
      { code: 'standalone_session_creating' },
      'outcome unknown',
    );
    sdkMocks.MockDaemonSessionClient.createStandalone.mockRejectedValueOnce(
      new DaemonStandaloneCreationOutcomeUnknownError(
        sessionId,
        { state: 'creating', sessionId },
        originalError,
      ),
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
      sessionContext: { kind: 'standalone' },
    });
    await act(async () => flushPromises());
    await act(async () => {
      await requireActions(actions).newSession();
    });
    await act(async () => {
      await vi.waitFor(() => expect(connection?.status).toBe('error'));
    });

    expect(
      sdkMocks.MockDaemonSessionClient.createStandalone,
    ).toHaveBeenCalledOnce();
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).not.toHaveBeenCalled();
    expect(connection).toMatchObject({
      status: 'error',
      sessionId,
      sessionContext: { kind: 'standalone' },
      workspaceCwd: undefined,
      standaloneSession: {
        creationRecovery: { state: 'creating', sessionId },
        errorCode: 'standalone_session_creating',
      },
    });

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect
          sessionContext={{ kind: 'standalone' }}
          createSessionRequest={{ modelServiceId: 'next-model' }}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => flushPromises());

    expect(connection).toMatchObject({
      status: 'error',
      sessionId,
      sessionContext: { kind: 'standalone' },
      standaloneSession: {
        creationRecovery: { state: 'creating', sessionId },
      },
    });
    expect(
      sdkMocks.MockDaemonSessionClient.createStandalone,
    ).toHaveBeenCalledOnce();

    const recoveredSession = createMockSession({
      sessionId,
      workspaceCwd: '/private/recovered-standalone',
      session: {
        sessionId,
        workspaceCwd: '/private/recovered-standalone',
        sourceType: 'standalone',
        context: { kind: 'standalone' },
        projectlessOutputDirectory: '/output/recovered-standalone',
        workingDirectory: { state: 'ready' },
      },
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(recoveredSession);
    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect
          sessionId={sessionId}
          sessionContext={{ kind: 'standalone' }}
          createSessionRequest={{ modelServiceId: 'next-model' }}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await wait(50);
      await flushPromises();
    });
    expect(connection?.status).toBe('connected');

    expect(
      sdkMocks.MockDaemonSessionClient.loadStandalone,
    ).toHaveBeenCalledOnce();
    expect(connection).toMatchObject({
      status: 'connected',
      sessionId,
      sessionContext: { kind: 'standalone' },
      standaloneSession: {
        projectlessOutputDirectory: '/output/recovered-standalone',
      },
    });
  });

  it('preserves action-created standalone recovery across baseUrl-only dependency churn', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
    });
    const sessionId = '019cf000-0000-7000-8000-000000000004';
    const originalError = new DaemonHttpError(
      503,
      { code: 'standalone_session_creating' },
      'outcome unknown',
    );
    sdkMocks.MockDaemonSessionClient.createStandalone.mockRejectedValueOnce(
      new DaemonStandaloneCreationOutcomeUnknownError(
        sessionId,
        { state: 'creating', sessionId },
        originalError,
      ),
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
      await vi.waitFor(() => expect(connection?.status).toBe('connected'));
    });
    await act(async () => {
      await expect(
        requireActions(actions).createSession({
          sessionContext: { kind: 'standalone' },
        }),
      ).rejects.toBeInstanceOf(DaemonStandaloneCreationOutcomeUnknownError);
    });

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect
          createSessionRequest={{ modelServiceId: 'next-model' }}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => flushPromises());

    expect(connection).toMatchObject({
      status: 'error',
      sessionId,
      sessionContext: { kind: 'standalone' },
      standaloneSession: {
        creationRecovery: { state: 'creating', sessionId },
      },
    });
    expect(
      sdkMocks.MockDaemonSessionClient.createStandalone,
    ).toHaveBeenCalledOnce();
  });

  it('clears stale standalone identity after a plain fresh-create failure', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
    });
    const activeSession = createMockSession({
      sessionId: 'standalone-active',
      workspaceCwd: '/private/standalone-active',
      session: {
        sessionId: 'standalone-active',
        workspaceCwd: '/private/standalone-active',
        sourceType: 'standalone',
        context: { kind: 'standalone' },
        projectlessOutputDirectory: '/output/standalone-active',
        workingDirectory: { state: 'ready' },
      },
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(activeSession);
    sdkMocks.MockDaemonSessionClient.createStandalone.mockRejectedValueOnce(
      new Error('create failed'),
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
      sessionId: 'standalone-active',
      sessionContext: { kind: 'standalone' },
    });
    await act(async () => {
      await vi.waitFor(() => expect(connection?.status).toBe('connected'));
    });
    await act(async () => requireActions(actions).newSession());
    await act(async () => {
      await vi.waitFor(() => expect(connection?.status).toBe('error'));
    });

    expect(connection).toMatchObject({
      status: 'error',
      sessionContext: { kind: 'standalone' },
      error: 'create failed',
    });
    expect(connection?.sessionId).toBeUndefined();
    expect(connection?.displayName).toBeUndefined();
    expect(connection?.standaloneSession?.creationRecovery).toBeUndefined();

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect
          sessionId="standalone-active"
          sessionContext={{ kind: 'standalone' }}
          createSessionRequest={{ modelServiceId: 'next-model' }}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => flushPromises());

    expect(connection).toMatchObject({
      status: 'error',
      sessionContext: { kind: 'standalone' },
      error: 'create failed',
      standaloneSession: { errorCode: undefined },
    });
    expect(
      sdkMocks.MockDaemonSessionClient.createStandalone,
    ).toHaveBeenCalledOnce();
  });

  it('surfaces a standalone create capability failure without fallback', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
    });
    sdkMocks.MockDaemonSessionClient.createStandalone.mockRejectedValueOnce(
      new DaemonCapabilityMissingError(
        'standalone_sessions_v1',
        'standalone sessions are unavailable',
      ),
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
      sessionContext: { kind: 'standalone' },
    });
    await act(async () => requireActions(actions).newSession());
    await act(async () => {
      await vi.waitFor(() => expect(connection?.status).toBe('error'));
    });

    expect(
      sdkMocks.MockDaemonSessionClient.createStandalone,
    ).toHaveBeenCalledOnce();
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).not.toHaveBeenCalled();
    expect(connection).toMatchObject({
      status: 'error',
      sessionContext: { kind: 'standalone' },
      standaloneSession: { errorCode: 'standalone_sessions_v1' },
    });
    expect(connection?.workspaceCwd).toBeUndefined();
  });

  it('fails a standalone load once when its capability is unavailable', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
    });
    sdkMocks.MockDaemonSessionClient.loadStandalone.mockRejectedValueOnce(
      new DaemonCapabilityMissingError(
        'standalone_sessions_v1',
        'standalone sessions are unavailable',
      ),
    );
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: true,
      sessionId: 'standalone-missing-capability',
      sessionContext: { kind: 'standalone' },
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await vi.waitFor(() => expect(connection?.status).toBe('error'));
    });
    await act(async () => {
      await wait(20);
      await flushPromises();
    });

    expect(
      sdkMocks.MockDaemonSessionClient.loadStandalone,
    ).toHaveBeenCalledOnce();
    expect(sdkMocks.MockDaemonSessionClient.load).not.toHaveBeenCalled();
    expect(
      sdkMocks.MockDaemonSessionClient.createStandalone,
    ).not.toHaveBeenCalled();
    expect(connection).toMatchObject({
      status: 'error',
      sessionContext: { kind: 'standalone' },
      standaloneSession: { errorCode: 'standalone_sessions_v1' },
    });
    expect(connection?.workspaceCwd).toBeUndefined();
  });

  it('keeps model preview separate until live reasoning context is authoritative', async () => {
    sdkMocks.workspaceProviders.mockResolvedValueOnce(
      workspaceProvidersWithReasoningPreview(),
    );
    const session = createMockSession({
      sessionId: 'lazy-session',
      context: vi.fn(async () => ({
        v: 1 as const,
        sessionId: 'lazy-session',
        workspaceCwd: '/mock-workspace',
        state: { configOptions: reasoningConfigOptions('medium') },
      })),
    });
    sdkMocks.sessions.push(session);
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

    expect(connection?.sessionId).toBeUndefined();
    expect(connection?.context).toBeUndefined();
    expect(connection?.reasoning).toBeUndefined();
    expect(connection?.models?.[0]?.reasoningPreview).toEqual({
      enabled: true,
      effort: 'xhigh',
      efforts: ['low', 'medium', 'xhigh'],
    });

    const providerActions = requireActions(actions);
    await act(async () => {
      await providerActions.createSession();
    });
    expect(connection?.sessionId).toBe('lazy-session');
    expect(connection?.context).toBeUndefined();
    expect(connection?.reasoning).toBeUndefined();

    let attach: Promise<void> | undefined;
    act(() => {
      attach = providerActions.attachSession();
    });
    await act(async () => {
      await flushPromises();
    });
    await attach;

    expect(connection?.context?.sessionId).toBe('lazy-session');
    expect(connection?.reasoning).toEqual({
      enabled: true,
      effort: 'medium',
      efforts: ['low', 'medium', 'xhigh'],
    });
  });

  it('does not restore model preview when live context lacks reasoning capability', async () => {
    sdkMocks.workspaceProviders.mockResolvedValueOnce(
      workspaceProvidersWithReasoningPreview(),
    );
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'lazy-session',
        context: vi.fn(async () => ({
          v: 1 as const,
          sessionId: 'lazy-session',
          workspaceCwd: '/mock-workspace',
          state: { configOptions: [] },
        })),
      }),
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

    expect(connection?.context?.sessionId).toBe('lazy-session');
    expect(connection?.reasoning).toBeUndefined();
    expect(connection?.models?.[0]?.reasoningPreview?.effort).toBe('xhigh');
  });

  it('restores workspace reasoning preview after clearing live context models', async () => {
    sdkMocks.workspaceProviders.mockResolvedValue(
      workspaceProvidersWithReasoningPreview(),
    );
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'lazy-session',
        context: vi.fn(async () => ({
          v: 1 as const,
          sessionId: 'lazy-session',
          workspaceCwd: '/mock-workspace',
          state: {
            configOptions: reasoningConfigOptions('medium'),
            models: {
              currentModelId: 'qwen3.8-max',
              availableModels: [
                {
                  modelId: 'qwen3.8-max',
                  baseModelId: 'qwen3.8-max',
                  name: 'Qwen 3.8 Max',
                  contextLimit: 131_072,
                },
              ],
            },
          },
        })),
      }),
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
      sessionId: 'lazy-session',
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection?.context?.sessionId).toBe('lazy-session');
    expect(connection?.models?.[0]?.reasoningPreview).toBeUndefined();

    await act(async () => {
      await actions?.clearSession();
    });

    expect(connection?.sessionId).toBeUndefined();
    expect(connection?.context).toBeUndefined();
    expect(connection?.models?.[0]?.reasoningPreview).toEqual({
      enabled: true,
      effort: 'xhigh',
      efforts: ['low', 'medium', 'xhigh'],
    });
  });

  it('populates git branch from the active session workspace', async () => {
    sdkMocks.sessions.push(createMockSession());
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

    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'session-1',
      workspaceCwd: '/mock-workspace',
      gitBranch: 'main',
    });
    expect(sdkMocks.workspaceByCwd).toHaveBeenCalledWith('/mock-workspace');
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

  it('preheats ACP and refreshes deferred skills when ACP is not running', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['workspace_acp_preheat', 'workspace_acp_status'],
    });
    sdkMocks.workspaceAcpStatus.mockResolvedValue({ channelLive: false });
    sdkMocks.workspaceSkills
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        skills: [
          {
            kind: 'skill',
            status: 'ok',
            name: 'review',
            description: 'Review code',
            level: 'bundled',
            modelInvocable: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        skills: [
          {
            kind: 'skill',
            status: 'ok',
            name: 'review',
            description: 'Review code',
            level: 'bundled',
            modelInvocable: true,
          },
          {
            kind: 'skill',
            status: 'ok',
            name: 'pdf',
            description: 'Work with PDFs',
            level: 'extension',
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
    await act(async () => {
      await flushPromises();
      await flushPromises();
    });

    expect(sdkMocks.workspaceAcpPreheat).toHaveBeenCalledWith(5000);
    expect(sdkMocks.workspaceSkills).toHaveBeenCalledTimes(2);
    expect(connection?.skills).toEqual(['review', 'pdf']);
  });

  it('clears deferred skills when ACP refresh returns an empty list', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['workspace_acp_preheat', 'workspace_acp_status'],
    });
    sdkMocks.workspaceAcpStatus.mockResolvedValue({ channelLive: false });
    sdkMocks.workspaceSkills
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        skills: [
          {
            kind: 'skill',
            status: 'ok',
            name: 'review',
            description: 'Review code',
            level: 'bundled',
            modelInvocable: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/mock-workspace',
        initialized: true,
        skills: [],
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
    await act(async () => {
      await flushPromises();
      await flushPromises();
    });

    expect(connection?.skills).toEqual([]);
    expect(connection?.commands).toEqual([]);
  });

  it('skips ACP workspace routes when the daemon lacks their capabilities', async () => {
    function Harness() {
      useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
    });

    expect(sdkMocks.workspaceAcpStatus).not.toHaveBeenCalled();
    expect(sdkMocks.workspaceAcpPreheat).not.toHaveBeenCalled();
  });

  it('skips primary ACP workspace routes for a secondary workspace', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['workspace_acp_preheat', 'workspace_acp_status'],
    });

    function Harness() {
      useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
      workspaceCwd: '/secondary-workspace',
    });

    expect(sdkMocks.workspaceAcpStatus).not.toHaveBeenCalled();
    expect(sdkMocks.workspaceAcpPreheat).not.toHaveBeenCalled();
  });

  it('preheats without probing status when only preheat is advertised', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['workspace_acp_preheat'],
    });

    function Harness() {
      useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(sdkMocks.workspaceAcpStatus).not.toHaveBeenCalled();
    expect(sdkMocks.workspaceAcpPreheat).toHaveBeenCalledWith(5000);
  });

  it('does not preheat when the advertised ACP status is live', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['workspace_acp_preheat', 'workspace_acp_status'],
    });

    function Harness() {
      useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
    });

    expect(sdkMocks.workspaceAcpStatus).toHaveBeenCalledOnce();
    expect(sdkMocks.workspaceAcpPreheat).not.toHaveBeenCalled();
  });

  it('still preheats when the advertised ACP status request fails', async () => {
    const statusError = new Error('status unavailable');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['workspace_acp_preheat', 'workspace_acp_status'],
    });
    sdkMocks.workspaceAcpStatus.mockRejectedValue(statusError);

    function Harness() {
      useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(warn).toHaveBeenCalledWith(
      '[DaemonSessionProvider] workspaceAcpStatus failed in deferred connect:',
      statusError,
    );
    expect(sdkMocks.workspaceAcpPreheat).toHaveBeenCalledWith(5000);
  });

  it('keeps the deferred connection usable when preheat fails', async () => {
    const preheatError = new Error('preheat unavailable');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['workspace_acp_preheat'],
    });
    sdkMocks.workspaceAcpPreheat.mockRejectedValue(preheatError);
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: undefined,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection).toMatchObject({
      status: 'connected',
      workspaceCwd: '/mock-workspace',
    });
    expect(connection).not.toHaveProperty('sessionId');
    expect(warn).toHaveBeenCalledWith(
      '[DaemonSessionProvider] ACP preheat for workspace skills failed:',
      preheatError,
    );
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
    // resolve and the connection reports connected, without clearing any
    // previous skill commands.
    expect(connection).toMatchObject({
      status: 'connected',
      workspaceCwd: '/mock-workspace',
    });
    expect(connection?.commands).toBeUndefined();
    expect(connection?.skills).toBeUndefined();
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

  it('keeps an explicit standalone context through detached create and attach', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
    });
    const standaloneSession = createMockSession({
      sessionId: 'standalone-created',
      workspaceCwd: '/private/standalone-created',
      session: {
        sessionId: 'standalone-created',
        workspaceCwd: '/private/standalone-created',
        sourceType: 'standalone',
        context: { kind: 'standalone' },
        projectlessOutputDirectory: '/output/standalone-created',
        workingDirectory: { state: 'ready' },
      },
    });
    sdkMocks.sessions.push(standaloneSession);
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
      createSessionRequest: { approvalMode: 'yolo' },
    });
    sdkMocks.workspaceProviders.mockClear();
    sdkMocks.workspaceSkills.mockClear();
    sdkMocks.workspaceByCwd.mockClear();

    const providerActions = requireActions(actions);
    await act(async () => {
      await providerActions.createSession({
        sessionContext: { kind: 'standalone' },
      });
    });

    expect(
      sdkMocks.MockDaemonSessionClient.createStandalone,
    ).toHaveBeenCalledWith(expect.anything(), { approvalMode: 'yolo' });
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).not.toHaveBeenCalled();
    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'standalone-created',
      sessionContext: { kind: 'standalone' },
      workspaceCwd: undefined,
      standaloneSession: {
        projectlessOutputDirectory: '/output/standalone-created',
        workingDirectory: { state: 'ready' },
      },
    });

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect
          createSessionRequest={{
            approvalMode: 'yolo',
            modelServiceId: 'next-model',
          }}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => flushPromises());

    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'standalone-created',
      sessionContext: { kind: 'standalone' },
      workspaceCwd: undefined,
      standaloneSession: {
        projectlessOutputDirectory: '/output/standalone-created',
      },
    });
    expect(sdkMocks.workspaceProviders).not.toHaveBeenCalled();
    expect(sdkMocks.workspaceSkills).not.toHaveBeenCalled();
    expect(sdkMocks.workspaceByCwd).not.toHaveBeenCalled();

    let attach: Promise<void> | undefined;
    act(() => {
      attach = providerActions.attachSession();
    });
    await act(async () => {
      await flushPromises();
    });
    await attach;

    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'standalone-created',
      sessionContext: { kind: 'standalone' },
      workspaceCwd: undefined,
    });
    expect(sdkMocks.workspaceProviders).not.toHaveBeenCalled();
    expect(sdkMocks.workspaceSkills).not.toHaveBeenCalled();
    expect(sdkMocks.workspaceByCwd).not.toHaveBeenCalled();
    expect(standaloneSession.supportedCommands).toHaveBeenCalledOnce();
  });

  it('returns to the workspace prop after clearing a standalone restore', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(undefined, { status: 204 })),
    );
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/workspace',
      features: ['standalone_sessions_v1'],
    });
    const initialWorkspace = createMockSession({
      sessionId: 'workspace-initial',
      workspaceCwd: '/workspace',
      events: createIdleEvents(),
    });
    const loadedStandalone = createMockSession({
      sessionId: 'standalone-loaded',
      workspaceCwd: '/private/standalone-loaded',
      session: {
        sessionId: 'standalone-loaded',
        workspaceCwd: '/private/standalone-loaded',
        sourceType: 'standalone',
        context: { kind: 'standalone' },
        projectlessOutputDirectory: '/output/standalone-loaded',
        workingDirectory: { state: 'ready' },
      },
      events: createIdleEvents(),
    });
    const createdWorkspace = createMockSession({
      sessionId: 'workspace-created',
      workspaceCwd: '/workspace',
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(initialWorkspace);
    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'workspace-initial',
      sessionContext: { kind: 'workspace', cwd: '/workspace' },
    });
    await act(async () => {
      await vi.waitFor(() => expect(connection?.status).toBe('connected'));
    });
    sdkMocks.sessions.push(loadedStandalone, createdWorkspace);
    let loadStandalone!: Promise<void>;
    act(() => {
      loadStandalone = requireActions(actions).loadSession(
        'standalone-loaded',
        {
          sessionContext: { kind: 'standalone' },
        },
      );
    });
    await act(async () => {
      await wait(5);
      await flushPromises();
    });
    await expect(loadStandalone).resolves.toBeUndefined();
    await act(async () => {
      await vi.waitFor(() =>
        expect(connection?.sessionContext).toEqual({ kind: 'standalone' }),
      );
    });
    let newWorkspaceSession!: Promise<void>;
    act(() => {
      newWorkspaceSession = requireActions(actions).newSession();
    });
    await act(async () => {
      await wait(5);
      await flushPromises();
    });
    await expect(newWorkspaceSession).resolves.toBeUndefined();
    await act(async () => {
      await vi.waitFor(() =>
        expect(connection).toMatchObject({
          status: 'connected',
          sessionId: 'workspace-created',
          sessionContext: { kind: 'workspace', cwd: '/workspace' },
        }),
      );
    });

    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).toHaveBeenCalledOnce();
    expect(
      sdkMocks.MockDaemonSessionClient.createStandalone,
    ).not.toHaveBeenCalled();
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

  it('updates session connection capabilities after a workspace refresh', async () => {
    sdkMocks.sessions.push(createMockSession());
    let connection: DaemonConnectionState | undefined;
    let refreshCapabilities: (() => Promise<unknown>) | undefined;

    function Harness() {
      connection = useDaemonConnection();
      refreshCapabilities = useOptionalDaemonWorkspace()?.refreshCapabilities;
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
    sdkMocks.capabilities.mockResolvedValueOnce({
      workspaceCwd: '/mock-workspace',
      features: ['workspace_runtime_removal'],
    });

    await act(async () => {
      await refreshCapabilities?.();
    });

    expect(connection?.capabilities?.features).toContain(
      'workspace_runtime_removal',
    );
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

  it('adds daemon goal set and paused status metadata to the transcript', async () => {
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
                goalState: {
                  v: 2,
                  activity: 'running',
                  goal: {
                    goalId: 'goal-sync',
                    revision: 1,
                    objective: 'ship goal sync',
                    status: 'active',
                    evidenceCursor: { recordId: 'goal-record' },
                    turnCount: 0,
                    activeTimeMs: 0,
                    createdAt: 1234,
                    updatedAt: 1234,
                  },
                },
                goalStatus: {
                  kind: 'set',
                  condition: 'ship goal sync',
                  setAt: 1234,
                },
              },
            },
          },
        };
        yield {
          id: 12,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '' },
              _meta: {
                goalStatus: {
                  kind: 'paused',
                  condition: 'ship goal sync',
                  lastReason: 'waiting for review',
                },
              },
            },
          },
        };
      },
    });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
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
      expect.objectContaining({
        kind: 'status',
        text: '',
        source: 'goal',
        data: {
          kind: 'paused',
          condition: 'ship goal sync',
          lastReason: 'waiting for review',
        },
      }),
    ]);
    expect(connection?.goalState).toMatchObject({
      v: 2,
      activity: 'running',
      goal: {
        goalId: 'goal-sync',
        revision: 1,
        objective: 'ship goal sync',
      },
    });
  });

  it('does not overwrite a streamed goal update with the session-load snapshot', async () => {
    const pendingGoal = createDeferred<GoalStateResponse>();
    const streamedGoal: GoalStateResponse['snapshot'] = {
      v: 2,
      activity: 'idle',
      goal: {
        goalId: 'goal-sync',
        revision: 2,
        objective: 'newer objective',
        status: 'paused',
        evidenceCursor: { recordId: 'goal-record' },
        turnCount: 1,
        activeTimeMs: 10,
        createdAt: 1234,
        updatedAt: 2345,
      },
    };
    sdkMocks.sessions.push(
      createMockSession({
        goal: vi.fn(() => pendingGoal.promise),
        controlGoal: vi.fn(async () => ({ snapshot: streamedGoal })),
      }),
    );
    let connection: DaemonConnectionState | undefined;
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      connection = useDaemonConnection();
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });
    await act(async () => {
      await actions?.controlGoal({
        action: 'pause',
        expectedGoalId: 'goal-sync',
        expectedRevision: 1,
      });
    });
    expect(connection?.goalState).toBe(streamedGoal);

    pendingGoal.resolve({
      snapshot: {
        ...streamedGoal,
        activity: 'running',
        goal: { ...streamedGoal.goal!, revision: 1, status: 'active' },
      },
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection?.goalState).toBe(streamedGoal);
  });

  it('applies a cleared session-load Goal snapshot over a stale active one', async () => {
    // The load-time `goal()` is issued before the state below is installed, so
    // a reference-equality guard would discard its authoritative cleared
    // snapshot — and install no tombstone, leaving the stale goal to come back.
    const pendingGoal = createDeferred<GoalStateResponse>();
    const staleActive: GoalStateResponse['snapshot'] = {
      v: 2,
      activity: 'running',
      goal: {
        goalId: 'goal-stale',
        revision: 1,
        objective: 'stale objective',
        status: 'active',
        evidenceCursor: { recordId: 'goal-record' },
        turnCount: 1,
        activeTimeMs: 10,
        createdAt: 1234,
        updatedAt: 2345,
      },
    };
    sdkMocks.sessions.push(
      createMockSession({
        goal: vi.fn(() => pendingGoal.promise),
        controlGoal: vi.fn(async () => ({ snapshot: staleActive })),
      }),
    );
    let connection: DaemonConnectionState | undefined;
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      connection = useDaemonConnection();
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });
    await act(async () => {
      await actions?.controlGoal({
        action: 'pause',
        expectedGoalId: 'goal-stale',
        expectedRevision: 1,
      });
    });
    expect(connection?.goalState).toBe(staleActive);

    pendingGoal.resolve({
      snapshot: {
        v: 2,
        goal: null,
        activity: 'idle',
        clearedGoal: { goalId: 'goal-stale', revision: 3, updatedAt: 4567 },
      },
    });
    await act(async () => {
      await flushPromises();
    });

    expect(connection?.goalState?.goal).toBeNull();
  });

  it('does not let a stale bare-null session-load Goal read wipe a Goal created meanwhile', async () => {
    // Mirrors actions.test.ts's `getGoal` case for the OTHER `goal()` reader.
    // The load issues its read while the session is goal-less, so the response
    // carries no `clearedGoal` tombstone; a goal created inside the load window
    // (Web Shell allocates the session, then creates the goal on it) would
    // otherwise be accepted as the clear target — wiping it AND tombstoning its
    // identity, after which its own frames at the same revision are rejected as
    // superseded and the composer stops holding prompts for the Goal queue.
    const pendingGoal = createDeferred<GoalStateResponse>();
    const created: GoalStateResponse['snapshot'] = {
      v: 2,
      activity: 'running',
      goal: {
        goalId: 'goal-new',
        revision: 1,
        objective: 'ship safely',
        status: 'active',
        evidenceCursor: { recordId: 'goal-record' },
        turnCount: 0,
        activeTimeMs: 0,
        createdAt: 1234,
        updatedAt: 2345,
      },
    };
    sdkMocks.sessions.push(
      createMockSession({ goal: vi.fn(() => pendingGoal.promise) }),
    );
    let connection: DaemonConnectionState | undefined;
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      connection = useDaemonConnection();
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });

    const sessionId = connection?.sessionId;
    expect(sessionId).toBeDefined();
    await act(async () => {
      actions?.applyGoalSnapshot(sessionId!, created);
      pendingGoal.resolve({
        snapshot: { v: 2, goal: null, activity: 'idle' },
      });
      await flushPromises();
    });

    expect(connection?.goalState).toBe(created);
  });

  it('keeps a known Goal state when the session-load Goal request fails', async () => {
    // Only the fresh-connection branch synthesizes an idle snapshot; once a
    // state is known, a transient `goal()` failure must not replace a live goal
    // with idle — that would drop the strip and the composer gating while the
    // daemon still considers the goal live.
    const pendingGoal = createDeferred<GoalStateResponse>();
    const knownGoal: GoalStateResponse['snapshot'] = {
      v: 2,
      activity: 'running',
      goal: {
        goalId: 'goal-known',
        revision: 2,
        objective: 'keep me',
        status: 'active',
        evidenceCursor: { recordId: 'goal-record' },
        turnCount: 1,
        activeTimeMs: 10,
        createdAt: 1234,
        updatedAt: 2345,
      },
    };
    sdkMocks.sessions.push(
      createMockSession({
        goal: vi.fn(() => pendingGoal.promise),
        controlGoal: vi.fn(async () => ({ snapshot: knownGoal })),
      }),
    );
    let connection: DaemonConnectionState | undefined;
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      connection = useDaemonConnection();
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });
    await act(async () => {
      await actions?.controlGoal({
        action: 'resume',
        expectedGoalId: 'goal-known',
        expectedRevision: 1,
      });
    });
    expect(connection?.goalState).toBe(knownGoal);

    pendingGoal.reject(new Error('goal route unavailable'));
    await act(async () => {
      await flushPromises();
    });

    expect(connection?.goalState).toBe(knownGoal);
  });

  it('releases unknown Goal state when the session-load Goal request fails', async () => {
    sdkMocks.sessions.push(
      createMockSession({
        goal: vi.fn().mockRejectedValue(new Error('goal route unavailable')),
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

    expect(connection?.goalState).toEqual({
      v: 2,
      goal: null,
      activity: 'idle',
    });
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
        text: 'also check the tests',
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
      ).resolves.toEqual({
        promptId: 'pending-1',
        removedAfterAbort: true,
      });
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
      ).resolves.toEqual({
        promptId: 'pending-1',
        removedAfterAbort: true,
      });
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

  it('routes mid-turn message removal through the matching session owner', async () => {
    const removeMidTurnMessage = vi.fn(async () => ({ removed: true }));
    const session = createMockSession({
      sessionId: 'session-current',
      clientId: 'client-current',
      removeMidTurnMessage,
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
      providerActions.removeMidTurnMessage('mid-current'),
    ).resolves.toEqual({ removed: true });
    await expect(
      providerActions.removeMidTurnMessage('mid-old', {
        sessionId: 'session-old',
      }),
    ).resolves.toEqual({ removed: true });

    expect(removeMidTurnMessage).toHaveBeenCalledWith('mid-current');
    // The cross-session branch must forward an id attached to the target
    // session so the bridge authorizes the mutation.
    expect(sdkMocks.removeMidTurnMessage).toHaveBeenCalledWith(
      'session-old',
      'mid-old',
      { clientId: 'client-current' },
    );
  });

  it('forwards the persisted client id of the target session on cross-session removal', async () => {
    window.sessionStorage.clear();
    const removeMidTurnMessage = vi.fn(async () => ({ removed: true }));
    const session = createMockSession({
      sessionId: 'session-current',
      clientId: 'client-current',
      removeMidTurnMessage,
    });
    sdkMocks.sessions.push(session);
    // After switching sessions, forward session-old's persisted id because the
    // current session's id is not attached to the target session.
    persistStableClientId('client-old', 'session-old');
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    const providerActions = requireActions(actions);

    await expect(
      providerActions.removeMidTurnMessage('mid-old', {
        sessionId: 'session-old',
      }),
    ).resolves.toEqual({ removed: true });

    expect(sdkMocks.removeMidTurnMessage).toHaveBeenCalledWith(
      'session-old',
      'mid-old',
      { clientId: 'client-old' },
    );
    window.sessionStorage.clear();
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

  it('does not restart the event stream after prompt acceptance by default', async () => {
    const turnComplete = createDeferred<void>();
    const eventSignals: AbortSignal[] = [];
    const events = vi.fn(async function* defaultPromptEvents(
      opts: { signal?: AbortSignal } = {},
    ) {
      if (opts.signal) eventSignals.push(opts.signal);
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
        id: 1,
        type: 'turn_complete',
        data: { promptId: 'prompt-1', stopReason: 'end_turn' },
      } satisfies DaemonEvent;
    });
    const session = createMockSession({ events });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    let prompt: Promise<unknown> | undefined;
    await act(async () => {
      prompt = requireActions(actions).sendPrompt('hello');
      await flushPromises();
    });

    expect(events).toHaveBeenCalledTimes(1);
    expect(eventSignals[0]?.aborted).toBe(false);

    turnComplete.resolve();
    const pendingPrompt = prompt;
    if (!pendingPrompt) throw new Error('prompt was not started');
    await act(async () => {
      await expect(pendingPrompt).resolves.toEqual({
        stopReason: 'end_turn',
      });
    });
  });

  it('keeps prompt loading active after non-blocking prompt acceptance', async () => {
    const turnComplete = createDeferred<void>();
    const secondSubscriptionStarted = createDeferred<void>();
    const eventSignals: AbortSignal[] = [];
    const events = vi.fn(async function* acceptedPromptEvents(
      opts: { signal?: AbortSignal } = {},
    ) {
      if (opts.signal) eventSignals.push(opts.signal);
      if (events.mock.calls.length === 2) secondSubscriptionStarted.resolve();
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
        data: { promptId: 'prompt-1', stopReason: 'end_turn' },
      } satisfies DaemonEvent;
    });
    const session = createMockSession({
      submitPrompt: vi.fn(async () => ({
        promptId: 'prompt-1',
        lastEventId: 10,
      })),
      events,
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

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      restartEventStreamOnPrompt: true,
    });
    const providerActions = requireActions(actions);
    const providersCalls = sdkMocks.workspaceProviders.mock.calls.length;
    const gitCalls = sdkMocks.workspaceGit.mock.calls.length;
    const supportedCommandsCalls = vi.mocked(session.supportedCommands).mock
      .calls.length;
    const contextCalls = vi.mocked(session.context).mock.calls.length;

    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('hello');
      await secondSubscriptionStarted.promise;
    });
    expect(events).toHaveBeenCalledTimes(2);
    expect(events.mock.calls[1]?.[0]).toMatchObject({
      sseConnectReason: 'prompt_restart',
    });
    expect(eventSignals[0]?.aborted).toBe(true);
    expect(eventSignals[1]?.aborted).toBe(false);
    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
    expect(sdkMocks.workspaceProviders).toHaveBeenCalledTimes(providersCalls);
    expect(sdkMocks.workspaceGit).toHaveBeenCalledTimes(gitCalls);
    expect(session.supportedCommands).toHaveBeenCalledTimes(
      supportedCommandsCalls,
    );
    expect(session.context).toHaveBeenCalledTimes(contextCalls);
    expect(streamingState).not.toBe('idle');

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

  it('restarts the event stream when aborting the subscription throws', async () => {
    const turnComplete = createDeferred<void>();
    const secondSubscriptionStarted = createDeferred<void>();
    const eventSignals: AbortSignal[] = [];
    const events = vi.fn(async function* throwingAbortEvents(
      opts: { signal?: AbortSignal } = {},
    ) {
      if (opts.signal) eventSignals.push(opts.signal);
      const subscription = events.mock.calls.length;
      if (subscription === 2) secondSubscriptionStarted.resolve();
      await Promise.race([
        turnComplete.promise,
        new Promise<void>((resolve) =>
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        ),
      ]);
      if (opts.signal?.aborted) {
        if (subscription === 1) throw createAbortError();
        return;
      }
      yield {
        v: 1,
        id: 11,
        type: 'turn_complete',
        data: { promptId: 'prompt-1', stopReason: 'end_turn' },
      } satisfies DaemonEvent;
    });
    const session = createMockSession({
      submitPrompt: vi.fn(async () => ({
        promptId: 'prompt-1',
        lastEventId: 10,
      })),
      events,
    });
    sdkMocks.sessions.push(session);
    let actions: DaemonUiSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      restartEventStreamOnPrompt: true,
    });
    const providerActions = requireActions(actions);
    const providersCalls = sdkMocks.workspaceProviders.mock.calls.length;
    const gitCalls = sdkMocks.workspaceGit.mock.calls.length;
    const supportedCommandsCalls = vi.mocked(session.supportedCommands).mock
      .calls.length;
    const contextCalls = vi.mocked(session.context).mock.calls.length;

    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('hello');
      await secondSubscriptionStarted.promise;
    });

    expect(events).toHaveBeenCalledTimes(2);
    expect(events.mock.calls[1]?.[0]).toMatchObject({
      sseConnectReason: 'prompt_restart',
    });
    expect(eventSignals[0]?.aborted).toBe(true);
    expect(eventSignals[1]?.aborted).toBe(false);
    expect(sdkMocks.workspaceProviders).toHaveBeenCalledTimes(providersCalls);
    expect(sdkMocks.workspaceGit).toHaveBeenCalledTimes(gitCalls);
    expect(session.supportedCommands).toHaveBeenCalledTimes(
      supportedCommandsCalls,
    );
    expect(session.context).toHaveBeenCalledTimes(contextCalls);

    turnComplete.resolve();
    const pendingPrompt = promptResult;
    if (!pendingPrompt) throw new Error('prompt was not started');
    await act(async () => {
      await expect(pendingPrompt).resolves.toEqual({
        stopReason: 'end_turn',
      });
    });
  });

  it('rebuilds the SSE stream immediately when a prompt is submitted while the stream is down', async () => {
    const turnComplete = createDeferred<void>();
    const secondSubscriptionStarted = createDeferred<void>();
    const eventSignals: AbortSignal[] = [];
    const events = vi.fn(async function* downStreamEvents(
      opts: { signal?: AbortSignal } = {},
    ) {
      if (opts.signal) eventSignals.push(opts.signal);
      const subscription = events.mock.calls.length;
      // First subscription ends immediately: the stream is down and the
      // provider enters reconnect backoff.
      if (subscription === 1) {
        yield* [];
        return;
      }
      secondSubscriptionStarted.resolve();
      await Promise.race([
        turnComplete.promise,
        new Promise<void>((resolve) =>
          opts.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        ),
      ]);
    });
    const session = createMockSession({
      submitPrompt: vi.fn(async () => ({
        promptId: 'prompt-1',
        lastEventId: 10,
      })),
      events,
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
      // Long backoff: the rebuild must be triggered by the prompt admission,
      // not by the reconnect timer elapsing.
      reconnectDelayMs: 60_000,
      maxReconnectDelayMs: 60_000,
    });
    const providerActions = requireActions(actions);

    // The first subscription has ended; the provider is now in backoff.
    await vi.waitFor(() => expect(events).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(connection?.status).toBe('disconnected'));

    // Submitting a prompt rebuilds the stream immediately (no backoff wait).
    await act(async () => {
      void providerActions.sendPrompt('hello');
      await secondSubscriptionStarted.promise;
    });

    expect(events).toHaveBeenCalledTimes(2);
    // The session handle is preserved: no full reload, direct SSE resume.
    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
    expect(eventSignals[1]?.aborted).toBe(false);

    turnComplete.resolve();
    await act(async () => {
      await flushPromises();
    });
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
        yield {
          id: 26,
          v: 1,
          type: 'artifact_changed',
          data: {
            sessionId: 'session-1',
            change: {
              action: 'created',
              artifactId: 'artifact-1',
              artifact: {
                id: 'artifact-1',
                kind: 'html',
                storage: 'workspace',
                source: 'tool',
                status: 'available',
                title: 'Report',
                workspacePath: 'report.html',
                createdAt: '2026-07-09T00:00:00.000Z',
                updatedAt: '2026-07-09T00:00:00.000Z',
              },
            },
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
      artifactsVersion: 1,
      initVersion: 0,
      authVersion: 0,
    });
  });

  it('does not invalidate workspace data from standalone session events', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
    });
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'standalone-signals',
        workspaceCwd: '/private/standalone-signals',
        session: {
          sessionId: 'standalone-signals',
          workspaceCwd: '/private/standalone-signals',
          sourceType: 'standalone',
          context: { kind: 'standalone' },
          workingDirectory: { state: 'ready' },
        },
        events: async function* standaloneWorkspaceEvents() {
          yield {
            id: 21,
            v: 1,
            type: 'memory_changed',
            data: {
              scope: 'workspace',
              filePath: '/private/standalone-signals/QWEN.md',
              mode: 'append',
              bytesWritten: 12,
            },
          } satisfies DaemonEvent;
          yield {
            id: 22,
            v: 1,
            type: 'settings_changed',
            data: {
              key: 'ui.theme',
              scope: 'workspace',
              value: 'Qwen Dark',
            },
          } satisfies DaemonEvent;
        },
      }),
    );
    let signals: DaemonWorkspaceEventSignals | undefined;

    function Harness() {
      signals = useDaemonWorkspaceEventSignals();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'standalone-signals',
      sessionContext: { kind: 'standalone' },
    });
    await act(async () => flushPromises());

    expect(signals).toMatchObject({
      memoryVersion: 0,
      agentsVersion: 0,
      toolsVersion: 0,
      settingsVersion: 0,
      skillsVersion: 0,
      mcpVersion: 0,
      artifactsVersion: 0,
      initVersion: 0,
      authVersion: 0,
    });
  });

  it('deduplicates skill toggle settings events from the generic settings signal', async () => {
    const mutation = {
      id: 'skill-toggle-1',
      kind: 'skill_toggle' as const,
      skills: [{ name: 'web-search', enabled: false }],
      activation: 'applied' as const,
      sessionsRefreshed: 1,
      sessionsFailed: 0,
    };
    const laterMutation = {
      id: 'skill-toggle-2',
      kind: 'skill_toggle' as const,
      skills: [{ name: 'review', enabled: false }],
      activation: 'partial' as const,
      sessionsRefreshed: 0,
      sessionsFailed: 1,
    };
    const session = createMockSession({
      events: async function* skillToggleEvents() {
        yield {
          id: 27,
          v: 1,
          type: 'settings_changed',
          data: {
            key: 'skills.disabled',
            scope: 'workspace',
            value: ['web-search'],
            mutation,
          },
        };
        yield {
          id: 28,
          v: 1,
          type: 'settings_changed',
          data: {
            key: 'skills.enabled',
            scope: 'workspace',
            value: undefined,
            mutation,
          },
        };
        yield {
          id: 29,
          v: 1,
          type: 'settings_changed',
          data: {
            key: 'ui.theme',
            scope: 'workspace',
            value: 'Qwen Dark',
          },
        };
        yield {
          id: 30,
          v: 1,
          type: 'settings_changed',
          data: {
            key: 'skills.disabled',
            scope: 'workspace',
            value: ['web-search', 'review'],
            mutation: laterMutation,
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
      settingsVersion: 1,
      skillsVersion: 2,
      lastSkillMutation: laterMutation,
      skillMutationsByCwd: {
        '/mock-workspace': [mutation, laterMutation],
      },
    });
  });

  it('retains every distinct skill mutation from one replay batch', async () => {
    const partialMutation = {
      id: 'replay-skill-toggle-1',
      kind: 'skill_toggle' as const,
      skills: [{ name: 'web-search', enabled: false }],
      activation: 'partial' as const,
      sessionsRefreshed: 0,
      sessionsFailed: 1,
    };
    const appliedMutation = {
      id: 'replay-skill-toggle-2',
      kind: 'skill_toggle' as const,
      skills: [{ name: 'review', enabled: false }],
      activation: 'applied' as const,
      sessionsRefreshed: 1,
      sessionsFailed: 0,
    };
    const session = createMockSession({
      replaySnapshot: {
        compactedReplay: [
          {
            id: 27,
            v: 1,
            type: 'settings_changed',
            data: {
              key: 'skills.disabled',
              scope: 'workspace',
              value: ['web-search'],
              mutation: partialMutation,
            },
          },
          {
            id: 28,
            v: 1,
            type: 'settings_changed',
            data: {
              key: 'skills.disabled',
              scope: 'workspace',
              value: ['web-search', 'review'],
              mutation: appliedMutation,
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

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });

    expect(signals).toMatchObject({
      skillsVersion: 2,
      lastSkillMutation: appliedMutation,
      skillMutationsByCwd: {
        '/mock-workspace': [partialMutation, appliedMutation],
      },
    });
  });

  it('logs settings reloads without inserting daemon debug blocks', async () => {
    const debug = vi
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined);
    const session = createMockSession({
      events: async function* settingsReloadEvents() {
        yield {
          id: 31,
          v: 1,
          type: 'settings_reloaded',
          data: {
            env: { updatedKeys: ['OPENAI_API_KEY'], removedKeys: [] },
            changedKeys: ['env', 'hooks'],
            childReloaded: true,
            sessionsRefreshed: ['session-1'],
            sessionsSkipped: [],
          },
        };
      },
    });
    sdkMocks.sessions.push(session);
    let signals: DaemonWorkspaceEventSignals | undefined;
    let blocks: readonly DaemonTranscriptBlock[] | undefined;

    function Harness() {
      signals = useDaemonWorkspaceEventSignals();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });

    expect(signals?.settingsVersion).toBe(1);
    expect(blocks).not.toContainEqual(
      expect.objectContaining({
        kind: 'debug',
        text: expect.stringContaining(
          'settings_reloaded (unrecognized daemon event)',
        ) as string,
      }),
    );
    expect(debug).toHaveBeenCalledWith(
      '[DaemonSessionProvider] settings reloaded:',
      expect.objectContaining({
        childReloaded: true,
        changedKeys: ['env', 'hooks'],
        env: { updatedKeys: ['OPENAI_API_KEY'], removedKeys: [] },
        sessionsRefreshed: ['session-1'],
        sessionsSkipped: [],
      }),
    );
    debug.mockRestore();
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
      await flushTranscriptDispatch();
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
      await flushTranscriptDispatch();
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

  it('coalesces a burst of streamed chunks into one complete ordered transcript', async () => {
    // A burst of buffered SSE events — e.g. the stream catching up after the
    // tab was hidden — must drain into a complete, correctly-ordered
    // transcript even though transcript dispatch is batched onto a macrotask.
    // Regression guard for the batched-dispatch path losing or reordering
    // events.
    const CHUNK_COUNT = 100;
    const burstDrained = createDeferred<void>();
    // Spy on the store factory to record how many events each dispatch
    // receives. Batched dispatch must hand the whole burst to a single reducer
    // pass; a regression to per-event dispatch would surface as many
    // single-event dispatches and fail the batch-size assertion below.
    const sdk = await import('@qwen-code/sdk/daemon');
    const realCreateStore = sdk.createDaemonTranscriptStore;
    const dispatchBatchSizes: number[] = [];
    const createStoreSpy = vi
      .spyOn(sdk, 'createDaemonTranscriptStore')
      .mockImplementation((seed) => {
        const store = realCreateStore(seed);
        const realDispatch = store.dispatch.bind(store);
        store.dispatch = (event) => {
          dispatchBatchSizes.push(Array.isArray(event) ? event.length : 1);
          return realDispatch(event);
        };
        return store;
      });
    const session = createMockSession({
      events: async function* burstEvents(opts: { signal?: AbortSignal } = {}) {
        for (let i = 0; i < CHUNK_COUNT; i += 1) {
          yield {
            id: i + 1,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: `chunk-${i} ` },
              },
            },
          };
        }
        burstDrained.resolve();
        // Stay alive so the consumer loop does not end (which would flush
        // synchronously) — exercise the batched macrotask flush instead.
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
      await burstDrained.promise;
      await flushPromises();
      await flushTranscriptDispatch();
    });

    const assistant = blocks.find((block) => block.kind === 'assistant');
    const text = (assistant as { text?: string } | undefined)?.text ?? '';
    // No chunk lost, and all in order.
    let lastIndex = -1;
    for (let i = 0; i < CHUNK_COUNT; i += 1) {
      const idx = text.indexOf(`chunk-${i} `);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
    // The whole burst reached the store in a single dispatch — the coalescing
    // property this fix exists to provide. `toContain` alone would still pass
    // if a regression also emitted redundant per-event dispatches; pin that the
    // burst is the only dispatch (one reducer pass, nothing duplicated).
    expect(dispatchBatchSizes).toEqual([CHUNK_COUNT]);
    createStoreSpy.mockRestore();
  });

  it('coalesces streamed chunks arriving within the dispatch window', async () => {
    vi.useFakeTimers();
    const sdk = await import('@qwen-code/sdk/daemon');
    const realCreateStore = sdk.createDaemonTranscriptStore;
    const dispatchBatchSizes: number[] = [];
    const createStoreSpy = vi
      .spyOn(sdk, 'createDaemonTranscriptStore')
      .mockImplementation((seed) => {
        const store = realCreateStore(seed);
        const realDispatch = store.dispatch.bind(store);
        store.dispatch = (event) => {
          dispatchBatchSizes.push(Array.isArray(event) ? event.length : 1);
          return realDispatch(event);
        };
        return store;
      });
    try {
      const firstQueued = createDeferred<void>();
      const secondQueued = createDeferred<void>();
      const event = (id: number, text: string): DaemonEvent => ({
        id,
        v: 1,
        type: 'session_update',
        data: {
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        },
      });
      const session = createMockSession({
        events: async function* spacedEvents(
          opts: { signal?: AbortSignal } = {},
        ) {
          yield event(1, 'first ');
          firstQueued.resolve();
          await new Promise((resolve) => setTimeout(resolve, 5));
          yield event(2, 'second');
          secondQueued.resolve();
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

      await renderWithProvider(null, { autoConnect: true });
      await act(async () => {
        await firstQueued.promise;
        await flushPromises();
        await vi.advanceTimersByTimeAsync(5);
        await secondQueued.promise;
        await flushPromises();
      });
      expect(dispatchBatchSizes).toEqual([]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(11);
        await flushPromises();
      });
      expect(dispatchBatchSizes).toEqual([2]);
    } finally {
      createStoreSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('flushes buffered transcript events on unmount instead of dropping them', async () => {
    // The SSE client advances lastSeenEventId as each event is yielded, before
    // the batched dispatch runs. If teardown dropped the pending buffer, a
    // same-session incremental resume would skip those events. The cleanup must
    // flush, not drop — assert a still-buffered event lands in the store on
    // unmount. Fake timers keep the batched macrotask flush from racing the
    // pre-unmount assertion (otherwise the setTimeout(0) sometimes fires first).
    vi.useFakeTimers();
    try {
      const eventBuffered = createDeferred<void>();
      const session = createMockSession({
        events: async function* oneChunkThenIdle(
          opts: { signal?: AbortSignal } = {},
        ) {
          yield {
            id: 1,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'buffered-chunk' },
              },
            },
          };
          eventBuffered.resolve();
          // Stay alive so the event sits in the pending buffer (no loop-end
          // flush) until the test unmounts the provider.
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
      let store: DaemonTranscriptStore | undefined;
      function Harness() {
        store = useDaemonTranscriptStore();
        return null;
      }

      await renderWithProvider(<Harness />, { autoConnect: true });
      await act(async () => {
        await eventBuffered.promise;
        await flushPromises();
      });

      expect(store).toBeDefined();
      // The macrotask flush has not run (timer not advanced), so the event is
      // still only in the pending buffer.
      expect(
        store?.getSnapshot().blocks.some((block) => block.kind === 'assistant'),
      ).toBe(false);

      await act(async () => {
        root?.unmount();
        root = null;
      });

      // Unmount flushed the buffered event into the store rather than dropping
      // it. flushTranscriptSync runs synchronously, independent of timers.
      const assistant = store
        ?.getSnapshot()
        .blocks.find((block) => block.kind === 'assistant') as
        | { text?: string }
        | undefined;
      expect(assistant?.text ?? '').toContain('buffered-chunk');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an observer assistant burst in one block when a debug event interleaves', async () => {
    // Regression for the batched-dispatch debug guard (ytahdn, PR #7012 review).
    // In observer mode a `debug` event (an unrecognized daemon event)
    // interleaved between two assistant chunks must be filtered so the chunks
    // stay in ONE assistant block. Batching leaves the first chunk in the
    // pending buffer (not yet committed to the store), so the guard must flush
    // before reading `activeAssistantBlockId` — otherwise the debug event is
    // not filtered and splits the assistant block.
    const burstDrained = createDeferred<void>();
    const session = createMockSession({
      events: async function* observerDebugBurst(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'first ' },
            },
          },
        };
        // An unrecognized daemon event normalizes to a `debug` UI event.
        yield {
          id: 2,
          v: 1,
          type: 'mystery_unrecognized_event',
          data: {
            note: 'should be filtered while an assistant block is active',
          },
        };
        yield {
          id: 3,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'second' },
            },
          },
        };
        burstDrained.resolve();
        // Stay alive so the burst rides the batched macrotask flush rather than
        // a synchronous loop-end flush.
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
    let diagnostics: readonly DaemonUnrecognizedDiagnostic[] = [];
    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      diagnostics = useDaemonTranscriptState().unrecognizedDiagnostics;
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await burstDrained.promise;
      await flushPromises();
      await flushTranscriptDispatch();
    });

    // One assistant block with both chunks merged, and no debug block splitting
    // it. Without the flush-before-guard fix this is
    // `[assistant("first "), debug, assistant("second")]`.
    const assistantBlocks = blocks.filter((b) => b.kind === 'assistant');
    expect(assistantBlocks).toHaveLength(1);
    expect((assistantBlocks[0] as { text?: string }).text).toBe('first second');
    expect(blocks.some((b) => b.kind === 'debug')).toBe(false);
    // The narrowed guard (#8823 review) lets `unrecognized_*` debug events
    // through to the reducer: they route onto the sidechannel instead of
    // `blocks[]`, so they cannot split the burst and must not be dropped
    // before dispatch.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({ debugReason: 'unrecognized_event' }),
    );
  });

  it('keeps the burst in one block when a malformed_payload debug event interleaves', async () => {
    // Sibling of the test above for the stimulus that STILL takes the block
    // path: unrecognized_* diagnostics now route to the sidechannel without
    // `clearActiveText`, so they can no longer discriminate the
    // flush-before-guard fix (#7012) — deleting the guard leaves that test
    // green. `malformed_payload` still appends a status block (with
    // `clearActiveText`), so this interleaved frame splits the assistant
    // burst unless the guard flushes first (#8823 review).
    const burstDrained = createDeferred<void>();
    const session = createMockSession({
      events: async function* observerMalformedBurst(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          id: 1,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'first ' },
            },
          },
        };
        // An unusable session_update discriminator normalizes to a `debug`
        // UI event with `debugReason: 'malformed_payload'`.
        yield {
          id: 2,
          v: 1,
          type: 'session_update',
          data: { update: { sessionUpdate: 42 } },
        };
        yield {
          id: 3,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'second' },
            },
          },
        };
        burstDrained.resolve();
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
      await burstDrained.promise;
      await flushPromises();
      await flushTranscriptDispatch();
    });

    const assistantBlocks = blocks.filter((b) => b.kind === 'assistant');
    expect(assistantBlocks).toHaveLength(1);
    expect((assistantBlocks[0] as { text?: string }).text).toBe('first second');
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
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
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

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledTimes(2);
    expect(events.mock.calls[1]?.[0]).toMatchObject({
      sseConnectReason: 'stream_end',
    });
    expect(connection?.error).toBeUndefined();
    expect(blocks).toMatchObject([{ kind: 'assistant', text: 'hello' }]);
  });

  it('requests summary live replay for summary transcript mode', async () => {
    sdkMocks.sessions.push(createMockSession());

    await renderWithProvider(null, {
      autoConnect: true,
      subagentTranscriptMode: 'summary',
    });
    await act(async () => {
      await flushPromises();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ liveReplayMode: 'summary' }),
      expect.any(String),
    );
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
    const sdk = await import('@qwen-code/sdk/daemon');
    const realCreateStore = sdk.createDaemonTranscriptStore;
    const replayDispatchBatchSizes: number[] = [];
    // The first store created is the provider's main store; every later
    // store in this flow is the replay rebuild store (replay now rebuilds
    // under the same maxBlocks cap, so the seed no longer identifies it).
    let createStoreCalls = 0;
    const createStoreSpy = vi
      .spyOn(sdk, 'createDaemonTranscriptStore')
      .mockImplementation((seed) => {
        const store = realCreateStore(seed);
        createStoreCalls += 1;
        if (createStoreCalls > 1) {
          const realDispatch = store.dispatch.bind(store);
          store.dispatch = (event) => {
            replayDispatchBatchSizes.push(
              Array.isArray(event) ? event.length : 1,
            );
            return realDispatch(event);
          };
        }
        return store;
      });
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
    expect(replayDispatchBatchSizes).toEqual([2]);
    createStoreSpy.mockRestore();
  });

  it.each([
    [undefined, false],
    ['future_scope', true],
  ] as const)(
    'uses bounded replay truncation for pagination without hiding scope %s incorrectly',
    async (scope, markerVisible) => {
      sdkMocks.capabilities.mockResolvedValue({
        workspaceCwd: '/mock-workspace',
        features: ['session_transcript_pagination'],
      });
      const session = createMockSession({
        replaySnapshot: {
          compactedReplay: [
            {
              v: 1,
              type: 'history_truncated',
              data: {
                reason: 'replay_window_exceeded',
                ...(scope ? { scope } : {}),
                truncatedEvents: 4,
                retainedEvents: 2,
                maxBytes: 512,
                fullTranscriptAvailable: true,
              },
            },
            {
              id: 5,
              v: 1,
              type: 'session_update',
              data: {
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'retained replay' },
                  _meta: { 'qwen.session.recordId': 'record-retained' },
                },
              },
            },
          ],
          liveJournal: [],
        },
      });
      sdkMocks.sessions.push(session);
      sdkMocks.getSessionTranscriptPage.mockResolvedValue({
        v: 1,
        sessionId: session.sessionId,
        events: [],
        hasMore: false,
      });
      let blocks: readonly DaemonTranscriptBlock[] = [];
      let awaitingResync = false;
      let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;

      function Harness() {
        blocks = useDaemonTranscriptBlocks();
        awaitingResync = useDaemonTranscriptState().awaitingResync;
        history = useDaemonTranscriptHistory();
        return null;
      }

      await renderWithProvider(<Harness />, {
        autoConnect: true,
        reconnectDelayMs: 1,
        maxReconnectDelayMs: 1,
        historyPageSize: 25,
      });
      await act(async () => {
        await flushPromises();
      });

      expect(awaitingResync).toBe(false);
      expect(blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'assistant',
            text: 'retained replay',
          }),
        ]),
      );
      expect(
        blocks.some(
          (block) =>
            block.kind === 'status' && block.source === 'history_truncated',
        ),
      ).toBe(markerVisible);
      expect(history?.hasMore).toBe(true);
      await act(async () => history?.loadMore());
      expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledWith(
        session.sessionId,
        {
          beforeRecordId: 'record-retained',
          limit: 25,
          clientId: session.clientId,
        },
      );
    },
  );

  it('keeps replay-derived pagination state across a same-session reconnect', async () => {
    // Regression coverage: once consumeReplaySnapshot() releases the
    // snapshot, a same-session reconnect (stream-end resubscribe) recomputes
    // the history inputs empty — firstPersistedRecordId degrades to
    // historyAnchorRecordId and replayHistoryWasTruncated to false. The
    // history state the original injection initialized (hasMore /
    // beforeRecordId derived from the replay window) must survive instead of
    // being clobbered with the degraded recomputation, which would make
    // older history unloadable until a page reload.
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const events = vi.fn(async function* endOnceThenIdle(
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
      sessionId: 'session-pagination-reconnect',
      // historyHasMore / historyAnchorRecordId stay at their defaults
      // (false / undefined): pagination state derives solely from the replay
      // window, so a clobbering recomputation would drop both.
      replaySnapshot: {
        compactedReplay: [
          {
            v: 1,
            type: 'history_truncated',
            data: {
              reason: 'replay_window_exceeded',
              truncatedEvents: 4,
              retainedEvents: 2,
              maxBytes: 512,
              fullTranscriptAvailable: true,
            },
          },
          {
            id: 5,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'retained replay' },
                _meta: { 'qwen.session.recordId': 'record-retained' },
              },
            },
          },
        ],
        liveJournal: [],
      },
      events,
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [],
      hasMore: false,
    });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;

    function Harness() {
      history = useDaemonTranscriptHistory();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
      historyPageSize: 25,
    });
    await act(async () => {
      await wait(5);
      await flushPromises();
    });

    // The stream ended once and the provider resubscribed the same session...
    expect(events).toHaveBeenCalledTimes(2);
    expect(events.mock.calls[1]?.[0]).toMatchObject({
      sseConnectReason: 'stream_end',
    });
    // ...and the pagination state initialized by the replay injection
    // survives the reconnect even though the snapshot was consumed.
    expect(history?.hasMore).toBe(true);
    await act(async () => history?.loadMore());
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledWith(
      session.sessionId,
      {
        beforeRecordId: 'record-retained',
        limit: 25,
        clientId: session.clientId,
      },
    );
  });

  it('keeps history-sourced unrecognized diagnostics on the sidechannel when paging (#8823)', async () => {
    // A session recorded by a newer daemon is exactly the forward-compat
    // case the sidechannel exists for: unknown persisted session_update
    // kinds normalize to `unrecognized_session_update` debug events in the
    // throwaway history store, and applyTranscriptHistory must merge them
    // onto the live store instead of dropping them.
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const session = createMockSession({
      replaySnapshot: {
        compactedReplay: [
          {
            v: 1,
            type: 'history_truncated',
            data: {
              reason: 'replay_window_exceeded',
              truncatedEvents: 4,
              retainedEvents: 1,
              maxBytes: 512,
              fullTranscriptAvailable: true,
            },
          },
          {
            id: 5,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'retained tail' },
                _meta: {
                  'qwen.session.recordId': 'record-retained',
                  qwenTranscript: { sourceRecordIds: ['record-retained'] },
                },
              },
            },
          },
        ],
        liveJournal: [],
      },
      events: async function* liveDiagnostics(
        opts: { signal?: AbortSignal } = {},
      ) {
        // LIMIT-2 live events so the post-merge total (live + the two
        // fresh history entries, the overlap deduped away) lands exactly
        // on the cap without newest-wins eviction.
        for (
          let index = 0;
          index < UNRECOGNIZED_DIAGNOSTICS_LIMIT - 2;
          index++
        ) {
          if (index === 0) {
            yield {
              id: 100,
              v: 1,
              type: 'session_update',
              data: {
                update: {
                  sessionUpdate: 'mystery_kind_from_newer_daemon_overlap',
                  // Production replay frames stamp BOTH keys (acp-bridge
                  // buildUpdateMeta); the normalizer's dedupe reads
                  // qwenTranscript.sourceRecordIds.
                  _meta: {
                    'qwen.session.recordId': 'record-overlap',
                    qwenTranscript: { sourceRecordIds: ['record-overlap'] },
                  },
                },
              },
            };
            continue;
          }
          yield {
            id: 100 + index,
            v: 1,
            type: `mystery_live_event_${index}`,
            data: { label: `live-${index}` },
          };
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
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [
        ...[1, 2].map((id) => ({
          id,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: `mystery_kind_from_newer_daemon_${id}`,
              _meta: {
                'qwen.session.recordId': `record-old-${id}`,
                qwenTranscript: { sourceRecordIds: [`record-old-${id}`] },
              },
            },
          },
        })),
        {
          id: 5,
          v: 1,
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'mystery_kind_from_newer_daemon_overlap',
              _meta: {
                'qwen.session.recordId': 'record-overlap',
                qwenTranscript: { sourceRecordIds: ['record-overlap'] },
              },
            },
          },
        },
      ],
      hasMore: false,
    });
    let diagnostics: readonly DaemonUnrecognizedDiagnostic[] = [];
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;

    function Harness() {
      diagnostics = useDaemonTranscriptState().unrecognizedDiagnostics;
      history = useDaemonTranscriptHistory();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
      historyPageSize: 25,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(history?.hasMore).toBe(true);
    await vi.waitFor(() =>
      expect(diagnostics).toHaveLength(UNRECOGNIZED_DIAGNOSTICS_LIMIT - 2),
    );

    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });

    // Merge order: history entries first (older), then the live ones; the
    // page's duplicate of the live overlap record is deduped away, so the
    // two fresh history entries plus the live stream land exactly on the
    // cap.
    expect(diagnostics).toHaveLength(UNRECOGNIZED_DIAGNOSTICS_LIMIT);
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        debugReason: 'unrecognized_session_update',
        sourceRecordIds: ['record-old-1'],
      }),
    );
    expect(diagnostics[1]).toEqual(
      expect.objectContaining({
        debugReason: 'unrecognized_session_update',
        sourceRecordIds: ['record-old-2'],
      }),
    );
    expect(diagnostics[2]).toEqual(
      expect.objectContaining({
        debugReason: 'unrecognized_session_update',
        sourceRecordIds: ['record-overlap'],
      }),
    );
    expect(
      diagnostics.filter((entry) =>
        entry.sourceRecordIds?.includes('record-overlap'),
      ),
    ).toHaveLength(1);
    expect(
      diagnostics.filter((entry) =>
        entry.sourceRecordIds?.includes('record-old-1'),
      ),
    ).toHaveLength(1);
    expect(diagnostics[3]).toEqual(
      expect.objectContaining({ debugReason: 'unrecognized_event' }),
    );
  });

  it('uses history_truncated marker recordId as pagination anchor when session_updates lack one', async () => {
    // Regression coverage: a live-journal truncation during a single long
    // in-flight turn can leave the retained window with no
    // `session_update` carrying a `qwen.session.recordId`. The daemon's
    // compaction engine now stamps the last-seen recordId on the
    // `history_truncated` marker itself; the client must fall back to
    // that anchor so `loadMore()` keeps working instead of rendering the
    // banner with no recovery path.
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const session = createMockSession({
      replaySnapshot: {
        compactedReplay: [],
        liveJournal: [
          {
            v: 1,
            type: 'history_truncated',
            data: {
              reason: 'replay_window_exceeded',
              scope: 'live_journal',
              truncatedEvents: 7602,
              retainedEvents: 10000,
              maxBytes: 8 * 1024 * 1024,
              maxEvents: 10000,
              fullTranscriptAvailable: true,
              recordId: 'record-anchor',
            },
          },
          {
            id: 9001,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'streaming chunk 1' },
              },
            },
          },
          {
            id: 9002,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'streaming chunk 2' },
              },
            },
          },
        ],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [],
      hasMore: false,
    });
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      history = useDaemonTranscriptHistory();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });
    await act(async () => {
      await flushPromises();
    });

    // Live journal loss stays visible even when persisted history can page.
    expect(history?.hasMore).toBe(true);
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'status',
          text: expect.stringContaining('History truncated'),
        }),
      ]),
    );
    await act(async () => history?.loadMore());
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledWith(
      session.sessionId,
      {
        beforeRecordId: 'record-anchor',
        limit: 25,
        clientId: session.clientId,
      },
    );
  });

  it('prefers session_update recordId over marker recordId for pagination anchor', async () => {
    // Critical regression: when the retained window has session_updates
    // carrying an earlier recordId than the marker's stamped anchor, the
    // client must use the session_update's recordId — otherwise
    // `beforeRecordId` re-fetches records already displayed.
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const session = createMockSession({
      replaySnapshot: {
        compactedReplay: [],
        liveJournal: [
          {
            v: 1,
            type: 'history_truncated',
            data: {
              reason: 'replay_window_exceeded',
              scope: 'live_journal',
              truncatedEvents: 100,
              retainedEvents: 3,
              maxBytes: 8 * 1024 * 1024,
              maxEvents: 10000,
              fullTranscriptAvailable: true,
              recordId: 'record-recent',
            },
          },
          {
            id: 9001,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'earlier turn' },
                _meta: { 'qwen.session.recordId': 'record-earlier' },
              },
            },
          },
          {
            id: 9002,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'streaming chunk' },
              },
            },
          },
        ],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [],
      hasMore: false,
    });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;

    function Harness() {
      history = useDaemonTranscriptHistory();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(history?.hasMore).toBe(true);
    await act(async () => history?.loadMore());
    // Uses the session_update's earlier recordId, NOT the marker's.
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledWith(
      session.sessionId,
      {
        beforeRecordId: 'record-earlier',
        limit: 25,
        clientId: session.clientId,
      },
    );
  });

  it('renders bounded replay truncation when no pagination anchor is available', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const session = createMockSession({
      replaySnapshot: {
        compactedReplay: [
          {
            v: 1,
            type: 'history_truncated',
            data: {
              reason: 'replay_window_exceeded',
              truncatedEvents: 4,
              retainedEvents: 1,
              maxBytes: 512,
              fullTranscriptAvailable: true,
            },
          },
          {
            id: 5,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'retained replay' },
              },
            },
          },
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      history = useDaemonTranscriptHistory();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });
    await act(async () => {
      await flushPromises();
    });

    expect(history?.hasMore).toBe(false);
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'status',
          text: expect.stringContaining('History truncated'),
        }),
      ]),
    );
  });

  it('uses daemon historyAnchorRecordId when neither marker nor session_updates carry a recordId', async () => {
    // Regression for the live-session case: an in-flight turn caps the
    // journal before any turn boundary fires, so the retained window has
    // no recordId-bearing session_update AND the marker ships without
    // one (recordId is only stamped during transcript replay, never on
    // the live stream). The daemon backfills `historyAnchorRecordId`
    // from the persisted transcript; the client must use it as the
    // pagination anchor so loadMore keeps working.
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const session = createMockSession({
      historyAnchorRecordId: 'record-daemon-anchor',
      replaySnapshot: {
        compactedReplay: [],
        liveJournal: [
          {
            v: 1,
            type: 'history_truncated',
            data: {
              reason: 'replay_window_exceeded',
              scope: 'live_journal',
              truncatedEvents: 1259,
              retainedEvents: 10000,
              maxBytes: 8 * 1024 * 1024,
              maxEvents: 10000,
              fullTranscriptAvailable: true,
            },
          },
          {
            id: 9001,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'streaming chunk' },
              },
            },
          },
        ],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [],
      hasMore: false,
    });
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      history = useDaemonTranscriptHistory();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });
    await act(async () => {
      await flushPromises();
    });

    // Live journal loss stays visible even when the daemon supplied an anchor.
    expect(history?.hasMore).toBe(true);
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'status',
          text: expect.stringContaining('History truncated'),
        }),
      ]),
    );
    await act(async () => history?.loadMore());
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledWith(
      session.sessionId,
      {
        beforeRecordId: 'record-daemon-anchor',
        limit: 25,
        clientId: session.clientId,
      },
    );
  });

  it.each([
    ['complete', 'turn_complete', 'end_turn'],
    ['cancelled', 'turn_complete', 'cancelled'],
    ['error', 'turn_error', undefined],
  ] as const)(
    'repairs a truncated live turn after a matching %s terminal',
    async (_label, terminalType, stopReason) => {
      clearSidechannelMidTurnInjected();
      sdkMocks.capabilities.mockResolvedValue({
        workspaceCwd: '/mock-workspace',
        features: ['session_transcript_pagination'],
      });
      const terminalGate = createDeferred<void>();
      const localPromptAcceptance = createDeferred<NonBlockingPromptAccepted>();
      const terminalEvent: DaemonEvent = {
        id: 11,
        v: 1,
        type: terminalType,
        promptId: 'prompt-live',
        data:
          terminalType === 'turn_complete'
            ? { promptId: 'prompt-live', stopReason }
            : { promptId: 'prompt-live', message: 'model failed' },
      };
      const observedMidTurnEvent: DaemonEvent = {
        id: 10,
        v: 1,
        type: 'mid_turn_message_injected',
        promptId: 'prompt-live',
        originatorClientId: 'client-live',
        data: {
          sessionId: 'session-live-repair',
          messages: ['observed queued message'],
          messageIds: ['observed-message'],
        },
      };
      const followupUserEvent: DaemonEvent = {
        id: 12,
        v: 1,
        type: 'session_update',
        promptId: 'prompt-next',
        data: {
          update: {
            sessionUpdate: 'user_message_chunk',
            content: {
              type: 'text',
              text: 'follow-up created during reload',
            },
          },
        },
      };
      const metadataEvent: DaemonEvent = {
        id: 13,
        v: 1,
        type: 'session_metadata_updated',
        promptId: 'prompt-next',
        data: {
          sessionId: 'session-live-repair',
          displayName: 'Updated during repair',
        },
      };
      const prefix: DaemonEvent[] = [
        {
          id: 1,
          v: 1,
          type: 'session_update',
          promptId: 'prompt-old',
          data: {
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'older prompt' },
              _meta: { 'qwen.session.recordId': 'record-old' },
            },
          },
        },
        {
          id: 2,
          v: 1,
          type: 'session_update',
          promptId: 'prompt-old',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'older answer' },
            },
          },
        },
        {
          id: 3,
          v: 1,
          type: 'turn_complete',
          promptId: 'prompt-old',
          data: { promptId: 'prompt-old', stopReason: 'end_turn' },
        },
      ];
      const initialSession = createMockSession({
        sessionId: 'session-live-repair',
        hasActivePrompt: true,
        historyHasMore: true,
        lastEventId: 9,
        replaySnapshot: {
          compactedReplay: prefix,
          liveJournal: [
            {
              v: 1,
              type: 'history_truncated',
              promptId: 'prompt-live',
              data: {
                reason: 'replay_window_exceeded',
                scope: 'live_journal',
                truncatedEvents: 8,
                retainedEvents: 1,
                maxBytes: 1024,
                maxEvents: 1,
                fullTranscriptAvailable: true,
                recordId: 'record-old',
              },
            },
            {
              id: 8,
              v: 1,
              type: 'memory_changed',
              promptId: 'prompt-live',
              data: {
                scope: 'workspace',
                filePath: '/mock-workspace/QWEN.md',
                mode: 'append',
                bytesWritten: 12,
              },
            },
            {
              id: 9,
              v: 1,
              type: 'session_update',
              promptId: 'prompt-live',
              data: {
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'partial tail' },
                },
              },
            },
          ],
        },
        events: async function* terminalEvents(
          options: { signal?: AbortSignal } = {},
        ) {
          await Promise.race([
            terminalGate.promise,
            new Promise<void>((resolve) =>
              options.signal?.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            ),
          ]);
          if (options.signal?.aborted) return;
          yield observedMidTurnEvent;
          yield terminalEvent;
          await new Promise<void>((resolve) =>
            options.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
        },
        submitPrompt: vi.fn(() => localPromptAcceptance.promise),
        supportedCommands: vi.fn(async () => {
          throw new Error('commands unavailable');
        }),
      });
      const targetTurn: DaemonEvent[] = [
        {
          id: 4,
          v: 1,
          type: 'session_update',
          promptId: 'prompt-live',
          data: {
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'long prompt' },
            },
          },
        },
        {
          id: 5,
          v: 1,
          type: 'session_update',
          promptId: 'prompt-live',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `complete ${_label} answer` },
            },
          },
        },
        {
          id: 6,
          v: 1,
          type: 'mid_turn_message_injected',
          promptId: 'prompt-live',
          originatorClientId: 'client-live',
          data: {
            sessionId: 'session-live-repair',
            messages: ['evicted queued message'],
            messageIds: ['evicted-message'],
          },
        },
        {
          id: 8,
          v: 1,
          type: 'memory_changed',
          promptId: 'prompt-live',
          data: {
            scope: 'workspace',
            filePath: '/mock-workspace/QWEN.md',
            mode: 'append',
            bytesWritten: 12,
          },
        },
        observedMidTurnEvent,
        terminalEvent,
      ];
      const repairedSession = createMockSession({
        sessionId: 'session-live-repair',
        hasActivePrompt: true,
        lastEventId: 13,
        replaySnapshot: {
          compactedReplay: [...prefix, ...targetTurn],
          liveJournal: [followupUserEvent, metadataEvent],
        },
        supportedCommands: vi.fn(async () => {
          throw new Error('commands unavailable');
        }),
      });
      sdkMocks.sessions.push(initialSession, repairedSession);
      const historyPageGate = createDeferred<unknown>();
      const historyPage = {
        v: 1,
        sessionId: initialSession.sessionId,
        events: [
          {
            id: 0,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-earliest',
            data: {
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'earliest loaded prompt' },
                _meta: { 'qwen.session.recordId': 'record-earliest' },
              },
            },
          },
        ],
        hasMore: true,
      };
      sdkMocks.getSessionTranscriptPage.mockReturnValue(
        historyPageGate.promise,
      );
      let blocks: readonly DaemonTranscriptBlock[] = [];
      let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
      let signals: DaemonWorkspaceEventSignals | undefined;
      let connection: DaemonConnectionState | undefined;
      let actions: DaemonSessionActions | undefined;
      const settlements: DaemonPromptSettledEvent[] = [];

      function Harness() {
        blocks = useDaemonTranscriptBlocks();
        history = useDaemonTranscriptHistory();
        signals = useDaemonWorkspaceEventSignals();
        connection = useDaemonConnection();
        actions = useDaemonActions();
        useDaemonPromptSettled((event) => settlements.push(event));
        return null;
      }

      await renderWithProvider(<Harness />, {
        autoConnect: true,
        historyPageSize: 25,
        loadWarnings: { commands: 'Commands are temporarily unavailable.' },
      });
      await act(async () => flushPromises());
      expect(blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'status',
            source: 'history_truncated',
          }),
        ]),
      );
      const prefixBlockId = blocks.find(
        (block) => block.kind === 'user' && block.text === 'older prompt',
      )?.id;
      let historyLoad: Promise<void> | undefined;
      await act(async () => {
        historyLoad = history?.loadMore();
        await flushPromises();
      });
      expect(historyLoad).toBeDefined();
      expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledOnce();

      await act(async () => {
        terminalGate.resolve();
        await flushPromises();
      });
      expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
      expect(settlements).toEqual([]);
      let localPrompt: Promise<unknown> | undefined;
      if (_label === 'complete') {
        await act(async () => {
          localPrompt = requireActions(actions).sendPrompt(
            'next local prompt',
            { optimisticUserMessage: false },
          );
          await vi.waitFor(() =>
            expect(initialSession.submitPrompt).toHaveBeenCalledOnce(),
          );
        });
      }

      await act(async () => {
        historyPageGate.resolve(historyPage);
        await historyLoad;
        await flushPromises();
      });
      const loadedHistoryBlockId = blocks.find(
        (block) =>
          block.kind === 'user' && block.text === 'earliest loaded prompt',
      )?.id;
      expect(loadedHistoryBlockId).toBeDefined();
      if (_label === 'complete') {
        expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
        await act(async () => {
          localPromptAcceptance.reject(new Error('next prompt rejected'));
          await expect(localPrompt).rejects.toThrow('next prompt rejected');
          await flushPromises();
        });
      }

      await act(async () => {
        await vi.waitFor(() =>
          expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(
            2,
          ),
        );
        await vi.waitFor(() =>
          expect(JSON.stringify(blocks)).toContain(`complete ${_label} answer`),
        );
        await flushPromises();
      });

      expect(
        blocks.find(
          (block) => block.kind === 'user' && block.text === 'older prompt',
        )?.id,
      ).toBe(prefixBlockId);
      expect(
        blocks.find(
          (block) =>
            block.kind === 'user' && block.text === 'earliest loaded prompt',
        )?.id,
      ).toBe(loadedHistoryBlockId);
      expect(history?.hasMore).toBe(true);
      expect(signals?.memoryVersion).toBe(1);
      expect(connection?.displayName).toBe('Updated during repair');
      expect(JSON.stringify(blocks)).not.toContain('partial tail');
      expect(JSON.stringify(blocks)).toContain(
        'follow-up created during reload',
      );
      expect(
        blocks.filter(
          (block) =>
            block.kind === 'assistant' &&
            block.text === `complete ${_label} answer`,
        ),
      ).toHaveLength(1);
      expect(blocks).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'history_truncated' }),
        ]),
      );
      expect(
        blocks.filter(
          (block) =>
            block.kind === 'status' &&
            block.text === 'Commands are temporarily unavailable.',
        ),
      ).toHaveLength(1);
      expect(
        sdkMocks.MockDaemonSessionClient.load.mock.calls[1]?.[2],
      ).not.toHaveProperty('historyPageSize');
      expect(settlements).toEqual([
        expect.objectContaining({
          sessionId: 'session-live-repair',
          promptId: 'prompt-live',
          outcome:
            _label === 'cancelled'
              ? 'cancelled'
              : _label === 'error'
                ? 'failed'
                : 'completed',
          transcriptComplete: true,
        }),
      ]);
      expect(initialSession.prompt).not.toHaveBeenCalled();
      expect(repairedSession.prompt).not.toHaveBeenCalled();
      const midTurnInjected = getSidechannelMidTurnInjected();
      clearSidechannelMidTurnInjected();
      expect(midTurnInjected).toEqual([
        {
          sessionId: 'session-live-repair',
          messages: ['observed queued message'],
          messageIds: ['observed-message'],
          originatorClientId: 'client-live',
        },
        {
          sessionId: 'session-live-repair',
          messages: ['evicted queued message'],
          messageIds: ['evicted-message'],
          originatorClientId: 'client-live',
        },
      ]);
    },
  );

  it('publishes an incomplete settlement before clearing an in-flight repair', async () => {
    const terminalGate = createDeferred<void>();
    const repairLoad = createDeferred<MockSession>();
    const initialSession = createMockSession({
      sessionId: 'session-live-repair-clear',
      hasActivePrompt: true,
      lastEventId: 9,
      replaySnapshot: {
        compactedReplay: [],
        liveJournal: [
          {
            id: 8,
            v: 1,
            type: 'history_truncated',
            promptId: 'prompt-live',
            data: {
              reason: 'replay_window_exceeded',
              scope: 'live_journal',
              truncatedEvents: 8,
              retainedEvents: 1,
              maxBytes: 1024,
              maxEvents: 1,
              fullTranscriptAvailable: true,
            },
          },
          {
            id: 9,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-live',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'partial tail' },
              },
            },
          },
        ],
      },
      events: async function* terminalEvents(
        options: { signal?: AbortSignal } = {},
      ) {
        await terminalGate.promise;
        if (options.signal?.aborted) return;
        yield {
          id: 10,
          v: 1,
          type: 'turn_complete',
          promptId: 'prompt-live',
          data: { promptId: 'prompt-live', stopReason: 'end_turn' },
        } satisfies DaemonEvent;
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
      },
    });
    const repairedSession = createMockSession({
      sessionId: initialSession.sessionId,
    });
    sdkMocks.sessions.push(initialSession);

    let actions: DaemonSessionActions | undefined;
    const settlements: DaemonPromptSettledEvent[] = [];
    function Harness() {
      actions = useDaemonActions();
      useDaemonPromptSettled((event) => settlements.push(event));
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    sdkMocks.MockDaemonSessionClient.load.mockImplementationOnce(
      async (client: unknown): Promise<MockSession> => {
        const repaired = await repairLoad.promise;
        repaired.client = client as MockClient;
        return repaired;
      },
    );
    await act(async () => {
      terminalGate.resolve();
      await flushPromises();
    });
    expect(settlements).toEqual([]);

    let clearPromise: Promise<void> | undefined;
    await act(async () => {
      clearPromise = requireActions(actions).clearSession();
      await flushPromises();
    });
    expect(settlements).toEqual([
      expect.objectContaining({
        sessionId: initialSession.sessionId,
        promptId: 'prompt-live',
        outcome: 'completed',
        transcriptComplete: false,
      }),
    ]);

    await act(async () => {
      repairLoad.resolve(repairedSession);
      await clearPromise;
      await flushPromises();
    });
  });

  it('publishes an incomplete settlement before replacing a repair episode', async () => {
    const terminalGate = createDeferred<void>();
    const repairLoad = createDeferred<MockSession>();
    const terminalEvent: DaemonEvent = {
      id: 10,
      v: 1,
      type: 'turn_complete',
      promptId: 'prompt-first',
      data: { promptId: 'prompt-first', stopReason: 'end_turn' },
    };
    const initialSession = createMockSession({
      sessionId: 'session-live-repair-replaced',
      hasActivePrompt: true,
      lastEventId: 9,
      replaySnapshot: {
        compactedReplay: [],
        liveJournal: [
          {
            id: 8,
            v: 1,
            type: 'history_truncated',
            promptId: 'prompt-first',
            data: {
              reason: 'replay_window_exceeded',
              scope: 'live_journal',
              truncatedEvents: 8,
              retainedEvents: 1,
              maxBytes: 1024,
              maxEvents: 1,
              fullTranscriptAvailable: true,
            },
          },
          {
            id: 9,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-first',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'partial first answer' },
              },
            },
          },
        ],
      },
      events: async function* terminalEvents(
        options: { signal?: AbortSignal } = {},
      ) {
        await terminalGate.promise;
        if (options.signal?.aborted) return;
        yield terminalEvent;
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
      },
    });
    const replacementSession = createMockSession({
      sessionId: initialSession.sessionId,
      hasActivePrompt: true,
      lastEventId: 13,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 1,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-first',
            data: {
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'first prompt' },
              },
            },
          },
          {
            id: 2,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-first',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'complete first answer' },
              },
            },
          },
          terminalEvent,
          {
            id: 11,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-second',
            data: {
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'second prompt' },
              },
            },
          },
        ],
        liveJournal: [
          {
            id: 12,
            v: 1,
            type: 'history_truncated',
            promptId: 'prompt-second',
            data: {
              reason: 'replay_window_exceeded',
              scope: 'live_journal',
              truncatedEvents: 12,
              retainedEvents: 1,
              maxBytes: 1024,
              maxEvents: 1,
              fullTranscriptAvailable: true,
            },
          },
          {
            id: 13,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-second',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'partial second answer' },
              },
            },
          },
        ],
      },
    });
    sdkMocks.sessions.push(initialSession);

    const settlements: DaemonPromptSettledEvent[] = [];
    function Harness() {
      useDaemonPromptSettled((event) => settlements.push(event));
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    sdkMocks.MockDaemonSessionClient.load.mockImplementationOnce(
      async (client: unknown): Promise<MockSession> => {
        const replacement = await repairLoad.promise;
        replacement.client = client as MockClient;
        return replacement;
      },
    );
    await act(async () => {
      terminalGate.resolve();
      await flushPromises();
    });
    expect(settlements).toEqual([]);

    await act(async () => {
      repairLoad.resolve(replacementSession);
      await vi.waitFor(() => expect(settlements).toHaveLength(1));
      await flushPromises();
    });
    expect(settlements).toEqual([
      expect.objectContaining({
        sessionId: initialSession.sessionId,
        promptId: 'prompt-first',
        outcome: 'completed',
        transcriptComplete: false,
      }),
    ]);
  });

  it('does not repair a live marker for a non-matching queued terminal', async () => {
    const terminalGate = createDeferred<void>();
    const session = createMockSession({
      sessionId: 'session-live-mismatch',
      hasActivePrompt: true,
      lastEventId: 5,
      replaySnapshot: {
        compactedReplay: [],
        liveJournal: [
          {
            v: 1,
            type: 'history_truncated',
            promptId: 'prompt-live',
            data: {
              reason: 'replay_window_exceeded',
              scope: 'live_journal',
              truncatedEvents: 2,
              retainedEvents: 1,
              maxBytes: 512,
              maxEvents: 1,
              fullTranscriptAvailable: true,
            },
          },
          {
            id: 5,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-live',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'retained tail' },
              },
            },
          },
        ],
      },
      events: async function* mismatchedTerminal(
        options: { signal?: AbortSignal } = {},
      ) {
        await terminalGate.promise;
        yield {
          id: 6,
          v: 1,
          type: 'turn_complete',
          promptId: 'prompt-queued',
          data: { promptId: 'prompt-queued', stopReason: 'end_turn' },
        } satisfies DaemonEvent;
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
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
      terminalGate.resolve();
      await flushPromises();
      await flushTranscriptDispatch();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
    expect(blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'history_truncated' }),
      ]),
    );
  });

  it('uses a bounded full-snapshot fallback after the marker block is trimmed', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    sdkMocks.getSessionTranscriptPage
      .mockResolvedValueOnce({
        v: 1,
        sessionId: 'session-live-trimmed-marker',
        events: [],
        nextCursor: 'stale-cursor',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        v: 1,
        sessionId: 'session-live-trimmed-marker',
        events: [],
        hasMore: false,
      });
    const toolGate = createDeferred<void>();
    const terminalGate = createDeferred<void>();
    const toolEvent: DaemonEvent = {
      id: 6,
      v: 1,
      type: 'session_update',
      promptId: 'prompt-live',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-live',
          title: 'long tool',
          status: 'running',
        },
      },
    };
    const secondToolEvent: DaemonEvent = {
      id: 7,
      v: 1,
      type: 'session_update',
      promptId: 'prompt-live',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'call-live-2',
          title: 'another long tool',
          status: 'running',
        },
      },
    };
    const terminalEvent: DaemonEvent = {
      id: 8,
      v: 1,
      type: 'turn_complete',
      promptId: 'prompt-live',
      data: { promptId: 'prompt-live', stopReason: 'end_turn' },
    };
    const initialSession = createMockSession({
      sessionId: 'session-live-trimmed-marker',
      hasActivePrompt: true,
      lastEventId: 5,
      replaySnapshot: {
        compactedReplay: [],
        liveJournal: [
          {
            v: 1,
            type: 'history_truncated',
            promptId: 'prompt-live',
            data: {
              reason: 'replay_window_exceeded',
              scope: 'live_journal',
              truncatedEvents: 4,
              retainedEvents: 1,
              maxBytes: 512,
              maxEvents: 1,
              fullTranscriptAvailable: true,
              recordId: 'record-stale-anchor',
            },
          },
          {
            id: 5,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-live',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'partial tail' },
              },
            },
          },
        ],
      },
      events: async function* trimMarkerThenFinish(
        options: { signal?: AbortSignal } = {},
      ) {
        await toolGate.promise;
        if (options.signal?.aborted) return;
        yield toolEvent;
        yield secondToolEvent;
        await terminalGate.promise;
        if (options.signal?.aborted) return;
        yield terminalEvent;
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
      },
    });
    const repairedSession = createMockSession({
      sessionId: initialSession.sessionId,
      lastEventId: 8,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 1,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-live',
            data: {
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'complete prompt' },
                _meta: { 'qwen.session.recordId': 'record-fresh-anchor' },
              },
            },
          },
          toolEvent,
          secondToolEvent,
          {
            id: 2,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-live',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'complete bounded answer' },
              },
            },
          },
          terminalEvent,
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(initialSession, repairedSession);
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      history = useDaemonTranscriptHistory();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      maxBlocks: 3,
    });
    await act(async () => {
      await vi.waitFor(() => expect(history?.hasMore).toBe(true));
      await history?.loadMore();
    });
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenNthCalledWith(
      1,
      initialSession.sessionId,
      {
        beforeRecordId: 'record-stale-anchor',
        limit: 100,
        clientId: initialSession.clientId,
      },
    );
    await act(async () => {
      toolGate.resolve();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          blocks.some(
            (block) =>
              'source' in block && block.source === 'history_truncated',
          ),
        ).toBe(false),
      );
    });
    await act(async () => {
      terminalGate.resolve();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(2),
      );
      await vi.waitFor(() =>
        expect(JSON.stringify(blocks)).toContain('complete bounded answer'),
      );
    });

    expect(blocks.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(blocks)).not.toContain('partial tail');
    // R11-12: the bounded rebuild evicts the fresh snapshot's anchor record
    // (record-fresh-anchor), and no retained block carries a recordId, so the
    // re-anchor is uncomputable. Anchoring to the evicted record would leave
    // it silently unreachable (exclusive-before never returns the anchor), so
    // the affordance fails closed instead of paging from a stale anchor.
    expect(history?.hasMore).toBe(false);
    expect(history?.capacityReached).toBe(true);
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledTimes(1);
  });

  it.each([
    'missing input',
    'missing terminal',
    'degraded',
    'network error',
    'auth error',
    'missing session',
    'server error',
  ] as const)(
    'keeps the retained transcript and reports one repair failure for %s',
    async (invalidCase) => {
      const terminalGate = createDeferred<void>();
      let streamAttempt = 0;
      const terminalEvent: DaemonEvent = {
        id: 6,
        v: 1,
        type: 'turn_complete',
        promptId: 'prompt-live',
        data: { promptId: 'prompt-live', stopReason: 'end_turn' },
      };
      const session = createMockSession({
        sessionId: 'session-live-invalid-repair',
        hasActivePrompt: true,
        lastEventId: 5,
        replaySnapshot: {
          compactedReplay: [],
          liveJournal: [
            {
              v: 1,
              type: 'history_truncated',
              promptId: 'prompt-live',
              data: {
                reason: 'replay_window_exceeded',
                scope: 'live_journal',
                truncatedEvents: 2,
                retainedEvents: 1,
                maxBytes: 512,
                maxEvents: 1,
                fullTranscriptAvailable: true,
              },
            },
            {
              id: 5,
              v: 1,
              type: 'session_update',
              promptId: 'prompt-live',
              data: {
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'retained tail' },
                },
              },
            },
          ],
        },
        events: async function* matchingTerminal(
          options: { signal?: AbortSignal } = {},
        ) {
          streamAttempt += 1;
          if (streamAttempt > 1) {
            yield {
              id: 7,
              v: 1,
              type: 'session_update',
              promptId: 'prompt-live',
              data: {
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'old SSE resumed' },
                },
              },
            } satisfies DaemonEvent;
            await new Promise<void>((resolve) =>
              options.signal?.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
            return;
          }
          await terminalGate.promise;
          if (options.signal?.aborted) return;
          yield terminalEvent;
          await new Promise<void>((resolve) =>
            options.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
        },
      });
      const freshUserEvent: DaemonEvent = {
        id: 4,
        v: 1,
        type: 'session_update',
        promptId: 'prompt-live',
        data: {
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'complete prompt' },
          },
        },
      };
      const invalidFreshSession = createMockSession({
        sessionId: session.sessionId,
        lastEventId: 6,
        replayDegraded: invalidCase === 'degraded',
        replaySnapshot: {
          compactedReplay:
            invalidCase === 'missing input'
              ? [terminalEvent]
              : invalidCase === 'missing terminal'
                ? [freshUserEvent]
                : [freshUserEvent, terminalEvent],
          liveJournal: [],
        },
      });
      sdkMocks.sessions.push(session, invalidFreshSession);
      let blocks: readonly DaemonTranscriptBlock[] = [];
      let notices: readonly DaemonSessionNotice[] = [];
      let connection: DaemonConnectionState | undefined;
      const settlements: DaemonPromptSettledEvent[] = [];

      function Harness() {
        blocks = useDaemonTranscriptBlocks();
        notices = useDaemonSessionNotices().notices;
        connection = useDaemonConnection();
        useDaemonPromptSettled((event) => settlements.push(event));
        return null;
      }

      await renderWithProvider(<Harness />, { autoConnect: true });
      if (invalidCase === 'network error') {
        sdkMocks.MockDaemonSessionClient.load.mockRejectedValueOnce(
          new Error('repair load unavailable'),
        );
      } else if (invalidCase === 'auth error') {
        sdkMocks.MockDaemonSessionClient.load.mockRejectedValueOnce(
          new DaemonHttpError(401, undefined, 'Unauthorized'),
        );
      } else if (invalidCase === 'missing session') {
        sdkMocks.MockDaemonSessionClient.load.mockRejectedValueOnce(
          new DaemonHttpError(404, undefined, 'Session not found'),
        );
      } else if (invalidCase === 'server error') {
        sdkMocks.MockDaemonSessionClient.load.mockRejectedValueOnce(
          new DaemonHttpError(500, undefined, 'Server unavailable'),
        );
      }
      await act(async () => {
        terminalGate.resolve();
      });
      await act(async () => {
        await vi.waitFor(() =>
          expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(
            2,
          ),
        );
        await vi.waitFor(() =>
          expect(
            notices.some(
              (notice) => notice.code === 'daemon.live_journal_repair.failed',
            ),
          ).toBe(true),
        );
        if (invalidCase !== 'auth error' && invalidCase !== 'missing session') {
          await vi.waitFor(() =>
            expect(JSON.stringify(blocks)).toContain('old SSE resumed'),
          );
        }
      });

      expect(JSON.stringify(blocks)).toContain('retained tail');
      expect(
        notices.filter(
          (notice) => notice.code === 'daemon.live_journal_repair.failed',
        ),
      ).toHaveLength(1);
      expect(settlements).toEqual([
        expect.objectContaining({
          sessionId: 'session-live-invalid-repair',
          promptId: 'prompt-live',
          outcome: 'completed',
          transcriptComplete: false,
        }),
      ]);
      if (
        invalidCase === 'network error' ||
        invalidCase === 'auth error' ||
        invalidCase === 'missing session' ||
        invalidCase === 'server error'
      ) {
        expect(invalidFreshSession.detach).not.toHaveBeenCalled();
      } else {
        expect(invalidFreshSession.detach).toHaveBeenCalledOnce();
      }
      if (invalidCase === 'auth error') {
        expect(connection).toMatchObject({
          status: 'error',
          sessionId: undefined,
          missingSession: false,
        });
      } else if (invalidCase === 'missing session') {
        expect(connection).toMatchObject({
          status: 'disconnected',
          sessionId: undefined,
          missingSession: true,
        });
      }
    },
  );

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

  it('attaches a live branch point only to its restored prompt response', async () => {
    const turnCompleted = createDeferred<void>();
    const session = createMockSession({
      hasActivePrompt: true,
      lastEventId: 5,
      events: async function* restoredPromptThenBranchPoint() {
        yield {
          id: 6,
          v: 1,
          type: 'session_update',
          promptId: 'restored-prompt',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'completed answer' },
            },
          },
        };
        yield {
          id: 7,
          v: 1,
          type: 'turn_complete',
          promptId: 'restored-prompt',
          data: {
            promptId: 'restored-prompt',
            stopReason: 'end_turn',
            branchPoint: {
              assistantRecordUuid: 'a1b2c3d4-e5f6-1a2b-8c3d-4e5f6a7b8c9d',
              checkpointUuid: 'f9e8d7c6-b5a4-1f2e-9a3b-4c5d6e7f8a9b',
            },
          },
        };
        turnCompleted.resolve();
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
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await turnCompleted.promise;
      await flushPromises();
    });

    expect(blocks).toMatchObject([
      {
        kind: 'assistant',
        text: 'completed answer',
        promptId: 'restored-prompt',
        sourceRecordIds: ['a1b2c3d4-e5f6-1a2b-8c3d-4e5f6a7b8c9d'],
        branchRecordId: 'f9e8d7c6-b5a4-1f2e-9a3b-4c5d6e7f8a9b',
        streaming: false,
      },
    ]);
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
      { workspaceCwd: '/mock-workspace', timeoutMs: 70_000 },
      expect.any(String),
    );
    expect(promptStatus).toBe('streaming');
  });

  it('reloads standalone sessions through the standalone route after resync', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
    });
    const reloaded = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'standalone-resync',
      workspaceCwd: '/private/standalone-resync',
      session: {
        sessionId: 'standalone-resync',
        workspaceCwd: '/private/standalone-resync',
        sourceType: 'standalone',
        context: { kind: 'standalone' },
        projectlessOutputDirectory: '/output/standalone-resync',
        workingDirectory: { state: 'ready' },
      },
      events: async function* standaloneEpochReset() {
        yield {
          id: 6,
          v: 1,
          type: 'state_resync_required',
          data: { reason: 'epoch_reset' },
        } satisfies DaemonEvent;
      },
    });
    const reloadedSession = createMockSession({
      sessionId: 'standalone-resync',
      workspaceCwd: '/private/standalone-resync',
      session: {
        sessionId: 'standalone-resync',
        workspaceCwd: '/private/standalone-resync',
        sourceType: 'standalone',
        context: { kind: 'standalone' },
        projectlessOutputDirectory: '/output/standalone-resync',
        workingDirectory: { state: 'ready' },
      },
      events: createPendingEvents(reloaded),
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'standalone-resync',
      sessionContext: { kind: 'standalone' },
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      await reloaded.promise;
      await flushPromises();
    });

    expect(
      sdkMocks.MockDaemonSessionClient.loadStandalone,
    ).toHaveBeenCalledTimes(2);
    expect(
      sdkMocks.MockDaemonSessionClient.loadStandalone,
    ).toHaveBeenLastCalledWith(
      expect.anything(),
      'standalone-resync',
      { timeoutMs: 70_000 },
      expect.any(String),
    );
    expect(sdkMocks.MockDaemonSessionClient.load).not.toHaveBeenCalled();
    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'standalone-resync',
      sessionContext: { kind: 'standalone' },
      workspaceCwd: undefined,
      standaloneSession: {
        workingDirectory: { state: 'ready' },
      },
    });
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
    expect(events.mock.calls[1]?.[0]).toMatchObject({
      sseConnectReason: 'transport_error',
    });
    expect(promptStatus).not.toBe('idle');
  });

  it('keeps restored active prompts streaming after resync requests', async () => {
    const resyncSeen = createDeferred<void>();
    const reloaded = createDeferred<void>();
    const reloadedEvents = vi.fn(createPendingEvents(reloaded));
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
      events: reloadedEvents,
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
    expect(reloadedEvents.mock.calls[0]?.[0]).toMatchObject({
      sseConnectReason: 'state_resync',
    });
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
        // Advance through the transcript batching window so the passive
        // assistant chunk lands before asserting.
        await vi.advanceTimersByTimeAsync(20);
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

  it('ignores streamed events from a replaced same-id attachment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const streamStarted = createDeferred<void>();
    const releaseOldEvent = createDeferred<void>();
    const source = createMockSession({
      sessionId: 'session-a',
      clientId: 'client-a',
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
    const target = createMockSession({
      sessionId: 'session-a',
      clientId: 'client-b',
      replaySnapshot: createTextReplaySnapshot('replacement transcript'),
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(source, target);
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
      clientId: 'client-a',
    });
    await act(async () => {
      await streamStarted.promise;
      await flushPromises();
    });

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={true}
          sessionId="session-a"
          clientId="client-b"
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({
      sessionId: 'session-a',
      clientId: 'client-b',
    });
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'replacement transcript' },
    ]);

    releaseOldEvent.resolve();
    await act(async () => {
      await flushPromises();
      await flushTranscriptDispatch();
    });

    expect(JSON.stringify(blocks)).not.toContain('stale output');
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'replacement transcript' },
    ]);
  });

  it('ignores session_closed from a replaced same-id attachment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const streamStarted = createDeferred<void>();
    const releaseOldEvent = createDeferred<void>();
    const source = createMockSession({
      sessionId: 'session-a',
      clientId: 'client-a',
      events: async function* staleEvents() {
        streamStarted.resolve();
        await releaseOldEvent.promise;
        yield {
          id: 1,
          v: 1,
          type: 'session_closed',
          sessionId: 'session-a',
          data: { reason: 'client_close' },
        };
      },
    });
    const target = createMockSession({
      sessionId: 'session-a',
      clientId: 'client-b',
      replaySnapshot: createTextReplaySnapshot('replacement transcript'),
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(source, target);
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
      clientId: 'client-a',
    });
    await act(async () => {
      await streamStarted.promise;
      await flushPromises();
    });

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={true}
          sessionId="session-a"
          clientId="client-b"
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });

    releaseOldEvent.resolve();
    await act(async () => {
      await flushPromises();
    });

    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'session-a',
      clientId: 'client-b',
    });
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'replacement transcript' },
    ]);
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

  it('hydrates Goal state without waiting for session metadata after a switch', async () => {
    sdkMocks.sessions.push(createMockSession({ sessionId: 'session-a' }));
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

    const providers = createDeferred<unknown>();
    const commands =
      createDeferred<Awaited<ReturnType<MockSession['supportedCommands']>>>();
    const context =
      createDeferred<Awaited<ReturnType<MockSession['context']>>>();
    sdkMocks.workspaceProviders.mockReturnValueOnce(providers.promise);
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'session-b',
        supportedCommands: vi.fn(() => commands.promise),
        context: vi.fn(() => context.promise),
      }),
    );

    let loadSession: Promise<void> | undefined;
    act(() => {
      loadSession = requireActions(actions).loadSession('session-b');
    });
    await act(async () => {
      await wait(5);
      await loadSession;
      await flushPromises();
    });
    const goalStateBeforeMetadata = connection?.goalState;

    providers.resolve({
      v: 1,
      workspaceCwd: '/mock-workspace',
      initialized: true,
      providers: [],
    });
    commands.resolve({
      v: 1,
      sessionId: 'session-b',
      availableCommands: [],
      availableSkills: [],
    });
    context.resolve({
      v: 1,
      sessionId: 'session-b',
      workspaceCwd: '/mock-workspace',
      state: {},
    });
    await act(async () => {
      await flushPromises();
    });

    expect(goalStateBeforeMetadata).toEqual({
      v: 2,
      goal: null,
      activity: 'idle',
    });
    expect(connection?.goalState).toEqual({
      v: 2,
      goal: null,
      activity: 'idle',
    });
  });

  it('preserves hydrated Goal state when the event stream starts', async () => {
    sdkMocks.sessions.push(createMockSession({ sessionId: 'session-a' }));
    const goal = createDeferred<GoalStateResponse>();
    const eventApplied = createDeferred<void>();
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'session-b',
        goal: vi.fn(() => goal.promise),
        events: async function* events(opts = {}) {
          yield {
            v: 1,
            type: 'git_branch_changed',
            data: { branch: 'feature' },
          };
          eventApplied.resolve();
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

    act(() => {
      void requireActions(actions).loadSession('session-b');
    });
    await act(async () => {
      await flushPromises();
    });
    expect(connection?.goalState).toBeUndefined();

    await act(async () => {
      goal.resolve({
        snapshot: { v: 2, goal: null, activity: 'idle' },
      });
      await eventApplied.promise;
      await flushPromises();
    });

    expect(connection).toMatchObject({
      sessionId: 'session-b',
      gitBranch: 'feature',
      goalState: { v: 2, goal: null, activity: 'idle' },
    });
  });

  it('retries a session switch while the target session is closing', async () => {
    const firstSession = createMockSession({ sessionId: 'session-a' });
    const secondSession = createMockSession({ sessionId: 'session-b' });
    sdkMocks.sessions.push(firstSession);
    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;
    let notices: readonly DaemonSessionNotice[] = [];

    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      notices = useDaemonSessionNotices().notices;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
      historyPageSize: 100,
      reconnectDelayMs: 10,
      maxReconnectDelayMs: 100,
    });
    await act(async () => {
      await flushPromises();
    });
    sdkMocks.MockDaemonSessionClient.load.mockClear();
    const closingError = new DaemonHttpError(
      404,
      {
        code: 'session_closing',
        error:
          'No session with id "session-b". The session is closing; retry after close completes',
        sessionId: 'session-b',
      },
      'POST /session/:id/load: No session with id "session-b". The session is closing; retry after close completes',
    );
    sdkMocks.MockDaemonSessionClient.load
      .mockRejectedValueOnce(closingError)
      .mockRejectedValueOnce(closingError);
    sdkMocks.sessions.push(secondSession);

    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.useFakeTimers();
    try {
      let switched: Promise<void> | undefined;
      act(() => {
        switched = requireActions(actions).loadSession('session-b');
      });
      if (!switched) throw new Error('Session switch was not started');
      await act(async () => {
        await flushPromises();
      });
      expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
        await flushPromises();
      });
      expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
        await flushPromises();
      });
      expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(3);

      await act(async () => {
        await expect(switched).resolves.toBeUndefined();
        await flushPromises();
      });
      expect(connection).toMatchObject({
        status: 'connected',
        sessionId: 'session-b',
        missingSession: false,
      });
      expect(notices).toEqual([]);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('retries restore_in_progress loads after the advertised delay', async () => {
    sdkMocks.sessions.push(createMockSession({ sessionId: 'session-a' }));
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });
    await act(async () => flushPromises());
    sdkMocks.MockDaemonSessionClient.load.mockClear();
    sdkMocks.MockDaemonSessionClient.load.mockRejectedValueOnce(
      new DaemonHttpError(
        409,
        {
          code: 'restore_in_progress',
          reason: 'restore_in_progress',
          retryable: true,
          retryAfterSeconds: 2,
          sessionId: 'session-b',
        },
        'Session restore is already in progress',
      ),
    );
    sdkMocks.sessions.push(createMockSession({ sessionId: 'session-b' }));

    vi.useFakeTimers();
    try {
      const switched = requireActions(actions).loadSession('session-b');
      await act(async () => flushPromises());
      expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledOnce();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_999);
        await flushPromises();
      });
      expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledOnce();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await switched;
        await flushPromises();
      });
      expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps an oversized restore_in_progress retry delay', async () => {
    sdkMocks.sessions.push(createMockSession({ sessionId: 'session-a' }));
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });
    await act(async () => flushPromises());
    sdkMocks.MockDaemonSessionClient.load.mockClear();
    sdkMocks.MockDaemonSessionClient.load.mockRejectedValueOnce(
      new DaemonHttpError(
        409,
        {
          code: 'restore_in_progress',
          reason: 'restore_in_progress',
          retryable: true,
          retryAfterSeconds: 100_000,
          sessionId: 'session-b',
        },
        'Session restore is already in progress',
      ),
    );
    sdkMocks.sessions.push(createMockSession({ sessionId: 'session-b' }));

    vi.useFakeTimers();
    try {
      const switched = requireActions(actions).loadSession('session-b');
      await act(async () => flushPromises());
      expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledOnce();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(59_999);
        await flushPromises();
      });
      expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledOnce();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await switched;
        await flushPromises();
      });
      expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry a closing session when auto-reconnect is disabled', async () => {
    sdkMocks.sessions.push(createMockSession({ sessionId: 'session-a' }));
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
      autoReconnect: false,
    });
    await act(async () => {
      await flushPromises();
    });
    sdkMocks.MockDaemonSessionClient.load.mockClear();
    sdkMocks.MockDaemonSessionClient.load.mockRejectedValueOnce(
      new DaemonHttpError(
        404,
        {
          code: 'session_closing',
          error:
            'No session with id "session-b". The session is closing; retry after close completes',
          sessionId: 'session-b',
        },
        'POST /session/:id/load: No session with id "session-b". The session is closing; retry after close completes',
      ),
    );

    await expect(
      requireActions(actions).loadSession('session-b'),
    ).rejects.toThrow();
    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
  });

  it('does not retry a missing session', async () => {
    sdkMocks.sessions.push(createMockSession({ sessionId: 'session-a' }));
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
    });
    await act(async () => {
      await flushPromises();
    });
    sdkMocks.MockDaemonSessionClient.load.mockClear();
    sdkMocks.MockDaemonSessionClient.load.mockRejectedValueOnce(
      new DaemonHttpError(
        404,
        {
          code: 'session_not_found',
          error: 'No session with id "session-b"',
          sessionId: 'session-b',
        },
        'POST /session/:id/load: No session with id "session-b"',
      ),
    );

    await expect(
      requireActions(actions).loadSession('session-b'),
    ).rejects.toThrow();
    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
  });

  it('does not retry a closing session after a newer switch', async () => {
    sdkMocks.sessions.push(createMockSession({ sessionId: 'session-a' }));
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
      reconnectDelayMs: 50,
      maxReconnectDelayMs: 50,
    });
    await act(async () => {
      await flushPromises();
    });
    sdkMocks.MockDaemonSessionClient.load.mockClear();
    sdkMocks.MockDaemonSessionClient.load.mockRejectedValueOnce(
      new DaemonHttpError(
        404,
        {
          code: 'session_closing',
          error:
            'No session with id "session-b". The session is closing; retry after close completes',
          sessionId: 'session-b',
        },
        'POST /session/:id/load: No session with id "session-b". The session is closing; retry after close completes',
      ),
    );
    sdkMocks.sessions.push(createMockSession({ sessionId: 'session-c' }));

    vi.useFakeTimers();
    try {
      const loadB = requireActions(actions)
        .loadSession('session-b')
        .catch(() => undefined);
      await act(async () => {
        await flushPromises();
      });
      const loadC = requireActions(actions).loadSession('session-c');
      await act(async () => {
        await flushPromises();
      });
      await expect(loadC).resolves.toBeUndefined();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
        await flushPromises();
      });
      await loadB;

      expect(
        sdkMocks.MockDaemonSessionClient.load.mock.calls.map((call) => call[1]),
      ).toEqual(['session-b', 'session-c']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards the checkpoint and loads the persisted branch separately', async () => {
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

    const branch = requireActions(actions).branchSession(
      'Branch 1',
      'checkpoint-1',
    );
    await act(async () => {
      await wait(5);
      await flushPromises();
    });
    await expect(branch).resolves.toEqual({
      sessionId: 'session-b',
      displayName: 'Branch 1',
      switchStarted: true,
    });

    expect(sdkMocks.branchSession).toHaveBeenCalledWith(
      'session-a',
      { name: 'Branch 1', atRecordId: 'checkpoint-1' },
      'client-a',
    );
    const loadCalls = sdkMocks.MockDaemonSessionClient.load.mock.calls;
    expect(loadCalls[0]?.[1]).toBe('session-b');
    expect(loadCalls[0]?.[3]).toMatch(/^webui_/);
  });

  it('rejects a concurrent branch and opens the first branch', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      v: 1,
      mode: 'http-bridge',
      workspaceCwd: '/mock-workspace',
      features: ['client_identity'],
      modelServices: [],
    });
    const sourceSession = createMockSession({
      sessionId: 'session-a',
      clientId: 'client-a',
    });
    const branchedSession = createMockSession({
      sessionId: 'session-b',
      clientId: 'client-b',
    });
    const firstBranch = createDeferred<{
      sessionId: string;
      displayName: string;
      clientId: string;
    }>();
    sdkMocks.branchSession.mockReturnValueOnce(firstBranch.promise);
    sdkMocks.sessions.push(sourceSession, branchedSession);
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
    sdkMocks.MockDaemonSessionClient.load.mockClear();

    let first!: Promise<{
      sessionId: string;
      displayName: string;
      switchStarted: boolean;
    }>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = requireActions(actions).branchSession('First');
      second = requireActions(actions)
        .branchSession('Second')
        .catch((error: unknown) => error);
      await flushPromises();
    });
    await expect(second).resolves.toMatchObject({ name: 'InvalidStateError' });
    expect(sdkMocks.branchSession).toHaveBeenCalledOnce();
    let firstResult:
      | {
          sessionId: string;
          displayName: string;
          switchStarted: boolean;
        }
      | undefined;
    await act(async () => {
      firstBranch.resolve({
        sessionId: 'session-b',
        displayName: 'First',
        clientId: 'client-b',
      });
      firstResult = await first;
      await flushPromises();
    });
    expect(firstResult).toEqual({
      sessionId: 'session-b',
      displayName: 'First',
      switchStarted: true,
    });
    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledOnce();
    expect(sdkMocks.MockDaemonSessionClient.load.mock.calls[0]?.[1]).toBe(
      'session-b',
    );
    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'session-b',
      clientId: 'client-b',
    });
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
      goalState: { v: 2, goal: null, activity: 'idle' },
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
      { workspaceCwd: '/mock-workspace', timeoutMs: 70_000 },
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

  it('retains standalone identity after transient heartbeat failures', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      v: 1,
      mode: 'http-bridge',
      features: ['client_heartbeat', 'standalone_sessions_v1'],
      modelServices: [],
      workspaceCwd: '/primary',
    });
    const heartbeat = vi.fn(async () => {
      throw new Error('heartbeat lost');
    });
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'standalone-heartbeat',
        workspaceCwd: '/private/standalone-heartbeat',
        session: {
          sessionId: 'standalone-heartbeat',
          workspaceCwd: '/private/standalone-heartbeat',
          sourceType: 'standalone',
          context: { kind: 'standalone' },
          projectlessOutputDirectory: '/output/standalone-heartbeat',
          workingDirectory: { state: 'ready' },
        },
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
      sessionId: 'standalone-heartbeat',
      sessionContext: { kind: 'standalone' },
      heartbeatIntervalMs: 1,
      heartbeatFailureThreshold: 1,
    });
    await act(async () => {
      await wait(50);
      await flushPromises();
    });

    expect(connection).toMatchObject({
      status: 'disconnected',
      sessionId: 'standalone-heartbeat',
      sessionContext: { kind: 'standalone' },
      standaloneSession: { workingDirectory: { state: 'ready' } },
      error: 'heartbeat lost',
    });
  });

  it('clears standalone identity after a terminal heartbeat failure', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      v: 1,
      mode: 'http-bridge',
      features: ['client_heartbeat', 'standalone_sessions_v1'],
      modelServices: [],
      workspaceCwd: '/primary',
    });
    const heartbeat = vi.fn(async () => {
      throw Object.assign(new Error('session gone'), { status: 410 });
    });
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'standalone-gone',
        workspaceCwd: '/private/standalone-gone',
        session: {
          sessionId: 'standalone-gone',
          workspaceCwd: '/private/standalone-gone',
          sourceType: 'standalone',
          context: { kind: 'standalone' },
          projectlessOutputDirectory: '/output/standalone-gone',
          workingDirectory: { state: 'ready' },
        },
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
      sessionId: 'standalone-gone',
      sessionContext: { kind: 'standalone' },
      heartbeatIntervalMs: 1,
      heartbeatFailureThreshold: 1,
    });
    await act(async () => {
      await wait(50);
      await flushPromises();
    });

    expect(connection).toMatchObject({
      status: 'disconnected',
      missingSession: true,
    });
    expect(connection?.sessionId).toBeUndefined();
    expect(connection?.sessionContext).toEqual({ kind: 'standalone' });
    expect(connection?.workspaceCwd).toBeUndefined();
    expect(connection?.standaloneSession).toBeUndefined();
  });

  it('ignores a late heartbeat failure from a replaced same-id attachment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    sdkMocks.capabilities.mockResolvedValue({
      v: 1,
      mode: 'http-bridge',
      features: ['client_heartbeat'],
      modelServices: [],
      workspaceCwd: '/mock-workspace',
    });
    const releaseHeartbeat = createDeferred<void>();
    const sourceHeartbeat = vi.fn(async () => {
      await releaseHeartbeat.promise;
      throw Object.assign(new Error('source session gone'), { status: 410 });
    });
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'session-a',
        clientId: 'client-a',
        heartbeat: sourceHeartbeat,
        events: createIdleEvents(),
      }),
      createMockSession({
        sessionId: 'session-a',
        clientId: 'client-b',
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
      sessionId: 'session-a',
      clientId: 'client-a',
      heartbeatIntervalMs: 20,
      heartbeatFailureThreshold: 1,
    });
    await vi.waitFor(() => expect(sourceHeartbeat).toHaveBeenCalled());

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={true}
          sessionId="session-a"
          clientId="client-b"
          heartbeatIntervalMs={20}
          heartbeatFailureThreshold={1}
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'session-a',
      clientId: 'client-b',
    });

    releaseHeartbeat.resolve();
    await act(async () => {
      await wait(30);
      await flushPromises();
    });

    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'session-a',
      clientId: 'client-b',
      missingSession: false,
    });
    expect(connection?.error).toBeUndefined();
  });

  it('clears stale sessions on terminal HTTP heartbeat errors', async () => {
    sdkMocks.workspaceProviders.mockResolvedValue(
      workspaceProvidersWithReasoningPreview(),
    );
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
        context: vi.fn(async () => sessionContextWithModels('session-1')),
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
    expect(connection?.context).toBeUndefined();
    expect(connection?.reasoning).toBeUndefined();
    expect(connection?.models?.[0]?.reasoningPreview).toEqual({
      enabled: true,
      effort: 'xhigh',
      efforts: ['low', 'medium', 'xhigh'],
    });
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

    await vi.waitFor(() =>
      expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({
      status: 'disconnected',
      error: 'session gone',
      errorStatus: 410,
      missingSession: true,
    });
    expect(connection?.sessionId).toBeUndefined();
  });

  it('preserves missing-session heartbeat status across later HTTP failures', async () => {
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
      .mockRejectedValue(
        Object.assign(new Error('server error'), { status: 500 }),
      );
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

    await vi.waitFor(() =>
      expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    await act(async () => {
      await flushPromises();
    });

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
    const releaseHeartbeatFailure = createDeferred<void>();
    const heartbeat = vi.fn(async () => {
      await releaseHeartbeatFailure.promise;
      throw Object.assign(new Error('session gone'), { status: 410 });
    });
    const submitStarted = createDeferred<void>();
    const session = createMockSession({
      heartbeat,
      submitPrompt: vi.fn((_req: unknown, signal?: AbortSignal) => {
        submitStarted.resolve();
        return new Promise<NonBlockingPromptAccepted>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(createAbortError()), {
            once: true,
          });
        });
      }),
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
      await submitStarted.promise;
      await flushPromises();
    });

    await act(async () => {
      releaseHeartbeatFailure.resolve();
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
      expect(connection?.context).toBeUndefined();
      expect(connection?.reasoning).toBeUndefined();
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

  it('does not attach a session after its load watchdog expires', async () => {
    const firstSession = createMockSession({ sessionId: 'session-a' });
    const lateSession = createMockSession({ sessionId: 'session-b' });
    const lateLoad = createDeferred<MockSession>();
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
    sdkMocks.MockDaemonSessionClient.load.mockImplementationOnce(
      async () => lateLoad.promise,
    );

    vi.useFakeTimers();
    try {
      const loadPromise = requireActions(actions).loadSession('session-b');
      const rejection = loadPromise.catch((error: unknown) => error);
      await act(async () => {
        await flushPromises();
        await vi.advanceTimersByTimeAsync(75_000);
      });
      const loadError = await rejection;
      expect(loadError).toBeInstanceOf(Error);
      expect((loadError as Error).message).toContain('Session load timed out');
      expect(connection).toMatchObject({ sessionId: undefined });

      lateLoad.resolve(lateSession);
      await act(async () => {
        await flushPromises();
      });
      expect(connection).toMatchObject({ sessionId: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a restore 504 without treating the session as missing', async () => {
    sdkMocks.MockDaemonSessionClient.load.mockRejectedValueOnce(
      new DaemonHttpError(
        504,
        {
          code: 'session_restore_timeout',
          errorKind: 'restore_timeout',
          retryable: true,
        },
        'AcpSessionBridge session/load timed out after 60000ms',
      ),
    );
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
      sessionId: 'large-session',
    });

    expect(connection).toMatchObject({
      status: 'error',
      error: 'AcpSessionBridge session/load timed out after 60000ms',
      errorStatus: 504,
      missingSession: false,
    });
    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledWith(
      expect.anything(),
      'large-session',
      { workspaceCwd: '/mock-workspace', timeoutMs: 70_000 },
      expect.any(String),
    );
  });

  it('keeps the current transcript when a same-session reload is aborted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const replacement = createDeferred<MockSession>();
    const currentSession = createMockSession({
      sessionId: 'session-a',
      replaySnapshot: createTextReplaySnapshot('current transcript'),
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
    sdkMocks.MockDaemonSessionClient.load.mockImplementationOnce(
      async () => replacement.promise,
    );
    const controller = new AbortController();
    let reloadOutcome: Promise<unknown> | undefined;
    act(() => {
      reloadOutcome = requireActions(actions)
        .reloadSession(controller.signal)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
    });
    await act(async () => {
      await flushPromises();
    });

    const refreshedSession = createMockSession({
      sessionId: 'session-a',
      replaySnapshot: createTextReplaySnapshot('replacement transcript'),
    });
    let outcome: unknown;
    await act(async () => {
      controller.abort();
      replacement.resolve(refreshedSession);
      outcome = await reloadOutcome;
      await flushPromises();
    });
    expect(outcome).toMatchObject({ name: 'AbortError' });

    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'current transcript' },
    ]);
    expect(currentSession.detach).not.toHaveBeenCalled();
    expect(refreshedSession.detach).toHaveBeenCalledOnce();

    await act(async () => {
      root?.unmount();
      root = null;
      await flushPromises();
    });
  });

  it('detaches the source attachment once after a same-session reload', async () => {
    const detachFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', detachFetch);
    const currentSession = createMockSession({
      sessionId: 'session-a',
      clientId: 'client-a',
      events: createIdleEvents(),
    });
    const replacementSession = createMockSession({
      sessionId: 'session-a',
      clientId: 'client-b',
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(currentSession);
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await flushPromises();
    });
    sdkMocks.MockDaemonSessionClient.load.mockResolvedValueOnce(
      replacementSession,
    );

    let reload: Promise<void> | undefined;
    act(() => {
      reload = requireActions(actions).reloadSession(
        new AbortController().signal,
      );
    });
    await act(async () => {
      await flushPromises();
    });
    await expect(reload).resolves.toBeUndefined();

    await act(async () => {
      root?.unmount();
      root = null;
      await flushPromises();
    });

    expect(currentSession.detach).toHaveBeenCalledOnce();
    expect(detachFetch).toHaveBeenCalledOnce();
    expect(
      new Headers(detachFetch.mock.calls[0][1]?.headers).get(
        'X-Qwen-Client-Id',
      ),
    ).toBe('client-b');
  });

  it('retires both attachments when unmounted during a same-session reload', async () => {
    const detachFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', detachFetch);
    const replacement = createDeferred<MockSession>();
    const source = createMockSession({
      sessionId: 'session-a',
      clientId: 'client-a',
      events: createIdleEvents(),
    });
    const target = createMockSession({
      sessionId: 'session-a',
      clientId: 'client-b',
      events: createIdleEvents(),
    });
    sdkMocks.sessions.push(source);
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    sdkMocks.MockDaemonSessionClient.load.mockClear();
    sdkMocks.MockDaemonSessionClient.load.mockImplementationOnce(
      async () => replacement.promise,
    );
    let reloadOutcome: Promise<unknown> | undefined;
    act(() => {
      reloadOutcome = requireActions(actions)
        .reloadSession(new AbortController().signal)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
    });
    await act(async () => {
      await flushPromises();
    });
    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledOnce();

    await act(async () => {
      root?.unmount();
      root = null;
    });
    await expect(reloadOutcome).resolves.toMatchObject({ name: 'AbortError' });

    replacement.resolve(target);
    await act(async () => {
      await flushPromises();
    });

    const detachedClientIds = detachFetch.mock.calls.map(([, init]) =>
      new Headers(init?.headers).get('X-Qwen-Client-Id'),
    );
    expect(detachedClientIds).toEqual(
      expect.arrayContaining(['client-a', 'client-b']),
    );
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

  it('keeps the cleared target and exposes the error when load fails', async () => {
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'session-a',
        workspaceCwd: '/work/a',
        replaySnapshot: createTextReplaySnapshot('old transcript'),
      }),
    );
    let actions: DaemonSessionActions | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let connection: DaemonConnectionState | undefined;

    function Harness() {
      actions = useDaemonActions();
      blocks = useDaemonTranscriptBlocks();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await act(async () => flushPromises());
    sdkMocks.MockDaemonSessionClient.load.mockRejectedValueOnce(
      new Error('load failed'),
    );

    await act(async () => {
      await expect(
        requireActions(actions).loadSession('session-b', {
          workspaceCwd: '/work/b',
        }),
      ).rejects.toThrow('load failed');
      await flushPromises();
    });

    expect(blocks).toEqual([]);
    expect(connection).toMatchObject({
      sessionId: 'session-b',
      workspaceCwd: '/work/b',
      error: 'load failed',
    });
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
      { workspaceCwd: '/mock-workspace', timeoutMs: 70_000 },
      expect.any(String),
    );
    expect(connection).toMatchObject({ sessionId: 'session-b' });
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'new transcript' },
    ]);
  });

  it('keeps an imperatively loaded session when controlled workspace props catch up', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(undefined, { status: 204 })),
    );
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'session-a',
        workspaceCwd: '/work/a',
      }),
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
      sessionId: 'session-a',
      workspaceCwd: '/work/a',
    });
    sdkMocks.MockDaemonSessionClient.load.mockClear();
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'session-b',
        workspaceCwd: '/work/b',
      }),
    );

    let loadSession: Promise<void> | undefined;
    act(() => {
      loadSession = requireActions(actions).loadSession('session-b', {
        workspaceCwd: '/work/b',
      });
    });
    await act(async () => {
      await wait(5);
      await flushPromises();
    });
    await act(async () => {
      await loadSession;
      await flushPromises();
    });
    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'session-b',
      workspaceCwd: '/work/b',
    });

    act(() => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect={true}
          sessionId="session-b"
          workspaceCwd="/work/b"
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledOnce();
    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'session-b',
      workspaceCwd: '/work/b',
      missingSession: false,
    });
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

  it('ignores stale metadata from a replaced same-id attachment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const providersA = createDeferred<unknown>();
    const commandsA =
      createDeferred<Awaited<ReturnType<MockSession['supportedCommands']>>>();
    const contextA =
      createDeferred<Awaited<ReturnType<MockSession['context']>>>();
    sdkMocks.workspaceProviders.mockReturnValueOnce(providersA.promise);
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'session-a',
        clientId: 'client-a',
        replaySnapshot: createTextReplaySnapshot('session a transcript'),
        supportedCommands: vi.fn(() => commandsA.promise),
        context: vi.fn(() => contextA.promise),
      }),
      createMockSession({
        sessionId: 'session-a',
        clientId: 'client-b',
        replaySnapshot: createTextReplaySnapshot('replacement transcript'),
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
      clientId: 'client-a',
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
          sessionId="session-a"
          clientId="client-b"
        >
          <Harness />
        </DaemonSessionProvider>,
      );
    });
    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({
      sessionId: 'session-a',
      clientId: 'client-b',
      loadingTranscript: undefined,
    });
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'replacement transcript' },
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

    expect(connection).toMatchObject({
      sessionId: 'session-a',
      clientId: 'client-b',
    });
    expect(connection?.currentModel).not.toBe('stale-model');
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'replacement transcript' },
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
      { workspaceCwd: '/mock-workspace', timeoutMs: 70_000 },
      expect.any(String),
    );
    expect(
      sdkMocks.MockDaemonSessionClient.createOrAttach,
    ).not.toHaveBeenCalled();
    expect(connection).toMatchObject({ sessionId: 'session-a' });
  });

  it('publishes the loaded workspace instead of the primary fallback', async () => {
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'session-a',
        workspaceCwd: '/secondary-workspace',
      }),
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
      sessionId: 'session-a',
      sessionContext: {
        kind: 'workspace',
        cwd: '/secondary-workspace',
      },
      workspaceCwd: '/secondary-workspace',
    });
  });

  it('does not duplicate the initial controlled load when workspace is set', async () => {
    sdkMocks.sessions.push(
      createMockSession({ sessionId: 'session-a', clientId: 'client-a' }),
    );

    await renderWithProvider(null, {
      autoConnect: true,
      sessionId: 'session-a',
      workspaceCwd: '/mock-workspace',
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledOnce();
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

  it('does not apply session metadata captured before a model update', async () => {
    const staleContext =
      createDeferred<Awaited<ReturnType<MockSession['context']>>>();
    const session = createMockSession({
      sessionId: 'session-a',
      context: vi
        .fn()
        .mockReturnValueOnce(staleContext.promise)
        .mockResolvedValueOnce({
          v: 1,
          sessionId: 'session-a',
          workspaceCwd: '/mock-workspace',
          state: { models: { currentModelId: 'model-b' } },
        }),
    });
    sdkMocks.sessions.push(session);
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
    await vi.waitFor(() => expect(session.context).toHaveBeenCalledOnce());

    await act(async () => {
      await requireActions(actions).setModel('model-b');
      await flushPromises();
    });
    expect(connection?.currentModel).toBe('model-b');

    await act(async () => {
      staleContext.resolve({
        v: 1,
        sessionId: 'session-a',
        workspaceCwd: '/mock-workspace',
        state: { models: { currentModelId: 'model-a' } },
      });
      await flushPromises();
    });

    expect(connection?.currentModel).toBe('model-b');
    expect(connection?.context?.state).toEqual({
      models: { currentModelId: 'model-b' },
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
    sdkMocks.workspaceProviders.mockResolvedValue(
      workspaceProvidersWithReasoningPreview(),
    );
    const session = createMockSession({
      context: vi.fn(async () => sessionContextWithModels('session-1')),
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
    expect(connection?.context).toBeUndefined();
    expect(connection?.reasoning).toBeUndefined();
    expect(connection?.models?.[0]?.reasoningPreview).toEqual({
      enabled: true,
      effort: 'xhigh',
      efforts: ['low', 'medium', 'xhigh'],
    });
    await act(async () => {
      await expect(providerActions.cancel()).rejects.toThrow(
        'Daemon session is not connected',
      );
    });
  });

  it('restores the workspace reasoning preview after an auth failure clears the stream', async () => {
    sdkMocks.workspaceProviders.mockResolvedValue(
      workspaceProvidersWithReasoningPreview(),
    );
    const session = createMockSession({
      context: vi.fn(async () => sessionContextWithModels('session-1')),
      events: async function* authErrorEvents() {
        await Promise.resolve();
        yield* [];
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
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
      autoReconnect: false,
    });

    await act(async () => {
      await flushPromises();
    });

    expect(connection).toMatchObject({
      status: 'error',
      error: 'Unauthorized',
      errorStatus: 401,
    });
    expect(connection?.sessionId).toBeUndefined();
    expect(connection?.context).toBeUndefined();
    expect(connection?.reasoning).toBeUndefined();
    expect(connection?.models?.[0]?.reasoningPreview).toEqual({
      enabled: true,
      effort: 'xhigh',
      efforts: ['low', 'medium', 'xhigh'],
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

  it('clears missing-session state when starting a new session', async () => {
    sdkMocks.MockDaemonSessionClient.load.mockRejectedValueOnce(
      Object.assign(new Error('session gone'), { status: 410 }),
    );
    sdkMocks.sessions.push(createMockSession({ sessionId: 'new-session' }));

    let actions: DaemonSessionActions | undefined;
    let connection: DaemonConnectionState | undefined;
    function Harness() {
      actions = useDaemonActions();
      connection = useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
      sessionId: 'missing-session',
    });

    await act(async () => {
      await flushPromises();
    });
    expect(connection).toMatchObject({
      status: 'disconnected',
      error: 'session gone',
      errorStatus: 410,
      missingSession: true,
    });

    await act(async () => {
      await actions?.newSession();
      await wait(5);
      await flushPromises();
    });

    expect(connection).toMatchObject({
      status: 'connected',
      sessionId: 'new-session',
    });
    expect(connection?.error).toBeUndefined();
    expect(connection?.errorStatus).toBeUndefined();
    expect(connection?.missingSession).not.toBe(true);
  });

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
        errorStatus: status,
        missingSession: false,
        capabilities: {
          workspaceCwd: '/mock-workspace',
          features: [],
        },
      });
      expect(connection?.sessionId).toBeUndefined();
      expect(connection?.context).toBeUndefined();
      expect(connection?.reasoning).toBeUndefined();
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

  it('clears standalone session metadata after an auth failure', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/primary',
      features: ['standalone_sessions_v1'],
    });
    const streamFailure = createDeferred<void>();
    const streamStarted = createDeferred<void>();
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'standalone-auth',
        workspaceCwd: '/private/standalone-auth',
        session: {
          sessionId: 'standalone-auth',
          workspaceCwd: '/private/standalone-auth',
          sourceType: 'standalone',
          context: { kind: 'standalone' },
          projectlessOutputDirectory: '/output/standalone-auth',
          workingDirectory: { state: 'ready' },
        },
        context: vi.fn(async () => sessionContextWithModels('standalone-auth')),
        supportedCommands: vi.fn(async () => ({
          v: 1 as const,
          sessionId: 'standalone-auth',
          availableCommands: [
            { name: '/context', description: 'Show context', input: null },
          ],
          availableSkills: ['review'],
        })),
        events: async function* authFailureEvents() {
          streamStarted.resolve();
          await streamFailure.promise;
          yield* [];
          throw new DaemonHttpError(401, {}, 'Unauthorized');
        },
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
      sessionId: 'standalone-auth',
      sessionContext: { kind: 'standalone' },
    });
    await act(async () => {
      await vi.waitFor(() => expect(connection?.status).toBe('connected'));
      await streamStarted.promise;
    });
    expect(connection?.commands?.length).toBeGreaterThan(0);
    expect(connection?.models).toHaveLength(1);

    streamFailure.resolve();
    await act(async () => {
      await wait(20);
      await flushPromises();
    });

    expect(connection).toMatchObject({
      status: 'error',
      sessionContext: { kind: 'standalone' },
      error: 'Unauthorized',
      errorStatus: 401,
    });
    expect(connection?.sessionId).toBeUndefined();
    expect(connection?.commands).toBeUndefined();
    expect(connection?.skills).toBeUndefined();
    expect(connection?.models).toBeUndefined();
    expect(connection?.supportedCommands).toBeUndefined();
    expect(connection?.context).toBeUndefined();
    expect(connection?.standaloneSession).toBeUndefined();
  });

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
      { workspaceCwd: '/mock-workspace', timeoutMs: 70_000 },
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
    const settlements: DaemonPromptSettledEvent[] = [];
    function Harness() {
      actions = useDaemonActions();
      streamingState = useDaemonStreamingState();
      blocks = useDaemonTranscriptBlocks();
      useDaemonPromptSettled((event) => settlements.push(event));
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
    expect(settlements).toEqual([
      {
        sessionId: 'session-ring-active-prompt',
        promptId: 'prompt-1',
        outcome: 'completed',
        stopReason: 'end_turn',
        eventId: 13,
        transcriptComplete: true,
      },
    ]);
  });

  it.each([
    {
      label: 'degraded',
      replayDegraded: true,
      liveJournal: [] as DaemonEvent[],
    },
    {
      label: 'marked unrecoverable',
      replayDegraded: false,
      liveJournal: [
        {
          id: 14,
          v: 1,
          type: 'history_truncated',
          promptId: 'prompt-1',
          data: {
            reason: 'replay_window_exceeded',
            scope: 'live_journal',
            truncatedEvents: 8,
            retainedEvents: 1,
            maxBytes: 1024,
            maxEvents: 1,
            fullTranscriptAvailable: false,
          },
        },
      ] as DaemonEvent[],
    },
  ])(
    'marks catch-up settlement incomplete when the replay is $label',
    async ({ replayDegraded, liveJournal }) => {
      const ringEvicted = createDeferred<void>();
      const reloaded = createDeferred<void>();
      const firstSession = createMockSession({
        sessionId: 'session-ring-degraded',
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
        sessionId: firstSession.sessionId,
        replayDegraded,
        replaySnapshot: {
          compactedReplay: [
            {
              id: 12,
              v: 1,
              type: 'session_update',
              promptId: 'prompt-1',
              data: {
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'partial replay' },
                },
              },
            },
            {
              id: 13,
              v: 1,
              type: 'turn_complete',
              promptId: 'prompt-1',
              data: { promptId: 'prompt-1', stopReason: 'end_turn' },
            },
          ],
          liveJournal,
        },
        events: createPendingEvents(reloaded),
      });
      sdkMocks.sessions.push(firstSession, reloadedSession);

      let actions: DaemonUiSessionActions | undefined;
      const settlements: DaemonPromptSettledEvent[] = [];
      function Harness() {
        actions = useDaemonActions();
        useDaemonPromptSettled((event) => settlements.push(event));
        return null;
      }

      await renderWithProvider(<Harness />, {
        autoConnect: true,
        reconnectDelayMs: 1,
        maxReconnectDelayMs: 1,
      });
      const promptResult = requireActions(actions).sendPrompt('ring prompt');
      await act(async () => flushPromises());
      await act(async () => {
        ringEvicted.resolve();
        await reloaded.promise;
        await flushPromises();
      });
      await act(async () => {
        await expect(promptResult).resolves.toEqual({ stopReason: 'end_turn' });
      });

      expect(settlements).toEqual([
        expect.objectContaining({
          sessionId: firstSession.sessionId,
          promptId: 'prompt-1',
          outcome: 'completed',
          transcriptComplete: false,
        }),
      ]);
    },
  );

  it('repairs and publishes a live terminal after a reconnect restores an active prompt', async () => {
    const ringEvicted = createDeferred<void>();
    const reloadedStreamStarted = createDeferred<void>();
    const terminalGate = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-ring-live-repair',
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
      sessionId: firstSession.sessionId,
      hasActivePrompt: true,
      lastEventId: 13,
      replaySnapshot: {
        compactedReplay: [],
        liveJournal: [
          {
            id: 11,
            v: 1,
            type: 'history_truncated',
            promptId: 'prompt-1',
            data: {
              reason: 'replay_window_exceeded',
              scope: 'live_journal',
              truncatedEvents: 8,
              retainedEvents: 1,
              maxBytes: 1024,
              maxEvents: 1,
              fullTranscriptAvailable: true,
            },
          },
          {
            id: 12,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-1',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'partial tail' },
              },
            },
          },
        ],
      },
      events: async function* terminalEvents(
        options: { signal?: AbortSignal } = {},
      ) {
        reloadedStreamStarted.resolve();
        await terminalGate.promise;
        if (options.signal?.aborted) return;
        yield {
          id: 13,
          v: 1,
          type: 'turn_complete',
          promptId: 'prompt-1',
          data: { promptId: 'prompt-1', stopReason: 'end_turn' },
        } satisfies DaemonEvent;
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
      },
    });
    const repairedSession = createMockSession({
      sessionId: firstSession.sessionId,
      lastEventId: 13,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 10,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-1',
            data: {
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'long prompt' },
              },
            },
          },
          {
            id: 11,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-1',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'complete answer' },
              },
            },
          },
          {
            id: 13,
            v: 1,
            type: 'turn_complete',
            promptId: 'prompt-1',
            data: { promptId: 'prompt-1', stopReason: 'end_turn' },
          },
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(firstSession, reloadedSession, repairedSession);

    let actions: DaemonUiSessionActions | undefined;
    const settlements: DaemonPromptSettledEvent[] = [];
    function Harness() {
      actions = useDaemonActions();
      useDaemonPromptSettled((event) => settlements.push(event));
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
      promptResult = providerActions.sendPrompt('long prompt');
      await flushPromises();
    });
    await act(async () => {
      ringEvicted.resolve();
      await reloadedStreamStarted.promise;
      terminalGate.resolve();
      await flushPromises();
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(3),
      );
      await flushPromises();
    });
    await act(async () => {
      await vi.waitFor(() => expect(settlements).toHaveLength(1));
      await flushPromises();
    });
    await act(async () => {
      await expect(promptResult).resolves.toEqual({ stopReason: 'end_turn' });
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(3);
    expect(settlements).toEqual([
      expect.objectContaining({
        sessionId: firstSession.sessionId,
        promptId: 'prompt-1',
        outcome: 'completed',
        transcriptComplete: true,
      }),
    ]);
  });

  it('marks a live restored-prompt terminal incomplete after a degraded load', async () => {
    const terminalDelivered = createDeferred<void>();
    const session = createMockSession({
      sessionId: 'session-degraded-restored-live',
      hasActivePrompt: true,
      replayDegraded: true,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 11,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-1',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'partial restored answer' },
              },
            },
          },
        ],
        liveJournal: [],
      },
      events: async function* terminalEvents() {
        yield {
          id: 12,
          v: 1,
          type: 'turn_complete',
          promptId: 'prompt-1',
          data: { promptId: 'prompt-1', stopReason: 'end_turn' },
        } satisfies DaemonEvent;
        terminalDelivered.resolve();
      },
    });
    sdkMocks.sessions.push(session);

    const settlements: DaemonPromptSettledEvent[] = [];
    function Harness() {
      useDaemonPromptSettled((event) => settlements.push(event));
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await terminalDelivered.promise;
      await flushPromises();
    });

    expect(settlements).toEqual([
      expect.objectContaining({
        sessionId: session.sessionId,
        promptId: 'prompt-1',
        outcome: 'completed',
        transcriptComplete: false,
      }),
    ]);
  });

  it('marks a live restored-prompt terminal incomplete while an unowned live-journal marker remains', async () => {
    const terminalDelivered = createDeferred<void>();
    const session = createMockSession({
      sessionId: 'session-truncated-restored-live',
      hasActivePrompt: true,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 8,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-1',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'partial restored answer' },
              },
            },
          },
        ],
        liveJournal: [
          {
            v: 1,
            type: 'history_truncated',
            data: {
              reason: 'replay_window_exceeded',
              scope: 'live_journal',
              truncatedEvents: 8,
              retainedEvents: 2,
              maxBytes: 1024,
              maxEvents: 2,
              fullTranscriptAvailable: true,
            },
            id: 9,
          },
          {
            id: 10,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-previous',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'previous retained tail' },
              },
            },
          },
          {
            id: 11,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-1',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'current retained tail' },
              },
            },
          },
        ],
      },
      events: async function* terminalEvents() {
        yield {
          id: 12,
          v: 1,
          type: 'turn_complete',
          promptId: 'prompt-1',
          data: { promptId: 'prompt-1', stopReason: 'end_turn' },
        } satisfies DaemonEvent;
        terminalDelivered.resolve();
      },
    });
    sdkMocks.sessions.push(session);

    const settlements: DaemonPromptSettledEvent[] = [];
    function Harness() {
      useDaemonPromptSettled((event) => settlements.push(event));
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await terminalDelivered.promise;
      await flushPromises();
    });

    expect(settlements).toEqual([
      expect.objectContaining({
        sessionId: session.sessionId,
        promptId: 'prompt-1',
        outcome: 'completed',
        transcriptComplete: false,
      }),
    ]);
  });

  it('publishes a restored prompt terminal received in a reconnect replay', async () => {
    const ringEvicted = createDeferred<void>();
    const reloaded = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-restored-catchup',
      hasActivePrompt: true,
      lastEventId: 10,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 10,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-1',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'answer before reconnect' },
              },
            },
          },
        ],
        liveJournal: [],
      },
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
        } satisfies DaemonEvent;
      },
    });
    const reloadedSession = createMockSession({
      sessionId: firstSession.sessionId,
      hasActivePrompt: false,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 11,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-1',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'final replayed answer' },
              },
            },
          },
          {
            id: 12,
            v: 1,
            type: 'turn_complete',
            promptId: 'prompt-1',
            data: {
              sessionId: firstSession.sessionId,
              promptId: 'prompt-1',
              stopReason: 'end_turn',
            },
          },
        ],
        liveJournal: [],
      },
      events: createPendingEvents(reloaded),
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);

    const settlements: DaemonPromptSettledEvent[] = [];
    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';
    function Harness() {
      promptStatus = useDaemonPromptStatus();
      useDaemonPromptSettled((event) => settlements.push(event));
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      ringEvicted.resolve();
      await reloaded.promise;
      await flushPromises();
    });

    expect(settlements).toEqual([
      expect.objectContaining({
        sessionId: firstSession.sessionId,
        promptId: 'prompt-1',
        outcome: 'completed',
        transcriptComplete: true,
      }),
    ]);
    expect(promptStatus).toBe('idle');
  });

  it('fails closed when an idle reload lacks the restored prompt terminal', async () => {
    const ringEvicted = createDeferred<void>();
    const reloaded = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-restored-terminal-missing',
      hasActivePrompt: true,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 10,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-restored',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'partial answer' },
              },
            },
          },
        ],
        liveJournal: [],
      },
      events: async function* ringEvictedEvents() {
        await ringEvicted.promise;
        yield {
          v: 1,
          type: 'state_resync_required',
          data: { reason: 'ring_evicted' },
        } satisfies DaemonEvent;
      },
    });
    const reloadedSession = createMockSession({
      sessionId: firstSession.sessionId,
      hasActivePrompt: false,
      replaySnapshot: { compactedReplay: [], liveJournal: [] },
      events: createPendingEvents(reloaded),
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);

    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';
    const settlements: DaemonPromptSettledEvent[] = [];
    function Harness() {
      promptStatus = useDaemonPromptStatus();
      useDaemonPromptSettled((event) => settlements.push(event));
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      ringEvicted.resolve();
      await reloaded.promise;
      await flushPromises();
    });

    expect(settlements).toEqual([]);
    expect(promptStatus).toBe('idle');
  });

  it('re-correlates a restored successor after replay finishes the pinned prompt', async () => {
    const ringEvicted = createDeferred<void>();
    const successorCompleted = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-restored-successor',
      hasActivePrompt: true,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 10,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-finished',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'finished answer' },
              },
            },
          },
        ],
        liveJournal: [],
      },
      events: async function* ringEvictedEvents() {
        await ringEvicted.promise;
        yield {
          v: 1,
          type: 'state_resync_required',
          data: { reason: 'ring_evicted' },
        } satisfies DaemonEvent;
      },
    });
    const reloadedSession = createMockSession({
      sessionId: firstSession.sessionId,
      hasActivePrompt: true,
      replayDegraded: true,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 11,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-finished',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'finished answer' },
              },
            },
          },
          {
            id: 12,
            v: 1,
            type: 'turn_complete',
            promptId: 'prompt-finished',
            data: {
              sessionId: firstSession.sessionId,
              promptId: 'prompt-finished',
              stopReason: 'end_turn',
            },
          },
          {
            id: 13,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-successor',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'successor answer' },
              },
            },
          },
        ],
        liveJournal: [],
      },
      events: async function* successorEvents() {
        yield {
          id: 14,
          v: 1,
          type: 'turn_complete',
          promptId: 'prompt-successor',
          data: {
            sessionId: firstSession.sessionId,
            promptId: 'prompt-successor',
            stopReason: 'end_turn',
          },
        } satisfies DaemonEvent;
        successorCompleted.resolve();
      },
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);

    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';
    const settlements: DaemonPromptSettledEvent[] = [];
    function Harness() {
      promptStatus = useDaemonPromptStatus();
      useDaemonPromptSettled((event) => settlements.push(event));
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      ringEvicted.resolve();
      await successorCompleted.promise;
      await flushPromises();
    });

    expect(promptStatus).toBe('idle');
    expect(settlements).toEqual([
      expect.objectContaining({
        promptId: 'prompt-successor',
        outcome: 'completed',
      }),
    ]);
  });

  it('does not adopt a queued prompt while correlating a restored terminal', async () => {
    const terminalDelivered = createDeferred<void>();
    const sessionId = 'session-restored-queued-correlation';
    const session = createMockSession({
      sessionId,
      hasActivePrompt: true,
      events: async function* queuedThenTerminal() {
        yield {
          id: 1,
          v: 1,
          type: 'pending_prompt_added',
          data: {
            sessionId,
            promptId: 'prompt-queued',
            text: 'queued request',
          },
        } satisfies DaemonEvent;
        yield {
          id: 2,
          v: 1,
          type: 'turn_complete',
          promptId: 'prompt-restored',
          data: { promptId: 'prompt-restored', stopReason: 'end_turn' },
        } satisfies DaemonEvent;
        terminalDelivered.resolve();
      },
    });
    sdkMocks.sessions.push(session);

    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';
    const settlements: DaemonPromptSettledEvent[] = [];
    function Harness() {
      promptStatus = useDaemonPromptStatus();
      useDaemonPromptSettled((event) => settlements.push(event));
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await terminalDelivered.promise;
      await flushPromises();
    });

    expect(promptStatus).toBe('idle');
    expect(settlements).toEqual([
      expect.objectContaining({ promptId: 'prompt-restored' }),
    ]);
  });

  it('does not attribute an uncorrelated historical terminal to a restored prompt', async () => {
    const ringEvicted = createDeferred<void>();
    const reloaded = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-restored-uncorrelated-terminal',
      hasActivePrompt: true,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 9,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-restored',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'restored partial answer' },
              },
            },
          },
        ],
        liveJournal: [],
      },
      events: async function* ringEvictedEvents() {
        await ringEvicted.promise;
        yield {
          v: 1,
          type: 'state_resync_required',
          data: { reason: 'ring_evicted' },
        } satisfies DaemonEvent;
      },
    });
    const reloadedSession = createMockSession({
      sessionId: firstSession.sessionId,
      hasActivePrompt: false,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 10,
            v: 1,
            type: 'turn_complete',
            promptId: 'prompt-historical',
            data: { promptId: 'prompt-historical', stopReason: 'end_turn' },
          },
        ],
        liveJournal: [],
      },
      events: createPendingEvents(reloaded),
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);

    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';
    const settlements: DaemonPromptSettledEvent[] = [];
    function Harness() {
      promptStatus = useDaemonPromptStatus();
      useDaemonPromptSettled((event) => settlements.push(event));
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      ringEvicted.resolve();
      await reloaded.promise;
      await flushPromises();
    });

    expect(settlements).toEqual([]);
    expect(promptStatus).toBe('idle');
  });

  it('settles an unbound restored prompt on a promptId-less terminal', async () => {
    const terminalDelivered = createDeferred<void>();
    const session = createMockSession({
      sessionId: 'session-restored-unbound-terminal',
      hasActivePrompt: true,
      events: async function* promptIdlessTerminal() {
        yield {
          id: 1,
          v: 1,
          type: 'turn_complete',
          data: { stopReason: 'end_turn' },
        } satisfies DaemonEvent;
        terminalDelivered.resolve();
      },
    });
    sdkMocks.sessions.push(session);

    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';
    const settlements: DaemonPromptSettledEvent[] = [];
    function Harness() {
      promptStatus = useDaemonPromptStatus();
      useDaemonPromptSettled((event) => settlements.push(event));
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await terminalDelivered.promise;
      await flushPromises();
    });

    expect(promptStatus).toBe('idle');
    expect(settlements).toEqual([]);
  });

  it('preserves restored prompt correlation across degraded reconnect replay', async () => {
    const ringEvicted = createDeferred<void>();
    const mismatchedTerminalDelivered = createDeferred<void>();
    const deliverMatchingTerminal = createDeferred<void>();
    const terminalDelivered = createDeferred<void>();
    const firstSession = createMockSession({
      sessionId: 'session-restored-degraded-correlation',
      hasActivePrompt: true,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 10,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-correct',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'correct partial answer' },
              },
            },
          },
        ],
        liveJournal: [],
      },
      events: async function* ringEvictedEvents() {
        await ringEvicted.promise;
        yield {
          v: 1,
          type: 'state_resync_required',
          data: { reason: 'ring_evicted' },
        } satisfies DaemonEvent;
      },
    });
    const reloadedSession = createMockSession({
      sessionId: firstSession.sessionId,
      hasActivePrompt: true,
      replayDegraded: true,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 11,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-stale',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'stale replay tail' },
              },
            },
          },
        ],
        liveJournal: [],
      },
      events: async function* correctTerminal(
        options: { signal?: AbortSignal } = {},
      ) {
        yield {
          id: 12,
          v: 1,
          type: 'turn_complete',
          promptId: 'prompt-other',
          data: { promptId: 'prompt-other', stopReason: 'end_turn' },
        } satisfies DaemonEvent;
        mismatchedTerminalDelivered.resolve();
        await deliverMatchingTerminal.promise;
        yield {
          id: 13,
          v: 1,
          type: 'turn_complete',
          promptId: 'prompt-correct',
          data: { promptId: 'prompt-correct', stopReason: 'end_turn' },
        } satisfies DaemonEvent;
        terminalDelivered.resolve();
        await new Promise<void>((resolve) =>
          options.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
      },
    });
    sdkMocks.sessions.push(firstSession, reloadedSession);

    let promptStatus: ReturnType<typeof useDaemonPromptStatus> = 'idle';
    const settlements: DaemonPromptSettledEvent[] = [];
    function Harness() {
      promptStatus = useDaemonPromptStatus();
      useDaemonPromptSettled((event) => settlements.push(event));
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => {
      ringEvicted.resolve();
      await mismatchedTerminalDelivered.promise;
      await flushPromises();
    });
    expect(promptStatus).toBe('streaming');
    expect(settlements).toEqual([]);

    await act(async () => {
      deliverMatchingTerminal.resolve();
      await terminalDelivered.promise;
      await flushPromises();
    });

    expect(promptStatus).toBe('idle');
    expect(settlements).toEqual([
      expect.objectContaining({
        promptId: 'prompt-correct',
        transcriptComplete: false,
      }),
    ]);
  });

  it('defers catch-up settlement until a truncated replay is repaired', async () => {
    const ringEvicted = createDeferred<void>();
    const repairLoad = createDeferred<MockSession>();
    const firstSession = createMockSession({
      sessionId: 'session-ring-catchup-repair',
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
      sessionId: firstSession.sessionId,
      hasActivePrompt: true,
      lastEventId: 14,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 13,
            v: 1,
            type: 'turn_complete',
            promptId: 'prompt-1',
            data: { promptId: 'prompt-1', stopReason: 'end_turn' },
          },
        ],
        liveJournal: [
          {
            id: 11,
            v: 1,
            type: 'history_truncated',
            promptId: 'prompt-1',
            data: {
              reason: 'replay_window_exceeded',
              scope: 'live_journal',
              truncatedEvents: 8,
              retainedEvents: 1,
              maxBytes: 1024,
              maxEvents: 1,
              fullTranscriptAvailable: true,
            },
          },
          {
            id: 12,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-1',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'partial catch-up tail' },
              },
            },
          },
        ],
      },
    });
    const repairedSession = createMockSession({
      sessionId: firstSession.sessionId,
      lastEventId: 14,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 10,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-1',
            data: {
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'long prompt' },
              },
            },
          },
          {
            id: 12,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-1',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'complete catch-up answer' },
              },
            },
          },
          {
            id: 13,
            v: 1,
            type: 'turn_complete',
            promptId: 'prompt-1',
            data: { promptId: 'prompt-1', stopReason: 'end_turn' },
          },
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(firstSession);

    let actions: DaemonUiSessionActions | undefined;
    const settlements: DaemonPromptSettledEvent[] = [];
    function Harness() {
      actions = useDaemonActions();
      useDaemonPromptSettled((event) => settlements.push(event));
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      reconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
    });
    await act(async () => flushPromises());
    let reloadNumber = 0;
    sdkMocks.MockDaemonSessionClient.load.mockImplementation(
      async (client: unknown): Promise<MockSession> => {
        reloadNumber += 1;
        if (reloadNumber === 1) {
          reloadedSession.client = client as MockClient;
          return reloadedSession;
        }
        const repaired = await repairLoad.promise;
        repaired.client = client as MockClient;
        return repaired;
      },
    );
    const providerActions = requireActions(actions);
    let promptResult: Promise<unknown> | undefined;
    await act(async () => {
      promptResult = providerActions.sendPrompt('long prompt');
      await flushPromises();
    });
    await act(async () => {
      ringEvicted.resolve();
      await flushPromises();
    });
    await vi.waitFor(() => expect(reloadNumber).toBe(2));
    expect(settlements).toEqual([]);

    await act(async () => {
      repairLoad.resolve(repairedSession);
      await vi.waitFor(() => expect(settlements).toHaveLength(1));
      await flushPromises();
    });
    await act(async () => {
      await expect(promptResult).resolves.toEqual({ stopReason: 'end_turn' });
    });

    expect(settlements).toEqual([
      expect.objectContaining({
        sessionId: firstSession.sessionId,
        promptId: 'prompt-1',
        outcome: 'completed',
        transcriptComplete: true,
      }),
    ]);
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
    const settlements: DaemonPromptSettledEvent[] = [];
    function Harness() {
      actions = useDaemonActions();
      streamingState = useDaemonStreamingState();
      blocks = useDaemonTranscriptBlocks();
      useDaemonPromptSettled((event) => settlements.push(event));
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
    expect(settlements).toEqual([
      {
        sessionId: firstSession.sessionId,
        promptId: 'prompt-1',
        outcome: 'failed',
        eventId: 13,
        transcriptComplete: true,
        error: { message: 'model overloaded', code: 'overloaded' },
      },
    ]);
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
      await flushTranscriptDispatch();
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
    const resumeDelivered = createDeferred<void>();
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
      resumeDelivered.resolve();
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
      await resumeDelivered.promise;
      await flushPromises();
      await flushTranscriptDispatch();
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledTimes(1);
    // events() was called twice: first threw, second succeeded
    expect(events).toHaveBeenCalledTimes(2);
    // Transcript preserved content from before the error and appended delta
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'before error after resume' },
    ]);
  });

  it('clears an existing error during autoReconnect backoff', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      v: 1,
      mode: 'http-bridge',
      features: ['client_heartbeat'],
      modelServices: [],
      workspaceCwd: '/mock-workspace',
    });
    let callCount = 0;
    const firstAttempt = createDeferred<void>();
    const secondAttempt = createDeferred<void>();
    const events = vi.fn(async function* retriableEvents(
      opts: { signal?: AbortSignal } = {},
    ) {
      callCount += 1;
      if (callCount === 1) {
        await firstAttempt.promise;
        throw new Error('network timeout');
      }
      await secondAttempt.promise;
      if (opts.signal?.aborted) return;
      yield* [];
    });
    const laterHeartbeat = createDeferred<void>();
    const heartbeat = vi
      .fn()
      .mockRejectedValueOnce(new Error('heartbeat lost'))
      .mockImplementation(async () => {
        await laterHeartbeat.promise;
        return { ok: true };
      });
    const session = createMockSession({ events, heartbeat });
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
      heartbeatIntervalMs: 1,
      heartbeatFailureThreshold: 1,
    });
    await vi.waitFor(() => expect(connection?.error).toBe('heartbeat lost'));

    firstAttempt.resolve();
    await vi.waitFor(() => expect(events).toHaveBeenCalledTimes(2));

    expect(connection?.error).toBeUndefined();

    secondAttempt.resolve();
    laterHeartbeat.resolve();
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

  it('deduplicates live and snapshot recording degradation notices', async () => {
    const session = createMockSession({
      events: async function* recordingDegradedEvents(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield {
          id: 12,
          v: 1,
          type: 'session_recording_degraded',
          data: { sessionId: 'recording-session', reason: 'write_failed' },
        };
        yield {
          id: 13,
          v: 1,
          type: 'session_snapshot',
          data: {
            sessionId: 'recording-session',
            recordingDegraded: true,
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

    expect(blocks.some((block) => block.kind === 'error')).toBe(false);
    expect(notices).toEqual([
      expect.objectContaining({
        id: 'daemon.session_recording_degraded:recording-session',
        severity: 'warning',
        category: 'system',
        operation: 'record_session',
        code: 'daemon.session_recording_degraded',
        recoverable: true,
      }),
    ]);
  });

  it('clears a degraded notice after an authoritative healthy snapshot', async () => {
    const session = createMockSession({
      events: async function* recordingRecoveredEvents() {
        yield {
          id: 14,
          v: 1,
          type: 'session_recording_degraded',
          data: { sessionId: 'recording-session', reason: 'write_failed' },
        };
        yield {
          id: 15,
          v: 1,
          type: 'session_snapshot',
          data: {
            sessionId: 'recording-session',
            recordingDegraded: false,
          },
        };
      },
    });
    sdkMocks.sessions.push(session);
    let notices: readonly DaemonSessionNotice[] = [];

    function Harness() {
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

    expect(notices).toEqual([]);
  });

  it('allows a later degraded snapshot to restore a dismissed notice', async () => {
    const releaseSnapshot = createDeferred<void>();
    const session = createMockSession({
      events: async function* recordingDegradedThenSnapshot() {
        yield {
          id: 14,
          v: 1,
          type: 'session_recording_degraded',
          data: { sessionId: 'recording-session', reason: 'write_failed' },
        };
        await releaseSnapshot.promise;
        yield {
          id: 15,
          v: 1,
          type: 'session_snapshot',
          data: {
            sessionId: 'recording-session',
            recordingDegraded: true,
          },
        };
      },
    });
    sdkMocks.sessions.push(session);
    let notices: readonly DaemonSessionNotice[] = [];
    let dismissNotice: ((id: string) => void) | undefined;

    function Harness() {
      const noticeState = useDaemonSessionNotices();
      notices = noticeState.notices;
      dismissNotice = noticeState.dismissNotice;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      autoReconnect: false,
    });
    await vi.waitFor(() => expect(notices).toHaveLength(1));

    act(() => {
      dismissNotice?.('daemon.session_recording_degraded:recording-session');
    });
    expect(notices).toHaveLength(0);

    await act(async () => {
      releaseSnapshot.resolve();
      await flushPromises();
    });
    await vi.waitFor(() => expect(notices).toHaveLength(1));
    expect(notices[0]).toMatchObject({
      id: 'daemon.session_recording_degraded:recording-session',
      code: 'daemon.session_recording_degraded',
    });
  });

  it('stops reconnect loop on session_closed (user deleted session) even when autoReconnect is true', async () => {
    // When the user deletes a running session, the server publishes
    // session_closed on SSE. The provider must NOT auto-reconnect and
    // create a new session — that would undo the user's delete action.
    sdkMocks.workspaceProviders.mockResolvedValue(
      workspaceProvidersWithReasoningPreview(),
    );
    const session = createMockSession({
      context: vi.fn(async () => sessionContextWithModels('session-1')),
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
    expect(connection?.context).toBeUndefined();
    expect(connection?.reasoning).toBeUndefined();
    // The close must re-project models from the retained provider snapshot:
    // the attached context's models carry no reasoningPreview, so keeping
    // them would drop the welcome preview.
    expect(connection?.models?.[0]?.reasoningPreview).toEqual({
      enabled: true,
      effort: 'xhigh',
      efforts: ['low', 'medium', 'xhigh'],
    });
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
          type: 'session_update',
          data: {
            update: {
              sessionUpdate: 'agent_message_chunk',
              _meta: {
                goalState: {
                  v: 2,
                  activity: 'running',
                  goal: {
                    goalId: 'goal-before-close',
                    revision: 1,
                    objective: 'must disappear',
                    status: 'active',
                    evidenceCursor: { recordId: 'goal-record' },
                    turnCount: 0,
                    activeTimeMs: 0,
                    createdAt: 1,
                    updatedAt: 1,
                  },
                },
              },
            },
          },
        };
        yield {
          id: 2,
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
    expect(connection?.goalState).toBeUndefined();
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
      subagentTranscriptMode: 'summary',
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
      {
        workspaceCwd: '/mock-workspace',
        timeoutMs: 70_000,
        liveReplayMode: 'summary',
      },
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

  it('keeps history pagination disabled when the server does not advertise it', async () => {
    const session = createMockSession({
      sessionId: 'session-history-unsupported',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [
          {
            id: 1,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'complete history' },
                _meta: { 'qwen.session.recordId': 'record-1' },
              },
            },
          },
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;

    function Harness() {
      history = useDaemonTranscriptHistory();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });

    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledWith(
      expect.anything(),
      session.sessionId,
      { workspaceCwd: '/mock-workspace', timeoutMs: 70_000 },
      expect.any(String),
    );
    expect(history?.hasMore).toBe(false);
    await act(async () => history?.loadMore());
    expect(sdkMocks.getSessionTranscriptPage).not.toHaveBeenCalled();
  });

  it('prepends an older transcript page from the first replay record', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const replayEvent = (
      id: number,
      text: string,
      recordId?: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text },
          ...(recordId ? { _meta: { 'qwen.session.recordId': recordId } } : {}),
        },
      },
    });
    const session = createMockSession({
      sessionId: 'session-history-page',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [replayEvent(2, 'recent prompt', 'record-2')],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [replayEvent(1, 'older prompt')],
      hasMore: false,
    });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      history = useDaemonTranscriptHistory();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });
    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledWith(
      expect.anything(),
      session.sessionId,
      {
        workspaceCwd: '/mock-workspace',
        historyPageSize: 25,
        timeoutMs: 70_000,
      },
      expect.any(String),
    );
    expect(history?.hasMore).toBe(true);
    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });

    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledWith(
      session.sessionId,
      {
        beforeRecordId: 'record-2',
        limit: 25,
        clientId: session.clientId,
      },
    );
    expect(
      blocks.map((block) => ('text' in block ? block.text : undefined)),
    ).toEqual(['older prompt', 'recent prompt']);
    expect(history?.hasMore).toBe(false);
  });

  it('counts prepended history pages against the retention byte estimate', async () => {
    // Pagination prepends blocks carrying raw tool payloads; the running
    // retained-bytes estimate must grow with them or later live growth trims
    // against an undercounted counter and exceeds the retention budget.
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const replayEvent = (
      id: number,
      text: string,
      recordId: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text },
          _meta: { 'qwen.session.recordId': recordId },
        },
      },
    });
    const toolEvent = (
      id: number,
      toolCallId: string,
      recordId: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: `Tool ${toolCallId}`,
          status: 'completed',
          rawInput: { payload: 'P'.repeat(100_000) },
          _meta: {
            'qwen.session.recordId': recordId,
            qwenTranscript: { sourceRecordIds: [recordId] },
          },
        },
      },
    });
    const session = createMockSession({
      sessionId: 'session-history-bytes',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [replayEvent(2, 'recent prompt', 'record-2')],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [
        toolEvent(0, 'tool-older-0', 'record-0'),
        toolEvent(1, 'tool-older-1', 'record-1'),
      ],
      hasMore: false,
    });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let retainedBytes = 0;

    function Harness() {
      history = useDaemonTranscriptHistory();
      blocks = useDaemonTranscriptBlocks();
      retainedBytes = useDaemonTranscriptState().retainedBytes;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });
    const retainedBefore = retainedBytes;
    expect(retainedBefore).toBeGreaterThan(0);

    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });

    expect(blocks).toHaveLength(3);
    const expected = blocks.reduce(
      (total, block) => total + estimateDaemonTranscriptBlockBytes(block),
      0,
    );
    expect(retainedBytes).toBeGreaterThan(retainedBefore);
    expect(retainedBytes).toBe(expected);
  });

  it('rejects a history page that would overflow the retention byte budget', async () => {
    // Pagination admission must be byte-budget-aware, not just block-count
    // aware: merging a page that pushes the retained estimate over the
    // budget leaves it over budget while the session is idle, and the next
    // live trim evicts the freshly prepended oldest records, which the
    // exclusive pagination anchor can never re-fetch — a permanent silent
    // gap. The whole page is rejected atomically instead, mirroring the
    // block-cap rejection.
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const replayEvent = (
      id: number,
      text: string,
      recordId: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text },
          _meta: { 'qwen.session.recordId': recordId },
        },
      },
    });
    // ~10 MB estimated per block; 14 of them cross the default 128 MiB
    // retention budget, so admitting the page would overflow it.
    const heavyToolEvent = (id: number, index: number): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: `tool-${index}`,
          title: `Tool ${index}`,
          status: 'completed',
          rawInput: { payload: `page-${index}-` + 'A'.repeat(5_000_000) },
          _meta: {
            'qwen.session.recordId': `record-${index}`,
            qwenTranscript: { sourceRecordIds: [`record-${index}`] },
          },
        },
      },
    });
    const session = createMockSession({
      sessionId: 'session-history-heavy-page',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [replayEvent(20, 'recent prompt', 'record-recent')],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: Array.from({ length: 14 }, (_, index) =>
        heavyToolEvent(index + 1, index),
      ),
      hasMore: true,
    });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let retainedBytes = 0;

    function Harness() {
      history = useDaemonTranscriptHistory();
      blocks = useDaemonTranscriptBlocks();
      retainedBytes = useDaemonTranscriptState().retainedBytes;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });
    const retainedBefore = retainedBytes;
    expect(retainedBefore).toBeGreaterThan(0);
    // The page alone (~140 MB estimated) exceeds the whole 128 MiB byte
    // budget, so it can never be admitted in any occupancy state — a
    // terminal pagination failure rather than a re-openable capacity latch
    // (which would re-offer the same doomed page on every trim and hide
    // everything older than it).
    await act(async () => {
      await expect(history?.loadMore()).rejects.toThrow(
        'Earlier history page exceeds the transcript retention window',
      );
      await flushPromises();
    });

    // Nothing from the page merges, the byte counter is untouched, and the
    // failure latches as a terminal pagination error.
    expect(blocks.filter((block) => block.kind === 'tool')).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect(retainedBytes).toBe(retainedBefore);
    expect(history).toMatchObject({
      hasMore: false,
      loading: false,
      capacityReached: false,
      paginationError: true,
    });
  });

  it('drops fetched transcript events whose records are already displayed', async () => {
    // The pagination anchor can sit inside the retained window (e.g. the
    // daemon's transcript backfill for a live-journal overflow returns the
    // latest recordId), so a fetched page may include records the client
    // already shows. prepend must dedup by sourceRecordId or those records
    // render twice.
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const replayEvent = (
      id: number,
      text: string,
      recordId: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text },
          _meta: {
            'qwen.session.recordId': recordId,
            qwenTranscript: { sourceRecordIds: [recordId] },
          },
        },
      },
    });
    const session = createMockSession({
      sessionId: 'session-history-dedup',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [replayEvent(3, 'displayed prompt', 'record-2')],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    // The page overlaps the retained window: 'record-2' is already
    // displayed; only 'record-1' is genuinely older.
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [
        replayEvent(1, 'older prompt', 'record-1'),
        replayEvent(2, 'displayed prompt', 'record-2'),
      ],
      hasMore: false,
    });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      history = useDaemonTranscriptHistory();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });
    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });

    // 'record-2' is NOT duplicated; only the genuinely older 'record-1'
    // is prepended.
    expect(
      blocks.map((block) => ('text' in block ? block.text : undefined)),
    ).toEqual(['older prompt', 'displayed prompt']);
  });

  it('keeps transient transcript page failures retryable', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const replayEvent = (id: number, text: string): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text },
          _meta: { 'qwen.session.recordId': `record-${id}` },
        },
      },
    });
    const session = createMockSession({
      sessionId: 'session-retry-history-page',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [replayEvent(2, 'recent prompt')],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce({
        v: 1,
        sessionId: session.sessionId,
        events: [replayEvent(1, 'older prompt')],
        hasMore: false,
      });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      history = useDaemonTranscriptHistory();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });
    await act(async () => {
      await expect(history?.loadMore()).rejects.toThrow(
        'temporary network failure',
      );
      await flushPromises();
    });
    expect(history?.hasMore).toBe(true);

    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });

    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledTimes(2);
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenNthCalledWith(
      1,
      session.sessionId,
      {
        beforeRecordId: 'record-2',
        limit: 25,
        clientId: session.clientId,
      },
    );
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenNthCalledWith(
      2,
      session.sessionId,
      {
        beforeRecordId: 'record-2',
        limit: 25,
        clientId: session.clientId,
      },
    );
    expect(
      blocks.map((block) => ('text' in block ? block.text : undefined)),
    ).toEqual(['older prompt', 'recent prompt']);
    expect(history?.hasMore).toBe(false);
  });

  it('latches a non-retryable transcript page failure', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const replayEvent = (id: number, text: string): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text },
          _meta: { 'qwen.session.recordId': `record-${id}` },
        },
      },
    });
    const session = createMockSession({
      sessionId: 'session-forbidden-history-page',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [replayEvent(2, 'recent prompt')],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage.mockRejectedValue(
      new DaemonHttpError(403, undefined, 'Forbidden'),
    );
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
    function Harness() {
      history = useDaemonTranscriptHistory();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });
    await act(async () => {
      await expect(history?.loadMore()).rejects.toThrow('Forbidden');
      await flushPromises();
    });

    expect(history?.paginationError).toBe(true);
    expect(history?.hasMore).toBe(false);

    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledTimes(1);
  });

  it('retries a latched pagination failure when loadMore is forced', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const replayEvent = (id: number, text: string): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text },
          _meta: { 'qwen.session.recordId': `record-${id}` },
        },
      },
    });
    const session = createMockSession({
      sessionId: 'session-retried-history-page',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [replayEvent(2, 'recent prompt')],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage
      .mockRejectedValueOnce(new DaemonHttpError(403, undefined, 'Forbidden'))
      .mockResolvedValueOnce({
        v: 1,
        sessionId: session.sessionId,
        events: [replayEvent(1, 'older prompt')],
        hasMore: false,
      });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
    function Harness() {
      history = useDaemonTranscriptHistory();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });
    await act(async () => {
      await expect(history?.loadMore()).rejects.toThrow('Forbidden');
      await flushPromises();
    });
    expect(history?.paginationError).toBe(true);
    expect(history?.hasMore).toBe(false);

    await act(async () => {
      await history?.loadMore({ force: true });
      await flushPromises();
    });

    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledTimes(2);
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenNthCalledWith(
      2,
      session.sessionId,
      {
        beforeRecordId: 'record-2',
        limit: 25,
        clientId: session.clientId,
      },
    );
    expect(history?.paginationError).toBe(false);
    expect(history?.hasMore).toBe(false);
  });

  it('skips malformed older-page events and advances by record boundary', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const replayEvent = (id: number, text: string): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text },
          _meta: { 'qwen.session.recordId': `record-${id}` },
        },
      },
    });
    const malformedEvent = {
      id: 1,
      v: 1,
      type: 'session_update',
    } as DaemonEvent;
    Object.defineProperty(malformedEvent, 'data', {
      get() {
        throw new Error('malformed history event');
      },
    });
    const session = createMockSession({
      sessionId: 'session-malformed-history-page',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [replayEvent(3, 'recent prompt')],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage
      .mockResolvedValueOnce({
        v: 1,
        sessionId: session.sessionId,
        events: [malformedEvent, replayEvent(2, 'older prompt')],
        nextCursor: 'next-page',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        v: 1,
        sessionId: session.sessionId,
        events: [replayEvent(1, 'oldest prompt')],
        hasMore: false,
      });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let notices: readonly DaemonSessionNotice[] = [];

    function Harness() {
      history = useDaemonTranscriptHistory();
      blocks = useDaemonTranscriptBlocks();
      notices = useDaemonSessionNotices().notices;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });
    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });

    expect(history?.hasMore).toBe(true);
    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });

    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledTimes(2);
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenNthCalledWith(
      2,
      session.sessionId,
      {
        beforeRecordId: 'record-2',
        limit: 25,
        clientId: session.clientId,
      },
    );
    expect(
      blocks.map((block) => ('text' in block ? block.text : undefined)),
    ).toEqual(['oldest prompt', 'older prompt', 'recent prompt']);
    expect(history?.hasMore).toBe(false);
    expect(notices).toContainEqual(
      expect.objectContaining({
        code: 'daemon.replay_event_malformed',
        message: 'Skipped malformed history event',
        debugMessage: 'malformed history event',
      }),
    );
  });

  it('falls back to the server cursor when a page has no record boundary', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const replayEvent = (
      id: number,
      text: string,
      recordId?: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text },
          ...(recordId ? { _meta: { 'qwen.session.recordId': recordId } } : {}),
        },
      },
    });
    const session = createMockSession({
      sessionId: 'session-history-cursor-fallback',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [replayEvent(3, 'recent prompt', 'recent-record')],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage
      .mockResolvedValueOnce({
        v: 1,
        sessionId: session.sessionId,
        events: [replayEvent(2, 'older prompt')],
        nextCursor: 'next-page',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        v: 1,
        sessionId: session.sessionId,
        events: [replayEvent(1, 'oldest prompt')],
        hasMore: false,
      });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;

    function Harness() {
      history = useDaemonTranscriptHistory();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });
    await act(async () => {
      await history?.loadMore();
      await history?.loadMore();
      await flushPromises();
    });

    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenNthCalledWith(
      2,
      session.sessionId,
      {
        cursor: 'next-page',
        limit: 25,
        clientId: session.clientId,
      },
    );
  });

  it('reports a partial older page without changing the transcript', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const replayEvent = (
      id: number,
      text: string,
      recordId?: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text },
          ...(recordId ? { _meta: { 'qwen.session.recordId': recordId } } : {}),
        },
      },
    });
    const session = createMockSession({
      sessionId: 'session-partial-history-page',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [replayEvent(2, 'recent prompt', 'record-2')],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [replayEvent(1, 'partial older prompt')],
      hasMore: false,
      partial: true,
      replayError: 'Replay conversion failed for this page',
    });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];
    let notices: readonly DaemonSessionNotice[] = [];

    function Harness() {
      history = useDaemonTranscriptHistory();
      blocks = useDaemonTranscriptBlocks();
      notices = useDaemonSessionNotices().notices;
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });
    await act(async () => {
      await expect(history?.loadMore()).rejects.toThrow(
        'Replay conversion failed for this page',
      );
      await flushPromises();
    });

    expect(
      blocks.map((block) => ('text' in block ? block.text : undefined)),
    ).toEqual(['recent prompt']);
    expect(history?.hasMore).toBe(false);
    expect(history?.paginationError).toBe(true);
    expect(notices.at(-1)).toBeUndefined();
  });

  it('trims an oversized initial replay to the block cap and re-anchors older pagination', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const event = (
      id: number,
      kind: 'user_message_chunk' | 'agent_message_chunk',
      text: string,
      recordId: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: kind,
          content: { type: 'text', text },
          _meta: {
            'qwen.session.recordId': recordId,
            qwenTranscript: { sourceRecordIds: [recordId] },
          },
        },
      },
    });
    const session = createMockSession({
      sessionId: 'session-oversized-initial-page',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [
          event(1, 'user_message_chunk', 'recent prompt', 'record-1'),
          event(2, 'agent_message_chunk', 'recent answer', 'record-2'),
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [],
      hasMore: false,
    });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      history = useDaemonTranscriptHistory();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
      maxBlocks: 1,
    });

    // The rebuild keeps the most recent blocks within the cap instead of
    // ratcheting the cap up to the replay size (which retained unbounded
    // history and exhausted renderer memory on busy sessions). The trim is
    // surfaced via capacityReached, and the anchor re-bases to the oldest
    // RETAINED record: the pre-trim anchor (record-1) was evicted, and an
    // exclusive anchor pointing at it could never re-fetch the trimmed
    // stretch.
    expect(blocks).toMatchObject([
      { kind: 'assistant', text: 'recent answer' },
    ]);
    expect(history).toMatchObject({
      hasMore: true,
      loading: false,
      capacityReached: true,
    });
    expect(sdkMocks.getSessionTranscriptPage).not.toHaveBeenCalled();

    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledWith(
      session.sessionId,
      {
        beforeRecordId: 'record-2',
        limit: 25,
        clientId: session.clientId,
      },
    );
  });

  it('surfaces capacity and re-anchors pagination when the rebuild count-trims a live session', async () => {
    // Count corner: live (non-restored) sessions report historyHasMore=false,
    // so the capacity latch must not be gated on it — the trimmed stretch is
    // persisted daemon-side and fetchable through pagination. Pre-fix the
    // trim stayed silent (no indicator, no load-older affordance) and the
    // anchor pointed inside the trimmed span.
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const event = (
      id: number,
      kind: 'user_message_chunk' | 'agent_message_chunk',
      text: string,
      recordId: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: kind,
          content: { type: 'text', text },
          _meta: {
            'qwen.session.recordId': recordId,
            qwenTranscript: { sourceRecordIds: [recordId] },
          },
        },
      },
    });
    const session = createMockSession({
      sessionId: 'session-rebuild-count-trim',
      // historyHasMore stays at its false default: live session shape.
      replaySnapshot: {
        compactedReplay: [
          event(1, 'user_message_chunk', 'turn one prompt', 'record-1'),
          event(2, 'agent_message_chunk', 'turn one answer', 'record-2'),
          event(3, 'user_message_chunk', 'turn two prompt', 'record-3'),
          event(4, 'agent_message_chunk', 'turn two answer', 'record-4'),
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [event(0, 'user_message_chunk', 'older prompt', 'record-0')],
      hasMore: false,
    });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      history = useDaemonTranscriptHistory();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
      maxBlocks: 2,
    });

    expect(blocks).toMatchObject([
      { kind: 'user', text: 'turn two prompt' },
      { kind: 'assistant', text: 'turn two answer' },
    ]);
    expect(history).toMatchObject({
      hasMore: true,
      loading: false,
      capacityReached: true,
    });

    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });
    // Anchored at the oldest RETAINED record, not the evicted pre-trim one
    // (record-1): pagination is exclusive of the anchor. The page does not
    // fit the saturated window, so the atomic rejection re-latches.
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledWith(
      session.sessionId,
      {
        beforeRecordId: 'record-3',
        limit: 25,
        clientId: session.clientId,
      },
    );
    expect(history).toMatchObject({
      hasMore: false,
      loading: false,
      capacityReached: true,
    });
  });

  it('surfaces capacity and re-anchors when the rebuild trims on the byte budget', async () => {
    // Byte corner: the rebuild store runs under the default 128 MiB budget.
    // Two heavy replay blocks cross it INSIDE the block cap, so a
    // count-only saturation check never fires; the eviction is observable
    // only through the truncation listener.
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    // ~90 MB estimated per block; the second crosses the 128 MiB budget.
    const heavyToolEvent = (id: number, recordId: string): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: recordId,
          title: `Heavy ${recordId}`,
          status: 'completed',
          rawInput: { payload: 'A'.repeat(45_000_000) },
          _meta: {
            'qwen.session.recordId': recordId,
            qwenTranscript: { sourceRecordIds: [recordId] },
          },
        },
      },
    });
    const session = createMockSession({
      sessionId: 'session-rebuild-byte-trim',
      replaySnapshot: {
        compactedReplay: [
          heavyToolEvent(1, 'record-heavy-0'),
          heavyToolEvent(2, 'record-heavy-1'),
          {
            id: 3,
            v: 1,
            type: 'session_update',
            data: {
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'recent prompt' },
                _meta: { 'qwen.session.recordId': 'record-recent' },
              },
            },
          },
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [],
      hasMore: false,
    });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      history = useDaemonTranscriptHistory();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
    });

    // The oldest heavy block was evicted mid-rebuild while the block count
    // stayed far below the cap...
    expect(blocks.filter((block) => block.kind === 'tool')).toHaveLength(1);
    expect(blocks).toMatchObject([
      { kind: 'tool' },
      { kind: 'user', text: 'recent prompt' },
    ]);
    // ...and the trim surfaced with the anchor re-based to the oldest
    // retained record.
    expect(history).toMatchObject({
      hasMore: true,
      loading: false,
      capacityReached: true,
    });

    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledWith(
      session.sessionId,
      {
        beforeRecordId: 'record-heavy-1',
        limit: 25,
        clientId: session.clientId,
      },
    );
  });

  it('grows the latched rejected-page footprint by a re-anchoring trim’s evicted band and keeps the latch closed', async () => {
    // A byte-budget rejection stores the rejected page's footprint. A later
    // re-anchoring eviction trim re-serves the evicted band on the next fetch,
    // so the latched footprint must grow by that band; when the grown page no
    // longer fits, the latch stays closed (no fetch/reject churn, no spurious
    // terminal failure).
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const replayEvent = (
      id: number,
      kind: 'user_message_chunk' | 'agent_message_chunk',
      text: string,
      recordId: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: kind,
          content: { type: 'text', text },
          _meta: {
            'qwen.session.recordId': recordId,
            qwenTranscript: { sourceRecordIds: [recordId] },
          },
        },
      },
    });
    const liveGate = createDeferred<void>();
    const session = createMockSession({
      sessionId: 'session-live-trim-anchor',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [
          replayEvent(1, 'user_message_chunk', 'a'.repeat(1100), 'record-1'),
          replayEvent(2, 'agent_message_chunk', 'b'.repeat(100), 'record-2'),
        ],
        liveJournal: [],
      },
      events: async function* liveEventsAfterGate(
        opts: { signal?: AbortSignal } = {},
      ) {
        await Promise.race([
          liveGate.promise,
          new Promise<void>((resolve) => {
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          }),
        ]);
        if (opts.signal?.aborted) return;
        yield replayEvent(
          3,
          'user_message_chunk',
          'z'.repeat(450),
          'record-live-1',
        );
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
    sdkMocks.sessions.push(session);
    const olderPage = {
      v: 1 as const,
      sessionId: session.sessionId,
      events: [
        replayEvent(10, 'user_message_chunk', 'p'.repeat(400), 'record-a'),
      ],
      hasMore: false,
    };
    sdkMocks.getSessionTranscriptPage.mockResolvedValue(olderPage);
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      history = useDaemonTranscriptHistory();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
      maxBlocks: 8,
      maxRetainedBytes: 3600,
    });

    // The page alone fits the budget, but not on top of the current window:
    // rejected, with its footprint recorded.
    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });
    expect(blocks.map((block) => block.sourceRecordIds?.[0])).toEqual([
      'record-1',
      'record-2',
    ]);
    expect(history).toMatchObject({
      hasMore: false,
      loading: false,
      capacityReached: true,
    });
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledTimes(1);

    // Live growth crosses the budget; the trim evicts record-1 and re-anchors
    // to record-2. A faithful daemon re-serves the evicted record-1 on the next
    // exclusive-before fetch (it is persisted and now before the anchor), so
    // the re-anchored page is record-1 + record-a — larger than the latched
    // footprint. The fix grows the latched footprint by the evicted band, so the
    // re-open gate sees that grown page no longer fits and keeps the latch
    // closed instead of re-opening into a fetch/reject churn (or misclassifying
    // the now-larger page as a terminal failure).
    await act(async () => {
      liveGate.resolve();
      await flushTranscriptDispatch();
    });
    expect(history).toMatchObject({
      hasMore: false,
      loading: false,
      capacityReached: true,
      paginationError: false,
    });
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledTimes(1);
  });

  it('keeps the capacity latch closed on live trims when pagination is unavailable', async () => {
    // The eviction re-open of the load-older affordance must apply the same
    // gates as the sibling paths: without the pagination feature (or without
    // an anchor) a re-opened affordance would call a route the daemon does
    // not serve and latch a pagination error instead of the terminal
    // capacity state.
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: [],
    });
    const chunk = (
      id: number,
      kind: 'user_message_chunk' | 'agent_message_chunk',
      text: string,
      recordId: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: kind,
          content: { type: 'text', text },
          _meta: {
            'qwen.session.recordId': recordId,
            qwenTranscript: { sourceRecordIds: [recordId] },
          },
        },
      },
    });
    const liveGate = createDeferred<void>();
    const session = createMockSession({
      sessionId: 'session-latch-no-pagination',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [
          chunk(1, 'user_message_chunk', 'replay prompt', 'record-1'),
          chunk(2, 'agent_message_chunk', 'replay answer', 'record-2'),
        ],
        liveJournal: [],
      },
      events: async function* liveEventAfterGate(
        opts: { signal?: AbortSignal } = {},
      ) {
        await Promise.race([
          liveGate.promise,
          new Promise<void>((resolve) => {
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          }),
        ]);
        if (opts.signal?.aborted) return;
        yield chunk(3, 'user_message_chunk', 'live one', 'record-live-1');
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
    sdkMocks.sessions.push(session);
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;

    function Harness() {
      history = useDaemonTranscriptHistory();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
      maxBlocks: 2,
    });

    // Saturated replay on a non-pagination daemon latches the capacity
    // state with the affordance closed.
    expect(history).toMatchObject({
      hasMore: false,
      loading: false,
      capacityReached: true,
    });

    // Live growth count-trims; the re-open must stay gated.
    await act(async () => {
      liveGate.resolve();
      await flushTranscriptDispatch();
    });
    expect(history).toMatchObject({
      hasMore: false,
      loading: false,
      capacityReached: true,
    });
    expect(sdkMocks.getSessionTranscriptPage).not.toHaveBeenCalled();
  });

  it('drops an in-flight history page when a trim re-anchors pagination mid-fetch', async () => {
    // A byte/count trim firing while a load-older page is in flight
    // re-anchors the exclusive `beforeRecordId`; merging the stale page
    // afterwards would advance the anchor below the evicted band and make
    // evicted-but-persisted records unreachable. The page must be dropped
    // losslessly instead.
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const chunk = (
      id: number,
      kind: 'user_message_chunk' | 'agent_message_chunk',
      text: string,
      recordId: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: kind,
          content: { type: 'text', text },
          _meta: {
            'qwen.session.recordId': recordId,
            qwenTranscript: { sourceRecordIds: [recordId] },
          },
        },
      },
    });
    const firstLiveGate = createDeferred<void>();
    const secondLiveGate = createDeferred<void>();
    const session = createMockSession({
      sessionId: 'session-inflight-page-trim',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [
          chunk(1, 'user_message_chunk', 'replay prompt', 'record-1'),
          chunk(2, 'agent_message_chunk', 'replay answer', 'record-2'),
        ],
        liveJournal: [],
      },
      events: async function* liveEventsAfterGates(
        opts: { signal?: AbortSignal } = {},
      ) {
        await Promise.race([
          firstLiveGate.promise,
          new Promise<void>((resolve) => {
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          }),
        ]);
        if (opts.signal?.aborted) return;
        yield chunk(3, 'user_message_chunk', 'live one', 'record-live-1');
        await Promise.race([
          secondLiveGate.promise,
          new Promise<void>((resolve) => {
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          }),
        ]);
        if (opts.signal?.aborted) return;
        yield chunk(4, 'agent_message_chunk', 'live two', 'record-live-2');
        yield chunk(5, 'user_message_chunk', 'live three', 'record-live-3');
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
    sdkMocks.sessions.push(session);
    // Page 1 merges (window 3 of 4, still paging room); page 2 resolves
    // only when the test triggers it — after the mid-fetch trim.
    const stalePage = createDeferred<{
      v: 1;
      sessionId: string;
      events: DaemonEvent[];
      hasMore: boolean;
    }>();
    sdkMocks.getSessionTranscriptPage
      .mockResolvedValueOnce({
        v: 1,
        sessionId: session.sessionId,
        events: [chunk(10, 'user_message_chunk', 'older prompt', 'record-a')],
        hasMore: true,
      })
      .mockReturnValueOnce(stalePage.promise)
      .mockResolvedValueOnce({
        v: 1,
        sessionId: session.sessionId,
        events: [],
        hasMore: false,
      });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      history = useDaemonTranscriptHistory();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
      maxBlocks: 4,
    });

    // Admit the older page; the window is 3 of 4, paging stays available.
    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });
    expect(blocks.map((block) => block.sourceRecordIds?.[0])).toEqual([
      'record-a',
      'record-1',
      'record-2',
    ]);
    expect(history).toMatchObject({
      hasMore: true,
      loading: false,
      capacityReached: false,
    });

    // One live block fills the window (4 of 4)...
    await act(async () => {
      firstLiveGate.resolve();
      await flushTranscriptDispatch();
    });

    // ...then the next fetch (against record-a, the merged page's oldest
    // record) starts, still in flight...
    let pendingLoad: Promise<void> | undefined;
    await act(async () => {
      pendingLoad = history?.loadMore();
      await flushPromises();
    });
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenNthCalledWith(
      2,
      session.sessionId,
      {
        beforeRecordId: 'record-a',
        limit: 25,
        clientId: session.clientId,
      },
    );

    // ...while two more live blocks overflow the window; the trim evicts
    // record-a AND record-1, re-anchoring to record-2.
    await act(async () => {
      secondLiveGate.resolve();
      await flushTranscriptDispatch();
    });

    // The stale page (fetched against the evicted record-a anchor) now
    // resolves; it must be dropped, not merged.
    await act(async () => {
      stalePage.resolve({
        v: 1,
        sessionId: session.sessionId,
        events: [chunk(11, 'agent_message_chunk', 'older answer', 'record-b')],
        hasMore: true,
      });
      await pendingLoad;
      await flushPromises();
    });
    expect(blocks.map((block) => block.sourceRecordIds?.[0])).toEqual([
      'record-2',
      'record-live-1',
      'record-live-2',
      'record-live-3',
    ]);
    expect(history).toMatchObject({
      hasMore: true,
      loading: false,
    });

    // A retry fetches against the re-anchored anchor; nothing was lost.
    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenNthCalledWith(
      3,
      session.sessionId,
      {
        beforeRecordId: 'record-2',
        limit: 25,
        clientId: session.clientId,
      },
    );
  });

  it('does not churn fetch/reject while count-saturated trims leave zero headroom', async () => {
    // A count trim restores the window to exactly maxBlocks, so a rejected
    // page still cannot fit afterwards; the eviction re-open must stay gated
    // on admission headroom instead of re-offering the doomed page on every
    // live block.
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const chunk = (
      id: number,
      kind: 'user_message_chunk' | 'agent_message_chunk',
      text: string,
      recordId: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: kind,
          content: { type: 'text', text },
          _meta: {
            'qwen.session.recordId': recordId,
            qwenTranscript: { sourceRecordIds: [recordId] },
          },
        },
      },
    });
    const liveGate = createDeferred<void>();
    const session = createMockSession({
      sessionId: 'session-churn-guard',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [
          chunk(1, 'user_message_chunk', 'replay prompt', 'record-1'),
          chunk(2, 'agent_message_chunk', 'replay answer', 'record-2'),
        ],
        liveJournal: [],
      },
      events: async function* liveEventAfterGate(
        opts: { signal?: AbortSignal } = {},
      ) {
        await Promise.race([
          liveGate.promise,
          new Promise<void>((resolve) => {
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          }),
        ]);
        if (opts.signal?.aborted) return;
        yield chunk(3, 'user_message_chunk', 'live one', 'record-live-1');
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
    sdkMocks.sessions.push(session);
    // A single-block page cannot join the saturated 2/2 window (count), but a
    // lone block is below the block cap, so it routes to the re-openable
    // latch rather than the terminal branch; the latch records its footprint.
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [chunk(10, 'user_message_chunk', 'older prompt', 'record-a')],
      hasMore: true,
    });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;

    function Harness() {
      history = useDaemonTranscriptHistory();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
      maxBlocks: 2,
    });

    // The two-block page cannot join the saturated 2/2 window; the latch
    // records its footprint.
    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });
    expect(history).toMatchObject({
      hasMore: false,
      loading: false,
      capacityReached: true,
    });
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledTimes(1);

    // Live growth count-trims back to exactly maxBlocks — zero headroom —
    // so the latch must NOT re-open into another doomed fetch.
    await act(async () => {
      liveGate.resolve();
      await flushTranscriptDispatch();
    });
    expect(history).toMatchObject({
      hasMore: false,
      loading: false,
      capacityReached: true,
    });
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledTimes(1);
  });

  it('keeps the capacity latch while the freed hole is smaller than the rejected page', async () => {
    // A byte-budget rejection must not be re-offered on every later trim:
    // trimming stops as soon as the estimate is back under budget, so the
    // freed hole is typically smaller than the rejected page. The re-open
    // gate checks the rejected footprint against the post-trim occupancy.
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const chunk = (
      id: number,
      kind: 'user_message_chunk' | 'agent_message_chunk',
      text: string,
      recordId: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: kind,
          content: { type: 'text', text },
          _meta: {
            'qwen.session.recordId': recordId,
            qwenTranscript: { sourceRecordIds: [recordId] },
          },
        },
      },
    });
    const liveGate = createDeferred<void>();
    const session = createMockSession({
      sessionId: 'session-byte-hole-guard',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [
          chunk(1, 'user_message_chunk', 'replay prompt', 'record-1'),
        ],
        liveJournal: [],
      },
      events: async function* liveEventAfterGate(
        opts: { signal?: AbortSignal } = {},
      ) {
        await Promise.race([
          liveGate.promise,
          new Promise<void>((resolve) => {
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          }),
        ]);
        if (opts.signal?.aborted) return;
        yield chunk(3, 'user_message_chunk', 'z'.repeat(1800), 'record-live-1');
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
    sdkMocks.sessions.push(session);
    // Page estimate lands between "current + page over budget" and "page
    // alone over budget": rejectable, but not terminally impossible.
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [chunk(10, 'user_message_chunk', 'y'.repeat(1700), 'record-a')],
      hasMore: true,
    });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;

    function Harness() {
      history = useDaemonTranscriptHistory();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
      maxBlocks: 8,
      maxRetainedBytes: 3900,
    });

    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });
    expect(history).toMatchObject({
      hasMore: false,
      loading: false,
      capacityReached: true,
      paginationError: false,
    });
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledTimes(1);

    // Live growth crosses the budget; the trim evicts the small replay
    // block, freeing far less than the rejected page's footprint, so the
    // latch must stay closed.
    await act(async () => {
      liveGate.resolve();
      await flushTranscriptDispatch();
    });
    expect(history).toMatchObject({
      hasMore: false,
      loading: false,
      capacityReached: true,
      paginationError: false,
    });
    expect(sdkMocks.getSessionTranscriptPage).toHaveBeenCalledTimes(1);
  });

  it('fails terminally when a single history page exceeds the retention budget', async () => {
    // A page that alone exceeds the whole byte budget can never be admitted
    // in any window state; re-offering it forever would hide everything
    // older than it. Surface a terminal pagination failure instead.
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const chunk = (
      id: number,
      kind: 'user_message_chunk' | 'agent_message_chunk',
      text: string,
      recordId: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: kind,
          content: { type: 'text', text },
          _meta: {
            'qwen.session.recordId': recordId,
            qwenTranscript: { sourceRecordIds: [recordId] },
          },
        },
      },
    });
    const session = createMockSession({
      sessionId: 'session-oversized-page',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [
          chunk(1, 'user_message_chunk', 'replay prompt', 'record-1'),
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [chunk(10, 'user_message_chunk', 'y'.repeat(600), 'record-a')],
      hasMore: true,
    });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;

    function Harness() {
      history = useDaemonTranscriptHistory();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
      maxBlocks: 8,
      maxRetainedBytes: 1000,
    });

    await act(async () => {
      await expect(history?.loadMore()).rejects.toThrow(
        'Earlier history page exceeds the transcript retention window',
      );
      await flushPromises();
    });
    expect(history).toMatchObject({
      hasMore: false,
      loading: false,
      capacityReached: false,
      paginationError: true,
    });
  });

  it('releases the replay snapshot after injection and never raises the block cap', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: [],
    });
    const chunk = (
      id: number,
      kind: 'user_message_chunk' | 'agent_message_chunk',
      text: string,
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: kind,
          content: { type: 'text', text },
        },
      },
    });
    const session = createMockSession({
      sessionId: 'session-consume-replay',
      lastEventId: 3,
      replaySnapshot: {
        compactedReplay: [
          chunk(1, 'user_message_chunk', 'replayed prompt'),
          chunk(2, 'agent_message_chunk', 'replayed answer'),
          {
            id: 3,
            v: 1,
            type: 'turn_complete',
            data: { stopReason: 'end_turn' },
          },
        ],
        liveJournal: [],
      },
      events: async function* oneLiveEventThenIdle(
        opts: { signal?: AbortSignal } = {},
      ) {
        yield chunk(4, 'user_message_chunk', 'live follow-up');
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
    sdkMocks.sessions.push(session);
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      maxBlocks: 1,
    });
    await act(async () => {
      await vi.waitFor(() =>
        expect(blocks).toMatchObject([
          { kind: 'user', text: 'live follow-up' },
        ]),
      );
    });

    // The oversized replay was trimmed to the cap on injection...
    expect(blocks).toHaveLength(1);
    // ...the raw snapshot was released from the session client...
    expect(session.consumeReplaySnapshot).toHaveBeenCalledTimes(1);
    expect(session.replaySnapshot.compactedReplay).toHaveLength(0);
    expect(session.replaySnapshot.liveJournal).toHaveLength(0);
    // ...and later live growth still trims at the configured cap, i.e. the
    // replay did not ratchet maxBlocks up to its own size.
  });

  it('rejects a terminal older page that does not fit atomically', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: ['session_transcript_pagination'],
    });
    const replayEvent = (
      id: number,
      text: string,
      recordId?: string,
      kind: 'user_message_chunk' | 'agent_message_chunk' = 'user_message_chunk',
    ): DaemonEvent => ({
      id,
      v: 1,
      type: 'session_update',
      data: {
        update: {
          sessionUpdate: kind,
          content: { type: 'text', text },
          ...(recordId ? { _meta: { 'qwen.session.recordId': recordId } } : {}),
        },
      },
    });
    const session = createMockSession({
      sessionId: 'session-history-capacity',
      historyHasMore: true,
      replaySnapshot: {
        compactedReplay: [
          replayEvent(1, 'replay prompt', 'record-1'),
          replayEvent(2, 'replay answer', 'record-2', 'agent_message_chunk'),
        ],
        liveJournal: [],
      },
    });
    sdkMocks.sessions.push(session);
    // Three older blocks (alternating kinds so they do not merge): with the
    // two retained blocks they overflow the cap (2 + 3 > 4), but the page
    // alone is below the cap, so it is rejected atomically into the
    // re-openable latch rather than partially prepended.
    sdkMocks.getSessionTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: session.sessionId,
      events: [
        replayEvent(10, 'older prompt'),
        replayEvent(11, 'older answer', undefined, 'agent_message_chunk'),
        replayEvent(12, 'older follow-up'),
      ],
      hasMore: false,
    });
    let history: ReturnType<typeof useDaemonTranscriptHistory> | undefined;
    let blocks: readonly DaemonTranscriptBlock[] = [];

    function Harness() {
      history = useDaemonTranscriptHistory();
      blocks = useDaemonTranscriptBlocks();
      return null;
    }

    // maxBlocks 4 keeps the 3-block page below the cap (so the rejection is
    // count-based, not the terminal impossible branch) while the merged total
    // still overflows the cap.
    await renderWithProvider(<Harness />, {
      autoConnect: true,
      historyPageSize: 25,
      maxBlocks: 4,
    });
    await act(async () => {
      await history?.loadMore();
      await flushPromises();
    });

    expect(history).toMatchObject({
      hasMore: false,
      loading: false,
      capacityReached: true,
    });
    expect(blocks).toMatchObject([
      { kind: 'user', text: 'replay prompt' },
      { kind: 'assistant', text: 'replay answer' },
    ]);
  });

  it('uses a full load for a legacy controlled clientId rebind', async () => {
    sdkMocks.capabilities.mockResolvedValue({
      workspaceCwd: '/mock-workspace',
      features: [],
    });
    sdkMocks.sessions.push(
      createMockSession({
        sessionId: 'session-a',
        clientId: 'client-a',
        replaySnapshot: createTextReplaySnapshot('A transcript'),
      }),
    );
    let actions: DaemonSessionActions | undefined;

    function Harness() {
      actions = useDaemonActions();
      useDaemonConnection();
      return null;
    }

    await renderWithProvider(<Harness />, {
      autoConnect: true,
      sessionId: 'session-a',
      clientId: 'client-a',
      subagentTranscriptMode: 'summary',
    });
    sdkMocks.MockDaemonSessionClient.resume.mockResolvedValueOnce(
      createMockSession({
        sessionId: 'session-a',
        clientId: 'client-a',
        lastEventId: 2,
      }),
    );
    let resume!: Promise<void>;
    act(() => {
      resume = requireActions(actions).resumeSession('session-a');
    });
    await act(async () => flushPromises());
    await expect(resume).resolves.toBeUndefined();
    expect(
      sdkMocks.MockDaemonSessionClient.resume.mock.calls[0]?.[2],
    ).not.toHaveProperty('liveReplayMode');
    sdkMocks.MockDaemonSessionClient.load.mockClear();
    sdkMocks.MockDaemonSessionClient.resume.mockClear();
    sdkMocks.MockDaemonSessionClient.load.mockResolvedValueOnce(
      createMockSession({
        sessionId: 'session-a',
        clientId: 'client-b',
        replaySnapshot: createTextReplaySnapshot('reloaded transcript'),
      }),
    );

    await act(async () => {
      root?.render(
        <DaemonSessionProvider
          baseUrl="http://127.0.0.1:4170"
          autoConnect
          sessionId="session-a"
          clientId="client-b"
        >
          <Harness />
        </DaemonSessionProvider>,
      );
      await flushPromises();
    });

    expect(sdkMocks.MockDaemonSessionClient.resume).not.toHaveBeenCalled();
    expect(sdkMocks.MockDaemonSessionClient.load).toHaveBeenCalledOnce();
    expect(sdkMocks.MockDaemonSessionClient.load.mock.calls[0]?.[3]).toBe(
      'client-b',
    );
  });

  it('publishes authoritative prompt settlements once after terminal transcript commit', async () => {
    const delivered = createDeferred<void>();
    let blocksAtDelivery: readonly DaemonTranscriptBlock[] = [];
    const listener = vi.fn((_event: DaemonPromptSettledEvent) => {
      blocksAtDelivery = store?.getSnapshot().blocks ?? [];
      delivered.resolve();
    });
    const terminal: DaemonEvent = {
      id: 4,
      v: 1,
      type: 'turn_complete',
      promptId: 'prompt-live',
      data: { promptId: 'prompt-live', stopReason: 'end_turn' },
    };
    sdkMocks.sessions.push(
      createMockSession({
        events: async function* settlementEvents() {
          yield {
            id: 1,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-live',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'before tool' },
              },
            },
          } satisfies DaemonEvent;
          yield {
            id: 2,
            v: 1,
            type: 'session_update',
            promptId: 'prompt-live',
            data: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'final answer' },
              },
            },
          } satisfies DaemonEvent;
          yield terminal;
          yield terminal;
        },
      }),
    );
    let store: DaemonTranscriptStore | undefined;

    function Harness() {
      store = useDaemonTranscriptStore();
      useDaemonPromptSettled(listener);
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await delivered.promise;
      await flushPromises();
    });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      sessionId: 'session-1',
      promptId: 'prompt-live',
      outcome: 'completed',
      stopReason: 'end_turn',
      eventId: 4,
      transcriptComplete: true,
    });
    expect(blocksAtDelivery).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assistant',
          text: 'before toolfinal answer',
          streaming: false,
          promptId: 'prompt-live',
        }),
      ]),
    );
    expect(store?.getSnapshot().blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assistant',
          text: 'before toolfinal answer',
          streaming: false,
          promptId: 'prompt-live',
        }),
      ]),
    );
  });

  it('bounds prompt settlement duplicate retention', async () => {
    const continueAfterBoundary = createDeferred<void>();
    const streamCompleted = createDeferred<void>();
    sdkMocks.sessions.push(
      createMockSession({
        events: async function* manyTerminalEvents() {
          for (let index = 0; index < 1024; index += 1) {
            yield {
              id: index + 1,
              v: 1,
              type: 'turn_complete',
              promptId: `prompt-${index}`,
              data: {
                promptId: `prompt-${index}`,
                stopReason: 'end_turn',
              },
            } satisfies DaemonEvent;
          }
          yield {
            id: 1025,
            v: 1,
            type: 'turn_complete',
            promptId: 'prompt-0',
            data: { promptId: 'prompt-0', stopReason: 'end_turn' },
          } satisfies DaemonEvent;
          await continueAfterBoundary.promise;
          yield {
            id: 1026,
            v: 1,
            type: 'turn_complete',
            promptId: 'prompt-1024',
            data: { promptId: 'prompt-1024', stopReason: 'end_turn' },
          } satisfies DaemonEvent;
          yield {
            id: 1027,
            v: 1,
            type: 'turn_complete',
            promptId: 'prompt-0',
            data: { promptId: 'prompt-0', stopReason: 'end_turn' },
          } satisfies DaemonEvent;
          yield {
            id: 1028,
            v: 1,
            type: 'turn_complete',
            promptId: 'prompt-1024',
            data: { promptId: 'prompt-1024', stopReason: 'end_turn' },
          } satisfies DaemonEvent;
          yield {
            id: 1029,
            v: 1,
            type: 'turn_complete',
            promptId: 'prompt-1023',
            data: { promptId: 'prompt-1023', stopReason: 'end_turn' },
          } satisfies DaemonEvent;
          streamCompleted.resolve();
        },
      }),
    );
    const settlements: DaemonPromptSettledEvent[] = [];

    function Harness() {
      useDaemonPromptSettled((event) => settlements.push(event));
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await vi.waitFor(() => expect(settlements).toHaveLength(1024));
      await flushPromises();
    });
    expect(
      settlements.filter((event) => event.promptId === 'prompt-0'),
    ).toHaveLength(1);

    await act(async () => {
      continueAfterBoundary.resolve();
      await streamCompleted.promise;
      await flushPromises();
    });

    expect(settlements).toHaveLength(1026);
    expect(
      settlements.filter((event) => event.promptId === 'prompt-0'),
    ).toHaveLength(2);
    expect(
      settlements.filter((event) => event.promptId === 'prompt-1024'),
    ).toHaveLength(1);
    expect(
      settlements.filter((event) => event.promptId === 'prompt-1023'),
    ).toHaveLength(1);
  });

  it('isolates prompt settlement listener failures', async () => {
    const delivered = createDeferred<void>();
    const failingListener = vi.fn(() => {
      if (failingListener.mock.calls.length === 1) {
        throw new Error('host callback failed');
      }
    });
    const healthyListener = vi.fn(() => {
      if (healthyListener.mock.calls.length === 2) delivered.resolve();
    });
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    sdkMocks.sessions.push(
      createMockSession({
        events: async function* terminalEvent() {
          yield {
            id: 1,
            v: 1,
            type: 'turn_complete',
            promptId: 'prompt-live',
            data: { promptId: 'prompt-live', stopReason: 'end_turn' },
          } satisfies DaemonEvent;
          yield {
            id: 2,
            v: 1,
            type: 'turn_complete',
            promptId: 'prompt-next',
            data: { promptId: 'prompt-next', stopReason: 'end_turn' },
          } satisfies DaemonEvent;
        },
      }),
    );

    function Harness() {
      useDaemonPromptSettled(failingListener);
      useDaemonPromptSettled(healthyListener);
      return null;
    }

    try {
      await renderWithProvider(<Harness />, { autoConnect: true });
      await act(async () => {
        await delivered.promise;
        await flushPromises();
      });

      expect(failingListener).toHaveBeenCalledTimes(2);
      expect(healthyListener).toHaveBeenCalledTimes(2);
      expect(consoleError).toHaveBeenCalledWith(
        '[DaemonSessionProvider] prompt settlement listener failed',
        expect.objectContaining({ message: 'host callback failed' }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('publishes failed and confirmed cancelled settlements but not waits, cancellation requests, or history replay', async () => {
    const terminalsDelivered = createDeferred<void>();
    const listener = vi.fn((event: DaemonPromptSettledEvent) => {
      if (event.outcome === 'cancelled') terminalsDelivered.resolve();
    });
    sdkMocks.sessions.push(
      createMockSession({
        replaySnapshot: {
          compactedReplay: [
            {
              id: 1,
              v: 1,
              type: 'turn_complete',
              promptId: 'prompt-history',
              data: { promptId: 'prompt-history', stopReason: 'end_turn' },
            },
          ],
          liveJournal: [],
        },
        events: async function* failureEvents() {
          yield {
            id: 2,
            v: 1,
            type: 'permission_request',
            promptId: 'prompt-waiting',
            data: {
              requestId: 'permission-1',
              sessionId: 'session-1',
              title: 'Ask user 1 question',
              toolCall: {
                toolCallId: 'tool-1',
                rawInput: { questions: [] },
              },
              options: [],
            },
          } satisfies DaemonEvent;
          yield {
            id: 3,
            v: 1,
            type: 'prompt_cancelled',
            data: { sessionId: 'session-1', reason: 'user_cancel' },
          } satisfies DaemonEvent;
          yield {
            id: 4,
            v: 1,
            type: 'turn_error',
            promptId: 'prompt-failed',
            data: {
              promptId: 'prompt-failed',
              message: 'model unavailable',
              code: 'model_error',
            },
          } satisfies DaemonEvent;
          yield {
            id: 5,
            v: 1,
            type: 'turn_complete',
            promptId: 'prompt-cancelled',
            data: {
              promptId: 'prompt-cancelled',
              stopReason: 'cancelled',
            },
          } satisfies DaemonEvent;
        },
      }),
    );

    function Harness() {
      useDaemonPromptSettled(listener);
      return null;
    }

    await renderWithProvider(<Harness />, { autoConnect: true });
    await act(async () => {
      await terminalsDelivered.promise;
      await flushPromises();
    });

    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      {
        sessionId: 'session-1',
        promptId: 'prompt-failed',
        outcome: 'failed',
        eventId: 4,
        transcriptComplete: true,
        error: { message: 'model unavailable', code: 'model_error' },
      },
      {
        sessionId: 'session-1',
        promptId: 'prompt-cancelled',
        outcome: 'cancelled',
        stopReason: 'cancelled',
        eventId: 5,
        transcriptComplete: true,
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

function reasoningConfigOptions(currentValue: string): unknown[] {
  return [
    {
      id: 'reasoning_effort',
      currentValue,
      options: [
        { value: 'none' },
        { value: 'low' },
        { value: 'medium' },
        { value: 'xhigh' },
      ],
      _meta: {
        'qwenCode/reasoning': { defaultEffort: 'xhigh' },
      },
    },
  ];
}

function workspaceProvidersWithReasoningPreview() {
  return {
    v: 1,
    workspaceCwd: '/mock-workspace',
    initialized: true,
    current: { modelId: 'qwen3.8-max' },
    providers: [
      {
        kind: 'model_provider',
        status: 'ok',
        authType: 'qwen-oauth',
        current: true,
        models: [
          {
            modelId: 'qwen3.8-max',
            baseModelId: 'qwen3.8-max',
            name: 'Qwen 3.8 Max',
            isCurrent: true,
            isRuntime: false,
            configOptions: reasoningConfigOptions('xhigh'),
          },
        ],
      },
    ],
  };
}

function sessionContextWithModels(sessionId: string) {
  return {
    v: 1 as const,
    sessionId,
    workspaceCwd: '/mock-workspace',
    state: {
      models: {
        currentModelId: 'qwen3.8-max',
        availableModels: [
          {
            modelId: 'qwen3.8-max',
            baseModelId: 'qwen3.8-max',
            name: 'Qwen 3.8 Max',
            contextLimit: 131_072,
          },
        ],
      },
    },
  };
}

function createMockSession(opts: Partial<MockSession> = {}): MockSession {
  const session: MockSession = {
    sessionId: opts.sessionId ?? 'session-1',
    workspaceCwd: opts.workspaceCwd ?? '/mock-workspace',
    clientId: opts.clientId ?? 'client-1',
    state: opts.state ?? {},
    hasActivePrompt: opts.hasActivePrompt ?? false,
    historyHasMore: opts.historyHasMore ?? false,
    historyAnchorRecordId: opts.historyAnchorRecordId,
    replayDegraded: opts.replayDegraded ?? false,
    replaySnapshotComplete: opts.replaySnapshotComplete ?? true,
    replayPartial: opts.replayPartial ?? false,
    replayError: opts.replayError,
    eventEpoch: opts.eventEpoch ?? 'epoch-1',
    session:
      opts.session ??
      ({
        sessionId: opts.sessionId ?? 'session-1',
        workspaceCwd: opts.workspaceCwd ?? '/mock-workspace',
        sourceType: 'default',
      } as Record<string, unknown>),
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
    removeMidTurnMessage:
      opts.removeMidTurnMessage ?? vi.fn(async () => ({ removed: true })),
    cancel: opts.cancel ?? vi.fn(async () => {}),
    setModel:
      opts.setModel ??
      vi.fn(async (modelId: string) => ({
        modelId,
      })),
    heartbeat: opts.heartbeat ?? vi.fn(async () => ({ ok: true })),
    shellCommand: opts.shellCommand ?? vi.fn(async () => undefined),
    goal:
      opts.goal ??
      vi.fn(async () => ({
        snapshot: { v: 2 as const, goal: null, activity: 'idle' as const },
      })),
    controlGoal:
      opts.controlGoal ??
      vi.fn(async () => ({
        snapshot: { v: 2 as const, goal: null, activity: 'idle' as const },
      })),
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
    getTranscriptPage:
      opts.getTranscriptPage ??
      vi.fn(async (pageOpts: unknown) => {
        if (!session.client) throw new Error('Session client is unavailable');
        return (await session.client.getSessionTranscriptPage(
          session.sessionId,
          pageOpts,
        )) as {
          events: DaemonEvent[];
          hasMore: boolean;
          nextCursor?: string;
          partial?: true;
          replayError?: string;
        };
      }),
    replaySnapshot: opts.replaySnapshot ?? {
      compactedReplay: [],
      liveJournal: [],
    },
    consumeReplaySnapshot: vi.fn(() => {
      const snapshot = session.replaySnapshot;
      session.replaySnapshot = { compactedReplay: [], liveJournal: [] };
      return snapshot;
    }),
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

// Transcript dispatch is batched onto a short timer so a burst of
// SSE events coalesces into one reducer pass. Stay-alive mock generators never
// end the consumer loop (which would flush synchronously), so tests that assert
// transcript state mid-stream drain the batched dispatch here.
// Two hops are required because the dispatch timer and the first timer can be
// registered from concurrently draining microtask chains in either order.
async function flushTranscriptDispatch(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 0));
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
