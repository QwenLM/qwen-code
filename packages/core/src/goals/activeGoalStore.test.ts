/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetActiveGoalStoreForTests,
  clearActiveGoal,
  getActiveGoal,
  recordGoalIteration,
  setActiveGoal,
  type ActiveGoal,
} from './activeGoalStore.js';

const makeGoal = (overrides: Partial<ActiveGoal> = {}): ActiveGoal => ({
  condition: 'write a hello world script',
  iterations: 0,
  setAt: 1_000,
  tokensAtStart: 100,
  hookId: 'hook-1',
  ...overrides,
});

describe('activeGoalStore', () => {
  beforeEach(() => __resetActiveGoalStoreForTests());

  it('returns undefined when no goal is set', () => {
    expect(getActiveGoal('sess-1')).toBeUndefined();
  });

  it('isolates goals per session', () => {
    setActiveGoal('sess-1', makeGoal({ condition: 'one' }));
    setActiveGoal('sess-2', makeGoal({ condition: 'two' }));

    expect(getActiveGoal('sess-1')?.condition).toBe('one');
    expect(getActiveGoal('sess-2')?.condition).toBe('two');
  });

  it('clearActiveGoal returns the previous goal and removes it', () => {
    setActiveGoal('sess-1', makeGoal());
    const cleared = clearActiveGoal('sess-1');
    expect(cleared?.condition).toBe('write a hello world script');
    expect(getActiveGoal('sess-1')).toBeUndefined();
  });

  it('clearActiveGoal returns undefined when nothing was set', () => {
    expect(clearActiveGoal('sess-missing')).toBeUndefined();
  });

  it('recordGoalIteration increments and stores lastReason', () => {
    setActiveGoal('sess-1', makeGoal());
    const next = recordGoalIteration('sess-1', 'still missing tests');
    expect(next?.iterations).toBe(1);
    expect(next?.lastReason).toBe('still missing tests');
    expect(getActiveGoal('sess-1')?.iterations).toBe(1);
  });

  it('recordGoalIteration is a no-op when no goal exists', () => {
    expect(recordGoalIteration('sess-missing', 'noop')).toBeUndefined();
  });
});
