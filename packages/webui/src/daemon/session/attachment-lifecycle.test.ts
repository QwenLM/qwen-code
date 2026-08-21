/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionClient } from '@qwen-code/sdk/daemon';
import { SessionAttachmentLifecycle } from './attachment-lifecycle.js';

describe('SessionAttachmentLifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects the previous load when a newer load supersedes it', async () => {
    const lifecycle = new SessionAttachmentLifecycle();
    const first = lifecycle.startPendingLoad({
      sessionId: 'session-a',
      mode: 'load',
      onTimeout: () => new Error('timed out'),
    });

    const second = lifecycle.startPendingLoad({
      sessionId: 'session-b',
      mode: 'resume',
      onTimeout: () => new Error('timed out'),
    });

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(lifecycle.pendingLoad?.sessionId).toBe('session-b');
    lifecycle.resolvePendingLoad(lifecycle.pendingLoad!);
    await expect(second).resolves.toBeUndefined();
  });

  it('does not let a stale load settle the current load', async () => {
    const lifecycle = new SessionAttachmentLifecycle();
    const first = lifecycle.startPendingLoad({
      sessionId: 'session-a',
      mode: 'load',
      onTimeout: () => new Error('timed out'),
    });
    const staleLoad = lifecycle.pendingLoad!;
    const second = lifecycle.startPendingLoad({
      sessionId: 'session-b',
      mode: 'load',
      onTimeout: () => new Error('timed out'),
    });

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(lifecycle.resolvePendingLoad(staleLoad)).toBe(false);
    expect(lifecycle.pendingLoad?.sessionId).toBe('session-b');
    lifecycle.resolvePendingLoad(lifecycle.pendingLoad!);
    await expect(second).resolves.toBeUndefined();
  });

  it('releases the current load before running its timeout callback', async () => {
    vi.useFakeTimers();
    const lifecycle = new SessionAttachmentLifecycle();
    const onTimeout = vi.fn(() => new Error('timed out'));
    const pending = lifecycle.startPendingLoad({
      sessionId: 'session-a',
      mode: 'attach',
      watchdogTimeoutMs: 10,
      onTimeout,
    });
    const settled = pending.then(
      () => ({ status: 'resolved' as const, error: undefined }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(await settled).toEqual({
      status: 'rejected',
      error: expect.objectContaining({ message: 'timed out' }),
    });
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(lifecycle.pendingLoad).toBeUndefined();
  });

  it('owns the manual-clear and cleanup-detach states', () => {
    const lifecycle = new SessionAttachmentLifecycle();
    const session = {
      sessionId: 'session-a',
    } as DaemonSessionClient;

    lifecycle.markManuallyCleared();
    lifecycle.preserveCleanupDetach(session);

    expect(lifecycle.isManuallyCleared).toBe(true);
    expect(lifecycle.isCleanupDetachPreserved(session)).toBe(true);

    lifecycle.allowAutomaticAttachment();
    lifecycle.releaseCleanupDetachExemption(session);

    expect(lifecycle.isManuallyCleared).toBe(false);
    expect(lifecycle.isCleanupDetachPreserved(session)).toBe(false);
  });
});
