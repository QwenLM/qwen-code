/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage, type MeshAgent } from '@qwen-code/qwen-code-core';
import {
  makeBridge,
  makeChannel,
} from '@qwen-code/acp-bridge/internal/testUtils';
import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import {
  getWorkspaceSessionInfoForResponse,
  listLiveWorkspaceSessionsForResponse,
  listWorkspaceSessionsForResponse,
} from '../server/session-list.js';
import { startMeshHostSessionOwner } from './mesh-host-session.js';

const AGENT: MeshAgent = { id: 'ag_alice', name: 'alice', createdAt: 1 };

async function writeStoredSession(
  workspace: string,
  sessionId: string,
  sourceType: string,
  mtime: Date,
): Promise<void> {
  const chatsDir = path.join(new Storage(workspace).getProjectDir(), 'chats');
  await fs.mkdir(chatsDir, { recursive: true });
  const filePath = path.join(chatsDir, `${sessionId}.jsonl`);
  const records = [
    {
      uuid: `${sessionId}-user`,
      parentUuid: null,
      sessionId,
      timestamp: mtime.toISOString(),
      type: 'user',
      message: { role: 'user', parts: [{ text: sessionId }] },
      cwd: workspace,
    },
    {
      uuid: `${sessionId}-source`,
      parentUuid: `${sessionId}-user`,
      sessionId,
      timestamp: mtime.toISOString(),
      type: 'system',
      subtype: 'session_source',
      systemPayload: { sourceType },
      cwd: workspace,
    },
  ];
  await fs.writeFile(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  await fs.utimes(filePath, mtime, mtime);
}

describe('mesh host session owner', () => {
  let scratch: string;
  let workspace: string;

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-host-test-'));
    workspace = path.join(scratch, 'workspace');
    await fs.mkdir(workspace);
    Storage.setRuntimeBaseDir(scratch);
  });

  afterEach(async () => {
    Storage.setRuntimeBaseDir(null);
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it('owns one hidden session and revives it before the next launch', async () => {
    let resident = false;
    let spawnCount = 0;
    const resumes: string[] = [];
    const launches: string[] = [];
    const bridge = {
      recordHeartbeat: (sessionId: string) => {
        if (!resident) throw new Error(`${sessionId} was reaped`);
      },
      spawnOrAttach: vi.fn(async () => {
        spawnCount++;
        resident = true;
        return { sessionId: `mesh-host-${spawnCount}` };
      }),
      resumeSession: vi.fn(async ({ sessionId }: { sessionId: string }) => {
        resumes.push(sessionId);
        resident = true;
        return { sessionId };
      }),
      closeSession: vi.fn(async () => {}),
      launchMeshAgent: vi.fn(async (sessionId: string, agentId: string) => {
        launches.push(`${sessionId}:${agentId}`);
        return {
          status: 'started' as const,
          runtimeId: `local:mesh-${agentId}`,
          backgroundAgentId: `mesh-${agentId}`,
          sessionId,
        };
      }),
    } as unknown as AcpSessionBridge;
    const owner = startMeshHostSessionOwner({
      bridge,
      workspaceCwd: workspace,
      intervalMs: 60_000,
      resumeTimeoutMs: 1_000,
    });

    await expect(owner.launch(AGENT, 'first')).resolves.toMatchObject({
      status: 'started',
      sessionId: 'mesh-host-1',
    });
    resident = false;
    const startedAt = performance.now();
    await owner.tick();
    const reloadMs = performance.now() - startedAt;
    await expect(owner.launch(AGENT, 'second')).resolves.toMatchObject({
      status: 'started',
      sessionId: 'mesh-host-1',
    });
    owner.stop();

    expect(spawnCount).toBe(1);
    expect(resumes).toEqual(['mesh-host-1']);
    expect(launches).toEqual(['mesh-host-1:ag_alice', 'mesh-host-1:ag_alice']);
    expect(reloadMs).toBeLessThan(1_000);
  });

  it('closes the losing host when two owners start concurrently', async () => {
    let releaseSpawns: (() => void) | undefined;
    const bothSpawned = new Promise<void>((resolve) => {
      releaseSpawns = resolve;
    });
    let spawnCount = 0;
    const bridge = {
      recordHeartbeat: vi.fn(),
      spawnOrAttach: vi.fn(async () => {
        const sessionId = `mesh-host-${++spawnCount}`;
        if (spawnCount === 2) releaseSpawns?.();
        await bothSpawned;
        return { sessionId };
      }),
      resumeSession: vi.fn(),
      closeSession: vi.fn(async () => {}),
      launchMeshAgent: vi.fn(),
    } as unknown as AcpSessionBridge;
    const owners = [
      startMeshHostSessionOwner({
        bridge,
        workspaceCwd: workspace,
        intervalMs: 60_000,
      }),
      startMeshHostSessionOwner({
        bridge,
        workspaceCwd: workspace,
        intervalMs: 60_000,
      }),
    ];
    try {
      const sessionIds = await Promise.all(
        owners.map((owner) => owner.ensureResident()),
      );
      expect(new Set(sessionIds).size).toBe(1);
      expect(bridge.spawnOrAttach).toHaveBeenCalledTimes(2);
      expect(bridge.closeSession).toHaveBeenCalledOnce();
      expect(bridge.closeSession).not.toHaveBeenCalledWith(sessionIds[0]);
    } finally {
      owners.forEach((owner) => owner.stop());
    }
  });

  it('reloads after the daemon bridge reaper closes the host', async () => {
    const handles: ReturnType<typeof makeChannel>[] = [];
    const bridge = makeBridge({
      boundWorkspace: workspace,
      sessionReapIntervalMs: 10,
      sessionIdleTimeoutMs: 20,
      channelFactory: async () => {
        const handle = makeChannel({
          extMethodImpl: (method, params) =>
            method === SERVE_CONTROL_EXT_METHODS.sessionMeshAgentLaunch
              ? {
                  status: 'started',
                  runtimeId: `local:mesh-${String(params['agentId'])}`,
                  backgroundAgentId: `mesh-${String(params['agentId'])}`,
                  sessionId: String(params['sessionId']),
                }
              : method === SERVE_CONTROL_EXT_METHODS.sessionClose
                ? { closed: true, holds: [] }
                : {},
        });
        handles.push(handle);
        return handle.channel;
      },
    });
    const owner = startMeshHostSessionOwner({
      bridge,
      workspaceCwd: workspace,
      intervalMs: 60_000,
      resumeTimeoutMs: 1_000,
    });
    try {
      const sessionId = await owner.ensureResident();
      await vi.waitFor(() => expect(bridge.sessionCount).toBe(0), {
        timeout: 2_000,
      });
      const startedAt = performance.now();
      await expect(owner.launch(AGENT, 'after reaper')).resolves.toMatchObject({
        status: 'started',
        sessionId,
      });
      const reloadMs = performance.now() - startedAt;

      expect(handles).toHaveLength(2);
      expect(handles[0]?.killed).toBe(true);
      expect(reloadMs).toBeLessThan(1_000);
    } finally {
      owner.stop();
      await bridge.shutdown();
    }
  });

  it('is excluded from the unfiltered session catalog', async () => {
    const bridge = {
      listWorkspaceSessions: () => [
        {
          sessionId: 'default-session',
          cwd: workspace,
          sourceType: 'default',
        },
        { sessionId: 'mesh-host', cwd: workspace, sourceType: 'mesh' },
      ],
    } as unknown as AcpSessionBridge;

    const result = await listWorkspaceSessionsForResponse(
      bridge,
      workspace,
      undefined,
      { runtimeBaseDir: scratch },
    );
    expect(result.sessions.map((session) => session.sessionId)).toEqual([
      'default-session',
    ]);
    const liveResult = await listLiveWorkspaceSessionsForResponse(
      bridge,
      workspace,
      undefined,
      { runtimeBaseDir: scratch },
    );
    expect(liveResult.sessions.map((session) => session.sessionId)).toEqual([
      'default-session',
    ]);
    await expect(
      getWorkspaceSessionInfoForResponse(bridge, workspace),
    ).resolves.toMatchObject({ active: 0, total: 0, live: 1 });
  });

  it('filters persisted hosts before paginating public catalogs', async () => {
    const visibleId = '00000000-0000-4000-8000-000000000001';
    const hiddenId = '00000000-0000-4000-8000-000000000002';
    await writeStoredSession(
      workspace,
      visibleId,
      'default',
      new Date('2026-09-06T00:00:00.000Z'),
    );
    await writeStoredSession(
      workspace,
      hiddenId,
      'mesh',
      new Date('2026-09-06T00:01:00.000Z'),
    );
    const bridge = {
      listWorkspaceSessions: () => [],
    } as unknown as AcpSessionBridge;

    const page = await listWorkspaceSessionsForResponse(
      bridge,
      workspace,
      { size: 1 },
      { runtimeBaseDir: scratch, mergeLive: false },
    );
    expect(page.sessions.map((session) => session.sessionId)).toEqual([
      visibleId,
    ]);
    expect(page.nextCursor).toBeUndefined();

    const organized = await listWorkspaceSessionsForResponse(
      bridge,
      workspace,
      { size: 1, view: 'organized' },
      { runtimeBaseDir: scratch, mergeLive: false },
    );
    expect(organized.sessions.map((session) => session.sessionId)).toEqual([
      visibleId,
    ]);

    const explicitMesh = await listWorkspaceSessionsForResponse(
      bridge,
      workspace,
      { sourceType: 'mesh' },
      { runtimeBaseDir: scratch, mergeLive: false },
    );
    expect(explicitMesh.sessions).toEqual([]);

    await expect(
      getWorkspaceSessionInfoForResponse(bridge, workspace),
    ).resolves.toMatchObject({ active: 1, archived: 0, total: 1, live: 0 });
  });

  it('does not duplicate a resume that outlives its deadline', async () => {
    const first = startMeshHostSessionOwner({
      bridge: {
        recordHeartbeat: () => {},
        spawnOrAttach: async () => ({ sessionId: 'mesh-host' }),
        resumeSession: async () => ({ sessionId: 'mesh-host' }),
        closeSession: async () => {},
        launchMeshAgent: async () => ({ status: 'capacity_wait' as const }),
      } as unknown as AcpSessionBridge,
      workspaceCwd: workspace,
      intervalMs: 60_000,
    });
    await first.ensureResident();
    first.stop();

    let settleResume: (() => void) | undefined;
    const resumeSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleResume = resolve;
        }),
    );
    const owner = startMeshHostSessionOwner({
      bridge: {
        recordHeartbeat: () => {
          throw new Error('reaped');
        },
        spawnOrAttach: async () => ({ sessionId: 'unexpected' }),
        resumeSession,
        closeSession: async () => {},
        launchMeshAgent: async () => ({ status: 'capacity_wait' as const }),
      } as unknown as AcpSessionBridge,
      workspaceCwd: workspace,
      intervalMs: 60_000,
      resumeTimeoutMs: 5,
    });

    await expect(owner.tick()).rejects.toThrow(/timed out/);
    await expect(owner.tick()).rejects.toThrow(/timed out/);
    expect(resumeSession).toHaveBeenCalledOnce();
    settleResume?.();
    owner.stop();
  });
});
