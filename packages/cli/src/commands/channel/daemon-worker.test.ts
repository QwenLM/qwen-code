import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCanonicalizeWorkspace = vi.hoisted(() => vi.fn((p: string) => p));
const mockLoadChannelsConfig = vi.hoisted(() => vi.fn());
const mockLoadChannelsFromExtensions = vi.hoisted(() => vi.fn());
const mockParseConfiguredChannels = vi.hoisted(() => vi.fn());
const mockCreateChannel = vi.hoisted(() => vi.fn());
const mockReadChannelMemory = vi.hoisted(() => vi.fn());
const mockGetChannelMemoryRevision = vi.hoisted(() => vi.fn());
const mockListChannelMemoryEntries = vi.hoisted(() => vi.fn());
const mockAddChannelMemoryEntries = vi.hoisted(() => vi.fn());
const mockUpdateChannelMemoryEntry = vi.hoisted(() => vi.fn());
const mockRemoveChannelMemoryEntries = vi.hoisted(() => vi.fn());
const mockClearChannelMemory = vi.hoisted(() => vi.fn());
const mockRecordChannelMemoryRecallMetrics = vi.hoisted(() => vi.fn());
const mockRegisterToolCallDispatch = vi.hoisted(() => vi.fn());
const mockRegisterPermissionRelay = vi.hoisted(() => vi.fn());
const mockRegisterSessionCleanup = vi.hoisted(() => vi.fn());
const mockSessionsPath = vi.hoisted(() => vi.fn(() => '/tmp/sessions.json'));
const mockDaemonSessionRoutesPath = vi.hoisted(() =>
  vi.fn(() => '/tmp/qwen/channels/daemon/workspace-hash/routes.json'),
);
const mockDaemonObservedContactsPath = vi.hoisted(() =>
  vi.fn(
    () => '/tmp/qwen/channels/daemon/workspace-hash/observed-contacts.json',
  ),
);
const mockObserveContact = vi.hoisted(() => vi.fn());
const mockObservedContactStore = vi.hoisted(() =>
  vi.fn(() => ({
    observe: mockObserveContact,
  })),
);
const mockLoadSettings = vi.hoisted(() =>
  vi.fn((_cwd?: string, _opts?: unknown) => ({
    merged: { proxy: 'http://settings-proxy:8080' as string | undefined },
  })),
);
const mockResolveProxyUrl = vi.hoisted(() =>
  vi.fn((_cliProxy?: string, settingsProxy?: string) => settingsProxy),
);
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockSelectFirstModel = vi.hoisted(() =>
  vi.fn(
    (
      parsed: Array<{ config: { model?: string } }>,
      bridgeLabel: string,
    ): string | undefined => {
      const models = [
        ...new Set(
          parsed
            .map((channel) => channel.config.model)
            .filter((model): model is string => Boolean(model)),
        ),
      ];
      if (models.length > 1) {
        mockWriteStderrLine(
          `[Channel] Warning: Multiple models configured (${models.join(', ')}). ` +
            `${bridgeLabel} will use "${models[0]}".`,
        );
      }
      return models[0];
    },
  ),
);
const mockSanitizeLogText = vi.hoisted(() =>
  vi.fn((value: unknown) => String(value).replace(/[\r\n]/g, ' ')),
);
const mockDefaultDaemonClientCapabilities = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    v: 1,
    mode: 'http-bridge',
    features: [],
    modelServices: [],
    workspaceCwd: '/workspace',
  }),
);
const mockDefaultDaemonClient = vi.hoisted(() =>
  vi.fn(() => ({
    capabilities: mockDefaultDaemonClientCapabilities,
  })),
);
const mockDefaultDaemonSessionClient = vi.hoisted(() => ({
  createOrAttach: vi.fn(),
  load: vi.fn(),
}));

const mockBridgeStart = vi.hoisted(() => vi.fn());
const mockBridgeStop = vi.hoisted(() => vi.fn());
const mockBridgeOn = vi.hoisted(() => vi.fn());
const mockBridgeOff = vi.hoisted(() => vi.fn());
const mockBridgeNewSession = vi.hoisted(() => vi.fn());
const mockBridgeLoadSession = vi.hoisted(() => vi.fn());
const mockBridgePrompt = vi.hoisted(() => vi.fn());
const mockBridgeCancelSession = vi.hoisted(() => vi.fn());
const mockBridgeDiscardSession = vi.hoisted(() => vi.fn());
const mockBridgeRespondToPermission = vi.hoisted(() => vi.fn());
const mockBridgeShellCommand = vi.hoisted(() => vi.fn());
const mockBridgeGetAvailableCommands = vi.hoisted(() => vi.fn(() => []));
const mockDaemonChannelBridge = vi.hoisted(() =>
  vi.fn(() => ({
    get availableCommands() {
      return [];
    },
    getAvailableCommands: mockBridgeGetAvailableCommands,
    on: mockBridgeOn,
    off: mockBridgeOff,
    newSession: mockBridgeNewSession,
    loadSession: mockBridgeLoadSession,
    prompt: mockBridgePrompt,
    cancelSession: mockBridgeCancelSession,
    discardSession: mockBridgeDiscardSession,
    respondToPermission: mockBridgeRespondToPermission,
    shellCommand: mockBridgeShellCommand,
    start: mockBridgeStart,
    stop: mockBridgeStop,
  })),
);
const mockRouterSetChannelScope = vi.hoisted(() => vi.fn());
const mockRouterSetChannelApprovalMode = vi.hoisted(() => vi.fn());
const mockRouterClearAll = vi.hoisted(() => vi.fn());
const mockRouterRestoreRoutes = vi.hoisted(() =>
  vi.fn(() => ({ restored: 1, dropped: 0 })),
);
const mockRouterDispose = vi.hoisted(() => vi.fn());
const mockSessionRouter = vi.hoisted(() =>
  vi.fn(
    (
      _bridge?: unknown,
      _defaultCwd?: string,
      _scope?: string,
      _persistPath?: string,
    ) => ({
      setChannelScope: mockRouterSetChannelScope,
      setChannelApprovalMode: mockRouterSetChannelApprovalMode,
      clearAll: mockRouterClearAll,
      restoreRoutes: mockRouterRestoreRoutes,
      dispose: mockRouterDispose,
    }),
  ),
);

vi.mock('@qwen-code/acp-bridge/workspacePaths', () => ({
  canonicalizeWorkspace: mockCanonicalizeWorkspace,
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  addChannelMemoryEntries: mockAddChannelMemoryEntries,
  clearChannelMemory: mockClearChannelMemory,
  getChannelMemoryRevision: mockGetChannelMemoryRevision,
  listChannelMemoryEntries: mockListChannelMemoryEntries,
  readChannelMemory: mockReadChannelMemory,
  recordChannelMemoryRecallMetrics: mockRecordChannelMemoryRecallMetrics,
  removeChannelMemoryEntries: mockRemoveChannelMemoryEntries,
  updateChannelMemoryEntry: mockUpdateChannelMemoryEntry,
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
  writeStdoutLine: mockWriteStdoutLine,
}));

vi.mock('../../config/settings.js', () => ({
  loadSettings: mockLoadSettings,
}));

vi.mock('./proxy.js', () => ({
  resolveProxyUrl: mockResolveProxyUrl,
}));

vi.mock('./runtime.js', () => ({
  createChannel: mockCreateChannel,
  daemonObservedContactsPath: mockDaemonObservedContactsPath,
  daemonSessionRoutesPath: mockDaemonSessionRoutesPath,
  loadChannelsConfig: mockLoadChannelsConfig,
  loadChannelsFromExtensions: mockLoadChannelsFromExtensions,
  parseConfiguredChannels: mockParseConfiguredChannels,
  registerPermissionRelay: mockRegisterPermissionRelay,
  registerSessionCleanup: mockRegisterSessionCleanup,
  registerToolCallDispatch: mockRegisterToolCallDispatch,
  selectFirstModel: mockSelectFirstModel,
  sessionsPath: mockSessionsPath,
}));

vi.mock('./observed-contact-store.js', () => ({
  ObservedChannelContactStore: mockObservedContactStore,
}));

