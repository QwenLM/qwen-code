import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import { CHANNEL_WORKER_KILL_GRACE_MS } from '@qwen-code/acp-bridge/channelControlTimeouts';
import {
  BoundSessionGoneError,
  BoundSessionQueueFullError,
  BoundSessionUnavailableError,
  CHANNEL_PROMPT_AUTHORIZATION_META_KEY,
  CHANNEL_PROMPT_META_KEY,
} from '@qwen-code/channel-base';
import type { ChannelBoundSessions } from '@qwen-code/channel-base';
import { CHANNEL_BOUND_RELAY_META_KEY } from '../../serve/channel-worker-prompt-authorization.js';

const mockCanonicalizeWorkspace = vi.hoisted(() => vi.fn((p: string) => p));
const mockLoadChannelsConfig = vi.hoisted(() => vi.fn());
const mockLoadChannelsFromExtensions = vi.hoisted(() => vi.fn());
const mockParseConfiguredChannels = vi.hoisted(() => vi.fn());
const mockCreateChannel = vi.hoisted(() => vi.fn());
const mockResolveChannelLocale = vi.hoisted(() =>
  vi.fn((value: unknown) => (value === 'Chinese' ? 'zh' : 'en')),
);
const mockReadChannelMemory = vi.hoisted(() => vi.fn());
const mockGetChannelMemoryRevision = vi.hoisted(() => vi.fn());
const mockListChannelMemoryEntries = vi.hoisted(() => vi.fn());
const mockAddChannelMemoryEntries = vi.hoisted(() => vi.fn());
const mockUpdateChannelMemoryEntry = vi.hoisted(() => vi.fn());
const mockRemoveChannelMemoryEntries = vi.hoisted(() => vi.fn());
const mockClearChannelMemory = vi.hoisted(() => vi.fn());
const mockRecordChannelMemoryRecallMetrics = vi.hoisted(() => vi.fn());
const mockNextFireTime = vi.hoisted(() =>
  vi.fn(() => new Date('2026-01-01T00:01:00.000Z')),
);
const mockParseCron = vi.hoisted(() => vi.fn());
const mockRegisterToolCallDispatch = vi.hoisted(() => vi.fn());
const mockRegisterBackgroundResponseRelay = vi.hoisted(() => vi.fn());
const mockRegisterPermissionRelay = vi.hoisted(() => vi.fn());
const mockRegisterSessionCleanup = vi.hoisted(() => vi.fn());
const mockSessionsPath = vi.hoisted(() => vi.fn(() => '/tmp/sessions.json'));
const mockDaemonSessionRoutesPath = vi.hoisted(() =>
  vi.fn(() => '/tmp/qwen/channels/daemon/workspace-hash/routes.json'),
);
const mockDaemonChannelLoopPath = vi.hoisted(() =>
  vi.fn(() => '/tmp/qwen/channels/daemon/workspace-hash/cron.json'),
);
const mockDaemonObservedContactsPath = vi.hoisted(() =>
  vi.fn(
    () => '/tmp/qwen/channels/daemon/workspace-hash/observed-contacts.json',
  ),
);
const mockDaemonChannelStateDir = vi.hoisted(() =>
  vi.fn(
    (workspace: string, channelName: string) =>
      `/tmp/qwen/channels/daemon/${workspace === '/workspace' ? 'workspace-hash' : 'other-hash'}/instances/${channelName}-hash`,
  ),
);
const mockObserveContact = vi.hoisted(() => vi.fn());
const mockListContacts = vi.hoisted(() => vi.fn());
const mockObservedContactStore = vi.hoisted(() =>
  vi.fn(() => ({
    observe: mockObserveContact,
    list: mockListContacts,
  })),
);
const mockLoadSettings = vi.hoisted(() =>
  vi.fn(
    (
      _cwd?: string,
      _opts?: unknown,
    ): {
      merged: {
        proxy?: string;
        experimental?: { cron?: boolean };
        general?: { language?: string };
      };
    } => ({
      merged: { proxy: 'http://settings-proxy:8080' },
    }),
  ),
);
const mockResolveProxyUrl = vi.hoisted(() =>
  vi.fn((_cliProxy?: string, settingsProxy?: string) => settingsProxy),
);
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLineSafe = vi.hoisted(() => vi.fn());
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
const mockIsChannelProactiveDeliveryError = vi.hoisted(() =>
  vi.fn(
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code ===
        'channel_proactive_delivery_error' &&
      ((error as { disposition?: unknown }).disposition === 'permanent' ||
        (error as { disposition?: unknown }).disposition === 'transient'),
  ),
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
  resume: vi.fn(),
  resetWorktree: vi.fn(),
}));

const mockBridgeStart = vi.hoisted(() => vi.fn());
const mockBridgeStop = vi.hoisted(() => vi.fn());
const mockBridgeOn = vi.hoisted(() => vi.fn());
const mockBridgeOff = vi.hoisted(() => vi.fn());
const mockBridgeNewSession = vi.hoisted(() => vi.fn());
const mockBridgeLoadSession = vi.hoisted(() => vi.fn());
const mockBridgePrompt = vi.hoisted(() => vi.fn());
const mockBridgeBtw = vi.hoisted(() => vi.fn());
const mockBridgeCancelSession = vi.hoisted(() => vi.fn());
const mockBridgeDiscardSession = vi.hoisted(() => vi.fn());
const mockBridgeRespondToPermission = vi.hoisted(() => vi.fn());
const mockBridgeShellCommand = vi.hoisted(() => vi.fn());
const mockBridgeGetAvailableCommands = vi.hoisted(() => vi.fn(() => []));
const mockBridgeRegisterChannelLoopToolHandler = vi.hoisted(() => vi.fn());
const mockChannelLoopStoreCreate = vi.hoisted(() => vi.fn());
const mockChannelLoopStoreCreateForTarget = vi.hoisted(() => vi.fn());
const mockChannelLoopStoreList = vi.hoisted(() => vi.fn());
const mockChannelLoopStoreListForTarget = vi.hoisted(() => vi.fn());
const mockChannelLoopStoreDisable = vi.hoisted(() => vi.fn());
const mockChannelLoopStore = vi.hoisted(() =>
  vi.fn(() => ({
    create: mockChannelLoopStoreCreate,
    createForTarget: mockChannelLoopStoreCreateForTarget,
    list: mockChannelLoopStoreList,
    listForTarget: mockChannelLoopStoreListForTarget,
    disable: mockChannelLoopStoreDisable,
  })),
);
const mockChannelLoopSchedulerStart = vi.hoisted(() => vi.fn());
const mockChannelLoopSchedulerStop = vi.hoisted(() => vi.fn());
const mockChannelLoopScheduler = vi.hoisted(() =>
  vi.fn((_options?: unknown) => ({
    start: mockChannelLoopSchedulerStart,
    stop: mockChannelLoopSchedulerStop,
  })),
);
const mockDaemonChannelBridge = vi.hoisted(() =>
  vi.fn((_options?: unknown) => ({
    get availableCommands() {
      return [];
    },
    getAvailableCommands: mockBridgeGetAvailableCommands,
    on: mockBridgeOn,
    off: mockBridgeOff,
    newSession: mockBridgeNewSession,
    loadSession: mockBridgeLoadSession,
    prompt: mockBridgePrompt,
    btw: mockBridgeBtw,
    cancelSession: mockBridgeCancelSession,
    discardSession: mockBridgeDiscardSession,
    respondToPermission: mockBridgeRespondToPermission,
    shellCommand: mockBridgeShellCommand,
    registerChannelLoopToolHandler: mockBridgeRegisterChannelLoopToolHandler,
    start: mockBridgeStart,
    stop: mockBridgeStop,
  })),
);
const mockRouterSetChannelScope = vi.hoisted(() => vi.fn());
const mockRouterSetChannelApprovalMode = vi.hoisted(() => vi.fn());
const mockRouterSetChannelLoopsEnabled = vi.hoisted(() => vi.fn());
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
      setChannelLoopsEnabled: mockRouterSetChannelLoopsEnabled,
      clearAll: mockRouterClearAll,
      restoreRoutes: mockRouterRestoreRoutes,
      dispose: mockRouterDispose,
    }),
  ),
);

const mockNetworkInterfaces = vi.hoisted(() => ({
  value: undefined as NodeJS.Dict<os.NetworkInterfaceInfo[]> | undefined,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const networkInterfaces = () =>
    mockNetworkInterfaces.value ?? actual.networkInterfaces();
  return {
    ...actual,
    networkInterfaces,
    default: { ...actual, networkInterfaces },
  };
});

vi.mock('@qwen-code/acp-bridge/workspacePaths', () => ({
  canonicalizeWorkspace: mockCanonicalizeWorkspace,
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  addChannelMemoryEntries: mockAddChannelMemoryEntries,
  clearChannelMemory: mockClearChannelMemory,
  getChannelMemoryRevision: mockGetChannelMemoryRevision,
  listChannelMemoryEntries: mockListChannelMemoryEntries,
  nextFireTime: mockNextFireTime,
  parseCron: mockParseCron,
  readChannelMemory: mockReadChannelMemory,
  recordChannelMemoryRecallMetrics: mockRecordChannelMemoryRecallMetrics,
  removeChannelMemoryEntries: mockRemoveChannelMemoryEntries,
  updateChannelMemoryEntry: mockUpdateChannelMemoryEntry,
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
  writeStderrLineSafe: mockWriteStderrLineSafe,
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
  daemonChannelLoopPath: mockDaemonChannelLoopPath,
  daemonChannelStateDir: mockDaemonChannelStateDir,
  daemonObservedContactsPath: mockDaemonObservedContactsPath,
  daemonSessionRoutesPath: mockDaemonSessionRoutesPath,
  loadChannelsConfig: mockLoadChannelsConfig,
  loadChannelsFromExtensions: mockLoadChannelsFromExtensions,
  parseConfiguredChannels: mockParseConfiguredChannels,
  registerBackgroundResponseRelay: mockRegisterBackgroundResponseRelay,
  registerPermissionRelay: mockRegisterPermissionRelay,
  registerSessionCleanup: mockRegisterSessionCleanup,
  registerToolCallDispatch: mockRegisterToolCallDispatch,
  resolveChannelLocale: mockResolveChannelLocale,
  selectFirstModel: mockSelectFirstModel,
  sessionsPath: mockSessionsPath,
}));

vi.mock('./observed-contact-store.js', () => ({
  OBSERVED_CONTACT_MAX_FRESH_WITHIN_SECONDS: 365 * 24 * 60 * 60,
  ObservedChannelContactStore: mockObservedContactStore,
}));

vi.mock('@qwen-code/channel-base', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/channel-base')>();
  return {
    ...actual,
    ChannelLoopScheduler: mockChannelLoopScheduler,
    ChannelLoopStore: mockChannelLoopStore,
    DaemonChannelBridge: mockDaemonChannelBridge,
    isChannelProactiveDeliveryError: mockIsChannelProactiveDeliveryError,
    sanitizeLogText: mockSanitizeLogText,
    SessionRouter: mockSessionRouter,
  };
});

vi.mock('@qwen-code/sdk/daemon', () => ({
  DaemonClient: mockDefaultDaemonClient,
  DaemonSessionClient: mockDefaultDaemonSessionClient,
}));

import {
  createBoundSessionsAccessor,
  createDaemonChannelBridgeFacade,
  createDaemonSessionFactory,
  daemonWorkerCommand,
  runChannelDaemonWorker,
} from './daemon-worker.js';
import { isOwnInterfaceAddress } from '../../serve/local-bind-addresses.js';

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

const deliveryRequest = {
  deliveryId: 'delivery-1',
  channelName: 'telegram',
  target: { type: 'chat' as const, id: 'group-1' },
  text: 'inspection result',
};

