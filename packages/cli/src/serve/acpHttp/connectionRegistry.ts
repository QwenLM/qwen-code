/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { SseStream } from './sseStream.js';

/**
 * Tracks one logical ACP-over-HTTP connection (RFD #721). A connection is
 * minted at `initialize`, keyed by `Acp-Connection-Id`, and may host many
 * sessions — each with its own session-scoped SSE stream.
 */
export interface SessionBinding {
  sessionId: string;
  /**
   * The clientId the bridge STAMPED for this session at create/attach.
   * The bridge ignores caller-supplied ids it has never issued and mints
   * a fresh one (returned on `spawnOrAttach`/`loadSession`), so every
   * later per-session call (`sendPrompt`, permission votes, …) must echo
   * THIS id, not the connection's own — otherwise the bridge rejects it
   * with "client id is not registered for session".
   */
  clientId?: string;
  /** Session-scoped SSE stream (the client's `GET /acp` with both headers). */
  stream?: SseStream;
  /** Frames emitted before the session stream attached, flushed on attach. */
  buffer: unknown[];
  /** Aborts the bridge event subscription when the stream/connection closes. */
  abort: AbortController;
}

/** An agent→client request awaiting the client's JSON-RPC response. */
export interface PendingClientRequest {
  sessionId: string;
  /** Maps the JSON-RPC id we issued back to the bridge's permission id. */
  bridgeRequestId: string;
  kind: 'permission';
}

export class AcpConnection {
  readonly connectionId: string;
  /** Connection-scoped SSE stream (the client's `GET /acp` with only the conn header). */
  connStream?: SseStream;
  /** Frames emitted before the connection stream attached, flushed on attach. */
  private readonly connBuffer: unknown[] = [];
  readonly sessions = new Map<string, SessionBinding>();
  readonly pending = new Map<number, PendingClientRequest>();
  /** Daemon-issued client id reused across this connection's bridge calls. */
  readonly clientId: string;
  lastActiveMs: number = Date.now();
  private idCounter = 0;

  constructor(connectionId?: string) {
    this.connectionId = connectionId ?? randomUUID();
    this.clientId = randomUUID();
  }

  /** Allocate a fresh JSON-RPC id for an agent→client request. */
  nextId(): number {
    // Negative ids keep our outbound request ids disjoint from the
    // client's (clients conventionally use positive ids), so a client
    // that echoes ids can't collide with our permission requests.
    this.idCounter -= 1;
    return this.idCounter;
  }

  touch(): void {
    this.lastActiveMs = Date.now();
  }

  getOrCreateSession(sessionId: string): SessionBinding {
    let binding = this.sessions.get(sessionId);
    if (!binding) {
      binding = { sessionId, abort: new AbortController(), buffer: [] };
      this.sessions.set(sessionId, binding);
    }
    return binding;
  }

  /** Send a frame on the connection-scoped stream (buffer until it attaches). */
  sendConn(frame: unknown): void {
    if (this.connStream && !this.connStream.isClosed) {
      void this.connStream.send(frame);
    } else {
      this.connBuffer.push(frame);
    }
  }

  /** Attach the connection-scoped stream and flush any buffered frames. */
  attachConnStream(stream: SseStream): void {
    this.connStream = stream;
    for (const frame of this.connBuffer.splice(0)) void stream.send(frame);
  }

  /** Send a frame on a session-scoped stream (buffer until it attaches). */
  sendSession(sessionId: string, frame: unknown): void {
    const binding = this.getOrCreateSession(sessionId);
    if (binding.stream && !binding.stream.isClosed) {
      void binding.stream.send(frame);
    } else {
      binding.buffer.push(frame);
    }
  }

  /** Attach a session-scoped stream and flush any buffered frames. */
  attachSessionStream(sessionId: string, stream: SseStream): SessionBinding {
    const binding = this.getOrCreateSession(sessionId);
    binding.stream = stream;
    for (const frame of binding.buffer.splice(0)) void stream.send(frame);
    return binding;
  }

  closeSessionStream(sessionId: string): void {
    const binding = this.sessions.get(sessionId);
    if (!binding) return;
    binding.abort.abort();
    binding.stream?.close();
    this.sessions.delete(sessionId);
  }

  destroy(): void {
    for (const binding of this.sessions.values()) {
      binding.abort.abort();
      binding.stream?.close();
    }
    this.sessions.clear();
    this.pending.clear();
    this.connStream?.close();
  }
}

/**
 * Registry of live ACP connections with an idle-TTL sweep. The sweep is
 * defensive: a well-behaved client `DELETE /acp`s, but a crashed client
 * that never closes its streams would otherwise leak connection state.
 */
export class ConnectionRegistry {
  private readonly byId = new Map<string, AcpConnection>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(private readonly idleTtlMs = 30 * 60_000) {
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  create(): AcpConnection {
    const conn = new AcpConnection();
    this.byId.set(conn.connectionId, conn);
    return conn;
  }

  get(connectionId: string | undefined): AcpConnection | undefined {
    if (!connectionId) return undefined;
    const conn = this.byId.get(connectionId);
    conn?.touch();
    return conn;
  }

  delete(connectionId: string): boolean {
    const conn = this.byId.get(connectionId);
    if (!conn) return false;
    conn.destroy();
    return this.byId.delete(connectionId);
  }

  get size(): number {
    return this.byId.size;
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    for (const id of [...this.byId.keys()]) this.delete(id);
  }

  private sweep(): void {
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [id, conn] of this.byId) {
      if (conn.lastActiveMs < cutoff) this.delete(id);
    }
  }
}
