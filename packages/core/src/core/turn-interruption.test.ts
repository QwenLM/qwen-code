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
  effectiveHistoryEnd,
  TURN_INTERRUPTION_HISTORY_TAIL_COUNT,
} from './turn-interruption.js';

const reminder = (text: string) => ({
  text: `<system-reminder>\n${text}\n</system-reminder>`,
});

describe('detectTurnInterruption', () => {
  it('recovers only input after a recorded tool boundary', () => {
    const result: Content = {
      role: 'user',
      parts: [
        {
          functionResponse: { id: 'ended', name: 'update_goal', response: {} },
        },
      ],
    };
    expect(detectTurnInterruption([result], ['ended'])).toEqual({
      kind: 'none',
    });
    const input: Content = { role: 'user', parts: [{ text: 'next request' }] };
    expect(detectTurnInterruption([result, input], ['ended'])).toEqual({
      kind: 'interrupted_prompt',
      parts: input.parts,
    });
    expect(detectTurnInterruption([result, input], ['missing']).kind).toBe(
      'interrupted_prompt',
    );
    expect(
      detectTurnInterruption([result, input, result], ['ended']).kind,
    ).toBe('interrupted_prompt');
    expect(
      detectTurnInterruption(
        [
          result,
          {
            role: 'model',
            parts: [{ functionCall: { id: 'pending', name: 'read_file' } }],
          },
        ],
        ['ended'],
      ),
    ).toEqual({
      kind: 'interrupted_turn',
      danglingCalls: [{ callId: 'pending', name: 'read_file' }],
    });
  });
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

describe('detectTurnInterruption with background notifications', () => {
  const notification = (summary: string) => ({
    text:
      `<task-notification><task-id>agent-1</task-id>` +
      `<status>completed</status><summary>${summary}</summary>` +
      `</task-notification>`,
  });

  it('returns none when an unanswered notification is the whole tail', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'run it in the background' }] },
      { role: 'model', parts: [{ text: 'done' }] },
      { role: 'user', parts: [notification('Agent "explore" completed.')] },
      { role: 'user', parts: [notification('Agent "build" completed.')] },
    ];
    expect(detectTurnInterruption(history)).toEqual({ kind: 'none' });
  });

  it('returns none for a history that is only notifications', () => {
    const history: Content[] = [
      { role: 'user', parts: [notification('Agent "explore" completed.')] },
    ];
    expect(detectTurnInterruption(history)).toEqual({ kind: 'none' });
  });

  it('re-submits the orphaned prompt together with the notification after it', () => {
    // The Retry send path (`stripOrphanedUserEntriesFromHistory`) pops the
    // ENTIRE trailing user run, notification entries included — its only
    // break-guard is `isSystemReminderContent`, which is false for an
    // envelope. Detection must therefore re-submit exactly that run: trimming
    // the notification out of `parts` while the strip still pops it drops the
    // recorded-but-undelivered payload from live history for good, because
    // `persistedBackgroundNotificationTaskIds` is primed from the transcript
    // itself and the queue never re-delivers it.
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'do the thing' }] },
      { role: 'user', parts: [notification('Agent "explore" completed.')] },
    ];
    expect(detectTurnInterruption(history)).toEqual({
      kind: 'interrupted_prompt',
      parts: [
        { text: 'do the thing' },
        notification('Agent "explore" completed.'),
      ],
    });
  });

  it('keeps a delivered notification turn entry (reminders + envelope) interrupted', () => {
    // An automatic notification turn that was admitted, ran, then failed
    // mid-stream pushes no model entry (`willPersistToHistory` is false), so
    // its `[...systemReminders, ...notificationParts]` user entry is the
    // history tail with nothing in flight to guard it. That is the textbook
    // `interrupted_prompt`, and the queue item is already gone — trimming the
    // entry would certify `clean` and leave the turn with no re-drive at all.
    // Only the single-part cold projection (a recorded notification whose turn
    // never ran) is structural, so the reminder allowance must not apply.
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'earlier prompt' }] },
      { role: 'model', parts: [{ text: 'earlier answer' }] },
      {
        role: 'user',
        parts: [reminder('plan mode is active'), notification('Agent done.')],
      },
    ];
    expect(detectTurnInterruption(history)).toEqual({
      kind: 'interrupted_prompt',
      parts: [reminder('plan mode is active'), notification('Agent done.')],
    });
  });

  it('keeps a user entry that quotes an envelope inside its text', () => {
    // The anchoring axis: `isWrappedIn` requires the envelope to START the
    // text. A real prompt that quotes a notification inside its own text is
    // user input, and trimming it would report `clean` for a session that
    // died with an unanswered prompt — silent loss, worse than a spurious
    // banner. One part, so the `every` quantifier cannot carry the assertion.
    const text =
      'what does this mean: <task-notification><status>completed</status></task-notification>';
    expect(
      detectTurnInterruption([{ role: 'user', parts: [{ text }] }]),
    ).toEqual({ kind: 'interrupted_prompt', parts: [{ text }] });
  });

  it('keeps a user entry with a leading label before the envelope', () => {
    const text = `Background task update:\n${notification('Agent "explore" completed.').text}`;
    expect(
      detectTurnInterruption([{ role: 'user', parts: [{ text }] }]),
    ).toEqual({ kind: 'interrupted_prompt', parts: [{ text }] });
  });

  it('does not trim a MODEL entry whose text is a bare envelope', () => {
    // Model output is never defanged, so the envelope shape alone cannot prove
    // provenance: the user asked the model to echo a notification verbatim (or
    // injected tool/web content steered the reply into ending with one). This
    // turn ENDED CLEANLY — the model answered. Trimming it would expose the
    // already-answered prompt as the tail and re-introduce the false
    // `interrupted_prompt` this trim exists to remove. The role is the
    // provenance signal: real notification records are always user-role.
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'print the notification you got' }] },
      { role: 'model', parts: [notification('Agent "explore" completed.')] },
    ];
    expect(detectTurnInterruption(history)).toEqual({ kind: 'none' });
  });

  it('still classifies a real prompt carrying a merged notification part', () => {
    // A mid-turn drain can merge background parts into a genuine user message.
    // That entry has a non-structural part, so it stays an orphaned prompt.
    const history: Content[] = [
      {
        role: 'user',
        parts: [notification('Agent done.'), { text: 'and now do this' }],
      },
    ];
    expect(detectTurnInterruption(history)).toEqual({
      kind: 'interrupted_prompt',
      parts: [notification('Agent done.'), { text: 'and now do this' }],
    });
  });

  it('classifies a dangling tool call under a trailing notification', () => {
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'read it' }] },
      {
        role: 'model',
        parts: [{ functionCall: { id: 'call-1', name: 'read_file' } }],
      },
      { role: 'user', parts: [notification('Agent "explore" completed.')] },
    ];
    expect(detectTurnInterruption(history)).toEqual({
      kind: 'interrupted_turn',
      danglingCalls: [{ callId: 'call-1', name: 'read_file' }],
    });
  });

  it('returns none when a completed tool boundary is followed only by notifications', () => {
    const history: Content[] = [
      {
        role: 'model',
        parts: [{ functionCall: { id: 'ended', name: 'shell' } }],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { id: 'ended', name: 'shell', response: {} } },
        ],
      },
      { role: 'user', parts: [notification('Agent "explore" completed.')] },
    ];
    expect(detectTurnInterruption(history, ['ended'])).toEqual({
      kind: 'none',
    });
  });
});

