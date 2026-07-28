/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import { BackgroundTaskRegistry } from '../agents/background-tasks.js';
import { ListAgentsTool } from './list-agents.js';

describe('ListAgentsTool', () => {
  let registry: BackgroundTaskRegistry;
  let tool: ListAgentsTool;

  beforeEach(() => {
    registry = new BackgroundTaskRegistry();
    tool = new ListAgentsTool({
      getBackgroundTaskRegistry: () => registry,
    } as unknown as Config);
  });

  it('reports an empty roster', async () => {
    const result = await tool.validateBuildAndExecute(
      {},
      new AbortController().signal,
    );

    expect(tool.name).toBe('list_agents');
    expect(result.llmContent).toBe(
      'No background agents are available in this session.',
    );
  });

  it('lists only background agents with stable continuation fields', async () => {
    registry.register({
      agentId: 'agent-running',
      subagentType: 'explore',
      description: 'Inspect runtime',
      isBackgrounded: true,
      status: 'running',
      startTime: 1,
      abortController: new AbortController(),
      outputFile: '/tmp/agent-running.jsonl',
    });
    registry.register({
      agentId: 'agent-foreground',
      description: 'Inline work',
      isBackgrounded: false,
      status: 'running',
      startTime: 2,
      abortController: new AbortController(),
      outputFile: '/tmp/agent-foreground.jsonl',
    });
    registry.register({
      agentId: 'agent-blocked',
      description: 'Unsafe restore',
      isBackgrounded: true,
      status: 'completed',
      startTime: 3,
      endTime: 4,
      abortController: new AbortController(),
      outputFile: '/tmp/agent-blocked.jsonl',
      resumeBlockedReason: 'Transcript does not match.',
    });

    const result = await tool.validateBuildAndExecute(
      {},
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.llmContent))).toEqual({
      agents: [
        {
          task_id: 'agent-running',
          subagent_type: 'explore',
          description: 'Inspect runtime',
          status: 'running',
          can_message: true,
        },
        {
          task_id: 'agent-blocked',
          description: 'Unsafe restore',
          status: 'completed',
          can_message: false,
          resume_blocked_reason: 'Transcript does not match.',
        },
      ],
    });
  });
});
