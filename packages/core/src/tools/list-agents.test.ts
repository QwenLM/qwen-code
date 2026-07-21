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
  let registeredTools: string[];

  beforeEach(() => {
    registry = new BackgroundTaskRegistry();
    registeredTools = ['send_message'];
    tool = new ListAgentsTool({
      getBackgroundTaskRegistry: () => registry,
      getToolRegistry: () => ({
        getAllToolNames: () => registeredTools,
      }),
    } as unknown as Config);
  });

  it('has an empty schema and the expected name', () => {
    expect(tool.name).toBe('list_agents');
    expect(tool.schema.parametersJsonSchema).toMatchObject({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('reports an empty roster', async () => {
    const result = await tool.validateBuildAndExecute(
      {},
      new AbortController().signal,
    );

    expect(result.llmContent).toBe(
      'No background agents are available in this session.',
    );
  });

  it('lists only backgrounded agents with stable continuation fields', async () => {
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
      subagentType: 'general-purpose',
      description: 'Inline work',
      isBackgrounded: false,
      status: 'running',
      startTime: 2,
      abortController: new AbortController(),
      outputFile: '/tmp/agent-foreground.jsonl',
    });
    registry.register({
      agentId: 'agent-completed',
      subagentType: 'general-purpose',
      description: 'Finished first pass',
      isBackgrounded: true,
      status: 'completed',
      startTime: 3,
      endTime: 4,
      abortController: new AbortController(),
      outputFile: '/tmp/agent-completed.jsonl',
    });

    const result = await tool.validateBuildAndExecute(
      {},
      new AbortController().signal,
    );
    const content = JSON.parse(String(result.llmContent)) as {
      agents: Array<Record<string, unknown>>;
    };

    expect(content.agents).toEqual([
      {
        task_id: 'agent-running',
        subagent_type: 'explore',
        description: 'Inspect runtime',
        status: 'running',
        can_message: true,
      },
      {
        task_id: 'agent-completed',
        subagent_type: 'general-purpose',
        description: 'Finished first pass',
        status: 'completed',
        can_message: true,
      },
    ]);
  });

  it('marks blocked and terminal agents as not messageable', async () => {
    registry.register({
      agentId: 'agent-blocked',
      subagentType: 'missing-agent',
      description: 'Cannot restore',
      isBackgrounded: true,
      status: 'paused',
      startTime: 1,
      abortController: new AbortController(),
      outputFile: '/tmp/agent-blocked.jsonl',
      resumeBlockedReason: 'Subagent is unavailable.',
    });
    registry.register({
      agentId: 'agent-failed',
      description: 'Failed work',
      isBackgrounded: true,
      status: 'failed',
      startTime: 2,
      endTime: 3,
      abortController: new AbortController(),
      outputFile: '/tmp/agent-failed.jsonl',
    });

    const result = await tool.validateBuildAndExecute(
      {},
      new AbortController().signal,
    );
    const content = JSON.parse(String(result.llmContent)) as {
      agents: Array<Record<string, unknown>>;
    };

    expect(content.agents).toEqual([
      {
        task_id: 'agent-blocked',
        subagent_type: 'missing-agent',
        description: 'Cannot restore',
        status: 'paused',
        can_message: false,
        resume_blocked_reason: 'Subagent is unavailable.',
      },
      {
        task_id: 'agent-failed',
        description: 'Failed work',
        status: 'failed',
        can_message: false,
      },
    ]);
  });

  it('marks retained agents as not messageable when send_message is unavailable', async () => {
    registeredTools = [];
    tool = new ListAgentsTool({
      getBackgroundTaskRegistry: () => registry,
      getToolRegistry: () => ({
        getAllToolNames: () => registeredTools,
      }),
    } as unknown as Config);
    registry.register({
      agentId: 'agent-completed',
      description: 'Finished work',
      isBackgrounded: true,
      status: 'completed',
      startTime: 1,
      abortController: new AbortController(),
      outputFile: '/tmp/agent-completed.jsonl',
    });

    const result = await tool.validateBuildAndExecute(
      {},
      new AbortController().signal,
    );
    const content = JSON.parse(String(result.llmContent)) as {
      agents: Array<Record<string, unknown>>;
    };

    expect(content.agents[0]).toMatchObject({ can_message: false });
    expect(tool.description).not.toContain('with send_message');
  });
});
