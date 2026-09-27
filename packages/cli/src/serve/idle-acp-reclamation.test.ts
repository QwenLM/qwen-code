/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createChildHeapPolicy,
  type ChildHeapMode,
} from '@qwen-code/acp-bridge/childHeapPolicy';
import { resolveDaemonMemoryBudget } from '@qwen-code/acp-bridge/daemonMemoryBudget';
import { ProcessRegistry } from '@qwen-code/acp-bridge/processRegistry';
import { createIdleAcpReclaimer } from './idle-acp-reclamation.js';
import {
  readWorkspaceActivity,
  type WorkspaceRemovalActivity,
} from './workspace-activity.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from './workspace-registry.js';

function makeRuntime(
  id: string,
  lastUsedAt: number,
  primary = false,
): WorkspaceRuntime {
  return {
    workspaceId: id,
    workspaceCwd: `/tmp/${id}`,
    trusted: true,
    primary,
    env: { mode: 'parent-process', overlayKeys: [], envFilePaths: [] },
    bridge: {
      sessionCount: 0,
      activePromptCount: 0,
      getIdleChannelCandidate: vi.fn(() => ({
        channelId: id,
        runtimeEpoch: 1,
        lastUsedAt,
      })),
      reclaimIdleChannel: vi.fn().mockResolvedValue(true),
      getWorkspaceRuntimeLifecycleSnapshot: () => ({
        state: 'idle',
        runtimeLive: true,
        runtimeEpoch: 1,
        activeWork: false,
      }),
    },
  } as unknown as WorkspaceRuntime;
}

function setup(mode: ChildHeapMode) {
  const a = makeRuntime('a', 10, true);
  const b = makeRuntime('b', 20);
  const c = makeRuntime('c', 30);
  const runtimes = [a, b, c];
  const registry = createWorkspaceRegistry(runtimes);
  const processes = new ProcessRegistry();
  const policy = createChildHeapPolicy({
    budget: resolveDaemonMemoryBudget({ availableMemoryMb: 2048 }),
    mode,
  });
  const occupied = processes.reserve();
  const getActivity = vi.fn(
    (runtime: WorkspaceRuntime): WorkspaceRemovalActivity | undefined =>
      readWorkspaceActivity(runtime),
  );
  const ownsBridge = vi.fn(() => true);
  const reclaim = createIdleAcpReclaimer({
    registry,
    processes,
    policy,
    ownsBridge,
    getActivity,
  });
  return {
    a,
    b,
    c,
    registry,
    processes,
    occupied,
    reclaim,
    getActivity,
    ownsBridge,
  };
}

