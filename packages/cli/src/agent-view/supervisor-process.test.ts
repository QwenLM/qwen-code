/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Socket } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_VIEW_ATTACH_LEASE_TTL_MS } from './attach-lease.js';
import { AGENT_VIEW_PROTOCOL_VERSION } from './protocol.js';
import type {
  AgentViewLaunchFile,
  AgentViewSessionStateFile,
} from './protocol.js';
import {
  createAgentViewSupervisorHandler as createAgentViewSupervisorHandlerImpl,
  getAgentViewSupervisorSocketPath,
  getAgentViewSupervisorStaleSocketPath,
} from './supervisor-process.js';
import {
  readAgentViewActivity,
  readAgentViewLaunch,
  readAgentViewRoster,
  readAgentViewSessionState,
  readAgentViewWorker,
  writeAgentViewActivity,
  writeAgentViewLaunch,
  writeAgentViewWorker,
  writeAgentViewSessionState,
} from './supervisor-store.js';
import type { AgentViewPtyHostHandle } from './pty-host.js';
import { BoundedOutputRing } from './pty-host.js';
import { createAgentViewPtyHostServer } from './pty-host-process.js';
import { QWEN_AGENT_VIEW_TOKEN } from './worker-sideband.js';

const workerTokensForTest = new Map<string, string>();

type AgentViewSupervisorHandlerForTest = Omit<
  ReturnType<typeof createAgentViewSupervisorHandlerImpl>,
  'workerEvent'
> & {
  workerEvent?(params?: Record<string, unknown>): Promise<unknown>;
};

function createAgentViewSupervisorHandler(
  options: NonNullable<
    Parameters<typeof createAgentViewSupervisorHandlerImpl>[0]
  >,
): AgentViewSupervisorHandlerForTest {
  const launchPtyHost = options.launchPtyHost;
  const handler = createAgentViewSupervisorHandlerImpl({
    ...options,
    ...(launchPtyHost
      ? {
          launchPtyHost: async (
            launch: AgentViewLaunchFile,
            workerEnv?: Readonly<Record<string, string>>,
          ) => {
            const token = workerEnv?.[QWEN_AGENT_VIEW_TOKEN];
            if (token) workerTokensForTest.set(launch.sessionId, token);
            return launchPtyHost(launch, workerEnv);
          },
        }
      : {}),
  });
  const testHandler = handler as AgentViewSupervisorHandlerForTest;
  const workerEvent = testHandler.workerEvent?.bind(handler);
  if (workerEvent) {
    testHandler.workerEvent = async (params) => {
      const sessionId = params?.['sessionId'];
      const worker =
        typeof sessionId === 'string'
          ? await readAgentViewWorker(sessionId, {
              ...(options.globalDir ? { globalDir: options.globalDir } : {}),
            })
          : undefined;
      return workerEvent({
        ...params,
        workerGeneration:
          params?.['workerGeneration'] ?? worker?.workerGeneration,
        sequence: params?.['sequence'] ?? (worker?.lastSequence ?? -1) + 1,
      });
    };
  }
  return testHandler;
}

