/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  AUTO_MODE_DENIAL_LIMITS,
  consumePendingManualRetry,
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
import { ToolConfirmationOutcome } from '../tools/tools.js';

const FRESH: AutoModeDenialState = {
  consecutiveBlock: 0,
  consecutiveUnavailable: 0,
  totalBlock: 0,
  totalUnavailable: 0,
};
// Total-denial cap and consecutive-block cap reached at the same time.
const BOTH_CAPS: AutoModeDenialState = {
  consecutiveBlock: AUTO_MODE_DENIAL_LIMITS.maxConsecutiveBlock,
  consecutiveUnavailable: 0,
  totalBlock: AUTO_MODE_DENIAL_LIMITS.maxTotalDenials,
  totalUnavailable: 0,
};
const NO_FALLBACK = { fallback: false };
const fallbackFor = (reason: string) => ({ fallback: true, reason });
const RETRY = fallbackFor('classifier_blocked_retry');

/** Applies each transition in order, starting from FRESH. */
const apply = (
  ...steps: Array<(s: AutoModeDenialState) => AutoModeDenialState>
) => steps.reduce((s, step) => step(s), FRESH);

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
    expect(isDenialFallbackReason('classifier_blocked_retry')).toBe(true);
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
    const s = apply(recordUnavailable);
    expect(s.consecutiveUnavailable).toBe(1);
    const next = recordBlock(s);
    expect(next.consecutiveUnavailable).toBe(0);
    expect(next.totalUnavailable).toBe(1); // totals are independent
  });

  it('records only a digest for the exact action eligible for manual retry', () => {
    expect(recordBlock(FRESH, 'action-digest')).toMatchObject({
      pendingManualRetryFingerprint: 'action-digest',
    });
  });
});

describe('recordUnavailable', () => {
  it('increments consecutiveUnavailable and totalUnavailable', () => {
    const s = recordUnavailable(FRESH);
    expect(s.consecutiveUnavailable).toBe(1);
    expect(s.totalUnavailable).toBe(1);
  });

  it('cross-resets consecutiveBlock', () => {
    const s = apply(recordBlock, recordBlock);
    expect(s.consecutiveBlock).toBe(2);
    const next = recordUnavailable(s);
    expect(next.consecutiveBlock).toBe(0);
    expect(next.totalBlock).toBe(2); // totals are independent
  });
});

describe('recordAllow', () => {
  it('resets both consecutive counters', () => {
    const s = apply(recordBlock, recordBlock, recordAllow);
    expect(s.consecutiveBlock).toBe(0);
    expect(s.consecutiveUnavailable).toBe(0);
    expect(s.totalBlock).toBe(2); // totals stay (telemetry only)
  });

  it('returns the same reference when nothing changes', () => {
    const s = createDenialState();
    expect(recordAllow(s)).toBe(s);
  });
});

describe('shouldFallback', () => {
  it('returns no fallback for fresh state', () => {
    expect(shouldFallback(FRESH)).toEqual(NO_FALLBACK);
  });

  it('triggers fallback after 3 consecutive blocks', () => {
    const s = apply(recordBlock, recordBlock);
    expect(shouldFallback(s)).toEqual(NO_FALLBACK);
    expect(shouldFallback(recordBlock(s))).toEqual(
      fallbackFor('consecutive_block'),
    );
  });

  it('routes only an exact retry of the last blocked action to manual approval', () => {
    const blocked = recordBlock(FRESH, 'blocked-action');

    expect(shouldFallback(blocked, 'blocked-action')).toEqual(RETRY);
    expect(shouldFallback(blocked, 'changed-action')).toEqual(NO_FALLBACK);
  });

  it('consumes the exact-action retry before manual confirmation', () => {
    const blocked = recordBlock(FRESH, 'blocked-action');
    const consumed = consumePendingManualRetry(blocked);

    expect(consumed.pendingManualRetryFingerprint).toBeUndefined();
    expect(shouldFallback(consumed, 'blocked-action')).toEqual(NO_FALLBACK);
  });

  it('preserves an exact-action retry across unrelated allowed work', () => {
    const blocked = recordBlock(FRESH, 'blocked-action');
    const allowed = recordAllow(blocked, 'allowed-action');

    expect(shouldFallback(allowed, 'blocked-action')).toEqual(RETRY);
  });

  it('clears the retry when that exact action is allowed', () => {
    const blocked = recordBlock(FRESH, 'blocked-action');
    const allowed = recordAllow(blocked, 'blocked-action');

    expect(shouldFallback(allowed, 'blocked-action')).toEqual(NO_FALLBACK);
  });

  it.each([
    ['a fingerprint-less block', recordBlock],
    ['classifier unavailability', recordUnavailable],
    ['an unrelated fallback approval', recordFallbackApprove],
  ])('preserves an exact-action retry across %s', (_name, transition) => {
    const blocked = recordBlock(FRESH, 'blocked-action');

    expect(shouldFallback(transition(blocked), 'blocked-action')).toEqual(
      RETRY,
    );
  });

  it('triggers fallback after 2 consecutive unavailable', () => {
    const s = apply(recordUnavailable);
    expect(shouldFallback(s)).toEqual(NO_FALLBACK);
    expect(shouldFallback(recordUnavailable(s))).toEqual(
      fallbackFor('consecutive_unavailable'),
    );
  });

  it('triggers fallback after 20 total denials even when they are not consecutive', () => {
    let s: AutoModeDenialState = FRESH;
    for (let i = 0; i < AUTO_MODE_DENIAL_LIMITS.maxTotalDenials - 1; i++) {
      s = i % 2 === 0 ? recordBlock(s) : recordUnavailable(s);
      s = recordAllow(s); // cycle block→allow so consecutive resets each round
    }
    expect(s.totalBlock + s.totalUnavailable).toBe(19);
    expect(shouldFallback(s)).toEqual(NO_FALLBACK);
    s = recordBlock(s);
    expect(s.totalBlock + s.totalUnavailable).toBe(20);
    expect(shouldFallback(s)).toEqual(fallbackFor('total_denial'));
  });

  it('gives total-denial fallback precedence over consecutive thresholds', () => {
    expect(shouldFallback(BOTH_CAPS)).toEqual(fallbackFor('total_denial'));
  });
});

