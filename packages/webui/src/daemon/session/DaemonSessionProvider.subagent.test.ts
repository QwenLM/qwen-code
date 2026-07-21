import { describe, expect, it } from 'vitest';
import type { DaemonUiEvent } from '@qwen-code/sdk/daemon';
import { projectMainTranscriptEventsForTesting } from './DaemonSessionProvider.js';

describe('on-demand subagent transcript projection', () => {
  it('drops child events and bounds the root agent payload', () => {
    const events: DaemonUiEvent[] = [
      {
        type: 'tool.update',
        toolCallId: 'agent-1',
        toolName: 'agent',
        status: 'completed',
        rawInput: {
          subagent_type: 'explore',
          prompt: 'p'.repeat(400),
        },
        rawOutput: {
          type: 'task_execution',
          status: 'completed',
          terminateReason: 'max_turns',
          result: 'large result',
          toolCalls: [{ callId: 'read-1' }],
          executionSummary: {
            totalToolCalls: 1,
            inputTokens: 100,
            outputTokens: 20,
            cachedTokens: 40,
            totalTokens: 120,
          },
        },
      },
      {
        type: 'assistant.text.delta',
        text: 'child output',
        parentToolCallId: 'agent-1',
      },
      {
        type: 'tool.update',
        toolCallId: 'read-1',
        toolName: 'read_file',
        parentToolCallId: 'agent-1',
        rawOutput: 'file contents',
      },
      {
        type: 'assistant.usage',
        usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 8 },
        parentToolCallId: 'agent-1',
      },
    ];

    const result = projectMainTranscriptEventsForTesting(events);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: 'tool.update',
      toolCallId: 'agent-1',
      rawInput: { subagent_type: 'explore' },
      rawOutput: {
        type: 'task_execution',
        status: 'completed',
        terminateReason: 'max_turns',
        executionSummary: {
          totalToolCalls: 1,
          inputTokens: 100,
          outputTokens: 20,
          cachedTokens: 40,
          totalTokens: 120,
        },
      },
    });
    expect(result[1]).toMatchObject({
      type: 'assistant.usage',
      usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 8 },
      parentToolCallId: 'agent-1',
    });
    expect(result[0]).not.toHaveProperty('rawOutput.result');
    expect(result[0]).not.toHaveProperty('rawOutput.toolCalls');
    expect(
      (result[0] as Extract<DaemonUiEvent, { type: 'tool.update' }>).rawInput,
    ).toMatchObject({ prompt: `${'p'.repeat(240)}…` });
  });

  it('omits root output when none of its fields are projected', () => {
    const [result] = projectMainTranscriptEventsForTesting([
      {
        type: 'tool.update',
        toolCallId: 'agent-1',
        toolName: 'agent',
        rawOutput: { result: 'unbounded result' },
      },
    ]);

    expect(result).toMatchObject({
      type: 'tool.update',
      toolCallId: 'agent-1',
      rawOutput: undefined,
    });
  });
});
