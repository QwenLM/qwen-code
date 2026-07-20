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
import { DaemonHttpError } from './DaemonHttpError.js';
import { parseSseStream } from './sse.js';

/**
 * Default REST+SSE transport. Delegates `fetch()` to the underlying
 * `_fetch` callable and implements `subscribeEvents()` by opening an
 * SSE connection to `GET /session/:id/events`.
 *
 * This is the transport `DaemonClient` uses when no explicit transport
 * is provided — it exactly reproduces the pre-abstraction behavior.
 */
export class RestSseTransport implements DaemonTransport {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly _fetch: typeof globalThis.fetch;
  private _disposed = false;

  readonly type = 'rest' as const;
  readonly supportsReplay = true;
  readonly restFetch: typeof globalThis.fetch;

  constructor(
    baseUrl: string,
    token: string | undefined,
    fetchFn: typeof globalThis.fetch,
  ) {
    this.baseUrl = baseUrl;
    this.token = token;
    this._fetch = fetchFn;
    this.restFetch = fetchFn;
  }

  get connected(): boolean {
    return !this._disposed;
  }

  async fetch(
    url: string,
    init: RequestInit,
    _opts?: DaemonTransportFetchOptions,
  ): Promise<Response> {
    if (this._disposed) {
      throw new DaemonTransportClosedError();
    }
    return this._fetch(url, init);
  }

  /**
   * Open an SSE stream for the given session. Mirrors the inline
   * logic that previously lived in `DaemonClient.subscribeEvents`:
   *   - connect-phase timeout via AbortController
   *   - `Last-Event-ID` header
   *   - `?maxQueued=N` query param
   *   - content-type validation
   *   - delegation to `parseSseStream`
   */
  async *subscribeEvents(
    sessionId: string,
    opts: DaemonTransportSubscribeOptions = {},
  ): AsyncGenerator<DaemonEvent> {
    if (this._disposed) {
      throw new DaemonTransportClosedError();
    }

    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    if (opts.lastEventId !== undefined) {
      headers['Last-Event-ID'] = String(opts.lastEventId);
    }

    // Request-lifetime controller. It drives the connect-phase timeout
    // (request → headers received) AND owns teardown of the long-lived
    // SSE body: aborting it in the `finally` around the `yield*` below
    // releases the underlying fetch/TCP connection when the consumer
    // exits the iterator for any reason (break, return, throw, or normal
    // end), even when no caller signal was supplied. Without this,
    // `reader.cancel()` alone does not reliably close the connection on
    // some runtimes (e.g. Bun), leaking the daemon-side EventBus
    // subscriber. The SSE body must NOT be timed out, so the connect
    // timer only fires before headers arrive.
    const requestCtrl = new AbortController();
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    const connectTimeoutMs = opts.connectTimeoutMs;
    if (connectTimeoutMs && Number.isFinite(connectTimeoutMs)) {
      connectTimer = setTimeout(
        () =>
          requestCtrl.abort(
            new DOMException('Initial connect timed out', 'TimeoutError'),
          ),
        connectTimeoutMs,
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
      ? composeAbortSignals([opts.signal, requestCtrl.signal])
      : requestCtrl.signal;

    // Build the SSE URL, optionally with `?maxQueued=N`.
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
      // Read the error body for the caller.
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
      throw new DaemonHttpError(
        res.status,
        body,
        `GET /session/:id/events: ${detail}`,
      );
    }

    // Content-type validation — a misconfigured proxy that swallows
    // the SSE response would otherwise silently produce zero frames.
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes('text/event-stream')) {
      try {
        await res.body?.cancel();
      } catch {
        /* body already consumed or no body */
      }
      throw new DaemonHttpError(
        res.status,
        ct,
        `GET /session/:id/events: expected content-type text/event-stream, got "${ct}"`,
      );
    }

    if (!res.body) {
      throw new Error('No SSE body');
    }

    // Pass the composed signal (caller + request controller) to the
    // parser, and abort the request controller when the iterator exits
    // for any reason. This tears down the underlying fetch/TCP
    // connection and releases the daemon EventBus subscriber regardless
    // of whether the caller supplied `opts.signal`.
    try {
      yield* parseSseStream(res.body, fetchSignal);
    } finally {
      requestCtrl.abort();
    }
  }

  dispose(): void {
    this._disposed = true;
  }
}

// ---------------------------------------------------------------------------
// Minimal abort-signal composition (same logic as DaemonClient's
// `composeAbortSignals` but kept transport-local to avoid a circular
// import). REST is the only transport that needs this inline; the ACP
// transports compose differently.
// ---------------------------------------------------------------------------

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
