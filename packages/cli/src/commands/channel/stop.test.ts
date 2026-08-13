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
    // mocks still exercise "persistence failure never blocks a stop", and
    // report the persisted boolean so failure-path messages are testable.
    trySet: (name: string, state: 'active' | 'stopped') => {
      try {
        mockChannelStateStoreSetMany([name], state);
        return true;
      } catch {
        return false;
      }
    },
    trySetMany: (names: string[], state: 'active' | 'stopped') => {
      try {
        mockChannelStateStoreSetMany(names, state);
        return true;
      } catch {
        return false;
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
    // A response WITHOUT statePersisted (e.g. a long-running pre-#8975
    // daemon) must not print the durability warning: only an explicit
    // `false` means the record was lost.
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('reports when daemon-managed channels are already stopped', async () => {
    mockStopChannelWorker.mockResolvedValueOnce({ changed: false });
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop({ 'daemon-url': 'http://daemon:9' });

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Daemon-managed channels are already stopped.',
    );
    expect(mockReadServiceInfo).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('warns when the daemon stop record failed to persist (#8975)', async () => {
    // The route reports a successful stop whose `stopped` record did not
    // persist (ENOSPC/EACCES on the daemon channels dir). The CLI must
    // surface the loss like the standalone path does — printing an
    // unqualified success here resurrects the channels on the next
    // `--channel all` (#8975).
    mockStopChannelWorker.mockResolvedValueOnce({
      changed: true,
      statePersisted: false,
    });
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop({ 'daemon-url': 'http://daemon:9' });

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'Daemon-managed channels stopped.',
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('warns when a failed daemon stop also lost the stopped record (#8975)', async () => {
    // The DELETE route reports a failed stop whose torn-down record ALSO
    // failed to persist via statePersisted: false on the DaemonHttpError
    // body. The CLI must surface the loss before exiting non-zero, or the
    // stopped channels resurrect on the next `--channel all` with no
    // trace (#8975).
    mockStopChannelWorker.mockRejectedValueOnce(
      Object.assign(new Error('stop failed'), {
        status: 500,
        body: { error: 'Stop failed', statePersisted: false },
      }),
    );
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop({ 'daemon-url': 'http://daemon:9' });

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('stop failed'),
    );
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('keeps a plain failed daemon stop quiet about persistence (#8975)', async () => {
    // No statePersisted on the error body (ordinary stop failure, or a
    // pre-#8975 daemon): the durability warning would be a false alarm.
    mockStopChannelWorker.mockRejectedValueOnce(new Error('stop failed'));
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop({ 'daemon-url': 'http://daemon:9' });

    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
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
    // The record persisted, so the exit message must be the durable-stop
    // guidance (the only user-visible way back out of the stopped state),
    // NOT the durability warning (#8975).
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('stay stopped'),
    );
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
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

    // The peek must run BEFORE readServiceInfo: the read unlinks a
    // crashed service's stale pidfile during its liveness check, so a
    // later peek would see no file and silently drop the stop record.
    expect(mockPeekServiceInfo.mock.invocationCallOrder[0]).toBeLessThan(
      mockReadServiceInfo.mock.invocationCallOrder[0]!,
    );
    expect(mockChannelRuntimeStatePath).toHaveBeenCalledWith('/workspace/a');
    // And the store is constructed with the path the helper returns — a
    // split here writes the stop to a different file than start reads.
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      '/tmp/qwen-home/channels/channel-state.json',
    );
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

  it('reports when the crashed service stop record fails to persist (#8975)', async () => {
    mockPeekServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
    mockReadServiceInfo.mockReturnValue(null);
    mockChannelStateStoreSetMany.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    // The success message claims a durable stop; a swallowed write failure
    // must not print it, or the resurrection comes as a surprise (#8975).
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('Could not record the crashed service channels'),
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

  it('does not record a crashed zero-channel service as stopped (#8975)', async () => {
    // A zero-channel standalone service is a legitimate state this PR
    // introduces (serveWithoutChannels writes a `channels: []` pidfile);
    // when that process dies, stop must not claim it recorded stops for a
    // service that had no channels (#8975).
    mockPeekServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: [],
      workspaceCwd: '/workspace/a',
    });
    mockReadServiceInfo.mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockChannelStateStoreSetMany).not.toHaveBeenCalled();
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      'No channel service is running.',
    );
  });

  it('falls back to the legacy global file for crashed older pidfiles (#8975)', async () => {
    // Crash-path twin of the live-path legacy test: pidfiles from older
    // releases carry no workspaceCwd, so the recorded stops must land in
    // the legacy global file, where the next start's adoption finds them.
    mockPeekServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
    });
    mockReadServiceInfo.mockReturnValue(null);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockChannelRuntimeStatePath).toHaveBeenCalledWith(undefined);
    // And the store is constructed with the path the helper returns — a
    // split here writes the stop to a different file than start reads.
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      '/tmp/qwen-home/channels/channel-state.json',
    );
    expect(mockChannelStateStoreSetMany).toHaveBeenCalledWith(
      ['telegram'],
      'stopped',
    );
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
    // And the store is constructed with the path the helper returns — a
    // split here writes the stop to a different file than start reads.
    expect(mockChannelStateStore).toHaveBeenCalledWith(
      '/tmp/qwen-home/channels/channel-state.json',
    );
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
    // The "stay stopped" message claims a durable stop; a swallowed write
    // failure must surface the contrary warning instead (#8975).
    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
  });

  it('surfaces a lost stop record when the service died before the signal (#8975)', async () => {
    // The realistic shape when stopping a hung or dying service: the state
    // write fails (disk full) AND the service dies between the liveness
    // check and SIGTERM delivery. This branch exits 0 before the final
    // recorded-conditional message, so the warning must be emitted inside
    // it, or the lost record is never surfaced (#8975).
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
    mockChannelStateStoreSetMany.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    mockSignalService.mockReturnValue(false);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    await expect(invokeStop()).rejects.toThrow('process.exit: 0');

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Failed to send signal'),
    );
    expect(mockRemoveServiceInfo).toHaveBeenCalled();
    // The branch must exit before any wait/kill fall-through.
    expect(mockWaitForExit).not.toHaveBeenCalled();
  });

  it('keeps the signal-failure branch quiet when the record persisted (#8975)', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'channel',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
      workspaceCwd: '/workspace/a',
    });
    mockSignalService.mockReturnValue(false);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${String(code)}`);
    });

    await expect(invokeStop()).rejects.toThrow('process.exit: 0');

    // The record persisted, so only the signal failure is reported — the
    // persistence warning would be a false alarm here.
    expect(mockWriteStdoutLine).not.toHaveBeenCalledWith(
      expect.stringContaining('could not persist the stopped record'),
    );
    expect(mockRemoveServiceInfo).toHaveBeenCalled();
  });
});
