import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { ServeChannelSelection } from './types.js';
import { CHANNEL_DAEMON_WORKER_SENTINEL } from '../commands/channel/daemon-worker.js';

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
  spawnWorker?: SpawnChannelWorker;
}

function selectionChannelArgs(selection: ServeChannelSelection): string[] {
  const names = selection.mode === 'all' ? ['all'] : selection.names;
  return names.flatMap((name) => ['--channel', name]);
}

function configuredChannels(selection: ServeChannelSelection): string[] {
  return selection.mode === 'all' ? ['all'] : [...selection.names];
}

function defaultSpawnWorker(
  execPath: string,
  argv: string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'];
  },
): ChannelWorkerChild {
  const child = fork(argv[0]!, argv.slice(1), {
    execPath,
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

export function createChannelWorkerSupervisor(
  opts: CreateChannelWorkerSupervisorOptions,
): ChannelWorkerSupervisor {
  const spawnWorker = opts.spawnWorker ?? defaultSpawnWorker;
  let child: ChannelWorkerChild | undefined;
  let snapshot: ChannelWorkerSnapshot = {
    enabled: true,
    state: 'disabled',
    channels: configuredChannels(opts.selection),
  };
  let ready = false;

  const setExited = (
    state: ChannelWorkerState,
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => {
    snapshot = {
      ...snapshot,
      state,
      exitCode: code,
      signal,
    };
  };

  return {
    async start() {
      if (child) return;
      const argv = [
        opts.cliEntryPath,
        'channel',
        'daemon-worker',
        ...selectionChannelArgs(opts.selection),
      ];
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        QWEN_CODE_NO_RELAUNCH: 'true',
        [CHANNEL_DAEMON_WORKER_SENTINEL]: '1',
        QWEN_DAEMON_URL: opts.daemonUrl,
        QWEN_DAEMON_TOKEN: opts.daemonToken ?? '',
        QWEN_DAEMON_WORKSPACE: opts.workspace,
      };
      snapshot = {
        enabled: true,
        state: 'starting',
        channels: configuredChannels(opts.selection),
        startedAt: new Date().toISOString(),
      };
      child = spawnWorker(process.execPath, argv, {
        env,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      if (child.pid !== undefined) {
        snapshot = { ...snapshot, pid: child.pid };
      }

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settleReady = (message: unknown) => {
          if (settled || !isReadyMessage(message)) return;
          settled = true;
          ready = true;
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
        };
        const settleExit = (
          code: number | null,
          signal: NodeJS.Signals | null,
        ) => {
          const state = ready ? 'exited' : 'failed';
          setExited(state, code, signal);
          if (!settled) {
            settled = true;
            reject(
              new Error(
                `Channel worker exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`,
              ),
            );
          }
        };
        const settleError = (err: Error) => {
          snapshot = { ...snapshot, state: ready ? 'exited' : 'failed' };
          if (!settled) {
            settled = true;
            reject(err);
          }
        };
        child!.once('message', settleReady);
        child!.once('exit', settleExit);
        child!.once('error', settleError);
      });
    },
    async stop() {
      if (
        !child ||
        snapshot.state === 'exited' ||
        snapshot.state === 'failed' ||
        snapshot.state === 'stopped'
      ) {
        snapshot = { ...snapshot, state: 'stopped' };
        return;
      }
      const exited = waitForExit(child, 5_000);
      child.kill('SIGTERM');
      if (!(await exited)) {
        const killed = waitForExit(child, 2_000);
        child.kill('SIGKILL');
        await killed;
      }
      snapshot = { ...snapshot, state: 'stopped' };
    },
    killAllSync() {
      if (!child || snapshot.state === 'exited' || snapshot.state === 'stopped')
        return;
      child.kill('SIGKILL');
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

export function createDisabledChannelWorkerSupervisor(): ChannelWorkerSupervisor {
  const snapshot: ChannelWorkerSnapshot = {
    enabled: false,
    state: 'disabled',
    channels: [],
  };
  return {
    async start() {},
    async stop() {},
    killAllSync() {},
    snapshot: () => snapshot,
  };
}
