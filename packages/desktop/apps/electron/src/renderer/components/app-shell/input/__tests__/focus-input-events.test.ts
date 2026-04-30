import { describe, expect, it, beforeEach } from 'bun:test'
import {
  __resetPendingFocusForTests,
  clearPendingFocusForSession,
  consumePendingFocusForSession,
  queuePendingFocusForSession,
} from '../focus-input-events'

describe('focus-input-events pending focus queue', () => {
  beforeEach(() => {
    __resetPendingFocusForTests()
  })

  it('consumes only matching queued session focus request', () => {
    queuePendingFocusForSession('session-b')

    expect(consumePendingFocusForSession('session-a')).toBe(false)
    expect(consumePendingFocusForSession('session-b')).toBe(true)
  })

  it('consumption is one-shot', () => {
    queuePendingFocusForSession('session-b')

    expect(consumePendingFocusForSession('session-b')).toBe(true)
    expect(consumePendingFocusForSession('session-b')).toBe(false)
  })

  it('clear removes queued focus for that session', () => {
    queuePendingFocusForSession('session-b')
    clearPendingFocusForSession('session-b')

    expect(consumePendingFocusForSession('session-b')).toBe(false)
  })

  it('latest queued session wins', () => {
    queuePendingFocusForSession('session-a')
    queuePendingFocusForSession('session-b')

    expect(consumePendingFocusForSession('session-a')).toBe(false)
    expect(consumePendingFocusForSession('session-b')).toBe(true)
  })
})