vi.mock('@qwen-code/channel-base', () => ({
  DaemonChannelBridge: mockDaemonChannelBridge,
  sanitizeLogText: mockSanitizeLogText,
  SessionRouter: mockSessionRouter,
}));

vi.mock('@qwen-code/sdk/daemon', () => ({
  DaemonClient: mockDefaultDaemonClient,
  DaemonSessionClient: mockDefaultDaemonSessionClient,
}));

import {
  createDaemonChannelBridgeFacade,
  createDaemonSessionFactory,
  daemonWorkerCommand,
  runChannelDaemonWorker,
} from './daemon-worker.js';

const parsedTelegram = {
  name: 'telegram',
  config: {
    type: 'telegram',
    cwd: '/workspace',
    model: 'qwen-plus',
    sessionScope: 'thread',
  },
};

const parsedFeishu = {
  name: 'feishu',
  config: {
    type: 'feishu',
    cwd: '/workspace',
    sessionScope: 'single',
  },
};

const webhookTask = {
  channelName: 'telegram',
  source: 'github-ci',
  eventType: 'check_failed',
  targetRef: 'default',
  title: 'CI failed',
  payload: { runId: 123 },
};

function createSdk() {
  const client = {
    capabilities: vi.fn().mockResolvedValue({
      v: 1,
      mode: 'http-bridge',
      features: [],
      modelServices: [],
      workspaceCwd: '/workspace',
    }),
  };
  const DaemonClient = vi.fn(() => client);
  const DaemonSessionClient = {
    createOrAttach: vi.fn().mockResolvedValue({
      sessionId: 'created-session',
      workspaceCwd: '/workspace',
      prompt: vi.fn(),
      events: vi.fn(),
      cancel: vi.fn(),
      setModel: vi.fn(),
      respondToPermission: vi.fn(),
    }),
    load: vi.fn().mockResolvedValue({
      sessionId: 'loaded-session',
      workspaceCwd: '/workspace',
      prompt: vi.fn(),
      events: vi.fn(),
      cancel: vi.fn(),
      setModel: vi.fn(),
      respondToPermission: vi.fn(),
    }),
  };
  return { client, DaemonClient, DaemonSessionClient };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDefaultDaemonClientCapabilities.mockResolvedValue({
    v: 1,
    mode: 'http-bridge',
    features: [],
    modelServices: [],
    workspaceCwd: '/workspace',
  });
  mockBridgeStart.mockResolvedValue(undefined);
  mockCreateChannel.mockImplementation((name: string) => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    name,
    validateWebhookTask: vi.fn(),
  }));
  mockLoadChannelsConfig.mockReturnValue({
    telegram: { type: 'telegram' },
    feishu: { type: 'feishu' },
  });
  mockLoadChannelsFromExtensions.mockResolvedValue(0);
  mockParseConfiguredChannels.mockResolvedValue([parsedTelegram]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function mockProcessExit(): void {
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit ${code ?? 0}`);
  }) as never);
}

function mockProcessExitNoThrow() {
  return vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
}

function stubProcessSend(send: NodeJS.Process['send'] | undefined): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'send');
  Object.defineProperty(process, 'send', {
    configurable: true,
    value: send,
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(process, 'send', descriptor);
    } else {
      delete (process as { send?: NodeJS.Process['send'] }).send;
    }
  };
}

describe('createDaemonSessionFactory', () => {
  it('tags created channel sessions without changing loaded sessions', async () => {
    const sdk = createSdk();
    const factory = createDaemonSessionFactory({
      client: sdk.client,
      DaemonSessionClient: sdk.DaemonSessionClient,
      clientId: 'qwen-channel-worker',
    });

    await factory({ workspaceCwd: '/workspace', modelServiceId: 'qwen-plus' });
    await factory({
      workspaceCwd: '/workspace',
      modelServiceId: 'qwen-plus',
      sessionId: 'existing-session',
    });

    expect(sdk.DaemonSessionClient.createOrAttach).toHaveBeenCalledWith(
      sdk.client,
      {
        workspaceCwd: '/workspace',
        modelServiceId: 'qwen-plus',
        sessionScope: 'thread',
        sourceType: 'channel',
      },
      'qwen-channel-worker',
    );
    expect(sdk.DaemonSessionClient.load).toHaveBeenCalledWith(
      sdk.client,
      'existing-session',
      {
        workspaceCwd: '/workspace',
        modelServiceId: 'qwen-plus',
        sessionScope: 'thread',
      },
      'qwen-channel-worker',
    );
  });

  it('passes channel approval mode to daemon session requests', async () => {
    const sdk = createSdk();
    const factory = createDaemonSessionFactory({
      client: sdk.client,
      DaemonSessionClient: sdk.DaemonSessionClient,
      clientId: 'qwen-channel-worker',
    });

    await factory({
      workspaceCwd: '/workspace',
      approvalMode: 'yolo',
    });
    await factory({
      workspaceCwd: '/workspace',
      sessionId: 'existing-session',
      approvalMode: 'yolo',
    });

    expect(sdk.DaemonSessionClient.createOrAttach).toHaveBeenCalledWith(
      sdk.client,
      {
        workspaceCwd: '/workspace',
        approvalMode: 'yolo',
        sessionScope: 'thread',
        sourceType: 'channel',
      },
      'qwen-channel-worker',
    );
    expect(sdk.DaemonSessionClient.load).toHaveBeenCalledWith(
      sdk.client,
      'existing-session',
      {
        workspaceCwd: '/workspace',
        approvalMode: 'yolo',
        sessionScope: 'thread',
      },
      'qwen-channel-worker',
    );
  });

  it('stamps channel sourceId on created sessions only', async () => {
    const sdk = createSdk();
    const factory = createDaemonSessionFactory({
      client: sdk.client,
      DaemonSessionClient: sdk.DaemonSessionClient,
      clientId: 'qwen-channel-worker',
    });

    await factory({ workspaceCwd: '/workspace', sourceId: 'dingtalk-main' });
    await factory({
      workspaceCwd: '/workspace',
      sessionId: 'existing-session',
      sourceId: 'dingtalk-main',
    });

    expect(sdk.DaemonSessionClient.createOrAttach).toHaveBeenCalledWith(
      sdk.client,
      {
        workspaceCwd: '/workspace',
        sessionScope: 'thread',
        sourceType: 'channel',
        sourceId: 'dingtalk-main',
      },
      'qwen-channel-worker',
    );
    // The load branch never re-stamps creation attribution: no sourceId in the
    // load request even when the factory request carried one.
    expect(sdk.DaemonSessionClient.load).toHaveBeenCalledWith(
      sdk.client,
      'existing-session',
      {
        workspaceCwd: '/workspace',
        sessionScope: 'thread',
      },
      'qwen-channel-worker',
    );
  });
});

describe('createDaemonChannelBridgeFacade', () => {
  it('omits shellCommand when the daemon does not advertise shell support', () => {
    const bridge = mockDaemonChannelBridge.mock.results[0]?.value ?? {
      availableCommands: [],
      on: mockBridgeOn,
      off: mockBridgeOff,
      newSession: mockBridgeNewSession,
      loadSession: mockBridgeLoadSession,
      prompt: mockBridgePrompt,
      cancelSession: mockBridgeCancelSession,
      shellCommand: mockBridgeShellCommand,
    };

    const facade = createDaemonChannelBridgeFacade(bridge, {
      exposeShellCommand: false,
    });

    expect('shellCommand' in facade).toBe(false);
  });

  it('exposes shellCommand when the daemon advertises shell support', () => {
    let availableCommands = [{ name: 'initial', description: 'Initial' }];
    const bridge = {
      get availableCommands() {
        return availableCommands;
      },
      on: mockBridgeOn,
      off: mockBridgeOff,
      newSession: mockBridgeNewSession,
      loadSession: mockBridgeLoadSession,
      prompt: mockBridgePrompt,
      cancelSession: mockBridgeCancelSession,
      shellCommand: mockBridgeShellCommand,
    };

    const facade = createDaemonChannelBridgeFacade(bridge, {
      exposeShellCommand: true,
    });

    expect(facade.shellCommand).toBeTypeOf('function');
    availableCommands = [{ name: 'updated', description: 'Updated' }];
    expect(facade.availableCommands).toEqual([
      { name: 'updated', description: 'Updated' },
    ]);
  });

  it('preserves session-scoped available commands when present', () => {
    const getAvailableCommands = vi.fn(() => [
      { name: 'status', description: 'Show status' },
    ]);
    const bridge = {
      availableCommands: [],
      getAvailableCommands,
      on: mockBridgeOn,
      off: mockBridgeOff,
      newSession: mockBridgeNewSession,
      loadSession: mockBridgeLoadSession,
      prompt: mockBridgePrompt,
      cancelSession: mockBridgeCancelSession,
    };

    const facade = createDaemonChannelBridgeFacade(bridge, {
      exposeShellCommand: false,
    });

    expect(facade.getAvailableCommands?.('session-1')).toEqual([
      { name: 'status', description: 'Show status' },
    ]);
    expect(getAvailableCommands).toHaveBeenCalledWith('session-1');
  });

  it('forwards listSessions when present on bridge', () => {
    const listSessions = vi.fn(() => [
      {
        sessionId: 'sess-1',
        workspaceCwd: '/repo',
        hasActivePrompt: false,
      },
    ]);
    const bridge = {
      availableCommands: [],
      on: mockBridgeOn,
      off: mockBridgeOff,
      newSession: mockBridgeNewSession,
      loadSession: mockBridgeLoadSession,
      prompt: mockBridgePrompt,
      cancelSession: mockBridgeCancelSession,
      listSessions,
    };

    const facade = createDaemonChannelBridgeFacade(bridge, {
      exposeShellCommand: false,
    });

    expect(facade.listSessions?.()).toEqual([
      {
        sessionId: 'sess-1',
        workspaceCwd: '/repo',
        hasActivePrompt: false,
      },
    ]);
    expect(listSessions).toHaveBeenCalled();
  });

  it('forwards permission responses when present on bridge', async () => {
    const respondToPermission = vi.fn().mockResolvedValue(true);
    const bridge = {
      availableCommands: [],
      on: mockBridgeOn,
      off: mockBridgeOff,
      newSession: mockBridgeNewSession,
      loadSession: mockBridgeLoadSession,
      prompt: mockBridgePrompt,
      cancelSession: mockBridgeCancelSession,
      respondToPermission,
    };

    const facade = createDaemonChannelBridgeFacade(bridge, {
      exposeShellCommand: false,
    });

    const response = { outcome: { outcome: 'cancelled' as const } };
    await expect(facade.respondToPermission?.('req-1', response)).resolves.toBe(
      true,
    );
    expect(respondToPermission).toHaveBeenCalledWith('req-1', response);
  });

  it('omits permission responses when absent on bridge', () => {
    const bridge = {
      availableCommands: [],
      on: mockBridgeOn,
      off: mockBridgeOff,
      newSession: mockBridgeNewSession,
      loadSession: mockBridgeLoadSession,
      prompt: mockBridgePrompt,
      cancelSession: mockBridgeCancelSession,
    };

    const facade = createDaemonChannelBridgeFacade(bridge, {
      exposeShellCommand: false,
    });

    expect('respondToPermission' in facade).toBe(false);
    expect('discardSession' in facade).toBe(false);
  });

  it('omits listSessions when absent on bridge', () => {
    const bridge = {
      availableCommands: [],
      on: mockBridgeOn,
      off: mockBridgeOff,
      newSession: mockBridgeNewSession,
      loadSession: mockBridgeLoadSession,
      prompt: mockBridgePrompt,
      cancelSession: mockBridgeCancelSession,
    };

    const facade = createDaemonChannelBridgeFacade(bridge, {
      exposeShellCommand: false,
    });

    expect('listSessions' in facade).toBe(false);
  });

  it('does not expose channel loop MCP registration through the daemon facade', () => {
    const bridge = {
      availableCommands: [],
      on: mockBridgeOn,
      off: mockBridgeOff,
      newSession: mockBridgeNewSession,
      loadSession: mockBridgeLoadSession,
      prompt: mockBridgePrompt,
      cancelSession: mockBridgeCancelSession,
      registerChannelLoopToolHandler: vi.fn(),
    };

    const facade = createDaemonChannelBridgeFacade(bridge, {
      exposeShellCommand: false,
    });

    expect('registerChannelLoopToolHandler' in facade).toBe(false);
  });
});

describe('runChannelDaemonWorker', () => {
  it('forwards router discard through the daemon bridge facade', async () => {
    const sdk = createSdk();
    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });
    const bridgeFacade = mockSessionRouter.mock.calls[0]![0] as {
      discardSession?: (
        sessionId: string,
        expectedBindingToken?: object,
      ) => Promise<void>;
    };
    const bindingToken = {};

    expect(bridgeFacade.discardSession).toBeTypeOf('function');
    await bridgeFacade.discardSession?.('orphan-session', bindingToken);

    expect(mockBridgeDiscardSession).toHaveBeenCalledWith(
      'orphan-session',
      bindingToken,
    );
    expect(mockBridgeDiscardSession.mock.instances[0]).toBe(
      mockDaemonChannelBridge.mock.results[0]!.value,
    );

    await handle.close();
  });

  it('starts selected channels through a daemon-backed bridge facade', async () => {
    const sdk = createSdk();
    const ready = vi.fn();
    const settings = { merged: { proxy: 'http://settings-proxy:8080' } };
    mockLoadSettings.mockReturnValueOnce(settings);

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      daemonToken: 'secret-token',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
      sendReady: ready,
    });

    expect(sdk.DaemonClient).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:4170',
      token: 'secret-token',
    });
    expect(mockLoadChannelsFromExtensions).toHaveBeenCalled();
    expect(mockParseConfiguredChannels).toHaveBeenCalledWith(
      expect.any(Object),
      ['telegram'],
      { defaultCwd: '/workspace' },
    );
    expect(mockDaemonChannelBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/workspace',
        modelServiceId: 'qwen-plus',
      }),
    );
    const bridgeFacade = mockSessionRouter.mock.calls[0]![0] as {
      shellCommand?: unknown;
    };
    expect('shellCommand' in bridgeFacade).toBe(false);
    expect(mockCreateChannel).toHaveBeenCalledWith(
      'telegram',
      parsedTelegram.config,
      bridgeFacade,
      expect.objectContaining({
        proxy: 'http://settings-proxy:8080',
        router: mockSessionRouter.mock.results[0]!.value,
        channelMemory: {
          readChannelMemory: mockReadChannelMemory,
          getChannelMemoryRevision: mockGetChannelMemoryRevision,
          listChannelMemoryEntries: mockListChannelMemoryEntries,
          addChannelMemoryEntries: mockAddChannelMemoryEntries,
          updateChannelMemoryEntry: mockUpdateChannelMemoryEntry,
          removeChannelMemoryEntries: mockRemoveChannelMemoryEntries,
          clearChannelMemory: mockClearChannelMemory,
        },
        memoryIntentClassifier: expect.objectContaining({
          classifyChannelMemoryIntent: expect.any(Function),
        }),
        channelMemoryRecallObserver: mockRecordChannelMemoryRecallMetrics,
        observedContacts: {
          observe: expect.any(Function),
        },
      }),
    );
    expect(mockDaemonObservedContactsPath).toHaveBeenCalledWith('/workspace');
    expect(mockObservedContactStore).toHaveBeenCalledWith(
      '/tmp/qwen/channels/daemon/workspace-hash/observed-contacts.json',
    );
    const channelOptions = mockCreateChannel.mock.calls[0]![3] as {
      observedContacts: {
        observe(channelName: string, observation: unknown): unknown;
      };
    };
    const observation = {
      user: { id: '42', label: 'Ada' },
      group: { id: 'group-1', label: 'group-1' },
    };
    channelOptions.observedContacts.observe('telegram', observation);
    expect(mockObserveContact).toHaveBeenCalledWith('telegram', observation);
    expect(mockRegisterPermissionRelay).toHaveBeenCalledWith(
      bridgeFacade,
      mockSessionRouter.mock.results[0]!.value,
      expect.any(Map),
    );
    expect(mockResolveProxyUrl).toHaveBeenCalledWith(
      undefined,
      'http://settings-proxy:8080',
    );
    expect(mockLoadSettings).toHaveBeenCalledWith('/workspace', {
      skipLoadEnvironment: true,
    });
    expect(mockLoadChannelsConfig).toHaveBeenCalledWith('/workspace', settings);
    expect(mockDaemonSessionRoutesPath).toHaveBeenCalledWith('/workspace');
    expect(mockSessionRouter).toHaveBeenCalledWith(
      expect.any(Object),
      '/workspace',
      'user',
      '/tmp/qwen/channels/daemon/workspace-hash/routes.json',
      { recoveryMode: 'lazy' },
    );
    expect(mockRouterRestoreRoutes).toHaveBeenCalledTimes(1);
    expect(mockBridgeLoadSession).not.toHaveBeenCalled();
    expect(mockRouterSetChannelScope.mock.invocationCallOrder[0]).toBeLessThan(
      mockRouterRestoreRoutes.mock.invocationCallOrder[0],
    );
    expect(mockRouterRestoreRoutes.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateChannel.mock.invocationCallOrder[0],
    );
    expect(mockSessionsPath).not.toHaveBeenCalled();
    expect(ready).toHaveBeenCalledWith({
      channels: ['telegram'],
      requestedChannels: ['telegram'],
      pid: process.pid,
    });

    await handle.close();
    expect(mockBridgeStop).toHaveBeenCalled();
    expect(mockBridgeStop.mock.invocationCallOrder[0]!).toBeLessThan(
      mockRouterDispose.mock.invocationCallOrder[0]!,
    );
    expect(mockRouterClearAll).not.toHaveBeenCalled();
  });

  it('selects all configured channels in one shared router', async () => {
    const sdk = createSdk();
    mockParseConfiguredChannels.mockResolvedValueOnce([
      {
        ...parsedTelegram,
        config: { ...parsedTelegram.config, approvalMode: 'yolo' },
      },
      parsedFeishu,
    ]);

    await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
    });

    expect(mockParseConfiguredChannels).toHaveBeenCalledWith(
      expect.any(Object),
      ['telegram', 'feishu'],
      { defaultCwd: '/workspace' },
    );
    expect(mockSessionRouter).toHaveBeenCalledTimes(1);
    expect(mockRouterSetChannelScope).toHaveBeenCalledWith(
      'telegram',
      'thread',
    );
    expect(mockRouterSetChannelScope).toHaveBeenCalledWith('feishu', 'single');
    expect(mockRouterSetChannelApprovalMode).not.toHaveBeenCalled();
  });

  it('applies channel approval mode only for webhook-enabled channels', async () => {
    const sdk = createSdk();
    mockParseConfiguredChannels.mockResolvedValueOnce([
      {
        ...parsedTelegram,
        config: {
          ...parsedTelegram.config,
          approvalMode: 'yolo',
          webhooks: { sources: {} },
        },
      },
      {
        ...parsedFeishu,
        config: { ...parsedFeishu.config, approvalMode: 'yolo' },
      },
    ]);

    await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
    });

    expect(mockRouterSetChannelApprovalMode).toHaveBeenCalledTimes(1);
    expect(mockRouterSetChannelApprovalMode).toHaveBeenCalledWith(
      'telegram',
      'yolo',
    );
  });

  it('sanitizes channel names before writing connected logs', async () => {
    const sdk = createSdk();
    const unsafeName = 'evil\nchannel';
    mockLoadChannelsConfig.mockReturnValueOnce({
      [unsafeName]: { type: 'telegram' },
    });
    mockParseConfiguredChannels.mockResolvedValueOnce([
      {
        ...parsedTelegram,
        name: unsafeName,
      },
    ]);

    await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
    });

    expect(mockSanitizeLogText).toHaveBeenCalledWith(unsafeName, 128);
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      '[Channel] Connecting "evil channel"...',
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      '[Channel] "evil channel" connected.',
    );
  });

  it('exposes shellCommand only when capabilities include session_shell_command', async () => {
    const sdk = createSdk();
    sdk.client.capabilities.mockResolvedValueOnce({
      v: 1,
      mode: 'http-bridge',
      features: ['session_shell_command'],
      modelServices: [],
      workspaceCwd: '/workspace',
    });

    await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    const bridgeFacade = mockSessionRouter.mock.calls[0]![0] as {
      shellCommand?: unknown;
    };
    expect(bridgeFacade.shellCommand).toBeTypeOf('function');
  });

  it('fails fast for unknown selected channel names', async () => {
    const sdk = createSdk();

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['missing'] },
        loadDaemonSdk: async () => sdk,
      }),
    ).rejects.toThrow('Channel "missing" not found in settings.');
  });

  it('rejects daemon URLs that are not http loopback URLs', async () => {
    const sdk = createSdk();

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://attacker.example:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      }),
    ).rejects.toThrow('QWEN_DAEMON_URL must use an http loopback URL.');
    expect(sdk.DaemonClient).not.toHaveBeenCalled();
  });

  it('fails fast when no channels are configured', async () => {
    const sdk = createSdk();
    mockLoadChannelsConfig.mockReturnValueOnce({});

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'all' },
        loadDaemonSdk: async () => sdk,
      }),
    ).rejects.toThrow('No channels configured in settings.json.');
  });

  it('fails fast when daemon capabilities report a different workspace', async () => {
    const sdk = createSdk();
    sdk.client.capabilities.mockResolvedValueOnce({
      v: 1,
      mode: 'http-bridge',
      features: [],
      modelServices: [],
      workspaceCwd: '/other-workspace',
    });

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      }),
    ).rejects.toThrow('does not match worker workspace');
    expect(mockLoadSettings).not.toHaveBeenCalled();
  });

  it('uses the legacy workspace fallback when capabilities workspaces are empty', async () => {
    const sdk = createSdk();
    sdk.client.capabilities.mockResolvedValueOnce({
      v: 1,
      mode: 'http-bridge',
      features: [],
      modelServices: [],
      workspaceCwd: '/workspace',
      workspaces: [],
    });

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      }),
    ).resolves.toBeDefined();
  });

  it('preserves the legacy trust behavior for a singleton workspace', async () => {
    const sdk = createSdk();
    sdk.client.capabilities.mockResolvedValueOnce({
      v: 1,
      mode: 'http-bridge',
      features: [],
      modelServices: [],
      workspaceCwd: '/workspace',
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true, trusted: false },
      ],
    });

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      }),
    ).resolves.toBeDefined();
  });

  it('accepts a trusted registered non-primary workspace', async () => {
    const sdk = createSdk();
    sdk.client.capabilities.mockResolvedValueOnce({
      v: 1,
      mode: 'http-bridge',
      features: [],
      modelServices: [],
      workspaceCwd: '/primary',
      workspaces: [
        { id: 'primary', cwd: '/primary', primary: true, trusted: true },
        { id: 'worker', cwd: '/workspace', primary: false, trusted: true },
      ],
    });

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a worker workspace missing from daemon capabilities', async () => {
    const sdk = createSdk();
    sdk.client.capabilities.mockResolvedValueOnce({
      v: 1,
      mode: 'http-bridge',
      features: [],
      modelServices: [],
      workspaceCwd: '/primary',
      workspaces: [
        { id: 'primary', cwd: '/primary', primary: true, trusted: true },
        { id: 'other', cwd: '/other', primary: false, trusted: true },
      ],
    });

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      }),
    ).rejects.toThrow('not registered');
  });

  it('rejects an untrusted registered worker workspace', async () => {
    const sdk = createSdk();
    sdk.client.capabilities.mockResolvedValueOnce({
      v: 1,
      mode: 'http-bridge',
      features: [],
      modelServices: [],
      workspaceCwd: '/primary',
      workspaces: [
        { id: 'primary', cwd: '/primary', primary: true, trusted: true },
        { id: 'worker', cwd: '/workspace', primary: false, trusted: false },
      ],
    });

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      }),
    ).rejects.toThrow('not trusted');
  });

  it('stops the bridge when adapter creation fails before ready', async () => {
    const sdk = createSdk();
    mockCreateChannel.mockRejectedValueOnce(new Error('adapter boom'));

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      }),
    ).rejects.toThrow('adapter boom');

    expect(mockBridgeStop).toHaveBeenCalled();
  });

  it('disposes router state when startup rollback bridge stop fails', async () => {
    const sdk = createSdk();
    mockCreateChannel.mockRejectedValueOnce(new Error('adapter boom'));
    mockBridgeStop.mockImplementationOnce(() => {
      throw new Error('stop boom');
    });

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      }),
    ).rejects.toThrow('adapter boom');

    expect(mockBridgeStop).toHaveBeenCalled();
    expect(mockRouterDispose).toHaveBeenCalled();
    expect(mockRouterClearAll).not.toHaveBeenCalled();
  });

  it('does not repopulate daemon-private env from worker settings loads', async () => {
    const sdk = createSdk();
    delete process.env['QWEN_SERVER_TOKEN'];
    delete process.env['QWEN_DAEMON_TOKEN'];
    mockLoadSettings.mockImplementationOnce((_cwd?: string, opts?: unknown) => {
      if (
        !opts ||
        typeof opts !== 'object' ||
        !('skipLoadEnvironment' in opts) ||
        !opts.skipLoadEnvironment
      ) {
        process.env['QWEN_SERVER_TOKEN'] = 'restored-server-token';
      }
      return { merged: { proxy: undefined } };
    });

    await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      daemonToken: 'daemon-token',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
    expect(process.env['QWEN_DAEMON_TOKEN']).toBeUndefined();
  });

  it('disconnects a constructed adapter when connect fails', async () => {
    const sdk = createSdk();
    const disconnect = vi.fn();
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockRejectedValue(new Error('connect boom')),
      disconnect,
      name: 'telegram',
    });

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      }),
    ).rejects.toThrow('No channels connected.');

    expect(disconnect).toHaveBeenCalled();
    expect(mockSanitizeLogText).toHaveBeenCalledWith('connect boom', 512);
    expect(mockBridgeStop).toHaveBeenCalled();
  });

  it('waits for each startup failure report before connecting the next channel', async () => {
    const sdk = createSdk();
    let acknowledge!: () => void;
    const reportPending = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const reportStartup = vi.fn(() => reportPending);
    const secondConnect = vi.fn().mockResolvedValue(undefined);
    mockParseConfiguredChannels.mockResolvedValueOnce([
      parsedTelegram,
      parsedFeishu,
    ]);
    mockCreateChannel
      .mockResolvedValueOnce({
        connect: vi.fn().mockRejectedValue(
          Object.assign(new Error('connection refused'), {
            code: 'ECONNREFUSED',
          }),
        ),
        disconnect: vi.fn(),
        name: 'telegram',
      })
      .mockResolvedValueOnce({
        connect: secondConnect,
        disconnect: vi.fn(),
        name: 'feishu',
      });

    const started = runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram', 'feishu'] },
      loadDaemonSdk: async () => sdk,
      reportStartup,
    });
    await vi.waitFor(() => expect(reportStartup).toHaveBeenCalledOnce());
    expect(secondConnect).not.toHaveBeenCalled();
    expect(reportStartup).toHaveBeenCalledWith({
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram',
        phase: 'connect',
        code: 'ECONNREFUSED',
        message: 'connection refused',
      },
    });

    acknowledge();
    const handle = await started;
    expect(secondConnect).toHaveBeenCalledOnce();
    await handle.close();
  });

  it('converts finite numeric connection error codes to strings', async () => {
    const sdk = createSdk();
    const reportStartup = vi.fn().mockResolvedValue(undefined);
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockRejectedValue(
        Object.assign(new Error('port unreachable'), {
          code: 443,
        }),
      ),
      disconnect: vi.fn(),
      name: 'telegram',
    });

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
        reportStartup,
      }),
    ).rejects.toThrow('No channels connected.');

    expect(reportStartup).toHaveBeenCalledWith({
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram',
        phase: 'connect',
        code: '443',
        message: 'port unreachable',
      },
    });
  });

  it('keeps an acknowledged failure when the next channel connect hangs', async () => {
    const sdk = createSdk();
    const controller = new AbortController();
    const reportStartup = vi.fn().mockResolvedValue(undefined);
    const secondConnect = vi.fn(
      () =>
        new Promise<void>(() => {
          // hangs until startupSignal aborts
        }),
    );
    mockParseConfiguredChannels.mockResolvedValueOnce([
      parsedTelegram,
      parsedFeishu,
    ]);
    mockCreateChannel
      .mockResolvedValueOnce({
        connect: vi.fn().mockRejectedValue(new Error('telegram failed')),
        disconnect: vi.fn(),
        name: 'telegram',
      })
      .mockResolvedValueOnce({
        connect: secondConnect,
        disconnect: vi.fn(),
        name: 'feishu',
      });

    const started = runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram', 'feishu'] },
      loadDaemonSdk: async () => sdk,
      reportStartup,
      startupSignal: controller.signal,
    });
    await vi.waitFor(() => expect(secondConnect).toHaveBeenCalledOnce());

    expect(reportStartup).toHaveBeenCalledWith({
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram',
        phase: 'connect',
        message: 'telegram failed',
      },
    });

    controller.abort();
    await expect(started).rejects.toThrow('Daemon worker startup aborted.');
  });

  it('uses safe fallback diagnostics when error getters throw', async () => {
    const sdk = createSdk();
    const malformedError = {};
    Object.defineProperties(malformedError, {
      message: {
        get() {
          throw new Error('message getter must not escape');
        },
      },
      code: {
        get() {
          throw new Error('code getter must not escape');
        },
      },
      toString: {
        value() {
          throw new Error('toString must not escape');
        },
      },
    });
    const reportStartup = vi.fn().mockResolvedValue(undefined);
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockRejectedValue(malformedError),
      disconnect: vi.fn(),
      name: 'telegram',
    });

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
        reportStartup,
      }),
    ).rejects.toThrow('No channels connected.');

    expect(reportStartup).toHaveBeenCalledWith({
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram',
        phase: 'connect',
        message: 'Channel connection failed.',
      },
    });
  });

  it('stops startup when a failure report cannot be acknowledged', async () => {
    const sdk = createSdk();
    const secondConnect = vi.fn().mockResolvedValue(undefined);
    mockParseConfiguredChannels.mockResolvedValueOnce([
      parsedTelegram,
      parsedFeishu,
    ]);
    mockCreateChannel
      .mockResolvedValueOnce({
        connect: vi.fn().mockRejectedValue(new Error('first failed')),
        disconnect: vi.fn(),
        name: 'telegram',
      })
      .mockResolvedValueOnce({
        connect: secondConnect,
        disconnect: vi.fn(),
        name: 'feishu',
      });

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram', 'feishu'] },
        loadDaemonSdk: async () => sdk,
        reportStartup: vi
          .fn()
          .mockRejectedValue(new Error('startup report failed')),
      }),
    ).rejects.toThrow('startup report failed');
    expect(secondConnect).not.toHaveBeenCalled();
  });

  it('reports at most 64 failures and acknowledges one truncation marker', async () => {
    const sdk = createSdk();
    const names = Array.from({ length: 66 }, (_, index) => `channel-${index}`);
    mockLoadChannelsConfig.mockReturnValueOnce(
      Object.fromEntries(names.map((name) => [name, { type: 'test' }])),
    );
    mockParseConfiguredChannels.mockResolvedValueOnce(
      names.map((name) => ({
        name,
        config: {
          type: 'test',
          cwd: '/workspace',
          sessionScope: 'thread',
        },
      })),
    );
    mockCreateChannel.mockImplementation(async (name: string) => ({
      connect: vi.fn().mockRejectedValue(new Error(`${name} failed`)),
      disconnect: vi.fn(),
      name,
    }));
    const reportStartup = vi.fn().mockResolvedValue(undefined);

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names },
        loadDaemonSdk: async () => sdk,
        reportStartup,
      }),
    ).rejects.toThrow('No channels connected.');

    expect(reportStartup).toHaveBeenCalledTimes(65);
    expect(
      reportStartup.mock.calls
        .slice(0, 64)
        .map(([message]) => (message as { type?: string }).type),
    ).toEqual(Array(64).fill('channel_startup_failure'));
    expect(reportStartup).toHaveBeenLastCalledWith({
      type: 'channel_startup_failures_truncated',
    });
  });

  it('reports requested channels when only some adapters connect', async () => {
    const sdk = createSdk();
    const telegramDisconnect = vi.fn();
    const feishuDisconnect = vi.fn();
    const ready = vi.fn();
    mockParseConfiguredChannels.mockResolvedValueOnce([
      parsedTelegram,
      parsedFeishu,
    ]);
    mockCreateChannel
      .mockResolvedValueOnce({
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: telegramDisconnect,
        name: 'telegram',
      })
      .mockResolvedValueOnce({
        connect: vi.fn().mockRejectedValue(new Error('feishu boom')),
        disconnect: feishuDisconnect,
        name: 'feishu',
      });

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram', 'feishu'] },
      loadDaemonSdk: async () => sdk,
      sendReady: ready,
    });

    expect(handle.channels).toEqual(['telegram']);
    expect(ready).toHaveBeenCalledWith({
      channels: ['telegram'],
      requestedChannels: ['telegram', 'feishu'],
      pid: process.pid,
    });
    expect(feishuDisconnect).toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      '[Channel] Failed to connect "feishu": feishu boom',
    );

    await handle.close();
    expect(telegramDisconnect).toHaveBeenCalled();
  });

  it('rolls back startup when aborted during channel connect', async () => {
    const sdk = createSdk();
    const controller = new AbortController();
    const disconnect = vi.fn();
    const connect = vi.fn(
      () =>
        new Promise<void>(() => {
          // hangs until startupSignal aborts
        }),
    );
    mockCreateChannel.mockResolvedValueOnce({
      connect,
      disconnect,
      name: 'telegram',
    });

    const started = runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
      startupSignal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(connect).toHaveBeenCalled();
    });

    controller.abort();

    await expect(started).rejects.toThrow('Daemon worker startup aborted.');
    expect(disconnect).toHaveBeenCalled();
    expect(mockBridgeStop).toHaveBeenCalled();
    expect(mockRouterDispose).toHaveBeenCalled();
    expect(mockRouterClearAll).not.toHaveBeenCalled();
  });

  it('fails fast when a channel cwd does not match the daemon workspace', async () => {
    const sdk = createSdk();
    mockParseConfiguredChannels.mockResolvedValueOnce([
      {
        ...parsedTelegram,
        config: { ...parsedTelegram.config, cwd: '/other' },
      },
    ]);

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      }),
    ).rejects.toThrow('must use daemon workspace "/workspace"');
  });

  it('disposes router state even when bridge stop fails during close', async () => {
    const sdk = createSdk();
    mockBridgeStop.mockImplementationOnce(() => {
      throw new Error('stop boom');
    });

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    await expect(handle.close()).rejects.toThrow('stop boom');
    expect(mockRouterDispose).toHaveBeenCalled();
    expect(mockRouterClearAll).not.toHaveBeenCalled();
  });

  it('runs webhook tasks on the matching channel handle', async () => {
    const sdk = createSdk();
    const runWebhookTask = vi.fn().mockResolvedValue(undefined);
    const validateWebhookTask = vi.fn();
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      name: 'telegram',
      validateWebhookTask,
      runWebhookTask,
    });

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    await handle.runWebhookTask(webhookTask);

    expect(runWebhookTask).toHaveBeenCalledWith(webhookTask);
  });

  it('rejects webhook tasks for channels that are not running', async () => {
    const sdk = createSdk();

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    await expect(
      handle.runWebhookTask({ ...webhookTask, channelName: 'missing' }),
    ).rejects.toThrow('Channel "missing" is not running.');
  });
});

describe('daemonWorkerCommand', () => {
  it('rejects direct user invocation without the internal sentinel', async () => {
    mockProcessExit();

    await expect(
      daemonWorkerCommand.handler({ channel: ['telegram'], _: [], $0: 'qwen' }),
    ).rejects.toThrow('process.exit 1');

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      '[Channel] daemon worker failed: daemon-worker is an internal qwen serve command.',
    );
  });

  it('rejects the legacy static internal sentinel', async () => {
    mockProcessExit();
    const restoreSend = stubProcessSend(vi.fn() as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', '1');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');

    try {
      await expect(
        daemonWorkerCommand.handler({
          channel: ['telegram'],
          _: [],
          $0: 'qwen',
        }),
      ).rejects.toThrow('process.exit 1');
    } finally {
      restoreSend();
    }

    expect(process.env['QWEN_CHANNEL_DAEMON_WORKER']).toBeUndefined();
    expect(process.env['QWEN_DAEMON_URL']).toBeUndefined();
    expect(process.env['QWEN_DAEMON_WORKSPACE']).toBeUndefined();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      '[Channel] daemon worker failed: daemon-worker is an internal qwen serve command.',
    );
  });

  it('rejects internal sentinel without parent IPC', async () => {
    mockProcessExit();
    const restoreSend = stubProcessSend(undefined);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');

    try {
      await expect(
        daemonWorkerCommand.handler({
          channel: ['telegram'],
          _: [],
          $0: 'qwen',
        }),
      ).rejects.toThrow('process.exit 1');
    } finally {
      restoreSend();
    }

    expect(process.env['QWEN_CHANNEL_DAEMON_WORKER']).toBeUndefined();
    expect(process.env['QWEN_DAEMON_URL']).toBeUndefined();
    expect(process.env['QWEN_DAEMON_WORKSPACE']).toBeUndefined();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      '[Channel] daemon worker failed: daemon-worker is an internal qwen serve command.',
    );
  });

  it('scrubs daemon connection env before validating channel selection', async () => {
    mockProcessExit();
    const restoreSend = stubProcessSend(vi.fn() as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_TOKEN', 'daemon-token');
    vi.stubEnv('QWEN_SERVER_TOKEN', 'server-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');

    try {
      await expect(
        daemonWorkerCommand.handler({ channel: [' '], _: [], $0: 'qwen' }),
      ).rejects.toThrow('process.exit 1');
    } finally {
      restoreSend();
    }

    expect(process.env['QWEN_DAEMON_TOKEN']).toBeUndefined();
    expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
    expect(process.env['QWEN_DAEMON_URL']).toBeUndefined();
    expect(process.env['QWEN_DAEMON_WORKSPACE']).toBeUndefined();
    expect(process.env['QWEN_CHANNEL_DAEMON_WORKER']).toBeUndefined();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      '[Channel] daemon worker failed: --channel requires a non-empty channel name.',
    );
  });

  it('scrubs daemon connection env when required env validation fails', async () => {
    mockProcessExit();
    const restoreSend = stubProcessSend(vi.fn() as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_TOKEN', 'daemon-token');
    vi.stubEnv('QWEN_SERVER_TOKEN', 'server-token');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');

    try {
      await expect(
        daemonWorkerCommand.handler({
          channel: ['telegram'],
          _: [],
          $0: 'qwen',
        }),
      ).rejects.toThrow('process.exit 1');
    } finally {
      restoreSend();
    }

    expect(process.env['QWEN_DAEMON_TOKEN']).toBeUndefined();
    expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
    expect(process.env['QWEN_DAEMON_WORKSPACE']).toBeUndefined();
    expect(process.env['QWEN_CHANNEL_DAEMON_WORKER']).toBeUndefined();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      '[Channel] daemon worker failed: QWEN_DAEMON_URL is required.',
    );
  });

  it('sends ready from the command handler and exits cleanly on SIGTERM', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_TOKEN', 'daemon-token');
    vi.stubEnv('QWEN_SERVER_TOKEN', 'server-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith({
          type: 'ready',
          channels: ['telegram'],
          requestedChannels: ['telegram'],
          pid: process.pid,
        });
      });

      process.emit('SIGTERM', 'SIGTERM');
      await handler;

      expect(mockBridgeStop).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
    }
  });

  it('waits for the supervisor ACK instead of the process.send callback', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn(
      (_message: unknown, callback?: (error: Error | null) => void) => {
        callback?.(null);
        return true;
      },
    );
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');
    mockParseConfiguredChannels.mockResolvedValueOnce([
      parsedTelegram,
      parsedFeishu,
    ]);
    mockCreateChannel
      .mockResolvedValueOnce({
        connect: vi.fn().mockRejectedValue(new Error('telegram failed')),
        disconnect: vi.fn(),
        name: 'telegram',
      })
      .mockResolvedValueOnce({
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
        name: 'feishu',
      });

    try {
      const existingMessageListeners = new Set(process.listeners('message'));
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram', 'feishu'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'channel_startup_failure' }),
          expect.any(Function),
        );
      });
      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ready' }),
      );

      const ackListener = process
        .listeners('message')
        .find((listener) => !existingMessageListeners.has(listener));
      expect(ackListener).toBeDefined();
      ackListener!({ type: 'channel_startup_report_ack' }, undefined);
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'ready',
            channels: ['feishu'],
            requestedChannels: ['telegram', 'feishu'],
          }),
        );
      });

      process.emit('SIGTERM', 'SIGTERM');
      await handler;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
    }
  });

  it('aborts startup when parent IPC disconnects while awaiting an ACK', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn(
      (_message: unknown, callback?: (error: Error | null) => void) => {
        callback?.(null);
        return true;
      },
    );
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockRejectedValue(new Error('telegram failed')),
      disconnect: vi.fn(),
      name: 'telegram',
    });

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'channel_startup_failure' }),
          expect.any(Function),
        );
      });

      process.emit('disconnect');
      await handler;

      expect(exit).toHaveBeenCalledWith(1);
      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        '[Channel] daemon worker failed: Daemon worker startup aborted.',
      );
    } finally {
      restoreSend();
    }
  });

  it('sends heartbeat messages while the daemon worker is live', async () => {
    vi.useFakeTimers();
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_TOKEN', 'daemon-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'ready',
            channels: ['telegram'],
            requestedChannels: ['telegram'],
            pid: process.pid,
          }),
        );
      });
      send.mockClear();

      await vi.advanceTimersByTimeAsync(15_000);

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'heartbeat', pid: process.pid }),
      );

      process.emit('SIGTERM', 'SIGTERM');
      await handler;
      expect(exit).toHaveBeenCalledWith(0);

      send.mockClear();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'heartbeat' }),
      );
    } finally {
      restoreSend();
      vi.useRealTimers();
    }
  });

  it('clears heartbeat messages when the IPC send channel is closed', async () => {
    vi.useFakeTimers();
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'ready',
            channels: ['telegram'],
            requestedChannels: ['telegram'],
            pid: process.pid,
          }),
        );
      });
      send.mockClear();
      send.mockImplementation(() => {
        throw Object.assign(new Error('Channel closed'), {
          code: 'ERR_IPC_CHANNEL_CLOSED',
        });
      });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'heartbeat' }),
      );

      send.mockClear();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(send).not.toHaveBeenCalled();

      process.emit('SIGTERM', 'SIGTERM');
      await handler;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
      vi.useRealTimers();
    }
  });

  it('clears heartbeat messages when parent IPC disconnects', async () => {
    vi.useFakeTimers();
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'ready',
            channels: ['telegram'],
            requestedChannels: ['telegram'],
            pid: process.pid,
          }),
        );
      });

      process.emit('disconnect');
      send.mockClear();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'heartbeat' }),
      );

      await handler;
      expect(exit).toHaveBeenCalledWith(0);

      send.mockClear();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'heartbeat' }),
      );
    } finally {
      restoreSend();
      vi.useRealTimers();
    }
  });

  it('honors a shutdown signal received during async setup', async () => {
    const exit = mockProcessExitNoThrow();
    const restoreSend = stubProcessSend(vi.fn() as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');
    let finishBridgeStart!: () => void;
    mockBridgeStart.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishBridgeStart = resolve;
        }),
    );

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(mockBridgeStart).toHaveBeenCalled();
      });

      process.emit('SIGTERM', 'SIGTERM');
      await handler;

      expect(mockBridgeStop).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1);
      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        '[Channel] daemon worker failed: Daemon worker startup aborted.',
      );
    } finally {
      finishBridgeStart?.();
      restoreSend();
    }
  });

  it('exits after startup rollback when the parent disconnects during async setup', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');
    const disconnect = vi.fn();
    const connect = vi.fn(
      () =>
        new Promise<void>(() => {
          // hangs until startupSignal aborts
        }),
    );
    mockCreateChannel.mockResolvedValueOnce({
      connect,
      disconnect,
      name: 'telegram',
    });

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(connect).toHaveBeenCalled();
      });

      process.emit('disconnect');
      expect(exit).not.toHaveBeenCalled();
      expect(disconnect).not.toHaveBeenCalled();
      expect(mockBridgeStop).not.toHaveBeenCalled();
      expect(mockRouterDispose).not.toHaveBeenCalled();
      expect(mockRouterClearAll).not.toHaveBeenCalled();

      await handler;

      expect(exit).toHaveBeenCalledWith(1);
      expect(send).not.toHaveBeenCalled();
      expect(disconnect).toHaveBeenCalled();
      expect(mockBridgeStop).toHaveBeenCalled();
      expect(mockRouterDispose).toHaveBeenCalled();
      expect(mockRouterClearAll).not.toHaveBeenCalled();
    } finally {
      restoreSend();
    }
  });

  it('exits cleanly when the parent IPC disconnects', async () => {
    const exit = mockProcessExitNoThrow();
    const restoreSend = stubProcessSend(vi.fn() as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(mockBridgeStart).toHaveBeenCalled();
      });

      process.emit('disconnect');
      await handler;

      expect(exit).toHaveBeenCalledWith(0);
      expect(mockBridgeStop).toHaveBeenCalled();
    } finally {
      restoreSend();
    }
  });

  it('exits with failure when shutdown fails', async () => {
    const exit = mockProcessExitNoThrow();
    const restoreSend = stubProcessSend(vi.fn() as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');
    mockBridgeStop.mockImplementationOnce(() => {
      throw new Error('stop boom');
    });

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(mockBridgeStart).toHaveBeenCalled();
      });

      process.emit('SIGTERM', 'SIGTERM');
      await handler;

      expect(exit).toHaveBeenCalledWith(1);
      expect(mockWriteStderrLine).toHaveBeenCalledWith(
        '[Channel] daemon worker failed to shut down after SIGTERM: stop boom',
      );
    } finally {
      restoreSend();
    }
  });

  it('force exits when a second signal arrives during shutdown', async () => {
    const exit = mockProcessExitNoThrow();
    const restoreSend = stubProcessSend(vi.fn() as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(mockBridgeStart).toHaveBeenCalled();
      });

      process.emit('SIGTERM', 'SIGTERM');
      process.emit('SIGINT', 'SIGINT');
      await handler;

      expect(exit).toHaveBeenNthCalledWith(1, 1);
    } finally {
      restoreSend();
    }
  });

  it('rejects webhook IPC messages for channels that are not running', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');
    const existingMessageListeners = process.listeners('message');

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'ready' }),
        );
      });
      send.mockClear();

      const webhookListener = process
        .listeners('message')
        .find((listener) => !existingMessageListeners.includes(listener));
      expect(webhookListener).toBeDefined();
      (webhookListener as ((message: unknown) => void) | undefined)?.({
        type: 'webhook_task',
        id: 'webhook-1',
        expiresAt: Date.now() + 1000,
        task: { ...webhookTask, channelName: 'missing' },
      });

      expect(send).toHaveBeenCalledWith({
        type: 'webhook_task_result',
        id: 'webhook-1',
        ok: false,
        code: 'channel_worker_unavailable',
        error: 'Channel "missing" is not running.',
      });

      process.emit('SIGTERM', 'SIGTERM');
      await handler;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
    }
  });

  it('ignores disconnected IPC while sending webhook task results', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');
    const existingMessageListeners = process.listeners('message');

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'ready' }),
        );
      });
      send.mockImplementation(() => {
        throw new Error('ipc disconnected');
      });

      const webhookListener = process
        .listeners('message')
        .find((listener) => !existingMessageListeners.includes(listener));
      expect(webhookListener).toBeDefined();
      expect(() =>
        (webhookListener as ((message: unknown) => void) | undefined)?.({
          type: 'webhook_task',
          id: 'webhook-1',
          expiresAt: Date.now() + 1000,
          task: { ...webhookTask, channelName: 'missing' },
        }),
      ).not.toThrow();

      process.emit('SIGTERM', 'SIGTERM');
      await handler;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
    }
  });

  it('rejects webhook IPC messages that fail preflight before running', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    const validateWebhookTask = vi.fn(() => {
      throw new Error('Webhook tasks require unattended approval mode.');
    });
    const runWebhookTask = vi.fn().mockResolvedValue(undefined);
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      name: 'telegram',
      validateWebhookTask,
      runWebhookTask,
    });
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');
    const existingMessageListeners = process.listeners('message');

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'ready' }),
        );
      });
      send.mockClear();

      const webhookListener = process
        .listeners('message')
        .find((listener) => !existingMessageListeners.includes(listener));
      expect(webhookListener).toBeDefined();
      (webhookListener as ((message: unknown) => void) | undefined)?.({
        type: 'webhook_task',
        id: 'webhook-1',
        expiresAt: Date.now() + 1000,
        task: webhookTask,
      });

      expect(send).toHaveBeenCalledWith({
        type: 'webhook_task_result',
        id: 'webhook-1',
        ok: false,
        code: 'channel_webhook_target_unavailable',
        error: 'Webhook tasks require unattended approval mode.',
      });
      expect(runWebhookTask).not.toHaveBeenCalled();

      process.emit('SIGTERM', 'SIGTERM');
      await handler;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
    }
  });

  it('rejects expired webhook IPC messages before running', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    const validateWebhookTask = vi.fn();
    const runWebhookTask = vi.fn().mockResolvedValue(undefined);
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      name: 'telegram',
      validateWebhookTask,
      runWebhookTask,
    });
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');
    const existingMessageListeners = process.listeners('message');

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'ready' }),
        );
      });
      send.mockClear();

      const webhookListener = process
        .listeners('message')
        .find((listener) => !existingMessageListeners.includes(listener));
      expect(webhookListener).toBeDefined();
      (webhookListener as ((message: unknown) => void) | undefined)?.({
        type: 'webhook_task',
        id: 'webhook-1',
        expiresAt: Date.now() - 1,
        task: webhookTask,
      });

      expect(send).toHaveBeenCalledWith({
        type: 'webhook_task_result',
        id: 'webhook-1',
        ok: false,
        code: 'channel_webhook_enqueue_timeout',
        error: 'Channel webhook task IPC timed out.',
      });
      expect(validateWebhookTask).not.toHaveBeenCalled();
      expect(runWebhookTask).not.toHaveBeenCalled();

      process.emit('SIGTERM', 'SIGTERM');
      await handler;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
    }
  });

  it('acks webhook IPC messages before running the webhook task in the background', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    const validateWebhookTask = vi.fn();
    const runWebhookTask = vi.fn().mockResolvedValue(undefined);
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      name: 'telegram',
      validateWebhookTask,
      runWebhookTask,
    });
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');
    const existingMessageListeners = process.listeners('message');

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'ready' }),
        );
      });
      send.mockClear();

      const webhookListener = process
        .listeners('message')
        .find((listener) => !existingMessageListeners.includes(listener));
      expect(webhookListener).toBeDefined();
      (webhookListener as ((message: unknown) => void) | undefined)?.({
        type: 'webhook_task',
        id: 'webhook-1',
        expiresAt: Date.now() + 1000,
        task: webhookTask,
      });

      expect(send).toHaveBeenCalledWith({
        type: 'webhook_task_result',
        id: 'webhook-1',
        ok: true,
      });
      expect(validateWebhookTask).toHaveBeenCalledWith(webhookTask);
      expect(runWebhookTask).toHaveBeenCalledWith(webhookTask, {
        timeoutMs: 5 * 60_000,
      });

      process.emit('SIGTERM', 'SIGTERM');
      await handler;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
    }
  });

  it('rejects webhook IPC messages when the worker webhook queue is full', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    const validateWebhookTask = vi.fn();
    const taskResolves: Array<() => void> = [];
    const runWebhookTask = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          taskResolves.push(resolve);
        }),
    );
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      name: 'telegram',
      validateWebhookTask,
      runWebhookTask,
    });
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');
    const existingMessageListeners = process.listeners('message');

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'ready' }),
        );
      });
      send.mockClear();

      const webhookListener = process
        .listeners('message')
        .find((listener) => !existingMessageListeners.includes(listener));
      expect(webhookListener).toBeDefined();
      for (let i = 0; i < 17; i++) {
        (webhookListener as ((message: unknown) => void) | undefined)?.({
          type: 'webhook_task',
          id: `webhook-${i}`,
          expiresAt: Date.now() + 1000,
          task: webhookTask,
        });
      }

      expect(send).toHaveBeenCalledWith({
        type: 'webhook_task_result',
        id: 'webhook-16',
        ok: false,
        code: 'channel_webhook_queue_full',
        error: 'Channel webhook task queue is full.',
      });
      expect(runWebhookTask).toHaveBeenCalledTimes(16);

      for (const resolve of taskResolves) {
        resolve();
      }
      process.emit('SIGTERM', 'SIGTERM');
      await handler;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
    }
  });

  it('logs background webhook task failures after acking the IPC message', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    const validateWebhookTask = vi.fn();
    const runWebhookTask = vi.fn().mockRejectedValue(new Error('run boom'));
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      name: 'telegram',
      validateWebhookTask,
      runWebhookTask,
    });
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');
    const existingMessageListeners = process.listeners('message');

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'ready' }),
        );
      });
      send.mockClear();

      const webhookListener = process
        .listeners('message')
        .find((listener) => !existingMessageListeners.includes(listener));
      expect(webhookListener).toBeDefined();
      (webhookListener as ((message: unknown) => void) | undefined)?.({
        type: 'webhook_task',
        id: 'webhook-1',
        expiresAt: Date.now() + 1000,
        task: webhookTask,
      });

      expect(send).toHaveBeenCalledWith({
        type: 'webhook_task_result',
        id: 'webhook-1',
        ok: true,
      });
      await vi.waitFor(() => {
        expect(mockWriteStderrLine).toHaveBeenCalledWith(
          '[Channel] webhook task failed ' +
            '(id=webhook-1, channel=telegram, source=github-ci): run boom',
        );
      });

      process.emit('SIGTERM', 'SIGTERM');
      await handler;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
    }
  });

  it('drains acknowledged webhook tasks before shutting down', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    const validateWebhookTask = vi.fn();
    let resolveTask!: () => void;
    const runWebhookTask = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveTask = resolve;
        }),
    );
    const disconnect = vi.fn().mockResolvedValue(undefined);
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect,
      name: 'telegram',
      validateWebhookTask,
      runWebhookTask,
    });
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');
    const existingMessageListeners = process.listeners('message');

    try {
      const handler = daemonWorkerCommand.handler({
        channel: ['telegram'],
        _: [],
        $0: 'qwen',
      });
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'ready' }),
        );
      });
      send.mockClear();

      const webhookListener = process
        .listeners('message')
        .find((listener) => !existingMessageListeners.includes(listener));
      expect(webhookListener).toBeDefined();
      (webhookListener as ((message: unknown) => void) | undefined)?.({
        type: 'webhook_task',
        id: 'webhook-1',
        expiresAt: Date.now() + 1000,
        task: webhookTask,
      });

      expect(send).toHaveBeenCalledWith({
        type: 'webhook_task_result',
        id: 'webhook-1',
        ok: true,
      });

      process.emit('SIGTERM', 'SIGTERM');
      await vi.waitFor(() => {
        expect(mockWriteStderrLine).toHaveBeenCalledWith(
          '[Channel] shutdown: draining 1 webhook task(s)...',
        );
      });
      expect(disconnect).not.toHaveBeenCalled();

      resolveTask();
      await handler;
      expect(disconnect).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
    }
  });
});
