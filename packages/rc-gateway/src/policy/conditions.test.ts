/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseTimeOfDay,
  isWithinTimeOfDay,
  parseExpiresAt,
  isExpired,
} from './conditions.js';

describe('parseTimeOfDay', () => {
  it('parses a valid window to minutes-of-day', () => {
    const p = parseTimeOfDay({
      from: '09:00',
      to: '23:30',
      timezone: 'UTC',
    });
    expect(p).toEqual({ fromMin: 540, toMin: 1410, timezone: 'UTC' });
  });

  it('parses 00:00 boundary', () => {
    const p = parseTimeOfDay({ from: '00:00', to: '23:59', timezone: 'UTC' });
    expect(p).toEqual({ fromMin: 0, toMin: 1439, timezone: 'UTC' });
  });

  it('rejects "24:00" (out of range hour)', () => {
    expect(
      parseTimeOfDay({ from: '24:00', to: '01:00', timezone: 'UTC' }),
    ).toBeNull();
  });

  it('rejects "9:00" (missing leading zero)', () => {
    expect(
      parseTimeOfDay({ from: '9:00', to: '17:00', timezone: 'UTC' }),
    ).toBeNull();
  });

  it('rejects "09:9" (single-digit minute)', () => {
    expect(
      parseTimeOfDay({ from: '09:9', to: '17:00', timezone: 'UTC' }),
    ).toBeNull();
  });

  it('rejects "09:60" (minute out of range)', () => {
    expect(
      parseTimeOfDay({ from: '09:60', to: '17:00', timezone: 'UTC' }),
    ).toBeNull();
  });

  it('rejects a missing field', () => {
    expect(parseTimeOfDay({ from: '09:00', timezone: 'UTC' })).toBeNull();
    expect(parseTimeOfDay({ from: '09:00', to: '17:00' })).toBeNull();
  });

  it('rejects a non-object (string/null/number)', () => {
    expect(parseTimeOfDay('09:00-17:00')).toBeNull();
    expect(parseTimeOfDay(null)).toBeNull();
    expect(parseTimeOfDay(42)).toBeNull();
    expect(parseTimeOfDay(undefined)).toBeNull();
  });

  it('rejects an empty timezone', () => {
    expect(
      parseTimeOfDay({ from: '09:00', to: '17:00', timezone: '' }),
    ).toBeNull();
  });

  it('rejects a garbage / invalid IANA timezone', () => {
    expect(
      parseTimeOfDay({
        from: '09:00',
        to: '17:00',
        timezone: 'Not/AReal_Zone',
      }),
    ).toBeNull();
  });
});

describe('isWithinTimeOfDay', () => {
  // UTC noon for simple non-wrapping checks.
  const at = (iso: string) => new Date(iso);

  it('is true inside the window', () => {
    const p = parseTimeOfDay({ from: '09:00', to: '17:00', timezone: 'UTC' })!;
    expect(isWithinTimeOfDay(p, at('2026-06-09T12:00:00Z'))).toBe(true);
  });

  it('is false outside the window', () => {
    const p = parseTimeOfDay({ from: '09:00', to: '17:00', timezone: 'UTC' })!;
    expect(isWithinTimeOfDay(p, at('2026-06-09T18:00:00Z'))).toBe(false);
  });

  it('is inclusive of both boundaries', () => {
    const p = parseTimeOfDay({ from: '09:00', to: '17:00', timezone: 'UTC' })!;
    expect(isWithinTimeOfDay(p, at('2026-06-09T09:00:00Z'))).toBe(true);
    expect(isWithinTimeOfDay(p, at('2026-06-09T17:00:00Z'))).toBe(true);
  });

  it('handles midnight-wrap (23:00-07:00): inside at 02:00, outside at 12:00', () => {
    const p = parseTimeOfDay({ from: '23:00', to: '07:00', timezone: 'UTC' })!;
    expect(isWithinTimeOfDay(p, at('2026-06-09T02:00:00Z'))).toBe(true);
    expect(isWithinTimeOfDay(p, at('2026-06-09T12:00:00Z'))).toBe(false);
  });

  it('DST: a America/Los_Angeles 09:00-17:00 window projects tz wall-clock, not raw UTC', () => {
    // Same UTC wall-time 00:30 on both dates. Raw-UTC minutes would be 30 on
    // both → both "outside" 09:00-17:00. But projected into LA:
    //   summer 2026-07-01T00:30Z → 17:30 PDT (UTC-7) → OUTSIDE
    //   winter 2026-01-01T00:30Z → 16:30 PST (UTC-8) → INSIDE
    // The winter=inside assertion fails for any raw-UTC implementation.
    const p = parseTimeOfDay({
      from: '09:00',
      to: '17:00',
      timezone: 'America/Los_Angeles',
    })!;
    expect(isWithinTimeOfDay(p, at('2026-07-01T00:30:00Z'))).toBe(false);
    expect(isWithinTimeOfDay(p, at('2026-01-01T00:30:00Z'))).toBe(true);
  });
});

describe('parseExpiresAt', () => {
  it('parses a valid ISO-8601 string to epoch ms', () => {
    expect(parseExpiresAt('2030-01-01T00:00:00Z')).toBe(
      Date.parse('2030-01-01T00:00:00Z'),
    );
  });

  it('returns null for an unparseable string', () => {
    expect(parseExpiresAt('not-a-date')).toBeNull();
  });

  it('returns null for a non-string (number/object/null)', () => {
    expect(parseExpiresAt(0)).toBeNull();
    expect(parseExpiresAt(1234567890)).toBeNull();
    expect(parseExpiresAt(null)).toBeNull();
    expect(parseExpiresAt({})).toBeNull();
    expect(parseExpiresAt(undefined)).toBeNull();
  });
});

describe('isExpired', () => {
  const ms = Date.parse('2026-06-09T12:00:00Z');

  it('is false strictly before the expiry', () => {
    expect(isExpired(ms, new Date('2026-06-09T11:59:59Z'))).toBe(false);
  });

  it('is true exactly at the expiry (now >= expiresAt)', () => {
    expect(isExpired(ms, new Date('2026-06-09T12:00:00Z'))).toBe(true);
  });

  it('is true after the expiry', () => {
    expect(isExpired(ms, new Date('2026-06-09T12:00:01Z'))).toBe(true);
  });
});
