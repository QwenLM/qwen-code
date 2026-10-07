import { describe, expect, it, vi } from 'vitest';
import {
  projectJavaAgentEvent,
  projectJavaAgentItem,
  toTimestamp,
} from './java-managed-agent-event-projector';
import { result } from './managed-tool-result.test-fixtures';
import { managedEventsToMessages } from './managed-session-messages';
import javaFixture from './managed-tool-result.java-fixture.json';
import type {
  JavaAgentEvent,
  JavaAgentItem,
} from './java-managed-agent-client';

describe('java managed agent event projector', () => {
  it('recovers the same tool from real Java publication, snapshot and event responses', () => {
    // Exported by ManagedArtifactApiIntegrationTest after publication/receipt and SQL projection.
    const live = javaFixture.events.flatMap((event) => {
      const projected = projectJavaAgentEvent(event as JavaAgentEvent);
      return projected ? [projected] : [];
    });
    const snapshot = javaFixture.transcript.items.flatMap((item) =>
      projectJavaAgentItem(item as JavaAgentItem),
    );
    const messages = managedEventsToMessages(live, '[truncated]');
    expect(messages).toEqual(managedEventsToMessages(snapshot, '[truncated]'));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'tool_group',
      tools: [
        {
          callId: `${javaFixture.toolResult.result.turn_id}:${javaFixture.toolResult.result.item_id}`,
          toolName: 'run_shell_command',
          status: 'completed',
          rawOutput: 'abc',
          toolResult: javaFixture.toolResult.result,
        },
      ],
    });
    expect(
      javaFixture.toolResult.result.artifacts.map((entry) => entry.byte_length),
    ).toEqual([3, 0]);
  });

  it('renders the same canonical result from a live event and a settled snapshot', () => {
    const cancelled = { ...result, execution_status: 'cancelled' as const };
    const live = projectJavaAgentEvent({
      sequence: 4,
      eventId: 'event-4',
      sessionId: result.session_id,
      turnId: result.turn_id,
      itemId: result.item_id,
      type: 'item.tool_result.updated',
      createdAt: 40,
      terminal: false,
      data: {
        toolCallId: 'model-call',
        input: { command: 'echo test' },
        status: 'cancelled',
        result: cancelled,
      },
    });
    const snapshot = projectJavaAgentItem({
      itemId: result.item_id,
      sessionId: result.session_id,
      turnId: result.turn_id,
      type: 'tool_call',
      role: 'assistant',
      status: 'cancelled',
      content: [],
      attributes: {
        toolCallId: 'model-call',
        input: { command: 'echo test' },
        result: cancelled,
      },
      firstSequence: 4,
      lastSequence: 4,
      createdAt: 40,
      updatedAt: 40,
    });
    const liveMessages = managedEventsToMessages([live!], '[truncated]');
    expect(liveMessages).toEqual(
      managedEventsToMessages(snapshot, '[truncated]'),
    );
    expect(liveMessages[0]).toMatchObject({
      role: 'tool_group',
      tools: [
        {
          callId: 'turn-1:item-1',
          status: 'failed',
          wasCancelled: true,
          toolResult: cancelled,
          args: { command: 'echo test' },
        },
      ],
    });
  });

  it('rebuilds a durable user message prompt from its input_text parts', () => {
    // The durable user branch was only asserted on {id, type}: its prompt
    // must be rebuilt from every input_text part, in order.
    const projected = projectJavaAgentItem({
      itemId: 'user-1',
      sessionId: 's',
      turnId: 't',
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [
        {
          partId: 'part-1',
          type: 'input_text',
          text: 'first',
          firstSequence: 1,
          lastSequence: 1,
        },
        {
          partId: 'part-2',
          type: 'output_text',
          text: 'ignored',
          firstSequence: 2,
          lastSequence: 2,
        },
        {
          partId: 'part-3',
          type: 'input_text',
          text: 'second',
          firstSequence: 3,
          lastSequence: 3,
        },
      ],
      attributes: {},
      firstSequence: 1,
      lastSequence: 3,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(projected).toHaveLength(1);
    expect(projected[0]).toEqual(
      expect.objectContaining({
        type: 'accepted',
        sessionId: 's',
        turnId: 't',
        assembledFromItem: true,
        data: expect.objectContaining({
          itemId: 'user-1',
          prompt: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        }),
      }),
    );
  });

  it('preserves pending tool state in a snapshot', () => {
    expect(
      projectJavaAgentItem({
        itemId: 'item-1',
        sessionId: 's',
        turnId: 't',
        type: 'tool_call',
        role: 'assistant',
        status: 'pending',
        content: [],
        attributes: {},
        firstSequence: 1,
        lastSequence: 1,
        createdAt: 1,
        updatedAt: 1,
      })[0]?.type,
    ).toBe('tool_requested');
  });

  it('replays a store-canonicalized pending tool as requested, not started', () => {
    // The store canonicalizes any unknown status to in_progress but keeps
    // the raw value in attributes.status; an approval-gated tool must not
    // come back as already running after a reload.
    expect(
      projectJavaAgentItem({
        itemId: 'item-1',
        sessionId: 's',
        turnId: 't',
        type: 'tool_call',
        role: 'assistant',
        status: 'in_progress',
        content: [],
        attributes: { status: 'pending' },
        firstSequence: 1,
        lastSequence: 1,
        createdAt: 1,
        updatedAt: 1,
      })[0]?.type,
    ).toBe('tool_requested');
    // A genuinely running tool (no raw hint) still comes back as started.
    expect(
      projectJavaAgentItem({
        itemId: 'item-2',
        sessionId: 's',
        turnId: 't',
        type: 'tool_call',
        role: 'assistant',
        status: 'in_progress',
        content: [],
        attributes: {},
        firstSequence: 2,
        lastSequence: 2,
        createdAt: 2,
        updatedAt: 2,
      })[0]?.type,
    ).toBe('tool_started');
  });

  it('lets a settled canonical status outrank the raw hint', () => {
    // settleTurnItems rewrites item_status when the Turn ends without
    // touching attributes_json: a tool that was still pending at that
    // moment must replay by the canonical status, not its frozen hint.
    expect(
      projectJavaAgentItem({
        itemId: 'item-3',
        sessionId: 's',
        turnId: 't',
        type: 'tool_call',
        role: 'assistant',
        status: 'completed',
        content: [],
        attributes: { status: 'pending' },
        firstSequence: 3,
        lastSequence: 3,
        createdAt: 3,
        updatedAt: 3,
      })[0]?.type,
    ).toBe('tool_completed');
  });

  it('maps a stream.reconciled event to a stream_gap resynchronization', () => {
    // The Java side emits stream.reconciled on continuation retraction;
    // deleting this mapping once stayed invisible to every test.
    expect(
      projectJavaAgentEvent({
        sequence: 9,
        eventId: 'evt_9',
        sessionId: 'session-1',
        turnId: 'turn-1',
        type: 'stream.reconciled',
        createdAt: '2026-09-18T00:00:00Z',
        data: {},
        terminal: false,
      }),
    ).toEqual(
      expect.objectContaining({
        id: 9,
        type: 'stream_gap',
        sessionId: 'session-1',
        turnId: 'turn-1',
      }),
    );
  });

  it('maps canonical events without exposing Java event names', () => {
    expect(
      projectJavaAgentEvent({
        sequence: 4,
        eventId: 'evt_4',
        sessionId: 'session-1',
        turnId: 'turn-1',
        type: 'turn.accepted',
        createdAt: '2026-09-18T00:00:00Z',
        data: { input: [{ type: 'text', text: 'hello' }] },
        terminal: false,
      }),
    ).toEqual(
      expect.objectContaining({
        id: 4,
        type: 'accepted',
        data: {
          input: [{ type: 'text', text: 'hello' }],
          prompt: [{ type: 'text', text: 'hello' }],
        },
      }),
    );

    expect(
      projectJavaAgentEvent({
        sequence: 5,
        eventId: 'evt_5',
        sessionId: 'session-1',
        turnId: 'turn-1',
        type: 'item.tool_call.updated',
        createdAt: 5,
        data: { status: 'completed', toolCallId: 'call-1' },
        terminal: false,
      })?.type,
    ).toBe('tool_completed');
  });

  it('maps an approval update, which carries no Turn', () => {
    expect(
      projectJavaAgentEvent({
        sequence: 9,
        eventId: 'evt_9',
        sessionId: 'session-1',
        turnId: null,
        type: 'action.updated',
        createdAt: 9,
        data: { actionId: 'tool_approval_1', state: 'decided' },
        terminal: false,
      }),
    ).toEqual({
      id: 9,
      at: 9,
      type: 'action_updated',
      sessionId: 'session-1',
      turnId: '',
      data: { actionId: 'tool_approval_1', state: 'decided' },
    });
  });

  it('keeps failed tool status and identity in live events', () => {
    expect(
      projectJavaAgentEvent({
        sequence: 6,
        eventId: 'evt_6',
        sessionId: 'session-1',
        turnId: 'turn-1',
        type: 'item.tool_call.updated',
        createdAt: 6,
        terminal: false,
        data: { status: 'failed', callId: 'call-1', name: 'read_file' },
      }),
    ).toEqual(
      expect.objectContaining({
        type: 'tool_completed',
        data: expect.objectContaining({
          failed: true,
          toolCallId: 'call-1',
          toolName: 'read_file',
        }),
      }),
    );
  });

  it('uses a safe timestamp fallback for invalid legacy values', () => {
    vi.spyOn(Date, 'now').mockReturnValue(42);
    expect(toTimestamp('not-a-date')).toBe(42);
  });

  it('projects a durable message part as one complete delta', () => {
    expect(
      projectJavaAgentItem({
        itemId: 'item-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            partId: 'part-1',
            type: 'output_text',
            text: 'hello world',
            firstSequence: 2,
            lastSequence: 3,
          },
        ],
        attributes: {},
        firstSequence: 2,
        lastSequence: 4,
        createdAt: 20,
        updatedAt: 40,
      }),
    ).toEqual([
      expect.objectContaining({
        id: 2,
        type: 'assistant_delta',
        data: { itemId: 'item-1', text: 'hello world' },
      }),
    ]);
  });
});