function createSdk() {
  const deleteSessionsData = vi.fn().mockResolvedValue({
    removed: ['classifier-session'],
    notFound: [],
    errors: [],
  });
  const client = {
    capabilities: vi.fn().mockResolvedValue({
      v: 1,
      mode: 'http-bridge',
      features: [],
      modelServices: [],
      workspaceCwd: '/workspace',
    }),
    requestRest: vi.fn(),
    workspaceByCwd: vi.fn(() => ({ deleteSessionsData })),
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
    resume: vi.fn().mockResolvedValue({
      sessionId: 'loaded-session',
      workspaceCwd: '/workspace',
      prompt: vi.fn(),
      events: vi.fn(),
      cancel: vi.fn(),
      setModel: vi.fn(),
      respondToPermission: vi.fn(),
    }),
    resetWorktree: vi.fn().mockResolvedValue({
      sessionId: 'reset-session',
      workspaceCwd: '/workspace',
      prompt: vi.fn(),
      events: vi.fn(),
      cancel: vi.fn(),
      setModel: vi.fn(),
      respondToPermission: vi.fn(),
    }),
  };
  return { client, DaemonClient, DaemonSessionClient, deleteSessionsData };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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
    runLoopPrompt: vi.fn().mockResolvedValue('done'),
    validateWebhookTask: vi.fn(),
  }));
  mockLoadChannelsConfig.mockReturnValue({
    telegram: { type: 'telegram' },
    feishu: { type: 'feishu' },
  });
  mockLoadChannelsFromExtensions.mockResolvedValue(0);
  mockParseConfiguredChannels.mockResolvedValue([parsedTelegram]);
  mockChannelLoopStoreCreate.mockResolvedValue({ id: 'job-1' });
  mockChannelLoopStoreCreateForTarget.mockResolvedValue({ id: 'job-1' });
  mockChannelLoopStoreList.mockResolvedValue([]);
  mockChannelLoopStoreListForTarget.mockResolvedValue([]);
  mockChannelLoopStoreDisable.mockResolvedValue(true);
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
  it('tags created and resumed channel sessions', async () => {
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
    expect(sdk.DaemonSessionClient.resume).toHaveBeenCalledWith(
      sdk.client,
      'existing-session',
      {
        workspaceCwd: '/workspace',
        modelServiceId: 'qwen-plus',
        sessionScope: 'thread',
        sourceType: 'channel',
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
    expect(sdk.DaemonSessionClient.resume).toHaveBeenCalledWith(
      sdk.client,
      'existing-session',
      {
        workspaceCwd: '/workspace',
        approvalMode: 'yolo',
        sessionScope: 'thread',
        sourceType: 'channel',
      },
      'qwen-channel-worker',
    );
  });

  it('stamps channel sourceId on created and resumed sessions', async () => {
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
    expect(sdk.DaemonSessionClient.resume).toHaveBeenCalledWith(
      sdk.client,
      'existing-session',
      {
        workspaceCwd: '/workspace',
        sessionScope: 'thread',
        sourceType: 'channel',
        sourceId: 'dingtalk-main',
      },
      'qwen-channel-worker',
    );
  });

  it('forwards worktree isolation only while creating a session', async () => {
    const sdk = createSdk();
    const factory = createDaemonSessionFactory({
      client: sdk.client,
      DaemonSessionClient: sdk.DaemonSessionClient,
      clientId: 'qwen-channel-worker',
    });

    await factory({ workspaceCwd: '/workspace', worktree: {} });
    await factory({
      workspaceCwd: '/workspace',
      sessionId: 'existing-session',
      worktree: {},
    });

    expect(sdk.DaemonSessionClient.createOrAttach).toHaveBeenCalledWith(
      sdk.client,
      expect.objectContaining({ worktree: {} }),
      'qwen-channel-worker',
    );
    expect(sdk.DaemonSessionClient.resume).toHaveBeenCalledWith(
      sdk.client,
      'existing-session',
      expect.not.objectContaining({ worktree: expect.anything() }),
      'qwen-channel-worker',
    );
  });

  it('routes worktree resets through resetWorktree', async () => {
    const sdk = createSdk();
    const factory = createDaemonSessionFactory({
      client: sdk.client,
      DaemonSessionClient: sdk.DaemonSessionClient,
      clientId: 'qwen-channel-worker',
    });

    await factory({
      workspaceCwd: '/workspace',
      sourceId: 'dingtalk-main',
      worktreeReset: { sessionId: 'old-session' },
    });

    expect(sdk.DaemonSessionClient.resetWorktree).toHaveBeenCalledWith(
      sdk.client,
      'old-session',
      {
        workspaceCwd: '/workspace',
        sessionScope: 'thread',
        sourceType: 'channel',
        sourceId: 'dingtalk-main',
      },
    );
    expect(sdk.DaemonSessionClient.createOrAttach).not.toHaveBeenCalled();
    expect(sdk.DaemonSessionClient.resume).not.toHaveBeenCalled();
  });
});

describe('createDaemonChannelBridgeFacade', () => {
  it('forwards BTW when exposed independently of shell support', async () => {
    const btw = vi.fn().mockResolvedValue({
      sessionId: 'session-1',
      answer: 'side answer',
    });
    const bridge = {
      availableCommands: [],
      on: mockBridgeOn,
      off: mockBridgeOff,
      newSession: mockBridgeNewSession,
      loadSession: mockBridgeLoadSession,
      prompt: mockBridgePrompt,
      btw,
      cancelSession: mockBridgeCancelSession,
    };
    const facade = createDaemonChannelBridgeFacade(bridge, {
      exposeBtw: true,
      exposeShellCommand: false,
    });

    await facade.btw?.('session-1', 'question');

    expect(btw).toHaveBeenCalledWith('session-1', 'question');
    expect('shellCommand' in facade).toBe(false);
  });

  it('omits BTW when the daemon does not advertise BTW support', () => {
    const bridge = {
      availableCommands: [],
      on: mockBridgeOn,
      off: mockBridgeOff,
      newSession: mockBridgeNewSession,
      loadSession: mockBridgeLoadSession,
      prompt: mockBridgePrompt,
      btw: vi.fn(),
      cancelSession: mockBridgeCancelSession,
    };

    const facade = createDaemonChannelBridgeFacade(bridge, {
      exposeBtw: false,
      exposeShellCommand: false,
    });

    expect('btw' in facade).toBe(false);
  });

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
      exposeBtw: false,
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
      exposeBtw: false,
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
      exposeBtw: false,
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
      exposeBtw: false,
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
      exposeBtw: false,
      exposeShellCommand: false,
    });

    const response = { outcome: { outcome: 'cancelled' as const } };
    await expect(facade.respondToPermission?.('req-1', response)).resolves.toBe(
      true,
    );
    expect(respondToPermission).toHaveBeenCalledWith('req-1', response);
  });

  it('forwards permanent internal-session deletion when present', async () => {
    const deleteSessionData = vi.fn().mockResolvedValue(undefined);
    const bridge = {
      availableCommands: [],
      on: mockBridgeOn,
      off: mockBridgeOff,
      newSession: mockBridgeNewSession,
      loadSession: mockBridgeLoadSession,
      prompt: mockBridgePrompt,
      cancelSession: mockBridgeCancelSession,
      deleteSessionData,
    };
    const facade = createDaemonChannelBridgeFacade(bridge, {
      exposeBtw: false,
      exposeShellCommand: false,
    });

    await facade.deleteSessionData?.('classifier-session');

    expect(deleteSessionData).toHaveBeenCalledWith('classifier-session');
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
      exposeBtw: false,
      exposeShellCommand: false,
    });

    expect('respondToPermission' in facade).toBe(false);
    expect('discardSession' in facade).toBe(false);
    expect('deleteSessionData' in facade).toBe(false);
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
      exposeBtw: false,
      exposeShellCommand: false,
    });

    expect('listSessions' in facade).toBe(false);
  });

  it('forwards channel loop MCP registration through the daemon facade', () => {
    const registerChannelLoopToolHandler = vi.fn();
    const bridge = {
      availableCommands: [],
      on: mockBridgeOn,
      off: mockBridgeOff,
      newSession: mockBridgeNewSession,
      loadSession: mockBridgeLoadSession,
      prompt: mockBridgePrompt,
      cancelSession: mockBridgeCancelSession,
      registerChannelLoopToolHandler,
    };

    const facade = createDaemonChannelBridgeFacade(bridge, {
      exposeBtw: false,
      exposeShellCommand: false,
    });

    const handler = {
      create: vi.fn(),
      list: vi.fn(),
      cancel: vi.fn(),
    };
    facade.registerChannelLoopToolHandler?.(handler);

    expect(registerChannelLoopToolHandler).toHaveBeenCalledWith(handler);
  });

  it('forwards adapter channel tool registration through the daemon facade', () => {
    const registerChannelTool = vi.fn();
    const bridge = {
      availableCommands: [],
      on: mockBridgeOn,
      off: mockBridgeOff,
      newSession: mockBridgeNewSession,
      loadSession: mockBridgeLoadSession,
      prompt: mockBridgePrompt,
      cancelSession: mockBridgeCancelSession,
      registerChannelTool,
    };

    const facade = createDaemonChannelBridgeFacade(bridge, {
      exposeBtw: false,
      exposeShellCommand: false,
    });

    const tool = {
      name: 'qq_recall_message',
      description: 'Recall a QQ message.',
      inputSchema: { type: 'object', properties: {} },
      handler: vi.fn(),
    };
    facade.registerChannelTool?.(tool);

    expect(registerChannelTool).toHaveBeenCalledWith(tool);
  });
});

