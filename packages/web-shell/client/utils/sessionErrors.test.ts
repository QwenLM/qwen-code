import { describe, expect, it } from 'vitest';
import {
  isPlannedReconnectError,
  isSessionDisconnectedError,
  shouldSurfaceDaemonConnectionError,
} from './sessionErrors';

describe('isSessionDisconnectedError', () => {
  it('matches direct and wrapped disconnected-session errors', () => {
    expect(
      isSessionDisconnectedError(new Error('Daemon session is not connected')),
    ).toBe(true);
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

describe('planned SSE reconnect errors', () => {
  it('recognizes the autoReconnect backoff countdown', () => {
    expect(isPlannedReconnectError('Reconnecting in 1000ms')).toBe(true);
    expect(isPlannedReconnectError(new Error('Reconnecting in 1000ms'))).toBe(
      true,
    );
    expect(isPlannedReconnectError('heartbeat lost')).toBe(false);
  });

  it('keeps real connection failures visible and hides planned reconnects', () => {
    expect(
      shouldSurfaceDaemonConnectionError({
        status: 'disconnected',
        error: 'Reconnecting in 1000ms',
      }),
    ).toBe(false);
    expect(
      shouldSurfaceDaemonConnectionError({
        status: 'error',
        error: 'Unauthorized',
      }),
    ).toBe(true);
    expect(
      shouldSurfaceDaemonConnectionError({
        status: 'disconnected',
        error: 'heartbeat lost',
      }),
    ).toBe(true);
    expect(
      shouldSurfaceDaemonConnectionError({
        status: 'connecting',
        error: 'Unauthorized',
      }),
    ).toBe(false);
  });
});
