/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ENV_AUTOCOMPACT_WINDOW,
  ENV_AUTOCOMPACT_PCT_OVERRIDE,
  ENV_BLOCKING_LIMIT_OVERRIDE,
} from '../config/brand.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tokenLimit } from '../core/tokenLimits.js';
import type { Model } from '../provider/model/model.js';
import {
  ERROR_THRESHOLD_BUFFER_TOKENS,
  MANUAL_COMPACT_BUFFER_TOKENS,
  MIN_AUTOCOMPACT_BUFFER_TOKENS,
  WARNING_THRESHOLD_BUFFER_TOKENS,
  calculateTokenWarningState,
  calculateTokenWarningStateForContextWindow,
  getAutoCompactBufferTokens,
  getAutoCompactThreshold,
  getAutoCompactThresholdForContextWindow,
  getEffectiveContextWindowSize,
  getRawContextWindowSize,
  getSummaryReserveTokens,
} from './thresholds.js';

const MODEL: Model | undefined = undefined;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getRawContextWindowSize [CTX61]', () => {
  it('returns tokenLimit(model) by default', () => {
    expect(getRawContextWindowSize(MODEL)).toBe(tokenLimit(MODEL));
  });

  it('honors ENV_AUTOCOMPACT_WINDOW to clamp the raw window down', () => {
    vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '100000');
    expect(getRawContextWindowSize(MODEL)).toBe(100_000);
  });

  it('never raises the raw window above the model limit', () => {
    vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, String(tokenLimit(MODEL) * 10));
    expect(getRawContextWindowSize(MODEL)).toBe(tokenLimit(MODEL));
  });

  it('prefers the context window already resolved for the request', () => {
    expect(getRawContextWindowSize(undefined, 128_000)).toBe(128_000);
  });

  it('still applies the debug clamp to a request-resolved window', () => {
    vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '100000');
    expect(getRawContextWindowSize(undefined, 128_000)).toBe(100_000);
  });

  it.each([
    ['not-a-number', 'non-numeric'],
    ['0', 'zero'],
    ['-500', 'negative'],
  ])('ignores ENV_AUTOCOMPACT_WINDOW=%s (%s)', (value: string) => {
    vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, value);
    expect(getRawContextWindowSize(MODEL)).toBe(tokenLimit(MODEL));
  });
});

describe('getEffectiveContextWindowSize [CTX61]', () => {
  it('reserves compact summary output tokens from the raw window', () => {
    expect(getEffectiveContextWindowSize(MODEL)).toBe(
      tokenLimit(MODEL) - getSummaryReserveTokens(MODEL),
    );
  });

  it('clamps to 0 when the raw window is smaller than the summary reserve', () => {
    vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '10000');
    expect(getEffectiveContextWindowSize(MODEL)).toBe(0);
  });
});

describe('getAutoCompactThreshold [CTX61]', () => {
  it('returns effectiveWindow - max(13k, 5% effectiveWindow) by default', () => {
    const effective = getEffectiveContextWindowSize(MODEL);
    expect(getAutoCompactThreshold(MODEL)).toBe(
      effective - getAutoCompactBufferTokens(effective),
    );
  });

  it('ENV_AUTOCOMPACT_PCT_OVERRIDE lowers the threshold when percent is below base', () => {
    vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '100000');
    vi.stubEnv(ENV_AUTOCOMPACT_PCT_OVERRIDE, '50');
    const effective = getEffectiveContextWindowSize(MODEL);
    expect(getAutoCompactThreshold(MODEL)).toBe(Math.floor(effective * 0.5));
  });

  it('ENV_AUTOCOMPACT_PCT_OVERRIDE never raises the threshold above base', () => {
    vi.stubEnv(ENV_AUTOCOMPACT_PCT_OVERRIDE, '100');
    const effective = getEffectiveContextWindowSize(MODEL);
    const base = effective - getAutoCompactBufferTokens(effective);
    expect(getAutoCompactThreshold(MODEL)).toBe(base);
  });

  it.each([
    ['not-a-number', 'non-numeric'],
    ['0', 'zero'],
    ['-10', 'negative'],
    ['150', 'over 100'],
  ])('ignores ENV_AUTOCOMPACT_PCT_OVERRIDE=%s (%s)', (value: string) => {
    vi.stubEnv(ENV_AUTOCOMPACT_PCT_OVERRIDE, value);
    const effective = getEffectiveContextWindowSize(MODEL);
    expect(getAutoCompactThreshold(MODEL)).toBe(
      effective - getAutoCompactBufferTokens(effective),
    );
  });

  it('clamps the threshold to 0 when there is no effective input budget', () => {
    vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '10000');
    expect(getAutoCompactThreshold(MODEL)).toBe(0);
  });

  it('derives the threshold from the request window for a routing alias', () => {
    expect(getAutoCompactThreshold(undefined, 128_000)).toBe(95_000);
  });
});

describe('getAutoCompactThresholdForContextWindow [CTX61]', () => {
  it('derives the threshold from the provided context window', () => {
    expect(getAutoCompactThresholdForContextWindow(200_000)).toBe(187_000);
  });
});

