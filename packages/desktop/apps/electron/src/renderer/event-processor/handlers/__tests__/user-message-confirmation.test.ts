import { describe, expect, it } from 'bun:test'
import type { Message } from '../../../../shared/types'
import { handleUserMessage } from '../session'
import type { SessionState, UserMessageEvent } from '../../types'

function makeUserMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'optimistic-1',
    role: 'user',
    content: '/ralph-loop /qu',
    timestamp: 100,
    isPending: true,
    ...overrides,
  } as Message
}

function makeState(message: Message, isProcessing = true): SessionState {
  return {
    session: {
      id: 'session-1',
      messages: [message],
      isProcessing,
      lastMessageAt: 100,
    } as any,
    streaming: null,
  }
}

describe('handleUserMessage confirmation', () => {
  it('replaces optimistic content with the backend-confirmed message content', () => {
    const state = makeState(makeUserMessage({
      attachments: [{
        id: 'att-1',
        type: 'text',
        name: 'note.txt',
        mimeType: 'text/plain',
        size: 4,
      }] as any,
    }))

    const event: UserMessageEvent = {
      type: 'user_message',
      sessionId: 'session-1',
      optimisticMessageId: 'optimistic-1',
      status: 'accepted',
      message: makeUserMessage({
        id: 'backend-1',
        content: '# Ralph Loop Command\n\nExpanded prompt body',
        timestamp: 200,
        attachments: undefined,
      }),
    }

    const result = handleUserMessage(state, event)
    const message = result.state.session.messages[0]

    expect(message?.id).toBe('backend-1')
    expect(message?.content).toBe('# Ralph Loop Command\n\nExpanded prompt body')
    expect(message?.timestamp).toBe(200)
    expect(message?.isPending).toBe(false)
    expect(message?.isQueued).toBe(false)
    expect(message?.attachments).toHaveLength(1)
  })

  it('does not regress processing state when a queued event arrives late', () => {
    const state = makeState(makeUserMessage({
      id: 'backend-1',
      content: '/ralph-loop /qu',
      isPending: false,
      isQueued: false,
    }))

    const event: UserMessageEvent = {
      type: 'user_message',
      sessionId: 'session-1',
      status: 'queued',
      message: makeUserMessage({
        id: 'backend-1',
        content: '# Ralph Loop Command\n\nExpanded prompt body',
        timestamp: 200,
      }),
    }

    const result = handleUserMessage(state, event)
    const message = result.state.session.messages[0]

    expect(message?.content).toBe('# Ralph Loop Command\n\nExpanded prompt body')
    expect(message?.isQueued).toBe(false)
    expect(result.state.session.isProcessing).toBe(true)
  })
})
