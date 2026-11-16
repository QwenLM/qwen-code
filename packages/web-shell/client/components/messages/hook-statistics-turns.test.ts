import { expect, it } from 'vitest';
import type { Message } from '../../adapters/types';
import { collectHookStatisticsTurns } from './hook-statistics-turns';

const user: Message = {
  id: 'user',
  role: 'user',
  content: 'Question',
  promptId: 'admission',
  sourceRecordIds: ['record'],
};
const answer: Message = { id: 'answer', role: 'assistant', content: 'Answer' };

it('moves the entry from the prompt to the latest main-agent answer', () => {
  expect([...collectHookStatisticsTurns([user], 'session').keys()]).toEqual([
    'user',
  ]);
  const turns = collectHookStatisticsTurns(
    [user, answer, { ...answer, id: 'next', isStreaming: true }],
    'session',
  );
  expect([...turns.keys()]).toEqual(['next']);
  expect(turns.get('next')).toEqual({
    sessionId: 'session',
    promptId: 'admission',
    recordId: 'record',
  });
});

it('ignores assistant frames without text content', () => {
  const streaming = { ...answer, content: undefined } as unknown as Message;
  expect([
    ...collectHookStatisticsTurns([user, streaming], 'session').keys(),
  ]).toEqual(['user']);
});

it('keeps terminal-only turns accessible and does not attach to background work', () => {
  const failure: Message = {
    id: 'failed',
    role: 'system',
    source: 'turn_error',
    content: 'Blocked',
  };
  const turns = collectHookStatisticsTurns(
    [
      user,
      failure,
      {
        ...answer,
        backgroundTurn: { turnId: 'background', taskId: 'task', kind: 'shell' },
      },
    ],
    'session',
  );
  expect([...turns.keys()]).toEqual(['failed']);
});

it('keeps turns independent and ignores injected messages as new turn heads', () => {
  const injected: Message = {
    ...user,
    id: 'injected',
    source: 'mid_turn_message_injected',
  };
  const next: Message = {
    ...user,
    id: 'next',
    promptId: 'next-admission',
    sourceRecordIds: ['next-record'],
  };
  const turns = collectHookStatisticsTurns(
    [user, injected, answer, next],
    'session',
  );
  expect([...turns.keys()]).toEqual(['answer', 'next']);
  expect(turns.get('answer')?.recordId).toBe('record');
  expect(turns.get('next')?.recordId).toBe('next-record');
});
