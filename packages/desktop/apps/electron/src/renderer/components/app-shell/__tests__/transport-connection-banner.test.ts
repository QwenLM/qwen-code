import { describe, expect, it } from 'bun:test'
import {
  getTransportBannerCopy,
  shouldShowTransportConnectionBanner,
} from '../TransportConnectionBanner'
import type { TransportConnectionState } from '../../../../shared/types'

function state(overrides: Partial<TransportConnectionState>): TransportConnectionState {
  return {
    mode: 'remote',
    status: 'connected',
    url: 'ws://example.com:9000',
    attempt: 0,
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('shouldShowTransportConnectionBanner', () => {
  it('is hidden for null state', () => {
    expect(shouldShowTransportConnectionBanner(null)).toBe(false)
  })

  it('is hidden when mode is local', () => {
    expect(shouldShowTransportConnectionBanner(state({ mode: 'local', status: 'failed' }))).toBe(false)
  })

  it('is hidden when remote connection is healthy', () => {
    expect(shouldShowTransportConnectionBanner(state({ status: 'connected' }))).toBe(false)
  })

  it('is shown when remote connection is reconnecting', () => {
    expect(shouldShowTransportConnectionBanner(state({ status: 'reconnecting' }))).toBe(true)
  })

  it('is shown when remote connection failed', () => {
    expect(shouldShowTransportConnectionBanner(state({ status: 'failed' }))).toBe(true)
  })
})

describe('getTransportBannerCopy', () => {
  it('maps auth failures to token guidance', () => {
    const copy = getTransportBannerCopy(state({
      status: 'failed',
      lastError: { kind: 'auth', message: 'Invalid token', code: 'AUTH_FAILED' },
    }))

    expect(copy.title).toContain('Cannot connect')
    expect(copy.description).toContain('CRAFT_SERVER_TOKEN')
    expect(copy.showRetry).toBe(true)
    expect(copy.tone).toBe('error')
  })

  it('maps reconnecting state to warning with attempt info', () => {
    const copy = getTransportBannerCopy(state({
      status: 'reconnecting',
      attempt: 3,
      nextRetryInMs: 2000,
      lastError: { kind: 'network', message: 'Connection lost' },
    }))

    expect(copy.title).toContain('Reconnecting')
    expect(copy.description).toContain('attempt 3')
    expect(copy.description).toContain('2000ms')
    expect(copy.tone).toBe('warning')
  })
})
