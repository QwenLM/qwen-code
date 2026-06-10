/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { AgentResultDisplay } from '../tools/tools.js';
import {
  compactStringForHistory,
  compactToolResultDisplayForHistory,
  MAX_RETAINED_AGENT_FIELD_CHARS,
  MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
} from './toolResultDisplayCompaction.js';

describe('toolResultDisplayCompaction', () => {
  it('keeps short strings unchanged', () => {
    const value = 'short output';

    expect(compactStringForHistory(value)).toBe(value);
  });

  it('keeps head and tail when compacting long strings', () => {
    const value = `start-${'x'.repeat(
      MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
    )}-end`;

    const compacted = compactStringForHistory(value);

    expect(compacted.length).toBeLessThanOrEqual(
      MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
    );
    expect(compacted).toContain('start-');
    expect(compacted).toContain('-end');
    expect(compacted).toContain('truncated from');
  });

  it('drops subagent display fields that are not rendered in CLI history', () => {
    const nestedDisplay = `nested-${'x'.repeat(
      MAX_RETAINED_TOOL_RESULT_DISPLAY_CHARS,
    )}-done`;
    const display: AgentResultDisplay = {
      type: 'task_execution',
      subagentName: 'researcher',
      taskDescription: 'research',
      taskPrompt: 'p'.repeat(MAX_RETAINED_AGENT_FIELD_CHARS + 100),
      status: 'completed',
      toolCalls: [
        {
          callId: 'call-1',
          name: 'read_file',
          status: 'success',
          args: { content: 'x'.repeat(100_000) },
          responseParts: [{ text: 'x'.repeat(100_000) }],
          result: 'x'.repeat(100_000),
        },
        {
          callId: 'call-2',
          name: 'agent',
          status: 'success',
          resultDisplay: nestedDisplay,
        },
      ],
    };

    const compacted = compactToolResultDisplayForHistory(display);

    expect(compacted.taskPrompt.length).toBeLessThanOrEqual(
      MAX_RETAINED_AGENT_FIELD_CHARS,
    );
    expect(compacted.toolCalls?.[0]).not.toHaveProperty('args');
    expect(compacted.toolCalls?.[0]).not.toHaveProperty('responseParts');
    expect(compacted.toolCalls?.[0]).not.toHaveProperty('result');
    expect(compacted.toolCalls?.[1].resultDisplay).toContain('nested-');
    expect(compacted.toolCalls?.[1].resultDisplay).toContain('-done');
    expect(compacted.toolCalls?.[1].resultDisplay).toContain('truncated from');
  });
});
