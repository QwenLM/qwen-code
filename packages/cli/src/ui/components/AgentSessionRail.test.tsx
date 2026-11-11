/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  type AgentUnifiedTask,
  type InternalAgentUnifiedTask,
  TaskRegistry,
  type WorkflowUnifiedTask,
} from '@qwen-code/core';
import { renderWithProviders } from '../../test-utils/render.js';
import { TaskRegistryProvider } from '../contexts/TaskRegistryContext.js';
import type { Key } from '../contexts/KeypressContext.js';
import { AgentSessionRail } from './AgentSessionRail.js';

function makeWorkflowTask(): WorkflowUnifiedTask {
  return {
    id: 'wf-task',
    type: 'local_workflow',
    status: 'running',
    description: 'Deep research harness',
    startTime: Date.now() - 5000,
    notified: false,
    executionId: 1,
    completionBehavior: 'notify',
    workflowRunId: 'wf_test',
    workflowName: 'deep-research',
    scriptPath: '/tmp/workflow.js',
    transcriptDir: '/tmp/workflows/wf_test/transcripts',
    phases: [
      { title: 'Scope' },
      { title: 'Search' },
    ],
    progress: [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'scope',
        state: 'done',
        phaseIndex: 1,
        phaseTitle: 'Scope',
        tokens: 24_000,
        toolCalls: 1,
      },
      {
        type: 'workflow_agent',
        index: 2,
        label: 'search:docs',
        state: 'progress',
        phaseIndex: 2,
        phaseTitle: 'Search',
        tokens: 12_000,
        toolCalls: 1,
      },
    ],
    logs: [],
    agentCount: 2,
    totalTokens: 36_000,
    totalToolCalls: 2,
    abortController: new AbortController(),
    agentControllers: {},
  };
}

function makeLongWorkflowTask(): WorkflowUnifiedTask {
  return {
    ...makeWorkflowTask(),
    progress: [
      {
        type: 'workflow_agent',
        index: 1,
        label: 'scope',
        state: 'progress',
        phaseIndex: 1,
        phaseTitle: 'Scope',
      },
    ],
    agentCount: 1,
    totalTokens: 0,
    totalToolCalls: 0,
    description:
      'Deep research harness - fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.',
  };
}

function makeInternalAgentTask(
  overrides: Partial<InternalAgentUnifiedTask> = {},
): InternalAgentUnifiedTask {
  return {
    id: 'internal-auto-dream',
    type: 'internal_agent',
    status: 'running',
    description: 'Dreaming',
    startTime: Date.now() - 2000,
    notified: false,
    executionId: -2,
    completionBehavior: 'silent',
    agentName: 'Dreaming',
    agentType: 'dream',
    prompt: 'Dreaming',
    phase: 'running',
    isBackgrounded: true,
    killable: false,
    ...overrides,
  };
}

function makeCompletedAgentTask(
  overrides: Partial<AgentUnifiedTask> = {},
): AgentUnifiedTask {
  const endTime = Date.now() - 31_000;
  return {
    id: 'a-fork-completed',
    type: 'local_agent',
    status: 'completed',
    description: 'read every md file under .qwen/agents',
    startTime: endTime - 10_000,
    endTime,
    notified: true,
    executionId: 11,
    completionBehavior: 'notify',
    agentId: 'fork-completed',
    agentName: 'fork',
    agentType: 'fork',
    prompt: 'read every md file under .qwen/agents',
    isBackgrounded: true,
    taskId: 'task-afork-completed',
    ...overrides,
  };
}

function key(sequence: string): Key {
  return {
    name: sequence,
    shift: false,
    alt: false,
    ctrl: false,
    cmd: false,
    insertable: true,
    sequence,
  };
}

