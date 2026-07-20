import { describe, expect, it } from 'bun:test'
import { shouldHandleScopedInputEvent } from '../input-event-guards'

describe('shouldHandleScopedInputEvent', () => {
  it('handles targeted event only for matching session', () => {
    expect(shouldHandleScopedInputEvent({
      sessionId: 'session-a',
      isFocusedPanel: false,
      targetSessionId: 'session-a',
    })).toBe(true)

    expect(shouldHandleScopedInputEvent({
      sessionId: 'session-a',
      isFocusedPanel: true,
      targetSessionId: 'session-b',
    })).toBe(false)
  })

  it('handles untargeted events only for focused panel', () => {
    expect(shouldHandleScopedInputEvent({
      sessionId: 'session-a',
      isFocusedPanel: true,
    })).toBe(true)

    expect(shouldHandleScopedInputEvent({
      sessionId: 'session-a',
      isFocusedPanel: false,
    })).toBe(false)
  })
})
