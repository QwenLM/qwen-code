/**
 * Scenario tests for turn lifecycle transitions.
 *
 * These tests verify the turn phase transitions through realistic
 * message flow scenarios, ensuring the state machine correctly
 * handles all common use cases.
 */

import { describe, it, expect } from 'bun:test'
import { deriveTurnPhase, groupMessagesByTurn, type AssistantTurn } from '../turn-utils'
import type { Message } from '@craft-agent/core'

// ============================================================================
// Test Helpers
// ============================================================================

let messageIdCounter = 0
let turnIdCounter = 0

function resetCounters() {
  messageIdCounter = 0
  turnIdCounter = 0
}

function createUserMessage(content = 'Hello'): Message {
  return {
    id: `user-${++messageIdCounter}`,
    role: 'user',
    content,
    timestamp: Date.now() + messageIdCounter * 100,
  }
}

function createToolMessage(
  status: 'running' | 'completed',
  name = 'Read',
  turnId?: string
): Message {
  return {
    id: `tool-${++messageIdCounter}`,
    role: 'tool',
    content: status === 'completed' ? 'Tool result' : '',
    timestamp: Date.now() + messageIdCounter * 100,
    toolName: name,
    toolUseId: `tu-${messageIdCounter}`,
    toolStatus: status === 'completed' ? 'completed' : undefined,
    toolResult: status === 'completed' ? 'Tool result' : undefined,
    turnId: turnId || `turn-${turnIdCounter}`,
  }
}

function createAssistantMessage(
  isStreaming: boolean,
  isIntermediate = false,
  turnId?: string
): Message {
  return {
    id: `assistant-${++messageIdCounter}`,
    role: 'assistant',
    content: 'Response text',
    timestamp: Date.now() + messageIdCounter * 100,
    isStreaming,
    isIntermediate,
    turnId: turnId || `turn-${turnIdCounter}`,
  }
}

/** Update a message in the array (simulating streaming updates) */
function updateMessage(
  messages: Message[],
  id: string,
  updates: Partial<Message>
): Message[] {
  return messages.map(m => (m.id === id ? { ...m, ...updates } : m))
}

/** Get the last assistant turn from grouped turns */
function getLastAssistantTurn(turns: ReturnType<typeof groupMessagesByTurn>): AssistantTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.type === 'assistant') {
      return turns[i] as AssistantTurn
    }
  }
  return undefined
}

// ============================================================================
// Scenario Tests
// ============================================================================

