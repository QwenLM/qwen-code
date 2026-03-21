/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  trimAnthropicMessagesForContextBudget,
  CONTEXT_BUDGET_TRIM_SKIP_THRESHOLD,
} from './contextBudgetTrim.js';
import type Anthropic from '@anthropic-ai/sdk';

describe('trimAnthropicMessagesForContextBudget', () => {
  it('should not modify messages when context limit is Gemini-scale', () => {
    const huge = 'x'.repeat(500_000);
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: '1',
            content: huge,
          },
        ],
      },
    ];
    const out = trimAnthropicMessagesForContextBudget(
      messages,
      undefined,
      undefined,
      CONTEXT_BUDGET_TRIM_SKIP_THRESHOLD,
    );
    expect(out.messages).toBe(messages);
    expect(out.system).toBeUndefined();
  });

  it('should trim oversized tool_result string content for small context windows', () => {
    const huge = 'y'.repeat(50_000);
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'c1',
            content: huge,
          },
        ],
      },
    ];
    const out = trimAnthropicMessagesForContextBudget(
      messages,
      undefined,
      undefined,
      8192,
    );
    const toolMsg = out.messages[1];
    expect(toolMsg.role).toBe('user');
    if (typeof toolMsg.content === 'string') {
      throw new Error('Expected array content');
    }
    const block = toolMsg.content[0] as Anthropic.ContentBlockParam;
    expect(block.type).toBe('tool_result');
    if (block.type !== 'tool_result') {
      throw new Error('Expected tool_result block');
    }
    expect(typeof block.content).toBe('string');
    expect((block.content as string).length).toBeLessThan(huge.length);
    expect(block.content as string).toContain('trimmed to fit');
  });
});
