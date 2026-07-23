import { describe, expect, it } from 'vitest';
import { humanReadableCron } from './cronDisplay.js';
import { parseCron } from './cronParser.js';

describe('humanReadableCron', () => {
  it('formats common step expressions', () => {
    expect(humanReadableCron('*/15 * * * *')).toBe('Every 15 minutes');
    expect(humanReadableCron('0 */2 * * *')).toBe('Every 2 hours');
    expect(humanReadableCron('0 0 */1 * *')).toBe('Every day');
  });

  it('falls back for malformed step expressions', () => {
    expect(humanReadableCron('*/15x * * * *')).toBe('*/15x * * * *');
    expect(humanReadableCron('*/0 * * * *')).toBe('*/0 * * * *');
    expect(humanReadableCron('0 */2x * * *')).toBe('0 */2x * * *');
    expect(humanReadableCron('0 0 */3x * *')).toBe('0 0 */3x * *');
  });

  it('falls back for steps larger than the field range', () => {
    // parseCron accepts these, so they reach the display layer. Every step
    // past the field maximum is dropped, collapsing the schedule to a single
    // value — the friendly string would name an interval that never happens.
    expect([...parseCron('*/90 * * * *').minute]).toEqual([0]); // hourly
    expect(humanReadableCron('*/90 * * * *')).toBe('*/90 * * * *');

    expect([...parseCron('0 */30 * * *').hour]).toEqual([0]); // once a day
    expect(humanReadableCron('0 */30 * * *')).toBe('0 */30 * * *');

    expect([...parseCron('0 0 */40 * *').dayOfMonth]).toEqual([1]); // monthly
    expect(humanReadableCron('0 0 */40 * *')).toBe('0 0 */40 * *');
  });

  it('falls back for in-range steps that do not divide the field evenly', () => {
    // `*/25` fits in 0-59 but wraps unevenly: :00, :25, :50, then :00 again is
    // a 10-minute gap, so "Every 25 minutes" would be wrong too.
    expect([...parseCron('*/25 * * * *').minute]).toEqual([0, 25, 50]);
    expect(humanReadableCron('*/25 * * * *')).toBe('*/25 * * * *');

    // Same for hours: :00, 07, 14, 21, then 00 is a 3-hour gap.
    expect([...parseCron('0 */7 * * *').hour]).toEqual([0, 7, 14, 21]);
    expect(humanReadableCron('0 */7 * * *')).toBe('0 */7 * * *');
  });

  it('falls back for every day-of-month step but 1', () => {
    // The day-of-month field restarts at day 1 of a month whose length varies,
    // so no step above 1 keeps its own interval across the rollover. Walking a
    // non-leap year gives the shortest gap the schedule actually produces; if
    // that is not N, "Every N days" is a false label.
    const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const shortestGap = (days: readonly number[]): number => {
      const fires: number[] = [];
      let elapsed = 0;
      for (const length of MONTH_LENGTHS) {
        for (const day of days) if (day <= length) fires.push(elapsed + day);
        elapsed += length;
      }
      return Math.min(...fires.slice(1).map((f, i) => f - fires[i]!));
    };

    for (const [expr, step, days, gap] of [
      ['0 0 */2 * *', 2, [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31], 1], // prettier-ignore
      ['0 0 */3 * *', 3, [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31], 1],
      ['0 0 */15 * *', 15, [1, 16, 31], 1],
      // Not a large-step problem: 16 has a *longer* shortest gap than 15, so
      // no threshold separates the truthful labels from the false ones.
      ['0 0 */16 * *', 16, [1, 17], 12],
      ['0 0 */31 * *', 31, [1], 28], // day 1 only — monthly, not every 31 days
    ] as const) {
      expect([...parseCron(expr).dayOfMonth]).toEqual(days);
      expect(shortestGap(days)).toBe(gap);
      expect(gap).not.toBe(step);
      expect(humanReadableCron(expr)).toBe(expr);
    }
  });

  it('keeps the friendly string when the step really is the interval', () => {
    // Divisors of 60 / 24 wrap exactly, so the label is truthful. On days only
    // `*/1` qualifies, since 1 is the sole step that divides every month.
    for (const [expr, label] of [
      ['*/1 * * * *', 'Every minute'],
      ['*/20 * * * *', 'Every 20 minutes'],
      ['*/30 * * * *', 'Every 30 minutes'],
      ['0 */1 * * *', 'Every hour'],
      ['0 */6 * * *', 'Every 6 hours'],
      ['0 */12 * * *', 'Every 12 hours'],
      ['0 0 */1 * *', 'Every day'],
    ] as const) {
      expect(humanReadableCron(expr)).toBe(label);
    }
  });
});