describe('Agent View supervisor process helpers', () => {
  it('computes a stable Unix socket path under the Agent View store', () => {
    const globalDir = path.join(os.tmpdir(), 'qwen-agent-view-paths');

    expect(
      getAgentViewSupervisorSocketPath({
        globalDir,
        platform: 'linux',
      }),
    ).toBe(path.join(globalDir, 'daemon', 'supervisor.sock'));
  });

  it('falls back to a short runtime socket path when the store path is long', () => {
    const runtimeDir = os.tmpdir();
    const socketPath = getAgentViewSupervisorSocketPath({
      globalDir: path.join(runtimeDir, 'a'.repeat(140)),
      platform: 'linux',
      runtimeDir,
    });

    expect(path.dirname(socketPath)).toEqual(
      expect.stringMatching(
        new RegExp(`^${escapeRegExp(runtimeDir)}${escapeRegExp(path.sep)}`),
      ),
    );
    expect(path.basename(socketPath)).toMatch(/^[a-z0-9-]+\.sock$/);
    expect(Buffer.byteLength(socketPath)).toBeLessThan(100);
  });

  it('uses a private runtime fallback directory by default', () => {
    const socketPath = getAgentViewSupervisorSocketPath({
      globalDir: path.join(os.tmpdir(), 'a'.repeat(140)),
      platform: 'linux',
    });
    expect(path.dirname(socketPath)).toEqual(
      expect.stringMatching(
        new RegExp(`^${escapeRegExp(os.tmpdir())}${escapeRegExp(path.sep)}`),
      ),
    );
    expect(path.basename(socketPath)).toMatch(/^[a-z0-9-]+\.sock$/);
    expect(Buffer.byteLength(socketPath)).toBeLessThan(100);
  });

  it('computes a Windows named pipe path', () => {
    expect(
      getAgentViewSupervisorSocketPath({
        globalDir: 'C:\\Users\\test\\.qwen',
        platform: 'win32',
      }),
    ).toMatch(/^\\\\\.\\pipe\\qwen-agent-view-[a-f0-9]{16}$/);
  });

  it('computes stale socket paths without exceeding the Unix path limit', () => {
    expect(
      getAgentViewSupervisorStaleSocketPath(
        '/tmp/qwen-agent-view.sock',
        'pid:42',
      ),
    ).toBe('/tmp/qwen-agent-view.sock.stale-pid_42');

    const longPath = path.join('/tmp', `${'a'.repeat(120)}.sock`);
    const stalePath = getAgentViewSupervisorStaleSocketPath(longPath, 'pid:42');
    expect(stalePath).toMatch(
      /^\/tmp\/qwen-agent-view-stale-[a-f0-9]{16}\.sock$/,
    );
    expect(Buffer.byteLength(stalePath)).toBeLessThan(100);
  });

  it('creates a minimal default handler for status/list/shutdown', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const onShutdown = vi.fn();
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      onShutdown,
    });

    expect(await handler.status()).toMatchObject({
      protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
      pid: process.pid,
    });
    await expect(handler.list()).resolves.toEqual([]);
    await expect(handler.shutdown()).resolves.toEqual({
      shuttingDown: true,
      workersStopped: 0,
    });
    expect(onShutdown).toHaveBeenCalledOnce();

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('dispatches a managed session into the Agent View store', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    let launchedArgv: string[] | undefined;
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async (launch) => {
        launchedArgv = launch.argv;
        return fakePtyHost();
      },
    });

    const result = await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    });

    expect(result).toMatchObject({ state: 'created' });
    const sessionId = (result as { sessionId: string }).sessionId;
    await expect(
      readAgentViewSessionState(sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionId,
      ownership: 'managed',
      sessionState: 'starting',
      processState: 'starting',
    });
    await expect(
      readAgentViewActivity(sessionId, { globalDir }),
    ).resolves.toMatchObject({
      summary: 'write tests',
    });
    await expect(
      readAgentViewLaunch(sessionId, { globalDir }),
    ).resolves.toMatchObject({
      argv: expect.arrayContaining([
        '--session-id',
        sessionId,
        '--prompt-interactive',
        'write tests',
      ]),
    });
    await expect(readAgentViewRoster({ globalDir })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId })],
    });
    await expect(
      readAgentViewWorker(sessionId, { globalDir }),
    ).resolves.toMatchObject({
      hostPid: process.pid,
      workerPid: 1234,
    });
    await expect(handler.list()).resolves.toEqual([
      expect.objectContaining({
        sessionId,
        state: expect.objectContaining({
          sessionId,
          sessionState: 'starting',
        }),
        activity: expect.objectContaining({
          summary: 'write tests',
        }),
        worker: expect.objectContaining({
          workerPid: 1234,
        }),
      }),
    ]);
    await expect(handler.peek?.({ sessionId })).resolves.toMatchObject({
      sessionId,
      state: expect.objectContaining({
        sessionId,
        sessionState: 'starting',
      }),
      activity: expect.objectContaining({
        summary: 'write tests',
      }),
      worker: expect.objectContaining({
        workerPid: 1234,
      }),
      live: true,
    });
    await expect(
      handler.peek?.({ sessionId: sessionId.slice(0, 8) }),
    ).resolves.toMatchObject({
      sessionId,
      state: expect.objectContaining({ sessionId }),
    });
    await expect(
      handler.peek?.({ sessionId: sessionId.slice(0, 8).toUpperCase() }),
    ).resolves.toMatchObject({
      sessionId,
      state: expect.objectContaining({ sessionId }),
    });
    expect(launchedArgv).toEqual(
      expect.arrayContaining([
        '--session-id',
        sessionId,
        '--prompt-interactive',
        'write tests',
      ]),
    );

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('waits for worker ready before completing dispatch when enabled', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    let launchedArgv: string[] | undefined;
    let token = '';
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      waitForWorkerReady: true,
      workerReadyTimeoutMs: 1000,
      launchPtyHost: async (launch, workerEnv) => {
        launchedArgv = launch.argv;
        token = workerEnv?.[QWEN_AGENT_VIEW_TOKEN] ?? '';
        setImmediate(() => {
          void Promise.resolve(
            handler.workerEvent?.({
              type: 'ready',
              sessionId: launch.sessionId,
              token,
              cwd: launch.activeCwd,
              at: '2026-07-17T00:00:00.000Z',
            }),
          ).catch(() => {});
        });
        return fakePtyHost();
      },
    });

    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };

    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'idle',
      processState: 'alive',
      activeCwd: globalDir,
      updatedAt: '2026-07-17T00:00:00.000Z',
    });
    expect(launchedArgv).not.toContain('write tests');
    await expect(
      handler.workerControl?.({ sessionId: result.sessionId, token }),
    ).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          type: 'prompt',
          text: 'write tests',
        }),
      ],
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('marks dispatch failed when the worker never reports ready', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    let sessionId = '';
    let host: FakePtyHost | undefined;
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      waitForWorkerReady: true,
      workerReadyTimeoutMs: 1,
      launchPtyHost: async (launch) => {
        sessionId = launch.sessionId;
        host = fakePtyHost();
        return host;
      },
    });

    await expect(
      handler.dispatch?.({
        prompt: 'write tests',
        cwd: globalDir,
      }),
    ).rejects.toThrow('did not report ready');
    await expect(
      readAgentViewSessionState(sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'failed',
      processState: 'exited',
      lastError: {
        code: 'pty_launch_failed',
        message: expect.stringContaining('did not report ready'),
      },
    });
    expect(host?.killedWith).toBe('SIGTERM');
    await expect(handler.peek?.({ sessionId })).resolves.toMatchObject({
      live: false,
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('dispatches another shared-directory session when the previous session is idle', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });

    const first = (await handler.dispatch?.({
      prompt: 'first',
      cwd: globalDir,
    })) as { sessionId: string };
    await writeSessionStateForTest(first.sessionId, globalDir, 'idle');
    await expect(
      handler.dispatch?.({
        prompt: 'second',
        cwd: globalDir,
      }),
    ).resolves.toMatchObject({
      state: 'created',
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('dispatches another shared-directory session while a previous session is working', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });

    const first = (await handler.dispatch?.({
      prompt: 'first',
      cwd: globalDir,
    })) as { sessionId: string };
    await writeSessionStateForTest(first.sessionId, globalDir, 'working');
    await expect(
      handler.dispatch?.({
        prompt: 'second',
        cwd: globalDir,
      }),
    ).resolves.toMatchObject({
      state: 'created',
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('dispatches another session even when an existing session uses a user-owned worktree', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await handler.dispatch?.({
      prompt: 'first',
      cwd: globalDir,
    })) as { sessionId: string };
    const state = await readAgentViewSessionState(result.sessionId, {
      globalDir,
    });
    if (!state) {
      throw new Error('Missing test session state.');
    }
    await writeAgentViewSessionState(
      {
        ...state,
        activeCwd: path.join(globalDir, '.qwen', 'worktrees', 'topic'),
        worktree: {
          mode: 'worktree',
          path: path.join(globalDir, '.qwen', 'worktrees', 'topic'),
          owner: 'user',
        },
      },
      { globalDir },
    );

    await expect(
      handler.dispatch?.({
        prompt: 'second',
        cwd: globalDir,
      }),
    ).resolves.toMatchObject({
      state: 'created',
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('adopts an existing idle session through a resumed native worker', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    let launched: string[] | undefined;
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async (launch) => {
        launched = launch.argv;
        return fakePtyHost();
      },
    });

    await expect(
      handler.adopt?.({
        sessionId,
        projectCwd: path.join(globalDir, 'project'),
        activeCwd: path.join(globalDir, 'project', 'src'),
        approvalMode: 'default',
        terminal: { columns: 100, rows: 40 },
      }),
    ).resolves.toEqual({ sessionId, adopted: true });

    expect(launched).toEqual([
      process.execPath,
      process.argv[1],
      '--resume',
      sessionId,
    ]);
    await expect(
      readAgentViewSessionState(sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionId,
      ownership: 'managed',
      sessionState: 'starting',
      processState: 'starting',
      attachState: 'detached',
      activeCwd: path.join(globalDir, 'project', 'src'),
      projectCwd: path.join(globalDir, 'project'),
      worktree: { mode: 'none' },
    });
    const adoptedLaunch = await readAgentViewLaunch(sessionId, { globalDir });
    expect(adoptedLaunch).toMatchObject({
      sessionId,
      argv: launched,
      activeCwd: path.join(globalDir, 'project', 'src'),
      projectCwd: path.join(globalDir, 'project'),
      approvalMode: 'default',
      terminal: { columns: 100, rows: 40 },
    });
    expect(adoptedLaunch?.env).not.toHaveProperty(QWEN_AGENT_VIEW_TOKEN);
    await expect(
      readAgentViewActivity(sessionId, { globalDir }),
    ).resolves.toMatchObject({
      summary: 'Backgrounded from native session',
    });
    await expect(readAgentViewRoster({ globalDir })).resolves.toMatchObject({
      sessions: [
        expect.objectContaining({
          sessionId,
          activeCwd: path.join(globalDir, 'project', 'src'),
          projectCwd: path.join(globalDir, 'project'),
        }),
      ],
    });
    await expect(
      readAgentViewWorker(sessionId, { globalDir }),
    ).resolves.toMatchObject({
      hostPid: process.pid,
      workerPid: 1234,
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('treats adoption of an already managed session as idempotent', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const sessionsBefore = (await handler.list()) as unknown[];

    await expect(
      handler.adopt?.({
        sessionId: result.sessionId,
        projectCwd: globalDir,
        activeCwd: globalDir,
        terminal: { columns: 80, rows: 24 },
      }),
    ).resolves.toEqual({
      sessionId: result.sessionId,
      adopted: false,
      alreadyManaged: true,
    });
    await expect(handler.list()).resolves.toHaveLength(sessionsBefore.length);

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('rolls back adoption when the resumed worker cannot be launched', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        throw new Error('spawn failed');
      },
    });

    await expect(
      handler.adopt?.({
        sessionId,
        projectCwd: path.join(globalDir, 'project'),
        activeCwd: path.join(globalDir, 'project'),
        terminal: { columns: 80, rows: 24 },
      }),
    ).rejects.toThrow('spawn failed');

    await expect(
      readAgentViewSessionState(sessionId, { globalDir }),
    ).resolves.toMatchObject({
      ownership: 'unmanaged',
      processState: 'exited',
      lastError: {
        code: 'adoption_failed',
        message: 'spawn failed',
      },
    });
    await expect(readAgentViewRoster({ globalDir })).resolves.toMatchObject({
      sessions: [],
    });
    await expect(handler.list()).resolves.toEqual([]);

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('rolls back adoption when the resumed worker reports a different cwd', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    let host: FakePtyHost | undefined;
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      waitForWorkerReady: true,
      workerReadyTimeoutMs: 1000,
      launchPtyHost: async (launch, workerEnv) => {
        setImmediate(() => {
          void Promise.resolve(
            handler.workerEvent?.({
              type: 'ready',
              sessionId: launch.sessionId,
              token: workerEnv?.[QWEN_AGENT_VIEW_TOKEN],
              cwd: path.join(globalDir, 'other'),
            }),
          ).catch(() => {});
        });
        host = fakePtyHost();
        return host;
      },
    });

    await expect(
      handler.adopt?.({
        sessionId,
        projectCwd: path.join(globalDir, 'project'),
        activeCwd: path.join(globalDir, 'project'),
        terminal: { columns: 80, rows: 24 },
      }),
    ).rejects.toThrow('reported cwd');

    await expect(
      readAgentViewSessionState(sessionId, { globalDir }),
    ).resolves.toMatchObject({
      ownership: 'unmanaged',
      processState: 'exited',
      lastError: {
        code: 'adoption_failed',
        message: expect.stringContaining('reported cwd'),
      },
    });
    await expect(readAgentViewRoster({ globalDir })).resolves.toMatchObject({
      sessions: [],
    });
    expect(host?.killedWith).toBe('SIGTERM');

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('applies worker sideband events to session state', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    await expect(
      handler.workerEvent?.({
        type: 'ready',
        sessionId: result.sessionId,
        token,
        cwd: globalDir,
        capabilities: ['ready'],
        summary: 'ready summary',
        at: '2026-07-17T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      sessionId: result.sessionId,
      accepted: true,
      workerGeneration: expect.any(String),
      sequence: 0,
    });
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'idle',
      processState: 'alive',
      activeCwd: globalDir,
      updatedAt: '2026-07-17T00:00:00.000Z',
    });
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      summary: 'ready summary',
      capabilities: ['ready'],
      lastActivityAt: '2026-07-17T00:00:00.000Z',
    });
    await expect(
      readAgentViewWorker(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      lastHeartbeatAt: '2026-07-17T00:00:00.000Z',
    });

    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'needs_input',
      waitingFor: 'approval',
      at: '2026-07-17T00:00:01.000Z',
    });
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'needs_input',
      processState: 'alive',
      updatedAt: '2026-07-17T00:00:01.000Z',
    });
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      waitingFor: 'approval',
      lastActivityAt: '2026-07-17T00:00:01.000Z',
    });

    const blockedState = await readAgentViewSessionState(result.sessionId, {
      globalDir,
    });
    if (!blockedState) {
      throw new Error('expected blocked state');
    }
    await writeAgentViewSessionState(
      {
        ...blockedState,
        lastError: {
          code: 'stale_worker',
          message: 'old failure',
          at: '2026-07-17T00:00:01.000Z',
        },
      },
      { globalDir },
    );
    await writeAgentViewActivity(
      result.sessionId,
      {
        schemaVersion: 1,
        waitingFor: 'approval',
        inputKind: 'blocking',
        lastResult: 'old result',
        queuedPromptCount: 1,
        queuedPromptPreview: 'old prompt',
        lastQueuedPromptAt: '2026-07-17T00:00:01.000Z',
        lastActivityAt: '2026-07-17T00:00:01.000Z',
        capabilities: ['ready'],
      },
      { globalDir },
    );
    await handler.workerEvent?.({
      type: 'ready',
      sessionId: result.sessionId,
      token,
      cwd: globalDir,
      capabilities: ['ready'],
      at: '2026-07-17T00:00:02.000Z',
    });
    const readyState = await readAgentViewSessionState(result.sessionId, {
      globalDir,
    });
    const readyActivity = await readAgentViewActivity(result.sessionId, {
      globalDir,
    });
    expect(readyState).not.toHaveProperty('lastError');
    expect(readyActivity).not.toHaveProperty('waitingFor');
    expect(readyActivity).not.toHaveProperty('inputKind');
    expect(readyActivity).not.toHaveProperty('lastResult');
    expect(readyActivity).not.toHaveProperty('queuedPromptCount');

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('rejects stale or out-of-order worker events and deduplicates retries', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await handler.dispatch?.({
      prompt: 'inspect tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    const worker = await readAgentViewWorker(result.sessionId, { globalDir });
    const workerGeneration = worker?.workerGeneration;
    if (!workerGeneration) throw new Error('expected worker generation');

    const ready = {
      type: 'ready',
      sessionId: result.sessionId,
      token,
      workerGeneration,
      sequence: 0,
      cwd: globalDir,
    } as const;
    await handler.workerEvent?.(ready);
    await expect(handler.workerEvent?.(ready)).resolves.toMatchObject({
      workerGeneration,
      sequence: 0,
    });
    await expect(
      handler.workerEvent?.({
        type: 'state',
        sessionId: result.sessionId,
        token,
        workerGeneration,
        sequence: 2,
        sessionState: 'failed',
      }),
    ).rejects.toThrow('out of order');
    await expect(
      handler.workerEvent?.({
        type: 'state',
        sessionId: result.sessionId,
        token,
        workerGeneration: 'stale-generation',
        sequence: 1,
        sessionState: 'failed',
      }),
    ).rejects.toThrow('generation is stale');
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({ sessionState: 'idle' });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('rejects worker sideband calls with missing or invalid tokens', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };

    await expect(
      handler.workerEvent?.({
        type: 'state',
        sessionId: result.sessionId,
        sessionState: 'idle',
      }),
    ).rejects.toThrow('worker token is required');
    await expect(
      handler.workerEvent?.({
        type: 'state',
        sessionId: result.sessionId,
        token: 'wrong-token',
        sessionState: 'idle',
      }),
    ).rejects.toThrow('worker token is invalid');
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'starting',
    });
    await expect(
      handler.workerControl?.({
        sessionId: result.sessionId,
        token: 'wrong-token',
      }),
    ).rejects.toThrow('worker token is invalid');

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('queues follow-up text for detached live sessions', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost();
        hosts.push(host);
        return host;
      },
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    await handler.workerEvent?.({
      type: 'ready',
      sessionId: result.sessionId,
      token,
      cwd: globalDir,
      capabilities: ['reply', 'hibernate'],
    });

    await expect(
      handler.send?.({ sessionId: result.sessionId, text: 'next step' }),
    ).resolves.toEqual({ sessionId: result.sessionId, sent: true });
    expect(hosts[0]?.input).toBe('');
    await expect(
      handler.workerControl?.({ sessionId: result.sessionId, token }),
    ).resolves.toMatchObject({
      sessionId: result.sessionId,
      events: [
        {
          type: 'prompt',
          sequence: 1,
          text: 'next step',
          at: expect.any(String),
        },
      ],
    });
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({ sessionState: 'idle' });
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      summary: 'write tests',
      queuedPromptCount: 1,
      queuedPromptPreview: 'next step',
      capabilities: ['reply', 'hibernate'],
    });

    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'working',
    });
    await expect(
      handler.send?.({ sessionId: result.sessionId, text: 'queued follow-up' }),
    ).rejects.toThrow('is waiting for the previous response');

    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'completed',
      lastResult: 'done',
    });
    await expect(
      handler.send?.({ sessionId: result.sessionId, text: 'continue' }),
    ).resolves.toEqual({ sessionId: result.sessionId, sent: true });
    expect(hosts[0]?.input).toBe('');
    await expect(
      handler.workerControl?.({ sessionId: result.sessionId, token }),
    ).resolves.toMatchObject({
      sessionId: result.sessionId,
      events: [
        {
          type: 'prompt',
          sequence: 2,
          text: 'continue',
          at: expect.any(String),
        },
      ],
    });

    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'needs_input',
      waitingFor: 'response',
      lastResult: 'Anything else?',
    });
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.not.toMatchObject({ queuedPromptCount: 1 });
    await expect(
      handler.answer?.({ sessionId: result.sessionId, text: 'no' }),
    ).resolves.toEqual({ sessionId: result.sessionId, answered: true });
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      capabilities: ['reply', 'hibernate'],
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  }, 20_000);

  it('serializes concurrent follow-up prompts for the same session', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };

    await handler.kill?.({ sessionId: result.sessionId });
    const settled = await Promise.allSettled([
      handler.send?.({ sessionId: result.sessionId, text: 'first' }),
      handler.send?.({ sessionId: result.sessionId, text: 'second' }),
    ]);

    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = settled.find((item) => item.status === 'rejected');
    expect(
      rejected && rejected.status === 'rejected' ? rejected.reason : undefined,
    ).toMatchObject({
      message: expect.stringContaining('waiting for the previous response'),
    });
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    const controls = (await handler.workerControl?.({
      sessionId: result.sessionId,
      token,
    })) as { events: Array<{ type: string; text?: string }> };
    expect(controls.events).toEqual([
      expect.objectContaining({
        type: 'prompt',
        text: expect.stringMatching(/^(first|second)$/),
      }),
    ]);

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('serializes concurrent answers for the same session', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    await handler.workerEvent?.({
      type: 'ready',
      sessionId: result.sessionId,
      token,
      cwd: globalDir,
    });
    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'needs_input',
      waitingFor: 'approval',
    });

    const settled = await Promise.allSettled([
      handler.answer?.({ sessionId: result.sessionId, text: 'yes' }),
      handler.answer?.({ sessionId: result.sessionId, text: 'no' }),
    ]);

    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = settled.find((item) => item.status === 'rejected');
    expect(
      rejected && rejected.status === 'rejected' ? rejected.reason : undefined,
    ).toMatchObject({
      message: expect.stringContaining('waiting for the previous response'),
    });
    const controls = (await handler.workerControl?.({
      sessionId: result.sessionId,
      token,
    })) as { events: Array<{ type: string; text?: string }> };
    expect(controls.events).toEqual([
      expect.objectContaining({
        type: 'answer',
        text: expect.stringMatching(/^(yes|no)$/),
      }),
    ]);

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('serializes mixed follow-up prompts and soft answers for the same session', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    await handler.workerEvent?.({
      type: 'ready',
      sessionId: result.sessionId,
      token,
      cwd: globalDir,
    });
    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'needs_input',
      waitingFor: 'response',
      lastResult: 'Anything else?',
    });

    const settled = await Promise.allSettled([
      handler.send?.({ sessionId: result.sessionId, text: 'first' }),
      handler.answer?.({ sessionId: result.sessionId, text: 'second' }),
    ]);

    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = settled.find((item) => item.status === 'rejected');
    expect(
      rejected && rejected.status === 'rejected' ? rejected.reason : undefined,
    ).toMatchObject({
      message: expect.stringContaining('waiting for the previous response'),
    });
    const controls = (await handler.workerControl?.({
      sessionId: result.sessionId,
      token,
    })) as { events: Array<{ type: string; text?: string }> };
    expect(controls.events).toEqual([
      expect.objectContaining({
        type: 'prompt',
        text: expect.stringMatching(/^(first|second)$/),
      }),
    ]);

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('clears pending worker controls when a session is killed', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };

    await handler.kill?.({ sessionId: result.sessionId });
    await handler.send?.({ sessionId: result.sessionId, text: 'follow up' });
    await handler.kill?.({ sessionId: result.sessionId });
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);

    await expect(
      handler.workerControl?.({ sessionId: result.sessionId, token }),
    ).resolves.toMatchObject({
      sessionId: result.sessionId,
      events: [],
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('answers needs-input sessions and rejects attached or idle sessions', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost();
        hosts.push(host);
        return host;
      },
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    await handler.workerEvent?.({
      type: 'ready',
      sessionId: result.sessionId,
      token,
      cwd: globalDir,
    });

    await expect(
      handler.answer?.({ sessionId: result.sessionId, text: 'yes' }),
    ).rejects.toThrow('is not waiting for input');

    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'needs_input',
      waitingFor: 'approval',
    });
    await expect(
      handler.answer?.({ sessionId: result.sessionId, text: 'yes' }),
    ).resolves.toEqual({ sessionId: result.sessionId, answered: true });
    expect(hosts[0]?.input).toBe('');
    await expect(
      handler.workerControl?.({ sessionId: result.sessionId, token }),
    ).resolves.toMatchObject({
      sessionId: result.sessionId,
      events: [
        {
          type: 'answer',
          sequence: 1,
          text: 'yes',
          at: expect.any(String),
        },
      ],
    });
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.not.toMatchObject({ queuedPromptCount: 1 });

    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'needs_input',
      waitingFor: 'approval',
    });
    await writeAttachedStateForTest(result.sessionId, globalDir);
    await expect(
      handler.answer?.({ sessionId: result.sessionId, text: 'yes' }),
    ).rejects.toThrow('currently attached elsewhere');

    await writeDetachedStateForTest(result.sessionId, globalDir);
    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'needs_input',
      waitingFor: 'response',
    });
    await expect(
      handler.answer?.({ sessionId: result.sessionId, text: 'src/index.ts' }),
    ).resolves.toEqual({ sessionId: result.sessionId, answered: true });
    await expect(
      handler.answer?.({ sessionId: result.sessionId, text: 'src/app.ts' }),
    ).rejects.toThrow('is waiting for the previous response');

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('attaches a stream to a running PTY host with a single lease', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost();
        hosts.push(host);
        return host;
      },
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    const socket = new FakeAttachSocket();

    const attached = handler.attachStream?.(
      { sessionId: result.sessionId },
      socket as unknown as Socket,
      'request-1',
    );
    await socket.waitForOutput('request-1');

    expect(JSON.parse(socket.outputLine())).toMatchObject({
      id: 'request-1',
      ok: true,
      result: { sessionId: result.sessionId },
    });
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({ attachState: 'attached' });
    await expect(
      handler.workerControl?.({ sessionId: result.sessionId, token }),
    ).resolves.toMatchObject({
      sessionId: result.sessionId,
      events: [
        {
          type: 'redraw',
          sequence: 1,
          at: expect.any(String),
        },
      ],
    });
    await expect(
      handler.workerControl?.({ sessionId: result.sessionId, token }),
    ).resolves.toEqual({
      sessionId: result.sessionId,
      events: [],
    });

    socket.pushInput('hello');
    await waitFor(() => hosts[0]?.input === 'hello');
    hosts[0]?.emitData('world');
    await socket.waitForOutput('world');

    const secondSocket = new FakeAttachSocket();
    await handler.attachStream?.(
      { sessionId: result.sessionId },
      secondSocket as unknown as Socket,
      'request-2',
    );
    expect(JSON.parse(secondSocket.outputLine())).toMatchObject({
      id: 'request-2',
      ok: false,
      error: { code: 'already_attached' },
    });

    socket.closeInput();
    await attached;
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({ attachState: 'detached' });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('serializes concurrent attach recovery for the same inactive session', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    let launchCount = 0;
    let releaseRespawn: (() => void) | undefined;
    const respawnReady = new Promise<void>((resolve) => {
      releaseRespawn = resolve;
    });
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        launchCount++;
        if (launchCount > 1) {
          await respawnReady;
        }
        return fakePtyHost();
      },
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    await handler.kill?.({ sessionId: result.sessionId });
    const firstSocket = new FakeAttachSocket();
    const secondSocket = new FakeAttachSocket();

    const firstAttached = handler.attachStream?.(
      { sessionId: result.sessionId },
      firstSocket as unknown as Socket,
      'request-1',
    );
    const secondAttached = handler.attachStream?.(
      { sessionId: result.sessionId },
      secondSocket as unknown as Socket,
      'request-2',
    );
    releaseRespawn?.();
    await Promise.all([
      firstSocket.waitForOutput('request-1'),
      secondSocket.waitForOutput('request-2'),
    ]);

    expect(launchCount).toBe(2);
    expect(JSON.parse(firstSocket.outputLine())).toMatchObject({
      id: 'request-1',
      ok: true,
    });
    expect(JSON.parse(secondSocket.outputLine())).toMatchObject({
      id: 'request-2',
      ok: false,
      error: { code: 'already_attached' },
    });

    firstSocket.closeInput();
    await firstAttached;
    await secondAttached;
    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('keeps an active attach lease alive with heartbeats', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T00:00:00.000Z'));
    try {
      const socket = new FakeAttachSocket();
      const attached = handler.attachStream?.(
        { sessionId: result.sessionId },
        socket as unknown as Socket,
        'request-1',
      );
      await socket.waitForOutput('request-1');

      await vi.advanceTimersByTimeAsync(
        DEFAULT_AGENT_VIEW_ATTACH_LEASE_TTL_MS + 5_000,
      );

      const secondSocket = new FakeAttachSocket();
      await handler.attachStream?.(
        { sessionId: result.sessionId },
        secondSocket as unknown as Socket,
        'request-2',
      );
      expect(JSON.parse(secondSocket.outputLine())).toMatchObject({
        id: 'request-2',
        ok: false,
        error: { code: 'already_attached' },
      });

      socket.closeInput();
      await attached;

      const reattachSocket = new FakeAttachSocket();
      const reattached = handler.attachStream?.(
        { sessionId: result.sessionId },
        reattachSocket as unknown as Socket,
        'request-3',
      );
      await reattachSocket.waitForOutput('request-3');
      expect(JSON.parse(reattachSocket.outputLine())).toMatchObject({
        id: 'request-3',
        ok: true,
        result: { sessionId: result.sessionId },
      });
      reattachSocket.closeInput();
      await reattached;
    } finally {
      vi.useRealTimers();
      await fs.rm(globalDir, { recursive: true, force: true });
    }
  });

  it('respawns an inactive managed session on attach when no live PTY host is loaded', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(1234),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    await seedHandler.stop?.({ sessionId: result.sessionId });
    const state = await readAgentViewSessionState(result.sessionId, {
      globalDir,
    });
    if (!state) {
      throw new Error('Missing test session state.');
    }
    await writeAgentViewSessionState(
      {
        ...state,
        sessionState: 'idle',
        processState: 'exited',
        attachState: 'detached',
      },
      { globalDir },
    );
    const hosts: FakePtyHost[] = [];
    const recoveredHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost(2000 + hosts.length);
        hosts.push(host);
        return host;
      },
    });
    const socket = new FakeAttachSocket();

    const attached = recoveredHandler.attachStream?.(
      { sessionId: result.sessionId },
      socket as unknown as Socket,
      'request-1',
    );
    await socket.waitForOutput('request-1');

    expect(hosts).toHaveLength(1);
    expect(JSON.parse(socket.outputLine())).toMatchObject({
      id: 'request-1',
      ok: true,
      result: { sessionId: result.sessionId },
    });
    await expect(
      readAgentViewWorker(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      workerPid: 2000,
    });

    socket.closeInput();
    await attached;
    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('returns an attach error when respawned worker does not become ready', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(1234),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    await seedHandler.stop?.({ sessionId: result.sessionId });
    const recoveredHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      waitForWorkerReady: true,
      workerReadyTimeoutMs: 1,
      launchPtyHost: async () => fakePtyHost(2000),
    });
    const socket = new FakeAttachSocket();

    await recoveredHandler.attachStream?.(
      { sessionId: result.sessionId },
      socket as unknown as Socket,
      'request-1',
    );
    await socket.waitForOutput('request-1');

    expect(JSON.parse(socket.outputLine())).toMatchObject({
      id: 'request-1',
      ok: false,
      error: {
        message: expect.stringContaining('did not report ready'),
      },
    });
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'failed',
      processState: 'exited',
    });
    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('fails attach quickly for an active session with a stale persisted PTY host', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(1234),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const worker = await readAgentViewWorker(result.sessionId, { globalDir });
    if (!worker) {
      throw new Error('Missing worker state.');
    }
    await writeAgentViewWorker(
      result.sessionId,
      {
        ...worker,
        hostEndpoint: shortHostSocketPath(),
      },
      { globalDir },
    );
    const launchPtyHost = vi.fn(async () => fakePtyHost(4321));
    const recoveredHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost,
    });
    const socket = new FakeAttachSocket();

    await recoveredHandler.attachStream?.(
      { sessionId: result.sessionId },
      socket as unknown as Socket,
      'request-1',
    );

    expect(launchPtyHost).not.toHaveBeenCalled();
    expect(JSON.parse(socket.outputLine())).toMatchObject({
      id: 'request-1',
      ok: false,
      error: {
        code: 'stale_host',
        message: expect.stringContaining('has no live PTY host'),
      },
    });
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'failed',
      processState: 'exited',
      lastError: {
        code: 'stale_host',
        message: expect.stringContaining('stale PTY host'),
      },
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('respawns failed or stopped sessions on attach', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(1234),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const state = await readAgentViewSessionState(result.sessionId, {
      globalDir,
    });
    if (!state) {
      throw new Error('Missing test session state.');
    }
    const hosts: FakePtyHost[] = [];
    const launchedArgv: string[][] = [];
    const launchPtyHost = vi.fn(async (launch: AgentViewLaunchFile) => {
      launchedArgv.push(launch.argv);
      const host = fakePtyHost(4321 + hosts.length);
      hosts.push(host);
      return host;
    });

    for (const sessionState of ['failed', 'stopped'] as const) {
      await writeAgentViewSessionState(
        {
          ...state,
          sessionState,
          processState: 'exited',
          attachState: 'detached',
        },
        { globalDir },
      );
      const recoveredHandler = createAgentViewSupervisorHandler({
        globalDir,
        platform: 'linux',
        launchPtyHost,
      });
      const socket = new FakeAttachSocket();

      const attached = recoveredHandler.attachStream?.(
        { sessionId: result.sessionId },
        socket as unknown as Socket,
        `request-${sessionState}`,
      );
      await socket.waitForOutput(`request-${sessionState}`);

      expect(JSON.parse(socket.outputLine())).toMatchObject({
        id: `request-${sessionState}`,
        ok: true,
        result: { sessionId: result.sessionId },
      });
      socket.closeInput();
      await attached;
    }
    expect(launchPtyHost).toHaveBeenCalledTimes(2);
    expect(hosts).toHaveLength(2);
    for (const argv of launchedArgv) {
      expect(argv).toEqual(
        expect.arrayContaining(['--resume', result.sessionId]),
      );
      expect(argv).not.toContain('--session-id');
      expect(argv).not.toContain('--prompt-interactive');
    }

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('respawns a stopped session on attach instead of bridging to the old host', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost(1234 + hosts.length);
        hosts.push(host);
        return host;
      },
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };

    await expect(
      handler.stop?.({ sessionId: result.sessionId }),
    ).resolves.toEqual({
      sessionId: result.sessionId,
      stopped: true,
    });
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'stopped',
      processState: 'alive',
    });

    const socket = new FakeAttachSocket();
    const attached = handler.attachStream?.(
      { sessionId: result.sessionId },
      socket as unknown as Socket,
      'request-1',
    );
    await socket.waitForOutput('request-1');

    expect(hosts).toHaveLength(2);
    expect(hosts[0]?.killedWith).toBe('SIGTERM');
    expect(JSON.parse(socket.outputLine())).toMatchObject({
      id: 'request-1',
      ok: true,
      result: { sessionId: result.sessionId },
    });
    socket.pushInput('hello after stop');
    await waitFor(() => hosts[1]?.input === 'hello after stop');
    expect(hosts[0]?.input).toBe('');

    socket.closeInput();
    await attached;
    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('recovers stale attached state when attaching an inactive session', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(1234),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const state = await readAgentViewSessionState(result.sessionId, {
      globalDir,
    });
    if (!state) {
      throw new Error('Missing test session state.');
    }
    await writeAgentViewSessionState(
      {
        ...state,
        sessionState: 'starting',
        processState: 'starting',
        attachState: 'attached',
      },
      { globalDir },
    );
    const recoveredHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(2000),
    });
    const socket = new FakeAttachSocket();

    const attached = recoveredHandler.attachStream?.(
      { sessionId: result.sessionId },
      socket as unknown as Socket,
      'request-1',
    );
    await socket.waitForOutput('request-1');

    expect(JSON.parse(socket.outputLine())).toMatchObject({
      id: 'request-1',
      ok: true,
      result: { sessionId: result.sessionId },
    });
    socket.closeInput();
    await attached;
    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('recovers stale starting state when attaching an inactive session', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(1234),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const state = await readAgentViewSessionState(result.sessionId, {
      globalDir,
    });
    if (!state) {
      throw new Error('Missing test session state.');
    }
    await writeAgentViewSessionState(
      {
        ...state,
        sessionState: 'starting',
        processState: 'starting',
        attachState: 'detached',
        updatedAt: '2026-07-17T00:00:00.000Z',
      },
      { globalDir },
    );
    const recoveredHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(2000),
    });
    const socket = new FakeAttachSocket();

    const attached = recoveredHandler.attachStream?.(
      { sessionId: result.sessionId },
      socket as unknown as Socket,
      'request-1',
    );
    await socket.waitForOutput('request-1');

    expect(JSON.parse(socket.outputLine())).toMatchObject({
      id: 'request-1',
      ok: true,
      result: { sessionId: result.sessionId },
    });
    socket.closeInput();
    await attached;
    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('reconnects a persisted PTY host before respawning on attach', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(1234),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const liveHost = fakePtyHost(4321);
    const hostEndpoint = shortHostSocketPath();
    const hostServer = createAgentViewPtyHostServer(liveHost, hostEndpoint);
    await hostServer.listen();
    const worker = await readAgentViewWorker(result.sessionId, { globalDir });
    if (!worker) {
      throw new Error('Missing worker state.');
    }
    await writeAgentViewWorker(
      result.sessionId,
      {
        ...worker,
        hostEndpoint,
      },
      { globalDir },
    );
    const launchPtyHost = vi.fn(async () => {
      throw new Error('should not respawn');
    });
    const recoveredHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost,
    });
    const socket = new FakeAttachSocket();

    const attached = recoveredHandler.attachStream?.(
      { sessionId: result.sessionId },
      socket as unknown as Socket,
      'request-1',
    );
    await socket.waitForOutput('request-1');
    socket.pushInput('hello');
    await waitFor(() => liveHost.input === 'hello');

    expect(launchPtyHost).not.toHaveBeenCalled();
    await expect(
      readAgentViewWorker(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      workerPid: 4321,
      hostEndpoint,
    });

    socket.closeInput();
    await attached;
    await hostServer.close();
    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('reconnects a persisted PTY host for logs and stop', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(1234),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const liveHost = fakePtyHost(4321);
    liveHost.output.append('hello logs');
    const hostEndpoint = shortHostSocketPath();
    const hostServer = createAgentViewPtyHostServer(liveHost, hostEndpoint);
    await hostServer.listen();
    const worker = await readAgentViewWorker(result.sessionId, { globalDir });
    if (!worker) {
      throw new Error('Missing worker state.');
    }
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    await writeAgentViewWorker(
      result.sessionId,
      {
        ...worker,
        hostEndpoint,
      },
      { globalDir },
    );
    const recoveredHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        throw new Error('should not respawn');
      },
    });

    await expect(
      recoveredHandler.logs?.({ sessionId: result.sessionId }),
    ).resolves.toMatchObject({
      sessionId: result.sessionId,
      output: 'hello logs',
      live: true,
    });
    await expect(
      recoveredHandler.stop?.({ sessionId: result.sessionId }),
    ).resolves.toEqual({
      sessionId: result.sessionId,
      stopped: true,
    });
    expect(liveHost.killedWith).toBeUndefined();
    await expect(
      recoveredHandler.workerControl?.({ sessionId: result.sessionId, token }),
    ).resolves.toMatchObject({
      events: [
        {
          type: 'stop',
          sequence: 1,
          at: expect.any(String),
        },
      ],
    });

    await hostServer.close();
    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('detaches the active attach stream from a worker sideband event', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    const socket = new FakeAttachSocket();

    const attached = handler.attachStream?.(
      { sessionId: result.sessionId },
      socket as unknown as Socket,
      'request-1',
    );
    await socket.waitForOutput('request-1');
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({ attachState: 'attached' });

    await expect(
      handler.workerEvent?.({
        type: 'detach',
        sessionId: result.sessionId,
        token,
      }),
    ).resolves.toMatchObject({
      sessionId: result.sessionId,
      accepted: true,
      workerGeneration: expect.any(String),
      sequence: 0,
    });
    await attached;
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({ attachState: 'detached' });

    const secondSocket = new FakeAttachSocket();
    const secondAttached = handler.attachStream?.(
      { sessionId: result.sessionId },
      secondSocket as unknown as Socket,
      'request-2',
    );
    await secondSocket.waitForOutput('request-2');
    expect(JSON.parse(secondSocket.outputLine())).toMatchObject({
      id: 'request-2',
      ok: true,
    });
    secondSocket.closeInput();
    await secondAttached;

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('resizes the running PTY host through supervisor IPC', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost();
        hosts.push(host);
        return host;
      },
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };

    await expect(
      handler.resize?.({
        sessionId: result.sessionId,
        columns: 120,
        rows: 40,
      }),
    ).resolves.toEqual({
      sessionId: result.sessionId,
      resized: true,
    });
    expect(hosts[0]?.resizes).toEqual([{ columns: 120, rows: 40 }]);

    await expect(
      handler.resize?.({
        sessionId: result.sessionId,
        columns: 0,
        rows: 40,
      }),
    ).rejects.toThrow('Agent View columns must be a positive integer.');

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('manages logs, stop, respawn, and remove for a dispatched session', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const launches: AgentViewLaunchFile[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async (launch) => {
        launches.push(launch);
        const host = fakePtyHost(1234 + hosts.length);
        hosts.push(host);
        return host;
      },
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    const initialGeneration = (
      await readAgentViewWorker(result.sessionId, { globalDir })
    )?.workerGeneration;
    hosts[0]?.output.append('hello from worker');

    await expect(
      handler.respawn?.({ sessionId: result.sessionId }),
    ).rejects.toThrow(
      `Agent View session ${result.sessionId} cannot be respawned: its process is starting.`,
    );
    await expect(handler.respawn?.({ all: true })).resolves.toEqual({
      all: true,
      results: [
        {
          sessionId: result.sessionId,
          skipped: true,
          reason: 'its process is starting',
        },
      ],
    });

    await expect(
      handler.logs?.({ sessionId: result.sessionId }),
    ).resolves.toMatchObject({
      sessionId: result.sessionId,
      output: 'hello from worker',
      live: true,
    });

    await expect(
      handler.stop?.({ sessionId: result.sessionId }),
    ).resolves.toEqual({
      sessionId: result.sessionId,
      stopped: true,
    });
    expect(hosts[0]?.killedWith).toBeUndefined();
    await expect(
      handler.workerControl?.({ sessionId: result.sessionId, token }),
    ).resolves.toMatchObject({
      events: [
        {
          type: 'stop',
          sequence: 1,
          at: expect.any(String),
        },
      ],
    });
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'stopped',
      processState: 'alive',
    });
    const staleLaunch = await readAgentViewLaunch(result.sessionId, {
      globalDir,
    });
    if (!staleLaunch) {
      throw new Error('expected launch record');
    }
    await writeAgentViewLaunch(
      {
        ...staleLaunch,
        entrypoint: '/old/qwen',
        argv: ['/old/node', '/old/qwen', '--resume', result.sessionId],
      },
      { globalDir },
    );
    await handler.kill?.({ sessionId: result.sessionId });
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'stopped',
      processState: 'exited',
    });

    await expect(
      handler.respawn?.({ sessionId: result.sessionId }),
    ).resolves.toEqual({
      sessionId: result.sessionId,
      respawned: true,
    });
    const respawnedToken = await readWorkerTokenForTest(
      result.sessionId,
      globalDir,
    );
    expect(respawnedToken).not.toBe(token);
    expect(
      (await readAgentViewWorker(result.sessionId, { globalDir }))
        ?.workerGeneration,
    ).not.toBe(initialGeneration);
    expect(hosts).toHaveLength(2);
    expect(
      launches.every((launch) => !(QWEN_AGENT_VIEW_TOKEN in launch.env)),
    ).toBe(true);
    expect(launches[1]).toMatchObject({
      entrypoint: process.argv[1],
      argv: [process.execPath, process.argv[1], '--resume', result.sessionId],
    });
    await expect(
      readAgentViewLaunch(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      entrypoint: process.argv[1],
      argv: [process.execPath, process.argv[1], '--resume', result.sessionId],
    });
    await expect(
      readAgentViewWorker(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      workerPid: 1235,
    });

    await expect(
      handler.rename?.({
        sessionId: result.sessionId,
        displayName: '  Build Fix  ',
      }),
    ).resolves.toEqual({
      sessionId: result.sessionId,
      displayName: 'Build Fix',
    });
    await expect(
      handler.pin?.({ sessionId: result.sessionId }),
    ).resolves.toEqual({
      sessionId: result.sessionId,
      pinned: true,
    });
    await expect(readAgentViewRoster({ globalDir })).resolves.toMatchObject({
      sessions: [
        expect.objectContaining({
          sessionId: result.sessionId,
          displayName: 'Build Fix',
          pinned: true,
        }),
      ],
    });

    await expect(
      handler.pin?.({ sessionId: result.sessionId, pinned: false }),
    ).resolves.toEqual({
      sessionId: result.sessionId,
      pinned: false,
    });
    await expect(
      handler.rename?.({ sessionId: result.sessionId, displayName: '   ' }),
    ).resolves.toEqual({
      sessionId: result.sessionId,
      displayName: '',
    });
    const renamedRoster = await readAgentViewRoster({ globalDir });
    expect(renamedRoster.sessions[0]).toMatchObject({
      sessionId: result.sessionId,
      pinned: false,
    });
    expect(renamedRoster.sessions[0]?.displayName).toBeUndefined();

    await expect(
      handler.remove?.({ sessionId: result.sessionId }),
    ).resolves.toEqual({
      sessionId: result.sessionId,
      removed: true,
    });
    await expect(readAgentViewRoster({ globalDir })).resolves.toMatchObject({
      sessions: [],
    });
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      ownership: 'unmanaged',
    });
    await expect(handler.list()).resolves.toEqual([]);
    await expect(
      handler.respawn?.({ sessionId: result.sessionId }),
    ).rejects.toThrow(`Agent View session ${result.sessionId} is not managed.`);
    await expect(
      handler.logs?.({ sessionId: result.sessionId }),
    ).rejects.toThrow(`Agent View session ${result.sessionId} is not managed.`);
    await expect(handler.respawn?.({ all: true })).resolves.toEqual({
      all: true,
      results: [],
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('ignores stale host exits after a session respawns', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost(1234 + hosts.length);
        hosts.push(host);
        return host;
      },
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const state = await readAgentViewSessionState(result.sessionId, {
      globalDir,
    });
    if (!state) {
      throw new Error('expected session state');
    }
    await writeAgentViewSessionState(
      {
        ...state,
        sessionState: 'completed',
        processState: 'exited',
      },
      { globalDir },
    );

    await expect(
      handler.respawn?.({ sessionId: result.sessionId }),
    ).resolves.toEqual({
      sessionId: result.sessionId,
      respawned: true,
    });
    hosts[0]?.resolveExit(1);
    await new Promise((resolve) => setImmediate(resolve));

    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'starting',
      processState: 'starting',
    });
    await expect(
      readAgentViewWorker(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      workerPid: 1235,
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('cleans up host exits even when persisted state update fails', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost(1234 + hosts.length);
        hosts.push(host);
        return host;
      },
    });
    await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    });

    await fs.rm(globalDir, { recursive: true, force: true });
    hosts[0]?.resolveExit(1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(handler.shutdown()).resolves.toMatchObject({
      workersStopped: 0,
    });
  });

  it('marks a stopped session process exited when its host exits', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost(1234 + hosts.length);
        hosts.push(host);
        return host;
      },
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };

    await handler.stop?.({ sessionId: result.sessionId });
    hosts[0]?.resolveExit(0);
    await waitForSessionState(
      result.sessionId,
      globalDir,
      (state) => state.processState === 'exited',
    );

    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'stopped',
      processState: 'exited',
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('preserves a worker-reported failed state after a clean host exit', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost(1234 + hosts.length);
        hosts.push(host);
        return host;
      },
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const state = await readAgentViewSessionState(result.sessionId, {
      globalDir,
    });
    if (!state) {
      throw new Error('expected session state');
    }
    await writeAgentViewSessionState(
      {
        ...state,
        sessionState: 'failed',
        processState: 'alive',
      },
      { globalDir },
    );

    hosts[0]?.resolveExit(0);
    await waitForSessionState(
      result.sessionId,
      globalDir,
      (state) => state.processState === 'exited',
    );

    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'failed',
      processState: 'exited',
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('removes Agent View ownership without touching legacy worktree metadata', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost(1234 + hosts.length);
        hosts.push(host);
        return host;
      },
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const state = await readAgentViewSessionState(result.sessionId, {
      globalDir,
    });
    if (!state) {
      throw new Error('Missing test session state.');
    }
    await writeAgentViewSessionState(
      {
        ...state,
        worktree: {
          mode: 'worktree',
          path: '/workspace/project/.qwen/worktrees/agent-1234567',
          owner: 'agent-view',
        },
      },
      { globalDir },
    );

    await expect(
      handler.remove?.({ sessionId: result.sessionId }),
    ).resolves.toEqual({
      sessionId: result.sessionId,
      removed: true,
    });
    expect(hosts[0]?.killedWith).toBe('SIGTERM');
    await expect(readAgentViewRoster({ globalDir })).resolves.toMatchObject({
      sessions: [],
    });
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      ownership: 'unmanaged',
      processState: 'exited',
      worktree: {
        mode: 'worktree',
        owner: 'agent-view',
      },
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('rejects unknown session management requests', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
    });

    await expect(
      handler.remove?.({ sessionId: 'missing-session' }),
    ).rejects.toThrow('No Agent View session found for missing-session.');

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('notifies subscribers when session state changes', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const socket = new FakeAttachSocket();

    await handler.subscribe?.(undefined, socket as unknown as Socket, 'sub-1');
    await socket.waitForOutput('sub-1');

    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    await socket.waitForOutput('"type":"changed"');
    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'idle',
    });
    await waitFor(
      () => socket.output().split('"type":"changed"').length >= 3,
      (notify) => {
        setTimeout(notify, 10);
      },
    );

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('hibernates only idle or completed detached unpinned live sessions', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      hibernationPolicy: { idleMs: 1000, autoExit: false },
      now: () => new Date('2026-07-17T00:00:10.000Z'),
      launchPtyHost: async () => {
        const host = fakePtyHost(1234 + hosts.length);
        hosts.push(host);
        return host;
      },
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);

    await handler.workerEvent?.({
      type: 'ready',
      sessionId: result.sessionId,
      token,
      cwd: globalDir,
      at: '2026-07-17T00:00:00.000Z',
    });
    await handler.workerEvent?.({
      type: 'heartbeat',
      sessionId: result.sessionId,
      token,
      at: '2026-07-17T00:00:05.000Z',
    });
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      lastActivityAt: '2026-07-17T00:00:00.000Z',
    });
    await expect(
      readAgentViewWorker(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      lastHeartbeatAt: '2026-07-17T00:00:05.000Z',
    });
    await expect(handler.hibernateIdleSessions()).resolves.toEqual({
      hibernated: [result.sessionId],
    });
    expect(hosts[0]?.killedWith).toBe('SIGTERM');
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({ processState: 'hibernated' });
    hosts[0]?.resolveExit(0);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'idle',
      processState: 'hibernated',
    });

    await handler.respawn?.({ sessionId: result.sessionId });
    await writeSessionStateForTest(result.sessionId, globalDir, 'working');
    await expect(handler.hibernateIdleSessions()).resolves.toEqual({
      hibernated: [],
    });
    expect(hosts[1]?.killedWith).toBeUndefined();

    await writeSessionStateForTest(result.sessionId, globalDir, 'needs_input');
    await expect(handler.hibernateIdleSessions()).resolves.toEqual({
      hibernated: [],
    });
    expect(hosts[1]?.killedWith).toBeUndefined();

    await writeAgentViewActivity(
      result.sessionId,
      {
        schemaVersion: 1,
        waitingFor: 'response',
        inputKind: 'soft',
        lastActivityAt: '2026-07-17T00:00:00.000Z',
        capabilities: [],
      },
      { globalDir },
    );
    await expect(handler.hibernateIdleSessions()).resolves.toEqual({
      hibernated: [result.sessionId],
    });
    expect(hosts[1]?.killedWith).toBe('SIGTERM');

    await handler.respawn?.({ sessionId: result.sessionId });
    await writeSessionStateForTest(result.sessionId, globalDir, 'idle');
    await writeAttachedStateForTest(result.sessionId, globalDir);
    await expect(handler.hibernateIdleSessions()).resolves.toEqual({
      hibernated: [],
    });
    expect(hosts[2]?.killedWith).toBeUndefined();

    await writeDetachedStateForTest(result.sessionId, globalDir);
    await handler.pin?.({ sessionId: result.sessionId, pinned: true });
    await expect(handler.hibernateIdleSessions()).resolves.toEqual({
      hibernated: [],
    });
    expect(hosts[2]?.killedWith).toBeUndefined();

    await handler.pin?.({ sessionId: result.sessionId, pinned: false });
    await writeSessionStateForTest(result.sessionId, globalDir, 'completed');
    await expect(handler.hibernateIdleSessions()).resolves.toEqual({
      hibernated: [result.sessionId],
    });
    expect(hosts[2]?.killedWith).toBe('SIGTERM');

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('does not extend idle hibernation time for repeated idle state reports', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      hibernationPolicy: { idleMs: 1000, autoExit: false },
      now: () => new Date('2026-07-17T00:00:10.000Z'),
      launchPtyHost: async () => {
        const host = fakePtyHost(1234 + hosts.length);
        hosts.push(host);
        return host;
      },
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);

    await handler.workerEvent?.({
      type: 'ready',
      sessionId: result.sessionId,
      token,
      cwd: globalDir,
      at: '2026-07-17T00:00:00.000Z',
    });
    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'idle',
      lastResult: 'Done.',
      at: '2026-07-17T00:00:01.000Z',
    });
    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'idle',
      lastResult: 'Done.',
      at: '2026-07-17T00:00:09.500Z',
    });
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      lastResult: 'Done.',
      lastActivityAt: '2026-07-17T00:00:01.000Z',
    });
    await expect(handler.hibernateIdleSessions()).resolves.toEqual({
      hibernated: [result.sessionId],
    });
    expect(hosts[0]?.killedWith).toBe('SIGTERM');

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('extends idle hibernation time when idle output changes', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);

    await handler.workerEvent?.({
      type: 'ready',
      sessionId: result.sessionId,
      token,
      cwd: globalDir,
      at: '2026-07-17T00:00:00.000Z',
    });
    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'idle',
      lastResult: 'First result.',
      at: '2026-07-17T00:00:01.000Z',
    });
    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'idle',
      lastResult: 'Second result.',
      at: '2026-07-17T00:00:09.500Z',
    });

    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      lastResult: 'Second result.',
      lastActivityAt: '2026-07-17T00:00:09.500Z',
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('auto-exits after every managed worker is hibernated and subscribers leave', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const onShutdown = vi.fn();
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      onShutdown,
      hibernationPolicy: { idleMs: 1000, autoExitGraceMs: 0 },
      now: () => new Date('2026-07-17T00:00:10.000Z'),
      launchPtyHost: async () => fakePtyHost(),
    });
    const socket = new FakeAttachSocket();
    await handler.subscribe?.(undefined, socket as unknown as Socket, 'sub-1');
    await socket.waitForOutput('sub-1');
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    await handler.workerEvent?.({
      type: 'ready',
      sessionId: result.sessionId,
      token,
      cwd: globalDir,
      at: '2026-07-17T00:00:00.000Z',
    });

    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [result.sessionId],
      shutdownRequested: false,
    });
    expect(onShutdown).not.toHaveBeenCalled();

    socket.closeInput();
    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: true,
    });
    expect(onShutdown).toHaveBeenCalledOnce();

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('waits through the default supervisor auto-exit grace period', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const onShutdown = vi.fn();
    let nowMs = Date.parse('2026-07-17T00:00:10.000Z');
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      onShutdown,
      hibernationPolicy: { idleMs: 1000 },
      now: () => new Date(nowMs),
      launchPtyHost: async () => fakePtyHost(),
    });
    const socket = new FakeAttachSocket();
    await handler.subscribe?.(undefined, socket as unknown as Socket, 'sub-1');
    await socket.waitForOutput('sub-1');
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    await handler.workerEvent?.({
      type: 'ready',
      sessionId: result.sessionId,
      token,
      cwd: globalDir,
      at: '2026-07-17T00:00:00.000Z',
    });

    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [result.sessionId],
      shutdownRequested: false,
    });

    socket.closeInput();
    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: false,
    });
    nowMs += 10 * 60 * 1000 - 1;
    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: false,
    });
    nowMs += 1;
    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: true,
    });
    expect(onShutdown).toHaveBeenCalledOnce();

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('auto-exits after the last managed session is removed', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const onShutdown = vi.fn();
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      onShutdown,
      hibernationPolicy: { idleMs: 1000, autoExitGraceMs: 0 },
      now: () => new Date('2026-07-17T00:00:10.000Z'),
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };

    await expect(
      handler.remove?.({ sessionId: result.sessionId }),
    ).resolves.toMatchObject({
      removed: true,
    });
    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: true,
    });
    expect(onShutdown).toHaveBeenCalledOnce();

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('stops workers on shutdown unless workers are kept', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const onShutdown = vi.fn();
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      onShutdown,
      launchPtyHost: async () => {
        const host = fakePtyHost();
        hosts.push(host);
        return host;
      },
    });

    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };

    await expect(handler.shutdown()).resolves.toEqual({
      shuttingDown: true,
      workersStopped: 1,
    });
    expect(hosts[0]?.killedWith).toBe('SIGTERM');
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'stopped',
      processState: 'exited',
    });
    expect(onShutdown).toHaveBeenCalledOnce();

    await handler.respawn?.({ sessionId: result.sessionId });
    await expect(handler.shutdown({ keepWorkers: true })).resolves.toEqual({
      shuttingDown: true,
      keepWorkers: true,
    });
    expect(onShutdown).toHaveBeenCalledTimes(2);

    await fs.rm(globalDir, { recursive: true, force: true });
  });
});

