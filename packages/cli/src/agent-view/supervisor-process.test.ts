/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
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
  AgentViewWorkerFile,
} from './protocol.js';
import {
  createAgentViewSupervisorHandler,
  getAgentViewSupervisorSocketPath,
} from './supervisor-process.js';
import {
  clearAgentViewWorkerPids,
  getAgentViewSessionPaths,
  readAgentViewActivity,
  readAgentViewLaunch,
  readAgentViewRoster,
  readAgentViewSessionState,
  readAgentViewWorker,
  upsertAgentViewRosterEntry,
  writeAgentViewActivity,
  writeAgentViewLaunch,
  writeAgentViewWorker,
  writeAgentViewSessionState,
} from './supervisor-store.js';
import * as supervisorStore from './supervisor-store.js';
import type {
  AgentViewPtyHostExit,
  AgentViewPtyHostHandle,
} from './pty-host.js';
import { BoundedOutputRing } from './pty-host.js';
import { createAgentViewPtyHostServer } from './pty-host-process.js';

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
    const runtimeDir = '/tmp';
    const socketPath = getAgentViewSupervisorSocketPath({
      globalDir: path.join(runtimeDir, 'a'.repeat(140)),
      platform: 'linux',
      runtimeDir,
    });
    if (process.getuid === undefined) {
      expect(path.basename(path.dirname(socketPath))).toMatch(
        /^qwen-agent-view-[a-f0-9]{12}$/,
      );
    } else {
      expect(path.dirname(socketPath)).toBe(
        path.join(runtimeDir, `qwen-agent-view-${process.getuid()}`),
      );
    }
    expect(path.basename(socketPath)).toMatch(/^[a-z0-9-]+\.sock$/);
    expect(Buffer.byteLength(socketPath)).toBeLessThan(100);
  });

  it('uses the compact runtime tier when the fallback path is too long', () => {
    const runtimeDir = path.join('/tmp', 'r'.repeat(50));
    const socketPath = getAgentViewSupervisorSocketPath({
      globalDir: path.join(runtimeDir, 'a'.repeat(60)),
      platform: 'linux',
      runtimeDir,
    });

    const uid = process.getuid?.();
    if (uid === undefined) {
      expect(path.basename(path.dirname(socketPath))).toMatch(
        /^qav-[a-f0-9]{8}$/,
      );
    } else {
      expect(path.dirname(socketPath)).toBe(
        path.join(runtimeDir, `qav-${uid}`),
      );
    }
    expect(path.basename(socketPath)).toMatch(/^[a-f0-9]{12}\.sock$/);
    expect(Buffer.byteLength(socketPath)).toBeLessThan(100);
  });

  it('computes a Windows named pipe path', () => {
    expect(
      getAgentViewSupervisorSocketPath({
        globalDir: 'C:\\Users\\test\\.qwen',
        platform: 'win32',
      }),
    ).toMatch(/^\\\\\.\\pipe\\qwen-agent-view-[a-f0-9]{12}$/);
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
        // Attached-value form: a bare token would be re-parsed by yargs
        // when the prompt starts with '-'.
        '--prompt-interactive=write tests',
      ]),
    });
    await expect(readAgentViewRoster({ globalDir })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId })],
    });
    await expect(
      readAgentViewWorker(sessionId, { globalDir }),
    ).resolves.toMatchObject({
      hostPid: 999_999_001,
      workerPid: 999_999_002,
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
          workerPid: 999_999_002,
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
        workerPid: 999_999_002,
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
        '--prompt-interactive=write tests',
      ]),
    );

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('lists sessions scoped through a symlinked project path', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const linksDir = path.join(globalDir, 'links');
    const realProject = path.join(globalDir, 'real-project');
    const linkedProject = path.join(linksDir, 'project');
    await fs.mkdir(linksDir);
    await fs.mkdir(realProject);
    await fs.symlink(
      realProject,
      linkedProject,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: linkedProject,
    })) as { sessionId: string };
    await handler.workerEvent?.({
      type: 'ready',
      sessionId: result.sessionId,
      token: await readWorkerTokenForTest(result.sessionId, globalDir),
      cwd: realProject,
    });

    await expect(handler.list({ cwd: linksDir })).resolves.toEqual([
      expect.objectContaining({ sessionId: result.sessionId }),
    ]);

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
      // 15s is the product default; 1s was the developer-machine figure and
      // it is a deadline the test does not otherwise care about. On the
      // shared pool a worker takes longer than that to report ready, and
      // release run 33713579913 failed three of these on it, each three
      // times over, with --retry=2 already on. The cases that DO assert the
      // timeout keep their 1ms.
      workerReadyTimeoutMs: 15_000,
      launchPtyHost: async (launch) => {
        launchedArgv = launch.argv;
        token = launch.env['QWEN_AGENT_VIEW_TOKEN'] ?? '';
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

  it('fails the ready wait as soon as the launched host exits', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      waitForWorkerReady: true,
      workerReadyTimeoutMs: 15_000,
      launchPtyHost: async () => {
        const host = fakePtyHost();
        setImmediate(() => host.resolveExit(1));
        return host;
      },
    });

    await expect(
      handler.dispatch?.({ prompt: 'write tests', cwd: globalDir }),
    ).rejects.toThrow('exited before ready');

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('does not let a stale ready event resolve a replacement waiter', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const { sessionId } = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const oldToken = await readWorkerTokenForTest(sessionId, globalDir);
    await patchSessionStateForTest(sessionId, globalDir, {
      sessionState: 'completed',
      processState: 'exited',
    });

    let replacementLaunched!: () => void;
    const launched = new Promise<void>((resolve) => {
      replacementLaunched = resolve;
    });
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      waitForWorkerReady: true,
      workerReadyTimeoutMs: 15_000,
      launchPtyHost: async () => {
        replacementLaunched();
        return fakePtyHost();
      },
    });
    const readState = supervisorStore.readAgentViewSessionState;
    let staleReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      staleReadStarted = resolve;
    });
    let releaseStaleRead!: () => void;
    const staleReadGate = new Promise<void>((resolve) => {
      releaseStaleRead = resolve;
    });
    const readSpy = vi
      .spyOn(supervisorStore, 'readAgentViewSessionState')
      .mockImplementationOnce(async (...args) => {
        staleReadStarted();
        await staleReadGate;
        return readState(...args);
      });
    try {
      const staleReady = handler.workerEvent?.({
        type: 'ready',
        sessionId,
        token: oldToken,
        cwd: globalDir,
      });
      await readStarted;
      const respawn = Promise.resolve(handler.respawn?.({ sessionId }));
      await launched;
      releaseStaleRead();
      await expect(staleReady).resolves.toMatchObject({ accepted: true });
      const settled = vi.fn();
      void respawn.then(settled, settled);
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).not.toHaveBeenCalled();

      const newToken = await readWorkerTokenForTest(sessionId, globalDir);
      await handler.workerEvent?.({
        type: 'ready',
        sessionId,
        token: newToken,
        cwd: globalDir,
      });
      await expect(respawn).resolves.toMatchObject({ respawned: true });
    } finally {
      releaseStaleRead();
      readSpy.mockRestore();
    }

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
    expect(host?.shutdowns).toBe(1);
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
    let launched: AgentViewLaunchFile | undefined;
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async (launch) => {
        launched = launch;
        return fakePtyHost();
      },
    });

    await expect(
      handler.adopt?.({
        sessionId,
        projectCwd: path.join(globalDir, 'project'),
        activeCwd: path.join(globalDir, 'project', 'src'),
        approvalMode: 'yolo',
        sandbox: JSON.stringify({ command: 'docker', image: 'test-image' }),
        terminal: { columns: 100, rows: 40 },
      }),
    ).resolves.toEqual({ sessionId, adopted: true });

    expect(launched).toMatchObject({
      argv: [
        process.execPath,
        process.argv[1],
        `--resume=${sessionId}`,
        '--approval-mode=yolo',
      ],
      env: expect.objectContaining({
        QWEN_SANDBOX: 'docker',
        QWEN_SANDBOX_IMAGE: 'test-image',
      }),
    });
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
    await expect(
      readAgentViewLaunch(sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionId,
      argv: launched?.argv,
      activeCwd: path.join(globalDir, 'project', 'src'),
      projectCwd: path.join(globalDir, 'project'),
      approvalMode: 'yolo',
      terminal: { columns: 100, rows: 40 },
    });
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
      hostPid: 999_999_001,
      workerPid: 999_999_002,
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('preserves ready state when it races the adoption commit', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    let handler!: ReturnType<typeof createAgentViewSupervisorHandler>;
    let readyInjected = false;
    const writeWorker = supervisorStore.writeAgentViewWorker;
    const writeSpy = vi
      .spyOn(supervisorStore, 'writeAgentViewWorker')
      .mockImplementation(async (...args) => {
        await writeWorker(...args);
        const [writtenSessionId, worker] = args;
        if (
          !readyInjected &&
          writtenSessionId === sessionId &&
          worker.hostPid !== undefined
        ) {
          readyInjected = true;
          await handler.workerEvent?.({
            type: 'ready',
            sessionId,
            token: await readWorkerTokenForTest(sessionId, globalDir),
            cwd: globalDir,
          });
        }
      });
    try {
      handler = createAgentViewSupervisorHandler({
        globalDir,
        platform: 'linux',
        waitForWorkerReady: true,
        launchPtyHost: async () => fakePtyHost(),
      });

      await expect(
        handler.adopt?.({
          sessionId,
          projectCwd: globalDir,
          activeCwd: globalDir,
          terminal: { columns: 80, rows: 24 },
        }),
      ).resolves.toEqual({ sessionId, adopted: true });
      await expect(
        readAgentViewSessionState(sessionId, { globalDir }),
      ).resolves.toMatchObject({
        ownership: 'managed',
        sessionState: 'idle',
        processState: 'alive',
      });
    } finally {
      writeSpy.mockRestore();
      await fs.rm(globalDir, { recursive: true, force: true });
    }
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

  it('fails closed on adopting records with live unverified pids', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const staleId = '123e4567-e89b-12d3-a456-426614174000';
    const liveId = '223e4567-e89b-12d3-a456-426614174000';
    const now = new Date().toISOString();
    const adoptingState = (sessionId: string): AgentViewSessionStateFile => ({
      schemaVersion: 1,
      sessionId,
      ownership: 'adopting',
      sessionState: 'idle',
      processState: 'starting',
      attachState: 'detached',
      projectCwd: path.join(globalDir, 'project'),
      originalCwd: path.join(globalDir, 'project'),
      activeCwd: path.join(globalDir, 'project'),
      createdAt: now,
      updatedAt: now,
      worktree: { mode: 'none' },
    });
    await writeAgentViewSessionState(
      {
        ...adoptingState(staleId),
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
      },
      { globalDir },
    );
    await writeAgentViewSessionState(adoptingState(liveId), { globalDir });
    await writeAgentViewWorker(
      staleId,
      {
        schemaVersion: 1,
        hostPid: process.pid,
        protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
        platform: process.platform,
        recentOutputBytes: 0,
      },
      { globalDir },
    );
    await writeAgentViewWorker(
      liveId,
      {
        schemaVersion: 1,
        hostPid: process.pid,
        protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
        platform: process.platform,
        recentOutputBytes: 0,
      },
      { globalDir },
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await expect(
        handler.adopt?.({
          sessionId: staleId,
          projectCwd: path.join(globalDir, 'project'),
          activeCwd: path.join(globalDir, 'project'),
          terminal: { columns: 80, rows: 24 },
        }),
      ).resolves.toEqual({
        sessionId: staleId,
        adopted: false,
        alreadyManaged: true,
      });
      await expect(
        readAgentViewSessionState(staleId, { globalDir }),
      ).resolves.toMatchObject({ ownership: 'adopting' });
      expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual(
        [],
      );
    } finally {
      killSpy.mockRestore();
    }

    await expect(
      handler.adopt?.({
        sessionId: liveId,
        projectCwd: path.join(globalDir, 'project'),
        activeCwd: path.join(globalDir, 'project'),
        terminal: { columns: 80, rows: 24 },
      }),
    ).resolves.toEqual({
      sessionId: liveId,
      adopted: false,
      alreadyManaged: true,
    });

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

  it('fails a stale adopting re-adoption into a terminal state', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    const now = new Date().toISOString();
    await writeAgentViewSessionState(
      {
        schemaVersion: 1,
        sessionId,
        ownership: 'adopting',
        sessionState: 'idle',
        processState: 'starting',
        attachState: 'detached',
        projectCwd: path.join(globalDir, 'project'),
        originalCwd: path.join(globalDir, 'project'),
        activeCwd: path.join(globalDir, 'project'),
        createdAt: now,
        updatedAt: now,
        worktree: { mode: 'none' },
      },
      { globalDir },
    );
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

    // The stale 'adopting' record must not be restored: the session lands in
    // a terminal unmanaged state so a later adopt can retry.
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
      workerReadyTimeoutMs: 15_000,
      launchPtyHost: async (launch) => {
        setImmediate(() => {
          void Promise.resolve(
            handler.workerEvent?.({
              type: 'ready',
              sessionId: launch.sessionId,
              token: launch.env['QWEN_AGENT_VIEW_TOKEN'],
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
    expect(host?.shutdowns).toBe(1);

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
    ).resolves.toEqual({
      sessionId: result.sessionId,
      accepted: true,
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
    expect(readyActivity).toMatchObject({ queuedPromptCount: 1 });

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
          promptId: expect.any(String),
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
    const firstPromptId = (
      await readAgentViewActivity(result.sessionId, { globalDir })
    )?.queuedPromptId;
    if (!firstPromptId) throw new Error('Missing queued prompt id.');
    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'working',
      promptId: firstPromptId,
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
      promptId: firstPromptId,
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
          promptId: expect.any(String),
          text: 'continue',
          at: expect.any(String),
        },
      ],
    });
    const secondPromptId = (
      await readAgentViewActivity(result.sessionId, { globalDir })
    )?.queuedPromptId;
    if (!secondPromptId) throw new Error('Missing queued prompt id.');
    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'needs_input',
      inputKind: 'soft',
      lastResult: 'Anything else?',
      promptId: secondPromptId,
    });
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.not.toMatchObject({ queuedPromptCount: 1 });
    await writeAgentViewActivity(
      result.sessionId,
      {
        schemaVersion: 1,
        inputKind: 'soft',
        queuedPromptCount: 1,
        queuedPromptPreview: 'legacy prompt',
        queuedPromptId: undefined,
        queuedPromptText: undefined,
        queuedPromptDeliveredAt: undefined,
        lastQueuedPromptAt: '2026-07-17T00:00:00.000Z',
        lastActivityAt: '2026-07-17T00:00:01.000Z',
        capabilities: ['reply', 'hibernate'],
      },
      { globalDir },
    );
    await expect(
      handler.peek?.({ sessionId: result.sessionId }),
    ).resolves.not.toMatchObject({
      activity: { queuedPromptCount: 1 },
    });
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

  it('does not queue a control when the queued-prompt marker write fails', async () => {
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

    // The marker write surfaces EISDIR; with the marker persisted before
    // the control push, the failed send leaves no control behind.
    const activityPath = getAgentViewSessionPaths(result.sessionId, {
      globalDir,
    }).activityPath;
    await fs.rm(activityPath);
    await fs.mkdir(activityPath);
    await expect(
      handler.send?.({ sessionId: result.sessionId, text: 'task A' }),
    ).rejects.toThrow();
    await expect(
      handler.workerControl?.({ sessionId: result.sessionId, token }),
    ).resolves.toMatchObject({ events: [] });

    // A retry after the store recovers delivers the prompt exactly once.
    await fs.rm(activityPath, { recursive: true, force: true });
    await expect(
      handler.send?.({ sessionId: result.sessionId, text: 'task A' }),
    ).resolves.toEqual({ sessionId: result.sessionId, sent: true });
    await expect(
      handler.workerControl?.({ sessionId: result.sessionId, token }),
    ).resolves.toMatchObject({
      events: [expect.objectContaining({ type: 'prompt', text: 'task A' })],
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('delivers a durable queued prompt after the daemon restarts', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const firstDaemon = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await firstDaemon.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    await firstDaemon.workerEvent?.({
      type: 'ready',
      sessionId: result.sessionId,
      token,
      cwd: globalDir,
    });
    const prompt = `first prompt ${'x'.repeat(700)}`;
    await expect(
      firstDaemon.send?.({
        sessionId: result.sessionId,
        text: prompt,
      }),
    ).resolves.toEqual({ sessionId: result.sessionId, sent: true });
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({ queuedPromptCount: 1 });

    // The durable prompt remains private at the supervisor API boundary.
    await expect(firstDaemon.list()).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activity: expect.objectContaining({ queuedPromptText: prompt }),
        }),
      ]),
    );
    await expect(
      firstDaemon.peek?.({ sessionId: result.sessionId }),
    ).resolves.not.toMatchObject({
      activity: { queuedPromptText: prompt },
    });
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      queuedPromptCount: 1,
      queuedPromptId: expect.any(String),
      queuedPromptText: prompt,
    });

    // A restarted daemon re-serves the prompt until the worker reports that
    // processing began. The pre-submit idle report must not acknowledge it.
    const restartedDaemon = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const control = (await restartedDaemon.workerControl?.({
      sessionId: result.sessionId,
      token,
    })) as { events: Array<{ type: string; promptId?: string }> };
    expect(control).toMatchObject({
      events: [
        expect.objectContaining({
          type: 'prompt',
          promptId: expect.any(String),
          text: prompt,
        }),
      ],
    });
    const queuedActivity = await readAgentViewActivity(result.sessionId, {
      globalDir,
    });
    expect(control.events[0]?.promptId).toBe(queuedActivity?.queuedPromptId);
    await restartedDaemon.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'idle',
    });
    await expect(
      restartedDaemon.workerControl?.({ sessionId: result.sessionId, token }),
    ).resolves.toMatchObject({
      events: [
        expect.objectContaining({ promptId: control.events[0]?.promptId }),
      ],
    });
    await expect(
      restartedDaemon.workerEvent?.({
        type: 'state',
        sessionId: result.sessionId,
        token,
        sessionState: 'working',
        promptId: control.events[0]?.promptId,
      }),
    ).resolves.toMatchObject({ accepted: true });
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({ sessionState: 'working' });
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({ queuedPromptDeliveredAt: expect.any(String) });
    const completedAt = (
      await readAgentViewActivity(result.sessionId, { globalDir })
    )?.lastQueuedPromptAt;
    await restartedDaemon.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'completed',
      promptId: control.events[0]?.promptId,
      at: completedAt,
    });
    await expect(
      restartedDaemon.workerControl?.({ sessionId: result.sessionId, token }),
    ).resolves.toMatchObject({ events: [] });
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.not.toMatchObject({ queuedPromptCount: 1 });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('persists prompt acknowledgements across restarts and transient reads', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const firstDaemon = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const { sessionId } = (await firstDaemon.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(sessionId, globalDir);
    await firstDaemon.workerEvent?.({
      type: 'ready',
      sessionId,
      token,
      cwd: globalDir,
    });
    await firstDaemon.send?.({ sessionId, text: 'create the PR' });
    const firstControl = (await firstDaemon.workerControl?.({
      sessionId,
      token,
    })) as { events: Array<{ type: string; promptId?: string }> };
    expect(firstControl).toMatchObject({
      events: [
        expect.objectContaining({ type: 'prompt', text: 'create the PR' }),
      ],
    });
    const firstPromptId = firstControl.events[0]?.promptId;
    if (!firstPromptId) throw new Error('Missing prompt id.');
    await expect(
      readAgentViewActivity(sessionId, { globalDir }),
    ).resolves.not.toMatchObject({
      queuedPromptDeliveredAt: expect.any(String),
    });
    await firstDaemon.workerEvent?.({
      type: 'state',
      sessionId,
      token,
      sessionState: 'working',
      promptId: firstPromptId,
    });
    await expect(
      readAgentViewActivity(sessionId, { globalDir }),
    ).resolves.toMatchObject({ queuedPromptDeliveredAt: expect.any(String) });

    const restartedDaemon = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    await restartedDaemon.workerEvent?.({
      type: 'state',
      sessionId,
      token,
      sessionState: 'completed',
      lastResult: 'done',
      promptId: firstPromptId,
    });
    await expect(
      readAgentViewActivity(sessionId, { globalDir }),
    ).resolves.not.toMatchObject({ queuedPromptCount: 1 });
    await expect(
      restartedDaemon.workerControl?.({ sessionId, token }),
    ).resolves.toMatchObject({ events: [] });

    await firstDaemon.send?.({ sessionId, text: 'task A' });
    const secondControl = (await firstDaemon.workerControl?.({
      sessionId,
      token,
    })) as { events: Array<{ type: string; promptId?: string }> };
    expect(secondControl).toMatchObject({
      events: [expect.objectContaining({ type: 'prompt', text: 'task A' })],
    });
    await firstDaemon.workerEvent?.({
      type: 'state',
      sessionId,
      token,
      sessionState: 'working',
      promptId: secondControl.events[0]?.promptId,
    });
    const readActivity = supervisorStore.readAgentViewActivity;
    let activityReads = 0;
    const readSpy = vi
      .spyOn(supervisorStore, 'readAgentViewActivity')
      .mockImplementation((...args) =>
        ++activityReads === 2
          ? Promise.resolve(undefined)
          : readActivity(...args),
      );
    try {
      await expect(
        firstDaemon.workerEvent?.({
          type: 'state',
          sessionId,
          token,
          sessionState: 'working',
        }),
      ).resolves.toMatchObject({ accepted: true });
    } finally {
      readSpy.mockRestore();
    }

    await expect(
      firstDaemon.workerControl?.({ sessionId, token }),
    ).resolves.toMatchObject({ events: [] });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('preserves a queued prompt across an unplanned host exit and respawn', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost(999_999_002 + hosts.length);
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
      handler.send?.({ sessionId: result.sessionId, text: 'follow up' }),
    ).resolves.toEqual({ sessionId: result.sessionId, sent: true });
    const firstControl = (await handler.workerControl?.({
      sessionId: result.sessionId,
      token,
    })) as { events: Array<{ type: string; promptId?: string }> };
    expect(firstControl).toMatchObject({
      events: [expect.objectContaining({ type: 'prompt', text: 'follow up' })],
    });
    const promptId = firstControl.events[0]?.promptId;
    if (!promptId) throw new Error('Missing prompt id.');
    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'working',
      promptId,
    });

    hosts[0]?.resolveExit(1);
    await waitForSessionState(
      result.sessionId,
      globalDir,
      (state) =>
        state.sessionState === 'failed' && state.processState === 'exited',
    );
    // The crash is unplanned, so the accepted prompt stays queued for the
    // next worker instead of being destroyed with the dead host.
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({ queuedPromptCount: 1 });

    await expect(
      handler.respawn?.({ sessionId: result.sessionId }),
    ).resolves.toEqual({ sessionId: result.sessionId, respawned: true });
    const nextToken = await readWorkerTokenForTest(result.sessionId, globalDir);
    const replacementControl = (await handler.workerControl?.({
      sessionId: result.sessionId,
      token: nextToken,
    })) as { events: Array<{ type: string; promptId?: string }> };
    expect(replacementControl).toMatchObject({
      events: [expect.objectContaining({ type: 'prompt', text: 'follow up' })],
    });
    expect(replacementControl.events[0]?.promptId).toBe(promptId);

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('rejects an old worker control request after respawn rotates its token', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost(999_999_002 + hosts.length);
        hosts.push(host);
        return host;
      },
    });
    const { sessionId } = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const oldToken = await readWorkerTokenForTest(sessionId, globalDir);
    await handler.workerEvent?.({
      type: 'ready',
      sessionId,
      token: oldToken,
      cwd: globalDir,
    });
    await handler.send?.({ sessionId, text: 'follow up' });
    const control = (await handler.workerControl?.({
      sessionId,
      token: oldToken,
    })) as { events: Array<{ promptId?: string }> };
    const promptId = control.events[0]?.promptId;
    if (!promptId) throw new Error('Missing prompt id.');
    await patchSessionStateForTest(sessionId, globalDir, {
      sessionState: 'completed',
      processState: 'exited',
    });

    let shutdownReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      shutdownReached = resolve;
    });
    let releaseShutdown!: () => void;
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    hosts[0]!.shutdown = async () => {
      shutdownReached();
      await shutdownGate;
      hosts[0]!.resolveExit(0);
    };

    const respawn = handler.respawn?.({ sessionId });
    await reached;
    const readWorker = supervisorStore.readAgentViewWorker;
    let oldRequestAuthenticated!: () => void;
    const authenticated = new Promise<void>((resolve) => {
      oldRequestAuthenticated = resolve;
    });
    const readSpy = vi
      .spyOn(supervisorStore, 'readAgentViewWorker')
      .mockImplementation(async (...args) => {
        const worker = await readWorker(...args);
        oldRequestAuthenticated();
        return worker;
      });
    try {
      const staleControl = handler.workerControl?.({
        sessionId,
        token: oldToken,
      });
      await Promise.race([
        authenticated,
        new Promise((resolve) => setTimeout(resolve, 25)),
      ]);
      releaseShutdown();
      await expect(respawn).resolves.toMatchObject({ respawned: true });
      await expect(staleControl).rejects.toThrow('worker token is invalid');
    } finally {
      releaseShutdown();
      readSpy.mockRestore();
    }

    const newToken = await readWorkerTokenForTest(sessionId, globalDir);
    await expect(
      handler.workerControl?.({ sessionId, token: newToken }),
    ).resolves.toMatchObject({
      events: [expect.objectContaining({ type: 'prompt', promptId })],
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('answers needs-input sessions and recovers stale attach markers', async () => {
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
    await patchSessionStateForTest(result.sessionId, globalDir, {
      attachState: 'attached',
    });
    await expect(
      handler.answer?.({ sessionId: result.sessionId, text: 'yes' }),
    ).resolves.toEqual({ sessionId: result.sessionId, answered: true });
    await handler.workerControl?.({
      sessionId: result.sessionId,
      token,
    });

    await patchSessionStateForTest(result.sessionId, globalDir, {
      attachState: 'detached',
    });
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

  it('does not answer a different question that appears during reconnect', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const { sessionId } = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(sessionId, globalDir);
    await handler.workerEvent?.({
      type: 'state',
      sessionId,
      token,
      sessionState: 'needs_input',
      waitingFor: 'approval-a',
    });

    const readActivity = supervisorStore.readAgentViewActivity;
    let activityReads = 0;
    let releaseRead = () => {};
    const readBlocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let markReadStarted = () => {};
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const readSpy = vi
      .spyOn(supervisorStore, 'readAgentViewActivity')
      .mockImplementation(async (...args) => {
        if (++activityReads === 2) {
          markReadStarted();
          await readBlocked;
        }
        return readActivity(...args);
      });
    try {
      const answer = handler.answer?.({ sessionId, text: 'yes' });
      await readStarted;
      const state = await readAgentViewSessionState(sessionId, { globalDir });
      const activity = await readAgentViewActivity(sessionId, { globalDir });
      if (!state || !activity) throw new Error('Missing test session.');
      const changedAt = new Date(
        Date.parse(state.updatedAt) + 1000,
      ).toISOString();
      await writeAgentViewSessionState(
        { ...state, updatedAt: changedAt },
        { globalDir },
      );
      await writeAgentViewActivity(
        sessionId,
        {
          ...activity,
          waitingFor: 'approval-b',
          lastActivityAt: changedAt,
        },
        { globalDir },
      );
      releaseRead();
      await expect(answer).rejects.toThrow(
        'is no longer waiting for the same input',
      );
    } finally {
      releaseRead();
      readSpy.mockRestore();
    }
    await expect(
      handler.workerControl?.({ sessionId, token }),
    ).resolves.toMatchObject({ events: [] });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('does not revive a stopped session during an attach handshake', async () => {
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
    const originalPatch = supervisorStore.patchAgentViewSessionState;
    let releaseAttachWrite = () => {};
    const attachWriteBlocked = new Promise<void>((resolve) => {
      releaseAttachWrite = resolve;
    });
    let markAttachWriteStarted = () => {};
    const attachWriteStarted = new Promise<void>((resolve) => {
      markAttachWriteStarted = resolve;
    });
    const patchSpy = vi
      .spyOn(supervisorStore, 'patchAgentViewSessionState')
      .mockImplementation(async (sessionId, patch, options) => {
        if (patch.attachState === 'attached') {
          markAttachWriteStarted();
          await attachWriteBlocked;
        }
        return originalPatch(sessionId, patch, options);
      });
    const socket = new FakeAttachSocket();
    const attached = handler.attachStream?.(
      { sessionId: result.sessionId },
      socket as unknown as Socket,
      'request-1',
    );
    await attachWriteStarted;

    await handler.stop?.({ sessionId: result.sessionId });
    await expect(
      handler.respawn?.({ sessionId: result.sessionId }),
    ).rejects.toThrow('currently attached');
    await expect(
      handler.send?.({ sessionId: result.sessionId, text: 'follow up' }),
    ).rejects.toThrow('currently attached elsewhere');
    expect(hosts).toHaveLength(1);

    releaseAttachWrite();
    await socket.waitForOutput('request-1');
    socket.closeInput();
    await attached;
    patchSpy.mockRestore();
    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('leaves the stream open when attach setup fails', async () => {
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
    const patchState = supervisorStore.patchAgentViewSessionState;
    const patchSpy = vi
      .spyOn(supervisorStore, 'patchAgentViewSessionState')
      .mockImplementation((sessionId, patch, options) => {
        if (patch.attachState === 'attached') {
          throw new Error('attach state write failed');
        }
        return patchState(sessionId, patch, options);
      });
    const socket = new FakeAttachSocket();

    try {
      await expect(
        handler.attachStream?.(
          { sessionId: result.sessionId },
          socket as unknown as Socket,
          'request-1',
        ),
      ).rejects.toThrow('attach state write failed');
      expect(socket.writableEnded).toBe(false);
    } finally {
      patchSpy.mockRestore();
      socket.closeInput();
      await fs.rm(globalDir, { recursive: true, force: true });
    }
  });

  it('rejects send and answer while a live attach is open', async () => {
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
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'needs_input',
      waitingFor: 'approval',
    });
    const socket = new FakeAttachSocket();
    const attached = handler.attachStream?.(
      { sessionId: result.sessionId },
      socket as unknown as Socket,
      'request-1',
    );
    await socket.waitForOutput('request-1');

    await expect(
      handler.send?.({ sessionId: result.sessionId, text: 'follow up' }),
    ).rejects.toThrow('currently attached elsewhere');
    await expect(
      handler.answer?.({ sessionId: result.sessionId, text: 'yes' }),
    ).rejects.toThrow('currently attached elsewhere');

    socket.closeInput();
    await attached;

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
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        launchCount++;
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
    await Promise.all([
      firstSocket.waitForOutput('request-1'),
      secondSocket.waitForOutput('request-2'),
    ]);

    expect(launchCount).toBe(2);
    // The winner is whichever attach acquires the setup lock first, which
    // is nondeterministic; assert the pair of outcomes, not the order.
    const outcomes = [
      JSON.parse(firstSocket.outputLine()) as {
        id: string;
        ok: boolean;
        error?: { code?: string };
      },
      JSON.parse(secondSocket.outputLine()) as {
        id: string;
        ok: boolean;
        error?: { code?: string };
      },
    ];
    expect(outcomes.map((o) => o.id).sort()).toEqual([
      'request-1',
      'request-2',
    ]);
    expect(outcomes.find((o) => o.ok)).toMatchObject({ ok: true });
    expect(outcomes.find((o) => !o.ok)).toMatchObject({
      ok: false,
      error: { code: 'already_attached' },
    });

    firstSocket.closeInput();
    secondSocket.closeInput();
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
      launchPtyHost: async () => fakePtyHost(999_999_002),
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
        const host = fakePtyHost(999_999_004 + hosts.length);
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
      workerPid: 999_999_004,
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
      launchPtyHost: async () => fakePtyHost(999_999_002),
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
      launchPtyHost: async () => fakePtyHost(999_999_004),
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
      launchPtyHost: async () => fakePtyHost(999_999_002),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const worker = await readAgentViewWorker(result.sessionId, { globalDir });
    if (!worker) {
      throw new Error('Missing worker state.');
    }
    const hostEndpoint = shortHostSocketPath();
    await writeAgentViewWorker(
      result.sessionId,
      {
        ...worker,
        hostEndpoint: hostEndpoint.path,
      },
      { globalDir },
    );
    const launchPtyHost = vi.fn(async () => fakePtyHost(999_999_005));
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
        code: 'pty_launch_failed',
        message: expect.stringContaining('is still starting'),
      },
    });
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'starting',
      processState: 'starting',
    });

    await fs.rm(globalDir, { recursive: true, force: true });
    if (hostEndpoint.dir) {
      await fs.rm(hostEndpoint.dir, { recursive: true, force: true });
    }
  });

  it('respawns failed or stopped sessions on attach', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(999_999_002),
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
      const host = fakePtyHost(999_999_005 + hosts.length);
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
        expect.arrayContaining([`--resume=${result.sessionId}`]),
      );
      expect(argv).not.toContain('--session-id');
      expect(argv).not.toContain('--prompt-interactive');
    }

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('clears a stale persisted attach before respawning a stopped session on attach', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(999_999_002),
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
    // A daemon restart during an attach leaves this flag behind.
    await writeAgentViewSessionState(
      {
        ...state,
        sessionState: 'stopped',
        processState: 'exited',
        attachState: 'attached',
      },
      { globalDir },
    );
    const recoveredHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(999_999_005),
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

  it('respawns a stopped session on attach instead of bridging to the old host', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost(999_999_002 + hosts.length);
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
    expect(hosts[0]?.shutdowns).toBe(1);
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

  it('reconnects a persisted PTY host before respawning on attach', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(999_999_002),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const liveHost = fakePtyHost(999_999_005);
    const hostEndpoint = shortHostSocketPath();
    const hostServer = createAgentViewPtyHostServer(
      liveHost,
      hostEndpoint.path,
    );
    await hostServer.listen();
    const worker = await readAgentViewWorker(result.sessionId, { globalDir });
    if (!worker) {
      throw new Error('Missing worker state.');
    }
    await writeAgentViewWorker(
      result.sessionId,
      {
        ...worker,
        hostEndpoint: hostEndpoint.path,
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
      workerPid: 999_999_005,
      hostEndpoint: hostEndpoint.path,
    });

    socket.closeInput();
    await attached;
    await hostServer.close();
    await fs.rm(globalDir, { recursive: true, force: true });
    if (hostEndpoint.dir) {
      await fs.rm(hostEndpoint.dir, { recursive: true, force: true });
    }
  });

  it('reconnects a persisted PTY host for logs and stop', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(999_999_002),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const liveHost = fakePtyHost(999_999_005);
    liveHost.output.append('hello logs');
    const hostEndpoint = shortHostSocketPath();
    const hostServer = createAgentViewPtyHostServer(
      liveHost,
      hostEndpoint.path,
    );
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
        hostEndpoint: hostEndpoint.path,
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
    const restartedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
    });
    await restartedHandler.list();
    await expect(
      restartedHandler.workerControl?.({
        sessionId: result.sessionId,
        token,
      }),
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
    if (hostEndpoint.dir) {
      await fs.rm(hostEndpoint.dir, { recursive: true, force: true });
    }
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
    ).resolves.toEqual({
      sessionId: result.sessionId,
      accepted: true,
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

  it('respawns a refreshed stopped session on the first attempt', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(999_999_002),
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
    // A supervisor dying inside the graceful-stop window leaves the record
    // claiming the worker is still alive.
    await writeAgentViewSessionState(
      {
        ...state,
        sessionState: 'stopped',
        processState: 'alive',
        attachState: 'detached',
      },
      { globalDir },
    );
    const hosts: FakePtyHost[] = [];
    const readState = supervisorStore.readAgentViewSessionState;
    let spawned = false;
    let workerAtFirstPostSpawnRead: AgentViewWorkerFile | undefined;
    const readSpy = vi
      .spyOn(supervisorStore, 'readAgentViewSessionState')
      .mockImplementation(async (...args) => {
        if (spawned && !workerAtFirstPostSpawnRead) {
          workerAtFirstPostSpawnRead = await readAgentViewWorker(
            result.sessionId,
            { globalDir },
          );
        }
        return readState(...args);
      });
    const recoveredHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost(999_999_005);
        hosts.push(host);
        spawned = true;
        return host;
      },
    });

    try {
      await expect(
        recoveredHandler.respawn?.({ sessionId: result.sessionId }),
      ).resolves.toEqual({ sessionId: result.sessionId, respawned: true });
    } finally {
      readSpy.mockRestore();
    }
    expect(workerAtFirstPostSpawnRead).toMatchObject({
      hostPid: 999_999_001,
      workerPid: 999_999_005,
    });
    // The refresh repairs the record with a new updatedAt; the respawn must
    // not mistake that rewrite for a user stop and kill the fresh host.
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.killedWith).toBeUndefined();
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'starting',
      processState: 'starting',
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('fails closed instead of signaling unauthenticated stored pids', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(999_999_002, 999_999_001),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const recoveredHandler = createAgentViewSupervisorHandler({
        globalDir,
        platform: 'linux',
        launchPtyHost: async () => fakePtyHost(999_999_003, 999_999_004),
      });
      await expect(
        recoveredHandler.stop?.({ sessionId: result.sessionId }),
      ).rejects.toThrow('identity cannot be verified');
      await expect(
        recoveredHandler.respawn?.({ sessionId: result.sessionId }),
      ).rejects.toThrow();
      const signalled = killSpy.mock.calls
        .filter(([, signal]) => signal !== 0)
        .map(([pid]) => pid);
      expect(signalled).toEqual([]);
      await expect(
        readAgentViewSessionState(result.sessionId, { globalDir }),
      ).resolves.toMatchObject({
        sessionState: 'starting',
        processState: 'starting',
      });
    } finally {
      killSpy.mockRestore();
    }

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('fails closed when worker liveness data is unreadable', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const workerPath = getAgentViewSessionPaths(result.sessionId, {
      globalDir,
    }).workerPath;
    await fs.writeFile(workerPath, '{ invalid json');
    const recoveredHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
    });

    await expect(
      recoveredHandler.stop?.({ sessionId: result.sessionId }),
    ).rejects.toThrow('temporarily unreadable');
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({ processState: 'starting' });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('clears stale worker pids with the terminal heal', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(999_999_002, 999_999_001),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    await patchSessionStateForTest(result.sessionId, globalDir, {
      sessionState: 'working',
      processState: 'alive',
    });
    const recoveredHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
    });

    await recoveredHandler.list();

    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'failed',
      processState: 'exited',
    });
    const worker = JSON.parse(
      await fs.readFile(
        getAgentViewSessionPaths(result.sessionId, { globalDir }).workerPath,
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(worker).not.toHaveProperty('hostPid');
    expect(worker).not.toHaveProperty('workerPid');

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('preserves a queued prompt across a stop and a send-triggered revive', async () => {
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
      handler.send?.({ sessionId: result.sessionId, text: 'first prompt' }),
    ).resolves.toEqual({ sessionId: result.sessionId, sent: true });
    await expect(
      handler.stop?.({ sessionId: result.sessionId }),
    ).resolves.toEqual({ sessionId: result.sessionId, stopped: true });

    // The revive keeps the accepted prompt queued (and its persisted
    // marker), so the follow-up send must reject instead of silently
    // dropping the first prompt.
    await expect(
      handler.send?.({ sessionId: result.sessionId, text: 'second prompt' }),
    ).rejects.toThrow('is waiting for the previous response');

    // The replacement worker receives only the accepted prompt: the
    // superseded stop control was filtered before launch.
    const nextToken = await readWorkerTokenForTest(result.sessionId, globalDir);
    await expect(
      handler.workerControl?.({
        sessionId: result.sessionId,
        token: nextToken,
      }),
    ).resolves.toMatchObject({
      events: [
        expect.objectContaining({ type: 'prompt', text: 'first prompt' }),
      ],
    });
    expect(hosts).toHaveLength(2);
    expect(hosts[0]?.shutdowns).toBe(1);

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('does not requeue a predecessor stop during respawn healing', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost(999_999_002 + hosts.length);
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
    ).resolves.toEqual({ sessionId: result.sessionId, stopped: true });

    let retireReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      retireReached = resolve;
    });
    let releaseRetire!: () => void;
    const retireGate = new Promise<void>((resolve) => {
      releaseRetire = resolve;
    });
    const predecessor = hosts[0];
    predecessor!.shutdown = async () => {
      retireReached();
      await retireGate;
      predecessor!.shutdowns += 1;
      predecessor!.resolveExit(0);
    };

    const respawn = handler.respawn?.({ sessionId: result.sessionId });
    await reached;
    const listSnapshots = supervisorStore.listAgentViewSessionSnapshots;
    let snapshotsRead!: () => void;
    const read = new Promise<void>((resolve) => {
      snapshotsRead = resolve;
    });
    const snapshotSpy = vi
      .spyOn(supervisorStore, 'listAgentViewSessionSnapshots')
      .mockImplementation(async (...args) => {
        const snapshots = await listSnapshots(...args);
        snapshotsRead();
        return snapshots;
      });
    const list = handler.list();
    await read;
    await expect(list).resolves.toHaveLength(1);
    snapshotSpy.mockRestore();
    releaseRetire();

    await expect(respawn).resolves.toEqual({
      sessionId: result.sessionId,
      respawned: true,
    });
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    await expect(
      handler.workerControl?.({ sessionId: result.sessionId, token }),
    ).resolves.toMatchObject({ events: [] });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('does not queue a stop control for an unauthenticated stored worker', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(999_999_002, 999_999_001),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const recoveredHandler = createAgentViewSupervisorHandler({
        globalDir,
        platform: 'linux',
        launchPtyHost: async () => fakePtyHost(999_999_003, 999_999_004),
      });
      await expect(
        recoveredHandler.stop?.({ sessionId: result.sessionId }),
      ).rejects.toThrow('identity cannot be verified');
      await expect(
        recoveredHandler.workerControl?.({
          sessionId: result.sessionId,
          token,
        }),
      ).resolves.toMatchObject({ events: [] });
      expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual(
        [],
      );
    } finally {
      killSpy.mockRestore();
    }

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('serializes kill with a concurrent respawn', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const hosts: FakePtyHost[] = [];
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => {
        const host = fakePtyHost(999_999_002 + hosts.length);
        hosts.push(host);
        return host;
      },
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const first = hosts[0];
    if (!first) throw new Error('Missing first PTY host.');
    first.kill = (signal) => {
      first.killedWith = signal;
    };

    const killing = handler.kill?.({ sessionId: result.sessionId });
    await waitFor(() => first.killedWith === 'SIGKILL');
    const respawning = handler.respawn?.({ sessionId: result.sessionId });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hosts).toHaveLength(1);

    first.resolveExit(1);
    await expect(killing).resolves.toMatchObject({ killed: true });
    await expect(respawning).resolves.toMatchObject({ respawned: true });
    expect(hosts).toHaveLength(2);
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'starting',
      processState: 'starting',
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('bounds the wait when a killed host never exits', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const host = fakePtyHost();
    let markKillCalled = () => {};
    const killCalled = new Promise<void>((resolve) => {
      markKillCalled = resolve;
    });
    host.kill = (signal) => {
      host.killedWith = signal;
      markKillCalled();
    };
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => host,
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };

    vi.useFakeTimers();
    try {
      const killing = handler.kill?.({
        sessionId: result.sessionId,
      }) as Promise<unknown>;
      await killCalled;
      const outcome = killing?.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(10_001);
      await expect(outcome).resolves.toMatchObject({
        message: expect.stringContaining('Timed out waiting'),
      });
    } finally {
      vi.useRealTimers();
    }

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
        const host = fakePtyHost(999_999_002 + hosts.length);
        hosts.push(host);
        return host;
      },
    });
    const result = (await handler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, globalDir);
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
    expect(hosts).toHaveLength(2);
    expect(launches[1]).toMatchObject({
      entrypoint: process.argv[1],
      argv: [process.execPath, process.argv[1], `--resume=${result.sessionId}`],
    });
    await expect(
      readAgentViewLaunch(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      entrypoint: process.argv[1],
      argv: [process.execPath, process.argv[1], `--resume=${result.sessionId}`],
    });
    await expect(
      readAgentViewWorker(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      workerPid: 999_999_003,
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

  it('maps an unplanned non-zero exit of a live session to failed', async () => {
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

    hosts[0]?.resolveExit(1);
    await waitForSessionState(
      result.sessionId,
      globalDir,
      (state) =>
        state.sessionState === 'failed' && state.processState === 'exited',
    );

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('maps a clean exit of a live session to completed', async () => {
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

    hosts[0]?.resolveExit(0);
    await waitForSessionState(
      result.sessionId,
      globalDir,
      (state) =>
        state.sessionState === 'completed' && state.processState === 'exited',
    );

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('does not turn an unreachable remote host into a terminal verdict', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const host = fakePtyHost();
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => host,
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

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      host.resolveUnreachable();
      await vi.waitFor(async () => {
        await expect(
          handler.peek?.({ sessionId: result.sessionId }),
        ).resolves.toMatchObject({ live: false });
      });
      await expect(
        readAgentViewSessionState(result.sessionId, { globalDir }),
      ).resolves.toMatchObject({
        sessionState: 'idle',
        processState: 'alive',
      });
      expect(killSpy.mock.calls.filter(([, signal]) => signal !== 0)).toEqual(
        [],
      );
    } finally {
      killSpy.mockRestore();
    }

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('keeps a queued prompt marker that is newer than the worker event', async () => {
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
    await expect(
      handler.send?.({ sessionId: result.sessionId, text: 'queued prompt' }),
    ).resolves.toEqual({ sessionId: result.sessionId, sent: true });
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({ queuedPromptCount: 1 });

    const queuedAt = (
      await readAgentViewActivity(result.sessionId, { globalDir })
    )?.lastQueuedPromptAt;
    if (!queuedAt) throw new Error('Missing queued prompt timestamp.');
    // Millisecond-equal events can still predate the accepted send, so they
    // must not dequeue the fresh marker.
    await handler.workerEvent?.({
      type: 'state',
      sessionId: result.sessionId,
      token,
      sessionState: 'needs_input',
      waitingFor: 'response',
      at: queuedAt,
    });
    await expect(
      readAgentViewActivity(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      queuedPromptCount: 1,
      queuedPromptPreview: 'queued prompt',
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('labels a host crash while hibernating as failed', async () => {
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
    await patchSessionStateForTest(result.sessionId, globalDir, {
      processState: 'hibernating',
    });

    hosts[0]?.resolveExit(1);
    // A crash mid-hibernation is a failure, not a clean hibernation.
    await waitForSessionState(
      result.sessionId,
      globalDir,
      (state) =>
        state.sessionState === 'failed' && state.processState === 'exited',
    );

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
        const host = fakePtyHost(999_999_002 + hosts.length);
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
    // Poll across a bounded window: the stale host exit must never clobber
    // the respawned session's state.
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(
        readAgentViewSessionState(result.sessionId, { globalDir }),
      ).resolves.toMatchObject({
        sessionState: 'starting',
        processState: 'starting',
      });
    }
    await expect(
      readAgentViewWorker(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      workerPid: 999_999_003,
    });

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('garbage collects only expired unmanaged tombstones', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    await writeAgentViewSessionState(
      managedSessionStateForTest('expired', globalDir, {
        ownership: 'unmanaged',
        processState: 'exited',
        updatedAt: '2026-08-01T00:00:00.000Z',
      }),
      { globalDir },
    );
    await writeAgentViewSessionState(
      managedSessionStateForTest('recent', globalDir, {
        ownership: 'unmanaged',
        processState: 'exited',
        updatedAt: '2026-08-20T00:00:00.000Z',
      }),
      { globalDir },
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      now: () => new Date('2026-08-21T00:00:00.000Z'),
    });

    await expect(handler.list()).resolves.toEqual([]);
    await expect(
      readAgentViewSessionState('expired', { globalDir }),
    ).resolves.toBeUndefined();
    await expect(
      readAgentViewSessionState('recent', { globalDir }),
    ).resolves.toMatchObject({ ownership: 'unmanaged' });

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
        const host = fakePtyHost(999_999_002 + hosts.length);
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
    expect(hosts[0]?.killedWith).toBeUndefined();
    expect(hosts[0]?.shutdowns).toBe(1);
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

  it('finishes an interrupted remove after a daemon restart', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const { sessionId } = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    const state = await readAgentViewSessionState(sessionId, { globalDir });
    if (!state) throw new Error('Missing test session.');
    await writeAgentViewSessionState(
      { ...state, ownership: 'removing' },
      { globalDir },
    );
    const restarted = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
    });

    await expect(restarted.list()).resolves.toEqual([]);
    await expect(readAgentViewRoster({ globalDir })).resolves.toMatchObject({
      sessions: [],
    });
    await expect(
      readAgentViewSessionState(sessionId, { globalDir }),
    ).resolves.toMatchObject({
      ownership: 'unmanaged',
      processState: 'exited',
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

  it('rejects a dispatch with a blank prompt', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });

    await expect(
      handler.dispatch?.({ prompt: '   ', cwd: globalDir }),
    ).rejects.toThrow('Agent View dispatch prompt cannot be empty.');

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('rejects send and answer with blank text', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const sessionId = '123e4567-e89b-12d3-a456-426614174000';
    await writeAgentViewSessionState(
      managedSessionStateForTest(sessionId, globalDir),
      { globalDir },
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });

    await expect(handler.send?.({ sessionId, text: '   ' })).rejects.toThrow(
      'Agent View message text is required.',
    );
    await expect(handler.answer?.({ sessionId, text: '' })).rejects.toThrow(
      'Agent View message text is required.',
    );

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('rejects an ambiguous session id prefix', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    await writeAgentViewSessionState(
      managedSessionStateForTest(
        'aaaaaaaa-0000-0000-0000-000000000001',
        globalDir,
      ),
      { globalDir },
    );
    await writeAgentViewSessionState(
      managedSessionStateForTest(
        'aaaaaaaa-0000-0000-0000-000000000002',
        globalDir,
      ),
      { globalDir },
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });

    await expect(
      handler.send?.({ sessionId: 'aaaaaaaa', text: 'hello' }),
    ).rejects.toThrow(
      'Agent View session id aaaaaaaa is ambiguous. Use a longer id.',
    );

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
        const host = fakePtyHost(999_999_002 + hosts.length);
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
    expect(hosts[0]?.shutdowns).toBe(1);
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({ processState: 'hibernated' });
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
    expect(hosts[1]?.shutdowns).toBe(1);

    await handler.respawn?.({ sessionId: result.sessionId });
    await writeSessionStateForTest(result.sessionId, globalDir, 'idle');
    await patchSessionStateForTest(result.sessionId, globalDir, {
      attachState: 'attached',
    });
    await expect(handler.hibernateIdleSessions()).resolves.toEqual({
      hibernated: [],
    });
    expect(hosts[2]?.killedWith).toBeUndefined();

    await patchSessionStateForTest(result.sessionId, globalDir, {
      attachState: 'detached',
    });
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
    expect(hosts[2]?.shutdowns).toBe(1);

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('restores alive when a prompt lands inside the hibernation mark window', async () => {
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
        const host = fakePtyHost(999_999_002 + hosts.length);
        hosts.push(host);
        return host;
      },
    });
    const first = (await handler.dispatch?.({
      prompt: 'task A',
      cwd: globalDir,
    })) as { sessionId: string };
    const second = (await handler.dispatch?.({
      prompt: 'task B',
      cwd: globalDir,
    })) as { sessionId: string };
    await writeSessionStateForTest(first.sessionId, globalDir, 'idle');
    await writeSessionStateForTest(second.sessionId, globalDir, 'idle');
    // The sweep processes snapshots newest-updatedAt first: second (:03)
    // before first (:02), so gating second's shutdown suspends the sweep
    // ahead of first's mark.
    await patchSessionStateForTest(second.sessionId, globalDir, {
      updatedAt: '2026-07-17T00:00:03.000Z',
    });
    await patchSessionStateForTest(first.sessionId, globalDir, {
      updatedAt: '2026-07-17T00:00:02.000Z',
    });

    let gateReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      gateReached = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gatedHost = hosts[1];
    gatedHost!.shutdown = async () => {
      gateReached();
      await gate;
      // The sweep now confirms the exit before the hibernated verdict: the
      // gated drain must settle the exit like a real drain completing.
      gatedHost!.shutdowns += 1;
      gatedHost!.resolveExit(0);
    };

    const sweep = handler.hibernateIdleSessions();
    await reached;
    // A real send lands on first after the sweep's snapshot read. The prompt
    // lock serializes its durable write ahead of hibernation's final gate.
    await expect(
      handler.send?.({ sessionId: first.sessionId, text: 'late prompt' }),
    ).resolves.toEqual({ sessionId: first.sessionId, sent: true });
    releaseGate();

    await expect(sweep).resolves.toEqual({ hibernated: [second.sessionId] });
    await expect(
      readAgentViewSessionState(first.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      sessionState: 'idle',
      processState: 'alive',
    });
    await expect(
      readAgentViewSessionState(second.sessionId, { globalDir }),
    ).resolves.toMatchObject({ processState: 'hibernated' });
    expect(hosts[0]?.killedWith).toBeUndefined();
    const firstToken = await readWorkerTokenForTest(first.sessionId, globalDir);
    await expect(
      handler.workerControl?.({
        sessionId: first.sessionId,
        token: firstToken,
      }),
    ).resolves.toMatchObject({
      events: [
        expect.objectContaining({ type: 'prompt', text: 'late prompt' }),
      ],
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

  it('does not auto-exit when disabled, empty, or a worker is still alive', async () => {
    const emptyDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const emptyShutdown = vi.fn();
    const emptyHandler = createAgentViewSupervisorHandler({
      globalDir: emptyDir,
      platform: 'linux',
      onShutdown: emptyShutdown,
      hibernationPolicy: { idleMs: 1000, autoExitGraceMs: 0 },
      now: () => new Date('2026-07-17T00:00:10.000Z'),
    });
    await expect(emptyHandler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: false,
    });
    expect(emptyShutdown).not.toHaveBeenCalled();
    await fs.rm(emptyDir, { recursive: true, force: true });

    const activeDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const activeShutdown = vi.fn();
    const activeHandler = createAgentViewSupervisorHandler({
      globalDir: activeDir,
      platform: 'linux',
      onShutdown: activeShutdown,
      hibernationPolicy: { idleMs: 1000, autoExitGraceMs: 0 },
      now: () => new Date('2026-07-17T00:00:10.000Z'),
      launchPtyHost: async () => fakePtyHost(),
    });
    await activeHandler.dispatch?.({
      prompt: 'write tests',
      cwd: activeDir,
    });
    await expect(activeHandler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: false,
    });
    expect(activeShutdown).not.toHaveBeenCalled();
    await fs.rm(activeDir, { recursive: true, force: true });

    const disabledDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const disabledShutdown = vi.fn();
    const disabledHandler = createAgentViewSupervisorHandler({
      globalDir: disabledDir,
      platform: 'linux',
      onShutdown: disabledShutdown,
      hibernationPolicy: {
        idleMs: 1000,
        autoExit: false,
        autoExitGraceMs: 0,
      },
      now: () => new Date('2026-07-17T00:00:10.000Z'),
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await disabledHandler.dispatch?.({
      prompt: 'write tests',
      cwd: disabledDir,
    })) as { sessionId: string };
    const token = await readWorkerTokenForTest(result.sessionId, disabledDir);
    await disabledHandler.workerEvent?.({
      type: 'ready',
      sessionId: result.sessionId,
      token,
      cwd: disabledDir,
      at: '2026-07-17T00:00:00.000Z',
    });
    await expect(disabledHandler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [result.sessionId],
      shutdownRequested: false,
    });
    expect(disabledShutdown).not.toHaveBeenCalled();
    await fs.rm(disabledDir, { recursive: true, force: true });
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

  it('restarts the auto-exit grace period after a session becomes alive again', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const onShutdown = vi.fn();
    let nowMs = Date.parse('2026-07-17T00:00:10.000Z');
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      onShutdown,
      hibernationPolicy: { idleMs: 1000, autoExitGraceMs: 60_000 },
      now: () => new Date(nowMs),
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

    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [result.sessionId],
      shutdownRequested: false,
    });

    nowMs += 60_000;
    await patchSessionStateForTest(result.sessionId, globalDir, {
      processState: 'alive',
    });
    // Simulate a real respawn: update the worker record with a running
    // PID so refreshMissingWorkerState recognizes the session as alive.
    const worker = await readAgentViewWorker(result.sessionId, {
      globalDir,
    });
    if (worker) {
      await writeAgentViewWorker(
        result.sessionId,
        { ...worker, hostPid: process.pid },
        { globalDir },
      );
    }
    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: false,
    });

    await patchSessionStateForTest(result.sessionId, globalDir, {
      processState: 'hibernated',
    });
    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: false,
    });

    nowMs += 60_000;
    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: true,
    });
    expect(onShutdown).toHaveBeenCalledOnce();

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('does not auto-exit while an adoption is in flight', async () => {
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
    await patchSessionStateForTest(result.sessionId, globalDir, {
      processState: 'hibernated',
    });
    const adoptingId = '223e4567-e89b-12d3-a456-426614174000';
    const now = new Date().toISOString();
    await writeAgentViewSessionState(
      {
        schemaVersion: 1,
        sessionId: adoptingId,
        ownership: 'adopting',
        sessionState: 'idle',
        processState: 'starting',
        attachState: 'detached',
        projectCwd: globalDir,
        originalCwd: globalDir,
        activeCwd: globalDir,
        createdAt: now,
        updatedAt: now,
        worktree: { mode: 'none' },
      },
      { globalDir },
    );

    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: false,
    });
    expect(onShutdown).not.toHaveBeenCalled();

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('keeps a stale adoption with live unverified pids fail-closed', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const sessionId = '223e4567-e89b-12d3-a456-426614174000';
    const staleAt = '2026-07-17T00:00:00.000Z';
    const onShutdown = vi.fn();
    await writeAgentViewSessionState(
      {
        schemaVersion: 1,
        sessionId,
        ownership: 'adopting',
        sessionState: 'idle',
        processState: 'starting',
        attachState: 'detached',
        projectCwd: globalDir,
        originalCwd: globalDir,
        activeCwd: globalDir,
        createdAt: staleAt,
        updatedAt: staleAt,
        worktree: { mode: 'none' },
      },
      { globalDir },
    );
    await writeAgentViewWorker(
      sessionId,
      {
        schemaVersion: 1,
        hostPid: process.pid,
        workerPid: process.pid,
        protocolVersion: AGENT_VIEW_PROTOCOL_VERSION,
        platform: process.platform,
        recentOutputBytes: 0,
      },
      { globalDir },
    );
    await upsertAgentViewRosterEntry(
      {
        sessionId,
        projectCwd: globalDir,
        activeCwd: globalDir,
        createdAt: staleAt,
        updatedAt: staleAt,
      },
      { globalDir },
    );
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      onShutdown,
      hibernationPolicy: { idleMs: 1000, autoExitGraceMs: 0 },
      now: () => new Date('2026-07-17T00:00:20.000Z'),
      launchPtyHost: async () => fakePtyHost(),
    });

    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: false,
    });
    await expect(
      readAgentViewSessionState(sessionId, { globalDir }),
    ).resolves.toMatchObject({
      ownership: 'adopting',
      processState: 'starting',
    });
    await expect(
      readAgentViewWorker(sessionId, { globalDir }),
    ).resolves.toMatchObject({
      hostPid: expect.any(Number),
      workerPid: expect.any(Number),
    });
    await expect(readAgentViewRoster({ globalDir })).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId })],
    });
    expect(onShutdown).not.toHaveBeenCalled();

    await fs.rm(globalDir, { recursive: true, force: true });
  });

  it('repairs stale lifecycle state when its persisted host reconnects', async () => {
    const globalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-store-'),
    );
    const seedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      launchPtyHost: async () => fakePtyHost(),
    });
    const result = (await seedHandler.dispatch?.({
      prompt: 'write tests',
      cwd: globalDir,
    })) as { sessionId: string };
    await patchSessionStateForTest(result.sessionId, globalDir, {
      ownership: 'adopting',
      processState: 'starting',
      updatedAt: '2026-07-17T00:00:00.000Z',
    });
    const liveHost = fakePtyHost();
    const hostEndpoint = shortHostSocketPath();
    const hostServer = createAgentViewPtyHostServer(
      liveHost,
      hostEndpoint.path,
    );
    await hostServer.listen();
    const worker = await readAgentViewWorker(result.sessionId, { globalDir });
    if (!worker) throw new Error('Missing worker state.');
    await writeAgentViewWorker(
      result.sessionId,
      { ...worker, hostEndpoint: hostEndpoint.path },
      { globalDir },
    );
    await clearAgentViewWorkerPids(result.sessionId, { globalDir });
    const launchPtyHost = vi.fn(async () => {
      throw new Error('must not spawn');
    });
    const recoveredHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      now: () => new Date('2026-07-17T00:01:00.000Z'),
      hibernationPolicy: { autoExit: false },
      launchPtyHost,
    });

    await expect(
      recoveredHandler.adopt?.({
        sessionId: result.sessionId,
        projectCwd: globalDir,
        activeCwd: globalDir,
        terminal: { columns: 80, rows: 24 },
      }),
    ).resolves.toMatchObject({ adopted: false, alreadyManaged: true });
    expect(launchPtyHost).not.toHaveBeenCalled();
    await expect(recoveredHandler.list()).resolves.toEqual([
      expect.objectContaining({
        sessionId: result.sessionId,
        state: expect.objectContaining({
          ownership: 'managed',
          processState: 'alive',
        }),
      }),
    ]);
    await expect(
      readAgentViewSessionState(result.sessionId, { globalDir }),
    ).resolves.toMatchObject({
      ownership: 'managed',
      processState: 'alive',
    });

    await patchSessionStateForTest(result.sessionId, globalDir, {
      sessionState: 'idle',
      processState: 'hibernating',
    });
    const restartedHandler = createAgentViewSupervisorHandler({
      globalDir,
      platform: 'linux',
      hibernationPolicy: { autoExit: false },
    });
    await expect(
      restartedHandler.logs?.({ sessionId: result.sessionId }),
    ).resolves.toMatchObject({ live: true });
    const patchSpy = vi
      .spyOn(supervisorStore, 'patchAgentViewSessionStateIf')
      .mockRejectedValueOnce(new Error('transient write failure'));
    await expect(restartedHandler.list()).resolves.toEqual([
      expect.objectContaining({
        state: expect.objectContaining({ processState: 'hibernating' }),
      }),
    ]);
    await expect(restartedHandler.list()).resolves.toEqual([
      expect.objectContaining({
        state: expect.objectContaining({ processState: 'alive' }),
      }),
    ]);
    patchSpy.mockRestore();
    await expect(
      restartedHandler.send?.({
        sessionId: result.sessionId,
        text: 'follow up',
      }),
    ).resolves.toMatchObject({ sent: true });

    await hostServer.close();
    await fs.rm(globalDir, { recursive: true, force: true });
    if (hostEndpoint.dir) {
      await fs.rm(hostEndpoint.dir, { recursive: true, force: true });
    }
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
    expect(hosts[0]?.shutdowns).toBe(1);
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
    expect(hosts).toHaveLength(2);
    expect(hosts[1]?.killedWith).toBeUndefined();
    expect(onShutdown).toHaveBeenCalledTimes(2);

    await fs.rm(globalDir, { recursive: true, force: true });
  });
});

