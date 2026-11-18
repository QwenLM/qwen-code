import { expect, it } from 'vitest';
import {
  createDaemonTranscriptState,
  normalizeDaemonEvent,
  reduceDaemonTranscriptEvents,
  type DaemonTextTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { transcriptBlocksToDaemonMessages } from '../../adapters/transcriptToMessages';
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

it('does not take a message sent to another session as a turn', () => {
  const sent: Message = {
    ...user,
    id: 'sent',
    agentMessage: {
      kind: 'agent_mention',
      sentTo: { sessionId: 'target', workspaceCwd: '/work/b' },
    },
  };
  expect([
    ...collectHookStatisticsTurns([user, answer, sent], 'session').keys(),
  ]).toEqual(['answer']);
});

it.each([false, true])(
  'keeps hook statistics on the prompt answer after a cross-session relay (sent before answer: %s)',
  (sentBeforeAnswer) => {
    const textBlock = (
      id: string,
      kind: 'user' | 'assistant',
      promptId: string,
    ): DaemonTextTranscriptBlock => ({
      id,
      kind,
      text: id,
      promptId,
      streaming: false,
      clientReceivedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    const sent: DaemonTextTranscriptBlock = {
      ...textBlock('sent', 'user', 'send-record'),
      meta: {
        source: 'agent_mention',
        qwenAgentMessage: {
          kind: 'agent_mention',
          sentTo: { sessionId: 'target', workspaceCwd: '/work/b' },
        },
      },
    };
    const promptAnswer = textBlock('prompt-answer', 'assistant', 'admission');
    const messages = transcriptBlocksToDaemonMessages([
      textBlock('prompt', 'user', 'admission'),
      ...(sentBeforeAnswer ? [sent, promptAnswer] : [promptAnswer, sent]),
      {
        ...textBlock('relay', 'assistant', 'notification'),
        backgroundTurn: {
          turnId: 'notification',
          taskId: 'send-task',
          kind: 'agent',
          startedAt: 2,
        },
      },
    ]);
    expect([...collectHookStatisticsTurns(messages, 'session')]).toEqual([
      [
        'prompt-answer',
        expect.objectContaining({
          promptId: 'admission',
          sessionId: 'session',
        }),
      ],
    ]);
  },
);

it.each([false, true])(
  'keeps tracking the local prompt when a background turn starts first (answered: %s)',
  (answered) => {
    const backgroundTurn = {
      turnId: 'background',
      taskId: 'task',
      kind: 'shell' as const,
      startedAt: 2,
    };
    const localPrompt: DaemonTextTranscriptBlock = {
      id: 'local-prompt',
      kind: 'user',
      text: 'Question',
      promptId: 'admission',
      clientReceivedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const events = [
      ...normalizeDaemonEvent({
        v: 1,
        type: 'session_update',
        promptId: backgroundTurn.turnId,
        data: {
          sessionId: 'session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Processing a background result' },
            _meta: {
              source: 'background_notification_turn_started',
              backgroundTurn,
            },
          },
        },
      }),
      ...normalizeDaemonEvent({
        v: 1,
        type: 'turn_complete',
        promptId: backgroundTurn.turnId,
        data: { sessionId: 'session', stopReason: 'cancelled', backgroundTurn },
      }),
      ...(answered
        ? [
            {
              type: 'assistant.text.delta' as const,
              text: 'Answer',
              promptId: 'admission',
            },
          ]
        : []),
    ];
    const { blocks } = reduceDaemonTranscriptEvents(
      { ...createDaemonTranscriptState(), blocks: [localPrompt] },
      events,
    );
    const messages = transcriptBlocksToDaemonMessages(blocks);
    const target = answered
      ? messages.find((message) => message.role === 'assistant')?.id
      : localPrompt.id;
    expect(target).toBeDefined();
    expect([...collectHookStatisticsTurns(messages, 'session').keys()]).toEqual(
      [target],
    );
  },
);
