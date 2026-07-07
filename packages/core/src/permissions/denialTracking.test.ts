/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  AUTO_MODE_DENIAL_LIMITS,
  createDenialState,
  formatDenialStateLog,
  isApproveOutcome,
  isDenialFallbackReason,
  recordAllow,
  recordBlock,
  recordFallbackApprove,
  recordUnavailable,
  resetDenialState,
  shouldFallback,
  type AutoModeDenialState,
} from './denialTracking.js';

const FRESH: AutoModeDenialState = {
  consecutiveBlock: 0,
  consecutiveUnavailable: 0,
  totalBlock: 0,
  totalUnavailable: 0,
};

describe('createDenialState', () => {
  it('starts with all counters at zero', () => {
    expect(createDenialState()).toEqual(FRESH);
  });
});

describe('formatDenialStateLog', () => {
  it('formats every denial counter in a stable order', () => {
    expect(
      formatDenialStateLog({
        consecutiveBlock: 1,
        consecutiveUnavailable: 2,
        totalBlock: 3,
        totalUnavailable: 4,
      }),
    ).toBe(
      'consecutiveBlock=1, consecutiveUnavailable=2, totalBlock=3, totalUnavailable=4',
    );
  });
});

describe('isDenialFallbackReason', () => {
  it('accepts denial-tracking fallback reasons', () => {
    expect(isDenialFallbackReason('consecutive_block')).toBe(true);
    expect(isDenialFallbackReason('consecutive_unavailable')).toBe(true);
    expect(isDenialFallbackReason('total_denial')).toBe(true);
  });

  it('rejects non-denial fallback reasons', () => {
    expect(isDenialFallbackReason('ask_rule')).toBe(false);
    expect(isDenialFallbackReason('safety_check')).toBe(false);
    expect(isDenialFallbackReason('')).toBe(false);
  });
});

describe('recordBlock', () => {
  it('increments consecutiveBlock and totalBlock', () => {
    const s = recordBlock(FRESH);
    expect(s.consecutiveBlock).toBe(1);
    expect(s.totalBlock).toBe(1);
  });

  it('cross-resets consecutiveUnavailable', () => {
    let s: AutoModeDenialState = FRESH;
    s = recordUnavailable(s);
    expect(s.consecutiveUnavailable).toBe(1);
    s = recordBlock(s);
    expect(s.consecutiveUnavailable).toBe(0);
    // Total counters are independent.
    expect(s.totalUnavailable).toBe(1);
  });
});

describe('recordUnavailable', () => {
  it('increments consecutiveUnavailable and totalUnavailable', () => {
    const s = recordUnavailable(FRESH);
    expect(s.consecutiveUnavailable).toBe(1);
    expect(s.totalUnavailable).toBe(1);
  });

  it('cross-resets consecutiveBlock', () => {
    let s: AutoModeDenialState = FRESH;
    s = recordBlock(s);
    s = recordBlock(s);
    expect(s.consecutiveBlock).toBe(2);
    s = recordUnavailable(s);
    expect(s.consecutiveBlock).toBe(0);
    // Total counters are independent.
    expect(s.totalBlock).toBe(2);
  });
});

describe('recordAllow', () => {
  it('resets both consecutive counters', () => {
    let s: AutoModeDenialState = FRESH;
    s = recordBlock(s);
    s = recordBlock(s);
    s = recordAllow(s);
    expect(s.consecutiveBlock).toBe(0);
    expect(s.consecutiveUnavailable).toBe(0);
    // Totals stay (telemetry only).
    expect(s.totalBlock).toBe(2);
  });

  it('returns the same reference when nothing changes', () => {
    const s = createDenialState();
    expect(recordAllow(s)).toBe(s);
  });
});

describe('shouldFallback', () => {
  it('returns no fallback for fresh state', () => {
    expect(shouldFallback(FRESH)).toEqual({ fallback: false });
  });

  it('triggers fallback after 3 consecutive blocks', () => {
    let s: AutoModeDenialState = FRESH;
    s = recordBlock(s);
    s = recordBlock(s);
    expect(shouldFallback(s)).toEqual({ fallback: false });
    s = recordBlock(s);
    expect(shouldFallback(s)).toEqual({
      fallback: true,
      reason: 'consecutive_block',
    });
  });

  it('triggers fallback after 2 consecutive unavailable', () => {
    let s: AutoModeDenialState = FRESH;
    s = recordUnavailable(s);
    expect(shouldFallback(s)).toEqual({ fallback: false });
    s = recordUnavailable(s);
    expect(shouldFallback(s)).toEqual({
      fallback: true,
      reason: 'consecutive_unavailable',
    });
  });

  it('triggers fallback after 20 total denials even when they are not consecutive', () => {
    let s: AutoModeDenialState = FRESH;
    for (let i = 0; i < AUTO_MODE_DENIAL_LIMITS.maxTotalDenials - 1; i++) {
      s = i % 2 === 0 ? recordBlock(s) : recordUnavailable(s);
      s = recordAllow(s); // cycle block→allow so consecutive resets each round
    }
    expect(s.totalBlock + s.totalUnavailable).toBe(19);
    expect(shouldFallback(s)).toEqual({ fallback: false });
    s = recordBlock(s);
    expect(s.totalBlock + s.totalUnavailable).toBe(20);
    expect(shouldFallback(s)).toEqual({
      fallback: true,
      reason: 'total_denial',
    });
  });

  it('gives total-denial fallback precedence over consecutive thresholds', () => {
    const s: AutoModeDenialState = {
      consecutiveBlock: AUTO_MODE_DENIAL_LIMITS.maxConsecutiveBlock,
      consecutiveUnavailable: 0,
      totalBlock: AUTO_MODE_DENIAL_LIMITS.maxTotalDenials,
      totalUnavailable: 0,
    };

    expect(shouldFallback(s)).toEqual({
      fallback: true,
      reason: 'total_denial',
    });
  });
});

