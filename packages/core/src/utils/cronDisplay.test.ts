import { describe, it, expect } from 'vitest';
import { humanReadableCron } from './cronDisplay.js';

describe('humanReadableCron', () => {
  it('formats common step patterns', () => {
    expect(humanReadableCron('*/5 * * * *')).toBe('Every 5 minutes');
    expect(humanReadableCron('0 */2 * * *')).toBe('Every 2 hours');
    expect(humanReadableCron('0 9 */3 * *')).toBe('Every 3 days');
  });

  it('leaves malformed step expressions unchanged', () => {
    expect(humanReadableCron('*/15garbage * * * *')).toBe(
      '*/15garbage * * * *',
    );
    expect(humanReadableCron('0 */2x * * *')).toBe('0 */2x * * *');
    expect(humanReadableCron('0 9 */3x * *')).toBe('0 9 */3x * *');
  });
});
