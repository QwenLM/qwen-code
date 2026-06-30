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
    vi.unstubAllEnvs();
  });

  it('passes daemon connection details through env without putting token in argv', async () => {
    vi.stubEnv('QWEN_SERVER_TOKEN', 'serve-token');
    vi.stubEnv('OPENAI_API_KEY', 'openai-secret');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-secret');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-secret');
    vi.stubEnv('GITHUB_TOKEN', 'github-secret');
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
          QWEN_CHANNEL_DAEMON_WORKER: '1',
        }),
        cwd: '/workspace',
      }),
    );
    const env = (spawnWorker.mock.calls[0]![2] as { env: NodeJS.ProcessEnv })
      .env;
    expect(env).not.toHaveProperty('QWEN_SERVER_TOKEN');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).toHaveProperty('HTTPS_PROXY', 'http://proxy.example.com:8080');
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

  it('does not signal a spawn failure that never produced a process pid', async () => {
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

    expect(child.kill).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
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
});