describe('AgentSessionRail workflow integration', () => {
  it('shows persisted workflow history after the live task is evicted', async () => {
    const registry = new TaskRegistry();
    const historicalTask: WorkflowUnifiedTask = {
      ...makeWorkflowTask(),
      id: 'history-task',
      workflowRunId: 'wf_history',
      workflowName: 'completed-research',
      description: 'Completed research',
      status: 'completed',
      endTime: Date.now() - 60_000,
      notified: true,
      executionId: -1,
      completionBehavior: 'silent',
      abortController: undefined,
      agentControllers: undefined,
    };

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <AgentSessionRail selectionMode="workflows" />
      </TaskRegistryProvider>
    );

    const { lastFrame, unmount } = await renderWithProviders(tree, {
      width: 120,
      uiState: { workflowHistoryTasks: [historicalTask] },
    });

    expect(lastFrame()).toContain('completed-research');
    expect(lastFrame()).toContain('enter view');
    unmount();
  });

  it('shows only workflows in /workflows selection mode', async () => {
    const registry = new TaskRegistry();
    registry.register(makeWorkflowTask());
    registry.register(makeInternalAgentTask());
    const viewWorkflowSession = vi.fn();

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <AgentSessionRail selectionMode="workflows" />
      </TaskRegistryProvider>
    );

    const { capturedRegistry, lastFrame, unmount } =
      await renderWithProviders(tree, {
        width: 120,
        uiActions: { viewWorkflowSession },
      });

    expect(lastFrame()).toContain('enter view');
    expect(lastFrame()).toContain('deep-research');
    expect(lastFrame()).not.toContain('Dreaming');
    await act(async () => {
      expect(
        capturedRegistry?.invokeAction('AgentRail', 'agentRail:up', key('')),
      ).toBe(true);
    });
    await act(async () => {
      expect(
        capturedRegistry?.invokeAction(
          'AgentRail',
          'agentRail:select',
          key(''),
        ),
      ).toBe(true);
    });

    expect(viewWorkflowSession).toHaveBeenCalledWith('wf-task');
    unmount();
  });

  it('returns to the main session when workflow rail browsing is cancelled', async () => {
    const registry = new TaskRegistry();
    registry.register(makeWorkflowTask());
    const viewMainSession = vi.fn();

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <AgentSessionRail selectionMode="workflows" />
      </TaskRegistryProvider>
    );

    const { capturedRegistry, unmount } = await renderWithProviders(tree, {
      width: 120,
      uiActions: { viewMainSession },
    });

    await act(async () => {
      expect(
        capturedRegistry?.invokeAction(
          'AgentRail',
          'agentRail:escape',
          key(''),
        ),
      ).toBe(true);
    });

    expect(viewMainSession).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('renders workflow rows and opens the workflow view from rail selection', async () => {
    const registry = new TaskRegistry();
    const workflow = makeWorkflowTask();
    registry.register(workflow);

    const viewWorkflowSession = vi.fn();
    const focusRef: React.MutableRefObject<(() => boolean) | null> = {
      current: null,
    };
    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <AgentSessionRail onFocusRef={focusRef} />
      </TaskRegistryProvider>
    );

    const { capturedRegistry, lastFrame, unmount } = await renderWithProviders(
      tree,
      {
        width: 120,
        uiActions: { viewWorkflowSession },
      },
    );

    expect(lastFrame()).toContain('deep-research');
    expect(lastFrame()).toContain('1/2 agents');
    expect(lastFrame()).not.toContain('24000');
    expect(lastFrame()).not.toContain('36000');

    await act(async () => {
      expect(focusRef.current?.()).toBe(true);
    });
    await act(async () => {
      expect(
        capturedRegistry?.invokeAction('AgentRail', 'agentRail:down', key('')),
      ).toBe(true);
    });
    await act(async () => {
      expect(
        capturedRegistry?.invokeAction(
          'AgentRail',
          'agentRail:select',
          key(''),
        ),
      ).toBe(true);
    });

    expect(viewWorkflowSession).toHaveBeenCalledWith('wf-task');

    unmount();
  });

  it('keeps workflow marker name and status on one rail row', async () => {
    const registry = new TaskRegistry();
    registry.register(makeLongWorkflowTask());

    const focusRef: React.MutableRefObject<(() => boolean) | null> = {
      current: null,
    };
    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <AgentSessionRail onFocusRef={focusRef} />
      </TaskRegistryProvider>
    );

    const { capturedRegistry, lastFrame, unmount } = await renderWithProviders(tree, {
      width: 80,
    });

    await act(async () => {
      expect(focusRef.current?.()).toBe(true);
    });
    await act(async () => {
      expect(
        capturedRegistry?.invokeAction('AgentRail', 'agentRail:down', key('')),
      ).toBe(true);
    });

    const output = lastFrame();
    const workflowLine = output
      .split('\n')
      .find((line) => line.includes('deep-research'));
    expect(workflowLine).toBeDefined();
    expect(workflowLine).toContain('deep-research');
    expect(workflowLine).toContain('◎ deep-research');
    expect(workflowLine).toContain('0/1 agents');
    expect(workflowLine).toContain('…');
    expect(output).not.toContain('deep-researc\nh');

    unmount();
  });

  it('keeps compact workflow hint adjacent to the rail summary', async () => {
    const registry = new TaskRegistry();
    registry.register(makeLongWorkflowTask());

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <AgentSessionRail />
      </TaskRegistryProvider>
    );

    const { lastFrame, unmount } = await renderWithProviders(tree, {
      width: 100,
    });

    const output = lastFrame();
    expect(output).toContain('◎ main · ◎ deep-research');
    expect(output).toContain('0/1 agents');
    expect(output).toContain('↓ to manage');
    expect(output).not.toMatch(/\d+s {4,}· ↓ to manage/);

    unmount();
  });

  it('keeps paused workflows in the rail without presenting them as running', async () => {
    const registry = new TaskRegistry();
    const workflow = makeWorkflowTask();
    workflow.status = 'paused';
    workflow.endTime = Date.now();
    workflow.abortController = undefined;
    workflow.agentControllers = undefined;
    registry.register(workflow);

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <AgentSessionRail />
      </TaskRegistryProvider>
    );

    const { lastFrame, unmount } = await renderWithProviders(tree, {
      width: 100,
    });

    expect(lastFrame()).toContain('deep-research');
    expect(lastFrame()).toContain('paused');
    expect(lastFrame()).not.toContain('running');

    unmount();
  });

  it('renders only scoped internal background agents in the compact rail', async () => {
    const registry = new TaskRegistry();
    registry.register(makeInternalAgentTask());
    registry.register(
      makeInternalAgentTask({
        id: 'internal-task-summary',
        agentName: 'Task Summary',
        agentType: 'summary',
        description: 'Summarizing task',
      }),
    );

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <AgentSessionRail />
      </TaskRegistryProvider>
    );

    const { lastFrame, unmount } = await renderWithProviders(tree, {
      width: 100,
    });

    const output = lastFrame();
    expect(output).toContain('◎ main · ◎ Dreaming');
    expect(output).toContain('bg ·');
    expect(output).toContain('↓ to manage');
    expect(output).not.toContain('Task Summary');

    unmount();
  });

  it('renders the auto-memory internal background agent in the compact rail', async () => {
    const registry = new TaskRegistry();
    registry.register(
      makeInternalAgentTask({
        id: 'internal-auto-memory',
        executionId: -1,
        agentName: 'Memory',
        agentType: 'memory',
        description: 'Memory',
        phase: 'running',
        detail: undefined,
      }),
    );

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <AgentSessionRail />
      </TaskRegistryProvider>
    );

    const { lastFrame, unmount } = await renderWithProviders(tree, {
      width: 100,
    });

    const output = lastFrame();
    expect(output).toContain('◎ main · ◎ Memory');
    expect(output).toContain('bg ·');
    expect(output).toContain('↓ to manage');

    unmount();
  });

  it('combines concurrent auto-memory and auto-dream internal agents in the compact rail', async () => {
    const registry = new TaskRegistry();
    registry.register(makeInternalAgentTask());
    registry.register(
      makeInternalAgentTask({
        id: 'internal-auto-memory',
        executionId: -1,
        agentName: 'Memory',
        agentType: 'memory',
        description: 'Memory',
        phase: 'running',
        detail: undefined,
      }),
    );

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <AgentSessionRail />
      </TaskRegistryProvider>
    );

    const { lastFrame, unmount } = await renderWithProviders(tree, {
      width: 100,
    });

    const output = lastFrame();
    expect(output).toContain('◎ main · ◎ Memory · Dreaming');
    expect(output).toContain('bg ·');
    expect(output).toContain('↓ to manage');
    expect(output).not.toContain('2 background agents');

    unmount();
  });

  it('opens the background task list from scoped internal rail selection', async () => {
    const registry = new TaskRegistry();
    registry.register(makeInternalAgentTask());
    const openBackgroundTaskList = vi.fn(() => true);
    const focusRef: React.MutableRefObject<(() => boolean) | null> = {
      current: null,
    };

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <AgentSessionRail onFocusRef={focusRef} />
      </TaskRegistryProvider>
    );

    const { capturedRegistry, unmount } = await renderWithProviders(tree, {
      width: 100,
      uiActions: { openBackgroundTaskList },
    });

    await act(async () => {
      expect(focusRef.current?.()).toBe(true);
    });
    await act(async () => {
      expect(
        capturedRegistry?.invokeAction('AgentRail', 'agentRail:down', key('')),
      ).toBe(true);
    });
    await act(async () => {
      expect(
        capturedRegistry?.invokeAction('AgentRail', 'agentRail:select', key('')),
      ).toBe(true);
    });

    expect(openBackgroundTaskList).toHaveBeenCalledTimes(1);

    unmount();
  });
});

