import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { channelSelectionNames } from './channel-selection.js';
import type { ServeChannelSelection } from './types.js';
import {
  CHANNEL_DAEMON_WORKER_SENTINEL,
  QWEN_DAEMON_TOKEN_ENV,
  QWEN_DAEMON_URL_ENV,
  QWEN_DAEMON_WORKSPACE_ENV,
  QWEN_SERVER_TOKEN_ENV,
} from './channel-worker-env.js';
import { sanitizeLogText } from '@qwen-code/channel-base';

const DEFAULT_CHANNEL_WORKER_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_CHANNEL_WORKER_HEARTBEAT_TIMEOUT_MS = 45_000;
const MAX_WORKER_LOG_LINE_LENGTH = 4096;
const MAX_WORKER_LOG_BUFFER_LENGTH = 64 * 1024;

export interface ChannelWorkerRestartPolicy {
  maxRestarts: number;
  windowMs: number;
  delaysMs: number[];
}

const DEFAULT_RESTART_POLICY: ChannelWorkerRestartPolicy = {
  maxRestarts: 3,
  windowMs: 5 * 60_000,
  delaysMs: [1_000, 5_000, 15_000],
};

export type ChannelWorkerState =
  | 'disabled'
  | 'starting'
  | 'running'
  | 'exited'
  | 'failed'
  | 'stopped';

export interface ChannelWorkerSnapshot {
  enabled: boolean;
  state: ChannelWorkerState;
  channels: string[];
  requestedChannels?: string[];
  pid?: number;
  startedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  restartCount?: number;
  lastExitAt?: string;
  lastRestartAt?: string;
  nextRestartAt?: string;
  lastHeartbeatAt?: string;
  staleHeartbeatAt?: string;
}

export interface ChannelWorkerSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  killAllSync(): void;
  snapshot(): ChannelWorkerSnapshot;
}

export interface ChannelWorkerChild {
  pid?: number;
  killed?: boolean;
  stdout?: WorkerLogStream;
  stderr?: WorkerLogStream;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'message', listener: (message: unknown) => void): this;
  removeListener(event: 'message', listener: (message: unknown) => void): this;
  once(event: 'message', listener: (message: unknown) => void): this;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: 'error', listener: (err: Error) => void): this;
}

export type SpawnChannelWorker = (
  execPath: string,
  argv: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'];
  },
) => ChannelWorkerChild;

export interface ChannelWorkerLogEntry {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface WorkerLogStream {
  on(
    event: 'data',
    listener: (chunk: Buffer | string | Uint8Array) => void,
  ): unknown;
  on(event: 'end' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export interface CreateChannelWorkerSupervisorOptions {
  cliEntryPath: string;
  daemonUrl: string;
  daemonToken?: string;
  workspace: string;
  selection: ServeChannelSelection;
  startupTimeoutMs?: number;
  spawnWorker?: SpawnChannelWorker;
  onExit?: (snapshot: ChannelWorkerSnapshot) => void;
  onReady?: (snapshot: ChannelWorkerSnapshot) => void;
  onLog?: (entry: ChannelWorkerLogEntry) => void;
  restartPolicy?: ChannelWorkerRestartPolicy;
  heartbeatTimeoutMs?: number;
}

function selectionChannelArgs(selection: ServeChannelSelection): string[] {
  return channelSelectionNames(selection).flatMap((name) => [
    '--channel',
    name,
  ]);
}

function defaultSpawnWorker(
  execPath: string,
  argv: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'];
  },
): ChannelWorkerChild {
  const child = fork(argv[0]!, argv.slice(1), {
    execPath,
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio,
  });
  return child as ChildProcess & ChannelWorkerChild;
}

function isReadyMessage(message: unknown): message is {
  type: 'ready';
  pid?: number;
  channels?: string[];
  requestedChannels?: string[];
} {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'ready'
  );
}

function isHeartbeatMessage(message: unknown): message is {
  type: 'heartbeat';
  pid?: number;
  at?: string;
} {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'heartbeat'
  );
}

function requestedChannelNames(
  selection: ServeChannelSelection,
): string[] | undefined {
  return selection.mode === 'names' ? [...selection.names] : undefined;
}

function sanitizeWorkerError(error: string): string {
  return Array.from(sanitizeLogText(error, 512)).slice(0, 512).join('');
}

function notifyExit(
  onExit: ((snapshot: ChannelWorkerSnapshot) => void) | undefined,
  snapshot: ChannelWorkerSnapshot,
): void {
  try {
    onExit?.(snapshot);
  } catch {
    // onExit is bookkeeping; worker exit handling must not crash the daemon.
  }
}

