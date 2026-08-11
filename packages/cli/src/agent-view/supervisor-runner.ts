/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { sanitizeChildEnv } from '@qwen-code/qwen-code-core';
import {
  attachAgentViewSupervisorTerminal,
  callAgentViewSupervisor,
  requestAgentViewSupervisor,
  subscribeAgentViewSupervisor,
} from './supervisor-client.js';
import {
  AGENT_VIEW_PROTOCOL_VERSION,
  QWEN_FLEET_SUPERVISOR_SOCKET_ENV,
  QWEN_FLEET_WORKER_SPEC_PATH_ENV,
  QWEN_FLEET_WORKER_TOKEN_ENV,
} from './protocol.js';
import type {
  AgentViewDispatchParams,
  AgentViewDispatchResult,
  AgentViewWorkerAnswerOutcome,
  AgentViewWorkerAnswerPayload,
} from './protocol.js';
import type {
  AgentViewSupervisorAdoptParams,
  AgentViewSupervisorEvent,
  AgentViewSupervisorResponse,
  AgentViewSupervisorSubscription,
} from './supervisor-client.js';
import {
  createAgentViewSupervisorHandler,
  getAgentViewSupervisorSocketPath,
} from './supervisor-process.js';
import type { AgentViewSupervisorHibernationPolicy , AgentViewWorkerSpawner } from './supervisor-process.js';
import { createAgentViewSupervisorServer } from './supervisor-server.js';
import {
  getAgentViewSessionPaths,
  getAgentViewStorePaths,
  readAgentViewSupervisor,
  writeAgentViewSupervisor,
} from './supervisor-store.js';
import { buildCurrentQwenCliArgv } from './current-cli-argv.js';
import { closeFleetLogFd, fleetDebug, openFleetLogFd } from './fleet-debug.js';

export const INTERNAL_AGENT_VIEW_SUPERVISOR_ARG =
  '--internal-agent-view-supervisor';
const INTERNAL_FLEET_TEAMMATE_ARG = '--internal-fleet-teammate';

const SUPERVISOR_READY_RETRIES = 600;
const SUPERVISOR_READY_DELAY_MS = 50;
const SUPERVISOR_MAINTENANCE_INTERVAL_MS = 5000;
const LONG_AGENT_VIEW_OPERATION_TIMEOUT_MS = 30_000;

export interface AgentViewSupervisorClientHandle {
  socketPath: string;
  startedProcess?: ChildProcess;
  status(): Promise<unknown>;
  list(cwd?: string): Promise<unknown>;
  subscribe(
    onEvent: (event: AgentViewSupervisorEvent) => void,
    onError?: (error: Error) => void,
  ): AgentViewSupervisorSubscription;
  dispatch(params: AgentViewDispatchParams): Promise<AgentViewDispatchResult>;
  adopt(params: AgentViewSupervisorAdoptParams): Promise<unknown>;
  attach(sessionId: string): Promise<unknown>;
  peek(sessionId: string): Promise<unknown>;
  send(sessionId: string, turnId: string, text: string): Promise<unknown>;
  cancel(sessionId: string): Promise<unknown>;
  answer(
    sessionId: string,
    callId: string,
    outcome: AgentViewWorkerAnswerOutcome,
    payload?: AgentViewWorkerAnswerPayload,
  ): Promise<unknown>;
  logs(sessionId: string): Promise<unknown>;
  stop(sessionId: string): Promise<unknown>;
  kill(sessionId: string): Promise<unknown>;
  respawn(sessionId?: string): Promise<unknown>;
  remove(sessionId: string): Promise<unknown>;
  pin(sessionId: string, pinned?: boolean): Promise<unknown>;
  rename(sessionId: string, displayName: string): Promise<unknown>;
  shutdown(keepWorkers?: boolean): Promise<unknown>;
}

export interface EnsureAgentViewSupervisorOptions {
  globalDir?: string;
  spawnProcess?: (args: readonly string[]) => ChildProcess;
}

export interface RunAgentViewSupervisorOptions {
  globalDir?: string;
  hibernationPolicy?: AgentViewSupervisorHibernationPolicy;
  maintenanceIntervalMs?: number;
  spawnWorker?: AgentViewWorkerSpawner;
}

