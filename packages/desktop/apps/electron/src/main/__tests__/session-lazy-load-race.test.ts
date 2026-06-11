/**
 * Tests for the ensureSessionMessagesLoadedAtom merge logic.
 *
 * Mirrors the Jotai atom merge logic as a pure function.
 * Catches race conditions between IPC lazy-load and streaming events.
 */
import { describe, it, expect } from 'bun:test'
import type { Message } from '@craft-agent/core'

// ============================================================================
// Mirror: merge logic from ensureSessionMessagesLoadedAtom in atoms/sessions.ts
// ============================================================================

interface SessionLike {
  isProcessing: boolean
  messages: Message[]
  tokenUsage?: { totalTokens: number } | null
  sessionFolderPath?: string
}

/**
 * Mirrors the merge logic in ensureSessionMessagesLoadedAtom.
 * existingSession = current atom state (may have streaming messages)
 * loadedSession = IPC response from getSessionMessages (full history from main process)
 */
function mergeSessionMessages(
  existingSession: SessionLike | undefined,
  loadedSession: SessionLike,
): SessionLike {
  if (!existingSession) {
    return loadedSession
  }

  return {
    ...existingSession,
    // CRITICAL: Don't clobber messages if session is actively streaming
    // AND already has messages in the atom. After Cmd+R reload, the atom
    // starts with messages=[] from getSessions(), so IPC response must be used.
    messages: existingSession.isProcessing && existingSession.messages.length > 0
      ? existingSession.messages
      : loadedSession.messages,
    tokenUsage: loadedSession.tokenUsage ?? existingSession.tokenUsage,
    sessionFolderPath: loadedSession.sessionFolderPath ?? existingSession.sessionFolderPath,
  }
}

// ============================================================================
// Test Helpers
// ============================================================================

function msg(id: string, role: Message['role'] = 'user', extra: Partial<Message> = {}): Message {
  return { id, role, content: `Content of ${id}`, timestamp: Date.now(), ...extra }
}

// ============================================================================
// Tests
// ============================================================================

describe('ensureSessionMessagesLoadedAtom merge logic', () => {
  it('Cmd+R reload: empty atom + isProcessing=true → uses IPC response', () => {
    // After Cmd+R, atom is initialized with { isProcessing: true, messages: [] }
    // from getSessions() which returns metadata-only sessions
    const existing: SessionLike = {
      isProcessing: true,
      messages: [],  // Empty after reload
    }
    const loaded: SessionLike = {
      isProcessing: true,
      messages: [msg('m1', 'user'), msg('m2', 'assistant')],
    }

    const result = mergeSessionMessages(existing, loaded)

    expect(result.messages).toHaveLength(2)
    expect(result.messages[0].id).toBe('m1')
    expect(result.messages[1].id).toBe('m2')
  })

  it('active streaming: non-empty atom + isProcessing=true → keeps existing messages', () => {
    // During active streaming, atom has messages from streaming events
    // that may not be in the IPC response (race window)
    const existing: SessionLike = {
      isProcessing: true,
      messages: [
        msg('m1', 'user'),
        msg('m2', 'assistant', { isStreaming: true }),
      ],
    }
    const loaded: SessionLike = {
      isProcessing: true,
      messages: [msg('m1', 'user')],  // Stale — doesn't have streaming message
    }

    const result = mergeSessionMessages(existing, loaded)

    expect(result.messages).toHaveLength(2)
    expect(result.messages[1].id).toBe('m2')
    expect(result.messages[1].isStreaming).toBe(true)
  })

  it('normal lazy-load: isProcessing=false → uses IPC response', () => {
    const existing: SessionLike = {
      isProcessing: false,
      messages: [],
    }
    const loaded: SessionLike = {
      isProcessing: false,
      messages: [msg('m1', 'user'), msg('m2', 'assistant')],
    }

    const result = mergeSessionMessages(existing, loaded)

    expect(result.messages).toHaveLength(2)
    expect(result.messages).toBe(loaded.messages)
  })

  it('non-message fields update regardless of isProcessing guard', () => {
    const existing: SessionLike = {
      isProcessing: true,
      messages: [msg('m1')],  // Non-empty, guard is active
      tokenUsage: null,
      sessionFolderPath: undefined,
    }
    const loaded: SessionLike = {
      isProcessing: true,
      messages: [msg('m1')],
      tokenUsage: { totalTokens: 500 },
      sessionFolderPath: '/path/to/session',
    }

    const result = mergeSessionMessages(existing, loaded)

    // Messages are guarded (existing kept)
    expect(result.messages).toBe(existing.messages)
    // But metadata fields are updated from IPC
    expect(result.tokenUsage).toEqual({ totalTokens: 500 })
    expect(result.sessionFolderPath).toBe('/path/to/session')
  })

  it('first load (no existing session) → uses IPC response directly', () => {
    const loaded: SessionLike = {
      isProcessing: false,
      messages: [msg('m1', 'user'), msg('m2', 'assistant')],
      tokenUsage: { totalTokens: 100 },
      sessionFolderPath: '/path',
    }

    const result = mergeSessionMessages(undefined, loaded)

    expect(result).toBe(loaded)
  })

  it('processing→complete→lazy-load: isProcessing=false → uses IPC response', () => {
    // Session was processing, complete event fired, now isProcessing=false
    const existing: SessionLike = {
      isProcessing: false,  // complete event already set this
      messages: [msg('m1', 'user'), msg('m2', 'assistant')],
    }
    const loaded: SessionLike = {
      isProcessing: false,
      messages: [
        msg('m1', 'user'),
        msg('m2', 'assistant'),
        msg('m3', 'tool'),  // IPC has more messages (persisted after complete)
      ],
    }

    const result = mergeSessionMessages(existing, loaded)

    // isProcessing is false, so IPC response is used (may have more data)
    expect(result.messages).toHaveLength(3)
    expect(result.messages).toBe(loaded.messages)
  })

  it('tokenUsage fallback: existing tokenUsage preserved when IPC has null', () => {
    const existing: SessionLike = {
      isProcessing: false,
      messages: [],
      tokenUsage: { totalTokens: 200 },
    }
    const loaded: SessionLike = {
      isProcessing: false,
      messages: [msg('m1')],
      tokenUsage: null,
    }

    const result = mergeSessionMessages(existing, loaded)

    // Null-coalescing preserves existing
    expect(result.tokenUsage).toEqual({ totalTokens: 200 })
  })
})
