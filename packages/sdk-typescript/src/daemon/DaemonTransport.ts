/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonEvent } from './types.js';

// ---------------------------------------------------------------------------
// Transport abstraction layer
// ---------------------------------------------------------------------------

/**
 * Options for {@link DaemonTransport.fetch}. Mirrors the subset of
 * per-call tuning knobs that `DaemonClient.fetchWithTimeout` supports.
 */
export interface DaemonTransportFetchOptions {
  /** Per-call timeout in ms. `0` = no timeout. */
  timeout?: number;
}

/**
 * Options for {@link DaemonTransport.subscribeEvents}. Mirrors
 * `DaemonClient.SubscribeOptions` — the transport layer consumes
 * these to build the appropriate wire representation (SSE query
 * params, JSON-RPC params, etc.).
 */
export interface DaemonTransportSubscribeOptions {
  /** Resume from after this event id (`Last-Event-ID` for REST/SSE). */
  lastEventId?: number;
  /** Per-subscriber backlog cap (SSE `?maxQueued=N`). */
  maxQueued?: number;
  /** Aborts the subscription cleanly. */
  signal?: AbortSignal;
  /**
   * Connect-phase timeout in ms. Applied to the initial request →
   * headers-received phase; the long-lived event body itself is NOT
   * timed. `0` or `undefined` = no connect timeout.
   */
  connectTimeoutMs?: number;
}

/** Transport type discriminant. */
export type DaemonTransportType = 'rest' | 'acp-http' | 'acp-ws';

/**
 * Pluggable transport for the daemon SDK.
 *
 * The default transport (`RestSseTransport`) speaks the existing
 * `qwen serve` REST+SSE surface. ACP transports (`AcpHttpTransport`,
 * `AcpWsTransport`) map the same URL-shaped calls to JSON-RPC over
 * HTTP or WebSocket, synthesizing standard `Response` objects so
 * `DaemonClient` needs no control-flow changes.
 */
export interface DaemonTransport {
  /**
   * Issue an HTTP-shaped request. REST transports delegate to the
   * underlying `fetch`; ACP transports translate the URL + body into
   * a JSON-RPC request and synthesize a `Response`.
   */
  fetch(
    url: string,
    init: RequestInit,
    opts?: DaemonTransportFetchOptions,
  ): Promise<Response>;

  /**
   * Open a session event stream. REST transports open an SSE
   * connection; ACP transports filter a shared notification stream
   * by session id.
   */
  subscribeEvents(
    sessionId: string,
    opts: DaemonTransportSubscribeOptions,
  ): AsyncGenerator<DaemonEvent>;

  /** Transport family discriminant. */
  readonly type: DaemonTransportType;

  /**
   * Whether this transport supports `Last-Event-ID` replay. SSE
   * transports return `true`; WebSocket transports return `false`
   * (notifications are fire-and-forget on the WS).
   */
  readonly supportsReplay: boolean;

  /**
   * Whether the underlying connection is currently open. Stateless
   * transports (REST) always return `true`.
   */
  readonly connected: boolean;

  /**
   * Release any underlying connection resources (WebSocket close,
   * SSE abort, etc.). Idempotent — safe to call multiple times.
   */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Transport errors
// ---------------------------------------------------------------------------

/**
 * Thrown when an operation is attempted on a transport whose
 * connection has been closed (disposed, WS close, etc.).
 */
export class DaemonTransportClosedError extends Error {
  constructor(message?: string) {
    super(message ?? 'Transport connection closed');
    this.name = 'DaemonTransportClosedError';
  }
}

// ---------------------------------------------------------------------------
// Transport negotiation
// ---------------------------------------------------------------------------

/** Options for {@link negotiateTransport}. */
export interface NegotiateTransportOptions {
  /** Timeout for the capabilities probe and WS handshake. Default 5000ms. */
  probeTimeoutMs?: number;
}

/**
 * Auto-detect the best available transport by probing the daemon's
 * `GET /capabilities` endpoint and inspecting the `transports` array.
 *
 * Preference order: `acp-ws` > `acp-http` > `rest`.
 *
 * For `acp-ws`, a WebSocket probe with timeout is performed. If the
 * probe fails (timeout, connection refused, etc.), the next-best
 * transport is tried.
 *
 * When the daemon's `/capabilities` response does not include a
 * `transports` field, the factory falls back to REST (the universal
 * baseline).
 *
 * Usage:
 * ```ts
 * const transport = await negotiateTransport(baseUrl, token);
 * const client = new DaemonClient({ baseUrl, token, transport });
 * ```
 */
export async function negotiateTransport(
  baseUrl: string,
  token?: string,
  opts?: NegotiateTransportOptions,
): Promise<DaemonTransport> {
  const fetchFn = globalThis.fetch.bind(globalThis);
  const probeTimeoutMs = opts?.probeTimeoutMs ?? 5_000;

  // Lazy imports to avoid circular module initialization. These
  // modules are always available at runtime (same package), but we
  // don't want to eagerly load ACP transports when the caller never
  // negotiates.
  const { RestSseTransport } = await import('./RestSseTransport.js');

  // Probe capabilities.
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let transports: string[] = [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), probeTimeoutMs);
    try {
      const res = await fetchFn(`${baseUrl}/capabilities`, {
        headers,
        signal: ctrl.signal,
      });
      if (res.ok) {
        const caps = (await res.json()) as {
          transports?: string[];
          [key: string]: unknown;
        };
        transports = Array.isArray(caps.transports) ? caps.transports : [];
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Probe failed — fall through to REST.
  }

  // Try best available in preference order.
  if (transports.includes('acp-ws')) {
    try {
      const { AcpWsTransport } = await import('./AcpWsTransport.js');
      // Convert http(s) → ws(s) for the WS URL.
      const wsUrl = baseUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
      const transport = new AcpWsTransport(wsUrl + '/acp', token);
      // Probe: try to connect with a timeout.
      const probeRes = await Promise.race([
        transport.fetch(`${baseUrl}/capabilities`, { method: 'GET' }),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), probeTimeoutMs),
        ),
      ]);
      if (probeRes) {
        return transport;
      }
      transport.dispose();
    } catch {
      // WS probe failed — try next.
    }
  }

  if (transports.includes('acp-http')) {
    try {
      const { AcpHttpTransport } = await import('./AcpHttpTransport.js');
      return new AcpHttpTransport(baseUrl, token, fetchFn);
    } catch {
      // ACP-HTTP creation failed — fall back to REST.
    }
  }

  // Universal fallback.
  return new RestSseTransport(baseUrl, token, fetchFn);
}
