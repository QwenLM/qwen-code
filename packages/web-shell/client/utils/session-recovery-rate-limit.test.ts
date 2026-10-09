import { describe, expect, it } from 'vitest';
import {
  isRecoveryRateLimit,
  recoveryRetryAt,
} from './session-recovery-rate-limit';

describe('recovery rate limits', () => {
  it.each([
    ['403 用户 Token 限额已触发（每5小时）', undefined],
    ['Rate limit exceeded. Try again later.', undefined],
    ['Too many requests', undefined],
    ['Model unavailable', '429'],
    [
      'Quota exhausted: token-plan quota has been exhausted. The quota will reset at 10-10 10:00:00 UTC.',
      undefined,
    ],
  ])('recognizes temporary quota failures: %s', (text, code) => {
    expect(isRecoveryRateLimit(text, code)).toBe(true);
  });

  it.each([
    '403 Forbidden',
    '401 Invalid API key',
    '403 Permission denied',
    'Insufficient_quota: check your billing (429)',
    '429 Free allocated quota exceeded',
    'Network connection terminated',
  ])('does not wait for %s', (text) => {
    expect(isRecoveryRateLimit(text)).toBe(false);
  });

  const now = Date.parse('2026-10-10T00:00:00Z');
  it.each([
    ['429 Retry after 2 seconds', now + 2000],
    ['Rate limit: retry in 3 minutes', now + 180_000],
    ['Quota will reset at 2026-10-10T00:05:00Z', now + 300_000],
    ['Quota will reset at 10-10 00:05:00 UTC.', now + 300_000],
    ['403 用户 Token 限额已触发（每5小时）', now + 60_000],
    ['Quota will reset at 2026-10-09T00:00:00Z', now + 60_000],
    ['Quota will reset at 2026-99-99T00:00:00Z', now + 60_000],
  ])('uses only explicit future retry/reset timing: %s', (text, expected) => {
    expect(recoveryRetryAt(text, now, 60_000)).toBe(expected);
  });

  it('handles a quota reset across the UTC year boundary', () => {
    expect(
      recoveryRetryAt(
        'Quota reset at 01-01 00:01:00 UTC',
        Date.parse('2026-12-31T23:59:00Z'),
        60_000,
      ),
    ).toBe(Date.parse('2027-01-01T00:01:00Z'));
  });
});
