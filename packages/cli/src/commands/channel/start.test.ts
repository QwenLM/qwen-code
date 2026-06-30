import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
const mockSanitizeLogText = vi.hoisted(() =>
  vi.fn((text: string, maxLen: number) =>
    String(text).slice(0, maxLen).replace(/\n/g, '\\n').replace(/\r/g, ' '),
  ),
);
const mockRouterClearAll = vi.hoisted(() => vi.fn());
const mockRouterGetTarget = vi.hoisted(() => vi.fn());
const mockRouterRemoveSessionId = vi.hoisted(() => vi.fn());
const mockRouterRestoreSessions = vi.hoisted(() => vi.fn());
const mockRouterSetBridge = vi.hoisted(() => vi.fn());
const mockRouterSetChannelScope = vi.hoisted(() => vi.fn());
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
  sanitizeLogText: mockSanitizeLogText,
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
  it('refuses to start when channels are managed by qwen serve', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'serve',
      pid: 1234,
      servePid: 1234,
      workerPid: 5678,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
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

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('managed by qwen serve'),
    );
    expect(mockBridgeStart).not.toHaveBeenCalled();
  });

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
      expect.objectContaining({ proxy: settingsProxy }),
    );
  });

  it('cleans up a single channel when pidfile creation races', async () => {
    const channels = { telegram: { type: 'telegram' } };
    const err = new Error('EEXIST') as NodeJS.ErrnoException;
    err.code = 'EEXIST';
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    mockChannelConnect.mockResolvedValue(undefined);
    mockWriteServiceInfo.mockImplementationOnce(() => {
      throw err;
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

    expect(mockWriteServiceInfo).toHaveBeenCalledWith(['telegram']);
    expect(mockChannelDisconnect).toHaveBeenCalled();
    expect(mockBridgeStop).toHaveBeenCalled();
    expect(mockRouterClearAll).toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('started concurrently'),
    );
  });

  it('cleans up all connected channels when pidfile creation races', async () => {
    const channels = {
      telegram: { type: 'telegram' },
      feishu: { type: 'feishu' },
    };
    const err = new Error('EEXIST') as NodeJS.ErrnoException;
    err.code = 'EEXIST';
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    mockChannelConnect.mockResolvedValue(undefined);
    mockWriteServiceInfo.mockImplementationOnce(() => {
      throw err;
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    try {
      await expect(invokeStartHandler({})).rejects.toThrow('process.exit: 1');
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockWriteServiceInfo).toHaveBeenCalledWith(['telegram', 'feishu']);
    expect(mockChannelDisconnect).toHaveBeenCalledTimes(2);
    expect(mockBridgeStop).toHaveBeenCalled();
    expect(mockRouterClearAll).toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('started concurrently'),
    );
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
    )?.[1] as
      | ((event: { sessionId: string; reason?: string }) => void)
      | undefined;
    expect(sessionDiedListener).toBeDefined();

    sessionDiedListener!({
      sessionId: 'dead\nsession',
      reason: 'boom\nreason',
    });

    expect(mockSanitizeLogText).toHaveBeenCalledWith('dead\nsession', 128);
    expect(mockSanitizeLogText).toHaveBeenCalledWith('boom\nreason', 512);
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      '[Channel] Session dead\\nsession died (boom\\nreason), removing routing state',
    );
    expect(mockRouterRemoveSessionId).toHaveBeenCalledWith('dead\nsession');
    expect(mockChannelOnSessionDied).not.toHaveBeenCalled();
  });

  it('dispatches bridge tool calls to the routed channel', async () => {
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

    const toolCallListener = mockBridgeOn.mock.calls.find(
      ([eventName]) => eventName === 'toolCall',
    )?.[1] as
      | ((event: {
          sessionId: string;
          toolCallId: string;
          kind: string;
          title: string;
          status: string;
        }) => void)
      | undefined;
    expect(toolCallListener).toBeDefined();

    const event = {
      sessionId: 's-1',
      toolCallId: 'tool-1',
      kind: 'function',
      title: 'Read file',
      status: 'running',
    };
    mockRouterGetTarget.mockReturnValue({
      channelName: 'telegram',
      senderId: 'alice',
      chatId: 'chat1',
    });

    toolCallListener!(event);

    expect(mockRouterGetTarget).toHaveBeenCalledWith('s-1');
    expect(mockChannelOnToolCall).toHaveBeenCalledWith('chat1', event);
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

  it('restarts all channels on shared bridge crash before restoring sessions', async () => {
    const channels = {
      first: { type: 'telegram' },
      second: { type: 'telegram' },
    };
    const firstChannel = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      onSessionDied: vi.fn(),
      onToolCall: vi.fn(),
      setBridge: vi.fn(),
    };
    const secondChannel = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      onSessionDied: vi.fn(),
      onToolCall: vi.fn(),
      setBridge: vi.fn(),
    };
    mockLoadSettings.mockReturnValue({ merged: { channels } });
    mockParseChannelConfig.mockImplementation(async (name: string) => ({
      ...mockParsedChannelConfig,
      cwd: `/tmp/${name}`,
      model: 'shared-model',
      sessionScope: 'user',
    }));
    mockCreateChannel
      .mockReturnValueOnce(firstChannel)
      .mockReturnValueOnce(secondChannel);
    const processOnSpy = vi
      .spyOn(process, 'on')
      .mockImplementation(() => process);

    try {
      void invokeStartHandler({});
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
      expect(firstChannel.setBridge).toHaveBeenCalledWith(restartedBridge);
      expect(secondChannel.setBridge).toHaveBeenCalledWith(restartedBridge);
      expect(
        mockBridgeOn.mock.calls.filter(
          ([eventName]) => eventName === 'toolCall',
        ),
      ).toHaveLength(2);
      expect(
        mockBridgeOn.mock.calls.filter(
          ([eventName]) => eventName === 'sessionDied',
        ),
      ).toHaveLength(2);
      expect(mockRouterRestoreSessions).toHaveBeenCalledTimes(1);
    } finally {
      processOnSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
