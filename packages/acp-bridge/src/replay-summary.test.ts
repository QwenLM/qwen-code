/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { summarizeReplay } from './replay-summary.js';
import type { BridgeEvent } from './eventBus.js';

const frame = (id: number, update: Record<string, unknown>): BridgeEvent => ({
  id,
  v: 1,
  type: 'session_update',
  promptId: 'prompt-1',
  data: { sessionId: 'session-1', update },
});

describe('summary replay projection', () => {
  it('preserves root results, attribution, main usage and interactions without mutating full replay', () => {
    const result = frame(4, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'agent-1',
      status: 'completed',
      _meta: { toolName: 'agent', 'qwen.session.recordId': 'record-1' },
      rawInput: { description: 'Review', prompt: 'long task prompt' },
      rawOutput: {
        type: 'task_execution',
        status: 'completed',
        result: 'final answer',
        tokenCount: 12,
        subagentSessionReady: true,
        taskPrompt: 'long task prompt',
        toolCalls: [{ output: 'nested detail' }],
        executionSummary: {
          totalToolCalls: 1,
          totalDurationMs: 200,
          inputTokens: 10,
          outputTokens: 2,
          thoughtTokens: 1,
          cachedTokens: 5,
          totalTokens: 12,
        },
      },
    });
    const nested = frame(1, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking' },
      _meta: { parentToolCallId: 'agent-1' },
    });
    const usage = frame(2, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'nested answer' },
      _meta: {
        parentToolCallId: 'agent-1',
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    });
    const childTool = frame(3, {
      sessionUpdate: 'tool_call',
      toolCallId: 'child-1',
      _meta: { parentToolCallId: 'agent-1' },
      rawOutput: 'detail',
    });
    const permission: BridgeEvent = {
      id: 5,
      v: 1,
      type: 'permission_request',
      data: { requestId: 'permission-1', toolCallId: 'child-1' },
    };
    const mainUsage = frame(6, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: { usage: { inputTokens: 100, outputTokens: 20 } },
    });
    const original = [nested, usage, childTool, result, permission, mainUsage];
    const before = structuredClone(original);
    const projected = summarizeReplay(original);
    expect(projected.map((e) => e.id)).toEqual([4, 5, 6]);
    expect(projected[0]).toMatchObject({
      id: 4,
      promptId: 'prompt-1',
      data: {
        sessionId: 'session-1',
        update: {
          toolCallId: 'agent-1',
          status: 'completed',
          rawInput: { description: 'Review' },
          _meta: { 'qwen.session.recordId': 'record-1' },
          rawOutput: {
            result: 'final answer',
            subagentSessionReady: true,
            executionSummary: { totalToolCalls: 1, totalDurationMs: 200 },
          },
        },
      },
    });
    expect(JSON.stringify(projected)).not.toContain('nested');
    expect(JSON.stringify(projected)).not.toContain('long task prompt');
    expect(projected[1]).toBe(permission);
    expect(projected[2]).toBe(mainUsage);
    expect(projected[0]).toHaveProperty('data.update.rawOutput.tokenCount', 12);
    expect(projected[0]).toHaveProperty(
      'data.update.rawOutput.executionSummary',
      {
        totalToolCalls: 1,
        totalDurationMs: 200,
        inputTokens: 10,
        outputTokens: 2,
        thoughtTokens: 1,
        cachedTokens: 5,
        totalTokens: 12,
      },
    );
    expect(original).toEqual(before);
    expect(summarizeReplay(projected)).toEqual(projected);
  });

  it.each(['running', 'completed', 'failed', 'cancelled'])(
    'retains aggregate usage only for settled tasks: %s',
    (status) => {
      const [event] = summarizeReplay([
        frame(1, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'agent-1',
          status: 'completed',
          rawOutput: {
            type: 'task_execution',
            status,
            tokenCount: 20,
            executionSummary: {
              inputTokens: 100,
              outputTokens: 20,
              cachedTokens: 40,
            },
          },
        }),
      ]);
      if (status === 'running') {
        expect(event).not.toHaveProperty('data.update.rawOutput.tokenCount');
        expect(event).toHaveProperty(
          'data.update.rawOutput.executionSummary',
          {},
        );
      } else {
        expect(event).toHaveProperty('data.update.rawOutput.tokenCount', 20);
        expect(event).toHaveProperty('data.update.rawOutput.executionSummary', {
          inputTokens: 100,
          outputTokens: 20,
          cachedTokens: 40,
        });
      }
    },
  );

  it('retains typed progress cards and non-agent output, including self-parented tools', () => {
    const events = [
      frame(1, {
        sessionUpdate: 'tool_call',
        kind: 'other',
        toolCallId: 'agent-1',
        status: 'in_progress',
        _meta: { parentToolCallId: 'agent-1', subagentProgress: true },
      }),
      frame(2, {
        sessionUpdate: 'tool_call_update',
        status: 'completed',
        _meta: { toolName: 'read_file' },
        rawOutput: { toolCalls: ['file data'], taskPrompt: 'file data' },
      }),
    ];
    expect(summarizeReplay(events)).toEqual(events);
  });
});
