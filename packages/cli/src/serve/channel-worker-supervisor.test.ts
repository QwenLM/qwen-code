import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createChannelWorkerSupervisor,
  type ChannelWorkerChild,
} from './channel-worker-supervisor.js';

class FakeChild extends EventEmitter implements ChannelWorkerChild {
  pid: number | undefined = 12345;
  killed = false;
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

  it('preserves the pre-ready error when the worker exits after an error', async () => {
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
    child.emit('exit', 1, null);

    await expect(started).rejects.toThrow('spawn error');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      exitCode: 1,
      signal: null,
      error: 'spawn error',
    });
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
        error: 'ipc failed',
      }),
    );
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
    await supervisor.stop();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
    });
  });

  it('preserves a ready worker error when force-killing after failed state', async () => {
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
      state: 'exited',
      signal: 'SIGKILL',
      error: 'ipc failed',
    });
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
  });
});