describe('detectTurnInterruption with authoritative notification provenance', () => {
  const notification = (summary: string) => ({
    text:
      `<task-notification><task-id>agent-1</task-id>` +
      `<status>completed</status><summary>${summary}</summary>` +
      `</task-notification>`,
  });

  // A real prompt whose ENTIRE text is a bare envelope satisfies every clause
  // of the shape predicate: user-role, one part, wrapped in the envelope. Only
  // the recorder's `provenance` can tell it from a cold notification record.
  const envelopeTailHistory = (): Content[] => [
    { role: 'user', parts: [{ text: 'earlier prompt' }] },
    { role: 'model', parts: [{ text: 'earlier answer' }] },
    { role: 'user', parts: [notification('Agent "explore" completed.')] },
  ];

  it('keeps a real user prompt that is a bare envelope interrupted', () => {
    const history = envelopeTailHistory();
    // `trailingSystemNotifications: 0` is what the projection reports when the
    // tail record was stamped `provenance: 'real_user'`.
    expect(effectiveHistoryEnd(history, 0)).toBe(3);
    expect(detectTurnInterruption(history, undefined, 0)).toEqual({
      kind: 'interrupted_prompt',
      parts: [notification('Agent "explore" completed.')],
    });
  });

  it('still trims a genuine cold notification when provenance confirms it', () => {
    const history = envelopeTailHistory();
    expect(effectiveHistoryEnd(history, 1)).toBe(2);
    expect(detectTurnInterruption(history, undefined, 1)).toEqual({
      kind: 'none',
    });
  });

  it('leaves the shape-only contract untouched for one-argument callers', () => {
    // `tailHoldsAnyFunctionCall` (packages/cli/src/serve/prompt-terminal-ledger.ts)
    // calls `effectiveHistoryEnd(apiHistory)` with no provenance; it must keep
    // getting exactly the trim it gets today.
    const history = envelopeTailHistory();
    expect(effectiveHistoryEnd(history)).toBe(2);
    expect(effectiveHistoryEnd(history, undefined)).toBe(2);
    expect(detectTurnInterruption(history)).toEqual({ kind: 'none' });
  });

  it('stops the trim at the first entry provenance does not cover', () => {
    // Two envelope-shaped tail entries, only the LAST one authoritative: the
    // real prompt underneath must survive even though its shape matches.
    const history: Content[] = [
      { role: 'model', parts: [{ text: 'earlier answer' }] },
      { role: 'user', parts: [notification('Agent "explore" completed.')] },
      { role: 'user', parts: [notification('Agent "build" completed.')] },
    ];
    expect(effectiveHistoryEnd(history, 1)).toBe(2);
    expect(detectTurnInterruption(history, undefined, 1)).toEqual({
      kind: 'interrupted_prompt',
      parts: [
        notification('Agent "explore" completed.'),
        notification('Agent "build" completed.'),
      ],
    });
  });

  it('never trims further than the shape predicate would', () => {
    // A provenance count larger than the envelope-shaped run must not eat a
    // plain model tail: the signal narrows the trim, it never widens it.
    const history: Content[] = [
      { role: 'user', parts: [{ text: 'do the thing' }] },
      { role: 'model', parts: [{ text: 'done' }] },
    ];
    expect(effectiveHistoryEnd(history, 2)).toBe(2);
    expect(detectTurnInterruption(history, undefined, 2)).toEqual({
      kind: 'none',
    });
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
