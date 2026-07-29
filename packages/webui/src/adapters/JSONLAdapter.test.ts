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

  it('does not fall back to model-facing parts for empty display metadata', () => {
    const [message] = adaptJSONLMessages([
      userMessage([{ text: 'expanded model prompt' }], {
        displayText: '',
        hookContext: 'hook-only context',
      }),
    ]);

    expect(message?.content).toBe('');
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

  it('preserves legacy bare context without a reliable boundary', () => {
    const [message] = adaptJSONLMessages([
      userMessage([
        { text: 'user prompt' },
        { text: 'legacy bare hook context' },
      ]),
    ]);

    expect(message?.content).toBe('user promptlegacy bare hook context');
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