describe('recordFallbackApprove', () => {
  it('resets consecutiveBlock so AUTO flow can resume', () => {
    const s = apply(recordBlock, recordBlock, recordBlock);
    expect(shouldFallback(s).fallback).toBe(true);
    const next = recordFallbackApprove(s);
    expect(next.consecutiveBlock).toBe(0);
    expect(shouldFallback(next).fallback).toBe(false);
  });

  it('resets consecutiveUnavailable so AUTO flow can resume after a transient classifier blip', () => {
    // Regression guard: a transient classifier outage pushed
    // consecutiveUnavailable to its threshold, and recordFallbackApprove used
    // to reset only consecutiveBlock, so the session stayed on manual approval
    // until the user toggled ApprovalMode. Symmetric reset matches recordAllow.
    const s = apply(recordUnavailable, recordUnavailable);
    expect(shouldFallback(s).fallback).toBe(true);
    const next = recordFallbackApprove(s);
    expect(next.consecutiveUnavailable).toBe(0);
    expect(shouldFallback(next).fallback).toBe(false);
  });

  it('preserves total counters below the total denial cap', () => {
    const s = apply(
      recordBlock,
      recordUnavailable,
      recordUnavailable,
      recordFallbackApprove,
    );
    expect(s.totalBlock).toBe(1);
    expect(s.totalUnavailable).toBe(2);
  });

  it('resets total counters after the user approves a total-cap fallback prompt', () => {
    let s: AutoModeDenialState = FRESH;
    for (let i = 0; i < AUTO_MODE_DENIAL_LIMITS.maxTotalDenials; i++) {
      s = recordAllow(recordBlock(s));
    }
    expect(shouldFallback(s)).toEqual(fallbackFor('total_denial'));

    s = recordFallbackApprove(s);

    expect(s.consecutiveBlock).toBe(0);
    expect(s.consecutiveUnavailable).toBe(0);
    expect(s.totalBlock).toBe(0);
    expect(s.totalUnavailable).toBe(0);
    expect(shouldFallback(s)).toEqual(NO_FALLBACK);
  });

  it('preserves an unrelated retry when resetting the total denial cap', () => {
    const state = {
      ...FRESH,
      totalBlock: AUTO_MODE_DENIAL_LIMITS.maxTotalDenials,
      pendingManualRetryFingerprint: 'blocked-action',
    };

    expect(
      shouldFallback(recordFallbackApprove(state), 'blocked-action'),
    ).toEqual(RETRY);
  });

  it('resets all counters when total and consecutive caps overlap', () => {
    expect(recordFallbackApprove(BOTH_CAPS)).toEqual(FRESH);
  });

  it('is a no-op when both consecutive counters are already zero', () => {
    expect(recordFallbackApprove(FRESH)).toBe(FRESH);
  });
});

describe('resetDenialState', () => {
  it('clears every counter (e.g. when user switches ApprovalMode)', () => {
    apply(recordBlock, recordUnavailable, (s) =>
      recordBlock(s, 'blocked-action'),
    );
    expect(resetDenialState()).toEqual(FRESH);
  });
});

describe('isApproveOutcome', () => {
  // Single source of truth for "user said yes", shared by the CLI scheduler
  // and the ACP Session (drift between them was an earlier bug). Enumerated
  // from the enum because the hand-written list had drifted (it missed
  // `proceed_always_server` and `proceed_always_tool`); a new enum value now
  // fails here instead of silently reading as a denial.
  const proceedOutcomes = Object.values(ToolConfirmationOutcome).filter(
    (outcome) => outcome.startsWith('proceed_'),
  );

  it('covers every proceed_* value the enum declares', () => {
    // Guards the filter: if the naming convention changes, the table below
    // would silently shrink to nothing.
    expect(proceedOutcomes.length).toBeGreaterThanOrEqual(7);
  });

  it.each(proceedOutcomes)('returns true for %s', (outcome) => {
    expect(isApproveOutcome(outcome)).toBe(true);
  });

  it('returns true for modify_with_editor', () => {
    expect(isApproveOutcome(ToolConfirmationOutcome.ModifyWithEditor)).toBe(
      true,
    );
  });

  it('returns false for cancel and unknown outcomes', () => {
    expect(isApproveOutcome('cancel')).toBe(false);
    expect(isApproveOutcome('')).toBe(false);
    expect(isApproveOutcome('unknown_outcome')).toBe(false);
  });

  // Restoring the previous approval mode is not an approval of this call.
  it('returns false for restore_previous', () => {
    expect(isApproveOutcome(ToolConfirmationOutcome.RestorePrevious)).toBe(
      false,
    );
  });
});

describe('AUTO_MODE_DENIAL_LIMITS', () => {
  it('is frozen at the documented values', () => {
    expect(AUTO_MODE_DENIAL_LIMITS.maxConsecutiveBlock).toBe(3);
    expect(AUTO_MODE_DENIAL_LIMITS.maxConsecutiveUnavailable).toBe(2);
    expect(AUTO_MODE_DENIAL_LIMITS.maxTotalDenials).toBe(20);
  });
});
