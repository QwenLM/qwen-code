/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callAgentViewSupervisor } from './supervisor-client.js';
import { getAgentViewSupervisorSocketPath } from './supervisor-process.js';
import {
  connectExistingAgentViewSupervisor,
  INTERNAL_AGENT_VIEW_SUPERVISOR_ARG,
  ensureAgentViewSupervisor,
  runAgentViewSupervisor,
} from './supervisor-runner.js';
import type {
  AgentViewSupervisorHandler,
  AgentViewSupervisorServerHandle,
} from './supervisor-server.js';
import { createAgentViewSupervisorServer } from './supervisor-server.js';
import {
  readAgentViewSupervisor,
  writeAgentViewSessionState,
} from './supervisor-store.js';

const cleanupDirs: string[] = [];
const cleanupServers: AgentViewSupervisorServerHandle[] = [];

afterEach(async () => {
  await Promise.allSettled(
    cleanupServers.splice(0).map((server) => server.close()),
  );
  await Promise.all(
    cleanupDirs
      .splice(0)
      .map((entry) => fs.rm(entry, { recursive: true, force: true })),
  );
});

describe('Agent View supervisor runner', () => {
  it('returns undefined when no existing supervisor is reachable', async () => {
    const { globalDir } = await makeSupervisorPath();

    await expect(
      connectExistingAgentViewSupervisor({ globalDir }),
    ).resolves.toBeUndefined();
  });

  it('connects to an existing supervisor handle', async () => {
    const { globalDir, socketPath } = await makeSupervisorPath();
    const server = createFakeSupervisor(socketPath, {
      status: () => ({ state: 'ready' }),
      list: () => [],
      shutdown: () => ({ shuttingDown: true }),
    });
    await server.listen();
    cleanupServers.push(server);

    const handle = await connectExistingAgentViewSupervisor({ globalDir });

    expect(handle).toBeDefined();
    if (!handle) throw new Error('Expected existing supervisor handle.');
    expect(handle.socketPath).toBe(socketPath);
    expect(handle.startedProcess).toBeUndefined();
    await expect(handle.status()).resolves.toEqual({ state: 'ready' });
  });

  it('connects to an existing supervisor without spawning a process', async () => {
    const { globalDir, socketPath } = await makeSupervisorPath();
    const server = createFakeSupervisor(socketPath, {
      status: () => ({ state: 'ready' }),
      list: () => [],
      shutdown: () => ({ shuttingDown: true }),
    });
    await server.listen();
    cleanupServers.push(server);
    const spawnProcess = vi.fn(() => createFakeProcess());

    const handle = await ensureAgentViewSupervisor({
      globalDir,
      spawnProcess,
    });

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(handle.socketPath).toBe(socketPath);
    expect(handle.startedProcess).toBeUndefined();
    await expect(handle.status()).resolves.toEqual({ state: 'ready' });
  });

  it('spawns through the injected process factory and waits for readiness', async () => {
    const { globalDir, socketPath } = await makeSupervisorPath();
    const startedProcess = createFakeProcess();
    const server = createFakeSupervisor(socketPath, {
      status: () => ({ state: 'spawned' }),
      list: () => [],
      shutdown: () => ({ shuttingDown: true }),
    });
    const spawnProcess = vi.fn((args: readonly string[]) => {
      expect(args).toEqual([INTERNAL_AGENT_VIEW_SUPERVISOR_ARG]);
      void server.listen();
      cleanupServers.push(server);
      return startedProcess;
    });

    const handle = await ensureAgentViewSupervisor({
      globalDir,
      spawnProcess,
    });

    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(startedProcess.unref).toHaveBeenCalledOnce();
    expect(handle.socketPath).toBe(socketPath);
    expect(handle.startedProcess).toBe(startedProcess);
    await expect(handle.status()).resolves.toEqual({ state: 'spawned' });
  });

  it('rejects promptly when the spawned supervisor emits an error', async () => {
    const { globalDir } = await makeSupervisorPath();
    const startedProcess = createFakeProcess();
    const spawnError = new Error('spawn failed');

    const result = ensureAgentViewSupervisor({
      globalDir,
      spawnProcess: vi.fn(() => {
        setImmediate(() => startedProcess.emit('error', spawnError));
        return startedProcess;
      }),
    });

    await expect(result).rejects.toThrow('spawn failed');
    expect(startedProcess.unref).toHaveBeenCalledOnce();
  });

  it('rejects promptly when the spawned supervisor exits before readiness', async () => {
    const { globalDir } = await makeSupervisorPath();
    const startedProcess = createFakeProcess();

    const result = ensureAgentViewSupervisor({
      globalDir,
      spawnProcess: vi.fn(() => {
        setImmediate(() => startedProcess.emit('exit', 1, null));
        return startedProcess;
      }),
    });

    await expect(result).rejects.toThrow(
      'Agent View supervisor exited before becoming ready with code 1.',
    );
    expect(startedProcess.unref).toHaveBeenCalledOnce();
  });

  it('routes handle status/list/dispatch/shutdown calls through IPC', async () => {
    const { globalDir, socketPath } = await makeSupervisorPath();
    const handler = {
      status: vi.fn(() => ({ state: 'ok' })),
      list: vi.fn(() => [{ sessionId: 'session-1' }]),
      subscribe: vi.fn((_params, socket: import('node:net').Socket) => {
        socket.write(
          `${JSON.stringify({
            id: 'subscription',
            ok: true,
            result: { subscribed: true },
          })}\n`,
        );
        socket.write(
          `${JSON.stringify({
            type: 'changed',
            at: '2026-07-17T00:00:00.000Z',
          })}\n`,
        );
      }),
      dispatch: vi.fn(() => ({ sessionId: 'session-2' })),
      adopt: vi.fn(() => ({ sessionId: 'session-2', adopted: true })),
      peek: vi.fn(() => ({ sessionId: 'session-3' })),
      send: vi.fn(() => ({ sent: true })),
      answer: vi.fn(() => ({ answered: true })),
      logs: vi.fn(() => ({ logs: ['line-1'] })),
      stop: vi.fn(() => ({ stopped: true })),
      kill: vi.fn(() => ({ killed: true })),
      remove: vi.fn(() => ({ removed: true })),
      respawn: vi.fn(() => ({ respawned: true })),
      pin: vi.fn(() => ({ sessionId: 'session-3', pinned: true })),
      rename: vi.fn(() => ({
        sessionId: 'session-3',
        displayName: 'Build Fix',
      })),
      shutdown: vi.fn(() => ({ shuttingDown: true })),
    } satisfies AgentViewSupervisorHandler;
    const server = createFakeSupervisor(socketPath, handler);
    await server.listen();
    cleanupServers.push(server);

    const handle = await ensureAgentViewSupervisor({
      globalDir,
      spawnProcess: vi.fn(() => createFakeProcess()),
    });
    handler.status.mockClear();

    await expect(handle.status()).resolves.toEqual({ state: 'ok' });
    expect(handler.status).toHaveBeenCalledWith(undefined);

    await expect(handle.list('/workspace/project')).resolves.toEqual([
      { sessionId: 'session-1' },
    ]);
    expect(handler.list).toHaveBeenCalledWith({ cwd: '/workspace/project' });

    const eventCallback = vi.fn();
    const subscription = handle.subscribe(eventCallback);
    await waitFor(() => handler.subscribe.mock.calls.length === 1);
    await waitFor(() => eventCallback.mock.calls.length === 1);
    expect(eventCallback).toHaveBeenCalledWith({
      type: 'changed',
      at: '2026-07-17T00:00:00.000Z',
    });
    subscription.dispose();

    await expect(
      handle.dispatch('write tests', '/workspace/project'),
    ).resolves.toEqual({ sessionId: 'session-2' });
    expect(handler.dispatch).toHaveBeenCalledWith({
      prompt: 'write tests',
      cwd: '/workspace/project',
    });

    await expect(
      handle.adopt({
        sessionId: 'session-2',
        projectCwd: '/workspace/project',
        activeCwd: '/workspace/project',
        approvalMode: 'default',
        terminal: { columns: 80, rows: 24 },
      }),
    ).resolves.toEqual({ sessionId: 'session-2', adopted: true });
    expect(handler.adopt).toHaveBeenCalledWith({
      sessionId: 'session-2',
      projectCwd: '/workspace/project',
      activeCwd: '/workspace/project',
      approvalMode: 'default',
      terminal: { columns: 80, rows: 24 },
    });

    await expect(handle.peek('session-3')).resolves.toEqual({
      sessionId: 'session-3',
    });
    expect(handler.peek).toHaveBeenCalledWith({ sessionId: 'session-3' });

    await expect(handle.send('session-3', 'next')).resolves.toEqual({
      sent: true,
    });
    expect(handler.send).toHaveBeenCalledWith({
      sessionId: 'session-3',
      text: 'next',
    });

    await expect(handle.answer('session-3', 'yes')).resolves.toEqual({
      answered: true,
    });
    expect(handler.answer).toHaveBeenCalledWith({
      sessionId: 'session-3',
      text: 'yes',
    });

    await expect(handle.logs('session-3')).resolves.toEqual({
      logs: ['line-1'],
    });
    expect(handler.logs).toHaveBeenCalledWith({ sessionId: 'session-3' });

    await expect(handle.stop('session-3')).resolves.toEqual({
      stopped: true,
    });
    expect(handler.stop).toHaveBeenCalledWith({ sessionId: 'session-3' });

    await expect(handle.kill('session-3')).resolves.toEqual({
      killed: true,
    });
    expect(handler.kill).toHaveBeenCalledWith({ sessionId: 'session-3' });

    await expect(handle.remove('session-3')).resolves.toEqual({
      removed: true,
    });
    expect(handler.remove).toHaveBeenCalledWith({ sessionId: 'session-3' });

    await expect(handle.respawn('session-3')).resolves.toEqual({
      respawned: true,
    });
    expect(handler.respawn).toHaveBeenCalledWith({ sessionId: 'session-3' });

    await expect(handle.respawn()).resolves.toEqual({ respawned: true });
    expect(handler.respawn).toHaveBeenCalledWith({ all: true });

    await expect(handle.pin('session-3')).resolves.toEqual({
      sessionId: 'session-3',
      pinned: true,
    });
    expect(handler.pin).toHaveBeenCalledWith({ sessionId: 'session-3' });

    await expect(handle.pin('session-3', false)).resolves.toEqual({
      sessionId: 'session-3',
      pinned: true,
    });
    expect(handler.pin).toHaveBeenCalledWith({
      sessionId: 'session-3',
      pinned: false,
    });

    await expect(handle.rename('session-3', 'Build Fix')).resolves.toEqual({
      sessionId: 'session-3',
      displayName: 'Build Fix',
    });
    expect(handler.rename).toHaveBeenCalledWith({
      sessionId: 'session-3',
      displayName: 'Build Fix',
    });

    await expect(handle.shutdown(true)).resolves.toEqual({
      shuttingDown: true,
    });
    expect(handler.shutdown).toHaveBeenCalledWith({ keepWorkers: true });

    await expect(handle.shutdown(false)).resolves.toEqual({
      shuttingDown: true,
    });
    expect(handler.shutdown).toHaveBeenCalledWith({ keepWorkers: false });
  });

  it('closes the supervisor server when shutdown is requested', async () => {
    const { globalDir, socketPath } = await makeSupervisorPath();
    const supervisorPromise = runAgentViewSupervisor({ globalDir });

    await waitForSupervisor(socketPath, globalDir);
    await expect(readAgentViewSupervisor({ globalDir })).resolves.toMatchObject(
      {
        pid: process.pid,
        socketPath,
        authToken: expect.any(String),
        protocolVersion: 1,
      },
    );
    const authToken = await readAuthToken(globalDir);
    await expect(
      callAgentViewSupervisor(socketPath, 'shutdown', undefined, {
        authToken,
      }),
    ).resolves.toEqual({
      shuttingDown: true,
      workersStopped: 0,
    });
    await supervisorPromise;

    await expectSupervisorUnreachable(socketPath, authToken);
  });

  it('auto-exits when maintenance sees only hibernated managed sessions', async () => {
    const { globalDir, socketPath } = await makeSupervisorPath();
    const supervisorPromise = runAgentViewSupervisor({
      globalDir,
      maintenanceIntervalMs: 10,
      hibernationPolicy: { autoExitGraceMs: 0 },
    });

    await waitForSupervisor(socketPath, globalDir);
    const authToken = await readAuthToken(globalDir);
    await writeHibernatedSessionForTest(globalDir, 'session-1');
    await supervisorPromise;

    await expectSupervisorUnreachable(socketPath, authToken);
  });
});

