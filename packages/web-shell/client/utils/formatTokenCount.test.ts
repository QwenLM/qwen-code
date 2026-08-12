import { describe, expect, it } from 'vitest';
import {
  formatContextTokens,
  formatContextUsageDetail,
} from './formatTokenCount';

describe('formatContextTokens', () => {
  it('renders k/M units with one decimal', () => {
    expect(formatContextTokens(512)).toBe('512');
    expect(formatContextTokens(47_851)).toBe('47.9k');
    expect(formatContextTokens(1_000_000)).toBe('1.0M');
    expect(formatContextTokens(1_234_567)).toBe('1.2M');
  });
});

describe('formatContextUsageDetail', () => {
  it('formats used/total with k/M units and one decimal', () => {
    expect(formatContextUsageDetail(53_600, 1_000_000)).toBe(
      '53.6k / 1.0M tokens (5.4%)',
    );
    expect(formatContextUsageDetail(338_108, 1_000_000)).toBe(
      '338.1k / 1.0M tokens (33.8%)',
    );
    expect(formatContextUsageDetail(512, 2000)).toBe(
      '512 / 2.0k tokens (25.6%)',
    );
  });

  it('reports 0.0% for an unknown window instead of dividing by zero', () => {
    expect(formatContextUsageDetail(100, 0)).toBe('100 / 0 tokens (0.0%)');
  });
});
