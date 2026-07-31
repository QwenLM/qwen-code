/**
 * WsRpcClient — WebSocket-based RPC client.
 *
 * Used in both renderer (browser WebSocket) and Node.js contexts.
 * Handles handshake, request/response correlation, event subscriptions,
 * and automatic reconnection with exponential backoff.
 *
 * Extracted to server-core so any package (subprocesses, services, bridges)
 * can act as an RPC client without depending on the Electron app layer.
 */

import {
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  SEQUENCE_ACK_INTERVAL_MS,
  type MessageEnvelope,
} from '@craft-agent/shared/protocol'
import type { RpcClient } from './types'
import { serializeEnvelope, deserializeEnvelope } from './codec'

// ---------------------------------------------------------------------------
// Pending request state
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// Connection state model
// ---------------------------------------------------------------------------

export type TransportMode = 'local' | 'remote'

export type TransportConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'failed'

export type TransportConnectionErrorKind =
  | 'auth'
  | 'protocol'
  | 'timeout'
  | 'network'
  | 'server'
  | 'unknown'

export interface TransportConnectionError {
  kind: TransportConnectionErrorKind
  message: string
  code?: string
}

export interface TransportCloseInfo {
  code?: number
  reason?: string
  wasClean?: boolean
}

export interface TransportConnectionState {
  mode: TransportMode
  status: TransportConnectionStatus
  url: string
  attempt: number
  nextRetryInMs?: number
  lastError?: TransportConnectionError
  lastClose?: TransportCloseInfo
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

export interface WsRpcClientOptions {
  /** Workspace ID sent on handshake. */
  workspaceId?: string
  /** Electron webContents.id, sent on handshake for local clients. */
  webContentsId?: number
  /** Bearer token for remote auth. */
  token?: string
  /** Request timeout in ms. Default: 30_000 */
  requestTimeout?: number
  /** Max reconnection backoff in ms. Default: 30_000 */
  maxReconnectDelay?: number
  /** Whether to auto-reconnect on disconnect. Default: true */
  autoReconnect?: boolean
  /** Handshake/connect timeout in ms. Default: 10_000 */
  connectTimeout?: number
  /** Capabilities to advertise on handshake. Handlers must be registered via handleCapability(). */
  clientCapabilities?: string[]
  /** Runtime mode — local embedded or remote thin-client connection. */
  mode?: TransportMode
  /** Accept self-signed TLS certificates for wss:// connections. Default: false. Only works in Node.js (main process). */
  tlsRejectUnauthorized?: boolean
}

// ---------------------------------------------------------------------------
// WsRpcClient
// ---------------------------------------------------------------------------

export class WsRpcClient implements RpcClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, PendingRequest>()
  private listeners = new Map<string, Set<(...args: any[]) => void>>()
  private capabilityHandlers = new Map<string, (...args: any[]) => Promise<any> | any>()
  private connectionStateListeners = new Set<(state: TransportConnectionState) => void>()
  private anyEventListeners = new Set<(channel: string, ...args: any[]) => void>()
  private clientId: string | null = null
  private _serverVersion: string | null = null
  private connected = false
  private reconnectAttempt = 0
  private lastSeenSeq = 0
  private ackTimer: ReturnType<typeof setInterval> | null = null
  private pendingReconnect: { clientId: string; lastSeq: number } | null = null
  private currentHandshakeWasReconnect = false
  private manualReconnectRequested = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private backoffResetTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  /** Set when server sends shuttingDown — prevents reconnection attempts. */
  private permanentlyClosed = false
  private connectStarted = false
  private connectError: Error | null = null
  private readyPromise: Promise<void> | null = null
  private resolveReady: (() => void) | null = null
  private rejectReady: ((error: Error) => void) | null = null
  private connectionState: TransportConnectionState
  private serverChannels: Set<string> | null = null

