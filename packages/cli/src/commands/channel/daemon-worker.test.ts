import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCanonicalizeWorkspace = vi.hoisted(() => vi.fn((p: string) => p));
const mockLoadChannelsConfig = vi.hoisted(() => vi.fn());
const mockLoadChannelsFromExtensions = vi.hoisted(() => vi.fn());
const mockParseConfiguredChannels = vi.hoisted(() => vi.fn());
const mockCreateChannel = vi.hoisted(() => vi.fn());
const mockRegisterToolCallDispatch = vi.hoisted(() => vi.fn());
const mockRegisterSessionCleanup = vi.hoisted(() => vi.fn());
const mockSessionsPath = vi.hoisted(() => vi.fn(() => '/tmp/sessions.json'));
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());

const mockBridgeStart = vi.hoisted(() => vi.fn());
const mockBridgeStop = vi.hoisted(() => vi.fn());
const mockBridgeOn = vi.hoisted(() => vi.fn());
const mockBridgeOff = vi.hoisted(() => vi.fn());
const mockBridgeNewSession = vi.hoisted(() => vi.fn());
const mockBridgeLoadSession = vi.hoisted(() => vi.fn());
const mockBridgePrompt = vi.hoisted(() => vi.fn());
const mockBridgeCancelSession = vi.hoisted(() => vi.fn());
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
    shellCommand: mockBridgeShellCommand,
    start: mockBridgeStart,
    stop: mockBridgeStop,
  })),
);
const mockRouterSetChannelScope = vi.hoisted(() => vi.fn());
const mockRouterClearAll = vi.hoisted(() => vi.fn());
const mockSessionRouter = vi.hoisted(() =>
  vi.fn(
    (
      _bridge?: unknown,
      _defaultCwd?: string,
      _scope?: string,
      _persistPath?: string,
    ) => ({
      setChannelScope: mockRouterSetChannelScope,
      clearAll: mockRouterClearAll,
    }),
  ),
);

vi.mock('@qwen-code/acp-bridge/workspacePaths', () => ({
  canonicalizeWorkspace: mockCanonicalizeWorkspace,
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
  writeStdoutLine: mockWriteStdoutLine,
}));

vi.mock('./runtime.js', () => ({
  createChannel: mockCreateChannel,
  loadChannelsConfig: mockLoadChannelsConfig,
  loadChannelsFromExtensions: mockLoadChannelsFromExtensions,
  parseConfiguredChannels: mockParseConfiguredChannels,
  registerSessionCleanup: mockRegisterSessionCleanup,
  registerToolCallDispatch: mockRegisterToolCallDispatch,
  sessionsPath: mockSessionsPath,
}));

vi.mock('@qwen-code/channel-base', () => ({
  DaemonChannelBridge: mockDaemonChannelBridge,
  SessionRouter: mockSessionRouter,
}));

import {
  createDaemonChannelBridgeFacade,
  createDaemonSessionFactory,
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
  mockBridgeStart.mockResolvedValue(undefined);
  mockCreateChannel.mockImplementation((name: string) => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    name,
  }));
  mockLoadChannelsConfig.mockReturnValue({
    telegram: { type: 'telegram' },
    feishu: { type: 'feishu' },
  });
  mockLoadChannelsFromExtensions.mockResolvedValue(0);
  mockParseConfiguredChannels.mockResolvedValue([parsedTelegram]);
});

describe('createDaemonSessionFactory', () => {
  it('creates and loads daemon sessions with thread session scope', async () => {
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
    const bridge = {
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
      exposeShellCommand: true,
    });

    expect(facade.shellCommand).toBeTypeOf('function');
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
});

describe('runChannelDaemonWorker', () => {
  it('starts selected channels through a daemon-backed bridge facade', async () => {
    const sdk = createSdk();
    const ready = vi.fn();

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
        router: mockSessionRouter.mock.results[0]!.value,
      }),
    );
    expect(ready).toHaveBeenCalledWith({
      channels: ['telegram'],
      pid: process.pid,
    });

    await handle.close();
    expect(mockBridgeStop).toHaveBeenCalled();
  });

  it('selects all configured channels in one shared router', async () => {
    const sdk = createSdk();
    mockParseConfiguredChannels.mockResolvedValueOnce([
      parsedTelegram,
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
    expect(mockBridgeStop).toHaveBeenCalled();
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
});
