import { describe, expect, it } from 'vitest';
import type { ManagedAgentSessionEvent } from './managed-agent-provider';
import {
  managedEventsToMessages,
  mergeManagedEvents,
} from './managed-session-messages';
import { result } from './managed-tool-result.test-fixtures';

function event(
  id: number,
  type: ManagedAgentSessionEvent['type'],
  data?: unknown,
  turnId = 'p1',
): ManagedAgentSessionEvent {
  return { id, at: id * 100, type, sessionId: 's1', turnId, data };
}

describe('Managed transcript projection', () => {
  it('preserves existing output when a result has no preview or a shorter excerpt', () => {
    const source = { ...result, session_id: 's1', turn_id: 'p1' };
    const output = 'complete output';
    for (const preview of [undefined, { text: 'partial', truncated: true }]) {
      const messages = managedEventsToMessages(
        [
          event(1, 'tool_completed', { toolCallId: 'call', output }),
          event(2, 'tool_result_updated', {
            itemId: 'item-1',
            toolCallId: 'call',
            result: { ...source, preview },
          }),
        ],
        '[truncated]',
      );
      expect(messages[0]).toMatchObject({ tools: [{ rawOutput: output }] });
    }
  });

  it('marks a result-only excerpt as truncated and accepts later complete output', () => {
    const source = {
      ...result,
      session_id: 's1',
      turn_id: 'p1',
      preview: { text: 'partial', truncated: true },
    };
    const update = event(1, 'tool_result_updated', {
      itemId: 'item-1',
      toolCallId: 'call',
      result: source,
    });
    expect(managedEventsToMessages([update], '[truncated]')[0]).toMatchObject({
      tools: [{ rawOutput: 'partial\n[truncated]' }],
    });
    expect(
      managedEventsToMessages(
        [
          update,
          event(2, 'tool_completed', {
            toolCallId: 'call',
            output: 'complete output',
          }),
        ],
        '[truncated]',
      )[0],
    ).toMatchObject({ tools: [{ rawOutput: 'complete output' }] });
  });

  it('attaches a late result to its original turn without settling a new response', () => {
    const source = { ...result, session_id: 's1', turn_id: 'p1' };
    const events = [
      event(1, 'accepted', { prompt: [{ type: 'text', text: 'First' }] }),
      event(2, 'tool_completed', {
        toolCallId: 'call',
        toolName: 'run_shell_command',
      }),
      event(3, 'completed'),
      event(
        4,
        'accepted',
        { prompt: [{ type: 'text', text: 'Second' }] },
        'p2',
      ),
      event(5, 'assistant_delta', { text: 'Working' }, 'p2'),
      event(6, 'tool_result_updated', {
        itemId: 'item-1',
        toolCallId: 'call',
        result: source,
      }),
      event(7, 'assistant_delta', { text: ' now' }, 'p2'),
    ];
    const messages = managedEventsToMessages(events, 'truncated');
    expect(messages).toHaveLength(4);
    expect(messages[1]).toMatchObject({
      role: 'tool_group',
      tools: [{ callId: 'p1:item-1', toolResult: source }],
    });
    expect(messages[3]).toMatchObject({
      role: 'assistant',
      content: 'Working now',
      isStreaming: true,
    });
  });

  it('places a result-only tool in its original turn and ignores older projection revisions', () => {
    const source = {
      ...result,
      session_id: 's1',
      turn_id: 'p1',
      projection_revision: 2,
    };
    const messages = managedEventsToMessages(
      [
        event(1, 'accepted', { prompt: [{ type: 'text', text: 'First' }] }),
        event(2, 'completed'),
        event(
          3,
          'accepted',
          { prompt: [{ type: 'text', text: 'Second' }] },
          'p2',
        ),
        event(4, 'tool_result_updated', { itemId: 'item-1', result: source }),
        event(5, 'tool_result_updated', {
          itemId: 'item-1',
          result: {
            ...source,
            projection_revision: 1,
            execution_status: 'error',
          },
        }),
      ],
      'truncated',
    );
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({
      role: 'tool_group',
      tools: [{ status: 'completed', toolResult: source }],
    });
    expect(messages[2]).toMatchObject({ role: 'user', content: 'Second' });
  });
  it('preserves inline images admitted through the Managed API in user history', () => {
    const messages = managedEventsToMessages(
      [
        event(1, 'accepted', {
          prompt: [
            { type: 'text', text: 'Inspect this' },
            { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' },
          ],
        }),
      ],
      '[truncated]',
    );
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: 'Inspect this',
      images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }],
    });
  });

  it('deduplicates replay and preserves distinct turns without merging their answers', () => {
    const events = [
      event(1, 'accepted', { prompt: [{ type: 'text', text: 'First' }] }),
      event(2, 'assistant_delta', { text: 'Hello ' }),
      event(3, 'assistant_delta', { text: 'world' }),
      event(4, 'completed'),
      event(5, 'accepted', { prompt: [{ type: 'text', text: 'Again' }] }, 'p2'),
      event(6, 'assistant_delta', { text: 'Second' }, 'p2'),
    ];
    const merged = mergeManagedEvents(events.slice(0, 4), events.slice(2));
    const messages = managedEventsToMessages(merged, '[truncated]');
    expect(messages).toMatchObject([
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Hello world', isStreaming: false },
      { role: 'user', content: 'Again' },
      { role: 'assistant', content: 'Second', isStreaming: true },
    ]);
    expect(new Set(messages.map((message) => message.id)).size).toBe(4);
  });

  it('keeps approval updates out of the Turn being streamed', () => {
    const messages = managedEventsToMessages(
      [
        event(1, 'accepted', { prompt: [{ type: 'text', text: 'Edit it' }] }),
        event(2, 'assistant_delta', { text: 'Asking ' }),
        event(3, 'action_updated', { actionId: 'a1', state: 'requested' }, ''),
        event(4, 'assistant_delta', { text: 'first' }),
      ],
      '[truncated]',
    );
    expect(messages).toMatchObject([
      { role: 'user', content: 'Edit it' },
      { role: 'assistant', content: 'Asking first', isStreaming: true },
    ]);
    expect(messages).toHaveLength(2);
  });

  it('shows requested tools as pending until tool_started and renders bounded results', () => {
    const request = event(1, 'tool_requested', {
      toolCallId: 'call',
      toolName: 'read_file',
      input: { path: 'README.md' },
    });
    expect(managedEventsToMessages([request], '[truncated]')[0]).toMatchObject({
      tools: [{ status: 'pending', args: { path: 'README.md' } }],
    });
    const started = event(2, 'tool_started', {
      toolCallId: 'call',
      toolName: 'read_file',
    });
    expect(
      managedEventsToMessages([request, started], '[truncated]')[0],
    ).toMatchObject({ tools: [{ status: 'in_progress', startTime: 200 }] });
    const done = event(3, 'tool_completed', {
      toolCallId: 'call',
      toolName: 'read_file',
      output: 'contents',
      truncated: true,
    });
    expect(
      managedEventsToMessages([request, started, done], '[truncated]')[0],
    ).toMatchObject({
      tools: [
        {
          status: 'completed',
          rawOutput: 'contents\n[truncated]',
          endTime: 300,
        },
      ],
    });
  });

  it('settles cancellation and keeps late Runtime failure separate from a completed answer', () => {
    const events = [
      event(1, 'assistant_delta', { text: 'Done' }),
      event(2, 'completed'),
      event(3, 'runtime_failed', { message: 'Warmup failed' }),
    ];
    expect(managedEventsToMessages(events, '[truncated]')).toMatchObject([
      { role: 'assistant', content: 'Done', isStreaming: false },
    ]);
    expect(
      managedEventsToMessages(
        [
          event(1, 'tool_requested', { toolCallId: 'c', toolName: 'run' }),
          event(2, 'cancelled'),
        ],
        '[truncated]',
      )[0],
    ).toMatchObject({ tools: [{ status: 'failed', wasCancelled: true }] });
  });

  it('marks a truncated input summary before a tool result exists', () => {
    const messages = managedEventsToMessages(
      [
        event(1, 'tool_started', {
          toolCallId: 'c',
          toolName: 'run',
          input: 'partial input',
          truncated: true,
        }),
      ],
      '[truncated]',
    );
    expect(messages[0]).toMatchObject({
      tools: [
        {
          status: 'in_progress',
          args: { input: 'partial input\n[truncated]' },
        },
      ],
    });
  });

  it('renders the failed event message as an error bubble', () => {
    const messages = managedEventsToMessages(
      [
        event(1, 'accepted', { prompt: [{ type: 'text', text: 'Go' }] }),
        event(2, 'failed', { message: 'boom' }),
      ],
      '[truncated]',
    );
    expect(messages[1]).toMatchObject({
      role: 'system',
      variant: 'error',
      content: 'boom',
    });
  });

  it('coalesces two assistant_thought deltas into one thinking message', () => {
    const messages = managedEventsToMessages(
      [
        event(1, 'assistant_thought', { text: 'plan ' }),
        event(2, 'assistant_thought', { text: 'step' }),
      ],
      '[truncated]',
    );
    expect(messages).toMatchObject([
      { role: 'thinking', content: 'plan step', isStreaming: true },
    ]);
    expect(messages).toHaveLength(1);
  });

  it('marks a failed tool completed from its failed flag', () => {
    const messages = managedEventsToMessages(
      [
        event(1, 'tool_started', { toolCallId: 'c' }),
        event(2, 'tool_completed', { toolCallId: 'c', failed: true }),
      ],
      '[truncated]',
    );
    expect(messages[0]).toMatchObject({ tools: [{ status: 'failed' }] });
  });
});

