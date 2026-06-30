import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCanonicalizeWorkspace = vi.hoisted(() => vi.fn((p: string) => p));
const mockLoadChannelsConfig = vi.hoisted(() => vi.fn());
const mockLoadChannelsFromExtensions = vi.hoisted(() => vi.fn());
const mockParseConfiguredChannels = vi.hoisted(() => vi.fn());
const mockCreateChannel = vi.hoisted(() => vi.fn());
const mockRegisterToolCallDispatch = vi.hoisted(() => vi.fn());
const mockRegisterSessionCleanup = vi.hoisted(() => vi.fn());
const mockSessionsPath = vi.hoisted(() => vi.fn(() => '/tmp/sessions.json'));
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

vi.mock('../../config/settings.js', () => ({
  loadSettings: mockLoadSettings,
}));

vi.mock('./proxy.js', () => ({
  resolveProxyUrl: mockResolveProxyUrl,
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
});

describe('runChannelDaemonWorker', () => {
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
      }),
    );
    expect(mockResolveProxyUrl).toHaveBeenCalledWith(
      undefined,
      'http://settings-proxy:8080',
    );
    expect(mockLoadSettings).toHaveBeenCalledWith('/workspace', {
      skipLoadEnvironment: true,
    });
    expect(mockLoadChannelsConfig).toHaveBeenCalledWith('/workspace', settings);
    expect(mockSessionsPath).not.toHaveBeenCalled();
    expect(mockSessionRouter.mock.calls[0]![3]).toBeUndefined();
    expect(ready).toHaveBeenCalledWith({
      channels: ['telegram'],
      pid: process.pid,
    });

    await handle.close();
    expect(mockBridgeStop).toHaveBeenCalled();
    expect(mockBridgeStop.mock.invocationCallOrder[0]!).toBeLessThan(
      mockRouterClearAll.mock.invocationCallOrder[0]!,
    );
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

  it('clears router state when startup rollback bridge stop fails', async () => {
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
    expect(mockRouterClearAll).toHaveBeenCalled();
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
    expect(mockRouterClearAll).toHaveBeenCalled();
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

  it('clears router state even when bridge stop fails during close', async () => {
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
    expect(mockRouterClearAll).toHaveBeenCalled();
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
      expect(mockBridgeStop).not.toHaveBeenCalled();
      finishBridgeStart();
      await handler;

      expect(mockBridgeStop).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      finishBridgeStart?.();
      restoreSend();
    }
  });

  it('force exits when the parent disconnects during async setup', async () => {
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
      await handler;

      expect(exit).toHaveBeenCalledWith(1);
      expect(send).not.toHaveBeenCalled();
      expect(disconnect).toHaveBeenCalled();
      expect(mockBridgeStop).toHaveBeenCalled();
      expect(mockRouterClearAll).toHaveBeenCalled();
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
});