type FakePtyHost = AgentViewPtyHostHandle & {
  killedWith?: string;
  input: string;
  resizes: Array<{ columns: number; rows: number }>;
  emitData(data: string): void;
  resolveExit(exitCode: number): void;
};

function fakePtyHost(workerPid = 1234): FakePtyHost {
  let resolveExit: (exit: { exitCode: number }) => void = () => {};
  let dataCallbacks: Array<(data: string) => void> = [];
  const host: FakePtyHost = {
    pid: process.pid,
    workerPid,
    command: ['fake'],
    output: new BoundedOutputRing(100),
    input: '',
    resizes: [],
    exited: new Promise((resolve) => {
      resolveExit = resolve;
    }),
    write: (data) => {
      host.input += data.toString('utf8');
    },
    onData: (callback) => {
      dataCallbacks.push(callback);
      return {
        dispose: () => {
          dataCallbacks = dataCallbacks.filter((item) => item !== callback);
        },
      };
    },
    resize: (size) => {
      host.resizes.push(size);
    },
    kill: (signal) => {
      host.killedWith = signal;
    },
    resolveExit: (exitCode) => {
      resolveExit({ exitCode });
    },
    emitData: (data) => {
      for (const callback of dataCallbacks) {
        callback(data);
      }
    },
    dispose: () => {},
  };
  return host;
}

