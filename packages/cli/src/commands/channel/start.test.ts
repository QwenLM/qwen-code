import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChannelBaseOptions } from '@qwen-code/channel-base';

const mockSetGlobalDispatcher = vi.hoisted(() => vi.fn());
const mockProxyAgent = vi.hoisted(() =>
  vi.fn((url: string) => ({ proxyUrl: url })),
);
const mockLoadSettings = vi.hoisted(() => vi.fn());
const mockGetExtensionManager = vi.hoisted(() => vi.fn());
const mockReadServiceInfo = vi.hoisted(() => vi.fn());
const mockWriteServiceInfo = vi.hoisted(() => vi.fn());
const mockRemoveServiceInfo = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockFindCliEntryPath = vi.hoisted(() => vi.fn());
const mockParseChannelConfig = vi.hoisted(() => vi.fn());
const mockGetPlugin = vi.hoisted(() => vi.fn());
const mockRegisterPlugin = vi.hoisted(() => vi.fn());
const mockChannelConnect = vi.hoisted(() => vi.fn());
const mockChannelDisconnect = vi.hoisted(() => vi.fn());
const mockChannelSetBridge = vi.hoisted(() => vi.fn());
const mockChannelOnToolCall = vi.hoisted(() => vi.fn());
const mockChannelOnSessionDied = vi.hoisted(() => vi.fn());
const mockCreateChannel = vi.hoisted(() => vi.fn());
const mockBridgeStart = vi.hoisted(() => vi.fn());
const mockBridgeStop = vi.hoisted(() => vi.fn());
const mockBridgeOn = vi.hoisted(() => vi.fn());
const mockAcpBridge = vi.hoisted(() =>
  vi.fn(() => ({
    on: mockBridgeOn,
    start: mockBridgeStart,
    stop: mockBridgeStop,
  })),
);
const mockRouterClearAll = vi.hoisted(() => vi.fn());
const mockRouterGetTarget = vi.hoisted(() => vi.fn());
const mockRouterRemoveSessionId = vi.hoisted(() => vi.fn());
const mockRouterRestoreSessions = vi.hoisted(() => vi.fn());
const mockRouterSetBridge = vi.hoisted(() => vi.fn());
const mockRouterSetChannelScope = vi.hoisted(() => vi.fn());
const mockChannelLoopStoreCreate = vi.hoisted(() => vi.fn());
const mockChannelLoopStoreCreateForTarget = vi.hoisted(() => vi.fn());
const mockChannelLoopStoreListForTarget = vi.hoisted(() => vi.fn());
const mockChannelLoopStoreDisable = vi.hoisted(() => vi.fn());
const mockChannelLoopStore = vi.hoisted(() =>
  vi.fn(() => ({
    create: mockChannelLoopStoreCreate,
    createForTarget: mockChannelLoopStoreCreateForTarget,
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
const mockSessionRouter = vi.hoisted(() =>
  vi.fn(() => ({
    clearAll: mockRouterClearAll,
    getTarget: mockRouterGetTarget,
    removeSessionId: mockRouterRemoveSessionId,
    restoreSessions: mockRouterRestoreSessions,
    setBridge: mockRouterSetBridge,
    setChannelScope: mockRouterSetChannelScope,
  })),
);

vi.mock('undici', () => ({
  ProxyAgent: mockProxyAgent,
  setGlobalDispatcher: mockSetGlobalDispatcher,
}));

vi.mock('../../config/settings.js', () => ({
  loadSettings: mockLoadSettings,
}));

vi.mock('../extensions/utils.js', () => ({
  getExtensionManager: mockGetExtensionManager,
}));

vi.mock('./pidfile.js', () => ({
  readServiceInfo: mockReadServiceInfo,
  removeServiceInfo: mockRemoveServiceInfo,
  writeServiceInfo: mockWriteServiceInfo,
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStderrLine: mockWriteStderrLine,
  writeStdoutLine: mockWriteStdoutLine,
}));

vi.mock('./config-utils.js', () => ({
  findCliEntryPath: mockFindCliEntryPath,
  parseChannelConfig: mockParseChannelConfig,
}));

vi.mock('./channel-registry.js', () => ({
  getPlugin: mockGetPlugin,
  registerPlugin: mockRegisterPlugin,
}));

vi.mock('@qwen-code/channel-base', () => ({
  AcpBridge: mockAcpBridge,
  ChannelLoopScheduler: mockChannelLoopScheduler,
  ChannelLoopStore: mockChannelLoopStore,
  SessionRouter: mockSessionRouter,
}));

import {
  resolveExtensionChannelEntrySpecifier,
  resolveProxy,
  startCommand,
} from './start.js';

type StartCommandArgs = Parameters<NonNullable<typeof startCommand.handler>>[0];

const invokeStartHandler = async (
  args: Partial<StartCommandArgs>,
): Promise<void> => {
  const handler = startCommand.handler;
  if (!handler) {
    throw new Error('startCommand handler is missing');
  }
  await handler({ _: [], $0: 'qwen', ...args } as StartCommandArgs);
};

const mockParsedChannelConfig = {
  cwd: '/tmp/qwen-channel-test',
  model: 'qwen-test-model',
  sessionScope: 'user',
  type: 'telegram',
};

const mockChannel = {
  connect: mockChannelConnect,
  disconnect: mockChannelDisconnect,
  onSessionDied: mockChannelOnSessionDied,
  onToolCall: mockChannelOnToolCall,
  setBridge: mockChannelSetBridge,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockBridgeStart.mockResolvedValue(undefined);
  mockChannelConnect.mockRejectedValue(new Error('stop after channel setup'));
  mockCreateChannel.mockReturnValue(mockChannel);
  mockFindCliEntryPath.mockReturnValue('/tmp/qwen-cli-entry.js');
  mockGetExtensionManager.mockResolvedValue({ getLoadedExtensions: () => [] });
  mockGetPlugin.mockResolvedValue({ createChannel: mockCreateChannel });
  mockLoadSettings.mockReturnValue({ merged: { channels: {} } });
  mockParseChannelConfig.mockResolvedValue(mockParsedChannelConfig);
  mockReadServiceInfo.mockReturnValue(null);
  mockRouterGetTarget.mockReturnValue(undefined);
  mockRouterRestoreSessions.mockResolvedValue({ failed: 0, restored: 0 });
  mockChannelLoopStoreCreate.mockResolvedValue({ id: 'job-1' });
  mockChannelLoopStoreCreateForTarget.mockResolvedValue({ id: 'job-1' });
  mockChannelLoopStoreListForTarget.mockResolvedValue([]);
  mockChannelLoopStoreDisable.mockResolvedValue(true);
  delete process.env['HTTPS_PROXY'];
  delete process.env['https_proxy'];
  delete process.env['HTTP_PROXY'];
  delete process.env['http_proxy'];
});

describe('resolveProxy', () => {
  it('prefers the CLI proxy over settings and environment proxies', () => {
    process.env['HTTPS_PROXY'] = 'http://env.example.com:8080';

    const proxy = resolveProxy(
      'http://cli.example.com:8080',
      'http://settings.example.com:8080',
    );

    expect(proxy).toBe('http://cli.example.com:8080');
    expect(mockProxyAgent).toHaveBeenCalledWith('http://cli.example.com:8080');
    expect(mockSetGlobalDispatcher).toHaveBeenCalledWith({
      proxyUrl: 'http://cli.example.com:8080',
    });
  });

  it('prefers settings.proxy over environment proxies', () => {
    process.env['HTTPS_PROXY'] = 'http://env.example.com:8080';

    const proxy = resolveProxy(undefined, 'http://settings.example.com:8080');

    expect(proxy).toBe('http://settings.example.com:8080');
    expect(mockProxyAgent).toHaveBeenCalledWith(
      'http://settings.example.com:8080',
    );
  });

  it('falls back to proxy environment variables', () => {
    process.env['HTTP_PROXY'] = 'http://env.example.com:8080';

    const proxy = resolveProxy();

    expect(proxy).toBe('http://env.example.com:8080');
    expect(mockProxyAgent).toHaveBeenCalledWith('http://env.example.com:8080');
  });
});

describe('resolveExtensionChannelEntrySpecifier', () => {
  it('returns a file URL for extension channel entry paths', () => {
    const extensionPath = join('/tmp', 'qwen extension');
    const entry = join('dist', 'channel.js');

    expect(resolveExtensionChannelEntrySpecifier(extensionPath, entry)).toBe(
      pathToFileURL(join(extensionPath, entry)).href,
    );
  });
});

describe('startCommand.handler', () => {
  it('loads settings.merged.proxy when no CLI proxy is provided', async () => {
    const settingsProxy = 'http://settings.example.com:8080';
    const envProxy = 'http://env.example.com:8080';
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({
      merged: { channels, proxy: settingsProxy },
    });
    process.env['HTTPS_PROXY'] = envProxy;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockLoadSettings).toHaveBeenCalledWith(process.cwd());
    expect(mockProxyAgent).toHaveBeenCalledWith(settingsProxy);
    expect(mockProxyAgent).not.toHaveBeenCalledWith(envProxy);
    expect(mockCreateChannel).toHaveBeenCalledWith(
      'telegram',
      mockParsedChannelConfig,
      expect.any(Object),
      expect.objectContaining({
        proxy: settingsProxy,
        loopController: expect.objectContaining({
          create: expect.any(Function),
          createForTarget: expect.any(Function),
          listForTarget: expect.any(Function),
          disable: expect.any(Function),
          validateCron: expect.any(Function),
          nextFireTime: expect.any(Function),
        }),
      }),
    );

    const options = mockCreateChannel.mock.calls[0]?.[3] as
      | ChannelBaseOptions
      | undefined;
    const input = {
      channelName: 'telegram',
      target: {
        channelName: 'telegram',
        senderId: 'alice',
        chatId: 'chat-1',
        isGroup: false,
      },
      cwd: '/tmp/qwen-channel-test',
      cron: '0 9 * * *',
      prompt: 'post summary',
      recurring: true,
      createdBy: 'Alice',
    };
    expect(options?.loopController?.createForTarget).toBeDefined();
    await options!.loopController!.createForTarget!(input, 3);
    expect(mockChannelLoopStoreCreateForTarget).toHaveBeenCalledWith(input, 3);
  });

  it('rejects cron expressions that cannot fire', async () => {
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    const options = mockCreateChannel.mock.calls[0]?.[3] as
      | ChannelBaseOptions
      | undefined;
    expect(() =>
      options?.loopController?.validateCron('0 0 31 2 *'),
    ).toThrow();
  });

  it('starts a standalone AcpBridge before creating the channel', async () => {
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    const bridge = mockAcpBridge.mock.results[0]!.value;
    const router = mockSessionRouter.mock.results[0]!.value;
    expect(mockAcpBridge).toHaveBeenCalledWith({
      cliEntryPath: '/tmp/qwen-cli-entry.js',
      cwd: mockParsedChannelConfig.cwd,
      model: mockParsedChannelConfig.model,
    });
    expect(mockBridgeStart.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateChannel.mock.invocationCallOrder[0]!,
    );
    expect(mockSessionRouter).toHaveBeenCalledWith(
      bridge,
      mockParsedChannelConfig.cwd,
      mockParsedChannelConfig.sessionScope,
      expect.any(String),
    );
    expect(mockCreateChannel).toHaveBeenCalledWith(
      'telegram',
      mockParsedChannelConfig,
      bridge,
      expect.objectContaining({ router }),
    );
  });

  it('removes router sessions when the bridge reports session death', async () => {
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    const sessionDiedListener = mockBridgeOn.mock.calls.find(
      ([eventName]) => eventName === 'sessionDied',
    )?.[1] as ((event: { sessionId: string }) => void) | undefined;
    expect(sessionDiedListener).toBeDefined();

    sessionDiedListener!({ sessionId: 'dead-session' });

    expect(mockRouterRemoveSessionId).toHaveBeenCalledWith('dead-session');
    expect(mockChannelOnSessionDied).not.toHaveBeenCalled();
  });

  it('dispatches session death to the owning channel when the route is known', async () => {
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    mockRouterGetTarget.mockReturnValue({
      channelName: 'telegram',
      senderId: 'alice',
      chatId: 'chat1',
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({ name: 'telegram' })).rejects.toThrow(
        'process.exit: 1',
      );
    } finally {
      exitSpy.mockRestore();
    }

    const sessionDiedListener = mockBridgeOn.mock.calls.find(
      ([eventName]) => eventName === 'sessionDied',
    )?.[1] as ((event: { sessionId: string }) => void) | undefined;
    expect(sessionDiedListener).toBeDefined();

    sessionDiedListener!({ sessionId: 'dead-session' });

    expect(mockChannelOnSessionDied).toHaveBeenCalledWith('dead-session');
    expect(mockRouterRemoveSessionId).not.toHaveBeenCalled();
  });

  it('registers session cleanup on the replacement bridge before restoring sessions', async () => {
    mockChannelConnect.mockResolvedValue(undefined);
    const channels = { telegram: { type: 'telegram' } };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    const processOnSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(() => process);

    try {
      void invokeStartHandler({ name: 'telegram' });
      await new Promise((resolve) => setImmediate(resolve));

      const disconnectedListener = mockBridgeOn.mock.calls.find(
        ([eventName]) => eventName === 'disconnected',
      )?.[1] as (() => Promise<void>) | undefined;
      expect(disconnectedListener).toBeDefined();

      vi.useFakeTimers();
      const restart = disconnectedListener!();
      await vi.advanceTimersByTimeAsync(3000);
      await restart;

      const restartedBridge = mockAcpBridge.mock.results[1]!.value;
      expect(mockRouterSetBridge).toHaveBeenCalledWith(restartedBridge);
      expect(mockChannelSetBridge).toHaveBeenCalledWith(restartedBridge);

      const sessionDiedCalls = mockBridgeOn.mock.calls.filter(
        ([eventName]) => eventName === 'sessionDied',
      );
      expect(sessionDiedCalls).toHaveLength(2);
      const restartedSessionDiedListener = sessionDiedCalls[1]![1] as (event: {
        sessionId: string;
      }) => void;
      expect(mockBridgeOn.mock.invocationCallOrder.at(-2)).toBeLessThan(
        mockRouterRestoreSessions.mock.invocationCallOrder[0]!,
      );

      restartedSessionDiedListener({ sessionId: 'dead-after-restart' });

      expect(mockRouterRemoveSessionId).toHaveBeenCalledWith(
        'dead-after-restart',
      );
    } finally {
      processOnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('starts all channels with one shared bridge and router', async () => {
    const channels = {
      first: { type: 'telegram' },
      second: { type: 'telegram' },
    };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    mockParseChannelConfig.mockImplementation(async (name: string) => ({
      ...mockParsedChannelConfig,
      cwd: `/tmp/${name}`,
      model: 'shared-model',
      sessionScope: name === 'first' ? 'thread' : 'single',
    }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({})).rejects.toThrow('process.exit: 1');
    } finally {
      exitSpy.mockRestore();
    }

    const bridge = mockAcpBridge.mock.results[0]!.value;
    const router = mockSessionRouter.mock.results[0]!.value;
    expect(mockAcpBridge).toHaveBeenCalledTimes(1);
    expect(mockAcpBridge).toHaveBeenCalledWith({
      cliEntryPath: '/tmp/qwen-cli-entry.js',
      cwd: process.cwd(),
      model: 'shared-model',
    });
    expect(mockSessionRouter).toHaveBeenCalledWith(
      bridge,
      process.cwd(),
      'user',
      expect.any(String),
    );
    expect(mockRouterSetChannelScope).toHaveBeenCalledWith('first', 'thread');
    expect(mockRouterSetChannelScope).toHaveBeenCalledWith('second', 'single');
    expect(mockCreateChannel).toHaveBeenNthCalledWith(
      1,
      'first',
      expect.objectContaining({ cwd: '/tmp/first' }),
      bridge,
      expect.objectContaining({ router }),
    );
    expect(mockCreateChannel).toHaveBeenNthCalledWith(
      2,
      'second',
      expect.objectContaining({ cwd: '/tmp/second' }),
      bridge,
      expect.objectContaining({ router }),
    );
  });

  it('starts the scheduler with connected channels only', async () => {
    const channels = {
      first: { type: 'telegram' },
      second: { type: 'telegram' },
    };
    const firstChannel = {
      ...mockChannel,
      connect: vi.fn().mockRejectedValue(new Error('first down')),
    };
    const secondChannel = {
      ...mockChannel,
      connect: vi.fn().mockResolvedValue(undefined),
    };
    mockCreateChannel.mockImplementation((name: string) =>
      name === 'first' ? firstChannel : secondChannel,
    );
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    mockParseChannelConfig.mockImplementation(async (name: string) => ({
      ...mockParsedChannelConfig,
      cwd: `/tmp/${name}`,
      model: 'shared-model',
    }));
    mockChannelLoopSchedulerStart.mockImplementationOnce(() => {
      throw new Error('stop after scheduler setup');
    });
    const processOnSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(() => process);

    try {
      await expect(invokeStartHandler({})).rejects.toThrow(
        'stop after scheduler setup',
      );
    } finally {
      processOnSpy.mockRestore();
    }

    const schedulerOptions = mockChannelLoopScheduler.mock.calls[0]?.[0] as
      | { channels: Map<string, unknown> }
      | undefined;
    expect([...schedulerOptions!.channels.keys()]).toEqual(['second']);
    expect(mockChannelLoopSchedulerStart).toHaveBeenCalledOnce();
  });
});
