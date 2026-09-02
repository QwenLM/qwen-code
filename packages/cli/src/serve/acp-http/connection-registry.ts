/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { logSafe } from './json-rpc.js';
import {
  ACP_PRE_ATTACH_MAX_FRAMES_PER_CONNECTION,
  ACP_PRE_ATTACH_MAX_FRAMES_PER_STREAM,
  ACP_PRE_ATTACH_MAX_PAYLOAD_BYTES_PER_CONNECTION,
  AcpPreAttachBudget,
  type AcpPreAttachLease,
} from './pre-attach-budget.js';
import type {
  DeliveryResult,
  TransportCloseReason,
  TransportStream,
} from './transport-stream.js';

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

export interface DeliveryReceipt {
  delivered(): void;
  discarded(): void;
  outcomeUnknown?(): void;
}

interface PreparedFrame {
  payload: Buffer;
  sequence: number;
  id?: number;
  /**
   * For DEFERRED out-of-band replies only (`sendSessionReply`, always id-less):
   * the bus head id at the moment the reply was produced. The reply must not be
   * released to the wire until the pump has delivered every content event up to
   * this id — otherwise a prompt result produced during a slow ring replay could
   * land ahead of tail content that is still queued behind `replay_complete`
   * (§1.8 W1). `undefined` ⇒ release at the next boundary unconditionally.
   */
  anchorId?: number;
  receipt?: DeliveryReceipt;
  receiptSettled?: boolean;
  lease?: AcpPreAttachLease;
  binding?: SessionBinding;
  requeueOnStreamReplacement?: boolean;
  deliveryAttempt?: number;
  deliveryStream?: TransportStream;
  resolve: (result: DeliveryResult) => void;
}

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
  /** Stable across a transport detach while `stream` is temporarily absent. */
  usesConnectionStream?: boolean;
  /**
   * Frames emitted before the session stream attached, flushed on attach.
   * Each keeps its bus event id (when it has one) so the SSE `id:` resume
   * cursor survives the buffer → live-stream handoff.
   */
  buffer: PreparedFrame[];
  ownedFrames: number;
  ownedBytes: number;
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
  /**
   * Armed by `detachSessionStream` when the session stream closes at the
   * transport level (proxy idle-close, network blip) WITHOUT an explicit
   * `session/close`. The binding — ownership, prompt, bridge-client — is kept
   * alive across the window so a reconnect (`attachSessionStream`) can resume
   * (ring replay backfills the gap, §1.8). If no reconnect arrives the timer
   * fires the full teardown, bounding the runaway-prompt cost. Cleared on
   * reconnect and on teardown.
   */
  graceTimer?: ReturnType<typeof setTimeout>;
  /**
   * Set from the CURRENT attach mode on every `attachSessionStream`: armed on a
   * resumptive attach (with a `Last-Event-ID`), cleared on a fresh one (no
   * `Last-Event-ID`) — never a one-way latch, or an aborted resume that skipped
   * its flush would strand the flag and buffer every later reply forever. Also
   * cleared when the ring replay boundary passes (`replay_complete` →
   * `flushBufferedSessionFrames`). While set, OUT-OF-BAND session JSON-RPC
   * replies (`replySession` — e.g. a `session/prompt` result that finishes
   * mid-replay) are deferred into `buffer` instead of written live, so they
   * can't overtake replay frames that haven't been sent yet. The flush boundary
   * is `replay_complete` ONLY: `state_resync_required` is deliberately NOT one —
   * the EventBus emits it BEFORE the replay frames, so flushing there would put
   * deferred replies ahead of replayed content (the §1.8 reordering bug). In-band
   * pump frames (`translateEvent`, including the `replay_complete` frame itself)
   * are unaffected — they're already produced in replay order.
   */
  replayPending?: boolean;
  /**
   * Set after ACP `session/load` when the bridge used response-mode history
   * replay. The first session stream attach rereads the bridge replay snapshot
   * and emits it; the binding keeps only this lightweight marker, not the
   * potentially large replay arrays.
   */
  initialReplayPending?: boolean;
}

/** An agent→client request awaiting the client's JSON-RPC response. */
export interface PendingClientRequest {
  sessionId: string;
  /** Maps the JSON-RPC id we issued back to the bridge's permission id. */
  bridgeRequestId: string;
  kind: 'permission';
}

export interface SessionOwnershipIdentity {
  binding: SessionBinding | undefined;
  generation: number;
}

interface SessionOwnershipState {
  generation: number;
  captures: number;
}

export interface PendingClientRequestRef {
  conn: AcpConnection;
  id: string;
  req: PendingClientRequest;
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
  pendingDeliveryFrames: number;
  preAttachOwnedFrames: number;
  preAttachOwnedBytes: number;
}

export interface ConnectionRegistrySnapshot {
  connectionCount: number;
  connectionCap: number | null;
  connectionStreams: number;
  sessionStreams: number;
  sseStreams: number;
  wsStreams: number;
  pendingClientRequests: number;
  bufferedConnectionFrames: number;
  bufferedSessionFrames: number;
  pendingDeliveryFrames: number;
  preAttachOwnedFrames: number;
  preAttachOwnedBytes: number;
  preAttachGuardFailures: number;
  connections: AcpConnectionDiagnostic[];
}

export class AcpConnection {
  readonly connectionId: string;
  /** Connection-scoped SSE stream (the client's `GET /acp` with only the conn header). */
  connStream?: TransportStream;
  private readonly abortController = new AbortController();
  readonly abortSignal = this.abortController.signal;
  /** Frames emitted before the connection stream attached, flushed on attach. */
  private readonly connBuffer: PreparedFrame[] = [];
  private readonly pendingDeliveries = new Set<PreparedFrame>();
  private nextPreparedSequence = 0;
  private ownedFrames = 0;
  private ownedBytes = 0;
  private connOwnedFrames = 0;
  private readonly pendingReceipts = new Set<DeliveryReceipt>();
  private readonly sessionOwnershipStates = new Map<
    string,
    SessionOwnershipState
  >();
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
  /**
   * True once the connection grace timer has fired. The timer is one-shot, so
   * if it fired while a session was still mid-reconnect (`hasRecoverableSession`
   * blocked the reap), nothing would re-check the connection after that session
   * later tore down — it would linger until the 30-min idle sweep. This flag
   * lets `onSessionGraceExpired` (fired when a session grace expires) recognize
   * "the conn grace already elapsed" and run the reap that was deferred.
   */
  connGraceExpired = false;
  /**
   * Set by the transport layer (`index.ts`) when the connection grace timer is
   * armed. Invoked after a session's reclaim grace expires so a connection that
   * was blocked from reaping by a then-recoverable session gets re-evaluated
   * instead of leaking until the idle sweep.
   */
  onSessionGraceExpired?: () => void;
  lastActiveMs: number = Date.now();
  private idCounter = 0;

