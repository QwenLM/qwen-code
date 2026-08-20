/**
 * Transport layer tests — WsRpcServer + WsRpcClient.
 *
 * Tests handshake, RPC request/response, push events, error handling,
 * auth, and protocol version checking.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { EVENT_BUFFER_MAX_SIZE, type MessageEnvelope } from '@craft-agent/shared/protocol'
import { WsRpcServer } from '../transport/server'
import { WsRpcClient } from '../transport/client'
import { serializeEnvelope } from '../transport/codec'

// Helpers to manage cleanup
let servers: WsRpcServer[] = []
let clients: WsRpcClient[] = []

function trackServer(s: WsRpcServer) { servers.push(s); return s }
function trackClient(c: WsRpcClient) { clients.push(c); return c }

afterEach(() => {
  for (const c of clients) c.destroy()
  for (const s of servers) s.close()
  clients = []
  servers = []
})

/** Wait for client to be connected. */
async function waitConnected(client: WsRpcClient, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!client.isConnected) {
    if (Date.now() - start > timeoutMs) throw new Error('Connection timeout')
    await new Promise(r => setTimeout(r, 10))
  }
}

/** Wait for specific transport status. */
async function waitForStatus(
  client: WsRpcClient,
  predicate: (status: ReturnType<WsRpcClient['getConnectionState']>['status']) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now()
  while (!predicate(client.getConnectionState().status)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Status wait timeout. Last status: ${client.getConnectionState().status}`)
    }
    await new Promise(r => setTimeout(r, 10))
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Condition wait timeout')
    }
    await new Promise(r => setTimeout(r, 10))
  }
}

/** Create a server + connected client pair. */
async function createPair(
  serverOpts?: Partial<import('../transport/server').WsRpcServerOptions>,
  clientOpts?: Partial<import('../transport/client').WsRpcClientOptions>,
) {
  let connectedClientId: string | null = null
  const server = trackServer(new WsRpcServer({
    host: '127.0.0.1',
    port: 0,
    onClientConnected: (info) => { connectedClientId = info.clientId },
    ...serverOpts,
  }))
  await server.listen()

  const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
    workspaceId: 'test-workspace',
    autoReconnect: false,
    ...clientOpts,
  }))
  client.connect()
  await waitConnected(client)

  // Wait for onClientConnected callback
  const start = Date.now()
  while (!connectedClientId) {
    if (Date.now() - start > 2000) throw new Error('No clientId received')
    await new Promise(r => setTimeout(r, 10))
  }

  return { server, client, clientId: connectedClientId! }
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

describe('handshake', () => {
  test('client connects and receives clientId', async () => {
    const { client } = await createPair()
    expect(client.isConnected).toBe(true)
  })

  test('server assigns random port when port=0', async () => {
    const server = trackServer(new WsRpcServer({ host: '127.0.0.1', port: 0 }))
    await server.listen()
    expect(server.port).toBeGreaterThan(0)
  })

  test('handshake without protocolVersion is rejected', async () => {
    const server = trackServer(new WsRpcServer({ host: '127.0.0.1', port: 0 }))
    await server.listen()

    const result = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)

      ws.on('open', () => {
        ws.send(JSON.stringify({ id: 'missing-version', type: 'handshake' }))
      })

      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString() })
      })

      ws.on('error', (error) => {
        reject(error)
      })
    })

    expect(result.code).toBe(4004)
  })
})

// ---------------------------------------------------------------------------
// RPC: request → response
// ---------------------------------------------------------------------------

describe('RPC', () => {
  test('simple invoke returns result', async () => {
    const { server, client } = await createPair()

    server.handle('greet', async (_ctx, name: string) => {
      return `Hello, ${name}!`
    })

    const result = await client.invoke('greet', 'World')
    expect(result).toBe('Hello, World!')
  })

  test('handler receives correct args', async () => {
    const { server, client } = await createPair()

    server.handle('add', async (_ctx, a: number, b: number) => a + b)

    const result = await client.invoke('add', 3, 4)
    expect(result).toBe(7)
  })

  test('handler has access to clientId and workspaceId', async () => {
    const { server, client } = await createPair()

    server.handle('whoami', async (ctx) => ({
      clientId: ctx.clientId,
      workspaceId: ctx.workspaceId,
    }))

    const result = await client.invoke('whoami')
    expect(result.clientId).toBeTruthy()
    expect(result.workspaceId).toBe('test-workspace')
  })

  test('unknown channel returns CHANNEL_NOT_FOUND error', async () => {
    const { client } = await createPair()

    try {
      await client.invoke('nonexistent:channel')
      throw new Error('Should have thrown')
    } catch (err: any) {
      expect(err.code).toBe('CHANNEL_NOT_FOUND')
    }
  })

  test('handler error returns HANDLER_ERROR', async () => {
    const { server, client } = await createPair()

    server.handle('fail', async () => {
      throw new Error('Something broke')
    })

    try {
      await client.invoke('fail')
      throw new Error('Should have thrown')
    } catch (err: any) {
      expect(err.code).toBe('HANDLER_ERROR')
      expect(err.message).toBe('Something broke')
    }
  })

  test('handler with custom error code', async () => {
    const { server, client } = await createPair()

    server.handle('export', async () => {
      const err = new Error('Session is active') as any
      err.code = 'SESSION_NOT_IDLE'
      throw err
    })

    try {
      await client.invoke('export')
      throw new Error('Should have thrown')
    } catch (err: any) {
      expect(err.code).toBe('SESSION_NOT_IDLE')
    }
  })

  test('multiple concurrent requests resolve independently', async () => {
    const { server, client } = await createPair()

    server.handle('delay', async (_ctx, ms: number, value: string) => {
      await new Promise(r => setTimeout(r, ms))
      return value
    })

    const [r1, r2, r3] = await Promise.all([
      client.invoke('delay', 50, 'first'),
      client.invoke('delay', 10, 'second'),
      client.invoke('delay', 30, 'third'),
    ])

    expect(r1).toBe('first')
    expect(r2).toBe('second')
    expect(r3).toBe('third')
  })

  test('Uint8Array response payload roundtrips intact', async () => {
    const { server, client } = await createPair()

    server.handle('binary:response', async () => {
      return new Uint8Array([37, 80, 68, 70, 45]) // "%PDF-"
    })

    const result = await client.invoke('binary:response')
    expect(result).toBeInstanceOf(Uint8Array)
    expect(Array.from(result as Uint8Array)).toEqual([37, 80, 68, 70, 45])
  })

  test('Uint8Array request args decode correctly in handler', async () => {
    const { server, client } = await createPair()

    let seen: Uint8Array | null = null

    server.handle('binary:arg', async (_ctx, bytes: Uint8Array) => {
      seen = bytes
      return Array.from(bytes).reduce((sum, value) => sum + value, 0)
    })

    const result = await client.invoke('binary:arg', new Uint8Array([1, 2, 3, 4]))
    expect(result).toBe(10)
    expect(seen).toBeInstanceOf(Uint8Array)
    expect(Array.from(seen!)).toEqual([1, 2, 3, 4])
  })
})

// ---------------------------------------------------------------------------
// Push events
// ---------------------------------------------------------------------------

describe('push events', () => {
  test('client receives server-pushed events', async () => {
    const { server, client } = await createPair()

    const received: string[] = []
    client.on('test:event', (data: string) => {
      received.push(data)
    })

    // Small delay to ensure listener is registered
    await new Promise(r => setTimeout(r, 50))

    server.push('test:event', { to: 'all' }, 'hello')
    server.push('test:event', { to: 'all' }, 'world')

    await new Promise(r => setTimeout(r, 100))
    expect(received).toEqual(['hello', 'world'])
  })

  test('workspace-targeted push only reaches matching clients', async () => {
    const server = trackServer(new WsRpcServer({ host: '127.0.0.1', port: 0 }))
    await server.listen()

    const client1 = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      workspaceId: 'ws-a',
      autoReconnect: false,
    }))
    const client2 = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      workspaceId: 'ws-b',
      autoReconnect: false,
    }))

    client1.connect()
    client2.connect()
    await waitConnected(client1)
    await waitConnected(client2)

    const received1: string[] = []
    const received2: string[] = []
    client1.on('update', (v: string) => received1.push(v))
    client2.on('update', (v: string) => received2.push(v))

    await new Promise(r => setTimeout(r, 50))

    server.push('update', { to: 'workspace', workspaceId: 'ws-a' }, 'for-a')
    server.push('update', { to: 'workspace', workspaceId: 'ws-b' }, 'for-b')

    await new Promise(r => setTimeout(r, 100))
    expect(received1).toEqual(['for-a'])
    expect(received2).toEqual(['for-b'])
  })

  test('unsubscribe stops receiving events', async () => {
    const { server, client } = await createPair()

    const received: string[] = []
    const unsub = client.on('test:event', (data: string) => {
      received.push(data)
    })

    await new Promise(r => setTimeout(r, 50))

    server.push('test:event', { to: 'all' }, 'before')
    await new Promise(r => setTimeout(r, 50))

    unsub()
    server.push('test:event', { to: 'all' }, 'after')
    await new Promise(r => setTimeout(r, 50))

    expect(received).toEqual(['before'])
  })

  test('Uint8Array event args roundtrip intact', async () => {
    const { server, client } = await createPair()

    let received: Uint8Array | null = null

    client.on('binary:event', (data: Uint8Array) => {
      received = data
    })

    await new Promise(r => setTimeout(r, 50))

    server.push('binary:event', { to: 'all' }, new Uint8Array([9, 8, 7]))

    await new Promise(r => setTimeout(r, 50))
    expect(received).toBeInstanceOf(Uint8Array)
    expect(Array.from(received!)).toEqual([9, 8, 7])
  })
})

// ---------------------------------------------------------------------------
// Reliable delivery
// ---------------------------------------------------------------------------

describe('reliable delivery', () => {
  test('manual reconnect preserves reconnect identity and replays missed events', async () => {
    let sawDisconnect = false
    const server = trackServer(new WsRpcServer({
      host: '127.0.0.1',
      port: 0,
      onClientDisconnected: () => {
        if (sawDisconnect) return
        sawDisconnect = true
        server.push('stream', { to: 'workspace', workspaceId: 'test-workspace' }, 'missed-during-manual-reconnect')
      },
    }))
    await server.listen()

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      workspaceId: 'test-workspace',
      autoReconnect: false,
    }))

    const received: string[] = []
    const reconnectStates: boolean[] = []
    client.on('stream', (value: string) => received.push(value))
    client.on('__transport:reconnected', (isStale: boolean) => reconnectStates.push(isStale))

    client.connect()
    await waitConnected(client)

    server.push('stream', { to: 'workspace', workspaceId: 'test-workspace' }, 'before-reconnect')
    await waitUntil(() => received.includes('before-reconnect'))

    client.reconnectNow()

    await waitConnected(client)
    await waitUntil(() => reconnectStates.length === 1)
    await waitUntil(() => received.includes('missed-during-manual-reconnect'))

    expect(reconnectStates).toEqual([false])
    expect(received).toEqual(['before-reconnect', 'missed-during-manual-reconnect'])
  })

  test('reconnect replay ignores events targeted at other clients', async () => {
    const server = trackServer(new WsRpcServer({ host: '127.0.0.1', port: 0 }))
    await server.listen()

    const clientA = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      workspaceId: 'ws-a',
      autoReconnect: false,
    }))
    const clientB = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      workspaceId: 'ws-b',
      autoReconnect: false,
    }))

    const receivedA: string[] = []
    const receivedB: string[] = []
    const reconnectStates: boolean[] = []

    clientA.on('stream', (value: string) => receivedA.push(value))
    clientB.on('stream', (value: string) => receivedB.push(value))
    clientA.on('__transport:reconnected', (isStale: boolean) => reconnectStates.push(isStale))

    clientA.connect()
    clientB.connect()
    await waitConnected(clientA)
    await waitConnected(clientB)

    server.push('stream', { to: 'workspace', workspaceId: 'ws-a' }, 'before-a')
    await waitUntil(() => receivedA.includes('before-a'))

    ;((clientA as any).ws as WebSocket).close()
    await waitForStatus(clientA, (status) => status === 'disconnected')

    server.push('stream', { to: 'workspace', workspaceId: 'ws-b' }, 'only-b')
    server.push('stream', { to: 'workspace', workspaceId: 'ws-a' }, 'missed-a')

    await waitUntil(() => receivedB.includes('only-b'))

    clientA.reconnectNow()

    await waitConnected(clientA)
    await waitUntil(() => reconnectStates.length === 1)
    await waitUntil(() => receivedA.includes('missed-a'))

    expect(reconnectStates).toEqual([false])
    expect(receivedA).toEqual(['before-a', 'missed-a'])
    expect(receivedB).toEqual(['only-b'])
    expect((clientA as any).lastSeenSeq).toBe(2)
    expect((clientB as any).lastSeenSeq).toBe(1)
  })

  test('marks reconnect stale when the retained buffer evicts missed events', async () => {
    const server = trackServer(new WsRpcServer({ host: '127.0.0.1', port: 0 }))
    await server.listen()

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      workspaceId: 'test-workspace',
      autoReconnect: false,
    }))

    const received: string[] = []
    const reconnectStates: boolean[] = []
    client.on('stream', (value: string) => received.push(value))
    client.on('__transport:reconnected', (isStale: boolean) => reconnectStates.push(isStale))

    client.connect()
    await waitConnected(client)

    server.push('stream', { to: 'workspace', workspaceId: 'test-workspace' }, 'before-stale')
    await waitUntil(() => received.includes('before-stale'))

    ;((client as any).ws as WebSocket).close()
    await waitForStatus(client, (status) => status === 'disconnected')

    for (let i = 0; i < EVENT_BUFFER_MAX_SIZE + 25; i++) {
      server.push('stream', { to: 'workspace', workspaceId: 'test-workspace' }, `missed-${i}`)
    }

    client.reconnectNow()

    await waitConnected(client)
    await waitUntil(() => reconnectStates.length === 1)

    expect(reconnectStates).toEqual([true])
    expect(received).toEqual(['before-stale'])
  })

  test('sequence_ack evicts acknowledged buffered events', async () => {
    const { server, client, clientId } = await createPair()

    server.push('stream', { to: 'workspace', workspaceId: 'test-workspace' }, 'one')
    server.push('stream', { to: 'workspace', workspaceId: 'test-workspace' }, 'two')

    await waitUntil(() => (client as any).lastSeenSeq === 2)

    const ack: MessageEnvelope = {
      id: randomUUID(),
      type: 'sequence_ack',
      lastSeq: 2,
    }
    ;((client as any).ws as WebSocket).send(serializeEnvelope(ack))

    await waitUntil(() => ((server as any).clients.get(clientId)?.eventBuffer.length ?? -1) === 0)

    expect((server as any).clients.get(clientId)?.lastAckedSeq).toBe(2)
  })

  test('safe send skips non-open sockets', () => {
    const client = trackClient(new WsRpcClient('ws://127.0.0.1:1', {
      autoReconnect: false,
    }))

    let sendCalls = 0
    const fakeWs = {
      OPEN: 1,
      readyState: 2,
      send: () => { sendCalls += 1 },
    }

    const sent = (client as any).trySendEnvelope(fakeWs, {
      id: randomUUID(),
      type: 'sequence_ack',
      lastSeq: 1,
    } satisfies MessageEnvelope)

    expect(sent).toBe(false)
    expect(sendCalls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('auth', () => {
  test('server with requireAuth rejects clients without token', async () => {
    const server = trackServer(new WsRpcServer({
      host: '127.0.0.1',
      port: 0,
      requireAuth: true,
      validateToken: async (t) => t === 'valid-token',
    }))
    await server.listen()

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      autoReconnect: false,
    }))
    client.connect()

    // Should NOT become connected
    await new Promise(r => setTimeout(r, 500))
    expect(client.isConnected).toBe(false)
  })

  test('server with requireAuth accepts valid token', async () => {
    const server = trackServer(new WsRpcServer({
      host: '127.0.0.1',
      port: 0,
      requireAuth: true,
      validateToken: async (t) => t === 'valid-token',
    }))
    await server.listen()

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      token: 'valid-token',
      autoReconnect: false,
    }))
    client.connect()
    await waitConnected(client)

    expect(client.isConnected).toBe(true)
  })

  test('server with requireAuth rejects invalid token', async () => {
    const server = trackServer(new WsRpcServer({
      host: '127.0.0.1',
      port: 0,
      requireAuth: true,
      validateToken: async (t) => t === 'valid-token',
    }))
    await server.listen()

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      token: 'wrong-token',
      autoReconnect: false,
    }))
    client.connect()

    await new Promise(r => setTimeout(r, 500))
    expect(client.isConnected).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

describe('connection state', () => {
  test('becomes connected after successful handshake', async () => {
    const { client } = await createPair()

    const state = client.getConnectionState()
    expect(state.status).toBe('connected')
    expect(state.mode).toBe('local')
    expect(state.url.startsWith('ws://127.0.0.1:')).toBe(true)
  })

  test('classifies invalid token as auth failure', async () => {
    const server = trackServer(new WsRpcServer({
      host: '127.0.0.1',
      port: 0,
      requireAuth: true,
      validateToken: async (t) => t === 'valid-token',
    }))
    await server.listen()

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      token: 'wrong-token',
      autoReconnect: false,
    }))

    client.connect()
    await waitForStatus(client, (s) => s === 'failed')

    const state = client.getConnectionState()
    expect(state.lastError?.kind).toBe('auth')
  })

  test('enters reconnecting after disconnect when autoReconnect is enabled', async () => {
    const { server, client } = await createPair({}, { autoReconnect: true, maxReconnectDelay: 200 })

    server.close()
    await waitForStatus(client, (s) => s === 'reconnecting' || s === 'failed')

    const state = client.getConnectionState()
    expect(['reconnecting', 'failed']).toContain(state.status)
    expect(state.attempt).toBeGreaterThanOrEqual(1)
  })

  test('captures websocket close code and reason for handshake failures', async () => {
    const server = trackServer(new WsRpcServer({
      host: '127.0.0.1',
      port: 0,
      requireAuth: true,
      validateToken: async (t) => t === 'valid-token',
    }))
    await server.listen()

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      autoReconnect: false,
    }))

    client.connect()
    await waitForStatus(client, (s) => s === 'failed')

    const state = client.getConnectionState()
    expect(state.lastClose?.code).toBe(4005)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('invoke queues until handshake completes', async () => {
    const server = trackServer(new WsRpcServer({ host: '127.0.0.1', port: 0 }))
    await server.listen()

    server.handle('ping', async () => 'pong')

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      autoReconnect: false,
    }))

    client.connect()
    const result = await client.invoke('ping')
    expect(result).toBe('pong')
  })

  test('invoke without explicit connect auto-starts connection', async () => {
    const server = trackServer(new WsRpcServer({ host: '127.0.0.1', port: 0 }))
    await server.listen()

    server.handle('ping', async () => 'pong')

    const client = trackClient(new WsRpcClient(`ws://127.0.0.1:${server.port}`, {
      autoReconnect: false,
    }))

    const result = await client.invoke('ping')
    expect(result).toBe('pong')
  })

  test('invoke on disconnected client throws', async () => {
    const client = trackClient(new WsRpcClient('ws://127.0.0.1:1', {
      autoReconnect: false,
      connectTimeout: 250,
    }))

    try {
      await client.invoke('anything')
      throw new Error('Should have thrown')
    } catch (err: any) {
      expect(
        err.message.includes('Connection') || err.message.includes('WebSocket error during connection setup'),
      ).toBe(true)
    }
  })

  test('handler returning void resolves to undefined', async () => {
    const { server, client } = await createPair()

    server.handle('noop', async () => {
      // returns void
    })

    const result = await client.invoke('noop')
    expect(result).toBeUndefined()
  })

  test('handler returning null resolves to null', async () => {
    const { server, client } = await createPair()

    server.handle('nullable', async () => null)

    const result = await client.invoke('nullable')
    expect(result).toBeNull()
  })

  test('duplicate handler registration throws', async () => {
    const { server } = await createPair()

    server.handle('once', async () => 'ok')
    expect(() => server.handle('once', async () => 'dup')).toThrow('already registered')
  })
})

