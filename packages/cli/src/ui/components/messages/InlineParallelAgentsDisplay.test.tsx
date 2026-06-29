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
    getBackgroundTaskRegistry: () => ({
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
          outputTokens: 800,
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
    // outputTokens: 800 → "800" per formatTokenCount (not totalTokens: 2400).
    expect(frame).toContain('800 tok');
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

  describe('height backstop (availableTerminalHeight)', () => {
    const manyAgents = (n: number): IndividualToolCallDisplay[] =>
      Array.from({ length: n }, (_, i) =>
        agentToolCall({
          callId: `cap-${i}`,
          subagentName: 'general-purpose',
          taskDescription: `CapAgent ${i}`,
          status: 'completed',
        }),
      );

    const renderCapped = (
      toolCalls: IndividualToolCallDisplay[],
      availableTerminalHeight?: number,
    ) =>
      render(
        <ConfigContext.Provider value={undefined}>
          <InlineParallelAgentsDisplay
            toolCalls={toolCalls}
            contentWidth={120}
            availableTerminalHeight={availableTerminalHeight}
          />
        </ConfigContext.Provider>,
      );

    it('without a budget, renders every agent (no cap)', () => {
      const { lastFrame } = renderCapped(manyAgents(10));
      const frame = lastFrame() ?? '';
      // header + 10 rows, no overflow indicator.
      expect(frame.split('\n').length).toBe(11);
      expect(frame).not.toContain('more agent');
    });

    it('with a generous budget, renders every agent (backstop is a no-op)', () => {
      // 10 agents + header = 11 rows < budget 20, so the `rows.length + 1 >
      // budget` guard is false and windowing must NOT kick in. Pins the `>`
      // boundary: a regression to `>=` (or an off-by-one) would truncate here
      // even though there is room.
      const { lastFrame } = renderCapped(manyAgents(10), 20);
      const frame = lastFrame() ?? '';
      expect(frame.split('\n').length).toBe(11);
      expect(frame).not.toContain('more agent');
    });

    it('with a budget, windows to the most recent rows + "+N more" and never exceeds the budget', () => {
      const budget = 6;
      const { lastFrame } = renderCapped(manyAgents(10), budget);
      const frame = lastFrame() ?? '';
      // The whole non-Static frame must fit the budget, else ink clears the
      // terminal every repaint (the scroll snap-back this guards against).
      expect(frame.split('\n').length).toBeLessThanOrEqual(budget);
      // rowBudget = budget - 2 = 4 visible rows → 6 hidden.
      expect(frame).toContain('+6 more agents');
      // Windows from the END (most recent), so the last agent shows and the
      // first does not.
      expect(frame).toContain('CapAgent 9');
      expect(frame).not.toContain('CapAgent 0');
      // Header tally still reflects the full count.
      expect(frame).toContain('10/10 done');
    });

    it('at a budget of 2, keeps the header + indicator only (drops every row)', () => {
      const budget = 2;
      const { lastFrame } = renderCapped(manyAgents(10), budget);
      const frame = lastFrame() ?? '';
      // header (1) + "+N more" indicator (1) = 2 rows, exactly the budget — no
      // data row may slip in, or the frame overflows and snaps back.
      expect(frame.split('\n').length).toBeLessThanOrEqual(budget);
      expect(frame).toContain('+10 more agents');
      expect(frame).not.toContain('CapAgent');
      expect(frame).toContain('10/10 done');
    });

    it('at a budget of 1, keeps only the header (drops rows and the indicator)', () => {
      const budget = 1;
      const { lastFrame } = renderCapped(manyAgents(10), budget);
      const frame = lastFrame() ?? '';
      // Only the header fits; even the overflow indicator would overflow.
      expect(frame.split('\n').length).toBeLessThanOrEqual(budget);
      expect(frame).not.toContain('more agent');
      expect(frame).not.toContain('CapAgent');
      // The header label still carries the full tally.
      expect(frame).toContain('10/10 done');
    });
  });
});
