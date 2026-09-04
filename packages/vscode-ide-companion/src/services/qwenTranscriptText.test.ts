/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { qwenRecordToText } from './qwenTranscriptText.js';

describe('qwenRecordToText', () => {
  it('uses display metadata, including an empty display projection', () => {
    const record = {
      type: 'user',
      message: {
        parts: [
          { text: 'expanded model prompt' },
          {
            text: [
              '<qwen:user-prompt-submit-context>',
              'hook-only context',
              '</qwen:user-prompt-submit-context>',
            ].join('\n'),
          },
        ],
      },
      systemPayload: {
        displayText: 'raw @file prompt',
        hookContext: 'hook-only context',
      },
    };

    expect(qwenRecordToText(record)).toBe('raw @file prompt');
    expect(
      qwenRecordToText({
        ...record,
        systemPayload: { ...record.systemPayload, displayText: '' },
      }),
    ).toBe('');
  });

  it('keeps synthetic user model text instead of its display label', () => {
    expect(
      qwenRecordToText({
        type: 'user',
        message: { parts: [{ text: 'notification model text' }] },
        systemPayload: { displayText: 'Background agent completed' },
      }),
    ).toBe('notification model text');
  });

  it('strips a complete final tag-only context part', () => {
    expect(
      qwenRecordToText({
        type: 'user',
        message: {
          parts: [
            { text: 'user prompt' },
            {
              text: [
                '<qwen:user-prompt-submit-context>',
                'hook-only context',
                '</qwen:user-prompt-submit-context>',
              ].join('\n'),
            },
          ],
        },
      }),
    ).toBe('user prompt');
  });

  it('preserves legacy bare context without a reliable boundary', () => {
    expect(
      qwenRecordToText({
        type: 'user',
        message: {
          parts: [
            { text: 'user prompt' },
            { text: 'legacy bare hook context' },
          ],
        },
      }),
    ).toBe('user prompt\nlegacy bare hook context');
  });
});
