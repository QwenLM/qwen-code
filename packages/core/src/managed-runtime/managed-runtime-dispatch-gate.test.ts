/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  MANAGED_RUNTIME_DISPATCH_SETTLED_LIMIT,
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

  it('keeps only the most recent settled entries', () => {
    const gate = managedRuntimeDispatchGate(sessionKey);
    for (
      let index = 0;
      index < MANAGED_RUNTIME_DISPATCH_SETTLED_LIMIT;
      index++
    ) {
      gate.settle(`ex-${index}`);
    }
    gate.settle('ex-last');

    expect(gate.state('ex-0')).toBeUndefined();
    expect(gate.state('ex-1')).toBe('settled');
    expect(gate.state('ex-last')).toBe('settled');
    expect(() => gate.claim('ex-last')).toThrow(ManagedSessionConflictError);
  });

  it('measures the retained window by settle recency', () => {
    const gate = managedRuntimeDispatchGate(sessionKey);
    gate.claim('slow');
    for (
      let index = 0;
      index < MANAGED_RUNTIME_DISPATCH_SETTLED_LIMIT - 1;
      index++
    ) {
      gate.settle(`ex-${index}`);
    }
    gate.claim('live');
    gate.settle('slow');

    expect(gate.state('slow')).toBe('settled');
    expect(gate.state('ex-0')).toBeUndefined();
    expect(() => gate.claim('slow')).toThrow(ManagedSessionConflictError);
  });

  it('never prunes an in-flight or handed-off entry', () => {
    const gate = managedRuntimeDispatchGate(sessionKey);
    gate.claim('live');
    gate.handoff('handed');

    for (
      let index = 0;
      index < MANAGED_RUNTIME_DISPATCH_SETTLED_LIMIT + 4;
      index++
    ) {
      gate.settle(`ex-${index}`);
    }

    expect(gate.state('live')).toBe('dispatch');
    expect(gate.isHandedOff('handed')).toBe(true);
    expect(gate.state('ex-0')).toBeUndefined();
    expect(gate.state(`ex-${MANAGED_RUNTIME_DISPATCH_SETTLED_LIMIT + 3}`)).toBe(
      'settled',
    );
  });
});
