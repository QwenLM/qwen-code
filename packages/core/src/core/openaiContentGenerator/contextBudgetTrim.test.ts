/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  trimMessagesForContextBudget,
  CONTEXT_BUDGET_TRIM_SKIP_THRESHOLD,
} from './contextBudgetTrim.js';
import type OpenAI from 'openai';

describe('trimMessagesForContextBudget', () => {
  it('should not modify messages when context limit is Gemini-scale', () => {
    const huge = 'x'.repeat(500_000);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
      {
        role: 'tool',
        tool_call_id: '1',
        content: huge,
      },
    ];
    const out = trimMessagesForContextBudget(
      messages,
      undefined,
      CONTEXT_BUDGET_TRIM_SKIP_THRESHOLD,
    );
    expect(out).toBe(messages);
  });

  it('should trim oversized tool string content for small context windows', () => {
    const huge = 'y'.repeat(50_000);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: huge,
      },
    ];
    const out = trimMessagesForContextBudget(messages, undefined, 8192);
    const toolMsg = out[2] as OpenAI.Chat.ChatCompletionToolMessageParam;
    expect(toolMsg.role).toBe('tool');
    expect(typeof toolMsg.content).toBe('string');
    expect((toolMsg.content as string).length).toBeLessThan(huge.length);
    expect(toolMsg.content as string).toContain('trimmed to fit');
  });
});
