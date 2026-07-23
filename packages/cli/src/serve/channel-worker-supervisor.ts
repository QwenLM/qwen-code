import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { channelSelectionNames } from './channel-selection.js';
import type { ServeChannelSelection } from './types.js';
import {
  CHANNEL_DAEMON_WORKER_SENTINEL,
  CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS,
  QWEN_DAEMON_TOKEN_ENV,
  QWEN_DAEMON_URL_ENV,
  QWEN_DAEMON_WORKSPACE_ENV,
  QWEN_SERVER_TOKEN_ENV,
} from './channel-worker-env.js';
import { sanitizeLogText } from '@qwen-code/channel-base';
import type { ChannelWebhookTask } from '@qwen-code/channel-base';
import {
  CHANNEL_WORKER_KILL_GRACE_MS,
  CHANNEL_WORKER_STARTUP_TIMEOUT_MS,
  CHANNEL_WORKER_STOP_GRACE_MS,
} from '@qwen-code/acp-bridge/channelControlTimeouts';
import {
  CHANNEL_WEBHOOK_TASK_IPC_TIMEOUT_MS,
  ChannelWebhookEnqueueError,
  createChannelWebhookTaskMessage,
  isChannelWebhookEnqueueErrorCode,
  isChannelWebhookTaskResultMessage,
  type ChannelWebhookAccepted,
  type ChannelWebhookEnqueueErrorCode,
} from './channel-webhook-ipc.js';
import {
  CHANNEL_DELIVERY_IPC_TIMEOUT_MS,
  ChannelDeliveryError,
  createChannelDeliveryMessage,
  isChannelDeliveryResultMessage,
  MAX_CHANNEL_DELIVERIES_IN_FLIGHT,
  type ChannelDeliveryAccepted,
  type ChannelDeliveryErrorCode,
  type ChannelDeliveryRequest,
} from './channel-delivery-ipc.js';
import {
  createWorkerDiagnosticRedactor,
  normalizeWorkerDiagnostic,
  sanitizeWorkerDiagnostic,
  type WorkerDiagnosticRedactionOptions,
} from './channel-worker-diagnostics.js';
import {
  isChannelStartupReportMessage,
  isChannelStartupReportType,
  MAX_CHANNEL_STARTUP_FAILURES,
  MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH,
  type ChannelStartupFailure,
} from './channel-worker-startup-ipc.js';

const DEFAULT_CHANNEL_WORKER_HEARTBEAT_TIMEOUT_MS = 45_000;
const MAX_WORKER_LOG_LINE_LENGTH = 4096;
const MAX_WORKER_LOG_BUFFER_LENGTH = 64 * 1024;
const MAX_WORKER_LOG_DISCARDED_REMAINDER_LENGTH = MAX_WORKER_LOG_BUFFER_LENGTH;

export interface ChannelWorkerRestartPolicy {
  maxRestarts: number;
  windowMs: number;
  delaysMs: number[];
}

export class ChannelWorkerStopError extends Error {
  constructor(message = 'Channel worker did not exit after SIGKILL.') {
    super(message);
    this.name = 'ChannelWorkerStopError';
  }
}

export interface ChannelStartupAttemptFailure extends ChannelStartupFailure {
  workspaceCwd: string;
}

export class ChannelWorkerStartupError extends Error {
  readonly startupFailures: ChannelStartupAttemptFailure[];
  readonly startupFailuresTruncated: boolean;

  constructor(
    message: string,
    details: {
      workspaceCwd: string;
      startupFailures: readonly ChannelStartupFailure[];
      startupFailuresTruncated?: boolean;
    },
  ) {
    super(message);
    this.name = 'ChannelWorkerStartupError';
    this.startupFailures = details.startupFailures.map((failure) => ({
      ...failure,
      workspaceCwd: details.workspaceCwd,
    }));
    this.startupFailuresTruncated = details.startupFailuresTruncated === true;
  }
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
  startupFailures?: ChannelStartupFailure[];
  startupFailuresTruncated?: boolean;
}

