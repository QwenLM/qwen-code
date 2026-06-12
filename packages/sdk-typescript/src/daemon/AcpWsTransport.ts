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
import {
  denormalizeAcpNotification,
  type JsonRpcNotification,
} from './AcpEventDenormalizer.js';

// ---------------------------------------------------------------------------
// URL-to-JSON-RPC mapping
// ---------------------------------------------------------------------------

interface RouteMapping {
  method: string;
  /** Extract JSON-RPC params from URL path segments + request body. */
  extractParams: (
    segments: string[],
    body: unknown,
    httpMethod: string,
  ) => Record<string, unknown>;
  /**
   * True for notifications (no response expected). The transport will
   * NOT wait for a JSON-RPC response from the server.
   */
  notification?: boolean;
}

/**
 * Map of `METHOD PATH_PATTERN` to JSON-RPC method + params extractor.
 * Path segments are split by `/` after stripping the base URL prefix.
 *
 * Pattern conventions:
 *   - `:param` = named path param (consumed positionally)
 *   - `*`      = rest wildcard
 */
const ROUTE_TABLE: ReadonlyArray<{
  httpMethod: string;
  pattern: RegExp;
  mapping: RouteMapping;
}> = [
  // POST /session → session/new
  {
    httpMethod: 'POST',
    pattern: /^\/session\/?$/,
    mapping: {
      method: 'session/new',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // POST /session/:id/prompt → session/prompt
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
  // POST /session/:id/cancel → session/cancel (notification)
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/cancel$/,
    mapping: {
      method: 'session/cancel',
      extractParams: (segs) => ({ sessionId: segs[0] }),
      notification: true,
    },
  },
  // DELETE /session/:id → session/close
  {
    httpMethod: 'DELETE',
    pattern: /^\/session\/([^/]+)\/?$/,
    mapping: {
      method: 'session/close',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // POST /session/:id/load → session/load
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
  // POST /session/:id/resume → session/resume
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
  // POST /session/:id/permission/:reqId → JSON-RPC response
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
  // Also handle permission at /permission/:reqId (without session prefix)
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
  // POST /session/:id/model → session/set_config_option
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
  // GET /capabilities → use initialize result (handled specially)
  {
    httpMethod: 'GET',
    pattern: /^\/capabilities\/?$/,
    mapping: {
      method: '_capabilities',
      extractParams: () => ({}),
    },
  },
  // GET /health
  {
    httpMethod: 'GET',
    pattern: /^\/health\/?$/,
    mapping: {
      method: '_qwen/health',
      extractParams: () => ({}),
    },
  },
  // GET /workspace/* → _qwen/workspace/*
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/(.+)$/,
    mapping: {
      method: '_qwen/workspace',
      extractParams: (segs, _body, _httpMethod) => ({
        path: segs[0],
      }),
    },
  },
  // POST /workspace/* → _qwen/workspace/*
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
  // PATCH /session/:id/metadata → session/metadata
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
  // POST /session/:id/heartbeat
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
  // POST /session/:id/recap
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
  // POST /session/:id/btw
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
  // POST /session/:id/shell
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
  // POST /session/:id/approval-mode
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
  // POST /session/:id/branch
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
// JSON-RPC message types
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

interface PendingRequest {
  resolve: (value: JsonRpcResponse) => void;
  reject: (reason: Error) => void;
  signal?: AbortSignal;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// AcpWsTransport
// ---------------------------------------------------------------------------

/**
 * WebSocket-based ACP transport. Multiplexes all requests over a
 * single WS connection using JSON-RPC 2.0 framing.
 *
 * Lazy-init: the WebSocket connection is established on the first
 * `fetch()` call. An `initialize` JSON-RPC request is sent on
 * connect and its result is cached for `GET /capabilities` requests.
 */
export class AcpWsTransport implements DaemonTransport {
  private readonly wsUrl: string;
  private readonly token: string | undefined;

  private ws: WebSocket | null = null;
  private _connected = false;
  private _disposed = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  /**
   * Shared notification stream. Every JSON-RPC notification that
   * arrives on the WS is denormalized into a `DaemonEvent` and
   * pushed into this array of listeners. `subscribeEvents` registers
   * a per-session filter.
   */
  private readonly notificationListeners = new Set<
    (event: DaemonEvent) => void
  >();

  /**
   * Active async generators. Aborted when the WS closes so parked
   * generators throw `DaemonTransportClosedError` instead of hanging.
   */
  private readonly _activeGenerators = new Set<AbortController>();

  /** Cached `initialize` result for `GET /capabilities`. */
  private initResult: unknown = undefined;
  private initPromise: Promise<void> | null = null;

  readonly type = 'acp-ws' as const;
  readonly supportsReplay = false;

  constructor(wsUrl: string, token?: string) {
    this.wsUrl = wsUrl;
    this.token = token;
  }

  get connected(): boolean {
    return this._connected && !this._disposed;
  }

  async fetch(
    url: string,
    init: RequestInit,
    _opts?: DaemonTransportFetchOptions,
  ): Promise<Response> {
    if (this._disposed) throw new DaemonTransportClosedError();

    // Ensure WS is connected and initialized.
    await this.ensureConnected();

    // Parse the URL to extract the path relative to the base.
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;

    // Parse the body if present.
    let body: unknown;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    const httpMethod = (init.method ?? 'GET').toUpperCase();

    // Match against the route table.
    const match = matchRoute(path, httpMethod);
    if (!match) {
      // Unrecognized route — fall through with an error response.
      return synthesizeResponse(404, {
        error: `No ACP mapping for ${httpMethod} ${path}`,
      });
    }

    const { mapping, segments } = match;

    // Special handling for capabilities — return cached init result.
    if (mapping.method === '_capabilities') {
      return synthesizeResponse(200, this.initResult ?? { v: 1 });
    }

    // For notifications, send and return 204 immediately.
    if (mapping.notification) {
      const params = mapping.extractParams(segments, body, httpMethod);
      this.sendNotification(mapping.method, params);
      return synthesizeResponse(204, null);
    }

    // Normal request-response.
    const params = mapping.extractParams(segments, body, httpMethod);
    const response = await this.sendRequest(
      mapping.method,
      params,
      init.signal ?? undefined,
      // Extract sessionId for abort→cancel forwarding.
      typeof (params as { sessionId?: unknown }).sessionId === 'string'
        ? (params as { sessionId: string }).sessionId
        : undefined,
    );

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

    await this.ensureConnected();

    // Track this generator so we can abort it when the WS closes.
    const genAbort = new AbortController();
    this._activeGenerators.add(genAbort);

    // Create a queue that the notification listener pushes into.
    const queue: DaemonEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const listener = (event: DaemonEvent) => {
      // Filter by session: if the event has a sessionId, only yield
      // if it matches. Workspace-scoped events (no sessionId) pass.
      const data = event.data;
      if (isRecord(data)) {
        const evtSessionId = data['sessionId'];
        if (
          typeof evtSessionId === 'string' &&
          evtSessionId.length > 0 &&
          evtSessionId !== sessionId
        ) {
          return;
        }
      }
      queue.push(event);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    this.notificationListeners.add(listener);

    // Wire abort to cleanup.
    const onAbort = () => {
      done = true;
      this.notificationListeners.delete(listener);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        this._activeGenerators.delete(genAbort);
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    // Also wire the generator-level abort (fired on WS close).
    genAbort.signal.addEventListener('abort', onAbort, { once: true });

    try {
      while (!done && !this._disposed) {
        // Check if the generator was aborted (WS close).
        if (genAbort.signal.aborted) {
          throw new DaemonTransportClosedError(
            'WebSocket closed while generator was active',
          );
        }
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        // Wait for the next event.
        await new Promise<void>((r) => {
          resolve = r;
        });
        // Re-check abort after waking up.
        if (genAbort.signal.aborted) {
          throw new DaemonTransportClosedError(
            'WebSocket closed while generator was active',
          );
        }
      }
    } finally {
      this._activeGenerators.delete(genAbort);
      this.notificationListeners.delete(listener);
      if (opts.signal) {
        opts.signal.removeEventListener('abort', onAbort);
      }
      genAbort.signal.removeEventListener('abort', onAbort);
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this._connected = false;

    // Reject all pending requests.
    for (const [, pending] of this.pending) {
      pending.reject(new DaemonTransportClosedError());
    }
    this.pending.clear();

    // Abort all active generators.
    for (const ac of this._activeGenerators) {
      ac.abort();
    }

    // Close the WebSocket.
    if (this.ws) {
      try {
        this.ws.close(1000, 'transport disposed');
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
  }

  // -- Internal ----------------------------------------------------------

  private async ensureConnected(): Promise<void> {
    if (this._connected) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.connect();
    await this.initPromise;
  }

  private async connect(): Promise<void> {
    return new Promise<void>((resolveConnect, rejectConnect) => {
      const wsUrl = this.token
        ? `${this.wsUrl}?token=${encodeURIComponent(this.token)}`
        : this.wsUrl;

      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        this._connected = true;
        // Send initialize request.
        const initId = this.nextId++;
        const initReq: JsonRpcRequest = {
          jsonrpc: '2.0',
          id: initId,
          method: 'initialize',
          params: {
            clientInfo: { name: 'qwen-code-sdk', version: '1.0.0' },
          },
        };
        this.pending.set(initId, {
          resolve: (response) => {
            this.initResult = response.result;
            resolveConnect();
          },
          reject: (err) => rejectConnect(err),
        });
        ws.send(JSON.stringify(initReq));
      };

      ws.onmessage = (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(
            typeof event.data === 'string' ? event.data : String(event.data),
          );
        } catch {
          return; // ignore non-JSON messages
        }

        // JSON-RPC response (has `id` field).
        if ('id' in msg && typeof msg['id'] === 'number') {
          const pending = this.pending.get(msg['id'] as number);
          if (pending) {
            this.pending.delete(msg['id'] as number);
            pending.resolve(msg as unknown as JsonRpcResponse);
          }
          return;
        }

        // JSON-RPC notification (no `id` field, has `method`).
        if (
          'method' in msg &&
          typeof msg['method'] === 'string' &&
          msg['jsonrpc'] === '2.0'
        ) {
          const notification = msg as unknown as JsonRpcNotification;
          const event = denormalizeAcpNotification(notification);
          if (event) {
            for (const listener of this.notificationListeners) {
              try {
                listener(event);
              } catch {
                /* swallow listener errors */
              }
            }
          }
        }
      };

      ws.onerror = () => {
        // Node WebSocket may only fire 'error' without 'close' on
        // connection refused / unreachable. Reject the connect
        // promise so the caller doesn't hang forever.
        if (!this._connected) {
          rejectConnect(
            new DaemonTransportClosedError('WebSocket connection failed'),
          );
        }
      };

      ws.onclose = (event) => {
        this._connected = false;
        this.ws = null;
        this.initPromise = null;

        const closeError = new DaemonTransportClosedError(
          `WebSocket closed: ${event.code} ${event.reason}`,
        );

        // Reject all pending requests.
        for (const [, pending] of this.pending) {
          pending.reject(closeError);
        }
        this.pending.clear();

        // Abort all active generators so they throw instead of parking.
        for (const ac of this._activeGenerators) {
          ac.abort();
        }

        // If we never connected, reject the connect promise.
        if (!this._disposed) {
          rejectConnect(closeError);
        }
      };
    });
  }

  private sendNotification(
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.ws.send(JSON.stringify(msg));
  }

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<JsonRpcResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new DaemonTransportClosedError();
    }

    const id = this.nextId++;
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      // Wire abort signal: if the caller aborts a prompt request,
      // send a cancel notification.
      let onAbort: (() => void) | undefined;
      if (signal) {
        onAbort = () => {
          this.pending.delete(id);
          if (sessionId && method === 'session/prompt') {
            this.sendNotification('session/cancel', { sessionId });
          }
          reject(new DOMException('The operation was aborted', 'AbortError'));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(id, {
        resolve: (response) => {
          if (signal && onAbort) {
            signal.removeEventListener('abort', onAbort);
          }
          resolve(response);
        },
        reject: (err) => {
          if (signal && onAbort) {
            signal.removeEventListener('abort', onAbort);
          }
          reject(err);
        },
      });

      this.ws!.send(JSON.stringify(req));
    });
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
      // Groups 1..N are the captured segments.
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
  // JSON-RPC error code → HTTP status mapping.
  // -32600 = invalid request → 400
  // -32601 = method not found → 404
  // -32602 = invalid params → 400
  // -32603 = internal error → 500
  // -32700 = parse error → 400
  if (code === -32601) return 404;
  if (code === -32600 || code === -32602 || code === -32700) return 400;
  if (code === -32603) return 500;
  // Application-specific error codes. Use 500 as default.
  return code >= -32099 && code <= -32000 ? 500 : 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