  private readonly url: string
  private readonly workspaceId: string | undefined
  private readonly webContentsId: number | undefined
  private readonly token: string | undefined
  private readonly clientCapabilities: string[]
  private readonly requestTimeout: number
  private readonly maxReconnectDelay: number
  private readonly autoReconnect: boolean
  private readonly connectTimeout: number
  private readonly mode: TransportMode
  private readonly tlsRejectUnauthorized: boolean

  constructor(url: string, opts?: WsRpcClientOptions) {
    this.url = url
    this.workspaceId = opts?.workspaceId
    this.webContentsId = opts?.webContentsId
    this.token = opts?.token
    this.clientCapabilities = opts?.clientCapabilities ?? []
    this.requestTimeout = opts?.requestTimeout ?? REQUEST_TIMEOUT_MS
    this.maxReconnectDelay = opts?.maxReconnectDelay ?? 30_000
    this.autoReconnect = opts?.autoReconnect ?? true
    this.connectTimeout = opts?.connectTimeout ?? 10_000
    this.mode = opts?.mode ?? this.inferMode(url)
    this.tlsRejectUnauthorized = opts?.tlsRejectUnauthorized ?? true

    this.connectionState = {
      mode: this.mode,
      status: 'idle',
      url: this.url,
      attempt: 0,
      updatedAt: Date.now(),
    }
  }

  // -------------------------------------------------------------------------
  // RpcClient interface
  // -------------------------------------------------------------------------

