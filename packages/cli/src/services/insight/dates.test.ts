/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { dayKey, hourOfDay, parseDayKey, todayKey } from './dates.js';

// All assertions are timezone-independent: dates are constructed with the
// local-time Date constructor and compared against local-derived
// expectations, so the suite passes under any TZ. Run it explicitly with
// `TZ=UTC` and `TZ=America/New_York` to exercise both offset signs.

describe('dayKey', () => {
  it('keys a local-time instant by its local calendar day', () => {
    expect(dayKey(new Date(2026, 0, 15, 0, 0, 0))).toBe('2026-01-15');
    expect(dayKey(new Date(2026, 0, 15, 23, 59, 59))).toBe('2026-01-15');
  });

  it('zero-pads month and day', () => {
    expect(dayKey(new Date(2026, 8, 5, 12))).toBe('2026-09-05');
  });

  it('keys late-evening and early-morning instants to their local day', () => {
    // The UTC alternative would shift one of these across midnight for
    // any non-UTC viewer; the local key never does.
    const lateEvening = new Date(2026, 6, 20, 23, 30);
    const earlyMorning = new Date(2026, 6, 21, 0, 30);
    expect(dayKey(lateEvening)).toBe('2026-07-20');
    expect(dayKey(earlyMorning)).toBe('2026-07-21');
  });
});

describe('parseDayKey', () => {
  it('parses a day key to local midnight of that day', () => {
    const parsed = parseDayKey('2026-07-20');
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(6);
    expect(parsed.getDate()).toBe(20);
    expect(parsed.getHours()).toBe(0);
    expect(parsed.getMinutes()).toBe(0);
  });

  it('round-trips with dayKey without shifting the day', () => {
    // The old `new Date('YYYY-MM-DD')` parse produced UTC midnight, which
    // local normalization then shifted to the previous day in
    // negative-offset timezones. Local construction cannot shift.
    for (const key of ['2026-01-01', '2026-07-20', '2026-12-31']) {
      expect(dayKey(parseDayKey(key))).toBe(key);
    }
  });
});

describe('todayKey', () => {
  it('keys the injected now by its local day', () => {
    expect(todayKey(new Date(2026, 6, 20, 7, 0))).toBe('2026-07-20');
  });

  it('defaults to the current time', () => {
    expect(todayKey()).toBe(dayKey(new Date()));
  });
});

describe('hourOfDay', () => {
  it('buckets by the local hour', () => {
    expect(hourOfDay(new Date(2026, 6, 20, 7, 59))).toBe(7);
    expect(hourOfDay(new Date(2026, 6, 20, 0, 0))).toBe(0);
    expect(hourOfDay(new Date(2026, 6, 20, 23, 0))).toBe(23);
  });
});