describe('recordFallbackApprove', () => {
  it('resets consecutiveBlock so AUTO flow can resume', () => {
    let s: AutoModeDenialState = FRESH;
    s = recordBlock(s);
    s = recordBlock(s);
    s = recordBlock(s);
    expect(shouldFallback(s).fallback).toBe(true);
    s = recordFallbackApprove(s);
    expect(s.consecutiveBlock).toBe(0);
    expect(shouldFallback(s).fallback).toBe(false);
  });

  it('resets consecutiveUnavailable so AUTO flow can resume after a transient classifier blip', () => {
    // Regression guard: a transient classifier API outage would push
    // consecutiveUnavailable to its threshold and trigger fallback. Before
    // this fix, recordFallbackApprove only reset consecutiveBlock, so
    // every subsequent call kept seeing shouldFallback === true and the
    // session was permanently downgraded to manual approval until the
    // user toggled ApprovalMode. Symmetric reset matches recordAllow.
    let s: AutoModeDenialState = FRESH;
    s = recordUnavailable(s);
    s = recordUnavailable(s);
    expect(shouldFallback(s).fallback).toBe(true);
    s = recordFallbackApprove(s);
    expect(s.consecutiveUnavailable).toBe(0);
    expect(shouldFallback(s).fallback).toBe(false);
  });

  it('preserves total counters below the total denial cap', () => {
    let s: AutoModeDenialState = FRESH;
    s = recordBlock(s);
    s = recordUnavailable(s);
    s = recordUnavailable(s);
    s = recordFallbackApprove(s);
    expect(s.totalBlock).toBe(1);
    expect(s.totalUnavailable).toBe(2);
  });

  it('resets total counters after the user approves a total-cap fallback prompt', () => {
    let s: AutoModeDenialState = FRESH;
    for (let i = 0; i < AUTO_MODE_DENIAL_LIMITS.maxTotalDenials; i++) {
      s = recordBlock(s);
      s = recordAllow(s);
    }
    expect(shouldFallback(s)).toEqual({
      fallback: true,
      reason: 'total_denial',
    });

    s = recordFallbackApprove(s);

    expect(s.consecutiveBlock).toBe(0);
    expect(s.consecutiveUnavailable).toBe(0);
    expect(s.totalBlock).toBe(0);
    expect(s.totalUnavailable).toBe(0);
    expect(shouldFallback(s)).toEqual({ fallback: false });
  });

  it('resets all counters when total and consecutive caps overlap', () => {
    const s: AutoModeDenialState = {
      consecutiveBlock: AUTO_MODE_DENIAL_LIMITS.maxConsecutiveBlock,
      consecutiveUnavailable: 0,
      totalBlock: AUTO_MODE_DENIAL_LIMITS.maxTotalDenials,
      totalUnavailable: 0,
    };

    expect(recordFallbackApprove(s)).toEqual(FRESH);
  });

  it('is a no-op when both consecutive counters are already zero', () => {
    const s: AutoModeDenialState = FRESH;
    expect(recordFallbackApprove(s)).toBe(s);
  });
});

describe('resetDenialState', () => {
  it('clears every counter (e.g. when user switches ApprovalMode)', () => {
    let s: AutoModeDenialState = FRESH;
    s = recordBlock(s);
    s = recordUnavailable(s);
    s = recordBlock(s);
    s = resetDenialState();
    expect(s).toEqual(FRESH);
  });
});

describe('isApproveOutcome', () => {
  // Single source of truth for "user said yes" — shared between the CLI
  // scheduler and the ACP Session. Drift between them was a previous
  // round's bug; this test guards both call sites at once.
  it('returns true for every proceed_* outcome plus modify_with_editor', () => {
    expect(isApproveOutcome('proceed_once')).toBe(true);
    expect(isApproveOutcome('proceed_always')).toBe(true);
    expect(isApproveOutcome('proceed_always_project')).toBe(true);
    expect(isApproveOutcome('proceed_always_user')).toBe(true);
    expect(isApproveOutcome('modify_with_editor')).toBe(true);
  });

  it('returns false for cancel and unknown outcomes', () => {
    expect(isApproveOutcome('cancel')).toBe(false);
    expect(isApproveOutcome('')).toBe(false);
    expect(isApproveOutcome('unknown_outcome')).toBe(false);
  });
});

describe('AUTO_MODE_DENIAL_LIMITS', () => {
  it('is frozen at the documented values', () => {
    expect(AUTO_MODE_DENIAL_LIMITS.maxConsecutiveBlock).toBe(3);
    expect(AUTO_MODE_DENIAL_LIMITS.maxConsecutiveUnavailable).toBe(2);
    expect(AUTO_MODE_DENIAL_LIMITS.maxTotalDenials).toBe(20);
  });
});
