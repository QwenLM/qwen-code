/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { act, useEffect, useRef } from 'react';
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
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(lastFrame()).toContain('mate@team:false');
  });

  it('clears embedded shell focus when the focused agent unregisters', async () => {
    // unregisterAgent bounces activeView back to 'main' without going
    // through switchToAgent/Next/Previous — the switch resets alone never
    // run, so the view-change effect is the only reset on this path.
    // Without it a stale true would keyboard-lock the tab bar on main
    // (#9290 review). Stages are driven imperatively via act() so each
    // state change lands in its own commit (the production focus seed is
    // a keypress in a commit well after the tab switch).
    const config = makeConfig();
    const interactiveAgent = {
      getCore: () => ({
        runtimeContext: { getApprovalMode: () => ApprovalMode.DEFAULT },
      }),
    } as AgentInteractive;

    const probeActions: {
      registerAgent?: (
        agentId: string,
        agent: AgentInteractive,
        modelId: string,
        color: string,
      ) => void;
      switchToAgent?: (agentId: string) => void;
      setAgentShellFocused?: (focused: boolean) => void;
      unregisterAgent?: (agentId: string) => void;
    } = {};

    function Probe() {
      const state = useAgentViewState();
      const actions = useAgentViewActions();
      probeActions.registerAgent = actions.registerAgent;
      probeActions.switchToAgent = actions.switchToAgent;
      probeActions.setAgentShellFocused = actions.setAgentShellFocused;
      probeActions.unregisterAgent = actions.unregisterAgent;
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

    await act(async () => {
      probeActions.registerAgent?.('mate@team', interactiveAgent, 'm', 'c');
    });
    await act(async () => {
      probeActions.switchToAgent?.('mate@team');
    });
    expect(lastFrame()).toContain('mate@team:false');
    await act(async () => {
      probeActions.setAgentShellFocused?.(true);
    });
    expect(lastFrame()).toContain('mate@team:true');

    await act(async () => {
      probeActions.unregisterAgent?.('mate@team');
    });

    expect(lastFrame()).toContain('main:false');
  });
});

describe('AgentViewProvider per-agent message queues', () => {
  it('stores queues per agent and clears them when emptied or unregistered', async () => {
    const config = makeConfig();
    const interactiveAgent = {
      getCore: () => ({
        runtimeContext: { getApprovalMode: () => ApprovalMode.DEFAULT },
      }),
    } as AgentInteractive;

    const probeActions: {
      registerAgent?: (
        agentId: string,
        agent: AgentInteractive,
        modelId: string,
        color: string,
      ) => void;
      unregisterAgent?: (agentId: string) => void;
      setAgentMessageQueue?: (agentId: string, queue: string[]) => void;
    } = {};

    function Probe() {
      const state = useAgentViewState();
      const actions = useAgentViewActions();
      probeActions.registerAgent = actions.registerAgent;
      probeActions.unregisterAgent = actions.unregisterAgent;
      probeActions.setAgentMessageQueue = actions.setAgentMessageQueue;
      const queueA = state.agentMessageQueues.get('agent-a') ?? [];
      const queueB = state.agentMessageQueues.get('agent-b') ?? [];
      return (
        <Text>
          a:[{queueA.join(',')}] b:[{queueB.join(',')}]
        </Text>
      );
    }

    const { lastFrame } = render(
      <AgentViewProvider config={config}>
        <Probe />
      </AgentViewProvider>,
    );

    await act(async () => {
      probeActions.setAgentMessageQueue?.('agent-a', ['m1', 'm2']);
      probeActions.setAgentMessageQueue?.('agent-b', ['x']);
    });
    expect(lastFrame()).toContain('a:[m1,m2]');
    expect(lastFrame()).toContain('b:[x]');

    // Emptying a queue removes it; other agents keep theirs.
    await act(async () => {
      probeActions.setAgentMessageQueue?.('agent-a', []);
    });
    expect(lastFrame()).toContain('a:[]');
    expect(lastFrame()).toContain('b:[x]');

    // Unregistering an agent drops its pending queue, so a future agent
    // registered under the same id never inherits stale messages.
    await act(async () => {
      probeActions.registerAgent?.('agent-b', interactiveAgent, 'm', 'c');
      probeActions.unregisterAgent?.('agent-b');
    });
    expect(lastFrame()).toContain('b:[]');
  });
});
