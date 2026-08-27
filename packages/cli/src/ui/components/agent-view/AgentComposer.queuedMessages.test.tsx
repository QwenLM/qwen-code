/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression tests for #10069 — a follow-up accepted and shown as queued
 * while a teammate is busy must survive teammate tab switches. The layout
 * renders AgentComposer with `key={activeView}`, so switching tabs unmounts
 * the composer; any queue held only in local component state is discarded
 * and the message is never delivered.
 *
 * Also covers #10148 -- delivery must not depend on the keyed composer
 * being mounted: queued follow-ups are flushed when the agent settles to
 * idle even while the user is on another teammate tab, and the queue is
 * dropped when the agent reaches a terminal status (it can never be
 * delivered then, and a permanent "queued" display would remain otherwise).
 */

import { render } from 'ink-testing-library';
import { StrictMode, useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentStatus,
  ApprovalMode,
  type AgentInteractive,
} from '@qwen-code/qwen-code-core';
import {
  AgentViewProvider,
  useAgentViewActions,
  useAgentViewState,
} from '../../contexts/AgentViewContext.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { useAgentStreamingState } from '../../hooks/useAgentStreamingState.js';
import { usePreferredEditor } from '../../hooks/usePreferredEditor.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { StreamingState } from '../../types.js';
import { useTextBuffer } from '../shared/text-buffer.js';
import { AgentComposer } from './AgentComposer.js';

// Captures the onSubmit handler of the most recently rendered composer
// input so tests can submit messages without driving real keypresses.
const submitCapture = vi.hoisted(() => ({
  current: undefined as ((text: string) => void) | undefined,
}));

vi.mock('../../contexts/ConfigContext.js');
vi.mock('../../hooks/useAgentStreamingState.js');
vi.mock('../../hooks/useKeypress.js');
vi.mock('../../hooks/usePreferredEditor.js');
vi.mock('../../hooks/useTerminalSize.js');
vi.mock('../shared/text-buffer.js');
vi.mock('../BaseTextInput.js', () => ({
  BaseTextInput: (props: { onSubmit: (text: string) => void }) => {
    submitCapture.current = props.onSubmit;
    return null;
  },
}));
vi.mock('../LoadingIndicator.js', () => ({ LoadingIndicator: () => null }));
vi.mock('./AgentFooter.js', () => ({ AgentFooter: () => null }));

const BUSY = {
  status: AgentStatus.RUNNING,
  streamingState: StreamingState.Responding,
  isInputActive: true,
  elapsedTime: 0,
  lastPromptTokenCount: 0,
};

const IDLE = {
  status: AgentStatus.IDLE,
  streamingState: StreamingState.Idle,
  isInputActive: true,
  elapsedTime: 0,
  lastPromptTokenCount: 0,
};

