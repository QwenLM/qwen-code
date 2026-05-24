/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { SseStream } from './sseStream.js';

/**
 * Per-stream cap on frames buffered before the client attaches its SSE
 * stream. Mirrors the EventBus's `maxQueued` backpressure cap so a client
 * that drives requests without ever opening a stream can't grow daemon
 * memory without bound. Oldest frames are dropped past the cap.
 */
const MAX_BUFFERED_FRAMES = 256;

/**
 * Invoked when a session/connection tears down while an agent→client
 * request (e.g. a permission prompt) is still outstanding, so the bridge
 * isn't left blocked awaiting a vote that will never arrive.
 */
export type AbandonPendingFn = (
  req: PendingClientRequest,
  clientId: string | undefined,
) => void;

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
  /**
   * Aborts the bridge event subscription tied to the CURRENT session
   * stream. Replaced with a fresh controller on every re-attach — a
   * controller, once aborted (on stream close), can never resume, so
   * reusing it across reconnects would leave the new stream permanently
   * event-starved.
   */
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
  /**
   * Sessions this connection created (`session/new`) or explicitly
   * attached to (`session/load`/`resume`). Per-session operations
   * (subscribe, prompt, cancel, …) are gated on membership here so one
   * connection can't drive or eavesdrop on a session it never claimed.
   */
  readonly ownedSessions = new Set<string>();
  readonly pending = new Map<number, PendingClientRequest>();
  /** Daemon-issued client id reused across this connection's bridge calls. */
  readonly clientId: string;
  lastActiveMs: number = Date.now();
  private idCounter = 0;

  constructor(
    connectionId: string | undefined,
    private readonly onAbandonPending?: AbandonPendingFn,
  ) {
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

  ownSession(sessionId: string): void {
    this.ownedSessions.add(sessionId);
  }

  ownsSession(sessionId: string): boolean {
    return this.ownedSessions.has(sessionId);
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
      pushCapped(this.connBuffer, frame);
    }
  }

  /** Attach the connection-scoped stream and flush any buffered frames. */
  attachConnStream(stream: SseStream): void {
    // Close any prior connection stream so its heartbeat interval + socket
    // don't leak when a client reconnects the connection-scoped GET.
    if (this.connStream && this.connStream !== stream) this.connStream.close();
    this.connStream = stream;
    for (const frame of this.connBuffer.splice(0)) void stream.send(frame);
  }

  /** Send a frame on a session-scoped stream (buffer until it attaches). */
  sendSession(sessionId: string, frame: unknown): void {
    const binding = this.getOrCreateSession(sessionId);
    if (binding.stream && !binding.stream.isClosed) {
      void binding.stream.send(frame);
    } else {
      pushCapped(binding.buffer, frame);
    }
  }

  /**
   * Attach a session-scoped stream: close any prior stream, abort the prior
   * subscription, install the caller's FRESH AbortController (the old one is
   * aborted and can never resume — reusing it would leave the new stream
   * event-starved), flush buffered frames, and return the binding.
   */
  attachSessionStream(
    sessionId: string,
    stream: SseStream,
    abort: AbortController,
  ): SessionBinding {
    const binding = this.getOrCreateSession(sessionId);
    if (binding.stream && binding.stream !== stream) binding.stream.close();
    binding.abort.abort();
    binding.abort = abort;
    binding.stream = stream;
    for (const frame of binding.buffer.splice(0)) void stream.send(frame);
    return binding;
  }

  closeSessionStream(sessionId: string): void {
    const binding = this.sessions.get(sessionId);
    if (!binding) return;
    binding.abort.abort();
    binding.stream?.close();
    this.abandonPendingForSession(sessionId, binding.clientId);
    this.sessions.delete(sessionId);
    this.ownedSessions.delete(sessionId);
  }

  destroy(): void {
    for (const binding of this.sessions.values()) {
      binding.abort.abort();
      binding.stream?.close();
      this.abandonPendingForSession(binding.sessionId, binding.clientId);
    }
    this.sessions.clear();
    this.ownedSessions.clear();
    this.pending.clear();
    this.connStream?.close();
  }

  /** Cancel + drop any pending agent→client requests for a closing session. */
  private abandonPendingForSession(
    sessionId: string,
    clientId: string | undefined,
  ): void {
    for (const [id, req] of this.pending) {
      if (req.sessionId !== sessionId) continue;
      this.pending.delete(id);
      this.onAbandonPending?.(req, clientId);
    }
  }
}

function pushCapped(buf: unknown[], frame: unknown): void {
  if (buf.length >= MAX_BUFFERED_FRAMES) buf.shift();
  buf.push(frame);
}

/**
 * Registry of live ACP connections with an idle-TTL sweep. The sweep is
 * defensive: a well-behaved client `DELETE /acp`s, but a crashed client
 * that never closes its streams would otherwise leak connection state.
 */
export class ConnectionRegistry {
  private readonly byId = new Map<string, AcpConnection>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly onAbandonPending?: AbandonPendingFn,
    private readonly idleTtlMs = 30 * 60_000,
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  create(): AcpConnection {
    const conn = new AcpConnection(undefined, this.onAbandonPending);
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