it('preserves the order of assistant / current-turn result / assistant', () => {
  const event = (
    id: number,
    type: ManagedAgentSessionEvent['type'],
    data: unknown,
  ): ManagedAgentSessionEvent => ({
    id,
    at: id,
    type,
    sessionId: 's1',
    turnId: 'p1',
    data,
  });
  const messages = managedEventsToMessages(
    [
      event(1, 'assistant_delta', { text: 'Before' }),
      event(2, 'tool_result_updated', {
        itemId: 'item-1',
        result: {
          ...result,
          session_id: 's1',
          turn_id: 'p1',
          artifacts: result.artifacts.map((a) => ({ ...a, session_id: 's1' })),
        },
      }),
      event(3, 'assistant_delta', { text: 'After' }),
    ],
    '[truncated]',
  );
  expect(messages.map(({ role }) => role)).toEqual([
    'assistant',
    'tool_group',
    'assistant',
  ]);
  expect(messages[0]).toMatchObject({ content: 'Before' });
  expect(messages[2]).toMatchObject({ content: 'After' });
});

it('rejects every documented malformed result identity/status arm', () => {
  const source = { ...result, session_id: 's1', turn_id: 'p1' };
  const invalid = [
    { id: 1 },
    { id: '' },
    { session_id: 'foreign' },
    { turn_id: 'foreign' },
    { item_id: 'foreign' },
    { projection_revision: 0 },
    { projection_revision: 1.5 },
    { projection_revision: 9007199254740992 },
    { execution_status: 'unknown' },
    { execution_status: ['success'] },
    { execution_status: ['cancelled'] },
    { artifacts: {} },
  ];
  for (const change of invalid) {
    const messages = managedEventsToMessages(
      [
        {
          id: 1,
          at: 1,
          type: 'tool_result_updated',
          sessionId: 's1',
          turnId: 'p1',
          data: { itemId: 'item-1', result: { ...source, ...change } },
        },
      ],
      '[truncated]',
    );
    expect(
      messages
        .flatMap((message) => ('tools' in message ? (message.tools ?? []) : []))
        .map((tool) => tool.toolResult)
        .filter(Boolean),
    ).toEqual([]);
  }
});

