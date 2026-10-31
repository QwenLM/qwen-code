/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearReconnectState,
  computeBackoffMs,
  isBackingOff,
  readReconnectState,
  recordFailure,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
} from './reconnect-backoff.js';

const BASE = 'http://127.0.0.1:4170';

let sessionData: Record<string, unknown>;

beforeEach(() => {
  sessionData = {};
  (globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = {
    storage: {
      session: {
        get: vi.fn(async (key: string) => ({ [key]: sessionData[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionData, items);
        }),
        remove: vi.fn(async (key: string) => {
          delete sessionData[key];
        }),
      },
    },
  } as unknown as typeof chrome;
});

describe('computeBackoffMs', () => {
  it('doubles from the floor and caps at the ceiling', () => {
    expect(computeBackoffMs(0)).toBe(RECONNECT_MIN_MS);
    expect(computeBackoffMs(1)).toBe(2_000);
    expect(computeBackoffMs(2)).toBe(4_000);
    expect(computeBackoffMs(20)).toBe(RECONNECT_MAX_MS);
    expect(computeBackoffMs(100)).toBe(RECONNECT_MAX_MS);
  });
});

describe('recordFailure', () => {
  it('escalates the persisted ladder across calls', async () => {
    const first = await recordFailure(BASE);
    expect(first).toBe(RECONNECT_MIN_MS);
    let state = await readReconnectState(BASE);
    expect(state?.failures).toBe(1);
    expect(state?.nextRetryAt).toBeGreaterThan(Date.now());

    const second = await recordFailure(BASE);
    expect(second).toBe(2_000);
    state = await readReconnectState(BASE);
    expect(state?.failures).toBe(2);
  });

  it('restarts the ladder when the daemon config changed', async () => {
    await recordFailure(BASE);
    await recordFailure(BASE);
    // A different baseUrl means the old failures are irrelevant.
    expect(await readReconnectState('http://127.0.0.1:5000')).toBeNull();
    expect(await recordFailure('http://127.0.0.1:5000')).toBe(RECONNECT_MIN_MS);
  });

  it('does not evict the ladder when a failure has no known base', async () => {
    await recordFailure(BASE);
    await recordFailure(BASE);
    // A config-read failure arrives with an empty base URL. Recording it must
    // not rewrite the single-slot state and evict the real daemon's ladder.
    expect(await recordFailure('')).toBe(RECONNECT_MIN_MS);
    const state = await readReconnectState(BASE);
    expect(state?.failures).toBe(2);
  });
});

describe('isBackingOff', () => {
  it('is true only while nextRetryAt lies ahead', async () => {
    expect(await isBackingOff(BASE)).toBe(false);
    await recordFailure(BASE);
    expect(await isBackingOff(BASE)).toBe(true);

    // Expired state must not block anyone.
    sessionData['qwen.cdpReconnect'] = {
      failures: 3,
      nextRetryAt: Date.now() - 1,
      baseUrl: BASE,
    };
    expect(await isBackingOff(BASE)).toBe(false);
  });
});

describe('clearReconnectState', () => {
  it('wipes the ladder after successful ACP initialization', async () => {
    await recordFailure(BASE);
    await clearReconnectState();
    expect(await readReconnectState(BASE)).toBeNull();
    expect(await isBackingOff(BASE)).toBe(false);
  });
});