  async invoke(channel: string, ...args: any[]): Promise<any> {
    await this.ensureConnected(channel)

    return await new Promise((resolve, reject) => {
      if (!this.connected || !this.ws) {
        reject(new Error(`Not connected (channel: ${channel})`))
        return
      }

      const id = crypto.randomUUID()
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timeout: ${channel} (${this.requestTimeout}ms)`))
      }, this.requestTimeout)

      this.pending.set(id, { resolve, reject, timeout })

      const envelope: MessageEnvelope = {
        id,
        type: 'request',
        channel,
        args,
      }

      if (!this.trySendEnvelope(this.ws, envelope)) {
        this.pending.delete(id)
        clearTimeout(timeout)
        reject(new Error(`Not connected (channel: ${channel})`))
      }
    })
  }

  on(channel: string, callback: (...args: any[]) => void): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(callback)

    return () => {
      set!.delete(callback)
      if (set!.size === 0) {
        this.listeners.delete(channel)
      }
    }
  }

  handleCapability(channel: string, handler: (...args: any[]) => Promise<any> | any): void {
    this.capabilityHandlers.set(channel, handler)
  }

  /**
   * Check whether the server registered a handler for a given channel.
   * Returns true if the server advertised the channel in handshake_ack,
   * or if the server didn't advertise channels at all (backwards compat).
   */
  isChannelAvailable(channel: string): boolean {
    if (!this.serverChannels) return true // server didn't advertise — assume available
    return this.serverChannels.has(channel)
  }

  /** Server version from handshake_ack (null if server didn't send one / not yet connected). */
  getServerVersion(): string | null {
    return this._serverVersion
  }

  getConnectionState(): TransportConnectionState {
    return {
      ...this.connectionState,
      lastError: this.connectionState.lastError ? { ...this.connectionState.lastError } : undefined,
      lastClose: this.connectionState.lastClose ? { ...this.connectionState.lastClose } : undefined,
    }
  }

  onConnectionStateChanged(callback: (state: TransportConnectionState) => void): () => void {
    this.connectionStateListeners.add(callback)
    callback(this.getConnectionState())
    return () => {
      this.connectionStateListeners.delete(callback)
    }
  }

  /** Subscribe to all push events regardless of channel. Used by RemoteClientBridge for event forwarding. */
  onAnyEvent(callback: (channel: string, ...args: any[]) => void): () => void {
    this.anyEventListeners.add(callback)
    return () => {
      this.anyEventListeners.delete(callback)
    }
  }

  /** Emit a synthetic __transport:reconnected event. Used by RoutedClient after workspace swap to trigger stale recovery. */
  emitReconnected(isStale: boolean): void {
    const set = this.listeners.get('__transport:reconnected')
    if (set) {
      for (const cb of set) {
        try { cb(isStale) } catch { /* listener errors must not break transport */ }
      }
    }
  }

  reconnectNow(): void {
    if (this.destroyed) return

    if (this.clientId) {
      this.pendingReconnect = {
        clientId: this.clientId,
        lastSeq: this.lastSeenSeq,
      }
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    this.connectStarted = false
    this.connectError = null

    if (!this.ws) {
      this.setConnectionState({
        status: 'reconnecting',
        attempt: this.reconnectAttempt,
        nextRetryInMs: undefined,
      })
      this.connect()
      return
    }

    this.manualReconnectRequested = true

    try {
      this.ws.close()
    } catch {
      this.manualReconnectRequested = false
      this.setConnectionState({
        status: 'reconnecting',
        attempt: this.reconnectAttempt,
        nextRetryInMs: undefined,
      })
      this.connect()
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create a WebSocket instance. In Node.js (main process), uses the `ws` library
   * to support TLS options (e.g. rejectUnauthorized for self-signed certs).
   * In the renderer (browser), falls back to the global WebSocket.
   */
  private createWebSocket(url: string): WebSocket {
    const needsTlsOptions = url.startsWith('wss://') && !this.tlsRejectUnauthorized

    if (needsTlsOptions && typeof process !== 'undefined' && process.versions?.node) {
      // Node.js / Electron main process — use `ws` library for TLS options
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { WebSocket: WsWebSocket } = require('ws') as typeof import('ws')
        return new WsWebSocket(url, { rejectUnauthorized: false }) as unknown as WebSocket
      } catch {
        // Fallback if ws not available
        return new WebSocket(url)
      }
    }

    return new WebSocket(url)
  }

  connect(): void {
    if (this.destroyed) return

    this.connectStarted = true
    this.connectError = null
    this.createReadyPromise()

    const isReconnectAttempt = this.reconnectAttempt > 0 || this.pendingReconnect !== null
    const status: TransportConnectionStatus = isReconnectAttempt ? 'reconnecting' : 'connecting'
    this.setConnectionState({
      status,
      attempt: this.reconnectAttempt,
      nextRetryInMs: undefined,
      lastError: undefined,
    })

    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }

    // Close and detach any existing socket before creating a new one.
    // Prevents orphaned connections and stale event handler interference.
    if (this.ws) {
      const oldWs = this.ws
      this.ws = null
      oldWs.onopen = null
      oldWs.onmessage = null
      oldWs.onclose = null
      oldWs.onerror = null
      try { oldWs.close() } catch { /* best effort */ }
    }

    this.connectTimer = setTimeout(() => {
      if (!this.connected) {
        const err = this.createConnectionError('timeout', `Connection timeout after ${this.connectTimeout}ms`, 'HANDSHAKE_TIMEOUT')
        this.connectError = err
        this.setConnectionState({
          status: 'failed',
          lastError: this.toErrorState(err),
          attempt: this.reconnectAttempt,
        })
        this.failReady(err)
        this.ws?.close()
      }
    }, this.connectTimeout)

    const ws = this.createWebSocket(this.url)
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return // stale socket — ignore
      const reconnectSnapshot = this.pendingReconnect
      this.currentHandshakeWasReconnect = reconnectSnapshot !== null

      // Send handshake (includes reconnection info if available)
      const handshake: MessageEnvelope = {
        id: crypto.randomUUID(),
        type: 'handshake',
        protocolVersion: PROTOCOL_VERSION,
        workspaceId: this.workspaceId,
        webContentsId: this.webContentsId,
        token: this.token,
        clientCapabilities: this.clientCapabilities.length > 0 ? this.clientCapabilities : undefined,
        reconnectClientId: reconnectSnapshot?.clientId,
        lastSeq: reconnectSnapshot?.lastSeq,
      }
      this.trySendEnvelope(ws, handshake)
    }

    ws.onmessage = (event) => {
      if (this.ws !== ws) return // stale socket — ignore
      this.onMessage(typeof event.data === 'string' ? event.data : event.data.toString())
    }

    ws.onclose = (event) => {
      if (this.ws !== ws) return // stale socket — ignore
      this.onDisconnect(event)
    }

    ws.onerror = (event: Event | { message?: string; error?: Error }) => {
      if (this.ws !== ws) return // stale socket — ignore
      // Error is typically followed by close event, handled there.
      // Capture this early for more actionable state while connecting.
      if (!this.connected && !this.connectError) {
        // Extract actual error message when available (Node.js ws library provides it)
        const detail = ('message' in event && event.message)
          || ('error' in event && event.error?.message)
          || undefined
        const message = detail
          ? `WebSocket error: ${detail}`
          : 'WebSocket error during connection setup'
        const err = this.createConnectionError('network', message, 'WS_ERROR')
        this.connectError = err
        this.setConnectionState({
          status: 'failed',
          lastError: this.toErrorState(err),
          attempt: this.reconnectAttempt,
        })
      }
    }
  }

  destroy(): void {
    this.destroyed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    if (this.ackTimer) {
      clearInterval(this.ackTimer)
      this.ackTimer = null
    }
    if (this.backoffResetTimer) {
      clearTimeout(this.backoffResetTimer)
      this.backoffResetTimer = null
    }

    this.manualReconnectRequested = false
    this.currentHandshakeWasReconnect = false
    this.pendingReconnect = null
    this.failReady(new Error('Client destroyed'))

    // Reject all pending requests
    for (const [id, req] of this.pending) {
      clearTimeout(req.timeout)
      req.reject(new Error('Client destroyed'))
    }
    this.pending.clear()
    this.anyEventListeners.clear()

    this.ws?.close()
    this.ws = null
    this.connected = false

    this.setConnectionState({
      status: 'disconnected',
      lastError: {
        kind: 'unknown',
        code: 'CLIENT_DESTROYED',
        message: 'Client destroyed',
      },
      nextRetryInMs: undefined,
    })
  }

  get isConnected(): boolean {
    return this.connected
  }

  // -------------------------------------------------------------------------
  // Message handling
  // -------------------------------------------------------------------------

  private onMessage(raw: string): void {
    let envelope: MessageEnvelope
    try {
      envelope = deserializeEnvelope(raw)
    } catch {
      return
    }

    switch (envelope.type) {
      case 'handshake_ack': {
        const wasReconnectAttempt = this.currentHandshakeWasReconnect
        const serverRecognizedReconnect = envelope.reconnected === true

        this.currentHandshakeWasReconnect = false
        this.pendingReconnect = null
        this.clientId = envelope.clientId ?? null
        this._serverVersion = envelope.serverVersion ?? null
        this.serverChannels = envelope.registeredChannels
          ? new Set(envelope.registeredChannels)
          : null
        this.connected = true
        this.connectError = null
        // Delay backoff reset — only reset after 10s of stable connection.
        // Immediate reset causes rapid reconnect loops when the server
        // accepts the handshake but drops the connection right after.
        this.scheduleBackoffReset()

        if (!serverRecognizedReconnect) {
          this.lastSeenSeq = 0
        }

        if (this.connectTimer) {
          clearTimeout(this.connectTimer)
          this.connectTimer = null
        }
        this.setConnectionState({
          status: 'connected',
          attempt: 0,
          nextRetryInMs: undefined,
          lastError: undefined,
          lastClose: undefined,
        })
        this.startAckTimer()
        this.resolveReady?.()
        this.resolveReady = null
        this.rejectReady = null
        this.readyPromise = null

        // Notify listeners about reconnection AFTER resolveReady
        if (wasReconnectAttempt) {
          // envelope.reconnected === true means server recognized the previous client.
          // If absent, the reconnect fell back to a fresh connection — treat as stale.
          const isStale = !serverRecognizedReconnect || !!envelope.stale

          const set = this.listeners.get('__transport:reconnected')
          if (set) {
            for (const cb of set) {
              try { cb(isStale) } catch { /* listener errors must not break transport */ }
            }
          }
        }
        break
      }

      case 'response': {
        const req = this.pending.get(envelope.id)
        if (req) {
          this.pending.delete(envelope.id)
          clearTimeout(req.timeout)
          if (envelope.error) {
            const err = new Error(envelope.error.message)
            ;(err as any).code = envelope.error.code
            ;(err as any).data = envelope.error.data
            req.reject(err)
          } else {
            req.resolve(envelope.result)
          }
        }
        break
      }

      case 'error': {
        // Protocol-level error (handshake rejection, version mismatch).
        // No pending request — connection is about to close.
        if (envelope.error?.message) {
          const kind = this.classifyErrorKindFromCode(envelope.error.code)
          const err = this.createConnectionError(kind, envelope.error.message, envelope.error.code)
          this.connectError = err
          this.setConnectionState({
            status: 'failed',
            lastError: this.toErrorState(err),
            attempt: this.reconnectAttempt,
          })
          this.failReady(err)
        }
        break
      }

      case 'request': {
        // Server→client capability invocation
        if (envelope.channel) {
          this.onServerRequest(envelope)
        }
        break
      }

      case 'event': {
        // Track sequence numbers for reliable delivery
        if (typeof envelope.seq === 'number') {
          if (this.lastSeenSeq > 0 && envelope.seq > this.lastSeenSeq + 1) {
            console.warn(`[WsRpc] Sequence gap: expected ${this.lastSeenSeq + 1}, got ${envelope.seq}`)
          }
          this.lastSeenSeq = envelope.seq
        }

        if (envelope.channel) {
          // Server is shutting down — stop reconnection before dispatching
          if (envelope.channel === 'server:shuttingDown') {
            this.permanentlyClosed = true
            this.setConnectionState({
              status: 'disconnected',
              lastError: { kind: 'server', message: 'Server is shutting down', code: 'SERVER_SHUTDOWN' },
            })
          }

          const set = this.listeners.get(envelope.channel)
          if (set) {
            for (const cb of set) {
              try {
                cb(...(envelope.args ?? []))
              } catch {
                // Listener errors shouldn't break the client
              }
            }
          }
          // Wildcard listeners (used by RemoteClientBridge for event forwarding)
          for (const cb of this.anyEventListeners) {
            try {
              cb(envelope.channel, ...(envelope.args ?? []))
            } catch {
              // Listener errors shouldn't break the client
            }
          }
        }
        break
      }
    }
  }

  private async onServerRequest(envelope: MessageEnvelope): Promise<void> {
    const handler = this.capabilityHandlers.get(envelope.channel!)
    if (!handler) {
      const response: MessageEnvelope = {
        id: envelope.id,
        type: 'response',
        channel: envelope.channel,
        error: { code: 'CHANNEL_NOT_FOUND', message: `No handler for: ${envelope.channel}` },
      }
      this.trySendEnvelope(this.ws, response)
      return
    }

    try {
      const result = await handler(...(envelope.args ?? []))
      const response: MessageEnvelope = {
        id: envelope.id,
        type: 'response',
        channel: envelope.channel,
        result,
      }
      this.trySendEnvelope(this.ws, response)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const response: MessageEnvelope = {
        id: envelope.id,
        type: 'response',
        channel: envelope.channel,
        error: { code: 'HANDLER_ERROR', message },
      }
      this.trySendEnvelope(this.ws, response)
    }
  }

  // -------------------------------------------------------------------------
  // Reconnection
  // -------------------------------------------------------------------------

  private onDisconnect(closeEvent?: { code?: number; reason?: string; wasClean?: boolean }): void {
    if (this.clientId) {
      this.pendingReconnect = {
        clientId: this.clientId,
        lastSeq: this.lastSeenSeq,
      }
    }

    const manualReconnect = this.manualReconnectRequested
    this.manualReconnectRequested = false

    const wasConnected = this.connected
    this.connected = false
    this.clientId = null
    this.ws = null

    // Stop ack timer
    if (this.ackTimer) {
      clearInterval(this.ackTimer)
      this.ackTimer = null
    }

    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }

    // Cancel backoff reset — counter carries over across short-lived connections
    if (this.backoffResetTimer) {
      clearTimeout(this.backoffResetTimer)
      this.backoffResetTimer = null
    }

    const closeInfo: TransportCloseInfo | undefined = closeEvent
      ? {
          code: Number.isFinite(closeEvent.code) ? closeEvent.code : undefined,
          reason: closeEvent.reason || undefined,
          wasClean: closeEvent.wasClean,
        }
      : undefined

    if (!this.connectError && closeInfo?.code) {
      const closeKind = this.classifyErrorKindFromCloseCode(closeInfo.code)
      if (closeKind !== 'unknown') {
        this.connectError = this.createConnectionError(
          closeKind,
          closeInfo.reason || `Connection closed (${closeInfo.code})`,
          `WS_CLOSE_${closeInfo.code}`,
        )
      }
    }

    // Reject all pending requests
    if (wasConnected) {
      for (const [id, req] of this.pending) {
        clearTimeout(req.timeout)
        req.reject(new Error('Connection lost'))
      }
      this.pending.clear()

      this.setConnectionState({
        status: 'disconnected',
        lastClose: closeInfo,
        attempt: this.reconnectAttempt,
      })
    } else {
      const err = this.connectError ?? new Error('Connection lost before handshake')
      this.failReady(err)

      this.setConnectionState({
        status: 'failed',
        lastError: this.toErrorState(err),
        lastClose: closeInfo,
        attempt: this.reconnectAttempt,
      })
    }

    if (manualReconnect && !this.destroyed) {
      this.connect()
      return
    }

    if (!this.destroyed && !this.permanentlyClosed && this.autoReconnect) {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.permanentlyClosed) return

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempt),
      this.maxReconnectDelay,
    )

    this.reconnectAttempt++

    this.setConnectionState({
      status: 'reconnecting',
      attempt: this.reconnectAttempt,
      nextRetryInMs: delay,
    })

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private scheduleBackoffReset(): void {
    if (this.backoffResetTimer) clearTimeout(this.backoffResetTimer)
    this.backoffResetTimer = setTimeout(() => {
      this.backoffResetTimer = null
      this.reconnectAttempt = 0
    }, 10_000)
  }

  /** Best-effort send that skips closing/closed sockets and swallows send races. */
  private trySendEnvelope(ws: WebSocket | null, envelope: MessageEnvelope): boolean {
    if (!ws || ws.readyState !== ws.OPEN) return false

    try {
      ws.send(serializeEnvelope(envelope))
      return true
    } catch {
      return false
    }
  }

  /** Periodically send sequence_ack so server can evict acknowledged events. */
  private startAckTimer(): void {
    if (this.ackTimer) clearInterval(this.ackTimer)
    this.ackTimer = setInterval(() => {
      if (this.connected && this.lastSeenSeq > 0) {
        const ack: MessageEnvelope = {
          id: crypto.randomUUID(),
          type: 'sequence_ack',
          lastSeq: this.lastSeenSeq,
        }
        this.trySendEnvelope(this.ws, ack)
      }
    }, SEQUENCE_ACK_INTERVAL_MS)
  }

  private createReadyPromise(): void {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })

    // Handshake failures may happen before any invoke() awaits readiness.
    // Attach a noop catch to avoid noisy unhandled rejection warnings.
    this.readyPromise.catch(() => {})
  }

  private failReady(error: Error): void {
    if (!this.rejectReady) return
    this.rejectReady(error)
    this.resolveReady = null
    this.rejectReady = null
    this.readyPromise = null
  }

  private async ensureConnected(channel: string): Promise<void> {
    if (this.destroyed) {
      throw new Error(`Client destroyed (channel: ${channel})`)
    }

    if (this.connected && this.ws) return

    // If a reconnect is already scheduled or in progress, await it instead of
    // canceling the backoff timer and forcing a new attempt. This prevents
    // concurrent RPC calls from resetting the exponential backoff.
    if (this.readyPromise || this.reconnectTimer) {
      const ready = this.readyPromise
      if (!ready) {
        // Reconnect timer is pending but no readyPromise yet — wait for the
        // timer to fire and produce one. Throw so caller can retry.
        throw this.connectError ?? new Error(`Not connected (channel: ${channel})`)
      }
      try {
        await ready
      } catch (error) {
        throw error instanceof Error ? error : new Error(`Not connected (channel: ${channel})`)
      }
      if (!this.connected || !this.ws) {
        throw new Error(`Not connected (channel: ${channel})`)
      }
      return
    }

    // No connection in progress and no reconnect scheduled — start one
    this.connect()

    const ready = this.readyPromise
    if (!ready) {
      throw this.connectError ?? new Error(`Not connected (channel: ${channel})`)
    }

    try {
      await ready
    } catch (error) {
      throw error instanceof Error ? error : new Error(`Not connected (channel: ${channel})`)
    }

    if (!this.connected || !this.ws) {
      throw new Error(`Not connected (channel: ${channel})`)
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private inferMode(url: string): TransportMode {
    if (url.startsWith('ws://127.0.0.1') || url.startsWith('ws://localhost')) {
      return 'local'
    }
    return 'remote'
  }

  private setConnectionState(
    partial: Omit<Partial<TransportConnectionState>, 'mode' | 'url' | 'updatedAt'>,
  ): void {
    this.connectionState = {
      ...this.connectionState,
      ...partial,
      mode: this.mode,
      url: this.url,
      updatedAt: Date.now(),
    }

    const snapshot = this.getConnectionState()
    for (const cb of this.connectionStateListeners) {
      try {
        cb(snapshot)
      } catch {
        // Listener failures must not break transport.
      }
    }
  }

  private createConnectionError(kind: TransportConnectionErrorKind, message: string, code?: string): Error {
    const err = new Error(message)
    ;(err as any).kind = kind
    if (code) (err as any).code = code
    return err
  }

  private toErrorState(err: Error): TransportConnectionError {
    const code = (err as any).code ? String((err as any).code) : undefined
    const kind = (err as any).kind as TransportConnectionErrorKind | undefined
      ?? this.classifyErrorKindFromCode(code)

    return {
      kind,
      message: err.message,
      code,
    }
  }

  private classifyErrorKindFromCode(code?: unknown): TransportConnectionErrorKind {
    const normalized = typeof code === 'string' ? code.toUpperCase() : ''

    if (normalized === 'AUTH_FAILED') return 'auth'
    if (normalized === 'PROTOCOL_VERSION_UNSUPPORTED') return 'protocol'
    if (normalized === 'HANDSHAKE_TIMEOUT' || normalized === 'REQUEST_TIMEOUT' || normalized === 'CLIENT_REQUEST_TIMEOUT') {
      return 'timeout'
    }
    if (normalized.startsWith('WS_CLOSE_')) {
      const closeCode = parseInt(normalized.slice('WS_CLOSE_'.length), 10)
      return this.classifyErrorKindFromCloseCode(closeCode)
    }
    if (normalized === 'WS_ERROR') return 'network'
    if (normalized === 'CHANNEL_NOT_FOUND' || normalized === 'HANDLER_ERROR') return 'server'

    return 'unknown'
  }

  private classifyErrorKindFromCloseCode(code?: number): TransportConnectionErrorKind {
    if (!code) return 'unknown'

    if (code === 4005) return 'auth'
    if (code === 4004) return 'protocol'
    if (code === 4001) return 'timeout'

    // 1006 = abnormal close / network interruption in browsers.
    if (code === 1006 || code === 1001) return 'network'

    return 'unknown'
  }
}