export async function ensureAgentViewSupervisor(
  options: EnsureAgentViewSupervisorOptions = {},
): Promise<AgentViewSupervisorClientHandle> {
  const socketPath = getAgentViewSupervisorSocketPath({
    ...(options.globalDir ? { globalDir: options.globalDir } : {}),
  });
  if (await canReachSupervisor(socketPath, options)) {
    return createSupervisorHandle(
      socketPath,
      undefined,
      await readSupervisorAuthToken(options),
    );
  }

  return withSupervisorStartLock(options, socketPath, async () => {
    await retireIncompatibleSupervisor(options);
    if (await canReachSupervisor(socketPath, options)) {
      return createSupervisorHandle(
        socketPath,
        undefined,
        await readSupervisorAuthToken(options),
      );
    }
    const startedProcess = (options.spawnProcess ?? defaultSpawnSupervisor)([
      INTERNAL_AGENT_VIEW_SUPERVISOR_ARG,
    ]);
    startedProcess.unref?.();
    await waitForSpawnedSupervisorReady(startedProcess, socketPath, options);
    return createSupervisorHandle(
      socketPath,
      startedProcess,
      await readSupervisorAuthToken(options),
    );
  });
}

async function retireIncompatibleSupervisor(
  options: EnsureAgentViewSupervisorOptions,
): Promise<void> {
  const supervisor = await readAgentViewSupervisor({
    ...(options.globalDir ? { globalDir: options.globalDir } : {}),
  });
  if (
    !supervisor ||
    supervisor.protocolVersion === AGENT_VIEW_PROTOCOL_VERSION
  ) {
    return;
  }

  const statusResponse = await requestAgentViewSupervisor(
    supervisor.socketPath,
    {
      id: randomUUID(),
      op: 'status',
      protocolVersion: supervisor.protocolVersion,
      ...(supervisor.authToken ? { authToken: supervisor.authToken } : {}),
    },
    { timeoutMs: 1000 },
  ).catch(() => undefined);
  if (!statusResponse?.ok) {
    if (isProcessRunning(supervisor.pid)) {
      throw new Error(
        'An incompatible Agent View supervisor is still running and could ' +
          'not be authenticated for replacement.',
      );
    }
    return;
  }
  if (supervisor.protocolVersion > AGENT_VIEW_PROTOCOL_VERSION) {
    throw new Error(
      `Agent View supervisor protocol ${supervisor.protocolVersion} ` +
        'is newer than this CLI supports.',
    );
  }

  const shutdownResponse = await requestAgentViewSupervisor(
    supervisor.socketPath,
    {
      id: randomUUID(),
      op: 'shutdown',
      protocolVersion: supervisor.protocolVersion,
      ...(supervisor.authToken ? { authToken: supervisor.authToken } : {}),
    },
    { timeoutMs: 1000 },
  ).catch(() => undefined);
  if (!shutdownResponse?.ok) {
    throw new Error('The incompatible Agent View supervisor refused shutdown.');
  }

  if (await waitForProcessExit(supervisor.pid, 2000)) return;
  if (supervisor.pid === process.pid) {
    throw new Error('Cannot replace the current Agent View supervisor.');
  }
  try {
    process.kill(supervisor.pid, 'SIGTERM');
  } catch (error) {
    if (!isMissingProcessError(error)) throw error;
  }
  if (!(await waitForProcessExit(supervisor.pid, 2000))) {
    throw new Error('The incompatible Agent View supervisor did not stop.');
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await delay(50);
  }
  return !isProcessRunning(pid);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcessError(error);
  }
}

function isMissingProcessError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}

export async function connectExistingAgentViewSupervisor(
  options: EnsureAgentViewSupervisorOptions = {},
): Promise<AgentViewSupervisorClientHandle | undefined> {
  const socketPath = getAgentViewSupervisorSocketPath({
    ...(options.globalDir ? { globalDir: options.globalDir } : {}),
  });
  if (!(await canReachSupervisor(socketPath, options))) {
    return undefined;
  }
  return createSupervisorHandle(
    socketPath,
    undefined,
    await readSupervisorAuthToken(options),
  );
}