/** Let ink flush scheduled effects/state updates. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeFakeAgent(): AgentInteractive {
  return {
    enqueueMessage: vi.fn(),
    cancelCurrentRound: vi.fn(),
    getError: vi.fn(),
    getLastRoundError: vi.fn(),
    getCore: () => ({
      runtimeContext: {
        getApprovalMode: () => ApprovalMode.DEFAULT,
        setApprovalMode: vi.fn(),
      },
    }),
  } as unknown as AgentInteractive;
}

describe('Agent View queued follow-ups (#10069, #10148)', () => {
  let agentA: AgentInteractive;
  let agentB: AgentInteractive;
  const streamingByAgent = new Map<AgentInteractive, typeof IDLE>();

  // Mirrors DefaultAppLayout: AgentComposer is keyed by the active view,
  // so switching tabs unmounts and remounts the composer from scratch.
  function Harness({ view }: { view: string }) {
    const { agents } = useAgentViewState();
    const { registerAgent } = useAgentViewActions();

    useEffect(() => {
      if (!agents.has('agent-a')) {
        registerAgent('agent-a', agentA, 'qwen', 'cyan');
      }
      if (!agents.has('agent-b')) {
        registerAgent('agent-b', agentB, 'qwen', 'blue');
      }
    }, [agents, registerAgent]);

    return agents.has(view) ? (
      <AgentComposer key={view} agentId={view} />
    ) : null;
  }

  const view = (name: string) => (
    <StrictMode>
      <AgentViewProvider>
        <Harness view={name} />
      </AgentViewProvider>
    </StrictMode>
  );

  const renderWithView = async (name: string) => {
    const app = render(view(name));
    await tick();
    await tick();
    return app;
  };

  const switchTo = async (
    app: ReturnType<typeof render>,
    name: string,
  ): Promise<void> => {
    app.rerender(view(name));
    await tick();
    await tick();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    streamingByAgent.clear();
    submitCapture.current = undefined;
    agentA = makeFakeAgent();
    agentB = makeFakeAgent();

    vi.mocked(useConfig).mockReturnValue({
      getContentGeneratorConfig: () => undefined,
    } as never);
    vi.mocked(usePreferredEditor).mockReturnValue(undefined);
    vi.mocked(useTerminalSize).mockReturnValue({ columns: 80, rows: 24 });
    vi.mocked(useTextBuffer).mockReturnValue({
      text: '',
      allVisualLines: [''],
      visualCursor: [0, 0],
    } as never);
    vi.mocked(useAgentStreamingState).mockImplementation(
      (agent: AgentInteractive | undefined) =>
        (agent && streamingByAgent.get(agent)) || IDLE,
    );
  });

  it('keeps a queued follow-up across tab switches and delivers it exactly once', async () => {
    streamingByAgent.set(agentA, BUSY);
    const app = await renderWithView('agent-a');

    // Submit while agent-a is busy — accepted and shown as queued.
    expect(submitCapture.current).toBeDefined();
    submitCapture.current!('follow-up for later');
    await switchTo(app, 'agent-a');
    expect(app.lastFrame()).toContain('follow-up for later');
    expect(agentA.enqueueMessage).not.toHaveBeenCalled();

    // Switch to teammate B, then back to A (layout key remounts composer).
    await switchTo(app, 'agent-b');
    await switchTo(app, 'agent-a');

    // The accepted message must still be queued for agent-a.
    expect(app.lastFrame()).toContain('follow-up for later');
    expect(agentA.enqueueMessage).not.toHaveBeenCalled();

    // Agent-a settles to idle — the queued message is delivered once.
    streamingByAgent.set(agentA, IDLE);
    await switchTo(app, 'agent-a');
    expect(agentA.enqueueMessage).toHaveBeenCalledTimes(1);
    expect(agentA.enqueueMessage).toHaveBeenCalledWith('follow-up for later');
    expect(app.lastFrame()).not.toContain('follow-up for later');

    // A later re-render must not re-deliver the message.
    await switchTo(app, 'agent-a');
    expect(agentA.enqueueMessage).toHaveBeenCalledTimes(1);
  });

  it('delivers queued follow-ups while the user is on another tab (#10148)', async () => {
    streamingByAgent.set(agentA, BUSY);
    const app = await renderWithView('agent-a');

    submitCapture.current!('follow-up while away');
    await switchTo(app, 'agent-a');
    expect(app.lastFrame()).toContain('follow-up while away');

    // The user keeps working on teammate B while A finishes its round.
    await switchTo(app, 'agent-b');
    streamingByAgent.set(agentA, IDLE);
    await switchTo(app, 'agent-b');

    // Delivery must not wait for the user to revisit A's tab: A's composer
    // is unmounted here, only the provider persists (#10148).
    expect(agentA.enqueueMessage).toHaveBeenCalledTimes(1);
    expect(agentA.enqueueMessage).toHaveBeenCalledWith('follow-up while away');

    // Revisiting A later must not re-deliver.
    await switchTo(app, 'agent-a');
    expect(agentA.enqueueMessage).toHaveBeenCalledTimes(1);
    expect(app.lastFrame()).not.toContain('follow-up while away');
  });

  it('drops the queue when the agent reaches a terminal status (#10148)', async () => {
    streamingByAgent.set(agentA, BUSY);
    const app = await renderWithView('agent-a');

    submitCapture.current!('never delivered');
    await switchTo(app, 'agent-a');
    expect(app.lastFrame()).toContain('never delivered');

    // A fails while the user is on B; queued follow-ups can never arrive.
    await switchTo(app, 'agent-b');
    streamingByAgent.set(agentA, {
      status: AgentStatus.FAILED,
      streamingState: StreamingState.Idle,
      isInputActive: false,
      elapsedTime: 0,
      lastPromptTokenCount: 0,
    });
    await switchTo(app, 'agent-b');

    expect(agentA.enqueueMessage).not.toHaveBeenCalled();

    // The undeliverable queue must be dropped, not shown as "queued" forever.
    await switchTo(app, 'agent-a');
    expect(app.lastFrame()).not.toContain('never delivered');
    expect(agentA.enqueueMessage).not.toHaveBeenCalled();
  });

  it('joins multiple queued follow-ups into one prompt after a tab switch', async () => {
    streamingByAgent.set(agentA, BUSY);
    const app = await renderWithView('agent-a');

    submitCapture.current!('first follow-up');
    await switchTo(app, 'agent-a');
    submitCapture.current!('second follow-up');
    await switchTo(app, 'agent-a');
    expect(app.lastFrame()).toContain('first follow-up');
    expect(app.lastFrame()).toContain('second follow-up');

    await switchTo(app, 'agent-b');
    await switchTo(app, 'agent-a');

    streamingByAgent.set(agentA, IDLE);
    await switchTo(app, 'agent-a');
    expect(agentA.enqueueMessage).toHaveBeenCalledTimes(1);
    expect(agentA.enqueueMessage).toHaveBeenCalledWith(
      'first follow-up\nsecond follow-up',
    );
  });

  it('keeps both submits when two land in one batch while busy', async () => {
    streamingByAgent.set(agentA, BUSY);
    const app = await renderWithView('agent-a');

    // Two submits dispatched before the composer re-renders (e.g. two Enter
    // presses in one stdin chunk): the second must not replace the first.
    submitCapture.current!('same-batch one');
    submitCapture.current!('same-batch two');
    await switchTo(app, 'agent-a');

    expect(app.lastFrame()).toContain('same-batch one');
    expect(app.lastFrame()).toContain('same-batch two');

    streamingByAgent.set(agentA, IDLE);
    await switchTo(app, 'agent-a');
    expect(agentA.enqueueMessage).toHaveBeenCalledTimes(1);
    expect(agentA.enqueueMessage).toHaveBeenCalledWith(
      'same-batch one\nsame-batch two',
    );
  });

  it('still enqueues immediately when the teammate is idle', async () => {
    streamingByAgent.set(agentA, IDLE);
    const app = await renderWithView('agent-a');

    submitCapture.current!('hello');
    await switchTo(app, 'agent-a');
    expect(agentA.enqueueMessage).toHaveBeenCalledTimes(1);
    expect(agentA.enqueueMessage).toHaveBeenCalledWith('hello');
    expect(app.lastFrame()).not.toContain('hello');
  });
});
