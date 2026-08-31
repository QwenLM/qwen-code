import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';

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
const mockDaemonChannelRuntimeStatePath = vi.hoisted(() =>
  // Argument-derived on purpose (mirrors the instanceDir mock above): the
  // real helper hashes the workspace, so two different arguments are two
  // different files. A constant mock would let a split derivation (one
  // call for the assertion, another for the store, or the store built
  // from a different workspace than this worker's) coincide by accident
  // and ship green — resurrecting explicitly stopped channels (R9-26).
  vi.fn((workspace?: string) =>
    workspace === undefined
      ? '/tmp/qwen/channels/daemon/legacy/channel-state.json'
      : `/tmp/qwen/channels/daemon/${
          workspace === '/workspace' ? 'workspace-hash' : 'other-hash'
        }/channel-state.json`,
  ),
);
const mockChannelStateStoreReadAll = vi.hoisted(() => vi.fn(() => ({})));
const mockChannelStateStoreSet = vi.hoisted(() => vi.fn());
const mockChannelStateStoreSetMany = vi.hoisted(() => vi.fn());
const mockChannelStateStorePrune = vi.hoisted(() =>
  vi.fn(() => mockChannelStateStoreReadAll()),
);
const mockChannelStateStore = vi.hoisted(() =>
  vi.fn(() => ({
    readAll: mockChannelStateStoreReadAll,
    set: mockChannelStateStoreSet,
    setMany: mockChannelStateStoreSetMany,
    prune: mockChannelStateStorePrune,
    // Mirror the real best-effort wrappers so throwing `set`/`setMany`
    // mocks still exercise "persistence failure never blocks a connect".
    // Return the persistence boolean like the real store: callers surface a
    // failed write (#8975).
    trySet: (name: string, state: 'active' | 'stopped') => {
      try {
        mockChannelStateStoreSet(name, state);
        return true;
      } catch {
        // best-effort
        return false;
      }
    },
    trySetMany: (names: string[], state: 'active' | 'stopped') => {
      // Mirror the real setMany: an empty name list is a no-op and must
      // not be recorded, or tests diverge from production in both
      // directions (the all-channels-fail path reaches trySetMany([])).
      if (names.length === 0) return true;
      try {
        mockChannelStateStoreSetMany(names, state);
        return true;
      } catch {
        // best-effort
        return false;
      }
    },
  })),
);
const mockSelectActiveChannels = vi.hoisted(
  () =>
    (
      names: readonly string[],
      states: Record<string, 'active' | 'stopped'>,
      onSkipped?: (message: string) => void,
    ): string[] =>
      names.filter((name) => {
        if (states[name] === 'stopped') {
          // Route the name through the SAME sanitizer mock the module
          // under test uses (R14): the real helper embeds
          // sanitizeLogText(name, 128), so a hand-copied message here
          // would keep asserting the old format if the production
          // sanitization (or its arguments) ever changed.
          onSkipped?.(
            `[Channel] "${mockSanitizeLogText(name, 128)}" skipped (stopped before restart)`,
          );
          return false;
        }
        return true;
      }),
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
const mockWriteStdoutLineBestEffort = vi.hoisted(() => vi.fn());
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
  // Mirror the REAL sanitizeLogText contract (channels/base/sanitize.ts)
  // — cap by code points, render a real `\n` as the visible `\n` escape,
  // then strip the C1/Unicode line-break + bidi block and the C0/DEL
  // controls. This suite pins the not-running classifier contract
  // end-to-end (R14-10), so the stand-in must strip the same characters
  // the real helper does; a CR/LF-only stand-in would let NEL/U+2028/
  // U+2029 (all rendered line breaks) through and falsify the pin.
  vi.fn((value: unknown, maxLen?: number) => {
    const capped =
      maxLen === undefined
        ? String(value)
        : Array.from(String(value)).slice(0, maxLen).join('');
    return (
      capped
        .replace(/\n/g, '\\n')
        .replace(
          /[\u0080-\u009f\p{Cf}\u2028\u2029]|\p{Variation_Selector}/gu,
          ' ',
        )
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
    );
  }),
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
  // OWN mock, de-aliased from the loud sink (R12-3): with a shared mock,
  // swapping a best-effort diagnostic (the prune-fallback warning, the
  // skip notices, the zero-channel degrade notice, the active-record loss
  // warning) back to the loud `writeStdoutLine` ships every pin green,
  // while in production a failing stdout target — the same disk condition
  // that fails the state writes these diagnostics accompany — raises the
  // async stdout 'error' event and kills the worker mid-startup. The
  // EPIPE-crash resilience of the real helper itself is pinned in
  // stdioHelpers.test (R11-13).
  writeStdoutLineBestEffort: mockWriteStdoutLineBestEffort,
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
  daemonChannelRuntimeStatePath: mockDaemonChannelRuntimeStatePath,
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
  selectFirstModel: mockSelectFirstModel,
  sessionsPath: mockSessionsPath,
}));

