import { setTimeout as delay } from 'node:timers/promises'
import { connect as netConnect } from 'node:net'
import { describe, expect, it } from 'bun:test'
import WebSocket from 'ws'
import type { Logger } from '../runtime/platform'
import {
  classifyVoiceUpgrade,
  closeVoiceClients,
  closeVoiceServerResources,
  isAllowedVoiceOrigin,
  startVoiceServer,
  terminateDisabledVoiceClients,
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
    // No `qwen://` scheme is registered anywhere, so an unregistered custom
    // scheme must not pass origin validation.
    expect(isAllowedVoiceOrigin('qwen://app')).toBe(false)
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

  it('gracefully closes clients before force-terminating them', async () => {
    const events: string[] = []
    const client = {
      close: () => events.push('close'),
      terminate: () => events.push('terminate'),
    }

    await closeVoiceServerResources(
      {
        close: (cb?: () => void) => cb?.(),
        closeAllConnections: () => undefined,
      },
      {
        clients: new Set([client]),
        close: () => undefined,
      },
      100, // timeoutMs ceiling
      5, // short grace before terminate
    )

    // The graceful WS close must precede the brutal terminate so an in-flight
    // transcript can flush instead of being dropped by a TCP reset.
    expect(events[0]).toBe('close')
    expect(events).toContain('terminate')
    expect(events.indexOf('close')).toBeLessThan(events.indexOf('terminate'))
  })

  it('logs shutdown start (with client count), force-terminate, and completion', async () => {
    const logger = createFakeLogger()
    const client = { close: () => undefined, terminate: () => undefined }

    await closeVoiceServerResources(
      {
        close: (cb?: () => void) => cb?.(),
        closeAllConnections: () => undefined,
      },
      {
        clients: new Set([client]),
        close: () => undefined,
      },
      100, // timeoutMs ceiling
      5, // short grace before terminate
      logger,
    )

    expect(
      logger.infos.some((m) =>
        m.includes('shutting down stream server (1 active client(s))'),
      ),
    ).toBe(true)
    // The fake client never removes itself from the set, so it is a straggler.
    expect(
      logger.warnings.some((m) =>
        m.includes('force-terminated 1 straggling client(s)'),
      ),
    ).toBe(true)
    expect(
      logger.infos.some((m) => m.includes('stream server shutdown complete')),
    ).toBe(true)
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

describe('terminateDisabledVoiceClients', () => {
  it('logs the straggler count when clients are force-terminated', () => {
    const logger = createFakeLogger()
    let firstTerminated = false
    let secondTerminated = false

    const terminated = terminateDisabledVoiceClients(
      {
        clients: new Set([
          { terminate: () => (firstTerminated = true) },
          { terminate: () => (secondTerminated = true) },
        ]),
      },
      logger,
    )

    expect(terminated).toBe(2)
    expect(firstTerminated).toBe(true)
    expect(secondTerminated).toBe(true)
    expect(
      logger.warnings.some((m) =>
        m.includes(
          'force-terminated 2 straggling client(s) after disable-grace period',
        ),
      ),
    ).toBe(true)
  })

  it('does not log when there are no straggling clients', () => {
    const logger = createFakeLogger()

    const terminated = terminateDisabledVoiceClients(
      { clients: new Set() },
      logger,
    )

    expect(terminated).toBe(0)
    expect(logger.warnings).toEqual([])
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

describe('classifyVoiceUpgrade', () => {
  const base = {
    pathname: '/voice/stream',
    token: 'voice-token',
    origin: undefined,
    expectedToken: 'voice-token',
    isEnabled: () => true,
    allowedOrigins: [] as readonly string[],
  }

  it('rejects a wrong path with 404 before any other guard', () => {
    expect(
      classifyVoiceUpgrade({ ...base, pathname: '/nope', token: 'wrong' }),
    ).toEqual({ status: 404, statusText: 'Not Found', reason: 'bad-path' })
  })

  it('rejects a disabled server with 403', () => {
    expect(
      classifyVoiceUpgrade({ ...base, isEnabled: () => false }),
    ).toEqual({ status: 403, statusText: 'Forbidden', reason: 'disabled' })
  })

  it('rejects a disallowed origin with 403', () => {
    expect(
      classifyVoiceUpgrade({ ...base, origin: 'https://evil.example' }),
    ).toEqual({ status: 403, statusText: 'Forbidden', reason: 'bad-origin' })
  })

  it('rejects a bad/missing token with 401', () => {
    expect(classifyVoiceUpgrade({ ...base, token: 'wrong' })).toEqual({
      status: 401,
      statusText: 'Unauthorized',
      reason: 'bad-token',
    })
    expect(classifyVoiceUpgrade({ ...base, token: null })).toEqual({
      status: 401,
      statusText: 'Unauthorized',
      reason: 'bad-token',
    })
  })

  it('allows a valid upgrade (returns null)', () => {
    expect(classifyVoiceUpgrade(base)).toBeNull()
  })

  it('checks the token before the disk-reading isEnabled guard', () => {
    // isEnabled wraps loadStoredConfig (an uncached disk read); a bad token must
    // short-circuit before it so unauthenticated upgrades never touch disk.
    let isEnabledCalls = 0
    const result = classifyVoiceUpgrade({
      ...base,
      token: 'wrong',
      isEnabled: () => {
        isEnabledCalls++
        return false
      },
    })
    expect(result).toEqual({
      status: 401,
      statusText: 'Unauthorized',
      reason: 'bad-token',
    })
    expect(isEnabledCalls).toBe(0)
  })
})

interface FakeLogger extends Logger {
  warnings: string[]
  infos: string[]
}

function createFakeLogger(): FakeLogger {
  const warnings: string[] = []
  const infos: string[] = []
  return {
    warnings,
    infos,
    info: (...args: unknown[]) => infos.push(args.map(String).join(' ')),
    warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
    error: () => {},
    debug: () => {},
  }
}

// Drive a real upgrade over a raw TCP socket (so we control the Origin header,
// which Bun's bundled ws client drops) and report whether the server upgraded.
// The accept path flushes a `101 Switching Protocols` line; rejections write an
// HTTP status then `socket.destroy()` whose body the client never sees — so we
// assert upgrade-vs-reject here and the exact status via classifyVoiceUpgrade.
function attemptOpen(opts: {
  port: number
  path: string
  origin?: string
}): Promise<'open' | 'rejected'> {
  return new Promise((resolve) => {
    const lines = [
      `GET ${opts.path} HTTP/1.1`,
      `Host: 127.0.0.1:${opts.port}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
    ]
    if (opts.origin) lines.push(`Origin: ${opts.origin}`)
    const socket = netConnect({ host: '127.0.0.1', port: opts.port }, () => {
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    socket.setTimeout(5000)
    let raw = ''
    let settled = false
    const done = (outcome: 'open' | 'rejected') => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(outcome)
    }
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8')
      if (/^HTTP\/1\.1 101/.test(raw)) done('open')
      else if (raw.includes('\r\n')) done('rejected')
    })
    socket.on('error', () => done('rejected'))
    socket.on('close', () => done('rejected'))
    socket.on('timeout', () => done('rejected'))
  })
}

describe('startVoiceServer upgrade rejection guards (integration)', () => {
  it('rejects each guard without upgrading, logging the matching guard', async () => {
    let enabled = true
    const logger = createFakeLogger()
    const server = await startVoiceServer({
      token: 'voice-token',
      isEnabled: () => enabled,
      allowedOrigins: [],
      logger,
      resolveConfig: () => ({
        model: 'qwen3-asr-flash',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      }),
    })
    const validPath = '/voice/stream?token=voice-token'
    try {
      // Positive control: a valid request upgrades (proves attemptOpen detects it).
      expect(await attemptOpen({ port: server.port, path: validPath })).toBe('open')

      // Wrong path -> rejected (404).
      expect(
        await attemptOpen({ port: server.port, path: '/nope?token=voice-token' }),
      ).toBe('rejected')
      expect(logger.warnings.some((w) => w.includes('rejected upgrade for path'))).toBe(true)

      // Disallowed origin -> rejected (403).
      expect(
        await attemptOpen({
          port: server.port,
          path: validPath,
          origin: 'https://evil.example',
        }),
      ).toBe('rejected')
      expect(logger.warnings.some((w) => w.includes('rejected upgrade with origin'))).toBe(true)

      // Bad token -> rejected (401).
      expect(
        await attemptOpen({ port: server.port, path: '/voice/stream?token=wrong' }),
      ).toBe('rejected')
      expect(logger.warnings.some((w) => w.includes('rejected upgrade with invalid token'))).toBe(true)

      // Disabled -> rejected (403).
      enabled = false
      expect(await attemptOpen({ port: server.port, path: validPath })).toBe('rejected')
      expect(logger.warnings.some((w) => w.includes('rejected upgrade while disabled'))).toBe(true)
      enabled = true
    } finally {
      await server.close()
    }
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
