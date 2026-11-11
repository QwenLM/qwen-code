/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildTurn, groupMessagesIntoTurns } from './turn-factory.js';
import { buildMessage } from './message-factory.js';

describe('buildTurn', () => {
  it('builds a turn from a stamp', () => {
    const turn = buildTurn({
      promptId: 'p1',
      sessionId: 's1',
      promptText: 'hello',
      inputMode: 'bash',
      messages: [
        { uuid: 'u1', role: 'user', payload: { content: 'hello' } },
        { uuid: 'a1', role: 'assistant', payload: { content: 'hi' } },
      ],
    });

    expect(turn.getPromptId()).toBe('p1');
    expect(turn.getSessionId()).toBe('s1');
    expect(turn.getPromptText()).toBe('hello');
    expect(turn.getInputMode()).toBe('bash');
    expect(turn.getMessages()).toHaveLength(2);
  });

  it('derives prompt text from humanInput payload', () => {
    const turn = buildTurn({
      promptId: 'p1',
      messages: [
        {
          uuid: 'u1',
          role: 'user',
          payload: { humanInput: { text: 'run tests', mode: 'bash' } },
        },
      ],
    });

    expect(turn.getPromptText()).toBe('run tests');
    expect(turn.getInputMode()).toBe('bash');
  });
});

describe('groupMessagesIntoTurns', () => {
  it('groups by promptId', () => {
    const turns = groupMessagesIntoTurns([
      buildMessage({ uuid: 'u1', role: 'user', promptId: 'p1' }),
      buildMessage({ uuid: 'a1', role: 'assistant', promptId: 'p1' }),
      buildMessage({ uuid: 'u2', role: 'user', promptId: 'p2' }),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].getMessages()).toHaveLength(2);
    expect(turns[1].getMessages()).toHaveLength(1);
  });
});
