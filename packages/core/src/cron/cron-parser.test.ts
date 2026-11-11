/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseCronExpression,
  computeNextCronRun,
  cronToHuman,
} from './cron-parser.js';

describe('cron-parser', () => {
  // -------------------------------------------------------------------------
  // parseCronExpression
  // -------------------------------------------------------------------------
  describe('parseCronExpression', () => {
    it('parses "*/5 * * * *" (every 5 minutes)', () => {
      const result = parseCronExpression('*/5 * * * *');
      expect(result).not.toBeNull();
      expect(result!.minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
      expect(result!.hour).toHaveLength(24);
      expect(result!.dayOfMonth).toHaveLength(31);
      expect(result!.month).toHaveLength(12);
      expect(result!.dayOfWeek).toHaveLength(7);
    });

    it('parses "0 9 * * 1" (9am every Monday)', () => {
      const result = parseCronExpression('0 9 * * 1');
      expect(result).not.toBeNull();
      expect(result!.minute).toEqual([0]);
      expect(result!.hour).toEqual([9]);
      expect(result!.dayOfWeek).toEqual([1]);
    });

    it('parses "0 0 1 * *" (midnight on first of month)', () => {
      const result = parseCronExpression('0 0 1 * *');
      expect(result).not.toBeNull();
      expect(result!.minute).toEqual([0]);
      expect(result!.hour).toEqual([0]);
      expect(result!.dayOfMonth).toEqual([1]);
    });

    it('parses ranges: "10-20 * * * *"', () => {
      const result = parseCronExpression('10-20 * * * *');
      expect(result).not.toBeNull();
      expect(result!.minute).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    });

    it('parses lists: "1,15,30 * * * *"', () => {
      const result = parseCronExpression('1,15,30 * * * *');
      expect(result).not.toBeNull();
      expect(result!.minute).toEqual([1, 15, 30]);
    });

    it('parses range with step: "0-23/2 * * * *"', () => {
      const result = parseCronExpression('0-23/2 * * * *');
      expect(result).not.toBeNull();
      expect(result!.minute).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
    });

    it('accepts dayOfWeek 7 as Sunday alias', () => {
      const result = parseCronExpression('0 0 * * 7');
      expect(result).not.toBeNull();
      expect(result!.dayOfWeek).toEqual([0]); // 7 → 0
    });

    // Invalid expressions
    it('returns null for "invalid"', () => {
      expect(parseCronExpression('invalid')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseCronExpression('')).toBeNull();
    });

    it('returns null for 4-field expression', () => {
      expect(parseCronExpression('* * * *')).toBeNull();
    });

    it('returns null for 6-field expression', () => {
      expect(parseCronExpression('* * * * * *')).toBeNull();
    });

    it('returns null for out-of-range minute (99)', () => {
      expect(parseCronExpression('99 * * * *')).toBeNull();
    });

    it('returns null for out-of-range hour (25)', () => {
      expect(parseCronExpression('0 25 * * *')).toBeNull();
    });

    it('returns null for out-of-range dayOfMonth (32)', () => {
      expect(parseCronExpression('0 0 32 * *')).toBeNull();
    });

    it('returns null for out-of-range month (13)', () => {
      expect(parseCronExpression('0 0 1 13 *')).toBeNull();
    });

    it('returns null for out-of-range dayOfWeek (8)', () => {
      expect(parseCronExpression('0 0 * * 8')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // computeNextCronRun
  // -------------------------------------------------------------------------
  describe('computeNextCronRun', () => {
    it('computes next run for every-5-minutes cron', () => {
      const fields = parseCronExpression('*/5 * * * *')!;
      // From 10:02 → next should be 10:05
      const from = new Date(2025, 0, 15, 10, 2, 0);
      const next = computeNextCronRun(fields, from);
      expect(next).not.toBeNull();
      expect(next!.getMinutes()).toBe(5);
      expect(next!.getHours()).toBe(10);
    });

    it('computes next run for specific time daily', () => {
      const fields = parseCronExpression('30 14 * * *')!;
      // From Jan 15 2:29pm → same day 2:30pm
      const from = new Date(2025, 0, 15, 14, 29, 0);
      const next = computeNextCronRun(fields, from);
      expect(next).not.toBeNull();
      expect(next!.getHours()).toBe(14);
      expect(next!.getMinutes()).toBe(30);
      expect(next!.getDate()).toBe(15);
    });

    it('crosses to next day when time has passed', () => {
      const fields = parseCronExpression('0 9 * * *')!;
      // From Jan 15 at 10am → next is Jan 16 at 9am
      const from = new Date(2025, 0, 15, 10, 0, 0);
      const next = computeNextCronRun(fields, from);
      expect(next).not.toBeNull();
      expect(next!.getDate()).toBe(16);
      expect(next!.getHours()).toBe(9);
      expect(next!.getMinutes()).toBe(0);
    });

    it('crosses to next month', () => {
      const fields = parseCronExpression('0 0 1 * *')!;
      // From Jan 15 → Feb 1
      const from = new Date(2025, 0, 15, 0, 0, 0);
      const next = computeNextCronRun(fields, from);
      expect(next).not.toBeNull();
      expect(next!.getMonth()).toBe(1); // February
      expect(next!.getDate()).toBe(1);
    });

    it('crosses to next year', () => {
      const fields = parseCronExpression('0 0 1 1 *')!;
      // From Dec 15 2025 → Jan 1 2026
      const from = new Date(2025, 11, 15, 0, 0, 0);
      const next = computeNextCronRun(fields, from);
      expect(next).not.toBeNull();
      expect(next!.getFullYear()).toBe(2026);
      expect(next!.getMonth()).toBe(0);
      expect(next!.getDate()).toBe(1);
    });

    it('returns a time strictly after from', () => {
      const fields = parseCronExpression('*/1 * * * *')!;
      const from = new Date(2025, 0, 15, 10, 30, 0);
      const next = computeNextCronRun(fields, from);
      expect(next).not.toBeNull();
      expect(next!.getTime()).toBeGreaterThan(from.getTime());
    });

    it('handles day-of-week constraint (every Monday)', () => {
      const fields = parseCronExpression('0 9 * * 1')!;
      // Wednesday Jan 15, 2025 → next Monday Jan 20
      const from = new Date(2025, 0, 15, 10, 0, 0);
      const next = computeNextCronRun(fields, from);
      expect(next).not.toBeNull();
      expect(next!.getDay()).toBe(1); // Monday
    });

    it('handles OR semantics for dom + dow when both constrained', () => {
      // "0 0 15 * 1" → fires if day=15 OR day=Monday
      const fields = parseCronExpression('0 0 15 * 1')!;
      // From Jan 1 2025 (Wednesday) → should fire on Jan 6 (Monday) or Jan 15
      const from = new Date(2025, 0, 1, 0, 0, 0);
      const next = computeNextCronRun(fields, from);
      expect(next).not.toBeNull();
      // Should be whichever comes first
      const isMonday = next!.getDay() === 1;
      const is15th = next!.getDate() === 15;
      expect(isMonday || is15th).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // cronToHuman
  // -------------------------------------------------------------------------
  describe('cronToHuman', () => {
    it('converts "*/5 * * * *" to "Every 5 minutes"', () => {
      expect(cronToHuman('*/5 * * * *')).toBe('Every 5 minutes');
    });

    it('converts "*/1 * * * *" to "Every minute"', () => {
      expect(cronToHuman('*/1 * * * *')).toBe('Every minute');
    });

    it('converts "0 * * * *" to "Every hour"', () => {
      expect(cronToHuman('0 * * * *')).toBe('Every hour');
    });

    it('converts "30 * * * *" to "Every hour at :30"', () => {
      expect(cronToHuman('30 * * * *')).toBe('Every hour at :30');
    });

    it('converts "0 */2 * * *" to "Every 2 hours"', () => {
      expect(cronToHuman('0 */2 * * *')).toBe('Every 2 hours');
    });

    it('converts daily cron to human readable with time', () => {
      const result = cronToHuman('0 9 * * *');
      expect(result).toMatch(/Every day at .*9:00.*/);
    });

    it('converts weekday cron "0 9 * * 1" to include Monday', () => {
      const result = cronToHuman('0 9 * * 1');
      expect(result).toMatch(/Monday/);
    });

    it('converts "0 9 * * 1-5" to Weekdays', () => {
      const result = cronToHuman('0 9 * * 1-5');
      expect(result).toMatch(/Weekdays/);
    });

    it('describes expressions the hand-written cases do not claim', () => {
      // These used to fall through to the raw expression, which left the
      // /crontab table showing a bare cron string with no reading.
      expect(cronToHuman('0 9 1,15 * *')).toBe('At 9:00 AM on the 1st and 15th');
      expect(cronToHuman('0 10 15 8 *')).toBe(
        'At 10:00 AM on the 15th in August',
      );
    });

    it('never returns the expression unchanged for a valid 5-field cron', () => {
      // The table prints the reading underneath the expression and suppresses
      // it when the two match, so any expression that round-trips would render
      // without a description.
      const expressions = [
        '* * * * *',
        '*/1 * * * *',
        '*/15 * * * *',
        '0 * * * *',
        '30 * * * *',
        '0 */2 * * *',
        '0 9 * * *',
        '0 9 * * 1',
        '0 9 * * 1-5',
        '0 9 * * 0',
        '0 9 * * 7',
        '0 9 1 * *',
        '0 9 15 6 *',
        '0 10 15 8 *',
        '0 9 1,15 * *',
        '0 9,17 * * *',
        '0,30 * * * *',
        '0 0 */2 * *',
        '0 9 * 1,7 *',
        '0 9 * * 2-4',
        '*/5 9-17 * * 1-5',
        '15 14 1 * *',
        '0 22 * * 1-5',
        '23 0-20/2 * * *',
        '5 0 * 8 *',
        '0 0 1 1 *',
        '* 0 * * *',
        '0 * 1 * *',
      ];
      for (const expr of expressions) {
        expect(cronToHuman(expr), `no reading for ${expr}`).not.toBe(expr);
      }
    });

    it('returns raw string for invalid expressions', () => {
      expect(cronToHuman('invalid')).toBe('invalid');
    });
  });

  // -------------------------------------------------------------------------
  // Boundary dates
  // -------------------------------------------------------------------------
  describe('boundary dates', () => {
    it('skips months without day 31: Jan 31 → next "0 0 31 * *" is Mar 31', () => {
      // 2025 is not a leap year (Feb has 28 days). Cron `0 0 31 * *` walks past
      // Feb (no 31) and Mar (has 31) — next fire is Mar 31 2025 00:00.
      const fields = parseCronExpression('0 0 31 * *')!;
      // 1 second after the would-be Jan 31 00:00 fire so we don't pick that.
      const from = new Date(2025, 0, 31, 0, 0, 1);
      const next = computeNextCronRun(fields, from);
      expect(next).not.toBeNull();
      expect(next!.getFullYear()).toBe(2025);
      expect(next!.getMonth()).toBe(2); // March (0-indexed)
      expect(next!.getDate()).toBe(31);
      expect(next!.getHours()).toBe(0);
      expect(next!.getMinutes()).toBe(0);
    });

    it('crosses year boundary: Dec 31 23:59 → "*/5 * * * *" → Jan 1 00:00 next year', () => {
      const fields = parseCronExpression('*/5 * * * *')!;
      const from = new Date(2025, 11, 31, 23, 59, 0); // Dec 31, 2025 23:59
      const next = computeNextCronRun(fields, from);
      expect(next).not.toBeNull();
      expect(next!.getFullYear()).toBe(2026);
      expect(next!.getMonth()).toBe(0); // January
      expect(next!.getDate()).toBe(1);
      expect(next!.getHours()).toBe(0);
      expect(next!.getMinutes()).toBe(0);
    });

    it('hits Feb 29 in a leap year: "0 0 29 2 *" from Jan 1 2024 → Feb 29 2024', () => {
      const fields = parseCronExpression('0 0 29 2 *')!;
      const from = new Date(2024, 0, 1, 0, 0, 0); // Jan 1, 2024 (leap year)
      const next = computeNextCronRun(fields, from);
      expect(next).not.toBeNull();
      expect(next!.getFullYear()).toBe(2024);
      expect(next!.getMonth()).toBe(1); // February
      expect(next!.getDate()).toBe(29);
    });

    it('skips non-leap years: "0 0 29 2 *" from Jan 1 2025 → Feb 29 2028', () => {
      // 2025, 2026, 2027 are non-leap; 2028 is the next leap year.
      const fields = parseCronExpression('0 0 29 2 *')!;
      const from = new Date(2025, 0, 1, 0, 0, 0);
      const next = computeNextCronRun(fields, from);
      expect(next).not.toBeNull();
      expect(next!.getFullYear()).toBe(2028);
      expect(next!.getMonth()).toBe(1);
      expect(next!.getDate()).toBe(29);
    });
  });

  // -------------------------------------------------------------------------
  // Invalid input edge cases
  // -------------------------------------------------------------------------
  describe('invalid input edge cases', () => {
    it('returns null for negative field value "-1"', () => {
      // Source's expandField regexes (\\d+, \\d+-\\d+, etc.) reject leading "-".
      expect(parseCronExpression('-1 * * * *')).toBeNull();
    });

    it('returns null for floating-point field value "1.5"', () => {
      // Decimal point fails all of expandField's regexes.
      expect(parseCronExpression('1.5 * * * *')).toBeNull();
    });

    it('returns null for shorthand alias "@daily" (aliases not supported)', () => {
      // parseCronExpression splits on whitespace; @daily yields a single field,
      // length !== 5 → null. Source comment: "No L, W, ?, or name aliases."
      expect(parseCronExpression('@daily')).toBeNull();
      expect(parseCronExpression('@hourly')).toBeNull();
      expect(parseCronExpression('@reboot')).toBeNull();
    });

    it('accepts step larger than range: "*/100 * * * *" → minute [0]', () => {
      // For minute (range 0-59), step 100 → the loop adds only i=0, so minute=[0].
      // Per source: step is rejected only when < 1, so /100 is valid syntax.
      const result = parseCronExpression('*/100 * * * *');
      expect(result).not.toBeNull();
      expect(result!.minute).toEqual([0]);
      expect(result!.hour).toHaveLength(24); // wildcard
    });
  });
});
