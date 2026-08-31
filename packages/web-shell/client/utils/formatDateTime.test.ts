import { describe, expect, it } from 'vitest';
import { formatDateTime } from './formatDateTime';

const NOW = new Date('2026-03-05T20:00:00').getTime();

describe('formatDateTime', () => {
  it('shows the wall-clock time for timestamps less than a day old', () => {
    expect(formatDateTime('2026-03-05T08:09:10', NOW)).toBe('08:09:10');
    expect(formatDateTime('2026-03-05T20:00:00', NOW)).toBe('20:00:00');
  });

  it('zero-pads single-digit time parts', () => {
    expect(formatDateTime('2026-03-05T01:02:03', NOW)).toBe('01:02:03');
  });

  it('shows the calendar date once a full day has passed', () => {
    expect(formatDateTime('2026-03-04T19:59:59', NOW)).toBe('2026-03-04');
    expect(formatDateTime('2025-12-31T23:59:59', NOW)).toBe('2025-12-31');
  });

  it('shows the date at exactly the 24-hour boundary', () => {
    expect(formatDateTime('2026-03-04T20:00:00', NOW)).toBe('2026-03-04');
  });
});
