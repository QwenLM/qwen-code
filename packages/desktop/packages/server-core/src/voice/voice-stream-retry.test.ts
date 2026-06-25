import { describe, expect, it } from 'bun:test'
import { isRetryableVoiceStreamError } from './voice-stream-retry'

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
