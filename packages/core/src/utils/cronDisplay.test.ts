import { describe, expect, it } from 'vitest';
import { humanReadableCron } from './cronDisplay.js';

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
});
