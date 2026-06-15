import { describe, expect, it } from 'vitest';
import type { Message } from '../adapters/types';
import {
  applyTurnCollapse,
  findDisplayItemIndex,
  findTurnIdForIndex,
  getDisplayItemVirtualKey,
  groupParallelAgents,
  shouldUseVirtualScroll,
  VIRTUAL_SCROLL_THRESHOLD,
  type DisplayItem,
} from './MessageList';

function messageRow(
  item: DisplayItem,
): Extract<DisplayItem, { type: 'message' }> {
  if (item.type !== 'message') {
    throw new Error(`expected a message row, got ${item.type}`);
  }
  return item;
}

function makeAnswerWithThinking(id: string): Message {
  return {
    id,
    role: 'assistant',
    content: 'final answer',
    thinking: 'pondering',
  };
}

function makeSystemMessage(id: string): Message {
  return { id, role: 'system', content: 'heads up', variant: 'error' };
}

function makePlanMessage(id: string): Message {
  return { id, role: 'plan', todos: [] };
}

function makeAgentToolGroup(
  id: string,
  toolName = 'Agent',
  timestamp?: number,
): Message {
  return {
    id,
    role: 'tool_group',
    tools: [
      {
        callId: `call-${id}`,
        toolName,
        status: 'completed',
        args: { description: `task ${id}` },
      },
    ],
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

function makeBackgroundAgentToolGroup(id: string): Message {
  return {
    id,
    role: 'tool_group',
    tools: [
      {
        callId: `call-${id}`,
        toolName: 'Agent',
        status: 'pending',
        args: {
          description: `task ${id}`,
          run_in_background: true,
        },
        rawOutput: {
          type: 'task_execution',
          taskDescription: `task ${id}`,
          status: 'background',
        },
      },
    ],
  };
}

function makeMultiToolGroup(id: string): Message {
  return {
    id,
    role: 'tool_group',
    tools: [
      { callId: `call-${id}-a`, toolName: 'Read', status: 'completed' },
      { callId: `call-${id}-b`, toolName: 'Write', status: 'completed' },
    ],
  };
}

function makeUserMessage(id: string): Message {
  return { id, role: 'user', content: 'hello' };
}

function makeAssistantMessage(id: string): Message {
  return { id, role: 'assistant', content: 'response' };
}

function makeThoughtMessage(id: string): Message {
  return {
    id,
    role: 'assistant',
    content: '',
    thinking: 'launching another agent',
  };
}

describe('groupParallelAgents', () => {
  it('returns empty array for empty input', () => {
    expect(groupParallelAgents([])).toEqual([]);
  });

  it('does not group a single agent tool_group', () => {
    const msgs = [makeAgentToolGroup('1')];
    const items = groupParallelAgents(msgs);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('message');
  });

  it('groups 2+ consecutive agent-only tool_groups', () => {
    const msgs = [
      makeAgentToolGroup('1'),
      makeAgentToolGroup('2'),
      makeAgentToolGroup('3'),
    ];
    const items = groupParallelAgents(msgs);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('parallel_agents');
    if (items[0].type === 'parallel_agents') {
      expect(items[0].agents).toHaveLength(3);
      expect(items[0].agents[0].callId).toBe('call-1');
      expect(items[0].agents[2].callId).toBe('call-3');
    }
  });

  it('carries the first launch time onto the grouped parallel-agents row', () => {
    const msgs = [
      makeAgentToolGroup('1', 'Agent', 1000),
      makeAgentToolGroup('2', 'Agent', 2000),
    ];
    const items = groupParallelAgents(msgs);
    expect(items[0].type).toBe('parallel_agents');
    if (items[0].type === 'parallel_agents') {
      expect(items[0].timestamp).toBe(1000);
    }
  });

  it('non-agent message breaks the group', () => {
    const msgs = [
      makeAgentToolGroup('1'),
      makeAgentToolGroup('2'),
      makeAssistantMessage('3'),
      makeAgentToolGroup('4'),
      makeAgentToolGroup('5'),
    ];
    const items = groupParallelAgents(msgs);
    expect(items).toHaveLength(3);
    expect(items[0].type).toBe('parallel_agents');
    expect(items[1].type).toBe('message');
    expect(items[2].type).toBe('parallel_agents');
  });

  it('multi-tool tool_group is not grouped as agent', () => {
    const msgs = [
      makeAgentToolGroup('1'),
      makeMultiToolGroup('2'),
      makeAgentToolGroup('3'),
    ];
    const items = groupParallelAgents(msgs);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.type === 'message')).toBe(true);
  });

  it('non-agent tool names are not grouped', () => {
    const msgs: Message[] = [
      {
        id: '1',
        role: 'tool_group',
        tools: [{ callId: 'c1', toolName: 'Read', status: 'completed' }],
      },
      {
        id: '2',
        role: 'tool_group',
        tools: [{ callId: 'c2', toolName: 'Write', status: 'completed' }],
      },
    ];
    const items = groupParallelAgents(msgs);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.type === 'message')).toBe(true);
  });

  it('preserves non-tool_group messages as-is', () => {
    const msgs = [
      makeUserMessage('1'),
      makeAssistantMessage('2'),
      makeUserMessage('3'),
    ];
    const items = groupParallelAgents(msgs);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.type === 'message')).toBe(true);
  });

  it('groups Task tool calls as sub-agents', () => {
    const msgs: Message[] = [
      {
        id: '1',
        role: 'tool_group',
        tools: [{ callId: 'c1', toolName: 'Task', status: 'in_progress' }],
      },
      {
        id: '2',
        role: 'tool_group',
        tools: [{ callId: 'c2', toolName: 'Task', status: 'completed' }],
      },
    ];
    const items = groupParallelAgents(msgs);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('parallel_agents');
  });

  it('mixed agent and user messages produce correct order', () => {
    const msgs = [
      makeUserMessage('u1'),
      makeAgentToolGroup('a1'),
      makeAgentToolGroup('a2'),
      makeAssistantMessage('r1'),
      makeAgentToolGroup('a3'),
    ];
    const items = groupParallelAgents(msgs);
    expect(items).toHaveLength(4);
    expect(items[0].type).toBe('message');
    expect(items[1].type).toBe('parallel_agents');
    expect(items[2].type).toBe('message');
    expect(items[3].type).toBe('message');
  });

  it('groups background agents separated by thought-only launch narration', () => {
    const msgs = [
      makeBackgroundAgentToolGroup('a1'),
      makeThoughtMessage('t1'),
      makeBackgroundAgentToolGroup('a2'),
    ];
    const items = groupParallelAgents(msgs);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('parallel_agents');
    if (items[0].type === 'parallel_agents') {
      expect(items[0].agents.map((a) => a.callId)).toEqual([
        'call-a1',
        'call-a2',
      ]);
    }
  });

  it('preserves background thought narration when it is not between launches', () => {
    const msgs = [
      makeBackgroundAgentToolGroup('a1'),
      makeThoughtMessage('t1'),
      makeBackgroundAgentToolGroup('a2'),
      makeThoughtMessage('t2'),
    ];
    const items = groupParallelAgents(msgs);
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe('parallel_agents');
    expect(items[1].type).toBe('message');
    if (items[1].type === 'message') {
      expect(items[1].message.id).toBe('t2');
    }
  });
});

