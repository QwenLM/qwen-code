/**
 * Retry-exhaustion logic for the voice dictation hook. The hook itself is
 * timer-driven React state, so per repo convention (and the no-wait()-UI-test
 * rule) we test the extracted pure decision/message helpers by driving the
 * retry counter directly — no fake timers, no rendering.
 */
import { describe, it, expect } from 'bun:test';
import {
  isVoiceInitExhausted,
  formatVoiceInitFailureWarning,
} from '../useVoiceDictation';

describe('isVoiceInitExhausted', () => {
  it('is not exhausted while retries remain', () => {
    expect(isVoiceInitExhausted(null, 0)).toBe(false);
    expect(isVoiceInitExhausted(null, 9)).toBe(false);
  });

  it('is exhausted once the retry budget (10) is reached', () => {
    expect(isVoiceInitExhausted(null, 10)).toBe(true);
    expect(isVoiceInitExhausted(null, 11)).toBe(true);
  });

  it('is never exhausted once the URL has resolved', () => {
    expect(isVoiceInitExhausted('ws://127.0.0.1:1234?token=x', 10)).toBe(false);
    expect(isVoiceInitExhausted('ws://127.0.0.1:1234?token=x', 99)).toBe(false);
  });
});

describe('formatVoiceInitFailureWarning', () => {
  it('states the retry count, elapsed budget, and that dictation is unavailable', () => {
    const msg = formatVoiceInitFailureWarning();
    expect(msg).toContain('[voice]');
    expect(msg).toContain('10 retries');
    expect(msg).toContain('~15s');
    expect(msg).toContain('will not be available');
  });
});
