/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { GoalPersistenceUnavailableError } from '@qwen-code/qwen-code-core';
import {
  shouldDisplayGoalStateCause,
  waitForGoalRuntime,
} from './goal-runtime.js';

describe('waitForGoalRuntime', () => {
  it('allows Goal-less sessions when persistence is disabled', async () => {
    const getGoalRuntimeReady = vi
      .fn()
      .mockRejectedValue(new GoalPersistenceUnavailableError());

    await expect(
      waitForGoalRuntime({ getGoalRuntimeReady }),
    ).resolves.toBeUndefined();
    expect(getGoalRuntimeReady).toHaveBeenCalledTimes(1);
  });

  it('does not hide malformed or unsupported persisted Goal state', async () => {
    const failure = new Error('unsupported Goal lifecycle record');
    const getGoalRuntimeReady = vi.fn().mockRejectedValue(failure);

    await expect(waitForGoalRuntime({ getGoalRuntimeReady })).rejects.toBe(
      failure,
    );
  });

  it('keeps turn and verifier bookkeeping out of scrollback', () => {
    expect(shouldDisplayGoalStateCause('turn_finished')).toBe(false);
    expect(shouldDisplayGoalStateCause('verifier_accept')).toBe(false);
    expect(shouldDisplayGoalStateCause('verifier_reject')).toBe(false);
    expect(shouldDisplayGoalStateCause('create')).toBe(true);
    expect(shouldDisplayGoalStateCause('complete')).toBe(true);
    expect(shouldDisplayGoalStateCause('clear')).toBe(true);
  });
});
