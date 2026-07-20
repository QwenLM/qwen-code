import { describe, expect, it } from 'vitest';
import type { Message } from '../../adapters/types';
import { findSubagentRootTool } from './SubagentDetail';

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
});
