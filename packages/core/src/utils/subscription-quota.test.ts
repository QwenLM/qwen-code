/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatSubscriptionQuotaDisplay,
  subscriptionQuotaDisplay,
} from './subscription-quota.js';
import {
  subscriptionErrorMessage,
  subscriptionHttpError,
} from '../qwen/subscription-errors.js';

const now = Date.parse('2026-11-04T00:00:00Z');
const reset = (hours: number) => now / 1000 + hours * 3600;
function message(member?: unknown, resetAt?: unknown) {
  return formatSubscriptionQuotaDisplay(
    subscriptionQuotaDisplay(402, {
      code: 'insufficient_quota',
      quota: { member_type: member, reset_at: resetAt },
    }),
  )!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe('subscription quota presentation', () => {
  it.each(['plus', 'lite'])('offers %s members an upgrade', (member) => {
    expect(message(member, reset(26))).toBe(
      "You've used up your weekly credits. Your credits are expected to reset in 1 day and 2 hours. You can wait or run /upgrade to get more credits.",
    );
  });

  it('asks Pro members to wait, with hours only below one day', () => {
    expect(message('pro', reset(3))).toBe(
      "You've used up your weekly credits. Your credits are expected to reset in 3 hours. Please try again after the reset.",
    );
  });

  it.each([undefined, null, '', 'future', 3])(
    'does not invent an upgrade for unknown tier %s',
    (member) => {
      expect(message(member, reset(2))).toBe(
        "You've used up your credits. Your credits are expected to reset in 2 hours. Please try again after the reset.",
      );
    },
  );

  it.each([
    undefined,
    null,
    '1793750400',
    NaN,
    Infinity,
    reset(-1),
    now / 1000,
    reset(1) + 0.5,
    1e20,
  ])('omits invalid or elapsed reset time %s', (resetAt) => {
    expect(message('pro', resetAt)).toBe(
      "You've used up your weekly credits. Please try again after the reset.",
    );
  });

  it.each([undefined, null, [], 'invalid', {}])(
    'classifies quota exhaustion without valid quota %s',
    (quota) => {
      expect(
        formatSubscriptionQuotaDisplay(
          subscriptionQuotaDisplay(402, { code: 'insufficient_quota', quota }),
        ),
      ).toBe("You've used up your credits. Please try again after the reset.");
    },
  );

  it.each([
    [429, 'insufficient_quota'],
    [402, 'other_code'],
    [403, 'membership_required'],
  ])('requires both status and exact code (%s, %s)', (status, code) => {
    expect(
      subscriptionQuotaDisplay(status as number, { code }),
    ).toBeUndefined();
    expect(
      subscriptionErrorMessage(
        subscriptionHttpError(status as number, {
          error: { code, message: 'Backend public text' },
        }),
      ),
    ).toBe('Backend public text');
  });

  it('rounds up remaining hours without adding a day below 24 hours', () => {
    expect(message('pro', reset(1 / 3600))).toContain('1 hour.');
    expect(message('pro', reset(23.9))).toContain('24 hours.');
    expect(message('pro', reset(24))).toContain('1 day and 0 hours.');
  });

  it('uses the supplied translator only for marked quota data', () => {
    const quota = {
      ...subscriptionQuotaDisplay(402, {
        code: 'insufficient_quota',
        quota: { member_type: 'pro', reset_at: reset(26) },
      }),
      requestId: 'quota-id',
    };
    const translate = vi.fn(() => 'translated quota');
    expect(formatSubscriptionQuotaDisplay(quota, translate)).toBe(
      'translated quota (request_id: quota-id)',
    );
    expect(translate).toHaveBeenLastCalledWith(
      "You've used up your weekly credits.{{reset}} Please try again after the reset.",
      { reset: 'translated quota' },
    );
    translate.mockClear();
    expect(
      formatSubscriptionQuotaDisplay(message('pro'), translate),
    ).toBeUndefined();
    expect(
      formatSubscriptionQuotaDisplay({ message: message('pro') }, translate),
    ).toBeUndefined();
    expect(translate).not.toHaveBeenCalled();
  });
});
