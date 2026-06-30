import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { channelSelectionNames } from './channel-selection.js';
import type { ServeChannelSelection } from './types.js';
import {
  CHANNEL_DAEMON_WORKER_SENTINEL,
  QWEN_DAEMON_TOKEN_ENV,
  QWEN_DAEMON_URL_ENV,
  QWEN_DAEMON_WORKSPACE_ENV,
  QWEN_SERVER_TOKEN_ENV,
} from './channel-worker-env.js';

const DEFAULT_CHANNEL_WORKER_STARTUP_TIMEOUT_MS = 30_000;
const CHANNEL_WORKER_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  'DEV',
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'SystemRoot',
  'WINDIR',
  'ProgramFiles',
  'XDG_CONFIG_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'QWEN_HOME',
  'QWEN_RUNTIME_DIR',
  'QWEN_CLI_ENTRY',
  'QWEN_SERVE_DEBUG',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
];

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
  pid?: number;
  startedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
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
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'];
  },
) => ChannelWorkerChild;

export interface CreateChannelWorkerSupervisorOptions {
  cliEntryPath: string;
  daemonUrl: string;
  daemonToken?: string;
  workspace: string;
  selection: ServeChannelSelection;
  startupTimeoutMs?: number;
  spawnWorker?: SpawnChannelWorker;
  onExit?: (snapshot: ChannelWorkerSnapshot) => void;
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
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'];
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

function isReadyMessage(
  message: unknown,
): message is { type: 'ready'; pid?: number; channels?: string[] } {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'ready'
  );
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
  const env: NodeJS.ProcessEnv = {};
  for (const name of CHANNEL_WORKER_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  env['QWEN_CODE_NO_RELAUNCH'] = 'true';
  env[CHANNEL_DAEMON_WORKER_SENTINEL] = '1';
  env[QWEN_DAEMON_URL_ENV] = opts.daemonUrl;
  env[QWEN_DAEMON_WORKSPACE_ENV] = opts.workspace;
  delete env[QWEN_SERVER_TOKEN_ENV];
  delete env[QWEN_DAEMON_TOKEN_ENV];
  if (opts.daemonToken) {
    env[QWEN_DAEMON_TOKEN_ENV] = opts.daemonToken;
  }
  return env;
}

export function createChannelWorkerSupervisor(
  opts: CreateChannelWorkerSupervisorOptions,
): ChannelWorkerSupervisor {
  const spawnWorker = opts.spawnWorker ?? defaultSpawnWorker;
  let child: ChannelWorkerChild | undefined;
  let snapshot: ChannelWorkerSnapshot = {
    enabled: true,
    state: 'disabled',
    channels: channelSelectionNames(opts.selection),
  };
  let ready = false;

  const snapshotCopy = (): ChannelWorkerSnapshot => ({
    ...snapshot,
    channels: [...snapshot.channels],
  });

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

  return {
    async start() {
      if (child) return;
      ready = false;
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
      snapshot = {
        enabled: true,
        state: 'starting',
        channels: channelSelectionNames(opts.selection),
        startedAt: new Date().toISOString(),
      };
      child = spawnWorker(process.execPath, argv, {
        cwd: opts.workspace,
        env,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      if (child.pid !== undefined) {
        snapshot = { ...snapshot, pid: child.pid };
      }

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let startupTimer: NodeJS.Timeout | undefined;
        function cleanupReadyWait() {
          if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = undefined;
          }
          child?.removeListener('message', settleReady);
        }
        function failBeforeReady(err: Error) {
          if (settled) return;
          settled = true;
          cleanupReadyWait();
          reject(err);
        }
        function settleReady(message: unknown) {
          if (settled || !isReadyMessage(message)) return;
          settled = true;
          ready = true;
          cleanupReadyWait();
          snapshot = {
            ...snapshot,
            state: 'running',
            pid: message.pid ?? child?.pid,
            channels:
              message.channels && message.channels.length > 0
                ? message.channels
                : snapshot.channels,
          };
          resolve();
        }
        function settleExit(
          code: number | null,
          signal: NodeJS.Signals | null,
        ) {
          if (settled && !ready) return;
          const state = ready ? 'exited' : 'failed';
          const message = `Channel worker exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`;
          setExited(state, code, signal, ready ? undefined : message);
          if (ready) {
            opts.onExit?.(snapshotCopy());
          }
          if (!settled) {
            failBeforeReady(new Error(message));
          }
          child = undefined;
        }
        function settleError(err: Error) {
          if (settled && !ready) return;
          const observedExit = ready || child?.pid === undefined;
          if (observedExit) {
            setExited(ready ? 'exited' : 'failed', null, null, err.message);
          } else {
            snapshot = {
              ...snapshot,
              state: 'failed',
              error: err.message,
            };
          }
          if (ready) {
            opts.onExit?.(snapshotCopy());
          }
          if (!settled) {
            failBeforeReady(err);
          }
          if (observedExit) {
            child = undefined;
          }
        }
        startupTimer = setTimeout(() => {
          const timeoutMs =
            opts.startupTimeoutMs ?? DEFAULT_CHANNEL_WORKER_STARTUP_TIMEOUT_MS;
          const error = `Channel worker did not become ready within ${timeoutMs}ms.`;
          snapshot = {
            ...snapshot,
            state: 'failed',
            error,
          };
          failBeforeReady(new Error(error));
          child?.kill('SIGTERM');
        }, opts.startupTimeoutMs ?? DEFAULT_CHANNEL_WORKER_STARTUP_TIMEOUT_MS);
        startupTimer.unref();
        child!.on('message', settleReady);
        child!.once('exit', settleExit);
        child!.once('error', settleError);
      });
    },
    async stop() {
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
      child.kill('SIGTERM');
      if (!(await exited)) {
        const killed = waitForExit(child, 2_000);
        child.kill('SIGKILL');
        if (!(await killed)) {
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
      snapshot = { ...snapshot, state: 'stopped' };
    },
    killAllSync() {
      if (
        !child ||
        snapshot.state === 'exited' ||
        (snapshot.state === 'failed' && hasObservedExit(snapshot)) ||
        snapshot.state === 'stopped'
      ) {
        return;
      }
      child.kill('SIGKILL');
      child = undefined;
      snapshot = {
        ...snapshot,
        state: 'stopped',
        signal: 'SIGKILL',
      };
    },
    snapshot() {
      return { ...snapshot, channels: [...snapshot.channels] };
    },
  };
}
