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
import {
  matchRoute,
  synthesizeResponse,
  jsonRpcErrorToHttpStatus,
  isRecord,
} from './acpTransportUtils.js';

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
// Constants
// ---------------------------------------------------------------------------

/** Maximum queued events per generator before drop-oldest. */
const MAX_GENERATOR_QUEUE_SIZE = 256;

/** Default timeout for the initialize handshake (ms). */
const INIT_TIMEOUT_MS = 30_000;

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
 *
 * **Browser limitation**: The browser WebSocket API does not support
 * custom headers on the upgrade request. In Node (>=22), the token
 * is passed via an `Authorization` header. In browser environments,
 * the transport connects without auth headers — callers must rely on
 * token-less loopback access or a proxy that injects auth. A future
 * enhancement may use a subprotocol or query-param based token
 * exchange for browser contexts.
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
  private initPromise: Promise<void> | undefined = undefined;

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
      const notifMeta = extractHeaderMeta(init.headers);
      if (notifMeta) {
        params._meta = {
          ...(isRecord(params._meta) ? params._meta : {}),
          ...notifMeta,
        };
      }
      this.sendNotification(mapping.method, params);
      return synthesizeResponse(204, null);
    }

    // Normal request-response.
    const params = mapping.extractParams(segments, body, httpMethod);

    // Forward per-request headers as JSON-RPC _meta so the server can
    // see X-Qwen-Client-Id and similar metadata that HTTP transports
    // carry natively.
    const headerMeta = extractHeaderMeta(init.headers);
    if (headerMeta) {
      params._meta = {
        ...(isRecord(params._meta) ? params._meta : {}),
        ...headerMeta,
      };
    }

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
    // Capped at MAX_GENERATOR_QUEUE_SIZE with drop-oldest to prevent
    // unbounded memory growth if the consumer is slow.
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
      // Drop oldest if queue is full.
      if (queue.length >= MAX_GENERATOR_QUEUE_SIZE) {
        queue.shift();
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

    // Reset on failure so the next call retries instead of parking
    // on a permanently rejected promise.
    this.initPromise = this.connect().catch((err) => {
      this.initPromise = undefined;
      throw err;
    });
    await this.initPromise;
  }

  private async connect(): Promise<void> {
    return new Promise<void>((resolveConnect, rejectConnect) => {
      // Pass token via Authorization header on the upgrade request.
      // Node >=22 supports an options object as the second argument:
      //   new WebSocket(url, { headers: { ... } })
      // The browser WebSocket API does NOT support custom headers —
      // in browser environments we connect without auth and rely on
      // loopback/proxy auth (see class JSDoc).
      const isBrowser =
        typeof globalThis.window !== 'undefined' &&
        typeof globalThis.window.document !== 'undefined';
      let ws: WebSocket;
      if (isBrowser || !this.token) {
        ws = new WebSocket(this.wsUrl);
      } else {
        // Node: cast through unknown because DOM typings only declare
        // (url, protocols?) — Node accepts an options bag.
        ws = new (WebSocket as unknown as new (
          url: string,
          opts?: { headers?: Record<string, string> },
        ) => WebSocket)(this.wsUrl, {
          headers: { Authorization: `Bearer ${this.token}` },
        });
      }
      this.ws = ws;

      // Timeout for the initialize handshake.
      const initTimeout = setTimeout(() => {
        ws.close(1002, 'Initialize timeout');
        rejectConnect(
          new DaemonTransportClosedError(
            `WebSocket initialize timed out after ${INIT_TIMEOUT_MS}ms`,
          ),
        );
      }, INIT_TIMEOUT_MS);

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
            clearTimeout(initTimeout);
            this.initResult = response.result;
            resolveConnect();
          },
          reject: (err) => {
            clearTimeout(initTimeout);
            rejectConnect(err);
          },
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
          const daemonEvent = denormalizeAcpNotification(notification);
          if (daemonEvent) {
            for (const listener of this.notificationListeners) {
              try {
                listener(daemonEvent);
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
          clearTimeout(initTimeout);
          rejectConnect(
            new DaemonTransportClosedError('WebSocket connection failed'),
          );
        }
      };

      ws.onclose = (event) => {
        clearTimeout(initTimeout);
        this._connected = false;
        this.ws = null;
        this.initPromise = undefined;

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

/** Headers forwarded from per-request `init.headers` into JSON-RPC `_meta`. */
const FORWARDED_HEADERS = ['x-qwen-client-id'] as const;

/**
 * Extract metadata-relevant headers from `RequestInit.headers` and
 * return them as a plain object suitable for merging into `_meta`.
 * Returns `undefined` when no relevant headers are present.
 */
function extractHeaderMeta(
  headers: HeadersInit | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;

  const meta: Record<string, string> = {};

  const get = (key: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(key) ?? undefined;
    if (Array.isArray(headers)) {
      const pair = headers.find(([k]) => k.toLowerCase() === key.toLowerCase());
      return pair ? pair[1] : undefined;
    }
    // Plain object
    const h = headers as Record<string, string>;
    for (const k of Object.keys(h)) {
      if (k.toLowerCase() === key.toLowerCase()) return h[k];
    }
    return undefined;
  };

  for (const hdr of FORWARDED_HEADERS) {
    const value = get(hdr);
    if (value !== undefined) {
      // Normalize header name to a camelCase _meta key.
      // 'x-qwen-client-id' → 'clientId'
      if (hdr === 'x-qwen-client-id') {
        meta['clientId'] = value;
      }
    }
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}