function createFakeSupervisor(
  socketPath: string,
  handler: AgentViewSupervisorHandler,
): AgentViewSupervisorServerHandle {
  return createAgentViewSupervisorServer(handler, { socketPath });
}

function createFakeProcess(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    unref: vi.fn(),
  }) as unknown as ChildProcess;
}

async function makeSupervisorPath(): Promise<{
  globalDir: string;
  socketPath: string;
}> {
  const globalDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-agent-view-runner-'),
  );
  cleanupDirs.push(globalDir);
  return {
    globalDir,
    socketPath: getAgentViewSupervisorSocketPath({
      globalDir,
      platform: process.platform,
    }),
  };
}

async function writeHibernatedSessionForTest(
  globalDir: string,
  sessionId: string,
): Promise<void> {
  await writeAgentViewSessionState(
    {
      schemaVersion: 1,
      sessionId,
      ownership: 'managed',
      sessionState: 'idle',
      processState: 'hibernated',
      attachState: 'detached',
      projectCwd: globalDir,
      originalCwd: globalDir,
      activeCwd: globalDir,
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
      worktree: { mode: 'none' },
    },
    { globalDir },
  );
}

async function waitForSupervisor(
  socketPath: string,
  globalDir: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await callAgentViewSupervisor(socketPath, 'status', undefined, {
        authToken: await readAuthToken(globalDir),
        timeoutMs: 100,
      });
      return;
    } catch {
      await delay(25);
    }
  }
  throw new Error('Timed out waiting for test supervisor.');
}

async function readAuthToken(globalDir: string): Promise<string | undefined> {
  return (await readAgentViewSupervisor({ globalDir }))?.authToken;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for supervisor runner test condition.');
}

async function expectSupervisorUnreachable(
  socketPath: string,
  authToken: string | undefined,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await callAgentViewSupervisor(socketPath, 'status', undefined, {
        authToken,
        timeoutMs: 100,
      });
    } catch {
      return;
    }
    await delay(25);
  }
  throw new Error('Expected test supervisor to stop accepting connections.');
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
