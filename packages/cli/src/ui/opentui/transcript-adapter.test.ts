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
