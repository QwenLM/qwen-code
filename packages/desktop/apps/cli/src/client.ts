/**
 * CliRpcClient — Minimal WebSocket RPC client for CLI usage.
 *
 * Stripped-down version of WsRpcClient: no auto-reconnect, no capabilities,
 * no connection state listeners. Connect, work, exit.
 */

import {
  PROTOCOL_VERSION,
  type MessageEnvelope,
} from '@craft-agent/shared/protocol'
import {
  serializeEnvelope,
  deserializeEnvelope,
} from '@craft-agent/server-core/transport'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export interface CliClientOptions {
  token?: string
  workspaceId?: string
  requestTimeout?: number
  connectTimeout?: number
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class CliRpcClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, PendingRequest>()
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private _clientId: string | null = null
  private _connected = false
  private _destroyed = false

  private readonly url: string
  private readonly token: string | undefined
  private readonly workspaceId: string | undefined
  private readonly requestTimeout: number
  private readonly connectTimeout: number

  constructor(url: string, opts?: CliClientOptions) {
    this.url = url
    this.token = opts?.token
    this.workspaceId = opts?.workspaceId
    this.requestTimeout = opts?.requestTimeout ?? 10_000
    this.connectTimeout = opts?.connectTimeout ?? 10_000
  }

  /** Connect to the server and complete the handshake. Returns the assigned clientId. */
  async connect(): Promise<string> {
    if (this._destroyed) throw new Error('Client destroyed')

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Connection timeout (${this.connectTimeout}ms)`))
        this.ws?.close()
      }, this.connectTimeout)

      this.ws = new WebSocket(this.url)

      this.ws.onopen = () => {
        const handshake: MessageEnvelope = {
          id: crypto.randomUUID(),
          type: 'handshake',
          protocolVersion: PROTOCOL_VERSION,
          workspaceId: this.workspaceId,
          token: this.token,
        }
        this.ws!.send(serializeEnvelope(handshake))
      }

      this.ws.onmessage = (event) => {
        const raw = typeof event.data === 'string' ? event.data : String(event.data)
        let envelope: MessageEnvelope
        try {
          envelope = deserializeEnvelope(raw)
        } catch {
          return
        }

        if (envelope.type === 'handshake_ack') {
          clearTimeout(timer)
          this._clientId = envelope.clientId ?? null
          this._connected = true
          // Switch to normal message handler
          this.ws!.onmessage = (e) => {
            this.onMessage(typeof e.data === 'string' ? e.data : String(e.data))
          }
          resolve(this._clientId!)
        } else if (envelope.type === 'error') {
          clearTimeout(timer)
          const err = new Error(envelope.error?.message ?? 'Connection rejected')
          ;(err as any).code = envelope.error?.code
          reject(err)
        }
      }

      this.ws.onerror = () => {
        if (!this._connected) {
          clearTimeout(timer)
          reject(new Error('WebSocket connection error'))
        }
      }

      this.ws.onclose = () => {
        if (!this._connected) {
          clearTimeout(timer)
          reject(new Error('WebSocket closed before handshake'))
        }
        this._connected = false
        for (const [, req] of this.pending) {
          clearTimeout(req.timeout)
          req.reject(new Error('Disconnected'))
        }
        this.pending.clear()
      }
    })
  }

  /** Send an RPC request and await the response. */
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!this._connected || !this.ws) {
      throw new Error(`Not connected (channel: ${channel})`)
    }

    return new Promise((resolve, reject) => {
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
      this.ws!.send(serializeEnvelope(envelope))
    })
  }

  /** Subscribe to push events on a channel. Returns an unsubscribe function. */
  on(channel: string, callback: (...args: unknown[]) => void): () => void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(callback)

    return () => {
      set!.delete(callback)
      if (set!.size === 0) this.listeners.delete(channel)
    }
  }

  /** Close the connection and reject all pending requests. */
  destroy(): void {
    this._destroyed = true
    for (const [, req] of this.pending) {
      clearTimeout(req.timeout)
      req.reject(new Error('Client destroyed'))
    }
    this.pending.clear()
    this.ws?.close()
    this.ws = null
    this._connected = false
  }

  get isConnected(): boolean {
    return this._connected
  }

  get clientId(): string | null {
    return this._clientId
  }

  // -------------------------------------------------------------------------
  // Internal message routing
  // -------------------------------------------------------------------------

  private onMessage(raw: string): void {
    let envelope: MessageEnvelope
    try {
      envelope = deserializeEnvelope(raw)
    } catch {
      return
    }

    switch (envelope.type) {
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

      case 'event': {
        if (envelope.channel) {
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
        }
        break
      }
    }
  }
}