export async function runAgentViewSupervisor(
  options: RunAgentViewSupervisorOptions = {},
): Promise<void> {
  const socketPath = getAgentViewSupervisorSocketPath({
    ...(options.globalDir ? { globalDir: options.globalDir } : {}),
  });
  const authToken = randomUUID();
  const startedAt = new Date().toISOString();
  let closeRequested = false;
  const handler = createAgentViewSupervisorHandler({
    ...(options.globalDir ? { globalDir: options.globalDir } : {}),
    ...(options.hibernationPolicy
      ? { hibernationPolicy: options.hibernationPolicy }
      : {}),
    spawnWorker: options.spawnWorker ?? defaultSpawnWorker(socketPath),
    onShutdown: () => {
      closeRequested = true;
      setImmediate(() => {
        void Promise.resolve(server.close()).catch(() => {});
      });
    },
  });
  const server = createAgentViewSupervisorServer(handler, {
    socketPath,
    authToken,
    authorizeSideband: handler.authorizeSideband,
  });

  await server.listen();
  await writeAgentViewSupervisor(
    {
      schemaVersion: 1,
      pid: process.pid,
      socketPath,
      authToken,
      startedAt,
      updatedAt: new Date().toISOString(),
      protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
    },
    options,
  );
  await new Promise<void>((resolve) => {
    const maintenanceInterval = setInterval(() => {
      void handler.tickIdleHibernation().catch(() => {});
    }, options.maintenanceIntervalMs ?? SUPERVISOR_MAINTENANCE_INTERVAL_MS);
    const onSigterm = () => {
      clearInterval(maintenanceInterval);
      clearInterval(closeInterval);
      void handler
        .disposeWorkers()
        .catch(() => {})
        .then(() => server.close())
        .catch(() => {})
        .finally(resolve);
    };
    const onSigint = () => {
      clearInterval(maintenanceInterval);
      clearInterval(closeInterval);
      void handler
        .disposeWorkers()
        .catch(() => {})
        .then(() => server.close())
        .catch(() => {})
        .finally(resolve);
    };
    const closeInterval = setInterval(() => {
      if (closeRequested) {
        clearInterval(maintenanceInterval);
        clearInterval(closeInterval);
        process.off('SIGTERM', onSigterm);
        process.off('SIGINT', onSigint);
        resolve();
      }
    }, 25);
    process.once('SIGTERM', onSigterm);
    process.once('SIGINT', onSigint);
  });
  await fs
    .unlink(
      getAgentViewStorePaths({
        ...(options.globalDir ? { globalDir: options.globalDir } : {}),
      }).supervisorPath,
    )
    .catch(() => {});
}

function createSupervisorHandle(
  socketPath: string,
  startedProcess?: ChildProcess,
  authToken?: string,
): AgentViewSupervisorClientHandle {
  const authOptions = authToken ? { authToken } : undefined;
  return {
    socketPath,
    ...(startedProcess ? { startedProcess } : {}),
    status: () =>
      callAgentViewSupervisor(socketPath, 'status', undefined, authOptions),
    list: (cwd?: string) =>
      callAgentViewSupervisor(
        socketPath,
        'list',
        cwd ? { cwd } : undefined,
        authOptions,
      ),
    subscribe: (onEvent, onError) =>
      subscribeAgentViewSupervisor(socketPath, onEvent, {
        ...authOptions,
        ...(onError ? { onError } : {}),
      }),
    dispatch: (params: AgentViewDispatchParams) =>
      callAgentViewSupervisor(socketPath, 'dispatch', params, {
        ...authOptions,
        timeoutMs: LONG_AGENT_VIEW_OPERATION_TIMEOUT_MS,
      }),
    adopt: (params) =>
      callAgentViewSupervisor(socketPath, 'adopt', params, {
        ...authOptions,
        timeoutMs: LONG_AGENT_VIEW_OPERATION_TIMEOUT_MS,
      }),
    attach: (sessionId: string) =>
      attachAgentViewSupervisorTerminal(socketPath, sessionId, authOptions),
    peek: (sessionId: string) =>
      callAgentViewSupervisor(socketPath, 'peek', { sessionId }, authOptions),
    send: (sessionId: string, turnId: string, text: string) =>
      callAgentViewSupervisor(
        socketPath,
        'send',
        { sessionId, turnId, text },
        authOptions,
      ),
    cancel: (sessionId: string) =>
      callAgentViewSupervisor(socketPath, 'cancel', { sessionId }, authOptions),
    answer: (
      sessionId: string,
      callId: string,
      outcome: AgentViewWorkerAnswerOutcome,
      payload?: AgentViewWorkerAnswerPayload,
    ) =>
      callAgentViewSupervisor(
        socketPath,
        'answer',
        {
          sessionId,
          callId,
          outcome,
          ...(payload ? { payload } : {}),
        },
        authOptions,
      ),
    logs: (sessionId: string) =>
      callAgentViewSupervisor(socketPath, 'logs', { sessionId }, authOptions),
    stop: (sessionId: string) =>
      callAgentViewSupervisor(socketPath, 'stop', { sessionId }, authOptions),
    kill: (sessionId: string) =>
      callAgentViewSupervisor(socketPath, 'kill', { sessionId }, authOptions),
    respawn: (sessionId?: string) =>
      callAgentViewSupervisor(
        socketPath,
        'respawn',
        sessionId ? { sessionId } : { all: true },
        {
          ...authOptions,
          timeoutMs: LONG_AGENT_VIEW_OPERATION_TIMEOUT_MS,
        },
      ),
    remove: (sessionId: string) =>
      callAgentViewSupervisor(socketPath, 'remove', { sessionId }, authOptions),
    pin: (sessionId: string, pinned?: boolean) =>
      callAgentViewSupervisor(
        socketPath,
        'pin',
        pinned === undefined ? { sessionId } : { sessionId, pinned },
        authOptions,
      ),
    rename: (sessionId: string, displayName: string) =>
      callAgentViewSupervisor(
        socketPath,
        'rename',
        {
          sessionId,
          displayName,
        },
        authOptions,
      ),
    shutdown: (keepWorkers?: boolean) =>
      callAgentViewSupervisor(
        socketPath,
        'shutdown',
        keepWorkers === undefined ? undefined : { keepWorkers },
        authOptions,
      ),
  };
}

