/**
 * Unit tests for TurnPhase derivation logic.
 *
 * These tests verify that deriveTurnPhase() correctly determines the
 * current lifecycle phase of an assistant turn from its data.
 *
 * The state machine phases are:
 * - pending: Turn created, waiting for first activity
 * - tool_active: At least one tool is running
 * - awaiting: All tools done, waiting for next action (THE GAP!)
 * - streaming: Final response text is streaming
 * - complete: Turn is finished
 */

import { describe, it, expect } from 'bun:test'
import { deriveTurnPhase, shouldShowThinkingIndicator, type TurnPhase, type AssistantTurn } from '../turn-utils'
import type { ActivityItem, ResponseContent } from '../TurnCard'

// ============================================================================
// Test Helpers
// ============================================================================

/** Create a minimal turn for testing */
function createTurn(overrides: Partial<AssistantTurn> = {}): AssistantTurn {
  return {
    type: 'assistant',
    turnId: 'test-turn',
    activities: [],
    response: undefined,
    intent: undefined,
    isStreaming: false,
    isComplete: false,
    timestamp: Date.now(),
    ...overrides,
  }
}

/** Create a tool activity */
function createActivity(status: 'pending' | 'running' | 'completed' | 'error', name = 'TestTool'): ActivityItem {
  return {
    id: `activity-${Math.random().toString(36).slice(2)}`,
    type: 'tool',
    status,
    toolName: name,
    timestamp: Date.now(),
  }
}

/** Create a response */
function createResponse(isStreaming: boolean, text = 'Test response'): ResponseContent {
  return {
    text,
    isStreaming,
    streamStartTime: isStreaming ? Date.now() : undefined,
  }
}

// ============================================================================
// deriveTurnPhase Tests
// ============================================================================

