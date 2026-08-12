/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createJournalGrowthPolicy } from './journalGrowthPolicy.js';

const MiB = 1024 * 1024;
const BASELINE_EVENTS = 10_000;
const BASELINE_BYTES = 8 * MiB;
const HARD_CAP_BYTES = 256 * MiB;

const makePolicy = (poolBytes: number) =>
  createJournalGrowthPolicy({
    baselineEvents: BASELINE_EVENTS,
    baselineBytes: BASELINE_BYTES,
    poolBytes,
    hardCapBytes: HARD_CAP_BYTES,
  });

describe('createJournalGrowthPolicy', () => {
  it('doubles the requester caps within the pool and scales entries proportionally', () => {
    const policy = makePolicy(48 * MiB);
    expect(
      policy.grant({
        currentMaxEvents: BASELINE_EVENTS,
        currentMaxBytes: BASELINE_BYTES,
        allSessionLimitBytes: [BASELINE_BYTES],
      }),
    ).toEqual({ maxBytes: 16 * MiB, maxEvents: 20_000 });
  });

  it('does not charge baseline caps against the pool', () => {
    const policy = makePolicy(32 * MiB);
    expect(
      policy.grant({
        currentMaxEvents: BASELINE_EVENTS,
        currentMaxBytes: BASELINE_BYTES,
        allSessionLimitBytes: Array.from({ length: 33 }, () => BASELINE_BYTES),
      }),
    ).toEqual({ maxBytes: 16 * MiB, maxEvents: 20_000 });
  });

  it('grants only the remaining pool when a partial headroom is left', () => {
    const policy = makePolicy(48 * MiB);
    // Another session already grew to 52 MiB (44 MiB beyond baseline).
    expect(
      policy.grant({
        currentMaxEvents: BASELINE_EVENTS,
        currentMaxBytes: BASELINE_BYTES,
        allSessionLimitBytes: [BASELINE_BYTES, 52 * MiB],
      }),
    ).toEqual({ maxBytes: 12 * MiB, maxEvents: 15_000 });
  });

  it('refuses once the pool is fully granted', () => {
    const policy = makePolicy(48 * MiB);
    expect(
      policy.grant({
        currentMaxEvents: BASELINE_EVENTS,
        currentMaxBytes: BASELINE_BYTES,
        allSessionLimitBytes: [BASELINE_BYTES, 56 * MiB],
      }),
    ).toBeUndefined();
  });

  it('refuses a session already at the hard cap', () => {
    const policy = makePolicy(512 * MiB);
    expect(
      policy.grant({
        currentMaxEvents: 320_000,
        currentMaxBytes: HARD_CAP_BYTES,
        allSessionLimitBytes: [HARD_CAP_BYTES],
      }),
    ).toBeUndefined();
  });

  it('caps the grant at the per-session hard cap with proportional entries', () => {
    const policy = makePolicy(512 * MiB);
    expect(
      policy.grant({
        currentMaxEvents: 160_000,
        currentMaxBytes: 128 * MiB,
        allSessionLimitBytes: [128 * MiB],
      }),
    ).toEqual({ maxBytes: HARD_CAP_BYTES, maxEvents: 320_000 });
  });

  it('clamps a partial grant to the hard cap when doubling overshoots it', () => {
    // Doubling lands at 384 MiB and pool headroom allows 192 + 328 MiB;
    // only the hard-cap clamp term keeps the grant at 256 MiB (starting
    // exactly at 128 MiB would make the clamp indistinguishable from the
    // doubling term).
    const policy = makePolicy(512 * MiB);
    expect(
      policy.grant({
        currentMaxEvents: 240_000,
        currentMaxBytes: 192 * MiB,
        allSessionLimitBytes: [192 * MiB],
      }),
    ).toEqual({ maxBytes: HARD_CAP_BYTES, maxEvents: 320_000 });
  });

  it('accounts the requester through its reported pre-growth cap', () => {
    // allSessionLimitBytes carries the requester's CURRENT cap; granting
    // `current + available` keeps the daemon-wide sum at or below the
    // pool. The numbers make the pool-remainder term alone win (doubling
    // would reach 32 MiB), so a fixture that omits the requester's cap
    // produces a different grant and fails this test.
    const policy = makePolicy(20 * MiB);
    const grant = policy.grant({
      currentMaxEvents: 20_000,
      currentMaxBytes: 16 * MiB,
      allSessionLimitBytes: [16 * MiB],
    });
    // Extra already granted to the requester: 8 MiB; left: 12 MiB.
    expect(grant).toEqual({ maxBytes: 28 * MiB, maxEvents: 35_000 });
  });
  it('clamps the proportional event cap to the safe-integer range', () => {
    // Every input is a valid safe integer, but with a 1-byte baseline the
    // proportional entry cap is 256 MiB x MAX_SAFE_INTEGER — far past the
    // safe range. An unsafe maxEvents would make the engine reject the whole
    // grant, including an otherwise-funded byte grant.
    const policy = createJournalGrowthPolicy({
      baselineEvents: Number.MAX_SAFE_INTEGER,
      baselineBytes: 1,
      poolBytes: 64 * MiB,
      hardCapBytes: HARD_CAP_BYTES,
    });
    const grant = policy.grant({
      currentMaxEvents: Number.MAX_SAFE_INTEGER,
      currentMaxBytes: BASELINE_BYTES,
      allSessionLimitBytes: [BASELINE_BYTES],
    });
    expect(grant).toBeDefined();
    expect(Number.isSafeInteger(grant?.maxEvents)).toBe(true);
    expect(grant?.maxEvents).toBe(Number.MAX_SAFE_INTEGER);
    expect(grant?.maxBytes).toBe(16 * MiB);
  });
});
