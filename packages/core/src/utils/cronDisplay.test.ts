import { describe, expect, it } from 'vitest';
import { humanReadableCron } from './cronDisplay.js';
import { parseCron } from './cronParser.js';

describe('humanReadableCron', () => {
  it('formats common step expressions', () => {
    expect(humanReadableCron('*/15 * * * *')).toBe('Every 15 minutes');
    expect(humanReadableCron('0 */2 * * *')).toBe('Every 2 hours');
    expect(humanReadableCron('0 0 */3 * *')).toBe('Every 3 days');
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

  it('keeps the friendly string when the step really is the interval', () => {
    // Divisors of 60 / 24 wrap exactly, so the label is truthful.
    for (const [expr, label] of [
      ['*/1 * * * *', 'Every minute'],
      ['*/20 * * * *', 'Every 20 minutes'],
      ['*/30 * * * *', 'Every 30 minutes'],
      ['0 */1 * * *', 'Every hour'],
      ['0 */6 * * *', 'Every 6 hours'],
      ['0 */12 * * *', 'Every 12 hours'],
      ['0 0 */1 * *', 'Every day'],
      ['0 0 */31 * *', 'Every 31 days'],
    ] as const) {
      expect(humanReadableCron(expr)).toBe(label);
    }
  });
});