describe('deriveTurnPhase', () => {
  describe('PENDING state', () => {
    it('returns pending when no activities and not complete', () => {
      const turn = createTurn({
        activities: [],
        isComplete: false,
        response: undefined,
      })
      expect(deriveTurnPhase(turn)).toBe('pending')
    })

    it('returns pending when turn just started (no activities, no response)', () => {
      const turn = createTurn({
        activities: [],
        isComplete: false,
        isStreaming: true, // Streaming started but no content yet
      })
      expect(deriveTurnPhase(turn)).toBe('pending')
    })
  })

  describe('TOOL_ACTIVE state', () => {
    it('returns tool_active when any activity is running', () => {
      const turn = createTurn({
        activities: [createActivity('running')],
        isComplete: false,
      })
      expect(deriveTurnPhase(turn)).toBe('tool_active')
    })

    it('returns tool_active with mix of running and completed', () => {
      const turn = createTurn({
        activities: [
          createActivity('completed', 'Tool1'),
          createActivity('running', 'Tool2'),
        ],
        isComplete: false,
      })
      expect(deriveTurnPhase(turn)).toBe('tool_active')
    })

    it('returns tool_active even with pending activities if one is running', () => {
      const turn = createTurn({
        activities: [
          createActivity('pending', 'Tool1'),
          createActivity('running', 'Tool2'),
        ],
        isComplete: false,
      })
      expect(deriveTurnPhase(turn)).toBe('tool_active')
    })

    it('returns tool_active with multiple running tools', () => {
      const turn = createTurn({
        activities: [
          createActivity('running', 'Tool1'),
          createActivity('running', 'Tool2'),
        ],
        isComplete: false,
      })
      expect(deriveTurnPhase(turn)).toBe('tool_active')
    })
  })

  describe('AWAITING state (the gap)', () => {
    it('returns awaiting when all tools complete but turn not complete', () => {
      const turn = createTurn({
        activities: [createActivity('completed')],
        isComplete: false,
        response: undefined,
      })
      expect(deriveTurnPhase(turn)).toBe('awaiting')
    })

    it('returns awaiting with multiple completed tools', () => {
      const turn = createTurn({
        activities: [
          createActivity('completed', 'Tool1'),
          createActivity('completed', 'Tool2'),
        ],
        isComplete: false,
      })
      expect(deriveTurnPhase(turn)).toBe('awaiting')
    })

    it('returns awaiting with error activities (errors are not running)', () => {
      const turn = createTurn({
        activities: [createActivity('error')],
        isComplete: false,
        response: undefined,
      })
      expect(deriveTurnPhase(turn)).toBe('awaiting')
    })

    it('returns awaiting with mix of completed and error activities', () => {
      const turn = createTurn({
        activities: [
          createActivity('completed', 'Tool1'),
          createActivity('error', 'Tool2'),
        ],
        isComplete: false,
      })
      expect(deriveTurnPhase(turn)).toBe('awaiting')
    })

    it('returns awaiting when response exists but is not streaming (non-streaming response means complete, but isComplete takes precedence)', () => {
      // This is an edge case - if response.isStreaming is false, we should
      // really be complete. But the deriveTurnPhase function uses isComplete
      // as the authoritative signal for completion.
      const turn = createTurn({
        activities: [createActivity('completed')],
        isComplete: false,
        response: createResponse(false),
      })
      expect(deriveTurnPhase(turn)).toBe('awaiting')
    })
  })

  describe('STREAMING state', () => {
    it('returns streaming when response is streaming', () => {
      const turn = createTurn({
        activities: [],
        isComplete: false,
        response: createResponse(true),
      })
      expect(deriveTurnPhase(turn)).toBe('streaming')
    })

    it('returns streaming when response is streaming after tools', () => {
      const turn = createTurn({
        activities: [createActivity('completed')],
        isComplete: false,
        response: createResponse(true),
      })
      expect(deriveTurnPhase(turn)).toBe('streaming')
    })

    it('streaming takes precedence over awaiting when response exists', () => {
      const turn = createTurn({
        activities: [createActivity('completed')],
        isComplete: false,
        response: createResponse(true),
      })
      expect(deriveTurnPhase(turn)).toBe('streaming')
    })
  })

  describe('COMPLETE state', () => {
    it('returns complete when isComplete is true', () => {
      const turn = createTurn({
        activities: [],
        isComplete: true,
      })
      expect(deriveTurnPhase(turn)).toBe('complete')
    })

    it('complete takes precedence over streaming', () => {
      const turn = createTurn({
        activities: [],
        isComplete: true,
        response: createResponse(true), // Still marked as streaming
      })
      expect(deriveTurnPhase(turn)).toBe('complete')
    })

    it('complete takes precedence over tool_active', () => {
      const turn = createTurn({
        activities: [createActivity('running')], // Would be tool_active
        isComplete: true,
      })
      expect(deriveTurnPhase(turn)).toBe('complete')
    })

    it('complete takes precedence over awaiting', () => {
      const turn = createTurn({
        activities: [createActivity('completed')],
        isComplete: true,
      })
      expect(deriveTurnPhase(turn)).toBe('complete')
    })
  })

  describe('priority order', () => {
    it('checks complete first, then streaming, then tool_active, then awaiting, then pending', () => {
      // All signals present - complete should win
      const turn = createTurn({
        activities: [createActivity('running')],
        isComplete: true,
        response: createResponse(true),
      })
      expect(deriveTurnPhase(turn)).toBe('complete')
    })
  })
})

// ============================================================================
// Activity Type Filtering Tests (Bug Fix)
// ============================================================================