describe('calculateTokenWarningState [CTX71]', () => {
  it('returns 100% remaining when tokenUsage is 0', () => {
    const state = calculateTokenWarningState(0, MODEL);
    expect(state.percentLeft).toBe(100);
    expect(state.isAboveWarningThreshold).toBe(false);
    expect(state.isAboveErrorThreshold).toBe(false);
    expect(state.isAboveAutoCompactThreshold).toBe(false);
    expect(state.isAtBlockingLimit).toBe(false);
  });

  it('clamps percentLeft to 0 when usage exceeds threshold', () => {
    const threshold = getAutoCompactThreshold(MODEL);
    const state = calculateTokenWarningState(threshold * 10, MODEL);
    expect(state.percentLeft).toBe(0);
  });

  it('flips isAboveWarningThreshold at threshold - WARNING buffer', () => {
    const threshold = getAutoCompactThreshold(MODEL);
    const warning = threshold - WARNING_THRESHOLD_BUFFER_TOKENS;
    expect(
      calculateTokenWarningState(warning - 1, MODEL).isAboveWarningThreshold,
    ).toBe(false);
    expect(
      calculateTokenWarningState(warning, MODEL).isAboveWarningThreshold,
    ).toBe(true);
  });

  it('flips isAboveErrorThreshold at threshold - ERROR buffer', () => {
    const threshold = getAutoCompactThreshold(MODEL);
    const error = threshold - ERROR_THRESHOLD_BUFFER_TOKENS;
    expect(
      calculateTokenWarningState(error - 1, MODEL).isAboveErrorThreshold,
    ).toBe(false);
    expect(calculateTokenWarningState(error, MODEL).isAboveErrorThreshold).toBe(
      true,
    );
  });

  it('flips isAboveAutoCompactThreshold exactly at the auto-compact threshold', () => {
    const threshold = getAutoCompactThreshold(MODEL);
    expect(
      calculateTokenWarningState(threshold - 1, MODEL)
        .isAboveAutoCompactThreshold,
    ).toBe(false);
    expect(
      calculateTokenWarningState(threshold, MODEL).isAboveAutoCompactThreshold,
    ).toBe(true);
  });

  it('flips isAtBlockingLimit at effectiveWindow - MANUAL_COMPACT buffer', () => {
    const effective = getEffectiveContextWindowSize(MODEL);
    const blocking = effective - MANUAL_COMPACT_BUFFER_TOKENS;
    expect(
      calculateTokenWarningState(blocking - 1, MODEL).isAtBlockingLimit,
    ).toBe(false);
    expect(calculateTokenWarningState(blocking, MODEL).isAtBlockingLimit).toBe(
      true,
    );
  });

  it('ENV_BLOCKING_LIMIT_OVERRIDE overrides the blocking limit', () => {
    vi.stubEnv(ENV_BLOCKING_LIMIT_OVERRIDE, '500');
    expect(calculateTokenWarningState(499, MODEL).isAtBlockingLimit).toBe(
      false,
    );
    expect(calculateTokenWarningState(500, MODEL).isAtBlockingLimit).toBe(true);
  });

  it.each([
    ['not-a-number', 'non-numeric'],
    ['0', 'zero'],
    ['-1', 'negative'],
  ])(
    'ignores ENV_BLOCKING_LIMIT_OVERRIDE=%s (%s), falling back to default',
    (value: string) => {
      vi.stubEnv(ENV_BLOCKING_LIMIT_OVERRIDE, value);
      const effective = getEffectiveContextWindowSize(MODEL);
      const defaultBlocking = effective - MANUAL_COMPACT_BUFFER_TOKENS;
      expect(
        calculateTokenWarningState(defaultBlocking - 1, MODEL)
          .isAtBlockingLimit,
      ).toBe(false);
      expect(
        calculateTokenWarningState(defaultBlocking, MODEL).isAtBlockingLimit,
      ).toBe(true);
    },
  );

  it('composes correctly with ENV_AUTOCOMPACT_WINDOW override', () => {
    vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '100000');
    const effective = getEffectiveContextWindowSize(MODEL);
    const threshold = effective - getAutoCompactBufferTokens(effective);
    const state = calculateTokenWarningState(threshold, MODEL);
    expect(state.isAboveAutoCompactThreshold).toBe(true);
    expect(state.percentLeft).toBe(0);
  });

  it('handles a 0 auto-compact threshold without dividing by zero', () => {
    vi.stubEnv(ENV_AUTOCOMPACT_WINDOW, '10000');
    const state = calculateTokenWarningState(0, MODEL);
    expect(state.percentLeft).toBe(0);
    expect(state.isAboveAutoCompactThreshold).toBe(true);
    expect(state.isAtBlockingLimit).toBe(true);
  });
});

describe('calculateTokenWarningStateForContextWindow [CTX71]', () => {
  it('uses the provided context window for warning and error thresholds', () => {
    const state = calculateTokenWarningStateForContextWindow(181_400, 200_000);

    expect(state.isAboveWarningThreshold).toBe(true);
    expect(state.isAboveErrorThreshold).toBe(true);
    expect(state.isAboveAutoCompactThreshold).toBe(false);
    expect(state.isAtBlockingLimit).toBe(false);
  });

  it('flags blocking when the context window budget is exhausted', () => {
    expect(calculateTokenWarningStateForContextWindow(100, 0)).toEqual({
      percentLeft: 0,
      isAboveWarningThreshold: true,
      isAboveErrorThreshold: true,
      isAboveAutoCompactThreshold: true,
      isAtBlockingLimit: true,
    });
  });

  it('does not produce NaN when the auto-compact threshold is zero', () => {
    const state = calculateTokenWarningStateForContextWindow(
      0,
      MIN_AUTOCOMPACT_BUFFER_TOKENS,
    );

    expect(state.percentLeft).toBe(0);
  });
});
