/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { logSafe } from './json-rpc.js';
import type { TransportStream } from './transport-stream.js';

/**
 * Per-stream cap on frames buffered before the client attaches its SSE
 * stream. Mirrors the EventBus's `maxQueued` backpressure cap so a client
 * that drives requests without ever opening a stream can't grow daemon
 * memory without bound. Oldest frames are dropped past the cap.
 */
const MAX_BUFFERED_FRAMES = 256;

/** Default cap on concurrent live connections (mirrors a bounded resource). */
const DEFAULT_MAX_CONNECTIONS = 64;

/**
 * Invoked when a session/connection tears down while an agent→client
 * request (e.g. a permission prompt) is still outstanding, so the bridge
 * isn't left blocked awaiting a vote that will never arrive.
 */
export type AbandonPendingFn = (
  req: PendingClientRequest,
  clientId: string | undefined,
) => boolean;

/**
 * Best-effort bridge detach for a session's bridge-stamped clientId on
 * teardown. Without it, `session/new`/`load`/`resume`-registered client ids
 * stay visible in `knownClientIds()`/`votersForSession()` after the ACP
 * connection is gone — skewing permission mediation + origin validation.
 * ACP clients can't clean this up themselves (the id isn't on the wire).
 */
export type DetachSessionFn = (
  sessionId: string,
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
  stream?: TransportStream;
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
  /**
   * Aborts the in-flight `session/prompt` for this session. Set by
   * `handlePrompt` while a prompt runs; aborted on `session/cancel` and on
   * session/connection teardown so a disconnecting client doesn't leave
   * the agent burning model quota on a result nobody will read.
   */
  promptAbort?: AbortController;
}

/** An agent→client request awaiting the client's JSON-RPC response. */
export interface PendingClientRequest {
  sessionId: string;
  /** Maps the JSON-RPC id we issued back to the bridge's permission id. */
  bridgeRequestId: string;
  kind: 'permission';
}

export interface AcpConnectionDiagnostic {
  connectionIdPrefix: string;
  fromLoopback: boolean;
  destroyed: boolean;
  lastActiveMs: number;
  ownedSessionCount: number;
  sessionBindingCount: number;
  closingSessionCount: number;
  pendingClientRequests: number;
  connectionStreamOpen: boolean;
  sessionStreams: number;
  sseStreams: number;
  wsStreams: number;
  bufferedConnectionFrames: number;
  bufferedSessionFrames: number;
}

export interface ConnectionRegistrySnapshot {
  connectionCount: number;
  connectionCap: number | null;
  connectionStreams: number;
  sessionStreams: number;
  sseStreams: number;
  wsStreams: number;
  pendingClientRequests: number;
  connections: AcpConnectionDiagnostic[];
}

export class AcpConnection {
  readonly connectionId: string;
  /** Connection-scoped SSE stream (the client's `GET /acp` with only the conn header). */
  connStream?: TransportStream;
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
  /**
   * Sessions with an in-flight `session/close` (between the synchronous
   * ownership-revoke and the bridge close + local teardown). `session/load`
   * / `resume` reject for an id in this set so a close racing a re-load
   * can't have its `finally` teardown destroy the freshly-loaded session.
   */
  readonly closingSessions = new Set<string>();
  /** Agent→client requests awaiting a client response, keyed by JSON-RPC id. */
  readonly pending = new Map<string, PendingClientRequest>();
  /** Daemon-issued client id reused across this connection's bridge calls. */
  readonly clientId: string;
  /**
   * True when the `initialize` POST arrived from a kernel-stamped loopback
   * peer. Threaded into per-session bridge contexts so the `local-only`
   * permission policy can gate votes by transport — mirrors the REST
   * surface's `detectFromLoopback(req)`. NOT derived from forgeable
   * headers (`X-Forwarded-For` etc).
   */
  readonly fromLoopback: boolean;
  /**
   * Set by `destroy()`. An in-flight `session/new`/`load`/`resume` whose
   * bridge call resolves AFTER teardown checks this to kill/detach the
   * late-registered session, so a `DELETE` (or idle sweep) racing a spawn
   * doesn't orphan a child process / phantom clientId.
   */
  destroyed = false;
  /**
   * Grace-period reap timer armed when the connection-scoped SSE stream
   * closes; cleared on reconnect (`attachConnStream`) or teardown. Avoids a
   * dead connection locking its `ownedSessions` (and counting against
   * `maxConnections`) for the full 30-min idle TTL.
   */
  connGraceTimer?: ReturnType<typeof setTimeout>;
  lastActiveMs: number = Date.now();
  private idCounter = 0;

  constructor(
    connectionId: string | undefined,
    fromLoopback: boolean,
    private readonly onAbandonPending?: AbandonPendingFn,
    private readonly onDetachSession?: DetachSessionFn,
  ) {
    this.connectionId = connectionId ?? randomUUID();
    this.clientId = randomUUID();
    this.fromLoopback = fromLoopback;
  }

