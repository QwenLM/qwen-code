import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadServiceInfo = vi.hoisted(() => vi.fn());
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockGetChannelWorkerControl = vi.hoisted(() => vi.fn());
const mockDaemonClient = vi.hoisted(() =>
  vi.fn(() => ({ getChannelWorkerControl: mockGetChannelWorkerControl })),
);

vi.mock('@qwen-code/sdk/daemon', () => ({ DaemonClient: mockDaemonClient }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = vi.fn(() => false);
  const readFileSync = vi.fn();
  return {
    ...actual,
    existsSync,
    readFileSync,
    default: {
      ...actual,
      existsSync,
      readFileSync,
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
});
