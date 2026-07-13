/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceRuntime } from '../workspace-registry.js';
import {
  MAX_CONCURRENT_VOICE_SESSIONS,
  WorkspaceVoiceCoordinator,
} from './workspace-voice-coordinator.js';

function runtime(id: string): WorkspaceRuntime {
  return { workspaceId: id } as WorkspaceRuntime;
}

describe('WorkspaceVoiceCoordinator', () => {
  it('shares capacity across runtimes and releases it exactly once', () => {
    const coordinator = new WorkspaceVoiceCoordinator();
    const first = runtime('first');
    const second = runtime('second');
    const leases = Array.from({ length: MAX_CONCURRENT_VOICE_SESSIONS }, () =>
      coordinator.acquire(first),
    );
    expect(leases.every((item) => item.kind === 'admitted')).toBe(true);
    expect(coordinator.acquire(second)).toEqual({
      kind: 'rejected',
      reason: 'capacity',
    });
    const lease = leases[0];
    if (!lease || lease.kind !== 'admitted') throw new Error('expected lease');
    lease.lease.release();
    lease.lease.release();
    expect(coordinator.acquire(second).kind).toBe('admitted');
  });

  it('drains new work without aborting existing work and aborts on disposal', async () => {
    const coordinator = new WorkspaceVoiceCoordinator();
    const target = runtime('target');
    const admitted = coordinator.acquire(target);
    if (admitted.kind !== 'admitted') throw new Error('expected lease');
    coordinator.beginWorkspaceDrain(target);
    expect(admitted.lease.signal.aborted).toBe(false);
    expect(coordinator.getWorkspaceActivity(target)).toBe(1);
    expect(coordinator.acquire(target)).toEqual({
      kind: 'rejected',
      reason: 'draining',
    });
    const dispose = coordinator.disposeRuntime(target, 'workspace_removed');
    expect(admitted.lease.signal.aborted).toBe(true);
    admitted.lease.release();
    await dispose;
  });

  it('stops disposal waiting after five seconds without releasing an active lease', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new WorkspaceVoiceCoordinator();
      const target = runtime('target');
      const admitted = coordinator.acquire(target);
      if (admitted.kind !== 'admitted') throw new Error('expected lease');

      const dispose = coordinator.disposeRuntime(target, 'workspace_removed');
      await vi.advanceTimersByTimeAsync(5_000);
      await dispose;

      expect(coordinator.getWorkspaceActivity(target)).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      admitted.lease.release();
      expect(coordinator.getWorkspaceActivity(target)).toBe(0);
      expect(coordinator['states'].has(target)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts active leases when a workspace drain completes', () => {
    const coordinator = new WorkspaceVoiceCoordinator();
    const target = runtime('target');
    const admitted = coordinator.acquire(target);
    if (admitted.kind !== 'admitted') throw new Error('expected lease');

    coordinator.completeWorkspaceDrain(target);

    expect(admitted.lease.signal.aborted).toBe(true);
    expect(coordinator.getWorkspaceActivity(target)).toBe(1);
    admitted.lease.release();
    expect(coordinator.getWorkspaceActivity(target)).toBe(0);
    expect(coordinator['states'].has(target)).toBe(false);
  });

  it('keeps a re-added runtime generation independent from old leases', async () => {
    const coordinator = new WorkspaceVoiceCoordinator();
    const oldRuntime = runtime('same-id');
    const newRuntime = runtime('same-id');
    const oldAdmission = coordinator.acquire(oldRuntime);
    if (oldAdmission.kind !== 'admitted') throw new Error('expected lease');

    coordinator.beginWorkspaceDrain(oldRuntime);
    const newAdmission = coordinator.acquire(newRuntime);
    expect(newAdmission.kind).toBe('admitted');
    const disposal = coordinator.disposeRuntime(
      oldRuntime,
      'workspace_removed',
    );
    oldAdmission.lease.release();
    await disposal;

    expect(coordinator.getWorkspaceActivity(oldRuntime)).toBe(0);
    expect(coordinator.getWorkspaceActivity(newRuntime)).toBe(1);
    if (newAdmission.kind === 'admitted') newAdmission.lease.release();
  });

  it('rejects a disposed runtime that never acquired a lease', async () => {
    const coordinator = new WorkspaceVoiceCoordinator();
    const target = runtime('failed-construction');

    await coordinator.disposeRuntime(target, 'workspace_removed');

    expect(coordinator.getWorkspaceActivity(target)).toBe(0);
    expect(coordinator.acquire(target)).toEqual({
      kind: 'rejected',
      reason: 'draining',
    });
  });
});