  /**
   * Allocate a fresh JSON-RPC id for an agent→client request. STRING-typed
   * (`_qwen_perm_N`) so it can never collide with a client-originated id —
   * JSON-RPC 2.0 permits clients to use any number (incl. negatives) or
   * string, so a numeric namespace wasn't actually safe.
   */
  nextId(): string {
    this.idCounter += 1;
    return `_qwen_perm_${this.idCounter}`;
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

  getDiagnostic(): AcpConnectionDiagnostic {
    const liveStreams = new Set<TransportStream>();
    if (this.connStream && !this.connStream.isClosed) {
      liveStreams.add(this.connStream);
    }
    let sessionStreams = 0;
    let bufferedSessionFrames = 0;
    for (const binding of this.sessions.values()) {
      bufferedSessionFrames += binding.buffer.length;
      if (binding.stream && !binding.stream.isClosed) {
        sessionStreams += 1;
        liveStreams.add(binding.stream);
      }
    }
    let sseStreams = 0;
    let wsStreams = 0;
    for (const stream of liveStreams) {
      if (stream.kind === 'sse') sseStreams += 1;
      if (stream.kind === 'ws') wsStreams += 1;
    }
    return {
      connectionIdPrefix: this.connectionId.slice(0, 8),
      fromLoopback: this.fromLoopback,
      destroyed: this.destroyed,
      lastActiveMs: this.lastActiveMs,
      ownedSessionCount: this.ownedSessions.size,
      sessionBindingCount: this.sessions.size,
      closingSessionCount: this.closingSessions.size,
      pendingClientRequests: this.pending.size,
      connectionStreamOpen:
        this.connStream !== undefined && !this.connStream.isClosed,
      sessionStreams,
      sseStreams,
      wsStreams,
      bufferedConnectionFrames: this.connBuffer.length,
      bufferedSessionFrames,
    };
  }

  /** Send a frame on the connection-scoped stream (buffer until it attaches). */
  sendConn(frame: unknown): void {
    if (this.connStream && !this.connStream.isClosed) {
      void this.connStream.send(frame);
    } else {
      pushCapped(this.connBuffer, frame, `conn ${this.connectionId}`);
    }
  }

  /** True if any session currently has a live (open) SSE stream. */
  hasLiveSessionStream(): boolean {
    for (const b of this.sessions.values()) {
      if (b.stream && !b.stream.isClosed) return true;
    }
    return false;
  }

  /** Cancel a pending grace-period reap (e.g. on conn-stream reconnect). */
  clearGraceTimer(): void {
    if (this.connGraceTimer) {
      clearTimeout(this.connGraceTimer);
      this.connGraceTimer = undefined;
    }
  }

  /** Attach the connection-scoped stream and flush any buffered frames. */
  attachConnStream(stream: TransportStream): void {
    // A reconnect cancels any pending grace-period reap.
    this.clearGraceTimer();
    // Close any prior connection stream so its heartbeat interval + socket
    // don't leak when a client reconnects the connection-scoped GET.
    if (this.connStream && this.connStream !== stream) this.connStream.close();
    this.connStream = stream;
    for (const frame of this.connBuffer.splice(0)) void stream.send(frame);
  }

  /**
   * Send a frame on a session-scoped stream (buffer until it attaches).
   * LOOKUP-ONLY: drops the frame when the session has no binding — a binding
   * always exists for a live session (created at `session/new`/`load`/
   * `resume`), so a missing one means the session was torn down. Auto-
   * creating here would resurrect a ghost binding (no stream, no owner) that
   * buffers up to 256 late pump/reply frames forever.
   */
  sendSession(sessionId: string, frame: unknown): void {
    const binding = this.sessions.get(sessionId);
    if (!binding) return;
    if (binding.stream && !binding.stream.isClosed) {
      void binding.stream.send(frame);
    } else {
      pushCapped(binding.buffer, frame, `session ${sessionId}`);
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
    stream: TransportStream,
    abort: AbortController,
  ): SessionBinding {
    const binding = this.getOrCreateSession(sessionId);
    const prevStream = binding.stream;
    binding.abort.abort();
    binding.abort = abort;
    // Install the NEW stream BEFORE closing the old one. The old stream's
    // `onClose` is identity-guarded on `binding.stream` (see the session-GET
    // handler in `index.ts` — `if (conn.sessions.get(sessionId)?.stream ===
    // stream) ...promptAbort?.abort()`), so installing first means a
    // reconnect's close can't abort the in-flight prompt (the client is
    // reconnecting, not leaving — the prompt must survive). CONTRACT: that
    // identity guard and this ordering must stay in lockstep.
    binding.stream = stream;
    if (prevStream && prevStream !== stream && prevStream !== this.connStream) {
      prevStream.close();
    }
    for (const frame of binding.buffer.splice(0)) void stream.send(frame);
    return binding;
  }

  closeSessionStream(sessionId: string): void {
    const binding = this.sessions.get(sessionId);
    if (!binding) return;
    this.teardownBinding(binding);
    this.sessions.delete(sessionId);
    this.ownedSessions.delete(sessionId);
  }

  destroy(): void {
    this.destroyed = true;
    this.clearGraceTimer();
    for (const binding of this.sessions.values()) {
      try {
        this.teardownBinding(binding);
      } catch (err) {
        writeStderrLine(
          `qwen serve: /acp teardownBinding(${logSafe(binding.sessionId)}) failed during destroy: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.sessions.clear();
    this.ownedSessions.clear();
    this.pending.clear();
    this.connStream?.close();
  }

  private teardownBinding(binding: SessionBinding): void {
    binding.abort.abort();
    binding.promptAbort?.abort();
    // Don't close the stream if it's the shared connStream (WS reuses
    // one socket for all sessions — closing it kills the entire connection).
    if (binding.stream && binding.stream !== this.connStream) {
      binding.stream.close();
    }
    this.abandonPendingForSession(binding.sessionId, binding.clientId);
    this.onDetachSession?.(binding.sessionId, binding.clientId);
  }

  /**
   * Cancel + drop any pending agent→client requests for a closing session.
   * This is the LAST-RESORT recovery path: `resolveClientResponse` retains a
   * pending entry on double-failure (vote AND cancel both threw) precisely so
   * this teardown sweep can retry the cancel. We always drop the entry here
   * (the connection is going away — there is no further retry after teardown),
   * but if the cancel itself still fails (triple-failure) the bridge mediator
   * may be stuck awaiting a vote that will never arrive, so log it for the
   * operator rather than failing silently.
   */
  private abandonPendingForSession(
    sessionId: string,
    clientId: string | undefined,
  ): void {
    for (const [id, req] of this.pending) {
      if (req.sessionId !== sessionId) continue;
      this.pending.delete(id);
      const cancelled = this.onAbandonPending?.(req, clientId) ?? true;
      if (!cancelled) {
        writeStderrLine(
          `qwen serve: /acp MEDIATOR STUCK: abandonPendingForSession(${logSafe(sessionId)}) cancel failed for ${logSafe(req.bridgeRequestId)}`,
        );
      }
    }
  }
}

function pushCapped(buf: unknown[], frame: unknown, label = 'stream'): void {
  if (buf.length >= MAX_BUFFERED_FRAMES) {
    buf.shift();
    writeStderrLine(
      `qwen serve: /acp pre-attach buffer full (${label}), dropped oldest frame`,
    );
  }
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
    private readonly onDetachSession?: DetachSessionFn,
    private readonly maxConnections = DEFAULT_MAX_CONNECTIONS,
    private readonly idleTtlMs = 30 * 60_000,
  ) {
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  /**
   * Mint a connection, or return `undefined` when the live-connection cap
   * is reached (the caller answers `503`). Bounds an `initialize` flood from
   * growing the registry without limit through the full TTL window.
   */
  create(fromLoopback: boolean): AcpConnection | undefined {
    if (this.maxConnections > 0 && this.byId.size >= this.maxConnections) {
      return undefined;
    }
    const conn = new AcpConnection(
      undefined,
      fromLoopback,
      this.onAbandonPending,
      this.onDetachSession,
    );
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

  /** The configured concurrent-connection cap (for operator-facing logs). */
  get connectionCap(): number {
    return this.maxConnections;
  }

  getSnapshot(): ConnectionRegistrySnapshot {
    const connections = [...this.byId.values()].map((conn) =>
      conn.getDiagnostic(),
    );
    return {
      connectionCount: this.byId.size,
      connectionCap:
        this.maxConnections > 0 && Number.isFinite(this.maxConnections)
          ? this.maxConnections
          : null,
      connectionStreams: connections.filter((conn) => conn.connectionStreamOpen)
        .length,
      sessionStreams: sumBy(connections, (conn) => conn.sessionStreams),
      sseStreams: sumBy(connections, (conn) => conn.sseStreams),
      wsStreams: sumBy(connections, (conn) => conn.wsStreams),
      pendingClientRequests: sumBy(
        connections,
        (conn) => conn.pendingClientRequests,
      ),
      connections,
    };
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    for (const id of [...this.byId.keys()]) this.delete(id);
  }

  private sweep(): void {
    const cutoff = Date.now() - this.idleTtlMs;
    for (const [id, conn] of this.byId) {
      if (conn.lastActiveMs >= cutoff) continue;
      // Observability: a reaped connection silently dropping its SSE
      // streams is otherwise invisible to operators chasing "my client
      // froze". Note that `touch()` fires on inbound HTTP AND on event
      // delivery (pumpSessionEvents), so a long quiet prompt isn't reaped.
      writeStderrLine(
        `qwen serve: /acp reaping idle connection ${id} ` +
          `(idle > ${Math.round(this.idleTtlMs / 60_000)}m, ` +
          `${conn.sessions.size} session(s))`,
      );
      this.delete(id);
    }
  }
}

function sumBy<T>(values: readonly T[], select: (value: T) => number): number {
  let total = 0;
  for (const value of values) total += select(value);
  return total;
}
