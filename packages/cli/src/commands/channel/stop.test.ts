import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadServiceInfo = vi.hoisted(() => vi.fn());
const mockSignalService = vi.hoisted(() => vi.fn());
const mockWaitForExit = vi.hoisted(() => vi.fn());
const mockRemoveServiceInfo = vi.hoisted(() => vi.fn());
const mockIsSameProcess = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockStopChannelWorker = vi.hoisted(() => vi.fn());
const mockDaemonClient = vi.hoisted(() =>
  vi.fn(() => ({ stopChannelWorker: mockStopChannelWorker })),
);

vi.mock('@qwen-code/sdk/daemon', () => ({ DaemonClient: mockDaemonClient }));

vi.mock('./pidfile.js', () => ({
  readServiceInfo: mockReadServiceInfo,
  signalService: mockSignalService,
  waitForExit: mockWaitForExit,
  removeServiceInfo: mockRemoveServiceInfo,
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  isSameProcess: mockIsSameProcess,
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
}));

import { stopCommand } from './stop.js';

const runningService = {
  owner: 'channel',
  pid: 1234,
  procStart: 'boot-id:recorded-start',
  startedAt: '2026-01-01T00:00:00.000Z',
  channels: ['telegram'],
};

async function invokeStop(argv: Record<string, unknown> = {}): Promise<void> {
  const handler = stopCommand.handler;
  if (!handler) throw new Error('stop handler missing');
  await handler({ _: [], $0: 'qwen', ...argv } as never);
}

function exitThrows(): void {
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit: ${String(code)}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stopCommand', () => {
  it('threads the recorded process token through signal and wait operations', async () => {
    mockReadServiceInfo.mockReturnValue(runningService);
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(true);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await invokeStop();

    expect(mockSignalService).toHaveBeenCalledWith(
      1234,
      'SIGTERM',
      'boot-id:recorded-start',
    );
    expect(mockWaitForExit).toHaveBeenCalledWith(
      1234,
      5000,
      200,
      'boot-id:recorded-start',
    );
  });

  it('does not signal serve-owned channel workers', async () => {
    mockReadServiceInfo.mockReturnValue({
      owner: 'serve',
      pid: 1234,
      servePid: 1234,
      workerPid: 5678,
      startedAt: '2026-01-01T00:00:00.000Z',
      channels: ['telegram'],
    });
    exitThrows();

    await expect(invokeStop()).rejects.toThrow('process.exit: 1');

    expect(mockSignalService).not.toHaveBeenCalled();
    expect(mockRemoveServiceInfo).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('managed by qwen serve'),
    );
  });

  it('keeps the record of a service a refused SIGTERM left running', async () => {
    mockReadServiceInfo.mockReturnValue(runningService);
    mockSignalService.mockReturnValue(false);
    mockIsSameProcess.mockReturnValue(true);
    exitThrows();

    await expect(invokeStop()).rejects.toThrow('process.exit: 1');

    expect(mockIsSameProcess).toHaveBeenCalledWith(
      1234,
      'boot-id:recorded-start',
    );
    expect(mockRemoveServiceInfo).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('still running'),
    );
  });

  it('cleans up a refused SIGTERM once the process is confirmed gone', async () => {
    mockReadServiceInfo.mockReturnValue(runningService);
    mockSignalService.mockReturnValue(false);
    mockIsSameProcess.mockReturnValue(false);
    exitThrows();

    await expect(invokeStop()).rejects.toThrow('process.exit: 0');

    expect(mockRemoveServiceInfo).toHaveBeenCalledWith(runningService);
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'Failed to send signal — process may have already exited.',
    );
  });

  it('keeps the record of a service that survives SIGKILL', async () => {
    mockReadServiceInfo.mockReturnValue(runningService);
    mockSignalService.mockReturnValue(true);
    mockWaitForExit.mockResolvedValue(false);
    exitThrows();

    await expect(invokeStop()).rejects.toThrow('process.exit: 1');

    expect(mockSignalService).toHaveBeenCalledWith(
      1234,
      'SIGKILL',
      'boot-id:recorded-start',
    );
    expect(mockRemoveServiceInfo).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('still running'),
    );
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
});
