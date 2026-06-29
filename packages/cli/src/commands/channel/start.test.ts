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
});
