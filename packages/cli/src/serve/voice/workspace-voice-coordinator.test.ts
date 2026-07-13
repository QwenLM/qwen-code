/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
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
});
