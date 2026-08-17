/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { adaptJSONLMessages } from './JSONLAdapter.js';
import type { JSONLMessage } from './types.js';

function userMessage(
  parts: Array<{ text: string }>,
  systemPayload?: unknown,
): JSONLMessage {
  return {
    uuid: 'user-1',
    timestamp: '2026-07-28T00:00:00.000Z',
    type: 'user',
    message: { role: 'user', parts },
    ...(systemPayload === undefined ? {} : { systemPayload }),
  };
}

describe('adaptJSONLMessages user display projection', () => {
  it('uses display metadata without exposing model-only parts', () => {
    const [message] = adaptJSONLMessages([
      userMessage(
        [
          { text: 'expanded model prompt' },
          {
            text: [
              '<qwen:user-prompt-submit-context>',
              'hook-only context',
              '</qwen:user-prompt-submit-context>',
            ].join('\n'),
          },
        ],
        {
          displayText: 'raw @file prompt',
          hookContext: 'hook-only context',
        },
      ),
    ]);

    expect(message?.content).toBe('raw @file prompt');
  });

  it('treats empty paired displayText as meaningful', () => {
    const [message] = adaptJSONLMessages([
      userMessage([{ text: 'expanded model prompt' }], {
        displayText: '',
        hookContext: 'hook-only context',
      }),
    ]);

    expect(message?.content).toBe('');
  });

  it('keeps notification model text instead of its display label', () => {
    const [message] = adaptJSONLMessages([
      userMessage([{ text: 'notification model text' }], {
        displayText: 'Background agent completed',
      }),
    ]);

    expect(message?.content).toBe('notification model text');
  });

  it('strips a complete final tag-only context part', () => {
    const [message] = adaptJSONLMessages([
      userMessage([
        { text: 'user prompt' },
        {
          text: [
            '<qwen:user-prompt-submit-context>',
            'hook-only context',
            '</qwen:user-prompt-submit-context>',
          ].join('\n'),
        },
      ]),
    ]);

    expect(message?.content).toBe('user prompt');
  });

  it('strips a final tag-only context part with invalid metadata', () => {
    const [message] = adaptJSONLMessages([
      userMessage(
        [
          { text: 'user prompt' },
          {
            text: [
              '<qwen:user-prompt-submit-context>',
              'hook-only context',
              '</qwen:user-prompt-submit-context>',
            ].join('\n'),
          },
        ],
        null,
      ),
    ]);

    expect(message?.content).toBe('user prompt');
  });

  it('preserves legacy bare-part concatenation without a reliable boundary', () => {
    const [message] = adaptJSONLMessages([
      userMessage([
        { text: 'user prompt' },
        { text: 'legacy bare hook context' },
      ]),
    ]);

    expect(message?.content).toBe('user promptlegacy bare hook context');
  });

  it('uses released single-field display metadata when the final tag proves provenance', () => {
    const [message] = adaptJSONLMessages([
      userMessage(
        [
          { text: 'user prompt' },
          {
            text: [
              '<qwen:user-prompt-submit-context>',
              'user-authored text',
              '</qwen:user-prompt-submit-context>',
            ].join('\n'),
          },
        ],
        { displayText: 'raw @file prompt' },
      ),
    ]);

    expect(message?.content).toBe('raw @file prompt');
  });

  it('leaves non-Qwen user records to the existing format parser', () => {
    const [message] = adaptJSONLMessages([
      {
        uuid: 'claude-user-1',
        timestamp: '2026-07-28T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', content: 'Claude user prompt' },
      },
    ]);

    expect(message?.content).toBe('Claude user prompt');
  });
});