describe('runChannelDaemonWorker', () => {
  it('wires permanent classifier-session deletion to the worker workspace', async () => {
    const sdk = createSdk();
    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });
    const options = mockDaemonChannelBridge.mock.calls.at(-1)?.[0] as {
      deleteSessionData?: (sessionId: string) => Promise<void>;
    };

    await options.deleteSessionData?.('classifier-session');

    expect(sdk.client.workspaceByCwd).toHaveBeenCalledWith('/workspace');
    expect(sdk.deleteSessionsData).toHaveBeenCalledWith(['classifier-session']);
    await handle.close();
  });

  it('treats an already-deleted classifier session as deletion success', async () => {
    const sdk = createSdk();
    sdk.deleteSessionsData.mockResolvedValue({
      removed: [],
      notFound: ['classifier-session'],
      errors: [],
    });
    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });
    const options = mockDaemonChannelBridge.mock.calls.at(-1)?.[0] as {
      deleteSessionData?: (sessionId: string) => Promise<void>;
    };

    await expect(
      options.deleteSessionData?.('classifier-session'),
    ).resolves.toBeUndefined();
    await handle.close();
  });

  it('propagates per-session daemon deletion errors as a rejection', async () => {
    const sdk = createSdk();
    sdk.deleteSessionsData.mockResolvedValue({
      removed: [],
      notFound: [],
      errors: [{ sessionId: 'classifier-session', error: 'storage locked' }],
    });
    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });
    const options = mockDaemonChannelBridge.mock.calls.at(-1)?.[0] as {
      deleteSessionData?: (sessionId: string) => Promise<void>;
    };

    await expect(
      options.deleteSessionData?.('classifier-session'),
    ).rejects.toThrow('storage locked');
    await handle.close();
  });

  it('rejects when the deletion result omits the session entirely', async () => {
    const sdk = createSdk();
    sdk.deleteSessionsData.mockResolvedValue({
      removed: [],
      notFound: [],
      errors: [],
    });
    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });
    const options = mockDaemonChannelBridge.mock.calls.at(-1)?.[0] as {
      deleteSessionData?: (sessionId: string) => Promise<void>;
    };

    await expect(
      options.deleteSessionData?.('classifier-session'),
    ).rejects.toThrow('Session classifier-session was not deleted.');
    await handle.close();
  });

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
    const settings = {
      merged: {
        proxy: 'http://settings-proxy:8080',
        general: { language: 'en' },
      },
    };
    mockLoadSettings.mockReturnValueOnce(settings);
    vi.stubEnv('QWEN_CODE_LANG', 'zh');

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      daemonToken: 'secret-token',
      promptAuthorization: 'worker-prompt-token',
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
        promptAuthorization: 'worker-prompt-token',
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
          list: expect.any(Function),
        },
        stateDir:
          '/tmp/qwen/channels/daemon/workspace-hash/instances/telegram-hash',
        displayLanguage: 'zh',
      }),
    );
    expect(mockDaemonChannelStateDir).toHaveBeenCalledWith(
      '/workspace',
      'telegram',
    );
    expect(mockDaemonObservedContactsPath).toHaveBeenCalledWith('/workspace');
    expect(mockObservedContactStore).toHaveBeenCalledWith(
      '/tmp/qwen/channels/daemon/workspace-hash/observed-contacts.json',
    );
    const channelOptions = mockCreateChannel.mock.calls[0]![3] as {
      observedContacts: {
        observe(channelName: string, observation: unknown): unknown;
        list(): unknown;
      };
    };
    const observation = {
      user: { id: '42', label: 'Ada' },
      group: { id: 'group-1', label: 'group-1' },
    };
    channelOptions.observedContacts.observe('telegram', observation);
    expect(mockObserveContact).toHaveBeenCalledWith('telegram', observation);
    channelOptions.observedContacts.list();
    expect(mockListContacts).toHaveBeenCalledWith({
      freshWithinSeconds: 365 * 24 * 60 * 60,
    });
    expect(mockRegisterPermissionRelay).toHaveBeenCalledWith(
      bridgeFacade,
      mockSessionRouter.mock.results[0]!.value,
      expect.any(Map),
    );
    expect(mockRegisterBackgroundResponseRelay).toHaveBeenCalledWith(
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

  it('starts a workspace-scoped loop runtime for connected channels', async () => {
    const sdk = createSdk();
    const ready = vi.fn();

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
      sendReady: ready,
    });

    expect(mockDaemonChannelLoopPath).toHaveBeenCalledWith('/workspace');
    expect(mockChannelLoopStore).toHaveBeenCalledWith({
      filePath: '/tmp/qwen/channels/daemon/workspace-hash/cron.json',
    });
    const channelOptions = mockCreateChannel.mock.calls[0]![3] as {
      loopController?: {
        create: unknown;
        createForTarget: unknown;
        listForTarget: unknown;
        disable: unknown;
        validateCron: unknown;
        nextFireTime: unknown;
      };
    };
    expect(channelOptions.loopController).toEqual({
      create: expect.any(Function),
      createForTarget: expect.any(Function),
      listForTarget: expect.any(Function),
      disable: expect.any(Function),
      validateCron: expect.any(Function),
      nextFireTime: expect.any(Function),
    });
    const schedulerOptions = mockChannelLoopScheduler.mock.calls[0]![0] as {
      store: unknown;
      channels: Map<string, unknown>;
      nextFireTime: unknown;
    };
    expect(schedulerOptions.store).toBe(
      mockChannelLoopStore.mock.results[0]!.value,
    );
    expect([...schedulerOptions.channels.keys()]).toEqual(['telegram']);
    expect(schedulerOptions.nextFireTime).toBe(mockNextFireTime);
    expect(mockChannelLoopSchedulerStart).toHaveBeenCalledOnce();
    const channel = mockCreateChannel.mock.results[0]!.value as {
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    };
    expect(channel.connect.mock.invocationCallOrder[0]).toBeLessThan(
      mockChannelLoopSchedulerStart.mock.invocationCallOrder[0]!,
    );
    expect(
      mockChannelLoopSchedulerStart.mock.invocationCallOrder[0],
    ).toBeLessThan(ready.mock.invocationCallOrder[0]!);

    await handle.close();

    expect(mockChannelLoopSchedulerStop).toHaveBeenCalledOnce();
    expect(
      mockChannelLoopSchedulerStop.mock.invocationCallOrder[0],
    ).toBeLessThan(channel.disconnect.mock.invocationCallOrder[0]!);
    expect(channel.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      mockBridgeStop.mock.invocationCallOrder[0]!,
    );
  });

  it('waits for channel disconnect drains before stopping the bridge', async () => {
    const sdk = createSdk();
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const disconnect = vi.fn();
    const channel = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect,
      waitForDisconnect: vi.fn(() => {
        expect(disconnect).toHaveBeenCalledOnce();
        return drain;
      }),
      name: 'telegram',
      runLoopPrompt: vi.fn().mockResolvedValue('done'),
      validateWebhookTask: vi.fn(),
    };
    mockCreateChannel.mockReturnValueOnce(channel);

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    const closing = handle.close();
    await vi.waitFor(() =>
      expect(channel.waitForDisconnect).toHaveBeenCalled(),
    );
    expect(channel.disconnect).toHaveBeenCalledOnce();
    expect(channel.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      channel.waitForDisconnect.mock.invocationCallOrder[0]!,
    );
    expect(mockBridgeStop).not.toHaveBeenCalled();

    releaseDrain();
    await closing;

    expect(mockBridgeStop).toHaveBeenCalledOnce();
  });

  it('continues shutdown when a channel disconnect drain never settles', async () => {
    vi.useFakeTimers();
    try {
      const sdk = createSdk();
      const disconnect = vi.fn();
      const waitForDisconnect = vi.fn(() => new Promise<void>(() => {}));
      mockCreateChannel.mockReturnValueOnce({
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect,
        waitForDisconnect,
        name: 'telegram',
        runLoopPrompt: vi.fn().mockResolvedValue('done'),
        validateWebhookTask: vi.fn(),
      });
      const handle = await runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      });

      const closing = handle.close();
      await vi.advanceTimersByTimeAsync(7_999);
      expect(waitForDisconnect).toHaveBeenCalledOnce();
      expect(mockBridgeStop).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await closing;

      expect(mockWriteStderrLineSafe).toHaveBeenCalledWith(
        '[Channel] disconnect drain exceeded 8000ms; continuing worker shutdown.',
      );
      expect(mockBridgeStop).toHaveBeenCalledOnce();
      expect(mockRouterDispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts named sessions with per-channel state and no loop controller', async () => {
    const sdk = createSdk();
    mockParseConfiguredChannels.mockResolvedValueOnce([
      {
        ...parsedTelegram,
        config: {
          ...parsedTelegram.config,
          sessionScope: 'user',
          multiSession: true,
        },
      },
    ]);

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    expect(mockChannelLoopStoreList).toHaveBeenCalledOnce();
    expect(mockRouterSetChannelLoopsEnabled).toHaveBeenCalledWith(
      'telegram',
      false,
    );
    expect(mockCreateChannel).toHaveBeenCalledWith(
      'telegram',
      expect.objectContaining({ multiSession: true, sessionScope: 'user' }),
      expect.any(Object),
      expect.objectContaining({
        stateDir:
          '/tmp/qwen/channels/daemon/workspace-hash/instances/telegram-hash',
      }),
    );
    expect(mockCreateChannel.mock.calls[0]![3]).not.toHaveProperty(
      'loopController',
    );

    await handle.close();
  });

  it('passes the default Chinese language to daemon-managed channels', async () => {
    const sdk = createSdk();
    mockLoadSettings.mockReturnValueOnce({
      merged: { general: { language: 'Chinese' } },
    });

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      daemonToken: 'secret-token',
      promptAuthorization: 'worker-prompt-token',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    expect(mockCreateChannel.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({ locale: 'zh' }),
    );

    await handle.close();
  });

  it('fails closed when a named-session channel has an enabled loop', async () => {
    const sdk = createSdk();
    mockParseConfiguredChannels.mockResolvedValueOnce([
      {
        ...parsedTelegram,
        config: {
          ...parsedTelegram.config,
          sessionScope: 'user',
          multiSession: true,
        },
      },
    ]);
    mockChannelLoopStoreList.mockResolvedValueOnce([
      { channelName: 'telegram', enabled: true },
    ]);

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      }),
    ).rejects.toThrow('Disable the loop first');
    expect(mockCreateChannel).not.toHaveBeenCalled();
  });

  it('keeps disconnected channels out of the loop scheduler', async () => {
    const sdk = createSdk();
    const firstChannel = {
      connect: vi.fn().mockRejectedValue(new Error('first down')),
      disconnect: vi.fn(),
      name: 'first',
      runLoopPrompt: vi.fn(),
      validateWebhookTask: vi.fn(),
    };
    const secondChannel = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      name: 'second',
      runLoopPrompt: vi.fn(),
      validateWebhookTask: vi.fn(),
    };
    mockParseConfiguredChannels.mockResolvedValueOnce([
      { ...parsedTelegram, name: 'first' },
      { ...parsedTelegram, name: 'second' },
    ]);
    mockCreateChannel.mockImplementation((name: string) =>
      name === 'first' ? firstChannel : secondChannel,
    );

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
    });

    const schedulerOptions = mockChannelLoopScheduler.mock.calls[0]![0] as {
      channels: Map<string, unknown>;
    };
    expect([...schedulerOptions.channels.keys()]).toEqual(['second']);

    await handle.close();
  });

  it('disables daemon loop jobs owned by another workspace', async () => {
    const sdk = createSdk();
    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });
    const schedulerOptions = mockChannelLoopScheduler.mock.calls[0]![0] as {
      channels: Map<
        string,
        {
          runLoopPrompt(job: unknown): Promise<string | undefined>;
        }
      >;
    };
    const runner = schedulerOptions.channels.get('telegram')!;
    const channel = mockCreateChannel.mock.results[0]!.value as {
      runLoopPrompt: ReturnType<typeof vi.fn>;
    };

    await expect(
      runner.runLoopPrompt({ id: 'foreign-loop', cwd: '/other' }),
    ).rejects.toThrow('outside daemon workspace');
    expect(mockChannelLoopStoreDisable).toHaveBeenCalledWith('foreign-loop');
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      '[Channel] Disabled loop "foreign-loop": its workspace does not match this daemon worker.',
    );
    expect(channel.runLoopPrompt).not.toHaveBeenCalled();

    mockChannelLoopStoreDisable.mockRejectedValueOnce(new Error('disk full'));
    await expect(
      runner.runLoopPrompt({ id: 'unwritable-loop', cwd: '/other' }),
    ).rejects.toThrow('outside daemon workspace');
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      '[Channel] Disabled loop "unwritable-loop": its workspace does not match this daemon worker.',
    );
    expect(channel.runLoopPrompt).not.toHaveBeenCalled();

    await expect(
      runner.runLoopPrompt({ id: 'local-loop', cwd: '/workspace' }),
    ).resolves.toBe('done');
    expect(channel.runLoopPrompt).toHaveBeenCalledWith(
      { id: 'local-loop', cwd: '/workspace' },
      undefined,
    );

    await handle.close();
  });

  it('does not create loop runtime when cron is disabled in settings', async () => {
    const sdk = createSdk();
    mockLoadSettings.mockReturnValueOnce({
      merged: { experimental: { cron: false } },
    });

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    expect(mockDaemonChannelLoopPath).not.toHaveBeenCalled();
    expect(mockChannelLoopStore).not.toHaveBeenCalled();
    expect(mockChannelLoopScheduler).not.toHaveBeenCalled();
    expect(mockCreateChannel.mock.calls[0]![3]).not.toHaveProperty(
      'loopController',
    );

    await handle.close();
  });

  it('stops the loop scheduler when startup rolls back after connection', async () => {
    const sdk = createSdk();
    const sendReady = vi.fn(() => {
      throw new Error('ready failed');
    });

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
        sendReady,
      }),
    ).rejects.toThrow('ready failed');

    expect(mockChannelLoopSchedulerStart).toHaveBeenCalledOnce();
    expect(mockChannelLoopSchedulerStop).toHaveBeenCalledOnce();
    const channel = mockCreateChannel.mock.results[0]!.value as {
      disconnect: ReturnType<typeof vi.fn>;
    };
    expect(
      mockChannelLoopSchedulerStop.mock.invocationCallOrder[0],
    ).toBeLessThan(channel.disconnect.mock.invocationCallOrder[0]!);
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
    expect(mockRouterSetChannelApprovalMode.mock.calls).toEqual([
      ['telegram', 'yolo'],
      ['feishu', undefined],
    ]);
  });

  it.each(['plan', 'default', 'auto-edit', 'auto', 'yolo'])(
    'applies approval mode %s independently of webhook configuration',
    async (approvalMode) => {
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
          config: { ...parsedFeishu.config, approvalMode },
        },
      ]);

      await runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'all' },
        loadDaemonSdk: async () => sdk,
      });

      expect(mockRouterSetChannelApprovalMode.mock.calls).toEqual([
        ['telegram', 'yolo'],
        ['feishu', approvalMode],
      ]);
    },
  );

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

  it('omits BTW when capabilities do not include session_btw', async () => {
    const sdk = createSdk();

    await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    const bridgeFacade = mockSessionRouter.mock.calls[0]![0] as {
      btw?: unknown;
    };
    expect('btw' in bridgeFacade).toBe(false);
  });

  it('exposes BTW when capabilities include session_btw', async () => {
    const sdk = createSdk();
    sdk.client.capabilities.mockResolvedValueOnce({
      v: 1,
      mode: 'http-bridge',
      features: ['session_btw'],
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
      btw?: unknown;
    };
    expect(bridgeFacade.btw).toBeTypeOf('function');
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

  it('enables attachment uploads only when capabilities include session_attachments', async () => {
    const sdk = createSdk();
    sdk.client.capabilities.mockResolvedValueOnce({
      v: 1,
      mode: 'http-bridge',
      features: ['session_attachments'],
      modelServices: [],
      workspaceCwd: '/workspace',
    });

    await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    expect(mockDaemonChannelBridge).toHaveBeenCalledWith(
      expect.objectContaining({ sessionAttachments: true }),
    );
  });

  it('keeps attachment uploads off for daemons without session_attachments', async () => {
    const sdk = createSdk();

    await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    expect(mockDaemonChannelBridge).toHaveBeenCalledWith(
      expect.objectContaining({ sessionAttachments: false }),
    );
  });

  it('enables session-scoped permission votes when the daemon supports them', async () => {
    const sdk = createSdk();
    sdk.client.capabilities.mockResolvedValueOnce({
      v: 1,
      mode: 'http-bridge',
      features: ['session_permission_vote'],
      modelServices: [],
      workspaceCwd: '/workspace',
    });

    await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    expect(mockDaemonChannelBridge).toHaveBeenCalledWith(
      expect.objectContaining({ sessionPermissionVote: true }),
    );
  });

  it('keeps session-scoped permission votes off for older daemons', async () => {
    const sdk = createSdk();

    await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    expect(mockDaemonChannelBridge).toHaveBeenCalledWith(
      expect.objectContaining({ sessionPermissionVote: false }),
    );
  });

  it('enables worktree persistence only when the daemon advertises it', async () => {
    const sdk = createSdk();
    sdk.client.capabilities.mockResolvedValueOnce({
      v: 1,
      mode: 'http-bridge',
      features: ['session_worktree_persistence_v1'],
      modelServices: [],
      workspaceCwd: '/workspace',
    });

    await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    expect(mockDaemonChannelBridge).toHaveBeenCalledWith(
      expect.objectContaining({ sessionWorktreePersistence: true }),
    );
  });

  it('keeps worktree persistence off when the daemon omits the capability', async () => {
    const sdk = createSdk();

    await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    expect(mockDaemonChannelBridge).toHaveBeenCalledWith(
      expect.objectContaining({ sessionWorktreePersistence: false }),
    );
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

  it('rejects daemon URLs that name no address on this host', async () => {
    const sdk = createSdk();

    for (const daemonUrl of [
      'http://attacker.example:4170',
      'https://attacker.example:4170',
    ]) {
      await expect(
        runChannelDaemonWorker({
          daemonUrl,
          workspace: '/workspace',
          selection: { mode: 'names', names: ['telegram'] },
          loadDaemonSdk: async () => sdk,
        }),
      ).rejects.toThrow(
        "QWEN_DAEMON_URL must use an http(s) loopback URL or a literal address of one of this machine's interfaces.",
      );
    }
    expect(sdk.DaemonClient).not.toHaveBeenCalled();
  });

  it('accepts https loopback daemon URLs for TLS daemons', async () => {
    const sdk = createSdk();
    mockLoadChannelsConfig.mockReturnValueOnce({
      telegram: { type: 'telegram' },
    });
    mockParseConfiguredChannels.mockResolvedValueOnce([parsedTelegram]);

    await runChannelDaemonWorker({
      daemonUrl: 'https://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
    });

    expect(sdk.DaemonClient).toHaveBeenCalledWith({
      baseUrl: 'https://127.0.0.1:4170',
    });
  });

  it('accepts an IPv6 loopback daemon URL for a ::1-bound TLS daemon', async () => {
    // R2-14: formatChannelWorkerDaemonUrl emits `https://[::1]:<port>` for a
    // `::1` TLS bind, and this side accepts it only because `'[::1]'` sits in
    // LOOPBACK_BINDS. Nothing else pins that entry, so dropping it as
    // redundant keeps every test green while every ::1-bound TLS daemon's
    // workers reject their own URL at boot and restart-loop — the exact
    // failure this PR exists to remove, regressing on IPv6 alone.
    const sdk = createSdk();
    mockLoadChannelsConfig.mockReturnValueOnce({
      telegram: { type: 'telegram' },
    });
    mockParseConfiguredChannels.mockResolvedValueOnce([parsedTelegram]);

    await runChannelDaemonWorker({
      daemonUrl: 'https://[::1]:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
    });

    expect(sdk.DaemonClient).toHaveBeenCalledWith({
      baseUrl: 'https://[::1]:4170',
    });
  });

  // R2-4/R15-1: a daemon bound to a concrete interface listens on that
  // socket only — loopback is NOT bound, so rewriting the worker URL to
  // `127.0.0.1` would trade this validator's rejection for `ECONNREFUSED`.
  // The worker dials the bound address instead, and an own-interface address
  // keeps the daemon token on this host exactly as loopback does — the
  // property the rule protects. Without this widening the documented LAN
  // flow (`qwen serve --hostname <lan-ip> --channel …`) passes every boot
  // check (`assertChannelWorkerDaemonUrlIsLocal` certifies the bind) and
  // then throws in every worker: the first one exits the daemon, later ones
  // restart-loop with /health green.
  it("accepts a daemon URL bound to one of this host's own interfaces", async () => {
    const ownAddress = Object.values(os.networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => entry.family === 'IPv4' && !entry.internal)?.address;
    // A machine with no non-loopback IPv4 interface cannot exercise this.
    if (!ownAddress) return;

    const sdk = createSdk();
    mockLoadChannelsConfig.mockReturnValueOnce({
      telegram: { type: 'telegram' },
    });
    mockParseConfiguredChannels.mockResolvedValueOnce([parsedTelegram]);

    await runChannelDaemonWorker({
      daemonUrl: `https://${ownAddress}:4170`,
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
    });

    expect(sdk.DaemonClient).toHaveBeenCalledWith({
      baseUrl: `https://${ownAddress}:4170`,
    });
  });

  // The widening is to THIS host's addresses, not to routable addresses in
  // general: a literal that belongs to no local interface stays rejected, so
  // the daemon token still cannot be aimed off-box.
  it('still rejects a routable address that is not on this host', async () => {
    const sdk = createSdk();

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'https://203.0.113.7:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      }),
    ).rejects.toThrow(
      "QWEN_DAEMON_URL must use an http(s) loopback URL or a literal address of one of this machine's interfaces.",
    );
    expect(sdk.DaemonClient).not.toHaveBeenCalled();
  });

  it('accepts an IPv4 loopback spelling the daemon bound', async () => {
    const sdk = createSdk();
    mockLoadChannelsConfig.mockReturnValueOnce({
      telegram: { type: 'telegram' },
    });
    mockParseConfiguredChannels.mockResolvedValueOnce([parsedTelegram]);

    await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.2:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    expect(sdk.DaemonClient).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.2:4170',
    });
  });

  it('accepts an assigned wide loopback', async () => {
    const sdk = createSdk();
    mockLoadChannelsConfig.mockReturnValueOnce({
      telegram: { type: 'telegram' },
    });
    mockParseConfiguredChannels.mockResolvedValueOnce([parsedTelegram]);
    mockNetworkInterfaces.value = {
      lo: [
        {
          address: '127.0.0.1',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.1/8',
        },
        {
          address: '127.0.0.2',
          netmask: '255.0.0.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '127.0.0.2/8',
        },
        {
          address: '::1',
          netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
          family: 'IPv6',
          mac: '00:00:00:00:00:00',
          internal: true,
          cidr: '::1/128',
          scopeid: 0,
        },
      ],
    };
    try {
      expect(isOwnInterfaceAddress('127.0.0.2')).toBe(true);
      await runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.2:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      });
      expect(sdk.DaemonClient).toHaveBeenCalledWith({
        baseUrl: 'http://127.0.0.2:4170',
      });
    } finally {
      mockNetworkInterfaces.value = undefined;
    }
  });

  it('accepts the canonical loopback spellings', async () => {
    const sdk = createSdk();
    mockLoadChannelsConfig.mockReturnValueOnce({
      telegram: { type: 'telegram' },
    });
    mockParseConfiguredChannels.mockResolvedValueOnce([parsedTelegram]);

    await runChannelDaemonWorker({
      daemonUrl: 'http://localhost:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
    });

    expect(sdk.DaemonClient).toHaveBeenCalledWith({
      baseUrl: 'http://localhost:4170',
    });
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

  it('waits for a failed adapter to drain during startup rollback', async () => {
    const sdk = createSdk();
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const disconnect = vi.fn();
    const waitForDisconnect = vi.fn(() => {
      expect(disconnect).toHaveBeenCalled();
      return drain;
    });
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockRejectedValue(new Error('connect boom')),
      disconnect,
      waitForDisconnect,
      name: 'telegram',
    });

    const starting = runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });
    const rejection = starting.catch((error: unknown) => error);
    await vi.waitFor(() => expect(waitForDisconnect).toHaveBeenCalled());

    expect(mockBridgeStop).not.toHaveBeenCalled();

    releaseDrain();
    expect(await rejection).toEqual(
      expect.objectContaining({ message: 'No channels connected.' }),
    );

    expect(mockBridgeStop).toHaveBeenCalledOnce();
  });

  it('continues startup rollback when a disconnect drain never settles', async () => {
    vi.useFakeTimers();
    try {
      const sdk = createSdk();
      const disconnect = vi.fn();
      const waitForDisconnect = vi.fn(() => new Promise<void>(() => {}));
      mockCreateChannel.mockResolvedValueOnce({
        connect: vi.fn().mockRejectedValue(new Error('connect boom')),
        disconnect,
        waitForDisconnect,
        name: 'telegram',
      });

      const rejection = runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(CHANNEL_WORKER_KILL_GRACE_MS - 1);

      expect(await rejection).toEqual(
        expect.objectContaining({ message: 'No channels connected.' }),
      );
      expect(waitForDisconnect).toHaveBeenCalledOnce();
      expect(mockBridgeStop).toHaveBeenCalledOnce();
      expect(mockRouterDispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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

  it('waits for asynchronous channel cleanup before closing', async () => {
    const sdk = createSdk();
    let finishDisconnect!: () => void;
    // disconnectChannels discards the disconnect() return value and awaits
    // only waitForDisconnect, so the pending promise must hang off that hook
    // for the test to detect a regression that closes before the drain.
    const disconnect = vi.fn();
    const waitForDisconnect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDisconnect = resolve;
        }),
    );
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect,
      waitForDisconnect,
      name: 'telegram',
    });

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });
    let closed = false;
    const closing = handle.close().then(() => {
      closed = true;
    });

    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(waitForDisconnect).toHaveBeenCalledOnce());
    // Let a real macrotask elapse: if close did not await the drain, it
    // would have settled by now.
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    finishDisconnect();
    await closing;

    expect(closed).toBe(true);
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

  it('delivers existing text on the matching channel without an agent turn', async () => {
    const sdk = createSdk();
    const deliverProactive = vi.fn().mockResolvedValue(undefined);
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      name: 'telegram',
      validateWebhookTask: vi.fn(),
      deliverProactive,
    });

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    await handle.deliverChannelMessage(deliveryRequest);

    expect(deliverProactive).toHaveBeenCalledWith(
      { channelName: 'telegram', ...deliveryRequest.target },
      deliveryRequest.text,
    );
    expect(mockBridgePrompt).not.toHaveBeenCalled();
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

  describe('bound-session delivery wiring', () => {
    function boundSessionResponse(): Response {
      return jsonResponse(200, {
        bindings: [
          {
            sessionId: 'bound-1',
            workspaceCwd: '/ws/bound',
            prs: [{ number: 7, url: 'https://github.com/o/r/pull/7' }],
          },
        ],
        partial: false,
      });
    }

    async function startBoundWorker(
      sdk: ReturnType<typeof createSdk>,
      promptAuthorization?: string,
    ) {
      const handle = await runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        loadDaemonSdk: async () => sdk,
        ...(promptAuthorization ? { promptAuthorization } : {}),
      });
      const channelOptions = mockCreateChannel.mock.calls[0]![3] as {
        boundSessions?: ChannelBoundSessions;
      };
      const boundSessions = channelOptions.boundSessions;
      if (!boundSessions) {
        throw new Error(
          'Expected the channel factory to receive boundSessions',
        );
      }
      return { handle, boundSessions };
    }

    it('wakes dormant bound sessions through the SDK resume and releases after the retry', async () => {
      const sdk = createSdk();
      const detach = vi.fn().mockResolvedValue(undefined);
      sdk.DaemonSessionClient.resume.mockResolvedValue({ detach });
      sdk.client.requestRest
        .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
        .mockResolvedValueOnce(boundSessionResponse())
        .mockResolvedValueOnce(jsonResponse(202, { promptId: 'p-1' }));

      const { handle, boundSessions } = await startBoundWorker(
        sdk,
        'worker-prompt-token',
      );

      await boundSessions.deliverPrompt('bound-1', 'event text');

      expect(sdk.DaemonSessionClient.resume).toHaveBeenCalledTimes(1);
      expect(sdk.DaemonSessionClient.resume).toHaveBeenCalledWith(
        sdk.client,
        'bound-1',
        { workspaceCwd: '/ws/bound', sessionScope: 'thread' },
        `qwen-channel-worker:${process.pid}`,
      );
      const retryInit = sdk.client.requestRest.mock.calls[2]![1] as RequestInit;
      expect(JSON.parse(String(retryInit.body))).toEqual({
        prompt: [{ type: 'text', text: 'event text' }],
        _meta: {
          [CHANNEL_PROMPT_META_KEY]: true,
          [CHANNEL_BOUND_RELAY_META_KEY]: true,
          [CHANNEL_PROMPT_AUTHORIZATION_META_KEY]: 'worker-prompt-token',
        },
      });
      expect(detach).toHaveBeenCalledOnce();
      expect(sdk.client.requestRest.mock.invocationCallOrder[2]).toBeLessThan(
        detach.mock.invocationCallOrder[0]!,
      );
      await handle.close();
    });

    it('maps a 404 wake failure to BoundSessionGoneError', async () => {
      const sdk = createSdk();
      sdk.DaemonSessionClient.resume.mockRejectedValue({ status: 404 });
      sdk.client.requestRest
        .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
        .mockResolvedValueOnce(boundSessionResponse());

      const { handle, boundSessions } = await startBoundWorker(sdk);

      await expect(
        boundSessions.deliverPrompt('bound-1', 'x'),
      ).rejects.toBeInstanceOf(BoundSessionGoneError);
      expect(sdk.DaemonSessionClient.resume).toHaveBeenCalledTimes(1);
      expect(sdk.client.requestRest).toHaveBeenCalledTimes(2);
      await handle.close();
    });

    it('maps an unavailable wake failure to BoundSessionUnavailableError', async () => {
      const sdk = createSdk();
      sdk.DaemonSessionClient.resume.mockRejectedValue({
        status: 503,
        body: { code: 'workspace_runtime_unavailable' },
      });
      sdk.client.requestRest
        .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
        .mockResolvedValueOnce(boundSessionResponse());

      const { handle, boundSessions } = await startBoundWorker(sdk);

      await expect(
        boundSessions.deliverPrompt('bound-1', 'x'),
      ).rejects.toBeInstanceOf(BoundSessionUnavailableError);
      expect(sdk.client.requestRest).toHaveBeenCalledTimes(2);
      await handle.close();
    });

    it.each([429, 500, 502])(
      'maps wake HTTP %i to BoundSessionUnavailableError (R5-B1)',
      async (status) => {
        const sdk = createSdk();
        sdk.DaemonSessionClient.resume.mockRejectedValue({
          status,
          body: { code: status === 429 ? 'rate_limited' : 'internal_error' },
        });
        sdk.client.requestRest
          .mockResolvedValueOnce(
            jsonResponse(404, { code: 'session_not_found' }),
          )
          .mockResolvedValueOnce(boundSessionResponse());

        const { handle, boundSessions } = await startBoundWorker(sdk);

        // The resume mutation rate limit (429) and spawn/handshake jitter
        // (5xx) are transient: classifying them as delivery failures would
        // burn the attempt budget and dead-letter a recoverable event.
        await expect(
          boundSessions.deliverPrompt('bound-1', 'x'),
        ).rejects.toBeInstanceOf(BoundSessionUnavailableError);
        await handle.close();
      },
    );

    it('maps an archived wake conflict to BoundSessionGoneError', async () => {
      const sdk = createSdk();
      sdk.DaemonSessionClient.resume.mockRejectedValue({
        status: 409,
        body: { code: 'session_archived' },
      });
      sdk.client.requestRest
        .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
        .mockResolvedValueOnce(boundSessionResponse());

      const { handle, boundSessions } = await startBoundWorker(sdk);

      await expect(
        boundSessions.deliverPrompt('bound-1', 'x'),
      ).rejects.toBeInstanceOf(BoundSessionGoneError);
      expect(sdk.client.requestRest).toHaveBeenCalledTimes(2);
      await handle.close();
    });

    it('maps a superseded wake conflict to BoundSessionGoneError', async () => {
      const sdk = createSdk();
      sdk.DaemonSessionClient.resume.mockRejectedValue({
        status: 409,
        body: { code: 'worktree_session_superseded' },
      });
      sdk.client.requestRest
        .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
        .mockResolvedValueOnce(boundSessionResponse());

      const { handle, boundSessions } = await startBoundWorker(sdk);

      // A superseded session is never restored again; deferring it as
      // backpressure would dead-letter the event instead of falling back.
      await expect(
        boundSessions.deliverPrompt('bound-1', 'x'),
      ).rejects.toBeInstanceOf(BoundSessionGoneError);
      expect(sdk.client.requestRest).toHaveBeenCalledTimes(2);
      await handle.close();
    });

    it('maps a missing-worktree-marker wake conflict to BoundSessionGoneError', async () => {
      const sdk = createSdk();
      sdk.DaemonSessionClient.resume.mockRejectedValue({
        status: 409,
        body: { code: 'worktree_marker_missing' },
      });
      sdk.client.requestRest
        .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
        .mockResolvedValueOnce(boundSessionResponse());

      const { handle, boundSessions } = await startBoundWorker(sdk);

      // The repair is a worktree-reset retry, which a RESUME retry never
      // performs: deferring would dead-letter the event at the horizon.
      await expect(
        boundSessions.deliverPrompt('bound-1', 'x'),
      ).rejects.toBeInstanceOf(BoundSessionGoneError);
      expect(sdk.client.requestRest).toHaveBeenCalledTimes(2);
      await handle.close();
    });

    it('maps an interrupted-worktree reset wake conflict to BoundSessionGoneError', async () => {
      const sdk = createSdk();
      sdk.DaemonSessionClient.resume.mockRejectedValue({
        status: 409,
        body: { code: 'worktree_reset_interrupted' },
      });
      sdk.client.requestRest
        .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
        .mockResolvedValueOnce(boundSessionResponse());

      const { handle, boundSessions } = await startBoundWorker(sdk);

      await expect(
        boundSessions.deliverPrompt('bound-1', 'x'),
      ).rejects.toBeInstanceOf(BoundSessionGoneError);
      expect(sdk.client.requestRest).toHaveBeenCalledTimes(2);
      await handle.close();
    });

    it('maps a workspace-mismatch wake failure to BoundSessionUnavailableError', async () => {
      const sdk = createSdk();
      sdk.DaemonSessionClient.resume.mockRejectedValue({
        status: 400,
        body: { code: 'workspace_mismatch' },
      });
      sdk.client.requestRest
        .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
        .mockResolvedValueOnce(boundSessionResponse());

      const { handle, boundSessions } = await startBoundWorker(sdk);

      await expect(
        boundSessions.deliverPrompt('bound-1', 'x'),
      ).rejects.toBeInstanceOf(BoundSessionUnavailableError);
      expect(sdk.client.requestRest).toHaveBeenCalledTimes(2);
      await handle.close();
    });

    it('maps a restore-conflict wake failure to BoundSessionUnavailableError', async () => {
      const sdk = createSdk();
      sdk.DaemonSessionClient.resume.mockRejectedValue({
        status: 409,
        body: { code: 'restore_in_progress' },
      });
      sdk.client.requestRest
        .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
        .mockResolvedValueOnce(boundSessionResponse());

      const { handle, boundSessions } = await startBoundWorker(sdk);

      await expect(
        boundSessions.deliverPrompt('bound-1', 'x'),
      ).rejects.toBeInstanceOf(BoundSessionUnavailableError);
      expect(sdk.client.requestRest).toHaveBeenCalledTimes(2);
      await handle.close();
    });
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
    vi.stubEnv('QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN', 'guard-secret');
    vi.stubEnv('QWEN_MANAGED_RUNTIME_BROKER_TOKEN', 'broker-secret');
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
    expect(process.env['QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN']).toBeUndefined();
    expect(process.env['QWEN_MANAGED_RUNTIME_BROKER_TOKEN']).toBeUndefined();
    expect(process.env['QWEN_DAEMON_URL']).toBeUndefined();
    expect(process.env['QWEN_DAEMON_WORKSPACE']).toBeUndefined();
    expect(process.env['QWEN_CHANNEL_DAEMON_WORKER']).toBeUndefined();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      '[Channel] daemon worker failed: --channel requires a non-empty channel name.',
    );
  });

  // Regression for #8653: in dev mode the supervisor spawns the worker with
  // the daemon's loader-carrying base env (the harness tsx loader must reach
  // the worker's .ts entry). The worker must self-scrub like the ACP child
  // so nothing it spawns inherits them into another workspace. Production
  // base envs are scrubbed before the freeze, making this a no-op there.
  it('scrubs inherited loader env vars before starting channels', async () => {
    mockProcessExit();
    const restoreSend = stubProcessSend(vi.fn() as NodeJS.Process['send']);
    vi.stubEnv('QWEN_CHANNEL_DAEMON_WORKER', 'worker-token');
    vi.stubEnv('QWEN_DAEMON_URL', 'http://127.0.0.1:4170');
    vi.stubEnv('QWEN_DAEMON_WORKSPACE', '/workspace');
    vi.stubEnv('NODE_OPTIONS', '--import file:///other-checkout/register.mjs');
    vi.stubEnv(
      'npm_config_node-options',
      '--import file:///other-checkout/hook.mjs',
    );

    try {
      await expect(
        daemonWorkerCommand.handler({ channel: [' '], _: [], $0: 'qwen' }),
      ).rejects.toThrow('process.exit 1');
    } finally {
      restoreSend();
    }

    expect(process.env['NODE_OPTIONS']).toBeUndefined();
    expect(process.env['npm_config_node-options']).toBeUndefined();
    // Pin the channel-boundary breadcrumb, not just the removal: a refactor
    // onto the silent scrubInheritedLoaderEnv variant deletes the keys the
    // same way but drops the operator diagnostic — the reason the *AndReport*
    // helper exists.
    expect(mockWriteStderrLineSafe).toHaveBeenCalledWith(
      expect.stringContaining('scrubbed inherited loader env vars'),
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

  it('reports delivery success only after the adapter send completes', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    let resolveDelivery!: () => void;
    const deliverProactive = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelivery = resolve;
        }),
    );
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      name: 'telegram',
      validateWebhookTask: vi.fn(),
      deliverProactive,
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

      const listener = process
        .listeners('message')
        .find((candidate) => !existingMessageListeners.includes(candidate));
      (listener as ((message: unknown) => void) | undefined)?.({
        type: 'channel_delivery',
        id: 'ipc-delivery-1',
        expiresAt: Date.now() + 1000,
        request: deliveryRequest,
      });

      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'channel_delivery_result' }),
      );
      resolveDelivery();
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith({
          type: 'channel_delivery_result',
          id: 'ipc-delivery-1',
          ok: true,
        });
      });
      expect(mockBridgePrompt).not.toHaveBeenCalled();

      process.emit('SIGTERM', 'SIGTERM');
      await handler;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
    }
  });

  it('classifies permanent adapter failures without exposing control flow', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    const foreignError = Object.assign(new Error('recipient is invalid'), {
      code: 'channel_proactive_delivery_error',
      disposition: 'permanent',
    });
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      name: 'telegram',
      validateWebhookTask: vi.fn(),
      deliverProactive: vi.fn().mockRejectedValue(foreignError),
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

      const listener = process
        .listeners('message')
        .find((candidate) => !existingMessageListeners.includes(candidate));
      (listener as ((message: unknown) => void) | undefined)?.({
        type: 'channel_delivery',
        id: 'ipc-delivery-invalid',
        expiresAt: Date.now() + 1000,
        request: deliveryRequest,
      });

      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith({
          type: 'channel_delivery_result',
          id: 'ipc-delivery-invalid',
          ok: false,
          code: 'channel_delivery_rejected',
          error: 'recipient is invalid',
        });
      });

      process.emit('SIGTERM', 'SIGTERM');
      await handler;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
    }
  });

  it('rejects an expired delivery before calling the adapter', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    const deliverProactive = vi.fn().mockResolvedValue(undefined);
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      name: 'telegram',
      validateWebhookTask: vi.fn(),
      deliverProactive,
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

      const listener = process
        .listeners('message')
        .find((candidate) => !existingMessageListeners.includes(candidate));
      (listener as ((message: unknown) => void) | undefined)?.({
        type: 'channel_delivery',
        id: 'ipc-delivery-expired',
        expiresAt: Date.now() - 1,
        request: deliveryRequest,
      });

      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith({
          type: 'channel_delivery_result',
          id: 'ipc-delivery-expired',
          ok: false,
          code: 'channel_delivery_timeout',
          error: 'Channel delivery IPC timed out.',
        });
      });
      expect(deliverProactive).not.toHaveBeenCalled();

      process.emit('SIGTERM', 'SIGTERM');
      await handler;
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
    }
  });

  it('rejects delivery when sixteen adapter sends are already active', async () => {
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    const resolvers: Array<() => void> = [];
    const deliverProactive = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      name: 'telegram',
      validateWebhookTask: vi.fn(),
      deliverProactive,
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

      const listener = process
        .listeners('message')
        .find((candidate) => !existingMessageListeners.includes(candidate));
      for (let index = 0; index < 17; index++) {
        (listener as ((message: unknown) => void) | undefined)?.({
          type: 'channel_delivery',
          id: `ipc-delivery-${index}`,
          expiresAt: Date.now() + 1000,
          request: deliveryRequest,
        });
      }

      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith({
          type: 'channel_delivery_result',
          id: 'ipc-delivery-16',
          ok: false,
          code: 'channel_delivery_queue_full',
          error: 'Channel delivery queue is full.',
        });
      });
      expect(deliverProactive).toHaveBeenCalledTimes(16);

      for (const resolve of resolvers) resolve();
      process.emit('SIGTERM', 'SIGTERM');
      await handler;
      expect(exit).toHaveBeenCalledWith(0);
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

  it('uses one shutdown window for delivery and webhook tasks', async () => {
    vi.useFakeTimers();
    const exit = mockProcessExitNoThrow();
    const send = vi.fn();
    const restoreSend = stubProcessSend(send as NodeJS.Process['send']);
    const delayed = new Promise<void>((resolve) => {
      setTimeout(resolve, 5_000);
    });
    const never = new Promise<void>(() => undefined);
    const disconnect = vi.fn();
    const waitForDisconnect = vi.fn(() => never);
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect,
      waitForDisconnect,
      name: 'telegram',
      validateWebhookTask: vi.fn(),
      runWebhookTask: vi.fn(() => delayed),
      deliverProactive: vi.fn(() => delayed),
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
      const listener = process
        .listeners('message')
        .find((candidate) => !existingMessageListeners.includes(candidate));
      listener?.(
        {
          type: 'channel_delivery',
          id: 'delivery-drain',
          expiresAt: Date.now() + 1000,
          request: deliveryRequest,
        },
        undefined,
      );
      listener?.(
        {
          type: 'webhook_task',
          id: 'webhook-drain',
          expiresAt: Date.now() + 1000,
          task: webhookTask,
        },
        undefined,
      );

      process.emit('SIGTERM', 'SIGTERM');
      await vi.advanceTimersByTimeAsync(7_999);
      expect(mockBridgeStop).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await handler;

      expect(disconnect).toHaveBeenCalledOnce();
      expect(waitForDisconnect).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
      vi.useRealTimers();
    }
  });
});

