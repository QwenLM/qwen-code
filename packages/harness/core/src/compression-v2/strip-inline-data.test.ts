/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ModelStreamMessage } from '../provider/modelStreamRequest.js';
import { stripInlineDataForCompaction } from './strip-inline-data.js';

describe('stripInlineDataForCompaction', () => {
  it('replaces top-level images without mutating the original message', () => {
    const original: ModelStreamMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'inspect this' },
        {
          type: 'image',
          source: {
            type: 'base64',
            mediaType: 'image/png',
            data: 'large-base64-payload',
          },
        },
      ],
    };

    const result = stripInlineDataForCompaction([original]);

    expect(result[0]).not.toBe(original);
    expect(result[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'inspect this' },
        { type: 'text', text: '[image]' },
      ],
    });
    expect(JSON.stringify(original)).toContain('large-base64-payload');
  });

  it('replaces images nested inside tool results and preserves text', () => {
    const original: ModelStreamMessage = Object.freeze({
      role: 'tool',
      toolCallId: 'tool-1',
      isError: false,
      content: Object.freeze([
        Object.freeze({ type: 'text', text: 'screenshot result' }),
        Object.freeze({
          type: 'image',
          source: Object.freeze({
            type: 'base64',
            mediaType: 'image/jpeg',
            data: 'large-base64-payload',
          }),
        }),
      ]),
    });
    const saved = structuredClone(original);

    const result = stripInlineDataForCompaction([original]);

    expect(result[0]).toEqual({
      role: 'tool',
      toolCallId: 'tool-1',
      isError: false,
      content: [
        { type: 'text', text: 'screenshot result' },
        { type: 'text', text: '[image]' },
      ],
    });
    expect(original).toEqual(saved);
  });

  it('reuses messages that contain no inline media', () => {
    const user: ModelStreamMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    };
    const assistant: ModelStreamMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
    };

    const result = stripInlineDataForCompaction([user, assistant]);

    expect(result[0]).toBe(user);
    expect(result[1]).toBe(assistant);
  });
});
