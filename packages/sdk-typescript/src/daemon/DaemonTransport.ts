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
