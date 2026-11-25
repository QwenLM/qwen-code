/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { historyDisplay } from './sessionDisplayState.js';

describe('generic session history display', () => {
  it('renders conversation messages and notices while retaining stored display records', () => {
    const tool = { type: 'tool_group', tools: [] };
    expect(
      historyDisplay([
        { type: 'user', message: { role: 'user', content: 'question' } },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'answer' }],
          },
        },
        { type: 'system', level: 'info', content: 'interrupted' },
        { type: 'system', level: 'error', content: 'failed' },
        tool,
      ]),
    ).toEqual([
      { type: 'user', text: 'question' },
      { type: 'gemini', text: 'answer' },
      { type: 'info', text: 'interrupted' },
      { type: 'error', text: 'failed' },
      tool,
    ]);
  });
  it('does not render synthetic prompts, tool results or empty assistant content', () => {
    expect(
      historyDisplay([
        {
          type: 'user',
          isMeta: true,
          message: { role: 'user', content: 'internal' },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
            ],
          },
        },
        { type: 'assistant', message: { role: 'assistant', content: [] } },
      ]),
    ).toEqual([]);
  });
  it('preserves images in ordinary conversation history', () => {
    expect(
      historyDisplay([
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'image',
                },
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        type: 'user',
        text: '',
        images: [{ media_type: 'image/png', data: 'image' }],
      },
    ]);
  });
});