describe('createBoundSessionsAccessor', () => {
  function makeClient(requestRest: ReturnType<typeof vi.fn>) {
    return {
      capabilities: vi.fn(),
      requestRest,
    } as never;
  }

  function bindingsResponse(partial = false): Response {
    return jsonResponse(200, {
      bindings: [
        {
          sessionId: 'session-1',
          workspaceCwd: '/ws/a',
          prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
        },
      ],
      partial,
    });
  }

  it('lists and validates PR bindings', async () => {
    const requestRest = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        bindings: [
          {
            sessionId: 'session-1',
            workspaceCwd: '/ws/a',
            sourceType: 'web-shell',
            updatedAt: '2026-11-01T10:00:00.000Z',
            prs: [
              {
                number: 101,
                url: 'https://github.com/acme/widgets/pull/101',
                state: 'open',
              },
              { number: 'bad', url: 'https://github.com/acme/widgets/pull/2' },
              { number: 3 },
            ],
          },
          { sessionId: 'session-2', prs: [] },
          { workspaceCwd: '/ws/a', prs: [{ number: 1, url: 'x' }] },
          null,
        ],
      }),
    );
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const snapshot = await accessor.listPrBindings();

    expect(requestRest).toHaveBeenCalledWith(
      '/sessions/pr-bindings',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // session-1 mixed one valid PR with two malformed entries: ANY dropped
    // entry degrades the answer to partial so the adapter never trusts its
    // absence semantics; the valid projection still passes through.
    expect(snapshot.partial).toBe(true);
    expect(snapshot.bindings).toEqual([
      {
        sessionId: 'session-1',
        workspaceCwd: '/ws/a',
        sourceType: 'web-shell',
        updatedAt: '2026-11-01T10:00:00.000Z',
        prs: [
          {
            number: 101,
            url: 'https://github.com/acme/widgets/pull/101',
            state: 'open',
          },
        ],
      },
    ]);
  });

  it('propagates the partial flag from the bindings route', async () => {
    const requestRest = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        bindings: [
          {
            sessionId: 'session-1',
            workspaceCwd: '/ws/a',
            prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
          },
        ],
        partial: true,
      }),
    );
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const snapshot = await accessor.listPrBindings();

    expect(snapshot.partial).toBe(true);
    expect(snapshot.bindings).toHaveLength(1);
  });

  it('projects binding roles and degrades an unknown role to partial', async () => {
    const requestRest = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        bindings: [
          {
            sessionId: 'session-1',
            workspaceCwd: '/ws/a',
            prs: [
              {
                number: 1,
                url: 'https://github.com/o/r/pull/1',
                role: 'review',
              },
              {
                number: 2,
                url: 'https://github.com/o/r/pull/2',
                role: 'triage',
              },
            ],
          },
        ],
      }),
    );
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const snapshot = await accessor.listPrBindings();

    // The unknown role must not silently untype the entry: the dropped
    // entry degrades the whole answer so the adapter retains known bindings.
    expect(snapshot.partial).toBe(true);
    expect(snapshot.bindings[0]!.prs).toEqual([
      { number: 1, url: 'https://github.com/o/r/pull/1', role: 'review' },
    ]);
  });

  it('flags a partially malformed PR projection as partial (R4-B2)', async () => {
    const requestRest = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        bindings: [
          {
            sessionId: 'session-1',
            workspaceCwd: '/ws/a',
            prs: [
              { number: 1, url: 'https://github.com/o/r/pull/1' },
              { number: 'two', url: 'https://github.com/o/r/pull/2' },
            ],
          },
        ],
        partial: false,
      }),
    );
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const snapshot = await accessor.listPrBindings();

    // One valid + one malformed entry: the projection is degraded, not
    // complete — the adapter must not trust its absence semantics for the
    // dropped PR.
    expect(snapshot.partial).toBe(true);
    expect(snapshot.bindings).toHaveLength(1);
    expect(snapshot.bindings[0]!.prs).toEqual([
      { number: 1, url: 'https://github.com/o/r/pull/1' },
    ]);
  });

  it('logs one throttled line when the worker itself downgrades an answer to partial', async () => {
    const requestRest = vi.fn().mockImplementation(async () =>
      jsonResponse(200, {
        bindings: [
          {
            sessionId: 'session-1',
            workspaceCwd: '/ws/a',
            prs: [
              { number: 1, url: 'https://github.com/o/r/pull/1' },
              { number: 'two', url: 'https://github.com/o/r/pull/2' },
            ],
          },
          { workspaceCwd: '/ws/a', prs: [] },
        ],
        partial: false,
      }),
    );
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await accessor.listPrBindings();
      await accessor.listPrBindings();
      const lines = stderr.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('downgraded to partial by the worker'));
      // The daemon answered complete; the only cause is worker-side shape
      // rejection, so it must be named — once, not on every poll.
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('2 binding row(s) or PR entries');
      expect(lines[0]).toContain('same version');
    } finally {
      stderr.mockRestore();
    }
  });

  it('flags a dropped session row as partial (R5-C3)', async () => {
    const requestRest = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        bindings: [
          null,
          {
            sessionId: 'session-1',
            workspaceCwd: '/ws/a',
            prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
          },
        ],
        partial: false,
      }),
    );
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const snapshot = await accessor.listPrBindings();

    // A dropped row's bindings are unknown: the answer is degraded, and
    // the valid session still projects.
    expect(snapshot.partial).toBe(true);
    expect(snapshot.bindings).toHaveLength(1);
  });

  it('rebuilds the wake cache when sessions leave the bindings', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          bindings: [
            {
              sessionId: 'session-1',
              workspaceCwd: '/ws/a',
              prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
            },
          ],
          partial: false,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { bindings: [], partial: false }),
      )
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { bindings: [], partial: false }),
      );
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();
    await accessor.listPrBindings();

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundSessionGoneError);
    expect((err as Error).message).toBe(
      'Bound session session-1 no longer exists',
    );
    expect(wake).not.toHaveBeenCalled();
  });

  it('keeps known cwds on a partial answer so dormant deliveries still wake', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          bindings: [
            {
              sessionId: 'session-1',
              workspaceCwd: '/ws/a',
              prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
            },
          ],
          partial: false,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { bindings: [], partial: true }))
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(jsonResponse(202, { promptId: 'p-1' }));
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();
    await accessor.listPrBindings();

    // The partial answer must not erase the cwd needed to wake the
    // dormant session; the delivery retries through the wake path.
    await accessor.deliverPrompt('session-1', 'x');

    expect(wake).toHaveBeenCalledWith('session-1', '/ws/a');
  });

  it('keeps known cwds when row validation upgrades a complete answer to partial (R8-B4)', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          bindings: [
            {
              sessionId: 'session-1',
              workspaceCwd: '/ws/a',
              prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
            },
          ],
          partial: false,
        }),
      )
      // Nominally complete, but the ONLY row is malformed: row validation
      // degrades the answer to partial after the cache-clear decision would
      // have run if it keyed on the body flag alone. The cached session is
      // not listed, so an early clear would erase its wake hint.
      .mockResolvedValueOnce(
        jsonResponse(200, {
          bindings: [{ sessionId: 'bad-row', workspaceCwd: 42, prs: [] }],
          partial: false,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(jsonResponse(202, { promptId: 'p-1' }));
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();
    const second = await accessor.listPrBindings();
    expect(second.partial).toBe(true);

    // The degraded answer must not have cleared the wake cache before its
    // row-level partial upgrade: the dormant delivery still wakes from the
    // known cwd without another bindings refresh.
    await accessor.deliverPrompt('session-1', 'x');

    expect(wake).toHaveBeenCalledWith('session-1', '/ws/a');
    expect(requestRest).toHaveBeenCalledTimes(4);
  });

  it('adds new cwds to the wake cache from a partial answer', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          bindings: [
            {
              sessionId: 's-new',
              workspaceCwd: '/ws',
              prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
            },
          ],
          partial: true,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(jsonResponse(202, { promptId: 'p-1' }));
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    // A partial answer still enumerates real sessions: their cwds must
    // seed the cold cache so the dormant delivery wakes without a second
    // bindings refresh.
    await accessor.deliverPrompt('s-new', 'x');

    expect(wake).toHaveBeenCalledWith('s-new', '/ws');
    expect(requestRest).toHaveBeenCalledTimes(3);
  });

  it('wakes a dormant session beyond the wake-cwd cache cap on a complete snapshot (R2-1)', async () => {
    // A complete snapshot with more than MAX_WAKE_CWD_CACHE (1024) rows
    // truncates the FIFO hint cache. The target sits in the FIRST rows, so
    // the refill evicts it; the cold-cache branch must read its cwd from the
    // fresh FULL snapshot, not the capped cache, or it misreports the live
    // dormant session as gone — an irreversible public reply on a complete
    // snapshot. The cap stays a bound; only the cold-cache lookup changes.
    const makeRows = (): Array<Record<string, unknown>> => {
      const rows: Array<Record<string, unknown>> = [
        {
          sessionId: 'target-session',
          workspaceCwd: '/ws/target',
          prs: [{ number: 42, url: 'https://github.com/o/r/pull/42' }],
        },
      ];
      for (let i = 0; i < 1029; i++) {
        rows.push({
          sessionId: `filler-${i}`,
          workspaceCwd: '/ws/filler',
          prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
        });
      }
      return rows;
    };
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { bindings: makeRows(), partial: false }),
      )
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { bindings: makeRows(), partial: false }),
      )
      .mockResolvedValueOnce(jsonResponse(202, { promptId: 'p-1' }));
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    await accessor.deliverPrompt('target-session', 'x');

    expect(wake).toHaveBeenCalledWith('target-session', '/ws/target');
    expect(requestRest).toHaveBeenCalledTimes(4);
  });

  it('throws when the bindings route fails', async () => {
    const res = jsonResponse(500, { error: 'boom' });
    const cancel = vi.spyOn(res.body!, 'cancel');
    const requestRest = vi.fn().mockResolvedValue(res);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    await expect(accessor.listPrBindings()).rejects.toThrow(
      'GET /sessions/pr-bindings failed: HTTP 500',
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects a malformed bindings payload on HTTP 200', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { partial: false, bindings: null }));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    await expect(accessor.listPrBindings()).rejects.toThrow(
      'malformed bindings (HTTP 200)',
    );
  });

  it('accepts a legitimate empty bindings array', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { bindings: [], partial: false }));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    await expect(accessor.listPrBindings()).resolves.toEqual({
      bindings: [],
      partial: false,
    });
  });

  it('preserves merged and closed PR states in the snapshot', async () => {
    const prs = [
      { number: 1, url: 'https://github.com/o/r/pull/1', state: 'open' },
      { number: 2, url: 'https://github.com/o/r/pull/2', state: 'merged' },
      { number: 3, url: 'https://github.com/o/r/pull/3', state: 'closed' },
    ];
    const requestRest = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        bindings: [{ sessionId: 'session-1', workspaceCwd: '/ws/a', prs }],
        partial: false,
      }),
    );
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const snapshot = await accessor.listPrBindings();

    expect(snapshot.bindings[0]!.prs).toEqual(prs);
  });

  it('delivers a prompt as text content and accepts 202', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { promptId: 'p-1' }));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    await accessor.deliverPrompt('session-1', 'event text');

    expect(requestRest).toHaveBeenCalledWith(
      '/session/session-1/prompt',
      expect.objectContaining({
        method: 'POST',
        signal: expect.any(AbortSignal),
      }),
    );
    // Field assertions, not exact serialization: JSON key order is not
    // semantic.
    const body = JSON.parse(
      String((requestRest.mock.calls[0]![1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body['prompt']).toEqual([{ type: 'text', text: 'event text' }]);
    expect(body['_meta']).toEqual({
      [CHANNEL_PROMPT_META_KEY]: true,
      [CHANNEL_BOUND_RELAY_META_KEY]: true,
    });
  });

  it('rides the worker authorization alongside the prompt marker', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { promptId: 'p-1' }));
    const accessor = createBoundSessionsAccessor(
      makeClient(requestRest),
      undefined,
      'worker-prompt-token',
    );

    await accessor.deliverPrompt('session-1', 'event text');

    expect(requestRest).toHaveBeenCalledWith(
      '/session/session-1/prompt',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(
      String((requestRest.mock.calls[0]![1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body['prompt']).toEqual([{ type: 'text', text: 'event text' }]);
    expect(body['_meta']).toEqual({
      [CHANNEL_PROMPT_META_KEY]: true,
      [CHANNEL_BOUND_RELAY_META_KEY]: true,
      [CHANNEL_PROMPT_AUTHORIZATION_META_KEY]: 'worker-prompt-token',
    });
  });

  it('bounds the prompt request with a 30s timeout signal', async () => {
    // AbortSignal.timeout rides Node's internal timer list, which fake
    // timers do not intercept; pin the exact delay and signal identity
    // instead of advancing a fake clock.
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const requestRest = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { promptId: 'p-1' }));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    await accessor.deliverPrompt('session-1', 'x');

    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(30_000);
    const init = requestRest.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal).toBe(timeout.mock.results[0]!.value);
    expect(init.signal!.aborted).toBe(false);
  });

  it('maps 404 to BoundSessionGoneError', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(jsonResponse(404, { code: 'session_not_found' }));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundSessionGoneError);
    expect((err as Error).message).toBe(
      'Bound session session-1 no longer exists',
    );
  });

  it('wakes a dormant session on 404 and retries the prompt', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          bindings: [
            {
              sessionId: 'session-1',
              workspaceCwd: '/ws/a',
              prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(jsonResponse(202, { promptId: 'p-1' }));
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    await accessor.deliverPrompt('session-1', 'event text');

    expect(wake).toHaveBeenCalledWith('session-1', '/ws/a');
    expect(requestRest).toHaveBeenCalledTimes(3);
  });

  it('refreshes bindings to find the workspace when waking an unknown session', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          bindings: [
            {
              sessionId: 'session-1',
              workspaceCwd: '/ws/a',
              prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(202, { promptId: 'p-1' }));
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);

    await accessor.deliverPrompt('session-1', 'event text');

    expect(wake).toHaveBeenCalledWith('session-1', '/ws/a');
  });

  it('evicts the cached cwd when a wake reports the session deleted', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(bindingsResponse())
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { bindings: [], partial: true }),
      );
    const wake = vi
      .fn()
      .mockRejectedValue(new BoundSessionGoneError('session-1'));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    await expect(
      accessor.deliverPrompt('session-1', 'x'),
    ).rejects.toBeInstanceOf(BoundSessionGoneError);
    expect(wake).toHaveBeenNthCalledWith(1, 'session-1', '/ws/a');

    // A later partial snapshot can omit the dead session, so the cached cwd
    // must not survive an authoritative Gone: otherwise every delivery pays
    // a doomed resume instead of taking the cold path.
    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundSessionUnavailableError);
    expect((err as Error).message).toContain(
      'absent from a partial bindings snapshot; deferring delivery',
    );
    expect(wake).toHaveBeenCalledTimes(1);
    expect(requestRest).toHaveBeenCalledTimes(4);
  });

  it('surfaces Gone when the wake reports the session deleted', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          bindings: [
            {
              sessionId: 'session-1',
              workspaceCwd: '/ws/a',
              prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }));
    const wake = vi
      .fn()
      .mockRejectedValue(new BoundSessionGoneError('session-1'));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    await expect(
      accessor.deliverPrompt('session-1', 'x'),
    ).rejects.toBeInstanceOf(BoundSessionGoneError);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('propagates a transient wake failure instead of degrading to Gone', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          bindings: [
            {
              sessionId: 'session-1',
              workspaceCwd: '/ws/a',
              prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }));
    const wake = vi.fn().mockRejectedValue(new Error('restore conflict'));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('restore conflict');
    expect((err as Error).name).not.toBe('BoundSessionGoneError');
  });

  it('propagates a bindings-refresh failure during wake instead of Gone', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(jsonResponse(500, { error: 'daemon busy' }));
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(
      'GET /sessions/pr-bindings failed: HTTP 500',
    );
    expect((err as Error).name).not.toBe('BoundSessionGoneError');
    expect(wake).not.toHaveBeenCalled();
  });

  it('keeps a post-wake retry failure transient, not gone', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          bindings: [
            {
              sessionId: 'session-1',
              workspaceCwd: '/ws/a',
              prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockRejectedValueOnce(new Error('network blip'));
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('network blip');
    expect((err as Error).name).not.toBe('BoundSessionGoneError');
  });

  it('maps a full prompt queue to BoundSessionQueueFullError', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(jsonResponse(503, { code: 'prompt_queue_full' }));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundSessionQueueFullError);
    expect((err as Error).message).toBe(
      'Prompt queue of bound session session-1 is full',
    );
  });

  it('wakes only on 404, not on a full prompt queue', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(bindingsResponse())
      .mockResolvedValueOnce(jsonResponse(503, { code: 'prompt_queue_full' }));
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    // A 503 is backpressure on a live session: waking it would pay a
    // pointless resume (and a bindings refresh) per retry.
    await expect(
      accessor.deliverPrompt('session-1', 'x'),
    ).rejects.toBeInstanceOf(BoundSessionQueueFullError);
    expect(wake).not.toHaveBeenCalled();
    // Prewarm bindings read + the single prompt POST, nothing else.
    expect(requestRest).toHaveBeenCalledTimes(2);
  });

  it('wakes only on 404, not on a 500 prompt failure (R1-9)', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(bindingsResponse())
      .mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }));
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    // A daemon 5xx is backpressure: defer without waking and without
    // consuming the failure budget.
    expect(err).toBeInstanceOf(BoundSessionUnavailableError);
    expect((err as Error).message).toContain('HTTP 500');
    expect(wake).not.toHaveBeenCalled();
    expect(requestRest).toHaveBeenCalledTimes(2);
  });

  it('maps other 503s to BoundSessionUnavailableError', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(503, { code: 'daemon_runtime_starting' }),
      );
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundSessionUnavailableError);
    expect((err as Error).message).toContain(
      'HTTP 503 (daemon_runtime_starting)',
    );
  });

  it('maps a restore in progress to BoundSessionUnavailableError', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { code: 'restore_in_progress' }));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundSessionUnavailableError);
    expect((err as Error).message).toContain('HTTP 409 (restore_in_progress)');
  });

  it('maps a busy session to BoundSessionUnavailableError', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { code: 'session_busy' }));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundSessionUnavailableError);
    expect((err as Error).message).toContain('HTTP 409 (session_busy)');
  });

  it('maps an active worktree reset to BoundSessionUnavailableError', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { code: 'worktree_reset_active' }));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundSessionUnavailableError);
    expect((err as Error).message).toContain(
      'HTTP 409 (worktree_reset_active)',
    );
  });

  it('maps an unreleased standalone binding to BoundSessionUnavailableError (R9-B1)', async () => {
    // The daemon marks working_directory_missing retryable (Retry-After):
    // the bind/release window around a conversation restore is transient,
    // so the event defers instead of burning the failure budget.
    const requestRest = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(409, { code: 'working_directory_missing' }),
      );
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundSessionUnavailableError);
    expect((err as Error).message).toContain(
      'HTTP 409 (working_directory_missing)',
    );
  });

  it('maps an archived session to BoundSessionGoneError', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { code: 'session_archived' }));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundSessionGoneError);
    expect((err as Error).message).toBe(
      'Bound session session-1 no longer exists',
    );
  });

  it('maps a superseded session to BoundSessionGoneError', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(409, { code: 'worktree_session_superseded' }),
      );
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundSessionGoneError);
    expect((err as Error).message).toBe(
      'Bound session session-1 no longer exists',
    );
  });

  it('keeps other 409s as generic errors', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { code: 'binding_conflict' }));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      'POST /session/:id/prompt failed: HTTP 409 (binding_conflict)',
    );
    expect((err as Error).name).not.toBe('BoundSessionUnavailableError');
  });

  it('classifies a 500 prompt failure as daemon backpressure (R1-9)', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(jsonResponse(500, { error: 'boom' }));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    // Daemon-signalled transient states must not consume the failure
    // budget: three consecutive 500s would otherwise dead-letter the event.
    expect(err).toBeInstanceOf(BoundSessionUnavailableError);
    expect((err as Error).message).toContain('HTTP 500');
    expect((err as Error).name).not.toBe('BoundSessionGoneError');
    expect((err as Error).name).not.toBe('BoundSessionQueueFullError');
  });

  it('defers a post-wake 404 as reversible', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(bindingsResponse())
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }));
    const release = vi.fn().mockResolvedValue(undefined);
    const wake = vi.fn().mockResolvedValue(release);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    // The wake succeeded, so this 404 is a reversible lifecycle transition
    // (the owning workspace began draining), not deletion: deferring keeps
    // the event alive for the next wake instead of the gone fallback.
    expect(err).toBeInstanceOf(BoundSessionUnavailableError);
    expect((err as Error).message).toContain(
      'post-wake retry 404 (reversible lifecycle state)',
    );
    expect((err as Error).name).not.toBe('BoundSessionGoneError');
    expect(wake).toHaveBeenCalledTimes(1);
    expect(requestRest).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledOnce();
  });

  it('defers a post-wake 404 even when the wake returns no detach', async () => {
    // The SDK may resume a session without a detach handle; the wake still
    // succeeded, so a retry 404 stays reversible. The classification keys on
    // "the wake ran", not on the detach return.
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(bindingsResponse())
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }));
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    await expect(
      accessor.deliverPrompt('session-1', 'x'),
    ).rejects.toBeInstanceOf(BoundSessionUnavailableError);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached cwd when a post-wake 404 only defers', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(bindingsResponse())
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }));
    const release = vi.fn().mockResolvedValue(undefined);
    const wake = vi.fn().mockResolvedValue(release);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    await expect(
      accessor.deliverPrompt('session-1', 'x'),
    ).rejects.toBeInstanceOf(BoundSessionUnavailableError);

    // Only an authoritative Gone evicts the wake cache: a deferred delivery
    // must still know the workspace, or the next attempt would refresh
    // bindings on every cycle.
    await expect(
      accessor.deliverPrompt('session-1', 'x'),
    ).rejects.toBeInstanceOf(BoundSessionUnavailableError);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake).toHaveBeenNthCalledWith(2, 'session-1', '/ws/a');
    expect(requestRest).toHaveBeenCalledTimes(5);
  });

  it('defers delivery when a cold cache meets a partial snapshot', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { bindings: [], partial: true }),
      );
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    // Deferral is backpressure: the class must match the message's
    // promise, not a generic Error that burns the failure budget.
    expect(err).toBeInstanceOf(BoundSessionUnavailableError);
    expect((err as Error).message).toContain(
      'absent from a partial bindings snapshot; deferring delivery',
    );
    expect((err as Error).name).not.toBe('BoundSessionGoneError');
    expect(wake).not.toHaveBeenCalled();
  });

  it('treats absence from a complete snapshot as gone on a cold cache', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { bindings: [], partial: false }),
      );
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);

    await expect(
      accessor.deliverPrompt('session-1', 'x'),
    ).rejects.toBeInstanceOf(BoundSessionGoneError);
    expect(wake).not.toHaveBeenCalled();
  });

  it('releases the wake registration after the retried prompt is accepted', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(bindingsResponse())
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(jsonResponse(202, { promptId: 'p-1' }));
    const release = vi.fn().mockResolvedValue(undefined);
    const wake = vi.fn().mockResolvedValue(release);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    await accessor.deliverPrompt('session-1', 'event text');

    expect(release).toHaveBeenCalledOnce();
    // Detaching before the retry POST could close the session ahead of
    // the prompt and misclassify the 404 as gone.
    expect(requestRest.mock.invocationCallOrder[2]).toBeLessThan(
      release.mock.invocationCallOrder[0]!,
    );
  });

  it('still accepts the delivery when releasing the wake registration fails', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(bindingsResponse())
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(jsonResponse(202, { promptId: 'p-1' }));
    const release = vi.fn().mockRejectedValue(new Error('detach failed'));
    const wake = vi.fn().mockResolvedValue(release);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    // The prompt was already accepted; a failing detach is cleanup noise
    // and must not turn the delivery into a failure.
    await expect(
      accessor.deliverPrompt('session-1', 'x'),
    ).resolves.toBeUndefined();

    expect(release).toHaveBeenCalledOnce();
  });

  it('releases the wake registration when the retried prompt is deferred', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(bindingsResponse())
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }));
    const release = vi.fn().mockResolvedValue(undefined);
    const wake = vi.fn().mockResolvedValue(release);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    await expect(
      accessor.deliverPrompt('session-1', 'x'),
    ).rejects.toBeInstanceOf(BoundSessionUnavailableError);
    expect(release).toHaveBeenCalledOnce();
    expect(requestRest.mock.invocationCallOrder[2]).toBeLessThan(
      release.mock.invocationCallOrder[0]!,
    );
  });

  it('discards the response body of an accepted prompt', async () => {
    const res = jsonResponse(202, { promptId: 'p-1' });
    const cancel = vi.spyOn(res.body!, 'cancel');
    const requestRest = vi.fn().mockResolvedValue(res);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    await accessor.deliverPrompt('session-1', 'x');

    expect(cancel).toHaveBeenCalledOnce();
  });

  it('discards the response body of a gone session', async () => {
    const res = jsonResponse(404, { code: 'session_not_found' });
    const cancel = vi.spyOn(res.body!, 'cancel');
    const requestRest = vi.fn().mockResolvedValue(res);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    await expect(
      accessor.deliverPrompt('session-1', 'x'),
    ).rejects.toBeInstanceOf(BoundSessionGoneError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('discards the response body of a failed prompt', async () => {
    const res = jsonResponse(400, { error: 'boom' });
    const cancel = vi.spyOn(res.body!, 'cancel');
    const requestRest = vi.fn().mockResolvedValue(res);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    await expect(accessor.deliverPrompt('session-1', 'x')).rejects.toThrow(
      'failed: HTTP 400',
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('classifies a 429 rate limit as backpressure, not a failure (R1-9)', async () => {
    // The daemon's prompt-tier limiter answers 429 rate_limit_exceeded with
    // one bucket per worker client id: a delivery burst saturates it, and
    // the retries keep it saturated. Burning the failure budget here would
    // dead-letter a watch event irrecoverably after three polls.
    const res = jsonResponse(429, { code: 'rate_limit_exceeded' });
    const cancel = vi.spyOn(res.body!, 'cancel');
    const requestRest = vi.fn().mockResolvedValue(res);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const err = await accessor
      .deliverPrompt('session-1', 'x')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BoundSessionUnavailableError);
    expect((err as Error).message).toContain('HTTP 429');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('classifies other daemon 5xx as backpressure (R1-9)', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(jsonResponse(502, { error: 'bad gateway' }));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    await expect(
      accessor.deliverPrompt('session-1', 'x'),
    ).rejects.toBeInstanceOf(BoundSessionUnavailableError);
  });

  it('carries the idempotency key on the initial and the post-wake POST (W4)', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(bindingsResponse())
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(jsonResponse(202, { promptId: 'p-1' }));
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    await accessor.deliverPrompt('session-1', 'event text', 'task-42');

    // The first POST was a 404 (never admitted); the retry must carry the
    // SAME key so a lost acceptance mark or a lost 202 deduplicates.
    for (const call of [
      requestRest.mock.calls[1]!,
      requestRest.mock.calls[2]!,
    ]) {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as {
        idempotencyKey?: string;
      };
      expect(body.idempotencyKey).toBe('task-42');
    }
  });

  it('omits the idempotency key when the caller passes none', async () => {
    const requestRest = vi
      .fn()
      .mockResolvedValue(jsonResponse(202, { promptId: 'p-1' }));
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    await accessor.deliverPrompt('session-1', 'x');

    const body = JSON.parse(
      String((requestRest.mock.calls[0]![1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body['idempotencyKey']).toBeUndefined();
  });

  it('passes an empty-prs tombstone through to the adapter (W2, R1-8)', async () => {
    // "Scanned, no bindings" (an observed unbind) must reach the adapter
    // even on a partial answer: retention keys on the listed session set,
    // and a dropped empty row would revive the stale binding forever.
    const requestRest = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        bindings: [
          {
            sessionId: 'session-1',
            workspaceCwd: '/ws/a',
            prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
          },
          { sessionId: 'session-unbound', workspaceCwd: '/ws/a', prs: [] },
        ],
        partial: true,
      }),
    );
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const snapshot = await accessor.listPrBindings();

    expect(snapshot.partial).toBe(true);
    expect(snapshot.bindings).toHaveLength(2);
    expect(snapshot.bindings[1]).toEqual({
      sessionId: 'session-unbound',
      workspaceCwd: '/ws/a',
      prs: [],
    });
  });

  it('flags a session whose PR entries are all malformed as partial (W2)', async () => {
    const requestRest = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        bindings: [
          {
            sessionId: 'session-1',
            workspaceCwd: '/ws/a',
            prs: [{ number: 'bad' }, { url: 42 }],
          },
        ],
        partial: false,
      }),
    );
    const accessor = createBoundSessionsAccessor(makeClient(requestRest));

    const snapshot = await accessor.listPrBindings();

    // A degraded projection is not an unbind: the answer must not advertise
    // an authoritative empty binding set for this session.
    expect(snapshot.partial).toBe(true);
    expect(snapshot.bindings).toHaveLength(0);
  });

  it('bounds the wake cwd cache under a permanent partial (B-F3)', async () => {
    const many = Array.from({ length: 1030 }, (_, i) => ({
      sessionId: `s-${i}`,
      workspaceCwd: '/ws/a',
      prs: [],
    }));
    // Fresh Response per call: a shared instance's body can only be read
    // once.
    const requestRest = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { bindings: many, partial: true }),
      )
      .mockResolvedValueOnce(jsonResponse(404, { code: 'session_not_found' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { bindings: many, partial: true }),
      )
      .mockResolvedValueOnce(jsonResponse(202, { promptId: 'p-1' }));
    const wake = vi.fn().mockResolvedValue(undefined);
    const accessor = createBoundSessionsAccessor(makeClient(requestRest), wake);
    await accessor.listPrBindings();

    // s-0 is the oldest entry: the 1024 FIFO cap evicted it from the hint
    // cache, and the refresh evicts it again (1030 > 1024). But s-0 is still
    // LISTED in the fresh snapshot, so the cold-cache branch reads its cwd
    // from there and wakes it: a bounded hint cache must not turn a present
    // session into a deferral (or, on a complete snapshot, a false gone —
    // R2-1). Presence is authoritative even on a partial answer; only an
    // ABSENT session defers there. The 404 still triggers a bindings refresh
    // (a cached entry would skip it).
    await accessor.deliverPrompt('s-0', 'x');
    expect(wake).toHaveBeenCalledWith('s-0', '/ws/a');
    expect(requestRest.mock.calls[2]![0]).toBe('/sessions/pr-bindings');
  });
});
