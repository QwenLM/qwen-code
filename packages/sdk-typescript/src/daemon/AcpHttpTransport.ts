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
  jsonRpcErrorToHttpStatus,
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
      const params = mapping.extractParams(segments, body, httpMethod);
      await this.sendNotification(mapping.method, params, init.headers);
      return synthesizeResponse(204, null);
    }

    // Normal request: POST /acp with the JSON-RPC request body.
    // The POST returns 202 (ack); the real response rides the SSE stream.
    const params = mapping.extractParams(segments, body, httpMethod);
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
          : jsonRpcErrorToHttpStatus(response.error.code);
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
              if (/^\d+$/.test(raw)) {
                const n = Number.parseInt(raw, 10);
                if (Number.isFinite(n) && n <= Number.MAX_SAFE_INTEGER)
                  busId = n;
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
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._initialized = false;

    // Tear down the connection-scoped SSE stream.
    this.connStreamAbort?.abort();
    this.connStreamAbort = undefined;

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
    void this.pumpConnStream(headers, abort.signal).catch(() => {
      // Stream ended or errored — reject any remaining pending requests.
      if (!this._disposed) {
        for (const [id, entry] of this.pending) {
          entry.reject(new Error('Connection SSE stream closed unexpectedly'));
          this.pending.delete(id);
        }
      }
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

    if (!res.ok || !res.body) return;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    // Build an abort-aware read helper: `reader.read()` does not
    // respect the signal on its own (the fetch mock may return a
    // pre-built ReadableStream that isn't wired to the signal).
    // Race each read against a signal-based rejection so dispose()
    // can unblock a hanging `reader.read()`.
    const abortPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }
      signal.addEventListener(
        'abort',
        () =>
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    });

    try {
      while (!signal.aborted) {
        const { value, done } = await Promise.race([
          reader.read(),
          abortPromise,
        ]);
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame
            .split('\n')
            .find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const parsed = JSON.parse(
              dataLine.slice('data: '.length),
            ) as JsonRpcResponse;
            if (
              typeof parsed === 'object' &&
              parsed !== null &&
              'id' in parsed
            ) {
              const pending = this.pending.get(parsed.id);
              if (pending) {
                this.pending.delete(parsed.id);
                pending.resolve(parsed);
              }
            }
          } catch {
            // Ignore unparseable frames (heartbeats, etc.)
          }
        }
      }
    } catch {
      // Abort or read error — fall through to cleanup.
    } finally {
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

    // 202 (ack) — the real response rides the connection-scoped SSE
    // stream. Ensure it's open and register the pending request.
    this.ensureConnStream();

    const responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject });
    });

    // Handle abort signal: if the caller aborts, reject the pending
    // request and clean up.
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
    }

    return responsePromise;
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
