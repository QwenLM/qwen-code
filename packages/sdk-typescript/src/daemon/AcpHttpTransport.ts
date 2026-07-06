/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonEvent } from './types.js';
import type {
  DaemonTransport,
  DaemonTransportFetchOptions,
  DaemonTransportSubscribeOptions,
} from './DaemonTransport.js';
import { DaemonTransportClosedError } from './DaemonTransport.js';
import { consumeFrames } from './sse.js';
import {
  denormalizeAcpNotification,
  type JsonRpcNotification,
} from './AcpEventDenormalizer.js';
import {
  matchRoute,
  synthesizeResponse,
  jsonRpcErrorToHttpStatusWithData,
  isRecord,
  composeAbortSignals,
  mergeHeaders,
} from './acpTransportUtils.js';

/**
 * Cap the unread SSE buffer of the session-stream parser. Mirrors
 * `parseSseStream`'s `MAX_BUF_CHARS` — an unbounded buffer is a memory-pressure
 * vector (a tab crash for browser consumers) if a server/proxy never emits a
 * frame boundary or serves a non-SSE body.
 */
const MAX_SSE_BUF_CHARS = 16 * 1024 * 1024;

/**
 * ACP methods whose JSON-RPC reply the daemon routes onto the SESSION stream
 * (`replySession`) rather than the connection stream — every other request
 * replies on the connection stream the transport already pumps. For these, a
 * `sendRequest` made without an active `subscribeEvents` consumer must open a
 * background session-reply pump or it would hang. All require an already-owned
 * session, so the pump's `GET /acp` is always authorized.
 *
 * INVARIANT: this set must mirror the `replySession` call sites in the daemon
 * dispatcher at `packages/cli/src/serve/acp-http/dispatch.ts`. That file lives
 * in a different package the SDK doesn't import, so the coupling can't be
 * type-checked. If a future PR adds a `replySession(...)` for a new method
 * without adding it here, a no-subscriber `sendRequest` for that method opens
 * no reply pump and HANGS until abort; removing one here that the daemon still
 * routes to the session stream has the same effect. A build-time grep check or
 * a shared method-name constant would enforce this mechanically — tracked as a
 * follow-up (out of this PR's scope).
 */
const SESSION_STREAM_REPLY_METHODS = new Set<string>([
  'session/prompt',
  'session/cancel',
  'session/set_config_option',
  'session/set_mode',
  'session/set_model',
]);

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ---------------------------------------------------------------------------
// Pending request tracking
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  /**
   * Routing scope. `undefined` ⇒ the reply rides the CONNECTION stream;
   * a sessionId ⇒ it rides that SESSION stream (the daemon routes a handful of
   * `session/*` method replies there — see `SESSION_STREAM_REPLY_METHODS`). The
   * two stream pumps share this one map but must only sweep THEIR OWN scope on
   * failure: a connection-stream error must not reject a session-scoped pending
   * the session stream is about to resolve, and vice-versa.
   */
  sessionId?: string;
}

/**
 * Map a `session/request_permission` JSON-RPC request (as the daemon sends it
 * on the session-scoped `/acp` stream) to a `permission_request` DaemonEvent,
 * mirroring what the REST surface emits so consumers handle it identically.
 * The agent-stamped `requestId` (in `_meta.qwen.requestId`) is the correlator
 * the eventual vote must echo (§1.7). Returns `undefined` if it can't be read.
 */
function permissionRequestToEvent(
  msg: Record<string, unknown>,
  busId: number | undefined,
): DaemonEvent | undefined {
  const params = isRecord(msg['params']) ? msg['params'] : {};
  const meta = isRecord(params['_meta']) ? params['_meta'] : undefined;
  const qwenMeta = meta && isRecord(meta['qwen']) ? meta['qwen'] : undefined;
  const requestId =
    qwenMeta && typeof qwenMeta['requestId'] === 'string'
      ? qwenMeta['requestId']
      : undefined;
  if (!requestId) return undefined;
  return {
    id: busId,
    v: 1,
    type: 'permission_request',
    data: {
      requestId,
      sessionId:
        typeof params['sessionId'] === 'string'
          ? params['sessionId']
          : undefined,
      toolCall: params['toolCall'],
      options: params['options'],
    },
    _meta: meta,
  };
}

// ---------------------------------------------------------------------------
// AcpHttpTransport
// ---------------------------------------------------------------------------

/**
 * HTTP+SSE ACP transport. Sends JSON-RPC requests via `POST /acp`
 * and receives responses + notifications via a connection-scoped SSE
 * stream at `GET /acp`.
 *
 * Lazy-init: the first `fetch()` call sends `POST /acp { initialize }`
 * (which returns 200 with the initialize result inline), then opens a
 * connection-scoped SSE stream at `GET /acp` for subsequent responses.
 *
 * Subsequent `POST /acp` requests return 202 (ack); the real JSON-RPC
 * response rides an SSE stream. Responses are correlated by `id` using a
 * `Map<id, {resolve, reject}>` shared across both streams.
 *
 * Session events AND session-scoped JSON-RPC responses are received via the
 * session-scoped SSE stream at `GET /acp` (with `Acp-Session-Id`), which is
 * the resumable §1.8 stream the daemon's `replySession` routes session replies
 * onto. `subscribeEvents` reads it and dispatches each frame: a JSON-RPC
 * response resolves its pending request (so e.g. `session/prompt` doesn't hang
 * waiting on a reply it would otherwise never observe), a notification becomes
 * a `DaemonEvent`, and a `session/request_permission` request is surfaced as a
 * `permission_request` event (responding to it is the §1.7 follow-up). The
 * connection-scoped stream still carries replies to connection-level requests
 * (e.g. `initialize`, `session/new`).
 */
