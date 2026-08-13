/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonConnectionState } from '@qwen-code/webui/daemon-react-sdk';
import { isSessionMutationBlocked } from './sessionMutationBlock';

describe('isSessionMutationBlocked', () => {
  const connected: DaemonConnectionState = { status: 'connected' };

  it('blocks pending targets, recovery locks, and active transitions', () => {
    expect(isSessionMutationBlocked(connected, true)).toBe(true);
    expect(
      isSessionMutationBlocked({
        ...connected,
        sessionRecoveryRequired: true,
      }),
    ).toBe(true);
    for (const phase of ['queued', 'preparing'] as const) {
      expect(
        isSessionMutationBlocked({
          ...connected,
          sessionTransition: {
            phase,
            operation: 'load',
            origin: 'recovery',
            targetSessionId: 'session-a',
          },
        }),
      ).toBe(true);
    }
  });

  it('does not block an ordinary failed transition without a recovery lock', () => {
    expect(
      isSessionMutationBlocked({
        ...connected,
        sessionTransition: {
          phase: 'failed',
          operation: 'load',
          origin: 'action',
          targetSessionId: 'session-b',
        },
      }),
    ).toBe(false);
  });
});