describe('activity type filtering', () => {
  it('intermediate text with running status returns awaiting (not tool_active)', () => {
    // BUG FIX: Intermediate text streaming should show "Thinking...", not tool spinners
    const turn = createTurn({
      activities: [{
        id: 'int-1',
        type: 'intermediate',
        status: 'running',  // Streaming commentary
        timestamp: Date.now(),
      }],
      isComplete: false,
    })
    expect(deriveTurnPhase(turn)).toBe('awaiting')
  })

  it('only pending tool activities returns awaiting', () => {
    // Tools queued but not started yet
    const turn = createTurn({
      activities: [{
        id: 'tool-1',
        type: 'tool',
        status: 'pending',
        toolName: 'Read',
        timestamp: Date.now(),
      }],
      isComplete: false,
    })
    expect(deriveTurnPhase(turn)).toBe('awaiting')
  })

  it('status activity with running status returns awaiting', () => {
    // Status activities (e.g., compaction) should not count as tool_active
    const turn = createTurn({
      activities: [{
        id: 'status-1',
        type: 'status',
        status: 'running',
        content: 'Compacting context...',
        timestamp: Date.now(),
      }],
      isComplete: false,
    })
    expect(deriveTurnPhase(turn)).toBe('awaiting')
  })

  it('backgrounded tool returns awaiting', () => {
    // Backgrounded tasks don't need active UI feedback
    const turn = createTurn({
      activities: [{
        id: 'tool-1',
        type: 'tool',
        status: 'backgrounded',
        toolName: 'Task',
        timestamp: Date.now(),
      }],
      isComplete: false,
    })
    expect(deriveTurnPhase(turn)).toBe('awaiting')
  })

  it('tool running + intermediate running returns tool_active', () => {
    // Tool takes precedence - show tool spinner, not just "Thinking..."
    const turn = createTurn({
      activities: [
        {
          id: 'tool-1',
          type: 'tool',
          status: 'running',
          toolName: 'Read',
          timestamp: Date.now(),
        },
        {
          id: 'int-1',
          type: 'intermediate',
          status: 'running',
          timestamp: Date.now() + 100,
        },
      ],
      isComplete: false,
    })
    expect(deriveTurnPhase(turn)).toBe('tool_active')
  })

  it('completed tool + running intermediate returns awaiting', () => {
    // Tool done, intermediate text streaming = show "Thinking..."
    const turn = createTurn({
      activities: [
        {
          id: 'tool-1',
          type: 'tool',
          status: 'completed',
          toolName: 'Read',
          timestamp: Date.now(),
        },
        {
          id: 'int-1',
          type: 'intermediate',
          status: 'running',
          timestamp: Date.now() + 100,
        },
      ],
      isComplete: false,
    })
    expect(deriveTurnPhase(turn)).toBe('awaiting')
  })

  it('multiple non-tool running activities returns awaiting', () => {
    // Status + intermediate both running = still awaiting
    const turn = createTurn({
      activities: [
        {
          id: 'status-1',
          type: 'status',
          status: 'running',
          timestamp: Date.now(),
        },
        {
          id: 'int-1',
          type: 'intermediate',
          status: 'running',
          timestamp: Date.now() + 100,
        },
      ],
      isComplete: false,
    })
    expect(deriveTurnPhase(turn)).toBe('awaiting')
  })
})

// ============================================================================
// shouldShowThinkingIndicator Tests
// ============================================================================

describe('shouldShowThinkingIndicator', () => {
  it('returns true for pending phase', () => {
    expect(shouldShowThinkingIndicator('pending', false)).toBe(true)
    expect(shouldShowThinkingIndicator('pending', true)).toBe(true)
  })

  it('returns true for awaiting phase (the gap)', () => {
    expect(shouldShowThinkingIndicator('awaiting', false)).toBe(true)
    expect(shouldShowThinkingIndicator('awaiting', true)).toBe(true)
  })

  it('returns false for tool_active phase (tools are visible)', () => {
    expect(shouldShowThinkingIndicator('tool_active', false)).toBe(false)
    expect(shouldShowThinkingIndicator('tool_active', true)).toBe(false)
  })

  it('returns true for streaming when buffering', () => {
    expect(shouldShowThinkingIndicator('streaming', true)).toBe(true)
  })

  it('returns false for streaming when not buffering', () => {
    expect(shouldShowThinkingIndicator('streaming', false)).toBe(false)
  })

  it('returns false for complete phase', () => {
    expect(shouldShowThinkingIndicator('complete', false)).toBe(false)
    expect(shouldShowThinkingIndicator('complete', true)).toBe(false)
  })
})
