import { describe, it, expect } from 'vitest';
import { buildContextUsage } from './context-usage.js';

describe('buildContextUsage', () => {
  it('returns context usage data when both values are valid', () => {
    const result = buildContextUsage(200_000, 140_000);
    expect(result).toEqual({
      context_usage: 0.7,
      context_limit: 200_000,
      input_tokens: 140_000,
    });
  });

  it('returns undefined when contextWindowSize is undefined', () => {
    expect(buildContextUsage(undefined, 140_000)).toBeUndefined();
  });

  it('returns undefined when contextWindowSize is 0', () => {
    expect(buildContextUsage(0, 140_000)).toBeUndefined();
  });

  it('returns undefined when inputTokens is 0', () => {
    expect(buildContextUsage(200_000, 0)).toBeUndefined();
  });

  it('returns undefined when inputTokens is negative', () => {
    expect(buildContextUsage(200_000, -5)).toBeUndefined();
  });

  it('returns undefined when inputTokens is NaN', () => {
    expect(buildContextUsage(200_000, NaN)).toBeUndefined();
  });

  it('returns undefined when contextWindowSize is negative', () => {
    expect(buildContextUsage(-1, 140_000)).toBeUndefined();
  });

  it('handles ratio > 1 (tokens exceed window)', () => {
    const result = buildContextUsage(100_000, 120_000);
    expect(result?.context_usage).toBe(1.2);
  });
});
