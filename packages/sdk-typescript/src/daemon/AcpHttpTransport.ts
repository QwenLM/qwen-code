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
// URL-to-JSON-RPC mapping
// ---------------------------------------------------------------------------

interface RouteMapping {
  method: string;
  extractParams: (
    segments: string[],
    body: unknown,
    httpMethod: string,
  ) => Record<string, unknown>;
  notification?: boolean;
}

/** Same route table as AcpWsTransport — factored identically. */
const ROUTE_TABLE: ReadonlyArray<{
  httpMethod: string;
  pattern: RegExp;
  mapping: RouteMapping;
}> = [
  {
    httpMethod: 'POST',
    pattern: /^\/session\/?$/,
    mapping: {
      method: 'session/new',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/prompt$/,
    mapping: {
      method: 'session/prompt',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/cancel$/,
    mapping: {
      method: 'session/cancel',
      extractParams: (segs) => ({ sessionId: segs[0] }),
      notification: true,
    },
  },
  {
    httpMethod: 'DELETE',
    pattern: /^\/session\/([^/]+)\/?$/,
    mapping: {
      method: 'session/close',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/load$/,
    mapping: {
      method: 'session/load',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/resume$/,
    mapping: {
      method: 'session/resume',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/permission\/([^/]+)$/,
    mapping: {
      method: 'session/permission',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        requestId: segs[1],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  {
    httpMethod: 'POST',
    pattern: /^\/permission\/([^/]+)$/,
    mapping: {
      method: 'session/permission',
      extractParams: (segs, body) => ({
        requestId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/model$/,
    mapping: {
      method: 'session/set_config_option',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  {
    httpMethod: 'GET',
    pattern: /^\/capabilities\/?$/,
    mapping: {
      method: '_capabilities',
      extractParams: () => ({}),
    },
  },
  {
    httpMethod: 'GET',
    pattern: /^\/health\/?$/,
    mapping: {
      method: '_qwen/health',
      extractParams: () => ({}),
    },
  },
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/(.+)$/,
    mapping: {
      method: '_qwen/workspace',
      extractParams: (segs) => ({ path: segs[0] }),
    },
  },
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/(.+)$/,
    mapping: {
      method: '_qwen/workspace',
      extractParams: (segs, body) => ({
        path: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  {
    httpMethod: 'PATCH',
    pattern: /^\/session\/([^/]+)\/metadata$/,
    mapping: {
      method: 'session/metadata',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/heartbeat$/,
    mapping: {
      method: 'session/heartbeat',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/recap$/,
    mapping: {
      method: 'session/recap',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/btw$/,
    mapping: {
      method: 'session/btw',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/shell$/,
    mapping: {
      method: 'session/shell',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/approval-mode$/,
    mapping: {
      method: 'session/approval_mode',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/branch$/,
    mapping: {
      method: 'session/branch',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
];

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
  private initPromise: Promise<void> | null = null;
  private nextId = 1;
  private initResult: unknown = undefined;

  /**
   * Connection-scoped SSE stream. Receives JSON-RPC responses
   * correlated by id, and notifications pushed to listeners.
   */
  private sseAbort: AbortController | null = null;
  private readonly pendingRequests = new Map<
    number,
    {
      resolve: (value: JsonRpcResponse) => void;
      reject: (reason: Error) => void;
    }
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
      const params = mapping.extractParams(segments, body, httpMethod);
      await this.sendNotification(mapping.method, params);
      return synthesizeResponse(204, null);
    }

    // Normal request: POST /acp with the JSON-RPC request body.
    const params = mapping.extractParams(segments, body, httpMethod);
    const response = await this.sendRequest(mapping.method, params);

    if (response.error) {
      const status = jsonRpcErrorToHttpStatus(response.error.code);
      return synthesizeResponse(status, {
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

    for (const [, pending] of this.pendingRequests) {
      pending.reject(new DaemonTransportClosedError());
    }
    this.pendingRequests.clear();

    if (this.sseAbort) {
      this.sseAbort.abort();
      this.sseAbort = null;
    }
  }

  // -- Internal ----------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (this._initialized) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = this.initialize();
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

    this.initResult = response.result;
    this._initialized = true;
  }

  private async sendNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    await this._fetch(`${this.baseUrl}/acp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(notification),
    });
  }

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.nextId++,
      method,
      params,
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
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: -32603,
          message: `HTTP ${res.status}: ${text}`,
        },
      };
    }

    return (await res.json()) as JsonRpcResponse;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function matchRoute(
  path: string,
  httpMethod: string,
): { mapping: RouteMapping; segments: string[] } | null {
  for (const route of ROUTE_TABLE) {
    if (route.httpMethod !== httpMethod) continue;
    const m = path.match(route.pattern);
    if (m) {
      const segments = Array.from(m).slice(1).map(decodeURIComponent);
      return { mapping: route.mapping, segments };
    }
  }
  return null;
}

function synthesizeResponse(status: number, body: unknown): Response {
  const bodyStr = body !== null ? JSON.stringify(body) : '';
  const headers: Record<string, string> = {};
  if (bodyStr) {
    headers['content-type'] = 'application/json';
  }
  return new Response(bodyStr || null, { status, headers });
}

function jsonRpcErrorToHttpStatus(code: number): number {
  if (code === -32601) return 404;
  if (code === -32600 || code === -32602 || code === -32700) return 400;
  if (code === -32603) return 500;
  return 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function composeAbortSignals(signals: AbortSignal[]): AbortSignal {
  const anyFn = (
    AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }
  ).any;
  if (typeof anyFn === 'function') return anyFn.call(AbortSignal, signals);

  const ctrl = new AbortController();
  const cleanups: Array<() => void> = [];
  const detachAll = () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        fn?.();
      } catch {
        /* swallow */
      }
    }
  };
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      detachAll();
      return ctrl.signal;
    }
    const onAbort = () => {
      ctrl.abort(s.reason);
      detachAll();
    };
    s.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => s.removeEventListener('abort', onAbort));
  }
  ctrl.signal.addEventListener('abort', detachAll, { once: true });
  return ctrl.signal;
}
