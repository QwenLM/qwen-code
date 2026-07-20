import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextPollingDelay, remainingPollingTimeout } from './polling-deadline';

afterEach(() => vi.useRealTimers());

describe('polling deadline', () => {
  it('caps each request and delay to the remaining wall-clock budget', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    expect(remainingPollingTimeout(51_000)).toBe(30_000);
    expect(remainingPollingTimeout(2_250)).toBe(1_250);
    expect(nextPollingDelay(2_250, 1_500)).toBe(1_250);
  });

  it('rejects work after the absolute deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    expect(() => remainingPollingTimeout(2_000)).toThrow(
      'Operation polling timed out',
    );
  });
});
