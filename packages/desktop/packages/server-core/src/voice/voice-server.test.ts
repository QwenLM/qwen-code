import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'bun:test'
import WebSocket from 'ws'
import {
  closeVoiceClients,
  closeVoiceServerResources,
  isAllowedVoiceOrigin,
  startVoiceServer,
  terminateVoiceClients,
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

describe('terminateVoiceClients', () => {
  it('terminates active voice clients', () => {
    let firstTerminated = false
    let secondTerminated = false

    terminateVoiceClients({
      clients: new Set([
        {
          terminate: () => {
            firstTerminated = true
          },
        },
        {
          terminate: () => {
            secondTerminated = true
          },
        },
      ]),
    })

    expect(firstTerminated).toBe(true)
    expect(secondTerminated).toBe(true)
  })
})

describe('closeVoiceClients', () => {
  it('gracefully closes active voice clients with a reason', () => {
    const closes: Array<{ code?: number; reason?: string }> = []

    const count = closeVoiceClients({
      clients: new Set([
        {
          close: (code?: number, reason?: string) => {
            closes.push({ code, reason })
          },
          terminate: () => undefined,
        },
      ]),
    })

    expect(count).toBe(1)
    expect(closes).toEqual([{ code: 1000, reason: 'voice disabled' }])
  })
})

describe('startVoiceServer', () => {
  it('cancels pending disabled-client termination after voice is re-enabled', async () => {
    let enabled = true
    const server = await startVoiceServer({
      token: 'voice-token',
      isEnabled: () => enabled,
      resolveConfig: () => ({
        model: 'qwen3-asr-flash',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
    })
    try {
      const first = new WebSocket(`${server.url}?token=voice-token`)
      await new Promise<void>((resolve) => first.once('open', resolve))

      enabled = false
      await delay(1100)

      enabled = true
      const second = new WebSocket(`${server.url}?token=voice-token`)
      await new Promise<void>((resolve) => second.once('open', resolve))
      await delay(700)

      expect(second.readyState).toBe(WebSocket.OPEN)
      second.close()
    } finally {
      await server.close()
    }
  })
})
