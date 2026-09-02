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
  AgentStatus,
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

/**
 * Minimal AgentInteractive stub. The provider mounts a per-agent queue
 * flusher that derives streaming state via useAgentStreamingState, so the
 * stub must cover that surface even in storage tests. Status stays
 * undefined so the flusher never delivers here (delivery is covered by
 * AgentComposer.queuedMessages.test.tsx).
 */
function makeInteractiveAgent(): AgentInteractive {
  return {
    getCore: () => ({
      runtimeContext: {
        getApprovalMode: () => ApprovalMode.DEFAULT,
        setApprovalMode: vi.fn(),
      },
    }),
    getStatus: () => undefined,
    getPendingApprovals: () => new Map(),
    getLastPromptTokenCount: () => 0,
    getEventEmitter: () => undefined,
    enqueueMessage: vi.fn(),
  } as unknown as AgentInteractive;
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
    const interactiveAgent = makeInteractiveAgent();

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
    const interactiveAgent = makeInteractiveAgent();

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
    const interactiveAgent = makeInteractiveAgent();

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

  it('appends queued messages without losing same-batch updates', async () => {
    const config = makeConfig();
    const interactiveAgent = makeInteractiveAgent();

    const probeActions: {
      registerAgent?: (
        agentId: string,
        agent: AgentInteractive,
        modelId: string,
        color: string,
      ) => void;
      appendToAgentMessageQueue?: (agentId: string, message: string) => void;
    } = {};

    function Probe() {
      const state = useAgentViewState();
      const actions = useAgentViewActions();
      probeActions.registerAgent = actions.registerAgent;
      probeActions.appendToAgentMessageQueue =
        actions.appendToAgentMessageQueue;
      const queue = state.agentMessageQueues.get('agent-a') ?? [];
      return <Text>a:[{queue.join(',')}]</Text>;
    }

    const { lastFrame } = render(
      <AgentViewProvider config={config}>
        <Probe />
      </AgentViewProvider>,
    );

    await act(async () => {
      probeActions.registerAgent?.('agent-a', interactiveAgent, 'm', 'c');
    });
    // Two appends dispatched before the provider re-renders must both land:
    // a render-time snapshot + replace write would keep only the second.
    await act(async () => {
      probeActions.appendToAgentMessageQueue?.('agent-a', 'first');
      probeActions.appendToAgentMessageQueue?.('agent-a', 'second');
    });

    expect(lastFrame()).toContain('a:[first,second]');
  });

  it('drops a same-batch append for an agent that is unregistering', async () => {
    // If an Enter-submit and unregisterAgent land in one React batch (team
    // manager detaching while the user submits), the append must not
    // resurrect the queue entry the delete just removed.
    const config = makeConfig();
    const interactiveAgent = makeInteractiveAgent();

    const probeActions: {
      registerAgent?: (
        agentId: string,
        agent: AgentInteractive,
        modelId: string,
        color: string,
      ) => void;
      unregisterAgent?: (agentId: string) => void;
      appendToAgentMessageQueue?: (agentId: string, message: string) => void;
    } = {};

    function Probe() {
      const state = useAgentViewState();
      const actions = useAgentViewActions();
      probeActions.registerAgent = actions.registerAgent;
      probeActions.unregisterAgent = actions.unregisterAgent;
      probeActions.appendToAgentMessageQueue =
        actions.appendToAgentMessageQueue;
      const queue = state.agentMessageQueues.get('agent-a') ?? [];
      return <Text>a:[{queue.join(',')}]</Text>;
    }

    const { lastFrame } = render(
      <AgentViewProvider config={config}>
        <Probe />
      </AgentViewProvider>,
    );

    await act(async () => {
      probeActions.registerAgent?.('agent-a', interactiveAgent, 'm', 'c');
    });
    await act(async () => {
      probeActions.unregisterAgent?.('agent-a');
      probeActions.appendToAgentMessageQueue?.('agent-a', 'orphan');
    });

    expect(lastFrame()).toContain('a:[]');
  });

  it('clears all queued messages when all agents unregister', async () => {
    const config = makeConfig();
    const interactiveAgent = makeInteractiveAgent();

    const probeActions: {
      registerAgent?: (
        agentId: string,
        agent: AgentInteractive,
        modelId: string,
        color: string,
      ) => void;
      appendToAgentMessageQueue?: (agentId: string, message: string) => void;
      unregisterAll?: () => void;
    } = {};

    function Probe() {
      const state = useAgentViewState();
      const actions = useAgentViewActions();
      probeActions.registerAgent = actions.registerAgent;
      probeActions.appendToAgentMessageQueue =
        actions.appendToAgentMessageQueue;
      probeActions.unregisterAll = actions.unregisterAll;
      const queue = state.agentMessageQueues.get('agent-a') ?? [];
      return <Text>a:[{queue.join(',')}]</Text>;
    }

    const { lastFrame } = render(
      <AgentViewProvider config={config}>
        <Probe />
      </AgentViewProvider>,
    );

    await act(async () => {
      probeActions.registerAgent?.('agent-a', interactiveAgent, 'm', 'c');
    });
    await act(async () => {
      probeActions.appendToAgentMessageQueue?.('agent-a', 'first');
      probeActions.appendToAgentMessageQueue?.('agent-a', 'second');
    });
    expect(lastFrame()).toContain('a:[first,second]');

    await act(async () => {
      probeActions.unregisterAll?.();
    });

    expect(lastFrame()).toContain('a:[]');
  });
});

