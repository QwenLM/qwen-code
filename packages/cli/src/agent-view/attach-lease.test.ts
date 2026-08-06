/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AgentViewAttachLeaseManager } from './attach-lease.js';

describe('AgentViewAttachLeaseManager', () => {
  it('acquires a lease for an unattached session', () => {
    const clock = fakeClock('2026-07-17T00:00:00.000Z');
    const manager = new AgentViewAttachLeaseManager({
      now: clock.now,
      createLeaseId: () => 'lease-1',
      defaultTtlMs: 1000,
    });

    expect(manager.acquire('session-1', { clientId: 'terminal-1' })).toEqual({
      ok: true,
      lease: {
        sessionId: 'session-1',
        leaseId: 'lease-1',
        clientId: 'terminal-1',
        acquiredAt: '2026-07-17T00:00:00.000Z',
        lastHeartbeatAt: '2026-07-17T00:00:00.000Z',
        expiresAt: '2026-07-17T00:00:01.000Z',
      },
    });
  });

  it('uses a random lease id when no id factory is provided', () => {
    const manager = new AgentViewAttachLeaseManager();
    const result = manager.acquire('session-1');

    expect(result).toMatchObject({
      ok: true,
      lease: {
        sessionId: 'session-1',
      },
    });
    expect(result.lease.leaseId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('rejects a second acquire while a lease is active', () => {
    const clock = fakeClock('2026-07-17T00:00:00.000Z');
    const manager = new AgentViewAttachLeaseManager({
      now: clock.now,
      createLeaseId: () => 'lease-1',
    });
    const first = manager.acquire('session-1');

    expect(
      manager.acquire('session-1', {
        leaseId: 'lease-2',
      }),
    ).toEqual({
      ok: false,
      reason: 'already_attached',
      lease: first.lease,
    });
  });

  it('releases only the matching lease', () => {
    const manager = new AgentViewAttachLeaseManager({
      createLeaseId: () => 'lease-1',
    });
    manager.acquire('session-1');

    expect(manager.release('session-1', 'other-lease')).toBe(false);
    expect(manager.get('session-1')).toMatchObject({ leaseId: 'lease-1' });
    expect(manager.release('session-1', 'lease-1')).toBe(true);
    expect(manager.get('session-1')).toBeUndefined();
  });

  it('expires stale leases and allows reacquire', () => {
    const clock = fakeClock('2026-07-17T00:00:00.000Z');
    const leaseIds = ['lease-1', 'lease-2'];
    const manager = new AgentViewAttachLeaseManager({
      now: clock.now,
      createLeaseId: () => leaseIds.shift() ?? 'missing-lease',
      defaultTtlMs: 1000,
    });
    const first = manager.acquire('session-1');

    clock.advance(1000);

    expect(manager.expire()).toEqual([first.lease]);
    expect(manager.acquire('session-1')).toMatchObject({
      ok: true,
      lease: {
        leaseId: 'lease-2',
        acquiredAt: '2026-07-17T00:00:01.000Z',
      },
    });
  });

  it('expires corrupted leases with invalid timestamps', () => {
    const manager = new AgentViewAttachLeaseManager({
      createLeaseId: () => 'lease-1',
    });
    manager.acquire('session-1');
    (
      manager as unknown as {
        leases: Map<string, { expiresAt: string }>;
      }
    ).leases.get('session-1')!.expiresAt = 'not-a-date';

    expect(manager.expire()).toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        leaseId: 'lease-1',
        expiresAt: 'not-a-date',
      }),
    ]);
    expect(manager.get('session-1')).toBeUndefined();
  });

  it('heartbeat extends the matching lease', () => {
    const clock = fakeClock('2026-07-17T00:00:00.000Z');
    const manager = new AgentViewAttachLeaseManager({
      now: clock.now,
      createLeaseId: () => 'lease-1',
      defaultTtlMs: 1000,
    });
    manager.acquire('session-1');
    clock.advance(500);

    expect(manager.heartbeat('session-1', 'wrong-lease')).toBeUndefined();
    expect(manager.heartbeat('session-1', 'lease-1')).toMatchObject({
      sessionId: 'session-1',
      leaseId: 'lease-1',
      acquiredAt: '2026-07-17T00:00:00.000Z',
      lastHeartbeatAt: '2026-07-17T00:00:00.500Z',
      expiresAt: '2026-07-17T00:00:01.500Z',
    });

    clock.advance(999);
    expect(manager.get('session-1')).toMatchObject({ leaseId: 'lease-1' });
  });
});

function fakeClock(start: string): {
  now: () => Date;
  advance: (ms: number) => void;
} {
  let nowMs = Date.parse(start);
  return {
    now: () => new Date(nowMs),
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}
