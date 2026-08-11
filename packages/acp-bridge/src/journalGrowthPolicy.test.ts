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

  it('accounts the requester through its reported pre-growth cap', () => {
    // allSessionLimitBytes carries the requester's CURRENT cap; granting
    // `current + available` keeps the daemon-wide sum at or below the pool.
    const policy = makePolicy(24 * MiB);
    const grant = policy.grant({
      currentMaxEvents: 20_000,
      currentMaxBytes: 16 * MiB,
      allSessionLimitBytes: [16 * MiB],
    });
    // Extra already granted to the requester: 8 MiB; left: 16 MiB.
    expect(grant).toEqual({ maxBytes: 32 * MiB, maxEvents: 40_000 });
  });
});
