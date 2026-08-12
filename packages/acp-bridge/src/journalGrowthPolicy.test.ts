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

const session = (limitBytes: number, baselineBytes = BASELINE_BYTES) => ({
  limitBytes,
  baselineBytes,
});

describe('createJournalGrowthPolicy', () => {
  it('doubles the requester caps within the pool and scales entries proportionally', () => {
    const policy = makePolicy(48 * MiB);
    expect(
      policy.grant({
        currentMaxEvents: BASELINE_EVENTS,
        currentMaxBytes: BASELINE_BYTES,
        allSessionLimits: [session(BASELINE_BYTES)],
      }),
    ).toEqual({ maxBytes: 16 * MiB, maxEvents: 20_000 });
  });

  it('does not charge baseline caps against the pool', () => {
    const policy = makePolicy(32 * MiB);
    expect(
      policy.grant({
        currentMaxEvents: BASELINE_EVENTS,
        currentMaxBytes: BASELINE_BYTES,
        allSessionLimits: Array.from({ length: 33 }, () =>
          session(BASELINE_BYTES),
        ),
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
        allSessionLimits: [session(BASELINE_BYTES), session(52 * MiB)],
      }),
    ).toEqual({ maxBytes: 12 * MiB, maxEvents: 15_000 });
  });

  it('refuses once the pool is fully granted', () => {
    const policy = makePolicy(48 * MiB);
    expect(
      policy.grant({
        currentMaxEvents: BASELINE_EVENTS,
        currentMaxBytes: BASELINE_BYTES,
        allSessionLimits: [session(BASELINE_BYTES), session(56 * MiB)],
      }),
    ).toBeUndefined();
  });

  it('does not charge an untouched session that started at a larger baseline', () => {
    // Bridges sharing one pool may run different baselines. A session on a
    // 16 MiB-baseline bridge sitting AT its baseline has not grown; an
    // 8 MiB-baseline policy must not misread it as 8 MiB of granted growth
    // and refuse headroom while the pool is unused.
    const policy = makePolicy(12 * MiB);
    expect(
      policy.grant({
        currentMaxEvents: BASELINE_EVENTS,
        currentMaxBytes: BASELINE_BYTES,
        allSessionLimits: [
          session(BASELINE_BYTES),
          session(16 * MiB, 16 * MiB),
        ],
      }),
    ).toEqual({ maxBytes: 16 * MiB, maxEvents: 20_000 });
  });

  it('charges a grown session by its own baseline, not the policy baseline', () => {
    // The 16 MiB-baseline session grew to 24 MiB: 8 MiB of growth by its
    // OWN baseline, where the requester's 8 MiB baseline would misread it
    // as 16 MiB, overcharge the pool, and shrink this grant to 12 MiB.
    const policy = makePolicy(20 * MiB);
    expect(
      policy.grant({
        currentMaxEvents: BASELINE_EVENTS,
        currentMaxBytes: BASELINE_BYTES,
        allSessionLimits: [
          session(BASELINE_BYTES),
          session(24 * MiB, 16 * MiB),
        ],
      }),
    ).toEqual({ maxBytes: 16 * MiB, maxEvents: 20_000 });
  });

  it('refuses a session already at the hard cap', () => {
    const policy = makePolicy(512 * MiB);
    expect(
      policy.grant({
        currentMaxEvents: 320_000,
        currentMaxBytes: HARD_CAP_BYTES,
        allSessionLimits: [session(HARD_CAP_BYTES)],
      }),
    ).toBeUndefined();
  });

  it('caps the grant at the per-session hard cap with proportional entries', () => {
    const policy = makePolicy(512 * MiB);
    expect(
      policy.grant({
        currentMaxEvents: 160_000,
        currentMaxBytes: 128 * MiB,
        allSessionLimits: [session(128 * MiB)],
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
        allSessionLimits: [session(192 * MiB)],
      }),
    ).toEqual({ maxBytes: HARD_CAP_BYTES, maxEvents: 320_000 });
  });

  it('accounts the requester through its reported pre-growth cap', () => {
    // allSessionLimits carries the requester's CURRENT cap; granting
    // `current + available` keeps the daemon-wide sum at or below the
    // pool. The numbers make the pool-remainder term alone win (doubling
    // would reach 32 MiB), so a fixture that omits the requester's cap
    // produces a different grant and fails this test.
    const policy = makePolicy(20 * MiB);
    const grant = policy.grant({
      currentMaxEvents: 20_000,
      currentMaxBytes: 16 * MiB,
      allSessionLimits: [session(16 * MiB)],
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
      allSessionLimits: [session(BASELINE_BYTES, 1)],
    });
    expect(grant).toBeDefined();
    expect(Number.isSafeInteger(grant?.maxEvents)).toBe(true);
    expect(grant?.maxEvents).toBe(Number.MAX_SAFE_INTEGER);
    expect(grant?.maxBytes).toBe(16 * MiB);
  });
});