describe('turn lifecycle scenarios', () => {
  describe('simple response flow', () => {
    it('pending → streaming → complete (no tools)', () => {
      resetCounters()

      // 1. User message
      let messages: Message[] = [createUserMessage()]
      let turns = groupMessagesByTurn(messages)
      // No assistant turn yet
      expect(getLastAssistantTurn(turns)).toBeUndefined()

      // 2. Response starts streaming
      messages = [...messages, createAssistantMessage(true)]
      turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('streaming')

      // 3. Response completes
      messages = updateMessage(messages, 'assistant-2', { isStreaming: false })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('complete')
    })
  })

  describe('single tool flow', () => {
    it('pending → tool_active → awaiting → streaming → complete', () => {
      resetCounters()
      turnIdCounter++

      // 1. User message
      let messages: Message[] = [createUserMessage()]

      // 2. Tool starts running
      messages = [...messages, createToolMessage('running')]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 3. Tool completes - THIS IS THE GAP
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 4. Response starts streaming
      messages = [...messages, createAssistantMessage(true)]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('streaming')

      // 5. Response completes
      messages = updateMessage(messages, 'assistant-3', { isStreaming: false })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('complete')
    })
  })

  describe('multi-tool flow', () => {
    it('tool_active → awaiting → tool_active → awaiting → streaming → complete', () => {
      resetCounters()
      turnIdCounter++

      // 1. First tool starts
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. First tool completes - GAP
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 3. Second tool starts
      messages = [...messages, createToolMessage('running', 'Grep')]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 4. Second tool completes - GAP
      messages = updateMessage(messages, 'tool-3', {
        toolStatus: 'completed',
        toolResult: 'Search results...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 5. Response starts
      messages = [...messages, createAssistantMessage(true)]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('streaming')

      // 6. Response completes
      messages = updateMessage(messages, 'assistant-4', { isStreaming: false })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('complete')
    })
  })

  describe('parallel tools flow', () => {
    it('handles multiple tools running in parallel', () => {
      resetCounters()
      turnIdCounter++

      // 1. Multiple tools start
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
        createToolMessage('running', 'Grep'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. First tool completes (second still running)
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active') // Still running

      // 3. Second tool completes - GAP
      messages = updateMessage(messages, 'tool-3', {
        toolStatus: 'completed',
        toolResult: 'Search results...',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')
    })
  })

  describe('tool with error', () => {
    it('error transitions to awaiting (not stuck in tool_active)', () => {
      resetCounters()
      turnIdCounter++

      // 1. Tool starts
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. Tool errors
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: undefined,
        isError: true,
        content: 'File not found',
      })
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')
    })
  })

  describe('interruption', () => {
    it('user message during tool_active marks turn complete', () => {
      resetCounters()
      turnIdCounter++

      // 1. Tool running
      let messages: Message[] = [
        createUserMessage('First question'),
        createToolMessage('running', 'Read'),
      ]
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('tool_active')

      // 2. User interrupts with new message
      messages = [...messages, createUserMessage('Cancel that')]
      turns = groupMessagesByTurn(messages)
      // First assistant turn should now be complete (interrupted)
      const firstAssistantTurn = turns.find(t => t.type === 'assistant') as AssistantTurn
      expect(firstAssistantTurn.isComplete).toBe(true)
      expect(deriveTurnPhase(firstAssistantTurn)).toBe('complete')
    })
  })

  describe('intermediate text', () => {
    it('intermediate text during tool sequence stays in awaiting', () => {
      resetCounters()
      turnIdCounter++

      // 1. Tool completes
      let messages: Message[] = [
        createUserMessage(),
        createToolMessage('running', 'Read'),
      ]
      messages = updateMessage(messages, 'tool-2', {
        toolStatus: 'completed',
        toolResult: 'File contents...',
      })
      let turns = groupMessagesByTurn(messages)
      let assistantTurn = getLastAssistantTurn(turns)!
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')

      // 2. Intermediate text arrives (thinking out loud)
      messages = [...messages, createAssistantMessage(false, true)]
      turns = groupMessagesByTurn(messages)
      assistantTurn = getLastAssistantTurn(turns)!
      // Still awaiting because intermediate text is not the final response
      expect(deriveTurnPhase(assistantTurn)).toBe('awaiting')
    })
  })
})

describe('edge cases', () => {
  it('empty activities array returns pending', () => {
    resetCounters()

    const turn: AssistantTurn = {
      type: 'assistant',
      turnId: 'test',
      activities: [],
      isStreaming: false,
      isComplete: false,
      timestamp: Date.now(),
    }
    expect(deriveTurnPhase(turn)).toBe('pending')
  })

  it('isComplete true with empty activities returns complete', () => {
    const turn: AssistantTurn = {
      type: 'assistant',
      turnId: 'test',
      activities: [],
      isStreaming: false,
      isComplete: true,
      timestamp: Date.now(),
    }
    expect(deriveTurnPhase(turn)).toBe('complete')
  })

  it('response with isStreaming false but isComplete false returns awaiting', () => {
    // This is an edge case - usually when response.isStreaming is false,
    // the turn should be marked complete. But we trust isComplete as
    // the authoritative signal.
    const turn: AssistantTurn = {
      type: 'assistant',
      turnId: 'test',
      activities: [
        {
          id: 'act-1',
          type: 'tool',
          status: 'completed',
          timestamp: Date.now(),
        },
      ],
      response: {
        text: 'Done',
        isStreaming: false,
      },
      isStreaming: false,
      isComplete: false, // Not yet marked complete
      timestamp: Date.now(),
    }
    // Per our priority: complete > streaming > tool_active > awaiting > pending
    // response.isStreaming is false, so not streaming
    // no running tools, so not tool_active
    // has activities, so awaiting
    expect(deriveTurnPhase(turn)).toBe('awaiting')
  })
})
