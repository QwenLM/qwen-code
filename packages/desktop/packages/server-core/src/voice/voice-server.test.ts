import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'bun:test'
import {
  closeVoiceServerResources,
  isAllowedVoiceOrigin,
  tokenMatches,
} from './voice-server'

describe('tokenMatches', () => {
  it('accepts the exact token only', () => {
    expect(tokenMatches('secret-token', 'secret-token')).toBe(true)
    expect(tokenMatches(null, 'secret-token')).toBe(false)
    expect(tokenMatches('wrong-token', 'secret-token')).toBe(false)
    expect(tokenMatches('secret-token-extra', 'secret-token')).toBe(false)
  })
})

describe('isAllowedVoiceOrigin', () => {
  it('allows app origins and rejects browser origins', () => {
    expect(isAllowedVoiceOrigin(undefined)).toBe(true)
    expect(isAllowedVoiceOrigin('file://')).toBe(true)
    expect(isAllowedVoiceOrigin('qwen://app')).toBe(true)
    expect(
      isAllowedVoiceOrigin('http://localhost:5173', [
        'http://localhost:5173',
      ]),
    ).toBe(true)
    expect(isAllowedVoiceOrigin('https://evil.example')).toBe(false)
  })
})

describe('closeVoiceServerResources', () => {
  it('resolves even if httpServer.close never calls back', async () => {
    let closeAllConnectionsCalled = false
    let wssClosed = false
    let clientTerminated = false

    const close = closeVoiceServerResources(
      {
        close: () => undefined,
        closeAllConnections: () => {
          closeAllConnectionsCalled = true
        },
      },
      {
        clients: new Set([
          {
            terminate: () => {
              clientTerminated = true
            },
          },
        ]),
        close: () => {
          wssClosed = true
        },
      },
      10,
    )

    const result = await Promise.race([
      close.then(() => 'closed'),
      delay(100).then(() => 'timeout'),
    ])

    expect(result).toBe('closed')
    expect(closeAllConnectionsCalled).toBe(true)
    expect(wssClosed).toBe(true)
    expect(clientTerminated).toBe(true)
  })
})
