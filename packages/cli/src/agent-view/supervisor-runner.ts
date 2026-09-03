/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  attachAgentViewSupervisorTerminal,
  callAgentViewSupervisor,
  requestAgentViewSupervisor,
  subscribeAgentViewSupervisor,
} from './supervisor-client.js';
import { AGENT_VIEW_PROTOCOL_VERSION } from './protocol.js';
import type {
  AgentViewSupervisorAdoptParams,
  AgentViewSupervisorEvent,
  AgentViewSupervisorResponse,
  AgentViewSupervisorSubscription,
} from './supervisor-client.js';
import {
  createAgentViewSupervisorHandler,
  getAgentViewSupervisorSocketPath,
  requireValidWorkerToken,
} from './supervisor-process.js';
import type { AgentViewSupervisorHibernationPolicy } from './supervisor-process.js';
import { createAgentViewSupervisorServer } from './supervisor-server.js';
import type { AgentViewSidebandAuthorizer } from './supervisor-server.js';
import {
  getAgentViewStorePaths,
  readAgentViewSupervisor,
  writeAgentViewSupervisor,
} from './supervisor-store.js';
import { buildCurrentQwenCliArgv } from './current-cli-argv.js';
import { INTERNAL_AGENT_VIEW_SUPERVISOR_ARG } from './entry-flags.js';

export { INTERNAL_AGENT_VIEW_SUPERVISOR_ARG } from './entry-flags.js';

const SUPERVISOR_READY_RETRIES = 600;
const SUPERVISOR_READY_DELAY_MS = 50;
const SUPERVISOR_MAINTENANCE_INTERVAL_MS = 5000;
const LONG_AGENT_VIEW_OPERATION_TIMEOUT_MS = 30_000;
const AGENT_VIEW_SHUTDOWN_TIMEOUT_MS = 60_000;

export interface AgentViewSupervisorClientHandle {
  socketPath: string;
  startedProcess?: ChildProcess;
  status(): Promise<unknown>;
  list(cwd?: string): Promise<unknown>;
  subscribe(
    onEvent: (event: AgentViewSupervisorEvent) => void,
    onError?: (error: Error) => void,
  ): AgentViewSupervisorSubscription;
  dispatch(prompt: string, cwd: string): Promise<unknown>;
  adopt(params: AgentViewSupervisorAdoptParams): Promise<unknown>;
  attach(sessionId: string): Promise<unknown>;
  peek(sessionId: string): Promise<unknown>;
  send(sessionId: string, text: string): Promise<unknown>;
  answer(sessionId: string, text: string): Promise<unknown>;
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
  let closeServer = (): Promise<void> => Promise.resolve();
  const handler = createAgentViewSupervisorHandler({
    ...(options.globalDir ? { globalDir: options.globalDir } : {}),
    ...(options.hibernationPolicy
      ? { hibernationPolicy: options.hibernationPolicy }
      : {}),
    onShutdown: () => {
      closeRequested = true;
      setImmediate(() => {
        void closeServer().catch(() => {});
      });
    },
  });
  const authorizeSideband: AgentViewSidebandAuthorizer = async (
    _op,
    params,
  ) => {
    const sessionId = params?.['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    try {
      await requireValidWorkerToken(
        sessionId,
        params,
        options.globalDir ? { globalDir: options.globalDir } : {},
      );
      return true;
    } catch {
      return false;
    }
  };
  const server = createAgentViewSupervisorServer(handler, {
    socketPath,
    authToken,
    authorizeSideband,
  });
  let serverClosePromise: Promise<void> | undefined;
  closeServer = () => (serverClosePromise ??= server.close());

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
      void closeServer()
        .catch(() => {})
        .finally(resolve);
    };
    const onSigint = () => {
      clearInterval(maintenanceInterval);
      clearInterval(closeInterval);
      void closeServer()
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
  await closeServer().catch(() => {});
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
    dispatch: (prompt: string, cwd: string) =>
      callAgentViewSupervisor(
        socketPath,
        'dispatch',
        { prompt, cwd },
        {
          ...authOptions,
          timeoutMs: LONG_AGENT_VIEW_OPERATION_TIMEOUT_MS,
        },
      ),
    adopt: (params) =>
      callAgentViewSupervisor(socketPath, 'adopt', params, {
        ...authOptions,
        timeoutMs: LONG_AGENT_VIEW_OPERATION_TIMEOUT_MS,
      }),
    attach: (sessionId: string) =>
      attachAgentViewSupervisorTerminal(socketPath, sessionId, authOptions),
    peek: (sessionId: string) =>
      callAgentViewSupervisor(socketPath, 'peek', { sessionId }, authOptions),
    send: (sessionId: string, text: string) =>
      callAgentViewSupervisor(
        socketPath,
        'send',
        { sessionId, text },
        {
          ...authOptions,
          timeoutMs: LONG_AGENT_VIEW_OPERATION_TIMEOUT_MS,
        },
      ),
    answer: (sessionId: string, text: string) =>
      callAgentViewSupervisor(
        socketPath,
        'answer',
        { sessionId, text },
        {
          ...authOptions,
          timeoutMs: LONG_AGENT_VIEW_OPERATION_TIMEOUT_MS,
        },
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
        {
          ...authOptions,
          timeoutMs: AGENT_VIEW_SHUTDOWN_TIMEOUT_MS,
        },
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
  return spawn(argv[0]!, argv.slice(1), {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      QWEN_CODE_NO_RELAUNCH: '1',
    },
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
