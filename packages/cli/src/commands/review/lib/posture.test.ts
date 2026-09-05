/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The plan-time posture prediction (#10104) must stay INSIDE the compose-time
// resolution: every case below that predicts `critical` is one
// `floorResolvesCritical` resolves `critical` for, and the conservative
// misses (a streak one short of the bar) predict nothing.

import { describe, it, expect } from 'vitest';
import {
  CRITICAL_FLOOR_ROUND,
  FLAT_STREAK_TO_ENGAGE,
  resolveCriticalPosture,
} from './posture.js';

describe('resolveCriticalPosture', () => {
  it('resolves the round arm from the side file alone', () => {
    expect(
      resolveCriticalPosture({
        sideLedger: { round: CRITICAL_FLOOR_ROUND - 1 },
      }),
    ).toBe('round');
  });

  it('stays off one round before the schedule with no streak', () => {
    expect(
      resolveCriticalPosture({
        sideLedger: { round: CRITICAL_FLOOR_ROUND - 2 },
      }),
    ).toBeNull();
  });

  it('resolves the flat-trend arm off a latched streak', () => {
    // Round 4 with flatRounds 2: compose's latch holds engagement on the
    // recorded streak alone, so the prediction may follow it.
    expect(
      resolveCriticalPosture({
        sideLedger: { round: 4, flatRounds: FLAT_STREAK_TO_ENGAGE },
      }),
    ).toBe('flat-trend');
  });

  it('does not predict a streak one measurement short of the bar', () => {
    // Compose MAY advance it this round — the prediction must not outrun it.
    expect(
      resolveCriticalPosture({
        sideLedger: { round: 4, flatRounds: FLAT_STREAK_TO_ENGAGE - 1 },
      }),
    ).toBeNull();
  });

  it('clamps a planted streak to the honest maximum, as compose does', () => {
    // At round 3 no honest run carries more than 1, so a planted 5 must not
    // engage the posture a round ahead of the earliest honest engagement.
    expect(
      resolveCriticalPosture({ sideLedger: { round: 3, flatRounds: 5 } }),
    ).toBeNull();
  });

  it('follows the recorded explicit floor in both directions', () => {
    expect(
      resolveCriticalPosture({ recordedFloor: 'critical', sideLedger: null }),
    ).toBe('explicit');
    // An explicit `suggestion` turns the posture off even where the round
    // schedule would have resolved it.
    expect(
      resolveCriticalPosture({
        recordedFloor: 'suggestion',
        sideLedger: { round: 20 },
      }),
    ).toBeNull();
  });

  it('reads every doubt state as no posture', () => {
    expect(resolveCriticalPosture({ sideLedger: null })).toBeNull();
    expect(resolveCriticalPosture({ sideLedger: 'garbled' })).toBeNull();
    expect(resolveCriticalPosture({ sideLedger: {} })).toBeNull();
    expect(
      resolveCriticalPosture({ sideLedger: { round: 0, flatRounds: 9 } }),
    ).toBeNull();
    expect(
      resolveCriticalPosture({ sideLedger: { round: '7' } }),
    ).toBeNull();
  });
});
