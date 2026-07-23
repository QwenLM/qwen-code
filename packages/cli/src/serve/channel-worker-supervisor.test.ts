import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelWebhookTask } from '@qwen-code/channel-base';
import {
  ChannelWorkerStartupError,
  createChannelWorkerSupervisor,
  type ChannelWorkerChild,
} from './channel-worker-supervisor.js';
import { CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS } from './channel-worker-env.js';
import { MAX_CHANNEL_STARTUP_FAILURES } from './channel-worker-startup-ipc.js';
import {
  CHANNEL_DELIVERY_IPC_TIMEOUT_MS,
  MAX_CHANNEL_DELIVERIES_IN_FLIGHT,
  type ChannelDeliveryRequest,
} from './channel-delivery-ipc.js';

const TEST_HEARTBEAT_TIMEOUT_MS = CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS + 5;

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
  send = vi.fn(
    (_message: unknown, _callback?: (err: Error | null) => void) => true,
  );
}

const webhookTask: ChannelWebhookTask = {
  channelName: 'telegram',
  source: 'github-ci',
  eventType: 'check_failed',
  targetRef: 'default',
  title: 'CI failed',
  payload: { runId: 123 },
};

const deliveryRequest: ChannelDeliveryRequest = {
  deliveryId: 'delivery-1',
  channelName: 'telegram',
  target: { type: 'chat', id: 'group-1' },
  text: 'inspection result',
};

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
      workerBaseEnv: { ...process.env, CUSTOM: 'value' },
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
    expect(env).toHaveProperty('CUSTOM', 'value');
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

  it('stores and acknowledges startup failures before exposing a deep-copied running snapshot', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram', 'feishu'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram',
        phase: 'connect',
        code: 'ECONNREFUSED',
        message: 'connection refused',
      },
    });
    expect(child.send).toHaveBeenCalledWith(
      { type: 'channel_startup_report_ack' },
      expect.any(Function),
    );
    child.emit('message', {
      type: 'ready',
      channels: ['feishu'],
      requestedChannels: ['telegram', 'feishu'],
    });
    await started;

    const first = supervisor.snapshot();
    expect(first.startupFailures).toEqual([
      {
        channel: 'telegram',
        phase: 'connect',
        code: 'ECONNREFUSED',
        message: 'connection refused',
      },
    ]);
    first.startupFailures![0]!.message = 'mutated';
    expect(supervisor.snapshot().startupFailures![0]!.message).toBe(
      'connection refused',
    );
  });

  it('retains accepted and redacted startup failures when the worker exits before ready', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      daemonToken: 'daemon-secret',
      workspace: '/trusted/workspace',
      workerBaseEnv: { PROVIDER_API_KEY: '\tprovider-secret' },
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram-provider-secret',
        phase: 'connect',
        code: 'daemon-secret',
        message:
          'prefix \tprovider-secret Authorization: Bearer abcdef123456 failed',
      },
    });
    child.emit('exit', 1, null);

    const error = await started.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ChannelWorkerStartupError);
    expect(error).toMatchObject({
      startupFailures: [
        {
          workspaceCwd: '/trusted/workspace',
          channel: 'telegram-<redacted>',
          phase: 'connect',
          code: '<redacted>',
        },
      ],
    });
    expect(
      (error as ChannelWorkerStartupError).startupFailures[0]!.message,
    ).not.toContain('provider-secret');
    expect(
      (error as ChannelWorkerStartupError).startupFailures[0]!.message,
    ).not.toContain('abcdef123456');
    expect(supervisor.snapshot().startupFailures).toEqual(
      (error as ChannelWorkerStartupError).startupFailures.map(
        ({ workspaceCwd: _workspaceCwd, ...failure }) => failure,
      ),
    );
  });

  it('retains accepted startup failures across startup timeout', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram', 'feishu'] },
      startupTimeoutMs: 1,
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram',
        phase: 'connect',
        message: 'failed before feishu hung',
      },
    });

    const error = await started.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ChannelWorkerStartupError);
    expect(error).toMatchObject({
      startupFailures: [
        expect.objectContaining({ message: 'failed before feishu hung' }),
      ],
    });
    expect(supervisor.snapshot()).toMatchObject({
      state: 'failed',
      startupFailures: [
        expect.objectContaining({ message: 'failed before feishu hung' }),
      ],
    });
  });

  it('terminates startup on malformed reports and acknowledgement failures', async () => {
    const malformedChild = new FakeChild();
    const malformedSupervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => malformedChild),
    });
    const malformedStart = malformedSupervisor.start();
    malformedChild.emit('message', {
      type: 'channel_startup_failure',
      failure: { channel: '', phase: 'connect', message: 'invalid' },
    });
    await expect(malformedStart).rejects.toThrow(
      'Channel worker startup IPC protocol error: invalid startup report.',
    );
    expect(malformedChild.kill).toHaveBeenCalledWith('SIGTERM');

    const ackChild = new FakeChild();
    ackChild.send.mockImplementation((_message, callback) => {
      callback?.(new Error('ipc closed'));
      return true;
    });
    const ackSupervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => ackChild),
    });
    const ackStart = ackSupervisor.start();
    ackChild.emit('message', {
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram',
        phase: 'connect',
        message: 'failed',
      },
    });
    const ackError = await ackStart.catch((value: unknown) => value);
    expect(ackError).toBeInstanceOf(ChannelWorkerStartupError);
    expect((ackError as Error).message).toContain('acknowledgement failed');
    expect(
      (ackError as ChannelWorkerStartupError).startupFailures,
    ).toHaveLength(1);

    const markerChild = new FakeChild();
    const markerSupervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => markerChild),
    });
    const markerStart = markerSupervisor.start();
    markerChild.emit('message', {
      type: 'channel_startup_failures_truncated',
    });
    await expect(markerStart).rejects.toThrow('invalid truncation marker');
  });

  it('retains an accepted failure when the child emits a pre-ready error', async () => {
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
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram',
        phase: 'connect',
        message: 'provider failed',
      },
    });
    child.emit('error', new Error('child IPC failed'));

    const error = await started.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ChannelWorkerStartupError);
    expect(error).toMatchObject({
      startupFailures: [
        expect.objectContaining({ message: 'provider failed' }),
      ],
    });
  });

  it('accepts exactly 64 failures followed by one truncation marker', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    for (let index = 0; index < MAX_CHANNEL_STARTUP_FAILURES; index += 1) {
      child.emit('message', {
        type: 'channel_startup_failure',
        failure: {
          channel: `channel-${index}`,
          phase: 'connect',
          message: `failure-${index}`,
        },
      });
    }
    child.emit('message', { type: 'channel_startup_failures_truncated' });
    child.emit('message', {
      type: 'ready',
      channels: ['connected'],
    });
    await started;

    expect(supervisor.snapshot()).toMatchObject({
      state: 'running',
      startupFailuresTruncated: true,
    });
    expect(supervisor.snapshot().startupFailures).toHaveLength(
      MAX_CHANNEL_STARTUP_FAILURES,
    );
    expect(child.send).toHaveBeenCalledTimes(MAX_CHANNEL_STARTUP_FAILURES + 1);
  });

  it('rejects a 65th startup failure without a truncation marker', async () => {
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'all' },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    for (let index = 0; index < MAX_CHANNEL_STARTUP_FAILURES; index += 1) {
      child.emit('message', {
        type: 'channel_startup_failure',
        failure: {
          channel: `channel-${index}`,
          phase: 'connect',
          message: `failure-${index}`,
        },
      });
    }
    child.emit('message', {
      type: 'channel_startup_failure',
      failure: {
        channel: 'channel-overflow',
        phase: 'connect',
        message: 'overflow',
      },
    });

    const error = await started.catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ChannelWorkerStartupError);
    expect((error as Error).message).toContain('too many startup failures.');
    expect((error as ChannelWorkerStartupError).startupFailures).toHaveLength(
      MAX_CHANNEL_STARTUP_FAILURES,
    );
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.send).toHaveBeenCalledTimes(MAX_CHANNEL_STARTUP_FAILURES);
  });

  it('clears startup failure details when a new generation starts', async () => {
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
      selection: { mode: 'names', names: ['telegram', 'feishu'] },
      spawnWorker,
    });

    const firstStart = supervisor.start();
    firstChild.emit('message', {
      type: 'channel_startup_failure',
      failure: {
        channel: 'telegram',
        phase: 'connect',
        message: 'first generation failure',
      },
    });
    firstChild.emit('message', { type: 'ready', channels: ['feishu'] });
    await firstStart;
    await supervisor.stop();

    const secondStart = supervisor.start();
    secondChild.emit('message', {
      type: 'ready',
      channels: ['telegram', 'feishu'],
    });
    await secondStart;

    expect(supervisor.snapshot()).not.toHaveProperty('startupFailures');
    expect(supervisor.snapshot()).not.toHaveProperty(
      'startupFailuresTruncated',
    );
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

  it('rejects heartbeat timeouts that cannot exceed the worker heartbeat interval', () => {
    expect(() =>
      createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        heartbeatTimeoutMs: CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS,
      }),
    ).toThrow(
      `heartbeatTimeoutMs (${CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS}) must exceed the worker heartbeat interval (${CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS}ms) or be 0 to disable.`,
    );
  });

  it('rejects restart policies without a restart delay', () => {
    expect(() =>
      createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [] },
      }),
    ).toThrow('restartPolicy.delaysMs must be non-empty.');
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
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'telegram-secret');
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      daemonToken: 'secret-token',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    const unsafeMessage =
      `spawn error secret-token https://proxy-user:telegram-secret@proxy.example:8080\n` +
      `fake log line\r${'\u001b'}[31m${'x'.repeat(600)}`;
    child.emit('error', new Error(unsafeMessage));
    child.emit('exit', 1, null);

    await expect(started).rejects.toThrow('spawn error');
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
    expect(snapshot.error).not.toContain('secret-token');
    expect(snapshot.error).not.toContain('telegram-secret');
    expect(snapshot.error).not.toContain('proxy-user');
    expect(snapshot.error).toContain('https://<redacted>@proxy.example:8080');
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

  it('waits for the worker webhook drain window before force killing on stop', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
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
      requestedChannels: ['telegram'],
    });
    await started;

    const stopped = supervisor.stop();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    await vi.advanceTimersByTimeAsync(9_999);
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    child.emit('exit', null, 'SIGKILL');
    await stopped;
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

  it('uses escalating restart delays from the restart policy', async () => {
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
      restartPolicy: {
        maxRestarts: 3,
        windowMs: 300_000,
        delaysMs: [10, 50, 100],
      },
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

    await vi.advanceTimersByTimeAsync(9);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnWorker).toHaveBeenCalledTimes(2);
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();
    secondChild.emit('exit', 1, null);

    await vi.advanceTimersByTimeAsync(49);
    expect(spawnWorker).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(spawnWorker).toHaveBeenCalledTimes(3);
    thirdChild.emit('message', {
      type: 'ready',
      pid: 33333,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 33333,
      restartCount: 2,
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
      error: expect.stringContaining(
        'Channel worker restart budget exhausted. Last error: Channel worker exited before ready',
      ),
    });
  });

  it('resets restart budget after an intentional stop and start', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild();
    const thirdChild = new FakeChild(false);
    const fourthChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild)
      .mockReturnValueOnce(thirdChild)
      .mockReturnValueOnce(fourthChild);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      restartPolicy: { maxRestarts: 1, windowMs: 300_000, delaysMs: [10] },
    });

    const firstStart = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await firstStart;
    firstChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(10);
    secondChild.emit('message', {
      type: 'ready',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    await supervisor.stop();

    const secondStart = supervisor.start();
    thirdChild.emit('message', {
      type: 'ready',
      pid: 33333,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await secondStart;
    thirdChild.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(10);
    fourthChild.emit('message', {
      type: 'ready',
      pid: 44444,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await Promise.resolve();

    expect(spawnWorker).toHaveBeenCalledTimes(4);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 44444,
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

  it('does not restart when a pre-ready worker never exits after SIGKILL', async () => {
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
    secondChild.emit('error', new Error('ipc setup failed'));
    await Promise.resolve();

    expect(secondChild.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(secondChild.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onExit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'failed',
        error: 'ipc setup failed',
      }),
    );

    await vi.advanceTimersByTimeAsync(10);
    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'ipc setup failed',
    });
    await expect(supervisor.start()).rejects.toThrow(
      'Channel worker stop is not yet confirmed.',
    );
    expect(spawnWorker).toHaveBeenCalledTimes(2);
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

  it('keeps the last restart failure in the budget exhausted error', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const spawnWorker = vi.fn().mockReturnValueOnce(firstChild);
    spawnWorker.mockImplementationOnce(() => {
      throw new Error('fork failed');
    });
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      onExit,
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

    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(onExit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        state: 'failed',
        error:
          'Channel worker restart budget exhausted. Last error: fork failed',
        restartCount: 1,
      }),
    );
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'Channel worker restart budget exhausted. Last error: fork failed',
      restartCount: 1,
    });
  });

  it('does not clobber restart spawn failure state on force shutdown', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const spawnWorker = vi.fn().mockReturnValueOnce(firstChild);
    spawnWorker.mockImplementationOnce(() => {
      throw new Error('fork failed');
    });
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
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

    supervisor.killAllSync();

    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'fork failed',
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
    expect(supervisor.snapshot()).not.toHaveProperty('nextRestartAt');
  });

  it('clears a pending restart timestamp when force shutdown cancels the timer', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const spawnWorker = vi.fn().mockReturnValueOnce(firstChild);
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

    expect(supervisor.snapshot()).toHaveProperty('nextRestartAt');
    supervisor.killAllSync();

    expect(supervisor.snapshot()).not.toHaveProperty('nextRestartAt');
  });

  it('restarts when no heartbeat arrives after ready', async () => {
    vi.useFakeTimers();
    const firstChild = new FakeChild(false);
    const secondChild = new FakeChild();
    const spawnWorker = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const onExit = vi.fn();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker,
      onExit,
      restartPolicy: { maxRestarts: 3, windowMs: 300_000, delaysMs: [10] },
      heartbeatTimeoutMs: TEST_HEARTBEAT_TIMEOUT_MS,
    });

    const started = supervisor.start();
    firstChild.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    await vi.advanceTimersByTimeAsync(TEST_HEARTBEAT_TIMEOUT_MS);
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
    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'exited',
        staleHeartbeatAt: expect.any(String),
      }),
    );
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 22222,
      restartCount: 1,
    });
    expect(supervisor.snapshot()).not.toHaveProperty('error');
    expect(supervisor.snapshot()).not.toHaveProperty('nextRestartAt');
    expect(supervisor.snapshot()).not.toHaveProperty('staleHeartbeatAt');
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
      heartbeatTimeoutMs: TEST_HEARTBEAT_TIMEOUT_MS,
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

    await vi.advanceTimersByTimeAsync(TEST_HEARTBEAT_TIMEOUT_MS);
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
    });
    expect(supervisor.snapshot()).not.toHaveProperty('lastHeartbeatAt');
  });

  it('ignores heartbeats from a mismatched pid without rearming stale detection', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      heartbeatTimeoutMs: TEST_HEARTBEAT_TIMEOUT_MS,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;
    await vi.advanceTimersByTimeAsync(TEST_HEARTBEAT_TIMEOUT_MS - 1);

    child.emit('message', {
      type: 'heartbeat',
      pid: 22222,
      at: '2026-07-01T00:00:00.000Z',
    });

    expect(supervisor.snapshot()).not.toHaveProperty('lastHeartbeatAt');
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('keeps the worker running and heartbeat-armed when onReady throws', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
      onReady: () => {
        throw new Error('pidfile write failed');
      },
      heartbeatTimeoutMs: TEST_HEARTBEAT_TIMEOUT_MS,
    });

    const started = supervisor.start();
    child.emit('message', {
      type: 'ready',
      pid: 11111,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 11111,
    });
    await vi.advanceTimersByTimeAsync(TEST_HEARTBEAT_TIMEOUT_MS);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
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
      heartbeatTimeoutMs: TEST_HEARTBEAT_TIMEOUT_MS,
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
    await vi.advanceTimersByTimeAsync(TEST_HEARTBEAT_TIMEOUT_MS);

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
    vi.stubEnv('AUTH_ENABLED', 'true');
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland');
    vi.stubEnv('HTTPS_PROXY', 'http://proxy-user:p@ssword@proxy.example:8080');
    const esc = String.fromCharCode(0x1b);
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
    child.stderr.emit('data', Buffer.from('split secret-to\u200bken\n'));
    child.stderr.emit('data', Buffer.from(`ansi secret-${esc}[31mtoken\n`));
    child.stdout.emit('data', Buffer.from('adapter token telegram-secret'));
    child.stdout.emit('data', Buffer.from('\nredis redis-secret\n'));
    child.stdout.emit('data', Buffer.from('auth basic-auth-secret\n'));
    child.stdout.emit(
      'data',
      Buffer.from('benign true wayland authenticated user\n'),
    );
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
      stream: 'stderr',
      line: 'split <redacted>',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stderr',
      line: 'ansi <redacted>',
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
      stream: 'stdout',
      line: 'benign true wayland authenticated user',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stderr',
      line: 'proxy http://<redacted>@proxy.example:8080/path',
    });
    expect(
      onLog.mock.calls.flatMap((call) => call[0].line).join('\n'),
    ).not.toContain('ssword');
  });

  it('decodes Uint8Array worker log chunks and preserves separation', async () => {
    const child = new FakeChild();
    child.stdout = new EventEmitter();
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
    child.stdout.emit(
      'data',
      new Uint8Array(Buffer.from('\tat stack frame\nmetric\tvalue\t42\n')),
    );
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    expect(onLog).toHaveBeenCalledWith({
      stream: 'stdout',
      line: ' at stack frame',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stdout',
      line: 'metric value 42',
    });
  });

  it('forwards CRLF-delimited worker log lines without trailing carriage returns', async () => {
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
    child.stderr.emit('data', Buffer.from('line one\r\nline two\r\n'));
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    expect(onLog).toHaveBeenNthCalledWith(1, {
      stream: 'stderr',
      line: 'line one',
    });
    expect(onLog).toHaveBeenNthCalledWith(2, {
      stream: 'stderr',
      line: 'line two',
    });
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
    child.stderr.emit('data', Buffer.from('still oversized tail'));
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
    expect(onLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ line: 'discarded oversized tail' }),
    );
    expect(onLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ line: 'still oversized tail' }),
    );
    expect(onLog).toHaveBeenCalledTimes(2);
    expect(onLog).toHaveBeenLastCalledWith({
      stream: 'stderr',
      line: 'next line',
    });
  });

  it('resumes worker log forwarding after bounded oversized tail discard', async () => {
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
    child.stderr.emit('data', Buffer.from('discarded tail'.repeat(6000)));
    child.stderr.emit('data', Buffer.from('resumed line\n'));
    child.emit('message', {
      type: 'ready',
      pid: 12345,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
    await started;

    expect(onLog).toHaveBeenCalledTimes(2);
    expect(onLog).toHaveBeenLastCalledWith({
      stream: 'stderr',
      line: 'resumed line',
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
    const startedAt = Date.now();
    child.stderr.emit('data', Buffer.from('a.'.repeat(33_000)));
    expect(Date.now() - startedAt).toBeLessThan(1_000);
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

  it('terminates and notifies once when a ready worker emits error', async () => {
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

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'exited',
        exitCode: null,
        signal: 'SIGTERM',
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
    vi.useFakeTimers();
    const child = new FakeChild(false);
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

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      channels: ['telegram'],
      error: 'ipc failed',
    });

    const stopped = supervisor.stop();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('exit', null, 'SIGKILL');
    await stopped;

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
      signal: 'SIGKILL',
    });
  });

  it('force-kills a ready worker after a post-ready error without marking it failed', async () => {
    const child = new FakeChild(false);
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

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'stopped',
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

  it('does not clobber failed startup state before exit on force shutdown', async () => {
    const child = new FakeChild(false);
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => child),
    });

    const started = supervisor.start();
    child.emit('error', new Error('ipc setup failed'));
    await expect(started).rejects.toThrow('ipc setup failed');

    supervisor.killAllSync();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'ipc setup failed',
    });
  });

  it('escalates pre-ready termination to SIGKILL when the worker ignores SIGTERM', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
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
    child.emit('error', new Error('ipc setup failed'));
    await expect(started).rejects.toThrow('ipc setup failed');

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'ipc setup failed',
    });
    expect(onLog).toHaveBeenCalledWith({
      stream: 'stderr',
      line: 'Channel worker did not exit after SIGKILL; automatic restart is disabled.',
    });
  });

  it('does not release or restart a worker whose SIGKILL exit is unconfirmed', async () => {
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
    void stopped.catch(() => {});
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(stopped).rejects.toThrow(
      'Channel worker did not exit after SIGKILL.',
    );

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'failed',
      error: 'Channel worker did not exit after SIGKILL.',
    });
    expect(supervisor.snapshot()).not.toHaveProperty('signal');

    await expect(supervisor.start()).rejects.toThrow(
      'Channel worker stop is not yet confirmed.',
    );
    expect(spawnWorker).toHaveBeenCalledTimes(1);

    const retriedStop = supervisor.stop();
    void retriedStop.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(retriedStop).rejects.toThrow(
      'Channel worker did not exit after SIGKILL.',
    );
    await expect(supervisor.start()).rejects.toThrow(
      'Channel worker stop is not yet confirmed.',
    );
    expect(spawnWorker).toHaveBeenCalledTimes(1);

    child.emit('exit', 0, null);

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

    expect(supervisor.snapshot()).toMatchObject({
      enabled: true,
      state: 'running',
      pid: 22222,
      channels: ['telegram'],
      requestedChannels: ['telegram'],
    });
  });

  it('delivers a channel message through a running worker', async () => {
    const child = new FakeChild(false);
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
      requestedChannels: ['telegram'],
    });
    await started;

    const delivered = supervisor.deliverChannelMessage!(deliveryRequest);
    const sent = child.send.mock.calls[0]![0] as { id: string };
    expect(sent).toMatchObject({
      type: 'channel_delivery',
      id: expect.any(String),
      expiresAt: expect.any(Number),
      request: deliveryRequest,
    });
    child.emit('message', {
      type: 'channel_delivery_result',
      id: sent.id,
      ok: true,
    });

    await expect(delivered).resolves.toEqual({ delivered: true });
  });

  it('rejects channel delivery when the supervisor is full', async () => {
    const child = new FakeChild(false);
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
      requestedChannels: ['telegram'],
    });
    await started;

    const pending = Array.from(
      { length: MAX_CHANNEL_DELIVERIES_IN_FLIGHT },
      () => supervisor.deliverChannelMessage!(deliveryRequest),
    );
    const overflow = supervisor.deliverChannelMessage!(deliveryRequest).catch(
      (error: unknown) => error,
    );

    expect(child.send).toHaveBeenCalledTimes(MAX_CHANNEL_DELIVERIES_IN_FLIGHT);
    await expect(overflow).resolves.toMatchObject({
      code: 'channel_delivery_queue_full',
      message: 'Channel delivery queue is full.',
    });

    const first = child.send.mock.calls[0]![0] as { id: string };
    child.emit('message', {
      type: 'channel_delivery_result',
      id: first.id,
      ok: true,
    });
    await expect(pending[0]).resolves.toEqual({ delivered: true });

    const replacement = supervisor.deliverChannelMessage!(deliveryRequest);
    expect(child.send).toHaveBeenCalledTimes(
      MAX_CHANNEL_DELIVERIES_IN_FLIGHT + 1,
    );
    child.emit('exit', 1, null);
    await Promise.allSettled([...pending.slice(1), replacement]);
  });

  it('rejects channel delivery when the worker is not running', async () => {
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => new FakeChild()),
    });

    await expect(
      supervisor.deliverChannelMessage!(deliveryRequest),
    ).rejects.toMatchObject({
      code: 'channel_worker_unavailable',
      message: 'Channel worker is not running.',
    });
  });

  it('rejects typed delivery errors reported by the worker', async () => {
    const child = new FakeChild(false);
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

    const delivered = supervisor.deliverChannelMessage!(deliveryRequest);
    const sent = child.send.mock.calls[0]![0] as { id: string };
    child.emit('message', {
      type: 'channel_delivery_result',
      id: sent.id,
      ok: false,
      code: 'channel_delivery_failed',
      error: 'Platform send failed.',
    });

    await expect(delivered).rejects.toMatchObject({
      code: 'channel_delivery_failed',
      message: 'Platform send failed.',
    });
  });

  it('rejects channel delivery when IPC send throws synchronously', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    child.send.mockImplementationOnce(() => {
      throw new Error('send boom');
    });
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
      requestedChannels: ['telegram'],
    });
    await started;

    const rejected = supervisor.deliverChannelMessage!(deliveryRequest).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await rejected;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Channel worker IPC send failed: send boom',
    );
    expect((error as { code?: string }).code).toBe(
      'channel_worker_unavailable',
    );
  });

  it('rejects channel delivery when the IPC send callback reports an error', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    child.send.mockImplementationOnce((_message, callback) => {
      callback?.(new Error('callback boom'));
      return true;
    });
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
      requestedChannels: ['telegram'],
    });
    await started;

    const rejected = supervisor.deliverChannelMessage!(deliveryRequest).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await rejected;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Channel worker IPC send failed: callback boom',
    );
    expect((error as { code?: string }).code).toBe(
      'channel_worker_unavailable',
    );
  });

  it('times out delivery and rejects pending work when the worker exits', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
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

    const timedOut = supervisor.deliverChannelMessage!(deliveryRequest).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(CHANNEL_DELIVERY_IPC_TIMEOUT_MS);
    await expect(timedOut).resolves.toMatchObject({
      code: 'channel_delivery_timeout',
    });

    const pending = supervisor.deliverChannelMessage!(deliveryRequest);
    child.emit('exit', 1, null);
    await expect(pending).rejects.toMatchObject({
      code: 'channel_worker_unavailable',
      message: 'Channel worker exited.',
    });
  });

  it('sends a webhook task to a running worker over IPC', async () => {
    const child = new FakeChild(false);
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
      requestedChannels: ['telegram'],
    });
    await started;

    const accepted = supervisor.enqueueWebhookTask(webhookTask);
    const sent = child.send.mock.calls[0]![0] as { id: string };
    expect(sent).toMatchObject({
      type: 'webhook_task',
      id: expect.any(String),
      expiresAt: expect.any(Number),
      task: webhookTask,
    });

    child.emit('message', {
      type: 'webhook_task_result',
      id: sent.id,
      ok: true,
    });

    await expect(accepted).resolves.toEqual({ accepted: true });
  });

  it('rejects webhook tasks when the worker is not running', async () => {
    const supervisor = createChannelWorkerSupervisor({
      cliEntryPath: '/repo/dist/index.js',
      daemonUrl: 'http://127.0.0.1:4170',
      workspace: '/workspace',
      selection: { mode: 'names', names: ['telegram'] },
      spawnWorker: vi.fn(() => new FakeChild()),
    });

    await expect(supervisor.enqueueWebhookTask(webhookTask)).rejects.toThrow(
      'Channel worker is not running.',
    );
  });

  it('rejects webhook tasks when the worker reports an IPC error', async () => {
    const child = new FakeChild(false);
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
      requestedChannels: ['telegram'],
    });
    await started;

    const accepted = supervisor.enqueueWebhookTask(webhookTask);
    const sent = child.send.mock.calls[0]![0] as { id: string };
    child.emit('message', {
      type: 'webhook_task_result',
      id: sent.id,
      ok: false,
      error: 'boom',
    });

    await expect(accepted).rejects.toThrow('boom');
  });

  it('keeps webhook tasks pending when IPC send reports backpressure', async () => {
    const child = new FakeChild(false);
    child.send.mockReturnValueOnce(false);
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
      requestedChannels: ['telegram'],
    });
    await started;

    const accepted = supervisor.enqueueWebhookTask(webhookTask);
    const sent = child.send.mock.calls[0]![0] as { id: string };
    child.emit('message', {
      type: 'webhook_task_result',
      id: sent.id,
      ok: true,
    });

    await expect(accepted).resolves.toEqual({ accepted: true });
  });

  it('rejects webhook tasks when IPC send throws synchronously', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    child.send.mockImplementationOnce(() => {
      throw new Error('send boom');
    });
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
      requestedChannels: ['telegram'],
    });
    await started;

    const rejected = supervisor.enqueueWebhookTask(webhookTask).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await rejected;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Channel worker IPC send failed: send boom',
    );
    expect((error as { code?: string }).code).toBe(
      'channel_worker_unavailable',
    );
  });

  it('rejects webhook tasks when the IPC send callback reports an error', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
    child.send.mockImplementationOnce((_message, callback) => {
      callback?.(new Error('callback boom'));
      return true;
    });
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
      requestedChannels: ['telegram'],
    });
    await started;

    const rejected = supervisor.enqueueWebhookTask(webhookTask).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await rejected;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Channel worker IPC send failed: callback boom',
    );
    expect((error as { code?: string }).code).toBe(
      'channel_worker_unavailable',
    );
  });

  it('rejects webhook tasks when IPC result times out', async () => {
    vi.useFakeTimers();
    const child = new FakeChild(false);
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
      requestedChannels: ['telegram'],
    });
    await started;

    const accepted = supervisor.enqueueWebhookTask(webhookTask).then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await accepted;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Channel webhook task IPC timed out.',
    );
  });

  it('rejects pending webhook tasks when the worker exits', async () => {
    const child = new FakeChild(false);
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
      requestedChannels: ['telegram'],
    });
    await started;

    const accepted = supervisor.enqueueWebhookTask(webhookTask);
    child.emit('exit', 1, null);

    await expect(accepted).rejects.toThrow('Channel worker exited.');
  });

  it('rejects pending webhook tasks when the supervisor stops', async () => {
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
      requestedChannels: ['telegram'],
    });
    await started;

    const accepted = supervisor.enqueueWebhookTask(webhookTask);
    await supervisor.stop();

    await expect(accepted).rejects.toThrow('Channel worker stopped.');
  });

  describe('restart()', () => {
    const waitForCalls = async (getCount: () => number, count: number) => {
      for (let i = 0; i < 100 && getCount() < count; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    it('stops the running worker and relaunches it so settings are re-read', async () => {
      const child1 = new FakeChild();
      const child2 = new FakeChild();
      const queue = [child1, child2];
      const spawnWorker = vi.fn(() => queue.shift()!);
      const supervisor = createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        spawnWorker,
      });

      const started = supervisor.start();
      child1.emit('message', {
        type: 'ready',
        pid: 111,
        channels: ['telegram'],
      });
      await started;
      expect(supervisor.snapshot()).toMatchObject({
        state: 'running',
        pid: 111,
      });

      const restarted = supervisor.restart();
      await waitForCalls(() => spawnWorker.mock.calls.length, 2);
      child2.emit('message', {
        type: 'ready',
        pid: 222,
        channels: ['telegram'],
      });
      const snapshot = await restarted;

      expect(child1.kill).toHaveBeenCalled();
      expect(spawnWorker).toHaveBeenCalledTimes(2);
      expect(snapshot).toMatchObject({ state: 'running', pid: 222 });
      expect(supervisor.snapshot()).toMatchObject({
        state: 'running',
        pid: 222,
      });
    });

    it('coalesces concurrent restarts onto a single relaunch', async () => {
      const child1 = new FakeChild();
      const child2 = new FakeChild();
      const queue = [child1, child2];
      const spawnWorker = vi.fn(() => queue.shift()!);
      const supervisor = createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        spawnWorker,
      });

      const started = supervisor.start();
      child1.emit('message', {
        type: 'ready',
        pid: 111,
        channels: ['telegram'],
      });
      await started;

      const first = supervisor.restart();
      const second = supervisor.restart();
      await waitForCalls(() => spawnWorker.mock.calls.length, 2);
      child2.emit('message', {
        type: 'ready',
        pid: 222,
        channels: ['telegram'],
      });
      const [a, b] = await Promise.all([first, second]);

      // Initial start + exactly one relaunch: concurrent restarts share the
      // same in-flight promise and never fork a second worker.
      expect(spawnWorker).toHaveBeenCalledTimes(2);
      expect(a).toMatchObject({ state: 'running', pid: 222 });
      expect(b).toMatchObject({ state: 'running', pid: 222 });
    });

    it('rejects on relaunch failure, then recovers on a later restart', async () => {
      const child1 = new FakeChild();
      const child2 = new FakeChild();
      let call = 0;
      const spawnWorker = vi.fn(() => {
        call += 1;
        if (call === 2) {
          throw new Error('fork failed');
        }
        return call === 1 ? child1 : child2;
      });
      const supervisor = createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        spawnWorker,
      });

      const started = supervisor.start();
      child1.emit('message', {
        type: 'ready',
        pid: 111,
        channels: ['telegram'],
      });
      await started;

      // Second spawn throws — the relaunch fails and the worker parks in
      // `failed` (channels down), and restart() surfaces the error.
      await expect(supervisor.restart()).rejects.toThrow(/fork failed/);
      expect(supervisor.snapshot()).toMatchObject({ state: 'failed' });

      // A later restart resets the budget and recovers once spawning works.
      const recovered = supervisor.restart();
      await waitForCalls(() => spawnWorker.mock.calls.length, 3);
      child2.emit('message', {
        type: 'ready',
        pid: 333,
        channels: ['telegram'],
      });
      expect(await recovered).toMatchObject({ state: 'running', pid: 333 });
    });

    it('does not relaunch after killAllSync latches disposed', async () => {
      const child1 = new FakeChild();
      const spawnWorker = vi.fn(() => child1);
      const supervisor = createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        spawnWorker,
      });

      const started = supervisor.start();
      child1.emit('message', {
        type: 'ready',
        pid: 111,
        channels: ['telegram'],
      });
      await started;

      supervisor.killAllSync();
      expect(spawnWorker).toHaveBeenCalledTimes(1);

      // A reload after a hard shutdown must be a no-op, not a relaunch.
      const snapshot = await supervisor.restart();
      expect(spawnWorker).toHaveBeenCalledTimes(1);
      expect(snapshot.state).toBe('stopped');
    });

    it('does not fork a new worker when killAllSync races an in-flight restart', async () => {
      const child1 = new FakeChild();
      const child2 = new FakeChild();
      const queue = [child1, child2];
      const spawnWorker = vi.fn(() => queue.shift()!);
      const supervisor = createChannelWorkerSupervisor({
        cliEntryPath: '/repo/dist/index.js',
        daemonUrl: 'http://127.0.0.1:4170',
        workspace: '/workspace',
        selection: { mode: 'names', names: ['telegram'] },
        spawnWorker,
      });

      const started = supervisor.start();
      child1.emit('message', {
        type: 'ready',
        pid: 111,
        channels: ['telegram'],
      });
      await started;

      // Begin a reload, then simulate a hard daemon shutdown before the
      // relaunch's start() runs. The disposed latch must prevent a new fork
      // (which would otherwise orphan a worker spawned during shutdown).
      const restarted = supervisor.restart();
      supervisor.killAllSync();
      await restarted;

      expect(spawnWorker).toHaveBeenCalledTimes(1);
    });
  });
});
