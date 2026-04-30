import { describe, it, expect, afterEach } from 'bun:test'
import { CliRpcClient } from './client.ts'
import {
  serializeEnvelope,
  deserializeEnvelope,
} from '@craft-agent/server-core/transport'
import type { MessageEnvelope } from '@craft-agent/shared/protocol'

// ---------------------------------------------------------------------------
// Mock WS server helpers
// ---------------------------------------------------------------------------

interface MockServer {
  url: string
  port: number
  close: () => void
  lastMessage: () => MessageEnvelope | null
  sendToAll: (envelope: MessageEnvelope) => void
}

function createMockServer(opts?: {
  rejectAuth?: boolean
  noAck?: boolean
  tls?: { cert: string; key: string }
}): MockServer {
  let lastMsg: MessageEnvelope | null = null
  const clients = new Set<any>()

  const server = Bun.serve({
    port: 0,
    tls: opts?.tls,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      message(ws, message) {
        const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
        const envelope = deserializeEnvelope(raw)
        lastMsg = envelope

        if (envelope.type === 'handshake') {
          if (opts?.rejectAuth) {
            const error: MessageEnvelope = {
              id: envelope.id,
              type: 'error',
              error: { code: 'AUTH_FAILED', message: 'Invalid token' },
            }
            ws.send(serializeEnvelope(error))
            ws.close()
            return
          }

          if (opts?.noAck) return // Simulate timeout

          const ack: MessageEnvelope = {
            id: crypto.randomUUID(),
            type: 'handshake_ack',
            clientId: 'test-client-001',
            protocolVersion: '1.0',
          }
          ws.send(serializeEnvelope(ack))
          return
        }

        if (envelope.type === 'request') {
          // Default: echo args back as result
          const response: MessageEnvelope = {
            id: envelope.id,
            type: 'response',
            channel: envelope.channel,
            result: envelope.args,
          }
          ws.send(serializeEnvelope(response))
        }
      },
      open(ws) {
        clients.add(ws)
      },
      close(ws) {
        clients.delete(ws)
      },
    },
  })

  const protocol = opts?.tls ? 'wss' : 'ws'
  const port = server.port!
  return {
    url: `${protocol}://127.0.0.1:${port}`,
    port,
    close: () => server.stop(true),
    lastMessage: () => lastMsg,
    sendToAll: (envelope: MessageEnvelope) => {
      const data = serializeEnvelope(envelope)
      for (const ws of clients) ws.send(data)
    },
  }
}

