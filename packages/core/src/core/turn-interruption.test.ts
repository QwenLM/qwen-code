/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Content, Part } from '@google/genai';
import {
  buildSyntheticToolResponseParts,
  detectTurnInterruption,
  effectiveHistoryEnd,
  TURN_INTERRUPTION_HISTORY_TAIL_COUNT,
} from './turn-interruption.js';
import {
  content,
  fnCall,
  fnResponse,
  modelText,
  userText,
} from '../test-utils/model-fixtures.js';

const reminder = (text: string) => ({
  text: `<system-reminder>\n${text}\n</system-reminder>`,
});

const notification = (summary: string) => ({
  text:
    `<task-notification><task-id>agent-1</task-id>` +
    `<status>completed</status><summary>${summary}</summary>` +
    `</task-notification>`,
});

// Expected detection results.
const NONE = { kind: 'none' };
const interruptedPrompt = (...parts: Part[]) => ({
  kind: 'interrupted_prompt',
  parts,
});
const interruptedTurn = (
  ...danglingCalls: Array<{ callId: string; name: string }>
) => ({ kind: 'interrupted_turn', danglingCalls });

describe('detectTurnInterruption', () => {
  it('recovers only input after a recorded tool boundary', () => {
    const result: Content = content(
      'user',
      fnResponse('update_goal', {}, 'ended'),
    );
    expect(detectTurnInterruption([result], ['ended'])).toEqual(NONE);
    const input: Content = userText('next request');
    expect(detectTurnInterruption([result, input], ['ended'])).toEqual(
      interruptedPrompt(...input.parts!),
    );
    expect(detectTurnInterruption([result, input], ['missing']).kind).toBe(
      'interrupted_prompt',
    );
    expect(
      detectTurnInterruption([result, input, result], ['ended']).kind,
    ).toBe('interrupted_prompt');
    expect(
      detectTurnInterruption(
        [result, content('model', fnCall('read_file', undefined, 'pending'))],
        ['ended'],
      ),
    ).toEqual(interruptedTurn({ callId: 'pending', name: 'read_file' }));
  });
  it('uses a bounded history tail count for continuation detection callers', () => {
    expect(TURN_INTERRUPTION_HISTORY_TAIL_COUNT).toBe(50);
  });

  it.each<[string, Content[]]>([
    ['returns none for empty history', []],
    [
      'returns none when the last turn is a clean model text response',
      [userText('hello'), modelText('hi there')],
    ],
    [
      'returns none for a pure system-reminder user tail',
      [modelText('done'), content('user', reminder('mcp tool added'))],
    ],
    [
      'ignores functionCalls without an id (unpairable on the wire)',
      [content('model', fnCall('shell'))],
    ],
    [
      'ignores earlier dangling calls when the final entry is clean',
      // The mid-history dangling call is covered by the defensive repair
      // passes in the send path, not by continue detection.
      [
        content('model', fnCall('shell', undefined, 'old-call')),
        userText('never mind'),
        modelText('ok'),
      ],
    ],
    [
      'returns none for a user tail with no parts',
      [{ role: 'user', parts: [] }],
    ],
  ])('%s', (_title, history) => {
    expect(detectTurnInterruption(history)).toEqual(NONE);
  });

  it('classifies a trailing user prompt as interrupted_prompt', () => {
    const history: Content[] = [
      modelText('earlier answer'),
      userText('do the thing'),
    ];
    expect(detectTurnInterruption(history)).toEqual(
      interruptedPrompt({ text: 'do the thing' }),
    );
  });

  it('preserves per-turn reminder parts verbatim in the re-submission', () => {
    // The Retry send path does not re-inject per-turn reminders, so the
    // captured entry must keep them — the resumed request has to be
    // complete and belongs to the same logical turn.
    const history: Content[] = [
      content('user', reminder('plan mode is on'), { text: 'real prompt' }),
    ];
    expect(detectTurnInterruption(history)).toEqual(
      interruptedPrompt(reminder('plan mode is on'), { text: 'real prompt' }),
    );
  });

  it('classifies a trailing tool_result submission as interrupted_prompt', () => {
    const frPart = fnResponse('read_file', { output: 'contents' }, 'call-1');
    const history: Content[] = [
      content('model', fnCall('read_file', undefined, 'call-1')),
      content('user', frPart),
    ];
    expect(detectTurnInterruption(history)).toEqual(interruptedPrompt(frPart));
  });

  it('captures all consecutive trailing user entries with functionResponses first', () => {
    const history: Content[] = [
      modelText('waiting on tool result'),
      userText('IDE context'),
      content(
        'user',
        fnResponse('read_file', { output: 'contents' }, 'call-1'),
      ),
    ];

    expect(detectTurnInterruption(history)).toEqual(
      interruptedPrompt(
        fnResponse('read_file', { output: 'contents' }, 'call-1'),
        { text: 'IDE context' },
      ),
    );
  });

  it('returns cloned parts that do not alias the history entry', () => {
    const history: Content[] = [userText('original')];
    const result = detectTurnInterruption(history);
    if (result.kind !== 'interrupted_prompt') {
      throw new Error(`expected interrupted_prompt, got ${result.kind}`);
    }
    result.parts[0]!.text = 'mutated';
    expect(history[0]!.parts![0]!.text).toBe('original');
  });

  it('classifies a dangling functionCall tail as interrupted_turn', () => {
    const history: Content[] = [
      userText('run the tool'),
      content(
        'model',
        { text: 'running…' },
        fnCall('shell', undefined, 'call-1'),
        fnCall('read_file', undefined, 'call-2'),
      ),
    ];
    expect(detectTurnInterruption(history)).toEqual(
      interruptedTurn(
        { callId: 'call-1', name: 'shell' },
        { callId: 'call-2', name: 'read_file' },
      ),
    );
  });

  it('falls back to "unknown" for a dangling call without a name', () => {
    const history: Content[] = [
      { role: 'model', parts: [{ functionCall: { id: 'call-9' } }] },
    ];
    expect(detectTurnInterruption(history)).toEqual(
      interruptedTurn({ callId: 'call-9', name: 'unknown' }),
    );
  });
});