export class AcpHttpTransport implements DaemonTransport {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly _fetch: typeof globalThis.fetch;

  private _disposed = false;
  private _initialized = false;
  private initPromise: Promise<void> | undefined = undefined;
  private nextId = 1;
  private initResult: unknown = undefined;
  /** Connection id returned by the ACP initialize handshake. */
  private connectionId: string | undefined;

  /** Pending requests awaiting their JSON-RPC response on the SSE stream. */
  private readonly pending = new Map<number, PendingRequest>();
  /** Abort controller for the connection-scoped SSE stream. */
  private connStreamAbort: AbortController | undefined;
  /**
   * Per-session count of in-progress `subscribeEvents` iterations. When > 0 a
   * consumer is already reading that session's `/acp` stream and routing its
   * JSON-RPC replies to `pending` — so `sendRequest` must NOT open a competing
   * background reply pump (the daemon's session stream is single-reader; a
   * second `GET /acp` would detach the consumer's).
   */
  private readonly activeSessionSubscriptions = new Map<string, number>();
  /**
   * Background reply pumps started by `sendRequest` for a session-scoped
   * request when no consumer subscription is active, keyed by sessionId and
   * reference-counted so concurrent session requests share one pump. The
   * daemon routes replies to `session/prompt` & friends onto the SESSION
   * stream (not the connection stream), so without this a `DaemonClient.prompt`
   * that never iterates `subscribeEvents` would hang forever.
   */
  private readonly sessionReplyPumps = new Map<
    string,
    { abort: AbortController; refs: number }
  >();

  readonly type = 'acp-http' as const;
  readonly supportsReplay = true;

  constructor(
    baseUrl: string,
    token: string | undefined,
    fetchFn: typeof globalThis.fetch,
  ) {
    this.baseUrl = baseUrl;
    this.token = token;
    this._fetch = fetchFn;
  }

  get connected(): boolean {
    return this._initialized && !this._disposed;
  }

  async fetch(
    url: string,
    init: RequestInit,
    _opts?: DaemonTransportFetchOptions,
  ): Promise<Response> {
    if (this._disposed) throw new DaemonTransportClosedError();

    await this.ensureInitialized();

    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;
    let body: unknown;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    const httpMethod = (init.method ?? 'GET').toUpperCase();
    const match = matchRoute(path, httpMethod);

    if (!match) {
      return synthesizeResponse(404, {
        error: `No ACP mapping for ${httpMethod} ${path}`,
      });
    }

    const { mapping, segments } = match;

    if (mapping.method === '_capabilities') {
      return synthesizeResponse(200, this.initResult ?? { v: 1 });
    }

    // For notifications, send via POST /acp and return 204.
    if (mapping.notification) {
      const params = mapping.extractParams(
        segments,
        body,
        httpMethod,
        parsedUrl.searchParams,
      );
      await this.sendNotification(mapping.method, params, init.headers);
      return synthesizeResponse(204, null);
    }

    // Normal request: POST /acp with the JSON-RPC request body.
    // The POST returns 202 (ack); the real response rides the SSE stream.
    const params = mapping.extractParams(
      segments,
      body,
      httpMethod,
      parsedUrl.searchParams,
    );
    const response = await this.sendRequest(
      mapping.method,
      params,
      init.signal ?? undefined,
      init.headers,
    );

    if (response.error) {
      // Recover the original HTTP status when available (set by our
      // sendRequest wrapper), otherwise fall back to the JSON-RPC
      // error-code → HTTP-status mapping.
      const errorData = response.error.data;
      const httpStatus =
        isRecord(errorData) && typeof errorData['httpStatus'] === 'number'
          ? errorData['httpStatus']
          : jsonRpcErrorToHttpStatusWithData(
              response.error.code,
              response.error.data,
            );
      return synthesizeResponse(httpStatus, {
        error: response.error.message,
        ...(response.error.data != null ? { data: response.error.data } : {}),
      });
    }

    return synthesizeResponse(200, response.result);
  }

