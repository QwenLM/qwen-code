import { describe, expect, it } from 'bun:test'
import type { TransportConnectionState } from '../../../shared/types'
import {
  formatSessionLoadFailure,
  hasSessionContentHint,
  shouldShowMissingSessionState,
  shouldShowForegroundMessageLoading,
  shouldTreatSessionLoadFailureAsTransportFallback,
} from '../session-load'

function createState(overrides?: Partial<TransportConnectionState>): TransportConnectionState {
  return {
    mode: 'remote',
    status: 'connected',
    url: 'wss://remote.example.test',
    attempt: 0,
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('shouldTreatSessionLoadFailureAsTransportFallback', () => {
  it('returns true for remote reconnecting state', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({ status: 'reconnecting' }),
    )).toBe(true)
  })

  it('returns true for remote auth/network/timeout failures', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({
        status: 'connected',
        lastError: { kind: 'auth', message: 'Bad token' },
      }),
    )).toBe(true)
  })

  it('returns false for remote connected state without transport errors', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({ status: 'connected' }),
    )).toBe(false)
  })

  it('returns false for local transport state', () => {
    expect(shouldTreatSessionLoadFailureAsTransportFallback(
      createState({ mode: 'local', status: 'failed' }),
    )).toBe(false)
  })
})

describe('formatSessionLoadFailure', () => {
  it('prefers Error.message', () => {
    expect(formatSessionLoadFailure(new Error('boom'))).toBe('boom')
  })

  it('falls back to a generic message', () => {
    expect(formatSessionLoadFailure(null)).toBe('Unknown error')
  })
})

describe('shouldShowForegroundMessageLoading', () => {
  it('shows loading while an unloaded session has no visible messages', () => {
    expect(shouldShowForegroundMessageLoading(false, 0)).toBe(true)
  })

  it('keeps already-rendered messages visible during a background reload', () => {
    expect(shouldShowForegroundMessageLoading(false, 2)).toBe(false)
  })

  it('hides loading once the session is marked loaded', () => {
    expect(shouldShowForegroundMessageLoading(true, 0)).toBe(false)
  })

  it('hides loading for metadata-confirmed empty sessions', () => {
    expect(shouldShowForegroundMessageLoading(false, 0, 0)).toBe(false)
  })

  it('shows loading for unloaded sessions with content hints even when metadata count is briefly zero', () => {
    expect(shouldShowForegroundMessageLoading(false, 0, 0, true)).toBe(true)
  })

  it('shows loading when loaded tracking is stale but the session looks non-empty', () => {
    expect(shouldShowForegroundMessageLoading(true, 0, 2, true)).toBe(true)
  })

  it('shows loading for unloaded sessions that metadata says have messages', () => {
    expect(shouldShowForegroundMessageLoading(false, 0, 2)).toBe(true)
  })
})

describe('shouldShowMissingSessionState', () => {
  it('waits before treating an absent session as deleted', () => {
    expect(shouldShowMissingSessionState({
      hasSession: false,
      hasSessionMeta: false,
      missingForMs: 120,
      confirmationDelayMs: 250,
    })).toBe(false)
  })

  it('shows missing state after the absence is confirmed', () => {
    expect(shouldShowMissingSessionState({
      hasSession: false,
      hasSessionMeta: false,
      missingForMs: 250,
      confirmationDelayMs: 250,
    })).toBe(true)
  })

  it('does not show missing state while session data or metadata exists', () => {
    expect(shouldShowMissingSessionState({
      hasSession: true,
      hasSessionMeta: false,
      missingForMs: 500,
      confirmationDelayMs: 250,
    })).toBe(false)

    expect(shouldShowMissingSessionState({
      hasSession: false,
      hasSessionMeta: true,
      missingForMs: 500,
      confirmationDelayMs: 250,
    })).toBe(false)
  })
})

describe('hasSessionContentHint', () => {
  it('treats title or preview metadata as evidence that the session is not an empty draft', () => {
    expect(hasSessionContentHint({ name: '你好', messageCount: 0 })).toBe(true)
    expect(hasSessionContentHint({ preview: 'First user message' })).toBe(true)
  })

  it('returns false for metadata-confirmed empty sessions without content hints', () => {
    expect(hasSessionContentHint({ messageCount: 0 })).toBe(false)
  })
})