function notifyReady(
  onReady: ((snapshot: ChannelWorkerSnapshot) => void) | undefined,
  snapshot: ChannelWorkerSnapshot,
): void {
  try {
    onReady?.(snapshot);
  } catch {
    // onReady is bookkeeping; worker readiness must not crash the daemon.
  }
}

function notifyLog(
  onLog: ((entry: ChannelWorkerLogEntry) => void) | undefined,
  entry: ChannelWorkerLogEntry,
): void {
  try {
    onLog?.(entry);
  } catch {
    // onLog is bookkeeping; worker log forwarding must not crash the daemon.
  }
}

function waitForExit(
  child: ChannelWorkerChild,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(exited);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref();
    child.once('exit', () => done(true));
  });
}

function hasObservedExit(snapshot: ChannelWorkerSnapshot): boolean {
  return snapshot.exitCode !== undefined || snapshot.signal !== undefined;
}

function createWorkerEnv(opts: {
  daemonUrl: string;
  daemonToken?: string;
  workspace: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env['QWEN_CODE_NO_RELAUNCH'] = 'true';
  env[CHANNEL_DAEMON_WORKER_SENTINEL] = randomUUID();
  env[QWEN_DAEMON_URL_ENV] = opts.daemonUrl;
  env[QWEN_DAEMON_WORKSPACE_ENV] = opts.workspace;
  delete env[QWEN_SERVER_TOKEN_ENV];
  delete env[QWEN_DAEMON_TOKEN_ENV];
  if (opts.daemonToken) {
    env[QWEN_DAEMON_TOKEN_ENV] = opts.daemonToken;
  }
  return env;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sensitiveEnvValues(env: NodeJS.ProcessEnv): string[] {
  const sensitiveKey =
    /TOKEN|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|PASSWORD|PASSWD|PASSPHRASE|AUTH|SESSION|DSN|CONNECTION_STRING/i;
  return Object.entries(env)
    .filter(([key, value]) => sensitiveKey.test(key) && value !== undefined)
    .map(([, value]) => value!)
    .filter((value) => value.length >= 4);
}

function redactWorkerLogLine(
  line: string,
  opts: { daemonToken?: string; workerEnv: NodeJS.ProcessEnv },
): string {
  let redacted = line.replace(
    /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/]*@)([^\s/]+)([^\s]*)/gi,
    '$1<redacted>@$3$4',
  );
  const secrets = new Set([
    ...(opts.daemonToken && opts.daemonToken.length >= 4
      ? [opts.daemonToken]
      : []),
    ...sensitiveEnvValues(opts.workerEnv),
  ]);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    redacted = redacted.replace(
      new RegExp(escapeRegExp(secret), 'g'),
      '<redacted>',
    );
  }
  return redacted;
}

function normalizeWorkerLogLineForRedaction(line: string): string {
  return line.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g,
    '',
  );
}

function attachWorkerLogStream(
  stream: WorkerLogStream | undefined,
  streamName: ChannelWorkerLogEntry['stream'],
  opts: {
    daemonToken?: string;
    workerEnv: NodeJS.ProcessEnv;
    onLog?: (entry: ChannelWorkerLogEntry) => void;
  },
): () => void {
  if (!stream) return () => {};
  let buffer = '';
  let discardingOversizedLineRemainder = false;
  const flushLine = (line: string) => {
    const redacted = redactWorkerLogLine(
      normalizeWorkerLogLineForRedaction(line),
      {
        ...(opts.daemonToken ? { daemonToken: opts.daemonToken } : {}),
        workerEnv: opts.workerEnv,
      },
    );
    notifyLog(opts.onLog, {
      stream: streamName,
      line: sanitizeLogText(redacted, MAX_WORKER_LOG_LINE_LENGTH),
    });
  };
  const flushPartial = () => {
    if (buffer.length === 0) return;
    flushLine(buffer);
    buffer = '';
  };
  const flushOversizedBuffer = () => {
    if (buffer.length <= MAX_WORKER_LOG_BUFFER_LENGTH) return;
    // Keep one truncated entry for the huge logical line, then drop its tail
    // until the next newline so a single worker write cannot flood daemon logs.
    flushLine(buffer);
    buffer = '';
    discardingOversizedLineRemainder = true;
  };
  stream.on('data', (chunk) => {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    for (;;) {
      const newlineIndex = buffer.search(/\r?\n/);
      if (newlineIndex < 0) break;
      const line = buffer.slice(0, newlineIndex);
      const newlineLength =
        buffer[newlineIndex] === '\r' && buffer[newlineIndex + 1] === '\n'
          ? 2
          : 1;
      buffer = buffer.slice(newlineIndex + newlineLength);
      if (!discardingOversizedLineRemainder) {
        flushLine(line);
      }
      discardingOversizedLineRemainder = false;
    }
    if (discardingOversizedLineRemainder) {
      buffer = '';
      discardingOversizedLineRemainder = false;
      return;
    }
    flushOversizedBuffer();
  });
  stream.on('end', flushPartial);
  stream.on('close', flushPartial);
  stream.on('error', () => {
    flushPartial();
  });
  return flushPartial;
}