  async *subscribeEvents(
    sessionId: string,
    opts: DaemonTransportSubscribeOptions = {},
  ): AsyncGenerator<DaemonEvent> {
    if (this._disposed) throw new DaemonTransportClosedError();
    // Mark this session as having an active consumer reader for the duration of
    // the iteration, so `sendRequest` knows replies are already being routed
    // and won't open a competing background pump (single-reader session stream).
    this.activeSessionSubscriptions.set(
      sessionId,
      (this.activeSessionSubscriptions.get(sessionId) ?? 0) + 1,
    );
    // The session `/acp` stream is single-reader: this consumer's GET will make
    // the daemon detach any background reply pump started earlier by a no-iter
    // `sendRequest`. Abort that pump NOW so it tears down cleanly (its sweep is
    // skipped on abort) — otherwise its dying `.finally` would re-scan `pending`
    // and spuriously reject the very `session/prompt` this consumer is taking
    // over delivery of. The consumer now owns reply routing for this session.
    //
    // Delete the map entry SYNCHRONOUSLY (not just abort and let the pump's
    // async `.finally` remove it). Otherwise, if this subscription exits before
    // that microtask runs, BOTH stranded-pending guards miss: the consumer sweep
    // (`subscribeEventsInner` finally) sees the entry still present and defers to
    // the pump, while the pump's own sweep is skipped because its signal is
    // aborted — leaving a live `session/prompt` in `pending` forever. Removing it
    // here makes the consumer sweep deterministically responsible.
    const existingPump = this.sessionReplyPumps.get(sessionId);
    if (existingPump) {
      existingPump.abort.abort();
      this.sessionReplyPumps.delete(sessionId);
    }
    let subscriptionError: Error | undefined;
    try {
      yield* this.subscribeEventsInner(sessionId, opts);
    } catch (err) {
      // Capture WHY the subscription ended so the sweep below can reject with
      // the real cause. On the fast-fail path (401 / wrong content-type thrown
      // before the inner read loop) this wrapper finally is the ONLY sweep that
      // fires, so a generic message would hide the actual failure (M4DWx parity).
      subscriptionError = err instanceof Error ? err : new Error(String(err));
      throw err;
    } finally {
      const n = (this.activeSessionSubscriptions.get(sessionId) ?? 1) - 1;
      if (n <= 0) this.activeSessionSubscriptions.delete(sessionId);
      else this.activeSessionSubscriptions.set(sessionId, n);
      // This consumer owned reply routing for the session (no reply pump runs
      // while a subscription is active). On exit — whether the stream closed
      // cleanly OR `subscribeEventsInner` failed fast before its read loop (a
      // fetch reject / non-OK / wrong content-type) — if it was the LAST route
      // (no other active subscription left, no reply pump), reject its still-live
      // session-scoped pendings so a `session/prompt` caller can't hang on a
      // reply that will never arrive. This finally ALWAYS runs, so it covers the
      // fast-fail path the inner read-loop finally cannot. Mirrors the
      // reply-pump and connection-stream sweeps.
      if (!this._disposed && n <= 0 && !this.sessionReplyPumps.has(sessionId)) {
        const reason =
          subscriptionError ??
          new Error('Session SSE stream closed unexpectedly');
        for (const [id, entry] of this.pending) {
          if (entry.sessionId !== sessionId) continue;
          entry.reject(reason);
          this.pending.delete(id);
        }
      }
    }
  }

  private async *subscribeEventsInner(
    sessionId: string,
    opts: DaemonTransportSubscribeOptions = {},
  ): AsyncGenerator<DaemonEvent> {
    await this.ensureInitialized();

    // Open the SESSION-scoped `/acp` stream (GET /acp + Acp-Session-Id), NOT
    // REST `/session/:id/events`. This is the resumable §1.8 stream and — the
    // reason for this routing — the stream the daemon's `replySession` puts
    // session-scoped JSON-RPC *responses* on. Reading it here is what lets a
    // `session/prompt` reply resolve its pending request instead of hanging.
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (this.connectionId) {
      headers['Acp-Connection-Id'] = this.connectionId;
    }
    headers['Acp-Session-Id'] = sessionId;
    if (opts.lastEventId !== undefined) {
      headers['Last-Event-ID'] = String(opts.lastEventId);
    }
    // NOTE: `opts.maxQueued` does NOT apply to this transport. The REST
    // `/session/:id/events` surface accepted it as a per-subscription queue
    // bound, but the `/acp` session stream is backed by the daemon's
    // server-controlled EventBus ring (a fixed `DEFAULT_RING_SIZE`), so there
    // is no client-tunable queue to forward it to. It's intentionally ignored
    // here rather than silently mis-applied; the field stays on the shared
    // `DaemonTransportSubscribeOptions` for the REST transport.

    // Connect-phase timeout.
    const connectCtrl = new AbortController();
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    if (opts.connectTimeoutMs && Number.isFinite(opts.connectTimeoutMs)) {
      connectTimer = setTimeout(
        () =>
          connectCtrl.abort(
            new DOMException('Initial connect timed out', 'TimeoutError'),
          ),
        opts.connectTimeoutMs,
      );
      if (
        typeof connectTimer === 'object' &&
        connectTimer &&
        'unref' in connectTimer
      ) {
        (connectTimer as { unref: () => void }).unref();
      }
    }

    const fetchSignal = opts.signal
      ? composeAbortSignals([opts.signal, connectCtrl.signal])
      : connectCtrl.signal;

    let res: Response;
    try {
      res = await this._fetch(`${this.baseUrl}/acp`, {
        headers,
        signal: fetchSignal,
      });
    } finally {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
    }

    if (!res.ok) {
      let body: unknown;
      try {
        const text = await res.text();
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      } catch {
        /* body unreadable */
      }
      const detail =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw Object.assign(new Error(`GET /acp (session stream): ${detail}`), {
        status: res.status,
        body,
      });
    }

    const ct = res.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes('text/event-stream')) {
      try {
        await res.body?.cancel();
      } catch {
        /* body already consumed or no body */
      }
      throw Object.assign(
        new Error(
          `GET /acp (session stream): expected content-type text/event-stream, got "${ct}"`,
        ),
        { status: res.status, body: ct },
      );
    }

