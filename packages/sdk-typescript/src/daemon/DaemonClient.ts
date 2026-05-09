/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseSseStream } from './sse.js';
import type {
  DaemonCapabilities,
  DaemonEvent,
  DaemonSession,
  DaemonSessionSummary,
  PermissionResponse,
  PromptContentBlock,
  PromptResult,
  SetModelResult,
} from './types.js';

/**
 * SDK-side HTTP client for the `qwen serve` daemon. Sibling to
 * `ProcessTransport`: ProcessTransport drives a stdio child running
 * `qwen --input-format stream-json`; DaemonClient hits the daemon's HTTP
 * routes (POST /session, POST /session/:id/prompt, GET /session/:id/events,
 * etc.) and yields ACP-flavored events.
 *
 * The two surfaces are NOT interchangeable — they speak different protocols
 * (stream-json vs ACP NDJSON). DaemonClient lives alongside ProcessTransport
 * so applications that want daemon-mode (cross-client attach, shared MCP
 * pool, network reachability) can opt in without disturbing the existing
 * `query()` flow that subprocess-mode users rely on.
 */
export interface DaemonClientOptions {
  /** Daemon base URL (e.g. `http://127.0.0.1:4170`). Trailing slash is stripped. */
  baseUrl: string;
  /** Bearer token; required for non-loopback daemon binds. */
  token?: string;
  /**
   * Override the global `fetch` for tests. Defaults to `globalThis.fetch`.
   * Note: AbortController/AbortSignal must be Node-native for the default
   * to work (jsdom's polyfill is incompatible with undici).
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Per-call request timeout in milliseconds. Applied to every non-streaming
   * method (createOrAttachSession, prompt, setSessionModel, cancel, …) so
   * an unresponsive daemon doesn't block callers indefinitely. Streaming
   * (`subscribeEvents`) is intentionally excluded — SSE connections are
   * long-lived; cancellation is via `opts.signal`. Defaults to 30s. Set to
   * `0` or `Infinity` to disable.
   */
  fetchTimeoutMs?: number;
}

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Strip any trailing slashes from a base URL via plain string ops. The
 * obvious `replace(/\/+$/, '')` is technically linear here (the regex is
 * end-anchored), but CodeQL's ReDoS detector flags any `\/+$` pattern as a
 * polynomial-regex risk on attacker-controlled input. Hand-rolling the loop
 * sidesteps the rule entirely.
 */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f /* '/' */) end--;
  return end === url.length ? url : url.slice(0, end);
}

/**
 * Thrown for any non-2xx daemon response. `status` and `body` are surfaced
 * so callers can branch on the standard daemon HTTP semantics (404 missing
 * session, 401 bad token, 400 malformed body, 500 agent failure).
 */
export class DaemonHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'DaemonHttpError';
    this.status = status;
    this.body = body;
  }
}

export interface CreateSessionRequest {
  workspaceCwd: string;
  modelServiceId?: string;
}

export interface PromptRequest {
  prompt: PromptContentBlock[];
  /** Optional ACP _meta passthrough. */
  _meta?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface SubscribeOptions {
  /** Resume from after this event id (`Last-Event-ID` header). */
  lastEventId?: number;
  /** Aborts the subscription cleanly. */
  signal?: AbortSignal;
}

export class DaemonClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly fetchTimeoutMs: number;

