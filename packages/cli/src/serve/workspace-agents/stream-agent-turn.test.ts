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
    ({ stage, outputText, thoughtText }) => {
      updates.push([stage, outputText, thoughtText]);
    },
  );
  expect(updates).toEqual([
    ['responding', 'hello', undefined],
    ['thinking', undefined, 'not reply text'],
    ['thinking', undefined, 'not reply text continued'],
    ['responding', 'hello world', undefined],
  ]);
});

it('reports a pending approval for this turn and clears it once answered', async () => {
  const updates: Array<[string, unknown]> = [];
  await streamAgentTurn(
    {
      async *subscribeEvents() {
        yield {
          v: 1 as const,
          type: 'permission_request',
          promptId: 'other',
          data: { requestId: 'r0', toolCall: { title: 'not ours' } },
        };
        yield {
          v: 1 as const,
          type: 'permission_request',
          promptId: 'turn',
          data: {
            requestId: 'r1',
            toolCall: { title: 'Shell: npm test' },
            options: [{ optionId: 'allow', name: 'Allow' }],
          },
        };
        yield {
          v: 1 as const,
          type: 'permission_resolved',
          promptId: 'turn',
          data: { requestId: 'r1' },
        };
      },
    },
    'session',
    'turn',
    new AbortController().signal,
    ({ stage, permission }) => {
      updates.push([stage, permission]);
    },
  );
  expect(updates).toEqual([
    [
      'awaiting_approval',
      {
        requestId: 'r1',
        title: 'Shell: npm test',
        options: [{ optionId: 'allow', name: 'Allow' }],
      },
    ],
    ['tool', null],
  ]);
});

it('keeps a step per tool call and updates it in place as it finishes', async () => {
  const steps: unknown[] = [];
  await streamAgentTurn(
    {
      async *subscribeEvents() {
        for (const update of [
          { toolCallId: 'a', title: 'Read src/a.ts', status: 'in_progress' },
          { toolCallId: 'b', title: 'Shell: npm test', status: 'pending' },
          // An update without a title or status keeps what the call had.
          { toolCallId: 'a' },
          { toolCallId: 'a', status: 'completed' },
          { toolCallId: 'b', status: 'failed' },
        ]) {
          yield {
            v: 1 as const,
            type: 'session_update',
            promptId: 'turn',
            data: { update: { sessionUpdate: 'tool_call_update', ...update } },
          };
        }
      },
    },
    'session',
    'turn',
    new AbortController().signal,
    (update) => steps.push(update.steps),
  );
  expect(steps.at(2)).toEqual([
    { id: 'a', title: 'Read src/a.ts', status: 'running' },
    { id: 'b', title: 'Shell: npm test', status: 'running' },
  ]);
  expect(steps.at(-1)).toEqual([
    { id: 'a', title: 'Read src/a.ts', status: 'done' },
    { id: 'b', title: 'Shell: npm test', status: 'failed' },
  ]);
});