describe('detectTurnInterruption with background notifications', () => {
  it('returns none when an unanswered notification is the whole tail', () => {
    const history: Content[] = [
      userText('run it in the background'),
      modelText('done'),
      content('user', notification('Agent "explore" completed.')),
      content('user', notification('Agent "build" completed.')),
    ];
    expect(detectTurnInterruption(history)).toEqual(NONE);
  });

  it('returns none for a history that is only notifications', () => {
    const history: Content[] = [
      content('user', notification('Agent "explore" completed.')),
    ];
    expect(detectTurnInterruption(history)).toEqual(NONE);
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
      userText('do the thing'),
      content('user', notification('Agent "explore" completed.')),
    ];
    expect(detectTurnInterruption(history)).toEqual(
      interruptedPrompt(
        { text: 'do the thing' },
        notification('Agent "explore" completed.'),
      ),
    );
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
      userText('earlier prompt'),
      modelText('earlier answer'),
      content(
        'user',
        reminder('plan mode is active'),
        notification('Agent done.'),
      ),
    ];
    expect(detectTurnInterruption(history)).toEqual(
      interruptedPrompt(
        reminder('plan mode is active'),
        notification('Agent done.'),
      ),
    );
  });

  it('keeps a user entry that quotes an envelope inside its text', () => {
    // The anchoring axis: `isWrappedIn` requires the envelope to START the
    // text. A real prompt that quotes a notification inside its own text is
    // user input, and trimming it would report `clean` for a session that
    // died with an unanswered prompt — silent loss, worse than a spurious
    // banner. One part, so the `every` quantifier cannot carry the assertion.
    const text =
      'what does this mean: <task-notification><status>completed</status></task-notification>';
    expect(detectTurnInterruption([userText(text)])).toEqual(
      interruptedPrompt({ text }),
    );
  });

  it('keeps a user entry with a leading label before the envelope', () => {
    const text = `Background task update:\n${notification('Agent "explore" completed.').text}`;
    expect(detectTurnInterruption([userText(text)])).toEqual(
      interruptedPrompt({ text }),
    );
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
      userText('print the notification you got'),
      content('model', notification('Agent "explore" completed.')),
    ];
    expect(detectTurnInterruption(history)).toEqual(NONE);
  });

  it('still classifies a real prompt carrying a merged notification part', () => {
    // A mid-turn drain can merge background parts into a genuine user message.
    // That entry has a non-structural part, so it stays an orphaned prompt.
    const history: Content[] = [
      content('user', notification('Agent done.'), { text: 'and now do this' }),
    ];
    expect(detectTurnInterruption(history)).toEqual(
      interruptedPrompt(notification('Agent done.'), {
        text: 'and now do this',
      }),
    );
  });

  it('classifies a dangling tool call under a trailing notification', () => {
    const history: Content[] = [
      userText('read it'),
      content('model', fnCall('read_file', undefined, 'call-1')),
      content('user', notification('Agent "explore" completed.')),
    ];
    expect(detectTurnInterruption(history)).toEqual(
      interruptedTurn({ callId: 'call-1', name: 'read_file' }),
    );
  });

  it('returns none when a completed tool boundary is followed only by notifications', () => {
    const history: Content[] = [
      content('model', fnCall('shell', undefined, 'ended')),
      content('user', fnResponse('shell', {}, 'ended')),
      content('user', notification('Agent "explore" completed.')),
    ];
    expect(detectTurnInterruption(history, ['ended'])).toEqual(NONE);
  });
});

