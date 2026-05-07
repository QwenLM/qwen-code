/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import type { AgentResultDisplay } from '@qwen-code/qwen-code-core';
import { makeFakeConfig } from '@qwen-code/qwen-code-core';
import { AgentTree, type AgentTreeAgent } from './AgentTree.js';

vi.mock('../../messages/ToolConfirmationMessage.js', () => ({
  ToolConfirmationMessage: ({
    confirmationDetails,
  }: {
    confirmationDetails: { type?: string };
  }) => (
    <Text>{`[approval banner type=${confirmationDetails?.type ?? 'unknown'}]`}</Text>
  ),
}));

function makeAgent(
  overrides: Partial<AgentResultDisplay> & {
    callId?: string;
    isFocused?: boolean;
    isWaitingForOtherApproval?: boolean;
  } = {},
): AgentTreeAgent {
  const {
    callId = 'call-x',
    isFocused,
    isWaitingForOtherApproval,
    ...rest
  } = overrides;
  return {
    callId,
    data: {
      type: 'task_execution',
      subagentName: 'reviewer',
      taskDescription: 'review files',
      taskPrompt: 'review the files',
      status: 'running',
      ...rest,
    },
    isFocused,
    isWaitingForOtherApproval,
  };
}

function registerEntry(
  config: ReturnType<typeof makeFakeConfig>,
  callId: string,
  opts: {
    toolUses?: number;
    totalTokens?: number;
    activity?: { name: string; description?: string };
  } = {},
): void {
  const registry = config.getBackgroundTaskRegistry();
  registry.register({
    agentId: `agent-${callId}`,
    description: 'agent for ' + callId,
    flavor: 'foreground',
    status: 'running',
    startTime: Date.now(),
    abortController: new AbortController(),
    toolUseId: callId,
    stats: {
      totalTokens: opts.totalTokens ?? 0,
      toolUses: opts.toolUses ?? 0,
      durationMs: 0,
    },
  });
  if (opts.activity) {
    registry.appendActivity(`agent-${callId}`, {
      name: opts.activity.name,
      description: opts.activity.description ?? '',
      at: Date.now(),
    });
  }
}

