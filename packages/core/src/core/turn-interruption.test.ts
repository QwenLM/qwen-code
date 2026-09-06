/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content } from '@google/genai';
import {
  buildSyntheticToolResponseParts,
  detectTurnInterruption,
  TURN_INTERRUPTION_HISTORY_TAIL_COUNT,
} from './turn-interruption.js';

const reminder = (text: string) => ({
  text: `<system-reminder>\n${text}\n</system-reminder>`,
});

describe('detectTurnInterruption', () => {
  it('uses a bounded history tail count for continuation detection callers', () => {
    expect(TURN_INTERRUPTION_HISTORY_TAIL_COUNT).toBe(50);
  });

  it('returns none for empty history', () => {
    expect(detectTurnInterruption([])).toEqual({ kind: 'none' });
  });

  it('returns none when the last turn is a clean model text response', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ text: 'hi there' }] },
    ];
    expect(detectTurnInterruption(history)).toEqual({ kind: 'none' });
  });

  it('returns none for a pure system-reminder user tail', () => {
    const history: Content[] = [
      { role: 'model', parts: [{ text: 'done' }] },
      { role: 'user', parts: [reminder('mcp tool added')] },
    ];
    expect(detectTurnInterruption(history)).toEqual({ kind: 'none' });
  });

  it('classifies a trailing user prompt as interrupted_prompt', () => {
    const history: Content[] = [
      { role: 'model', parts: [{ text: 'earlier answer' }] },
      { role: 'user', parts: [{ text: 'do the thing' }] },
    ];
    const result = detectTurnInterruption(history);
    expect(result).toEqual({
      kind: 'interrupted_prompt',
      parts: [{ text: 'do the thing' }],
    });
  });

  it('preserves per-turn reminder parts verbatim in the re-submission', () => {
    // The Retry send path does not re-inject per-turn reminders, so the
    // captured entry must keep them — the resumed request has to be
    // complete and belongs to the same logical turn.
    const history: Content[] = [
      {
        role: 'user',
        parts: [reminder('plan mode is on'), { text: 'real prompt' }],
      },
    ];
    const result = detectTurnInterruption(history);
    expect(result).toEqual({
      kind: 'interrupted_prompt',
      parts: [reminder('plan mode is on'), { text: 'real prompt' }],
    });
  });

  it('classifies a trailing tool_result submission as interrupted_prompt', () => {
    const frPart = {
      functionResponse: {
        id: 'call-1',
        name: 'read_file',
        response: { output: 'contents' },
      },
    };
    const history: Content[] = [
      {
        role: 'model',
        parts: [{ functionCall: { id: 'call-1', name: 'read_file' } }],
      },
      { role: 'user', parts: [frPart] },
    ];
    const result = detectTurnInterruption(history);
    expect(result).toEqual({ kind: 'interrupted_prompt', parts: [frPart] });
  });

  it('captures all consecutive trailing user entries with functionResponses first', () => {
    const history: Content[] = [
      { role: 'model', parts: [{ text: 'waiting on tool result' }] },
      { role: 'user', parts: [{ text: 'IDE context' }] },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-1',
              name: 'read_file',
              response: { output: 'contents' },
            },
          },
        ],
      },
    ];

    const result = detectTurnInterruption(history);

    expect(result).toEqual({
      kind: 'interrupted_prompt',
      parts: [
        {
          functionResponse: {
            id: 'call-1',
            name: 'read_file',
            response: { output: 'contents' },
          },
        },
        { text: 'IDE context' },
      ],
    });
  });

  it('returns cloned parts that do not alias the history entry', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'original' }] },
    ];
    const result = detectTurnInterruption(history);
    if (result.kind !== 'interrupted_prompt') {
      throw new Error(`expected interrupted_prompt, got ${result.kind}`);
    }
    result.parts[0]!.text = 'mutated';
    expect(history[0]!.parts![0]!.text).toBe('original');
  });

  it('classifies a dangling functionCall tail as interrupted_turn', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'run the tool' }] },
      {
        role: 'model',
        parts: [
          { text: 'running…' },
          { functionCall: { id: 'call-1', name: 'shell' } },
          { functionCall: { id: 'call-2', name: 'read_file' } },
        ],
      },
    ];
    expect(detectTurnInterruption(history)).toEqual({
      kind: 'interrupted_turn',
      danglingCalls: [
        { callId: 'call-1', name: 'shell' },
        { callId: 'call-2', name: 'read_file' },
      ],
    });
  });

  it('ignores functionCalls without an id (unpairable on the wire)', () => {
    const history: Content[] = [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'shell' } }],
      },
    ];
    expect(detectTurnInterruption(history)).toEqual({ kind: 'none' });
  });

  it('falls back to "unknown" for a dangling call without a name', () => {
    const history: Content[] = [
      { role: 'model', parts: [{ functionCall: { id: 'call-9' } }] },
    ];
    expect(detectTurnInterruption(history)).toEqual({
      kind: 'interrupted_turn',
      danglingCalls: [{ callId: 'call-9', name: 'unknown' }],
    });
  });

  it('ignores earlier dangling calls when the final entry is clean', () => {
    // The mid-history dangling call is covered by the defensive repair
    // passes in the send path, not by continue detection.
    const history: Content[] = [
      {
        role: 'model',
        parts: [{ functionCall: { id: 'old-call', name: 'shell' } }],
      },
      { role: 'user', parts: [{ text: 'never mind' }] },
      { role: 'model', parts: [{ text: 'ok' }] },
    ];
    expect(detectTurnInterruption(history)).toEqual({ kind: 'none' });
  });

  it('returns none for a user tail with no parts', () => {
    const history: Content[] = [{ role: 'user', parts: [] }];
    expect(detectTurnInterruption(history)).toEqual({ kind: 'none' });
  });
});

describe('buildSyntheticToolResponseParts', () => {
  it('builds one error functionResponse per dangling call, matching repair shape', () => {
    const parts = buildSyntheticToolResponseParts(
      [
        { callId: 'call-1', name: 'shell' },
        { callId: 'call-2', name: 'read_file' },
      ],
      'interrupted',
    );
    expect(parts).toEqual([
      {
        functionResponse: {
          id: 'call-1',
          name: 'shell',
          response: { error: 'interrupted' },
        },
      },
      {
        functionResponse: {
          id: 'call-2',
          name: 'read_file',
          response: { error: 'interrupted' },
        },
      },
    ]);
  });
});
