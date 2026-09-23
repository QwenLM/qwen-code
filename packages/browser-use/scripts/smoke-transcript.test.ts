/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { collectAssistantReport } from './smoke-transcript.js';

describe('smoke transcript report', () => {
  it('retains the complete report before an extra tool call and short final response', () => {
    const report = 'Order completed. Total: $36.69';
    expect(
      collectAssistantReport([
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: report }] },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', name: 'get_goal' }] },
        },
        {
          type: 'user',
          message: {
            content: [{ type: 'tool_result', content: 'No active goal' }],
          },
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Done' }] },
        },
        { type: 'result', result: 'Done' },
      ]),
    ).toBe(`${report}\nDone`);
  });

  it('excludes reasoning, code, nested-agent reports, tool output, and malformed events', () => {
    expect(
      collectAssistantReport([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: 'private reasoning' },
              { type: 'tool_use', input: { code: 'printed text' } },
              { type: 'text', text: 'User report' },
            ],
          },
        },
        {
          type: 'assistant',
          parent_tool_use_id: 'child',
          message: { content: [{ type: 'text', text: 'Nested report' }] },
        },
        {
          type: 'user',
          message: { content: [{ type: 'text', text: 'User prompt' }] },
        },
        { type: 'assistant' },
        null,
        'invalid event',
      ]),
    ).toBe('User report');
  });
});
