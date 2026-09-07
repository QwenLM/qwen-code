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

function userLine(subtype: string, text: string): string {
  return JSON.stringify({
    type: 'user',
    subtype,
    message: { role: 'user', parts: [{ text }] },
    systemPayload: { displayText: text },
  });
}

describe('transcriptToEvents subtyped user records', () => {
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
