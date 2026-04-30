import { describe, expect, it } from 'bun:test'
import { handleMessageAnnotationsUpdated, handleMessageContentUpdated } from '../session'
import type { MessageContentUpdatedEvent, SessionState, MessageAnnotationsUpdatedEvent } from '../../types'

function makeState(messages: any[]): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: Date.now(),
    } as any,
    streaming: null,
  }
}

describe('handleMessageAnnotationsUpdated', () => {
  it('updates annotations only on the targeted message', () => {
    const state = makeState([
      { id: 'msg-a', role: 'assistant', content: 'alpha', annotations: [] },
      { id: 'msg-b', role: 'assistant', content: 'beta' },
    ])

    const annotations = [
      {
        id: 'ann-1',
        schemaVersion: 1 as const,
        createdAt: 1700000000000,
        motivation: 'highlighting' as const,
        body: [{ type: 'highlight' as const }],
        target: {
          source: { sessionId: 'session-1', messageId: 'msg-b' },
          selectors: [
            { type: 'text-position' as const, start: 0, end: 4 },
            { type: 'text-quote' as const, exact: 'beta' },
          ],
        },
      },
    ]

    const event: MessageAnnotationsUpdatedEvent = {
      type: 'message_annotations_updated',
      sessionId: 'session-1',
      messageId: 'msg-b',
      annotations,
    }

    const next = handleMessageAnnotationsUpdated(state, event)
    expect((next.state.session.messages[0] as any).annotations).toEqual([])
    expect((next.state.session.messages[1] as any).annotations).toEqual(annotations)
  })
})

describe('handleMessageContentUpdated', () => {
  it('replaces only the targeted message with the authoritative payload', () => {
    const state = makeState([
      { id: 'msg-a', role: 'user', content: 'alpha', timestamp: 100 },
      { id: 'msg-b', role: 'user', content: 'beta', timestamp: 200, badges: [{ type: 'source' }] },
    ])

    const event: MessageContentUpdatedEvent = {
      type: 'message_content_updated',
      sessionId: 'session-1',
      message: {
        id: 'msg-b',
        role: 'user',
        content: 'edited beta',
        timestamp: 200,
      } as any,
    }

    const next = handleMessageContentUpdated(state, event)
    expect((next.state.session.messages[0] as any).content).toBe('alpha')
    expect((next.state.session.messages[1] as any).content).toBe('edited beta')
    expect((next.state.session.messages[1] as any).badges).toBeUndefined()
  })
})
