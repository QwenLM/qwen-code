/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { runHeartbeatLoop, heartbeatIntervalMsOf } from './heartbeat.js';

const noSleep = async () => {}; // immediate (drive iterations synchronously)

describe('heartbeatIntervalMsOf', () => {
  it('reads heartbeatIntervalSec → ms', () => {
    expect(heartbeatIntervalMsOf({ heartbeatIntervalSec: 30 })).toBe(30_000);
  });
  it('falls back to 60s for missing/invalid', () => {
    expect(heartbeatIntervalMsOf(undefined)).toBe(60_000);
    expect(heartbeatIntervalMsOf({})).toBe(60_000);
    expect(heartbeatIntervalMsOf({ heartbeatIntervalSec: 0 })).toBe(60_000);
    expect(heartbeatIntervalMsOf({ heartbeatIntervalSec: -5 })).toBe(60_000);
  });
});

describe('runHeartbeatLoop', () => {
  it('beats periodically until abort', async () => {
    const ac = new AbortController();
    const beats: string[] = [];
    await runHeartbeatLoop({
      heartbeat: async (id) => {
        beats.push(id);
        if (beats.length >= 3) ac.abort();
        return { ok: true, status: 200 };
      },
      reRegister: async () => {},
      bridgeId: 'discord',
      intervalMs: 1000,
      signal: ac.signal,
      sleep: noSleep,
    });
    expect(beats).toEqual(['discord', 'discord', 'discord']);
  });

  it('does not beat when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    let beats = 0;
    await runHeartbeatLoop({
      heartbeat: async () => {
        beats++;
        return { ok: true, status: 200 };
      },
      reRegister: async () => {},
      bridgeId: 'x',
      intervalMs: 1,
      signal: ac.signal,
      sleep: noSleep,
    });
    expect(beats).toBe(0);
  });

  it('re-registers on a 404 (gateway lost the registration)', async () => {
    const ac = new AbortController();
    let reRegs = 0;
    let n = 0;
    await runHeartbeatLoop({
      heartbeat: async () => {
        n++;
        if (n >= 2) ac.abort();
        return { ok: false, status: 404 };
      },
      reRegister: async () => {
        reRegs++;
      },
      bridgeId: 'x',
      intervalMs: 1,
      signal: ac.signal,
      sleep: noSleep,
    });
    expect(reRegs).toBeGreaterThanOrEqual(1);
  });

  it('swallows a heartbeat throw and keeps looping', async () => {
    const ac = new AbortController();
    let n = 0;
    await runHeartbeatLoop({
      heartbeat: async () => {
        n++;
        if (n >= 3) ac.abort();
        throw new Error('network');
      },
      reRegister: async () => {},
      bridgeId: 'x',
      intervalMs: 1,
      signal: ac.signal,
      sleep: noSleep,
    });
    expect(n).toBeGreaterThanOrEqual(3);
  });
});