type FakePtyHost = AgentViewPtyHostHandle & {
  killedWith?: string;
  shutdowns: number;
  input: string;
  resizes: Array<{ columns: number; rows: number }>;
  emitData(data: string): void;
  resolveExit(exitCode: number): void;
  resolveUnreachable(): void;
};

function fakePtyHost(
  workerPid = 999_999_002,
  hostPid = 999_999_001,
): FakePtyHost {
  let resolveExit: (exit: AgentViewPtyHostExit) => void = () => {};
  let dataCallbacks: Array<(data: string) => void> = [];
  const host: FakePtyHost = {
    pid: hostPid,
    workerPid,
    command: ['fake'],
    output: new BoundedOutputRing(100),
    input: '',
    resizes: [],
    shutdowns: 0,
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
      if (signal === 'SIGKILL') {
        resolveExit({ kind: 'confirmed-kill' });
      }
    },
    shutdown: () => {
      host.shutdowns += 1;
      resolveExit({ kind: 'exited', exitCode: 0 });
    },
    resolveExit: (exitCode) => {
      resolveExit({ kind: 'exited', exitCode });
    },
    resolveUnreachable: () => {
      resolveExit({ kind: 'unreachable' });
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

async function patchSessionStateForTest(
  sessionId: string,
  globalDir: string,
  patch: Partial<AgentViewSessionStateFile>,
): Promise<void> {
  const state = await readAgentViewSessionState(sessionId, { globalDir });
  if (!state) {
    throw new Error(`Missing state for ${sessionId}`);
  }
  await writeAgentViewSessionState({ ...state, ...patch }, { globalDir });
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
  globalDir: string,
): Promise<string> {
  const launch = await readAgentViewLaunch(sessionId, { globalDir });
  const token = launch?.env['QWEN_AGENT_VIEW_TOKEN'];
  if (!token) {
    throw new Error(`Missing worker token for ${sessionId}`);
  }
  return token;
}

function managedSessionStateForTest(
  sessionId: string,
  globalDir: string,
  overrides: Partial<AgentViewSessionStateFile> = {},
): AgentViewSessionStateFile {
  return {
    schemaVersion: 1,
    sessionId,
    ownership: 'managed',
    sessionState: 'idle',
    processState: 'alive',
    attachState: 'detached',
    projectCwd: globalDir,
    originalCwd: globalDir,
    activeCwd: globalDir,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    worktree: { mode: 'none' },
    ...overrides,
  };
}

function shortHostSocketPath(): { path: string; dir?: string } {
  const unique = `qah-${process.pid}-${Date.now()}`;
  if (process.platform === 'win32') {
    return { path: `\\\\.\\pipe\\${unique}` };
  }
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), `${unique}-`));
  return { path: path.join(dir, 'host.sock'), dir };
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
  for (let attempt = 0; attempt < 500; attempt++) {
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
