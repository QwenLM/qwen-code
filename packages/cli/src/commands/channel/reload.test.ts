import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReloadChannelWorker = vi.hoisted(() => vi.fn());
const mockDaemonClient = vi.hoisted(() =>
  vi.fn(() => ({ reloadChannelWorker: mockReloadChannelWorker })),
);
const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
const mockWriteStderrLine = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/sdk/daemon', () => ({
  DaemonClient: mockDaemonClient,
}));
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: mockWriteStderrLine,
}));

import { reloadCommand } from './reload.js';

type ReloadHandler = NonNullable<typeof reloadCommand.handler>;

async function runHandler(argv: Record<string, unknown>): Promise<void> {
  await (reloadCommand.handler as ReloadHandler)({
    _: [],
    $0: 'qwen',
    ...argv,
  } as never);
}

describe('channel reload command', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.unstubAllEnvs();
    vi.stubEnv('QWEN_DAEMON_URL', undefined);
    vi.stubEnv('QWEN_SERVER_TOKEN', undefined);
    vi.stubEnv('QWEN_DAEMON_TOKEN', undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    mockReloadChannelWorker.mockReset();
    mockDaemonClient.mockClear();
    mockWriteStdoutLine.mockClear();
    mockWriteStderrLine.mockClear();
  });

  it('reloads via the resolved daemon URL/token and prints the snapshot', async () => {
    mockReloadChannelWorker.mockResolvedValue({
      reloaded: true,
      worker: {
        enabled: true,
        state: 'running',
        channels: ['telegram'],
        pid: 4321,
        restartCount: 2,
      },
    });

    await runHandler({ 'daemon-url': 'http://daemon:9', token: 'secret' });

    expect(mockDaemonClient).toHaveBeenCalledWith({
      baseUrl: 'http://daemon:9',
      token: 'secret',
    });
    expect(mockReloadChannelWorker).toHaveBeenCalledTimes(1);
    const line = mockWriteStdoutLine.mock.calls[0]?.[0] as string;
    expect(line).toContain('state=running');
    expect(line).toContain('channels=telegram');
    expect(line).toContain('pid=4321');
    expect(line).toContain('restarts=2');
    expect(process.exit).toHaveBeenCalledWith(0);
    expect(mockWriteStderrLine).not.toHaveBeenCalled();
  });

  it('defaults the daemon URL and omits the token when neither flag nor env is set', async () => {
    mockReloadChannelWorker.mockResolvedValue({
      reloaded: true,
      worker: { enabled: true, state: 'running', channels: [] },
    });

    await runHandler({});

    expect(mockDaemonClient).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:4170',
    });
  });

  it('falls back to QWEN_DAEMON_URL and QWEN_SERVER_TOKEN from the environment', async () => {
    vi.stubEnv('QWEN_DAEMON_URL', 'http://env-daemon:5');
    vi.stubEnv('QWEN_SERVER_TOKEN', 'env-token');
    mockReloadChannelWorker.mockResolvedValue({
      reloaded: true,
      worker: { enabled: true, state: 'running', channels: [] },
    });

    await runHandler({});

    expect(mockDaemonClient).toHaveBeenCalledWith({
      baseUrl: 'http://env-daemon:5',
      token: 'env-token',
    });
  });

  it('reports failures on stderr and exits non-zero', async () => {
    mockReloadChannelWorker.mockRejectedValue(new Error('no channel worker'));

    await runHandler({ 'daemon-url': 'http://daemon:9' });

    const line = mockWriteStderrLine.mock.calls[0]?.[0] as string;
    expect(line).toContain('Reload failed');
    expect(line).toContain('no channel worker');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('prints partial startup failures from a successful reload', async () => {
    mockReloadChannelWorker.mockResolvedValue({
      reloaded: true,
      worker: {
        enabled: true,
        state: 'running',
        channels: ['telegram'],
        startupFailures: [
          {
            channel: 'feishu',
            phase: 'connect',
            message: 'connection refused',
          },
        ],
      },
    });

    await runHandler({});

    expect(mockWriteStdoutLine).toHaveBeenCalledWith(
      '[Channel] Startup failure (channel=feishu, phase=connect): connection refused',
    );
  });

  it('prints structured startup failures from a failed reload body', async () => {
    mockReloadChannelWorker.mockRejectedValue(
      Object.assign(new Error('reload failed'), {
        body: {
          code: 'channel_worker_start_failed',
          startupFailures: [
            {
              workspaceCwd: '/work',
              channel: 'telegram',
              phase: 'connect',
              code: 'ECONNREFUSED',
              message: 'connection refused',
            },
          ],
        },
      }),
    );

    await runHandler({});

    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      '[Channel] Startup failure (workspace=/work, channel=telegram, phase=connect, code=ECONNREFUSED): connection refused',
    );
  });
});
