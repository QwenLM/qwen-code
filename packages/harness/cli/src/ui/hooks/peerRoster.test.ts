/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LivePeerSession, PeerEntry } from '@qwen-code/core';

const mocks = vi.hoisted(() => ({
  listAllPeers: vi.fn(),
  isCrossSessionMessagingEnabled: vi.fn(() => true),
}));

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    listAllPeers: mocks.listAllPeers,
    isCrossSessionMessagingEnabled: mocks.isCrossSessionMessagingEnabled,
  };
});

const {
  PEER_ROSTER_THROTTLE_MS,
  cachedPeerRoster,
  refreshPeerRoster,
  resetPeerRosterForTesting,
  subscribeToPeerRoster,
} = await import('./peerRoster.js');

const { baseNameForSession, displayNameForSession, peerHandle, shortRef } =
  await import('@qwen-code/core');

function peer(name: string, socketPath: string): PeerEntry {
  const live: LivePeerSession = {
    pid: 100,
    procStart: 0,
    startedAt: 1_700_000_000_000,
    cwd: '/home/dev/project',
    messagingSocketPath: socketPath,
    peerProtocol: 1,
    kind: 'interactive',
    status: 'idle',
    name,
  };
  return {
    transport: 'uds',
    address: `uds:${socketPath}`,
    session: live,
    baseName: baseNameForSession(live),
    displayName: displayNameForSession(live),
    handle: peerHandle(socketPath),
    ref: shortRef('session', socketPath),
  };
}

const REVIEWER = peer('reviewer', '/tmp/socks/1.sock');
const BUILDER = peer('builder', '/tmp/socks/2.sock');

beforeEach(() => {
  vi.useFakeTimers();
  resetPeerRosterForTesting();
  mocks.listAllPeers.mockReset();
  mocks.listAllPeers.mockResolvedValue([REVIEWER]);
  mocks.isCrossSessionMessagingEnabled.mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  resetPeerRosterForTesting();
});

describe('peerRoster', () => {
  it('starts empty and fills from the first refresh', async () => {
    expect(cachedPeerRoster()).toEqual([]);
    await refreshPeerRoster();
    expect(cachedPeerRoster()).toEqual([REVIEWER]);
  });

  it('[AC1] enumerates nothing when the gate is closed', async () => {
    mocks.isCrossSessionMessagingEnabled.mockReturnValue(false);
    await refreshPeerRoster();
    expect(mocks.listAllPeers).not.toHaveBeenCalled();
  });

  it('[AC4] collapses repeated refreshes inside the throttle window', async () => {
    await refreshPeerRoster();
    await refreshPeerRoster();
    await refreshPeerRoster();
    expect(mocks.listAllPeers).toHaveBeenCalledOnce();
  });

  it('[AC4] enumerates again once the window has passed', async () => {
    await refreshPeerRoster();
    vi.advanceTimersByTime(PEER_ROSTER_THROTTLE_MS + 1);
    await refreshPeerRoster();
    expect(mocks.listAllPeers).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent refreshes into one listing', async () => {
    const both = Promise.all([refreshPeerRoster(), refreshPeerRoster()]);
    await both;
    expect(mocks.listAllPeers).toHaveBeenCalledOnce();
  });

  it('[AC4] notifies on the first load', async () => {
    const listener = vi.fn();
    subscribeToPeerRoster(listener);
    await refreshPeerRoster();
    expect(listener).toHaveBeenCalledOnce();
  });

  it('does not notify when the content is unchanged', async () => {
    const listener = vi.fn();
    subscribeToPeerRoster(listener);

    await refreshPeerRoster();
    listener.mockClear();

    // A fresh array of fresh objects with identical content — identity
    // comparison would report a change here and start a dispatch loop.
    vi.advanceTimersByTime(PEER_ROSTER_THROTTLE_MS + 1);
    mocks.listAllPeers.mockResolvedValue([peer('reviewer', '/tmp/socks/1.sock')]);
    await refreshPeerRoster();

    expect(mocks.listAllPeers).toHaveBeenCalledTimes(2);
    expect(listener).not.toHaveBeenCalled();
  });

  it('adopts fresh session records even when it does not notify', async () => {
    // The key ignores `status`, so an early return before the assignment would
    // pin every row to the first enumeration's record and a peer going
    // busy → idle would never update for the life of the process.
    await refreshPeerRoster();
    expect(cachedPeerRoster()[0].session.status).toBe('idle');

    vi.advanceTimersByTime(PEER_ROSTER_THROTTLE_MS + 1);
    const busy = peer('reviewer', '/tmp/socks/1.sock');
    busy.session.status = 'busy';
    mocks.listAllPeers.mockResolvedValue([busy]);
    await refreshPeerRoster();

    expect(cachedPeerRoster()[0].session.status).toBe('busy');
  });

  it('notifies when a peer joins or leaves', async () => {
    const listener = vi.fn();
    subscribeToPeerRoster(listener);
    await refreshPeerRoster();
    listener.mockClear();

    vi.advanceTimersByTime(PEER_ROSTER_THROTTLE_MS + 1);
    mocks.listAllPeers.mockResolvedValue([REVIEWER, BUILDER]);
    await refreshPeerRoster();

    expect(listener).toHaveBeenCalledOnce();
    expect(cachedPeerRoster()).toHaveLength(2);
  });

  it('does not notify for a throttled call', async () => {
    const listener = vi.fn();
    subscribeToPeerRoster(listener);
    await refreshPeerRoster();
    listener.mockClear();

    mocks.listAllPeers.mockResolvedValue([REVIEWER, BUILDER]);
    await refreshPeerRoster();

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps the previous listing when a refresh fails', async () => {
    await refreshPeerRoster();
    const listener = vi.fn();
    subscribeToPeerRoster(listener);

    vi.advanceTimersByTime(PEER_ROSTER_THROTTLE_MS + 1);
    mocks.listAllPeers.mockRejectedValue(new Error('registry unreadable'));
    await expect(refreshPeerRoster()).resolves.toBeUndefined();

    expect(cachedPeerRoster()).toEqual([REVIEWER]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', async () => {
    const listener = vi.fn();
    subscribeToPeerRoster(listener)();
    await refreshPeerRoster();
    expect(listener).not.toHaveBeenCalled();
  });

  it('survives a listener that throws', async () => {
    subscribeToPeerRoster(() => {
      throw new Error('listener exploded');
    });
    const second = vi.fn();
    subscribeToPeerRoster(second);

    await expect(refreshPeerRoster()).resolves.toBeUndefined();
    expect(second).toHaveBeenCalledOnce();
  });
});
