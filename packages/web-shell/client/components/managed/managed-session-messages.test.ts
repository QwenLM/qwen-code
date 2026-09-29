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
    ).toMatchObject({ tools: [{ status: 'failed' }] });
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
});
