import { describe, expect, it } from 'vitest';
import { isSessionDisconnectedError } from './sessionErrors';

describe('isSessionDisconnectedError', () => {
  it('matches direct and wrapped disconnected-session errors', () => {
    expect(
      isSessionDisconnectedError(new Error('Daemon session is not connected')),
    ).toBe(true);
    expect(isSessionDisconnectedError(new TypeError('fetch failed'))).toBe(
      false,
    );
    expect(
      isSessionDisconnectedError(
        new Error('Get tasks failed: Daemon session is not connected'),
      ),
    ).toBe(true);
    expect(isSessionDisconnectedError(new Error('Get tasks timed out'))).toBe(
      false,
    );
  });
});
