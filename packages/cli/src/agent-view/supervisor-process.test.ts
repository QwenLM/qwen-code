/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Socket } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentViewSessionStateFile } from './protocol.js';
import {
  createAgentViewSupervisorHandler,
  getAgentViewSupervisorSocketPath,
} from './supervisor-process.js';
import {
  getAgentViewSessionPaths,
  writeAgentViewSessionState,
} from './supervisor-store.js';

describe('getAgentViewSupervisorSocketPath', () => {
  it('returns a named pipe on win32', () => {
    const socketPath = getAgentViewSupervisorSocketPath({
      globalDir: '/tmp/qwen-agent-view-win',
      platform: 'win32',
    });
    expect(socketPath.startsWith('\\\\.\\pipe\\qwen-agent-view-')).toBe(true);
  });

  it('returns a daemon-dir socket for short unix paths', () => {
    const globalDir = '/tmp/qwen-av';
    const socketPath = getAgentViewSupervisorSocketPath({
      globalDir,
      platform: 'linux',
    });
    expect(socketPath).toBe(path.join(globalDir, 'daemon', 'supervisor.sock'));
  });

  it('falls back to the runtime dir for long unix paths', () => {
    const globalDir = path.join(os.tmpdir(), `qwen-${'x'.repeat(200)}`);
    const runtimeDir = '/tmp/qwen-runtime';
    const socketPath = getAgentViewSupervisorSocketPath({
      globalDir,
      platform: 'linux',
      runtimeDir,
    });
    expect(socketPath.startsWith(`${path.join(runtimeDir)}${path.sep}`)).toBe(
      true,
    );
    expect(socketPath.endsWith('.sock')).toBe(true);
  });

  it('is deterministic for the same global dir', () => {
    const globalDir = '/tmp/qwen-agent-view-deterministic';
    expect(
      getAgentViewSupervisorSocketPath({ globalDir, platform: 'linux' }),
    ).toBe(getAgentViewSupervisorSocketPath({ globalDir, platform: 'linux' }));
  });

  it('isolates the tmpdir fallback socket in a per-uid directory', () => {
    if (process.platform === 'win32') return;
    const globalDir = path.join(os.tmpdir(), `qwen-${'x'.repeat(200)}`);
    const socketPath = getAgentViewSupervisorSocketPath({
      globalDir,
      platform: 'linux',
    });
    const uid = process.getuid?.();
    expect(socketPath).toContain(
      `${path.sep}qwen-agent-view-${uid}${path.sep}`,
    );
    expect(socketPath.endsWith('.sock')).toBe(true);
  });
});

