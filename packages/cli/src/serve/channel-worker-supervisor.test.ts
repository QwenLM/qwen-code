import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createChannelWorkerSupervisor,
  type ChannelWorkerChild,
} from './channel-worker-supervisor.js';

class FakeChild extends EventEmitter implements ChannelWorkerChild {
  pid: number | undefined = 12345;
  killed = false;
  stdout?: EventEmitter;
  stderr?: EventEmitter;
  constructor(private readonly emitExitOnKill = true) {
    super();
  }

  kill = vi.fn((signal?: NodeJS.Signals | number) => {
    this.killed = true;
    if (this.emitExitOnKill) {
      this.emit('exit', null, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
    }
    return true;
  });
}

describe('createChannelWorkerSupervisor', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('passes daemon connection details through env without putting token in argv', async () => {
    vi.stubEnv('QWEN_SERVER_TOKEN', 'serve-token');
    vi.stubEnv('QWEN_DAEMON_TOKEN', 'stale-daemon-token');
    vi.stubEnv('OPENAI_API_KEY', 'openai-secret');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-secret');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-secret');
    vi.stubEnv('GITHUB_TOKEN', 'github-secret');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'telegram-secret');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.com:8080');
    const child = new FakeChild();
    const spawnWorker = vi.fn(
      (_execPath: string, _argv: string[], _options: unknown) => child,
    );
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      daemonToken: 'secret-token',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram', 'feishu'] },
      spawnWorker,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 54321,
      channels: ['telegram', 'feishu'],
      requestedChannels: ['telegram', 'feishu'],
    });
    await started;

    expect(spawnWorker).toHaveBeenCalledWith(
      process.execPath,
      [
        '/repo/dist/index.js',
        'channel',
        'daemon-worker',
        '--channel',
        'telegram',
        '--channel',
        'feishu',
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          QWEN_DAEMON_URL: 'http://127.0.0.1:4170',
          QWEN_DAEMON_TOKEN: 'secret-token',
          QWEN_DAEMON_WORKSPACE: '/workspace',
          QWEN_CODE_NO_RELAUNCH: 'true',
          QWEN_CHANNEL_DAEMON_WORKER: expect.any(String),
        }),
        cwd: '/workspace',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      }),
    );
    const env = (spawnWorker.mock.calls[0]![2] as { env: NodeJS.ProcessEnv })
      .env;
    expect(env).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(env).toHaveProperty('QWEN_DAEMON_TOKEN', 'secret-token');
    expect(env).toHaveProperty('OPENAI_API_KEY', 'openai-secret');
    expect(env).toHaveProperty('ANTHROPIC_API_KEY', 'anthropic-secret');
    expect(env).toHaveProperty('AWS_SECRET_ACCESS_KEY', 'aws-secret');
    expect(env).toHaveProperty('GITHUB_TOKEN', 'github-secret');
    expect(env).toHaveProperty('TELEGRAM_BOT_TOKEN', 'telegram-secret');
    expect(env).toHaveProperty('HTTPS_PROXY', 'http://proxy.example.com:8080');
    expect(env['QWEN_CHANNEL_DAEMON_WORKER']).not.toBe('1');
    const argv = spawnWorker.mock.calls[0]![1];
    expect(argv).not.toContain('secret-token');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 54321,
      channels: ['telegram', 'feishu'],
      requestedChannels: ['telegram', 'feishu'],
    });
  });

  it('ignores non-ready IPC messages before the ready message', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', { type: 'not-ready' });
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      channels: ['telegram'],
    });
  });

  it('rejects startup when the worker exits before ready', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('exit', 1, null);

    await expect(started).rejects.toThrow('Channel worker exited before ready');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      exitCode: 1,
    });
  });

  it('marks startup failed when spawning the worker throws', async () => {
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => {
        throw new Error('fork failed');
      }),
    });

    await expect(supervisor.start()).rejects.toThrow('fork failed');

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'fork failed',
      restartCount: 0,
    });
  });

  it('rejects startup when the worker never becomes ready', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      startupTimeoutMs: 1,
      spawnWorker: vi.fn(() => child),
    });

    await expect(supervisor.start()).rejects.toThrow(
      'Channel worker did not become ready within 1ms.',
    );
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'Channel worker did not become ready within 1ms.',
      exitCode: null,
      signal: 'SIGTERM',
    });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not signal a worker that already failed before ready', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('exit', 1, null);
    await expect(started).rejects.toThrow('Channel worker exited before ready');

    await supervisor.stop();

    expect(child.kill).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
    });
  });

  it('still signals a worker that errors before an exit is observed', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('error', new Error('spawn error'));
    await expect(started).rejects.toThrow('spawn error');

    await supervisor.stop();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
    });
  });

  it('sanitizes the pre-ready error when the worker exits after an error', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    const unsafeMessage = `spawn error\nfake log line\r${'\u001b'}[31m${'x'.repeat(600)}`;
    child.emit('error', new Error(unsafeMessage));
    child.emit('exit', 1, null);

    await expect(started).rejects.toThrow('spawn error\\nfake log line');
    const snapshot = supervisor.snapshot();
    expect(snapshot).toMatchObject({
      enabled: true,
      state: 'failed',
      exitCode: null,
      signal: 'SIGTERM',
    });
    expect(snapshot.error).toContain('spawn error');
    expect(snapshot.error).not.toContain('\n');
    expect(snapshot.error).not.toContain('\r');
    expect(snapshot.error).not.toContain('\u001b');
    expect(snapshot.error!.length).toBeLessThanOrEqual(512);
  });

  it('still signals a worker error without an observed exit when pid is absent', async () => {
    const child = new FakeChild();
    child.pid = undefined;
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('error', new Error('spawn ENOENT'));
    await expect(started).rejects.toThrow('spawn ENOENT');

    await supervisor.stop();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
    });
  });

  it('can start a new worker after a stopped worker exits', async () => {
    const firstChild = new FakeChild();
    const secondChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
    });

    const firstStart = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
    });
    await firstStart;
    await supervisor.stop();

    const secondStart = supervisor.start();
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
    });
    await secondStart;

    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 22222,
    });
  });

  it('notifies when a ready worker exits unexpectedly', async () => {
    const child = new FakeChild();
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onExit,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;
    child.emit('exit', 1, null);

    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        state: 'exited',
        exitCode: 1,
        signal: null,
      }),
    );
  });

  it('restarts a ready worker after unexpected exit within budget', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const onReady = vi.fn();
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      onReady,
      onExit,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    firstChild.emit('exit', 1, null);

    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'exited',
        pid: 11111,
        nextRestartAt: expect.any(String),
      }),
    );

    await vi.advanceTimersByTimeAsync(10);
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(onReady).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'running',
        pid: 22222,
        restartCount: 1,
        requestedChannels: ['telegram'],
      }),
    );
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 22222,
      restartCount: 1,
      requestedChannels: ['telegram'],
    });
  });

  it('does not restart a pre-ready startup failure', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const spawnWorker = vi.fn(() => child);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
    });

    const started = supervisor.start();
    child.emit('exit', 1, null);

    await expect(started).rejects.toThrow('Channel worker exited before ready');
    await vi.advanceTimersByTimeAsync(100);

    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      restartCount: 0,
    });
  });

  it('stops restarting after restart budget is exhausted', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild(false);
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: { maxRestarts: 1, windowMs: 300_000, delaysMs: [10] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(10);
    secondChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(100);

    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      restartCount: 1,
    });
  });

  it('does not double-notify or reschedule when a restart launch times out then exits', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild(false);
    const thirdChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild)
      .mockReturnValueOnce(thirdChild);
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      startupTimeoutMs: 5,
      spawnWorker,
      onExit,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(5);
    expect(secondChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(onExit).toHaveBeenCalledTimes(1);

    secondChild.emit('exit', null, 'SIGTERM');
    expect(onExit).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10);
    thirdChild.emit('message', {
      type: 'ready',
      pid: 33333,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(onExit).toHaveBeenCalledTimes(2);
    expect(spawnWorker).toHaveBeenCalledTimes(3);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 33333,
      restartCount: 2,
    });
  });

  it('captures restart spawn failures and schedules the next restart internally', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const thirdChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockImplementationOnce(() => {
        throw new Error('fork failed');
      })
      .mockReturnValueOnce(thirdChild);
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      onExit,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('exit', 1, null);

    await vi.advanceTimersByTimeAsync(10);
    expect(onExit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'failed',
        error: 'fork failed',
        restartCount: 1,
        nextRestartAt: expect.any(String),
      }),
    );

    await vi.advanceTimersByTimeAsync(10);
    thirdChild.emit('message', {
      type: 'ready',
      pid: 33333,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(spawnWorker).toHaveBeenCalledTimes(3);
    expect(onExit).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 33333,
      restartCount: 2,
    });
  });

  it('does not count expired restart attempts against the restart budget', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild(false);
    const thirdChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild)
      .mockReturnValueOnce(thirdChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: { maxRestarts: 1, windowMs: 50, delaysMs: [10] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(10);
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(51);
    secondChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(10);
    thirdChild.emit('message', {
      type: 'ready',
      pid: 33333,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(spawnWorker).toHaveBeenCalledTimes(3);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 33333,
      restartCount: 2,
    });
  });

  it('cancels a pending restart when stopped', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [100] },
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('exit', 1, null);

    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
    });
  });

  it('restarts when no heartbeat arrives after ready', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
      heartbeatTimeoutMs: 20,
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    await vi.advanceTimersByTimeAsync(20);
    firstChild.emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(10);
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 22222,
      restartCount: 1,
      staleHeartbeatAt: expect.any(String),
    });
  });

  it('restarts when heartbeat becomes stale after ready', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
      heartbeatTimeoutMs: 20,
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    firstChild.emit('message', {
      type: 'heartbeat',
      pid: 11111,
      at: new Date().toISOString(),
    });

    await vi.advanceTimersByTimeAsync(20);
    firstChild.emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(10);
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 22222,
      restartCount: 1,
      lastHeartbeatAt: expect.any(String),
    });
  });

  it('cancels stale heartbeat detection when stopped intentionally', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
      heartbeatTimeoutMs: 20,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(20);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
    });
  });

  it('forwards worker stdout and stderr lines with secrets redacted', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'telegram-secret');
    vi.stubEnv('REDIS_PASSWORD', 'redis-secret');
    vi.stubEnv('BASIC_AUTH', 'basic-auth-secret');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy-user:p@ssword@proxy.example:8080');
    const child = new FakeChild();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const onLog = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      daemonToken: 'secret-token',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onLog,
    });

    const started = supervisor.start();
    child.stderr.emit('data', Buffer.from('failed with secret-token\n'));
    child.stdout.emit('data', Buffer.from('adapter token telegram-secret'));
    child.stdout.emit('data', Buffer.from('\nredis redis-secret\n'));
    child.stdout.emit('data', Buffer.from('auth basic-auth-secret\n'));
    child.stdout.emit('end');
    child.stderr.emit(
      'data',
      Buffer.from('proxy http://proxy-user:p@ssword@proxy.example:8080/path\n'),
    );
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    expect(onLog).toHaveBeenCalledWith({
      stream: 'stderr',
      line: 'failed with <redacted>',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stdout',
      line: 'adapter token <redacted>',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stdout',
      line: 'redis <redacted>',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stdout',
      line: 'auth <redacted>',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stderr',
      line: 'proxy http://<redacted>@proxy.example:8080/path',
    });
    expect(
      onLog.mock.calls.flatMap((call) => call[0].line).join('\n'),
    ).not.toContain('ssword');
  });

  it('flushes oversized worker log buffers without waiting for a newline', async () => {
    const child = new FakeChild();
    child.stderr = new EventEmitter();
    const onLog = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onLog,
    });

    const started = supervisor.start();
    child.stderr.emit('data', Buffer.from('x'.repeat(70_000)));
    child.stderr.emit('data', Buffer.from('discarded oversized tail'));
    child.stderr.emit('data', Buffer.from('\nnext line\n'));
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const firstLog = onLog.mock.calls[0]?.[0];
    expect(firstLog).toMatchObject({ stream: 'stderr' });
    expect(firstLog?.line).toHaveLength(4096);
    expect(onLog).toHaveBeenLastCalledWith({
      stream: 'stderr',
      line: 'next line',
    });
  });

  it('handles long non-url worker log lines while applying credential redaction', async () => {
    const child = new FakeChild();
    child.stderr = new EventEmitter();
    const onLog = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onLog,
    });

    const started = supervisor.start();
    child.stderr.emit('data', Buffer.from('a.'.repeat(33_000)));
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    const firstLog = onLog.mock.calls[0]?.[0];
    expect(firstLog).toMatchObject({ stream: 'stderr' });
    expect(firstLog?.line).toHaveLength(4096);
  });

  it('does not throw when worker log forwarding bookkeeping fails', async () => {
    const child = new FakeChild();
    child.stderr = new EventEmitter();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onLog: () => {
        throw new Error('log sink failed');
      },
    });

    const started = supervisor.start();
    expect(() =>
      child.stderr?.emit('data', Buffer.from('line\n')),
    ).not.toThrow();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 12345,
    });
  });

  it('does not throw when a worker log pipe emits an error', async () => {
    const child = new FakeChild();
    child.stderr = new EventEmitter();
    const onLog = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onLog,
    });

    const started = supervisor.start();
    child.stderr.emit('data', Buffer.from('partial line'));
    expect(() =>
      child.stderr?.emit('error', new Error('pipe failed')),
    ).not.toThrow();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 12345,
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stderr',
      line: 'partial line',
    });
  });

  it('does not throw when onExit bookkeeping fails', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onExit: () => {
        throw new Error('pidfile cleanup failed');
      },
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;

    expect(() => child.emit('exit', 1, null)).not.toThrow();
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'exited',
      exitCode: 1,
    });
  });

  it('does not notify onExit when stopping a ready worker intentionally', async () => {
    const child = new FakeChild();
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onExit,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;
    await supervisor.stop();

    expect(onExit).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
    });
  });

  it('notifies onExit once when a ready worker emits error and exit', async () => {
    const child = new FakeChild();
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onExit,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;
    child.emit('error', new Error('ipc failed'));
    child.emit('exit', 1, null);

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'exited',
        exitCode: 1,
        signal: null,
      }),
    );
    expect(onExit.mock.calls[0]![0]).not.toHaveProperty('error');
  });

  it('ignores a late error after a ready worker exit is already recorded', async () => {
    const child = new FakeChild();
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onExit,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;
    child.emit('exit', 7, null);
    child.emit('error', new Error('late ipc failed'));

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'exited',
      exitCode: 7,
      signal: null,
    });
  });

  it('can still stop a ready worker after an error without exit', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onExit: vi.fn(),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;
    child.emit('error', new Error('ipc failed'));

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      channels: ['telegram'],
    });
    expect(supervisor.snapshot()).not.toHaveProperty('error');

    await supervisor.stop();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
    });
  });

  it('force-kills a ready worker after a post-ready error without marking it failed', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;
    child.emit('error', new Error('ipc failed'));

    supervisor.killAllSync();

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
      signal: 'SIGKILL',
    });
    expect(supervisor.snapshot()).not.toHaveProperty('error');
  });

  it('kills the worker synchronously on force shutdown', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;

    supervisor.killAllSync();

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
      signal: 'SIGKILL',
    });
  });

  it('force-kills even after SIGTERM was already sent', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;
    child.killed = true;

    supervisor.killAllSync();

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not clobber failed startup state on force shutdown', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('exit', 1, null);
    await expect(started).rejects.toThrow('Channel worker exited before ready');

    supervisor.killAllSync();

    expect(child.kill).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      exitCode: 1,
      error: expect.stringContaining('Channel worker exited before ready'),
    });
  });

  it('does not report stopped when the worker ignores SIGKILL', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    const secondChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(secondChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      spawnWorker,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
    });
    await started;

    const stopped = supervisor.stop();
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(2_000);
    await stopped;

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      signal: 'SIGKILL',
      error: 'Channel worker did not exit after SIGKILL.',
    });

    const restarted = supervisor.start();
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await restarted;

    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });

    child.emit('exit', 0, null);

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
  });
});