    if (!res.body) {
      throw new Error('SSE response has no body');
    }

    // The `/acp` session stream carries RAW JSON-RPC frames (not REST
    // `BridgeEvent` envelopes), so parse them directly and dispatch by shape.
    // Each SSE frame may carry an `id:` line — the EventBus cursor we stamp
    // onto yielded events so the consumer resumes from the REAL daemon id
    // (the denormalizer's synthetic id is not resume-compatible); frames with
    // no `id:` (synthetic terminals) yield `id: undefined`, which the consumer
    // ignores for Last-Event-ID tracking.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const signal = opts.signal;
    // `reader.read()` doesn't observe `signal` on its own — race it against an
    // abort rejection so dispose()/caller-abort can unblock a hanging read.
    // Keep the listener in a named ref and remove it in the `finally`: a
    // long-lived signal reused across reconnects (the scenario this resumable
    // transport enables) would otherwise accumulate one listener per call.
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      if (signal) {
        onAbort = () =>
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    // If `signal` is already aborted at entry, the `while (!signal?.aborted)`
    // loop below never runs, so `Promise.race` never consumes this rejection.
    // Attach a no-op handler so that early-abort case can't surface as an
    // unhandled rejection (Node `UnhandledPromiseRejectionWarning` / browser
    // `unhandledrejection`). The race still settles on the same rejection.
    abortPromise.catch(() => {});

    try {
      while (!signal?.aborted) {
        const { value, done } = await Promise.race([
          reader.read(),
          abortPromise,
        ]);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.length > MAX_SSE_BUF_CHARS) {
          throw new Error(
            `AcpHttpTransport: unread SSE buffer exceeded ${MAX_SSE_BUF_CHARS} ` +
              `bytes without a frame boundary`,
          );
        }

        // Reuse the shared CRLF-aware frame splitter (handles both `\n\n` and
        // `\r\n\r\n`) instead of reimplementing it.
        const { frames, tail } = consumeFrames(buf);
        buf = tail;
        for (const rawFrame of frames) {
          let busId: number | undefined;
          const dataParts: string[] = [];
          for (const rawLine of rawFrame.split('\n')) {
            // Strip a trailing CR so CRLF line endings don't corrupt JSON.parse.
            const line = rawLine.endsWith('\r')
              ? rawLine.slice(0, -1)
              : rawLine;
            if (line.startsWith('id:')) {
              // Match the server's `parseLastEventId` strictness (pure decimal,
              // within MAX_SAFE_INTEGER) so a proxy-mangled `id:` can't seed a
              // cursor the daemon would later reject — `Number()` would wave
              // through hex / `1e5` / `''`→0.
              const raw = line.slice(3).trim();
              // A later `id:` line in the same frame overrides an earlier one;
              // an INVALID one resets the cursor to undefined rather than
              // leaving a stale value from a prior line (so a proxy-mangled
              // trailing `id:` can't carry a wrong cursor into the event).
              if (/^\d+$/.test(raw)) {
                const n = Number.parseInt(raw, 10);
                busId =
                  Number.isFinite(n) && n <= Number.MAX_SAFE_INTEGER
                    ? n
                    : undefined;
              } else {
                busId = undefined;
              }
            } else if (line.startsWith('data:')) {
              // Per the SSE spec, multiple `data:` lines in one event join with
              // a newline.
              dataParts.push(line.slice('data:'.length).replace(/^ /, ''));
            }
          }
          if (dataParts.length === 0) continue;
          const dataLine = dataParts.join('\n');

          let msg: unknown;
          try {
            msg = JSON.parse(dataLine);
          } catch {
            // Non-empty payload that failed to parse ⇒ a corrupt data frame
            // (genuine heartbeats/comments carry no `data:` and were filtered
            // by the `dataParts.length === 0` guard above). We drop it and move
            // on: the SDK has no logger and the package's lint config forbids
            // `console`, so there's no in-convention channel to trace it here.
            // Surfacing dropped frames is left to a follow-up once the SDK
            // grows a logging facility.
            continue;
          }
          if (!isRecord(msg)) continue;

          const hasId = 'id' in msg;
          const method = (msg as { method?: unknown }).method;

          // (1) JSON-RPC response (id, no method) → resolve the pending request.
          // THIS is the W2 fix: a `session/prompt` reply routed here by the
          // daemon's `replySession` now settles its promise instead of hanging.
          if (hasId && typeof method !== 'string') {
            const rid = (msg as { id: unknown }).id;
            if (typeof rid === 'number') {
              const pending = this.pending.get(rid);
              if (pending) {
                // Defense-in-depth: don't let a reply on this session's stream
                // resolve a pending scoped to a different session (mirror of the
                // reply-pump guard).
                if (
                  pending.sessionId !== undefined &&
                  pending.sessionId !== sessionId
                ) {
                  continue;
                }
                this.pending.delete(rid);
                pending.resolve(msg as unknown as JsonRpcResponse);
              }
            }
            continue;
          }

          // (2) Agent→client permission request → surface as an event so the
          // consumer can show it. Responding (POSTing the vote) is the §1.7
          // permission-coordination follow-up; here we only deliver it.
          if (method === 'session/request_permission') {
            const ev = permissionRequestToEvent(msg, busId);
            if (ev) yield ev;
            continue;
          }

          // (3) Notification → DaemonEvent, stamped with the real bus cursor.
          if (typeof method === 'string' && !hasId) {
            const ev = denormalizeAcpNotification(
              msg as unknown as JsonRpcNotification,
            );
            if (ev) {
              ev.id = busId; // authoritative cursor (or undefined → ignored)
              yield ev;
            }
            continue;
          }
          // else: unrecognized frame → ignore
        }
      }
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      try {
        reader.cancel().catch(() => {});
      } catch {
        /* already closed */
      }
      // NOTE: the session-scoped pending sweep lives in the `subscribeEvents`
      // WRAPPER's finally, not here. This read-loop finally only runs if the
      // pump reached the read loop — a fast failure (fetch reject / non-OK /
      // wrong content-type, all BEFORE this try) would skip it and strand the
      // pending. The wrapper finally always runs, so the sweep belongs there.
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._initialized = false;

    // Tear down the connection-scoped SSE stream.
    this.connStreamAbort?.abort();
    this.connStreamAbort = undefined;

    // Tear down any background session-reply pumps.
    for (const [sid, entry] of this.sessionReplyPumps) {
      entry.abort.abort();
      this.sessionReplyPumps.delete(sid);
    }

    // Reject all pending requests.
    for (const [id, entry] of this.pending) {
      entry.reject(new DaemonTransportClosedError());
      this.pending.delete(id);
    }
  }

