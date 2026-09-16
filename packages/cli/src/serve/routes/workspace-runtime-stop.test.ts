/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readCronTasks } from '@qwen-code/qwen-code-core/services/cronTasksFile.js';
import {
  registerWorkspaceRuntimeStopRoutes,
  type WorkspaceRuntimeStopDeps,
} from './workspace-runtime-stop.js';
import { sendBridgeError } from '../server/error-response.js';
import { readWorkspaceActivity } from '../workspace-activity.js';
import type {
  WorkspaceRuntime,
  WorkspaceRegistry,
} from '../workspace-registry.js';
import type { BridgeRuntimeStopResult } from '@qwen-code/acp-bridge/bridgeTypes';
vi.mock(
  '@qwen-code/qwen-code-core/services/cronTasksFile.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/services/cronTasksFile.js')
    >()),
    readCronTasks: vi.fn(async () => []),
  }),
);
beforeEach(() => {
  vi.mocked(readCronTasks).mockResolvedValue([]);
});
const confirmation = {
  confirmInterruptions: true,
  expectedChannelId: 'child',
  expectedRuntimeEpoch: 2,
  expectedStopToken: 'token',
  expectedSessionIds: ['s1'],
};
function setup() {
  const snapshot = {
    channelId: 'child',
    runtimeEpoch: 2,
    stopToken: 'token',
    sessions: [
      {
        sessionId: 's1',
        hasActivePrompt: true,
        queuedPrompts: 0,
        isWaitingForPermission: false,
        isWaitingForUserQuestion: false,
      },
    ],
    blockedReasons: [] as string[],
    lastStop: undefined as BridgeRuntimeStopResult | undefined,
  };
  const stop = vi.fn(
    async (): Promise<BridgeRuntimeStopResult> => ({
      channelId: 'child',
      runtimeEpoch: 2,
      stopToken: 'token',
      state: 'stopped',
      stopped: true,
      released: true,
      affectedSessionIds: ['s1'],
      closedSessionIds: ['s1'],
      interruptedSessionIds: ['s1'],
      remainingSessionIds: [],
    }),
  );
  const runtime = {
    workspaceId: 'selected',
    workspaceCwd: '/selected',
    sessionRuntimeBaseDir: '/runtime',
    trusted: true,
    primary: false,
    bridge: {
      sessionCount: 1,
      activePromptCount: 1,
      getRuntimeStopSnapshot: () => snapshot,
      stopWorkspaceRuntime: stop,
      getWorkspaceRuntimeLifecycleSnapshot: () => ({
        state: 'busy',
        runtimeLive: true,
        runtimeEpoch: 2,
        activeWork: true,
      }),
    },
  } as unknown as WorkspaceRuntime;
  const entry = {
    workspaceId: runtime.workspaceId,
    workspaceCwd: runtime.workspaceCwd,
    state: 'active',
    current: { runtime, guard: { closed: false } },
  };
  const registry = {
    getEntryByWorkspaceId: (id: string) =>
      id === 'selected' ? entry : undefined,
    listManaged: () => [runtime],
  } as unknown as WorkspaceRegistry;
  const deps: WorkspaceRuntimeStopDeps = {
    workspaceRegistry: registry,
    mutate: () => (_req, _res, next) => next(),
    safeBody: (req) => req.body as Record<string, unknown>,
    sendBridgeError,
    available: () => true,
    ownsBridge: () => true,
    getCapacity: () => ({ committedAcpChildren: 1, maxConcurrentChildren: 1 }),
    getActivity: () => readWorkspaceActivity(runtime),
    scheduledWorkActive: () => false,
    stopKeepalive: vi.fn(),
    startKeepalive: vi.fn(),
  };
  const app = express();
  app.use(express.json());
  registerWorkspaceRuntimeStopRoutes(app, deps);
  return { app, deps, runtime, entry, snapshot, stop };
}
describe('workspace runtime stop routes', () => {
  it('lists ordinary loaded sessions without starting or stopping the runtime', async () => {
    const h = setup();
    const response = await request(h.app).get(
      '/workspaces/runtime-stop-options',
    );
    expect(response.status).toBe(200);
    expect(response.body.workspaces[0].blockedReasons).toEqual([]);
    expect(response.body.workspaces[0]).toMatchObject({
      workspaceId: 'selected',
      canStop: true,
      sessions: [{ sessionId: 's1', hasActivePrompt: true }],
    });
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.deps.stopKeepalive).not.toHaveBeenCalled();
  });
  it('requires explicit complete confirmation', async () => {
    const h = setup();
    expect(
      (await request(h.app).post('/workspaces/selected/runtime/stop').send({}))
        .status,
    ).toBe(400);
    expect(h.stop).not.toHaveBeenCalled();
  });
  it('stops only the selected runtime and restores only its own scheduler gate', async () => {
    const h = setup();
    const response = await request(h.app)
      .post('/workspaces/selected/runtime/stop')
      .send(confirmation);
    expect(response.status).toBe(200);
    expect(response.body.released).toBe(true);
    expect(h.stop).toHaveBeenCalledExactlyOnceWith(confirmation);
    expect(h.deps.stopKeepalive).toHaveBeenCalledExactlyOnceWith(h.runtime);
    expect(h.deps.startKeepalive).toHaveBeenCalledExactlyOnceWith(h.runtime);
  });
  it.each([
    'acpConnections',
    'memoryTasks',
    'channelWorkers',
    'voiceSessions',
    'pendingSessionStarts',
  ] as const)(
    'blocks independent %s without closing sessions',
    async (field) => {
      const h = setup();
      h.deps.getActivity = () => ({
        ...readWorkspaceActivity(h.runtime),
        [field]: 1,
      });
      const response = await request(h.app)
        .post('/workspaces/selected/runtime/stop')
        .send(confirmation);
      expect(response.status).toBe(409);
      expect(response.body.preview.blockedReasons).toContain(field);
      expect(h.stop).not.toHaveBeenCalled();
    },
  );
  it('fails closed when scheduled tasks cannot be read', async () => {
    const h = setup();
    vi.mocked(readCronTasks).mockRejectedValue(new Error('unreadable'));
    const response = await request(h.app)
      .post('/workspaces/selected/runtime/stop')
      .send(confirmation);
    expect(response.body.preview.blockedReasons).toContain(
      'scheduled_tasks_unknown',
    );
    expect(h.stop).not.toHaveBeenCalled();
  });
  it('never falls back to primary for an unknown selector', async () => {
    const h = setup();
    const response = await request(h.app)
      .post('/workspaces/missing/runtime/stop')
      .send(confirmation);
    expect(response.status).toBe(400);
    expect(h.stop).not.toHaveBeenCalled();
  });
  it('rechecks a removed generation after async task inspection', async () => {
    const h = setup();
    vi.mocked(readCronTasks).mockImplementation(async () => {
      h.entry.state = 'removed';
      return [];
    });
    expect(
      (
        await request(h.app)
          .post('/workspaces/selected/runtime/stop')
          .send(confirmation)
      ).status,
    ).toBe(409);
    expect(h.stop).not.toHaveBeenCalled();
  });
  it('rejects untrusted selected runtimes', async () => {
    const h = setup();
    Object.defineProperty(h.runtime, 'trusted', { value: false });
    expect(
      (
        await request(h.app)
          .post('/workspaces/selected/runtime/stop')
          .send(confirmation)
      ).status,
    ).toBe(403);
    expect(h.stop).not.toHaveBeenCalled();
  });
  it('observes the previous receipt without repeating a stop', async () => {
    const h = setup();
    h.snapshot.lastStop = await h.stop();
    h.stop.mockClear();
    const response = await request(h.app)
      .post('/workspaces/selected/runtime/stop')
      .send(confirmation);
    expect(response.status).toBe(200);
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.deps.stopKeepalive).not.toHaveBeenCalled();
  });
});