describe('createAgentViewSupervisorHandler', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupDirs
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function makeGlobalDir(): Promise<string> {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-agent-view-process-'),
    );
    cleanupDirs.push(dir);
    return dir;
  }

  async function writeSession(
    globalDir: string,
    overrides: Partial<AgentViewSessionStateFile> = {},
  ): Promise<void> {
    await writeAgentViewSessionState(
      {
        schemaVersion: 1,
        sessionId: 'session-1',
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
        ...overrides,
      },
      { globalDir },
    );
  }

  it('reports session count and socket path in status', async () => {
    const globalDir = await makeGlobalDir();
    await writeSession(globalDir);
    const handler = createAgentViewSupervisorHandler({ globalDir });

    const status = (await handler.status()) as {
      state: string;
      socketPath: string;
      sessions: number;
    };

    expect(status.state).toBe('ready');
    expect(status.sessions).toBe(1);
    expect(status.socketPath).toBe(
      getAgentViewSupervisorSocketPath({
        globalDir,
        platform: process.platform,
      }),
    );
  });

  it('reports status even when a jobs entry cannot be read', async () => {
    const globalDir = await makeGlobalDir();
    await writeSession(globalDir);
    // A directory where state.json should be makes the read fail with EISDIR;
    // status must stay healthy rather than wedge on the bad entry.
    const bad = getAgentViewSessionPaths('bad', { globalDir });
    await fs.mkdir(bad.statePath, { recursive: true });
    const handler = createAgentViewSupervisorHandler({ globalDir });

    const status = (await handler.status()) as {
      state: string;
      sessions: number;
    };
    expect(status.state).toBe('ready');
    expect(status.sessions).toBe(1);
  });

  it('acknowledges subscribers and registers a close handler', () => {
    const handler = createAgentViewSupervisorHandler({
      globalDir: '/tmp/qwen-agent-view-subscribe',
    });
    const writes: string[] = [];
    let onClose: (() => void) | undefined;
    const socket = {
      write: (chunk: string) => {
        writes.push(chunk);
      },
      once: (event: string, listener: () => void) => {
        if (event === 'close') onClose = listener;
      },
    } as unknown as Socket;

    handler.subscribe?.(undefined, socket, 'req-1');

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? '')).toEqual({
      id: 'req-1',
      ok: true,
      result: { subscribed: true },
    });
    expect(onClose).toBeTypeOf('function');
    expect(() => onClose?.()).not.toThrow();
  });

  it('does not request shutdown when there are no sessions', async () => {
    const globalDir = await makeGlobalDir();
    const onShutdown = vi.fn();
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      hibernationPolicy: { autoExitGraceMs: 0 },
      onShutdown,
    });

    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: false,
    });
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('does not request shutdown when autoExit is disabled', async () => {
    const globalDir = await makeGlobalDir();
    await writeSession(globalDir);
    const onShutdown = vi.fn();
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      hibernationPolicy: { autoExit: false, autoExitGraceMs: 0 },
      onShutdown,
    });

    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: false,
    });
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('does not request shutdown while a managed session is still alive', async () => {
    const globalDir = await makeGlobalDir();
    await writeSession(globalDir, { processState: 'alive' });
    const onShutdown = vi.fn();
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      hibernationPolicy: { autoExitGraceMs: 0 },
      onShutdown,
    });

    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: false,
    });
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('does not request shutdown when a session is not managed', async () => {
    const globalDir = await makeGlobalDir();
    await writeSession(globalDir, { ownership: 'unmanaged' });
    const onShutdown = vi.fn();
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      hibernationPolicy: { autoExitGraceMs: 0 },
      onShutdown,
    });

    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: false,
    });
    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('requests shutdown once only-inactive managed sessions pass the grace period', async () => {
    const globalDir = await makeGlobalDir();
    await writeSession(globalDir);
    const onShutdown = vi.fn();
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      hibernationPolicy: { autoExitGraceMs: 0 },
      onShutdown,
    });

    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: true,
    });
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('requests shutdown when only-exited managed sessions pass the grace period', async () => {
    const globalDir = await makeGlobalDir();
    await writeSession(globalDir, { processState: 'exited' });
    const onShutdown = vi.fn();
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      hibernationPolicy: { autoExitGraceMs: 0 },
      onShutdown,
    });

    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: true,
    });
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('waits for the grace period to elapse before requesting shutdown', async () => {
    const globalDir = await makeGlobalDir();
    await writeSession(globalDir);
    let nowMs = 1_000_000;
    const onShutdown = vi.fn();
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      hibernationPolicy: { autoExitGraceMs: 5_000 },
      now: () => new Date(nowMs),
      onShutdown,
    });

    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: false,
    });

    nowMs += 4_999;
    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: false,
    });

    nowMs += 1;
    await expect(handler.tickIdleHibernation()).resolves.toEqual({
      hibernated: [],
      shutdownRequested: true,
    });
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('restarts the auto-exit grace period when a session becomes active again', async () => {
    const globalDir = await makeGlobalDir();
    await writeSession(globalDir);
    let nowMs = 1_000_000;
    const onShutdown = vi.fn();
    const handler = createAgentViewSupervisorHandler({
      globalDir,
      hibernationPolicy: { autoExitGraceMs: 5_000 },
      now: () => new Date(nowMs),
      onShutdown,
    });

    await expect(handler.tickIdleHibernation()).resolves.toMatchObject({
      shutdownRequested: false,
    });

    nowMs += 5_000;
    await writeSession(globalDir, { processState: 'alive' });
    await expect(handler.tickIdleHibernation()).resolves.toMatchObject({
      shutdownRequested: false,
    });

    await writeSession(globalDir, { processState: 'hibernated' });
    await expect(handler.tickIdleHibernation()).resolves.toMatchObject({
      shutdownRequested: false,
    });

    nowMs += 5_000;
    await expect(handler.tickIdleHibernation()).resolves.toMatchObject({
      shutdownRequested: true,
    });
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });
});
