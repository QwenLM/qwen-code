import { describe, expect, it, vi } from 'vitest';
import {
  projectJavaAgentEvent,
  projectJavaAgentItem,
  toTimestamp,
} from './java-managed-agent-event-projector';

describe('java managed agent event projector', () => {
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
