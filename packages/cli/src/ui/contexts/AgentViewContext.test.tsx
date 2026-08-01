/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  AgentViewProvider,
  useAgentViewState,
  useAgentViewActions,
} from './AgentViewContext.js';
import type { AgentViewState, AgentViewActions } from './AgentViewContext.js';

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

  it('does not re-subscribe bridge callbacks on re-render with same config', () => {
    const config = makeConfig();

    const { rerender } = render(
      <AgentViewProvider config={config}>{null}</AgentViewProvider>,
    );

    // Re-rendering with the same config should not cause additional subscriptions
    rerender(<AgentViewProvider config={config}>{null}</AgentViewProvider>);

    // Mount hook fires once; the early-return prevents redundant state updates
    expect(config.onTeamManagerChange).toHaveBeenCalledTimes(1);
    expect(config.onArenaManagerChange).toHaveBeenCalledTimes(1);
  });
});

describe('agentViewActiveShellPtySet tracking', () => {
  const latest: {
    state: AgentViewState | null;
    actions: AgentViewActions | null;
  } = { state: null, actions: null };

  function Consumer() {
    latest.state = useAgentViewState();
    latest.actions = useAgentViewActions();
    return null;
  }

  it('setAgentViewHasActiveShellPty adds/removes and unregisterAgent cleans up', () => {
    const config = makeConfig();
    render(
      <AgentViewProvider config={config}>
        <Consumer />
      </AgentViewProvider>,
    );

    expect(latest.state!.agentViewHasActiveShellPty).toBe(false);

    // Add a PTY for agent-1
    act(() => latest.actions!.setAgentViewHasActiveShellPty('agent-1', true));
    expect(latest.state!.agentViewHasActiveShellPty).toBe(true);

    // Remove it explicitly
    act(() => latest.actions!.setAgentViewHasActiveShellPty('agent-1', false));
    expect(latest.state!.agentViewHasActiveShellPty).toBe(false);

    // Add again, then clean up via unregisterAgent
    act(() => latest.actions!.setAgentViewHasActiveShellPty('agent-1', true));
    expect(latest.state!.agentViewHasActiveShellPty).toBe(true);

    act(() => latest.actions!.unregisterAgent('agent-1'));
    expect(latest.state!.agentViewHasActiveShellPty).toBe(false);
  });

  it('unregisterAll clears all PTY entries', () => {
    const config = makeConfig();
    render(
      <AgentViewProvider config={config}>
        <Consumer />
      </AgentViewProvider>,
    );

    act(() => {
      latest.actions!.setAgentViewHasActiveShellPty('a1', true);
      latest.actions!.setAgentViewHasActiveShellPty('a2', true);
    });
    expect(latest.state!.agentViewHasActiveShellPty).toBe(true);

    act(() => latest.actions!.unregisterAll());
    expect(latest.state!.agentViewHasActiveShellPty).toBe(false);
  });

  // Regression for the model-toggle blocker: the toggle guard must key off
  // the ACTIVE agent's PTY, not the global "any agent has a PTY" boolean.
  // A background agent's PTY must not block the toggle while the user views
  // a different agent tab (or main) that has none.
  it('activeAgentHasShellPty tracks only the active view, not every agent', () => {
    const config = makeConfig();
    render(
      <AgentViewProvider config={config}>
        <Consumer />
      </AgentViewProvider>,
    );

    // Register two agents so switchToAgent can move the active view.
    const interactiveAgent = {
      getCore: () => ({ runtimeContext: { getApprovalMode: () => 'default' } }),
    } as never;
    act(() => {
      latest.actions!.registerAgent('agent-1', interactiveAgent, 'm', 'red');
      latest.actions!.registerAgent('agent-2', interactiveAgent, 'm', 'blue');
    });

    // Both agents have a PTY → the global flag is true...
    act(() => {
      latest.actions!.setAgentViewHasActiveShellPty('agent-1', true);
      latest.actions!.setAgentViewHasActiveShellPty('agent-2', true);
    });
    expect(latest.state!.agentViewHasActiveShellPty).toBe(true);

    // ...but on the main view the active agent has none.
    expect(latest.state!.activeView).toBe('main');
    expect(latest.state!.activeAgentHasShellPty).toBe(false);

    // Viewing agent-1 (which has a PTY) → per-agent flag flips on.
    act(() => latest.actions!.switchToAgent('agent-1'));
    expect(latest.state!.activeAgentHasShellPty).toBe(true);

    // Drop agent-1's PTY while agent-2 keeps one: the global flag stays true
    // but the per-agent flag (active view = agent-1) turns off.
    act(() => latest.actions!.setAgentViewHasActiveShellPty('agent-1', false));
    expect(latest.state!.agentViewHasActiveShellPty).toBe(true);
    expect(latest.state!.activeAgentHasShellPty).toBe(false);

    // Switching to agent-2 (still has a PTY) turns the per-agent flag back on.
    act(() => latest.actions!.switchToAgent('agent-2'));
    expect(latest.state!.activeAgentHasShellPty).toBe(true);
  });
});
