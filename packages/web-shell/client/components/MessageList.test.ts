import { describe, expect, it } from 'vitest';
import type { Message } from '../adapters/types';
import { groupParallelAgents } from './MessageList';

function makeAgentToolGroup(id: string, toolName = 'Agent'): Message {
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
});
