/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  managedRuntimeDispatchGate,
  resetManagedRuntimeDispatchGatesForTest,
} from './managed-runtime-dispatch-gate.js';
import { ManagedSessionConflictError } from './managed-session-authority.js';

const sessionKey = {
  tenantId: 't1',
  workspaceId: 'w1',
  sessionId: 's1',
};

afterEach(() => {
  resetManagedRuntimeDispatchGatesForTest();
});

describe('managed runtime dispatch gate', () => {
  it('dispatches an executionCallId at most once', () => {
    const gate = managedRuntimeDispatchGate(sessionKey);
    gate.claim('ex-1');
    expect(gate.state('ex-1')).toBe('dispatch');
    expect(() => gate.claim('ex-1')).toThrow(ManagedSessionConflictError);
    gate.unclaim('ex-1');
    gate.claim('ex-1');
    expect(gate.state('ex-1')).toBe('dispatch');
  });

  it('hands off and settles without requiring a live in-memory claim', () => {
    const gate = managedRuntimeDispatchGate(sessionKey);
    gate.claim('ex-1');
    gate.handoff('ex-1');
    expect(gate.isHandedOff('ex-1')).toBe(true);
    expect(() => gate.claim('ex-1')).toThrow(/already dispatched/);

    const cold = managedRuntimeDispatchGate({
      ...sessionKey,
      sessionId: 's2',
    });
    cold.handoff('ex-2');
    expect(cold.isHandedOff('ex-2')).toBe(true);
    cold.settle('ex-2');
    expect(cold.state('ex-2')).toBe('settled');
    cold.settle('ex-2');
    expect(cold.state('ex-2')).toBe('settled');
    expect(() => cold.claim('ex-2')).toThrow(/already dispatched/);
  });

  it('returns the same gate for the same session key', () => {
    const first = managedRuntimeDispatchGate(sessionKey);
    first.claim('ex-1');
    expect(managedRuntimeDispatchGate(sessionKey).state('ex-1')).toBe(
      'dispatch',
    );
    resetManagedRuntimeDispatchGatesForTest();
    expect(
      managedRuntimeDispatchGate(sessionKey).state('ex-1'),
    ).toBeUndefined();
  });
});