vi.mock('./channel-state-store.js', () => ({
  ChannelStateStore: mockChannelStateStore,
  selectActiveChannels: mockSelectActiveChannels,
}));

vi.mock('./observed-contact-store.js', () => ({
  OBSERVED_CONTACT_MAX_FRESH_WITHIN_SECONDS: 365 * 24 * 60 * 60,
  ObservedChannelContactStore: mockObservedContactStore,
}));

vi.mock('@qwen-code/channel-base', () => ({
  ChannelLoopScheduler: mockChannelLoopScheduler,
  ChannelLoopStore: mockChannelLoopStore,
  DaemonChannelBridge: mockDaemonChannelBridge,
  isChannelProactiveDeliveryError: mockIsChannelProactiveDeliveryError,
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
  };
  return { client, DaemonClient, DaemonSessionClient, deleteSessionsData };
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
  mockChannelStateStoreReadAll.mockReturnValue({});
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
    const settings = { merged: { proxy: 'http://settings-proxy:8080' } };
    mockLoadSettings.mockReturnValueOnce(settings);

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
    // The real sanitizeLogText renders an ASCII newline as the VISIBLE
    // `\n` escape (not a space), keeping the payload one readable log
    // line — mirror that here (the mock now tracks the real contract,
    // R14-10).
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      '[Channel] Connecting "evil\\nchannel"...',
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      '[Channel] "evil\\nchannel" connected.',
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

  it('serves with zero channels when no channels are configured (#8975)', async () => {
    const sdk = createSdk();
    const ready = vi.fn();
    mockLoadChannelsConfig.mockReturnValueOnce({});

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
      sendReady: ready,
    });

    expect(handle.channels).toEqual([]);
    expect(ready).toHaveBeenCalledWith({
      channels: [],
      requestedChannels: [],
      pid: process.pid,
    });
    // Sink pin (R12-3): the zero-channel degrade notice rides the
    // best-effort sink — the worker survives with no channels, so the
    // notice must not crash it when stdout is the thing that is failing
    // (R11-13).
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      '[Channel] No channels configured; serving with 0 channels.',
    );
    // Strict sink negative (R14-25): the degrade notice must not ALSO land
    // on the loud sink — under the exact failing-stdout condition this
    // diagnostic exists for, a loud write raises the async stdout 'error'
    // event and kills the worker the degrade path exists to keep alive
    // (R11-13). The membership positive alone lets a dual-write ship green.
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      '[Channel] No channels configured; serving with 0 channels.',
    );
    // Never prune with an empty configured set: settings can transiently
    // recover to empty. The store no-ops prune([]) today, but keep this
    // caller-side guard pinned so a future store change cannot turn an
    // empty read into a wipe of every recorded stop (#8975).
    expect(mockChannelStateStorePrune).not.toHaveBeenCalled();
    expect(mockParseConfiguredChannels).not.toHaveBeenCalled();
    expect(mockDaemonChannelBridge).not.toHaveBeenCalled();
    expect(mockCreateChannel).not.toHaveBeenCalled();

    await expect(
      handle.deliverChannelMessage({
        deliveryId: 'delivery-1',
        channelName: 'telegram',
        target: { type: 'chat', id: 'chat-1' },
        text: 'hello',
      }),
      // Pin the ChannelDeliveryError CODE, not just the message: the
      // delivery classifier has no message fallback, so a plain Error
      // with the same message would map to channel_delivery_failed (502)
      // instead of the 503 channel_worker_unavailable the SDK documents
      // as an expected outcome (#8975).
    ).rejects.toMatchObject({ code: 'channel_worker_unavailable' });
    // Webhooks must be rejected upfront too, not silently accepted and
    // dropped (#8975). Pin the CLASSIFIER-VISIBLE shape with the anchored
    // regex (R12-19): classifyWebhookTaskValidationError decides the IPC
    // code via /^Channel ".+" is not running\.$/u — appending context to
    // the degrade copy keeps a substring pin green while flipping every
    // zero-channel webhook to channel_webhook_enqueue_failed.
    const webhookTask = {
      channelName: 'telegram',
      source: 'github-ci',
      eventType: 'check_failed',
      targetRef: 'default',
      title: 'CI failed',
      payload: { runId: 123 },
    };
    expect(() => handle.validateWebhookTask(webhookTask)).toThrow(
      /^Channel "telegram" is not running\.$/,
    );
    await expect(handle.runWebhookTask(webhookTask)).rejects.toThrow(
      /^Channel "telegram" is not running\.$/,
    );
    await handle.close();
  });

  it('sanitizes an evil webhook channel name in the zero-channel degrade stub (R15-27)', async () => {
    // R14-10's evil-name assertions run against a names-mode selection
    // that never reaches the zero-channel stub, and the stub's own pins
    // use the plain name 'telegram' (identity for the sanitizer). A
    // stub-only sanitizer drop therefore ships green while a zero-channel
    // worker receiving a webhook whose channelName carries CR/LF/NEL/
    // U+2028/U+2029 fails the anchored classifier `/^Channel ".+" is not
    // running\.$/u` (no `s` flag: `.` rejects real line breaks), flipping
    // channel_worker_unavailable (503) to channel_webhook_enqueue_failed.
    // Drive the stub with an evil name and pin the classifier match.
    const sdk = createSdk();
    const ready = vi.fn();
    mockLoadChannelsConfig.mockReturnValueOnce({});

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
      sendReady: ready,
    });

    const evilName = 'evil\r\n\u0085\u2028\u2029channel';
    const webhookTask = {
      channelName: evilName,
      source: 'github-ci',
      eventType: 'check_failed',
      targetRef: 'default',
      title: 'CI failed',
      payload: { runId: 123 },
    };

    // The anchored classifier matches ONLY because the sanitizer removed
    // every raw line break from the embedded name.
    expect(() => handle.validateWebhookTask(webhookTask)).toThrow(
      /^Channel ".+" is not running\.$/,
    );
    let message = '';
    try {
      handle.validateWebhookTask(webhookTask);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toMatch(/[\r\n\u0085\u2028\u2029]/);
    expect(mockSanitizeLogText).toHaveBeenCalledWith(evilName, 128);
    await expect(handle.runWebhookTask(webhookTask)).rejects.toThrow(
      /^Channel ".+" is not running\.$/,
    );
    await handle.close();
  });

  it('serves with zero channels when every configured channel is stopped (#8975)', async () => {
    const sdk = createSdk();
    const ready = vi.fn();
    mockChannelStateStoreReadAll.mockReturnValueOnce({
      telegram: 'stopped',
      feishu: 'stopped',
    });

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
      sendReady: ready,
    });

    expect(handle.channels).toEqual([]);
    expect(ready).toHaveBeenCalledWith({
      channels: [],
      requestedChannels: [],
      pid: process.pid,
    });
    // Sink pins (R12-3): the skip notices and the zero-channel degrade
    // notice ride the best-effort sink (R11-13).
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      '[Channel] "telegram" skipped (stopped before restart)',
    );
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      '[Channel] "feishu" skipped (stopped before restart)',
    );
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      '[Channel] All configured channels are stopped; serving with 0 channels.',
    );
    // Strict sink negative, twin of the no-config degrade pin (R14-25).
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      '[Channel] All configured channels are stopped; serving with 0 channels.',
    );
    expect(mockParseConfiguredChannels).not.toHaveBeenCalled();
    expect(mockCreateChannel).not.toHaveBeenCalled();
    // The all-stopped branch is exactly where every recorded state is
    // 'stopped': a state WRITE added here (e.g. persisting the configured
    // set as 'active') would flip the recorded stops and resurrect every
    // explicitly stopped channel on the next `--channel all` — the #8975
    // regression class.
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
    // prune IS called — and pin it: pruning stale entries against the
    // configured set is a read-side cleanup, not a state flip, and a
    // refactor skipping prune exactly in this branch would strand stale
    // `stopped` entries for channels removed from settings (#8975).
    // Count pin, matching the two sibling prune-calling branches
    // (R15-29, R16-46): a second call on this zero-selection branch
    // (e.g. a symmetric post-selection prune([])) stays green against
    // membership alone, and wipes the recorded stops the moment prune
    // semantics on an empty list change.
    expect(mockChannelStateStorePrune).toHaveBeenCalledTimes(1);
    expect(mockChannelStateStorePrune).toHaveBeenCalledWith([
      'telegram',
      'feishu',
    ]);
  });

  it('skips stopped channels when restoring --channel all (#8975)', async () => {
    const sdk = createSdk();
    const ready = vi.fn();
    mockParseConfiguredChannels.mockResolvedValueOnce([parsedTelegram]);
    mockChannelStateStoreReadAll.mockReturnValueOnce({ feishu: 'stopped' });

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
      sendReady: ready,
    });

    // Sink pin (R12-3): the skip notice rides the best-effort sink.
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      '[Channel] "feishu" skipped (stopped before restart)',
    );
    expect(mockParseConfiguredChannels).toHaveBeenCalledWith(
      expect.any(Object),
      ['telegram'],
      { defaultCwd: '/workspace' },
    );
    expect(mockCreateChannel).toHaveBeenCalledTimes(1);
    expect(mockCreateChannel).toHaveBeenCalledWith(
      'telegram',
      parsedTelegram.config,
      expect.any(Object),
      expect.any(Object),
    );
    expect(ready).toHaveBeenCalledWith({
      channels: ['telegram'],
      requestedChannels: ['telegram'],
      pid: process.pid,
    });
    // Connects are batched into one best-effort write after the loop.
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledWith(
      ['telegram'],
      'active',
    );
    // Negative twin of the batched-write pin (R12-14): per-channel
    // `trySet(name, 'active')` inside the connect loop alongside the
    // batch would reintroduce N full-file read-modify-write cycles on
    // the startup critical path while every membership pin stays green.
    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
    // State file wiring: the helper receives this worker's workspace and
    // the store is constructed with the path it returns — a split here
    // reads state from a different file than the stop writes target,
    // resurrecting explicitly stopped channels (#8975). The path mock is
    // argument-derived, and the store is pinned to the value returned for
    // THIS workspace's call, so a split fails (R9-26).
    expect(mockDaemonChannelRuntimeStatePath).toHaveBeenCalledWith(
      '/workspace',
    );
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      mockDaemonChannelRuntimeStatePath.mock.results[0]!.value,
    );
    // Uniqueness pins (R11-21): the membership pins above are satisfied
    // by a read/write store SPLIT (a second construction landing in a
    // different file), so assert the store is constructed exactly once
    // from exactly one path derivation.
    expect(mockChannelStateStore).toHaveBeenCalledTimes(1);
    expect(mockDaemonChannelRuntimeStatePath).toHaveBeenCalledTimes(1);
    // One-sided warning pin: the prune-fallback warning is pinned on the
    // failure path below; a prune-success restore must NOT emit it —
    // emitting it on every normal restore drowns the genuine warning
    // (R9-12). Sink twin (R12-3): the real warning sink is the
    // best-effort one.
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      '[Channel] Warning: failed to update channel state; falling back to recorded states.',
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      '[Channel] Warning: failed to update channel state; falling back to recorded states.',
    );
    // prune receives the FULL configured set: a post-selection or partial
    // list would wipe the stopped records of exactly the skipped channels.
    // Call-COUNT pin (R15-29): membership alone is satisfied by a refactor
    // adding a SECOND post-selection `prune(selectedNames)` — the real
    // store would then delete the skipped channels' stopped entries and the
    // next `--channel all` resurrects them. Match the names-mode pin pair.
    expect(mockChannelStateStorePrune).toHaveBeenCalledTimes(1);
    expect(mockChannelStateStorePrune).toHaveBeenCalledWith([
      'telegram',
      'feishu',
    ]);
    await handle.close();
  });

  it('falls back to the recorded states when prune fails (#8975)', async () => {
    const sdk = createSdk();
    const ready = vi.fn();
    mockParseConfiguredChannels.mockResolvedValueOnce([parsedTelegram]);
    mockChannelStateStorePrune.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    mockChannelStateStoreReadAll.mockReturnValueOnce({ feishu: 'stopped' });

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
      sendReady: ready,
    });

    // Startup proceeds and the fallback read drives the restore filter.
    // Sink pin (R12-3): the skip notice rides the best-effort sink.
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      '[Channel] "feishu" skipped (stopped before restart)',
    );
    // A silent fallback would hide that persistence is broken: stale
    // entries survive, and a re-added channel is skipped forever with no
    // diagnostic tracing the cause (#8975). Sink pin (R12-3): the
    // warning rides the best-effort sink — it fires exactly when the
    // disk is failing.
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      '[Channel] Warning: failed to update channel state; falling back to recorded states.',
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      '[Channel] Warning: failed to update channel state; falling back to recorded states.',
    );
    expect(mockParseConfiguredChannels).toHaveBeenCalledWith(
      expect.any(Object),
      ['telegram'],
      { defaultCwd: '/workspace' },
    );
    expect(ready).toHaveBeenCalledWith({
      channels: ['telegram'],
      requestedChannels: ['telegram'],
      pid: process.pid,
    });
    await handle.close();
  });

  it('keeps the names-mode prune-failure warning on the best-effort sink and still starts (R15-28)', async () => {
    // Names-mode twin of the mode-all prune-failure test: the prune
    // catch -> best-effort warning -> start-continues branch has zero
    // names-mode coverage (both prune-failure tests use mode:'all').
    // Routing the warning to the loud writeStdoutLine ships green through
    // the suite, yet under the failing-stdout condition the warning exists
    // for, the loud write raises the async stdout 'error' event and kills
    // the worker mid-start (the R11-13 hazard). Deleting the warning
    // likewise ships green.
    const sdk = createSdk();
    const ready = vi.fn();
    mockParseConfiguredChannels.mockResolvedValueOnce([parsedTelegram]);
    mockChannelStateStorePrune.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    mockChannelStateStoreReadAll.mockReturnValueOnce({});

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
      sendReady: ready,
    });

    // Warning on the best-effort sink, absent on the loud sink. The
    // names-mode branch carries its OWN copy ('continuing with the
    // explicit selection.') — the mode-all 'falling back to recorded
    // states.' wording is a different string, so this pin is branch-
    // specific and a loud-sink move of THIS copy fails here.
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      '[Channel] Warning: failed to update channel state; continuing with the explicit selection.',
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      '[Channel] Warning: failed to update channel state; continuing with the explicit selection.',
    );
    // The explicit selection still starts despite the prune failure.
    expect(ready).toHaveBeenCalledWith({
      channels: ['telegram'],
      requestedChannels: ['telegram'],
      pid: process.pid,
    });
    await handle.close();
  });

  it('treats all channels as active when prune fails and nothing is readable (R12-13)', async () => {
    // prune throws on ANY store failure — a transient READ failure
    // (applyChange rethrows every non-ENOENT read error, the EBUSY/EPERM
    // AV-lock class) as well as a write failure — and the fallback
    // readAll() can then return an EMPTY map while channels are
    // explicitly stopped. The warning must say so: selecting from an
    // empty map treats every configured channel as active, including the
    // stopped ones, and claiming 'falling back to recorded states' there
    // would be a lie (#8975).
    const sdk = createSdk();
    const ready = vi.fn();
    mockParseConfiguredChannels.mockResolvedValueOnce([
      parsedTelegram,
      parsedFeishu,
    ]);
    mockChannelStateStorePrune.mockImplementationOnce(() => {
      throw new Error('EBUSY');
    });
    // Persistent mock (beforeEach resets it): the fallback read comes
    // back EMPTY — the shape a transient read failure leaves behind.
    mockChannelStateStoreReadAll.mockReturnValue({});

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
      sendReady: ready,
    });

    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      '[Channel] Warning: no recorded channel state readable; treating all channels as active.',
    );
    // Mirror-pin the ternary's other half: with an empty fallback the
    // recorded-states wording must NOT appear (#8975).
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      '[Channel] Warning: failed to update channel state; falling back to recorded states.',
    );
    // Nothing is skipped: ALL configured channels are selected.
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('skipped (stopped before restart)'),
    );
    expect(mockParseConfiguredChannels).toHaveBeenCalledWith(
      expect.any(Object),
      ['telegram', 'feishu'],
      { defaultCwd: '/workspace' },
    );
    expect(ready).toHaveBeenCalledWith({
      channels: ['telegram', 'feishu'],
      requestedChannels: ['telegram', 'feishu'],
      pid: process.pid,
    });
    await handle.close();
  });

  it('records connected channels as active in one batched write (#8975)', async () => {
    const sdk = createSdk();
    const ready = vi.fn();
    // Two channels on purpose: with a single channel, batched and
    // per-channel writes are observationally identical, so moving the
    // write into the connect loop would ship green (#8975).
    mockParseConfiguredChannels.mockResolvedValueOnce([
      parsedTelegram,
      parsedFeishu,
    ]);

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
      sendReady: ready,
    });

    expect(mockChannelStateStoreSetMany).toHaveBeenCalledTimes(1);
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledWith(
      ['telegram', 'feishu'],
      'active',
    );
    // Per-channel `trySet(name, 'active')` inside the connect loop
    // alongside the batch ships every membership pin green while
    // reintroducing N full-file read-modify-write cycles on the startup
    // critical path — narrower than the regression this test's comment
    // claims to prevent (R12-14).
    expect(mockChannelStateStoreSet).not.toHaveBeenCalled();
    // One-sided warning pin: the persistence-failure warning is pinned on
    // the failure twin below; a successful batched write must NOT emit it
    // — a false data-loss alarm on every normal restore (R9-13). Sink
    // twin (R12-3): the real warning sink is the best-effort one.
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      '[Channel] Warning: could not persist the active record; --channel all may still skip this channel.',
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      '[Channel] Warning: could not persist the active record; --channel all may still skip this channel.',
    );
    // The store reads and writes the SAME workspace-derived file (the
    // path mock is argument-derived; the store is pinned to the value
    // returned for this workspace's call) — a split here resurrects
    // explicitly stopped channels (R9-26).
    expect(mockDaemonChannelRuntimeStatePath).toHaveBeenCalledWith(
      '/workspace',
    );
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      mockDaemonChannelRuntimeStatePath.mock.results[0]!.value,
    );
    // Uniqueness pins (R11-21): a read/write store split ships green
    // against the membership pins alone.
    expect(mockChannelStateStore).toHaveBeenCalledTimes(1);
    expect(mockDaemonChannelRuntimeStatePath).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith({
      channels: ['telegram', 'feishu'],
      requestedChannels: ['telegram', 'feishu'],
      pid: process.pid,
    });
    await handle.close();
  });

  it('force-starts explicitly selected channels even when stopped (#8975)', async () => {
    const sdk = createSdk();
    // Seed a recorded stop with a PERSISTENT mock (beforeEach resets it):
    // a mockReturnValueOnce leaks into the NEXT test because
    // vi.clearAllMocks() does not clear Vitest's once-implementation
    // queue. The seeded stop distinguishes force-start from a restore
    // filter mistakenly applied to names mode — with the filter applied,
    // the explicitly requested channel would be skipped (#8975).
    mockChannelStateStoreReadAll.mockReturnValue({ telegram: 'stopped' });

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    // Sink twin (R12-3): the real skip-notice sink is the best-effort one.
    expect(mockWriteStdoutLineBestEffort).not.toHaveBeenCalledWith(
      expect.stringContaining('skipped (stopped before restart)'),
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('skipped (stopped before restart)'),
    );
    expect(mockCreateChannel).toHaveBeenCalledWith(
      'telegram',
      parsedTelegram.config,
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledWith(
      ['telegram'],
      'active',
    );
    // Names mode never CONSULTS the restore filter for SELECTION: the
    // selection is the explicit name list verbatim, so a recorded stop
    // can never filter an explicitly requested channel out (the skip
    // negatives above + the active write below are the behavioral pin).
    // A state READ still happens — prune's freshness cleanup reads the
    // store (this suite's mock wires prune through the readAll spy), but
    // the selection never sees it. Prune runs by the FULL configured set
    // — here `['telegram','feishu']`, NOT just the selected
    // `['telegram']`: that distinction is load-bearing (R14-11). Pruning
    // by the selection would wipe the record of a configured-but-
    // unselected channel (feishu), resurrecting exactly what #8975 keeps
    // stopped; pruning by the configured set matches standalone startAll
    // and only drops entries ABSENT from settings, so the store's
    // freshness guarantee ("a channel removed from settings and re-added
    // later is not skipped forever") holds without an all-mode start in
    // the removal window.
    expect(mockChannelStateStorePrune).toHaveBeenCalledTimes(1);
    expect(mockChannelStateStorePrune).toHaveBeenCalledWith([
      'telegram',
      'feishu',
    ]);
    // The forced-start write lands in the SAME workspace-derived file the
    // restore filter reads (argument-derived path mock; the store is
    // pinned to the value returned for this workspace's call) — the
    // cleared `stopped` record must be visible to the next `--channel
    // all`, or the forced channel is re-skipped (R9-26).
    expect(mockDaemonChannelRuntimeStatePath).toHaveBeenCalledWith(
      '/workspace',
    );
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      mockDaemonChannelRuntimeStatePath.mock.results[0]!.value,
    );
    // Uniqueness pins (R11-21): a read/write store split ships green
    // against the membership pins alone.
    expect(mockChannelStateStore).toHaveBeenCalledTimes(1);
    expect(mockDaemonChannelRuntimeStatePath).toHaveBeenCalledTimes(1);
    await handle.close();
  });

  it('still reports connected channels when state persistence fails (#8975)', async () => {
    const sdk = createSdk();
    const ready = vi.fn();
    mockParseConfiguredChannels.mockResolvedValueOnce([parsedTelegram]);
    mockChannelStateStoreSetMany.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      loadDaemonSdk: async () => sdk,
      sendReady: ready,
    });

    // The persistence failure must not reclassify a connected channel as a
    // startup failure or keep it out of the ready payload.
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      '[Channel] "telegram" connected.',
    );
    expect(handle.channels).toEqual(['telegram']);
    expect(ready).toHaveBeenCalledWith({
      channels: ['telegram'],
      requestedChannels: ['telegram'],
      pid: process.pid,
    });
    // The loss must still be surfaced like the stop direction does: a
    // stale `stopped` record would re-skip the explicitly restarted
    // channel on the next `--channel all` restore (#8975). Sink pin
    // (R12-3): the warning rides the best-effort sink — it fires exactly
    // when the disk is failing.
    expect(mockWriteStdoutLineBestEffort).toHaveBeenCalledWith(
      '[Channel] Warning: could not persist the active record; --channel all may still skip this channel.',
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      '[Channel] Warning: could not persist the active record; --channel all may still skip this channel.',
    );
    await handle.close();
  });

  it('still fails fast for malformed channel config (#8975)', async () => {
    const sdk = createSdk();
    mockParseConfiguredChannels.mockRejectedValueOnce(
      new Error('Error in channel "telegram": token is required.'),
    );

    await expect(
      runChannelDaemonWorker({
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'all' },
        loadDaemonSdk: async () => sdk,
      }),
    ).rejects.toThrow('Error in channel "telegram": token is required.');
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

  it('keeps the not-running error classifier-visible for newline-laden channel names (R14-10)', async () => {
    // classifyWebhookTaskValidationError maps the not-running message via
    // /^Channel ".+" is not running\.$/u (no `s` flag: `.` rejects real
    // CR/LF). A raw CR/LF/NEL/U+2028/U+2029 embedded in the task's
    // channelName used to break the anchored match, flipping a clean 404
    // into channel_webhook_enqueue_failed. The throws now sanitize the
    // name through sanitizeLogText; pin the classifier contract with the
    // anchored regex for BOTH webhook entry points.
    const sdk = createSdk();

    const handle = await runChannelDaemonWorker({
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      loadDaemonSdk: async () => sdk,
    });

    const evilName = 'evil\r\n\u0085\u2028\u2029name';
    await expect(
      handle.runWebhookTask({ ...webhookTask, channelName: evilName }),
    ).rejects.toThrow(/^Channel ".+" is not running\.$/u);
    expect(() =>
      handle.validateWebhookTask({ ...webhookTask, channelName: evilName }),
    ).toThrow(/^Channel ".+" is not running\.$/u);
    // The raw newline/control characters must not survive into the
    // message either (log-line forgery, twin of the skip-notice pins).
    await expect(
      handle.runWebhookTask({ ...webhookTask, channelName: evilName }),
    ).rejects.toSatisfy((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return (
        !message.includes('\r') &&
        !message.includes('\n') &&
        !message.includes('\u0085') &&
        !message.includes('\u2028') &&
        !message.includes('\u2029')
      );
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
    const never = new Promise<void>(() => undefined);
    const disconnect = vi.fn().mockResolvedValue(undefined);
    mockCreateChannel.mockResolvedValueOnce({
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect,
      name: 'telegram',
      validateWebhookTask: vi.fn(),
      runWebhookTask: vi.fn(() => never),
      deliverProactive: vi.fn(() => never),
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
      await vi.advanceTimersByTimeAsync(10_000);
      await handler;

      expect(disconnect).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      restoreSend();
      vi.useRealTimers();
    }
  });
});
