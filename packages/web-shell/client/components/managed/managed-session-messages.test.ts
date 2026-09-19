import { describe, expect, it } from 'vitest';
import type { ManagedAgentSessionEvent } from './managed-agent-provider';
import {
  managedEventsToMessages,
  mergeManagedEvents,
} from './managed-session-messages';

function event(
  id: number,
  type: ManagedAgentSessionEvent['type'],
  data?: unknown,
  turnId = 'p1',
): ManagedAgentSessionEvent {
  return { id, at: id * 100, type, sessionId: 's1', turnId, data };
}

describe('Managed transcript projection', () => {
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