export interface ChannelWorkerSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Stop the current worker (if any) and relaunch it. The relaunched worker
   * re-reads settings.json, so this is how settings changes are applied
   * without restarting the whole daemon. Rejects if the relaunch fails.
   */
  restart(): Promise<ChannelWorkerSnapshot>;
  killAllSync(): void;
  snapshot(): ChannelWorkerSnapshot;
  deliverChannelMessage?(
    request: ChannelDeliveryRequest,
  ): Promise<ChannelDeliveryAccepted>;
  enqueueWebhookTask(task: ChannelWebhookTask): Promise<ChannelWebhookAccepted>;
}

export interface ChannelWorkerChild {
  pid?: number;
  killed?: boolean;
  stdout?: WorkerLogStream;
  stderr?: WorkerLogStream;
  send?(message: unknown, callback?: (err: Error | null) => void): boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'message', listener: (message: unknown) => void): this;
  removeListener(event: 'message', listener: (message: unknown) => void): this;
  removeListener(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
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
  /**
   * Base environment for the spawned worker. Defaults to `process.env`. In
   * multi-workspace mode the caller passes the owning runtime's effective env
   * overlay so the worker inherits that workspace's `.env` instead of the
   * daemon base env.
   */
  workerBaseEnv?: Readonly<NodeJS.ProcessEnv>;
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

function workerLogRedactionOptions(
  daemonToken: string | undefined,
  workerEnv: NodeJS.ProcessEnv,
): WorkerDiagnosticRedactionOptions {
  return {
    ...(daemonToken ? { daemonToken } : {}),
    workerEnv,
  };
}

function sanitizeWorkerError(
  error: string,
  redaction?: WorkerDiagnosticRedactionOptions,
): string {
  return redaction
    ? sanitizeWorkerDiagnostic(error, 512, redaction)
    : sanitizeLogText(normalizeWorkerDiagnostic(error), 512);
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
    const onExit = () => done(true);
    const done = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref();
    child.once('exit', onExit);
  });
}

function hasObservedExit(snapshot: ChannelWorkerSnapshot): boolean {
  return snapshot.exitCode !== undefined || snapshot.signal !== undefined;
}