it.each([undefined, null, '', 1, ['item-1'], {}])(
  'rejects matching malformed Item identities %j instead of using the call ID',
  (itemId) => {
    const messages = managedEventsToMessages(
      [
        event(1, 'tool_result_updated', {
          itemId,
          toolCallId: 'call',
          result: {
            ...result,
            session_id: 's1',
            turn_id: 'p1',
            item_id: itemId,
          },
        }),
      ],
      '[truncated]',
    );
    expect(messages[0]).toMatchObject({ tools: [{ status: 'pending' }] });
    expect(
      messages[0].role === 'tool_group' && messages[0].tools[0].toolResult,
    ).toBeUndefined();
  },
);

it.each([undefined, null, '', 1, ['committed'], {}, 'purged'])(
  'rejects an unknown delivery status %j',
  (delivery_status) => {
    const messages = managedEventsToMessages(
      [
        event(1, 'tool_result_updated', {
          itemId: 'item-1',
          result: {
            ...result,
            session_id: 's1',
            turn_id: 'p1',
            delivery_status,
          },
        }),
      ],
      '[truncated]',
    );
    expect(
      messages[0].role === 'tool_group' && messages[0].tools[0].toolResult,
    ).toBeUndefined();
  },
);

it.each(['pending', 'committed', 'blocked'])(
  'accepts the documented delivery status %s',
  (delivery_status) => {
    const source = {
      ...result,
      session_id: 's1',
      turn_id: 'p1',
      delivery_status,
    };
    const messages = managedEventsToMessages(
      [event(1, 'tool_result_updated', { itemId: 'item-1', result: source })],
      '[truncated]',
    );
    expect(messages[0]).toMatchObject({ tools: [{ toolResult: source }] });
  },
);

it.each([true, false, 'yes', 1, {}, null, undefined])(
  'marks a preview as truncated only for boolean true: %j',
  (truncated) => {
    const messages = managedEventsToMessages(
      [
        event(1, 'tool_result_updated', {
          itemId: 'item-1',
          result: {
            ...result,
            session_id: 's1',
            turn_id: 'p1',
            preview: { text: 'abc', truncated },
          },
        }),
      ],
      '[truncated]',
    );
    expect(messages[0]).toMatchObject({
      tools: [{ rawOutput: truncated === true ? 'abc\n[truncated]' : 'abc' }],
    });
  },
);

it.each([{}, 'abc', { truncated: true }, { text: 1 }])(
  'ignores malformed preview text %j',
  (preview) => {
    const messages = managedEventsToMessages(
      [
        event(1, 'tool_result_updated', {
          itemId: 'item-1',
          result: { ...result, session_id: 's1', turn_id: 'p1', preview },
        }),
      ],
      '[truncated]',
    );
    const tools = messages.flatMap((message) =>
      'tools' in message ? (message.tools ?? []) : [],
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].rawOutput).toBeUndefined();
    expect(tools[0].toolResult).toBeDefined();
  },
);
