/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildTurn, groupMessagesIntoTurns } from '../../../factory/turn-factory.js';
import { buildMessage } from '../../../factory/message-factory.js';
import { buildSession } from '../../../factory/session-factory.js';

describe('TurnImpl', () => {
  it('builds a turn from a stamp', () => {
    const turn = buildTurn({
      promptId: 'p1',
      sessionId: 's1',
      requestSetId: 'rs1',
      promptText: 'hello',
      inputMode: 'bash',
      agentId: 'agent-a',
      messages: [
        { uuid: 'm1', role: 'user', promptId: 'p1', payload: { content: 'hello' } },
        { uuid: 'm2', role: 'assistant', promptId: 'p1', payload: { content: 'hi' } },
      ],
    });

    expect(turn.getPromptId()).toBe('p1');
    expect(turn.getSessionId()).toBe('s1');
    expect(turn.getRequestSetId()).toBe('rs1');
    expect(turn.getPromptText()).toBe('hello');
    expect(turn.getInputMode()).toBe('bash');
    expect(turn.getAgentId()).toBe('agent-a');
    expect(turn.isSidechain()).toBe(true);
    expect(turn.getRewindTargetUuid()).toBe('m1');
    expect(turn.getMessages()).toHaveLength(2);
  });

  it('derives prompt text and input mode from the user message payload', () => {
    const turn = buildTurn({
      promptId: 'p1',
      messages: [
        {
          uuid: 'm1',
          role: 'user',
          promptId: 'p1',
          payload: {
            humanInput: { text: 'run tests', mode: 'bash' },
          },
        },
      ],
    });

    expect(turn.getPromptText()).toBe('run tests');
    expect(turn.getInputMode()).toBe('bash');
  });

  it('detects compact boundary turns', () => {
    const turn = buildTurn({
      promptId: 'p1',
      messages: [
        { uuid: 'm1', role: 'user', promptId: 'p1' },
        {
          uuid: 'm2',
          role: 'system',
          promptId: 'p1',
          payload: { subtype: 'compact_boundary', content: 'boundary' },
        },
      ],
    });

    expect(turn.isCompactBoundary()).toBe(true);
  });
});

describe('groupMessagesIntoTurns', () => {
  it('groups messages by promptId in chain order', () => {
    const messages = [
      buildMessage({ uuid: 'u1', role: 'user', promptId: 'p1', payload: { content: 'a' } }),
      buildMessage({ uuid: 'a1', role: 'assistant', promptId: 'p1', payload: { content: 'b' } }),
      buildMessage({ uuid: 'u2', role: 'user', promptId: 'p2', payload: { content: 'c' } }),
      buildMessage({ uuid: 'a2', role: 'assistant', promptId: 'p2', payload: { content: 'd' } }),
    ];

    const turns = groupMessagesIntoTurns(messages, 's1');

    expect(turns).toHaveLength(2);
    expect(turns[0].getPromptId()).toBe('p1');
    expect(turns[0].getMessages().map((m) => m.getUuid())).toEqual(['u1', 'a1']);
    expect(turns[1].getPromptId()).toBe('p2');
    expect(turns[1].getMessages().map((m) => m.getUuid())).toEqual(['u2', 'a2']);
  });

  it('carries requestSetId and agentId from the user message', () => {
    const messages = [
      buildMessage({
        uuid: 'u1',
        role: 'user',
        promptId: 'p1',
        requestSetId: 'rs1',
        agentId: 'agent-x',
        payload: { content: 'a' },
      }),
      buildMessage({ uuid: 'a1', role: 'assistant', promptId: 'p1', payload: { content: 'b' } }),
    ];

    const turns = groupMessagesIntoTurns(messages, 's1');

    expect(turns[0].getRequestSetId()).toBe('rs1');
    expect(turns[0].getAgentId()).toBe('agent-x');
  });
});

describe('Session turns', () => {
  it('incrementally groups added messages into turns', () => {
    const session = buildSession({ sessionId: 's1' });

    session.addMessage(buildMessage({
      uuid: 'u1',
      role: 'user',
      promptId: 'p1',
      payload: { content: 'first' },
    }));
    session.addMessage(buildMessage({
      uuid: 'a1',
      role: 'assistant',
      promptId: 'p1',
      payload: { content: 'ok' },
    }));
    session.addMessage(buildMessage({
      uuid: 'u2',
      role: 'user',
      promptId: 'p2',
      payload: { content: 'second' },
    }));

    expect(session.getTurns()).toHaveLength(2);
    expect(session.getTurns()[0].getMessages()).toHaveLength(2);
    expect(session.getTurns()[1].getMessages()).toHaveLength(1);
    expect(session.getMessages()).toHaveLength(3);
  });
});
