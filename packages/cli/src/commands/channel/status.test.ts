import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadServiceInfo = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockGetChannelWorkerControl = vi.hoisted(() => vi.fn());
const mockDaemonClient = vi.hoisted(() =>
  vi.fn(() => ({ getChannelWorkerControl: mockGetChannelWorkerControl })),
);

vi.mock('@qwen-code/sdk/daemon', () => ({ DaemonClient: mockDaemonClient }));

const mockExistsSync = vi.hoisted(() => vi.fn((_target: unknown) => false));
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockReaddirSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    readdirSync: mockReaddirSync,
    default: {
      ...actual,
      existsSync: mockExistsSync,
      readFileSync: mockReadFileSync,
      readdirSync: mockReaddirSync,
    },
  };
});

vi.mock('./pidfile.js', () => ({
  readServiceInfo: mockReadServiceInfo,
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
}));

import { statusCommand } from './status.js';

async function invokeStatus(argv: Record<string, unknown> = {}): Promise<void> {
  const handler = statusCommand.handler;
  if (!handler) throw new Error('status handler missing');
  await handler({ _: [], $0: 'qwen', ...argv } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('statusCommand', () => {
  it('shows serve ownership for daemon-managed channel workers', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'serve',
      pid: 1234,
      servePid: 1234,
      workerPid: 5678,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    await expect(invokeStatus()).rejects.toThrow('process.exit: 0');

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Channel service: managed by qwen serve (PID 1234)',
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith('Worker PID:      5678');
  });

  it('omits worker pid when serve-owned metadata has no live worker', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'serve',
      pid: 1234,
      servePid: 1234,
      startedAt: new Date().toISOString(),
      channels: ['telegram'],
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    await expect(invokeStatus()).rejects.toThrow('process.exit: 0');

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Channel service: managed by qwen serve (PID 1234)',
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('Worker PID:'),
    );
  });

  it('reads remote daemon manager state without consulting the pidfile', async () => {
    mockGetChannelWorkerControl.mockResolvedValueOnce({
      enabled: true,
      transition: 'idle',
      selection: { mode: 'names', names: ['telegram'] },
      workers: [
        {
          workspaceCwd: '/work',
          state: 'running',
          channels: ['telegram'],
          pid: 42,
          startupFailures: [
            {
              channel: 'feishu',
              phase: 'connect',
              message: 'connection refused',
            },
          ],
        },
      ],
    });
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStatus({
      'daemon-url': 'http://daemon:9',
      token: 'secret',
      timeout: 50,
    });

    expect(mockDaemonClient).toHaveBeenCalledWith({
      baseUrl: 'http://daemon:9',
      token: 'secret',
    });
    expect(mockGetChannelWorkerControl).toHaveBeenCalledWith({ timeoutMs: 50 });
    expect(mockReadServiceInfo).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('enabled'),
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      '[Channel] Startup failure (workspace=/work, channel=feishu, phase=connect): connection refused',
    );
  });

  it('reports remote status failures on stderr', async () => {
    mockGetChannelWorkerControl.mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStatus({ 'daemon-url': 'http://daemon:9' });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('offline'),
    );
    expect(mockReadServiceInfo).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  describe('session counts', () => {
    const daemonRoutes = (workspace: string) =>
      path.join('channels', 'daemon', workspace, 'routes.json');
    const standaloneSessions = path.join('channels', 'sessions.json');

    const routeEntry = (channelName: string, sessionId: string) => ({
      sessionId,
      target: {
        channelName,
        senderId: 'sender',
        chatId: 'chat',
        isGroup: false,
      },
      cwd: '/work',
    });

    function serveInfo(channels: string[]) {
      return {
        owner: 'serve' as const,
        pid: 1234,
        servePid: 1234,
        workerPid: 5678,
        startedAt: new Date().toISOString(),
        channels,
      };
    }

    function mockRouteFiles(files: Record<string, unknown>) {
      // Every candidate file exists, so the directory-entry filter is the only
      // thing keeping a stray non-directory out of the read path.
      mockExistsSync.mockImplementation((target) =>
        String(target).endsWith('.json'),
      );
      mockReadFileSync.mockImplementation((target) => {
        const suffix = Object.keys(files).find((candidate) =>
          String(target).endsWith(candidate),
        );
        if (suffix === undefined) {
          throw new Error(`unexpected read: ${String(target)}`);
        }
        return JSON.stringify(files[suffix]);
      });
    }

    beforeEach(() => {
      vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit: ${String(code)}`);
      });
    });

    it('counts daemon-persisted routes for a single-workspace serve pidfile', async () => {
      // A single-workspace daemon writes no workers[]/workspaceCwd, so the
      // count must not depend on resolving a workspace from the pidfile.
      mockReadServiceInfo.mockReturnValue(serveInfo(['wechat-bot']));
      mockReaddirSync.mockReturnValue([
        { name: 'ws-a', isDirectory: () => true },
      ]);
      mockRouteFiles({
        [daemonRoutes('ws-a')]: {
          'wechat-bot:sender:chat': routeEntry('wechat-bot', 'session-1'),
        },
      });

      await expect(invokeStatus()).rejects.toThrow('process.exit: 0');

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        expect.stringMatching(/^wechat-bot\s+1$/),
      );
      expect(mockReadFileSync).toHaveBeenCalledWith(
        expect.stringContaining(daemonRoutes('ws-a')),
        'utf-8',
      );
      expect(mockReadFileSync).not.toHaveBeenCalledWith(
        expect.stringContaining(standaloneSessions),
        'utf-8',
      );
    });

    it('sums routes across daemon workspaces and skips non-directories', async () => {
      mockReadServiceInfo.mockReturnValue(serveInfo(['wechat-bot']));
      mockReaddirSync.mockReturnValue([
        { name: 'ws-a', isDirectory: () => true },
        { name: 'ws-b', isDirectory: () => true },
        { name: 'stray.json', isDirectory: () => false },
      ]);
      mockRouteFiles({
        [daemonRoutes('ws-a')]: {
          'wechat-bot:sender:chat': routeEntry('wechat-bot', 'session-1'),
        },
        [daemonRoutes('ws-b')]: {
          'wechat-bot:sender2:chat2': routeEntry('wechat-bot', 'session-2'),
          'other:sender:chat': routeEntry('other', 'session-3'),
        },
      });

      await expect(invokeStatus()).rejects.toThrow('process.exit: 0');

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        expect.stringMatching(/^wechat-bot\s+2$/),
      );
      expect(mockReadFileSync).not.toHaveBeenCalledWith(
        expect.stringContaining(path.join('stray.json', 'routes.json')),
        'utf-8',
      );
    });

    it('reports zero when the daemon state directory does not exist', async () => {
      mockReadServiceInfo.mockReturnValue(serveInfo(['wechat-bot']));
      mockReaddirSync.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await expect(invokeStatus()).rejects.toThrow('process.exit: 0');

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        expect.stringMatching(/^wechat-bot\s+0$/),
      );
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });

    it('still reads the shared sessions.json for a standalone channel service', async () => {
      mockReadServiceInfo.mockReturnValue({
        owner: 'channel',
        pid: 1234,
        startedAt: new Date().toISOString(),
        channels: ['telegram'],
      });
      mockRouteFiles({
        [standaloneSessions]: {
          'telegram:sender:chat': routeEntry('telegram', 'session-1'),
        },
      });

      await expect(invokeStatus()).rejects.toThrow('process.exit: 0');

      expect(mockWriteStdoutLine).toHaveBeenCalledWith(
        expect.stringMatching(/^telegram\s+1$/),
      );
      expect(mockReaddirSync).not.toHaveBeenCalled();
    });
  });
});
