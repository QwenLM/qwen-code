import { expect, it } from 'vitest';
import { streamAgentTurn } from './stream-agent-turn.js';

it('accumulates only this turn’s reply without rendering thoughts as text', async () => {
  const updates: Array<[string, string | undefined, string | undefined]> = [];
  await streamAgentTurn(
    {
      async *subscribeEvents() {
        for (const [promptId, sessionUpdate, text] of [
          ['other', 'agent_message_chunk', 'wrong conversation'],
          ['turn', 'agent_message_chunk', 'hello'],
          ['turn', 'agent_thought_chunk', 'not reply text'],
          ['turn', 'agent_thought_chunk', ' continued'],
          ['turn', 'agent_message_chunk', ' world'],
        ]) {
          yield {
            v: 1 as const,
            type: 'session_update',
            promptId,
            data: {
              update: { sessionUpdate, content: { type: 'text', text } },
            },
          };
        }
      },
    },
    'session',
    'turn',
    new AbortController().signal,
    (stage, _detail, text, thought) => {
      updates.push([stage, text, thought]);
    },
  );
  expect(updates).toEqual([
    ['responding', 'hello', undefined],
    ['thinking', undefined, 'not reply text'],
    ['thinking', undefined, 'not reply text continued'],
    ['responding', 'hello world', undefined],
  ]);
});