describe('AgentQueueFlusher FAILED delivery gate (#10315 review)', () => {
  /**
   * Stub of an agent that has reached FAILED. `error` set models a fatal
   * failure (chat never created / run loop threw — core sets `error`, not
   * `lastRoundError`); `error` undefined models a recoverable round failure.
   */
  function makeFailedAgent(error: string | undefined): AgentInteractive {
    return {
      getCore: () => ({
        runtimeContext: {
          getApprovalMode: () => ApprovalMode.DEFAULT,
          setApprovalMode: vi.fn(),
        },
      }),
      getStatus: () => AgentStatus.FAILED,
      getError: () => error,
      getLastRoundError: () => (error === undefined ? 'round boom' : undefined),
      getPendingApprovals: () => new Map(),
      getLastPromptTokenCount: () => 0,
      getEventEmitter: () => undefined,
      enqueueMessage: vi.fn(),
    } as unknown as AgentInteractive;
  }

  function renderQueuedFailedAgent(
    agent: AgentInteractive,
    source?: 'arena' | 'team',
  ) {
    const config = makeConfig();
    const probeActions: {
      registerAgent?: (
        agentId: string,
        a: AgentInteractive,
        modelId: string,
        color: string,
        modelName?: string,
        src?: 'arena' | 'team',
      ) => void;
      setAgentMessageQueue?: (agentId: string, queue: string[]) => void;
    } = {};

    function Probe() {
      const state = useAgentViewState();
      const actions = useAgentViewActions();
      probeActions.registerAgent = actions.registerAgent;
      probeActions.setAgentMessageQueue = actions.setAgentMessageQueue;
      const queue = state.agentMessageQueues.get('agent-a') ?? [];
      return <Text>a:[{queue.join(',')}]</Text>;
    }

    const app = render(
      <AgentViewProvider config={config}>
        <Probe />
      </AgentViewProvider>,
    );
    return { app, probeActions, source };
  }

  const seedAndQueue = async (
    probeActions: ReturnType<typeof renderQueuedFailedAgent>['probeActions'],
    agent: AgentInteractive,
    source?: 'arena' | 'team',
  ) => {
    await act(async () => {
      probeActions.registerAgent?.(
        'agent-a',
        agent,
        'm',
        'c',
        undefined,
        source,
      );
    });
    await act(async () => {
      probeActions.setAgentMessageQueue?.('agent-a', ['queued follow-up']);
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  };

  it('drops the queue without delivering when a chat-less FAILED agent (fatal error) settles', async () => {
    // Chat-creation failure: enqueueMessage would restart a loop whose
    // runOneRound early-returns on `!this.chat`, silently consuming the
    // message and settling FAILED → IDLE (erasing the failure state).
    const agent = makeFailedAgent('Failed to create chat session');
    const { app, probeActions } = renderQueuedFailedAgent(agent);
    await seedAndQueue(probeActions, agent);

    expect(agent.enqueueMessage).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain('a:[]');
  });

  it('drops the queue without delivering when a FAILED team-managed agent settles', async () => {
    // TeamManager tears a teammate down synchronously on terminal status
    // (TEAMMATE_EXITED, event bridge detached, per-agent state dropped —
    // "a terminated teammate can never reach IDLE again"), so delivering
    // would resurrect a deaf agent.
    const agent = makeFailedAgent(undefined);
    const { app, probeActions } = renderQueuedFailedAgent(agent, 'team');
    await seedAndQueue(probeActions, agent, 'team');

    expect(agent.enqueueMessage).not.toHaveBeenCalled();
    expect(app.lastFrame()).toContain('a:[]');
  });

  it('still delivers to a FAILED arena agent whose round merely errored', async () => {
    // Recoverable flavor: no fatal error, not team-managed — core's
    // intentionally unguarded enqueueMessage restarts the run loop.
    const agent = makeFailedAgent(undefined);
    const { app, probeActions } = renderQueuedFailedAgent(agent);
    await seedAndQueue(probeActions, agent);

    expect(agent.enqueueMessage).toHaveBeenCalledTimes(1);
    expect(agent.enqueueMessage).toHaveBeenCalledWith('queued follow-up');
    expect(app.lastFrame()).toContain('a:[]');
  });
});
