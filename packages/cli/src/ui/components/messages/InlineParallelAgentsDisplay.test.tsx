/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { render } from 'ink-testing-library';
import type {
  AgentResultDisplay,
  AgentTask,
  Config,
} from '@qwen-code/qwen-code-core';
import { InlineParallelAgentsDisplay } from './InlineParallelAgentsDisplay.js';
import type { IndividualToolCallDisplay } from '../../types.js';
import { ToolCallStatus } from '../../types.js';
import { ConfigContext } from '../../contexts/ConfigContext.js';

interface AgentCallSeed {
  callId: string;
  subagentName: string;
  taskDescription: string;
  status?: AgentResultDisplay['status'];
  tokenCount?: number;
}

function agentToolCall(seed: AgentCallSeed): IndividualToolCallDisplay {
  const resultDisplay: AgentResultDisplay = {
    type: 'task_execution',
    subagentName: seed.subagentName,
    taskDescription: seed.taskDescription,
    taskPrompt: 'irrelevant prompt',
    status: seed.status ?? 'running',
    tokenCount: seed.tokenCount,
  };
  return {
    callId: seed.callId,
    name: 'agent',
    description: seed.taskDescription,
    resultDisplay,
    status: ToolCallStatus.Pending,
    confirmationDetails: undefined,
  };
}

/**
 * Build a stub Config with a backing Map registry — same pattern
 * LiveAgentPanel.test uses so the test can mutate `recentActivities`
 * between renders and observe the new value pick up on the next tick.
 */
function makeRegistryConfig(entries: Array<Partial<AgentTask>>): {
  config: Config;
  store: Map<string, AgentTask>;
} {
  const store = new Map<string, AgentTask>();
  for (const e of entries) {
    if (e.agentId) {
      store.set(e.agentId, e as AgentTask);
    }
  }
  const config = {
    getTaskRegistry: () => ({
      get: (id: string) => store.get(id),
    }),
  } as unknown as Config;
  return { config, store };
}

function renderInline(options: {
  toolCalls: IndividualToolCallDisplay[];
  config?: Config;
}) {
  let result!: ReturnType<typeof render>;
  act(() => {
    result = render(
      <ConfigContext.Provider value={options.config}>
        <InlineParallelAgentsDisplay
          toolCalls={options.toolCalls}
          contentWidth={120}
        />
      </ConfigContext.Provider>,
    );
  });
  return result;
}

