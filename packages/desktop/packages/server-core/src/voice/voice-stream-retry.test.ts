import { describe, expect, it, jest } from 'bun:test'
import {
  isRetryableVoiceStreamError,
  openVoiceStreamWithRetry,
} from './voice-stream-retry'
import type { VoiceStreamSession } from './voice-stream-session'

describe('isRetryableVoiceStreamError', () => {
  it('does not retry auth, client, unsupported model, or rate-limit errors', () => {
    for (const message of [
      '400 Bad Request',
      '401 Unauthorized',
      '403 Forbidden',
      '404 Not Found',
      '410 Gone',
      '422 Unprocessable Entity',
      '429 Too Many Requests',
      'unauthorised request',
      'model_not_supported',
      'rate limit exceeded',
    ]) {
      expect(isRetryableVoiceStreamError(new Error(message))).toBe(false)
    }
  })

  it('retries transient network and server errors', () => {
    for (const message of ['ECONNRESET', '502 Bad Gateway', '503 unavailable']) {
      expect(isRetryableVoiceStreamError(new Error(message))).toBe(true)
    }
  })
})

function makeSession(): VoiceStreamSession {
  return {
    pushAudio: () => {},
    finish: async () => '',
    abort: () => {},
  }
}

// Flush enough microtask turns for the retry helper to reach its internal
// `await delay()` before we advance the fake clock (the path is several awaits
// deep). Driving backoff with fake timers keeps the test instant — no real wait.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('openVoiceStreamWithRetry', () => {
  it('returns the session on the first successful open without retrying', async () => {
    const session = makeSession()
    let calls = 0
    const open = async () => {
      calls++
      return session
    }
    await expect(openVoiceStreamWithRetry(open)).resolves.toBe(session)
    expect(calls).toBe(1)
  })

  it('retries once after a retryable error and resolves with the retry', async () => {
    jest.useFakeTimers()
    try {
      const session = makeSession()
      let calls = 0
      const open = async () => {
        calls++
        if (calls === 1) throw new Error('ECONNRESET')
        return session
      }
      const promise = openVoiceStreamWithRetry(open)
      await flushMicrotasks()
      jest.advanceTimersByTime(200)
      await expect(promise).resolves.toBe(session)
      expect(calls).toBe(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it('rethrows a non-retryable error without retrying or waiting', async () => {
    let calls = 0
    const open = async () => {
      calls++
      throw new Error('401 Unauthorized')
    }
    await expect(openVoiceStreamWithRetry(open)).rejects.toThrow('401')
    expect(calls).toBe(1)
  })

  it('gives up after the single retry when the retry also fails', async () => {
    jest.useFakeTimers()
    try {
      let calls = 0
      const open = async () => {
        calls++
        throw new Error(`ECONNRESET attempt ${calls}`)
      }
      const promise = openVoiceStreamWithRetry(open)
      // Attach the outcome handler up front so the rejection is never unhandled.
      const settled = promise.then(
        () => ({ ok: true as const }),
        (error: Error) => ({ ok: false as const, error }),
      )
      await flushMicrotasks()
      jest.advanceTimersByTime(200)
      const result = await settled
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.message).toContain('attempt 2')
      }
      expect(calls).toBe(2)
    } finally {
      jest.useRealTimers()
    }
  })
})
