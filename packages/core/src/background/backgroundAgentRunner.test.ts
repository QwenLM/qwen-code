/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentEventEmitter, AgentEventType, AgentTerminateMode } from '../agents/index.js';
import { BackgroundAgentRunner } from './backgroundAgentRunner.js';

describe('BackgroundAgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs a headless agent and maps events into background task state', async () => {
    const createMock = vi.fn().mockImplementation(async (
      _name,
      _runtimeContext,
      _promptConfig,
      _modelConfig,
      _runConfig,
      _toolConfig,
      eventEmitter?: AgentEventEmitter,
    ) => ({
      execute: async () => {
        eventEmitter?.emit(AgentEventType.ROUND_START, {
          subagentId: 'agent-1',
          round: 1,
          promptId: 'prompt-1',
          timestamp: Date.now(),
        });
        eventEmitter?.emit(AgentEventType.STREAM_TEXT, {
          subagentId: 'agent-1',
          round: 1,
          text: 'Working on it',
          thought: false,
          timestamp: Date.now(),
        });
        eventEmitter?.emit(AgentEventType.TOOL_CALL, {
          subagentId: 'agent-1',
          round: 1,
          callId: 'call-1',
          name: 'read_file',
          args: { filePath: '/tmp/project/user.md' },
          description: 'Read a file',
          timestamp: Date.now(),
        });
        eventEmitter?.emit(AgentEventType.USAGE_METADATA, {
          subagentId: 'agent-1',
          round: 1,
          usage: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
          },
          timestamp: Date.now(),
        });
      },
      getTerminateMode: () => AgentTerminateMode.GOAL,
      getFinalText: () => 'Done',
    }));

    const runner = new BackgroundAgentRunner(undefined, undefined, undefined, createMock);
    const result = await runner.run({
      taskType: 'background-agent',
      title: 'Review code',
      description: 'Run a background code review',
      projectRoot: '/tmp/project',
      name: 'code-reviewer',
      runtimeContext: {} as never,
      taskPrompt: 'Review the recent code changes',
      promptConfig: { systemPrompt: 'You are a reviewer.' },
      modelConfig: { model: 'qwen3-coder-plus' },
      runConfig: { max_turns: 3 },
    });

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('Done');
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    expect(result.roundCount).toBe(1);
    expect(result.filesTouched).toEqual(['/tmp/project/user.md']);

    const tasks = runner.registry.list('/tmp/project');
    expect(tasks[0]?.progressText).toBe('Done');
    expect(tasks[0]?.metadata).toEqual(
      expect.objectContaining({
        allowedTools: ['*'],
        currentRound: 1,
        filesTouched: ['/tmp/project/user.md'],
        lastToolCall: 'read_file',
      }),
    );
  });

  it('marks background agent as failed when terminate mode is error', async () => {
    const createMock = vi.fn().mockResolvedValue({
      execute: vi.fn().mockResolvedValue(undefined),
      getTerminateMode: () => AgentTerminateMode.ERROR,
      getFinalText: () => '',
    });

    const runner = new BackgroundAgentRunner(undefined, undefined, undefined, createMock);
    const result = await runner.run({
      taskType: 'background-agent',
      title: 'Review code',
      description: 'Run a background code review',
      projectRoot: '/tmp/project',
      name: 'code-reviewer',
      runtimeContext: {} as never,
      taskPrompt: 'Review the recent code changes',
      promptConfig: { systemPrompt: 'You are a reviewer.' },
      modelConfig: { model: 'qwen3-coder-plus' },
      runConfig: { max_turns: 3 },
    });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('Background agent terminated with ERROR');
  });

  it('returns cancelled when the headless agent is aborted', async () => {
    const createMock = vi.fn().mockResolvedValue({
      execute: vi.fn().mockResolvedValue(undefined),
      getTerminateMode: () => AgentTerminateMode.CANCELLED,
      getFinalText: () => '',
    });

    const runner = new BackgroundAgentRunner(undefined, undefined, undefined, createMock);
    const result = await runner.run({
      taskType: 'background-agent',
      title: 'Review code',
      description: 'Run a background code review',
      projectRoot: '/tmp/project',
      name: 'code-reviewer',
      runtimeContext: {} as never,
      taskPrompt: 'Review the recent code changes',
      promptConfig: { systemPrompt: 'You are a reviewer.' },
      modelConfig: { model: 'qwen3-coder-plus' },
      runConfig: { max_turns: 3 },
    });

    expect(result.status).toBe('cancelled');
    expect(result.error).toContain('CANCELLED');
  });
});
