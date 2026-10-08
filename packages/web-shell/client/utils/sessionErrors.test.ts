import { describe, expect, it } from 'vitest';
import {
  isSessionDisconnectedError,
  isTransientSessionReadError,
} from './sessionErrors';

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

describe('isTransientSessionReadError', () => {
  it('covers the disconnected, transport-closed and fetch-failed sets', () => {
    expect(
      isTransientSessionReadError(new Error('Daemon session is not connected')),
    ).toBe(true);
    const closed = new Error('transport closed');
    closed.name = 'DaemonTransportClosedError';
    expect(isTransientSessionReadError(closed)).toBe(true);
    expect(isTransientSessionReadError(new TypeError('fetch failed'))).toBe(
      true,
    );
    expect(isTransientSessionReadError(new Error('Failed to fetch'))).toBe(
      true,
    );
  });

  it('leaves real failures reportable', () => {
    expect(
      isTransientSessionReadError(new Error('private transport detail')),
    ).toBe(false);
    expect(isTransientSessionReadError(new Error('Get tasks timed out'))).toBe(
      false,
    );
  });
});
