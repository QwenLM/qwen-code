/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetActiveGoalStoreForTests,
  registerGoalHook,
  unregisterGoalHook,
  type Config,
} from '@qwen-code/qwen-code-core';
import { renderWithProviders } from '../../test-utils/render.js';
import { GoalPill } from './GoalPill.js';

function makeConfig(): Config {
  return {
    getSessionId: () => 'sess-pill',
    isTrustedFolder: () => true,
    getDisableAllHooks: () => false,
    getHookSystem: () => ({
      addFunctionHook: vi.fn().mockReturnValue('hook-pill'),
      removeFunctionHook: vi.fn().mockReturnValue(true),
    }),
  } as unknown as Config;
}

describe('GoalPill', () => {
  beforeEach(() => __resetActiveGoalStoreForTests());
  afterEach(() => __resetActiveGoalStoreForTests());

  it('renders nothing when no goal is active', () => {
    const { lastFrame, unmount } = renderWithProviders(<GoalPill />, {
      config: makeConfig(),
    });
    expect(lastFrame()).toBe('');
    unmount();
  });

  it('renders a compact label once a goal is active', () => {
    const config = makeConfig();
    registerGoalHook({
      config,
      sessionId: 'sess-pill',
      condition: 'do something',
      tokensAtStart: 0,
    });

    const { lastFrame, unmount } = renderWithProviders(<GoalPill />, {
      config,
    });
    // Aligned with Claude Code 2.1.140 footer: "◎ /goal active" (no time
    // suffix during the first second, terse — turns/reason live elsewhere).
    expect(lastFrame()).toMatch(/\/goal active/);
    expect(lastFrame()).toMatch(/◎/);
    // Pill should not leak the raw condition into the footer.
    expect(lastFrame()).not.toMatch(/do something/);
    // Turns count should not appear here either (intentionally moved to the
    // /goal status card to stop pill jitter).
    expect(lastFrame()).not.toMatch(/turn/);
    unmount();
    unregisterGoalHook(config, 'sess-pill');
  });
});
