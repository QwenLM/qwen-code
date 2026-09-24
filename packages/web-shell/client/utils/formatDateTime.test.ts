import { describe, expect, it } from 'vitest';
import { formatDateTime } from './formatDateTime';

const NOW = new Date('2026-03-05T20:00:00').getTime();

describe('formatDateTime', () => {
  it('shows the wall-clock time for timestamps from the same calendar day', () => {
    expect(formatDateTime('2026-03-05T08:09:10', NOW)).toBe('08:09:10');
    expect(formatDateTime('2026-03-05T20:00:00', NOW)).toBe('20:00:00');
  });

  it('zero-pads single-digit time parts', () => {
    expect(formatDateTime('2026-03-05T01:02:03', NOW)).toBe('01:02:03');
  });

  it('shows the calendar date for any earlier calendar day', () => {
    expect(formatDateTime('2026-03-04T19:59:59', NOW)).toBe('2026-03-04');
    expect(formatDateTime('2025-12-31T23:59:59', NOW)).toBe('2025-12-31');
  });

  it('shows the date across midnight even when less than 24h elapsed', () => {
    // Yesterday 23:59 is minutes old at 00:01, but the date avoids the
    // "same wall-clock as a fresh session" ambiguity.
    const justAfterMidnight = new Date('2026-03-05T00:01:00').getTime();
    expect(formatDateTime('2026-03-04T23:59:00', justAfterMidnight)).toBe(
      '2026-03-04',
    );
  });
});
