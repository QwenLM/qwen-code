import { describe, expect, it } from 'bun:test'
import type { Message } from '@craft-agent/core'
import { groupMessagesByTurn, updateGroupedTurnsForStreamingMessage } from '../turn-utils'

describe('updateGroupedTurnsForStreamingMessage', () => {
  it('patches the active streaming assistant activity without regrouping all turns', () => {
    const userMessage: Message = {
      id: 'user-1',
      role: 'user',
      content: 'hello',
      timestamp: 1,
    }
    const streamingMessage: Message = {
      id: 'assistant-1',
      role: 'assistant',
      content: 'hel',
      timestamp: 2,
      isStreaming: true,
      isPending: true,
      turnId: 'turn-1',
    }
    const previousMessages = [userMessage, streamingMessage]
    const previousTurns = groupMessagesByTurn(previousMessages)

    const nextMessages = [
      userMessage,
      {
        ...streamingMessage,
        content: 'hello',
      },
    ]

    const nextTurns = updateGroupedTurnsForStreamingMessage(previousMessages, nextMessages, previousTurns)

    expect(nextTurns).toBeDefined()
    expect(nextTurns?.[0]).toBe(previousTurns[0])
    expect(nextTurns?.[1]).not.toBe(previousTurns[1])

    const assistantTurn = nextTurns?.[1]
    expect(assistantTurn?.type).toBe('assistant')
    if (assistantTurn?.type !== 'assistant') return
    expect(assistantTurn.activities[0]?.content).toBe('hello')
    expect(assistantTurn.isStreaming).toBe(true)
    expect(assistantTurn.isComplete).toBe(false)
  })

  it('does not patch when a message is appended', () => {
    const previousMessages: Message[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'hello',
        timestamp: 1,
      },
    ]
    const previousTurns = groupMessagesByTurn(previousMessages)
    const nextMessages: Message[] = [
      ...previousMessages,
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello',
        timestamp: 2,
        isStreaming: true,
        isPending: true,
      },
    ]

    expect(updateGroupedTurnsForStreamingMessage(previousMessages, nextMessages, previousTurns)).toBeUndefined()
  })

  it('does not patch when streaming metadata changes', () => {
    const previousMessages: Message[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello',
        timestamp: 1,
        isStreaming: true,
        isPending: true,
        turnId: 'turn-1',
      },
    ]
    const previousTurns = groupMessagesByTurn(previousMessages)
    const nextMessages: Message[] = [
      {
        ...previousMessages[0]!,
        content: 'hello world',
        isPending: false,
      },
    ]

    expect(updateGroupedTurnsForStreamingMessage(previousMessages, nextMessages, previousTurns)).toBeUndefined()
  })
})