describe('getDisplayItemVirtualKey', () => {
  it('keeps message and grouped rows in separate key namespaces', () => {
    expect(
      getDisplayItemVirtualKey({
        type: 'message',
        key: 'header',
        message: makeUserMessage('header'),
      }),
    ).toBe('msg:header');
    expect(
      getDisplayItemVirtualKey({
        type: 'parallel_agents',
        key: 'header',
        agents: [makeAgentToolGroup('a').tools[0]],
      }),
    ).toBe('group:header');
  });
});

describe('shouldUseVirtualScroll', () => {
  it('enables virtual scrolling only above the default threshold', () => {
    expect(shouldUseVirtualScroll(VIRTUAL_SCROLL_THRESHOLD - 1)).toBe(false);
    expect(shouldUseVirtualScroll(VIRTUAL_SCROLL_THRESHOLD)).toBe(false);
    expect(shouldUseVirtualScroll(VIRTUAL_SCROLL_THRESHOLD + 1)).toBe(true);
  });

  it('accepts a custom threshold', () => {
    expect(shouldUseVirtualScroll(50, 50)).toBe(false);
    expect(shouldUseVirtualScroll(51, 50)).toBe(true);
  });
});

describe('findDisplayItemIndex', () => {
  it('finds a row by message id', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      makeUserMessage('u2'),
    ]);
    expect(findDisplayItemIndex(items, 'g1')).toBe(1);
    expect(findDisplayItemIndex(items, 'missing')).toBe(-1);
  });

  it('falls back to the call id when the message id was merged away', () => {
    // Simulates compact mode, where consecutive tool groups collapse into
    // the first group's message id.
    const merged: Message = {
      id: 'g1',
      role: 'tool_group',
      tools: [
        { callId: 'call-a', toolName: 'Read', status: 'completed' },
        { callId: 'call-b', toolName: 'TodoWrite', status: 'completed' },
      ],
    };
    const items = groupParallelAgents([makeUserMessage('u1'), merged]);
    expect(findDisplayItemIndex(items, 'g2', 'call-b')).toBe(1);
    expect(findDisplayItemIndex(items, 'g2', 'call-x')).toBe(-1);
  });

  it('finds tool calls grouped into a parallel agents row', () => {
    const items = groupParallelAgents([
      makeAgentToolGroup('a1'),
      makeAgentToolGroup('a2'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('parallel_agents');
    expect(findDisplayItemIndex(items, 'a2', 'call-a2')).toBe(0);
  });
});

function collapseItems(
  items: DisplayItem[],
  opts: Partial<{
    overrides: Map<string, boolean>;
    isResponding: boolean;
    pendingApprovalCallId: string | null;
    enabled: boolean;
  }> = {},
): DisplayItem[] {
  return applyTurnCollapse(items, {
    overrides: opts.overrides ?? new Map(),
    isResponding: opts.isResponding ?? false,
    pendingApprovalCallId: opts.pendingApprovalCallId ?? null,
    enabled: opts.enabled ?? true,
  });
}

function rowIds(items: DisplayItem[]): string[] {
  return items.map((item) =>
    item.type === 'message' ? item.message.id : item.key,
  );
}

describe('applyTurnCollapse', () => {
  it('returns the same array reference when disabled', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      makeAssistantMessage('a1'),
    ]);
    expect(collapseItems(items, { enabled: false })).toBe(items);
  });

  it('returns the same array reference when there are no turns', () => {
    const items = groupParallelAgents([
      makeAssistantMessage('a1'),
      makeMultiToolGroup('g1'),
    ]);
    expect(collapseItems(items)).toBe(items);
  });

  it('collapses a completed turn to prompt + final answer and tags the head', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      makeAssistantMessage('a1'),
    ]);
    const out = collapseItems(items);
    expect(rowIds(out)).toEqual(['u1', 'a1']);
    expect(messageRow(out[0]).collapse).toEqual({
      turnId: 'u1',
      collapsed: true,
      hiddenCount: 1,
    });
    expect(messageRow(out[1]).collapse).toBeUndefined();
  });

  it('keeps every row but still tags the head when the turn is expanded', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      makeAssistantMessage('a1'),
    ]);
    const out = collapseItems(items, {
      overrides: new Map([['u1', true]]),
    });
    expect(rowIds(out)).toEqual(['u1', 'g1', 'a1']);
    expect(messageRow(out[0]).collapse).toEqual({
      turnId: 'u1',
      collapsed: false,
      hiddenCount: 1,
    });
  });

  it('tags but keeps the active turn expanded while responding', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      makeAssistantMessage('a1'),
    ]);
    const out = collapseItems(items, { isResponding: true });
    // Every row stays visible; the head carries the seam but is not collapsed.
    // While live there is no final answer, so the trailing assistant text counts
    // as a step too (tool group + assistant text = 2).
    expect(rowIds(out)).toEqual(['u1', 'g1', 'a1']);
    expect(messageRow(out[0]).collapse?.collapsed).toBe(false);
    expect(messageRow(out[0]).collapse?.hiddenCount).toBe(2);
  });

  it('collapsing the active turn folds to prompt + seam (no stranded line)', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      // An intermediate status line, not a final answer — the turn is still live.
      { id: 'a1', role: 'assistant', content: 'Deterministic analysis clean…' },
    ]);
    const out = collapseItems(items, {
      isResponding: true,
      overrides: new Map([['u1', false]]),
    });
    // No final answer yet, so the fold drops the intermediate text too — only
    // the prompt row (carrying the seam) survives.
    expect(rowIds(out)).toEqual(['u1']);
    expect(messageRow(out[0]).collapse?.collapsed).toBe(true);
  });

  it('collapses earlier turns but leaves the active last turn expanded', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      makeAssistantMessage('a1'),
      makeUserMessage('u2'),
      makeMultiToolGroup('g2'),
    ]);
    const out = collapseItems(items, { isResponding: true });
    expect(rowIds(out)).toEqual(['u1', 'a1', 'u2', 'g2']);
    expect(messageRow(out[0]).collapse?.collapsed).toBe(true);
    expect(messageRow(out[2]).collapse?.collapsed).toBe(false);
  });

  it('shows live metrics on the active turn without collapsing it', () => {
    const items = groupParallelAgents([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1_000 },
      {
        id: 'g1',
        role: 'tool_group',
        tools: [{ callId: 'c1', toolName: 'Read', status: 'in_progress' }],
        timestamp: 3_000,
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'working',
        timestamp: 3_500,
        usage: { inputTokens: 120, outputTokens: 30 },
      },
    ]);
    const out = collapseItems(items, { isResponding: true });
    // Active turn stays fully expanded, yet the seam carries live metrics.
    expect(rowIds(out)).toEqual(['u1', 'g1', 'a1']);
    const head = messageRow(out[0]).collapse;
    expect(head?.collapsed).toBe(false);
    expect(head?.elapsedMs).toBe(2_500);
    expect(head?.inputTokens).toBe(120);
    expect(head?.outputTokens).toBe(30);
  });

  it('does not tag a turn with no intermediate steps', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeAssistantMessage('a1'),
    ]);
    const out = collapseItems(items);
    expect(rowIds(out)).toEqual(['u1', 'a1']);
    expect(messageRow(out[0]).collapse).toBeUndefined();
  });

  it('folds a turn with no final answer down to just the prompt', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      makeMultiToolGroup('g2'),
    ]);
    const out = collapseItems(items);
    expect(rowIds(out)).toEqual(['u1']);
    expect(messageRow(out[0]).collapse).toEqual({
      turnId: 'u1',
      collapsed: true,
      hiddenCount: 2,
    });
  });

  it("strips the final answer's thinking only while collapsed", () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      makeAnswerWithThinking('a1'),
    ]);
    const collapsed = collapseItems(items);
    expect(rowIds(collapsed)).toEqual(['u1', 'a1']);
    const collapsedAnswer = messageRow(collapsed[1]).message;
    expect(collapsedAnswer.role).toBe('assistant');
    if (collapsedAnswer.role === 'assistant') {
      expect(collapsedAnswer.thinking).toBeUndefined();
      expect(collapsedAnswer.content).toBe('final answer');
    }

    const expanded = collapseItems(items, {
      overrides: new Map([['u1', true]]),
    });
    const expandedAnswer = messageRow(expanded[2]).message;
    if (expandedAnswer.role === 'assistant') {
      expect(expandedAnswer.thinking).toBe('pondering');
    }
  });

  it('passes through rows that precede the first turn', () => {
    const items = groupParallelAgents([
      makeAssistantMessage('pre'),
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      makeAssistantMessage('a1'),
    ]);
    const out = collapseItems(items);
    expect(rowIds(out)).toEqual(['pre', 'u1', 'a1']);
    expect(messageRow(out[0]).collapse).toBeUndefined();
    expect(messageRow(out[1]).collapse?.collapsed).toBe(true);
  });

  it('keeps system rows (errors/output) visible while hiding tool steps', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      makeSystemMessage('s1'),
      makeAssistantMessage('a1'),
    ]);
    const out = collapseItems(items);
    expect(rowIds(out)).toEqual(['u1', 's1', 'a1']);
    expect(messageRow(out[0]).collapse?.hiddenCount).toBe(1);
  });

  it('does not collapse a turn whose only response is a system row', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeSystemMessage('s1'),
    ]);
    const out = collapseItems(items);
    expect(rowIds(out)).toEqual(['u1', 's1']);
    expect(messageRow(out[0]).collapse).toBeUndefined();
  });

  it('hides mid-turn assistant narration but keeps the final answer', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeAssistantMessage('mid'),
      makeMultiToolGroup('g1'),
      makeAssistantMessage('a1'),
    ]);
    const out = collapseItems(items);
    expect(rowIds(out)).toEqual(['u1', 'a1']);
    expect(messageRow(out[0]).collapse?.hiddenCount).toBe(2);
  });

  it('hides plan rows', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makePlanMessage('p1'),
      makeAssistantMessage('a1'),
    ]);
    const out = collapseItems(items);
    expect(rowIds(out)).toEqual(['u1', 'a1']);
    expect(messageRow(out[0]).collapse?.hiddenCount).toBe(1);
  });

  it('counts a grouped parallel-agents row as one hidden step', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeAgentToolGroup('x1'),
      makeAgentToolGroup('x2'),
      makeAssistantMessage('a1'),
    ]);
    // x1/x2 collapse into a single parallel_agents row upstream.
    const out = collapseItems(items);
    expect(rowIds(out)).toEqual(['u1', 'a1']);
    expect(messageRow(out[0]).collapse?.hiddenCount).toBe(1);
  });

  it('treats an assistant row with undefined content as a non-answer without crashing', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      // Daemon SSE can leave content undefined despite the `string` type.
      { id: 'x', role: 'assistant', content: undefined as unknown as string },
    ]);
    const out = collapseItems(items);
    // No assistant-with-content → no final answer → fold to just the prompt.
    expect(rowIds(out)).toEqual(['u1']);
    expect(messageRow(out[0]).collapse?.hiddenCount).toBe(2);
  });

  it('force-expands a completed turn that holds a pending approval', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      makeAssistantMessage('a1'),
    ]);
    // call-g1-a belongs to g1's tool group → the turn must stay expanded so
    // its inline approve/reject UI is reachable.
    const out = collapseItems(items, { pendingApprovalCallId: 'call-g1-a' });
    expect(rowIds(out)).toEqual(['u1', 'g1', 'a1']);
    expect(messageRow(out[0]).collapse).toBeUndefined();
  });

  it('still collapses when the pending approval is in a different turn', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      makeAssistantMessage('a1'),
    ]);
    const out = collapseItems(items, { pendingApprovalCallId: 'call-other' });
    expect(rowIds(out)).toEqual(['u1', 'a1']);
    expect(messageRow(out[0]).collapse?.collapsed).toBe(true);
  });

  it('records elapsed (prompt → last step) and token usage on the head', () => {
    const items = groupParallelAgents([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1_000 },
      {
        id: 'g1',
        role: 'tool_group',
        tools: [{ callId: 'c1', toolName: 'Read', status: 'completed' }],
        timestamp: 2_000,
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'final',
        timestamp: 5_000,
        usage: { inputTokens: 3100, outputTokens: 5100 },
      },
    ]);
    const out = collapseItems(items);
    expect(messageRow(out[0]).collapse).toEqual({
      turnId: 'u1',
      collapsed: true,
      hiddenCount: 1,
      elapsedMs: 4_000,
      inputTokens: 3100,
      outputTokens: 5100,
    });
  });

  it('sums token usage across a turn (hidden mid-turn text + final answer)', () => {
    const items = groupParallelAgents([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1_000 },
      {
        id: 'a0',
        role: 'assistant',
        content: 'mid-turn note',
        timestamp: 2_000,
        usage: { inputTokens: 100, outputTokens: 50 },
      },
      {
        id: 'g1',
        role: 'tool_group',
        tools: [{ callId: 'c1', toolName: 'Read', status: 'completed' }],
        timestamp: 3_000,
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'final',
        timestamp: 4_000,
        usage: { inputTokens: 200, outputTokens: 80 },
      },
    ]);
    const head = messageRow(collapseItems(items)[0]).collapse;
    expect(head?.inputTokens).toBe(300);
    expect(head?.outputTokens).toBe(130);
    expect(head?.elapsedMs).toBe(3_000);
  });

  it('omits elapsed/usage when the turn carries no timestamps or usage', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      makeAssistantMessage('a1'),
    ]);
    const head = messageRow(collapseItems(items)[0]).collapse;
    expect(head).toEqual({ turnId: 'u1', collapsed: true, hiddenCount: 1 });
  });
});

describe('findTurnIdForIndex', () => {
  it('maps each row to the prompt that heads its turn', () => {
    const items = groupParallelAgents([
      makeUserMessage('u1'),
      makeMultiToolGroup('g1'),
      makeUserMessage('u2'),
      makeMultiToolGroup('g2'),
    ]);
    expect(findTurnIdForIndex(items, 0)).toBe('u1');
    expect(findTurnIdForIndex(items, 1)).toBe('u1');
    expect(findTurnIdForIndex(items, 2)).toBe('u2');
    expect(findTurnIdForIndex(items, 3)).toBe('u2');
  });

  it('returns null for rows before the first turn', () => {
    const items = groupParallelAgents([
      makeAssistantMessage('pre'),
      makeUserMessage('u1'),
    ]);
    expect(findTurnIdForIndex(items, 0)).toBeNull();
  });
});
