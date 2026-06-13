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
import { parseSseStream } from './sse.js';
import type { JsonRpcNotification } from './AcpEventDenormalizer.js';
import {
  matchRoute,
  synthesizeResponse,
  jsonRpcErrorToHttpStatus,
  isRecord,
  composeAbortSignals,
  mergeHeaders,
} from './acpTransportUtils.js';

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
// AcpHttpTransport
// ---------------------------------------------------------------------------

/**
 * HTTP+SSE ACP transport. Sends JSON-RPC requests via `POST /acp`
 * and receives responses + notifications via a connection-scoped SSE
 * stream at `GET /acp`.
 *
 * Lazy-init: the first `fetch()` call sends `POST /acp { initialize }`
 * and opens the connection-scoped SSE stream.
 *
 * Session events are received via a session-scoped SSE stream at
 * `GET /acp` with appropriate headers (session filtering).
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

    // Open a session-scoped SSE stream. For ACP HTTP, we use
    // the daemon's per-session SSE endpoint — same URL as REST
    // because ACP HTTP sessions still expose SSE for events.
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
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

    let url = `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/events`;
    if (opts.maxQueued !== undefined) {
      url += `?maxQueued=${encodeURIComponent(String(opts.maxQueued))}`;
    }

    let res: Response;
    try {
      res = await this._fetch(url, { headers, signal: fetchSignal });
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
      throw Object.assign(new Error(`GET /session/:id/events: ${detail}`), {
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
          `GET /session/:id/events: expected content-type text/event-stream, got "${ct}"`,
        ),
        { status: res.status, body: ct },
      );
    }

    if (!res.body) {
      throw new Error('SSE response has no body');
    }

    yield* parseSseStream(res.body, opts.signal);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._initialized = false;
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
      // Preserve the real HTTP status so the caller sees the
      // correct error code instead of everything becoming 500.
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

    return (await res.json()) as JsonRpcResponse;
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