describe('<InlineParallelAgentsDisplay />', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders one row per agent with header tally', () => {
    const toolCalls = [
      agentToolCall({
        callId: 'c1',
        subagentName: 'general-purpose',
        taskDescription: 'Agent 1: Correctness',
      }),
      agentToolCall({
        callId: 'c2',
        subagentName: 'general-purpose',
        taskDescription: 'Agent 2: Security',
      }),
      agentToolCall({
        callId: 'c3',
        subagentName: 'general-purpose',
        taskDescription: 'Agent 3: Code Quality',
      }),
    ];
    const { lastFrame } = renderInline({ toolCalls });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Parallel agents');
    expect(frame).toContain('3');
    // Each agent's display name is surfaced.
    expect(frame).toContain('Agent 1: Correctness');
    expect(frame).toContain('Agent 2: Security');
    expect(frame).toContain('Agent 3: Code Quality');
    // `0/3 done` tally — none have reached a terminal state.
    expect(frame).toContain('0/3 done');
  });

  it('renders nothing for an empty toolCalls list', () => {
    const { lastFrame } = renderInline({ toolCalls: [] });
    expect(lastFrame() ?? '').toBe('');
  });

  it('reflects completed agent in the done tally with a check glyph', () => {
    const toolCalls = [
      agentToolCall({
        callId: 'c1',
        subagentName: 'general-purpose',
        taskDescription: 'Agent 1: Correctness',
        status: 'completed',
      }),
      agentToolCall({
        callId: 'c2',
        subagentName: 'general-purpose',
        taskDescription: 'Agent 2: Security',
        status: 'running',
      }),
    ];
    const { lastFrame } = renderInline({ toolCalls });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1/2 done');
    // Completed glyph rendered for the finished agent.
    expect(frame).toContain('✔');
    // Running glyph for the in-flight one.
    expect(frame).toContain('○');
  });

  it('surfaces live activity + elapsed from the registry', () => {
    const { config } = makeRegistryConfig([
      {
        agentId: 'general-purpose-c1',
        kind: 'agent',
        startTime: -5_000, // 5s ago at fake-time 0
        recentActivities: [{ name: 'glob', description: '**/*.ts', at: -1000 }],
      } as Partial<AgentTask>,
    ]);
    const toolCalls = [
      agentToolCall({
        callId: 'c1',
        subagentName: 'general-purpose',
        taskDescription: 'Agent 1: Correctness',
      }),
    ];
    // contentWidth narrow enough to keep this minimal, but wide enough
    // for all the assertion targets — the activity label gets truncated
    // by Ink at small widths.
    let result!: ReturnType<typeof render>;
    act(() => {
      result = render(
        <ConfigContext.Provider value={config}>
          <InlineParallelAgentsDisplay
            toolCalls={toolCalls}
            contentWidth={120}
          />
        </ConfigContext.Provider>,
      );
    });
    const frame = result.lastFrame() ?? '';
    // Live activity from the registry (display name `Glob` from the
    // tool-name map, plus the description).
    expect(frame).toContain('Glob');
    expect(frame).toContain('**/*.ts');
    // 5s elapsed since the agent's startTime.
    expect(frame).toContain('5s');
  });

  it('falls back to executionSummary when the registry has unregistered the agent', () => {
    // After unregisterForeground fires for a finished foreground
    // subagent, `registry.get(agentId)` returns undefined — so the
    // panel must source elapsed + tokens from the terminal
    // `AgentResultDisplay.executionSummary` instead. Without the
    // fallback, completed rows render as just the name (the
    // production trace showed `✔ Agent 2: Security review  8.1k tok`
    // with no elapsed column).
    const toolCall: IndividualToolCallDisplay = {
      callId: 'c1',
      name: 'agent',
      description: 'A1',
      resultDisplay: {
        type: 'task_execution',
        subagentName: 'general-purpose',
        taskDescription: 'A1',
        taskPrompt: 'p',
        status: 'completed',
        executionSummary: {
          rounds: 1,
          totalDurationMs: 12_000,
          totalToolCalls: 3,
          successfulToolCalls: 3,
          failedToolCalls: 0,
          successRate: 1,
          inputTokens: 0,
          outputTokens: 0,
          thoughtTokens: 0,
          cachedTokens: 0,
          totalTokens: 2400,
          toolUsage: [],
        },
      } as AgentResultDisplay,
      status: ToolCallStatus.Success,
      confirmationDetails: undefined,
    };
    // No registry — explicit `config: undefined` so the panel exercises
    // the unregistered path.
    const { lastFrame } = renderInline({ toolCalls: [toolCall] });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('12s');
    // 2400 tokens → "2.4k" per formatTokenCount.
    expect(frame).toContain('2.4k tok');
  });

  it('ignores non task_execution tool calls in the same group', () => {
    const nonAgent: IndividualToolCallDisplay = {
      callId: 'shell-1',
      name: 'shell',
      description: 'ls',
      resultDisplay: 'irrelevant string',
      status: ToolCallStatus.Success,
      confirmationDetails: undefined,
    };
    const agent = agentToolCall({
      callId: 'c1',
      subagentName: 'general-purpose',
      taskDescription: 'Solo agent',
    });
    const { lastFrame } = renderInline({ toolCalls: [nonAgent, agent] });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Solo agent');
    // The non-agent tool's description does NOT bleed into the panel.
    expect(frame).not.toContain('ls');
    // Tally counts only the agent.
    expect(frame).toContain('0/1 done');
  });
});