describe('AgentSessionRail leaves the agent session view when the rail is left', () => {
  async function renderFocusedRailWithViewedAgent(
    viewedAgentTaskId: string | undefined,
  ) {
    const registry = new TaskRegistry();
    const agentTask = makeCompletedAgentTask();
    registry.register(agentTask);
    const viewMainSession = vi.fn();
    const focusRef: React.MutableRefObject<(() => boolean) | null> = {
      current: null,
    };

    const tree: React.ReactElement = (
      <TaskRegistryProvider registry={registry}>
        <AgentSessionRail onFocusRef={focusRef} />
      </TaskRegistryProvider>
    );

    const rendered = await renderWithProviders(tree, {
      width: 100,
      uiState: { viewedAgentTaskId },
      uiActions: { viewMainSession },
    });

    await act(async () => {
      expect(focusRef.current?.()).toBe(true);
    });

    return { ...rendered, viewMainSession };
  }

  it('closes the viewed agent session when a printable character blurs the rail', async () => {
    const { capturedRegistry, viewMainSession, unmount } =
      await renderFocusedRailWithViewedAgent('a-fork-completed');

    // Typing a printable character hands the key to the composer. Before this
    // fix it only blurred the rail, so retainReason='agent-session-view'
    // survived and the `bg · completed` row never left the rail.
    await act(async () => {
      expect(capturedRegistry?.invokeFallback('AgentRail', key('x'))).toBe(
        false,
      );
    });

    expect(viewMainSession).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('closes the viewed agent session when up leaves the rail', async () => {
    const { capturedRegistry, viewMainSession, unmount } =
      await renderFocusedRailWithViewedAgent('a-fork-completed');

    await act(async () => {
      expect(
        capturedRegistry?.invokeAction('AgentRail', 'agentRail:up', key('')),
      ).toBe(true);
    });

    expect(viewMainSession).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not switch sessions when the rail is blurred with no session open', async () => {
    const { capturedRegistry, viewMainSession, unmount } =
      await renderFocusedRailWithViewedAgent(undefined);

    await act(async () => {
      expect(capturedRegistry?.invokeFallback('AgentRail', key('x'))).toBe(
        false,
      );
    });

    expect(viewMainSession).not.toHaveBeenCalled();
    unmount();
  });
});
