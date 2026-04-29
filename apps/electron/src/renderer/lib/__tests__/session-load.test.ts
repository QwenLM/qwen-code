import { describe, expect, it } from 'bun:test'
import type { TransportConnectionState } from '../../../shared/types'
import {
  formatSessionLoadFailure,
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
})
