import { describe, expect, it } from 'vitest';
import type { Message } from '../adapters/types';
import {
  findDisplayItemIndex,
  getDisplayItemVirtualKey,
  groupParallelAgents,
  shouldUseVirtualScroll,
  VIRTUAL_SCROLL_THRESHOLD,
} from './MessageList';

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
