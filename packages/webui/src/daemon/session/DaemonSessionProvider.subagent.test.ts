import { describe, expect, it } from 'vitest';
import type { DaemonUiEvent } from '@qwen-code/sdk/daemon';
import { projectMainTranscriptEventsForTesting } from './DaemonSessionProvider.js';

describe('on-demand subagent transcript projection', () => {
  it('drops child events and bounds the root agent payload', () => {
    const todoId = `todo-${'x'.repeat(160)}`;
    const events: DaemonUiEvent[] = [
      {
        type: 'tool.update',
        toolCallId: 'agent-1',
        toolName: 'agent',
        status: 'completed',
        rawInput: {
          subagent_type: 'explore',
          prompt: 'p'.repeat(400),
          todo_id: todoId,
        },
        rawOutput: {
          type: 'task_execution',
          subagentColor: 'red',
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
      rawInput: { subagent_type: 'explore', todo_id: todoId },
      rawOutput: {
        type: 'task_execution',
        subagentColor: 'red',
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

  it('preserves fields used to classify foreground agents', () => {
    const [result] = projectMainTranscriptEventsForTesting([
      {
        type: 'tool.update',
        toolCallId: 'agent-1',
        toolName: 'agent',
        status: 'in_progress',
        rawInput: {
          description: 'Review the change',
          prompt: 'Review the change.',
          subagent_type: 'general-purpose',
          run_in_background: false,
          working_dir: '.qwen/tmp/review-pr-1',
          name: 'reviewer',
        },
      },
    ]);

    expect(result).toMatchObject({
      rawInput: {
        run_in_background: false,
        working_dir: '.qwen/tmp/review-pr-1',
        name: 'reviewer',
      },
    });
  });

  it('retains executionMode in the projected task_execution output', () => {
    const [result] = projectMainTranscriptEventsForTesting([
      {
        type: 'tool.update',
        toolCallId: 'agent-1',
        toolName: 'agent',
        status: 'running',
        rawOutput: {
          type: 'task_execution',
          status: 'running',
          executionMode: 'background',
          subagentName: 'probe',
        },
      },
    ]);

    // Summary-mode clients classify from executionMode starting with the
    // first running update; the projection must not strip the field.
    expect(result).toMatchObject({
      type: 'tool.update',
      toolCallId: 'agent-1',
      rawOutput: {
        type: 'task_execution',
        status: 'running',
        executionMode: 'background',
      },
    });
  });

  it('retains the foreground executionMode literal in the projected output', () => {
    const [result] = projectMainTranscriptEventsForTesting([
      {
        type: 'tool.update',
        toolCallId: 'agent-1',
        toolName: 'agent',
        status: 'running',
        rawOutput: {
          type: 'task_execution',
          status: 'running',
          executionMode: 'foreground',
        },
      },
    ]);

    expect(result).toMatchObject({
      type: 'tool.update',
      toolCallId: 'agent-1',
      rawOutput: {
        type: 'task_execution',
        status: 'running',
        executionMode: 'foreground',
      },
    });
  });

  it('drops an unknown executionMode literal from the projected output', () => {
    // The whitelist fails closed: only the two known literals may reach
    // summary-mode clients; anything else falls back to the legacy
    // argument/status heuristic downstream instead of forcing a mode.
    const [result] = projectMainTranscriptEventsForTesting([
      {
        type: 'tool.update',
        toolCallId: 'agent-1',
        toolName: 'agent',
        status: 'running',
        rawOutput: {
          type: 'task_execution',
          status: 'running',
          executionMode: 'detached',
        },
      },
    ]);

    expect(result).toMatchObject({
      type: 'tool.update',
      toolCallId: 'agent-1',
      rawOutput: {
        type: 'task_execution',
        status: 'running',
      },
    });
    expect(result).not.toHaveProperty('rawOutput.executionMode');
  });
});