describe.each(['admit', 'enforce'] as const)('idle ACP (%s)', (mode) => {
  it('reclaims the oldest eligible workspace once, excluding the requester', async () => {
    const { a, b, c, reclaim } = setup(mode);
    const controller = new AbortController();
    await reclaim('a', controller.signal);
    expect(a.bridge.reclaimIdleChannel).not.toHaveBeenCalled();
    expect(b.bridge.reclaimIdleChannel).toHaveBeenCalledTimes(1);
    expect(b.bridge.reclaimIdleChannel).toHaveBeenCalledWith(
      { channelId: 'b', runtimeEpoch: 1, lastUsedAt: 20 },
      controller.signal,
    );
    expect(c.bridge.reclaimIdleChannel).not.toHaveBeenCalled();
  });

  it('does not let an untrusted requester reclaim trusted workspaces', async () => {
    const { a, b, c, reclaim } = setup(mode);
    Object.assign(a, { trusted: false });
    await reclaim('a');
    for (const runtime of [a, b, c])
      expect(runtime.bridge.reclaimIdleChannel).not.toHaveBeenCalled();
  });

  it('continues scanning when an eligible runtime has no idle channel', async () => {
    const { a, b, reclaim } = setup(mode);
    vi.mocked(a.bridge.getIdleChannelCandidate!).mockReturnValue(undefined);
    await reclaim('new');
    expect(a.bridge.reclaimIdleChannel).not.toHaveBeenCalled();
    expect(b.bridge.reclaimIdleChannel).toHaveBeenCalledTimes(1);
  });

  it('allows an idle primary and ignores removal permission', async () => {
    const { a, reclaim } = setup(mode);
    Object.assign(a, { removable: false });
    await reclaim('new');
    expect(a.bridge.reclaimIdleChannel).toHaveBeenCalledTimes(1);
  });

  it('uses a stable workspace ID tie break', async () => {
    const { a, b, reclaim } = setup(mode);
    vi.mocked(a.bridge.getIdleChannelCandidate!).mockReturnValue({
      channelId: 'a',
      runtimeEpoch: 1,
      lastUsedAt: 20,
    });
    await reclaim('new');
    expect(a.bridge.reclaimIdleChannel).toHaveBeenCalledTimes(1);
    expect(b.bridge.reclaimIdleChannel).not.toHaveBeenCalled();
  });

  it.each([
    'sessions',
    'activePrompts',
    'pendingSessionStarts',
    'acpConnections',
    'memoryTasks',
    'channelWorkers',
    'voiceSessions',
    'workspaceRuntime',
  ] as const)('preserves a workspace with %s', async (key) => {
    const { a, b, reclaim, getActivity } = setup(mode);
    getActivity.mockImplementation((runtime) => ({
      ...readWorkspaceActivity(runtime),
      ...(runtime === a ? { [key]: 1 } : {}),
    }));
    await reclaim('new');
    expect(a.bridge.reclaimIdleChannel).not.toHaveBeenCalled();
    expect(b.bridge.reclaimIdleChannel).toHaveBeenCalledTimes(1);
  });

  it('skips missing observations and unowned bridges', async () => {
    const { a, b, c, reclaim, getActivity, ownsBridge } = setup(mode);
    getActivity.mockImplementation((runtime) =>
      runtime === a ? undefined : readWorkspaceActivity(runtime),
    );
    ownsBridge.mockImplementation((...args: unknown[]) => args[0] !== b.bridge);
    await reclaim('new');
    expect(a.bridge.reclaimIdleChannel).not.toHaveBeenCalled();
    expect(b.bridge.reclaimIdleChannel).not.toHaveBeenCalled();
    expect(c.bridge.reclaimIdleChannel).toHaveBeenCalledTimes(1);
  });

  it('skips draining, untrusted and special runtime candidates', async () => {
    const { a, b, c, registry, reclaim } = setup(mode);
    expect(registry.beginDrain(b)).toBe(true);
    Object.assign(a, { trusted: false });
    Object.assign(c, { provenance: 'managed-scratch' });
    await reclaim('new');
    for (const runtime of [a, b, c])
      expect(runtime.bridge.reclaimIdleChannel).not.toHaveBeenCalled();
  });

  it('does not choose another victim if the oldest changed or refused', async () => {
    const { a, b, reclaim } = setup(mode);
    vi.mocked(a.bridge.reclaimIdleChannel!).mockResolvedValue(false);
    await reclaim('new');
    expect(a.bridge.reclaimIdleChannel).toHaveBeenCalledTimes(1);
    expect(b.bridge.reclaimIdleChannel).not.toHaveBeenCalled();
  });

  it('checks current activity again before reclamation', async () => {
    const { a, b, reclaim, getActivity } = setup(mode);
    let reads = 0;
    getActivity.mockImplementation((runtime) => ({
      ...readWorkspaceActivity(runtime),
      sessions: runtime === a && ++reads > 1 ? 1 : 0,
    }));
    await reclaim('new');
    expect(a.bridge.reclaimIdleChannel).not.toHaveBeenCalled();
    expect(b.bridge.reclaimIdleChannel).not.toHaveBeenCalled();
  });

  it('does nothing if capacity was already released or the requester aborted', async () => {
    const { a, occupied, reclaim } = setup(mode);
    const controller = new AbortController();
    controller.abort();
    await reclaim('new', controller.signal);
    occupied.cancel();
    await reclaim('new');
    expect(a.bridge.reclaimIdleChannel).not.toHaveBeenCalled();
  });
});

it.each(['off', 'observe'] as const)(
  'does not reclaim under %s',
  async (mode) => {
    const { a, b, c, reclaim } = setup(mode);
    await reclaim('new');
    for (const runtime of [a, b, c])
      expect(runtime.bridge.reclaimIdleChannel).not.toHaveBeenCalled();
  },
);
