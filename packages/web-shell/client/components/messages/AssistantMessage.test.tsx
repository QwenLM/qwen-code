import { describe, expect, it, vi } from 'vitest';

vi.mock('../../App', async () => {
  const { createContext } = await import('react');
  return {
    CompactModeContext: createContext(false),
  };
});

const { formatThinkingDuration, getThinkingSummaryKey } = await import(
  './AssistantMessage'
);

describe('AssistantMessage thinking logic', () => {
  it('uses the running summary while streaming before answer content', () => {
    expect(getThinkingSummaryKey({ isStreaming: true })).toBe(
      'thinking.running',
    );
  });

  it('uses the finished summary after streaming ends', () => {
    expect(getThinkingSummaryKey({ isStreaming: false })).toBe('thinking.done');
    expect(getThinkingSummaryKey({})).toBe('thinking.done');
  });

  it('formats thinking durations', () => {
    expect(formatThinkingDuration(-1000)).toBe('1s');
    expect(formatThinkingDuration(0)).toBe('1s');
    expect(formatThinkingDuration(1499)).toBe('1s');
    expect(formatThinkingDuration(59_400)).toBe('59s');
    expect(formatThinkingDuration(65_000)).toBe('1m 5s');
    expect(formatThinkingDuration(120_000)).toBe('2m');
  });
});
