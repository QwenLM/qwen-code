import { describe, expect, it } from 'bun:test'
import type { Message, Session, TransportConnectionState } from '../../../shared/types'
import {
  formatSessionLoadFailure,
  hasSessionContentHint,
  mergeSessionRefreshResult,
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

function message(id: string, content = id): Message {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: Date.now(),
  }
}

function session(overrides: Partial<Session>): Session {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    messages: [],
    isProcessing: false,
    lastMessageAt: Date.now(),
    ...overrides,
  } as Session
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

describe('mergeSessionRefreshResult', () => {
  it('keeps existing history when a processing refresh returns an empty message list', () => {
    const existing = session({
      messages: [message('m1'), message('m2')],
      isProcessing: true,
    })
    const fresh = session({
      messages: [],
      isProcessing: true,
    })

    const result = mergeSessionRefreshResult(existing, fresh)

    expect(result.preservedExistingMessages).toBe(true)
    expect(result.session.messages.map(m => m.id)).toEqual(['m1', 'm2'])
  })

  it('merges a shorter processing snapshot into existing history', () => {
    const existing = session({
      messages: [message('m1'), message('m2', 'old'), message('m3')],
      isProcessing: true,
    })
    const fresh = session({
      messages: [message('m2', 'fresh'), message('m4')],
      isProcessing: true,
    })

    const result = mergeSessionRefreshResult(existing, fresh)

    expect(result.preservedExistingMessages).toBe(true)
    expect(result.session.messages.map(m => [m.id, m.content])).toEqual([
      ['m1', 'm1'],
      ['m2', 'fresh'],
      ['m3', 'm3'],
      ['m4', 'm4'],
    ])
  })

  it('does not replace longer streaming text with a shorter processing snapshot', () => {
    const existing = session({
      messages: [
        {
          ...message('m1', 'hello from renderer'),
          isStreaming: true,
        },
      ],
      isProcessing: true,
    })
    const fresh = session({
      messages: [
        {
          ...message('m1', 'hello'),
          isStreaming: true,
        },
      ],
      isProcessing: true,
    })

    const result = mergeSessionRefreshResult(existing, fresh)

    expect(result.preservedExistingMessages).toBe(true)
    expect(result.session.messages[0]?.content).toBe('hello from renderer')
  })

  it('trusts shorter completed refreshes as authoritative', () => {
    const existing = session({
      messages: [message('m1'), message('m2'), message('m3')],
      isProcessing: false,
    })
    const fresh = session({
      messages: [message('m1')],
      isProcessing: false,
    })

    const result = mergeSessionRefreshResult(existing, fresh)

    expect(result.preservedExistingMessages).toBe(false)
    expect(result.session.messages.map(m => m.id)).toEqual(['m1'])
  })
})
