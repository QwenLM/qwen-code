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

  it('advances the load generation on every startPendingLoad', async () => {
    // branchSession's stale-switch guard samples `generation` before its
    // await and compares it afterwards (actions.ts): the guard can only
    // notice an in-flight reload if every startPendingLoad actually
    // advances the counter. Two supersedes must therefore produce three
    // distinct, increasing generations.
    const lifecycle = new SessionAttachmentLifecycle();
    expect(lifecycle.generation).toBe(0);

    const first = lifecycle.startPendingLoad({
      sessionId: 'session-a',
      mode: 'load',
      onTimeout: () => new Error('timed out'),
    });
    expect(lifecycle.generation).toBe(1);
    expect(lifecycle.pendingLoad?.id).toBe(1);

    const second = lifecycle.startPendingLoad({
      sessionId: 'session-a',
      mode: 'load',
      onTimeout: () => new Error('timed out'),
    });
    expect(lifecycle.generation).toBe(2);
    expect(lifecycle.pendingLoad?.id).toBe(2);

    const third = lifecycle.startPendingLoad({
      sessionId: 'session-a',
      mode: 'load',
      onTimeout: () => new Error('timed out'),
    });
    expect(lifecycle.generation).toBe(3);
    expect(lifecycle.pendingLoad?.id).toBe(3);

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    lifecycle.resolvePendingLoad(lifecycle.pendingLoad!);
    await expect(third).resolves.toBeUndefined();
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

  it('releases the cleanup-detach exemption when a pending load is rejected', async () => {
    const lifecycle = new SessionAttachmentLifecycle();
    const session = {
      sessionId: 'session-a',
    } as DaemonSessionClient;
    const pending = lifecycle.startPendingLoad({
      sessionId: 'session-a',
      mode: 'load',
      onTimeout: () => new Error('timed out'),
    });
    lifecycle.preserveCleanupDetach(session);
    expect(lifecycle.isCleanupDetachPreserved(session)).toBe(true);

    expect(
      lifecycle.rejectPendingLoad(
        lifecycle.pendingLoad!,
        new Error('load failed'),
      ),
    ).toBe(true);

    await expect(pending).rejects.toThrow('load failed');
    // A failed load must not keep the session exempted: the next
    // effect-cleanup pass has to perform the prompt-state reset/detach.
    expect(lifecycle.isCleanupDetachPreserved(session)).toBe(false);
  });

  it('releases the cleanup-detach exemption when a pending load is cancelled', async () => {
    const lifecycle = new SessionAttachmentLifecycle();
    const session = {
      sessionId: 'session-a',
    } as DaemonSessionClient;
    const pending = lifecycle.startPendingLoad({
      sessionId: 'session-a',
      mode: 'resume',
      onTimeout: () => new Error('timed out'),
    });
    lifecycle.preserveCleanupDetach(session);

    expect(lifecycle.cancelPendingLoad(new Error('cancelled'))).toBe(true);

    await expect(pending).rejects.toThrow('cancelled');
    expect(lifecycle.isCleanupDetachPreserved(session)).toBe(false);
  });

  it("keeps another session's exemption when rejecting a load", async () => {
    const lifecycle = new SessionAttachmentLifecycle();
    const otherSession = {
      sessionId: 'session-b',
    } as DaemonSessionClient;
    const pending = lifecycle.startPendingLoad({
      sessionId: 'session-a',
      mode: 'load',
      onTimeout: () => new Error('timed out'),
    });
    lifecycle.preserveCleanupDetach(otherSession);

    expect(
      lifecycle.rejectPendingLoad(
        lifecycle.pendingLoad!,
        new Error('load failed'),
      ),
    ).toBe(true);

    await expect(pending).rejects.toThrow('load failed');
    expect(lifecycle.isCleanupDetachPreserved(otherSession)).toBe(true);
  });

  it("keeps the successor's exemption when a stale load is rejected", async () => {
    const lifecycle = new SessionAttachmentLifecycle();
    const session = {
      sessionId: 'session-a',
    } as DaemonSessionClient;
    const stale = lifecycle.startPendingLoad({
      sessionId: 'session-a',
      mode: 'load',
      onTimeout: () => new Error('timed out'),
    });
    const staleLoad = lifecycle.pendingLoad!;
    // A same-session reload supersedes the failed load; the second switch
    // re-preserves the cleanup-detach exemption for the successor.
    const successor = lifecycle.startPendingLoad({
      sessionId: 'session-a',
      mode: 'load',
      onTimeout: () => new Error('timed out'),
    });
    await expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    lifecycle.preserveCleanupDetach(session);
    expect(lifecycle.isCleanupDetachPreserved(session)).toBe(true);

    // The late reject of the superseded load must return false and must NOT
    // release the exemption: releasePendingLoad fails on the stale load
    // before any release runs, so the successor keeps its exemption.
    expect(lifecycle.rejectPendingLoad(staleLoad, new Error('late'))).toBe(
      false,
    );
    expect(lifecycle.isCleanupDetachPreserved(session)).toBe(true);

    let successorSettled = false;
    void successor.then(
      () => {
        successorSettled = true;
      },
      () => {
        successorSettled = true;
      },
    );
    await Promise.resolve();
    expect(successorSettled).toBe(false);

    lifecycle.resolvePendingLoad(lifecycle.pendingLoad!);
    await expect(successor).resolves.toBeUndefined();
  });

  it("releases a superseded load's exemption while keeping the successor's", async () => {
    const lifecycle = new SessionAttachmentLifecycle();
    const supersededSession = {
      sessionId: 'session-a',
    } as DaemonSessionClient;
    const successorSession = {
      sessionId: 'session-b',
    } as DaemonSessionClient;

    const first = lifecycle.startPendingLoad({
      sessionId: 'session-a',
      mode: 'load',
      onTimeout: () => new Error('timed out'),
    });
    lifecycle.preserveCleanupDetach(supersededSession);
    expect(lifecycle.isCleanupDetachPreserved(supersededSession)).toBe(true);

    const second = lifecycle.startPendingLoad({
      sessionId: 'session-b',
      mode: 'load',
      onTimeout: () => new Error('timed out'),
    });
    // The supersede runs cancelPendingLoad → rejectPendingLoad →
    // releaseCleanupDetachExemptionForSession('session-a') synchronously
    // inside startPendingLoad, so the superseded load's exemption must
    // already be gone by the time the successor re-preserves its own.
    lifecycle.preserveCleanupDetach(successorSession);

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(lifecycle.isCleanupDetachPreserved(supersededSession)).toBe(false);
    expect(lifecycle.isCleanupDetachPreserved(successorSession)).toBe(true);

    lifecycle.resolvePendingLoad(lifecycle.pendingLoad!);
    await expect(second).resolves.toBeUndefined();
  });

  it("keeps the successor's exemption when a superseded same-session release runs late", async () => {
    const lifecycle = new SessionAttachmentLifecycle();
    const session = {
      sessionId: 'session-a',
    } as DaemonSessionClient;

    const first = lifecycle.startPendingLoad({
      sessionId: 'session-a',
      mode: 'load',
      onTimeout: () => new Error('timed out'),
    });
    const firstLoad = lifecycle.pendingLoad!;
    lifecycle.preserveCleanupDetach(session, firstLoad);

    // A same-session reload supersedes the first load: the supersede clears
    // the exemption synchronously, then the second switch re-preserves it for
    // its own load.
    const second = lifecycle.startPendingLoad({
      sessionId: 'session-a',
      mode: 'load',
      onTimeout: () => new Error('timed out'),
    });
    const secondLoad = lifecycle.pendingLoad!;
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    lifecycle.preserveCleanupDetach(session, secondLoad);
    expect(lifecycle.isCleanupDetachPreserved(session)).toBe(true);

    // The superseded switch's deferred release arrives after the successor
    // re-preserved. Both preserved the same session object, so only the
    // recorded load distinguishes the two exemptions.
    lifecycle.releaseCleanupDetachExemption(session, firstLoad);
    expect(lifecycle.isCleanupDetachPreserved(session)).toBe(true);

    // The successor's own release clears the exemption once it settles.
    lifecycle.releaseCleanupDetachExemption(session, secondLoad);
    expect(lifecycle.isCleanupDetachPreserved(session)).toBe(false);

    lifecycle.resolvePendingLoad(secondLoad);
    await expect(second).resolves.toBeUndefined();
  });
});