  // -- Internal ----------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (this._initialized) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    // Reset on failure so the next call retries instead of parking
    // on a permanently rejected promise.
    this.initPromise = this.initialize().catch((err) => {
      this.initPromise = undefined;
      throw err;
    });
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    const initReq: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        clientInfo: { name: 'qwen-code-sdk', version: '1.0.0' },
      },
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const res = await this._fetch(`${this.baseUrl}/acp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(initReq),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ACP initialize failed: HTTP ${res.status} ${text}`);
    }

    const response = (await res.json()) as JsonRpcResponse;
    if (response.error) {
      throw new Error(`ACP initialize error: ${response.error.message}`);
    }

    // Extract connectionId: try the response header first (canonical),
    // then the JSON body at agentCapabilities._meta.qwen.connectionId,
    // then the legacy path _meta.qwen.connectionId.
    const result = response.result;
    const headerConnId = res.headers.get('acp-connection-id');
    this.connectionId =
      (headerConnId || undefined) ??
      extractConnectionId(result, [
        'agentCapabilities',
        '_meta',
        'qwen',
        'connectionId',
      ]) ??
      extractConnectionId(result, ['_meta', 'qwen', 'connectionId']);

    this.initResult = result;
    this._initialized = true;

    // Fetch REST /capabilities separately so capabilities() returns the
    // right shape (the ACP initialize result has a different schema).
    try {
      const capHeaders: Record<string, string> = {};
      if (this.token) {
        capHeaders['Authorization'] = `Bearer ${this.token}`;
      }
      const capRes = await this._fetch(`${this.baseUrl}/capabilities`, {
        headers: capHeaders,
      });
      if (capRes.ok) {
        this.initResult = await capRes.json();
      }
    } catch {
      // Non-fatal — initResult stays as the ACP initialize result.
    }
  }

  /**
   * Open a connection-scoped SSE stream at `GET /acp` with the
   * `Acp-Connection-Id` header. Incoming JSON-RPC responses are
   * matched to pending requests by `id`.
   */
  private openConnStream(): void {
    const abort = new AbortController();
    this.connStreamAbort = abort;

    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (this.connectionId) {
      headers['Acp-Connection-Id'] = this.connectionId;
    }

    // Fire-and-forget: pump the SSE stream in the background.
    void this.pumpConnStream(headers, abort.signal)
      .catch((err) => {
        // Stream ended or errored — reject remaining CONNECTION-scoped pendings
        // only. Session-scoped replies ride the session stream / its reply pump,
        // which owns their lifecycle; sweeping them here would reject a
        // `session/prompt` the session stream is about to resolve (§W2 race).
        // Carry the pump's real error (HTTP 401/503, network drop) as the reject
        // reason — mirroring `ensureSessionReplyPump` — so a caller can tell an
        // auth failure from a generic close instead of a one-size-fits-all msg.
        if (!this._disposed) {
          const reason =
            err instanceof Error
              ? err
              : new Error('Connection SSE stream closed unexpectedly');
          for (const [id, entry] of this.pending) {
            if (entry.sessionId !== undefined) continue;
            entry.reject(reason);
            this.pending.delete(id);
          }
        }
      })
      .finally(() => {
        // The pump has settled (clean close, error, or abort). Clear the
        // controller so the NEXT connection-scoped request reopens the stream
        // via `ensureConnStream` — without this, a stream that 500s, serves no
        // body, or closes leaves `connStreamAbort` non-null forever and every
        // later 202 request hangs with no pump to deliver its reply. Guard on
        // identity so a newer `openConnStream` that already replaced the
        // controller isn't clobbered.
        if (this.connStreamAbort === abort) this.connStreamAbort = undefined;
      });
  }

  private async pumpConnStream(
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<void> {
    const res = await this._fetch(`${this.baseUrl}/acp`, {
      headers,
      signal,
    });

    // A non-2xx response or a missing body is a HARD failure, not a silent
    // no-op: throwing lets `openConnStream`'s catch reject the connection-scoped
    // pendings (otherwise a 202 request would hang forever waiting for a reply
    // on a stream that never opened).
    if (!res.ok || !res.body) {
      throw new Error(
        `Connection SSE stream failed: HTTP ${res.status} ${res.statusText}`,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    // Build an abort-aware read helper: `reader.read()` does not
    // respect the signal on its own (the fetch mock may return a
    // pre-built ReadableStream that isn't wired to the signal).
    // Race each read against a signal-based rejection so dispose()
    // can unblock a hanging `reader.read()`.
    // Keep the abort listener in a named ref and remove it in the `finally`:
    // on a clean drain that never aborts, an anonymous `{ once: true }` listener
    // would otherwise leak on a long-lived signal reused across reconnects
    // (mirrors `subscribeEventsInner` / `pumpSessionReplies`).
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      onAbort = () =>
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    // No-op catch so a synchronous reject (signal already aborted) can't surface
    // as an unhandledrejection if the read loop throws before the race sees it.
    abortPromise.catch(() => {});

    try {
      while (!signal.aborted) {
        const { value, done } = await Promise.race([
          reader.read(),
          abortPromise,
        ]);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // Bound the unread buffer — the same OOM guard the session readers have.
        // A server/proxy that never emits a `\n\n` frame boundary would
        // otherwise grow this without limit on the connection-scoped stream.
        if (buf.length > MAX_SSE_BUF_CHARS) {
          throw new Error(
            `AcpHttpTransport: unread SSE buffer exceeded ${MAX_SSE_BUF_CHARS} ` +
              `bytes without a frame boundary`,
          );
        }

        // Reuse the shared CRLF-aware frame splitter (handles both `\n\n` and
        // `\r\n\r\n`) instead of an LF-only `indexOf('\n\n')`. A server/proxy
        // emitting `\r\n\r\n` separators never produces a `\n\n` substring, so
        // the old scan found no boundary, grew `buf` to the cap, and killed
        // this pump — leaving every conn-scoped JSON-RPC reply unresolved. This
        // matches the session readers' framing exactly.
        const { frames, tail } = consumeFrames(buf);
        buf = tail;
        for (const rawFrame of frames) {
          // Per the SSE spec multiple `data:` lines join with a newline; strip a
          // trailing CR so CRLF line endings don't corrupt JSON.parse.
          const dataParts: string[] = [];
          for (const rawLine of rawFrame.split('\n')) {
            const line = rawLine.endsWith('\r')
              ? rawLine.slice(0, -1)
              : rawLine;
            if (line.startsWith('data:')) {
              dataParts.push(line.slice('data:'.length).replace(/^ /, ''));
            }
          }
          if (dataParts.length === 0) continue;
          try {
            const parsed = JSON.parse(dataParts.join('\n')) as JsonRpcResponse;
            if (
              typeof parsed === 'object' &&
              parsed !== null &&
              'id' in parsed
            ) {
              const pending = this.pending.get(parsed.id);
              if (pending) {
                // Defense-in-depth scope guard, mirroring `subscribeEventsInner`
                // and `pumpSessionReplies`: the CONNECTION stream only carries
                // conn-scoped replies, so never resolve a SESSION-scoped pending
                // here — a daemon routing regression that mis-delivered a
                // session reply on the conn stream must not cross session
                // boundaries (matches the `openConnStream` error sweep, which
                // also skips `entry.sessionId !== undefined`).
                if (pending.sessionId === undefined) {
                  this.pending.delete(parsed.id);
                  pending.resolve(parsed);
                }
              }
            }
          } catch {
            // Ignore unparseable frames (heartbeats, etc.)
          }
        }
      }
    } catch (err) {
      // An intentional abort (dispose / reconnect) is a clean shutdown — the
      // aborter owns pending cleanup, so swallow it. Any OTHER error (read
      // failure, mid-stream socket drop) must PROPAGATE so `openConnStream`'s
      // catch rejects the connection-scoped pendings rather than leaving them
      // hung on a dead stream.
      if (signal.aborted) return;
      throw err;
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      // Best-effort cancel with a timeout guard — some ReadableStream
      // implementations (especially in test environments) can hang on
      // cancel() if the underlying source never closes.
      try {
        reader.cancel().catch(() => {});
      } catch {
        /* already closed */
      }
    }
  }

  private async sendNotification(
    method: string,
    params: Record<string, unknown>,
    callerHeaders?: HeadersInit,
  ): Promise<void> {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const transportHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      transportHeaders['Authorization'] = `Bearer ${this.token}`;
    }
    if (this.connectionId) {
      transportHeaders['Acp-Connection-Id'] = this.connectionId;
    }

    // Merge caller headers (from init.headers) with transport headers.
    const headers = mergeHeaders(transportHeaders, callerHeaders);

    await this._fetch(`${this.baseUrl}/acp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(notification),
    });
  }

  /**
   * Ensure the connection-scoped SSE stream is open. Called lazily on
   * the first sendRequest that needs it (i.e. when the server returns
   * 202, meaning the real response rides the SSE stream).
   */
  private ensureConnStream(): void {
    if (this.connStreamAbort) return;
    this.openConnStream();
  }

  /**
   * Send a JSON-RPC request via `POST /acp` (returns 202 ack) and wait
   * for the matching response on the connection-scoped SSE stream.
   */
  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    callerHeaders?: HeadersInit,
  ): Promise<JsonRpcResponse> {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      params,
    };

    const transportHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      transportHeaders['Authorization'] = `Bearer ${this.token}`;
    }
    if (this.connectionId) {
      transportHeaders['Acp-Connection-Id'] = this.connectionId;
    }

    // Merge caller headers with transport headers.
    const headers = mergeHeaders(transportHeaders, callerHeaders);

    const res = await this._fetch(`${this.baseUrl}/acp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
      signal,
    });

    if (!res.ok) {
      // POST itself failed — return a synthetic error response.
      const text = await res.text().catch(() => '');
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: -res.status,
          message: `HTTP ${res.status}: ${text}`,
          data: { httpStatus: res.status },
        },
      };
    }

    // If the server returned 200 with a JSON body (e.g. a server
    // that doesn't use 202+SSE), consume it directly.
    const ct = res.headers.get('content-type') ?? '';
    if (res.status === 200 && ct.includes('application/json')) {
      return (await res.json()) as JsonRpcResponse;
    }

    // 202 (ack) — the real response rides an SSE stream. Ensure the
    // connection-scoped stream is open and register the pending request.
    this.ensureConnStream();

    // The daemon routes a handful of session methods' replies onto the SESSION
    // stream, not the connection stream. If this is one of them and the caller
    // isn't already iterating `subscribeEvents` for that session (which would
    // route the reply itself), open a background reply pump so the request can
    // resolve — otherwise `DaemonClient.prompt()` and friends hang forever.
    const sessionId =
      typeof params['sessionId'] === 'string'
        ? (params['sessionId'] as string)
        : undefined;
    // This reply rides the SESSION stream iff it's one of the session-routed
    // methods (regardless of whether the reply pump or an active subscription
    // ultimately delivers it). Tag the pending entry with that scope so a
    // connection-stream failure can't sweep it (§W2 cross-stream race).
    const replyScopeSessionId =
      sessionId && SESSION_STREAM_REPLY_METHODS.has(method)
        ? sessionId
        : undefined;
    const releaseSessionPump =
      replyScopeSessionId &&
      !this.activeSessionSubscriptions.has(replyScopeSessionId)
        ? this.ensureSessionReplyPump(replyScopeSessionId)
        : undefined;

    const responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(req.id, {
        resolve,
        reject,
        sessionId: replyScopeSessionId,
      });
    });

    // Handle abort signal: if the caller aborts, reject the pending
    // request and clean up.
    let removeAbortHandler: (() => void) | undefined;
    if (signal) {
      const abortHandler = () => {
        const entry = this.pending.get(req.id);
        if (entry) {
          this.pending.delete(req.id);
          entry.reject(
            signal.reason ?? new DOMException('Aborted', 'AbortError'),
          );
        }
      };
      signal.addEventListener('abort', abortHandler, { once: true });
      // `{ once: true }` self-removes only when the signal FIRES. On the happy
      // path (request resolves normally) the listener would otherwise stay
      // attached, so a long-lived caller signal reused across many requests
      // accumulates one closure per call. Remove it explicitly on settle.
      removeAbortHandler = () =>
        signal.removeEventListener('abort', abortHandler);
    }

    // Release the background reply pump AND drop the abort listener once the
    // request settles (resolved by the pump, rejected by abort/stream-close) —
    // the pump closes when its last in-flight request drains.
    const cleanup = () => {
      removeAbortHandler?.();
      releaseSessionPump?.();
    };
    return removeAbortHandler || releaseSessionPump
      ? responsePromise.finally(cleanup)
      : responsePromise;
  }

  /**
   * Ensure a background session-reply pump is running for `sessionId`, returning
   * a release callback. Reference-counted: concurrent session requests share one
   * pump and it tears down when the last releases. The pump reads the session
   * `/acp` stream and routes JSON-RPC *responses* to `pending` (mirroring
   * `pumpConnStream`); it ignores events (no consumer) — a consumer that wants
   * events uses `subscribeEvents`, which suppresses this pump entirely.
   *
   * NOTE (daemon-side attach semantics): the pump opens `GET /acp` with
   * `Acp-Session-Id` but NO `Last-Event-ID`, so the daemon does a fresh
   * (non-resumptive) session attach — content events produced before the pump
   * attaches are delivered live, not replayed. A later `subscribeEvents`
   * consumer that resumes with a `Last-Event-ID` therefore won't see those
   * pre-pump content events replayed (they were live-delivered to a pump that
   * only routes JSON-RPC *responses* and drops events). This is fine for the
   * pump's job — resolving a no-subscriber `session/prompt` reply — but a
   * consumer that needs the full event history should open `subscribeEvents`
   * before issuing session RPCs.
   */
  private ensureSessionReplyPump(sessionId: string): () => void {
    let entry = this.sessionReplyPumps.get(sessionId);
    if (!entry) {
      const abort = new AbortController();
      const created = { abort, refs: 0 };
      entry = created;
      this.sessionReplyPumps.set(sessionId, created);
      // Capture the pump's error (e.g. `HTTP 401`, wrong content-type) so the
      // sweep can reject pendings WITH that reason instead of a generic message
      // — the caller can then tell an auth failure from a network drop.
      let pumpError: Error | undefined;
      void this.pumpSessionReplies(sessionId, abort.signal)
        .catch((err) => {
          pumpError = err instanceof Error ? err : new Error(String(err));
        })
        .finally(() => {
          if (this.sessionReplyPumps.get(sessionId) === created) {
            this.sessionReplyPumps.delete(sessionId);
          }
          // If the pump ended on its own (stream error) rather than via a clean
          // release (`abort` fires only when the last ref drops, after each
          // request already settled), reject this session's still-live pendings
          // so they don't hang. Scoped to THIS sessionId — the mirror of the
          // connection-stream sweep (§W2 race).
          if (!this._disposed && !abort.signal.aborted) {
            const reason =
              pumpError ??
              new Error('Session SSE reply stream closed unexpectedly');
            for (const [id, pending] of this.pending) {
              if (pending.sessionId !== sessionId) continue;
              pending.reject(reason);
              this.pending.delete(id);
            }
          }
        });
    }
    entry.refs += 1;
    let released = false;
    const active = entry;
    return () => {
      if (released) return;
      released = true;
      active.refs -= 1;
      if (active.refs <= 0) {
        active.abort.abort();
        if (this.sessionReplyPumps.get(sessionId) === active) {
          this.sessionReplyPumps.delete(sessionId);
        }
      }
    };
  }

  /**
   * Read a session-scoped `/acp` stream purely to route JSON-RPC *responses*
   * (`id`, no `method`) to `pending`. Notifications and agent→client requests
   * (`session/request_permission`, which also carry an `id`) are skipped — the
   * `method` guard prevents a permission request id from being mis-routed onto
   * a pending response slot.
   */
  private async pumpSessionReplies(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    if (this.connectionId) headers['Acp-Connection-Id'] = this.connectionId;
    headers['Acp-Session-Id'] = sessionId;

    const res = await this._fetch(`${this.baseUrl}/acp`, { headers, signal });
    // Surface the HTTP status (401 stale token / 404 gone session / 5xx) in the
    // thrown error so the caller's sweep + any log can tell them apart. Caught
    // by `ensureSessionReplyPump`'s `.catch(() => {})`; the pending rejection
    // still happens in its `.finally`.
    if (!res.ok || !res.body) {
      throw new Error(
        `session reply pump: HTTP ${res.status} ${res.statusText}`,
      );
    }
    // Validate the content-type before parsing as SSE — mirror
    // `subscribeEventsInner`. A non-SSE 2xx body (an HTML error page / a JSON
    // proxy error injected by a CDN) would otherwise be fed to the frame parser,
    // which would consume garbage or hang waiting for `data:` lines that never
    // come. Don't leave the reply channel with weaker validation than events.
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes('text/event-stream')) {
      try {
        await res.body.cancel();
      } catch {
        /* body already consumed or no body */
      }
      throw new Error(
        `session reply pump: expected content-type text/event-stream, got "${ct}"`,
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    // Mirror `subscribeEventsInner`: keep the abort listener in a named ref so
    // `finally` can remove it (it's `once`, so a clean drain that never aborts
    // would otherwise leak it on a reused parent signal), and attach a no-op
    // `.catch` so a synchronous reject (signal already aborted) can't surface as
    // an unhandledrejection if the read loop throws before the race observes it.
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      onAbort = () =>
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    abortPromise.catch(() => {});

    try {
      while (!signal.aborted) {
        const { value, done } = await Promise.race([
          reader.read(),
          abortPromise,
        ]);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.length > MAX_SSE_BUF_CHARS) {
          throw new Error('session reply pump: SSE buffer exceeded cap');
        }
        const { frames, tail } = consumeFrames(buf);
        buf = tail;
        for (const rawFrame of frames) {
          const dataParts: string[] = [];
          for (const rawLine of rawFrame.split('\n')) {
            const line = rawLine.endsWith('\r')
              ? rawLine.slice(0, -1)
              : rawLine;
            if (line.startsWith('data:')) {
              dataParts.push(line.slice('data:'.length).replace(/^ /, ''));
            }
          }
          if (dataParts.length === 0) continue;
          let msg: unknown;
          try {
            msg = JSON.parse(dataParts.join('\n'));
          } catch {
            continue;
          }
          if (!isRecord(msg)) continue;
          // Only JSON-RPC responses (id present, NO method) route to pending —
          // skip notifications and permission requests (which carry a method).
          if (!('id' in msg) || typeof msg['method'] === 'string') continue;
          const rid = msg['id'];
          if (typeof rid !== 'number') continue;
          const pending = this.pending.get(rid);
          if (pending) {
            // Defense-in-depth: a reply arriving on THIS session's stream must
            // not resolve a pending scoped to a different session. The daemon
            // enforces session ownership on `/acp`, but a future routing
            // regression must not silently cross-deliver across the SDK boundary.
            if (
              pending.sessionId !== undefined &&
              pending.sessionId !== sessionId
            ) {
              continue;
            }
            this.pending.delete(rid);
            pending.resolve(msg as unknown as JsonRpcResponse);
          }
        }
      }
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      try {
        reader.cancel().catch(() => {});
      } catch {
        /* already closed */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk an object along a key path and return the leaf value if it's a
 * string, otherwise `undefined`.
 */
function extractConnectionId(obj: unknown, path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return typeof cur === 'string' ? cur : undefined;
}
