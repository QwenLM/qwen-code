/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { AgentViewProvider } from './AgentViewContext.js';

/**
 * Minimal Config stub exposing only the manager-subscription surface the
 * in-process bridges touch on mount. Each bridge subscribes to its
 * manager-change callback; with no active manager they do nothing else, so
 * null getters keep the stub tiny.
 */
function makeConfig(): Config {
  return {
    onTeamManagerChange: vi.fn(),
    getTeamManager: vi.fn(() => null),
    onArenaManagerChange: vi.fn(),
    getArenaManager: vi.fn(() => null),
  } as unknown as Config;
}

describe('AgentViewProvider in-process bridges', () => {
  // Regression guard. The team bridge (useTeamInProcess) was authored but
  // never mounted in the provider, so teammate TEAMMATE_JOINED events never
  // registered agent tabs and the teammate tab bar never appeared. The bug
  // shipped because nothing asserted the provider actually mounts the bridge.
  it('mounts the team in-process bridge so teammate tabs can register', () => {
    const config = makeConfig();

    render(<AgentViewProvider config={config}>{null}</AgentViewProvider>);

    // useTeamInProcess subscribes via onTeamManagerChange in its mount effect.
    // If the provider forgets to call the hook, this is never invoked.
    expect(config.onTeamManagerChange).toHaveBeenCalled();
  });

  it('mounts the arena in-process bridge', () => {
    const config = makeConfig();

    render(<AgentViewProvider config={config}>{null}</AgentViewProvider>);

    expect(config.onArenaManagerChange).toHaveBeenCalled();
  });
});