// ---------------------------------------------------------------------------
// Server → Client invoke (bidirectional RPC)
// ---------------------------------------------------------------------------

describe('invokeClient', () => {
  test('server invokes client capability and receives result', async () => {
    const { server, client, clientId } = await createPair(
      {},
      { clientCapabilities: ['client:openExternal'] },
    )

    client.handleCapability('client:openExternal', (url: string) => {
      return `opened: ${url}`
    })

    const result = await server.invokeClient(clientId, 'client:openExternal', 'https://example.com')
    expect(result).toBe('opened: https://example.com')
  })

  test('invokeClient on missing capability returns CAPABILITY_UNAVAILABLE immediately', async () => {
    const { server, clientId } = await createPair(
      {},
      { clientCapabilities: [] },
    )

    try {
      await server.invokeClient(clientId, 'client:openExternal', 'https://example.com')
      throw new Error('Should have thrown')
    } catch (err: any) {
      expect(err.code).toBe('CAPABILITY_UNAVAILABLE')
    }
  })

  test('invokeClient on disconnected client returns CLIENT_DISCONNECTED immediately', async () => {
    const { server } = await createPair()

    try {
      await server.invokeClient('nonexistent-client-id', 'client:openExternal', 'url')
      throw new Error('Should have thrown')
    } catch (err: any) {
      expect(err.code).toBe('CLIENT_DISCONNECTED')
    }
  })

  test('client handler error propagates to server', async () => {
    const { server, client, clientId } = await createPair(
      {},
      { clientCapabilities: ['client:failing'] },
    )

    client.handleCapability('client:failing', () => {
      throw new Error('Handler blew up')
    })

    try {
      await server.invokeClient(clientId, 'client:failing')
      throw new Error('Should have thrown')
    } catch (err: any) {
      expect(err.code).toBe('HANDLER_ERROR')
      expect(err.message).toBe('Handler blew up')
    }
  })

  test('disconnect mid-flight rejects pending invoke with CLIENT_DISCONNECTED', async () => {
    const { server, client, clientId } = await createPair(
      {},
      { clientCapabilities: ['client:slow'] },
    )

    // Register a handler that never resolves — we'll disconnect before it returns
    client.handleCapability('client:slow', () => {
      return new Promise(() => {}) // Never resolves
    })

    const invokePromise = server.invokeClient(clientId, 'client:slow')

    // Disconnect client after a brief delay
    await new Promise(r => setTimeout(r, 50))
    client.destroy()

    try {
      await invokePromise
      throw new Error('Should have thrown')
    } catch (err: any) {
      expect(err.code).toBe('CLIENT_DISCONNECTED')
    }
  })

  test('handshake with capabilities stores them on server', async () => {
    const { server, client, clientId } = await createPair(
      {},
      { clientCapabilities: ['client:openExternal', 'client:notify'] },
    )

    client.handleCapability('client:openExternal', () => 'ok1')
    client.handleCapability('client:notify', () => 'ok2')

    // Both capabilities should work
    const r1 = await server.invokeClient(clientId, 'client:openExternal')
    const r2 = await server.invokeClient(clientId, 'client:notify')
    expect(r1).toBe('ok1')
    expect(r2).toBe('ok2')

    // Unregistered capability should fail
    try {
      await server.invokeClient(clientId, 'client:unknown')
      throw new Error('Should have thrown')
    } catch (err: any) {
      expect(err.code).toBe('CAPABILITY_UNAVAILABLE')
    }
  })

  test('async client handler works', async () => {
    const { server, client, clientId } = await createPair(
      {},
      { clientCapabilities: ['client:async'] },
    )

    client.handleCapability('client:async', async (ms: number) => {
      await new Promise(r => setTimeout(r, ms))
      return 'done'
    })

    const result = await server.invokeClient(clientId, 'client:async', 20)
    expect(result).toBe('done')
  })
})
