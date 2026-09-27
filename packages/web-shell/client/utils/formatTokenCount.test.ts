import { describe, expect, it } from 'vitest';
import { formatContextTokens } from './formatTokenCount';

describe('formatContextTokens', () => {
  it('renders k/M units with one decimal', () => {
    expect(formatContextTokens(512)).toBe('512');
    expect(formatContextTokens(47_851)).toBe('47.9k');
    expect(formatContextTokens(1_000_000)).toBe('1.0M');
    expect(formatContextTokens(1_234_567)).toBe('1.2M');
  });
});