export function createChannelWorkerSupervisor(
  opts: CreateChannelWorkerSupervisorOptions,
): ChannelWorkerSupervisor {
  const spawnWorker = opts.spawnWorker ?? defaultSpawnWorker;
  const restartPolicy = opts.restartPolicy ?? DEFAULT_RESTART_POLICY;
  const heartbeatTimeoutMs =
    opts.heartbeatTimeoutMs ?? DEFAULT_CHANNEL_WORKER_HEARTBEAT_TIMEOUT_MS;
  let child: ChannelWorkerChild | undefined;
  let snapshot: ChannelWorkerSnapshot = {
    enabled: true,
    state: 'disabled',
    channels: channelSelectionNames(opts.selection),
    restartCount: 0,
  };
  let stopping = false;
  let restartTimer: NodeJS.Timeout | undefined;
  let staleHeartbeatTimer: NodeJS.Timeout | undefined;
  let restartAttemptTimes: number[] = [];

  const snapshotCopy = (): ChannelWorkerSnapshot => ({
    ...snapshot,
    channels: [...snapshot.channels],
    ...(snapshot.requestedChannels
      ? { requestedChannels: [...snapshot.requestedChannels] }
      : {}),
  });

  const clearRestartTimer = () => {
    if (!restartTimer) return;
    clearTimeout(restartTimer);
    restartTimer = undefined;
  };

  const clearStaleHeartbeatTimer = () => {
    if (!staleHeartbeatTimer) return;
    clearTimeout(staleHeartbeatTimer);
    staleHeartbeatTimer = undefined;
  };

  const pruneRestartAttempts = (nowMs: number) => {
    restartAttemptTimes = restartAttemptTimes.filter(
      (attemptMs) => nowMs - attemptMs < restartPolicy.windowMs,
    );
  };

  const canScheduleRestart = (nowMs: number): boolean => {
    pruneRestartAttempts(nowMs);
    return restartAttemptTimes.length < restartPolicy.maxRestarts;
  };

  const nextRestartDelayMs = (): number => {
    const index = Math.min(
      restartAttemptTimes.length,
      restartPolicy.delaysMs.length - 1,
    );
    return restartPolicy.delaysMs[index] ?? 0;
  };

  const setExited = (
    state: ChannelWorkerState,
    code: number | null,
    signal: NodeJS.Signals | null,
    error?: string,
  ) => {
    const next: ChannelWorkerSnapshot = {
      ...snapshot,
      state,
      exitCode: code,
      signal,
      lastExitAt: new Date().toISOString(),
    };
    if (error) {
      next.error = error;
    } else {
      delete next.error;
    }
    snapshot = {
      ...next,
    };
  };

  const scheduleRestart = (): boolean => {
    if (stopping) return false;
    const nowMs = Date.now();
    if (!canScheduleRestart(nowMs)) {
      snapshot = {
        ...snapshot,
        state: 'failed',
        error: snapshot.error ?? 'Channel worker restart budget exhausted.',
        nextRestartAt: undefined,
      };
      return false;
    }
    const delayMs = nextRestartDelayMs();
    const nextRestartAt = new Date(nowMs + delayMs).toISOString();
    snapshot = {
      ...snapshot,
      nextRestartAt,
    };
    clearRestartTimer();
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void launch('restart').catch((err: unknown) => {
        handleRestartFailure(err instanceof Error ? err.message : String(err));
      });
    }, delayMs);
    restartTimer.unref();
    return true;
  };

  const handleRestartFailure = (error: string) => {
    snapshot = {
      ...snapshot,
      state: 'failed',
      error: sanitizeWorkerError(error),
    };
    scheduleRestart();
    notifyExit(opts.onExit, snapshotCopy());
  };

  const armStaleHeartbeatTimer = (startedChild: ChannelWorkerChild) => {
    clearStaleHeartbeatTimer();
    if (heartbeatTimeoutMs <= 0) return;
    staleHeartbeatTimer = setTimeout(() => {
      if (child !== startedChild || stopping) return;
      snapshot = {
        ...snapshot,
        error: 'Channel worker heartbeat timed out.',
        staleHeartbeatAt: new Date().toISOString(),
      };
      startedChild.kill('SIGKILL');
    }, heartbeatTimeoutMs);
    staleHeartbeatTimer.unref();
  };

  const launch = async (kind: 'initial' | 'restart'): Promise<void> => {
    clearStaleHeartbeatTimer();
    const argv = [
      opts.cliEntryPath,
      'channel',
      'daemon-worker',
      ...selectionChannelArgs(opts.selection),
    ];
    const env = createWorkerEnv({
      daemonUrl: opts.daemonUrl,
      workspace: opts.workspace,
      ...(opts.daemonToken ? { daemonToken: opts.daemonToken } : {}),
    });
    const requestedChannels = requestedChannelNames(opts.selection);
    const startedAt = new Date().toISOString();
    snapshot = {
      enabled: true,
      state: 'starting',
      channels: channelSelectionNames(opts.selection),
      ...(requestedChannels ? { requestedChannels } : {}),
      startedAt,
      restartCount: snapshot.restartCount ?? 0,
      ...(snapshot.lastExitAt ? { lastExitAt: snapshot.lastExitAt } : {}),
      ...(snapshot.lastHeartbeatAt
        ? { lastHeartbeatAt: snapshot.lastHeartbeatAt }
        : {}),
      ...(snapshot.staleHeartbeatAt
        ? { staleHeartbeatAt: snapshot.staleHeartbeatAt }
        : {}),
    };
    if (kind === 'restart') {
      const nowMs = Date.now();
      restartAttemptTimes.push(nowMs);
      snapshot = {
        ...snapshot,
        restartCount: (snapshot.restartCount ?? 0) + 1,
        lastRestartAt: new Date(nowMs).toISOString(),
        nextRestartAt: undefined,
      };
    }

    let startedChild: ChannelWorkerChild;
    try {
      startedChild = spawnWorker(process.execPath, argv, {
        cwd: opts.workspace,
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error = sanitizeWorkerError(message);
      snapshot = {
        ...snapshot,
        state: 'failed',
        error,
      };
      if (kind === 'initial') throw new Error(error);
      handleRestartFailure(message);
      return;
    }

    child = startedChild;
    attachWorkerLogStream(startedChild.stdout, 'stdout', {
      ...(opts.daemonToken ? { daemonToken: opts.daemonToken } : {}),
      workerEnv: env,
      onLog: opts.onLog,
    });
    attachWorkerLogStream(startedChild.stderr, 'stderr', {
      ...(opts.daemonToken ? { daemonToken: opts.daemonToken } : {}),
      workerEnv: env,
      onLog: opts.onLog,
    });
    if (startedChild.pid !== undefined) {
      snapshot = { ...snapshot, pid: startedChild.pid };
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let ready = false;
      let exitObserved = false;
      let terminatingBeforeReady = false;
      let startupTimer: NodeJS.Timeout | undefined;
      const cleanupStartupTimer = () => {
        if (!startupTimer) return;
        clearTimeout(startupTimer);
        startupTimer = undefined;
      };
      const cleanupLaunch = () => {
        cleanupStartupTimer();
        startedChild.removeListener('message', handleMessage);
        clearStaleHeartbeatTimer();
      };
      const terminateBeforeReady = () => {
        cleanupLaunch();
        if (terminatingBeforeReady) return;
        terminatingBeforeReady = true;
        const exited = waitForExit(startedChild, 2_000);
        startedChild.kill('SIGTERM');
        void exited.then((didExit) => {
          if (!didExit && child === startedChild && !exitObserved) {
            startedChild.kill('SIGKILL');
          }
        });
      };
      const failBeforeReady = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanupStartupTimer();
        if (kind === 'initial') {
          reject(err);
        } else {
          resolve();
        }
      };
      const completeReady = (message: {
        pid?: number;
        channels?: string[];
        requestedChannels?: string[];
      }) => {
        if (settled || child !== startedChild) return;
        settled = true;
        ready = true;
        cleanupStartupTimer();
        const next: ChannelWorkerSnapshot = {
          ...snapshot,
          state: 'running',
          pid: message.pid ?? startedChild.pid,
          channels:
            message.channels && message.channels.length > 0
              ? [...message.channels]
              : [...snapshot.channels],
        };
        if (message.requestedChannels?.length) {
          next.requestedChannels = [...message.requestedChannels];
        }
        snapshot = next;
        armStaleHeartbeatTimer(startedChild);
        notifyReady(opts.onReady, snapshotCopy());
        resolve();
      };
      const handleHeartbeat = (message: { pid?: number; at?: string }) => {
        if (!ready || child !== startedChild) return;
        const currentPid = snapshot.pid ?? startedChild.pid;
        if (message.pid !== undefined && currentPid !== undefined) {
          if (message.pid !== currentPid) return;
        }
        snapshot = {
          ...snapshot,
          lastHeartbeatAt: message.at ?? new Date().toISOString(),
        };
        armStaleHeartbeatTimer(startedChild);
      };
      function handleMessage(message: unknown) {
        if (child !== startedChild) return;
        if (!ready && isReadyMessage(message)) {
          completeReady(message);
        } else if (isHeartbeatMessage(message)) {
          handleHeartbeat(message);
        }
      }
      function settleExit(code: number | null, signal: NodeJS.Signals | null) {
        if (child !== startedChild) return;
        exitObserved = true;
        cleanupLaunch();
        const state = ready ? 'exited' : 'failed';
        const message = `Channel worker exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`;
        setExited(
          state,
          code,
          signal,
          snapshot.error ?? (ready ? undefined : sanitizeWorkerError(message)),
        );
        child = undefined;
        if (ready && !stopping) {
          scheduleRestart();
          notifyExit(opts.onExit, snapshotCopy());
        } else if (!ready && kind === 'restart' && !stopping) {
          scheduleRestart();
          notifyExit(opts.onExit, snapshotCopy());
        }
        if (!settled) {
          failBeforeReady(new Error(snapshot.error ?? message));
        }
      }
      function settleError(err: Error) {
        if (child !== startedChild || exitObserved) return;
        if (settled && ready) {
          startedChild.kill('SIGTERM');
          return;
        }
        snapshot = {
          ...snapshot,
          state: 'failed',
          error: sanitizeWorkerError(err.message),
        };
        terminateBeforeReady();
        if (!settled) {
          failBeforeReady(new Error(snapshot.error));
        }
      }
      startupTimer = setTimeout(() => {
        const timeoutMs =
          opts.startupTimeoutMs ?? DEFAULT_CHANNEL_WORKER_STARTUP_TIMEOUT_MS;
        const error = `Channel worker did not become ready within ${timeoutMs}ms.`;
        snapshot = {
          ...snapshot,
          state: 'failed',
          error: sanitizeWorkerError(error),
        };
        failBeforeReady(new Error(error));
        if (child === startedChild) {
          terminateBeforeReady();
        }
      }, opts.startupTimeoutMs ?? DEFAULT_CHANNEL_WORKER_STARTUP_TIMEOUT_MS);
      startupTimer.unref();
      startedChild.on('message', handleMessage);
      startedChild.once('exit', settleExit);
      startedChild.once('error', settleError);
    });
  };

  return {
    async start() {
      if (child) return;
      stopping = false;
      clearRestartTimer();
      restartAttemptTimes = [];
      await launch('initial');
    },
    async stop() {
      clearRestartTimer();
      clearStaleHeartbeatTimer();
      if (
        !child ||
        snapshot.state === 'exited' ||
        (snapshot.state === 'failed' && hasObservedExit(snapshot)) ||
        snapshot.state === 'stopped'
      ) {
        child = undefined;
        snapshot = { ...snapshot, state: 'stopped' };
        return;
      }
      const exited = waitForExit(child, 5_000);
      stopping = true;
      child.kill('SIGTERM');
      if (!(await exited)) {
        const killed = waitForExit(child, 2_000);
        child.kill('SIGKILL');
        if (!(await killed)) {
          child = undefined;
          stopping = false;
          snapshot = {
            ...snapshot,
            state: 'failed',
            signal: 'SIGKILL',
            error: 'Channel worker did not exit after SIGKILL.',
          };
          return;
        }
      }
      child = undefined;
      stopping = false;
      snapshot = { ...snapshot, state: 'stopped' };
    },
    killAllSync() {
      if (
        !child ||
        snapshot.state === 'exited' ||
        (snapshot.state === 'failed' && hasObservedExit(snapshot)) ||
        snapshot.state === 'stopped'
      ) {
        clearRestartTimer();
        clearStaleHeartbeatTimer();
        return;
      }
      const preserveFailure =
        snapshot.state === 'failed' && !hasObservedExit(snapshot);
      clearRestartTimer();
      clearStaleHeartbeatTimer();
      stopping = true;
      child.kill('SIGKILL');
      child = undefined;
      if (!preserveFailure) {
        snapshot = {
          ...snapshot,
          state: 'stopped',
          signal: 'SIGKILL',
        };
      }
    },
    snapshot() {
      return snapshotCopy();
    },
  };
}
