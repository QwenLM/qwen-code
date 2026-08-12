import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadServiceInfo = vi.hoisted(() => vi.fn());
const mockPeekServiceInfo = vi.hoisted(() => vi.fn());
const mockSignalService = vi.hoisted(() => vi.fn());
const mockWaitForExit = vi.hoisted(() => vi.fn());
const mockRemoveServiceInfo = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockStopChannelWorker = vi.hoisted(() => vi.fn());
const mockDaemonClient = vi.hoisted(() =>
  vi.fn(() => ({ stopChannelWorker: mockStopChannelWorker })),
);
const mockChannelStateStoreSetMany = vi.hoisted(() => vi.fn());
const mockChannelStateStore = vi.hoisted(() =>
  vi.fn(() => ({
    readAll: vi.fn(() => ({})),
    set: vi.fn(),
    setMany: mockChannelStateStoreSetMany,
    // Mirror the real best-effort wrappers so throwing `set`/`setMany`
    // mocks still exercise "persistence failure never blocks a stop".
    trySet: (name: string, state: 'active' | 'stopped') => {
      try {
        mockChannelStateStoreSetMany([name], state);
      } catch {
        // best-effort
      }
    },
    trySetMany: (names: string[], state: 'active' | 'stopped') => {
      try {
        mockChannelStateStoreSetMany(names, state);
      } catch {
        // best-effort
      }
    },
  })),
);
const mockChannelRuntimeStatePath = vi.hoisted(() =>
  vi.fn(() => '/tmp/qwen-home/channels/channel-state.json'),
);

vi.mock('@qwen-code/sdk/daemon', () => ({ DaemonClient: mockDaemonClient }));

vi.mock('./pidfile.js', () => ({
  readServiceInfo: mockReadServiceInfo,
  peekServiceInfo: mockPeekServiceInfo,
  signalService: mockSignalService,
  waitForExit: mockWaitForExit,
  removeServiceInfo: mockRemoveServiceInfo,
}));

vi.mock('./channel-state-store.js', () => ({
  ChannelStateStore: mockChannelStateStore,
  channelRuntimeStatePath: mockChannelRuntimeStatePath,
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
}));

import { stopCommand } from './stop.js';

async function invokeStop(argv: Record<string, unknown> = {}): Promise<void> {
  const handler = stopCommand.handler;
  if (!handler) throw new Error('stop handler missing');
  await handler({ _: [], $0: 'qwen', ...argv } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stopCommand', () => {
  it('does not signal serve-owned channel workers', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'serve',
      pid: 1234,
      servePid: 1234,
      workerPid: 5678,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
    });
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    await expect(invokeStop()).rejects.toThrow('process.exit: 1');

    expect(mockSignalService).not.toHaveBeenCalled();
    expect(mockRemoveServiceInfo).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('managed by qwen serve'),
    );
    // A serve-owned pidfile carries no workspaceCwd; persisting on this path
    // would land serve's channel union in the legacy global file, which the
    // next standalone start in ANY workspace adopts (#8975).
    expect(mockChannelRuntimeStatePath).not.toHaveBeenCalled();
    expect(mockChannelStateStore).not.toHaveBeenCalled();
    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
  });

  it('stops daemon-managed channels remotely without touching the pidfile', async () => {
    mockStopChannelWorker.mockResolvedValueOnce({ changed: true });
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop({
      'daemon-url': 'http://daemon:9',
      token: 'secret',
      timeout: 75,
    });

    expect(mockDaemonClient).toHaveBeenCalledWith({
      baseUrl: 'http://daemon:9',
      token: 'secret',
    });
    expect(mockStopChannelWorker).toHaveBeenCalledWith({ timeoutMs: 75 });
    expect(mockReadServiceInfo).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Daemon-managed channels stopped.',
    );
  });

  it('reports when daemon-managed channels are already stopped', async () => {
    mockStopChannelWorker.mockResolvedValueOnce({ changed: false });
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop({ 'daemon-url': 'http://daemon:9' });

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Daemon-managed channels are already stopped.',
    );
    expect(mockReadServiceInfo).not.toHaveBeenCalled();
  });

  it('reports remote stop failures without falling through to standalone mode', async () => {
    mockStopChannelWorker.mockRejectedValueOnce(new Error('stop failed'));
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop({ 'daemon-url': 'http://daemon:9' });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('stop failed'),
    );
    expect(mockReadServiceInfo).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('records stopped channels so --channel all does not restart them', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram', 'feishu'],
      workspaceCwd: '/workspace/a',
    });
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockChannelStateStoreSetMany).toHaveBeenCalledWith(
      ['telegram', 'feishu'],
      'stopped',
    );
    expect(mockSignalService).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(mockWriteStdoutLine).toHaveBeenCalledWith('Service stopped.');
  });

  it('persists the stopped record before signalling the service (#8975)', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram', 'feishu'],
      workspaceCwd: '/workspace/a',
    });
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    // The ordering is load-bearing: if the service is signalled first,
    // anything interrupting the stop between signal and persist leaves it
    // dead without a `stopped` record, and the next `--channel all` start
    // resurrects the channels the user explicitly stopped.
    const persistedAt =
      mockChannelStateStoreSetMany.mock.invocationCallOrder[0];
    const signalledAt = mockSignalService.mock.invocationCallOrder[0];
    expect(persistedAt).toBeDefined();
    expect(signalledAt).toBeDefined();
    expect(persistedAt!).toBeLessThan(signalledAt!);
  });

  it('scopes the stop record to the workspace from the pidfile (#8975)', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockChannelRuntimeStatePath).toHaveBeenCalledWith('/workspace/a');
    // And the store is constructed with the path the helper returns — a
    // split here writes the stop to a different file than start reads.
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      '/tmp/qwen-home/channels/channel-state.json',
    );
  });

  it('persists the crashed service channels from a stale pidfile (#8975)', async () => {
    // The process died, so readServiceInfo unlinks the stale pidfile and
    // returns null; the peek captures the channels first, or the explicit
    // stop is lost and the next `--channel all` start resurrects them.
    mockPeekServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram', 'feishu'],
      workspaceCwd: '/workspace/a',
    });
    mockReadServiceInfo.mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockChannelRuntimeStatePath).toHaveBeenCalledWith('/workspace/a');
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledWith(
      ['telegram', 'feishu'],
      'stopped',
    );
    expect(mockSignalService).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining(
        'Recorded the crashed service channels as stopped',
      ),
    );
  });

  it('does not persist for a crashed serve-owned or empty pidfile (#8975)', async () => {
    mockPeekServiceInfo.mockReturnValue({
      owner: 'serve',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
    });
    mockReadServiceInfo.mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'No channel service is running.',
    );

    mockPeekServiceInfo.mockReturnValue(null);
    await invokeStop();

    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
  });

  it('falls back to the legacy global state file for older pidfiles (#8975)', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
    });
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockChannelRuntimeStatePath).toHaveBeenCalledWith(undefined);
  });

  it('still stops the service when state persistence fails', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
    });
    mockChannelStateStoreSetMany.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockSignalService).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(mockWriteStdoutLine).toHaveBeenCalledWith('Service stopped.');
  });
});