  constructor(opts: DaemonClientOptions) {
    this.baseUrl = stripTrailingSlashes(opts.baseUrl);
    this.token = opts.token;
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  /**
   * Wrap a fetch call with the per-client `fetchTimeoutMs`. If the caller
   * passes their own `signal`, both signals abort the request via
   * `AbortSignal.any`, so caller cancellation and the per-call timeout
   * compose. Streaming endpoints (subscribeEvents) call `_fetch` directly
   * to skip the timeout — long-lived SSE connections must not be killed
   * by it.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    if (!this.fetchTimeoutMs || !Number.isFinite(this.fetchTimeoutMs)) {
      return await this._fetch(url, init);
    }
    const timeoutSignal = abortTimeout(this.fetchTimeoutMs);
    const callerSignal = init.signal ?? undefined;
    const signal = callerSignal
      ? composeAbortSignals([callerSignal, timeoutSignal])
      : timeoutSignal;
    return await this._fetch(url, { ...init, signal });
  }

  // -- Plumbing -----------------------------------------------------------

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const out: Record<string, string> = { ...extra };
    if (this.token) out['Authorization'] = `Bearer ${this.token}`;
    return out;
  }

  private async failOnError(
    res: Response,
    label: string,
  ): Promise<DaemonHttpError> {
    // Read the body exactly once. `res.json()` consumes the stream even on
    // parse-failure, leaving a subsequent `res.text()` empty — so go via
    // text() and attempt JSON parsing ourselves; raw text is a useful
    // fallback (the daemon may surface text/plain on upstream errors).
    let body: unknown = undefined;
    try {
      const text = await res.text();
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
    } catch {
      /* body unreadable */
    }
    const detail =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    return new DaemonHttpError(res.status, body, `${label}: ${detail}`);
  }

  // -- Lifecycle / discovery ---------------------------------------------

  async health(): Promise<{ status: string }> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/health`, {
      headers: this.headers(),
    });
    if (!res.ok) throw await this.failOnError(res, 'GET /health');
    return (await res.json()) as { status: string };
  }

  async capabilities(): Promise<DaemonCapabilities> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/capabilities`, {
      headers: this.headers(),
    });
    if (!res.ok) throw await this.failOnError(res, 'GET /capabilities');
    return (await res.json()) as DaemonCapabilities;
  }

  // -- Sessions ----------------------------------------------------------

  async createOrAttachSession(
    req: CreateSessionRequest,
  ): Promise<DaemonSession> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        cwd: req.workspaceCwd,
        ...(req.modelServiceId ? { modelServiceId: req.modelServiceId } : {}),
      }),
    });
    if (!res.ok) throw await this.failOnError(res, 'POST /session');
    return (await res.json()) as DaemonSession;
  }

  /**
   * Enumerate live sessions in the given workspace. Used by session-picker
   * UIs. Returns an empty list (not 404) when the workspace has no sessions.
   */
  async listWorkspaceSessions(
    workspaceCwd: string,
  ): Promise<DaemonSessionSummary[]> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/${encodeURIComponent(workspaceCwd)}/sessions`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      throw await this.failOnError(res, 'GET /workspace/:id/sessions');
    }
    const body = (await res.json()) as { sessions: DaemonSessionSummary[] };
    return body.sessions;
  }

  /**
   * Switch the active model for a session. Backed by ACP's currently-unstable
   * `unstable_setSessionModel`; the daemon also publishes a `model_switched`
   * event so cross-client UIs can update.
   */
  async setSessionModel(
    sessionId: string,
    modelId: string,
  ): Promise<SetModelResult> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/model`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ modelId }),
      },
    );
    if (!res.ok) throw await this.failOnError(res, 'POST /session/:id/model');
    return (await res.json()) as SetModelResult;
  }

  // `prompt` is intentionally exempt from `fetchTimeoutMs` — the request
  // is long-lived (model + tool turns can take minutes). Callers who
  // want cancellation should pass an `AbortSignal` (we'd add one to
  // PromptRequest in a follow-up) or rely on `cancel(sessionId)`.
  async prompt(sessionId: string, req: PromptRequest): Promise<PromptResult> {
    const res = await this._fetch(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/prompt`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(req),
      },
    );
    if (!res.ok) throw await this.failOnError(res, 'POST /session/:id/prompt');
    return (await res.json()) as PromptResult;
  }

  async cancel(sessionId: string): Promise<void> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/cancel`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: '{}',
      },
    );
    if (!res.ok && res.status !== 204) {
      throw await this.failOnError(res, 'POST /session/:id/cancel');
    }
  }

  // -- Events stream -----------------------------------------------------

  async *subscribeEvents(
    sessionId: string,
    opts: SubscribeOptions = {},
  ): AsyncGenerator<DaemonEvent> {
    const headers = this.headers({ Accept: 'text/event-stream' });
    if (opts.lastEventId !== undefined) {
      headers['Last-Event-ID'] = String(opts.lastEventId);
    }
    const res = await this._fetch(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/events`,
      { headers, signal: opts.signal },
    );
    if (!res.ok) {
      throw await this.failOnError(res, 'GET /session/:id/events');
    }
    // A 200 with the wrong content type usually means a misconfigured
    // proxy or middleware swallowed our SSE response and replaced it
    // with JSON/HTML. Without this check `parseSseStream` would
    // silently produce zero frames — a confusing "no events" symptom
    // that's easy to misdiagnose. Fail fast with the actual mime type.
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes('text/event-stream')) {
      throw new DaemonHttpError(
        res.status,
        ct,
        `GET /session/:id/events: expected content-type text/event-stream, got "${ct}"`,
      );
    }
    if (!res.body) {
      throw new Error('SSE response has no body');
    }
    // Forward the abort signal so post-200 aborts stop the iteration.
    // Without this, callers who `controller.abort()` after the response
    // arrives keep receiving frames until the upstream closes.
    yield* parseSseStream(res.body, opts.signal);
  }

  // -- Permissions -------------------------------------------------------

  /**
   * Cast a permission vote. Returns true when the daemon accepted the vote,
   * false on 404 (request unknown or already resolved by another client —
   * the typical "lost the race" outcome under multi-client fan-out).
   */
  async respondToPermission(
    requestId: string,
    response: PermissionResponse,
  ): Promise<boolean> {
    const res = await this.fetchWithTimeout(
      `${this.baseUrl}/permission/${encodeURIComponent(requestId)}`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(response),
      },
    );
    if (res.status === 200) return true;
    if (res.status === 404) {
      // Drain the body so the connection can be reused; ignore the payload.
      try {
        await res.json();
      } catch {
        /* body already consumed or empty */
      }
      return false;
    }
    throw await this.failOnError(res, 'POST /permission/:requestId');
  }
}

/**
 * `AbortSignal.timeout` is in Node 17.3+ — within our `>=18` engines floor —
 * but exposed as `static` on `AbortSignal`, so cautious feature-detect plus
 * a polyfill keeps us honest if a runtime ships a stripped-down `AbortSignal`.
 */
function abortTimeout(ms: number): AbortSignal {
  const tFn = (
    AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }
  ).timeout;
  if (typeof tFn === 'function') return tFn.call(AbortSignal, ms);
  const ctrl = new AbortController();
  // `.unref()` so a fast-resolving fetch doesn't keep the event loop
  // alive waiting for this timer to fire (the call is `await`-ed so
  // a long-lived event loop is the caller's problem, not ours).
  // Also clear the timer when the controller aborts via another path
  // (the composed callerSignal aborts first) so we don't accumulate
  // pending timers across many fast calls in the polyfill path.
  const handle = setTimeout(
    () => ctrl.abort(new DOMException('TimeoutError')),
    ms,
  );
  if (typeof handle === 'object' && handle && 'unref' in handle) {
    (handle as { unref: () => void }).unref();
  }
  ctrl.signal.addEventListener(
    'abort',
    () => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
    { once: true },
  );
  return ctrl.signal;
}

/**
 * `AbortSignal.any` was added in Node 20.3, but the SDK declares
 * `engines.node >=18.0.0`. Without this polyfill, every non-streaming call
 * would throw `TypeError: AbortSignal.any is not a function` on Node 18.0–
 * 20.2 and the SDK would be unusable on its own declared minimum runtime.
 *
 * The polyfill creates a fresh controller and forwards the first abort
 * from any input signal, including any that are already aborted at call
 * time. It does NOT support every native edge-case (cleanup of remaining
 * listeners after the first fire is best-effort), but for `fetch`-style
 * single-shot use the difference is invisible.
 */
function composeAbortSignals(signals: AbortSignal[]): AbortSignal {
  const anyFn = (
    AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }
  ).any;
  if (typeof anyFn === 'function') return anyFn.call(AbortSignal, signals);
  const ctrl = new AbortController();
  // Track per-input listener so we can detach them all on the FIRST
  // abort (whichever input fires). Without this, callers who reuse a
  // long-lived AbortSignal (e.g. a session-scope cancel signal that
  // never fires for the lifetime of the SDK client) accumulate one
  // listener per SDK call — slow leak that retains the closure +
  // controller of every prior call.
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
  // Also detach if our composed controller aborts via some other path
  // (e.g. its consumer aborted independently — defense-in-depth).
  ctrl.signal.addEventListener('abort', detachAll, { once: true });
  return ctrl.signal;
}