it('reports cancellation consistently for live and restored result-less tools', () => {
  const live = [
    projectJavaAgentEvent({
      sequence: 1,
      eventId: 'e1',
      sessionId: 's',
      turnId: 't',
      itemId: 'i',
      type: 'item.tool_call.updated',
      createdAt: 100,
      terminal: false,
      data: {
        status: 'in_progress',
        toolCallId: 'call',
        toolName: 'run_shell_command',
      },
    })!,
    projectJavaAgentEvent({
      sequence: 2,
      eventId: 'e2',
      sessionId: 's',
      turnId: 't',
      type: 'turn.cancelled',
      createdAt: 200,
      terminal: true,
      data: {},
    })!,
  ];
  const snapshot = projectJavaAgentItem({
    itemId: 'i',
    sessionId: 's',
    turnId: 't',
    type: 'tool_call',
    role: 'assistant',
    status: 'cancelled',
    content: [],
    attributes: { toolCallId: 'call', toolName: 'run_shell_command' },
    firstSequence: 1,
    lastSequence: 2,
    createdAt: 100,
    updatedAt: 200,
  });
  const liveMessages = managedEventsToMessages(live, '[truncated]');
  const restoredMessages = managedEventsToMessages(snapshot, '[truncated]');
  expect(restoredMessages[0]).toMatchObject({
    tools: [{ status: 'failed', wasCancelled: true }],
  });
  expect(liveMessages[0]).toMatchObject({
    tools: [{ status: 'failed', wasCancelled: true }],
  });
});