function createWorkerEnv(opts: {
  daemonUrl: string;
  daemonToken?: string;
  workspace: string;
  baseEnv?: Readonly<NodeJS.ProcessEnv>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(opts.baseEnv ?? process.env) };
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
  let discardedOversizedLineRemainderLength = 0;
  const redactWorkerLogLineForStream = createWorkerDiagnosticRedactor({
    ...(opts.daemonToken ? { daemonToken: opts.daemonToken } : {}),
    workerEnv: opts.workerEnv,
  });
  const flushLine = (line: string) => {
    const displayLine = line.replace(/\t/gu, ' ');
    const redacted = redactWorkerLogLineForStream(
      normalizeWorkerDiagnostic(displayLine),
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
    discardedOversizedLineRemainderLength = 0;
  };
  stream.on('data', (chunk) => {
    buffer +=
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
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
      discardedOversizedLineRemainderLength = 0;
    }
    if (discardingOversizedLineRemainder) {
      discardedOversizedLineRemainderLength += buffer.length;
      buffer = '';
      if (
        discardedOversizedLineRemainderLength >=
        MAX_WORKER_LOG_DISCARDED_REMAINDER_LENGTH
      ) {
        discardingOversizedLineRemainder = false;
        discardedOversizedLineRemainderLength = 0;
      }
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
  if (restartPolicy.delaysMs.length === 0) {
    throw new Error('restartPolicy.delaysMs must be non-empty.');
  }
  const heartbeatTimeoutMs =
    opts.heartbeatTimeoutMs ?? DEFAULT_CHANNEL_WORKER_HEARTBEAT_TIMEOUT_MS;
  if (
    heartbeatTimeoutMs > 0 &&
    heartbeatTimeoutMs <= CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS
  ) {
    throw new Error(
      `heartbeatTimeoutMs (${heartbeatTimeoutMs}) must exceed the worker heartbeat interval (${CHANNEL_WORKER_HEARTBEAT_INTERVAL_MS}ms) or be 0 to disable.`,
    );
  }
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
  const pendingWebhookTasks = new Map<
    string,
    {
      resolve: (accepted: ChannelWebhookAccepted) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const pendingChannelDeliveries = new Map<
    string,
    {
      resolve: (accepted: ChannelDeliveryAccepted) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  let restarting: Promise<ChannelWorkerSnapshot> | undefined;
  let disposed = false;

  const snapshotCopy = (): ChannelWorkerSnapshot => ({
    ...snapshot,
    channels: [...snapshot.channels],
    ...(snapshot.requestedChannels
      ? { requestedChannels: [...snapshot.requestedChannels] }
      : {}),
    ...(snapshot.startupFailures
      ? {
          startupFailures: snapshot.startupFailures.map((failure) => ({
            ...failure,
          })),
        }
      : {}),
  });

  const clearRestartTimer = () => {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    if (snapshot.nextRestartAt) {
      const next = { ...snapshot };
      delete next.nextRestartAt;
      snapshot = next;
    }
  };

  const clearStaleHeartbeatTimer = () => {
    if (!staleHeartbeatTimer) return;
    clearTimeout(staleHeartbeatTimer);
    staleHeartbeatTimer = undefined;
  };

  const rejectPendingWebhookTasks = (
    code: ChannelWebhookEnqueueErrorCode,
    message: string,
  ) => {
    for (const pending of pendingWebhookTasks.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ChannelWebhookEnqueueError(code, message));
    }
    pendingWebhookTasks.clear();
  };

  const rejectPendingWebhookTask = (id: string, err: Error) => {
    const pending = pendingWebhookTasks.get(id);
    if (!pending) return;
    pendingWebhookTasks.delete(id);
    clearTimeout(pending.timer);
    pending.reject(err);
  };

  const settleWebhookTask = (message: unknown): boolean => {
    if (!isChannelWebhookTaskResultMessage(message)) return false;
    const pending = pendingWebhookTasks.get(message.id);
    if (!pending) return true;
    if (message.ok) {
      pendingWebhookTasks.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve({ accepted: true });
    } else {
      const code = isChannelWebhookEnqueueErrorCode(message.code)
        ? message.code
        : 'channel_webhook_enqueue_failed';
      rejectPendingWebhookTask(
        message.id,
        new ChannelWebhookEnqueueError(
          code,
          message.error || 'Channel webhook task failed.',
        ),
      );
    }
    return true;
  };

  const rejectPendingChannelDeliveries = (
    code: ChannelDeliveryErrorCode,
    message: string,
  ) => {
    for (const pending of pendingChannelDeliveries.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ChannelDeliveryError(code, message));
    }
    pendingChannelDeliveries.clear();
  };

  const rejectPendingChannelDelivery = (id: string, error: Error) => {
    const pending = pendingChannelDeliveries.get(id);
    if (!pending) return;
    pendingChannelDeliveries.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  };

  const settleChannelDelivery = (message: unknown): boolean => {
    if (!isChannelDeliveryResultMessage(message)) return false;
    const pending = pendingChannelDeliveries.get(message.id);
    if (!pending) return true;
    if (message.ok) {
      pendingChannelDeliveries.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve({ delivered: true });
    } else {
      rejectPendingChannelDelivery(
        message.id,
        new ChannelDeliveryError(
          message.code,
          message.error || 'Channel delivery failed.',
        ),
      );
    }
    return true;
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
      const lastError = snapshot.error;
      snapshot = {
        ...snapshot,
        state: 'failed',
        error: lastError
          ? `Channel worker restart budget exhausted. Last error: ${lastError}`
          : 'Channel worker restart budget exhausted.',
        nextRestartAt: undefined,
      };
      return false;
    }
    clearRestartTimer();
    const delayMs = nextRestartDelayMs();
    const nextRestartAt = new Date(nowMs + delayMs).toISOString();
    snapshot = {
      ...snapshot,
      nextRestartAt,
    };
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void launch('restart').catch((err: unknown) => {
        handleRestartFailure(err instanceof Error ? err.message : String(err));
      });
    }, delayMs);
    restartTimer.unref();
    return true;
  };

  const handleRestartFailure = (
    error: string,
    redaction?: WorkerDiagnosticRedactionOptions,
  ) => {
    snapshot = {
      ...snapshot,
      state: 'failed',
      error: sanitizeWorkerError(error, redaction),
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
      ...(opts.workerBaseEnv ? { baseEnv: opts.workerBaseEnv } : {}),
    });
    const redaction = workerLogRedactionOptions(opts.daemonToken, env);
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
      const error = sanitizeWorkerError(message, redaction);
      if (kind === 'initial') {
        snapshot = {
          ...snapshot,
          state: 'failed',
          error,
        };
        throw new Error(error);
      }
      handleRestartFailure(message, redaction);
      return;
    }

    child = startedChild;
    attachWorkerLogStream(startedChild.stdout, 'stdout', {
      ...redaction,
      onLog: opts.onLog,
    });
    attachWorkerLogStream(startedChild.stderr, 'stderr', {
      ...redaction,
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
        const exited = waitForExit(startedChild, CHANNEL_WORKER_KILL_GRACE_MS);
        startedChild.kill('SIGTERM');
        void exited.then(async (didExit) => {
          if (!didExit && child === startedChild && !exitObserved) {
            const killed = waitForExit(
              startedChild,
              CHANNEL_WORKER_KILL_GRACE_MS,
            );
            startedChild.kill('SIGKILL');
            if (!(await killed) && child === startedChild && !exitObserved) {
              stopping = true;
              notifyLog(opts.onLog, {
                stream: 'stderr',
                line: 'Channel worker did not exit after SIGKILL; automatic restart is disabled.',
              });
              snapshot = {
                ...snapshot,
                state: 'failed',
                error:
                  snapshot.error ??
                  'Channel worker did not exit after SIGKILL.',
              };
              notifyExit(opts.onExit, snapshotCopy());
            }
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
      const startupError = (message: string): Error => {
        const failures = snapshot.startupFailures;
        return failures && failures.length > 0
          ? new ChannelWorkerStartupError(message, {
              workspaceCwd: opts.workspace,
              startupFailures: failures,
              ...(snapshot.startupFailuresTruncated
                ? { startupFailuresTruncated: true }
                : {}),
            })
          : new Error(message);
      };
      const failStartupProtocol = (detail: string) => {
        if (settled || ready || child !== startedChild) return;
        const error = sanitizeWorkerError(
          `Channel worker startup IPC protocol error: ${detail}`,
          redaction,
        );
        snapshot = { ...snapshot, state: 'failed', error };
        failBeforeReady(startupError(error));
        terminateBeforeReady();
      };
      const acknowledgeStartupReport = () => {
        const send = startedChild.send;
        if (!send) {
          failStartupProtocol('acknowledgement is unavailable.');
          return;
        }
        try {
          send.call(
            startedChild,
            { type: 'channel_startup_report_ack' },
            (err) => {
              if (err) {
                failStartupProtocol('acknowledgement failed.');
              }
            },
          );
        } catch {
          failStartupProtocol('acknowledgement failed.');
        }
      };
      const handleStartupReport = (message: unknown) => {
        if (!isChannelStartupReportMessage(message)) {
          failStartupProtocol('invalid startup report.');
          return;
        }
        if (message.type === 'channel_startup_failures_truncated') {
          if (
            snapshot.startupFailuresTruncated ||
            snapshot.startupFailures?.length !== MAX_CHANNEL_STARTUP_FAILURES
          ) {
            failStartupProtocol('invalid truncation marker.');
            return;
          }
          snapshot = { ...snapshot, startupFailuresTruncated: true };
          acknowledgeStartupReport();
          return;
        }
        if (
          snapshot.startupFailuresTruncated ||
          (snapshot.startupFailures?.length ?? 0) >=
            MAX_CHANNEL_STARTUP_FAILURES
        ) {
          failStartupProtocol('too many startup failures.');
          return;
        }
        const safeChannel =
          sanitizeWorkerDiagnostic(
            message.failure.channel,
            MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH,
            redaction,
          ) || '<unnamed>';
        const safeMessage =
          sanitizeWorkerDiagnostic(
            message.failure.message,
            MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH,
            redaction,
          ) || 'Channel connection failed.';
        const safeCode = message.failure.code
          ? sanitizeWorkerDiagnostic(
              message.failure.code,
              MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH,
              redaction,
            )
          : undefined;
        const failure: ChannelStartupFailure = {
          channel: safeChannel,
          phase: 'connect',
          ...(safeCode ? { code: safeCode } : {}),
          message: safeMessage,
        };
        snapshot = {
          ...snapshot,
          startupFailures: [...(snapshot.startupFailures ?? []), failure],
        };
        acknowledgeStartupReport();
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
        delete next.error;
        delete next.lastHeartbeatAt;
        delete next.nextRestartAt;
        delete next.staleHeartbeatAt;
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
        // Use daemon clock, not worker-supplied message.at — a compromised
        // adapter could inject arbitrary data via the IPC heartbeat.
        snapshot = {
          ...snapshot,
          lastHeartbeatAt: new Date().toISOString(),
        };
        armStaleHeartbeatTimer(startedChild);
      };
      function handleMessage(message: unknown) {
        if (child !== startedChild) return;
        if (settleChannelDelivery(message)) {
          return;
        }
        if (settleWebhookTask(message)) {
          return;
        }
        if (!ready && isChannelStartupReportType(message)) {
          handleStartupReport(message);
        } else if (!ready && isReadyMessage(message)) {
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
          snapshot.error ??
            (ready ? undefined : sanitizeWorkerError(message, redaction)),
        );
        rejectPendingWebhookTasks(
          'channel_worker_unavailable',
          'Channel worker exited.',
        );
        rejectPendingChannelDeliveries(
          'channel_worker_unavailable',
          'Channel worker exited.',
        );
        child = undefined;
        if ((ready || kind === 'restart') && !stopping) {
          scheduleRestart();
          notifyExit(opts.onExit, snapshotCopy());
        }
        if (!settled) {
          failBeforeReady(startupError(snapshot.error ?? message));
        }
      }
      function settleError(err: Error) {
        if (child !== startedChild || exitObserved) return;
        if (settled && ready) {
          snapshot = {
            ...snapshot,
            error: sanitizeWorkerError(err.message, redaction),
          };
          startedChild.kill('SIGTERM');
          return;
        }
        snapshot = {
          ...snapshot,
          state: 'failed',
          error: sanitizeWorkerError(err.message, redaction),
        };
        terminateBeforeReady();
        if (!settled) {
          failBeforeReady(
            startupError(snapshot.error ?? 'Channel worker failed to start.'),
          );
        }
      }
      startupTimer = setTimeout(() => {
        const timeoutMs =
          opts.startupTimeoutMs ?? CHANNEL_WORKER_STARTUP_TIMEOUT_MS;
        const error = `Channel worker did not become ready within ${timeoutMs}ms.`;
        snapshot = {
          ...snapshot,
          state: 'failed',
          error: sanitizeWorkerError(error, redaction),
        };
        failBeforeReady(startupError(error));
        if (child === startedChild) {
          terminateBeforeReady();
        }
      }, opts.startupTimeoutMs ?? CHANNEL_WORKER_STARTUP_TIMEOUT_MS);
      startupTimer.unref();
      startedChild.on('message', handleMessage);
      startedChild.once('exit', settleExit);
      startedChild.once('error', settleError);
    });
  };

  const supervisor: ChannelWorkerSupervisor = {
    async start() {
      // `disposed` is latched only by killAllSync() (hard shutdown), so the
      // supported stop()/start() reuse lifecycle is preserved; this guard just
      // prevents a relaunch into a daemon that is being force-torn-down.
      if (disposed) return;
      if (child) {
        if (stopping) {
          throw new ChannelWorkerStopError(
            'Channel worker stop is not yet confirmed.',
          );
        }
        return;
      }
      stopping = false;
      clearRestartTimer();
      restartAttemptTimes = [];
      await launch('initial');
    },
    async stop() {
      clearRestartTimer();
      clearStaleHeartbeatTimer();
      rejectPendingWebhookTasks(
        'channel_worker_unavailable',
        'Channel worker stopped.',
      );
      rejectPendingChannelDeliveries(
        'channel_worker_unavailable',
        'Channel worker stopped.',
      );
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
      const stoppingChild = child;
      const exited = waitForExit(stoppingChild, CHANNEL_WORKER_STOP_GRACE_MS);
      stopping = true;
      stoppingChild.kill('SIGTERM');
      if (!(await exited) && child === stoppingChild) {
        const killed = waitForExit(stoppingChild, CHANNEL_WORKER_KILL_GRACE_MS);
        stoppingChild.kill('SIGKILL');
        if (!(await killed)) {
          snapshot = {
            ...snapshot,
            state: 'failed',
            error: 'Channel worker did not exit after SIGKILL.',
          };
          throw new ChannelWorkerStopError();
        }
      }
      child = undefined;
      stopping = false;
      snapshot = { ...snapshot, state: 'stopped' };
    },
    async restart() {
      // A hard shutdown (killAllSync) latches `disposed`; a reload racing that
      // must not relaunch a worker into a tearing-down daemon.
      if (disposed) return snapshotCopy();
      // Coalesce concurrent reloads onto one stop+relaunch so a burst of
      // reload requests cannot fork multiple workers.
      restarting ??= (async () => {
        try {
          await supervisor.stop();
          // start() bails if a child is still attached (stop cleared it) or if
          // killAllSync latched `disposed` mid-reload — avoiding an orphaned
          // fork. It also resets the restart budget, so a worker previously
          // parked in `failed` recovers on an explicit reload.
          await supervisor.start();
          return snapshotCopy();
        } finally {
          restarting = undefined;
        }
      })();
      return restarting;
    },
    killAllSync() {
      disposed = true;
      rejectPendingWebhookTasks(
        'channel_worker_unavailable',
        'Channel worker stopped.',
      );
      rejectPendingChannelDeliveries(
        'channel_worker_unavailable',
        'Channel worker stopped.',
      );
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
    async deliverChannelMessage(request) {
      const startedChild = child;
      if (!startedChild || snapshot.state !== 'running') {
        throw new ChannelDeliveryError(
          'channel_worker_unavailable',
          'Channel worker is not running.',
        );
      }
      const send = startedChild.send;
      if (!send) {
        throw new ChannelDeliveryError(
          'channel_worker_unavailable',
          'Channel worker IPC send failed.',
        );
      }
      if (pendingChannelDeliveries.size >= MAX_CHANNEL_DELIVERIES_IN_FLIGHT) {
        throw new ChannelDeliveryError(
          'channel_delivery_queue_full',
          'Channel delivery queue is full.',
        );
      }
      const message = createChannelDeliveryMessage(request);
      return await new Promise<ChannelDeliveryAccepted>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingChannelDeliveries.delete(message.id);
          reject(
            new ChannelDeliveryError(
              'channel_delivery_timeout',
              'Channel delivery IPC timed out.',
            ),
          );
        }, CHANNEL_DELIVERY_IPC_TIMEOUT_MS);
        timer.unref();
        pendingChannelDeliveries.set(message.id, { resolve, reject, timer });
        try {
          send.call(startedChild, message, (error) => {
            if (!error) return;
            rejectPendingChannelDelivery(
              message.id,
              new ChannelDeliveryError(
                'channel_worker_unavailable',
                `Channel worker IPC send failed: ${error.message}`,
              ),
            );
          });
        } catch (error) {
          rejectPendingChannelDelivery(
            message.id,
            new ChannelDeliveryError(
              'channel_worker_unavailable',
              `Channel worker IPC send failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        }
      });
    },
    async enqueueWebhookTask(task) {
      const startedChild = child;
      if (!startedChild || snapshot.state !== 'running') {
        throw new ChannelWebhookEnqueueError(
          'channel_worker_unavailable',
          'Channel worker is not running.',
        );
      }
      const send = startedChild.send;
      if (!send) {
        throw new ChannelWebhookEnqueueError(
          'channel_worker_unavailable',
          'Channel worker IPC send failed.',
        );
      }
      const message = createChannelWebhookTaskMessage(task);
      return await new Promise<ChannelWebhookAccepted>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingWebhookTasks.delete(message.id);
          reject(
            new ChannelWebhookEnqueueError(
              'channel_webhook_enqueue_timeout',
              'Channel webhook task IPC timed out.',
            ),
          );
        }, CHANNEL_WEBHOOK_TASK_IPC_TIMEOUT_MS);
        timer.unref();
        pendingWebhookTasks.set(message.id, { resolve, reject, timer });
        try {
          send.call(startedChild, message, (err) => {
            if (err) {
              rejectPendingWebhookTask(
                message.id,
                new ChannelWebhookEnqueueError(
                  'channel_worker_unavailable',
                  `Channel worker IPC send failed: ${err.message}`,
                ),
              );
            }
          });
        } catch (err) {
          rejectPendingWebhookTask(
            message.id,
            new ChannelWebhookEnqueueError(
              'channel_worker_unavailable',
              `Channel worker IPC send failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          );
        }
      });
    },
  };
  return supervisor;
}