async function writeAttachedStateForTest(
  sessionId: string,
  globalDir: string,
): Promise<void> {
  const state = await readAgentViewSessionState(sessionId, { globalDir });
  if (!state) {
    throw new Error(`Missing state for ${sessionId}`);
  }
  await writeAgentViewSessionState(
    {
      ...state,
      attachState: 'attached',
    },
    { globalDir },
  );
}

async function writeDetachedStateForTest(
  sessionId: string,
  globalDir: string,
): Promise<void> {
  const state = await readAgentViewSessionState(sessionId, { globalDir });
  if (!state) {
    throw new Error(`Missing state for ${sessionId}`);
  }
  await writeAgentViewSessionState(
    {
      ...state,
      attachState: 'detached',
    },
    { globalDir },
  );
}

async function writeSessionStateForTest(
  sessionId: string,
  globalDir: string,
  sessionState: 'working' | 'needs_input' | 'idle' | 'completed',
): Promise<void> {
  const state = await readAgentViewSessionState(sessionId, { globalDir });
  if (!state) {
    throw new Error(`Missing state for ${sessionId}`);
  }
  const at = '2026-07-17T00:00:00.000Z';
  await writeAgentViewSessionState(
    {
      ...state,
      sessionState,
      processState: 'alive',
      attachState: 'detached',
      updatedAt: at,
    },
    { globalDir },
  );
  await writeAgentViewActivity(
    sessionId,
    {
      schemaVersion: 1,
      lastActivityAt: at,
      capabilities: [],
    },
    { globalDir },
  );
}

