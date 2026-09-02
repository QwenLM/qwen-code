import { describe, expect, it } from 'vitest';
import type { Message } from '../../adapters/types';
import { findSubagentRootTool, getSubagentPrompt } from './SubagentDetail';

describe('findSubagentRootTool', () => {
  it('selects the requested agent tool', () => {
    const messages = [
      {
        id: 'tools-1',
        role: 'tool_group',
        tools: [
          {
            callId: 'agent-1',
            toolName: 'agent',
            title: 'agent: 查询阿里云官网信息',
            status: 'in_progress',
            kind: 'agent',
            args: {
              description: '查询阿里云官网信息',
              prompt: '访问官网并整理结果',
              subagent_type: 'general-purpose',
            },
          },
        ],
      },
    ] as Message[];

    expect(findSubagentRootTool(messages, 'agent-1')).toMatchObject({
      callId: 'agent-1',
      title: 'agent: 查询阿里云官网信息',
      status: 'in_progress',
    });
  });

  it('returns undefined when the requested tool is absent', () => {
    expect(findSubagentRootTool([], 'agent-1')).toBeUndefined();
    expect(
      findSubagentRootTool(
        [{ id: 'assistant-1', role: 'assistant', content: 'done' }],
        'agent-1',
      ),
    ).toBeUndefined();
  });
});

describe('getSubagentPrompt', () => {
  const rootTool = {
    callId: 'agent-1',
    toolName: 'agent',
    title: 'agent: investigate',
    status: 'completed',
    kind: 'agent',
    args: { prompt: 'truncated parent prompt' },
  } as const;

  it('prefers the complete child transcript prompt', () => {
    const fullPrompt = `full child prompt ${'x'.repeat(300)}`;
    const messages = [
      { id: 'user-1', role: 'user', content: fullPrompt },
    ] as Message[];

    expect(getSubagentPrompt(messages, rootTool)).toBe(fullPrompt);
  });

  it('falls back to the parent tool prompt before the transcript loads', () => {
    expect(getSubagentPrompt([], rootTool)).toBe('truncated parent prompt');
  });
});