describe('<AgentTree />', () => {
  it('renders header + tree row + initializing for a single running agent', () => {
    const config = makeFakeConfig();
    const { lastFrame } = render(
      <AgentTree
        agents={[makeAgent({ callId: 'a' })]}
        config={config}
        childWidth={80}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Running 1 reviewer agents…');
    expect(frame).toContain('└─');
    expect(frame).toContain('⎿');
    expect(frame).toContain('Initializing…');
  });

  it('promotes a shared subagentName into the header and drops it from rows', () => {
    const config = makeFakeConfig();
    const agents = ['a', 'b', 'c'].map((id) =>
      makeAgent({
        callId: id,
        subagentName: 'reviewer',
        taskDescription: `task ${id}`,
      }),
    );
    const { lastFrame } = render(
      <AgentTree agents={agents} config={config} childWidth={80} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Running 3 reviewer agents…');
    // Common name is hidden inside rows; per-task descriptions remain visible.
    expect(frame).toContain('task a');
    expect(frame).toContain('task b');
    expect(frame).toContain('task c');
    // Two non-last rows + one last row.
    expect(frame.split('\n').filter((l) => l.includes('├─')).length).toBe(2);
    expect(frame.split('\n').filter((l) => l.includes('└─')).length).toBe(1);
  });

  it('keeps the generic header when subagentNames differ', () => {
    const config = makeFakeConfig();
    const agents = [
      makeAgent({ callId: 'a', subagentName: 'reviewer' }),
      makeAgent({ callId: 'b', subagentName: 'researcher' }),
    ];
    const { lastFrame } = render(
      <AgentTree agents={agents} config={config} childWidth={80} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Running 2 agents…');
    // Both subagent names appear inline because they differ.
    expect(frame).toContain('reviewer');
    expect(frame).toContain('researcher');
  });

  it('collapses backgrounded async agents to a single row with no row 2', () => {
    const config = makeFakeConfig();
    const { lastFrame } = render(
      <AgentTree
        agents={[
          makeAgent({
            callId: 'a',
            status: 'background',
            subagentName: 'searcher',
          }),
        ]}
        config={config}
        childWidth={80}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Running in the background');
    // Row 2 is suppressed → no `⎿` for the collapsed agent.
    expect(frame).not.toContain('⎿');
  });

  it('renders Done on row 2 for a finished sibling inside a still-pending tree', () => {
    const config = makeFakeConfig();
    const completed = makeAgent({
      callId: 'a',
      subagentName: 'reviewer',
      status: 'completed',
      executionSummary: {
        rounds: 1,
        totalDurationMs: 100,
        totalToolCalls: 4,
        successfulToolCalls: 4,
        failedToolCalls: 0,
        successRate: 100,
        inputTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
        cachedTokens: 0,
        totalTokens: 1234,
        toolUsage: [],
      },
    });
    const running = makeAgent({ callId: 'b', subagentName: 'reviewer' });
    registerEntry(config, 'b', {
      toolUses: 2,
      totalTokens: 800,
      activity: { name: 'grep_search', description: 'TODO' },
    });

    const { lastFrame } = render(
      <AgentTree
        agents={[completed, running]}
        config={config}
        childWidth={80}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Done');
    // Running sibling's row 2 reflects the registry's last activity.
    expect(frame.toLowerCase()).toContain('todo');
    // Completed agent's stats come from executionSummary fallback.
    expect(frame).toContain('4 tool uses');
    expect(frame).toContain('1.2k tokens');
  });

  it('updates row 2 when the registry emits an activity event', () => {
    const config = makeFakeConfig();
    registerEntry(config, 'a', {
      toolUses: 1,
      activity: { name: 'grep_search', description: 'first' },
    });
    const { lastFrame } = render(
      <AgentTree
        agents={[makeAgent({ callId: 'a' })]}
        config={config}
        childWidth={80}
      />,
    );
    expect(lastFrame() ?? '').toContain('first');

    act(() => {
      config.getBackgroundTaskRegistry().appendActivity('agent-a', {
        name: 'run_shell_command',
        description: 'ls -la',
        at: Date.now(),
      });
    });
    const updated = lastFrame() ?? '';
    expect(updated).toContain('ls -la');
    expect(updated).not.toContain('first');
  });

  it('renders the approval banner above the tree when an agent is focus-locked', () => {
    const config = makeFakeConfig();
    const agents = [
      makeAgent({
        callId: 'a',
        subagentName: 'reviewer',
        pendingConfirmation: {
          type: 'exec',
          rootCommand: 'rm -rf /',
        } as AgentResultDisplay['pendingConfirmation'],
        isFocused: true,
      }),
      makeAgent({ callId: 'b', subagentName: 'reviewer' }),
    ];
    const { lastFrame } = render(
      <AgentTree agents={agents} config={config} childWidth={80} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Approval requested by');
    expect(frame).toContain('[approval banner');
    // Tree still renders below the banner.
    const bannerIndex = frame.indexOf('[approval banner');
    const treeIndex = frame.indexOf('Running 2 reviewer agents…');
    expect(bannerIndex).toBeLessThan(treeIndex);
  });

  it('marks agents queued behind another approval with a queued marker', () => {
    const config = makeFakeConfig();
    const agents = [
      makeAgent({
        callId: 'a',
        subagentName: 'reviewer',
        pendingConfirmation: {
          type: 'exec',
          rootCommand: 'first',
        } as AgentResultDisplay['pendingConfirmation'],
        isFocused: true,
      }),
      makeAgent({
        callId: 'b',
        subagentName: 'reviewer',
        pendingConfirmation: {
          type: 'exec',
          rootCommand: 'second',
        } as AgentResultDisplay['pendingConfirmation'],
        isWaitingForOtherApproval: true,
      }),
    ];
    const { lastFrame } = render(
      <AgentTree agents={agents} config={config} childWidth={80} />,
    );
    expect(lastFrame() ?? '').toContain('⏳ Queued approval');
  });

  it('keeps the Running header when a finished sibling and a backgrounded sibling coexist', () => {
    const config = makeFakeConfig();
    const finished = makeAgent({
      callId: 'a',
      subagentName: 'reviewer',
      status: 'completed',
      executionSummary: {
        rounds: 1,
        totalDurationMs: 100,
        totalToolCalls: 1,
        successfulToolCalls: 1,
        failedToolCalls: 0,
        successRate: 100,
        inputTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
        cachedTokens: 0,
        totalTokens: 100,
        toolUsage: [],
      },
    });
    const backgrounded = makeAgent({
      callId: 'b',
      subagentName: 'reviewer',
      status: 'background',
    });
    const { lastFrame } = render(
      <AgentTree
        agents={[finished, backgrounded]}
        config={config}
        childWidth={80}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Running 2 reviewer agents…');
    expect(frame).not.toContain('agents finished');
    expect(frame).not.toContain('background agents launched');
  });

  it('marks failed agents with the terminate reason on row 2', () => {
    const config = makeFakeConfig();
    const failed = makeAgent({
      callId: 'a',
      status: 'failed',
      terminateReason: 'tool error: syntax',
    });
    const running = makeAgent({ callId: 'b' });
    const { lastFrame } = render(
      <AgentTree agents={[failed, running]} config={config} childWidth={80} />,
    );
    expect(lastFrame() ?? '').toContain('tool error: syntax');
  });
});
