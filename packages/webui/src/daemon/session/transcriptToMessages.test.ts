import { describe, expect, it } from 'vitest';
import type {
  DaemonStatusTranscriptBlock,
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { transcriptBlocksToDaemonMessages } from './transcriptToMessages.js';

function textBlock(
  id: string,
  kind: 'user' | 'assistant' | 'thought',
  text: string,
  createdAt: number,
  streaming = false,
): DaemonTextTranscriptBlock {
  return {
    id,
    kind,
    text,
    streaming,
    clientReceivedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
}

function statusBlock(
  id: string,
  text: string,
  createdAt: number,
): DaemonStatusTranscriptBlock {
  return {
    id,
    kind: 'status',
    text,
    clientReceivedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
}

function toolBlock(
  id: string,
  toolCallId: string,
  status: string,
  createdAt: number,
  overrides: Partial<DaemonToolTranscriptBlock> = {},
): DaemonToolTranscriptBlock {
  return {
    id,
    kind: 'tool',
    toolCallId,
    title: overrides.title ?? 'Tool',
    status,
    toolName: overrides.toolName ?? 'Read',
    toolKind: overrides.toolKind,
    preview: overrides.preview ?? { kind: 'generic' },
    rawInput: overrides.rawInput,
    rawOutput: overrides.rawOutput,
    content: overrides.content,
    locations: overrides.locations,
    details: overrides.details,
    clientReceivedAt: createdAt,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
  };
}

describe('transcriptBlocksToDaemonMessages', () => {
  it('renders daemon plan status blocks as plan messages', () => {
    const plan = {
      sessionUpdate: 'plan',
      entries: [
        {
          content: '检查项目结构',
          priority: 'medium',
          status: 'pending',
        },
        {
          content: '运行类型检查',
          priority: 'high',
          status: 'in_progress',
        },
      ],
    };

    const messages = transcriptBlocksToDaemonMessages([
      statusBlock('plan-1', `plan: ${JSON.stringify(plan)}`, 1),
    ]);

    expect(messages).toEqual([
      {
        id: 'plan-1',
        role: 'plan',
        todos: [
          {
            id: 'plan-0',
            content: '检查项目结构',
            priority: 'medium',
            status: 'pending',
          },
          {
            id: 'plan-1',
            content: '运行类型检查',
            priority: 'high',
            status: 'in_progress',
          },
        ],
      },
    ]);
  });

  it('keeps TodoWrite blocks as tool messages and does not aggregate tools', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('todo-1', 'todo-call-1', 'completed', 1, {
        title: 'Update Todos',
        toolName: 'TodoWrite',
        rawInput: {
          todos: [
            {
              content: '检查项目结构',
              priority: 'medium',
              status: 'completed',
            },
          ],
        },
      }),
      toolBlock('todo-2', 'todo-call-2', 'completed', 2, {
        title: 'Update Todos',
        toolName: 'TodoWrite',
        rawInput: {
          todos: [
            {
              content: '运行类型检查',
              priority: 'high',
              status: 'in_progress',
            },
          ],
        },
      }),
    ]);

    expect(messages).toEqual([
      {
        id: 'tg-todo-1',
        role: 'tool_group',
        tools: [
          expect.objectContaining({
            callId: 'todo-call-1',
            toolName: 'TodoWrite',
          }),
        ],
      },
      {
        id: 'tg-todo-2',
        role: 'tool_group',
        tools: [
          expect.objectContaining({
            callId: 'todo-call-2',
            toolName: 'TodoWrite',
          }),
        ],
      },
    ]);
  });

  it('keeps assistant chunks inside an active subagent until completion', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-start', 'agent-1', 'in_progress', 10, {
        title: 'Agent: 分析项目',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      textBlock('assistant-sub', 'assistant', 'subagent output', 20, true),
      toolBlock('read-sub', 'read-1', 'completed', 30, {
        title: 'Read file',
        toolName: 'Read',
      }),
      toolBlock('agent-end', 'agent-1', 'completed', 40, {
        title: 'Agent: 分析项目',
        toolName: 'agent',
        rawOutput: { type: 'task_execution' },
      }),
      textBlock('assistant-main', 'assistant', 'main output', 50, false),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'tool_group',
      tools: [
        {
          callId: 'agent-1',
          status: 'completed',
          subContent: 'subagent output',
          subTools: [{ callId: 'read-1', status: 'completed' }],
        },
      ],
    });
    expect(messages[1]).toMatchObject({
      id: 'assistant-main',
      role: 'assistant',
      content: 'main output',
    });
  });

  it('keeps parallel top-level subagents as sibling tool messages', () => {
    const messages = transcriptBlocksToDaemonMessages([
      toolBlock('agent-1', 'agent-call-1', 'in_progress', 10, {
        title: 'Agent: Correctness review agent',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      toolBlock('agent-2', 'agent-call-2', 'in_progress', 20, {
        title: 'Agent: Security review agent',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
      toolBlock('agent-3', 'agent-call-3', 'in_progress', 30, {
        title: 'Agent: Performance review agent',
        toolName: 'agent',
        rawInput: { subagent_type: 'general-purpose' },
      }),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages).toMatchObject([
      {
        role: 'tool_group',
        tools: [{ callId: 'agent-call-1' }],
      },
      {
        role: 'tool_group',
        tools: [{ callId: 'agent-call-2' }],
      },
      {
        role: 'tool_group',
        tools: [{ callId: 'agent-call-3' }],
      },
    ]);
    expect(
      messages[0]?.role === 'tool_group' && messages[0].tools[0],
    ).not.toHaveProperty('subTools');
    expect(
      messages[1]?.role === 'tool_group' && messages[1].tools[0],
    ).not.toHaveProperty('subTools');
    expect(
      messages[2]?.role === 'tool_group' && messages[2].tools[0],
    ).not.toHaveProperty('subTools');
  });

  it('merges streaming assistant chunks into one message', () => {
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('a1', 'assistant', 'hello ', 1, true),
      textBlock('a2', 'assistant', 'world', 2, false),
    ]);

    expect(messages).toEqual([
      {
        id: 'a1',
        role: 'assistant',
        content: 'hello world',
        isStreaming: false,
      },
    ]);
  });
});