  constructor(
    connectionId: string | undefined,
    fromLoopback: boolean,
    private readonly onAbandonPending?: AbandonPendingFn,
    private readonly onDetachSession?: DetachSessionFn,
    private readonly preAttachBudget = new AcpPreAttachBudget(),
    private readonly onFatalConnection?: (
      connection: AcpConnection,
      reason: TransportCloseReason,
    ) => void,
    private readonly maxFramesPerConnection = ACP_PRE_ATTACH_MAX_FRAMES_PER_CONNECTION,
    private readonly maxPayloadBytesPerConnection = ACP_PRE_ATTACH_MAX_PAYLOAD_BYTES_PER_CONNECTION,
    private readonly onPreAttachGuardFailure?: () => void,
  ) {
    this.connectionId = connectionId ?? randomUUID();
    this.clientId = randomUUID();
    this.fromLoopback = fromLoopback;
  }

  /**
   * Allocate a fresh JSON-RPC id for an agent→client request. STRING-typed
   * (`_qwen_perm_<conn>_N`) so it can never collide with a client-originated id —
   * JSON-RPC 2.0 permits clients to use any number (incl. negatives) or
   * string, so a numeric namespace wasn't actually safe.
   */
  nextId(): string {
    this.idCounter += 1;
    return `_qwen_perm_${this.connectionId}_${this.idCounter}`;
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

  captureSessionOwnershipIdentity(sessionId: string): SessionOwnershipIdentity {
    let state = this.sessionOwnershipStates.get(sessionId);
    if (!state) {
      state = { generation: 0, captures: 0 };
      this.sessionOwnershipStates.set(sessionId, state);
    }
    state.captures += 1;
    return {
      binding: this.sessions.get(sessionId),
      generation: state.generation,
    };
  }

  canCommitSessionOwnership(
    sessionId: string,
    ownership: SessionOwnershipIdentity,
  ): boolean {
    return (
      !this.destroyed &&
      !this.closingSessions.has(sessionId) &&
      this.sessionOwnershipStates.get(sessionId)?.generation ===
        ownership.generation &&
      this.sessions.get(sessionId) === ownership.binding
    );
  }

  releaseSessionOwnershipIdentity(
    sessionId: string,
    ownership: SessionOwnershipIdentity,
  ): void {
    const state = this.sessionOwnershipStates.get(sessionId);
    if (!state || state.generation < ownership.generation) return;
    state.captures -= 1;
    if (state.captures === 0) {
      this.sessionOwnershipStates.delete(sessionId);
    }
  }

  getOrCreateSession(sessionId: string): SessionBinding {
    let binding = this.sessions.get(sessionId);
    if (!binding) {
      binding = {
        sessionId,
        abort: new AbortController(),
        buffer: [],
        ownedFrames: 0,
        ownedBytes: 0,
      };
      this.sessions.set(sessionId, binding);
    }
    return binding;
  }

  markInitialReplayPending(sessionId: string): void {
    this.getOrCreateSession(sessionId).initialReplayPending = true;
  }

  hasInitialReplayPending(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.initialReplayPending === true;
  }

  markInitialReplayComplete(sessionId: string): void {
    const binding = this.sessions.get(sessionId);
    if (binding) binding.initialReplayPending = false;
  }

  getDiagnostic(): AcpConnectionDiagnostic {
    const liveStreams = new Set<TransportStream>();
    if (this.connStream && !this.connStream.isClosed) {
      liveStreams.add(this.connStream);
    }
    let sessionStreams = 0;
    let bufferedSessionFrames = 0;
    let pendingDeliveryFrames = 0;
    for (const binding of this.sessions.values()) {
      bufferedSessionFrames += binding.buffer.length;
      pendingDeliveryFrames += binding.buffer.filter(
        (prepared) =>
          prepared.lease !== undefined &&
          prepared.deliveryAttempt !== undefined,
      ).length;
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
      pendingDeliveryFrames:
        pendingDeliveryFrames +
        [...this.pendingDeliveries].filter(
          (prepared) => prepared.lease !== undefined,
        ).length,
      preAttachOwnedFrames: this.ownedFrames,
      preAttachOwnedBytes: this.ownedBytes,
    };
  }

  /** Send a frame on the connection-scoped stream (buffer until it attaches). */
  sendConn(frame: unknown, receipt?: DeliveryReceipt): Promise<DeliveryResult> {
    const trackedReceipt = this.trackReceipt(receipt);
    return this.prepareAndBuffer(
      this.connBuffer,
      frame,
      undefined,
      undefined,
      trackedReceipt,
      undefined,
      true,
    );
  }

  /** True if any session currently has a live (open) SSE stream. */
  hasLiveSessionStream(): boolean {
    for (const b of this.sessions.values()) {
      if (b.stream && !b.stream.isClosed) return true;
    }
    return false;
  }

  /**
   * True if any session is mid-reconnect: its transport stream detached but
   * its `SESSION_GRACE_MS` reclaim window is still armed (`graceTimer` set),
   * so the binding — ownership + in-flight prompt — is being held open for an
   * imminent resume. The connection reaper must count these as activity:
   * otherwise, when the connection-scoped stream closes first and a session
   * stream detaches just after, the connection grace timer could delete the
   * whole connection (and `destroy()` abort the prompt) while the session is
   * still inside its OWN grace window — the reconnect would then 404.
   */
  hasRecoverableSession(): boolean {
    for (const b of this.sessions.values()) {
      if (b.graceTimer) return true;
    }
    return false;
  }

  /** Cancel a pending grace-period reap (e.g. on conn-stream reconnect). */
  clearGraceTimer(): void {
    if (this.connGraceTimer) {
      clearTimeout(this.connGraceTimer);
      this.connGraceTimer = undefined;
    }
    // A fresh grace window (or a reconnect that cancels one) starts clean — the
    // prior window's "already expired" verdict must not carry over.
    this.connGraceExpired = false;
  }

  /** Attach the connection-scoped stream and flush any buffered frames. */
  attachConnStream(stream: TransportStream): void {
    // A reconnect cancels any pending grace-period reap.
    this.clearGraceTimer();
    const previousStream = this.connStream;
    this.connStream = stream;
    // Move unresolved replies off the old stream before closing it. A queued
    // SSE write can otherwise resolve `closed` without ever reaching the wire.
    if (previousStream && previousStream !== stream) {
      if (!this.requeuePendingConnectionFrames(previousStream)) {
        previousStream.close();
        return;
      }
      previousStream.close();
    }
    for (const prepared of this.connBuffer.splice(0)) {
      this.deliverPrepared(stream, prepared);
    }
  }

  /**
   * Send a frame on a session-scoped stream (buffer until it attaches).
   * LOOKUP-ONLY: drops the frame when the session has no binding — a binding
   * always exists for a live session (created at `session/new`/`load`/
   * `resume`), so a missing one means the session was torn down. Auto-
   * creating here would resurrect a ghost binding (no stream, no owner) that
   * buffers up to 256 late pump/reply frames forever.
   */
  sendSession(
    sessionId: string,
    frame: unknown,
    id?: number,
  ): Promise<DeliveryResult> {
    const binding = this.sessions.get(sessionId);
    if (!binding) return Promise.resolve('closed');
    if (binding.stream && !binding.stream.isClosed) {
      return this.sendLive(binding.stream, frame, id, undefined, binding);
    }
    return this.prepareAndBuffer(
      binding.buffer,
      frame,
      id,
      undefined,
      undefined,
      binding,
    );
  }

  /**
   * Send an OUT-OF-BAND session JSON-RPC reply (a `session/prompt` result and
   * friends from `replySession`) — id-less on the wire (no ring cursor).
   *
   * Unlike `sendSession`, this defers the reply behind a watermark while a ring
   * replay is catching up. `anchorId` is the bus head id at the moment the reply
   * was produced (every content event that should precede the reply has id ≤
   * `anchorId`). The reply is held until the pump has DELIVERED through that id
   * (`releaseDeferredSessionReplies`), so a prompt that finishes during a slow
   * replay can't land ahead of tail content still queued behind `replay_complete`
   * (§1.8 W1 — the truncated-body reordering).
   *
   * It defers when EITHER a resume replay is in flight (`replayPending`) OR the
   * stream is detached OR replies are already queued ahead of it (`buffer` not
   * empty) — that last case keeps a just-produced reply from overtaking an
   * earlier one still waiting on its watermark. Once the buffer drains and replay
   * is done, replies go straight to the wire (steady state, unchanged from a
   * non-resumed stream).
   */
  sendSessionReply(
    sessionId: string,
    frame: unknown,
    anchorId?: number,
  ): Promise<DeliveryResult> {
    const binding = this.sessions.get(sessionId);
    if (!binding) return Promise.resolve('closed');
    return this.prepareAndBuffer(
      binding.buffer,
      frame,
      undefined,
      anchorId,
      undefined,
      binding,
      true,
    );
  }

  /**
   * Release deferred out-of-band replies (`sendSessionReply`) whose watermark
   * (`anchorId`) the pump has now passed: every leading id-less buffer entry
   * with `anchorId ≤ deliveredId` is flushed to the live stream, in order. The
   * pump calls this after delivering each content event (and at `replay_complete`
   * with the last replayed id), so each reply lands immediately AFTER the last
   * content event that preceded it — never ahead of tail content still queued.
   *
   * Stops at the first entry that is id-bearing (not a deferred reply) or whose
   * anchor is still ahead of `deliveredId`, preserving stream order. No-op if the
   * stream isn't live (the entries stay buffered for the next attach).
   */
  releaseDeferredSessionReplies(sessionId: string, deliveredId: number): void {
    const binding = this.sessions.get(sessionId);
    if (!binding || !binding.stream || binding.stream.isClosed) return;
    while (binding.buffer.length > 0) {
      const front = binding.buffer[0];
      // Only id-less deferred replies are watermark-gated; anything else (a
      // stray id-bearing frame) marks the end of the releasable prefix.
      if (front.id !== undefined) break;
      if (front.anchorId === undefined) {
        // No watermark (rare: the bus head was unreadable when the reply was
        // produced — a session-teardown race). It can't be sequenced against a
        // content id, so hold it until the replay boundary passes
        // (`endReplayDeferral` clears `replayPending`, then this releases it).
        // Releasing mid-replay could land it ahead of not-yet-sent content.
        if (binding.replayPending) break;
      } else if (front.anchorId > deliveredId) {
        break;
      }
      binding.buffer.shift();
      this.deliverPrepared(binding.stream, front);
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
    resumeFromEventId?: number,
  ): SessionBinding {
    const binding = this.getOrCreateSession(sessionId);
    // Reclaim: a reconnect within the grace window cancels the pending
    // teardown so ownership/prompt survive the transport-level blip. Log it so
    // an operator can tell "reclaimed within grace" apart from a first attach
    // (the detach + grace-expiry paths already log; this completes the trail).
    if (binding.graceTimer) {
      clearTimeout(binding.graceTimer);
      binding.graceTimer = undefined;
      writeStderrLine(
        `qwen serve: /acp session reclaimed within grace (${logSafe(sessionId)})`,
      );
    }
    const prevStream = binding.stream;
    binding.abort.abort();
    binding.abort = abort;
    // Install the NEW stream BEFORE closing the old one. Each stream's event
    // pump has its OWN abort controller, and the post-pump teardown in the
    // session-GET handler (`index.ts` `onPumpSettled`) is identity-guarded on
    // `binding.stream`: a settling stream only acts if it is STILL the bound
    // stream (`conn.sessions.get(sessionId)?.stream === stream`). Installing
    // first means the old stream settles against a binding that already points
    // at the new stream, so it falls into detach-with-grace instead of tearing
    // down the in-flight prompt — the client is reconnecting, not leaving, and
    // the prompt must survive. CONTRACT: that identity guard and this ordering
    // must stay in lockstep.
    binding.stream = stream;
    binding.usesConnectionStream = stream === this.connStream;
    if (prevStream && prevStream !== stream && prevStream !== this.connStream) {
      if (!this.requeuePendingSessionReplies(binding, prevStream)) {
        prevStream.close();
        return binding;
      }
      prevStream.close();
    }
    // Flush buffered pre-attach frames produced during the detach gap.
    //
    // FRESH CONNECT (`resumeFromEventId === undefined`, no `Last-Event-ID`):
    // there's no ring replay, so the buffer is the only delivery path — flush
    // everything now, in order.
    //
    // REPLAYING ATTACH (Last-Event-ID resume or response-mode load's initial
    // replay): the event pump redelivers sequenced BUS events (`id !==
    // undefined`) from the replay source, so we do NOT flush id-bearing frames
    // here (flushing would double-deliver, and advancing a cursor past them to
    // dedupe would silently drop an in-flight-lost frame whose id sits below
    // the buffer's ids).
    //
    // Id-LESS frames are JSON-RPC replies (`replySession`), NOT ring events, so
    // the replay won't redeliver them. But flushing them HERE — before replay —
    // would deliver e.g. a `session/prompt` result BEFORE the pump replays the
    // content chunks that preceded it, so the client would see "prompt complete"
    // ahead of the body (the exact truncated-body failure §1.8 fixes). So on
    // resume we DEFER id-less frames: leave them in the buffer for the pump to
    // flush after `replay_complete` (`flushBufferedSessionFrames`), preserving
    // original stream order.
    // Set the deferral flag from the CURRENT attach mode every time — never a
    // one-way latch. Resume arms it (keep deferring out-of-band replies until
    // the replay boundary passes — not just the ones already buffered from the
    // detach gap, but any prompt that finishes DURING the replay window). A
    // fresh connect CLEARS it: the prior resumptive attach may have been aborted
    // before its pump reached `replay_complete` (the normal reclaim path skips
    // the flush), which would otherwise leave the flag stuck true and buffer
    // every later `sendSessionReply` — including `session/prompt` results —
    // behind a replay boundary this live-only subscription will never emit.
    const replayingOnAttach =
      resumeFromEventId !== undefined || binding.initialReplayPending === true;
    binding.replayPending = replayingOnAttach;
    if (binding.replayPending) {
      // Breadcrumb: while armed, `sendSessionReply` defers every out-of-band
      // reply (e.g. `session/prompt` results) until the pump delivers
      // `replay_complete`. If that sentinel never arrives — a dropped frame or
      // a pump error — the replies stay buffered indefinitely with no other
      // trace. Logging the arm gives operators a starting point when responses
      // look stuck behind the replay window.
      writeStderrLine(
        `qwen serve: /acp replay deferral armed (${logSafe(sessionId)}, from id ${resumeFromEventId ?? 'initial'})`,
      );
    }
    // Drain the gap buffer into a separate array first: on the resume path the
    // loop pushes id-less entries BACK into `binding.buffer`, so iterating the
    // live buffer would be re-entrant. `splice(0)` snapshots + clears in one
    // step; the explicit local makes the copy-semantics invariant visible.
    const gap = binding.buffer.splice(0);
    for (const entry of gap) {
      if (!replayingOnAttach) {
        this.deliverPrepared(stream, entry); // fresh connect: flush all now
      } else if (entry.id !== undefined) {
        // Resume: ring replay owns bus events, so drop the buffered copy to
        // avoid double-delivery (the same id arrives via replay). This branch is
        // near-vacuous on the resume path: id-bearing frames are buffered ONLY
        // by `sendSession` from the event pump, which is aborted the moment the
        // stream detaches — so during the detach gap that precedes a resume the
        // buffer accumulates only id-LESS out-of-band replies. Even the rare
        // race (an in-flight `translateEvent` buffering one id-bearing frame
        // just after detach) is covered: that id is still in the ring and the
        // replay redelivers it. The only residual loss needs that frame to ALSO
        // be ring-evicted before reconnect, which the replay signals to the
        // client as `state_resync_required` (not a silent gap) — strictly better
        // than the pre-resume live-only behaviour, which lost every gap frame.
        this.settlePrepared(entry, 'closed');
        continue;
      } else {
        binding.buffer.push(entry); // resume: defer id-less past replay
      }
    }
    return binding;
  }

  /**
   * The ring replay drained (`replay_complete`): stop deferring NEW replies that
   * are anchored within the replayed range, and release every buffered reply
   * whose watermark the replay already passed (`anchorId ≤ lastReplayedId`).
   *
   * Replies anchored ABOVE the replayed range stay buffered — their content
   * hasn't been delivered yet because the turn was still running at reconnect
   * (the content flows as LIVE events after `replay_complete`). The per-event
   * `releaseDeferredSessionReplies` calls drain those as the matching live
   * content arrives, so a result produced during a slow replay still lands after
   * its tail content (§1.8 W1), not at the boundary.
   */
  endReplayDeferral(
    sessionId: string,
    lastReplayedId: number,
    evictionOccurred = false,
  ): void {
    const binding = this.sessions.get(sessionId);
    if (!binding) return;
    // Replay boundary passed → new replies are no longer gated by the replay
    // window itself (they may still defer behind a non-empty buffer).
    binding.replayPending = false;
    if (evictionOccurred) {
      // The replay emitted a `state_resync_required` (ring eviction / epoch
      // reset): anchor events may have been dropped from the ring and will
      // NEVER be delivered. A watermark-gated release would then leave any
      // reply anchored above the surviving range deferred forever — and because
      // `sendSessionReply` gates inline delivery on an EMPTY buffer, every later
      // reply piles up behind it too (a cascading freeze: agent runs, heartbeats
      // flow, but no result ever reaches the client). With the ordering
      // guarantee already void after an eviction, release everything now — an
      // ordering imperfection beats a permanently frozen session.
      this.flushBufferedSessionFrames(sessionId);
      return;
    }
    this.releaseDeferredSessionReplies(sessionId, lastReplayedId);
  }

  /**
   * Final, UNCONDITIONAL flush of everything still buffered — used when the pump
   * ends with no more events coming (clean iterator end / live-only subscription
   * with no replay boundary). Releases any remaining deferred replies regardless
   * of watermark: their anchored content will never arrive, so holding them
   * would strand the result forever.
   *
   * No-op if the session has no live stream (frames stay buffered for the next
   * attach) — but `replayPending` is cleared regardless, since no replay is in
   * flight once the pump has settled.
   *
   * The frames are enqueued synchronously, in buffer order: `SseStream`
   * serializes every `send` through one `writeChain`, so wire order is fixed by
   * call order here. We deliberately do NOT `await` each `send` between `shift`s
   * — doing so would open a window where a live event arriving mid-drain enqueues
   * BETWEEN two deferred frames, reordering the very replies this deferral exists
   * to keep in order (§1.8 W1).
   */
  flushBufferedSessionFrames(sessionId: string): void {
    const binding = this.sessions.get(sessionId);
    if (!binding) return;
    // Pump settled → no replay in flight; stop deferring out-of-band replies.
    binding.replayPending = false;
    if (
      !binding.stream ||
      binding.stream.isClosed ||
      binding.buffer.length === 0
    )
      return;
    for (const prepared of binding.buffer.splice(0)) {
      this.deliverPrepared(binding.stream, prepared);
    }
  }

  /**
   * Transport-level session-stream close (proxy idle-close / network blip) —
   * as opposed to an explicit `session/close`. Detaches ONLY the stream and
   * its event subscription while KEEPING the binding, ownership, the in-flight
   * prompt, and the bridge-client registration, so a reconnect within
   * `graceMs` can resume (ring replay backfills the gap — §1.8). If no
   * reconnect arrives, the grace timer runs the full `closeSessionStream`
   * teardown, bounding the runaway-prompt cost. Identity-guarded: a stale
   * stream's close can't detach a newer reconnect's stream.
   */
  detachSessionStream(
    sessionId: string,
    stream: TransportStream,
    graceMs: number,
  ): void {
    const binding = this.sessions.get(sessionId);
    if (!binding || binding.stream !== stream) return;
    // Breadcrumb at the moment of detach so an operator can measure the actual
    // disconnect→reconnect gap against the grace window (the reclaim/expiry
    // logs alone can't tell "reclaimed with 0.5s to spare" from "9.5s").
    writeStderrLine(
      `qwen serve: /acp session stream detached (${logSafe(sessionId)}), ` +
        `grace=${graceMs}ms`,
    );
    // Stop the closing stream's event pump; the prompt + ownership live on.
    binding.abort.abort();
    // Drop the stream ref so frames produced during the gap buffer until the
    // reconnect re-attaches and flushes them.
    binding.stream = undefined;
    if (binding.graceTimer) clearTimeout(binding.graceTimer);
    binding.graceTimer = setTimeout(() => {
      // Grace expired with no reconnect → full teardown (aborts the prompt,
      // releases ownership, detaches the bridge client). Log it so an operator
      // debugging a vanished session can tell grace-expiry teardown apart from
      // an explicit `session/close` or connection drop.
      writeStderrLine(
        `qwen serve: /acp session grace expired (${logSafe(sessionId)}), ` +
          `no reconnect within ${graceMs}ms — tearing down`,
      );
      // `closeSessionStream` → `teardownBinding` runs external callbacks
      // (`abandonPendingForSession`, `onDetachSession`) that can throw. This
      // runs from a bare `setTimeout`, so an uncaught throw would crash the
      // whole daemon process (taking down every other session). `destroy()`
      // guards `teardownBinding` for the same reason; mirror it here.
      try {
        this.closeSessionStream(sessionId);
      } catch (err) {
        writeStderrLine(
          `qwen serve: /acp teardown failed during grace expiry ` +
            `(${logSafe(sessionId)}): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      // Grace expiry may have removed the last recoverable session that was
      // blocking a pending connection reap; let the owner re-check. Guard it in
      // its OWN try/catch (separate from the teardown above, so it runs even if
      // teardown threw): this callback is owner-supplied and still runs from the
      // bare `setTimeout`, so an uncaught throw here would equally crash the
      // daemon.
      try {
        this.onSessionGraceExpired?.();
      } catch (err) {
        writeStderrLine(
          `qwen serve: /acp onSessionGraceExpired failed during grace expiry ` +
            `(${logSafe(sessionId)}): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }, graceMs);
    binding.graceTimer.unref?.();
  }

  closeSessionStream(sessionId: string): void {
    const binding = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    this.ownedSessions.delete(sessionId);
    const ownershipState = this.sessionOwnershipStates.get(sessionId);
    if (ownershipState) {
      ownershipState.generation += 1;
      if (ownershipState.captures === 0) {
        this.sessionOwnershipStates.delete(sessionId);
      }
    }
    if (!binding) return;
    this.teardownBinding(binding);
  }

  destroy(reason?: TransportCloseReason): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abortController.abort();
    this.clearGraceTimer();
    const bindings = [...this.sessions.values()];
    this.sessions.clear();
    this.ownedSessions.clear();
    for (const prepared of this.connBuffer.splice(0)) {
      this.discardPrepared(prepared);
    }
    this.connStream?.close(reason);
    setImmediate(() => {
      for (const prepared of this.pendingDeliveries) {
        this.discardPreparedReceipt(prepared);
      }
      for (const receipt of [...this.pendingReceipts]) receipt.discarded();
    });
    for (const binding of bindings) {
      try {
        this.teardownBinding(binding);
      } catch (err) {
        writeStderrLine(
          `qwen serve: /acp teardownBinding(${logSafe(binding.sessionId)}) failed during destroy: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.sessionOwnershipStates.clear();
    this.pending.clear();
  }

  private teardownBinding(binding: SessionBinding): void {
    if (binding.graceTimer) {
      clearTimeout(binding.graceTimer);
      binding.graceTimer = undefined;
    }
    for (const prepared of binding.buffer.splice(0)) {
      this.discardPrepared(prepared);
    }
    for (const prepared of this.pendingDeliveries) {
      if (prepared.binding === binding) {
        this.discardPreparedReceipt(prepared);
      }
    }
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

  private sendLive(
    stream: TransportStream,
    frame: unknown,
    id?: number,
    receipt?: DeliveryReceipt,
    binding?: SessionBinding,
  ): Promise<DeliveryResult> {
    let payload: Buffer;
    try {
      const serialized = JSON.stringify(frame);
      if (serialized === undefined) throw new Error('not serializable');
      payload = Buffer.from(serialized, 'utf8');
    } catch {
      receipt?.discarded();
      if (!this.isCurrentStreamOwner(stream, binding)) {
        return Promise.resolve('closed');
      }
      this.failSerializationOwner(binding);
      return Promise.resolve('failed');
    }
    if (!this.isCurrentStreamOwner(stream, binding)) {
      receipt?.discarded();
      return Promise.resolve('closed');
    }
    const result = stream.sendSerialized(payload, id);
    this.observeLiveReceipt(result, receipt);
    return result;
  }

  private isCurrentStreamOwner(
    stream: TransportStream,
    binding: SessionBinding | undefined,
  ): boolean {
    if (this.destroyed || stream.isClosed) return false;
    return binding
      ? this.sessions.get(binding.sessionId) === binding &&
          binding.stream === stream
      : this.connStream === stream;
  }

  private prepareAndBuffer(
    buffer: PreparedFrame[],
    frame: unknown,
    id: number | undefined,
    anchorId: number | undefined,
    receipt: DeliveryReceipt | undefined,
    binding: SessionBinding | undefined,
    requeueOnStreamReplacement = false,
  ): Promise<DeliveryResult> {
    if (this.destroyed) {
      receipt?.discarded();
      return Promise.resolve('closed');
    }
    const expectedStream = binding ? binding.stream : this.connStream;
    if (
      (binding ? binding.ownedFrames : this.connOwnedFrames) >=
      ACP_PRE_ATTACH_MAX_FRAMES_PER_STREAM
    ) {
      receipt?.discarded();
      this.failOwner(binding, 'ACP pre-attach frame limit');
      return Promise.resolve('failed');
    }
    let payload: Buffer;
    try {
      const serialized = JSON.stringify(frame);
      if (serialized === undefined) throw new Error('not serializable');
      payload = Buffer.from(serialized, 'utf8');
    } catch {
      receipt?.discarded();
      if (
        this.destroyed ||
        (binding ? binding.stream : this.connStream) !== expectedStream ||
        (binding !== undefined &&
          this.sessions.get(binding.sessionId) !== binding)
      ) {
        return Promise.resolve('closed');
      }
      this.failSerializationOwner(binding);
      return Promise.resolve('failed');
    }
    if (
      this.destroyed ||
      (binding ? binding.stream : this.connStream) !== expectedStream ||
      (binding !== undefined &&
        this.sessions.get(binding.sessionId) !== binding)
    ) {
      receipt?.discarded();
      return Promise.resolve('closed');
    }
    if (
      (binding ? binding.ownedFrames : this.connOwnedFrames) >=
      ACP_PRE_ATTACH_MAX_FRAMES_PER_STREAM
    ) {
      receipt?.discarded();
      this.failOwner(binding, 'ACP pre-attach frame limit');
      return Promise.resolve('failed');
    }
    const liveStream = expectedStream;
    const deliveryDeferred = binding?.replayPending === true;
    const deliverImmediately =
      buffer.length === 0 &&
      liveStream &&
      !liveStream.isClosed &&
      !deliveryDeferred;
    if (deliverImmediately && !requeueOnStreamReplacement) {
      return this.sendSerializedLive(liveStream, payload, id, receipt);
    }
    let lease: AcpPreAttachLease | undefined;
    if (!deliverImmediately) {
      if (
        this.ownedFrames >= this.maxFramesPerConnection ||
        payload.byteLength > this.maxPayloadBytesPerConnection - this.ownedBytes
      ) {
        receipt?.discarded();
        this.failConnection('ACP pre-attach connection budget');
        return Promise.resolve('failed');
      }
      lease = this.preAttachBudget.tryReserve(payload.byteLength);
      if (!lease) {
        receipt?.discarded();
        this.failConnection('ACP pre-attach daemon budget', false);
        return Promise.resolve('failed');
      }
    }
    let resolve!: (result: DeliveryResult) => void;
    const result = new Promise<DeliveryResult>((accept) => {
      resolve = accept;
    });
    const prepared: PreparedFrame = {
      payload,
      sequence: this.nextPreparedSequence++,
      id,
      anchorId,
      receipt,
      lease,
      binding,
      requeueOnStreamReplacement,
      resolve,
    };
    if (deliverImmediately) {
      this.deliverPrepared(liveStream, prepared);
      return result;
    }
    buffer.push(prepared);
    this.ownedFrames += 1;
    this.ownedBytes += payload.byteLength;
    if (binding) {
      binding.ownedFrames += 1;
      binding.ownedBytes += payload.byteLength;
    } else {
      this.connOwnedFrames += 1;
    }
    return result;
  }

  private sendSerializedLive(
    stream: TransportStream,
    payload: Buffer,
    id: number | undefined,
    receipt: DeliveryReceipt | undefined,
  ): Promise<DeliveryResult> {
    const result = stream.sendSerialized(payload, id);
    this.observeLiveReceipt(result, receipt);
    return result;
  }

  private observeLiveReceipt(
    result: Promise<DeliveryResult>,
    receipt: DeliveryReceipt | undefined,
  ): void {
    void result.then(
      (outcome) => {
        if (outcome === 'delivered') receipt?.delivered();
        else if (outcome === 'outcome_unknown') receipt?.outcomeUnknown?.();
        else receipt?.discarded();
      },
      () => receipt?.discarded(),
    );
  }

  private trackReceipt(
    receipt: DeliveryReceipt | undefined,
  ): DeliveryReceipt | undefined {
    if (!receipt) return undefined;
    let settled = false;
    const tracked: DeliveryReceipt = {
      delivered: () => {
        if (settled) return;
        settled = true;
        this.pendingReceipts.delete(tracked);
        this.invokeReceipt(receipt, 'delivered');
      },
      discarded: () => {
        if (settled) return;
        settled = true;
        this.pendingReceipts.delete(tracked);
        this.invokeReceipt(receipt, 'discarded');
      },
      outcomeUnknown: () => {
        if (settled) return;
        settled = true;
        this.pendingReceipts.delete(tracked);
        this.invokeReceipt(receipt, 'outcomeUnknown');
      },
    };
    this.pendingReceipts.add(tracked);
    return tracked;
  }

  private deliverPrepared(
    stream: TransportStream,
    prepared: PreparedFrame,
  ): void {
    const attempt = (prepared.deliveryAttempt ?? 0) + 1;
    prepared.deliveryAttempt = attempt;
    prepared.deliveryStream = stream;
    prepared.lease?.markPendingDelivery();
    this.pendingDeliveries.add(prepared);
    void stream.sendSerialized(prepared.payload, prepared.id).then(
      (outcome) => this.settlePreparedAttempt(prepared, attempt, outcome),
      () => this.settlePreparedAttempt(prepared, attempt, 'failed'),
    );
  }

  private requeuePendingSessionReplies(
    binding: SessionBinding,
    previousStream: TransportStream,
  ): boolean {
    // These replies have no SSE event id and are absent from ring replay. Use
    // at-least-once handoff: a duplicate JSON-RPC response is identifiable by
    // its request id, while dropping the only response hangs the caller.
    const requeued = [...this.pendingDeliveries].filter(
      (prepared) =>
        prepared.binding === binding &&
        prepared.deliveryStream === previousStream &&
        prepared.requeueOnStreamReplacement,
    );
    for (const prepared of requeued) {
      if (!this.reservePreparedForBuffer(prepared, binding)) return false;
    }
    for (const prepared of requeued) {
      if (
        prepared.binding !== binding ||
        prepared.deliveryStream !== previousStream ||
        !prepared.requeueOnStreamReplacement
      ) {
        continue;
      }
      prepared.deliveryAttempt = (prepared.deliveryAttempt ?? 0) + 1;
      prepared.deliveryStream = undefined;
      this.pendingDeliveries.delete(prepared);
      this.insertPrepared(binding.buffer, prepared);
    }
    return true;
  }

  private requeuePendingConnectionFrames(
    previousStream: TransportStream,
  ): boolean {
    const requeued = [...this.pendingDeliveries].filter(
      (prepared) =>
        prepared.binding === undefined &&
        prepared.deliveryStream === previousStream &&
        prepared.requeueOnStreamReplacement,
    );
    for (const prepared of requeued) {
      if (!this.reservePreparedForBuffer(prepared)) return false;
    }
    for (const prepared of requeued) {
      if (
        prepared.binding !== undefined ||
        prepared.deliveryStream !== previousStream ||
        !prepared.requeueOnStreamReplacement
      ) {
        continue;
      }
      prepared.deliveryAttempt = (prepared.deliveryAttempt ?? 0) + 1;
      prepared.deliveryStream = undefined;
      this.pendingDeliveries.delete(prepared);
      this.insertPrepared(this.connBuffer, prepared);
    }
    return true;
  }

  private settlePreparedAttempt(
    prepared: PreparedFrame,
    attempt: number,
    outcome: DeliveryResult,
  ): void {
    if (prepared.deliveryAttempt !== attempt) return;
    const binding = prepared.binding;
    const stream = prepared.deliveryStream;
    if (
      outcome === 'closed' &&
      prepared.requeueOnStreamReplacement &&
      !binding &&
      stream &&
      stream.isClosed &&
      !this.destroyed &&
      this.connStream === stream
    ) {
      if (!this.reservePreparedForBuffer(prepared)) return;
      prepared.deliveryAttempt = attempt + 1;
      prepared.deliveryStream = undefined;
      this.pendingDeliveries.delete(prepared);
      this.insertPrepared(this.connBuffer, prepared);
      return;
    }
    if (
      outcome !== 'delivered' &&
      prepared.requeueOnStreamReplacement &&
      binding &&
      stream &&
      stream !== this.connStream &&
      stream.isClosed &&
      !this.destroyed &&
      this.sessions.get(binding.sessionId) === binding &&
      (binding.stream === stream || binding.stream === undefined)
    ) {
      if (!this.reservePreparedForBuffer(prepared, binding)) return;
      prepared.deliveryAttempt = attempt + 1;
      prepared.deliveryStream = undefined;
      this.pendingDeliveries.delete(prepared);
      this.insertPrepared(binding.buffer, prepared);
      return;
    }
    prepared.deliveryStream = undefined;
    this.settlePrepared(prepared, outcome);
  }

  private reservePreparedForBuffer(
    prepared: PreparedFrame,
    binding?: SessionBinding,
  ): boolean {
    if (prepared.lease) return true;
    if (
      (binding ? binding.ownedFrames : this.connOwnedFrames) >=
      ACP_PRE_ATTACH_MAX_FRAMES_PER_STREAM
    ) {
      this.settlePrepared(prepared, 'failed');
      this.failOwner(binding, 'ACP pre-attach frame limit');
      return false;
    }
    if (
      this.ownedFrames >= this.maxFramesPerConnection ||
      prepared.payload.byteLength >
        this.maxPayloadBytesPerConnection - this.ownedBytes
    ) {
      this.settlePrepared(prepared, 'failed');
      this.failConnection('ACP pre-attach connection budget');
      return false;
    }
    const lease = this.preAttachBudget.tryReserve(prepared.payload.byteLength);
    if (!lease) {
      this.settlePrepared(prepared, 'failed');
      this.failConnection('ACP pre-attach daemon budget', false);
      return false;
    }
    lease.markPendingDelivery();
    prepared.lease = lease;
    this.ownedFrames += 1;
    this.ownedBytes += prepared.payload.byteLength;
    if (binding) {
      binding.ownedFrames += 1;
      binding.ownedBytes += prepared.payload.byteLength;
    } else {
      this.connOwnedFrames += 1;
    }
    return true;
  }

  private insertPrepared(
    buffer: PreparedFrame[],
    prepared: PreparedFrame,
  ): void {
    const index = buffer.findIndex(
      (buffered) => buffered.sequence > prepared.sequence,
    );
    if (index === -1) buffer.push(prepared);
    else buffer.splice(index, 0, prepared);
  }

  private discardPrepared(prepared: PreparedFrame): void {
    this.discardPreparedReceipt(prepared);
    if (!this.pendingDeliveries.has(prepared)) {
      this.settlePrepared(prepared, 'closed');
    }
  }

  private settlePrepared(
    prepared: PreparedFrame,
    outcome: DeliveryResult,
  ): void {
    const lease = prepared.lease;
    lease?.release();
    prepared.lease = undefined;
    this.pendingDeliveries.delete(prepared);
    if (lease) {
      this.ownedFrames -= 1;
      this.ownedBytes -= prepared.payload.byteLength;
      if (prepared.binding) {
        prepared.binding.ownedFrames -= 1;
        prepared.binding.ownedBytes -= prepared.payload.byteLength;
      } else {
        this.connOwnedFrames -= 1;
      }
    }
    if (!prepared.receiptSettled) {
      prepared.receiptSettled = true;
      if (prepared.receipt) {
        this.invokeReceipt(
          prepared.receipt,
          outcome === 'delivered'
            ? 'delivered'
            : outcome === 'outcome_unknown'
              ? 'outcomeUnknown'
              : 'discarded',
        );
      }
    }
    prepared.resolve(outcome);
  }

  private discardPreparedReceipt(prepared: PreparedFrame): void {
    if (prepared.receiptSettled) return;
    prepared.receiptSettled = true;
    if (prepared.receipt) this.invokeReceipt(prepared.receipt, 'discarded');
  }

  private invokeReceipt(
    receipt: DeliveryReceipt,
    outcome: 'delivered' | 'discarded' | 'outcomeUnknown',
  ): void {
    try {
      if (outcome === 'outcomeUnknown') {
        (receipt.outcomeUnknown ?? receipt.delivered)();
      } else {
        receipt[outcome]();
      }
    } catch {
      writeStderrLine(`qwen serve: /acp ${outcome} receipt callback failed`);
    }
  }

  private failOwner(
    binding: SessionBinding | undefined,
    message: string,
  ): void {
    this.preAttachBudget.recordGuardFailure();
    this.onPreAttachGuardFailure?.();
    writeStderrLine(`qwen serve: /acp resource guard: ${message}`);
    if (
      !binding ||
      binding.usesConnectionStream === true ||
      (binding.usesConnectionStream === undefined &&
        binding.stream === undefined &&
        this.connStream?.kind === 'ws')
    ) {
      this.retireConnection(message);
      return;
    }
    try {
      this.closeSessionStream(binding.sessionId);
    } catch (error) {
      writeStderrLine(
        `qwen serve: /acp resource guard session teardown failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private failSerializationOwner(binding: SessionBinding | undefined): void {
    writeStderrLine('qwen serve: /acp response serialization failed');
    if (binding) this.failOwner(binding, 'ACP response serialization failed');
  }

  private failConnection(message: string, recordFailure = true): void {
    if (recordFailure) this.preAttachBudget.recordGuardFailure();
    this.onPreAttachGuardFailure?.();
    writeStderrLine(`qwen serve: /acp resource guard: ${message}`);
    this.retireConnection(message);
  }

  private retireConnection(_message: string): void {
    const reason = { code: 1013, reason: 'Resource limit' };
    if (this.onFatalConnection) this.onFatalConnection(this, reason);
    else this.destroy(reason);
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

/**
 * Registry of live ACP connections with an idle-TTL sweep. The sweep is
 * defensive: a well-behaved client `DELETE /acp`s, but a crashed client
 * that never closes its streams would otherwise leak connection state.
 */
export class ConnectionRegistry {
  private readonly byId = new Map<string, AcpConnection>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private preAttachGuardFailures = 0;

  constructor(
    private readonly onAbandonPending?: AbandonPendingFn,
    private readonly onDetachSession?: DetachSessionFn,
    private readonly maxConnections = DEFAULT_MAX_CONNECTIONS,
    private readonly idleTtlMs = 30 * 60_000,
    private readonly preAttachBudget = new AcpPreAttachBudget(),
    private readonly maxFramesPerConnection = ACP_PRE_ATTACH_MAX_FRAMES_PER_CONNECTION,
    private readonly maxPayloadBytesPerConnection = ACP_PRE_ATTACH_MAX_PAYLOAD_BYTES_PER_CONNECTION,
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
      this.preAttachBudget,
      (failed, reason) => this.deleteExact(failed, reason),
      this.maxFramesPerConnection,
      this.maxPayloadBytesPerConnection,
      () => {
        this.preAttachGuardFailures += 1;
      },
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

  findPendingClientRequest(id: string): PendingClientRequestRef | undefined {
    // Fast path: server-minted ids embed their originating connection
    // (`_qwen_perm_<connectionId>_<counter>`, connectionId is a hyphenated
    // `randomUUID()` with no underscores), so the owning connection is the
    // substring before the last `_` — an O(1) lookup instead of scanning all
    // connections on every client response.
    if (id.startsWith('_qwen_perm_')) {
      const body = id.slice('_qwen_perm_'.length);
      const lastUnderscore = body.lastIndexOf('_');
      if (lastUnderscore > 0) {
        const conn = this.byId.get(body.slice(0, lastUnderscore));
        const req = conn?.pending.get(id);
        if (conn && req) return { conn, id, req };
      }
    }
    // Fallback for client-chosen ids that don't match the server format.
    for (const conn of this.byId.values()) {
      const req = conn.pending.get(id);
      if (req) return { conn, id, req };
    }
    return undefined;
  }

  /**
   * Locate a pending permission entry matching `requestId` (a bridge
   * `bridgeRequestId`, i.e. a per-request `randomUUID()`) and optionally
   * `sessionId`, returning the first match.
   *
   * NOTE: `requestId` is unique per *request*, not per *pending entry*. The
   * per-entry unique id is the `conn.pending` map key
   * (`_qwen_perm_<connectionId>_N`), which is NOT what is matched here. A
   * `permission_request` is delivered to every live subscriber of its session,
   * so when connections co-own a session (multi-client attach) each mints its
   * own entry sharing the same `bridgeRequestId`. More than one entry can
   * therefore match, so this is a *read-only locator* for deriving a session /
   * ownership from a wire `requestId`. To DELETE a resolved entry, act on the
   * specific `conn`/map-key the caller already holds (see
   * `AcpDispatcher.dropOwnPendingPermission`) — never delete by re-matching
   * here, which could hit a sibling co-owner's entry.
   */
  findPendingPermission(
    requestId: string,
    sessionId?: string,
  ): PendingClientRequestRef | undefined {
    for (const conn of this.byId.values()) {
      for (const [id, req] of conn.pending) {
        if (
          req.kind === 'permission' &&
          req.bridgeRequestId === requestId &&
          (sessionId === undefined || req.sessionId === sessionId)
        ) {
          return { conn, id, req };
        }
      }
    }
    return undefined;
  }

  delete(connectionId: string): boolean {
    const conn = this.byId.get(connectionId);
    if (!conn) return false;
    return this.deleteExact(conn);
  }

  private deleteExact(
    conn: AcpConnection,
    reason?: TransportCloseReason,
  ): boolean {
    if (this.byId.get(conn.connectionId) !== conn) return false;
    this.byId.delete(conn.connectionId);
    conn.destroy(reason);
    return true;
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
      bufferedConnectionFrames: sumBy(
        connections,
        (conn) => conn.bufferedConnectionFrames,
      ),
      bufferedSessionFrames: sumBy(
        connections,
        (conn) => conn.bufferedSessionFrames,
      ),
      pendingDeliveryFrames: sumBy(
        connections,
        (conn) => conn.pendingDeliveryFrames,
      ),
      preAttachOwnedFrames: sumBy(
        connections,
        (conn) => conn.preAttachOwnedFrames,
      ),
      preAttachOwnedBytes: sumBy(
        connections,
        (conn) => conn.preAttachOwnedBytes,
      ),
      preAttachGuardFailures: this.preAttachGuardFailures,
      connections,
    };
  }

  clear(): void {
    for (const id of [...this.byId.keys()]) this.delete(id);
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    this.clear();
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
