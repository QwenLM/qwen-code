/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resume replay rules for subtyped user records: U-32 steering
 * (mid_turn_user_message) replays as a real user row, side-band records
 * (goal_runtime, cron) stay out of the transcript.
 */

import { describe, it, expect } from 'vitest';
import { transcriptToEvents } from './transcript-adapter.js';
import { MID_TURN_USER_MESSAGE_PREFIX } from '../../utils/midTurnUserMessage.js';
import { getAutoMemoryRoot } from '@qwen-code/qwen-code-core/memory/paths.js';

function userLine(subtype: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    subtype,
    message: { role: 'user', parts: [{ text }] },
    systemPayload: { displayText: text },
  });
}

describe('transcriptToEvents subtyped user records', () => {
  it.each(['error', 'cancelled'])(
    'does not count %s memory reads on resume',
    (status) => {
      const projectRoot = '/tmp/focus-resume-project';
      const events = transcriptToEvents(
        [
          JSON.stringify({
            type: 'assistant',
            message: {
              parts: [
                {
                  functionCall: {
                    id: 'memory1',
                    name: 'read_file',
                    args: {
                      file_path: `${getAutoMemoryRoot(projectRoot)}/MEMORY.md`,
                    },
                  },
                },
              ],
            },
          }),
          JSON.stringify({
            type: 'tool_result',
            toolCallResult: {
              callId: 'memory1',
              status,
              resultDisplay: 'READ_FAILED',
            },
          }),
        ].join('\n'),
        { projectRoot },
      );
      const result = events.find((event) => event.type === 'tool-result');
      expect(result).toBeDefined();
      expect(result).not.toHaveProperty('isMemoryOp');
      expect(events).toContainEqual({
        type: 'tool-end',
        id: 'memory1',
        success: false,
        summary: status,
      });
    },
  );
  it('preserves file arguments and detailed responses when resuming', () => {
    const events = transcriptToEvents(
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            parts: [
              {
                functionCall: {
                  id: 'read1',
                  name: 'read_file',
                  args: { file_path: 'src/main.ts' },
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'tool_result',
          toolCallResult: {
            callId: 'read1',
            status: 'success',
            resultDisplay: 'Read 2 lines',
            responseParts: [
              {
                functionResponse: {
                  id: 'read1',
                  name: 'read_file',
                  response: { output: 'FULL_READ_RESULT' },
                },
              },
            ],
          },
        }),
      ].join('\n'),
    );
    expect(events).toContainEqual({
      type: 'tool-args',
      id: 'read1',
      args: '{"file_path":"src/main.ts"}',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-result',
        id: 'read1',
        detailedDisplay: expect.stringContaining('FULL_READ_RESULT'),
      }),
    );
  });

  it('replays a mid_turn_user_message (U-32 steering) as a user event', () => {
    const events = transcriptToEvents(
      [
        userLine('mid_turn_user_message', 'STEER_CANARY_ONE'),
        JSON.stringify({ type: 'done' }),
      ].join('\n'),
    );
    expect(events).toEqual([
      { type: 'user', text: 'STEER_CANARY_ONE' },
      { type: 'done' },
    ]);
  });

  it('replays the typed displayText, not the @-expanded parts (U-32)', () => {
    const line = JSON.stringify({
      type: 'user',
      subtype: 'mid_turn_user_message',
      message: {
        role: 'user',
        parts: [
          { text: 'steer me' },
          { text: '--- Content from a.ts ---\nFILE BODY' },
        ],
      },
      systemPayload: { displayText: 'steer me @a.ts' },
    });
    const events = transcriptToEvents(
      [line, JSON.stringify({ type: 'done' })].join('\n'),
    );
    expect(events).toEqual([
      { type: 'user', text: 'steer me @a.ts' },
      { type: 'done' },
    ]);
  });

  it('renders an image-only steer as the attachment placeholder (R1-61)', () => {
    const line = JSON.stringify({
      type: 'user',
      subtype: 'mid_turn_user_message',
      message: {
        role: 'user',
        parts: [{ text: MID_TURN_USER_MESSAGE_PREFIX }],
      },
      systemPayload: {
        displayText: '',
        attachmentReferences: [{ type: 'image', mimeType: 'image/png' }],
      },
    });
    const events = transcriptToEvents(
      [line, JSON.stringify({ type: 'done' })].join('\n'),
    );
    expect(events).toEqual([
      { type: 'user', text: '[User message with attachments]' },
      { type: 'done' },
    ]);
  });

  it('falls back to the parts text when a record carries no displayText', () => {
    const line = JSON.stringify({
      type: 'user',
      subtype: 'mid_turn_user_message',
      message: { role: 'user', parts: [{ text: 'legacy steer' }] },
    });
    const events = transcriptToEvents(
      [line, JSON.stringify({ type: 'done' })].join('\n'),
    );
    expect(events).toEqual([
      { type: 'user', text: 'legacy steer' },
      { type: 'done' },
    ]);
  });

  it('still skips side-band subtyped user records', () => {
    const events = transcriptToEvents(
      [
        userLine('goal_runtime', 'goal tick'),
        userLine('cron', 'scheduled prompt'),
        JSON.stringify({ type: 'done' }),
      ].join('\n'),
    );
    expect(events).toEqual([{ type: 'done' }]);
  });
});