async function waitForSpawnedSupervisorReady(
  startedProcess: ChildProcess,
  socketPath: string,
  options: EnsureAgentViewSupervisorOptions,
): Promise<void> {
  const waitAbort = new AbortController();
  let cleanup = () => {};
  const startupFailure = new Promise<never>((_, reject) => {
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(new Error(formatSupervisorStartupExit(code, signal)));
    };
    cleanup = () => {
      startedProcess.off?.('error', fail);
      startedProcess.off?.('exit', onExit);
    };
    startedProcess.once?.('error', fail);
    startedProcess.once?.('exit', onExit);
  });

  try {
    await Promise.race([
      waitForSupervisor(socketPath, options, waitAbort.signal),
      startupFailure,
    ]);
  } finally {
    waitAbort.abort();
    cleanup();
  }
}

function formatSupervisorStartupExit(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (signal) {
    return `Agent View supervisor exited before becoming ready with signal ${signal}.`;
  }
  return `Agent View supervisor exited before becoming ready with code ${code ?? 'unknown'}.`;
}

async function withSupervisorStartLock(
  options: EnsureAgentViewSupervisorOptions,
  socketPath: string,
  startSupervisor: () => Promise<AgentViewSupervisorClientHandle>,
  allowStaleLockCleanup = true,
): Promise<AgentViewSupervisorClientHandle> {
  const lockPath = getSupervisorStartLockPath(options);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    await fs.mkdir(lockPath);
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    try {
      await waitForSupervisor(socketPath, options);
      return createSupervisorHandle(
        socketPath,
        undefined,
        await readSupervisorAuthToken(options),
      );
    } catch (waitError) {
      if (!allowStaleLockCleanup) throw waitError;
      await fs.rm(lockPath, { recursive: true, force: true });
      return withSupervisorStartLock(
        options,
        socketPath,
        startSupervisor,
        false,
      );
    }
  }

  try {
    return await startSupervisor();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

function getSupervisorStartLockPath(
  options: EnsureAgentViewSupervisorOptions,
): string {
  return path.join(
    getAgentViewStorePaths({
      ...(options.globalDir ? { globalDir: options.globalDir } : {}),
    }).daemonDir,
    'supervisor.lock',
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

async function canReachSupervisor(
  socketPath: string,
  options: EnsureAgentViewSupervisorOptions,
): Promise<boolean> {
  try {
    const response = await requestStatus(
      socketPath,
      250,
      await readSupervisorAuthToken(options),
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForSupervisor(
  socketPath: string,
  options: EnsureAgentViewSupervisorOptions,
  signal?: AbortSignal,
): Promise<void> {
  const deadlineMs =
    Date.now() + SUPERVISOR_READY_RETRIES * SUPERVISOR_READY_DELAY_MS;
  while (Date.now() < deadlineMs) {
    if (signal?.aborted) {
      throw new Error('Agent View supervisor startup was cancelled.');
    }
    if (await canReachSupervisor(socketPath, options)) return;
    if (signal?.aborted) {
      throw new Error('Agent View supervisor startup was cancelled.');
    }
    await delay(SUPERVISOR_READY_DELAY_MS);
  }
  throw new Error('Agent View supervisor did not become ready.');
}

function requestStatus(
  socketPath: string,
  timeoutMs: number,
  authToken: string | undefined,
): Promise<AgentViewSupervisorResponse> {
  return requestAgentViewSupervisor(
    socketPath,
    {
      id: randomUUID(),
      op: 'status',
    },
    { timeoutMs, ...(authToken ? { authToken } : {}) },
  );
}

async function readSupervisorAuthToken(
  options: EnsureAgentViewSupervisorOptions,
): Promise<string | undefined> {
  return (
    await readAgentViewSupervisor({
      ...(options.globalDir ? { globalDir: options.globalDir } : {}),
    })
  )?.authToken;
}

function defaultSpawnSupervisor(args: readonly string[]): ChildProcess {
  const argv = buildCurrentQwenCliArgv(args);
  // The supervisor is detached from the leader's terminal, so its output has
  // nowhere to go but a file. Without this a supervisor that dies during
  // startup is completely silent.
  const logFd = openFleetLogFd(getAgentViewStorePaths().supervisorLogPath, {
    role: 'supervisor',
    argv: argv.join(' '),
  });
  try {
    return spawn(argv[0]!, argv.slice(1), {
      detached: true,
      stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
      env: {
        ...sanitizeChildEnv(process.env),
        QWEN_CODE_NO_RELAUNCH: '1',
      },
    });
  } finally {
    closeFleetLogFd(logFd);
  }
}

function defaultSpawnWorker(socketPath: string): AgentViewWorkerSpawner {
  return async ({ params, workerToken }) => {
    const argv = buildCurrentQwenCliArgv([INTERNAL_FLEET_TEAMMATE_ARG]);
    const logPath = getAgentViewSessionPaths(params.sessionId).logPath;
    // Same reasoning as the supervisor: the leader owns the TUI, so a teammate
    // that fails before it can reach the socket can only report through here.
    const logFd = openFleetLogFd(logPath, {
      role: 'teammate',
      sessionId: params.sessionId,
      cwd: params.activeCwd,
      argv: argv.join(' '),
    });
    let child: ChildProcess;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: params.activeCwd,
        stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
        env: {
          ...sanitizeChildEnv(process.env),
          QWEN_CODE_NO_RELAUNCH: '1',
          [QWEN_FLEET_SUPERVISOR_SOCKET_ENV]: socketPath,
          [QWEN_FLEET_WORKER_TOKEN_ENV]: workerToken,
          [QWEN_FLEET_WORKER_SPEC_PATH_ENV]: params.specPath,
        },
      });
    } finally {
      closeFleetLogFd(logFd);
    }
    await waitForChildSpawn(child);
    fleetDebug('runtime', 'teammate spawned', {
      sessionId: params.sessionId,
      pid: child.pid,
      log: logPath,
    });
    return {
      pid: child.pid,
      stop: () => terminateWorker(child, false),
      kill: () => terminateWorker(child, true),
      onExit: (listener) => {
        let reported = false;
        const report = (code: number | null) => {
          if (reported) return;
          reported = true;
          listener(code);
        };
        const onError = () => report(1);
        child.on('exit', report);
        child.on('error', onError);
        if (child.exitCode !== null || child.signalCode !== null) {
          queueMicrotask(() => report(child.exitCode ?? 1));
        }
        return () => {
          child.off('exit', report);
          child.off('error', onError);
        };
      },
    };
  };
}

function waitForChildSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

async function terminateWorker(
  child: ChildProcess,
  force: boolean,
): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform !== 'win32') {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
    return;
  }
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
  const killed = await new Promise<boolean>((resolve) => {
    const killer = spawn(
      taskkill,
      ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])],
      { stdio: 'ignore', windowsHide: true },
    );
    killer.once('exit', (code) => resolve(code === 0));
    killer.once('error', () => resolve(false));
  });
  if (!killed) child.kill(force ? 'SIGKILL' : 'SIGTERM');
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