function createErrorServer(): MockServer {
  let lastMsg: MessageEnvelope | null = null
  const clients = new Set<any>()

  const server = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return undefined
      return new Response('Not found', { status: 404 })
    },
    websocket: {
      message(ws, message) {
        const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
        const envelope = deserializeEnvelope(raw)
        lastMsg = envelope

        if (envelope.type === 'handshake') {
          const ack: MessageEnvelope = {
            id: crypto.randomUUID(),
            type: 'handshake_ack',
            clientId: 'test-client-err',
            protocolVersion: '1.0',
          }
          ws.send(serializeEnvelope(ack))
          return
        }

        if (envelope.type === 'request') {
          // Respond with error
          const response: MessageEnvelope = {
            id: envelope.id,
            type: 'response',
            channel: envelope.channel,
            error: { code: 'HANDLER_ERROR', message: 'test error' },
          }
          ws.send(serializeEnvelope(response))
        }
      },
      open(ws) {
        clients.add(ws)
      },
      close(ws) {
        clients.delete(ws)
      },
    },
  })

  const port = server.port!
  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    close: () => server.stop(true),
    lastMessage: () => lastMsg,
    sendToAll: (envelope: MessageEnvelope) => {
      const data = serializeEnvelope(envelope)
      for (const ws of clients) ws.send(data)
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let server: MockServer | null = null

afterEach(() => {
  server?.close()
  server = null
})

describe('CliRpcClient', () => {
  it('connects and completes handshake', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url, { token: 'test-token' })
    const clientId = await client.connect()
    expect(clientId).toBe('test-client-001')
    expect(client.isConnected).toBe(true)
    expect(client.clientId).toBe('test-client-001')
    client.destroy()
  })

  it('sends token in handshake', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url, { token: 'my-secret' })
    await client.connect()
    const hs = server.lastMessage()
    expect(hs?.type).toBe('handshake')
    expect(hs?.token).toBe('my-secret')
    client.destroy()
  })

  it('rejects on auth failure', async () => {
    server = createMockServer({ rejectAuth: true })
    const client = new CliRpcClient(server.url, { token: 'bad-token' })
    await expect(client.connect()).rejects.toThrow('Invalid token')
    client.destroy()
  })

  it('rejects on connect timeout', async () => {
    server = createMockServer({ noAck: true })
    const client = new CliRpcClient(server.url, { connectTimeout: 200 })
    await expect(client.connect()).rejects.toThrow('Connection timeout')
    client.destroy()
  })

  it('invoke sends request and receives response', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url)
    await client.connect()
    const result = await client.invoke('system:homeDir')
    // Mock server echoes args — no args means empty array
    expect(result).toEqual([])
    client.destroy()
  })

  it('invoke passes args correctly', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url)
    await client.connect()
    const result = await client.invoke('sessions:get', 'workspace-1')
    expect(result).toEqual(['workspace-1'])
    client.destroy()
  })

  it('invoke rejects on server error', async () => {
    server = createErrorServer()
    const client = new CliRpcClient(server.url)
    await client.connect()
    await expect(client.invoke('system:versions')).rejects.toThrow('test error')
    client.destroy()
  })

  it('invoke rejects on timeout', async () => {
    server = createMockServer({ noAck: false })
    // Create a server that acks handshake but never responds to requests
    server.close()

    const silentServer = Bun.serve({
      port: 0,
      fetch(req, svr) {
        if (svr.upgrade(req)) return undefined
        return new Response('Not found', { status: 404 })
      },
      websocket: {
        message(ws, message) {
          const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
          const envelope = deserializeEnvelope(raw)
          if (envelope.type === 'handshake') {
            const ack: MessageEnvelope = {
              id: crypto.randomUUID(),
              type: 'handshake_ack',
              clientId: 'silent-client',
              protocolVersion: '1.0',
            }
            ws.send(serializeEnvelope(ack))
          }
          // Never respond to requests
        },
      },
    })

    const client = new CliRpcClient(`ws://127.0.0.1:${silentServer.port}`, { requestTimeout: 200 })
    await client.connect()
    await expect(client.invoke('system:homeDir')).rejects.toThrow('Request timeout')
    client.destroy()
    silentServer.stop(true)
  })

  it('invoke throws when not connected', async () => {
    const client = new CliRpcClient('ws://127.0.0.1:1')
    await expect(client.invoke('system:homeDir')).rejects.toThrow('Not connected')
    client.destroy()
  })

  it('receives push events via on()', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url)
    await client.connect()

    const events: unknown[][] = []
    const unsub = client.on('session:event', (...args) => {
      events.push(args)
    })

    // Push an event from server
    server.sendToAll({
      id: crypto.randomUUID(),
      type: 'event',
      channel: 'session:event',
      args: [{ type: 'text_delta', sessionId: 's1', delta: 'hello' }],
    })

    // Give it a tick
    await new Promise((r) => setTimeout(r, 50))

    expect(events.length).toBe(1)
    expect((events[0][0] as any).delta).toBe('hello')

    // Unsubscribe stops delivery
    unsub()
    server.sendToAll({
      id: crypto.randomUUID(),
      type: 'event',
      channel: 'session:event',
      args: [{ type: 'text_delta', sessionId: 's1', delta: 'world' }],
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(events.length).toBe(1) // Still 1
    client.destroy()
  })

  it('destroy closes connection and rejects pending', async () => {
    server = createMockServer({ noAck: false })
    // Use a server that acks but never responds
    server.close()

    const silentServer = Bun.serve({
      port: 0,
      fetch(req, svr) {
        if (svr.upgrade(req)) return undefined
        return new Response('Not found', { status: 404 })
      },
      websocket: {
        message(ws, message) {
          const raw = typeof message === 'string' ? message : new TextDecoder().decode(message)
          const envelope = deserializeEnvelope(raw)
          if (envelope.type === 'handshake') {
            ws.send(serializeEnvelope({
              id: crypto.randomUUID(),
              type: 'handshake_ack',
              clientId: 'destroy-test',
              protocolVersion: '1.0',
            }))
          }
        },
      },
    })

    const client = new CliRpcClient(`ws://127.0.0.1:${silentServer.port}`, { requestTimeout: 5000 })
    await client.connect()

    const pending = client.invoke('system:homeDir')
    client.destroy()

    await expect(pending).rejects.toThrow('Client destroyed')
    expect(client.isConnected).toBe(false)
    silentServer.stop(true)
  })

  it('throws on invoke after destroy', async () => {
    server = createMockServer()
    const client = new CliRpcClient(server.url)
    await client.connect()
    client.destroy()
    await expect(client.invoke('system:homeDir')).rejects.toThrow('Not connected')
  })

  it('connects over wss:// with TLS', async () => {
    const tls = generateSelfSignedCert()
    if (!tls) {
      // openssl not available — skip TLS test
      console.log('  (skipped: openssl not available)')
      return
    }
    server = createMockServer({ tls })

    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    try {
      const client = new CliRpcClient(server.url)
      const clientId = await client.connect()
      expect(clientId).toBe('test-client-001')
      expect(server.url.startsWith('wss://')).toBe(true)
      client.destroy()
    } finally {
      if (prev === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev
      }
    }
  })
})

// ---------------------------------------------------------------------------
// TLS cert helper — generates a real self-signed cert via openssl
// ---------------------------------------------------------------------------

function generateSelfSignedCert(): { cert: string; key: string } | null {
  try {
    const keyResult = Bun.spawnSync({
      cmd: ['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
        '-keyout', '/dev/stdout', '-out', '/dev/stdout',
        '-days', '1', '-nodes', '-subj', '/CN=localhost', '-batch'],
      stderr: 'pipe',
    })
    if (keyResult.exitCode !== 0) return null

    const pem = keyResult.stdout.toString()
    const certMatch = pem.match(/(-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----)/)
    const keyMatch = pem.match(/(-----BEGIN (?:EC )?PRIVATE KEY-----[\s\S]+?-----END (?:EC )?PRIVATE KEY-----)/)
    if (!certMatch || !keyMatch) return null

    return { cert: certMatch[1], key: keyMatch[1] }
  } catch {
    return null
  }
}
