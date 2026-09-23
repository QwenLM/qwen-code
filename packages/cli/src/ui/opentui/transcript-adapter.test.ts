/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resume replay rules for subtyped user records: U-32 steering
 * (mid_turn_user_message) replays as a real user row, side-band records
 * (goal_runtime, cron) stay out of the transcript, and a replayed functionCall
 * carries its arguments for ink's inline args row.
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

  it('strips an injected system-reminder envelope from replayed user text', () => {
    // The Ink resume path strips the one-shot envelope; the OpenTUI twin
    // replays the same session file and must agree on the row.
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        parts: [
          {
            text: '<system-reminder>\n1 background agent was restored from this session.\n</system-reminder>\n\nmy prompt',
          },
        ],
      },
    });
    const events = transcriptToEvents(
      [line, JSON.stringify({ type: 'done' })].join('\n'),
    );
    expect(events).toEqual([
      { type: 'user', text: 'my prompt' },
      { type: 'done' },
    ]);
  });

  it('strips the envelope when displayText wins the resolution chain', () => {
    // When provenance was unavailable at submit time the persisted
    // displayText IS the enveloped text, and displayText resolves ahead of
    // the parts — narrowing the strip to the parts fallback must not leave
    // this branch uncovered.
    const line = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        parts: [{ text: 'DIFFERENTLY WORDED PARTS TEXT' }],
      },
      systemPayload: {
        displayText:
          '<system-reminder>\n1 background agent was restored from this session.\n</system-reminder>\n\nmy prompt',
      },
    });
    const events = transcriptToEvents(
      [line, JSON.stringify({ type: 'done' })].join('\n'),
    );
    expect(events).toEqual([
      { type: 'user', text: 'my prompt' },
      { type: 'done' },
    ]);
  });

  it('keeps a user-authored leading envelope the record parts also carry', () => {
    // Same gate as Ink's resume path: when the record's model-facing parts
    // carry the displayText's leading run, the record cannot prove the run
    // was injected, so both renderers keep the user's text verbatim.
    const text =
      '<system-reminder>\nuser pasted note\n</system-reminder>\n\nmy prompt';
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', parts: [{ text }] },
      systemPayload: { displayText: text },
    });
    const events = transcriptToEvents(
      [line, JSON.stringify({ type: 'done' })].join('\n'),
    );
    expect(events).toEqual([{ type: 'user', text }, { type: 'done' }]);
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

describe('transcriptToEvents resumed tool calls', () => {
  const call = (id: string, name: string, args: unknown) =>
    JSON.stringify({
      type: 'assistant',
      message: { role: 'model', parts: [{ functionCall: { id, name, args } }] },
    });
  const result = (id: string) =>
    JSON.stringify({ type: 'tool_result', toolCallResult: { callId: id } });

  it("replays the arguments for ink's inline args row", () => {
    const events = transcriptToEvents(
      [
        call('c1', 'edit', { file_path: 'a.ts' }),
        result('c1'),
        call('c2', 'list_directory', {}),
        result('c2'),
      ].join('\n'),
    );
    // ink's resume placeholder records `args` for the same row, so a resumed
    // session shows what the live one did — and a call without arguments
    // carries no row at all.
    expect(events).toEqual([
      { type: 'tool-start', id: 'c1', tool: 'edit', title: 'edit' },
      { type: 'tool-args', id: 'c1', args: '{"file_path":"a.ts"}' },
      { type: 'tool-end', id: 'c1', success: true, summary: 'ok' },
      {
        type: 'tool-start',
        id: 'c2',
        tool: 'list_directory',
        title: 'list_directory',
      },
      { type: 'tool-end', id: 'c2', success: true, summary: 'ok' },
      { type: 'done' },
    ]);
  });
});

describe('transcriptToEvents assistant timestamps (#76)', () => {
  const RECORDED = '2026-09-18T07:05:09.000Z';

  function assistantLine(
    parts: Array<Record<string, unknown>>,
    extra: Record<string, unknown> = {},
  ): string {
    return JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', parts },
      ...extra,
    });
  }

  function replay(line: string) {
    return transcriptToEvents(
      [line, JSON.stringify({ type: 'done' })].join('\n'),
    );
  }

  it('stamps the first text run of the record, and only that one', () => {
    // A leading thought must not consume the stamp: ink puts the clock label
    // above the assistant message, not above the reasoning block.
    const events = replay(
      assistantLine(
        [
          { thought: true, text: 'READING' },
          { text: 'FIRST' },
          { text: 'SECOND' },
        ],
        { timestamp: RECORDED },
      ),
    );
    expect(events).toEqual([
      { type: 'thinking', delta: 'READING' },
      { type: 'thinking-end' },
      { type: 'text', delta: 'FIRST', timestamp: Date.parse(RECORDED) },
      { type: 'text', delta: 'SECOND' },
      { type: 'done' },
    ]);
  });

  it('leaves text events unstamped when the record has no usable time', () => {
    expect(replay(assistantLine([{ text: 'FIRST' }]))).toEqual([
      { type: 'text', delta: 'FIRST' },
      { type: 'done' },
    ]);
    expect(
      replay(assistantLine([{ text: 'FIRST' }], { timestamp: 'not-a-date' })),
    ).toEqual([{ type: 'text', delta: 'FIRST' }, { type: 'done' }]);
  });
});
