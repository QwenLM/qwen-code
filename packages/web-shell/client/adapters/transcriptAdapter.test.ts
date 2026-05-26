import { describe, expect, it } from 'vitest';
import type {
  DaemonStatusTranscriptBlock,
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
  DaemonTranscriptBlock,
  DaemonTranscriptState,
} from '@qwen-code/sdk/daemon';
import {
  extractPendingPermission,
  extractStreamingState,
  transcriptBlocksToMessages,
} from './transcriptAdapter';

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

function state(blocks: DaemonTranscriptBlock[]): DaemonTranscriptState {
  return {
    blocks,
    blockIndexById: Object.fromEntries(
      blocks.map((block, index) => [block.id, index]),
    ),
    toolBlockByCallId: {},
    trimmedToolNotificationByCallId: {},
    permissionBlockByRequestId: {},
    toolProgress: {},
    nextOrdinal: blocks.length,
    now: Date.now(),
    maxBlocks: 1000,
    awaitingResync: false,
    resyncRequiredCount: 0,
  };
}

describe('transcriptAdapter', () => {
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

    const messages = transcriptBlocksToMessages([
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
    const messages = transcriptBlocksToMessages([
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

  it('extracts pending AskUserQuestion options and raw input', () => {
    const permission = {
      id: 'perm-1',
      kind: 'permission',
      requestId: 'request-1',
      sessionId: 'session-1',
      title: 'Ask user 1 question',
      options: [
        {
          optionId: 'proceed_once',
          label: 'Submit',
          raw: { kind: 'allow_once', name: 'Submit' },
        },
        {
          optionId: 'cancel',
          label: 'Cancel',
          raw: { kind: 'reject_once', name: 'Cancel' },
        },
      ],
      toolCall: {
        rawInput: {
          questions: [
            {
              header: '姓名',
              question: '请问学生姓名是什么？',
              options: [{ label: '张三', description: '示例姓名' }],
            },
          ],
        },
      },
      preview: { kind: 'generic' },
      createdAt: 1,
      updatedAt: 1,
    } as DaemonTranscriptBlock;

    expect(extractPendingPermission(state([permission]).blocks)).toMatchObject({
      id: 'request-1',
      sessionId: 'session-1',
      title: 'Ask user 1 question',
      options: [
        { id: 'proceed_once', label: 'Submit', kind: 'allow_once' },
        { id: 'cancel', label: 'Cancel', kind: 'reject_once' },
      ],
      rawInput: {
        questions: [
          {
            header: '姓名',
            question: '请问学生姓名是什么？',
            options: [{ label: '张三', description: '示例姓名' }],
          },
        ],
      },
    });
  });

  it('extracts toolCallId from toolCall.toolCallId', () => {
    const permission = {
      id: 'perm-tc1',
      kind: 'permission',
      sessionId: 'session-1',
      requestId: 'request-tc1',
      resolved: undefined,
      title: 'Bash: ls',
      options: [{ optionId: 'allow', label: 'Allow', raw: {} }],
      toolCall: { toolCallId: 'call-abc', rawInput: {} },
      preview: { kind: 'generic' },
      createdAt: 1,
      updatedAt: 1,
      clientReceivedAt: 1,
    } as DaemonTranscriptBlock;

    const result = extractPendingPermission(state([permission]).blocks);
    expect(result?.toolCallId).toBe('call-abc');
  });

  it('falls back to toolCall.id when toolCallId is absent', () => {
    const permission = {
      id: 'perm-tc2',
      kind: 'permission',
      sessionId: 'session-1',
      requestId: 'request-tc2',
      resolved: undefined,
      title: 'Bash: pwd',
      options: [{ optionId: 'allow', label: 'Allow', raw: {} }],
      toolCall: { id: 'call-xyz', rawInput: {} },
      preview: { kind: 'generic' },
      createdAt: 1,
      updatedAt: 1,
      clientReceivedAt: 1,
    } as DaemonTranscriptBlock;

    const result = extractPendingPermission(state([permission]).blocks);
    expect(result?.toolCallId).toBe('call-xyz');
  });

  it('returns undefined toolCallId when toolCall has neither field', () => {
    const permission = {
      id: 'perm-tc3',
      kind: 'permission',
      sessionId: 'session-1',
      requestId: 'request-tc3',
      resolved: undefined,
      title: 'Read: file',
      options: [{ optionId: 'allow', label: 'Allow', raw: {} }],
      toolCall: { rawInput: {} },
      preview: { kind: 'generic' },
      createdAt: 1,
      updatedAt: 1,
      clientReceivedAt: 1,
    } as DaemonTranscriptBlock;

    const result = extractPendingPermission(state([permission]).blocks);
    expect(result?.toolCallId).toBeUndefined();
  });

  it('keeps assistant chunks inside an active subagent until completion', () => {
    const messages = transcriptBlocksToMessages([
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

  it('merges streaming assistant chunks into one message', () => {
    const messages = transcriptBlocksToMessages([
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

describe('extractStreamingState', () => {
  it('returns idle for empty blocks', () => {
    expect(extractStreamingState(state([]).blocks)).toBe('idle');
  });

  it('returns thinking when last block is a streaming thought', () => {
    expect(
      extractStreamingState(
        state([textBlock('t1', 'thought', 'thinking...', 1, true)]).blocks,
      ),
    ).toBe('thinking');
  });

  it('returns responding when last block is a streaming assistant', () => {
    expect(
      extractStreamingState(
        state([textBlock('a1', 'assistant', 'hello', 1, true)]).blocks,
      ),
    ).toBe('responding');
  });

  it('returns responding when last tool is in_progress', () => {
    expect(
      extractStreamingState(
        state([toolBlock('t1', 'call-1', 'in_progress', 1)]).blocks,
      ),
    ).toBe('responding');
  });

  it('returns idle when last assistant is not streaming', () => {
    expect(
      extractStreamingState(
        state([textBlock('a1', 'assistant', 'done', 1, false)]).blocks,
      ),
    ).toBe('idle');
  });

  it('returns responding when an earlier tool is still in_progress', () => {
    expect(
      extractStreamingState(
        state([
          toolBlock('t1', 'call-1', 'in_progress', 1),
          textBlock('a1', 'assistant', 'partial', 2, false),
        ]).blocks,
      ),
    ).toBe('responding');
  });

  it('returns idle when all tools are completed after user block', () => {
    expect(
      extractStreamingState(
        state([
          textBlock('u1', 'user', 'hello', 1),
          toolBlock('t1', 'call-1', 'completed', 2),
          textBlock('a1', 'assistant', 'done', 3, false),
        ]).blocks,
      ),
    ).toBe('idle');
  });
});
