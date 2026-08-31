import { describe, expect, it } from 'vitest';
import { formatDate } from './formatDate';

describe('formatDate', () => {
  it('formats an ISO timestamp as yyyy-MM-dd in local time', () => {
    expect(formatDate('2026-03-05T12:34:56')).toBe('2026-03-05');
    expect(formatDate('2026-12-31T23:59:59')).toBe('2026-12-31');
  });

  it('zero-pads single-digit months and days', () => {
    expect(formatDate('2026-01-02T00:00:00')).toBe('2026-01-02');
  });
});
