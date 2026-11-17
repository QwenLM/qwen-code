import { describe, expect, it } from 'vitest';
import { resolveSessionLiveStatePollInterval } from './session-live-state-poll-interval';

describe('session live-state polling interval', () => {
  it.each([
    undefined,
    null,
    '',
    '10000',
    0,
    -1,
    999,
    1000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_648,
  ])(
    'defaults to five seconds for missing or invalid capabilities: %s',
    (value) => {
      expect(resolveSessionLiveStatePollInterval(value)).toBe(5_000);
    },
  );

  it.each([1_000, 5_000, 10_000, 30_000, 2_147_483_647])(
    'accepts %i milliseconds from the daemon',
    (value) => {
      expect(resolveSessionLiveStatePollInterval(value)).toBe(value);
    },
  );
});
