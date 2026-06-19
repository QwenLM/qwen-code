/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  shouldRenew,
  msUntilRenewal,
  DEFAULT_RENEW_BEFORE_DAYS,
} from './renewalSchedule.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-01-01T00:00:00Z');

describe('renewalSchedule', () => {
  it('does not renew a fresh 90-day cert; ~60 days until the renewal point', () => {
    const notAfter = new Date(now.getTime() + 90 * DAY);
    expect(shouldRenew(notAfter, now)).toBe(false);
    expect(msUntilRenewal(notAfter, now)).toBe(60 * DAY);
  });

  it('renews once inside the renewBeforeDays window (delay 0)', () => {
    const notAfter = new Date(now.getTime() + 20 * DAY); // 20 < 30
    expect(shouldRenew(notAfter, now)).toBe(true);
    expect(msUntilRenewal(notAfter, now)).toBe(0);
  });

  it('renews an already-expired cert (delay 0)', () => {
    const notAfter = new Date(now.getTime() - DAY);
    expect(shouldRenew(notAfter, now)).toBe(true);
    expect(msUntilRenewal(notAfter, now)).toBe(0);
  });

  it('treats the exact renewal point as due', () => {
    const notAfter = new Date(now.getTime() + DEFAULT_RENEW_BEFORE_DAYS * DAY);
    expect(shouldRenew(notAfter, now)).toBe(true);
    expect(msUntilRenewal(notAfter, now)).toBe(0);
  });

  it('honors a custom renewBeforeDays', () => {
    const notAfter = new Date(now.getTime() + 10 * DAY);
    expect(shouldRenew(notAfter, now, 7)).toBe(false);
    expect(msUntilRenewal(notAfter, now, 7)).toBe(3 * DAY);
  });
});