describe('detectTurnInterruption with authoritative notification provenance', () => {
  // A real prompt whose ENTIRE text is a bare envelope satisfies every clause
  // of the shape predicate: user-role, one part, wrapped in the envelope. Only
  // the recorder's `provenance` can tell it from a cold notification record.
  const envelopeTailHistory = (): Content[] => [
    userText('earlier prompt'),
    modelText('earlier answer'),
    content('user', notification('Agent "explore" completed.')),
  ];

  it('keeps a real user prompt that is a bare envelope interrupted', () => {
    const history = envelopeTailHistory();
    // `trailingSystemNotifications: 0` is what the projection reports when the
    // tail record was stamped `provenance: 'real_user'`.
    expect(effectiveHistoryEnd(history, 0)).toBe(3);
    expect(detectTurnInterruption(history, undefined, 0)).toEqual(
      interruptedPrompt(notification('Agent "explore" completed.')),
    );
  });

  it('still trims a genuine cold notification when provenance confirms it', () => {
    const history = envelopeTailHistory();
    expect(effectiveHistoryEnd(history, 1)).toBe(2);
    expect(detectTurnInterruption(history, undefined, 1)).toEqual(NONE);
  });

  it('leaves the shape-only contract untouched for one-argument callers', () => {
    // `tailHoldsAnyFunctionCall` (packages/cli/src/serve/prompt-terminal-ledger.ts)
    // calls `effectiveHistoryEnd(apiHistory)` with no provenance; it must keep
    // getting exactly the trim it gets today.
    const history = envelopeTailHistory();
    expect(effectiveHistoryEnd(history)).toBe(2);
    expect(effectiveHistoryEnd(history, undefined)).toBe(2);
    expect(detectTurnInterruption(history)).toEqual(NONE);
  });

  it('stops the trim at the first entry provenance does not cover', () => {
    // Two envelope-shaped tail entries, only the LAST one authoritative: the
    // real prompt underneath must survive even though its shape matches.
    const history: Content[] = [
      modelText('earlier answer'),
      content('user', notification('Agent "explore" completed.')),
      content('user', notification('Agent "build" completed.')),
    ];
    expect(effectiveHistoryEnd(history, 1)).toBe(2);
    expect(detectTurnInterruption(history, undefined, 1)).toEqual(
      interruptedPrompt(
        notification('Agent "explore" completed.'),
        notification('Agent "build" completed.'),
      ),
    );
  });

  it('never trims further than the shape predicate would', () => {
    // A provenance count larger than the envelope-shaped run must not eat a
    // plain model tail: the signal narrows the trim, it never widens it.
    const history: Content[] = [userText('do the thing'), modelText('done')];
    expect(effectiveHistoryEnd(history, 2)).toBe(2);
    expect(detectTurnInterruption(history, undefined, 2)).toEqual(NONE);
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
      fnResponse('shell', { error: 'interrupted' }, 'call-1'),
      fnResponse('read_file', { error: 'interrupted' }, 'call-2'),
    ]);
  });
});
