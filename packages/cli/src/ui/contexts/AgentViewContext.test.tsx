/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useEffect, useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import {
  ApprovalMode,
  type AgentInteractive,
  type Config,
} from '@qwen-code/qwen-code-core';
import {
  AgentViewProvider,
  useAgentViewActions,
  useAgentViewState,
} from './AgentViewContext.js';

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

  it('clears embedded shell focus when switching agent tabs', async () => {
    const config = makeConfig();
    const interactiveAgent = {
      getCore: () => ({
        runtimeContext: { getApprovalMode: () => ApprovalMode.DEFAULT },
      }),
    } as AgentInteractive;

    function Probe() {
      const state = useAgentViewState();
      const actions = useAgentViewActions();
      const seeded = useRef(false);

      useEffect(() => {
        if (seeded.current) return;
        seeded.current = true;
        actions.registerAgent('mate@team', interactiveAgent, 'model', 'cyan');
        actions.setAgentShellFocused(true);
      }, [actions]);

      useEffect(() => {
        if (state.agentShellFocused) {
          actions.switchToAgent('mate@team');
        }
      }, [actions, state.agentShellFocused]);

      return (
        <Text>
          {state.activeView}:{String(state.agentShellFocused)}
        </Text>
      );
    }

    const { lastFrame } = render(
      <AgentViewProvider config={config}>
        <Probe />
      </AgentViewProvider>,
    );

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(lastFrame()).toContain('mate@team:false');
  });
});