async function readWorkerTokenForTest(
  sessionId: string,
  _globalDir: string,
): Promise<string> {
  const token = workerTokensForTest.get(sessionId);
  if (!token) {
    throw new Error(`Missing worker token for ${sessionId}`);
  }
  return token;
}

function shortHostSocketPath(): string {
  const unique = `qah-${process.pid}-${Date.now()}`;
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${unique}`;
  }
  return path.join(os.tmpdir(), `${unique}.sock`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class FakeAttachSocket extends Duplex {
  private readonly outputChunks: Buffer[] = [];
  private outputWaiters: Array<() => void> = [];

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.outputChunks.push(Buffer.from(chunk));
    for (const waiter of this.outputWaiters.splice(0)) {
      waiter();
    }
    callback();
  }

  pushInput(data: string): void {
    this.push(Buffer.from(data));
  }

  closeInput(): void {
    this.push(null);
    this.emit('close');
  }

  output(): string {
    return Buffer.concat(this.outputChunks).toString('utf8');
  }

  outputLine(): string {
    return this.output().split('\n')[0] ?? '';
  }

  async waitForOutput(pattern: string): Promise<void> {
    await waitFor(
      () => this.output().includes(pattern),
      (notify) => {
        this.outputWaiters.push(notify);
      },
    );
  }
}

async function waitFor(
  predicate: () => boolean,
  subscribe?: (notify: () => void) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => {
      subscribe?.(resolve);
      setTimeout(resolve, 10);
    });
  }
  throw new Error('Timed out waiting for condition.');
}

async function waitForSessionState(
  sessionId: string,
  globalDir: string,
  predicate: (state: AgentViewSessionStateFile) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await readAgentViewSessionState(sessionId, { globalDir });
    if (state && predicate(state)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for session state.');
}
