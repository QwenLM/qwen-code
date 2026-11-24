/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { TurnSkillSnapshotLease } from '@qwen-code/qwen-code-core';
import { TurnSkillLeases } from './turn-skill-leases.js';

function lease(digest: string) {
  return {
    snapshot: { version: 1 as const, id: digest, digest, skills: [] },
    dispose: vi.fn(async () => {}),
  };
}

describe('prepared turn skill reservations', () => {
  it('keeps the queued and running versions separate across two sessions', async () => {
    const leases = new TurnSkillLeases();
    const old = lease('v1');
    const current = lease('v2');
    await leases.prepare('old', 'a', async () => old);
    expect(leases.claim('old', 'a')).toBe(old);
    await leases.prepare('new', 'b', async () => current);
    expect(() => leases.claim('old', 'b')).toThrow();
    expect(leases.claim('new', 'b')).toBe(current);
    await leases.releaseQueued('old', 'a');
    leases.settle('new', 'b');
    await leases.collect('new');
    expect(current.dispose).toHaveBeenCalledTimes(1);
    expect(old.dispose).not.toHaveBeenCalled();
    leases.settle('old', 'a');
    await leases.collect('old');
    expect(old.dispose).toHaveBeenCalledTimes(1);
  });

  it('holds old work beyond five minutes even if the same session id is reopened', async () => {
    vi.useFakeTimers();
    try {
      const leases = new TurnSkillLeases();
      let drained = false;
      const old = lease('old');
      await leases.prepare('s', 'old', async () => old);
      leases.claim('s', 'old');
      await leases.collect('s', true);
      expect(old.dispose).not.toHaveBeenCalled();
      leases.settle('s', 'old', () => drained);
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      await leases.prepare('s', 'new', async () => lease('new'));
      await leases.collect('s');
      expect(old.dispose).not.toHaveBeenCalled();
      drained = true;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(old.dispose).toHaveBeenCalledOnce();
      await leases.collect('s', true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes a late preparation reply after close or rejection', async () => {
    const leases = new TurnSkillLeases();
    let resolveCapture!: (snapshot: TurnSkillSnapshotLease) => void;
    const capture = new Promise<TurnSkillSnapshotLease>((resolve) => {
      resolveCapture = resolve;
    });
    const old = lease('old');
    const prepared = leases.prepare('closed', 'a', () => capture);
    await leases.releaseQueued('closed', 'a');
    resolveCapture(old);
    await expect(prepared).rejects.toThrow('closed during preparation');
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(() => leases.claim('closed', 'a')).toThrow();
  });

  it('reclaims a settled lease only when its background work drains', async () => {
    vi.useFakeTimers();
    try {
      const leases = new TurnSkillLeases();
      const initial = lease('v1');
      let drained = false;
      await leases.prepare('s', 'id', async () => initial);
      leases.claim('s', 'id');
      leases.settle('s', 'id', () => drained);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(initial.dispose).not.toHaveBeenCalled();
      drained = true;
      await vi.advanceTimersByTimeAsync(5_001);
      expect(initial.dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects duplicate reservations and cannot consume a lease twice', async () => {
    const leases = new TurnSkillLeases();
    const initial = lease('v1');
    await leases.prepare('s', 'id', async () => initial);
    await expect(
      leases.prepare('s', 'id', async () => lease('v2')),
    ).rejects.toThrow();
    leases.claim('s', 'id');
    expect(() => leases.claim('s', 'id')).toThrow();
    leases.settle('s', 'id');
    await leases.collect('s', true);
    expect(initial.dispose).toHaveBeenCalledOnce();
  });
});
