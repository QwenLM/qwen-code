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
   * Per-call request timeout in milliseconds. Applied to short-lived
   * methods (`health`, `capabilities`, `createOrAttachSession`,
   * `listWorkspaceSessions`, `setSessionModel`, `cancel`,
   * `respondToPermission`) so an unresponsive daemon doesn't block
   * callers indefinitely. **NOT** applied to `prompt()` — model + tool
   * turns can take minutes, so prompt explicitly bypasses
   * `fetchTimeoutMs`; cancellation is via the optional `signal` arg.
   * Streaming (`subscribeEvents`) is similarly excluded for the
   * long-lived SSE body, though it does apply `fetchTimeoutMs` to the
   * initial connect phase (request → headers received).
   * Defaults to 30s. Set to `0` or `Infinity` to disable.
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
  /**
   * Workspace path the daemon must be bound to (per #3803 §02). When
   * omitted, the SDK sends no `cwd` field and the daemon route falls
   * back to its boot-time `boundWorkspace`. Pass `caps.workspaceCwd`
   * to be explicit, or omit it for the daemon-knows-best path. A
   * non-empty `workspaceCwd` that doesn't canonicalize to the
   * daemon's bound path yields a `400 workspace_mismatch`
   * `DaemonHttpError`.
   */
  workspaceCwd?: string;
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
    // Coerce non-positive / non-finite to 0 (= disabled). Without this
    // a caller passing `-1` or `NaN` would slip past the
    // `Number.isFinite` check inside `fetchWithTimeout` (NaN fails
    // isFinite, negatives pass) and either short-circuit timeout entirely
    // or fire `setTimeout(-1)` → immediate abort, killing every request
    // before it could complete. The `0` sentinel is the documented
    // disable value, so we collapse all "doesn't make sense" inputs onto
    // it instead of defending the math at every call site.
    const raw = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.fetchTimeoutMs = Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  /**
   * Wrap a fetch call with the per-client `fetchTimeoutMs`. If the caller
   * passes their own `signal`, both signals abort the request via
   * `AbortSignal.any`, so caller cancellation and the per-call timeout
   * compose. Streaming endpoints (subscribeEvents) call `_fetch` directly
   * to skip the timeout — long-lived SSE connections must not be killed
   * by it.
   */
  private async fetchWithTimeout<T = Response>(
    url: string,
    init: RequestInit = {},
    consume?: (res: Response) => Promise<T>,
  ): Promise<T> {
    // BRN1o: when `consume` is provided, the timer must remain
    // armed through the entire callback (body read + parse). The
    // previous `Response`-returning shape cleared the timer the
    // moment headers arrived, so `await res.json()` against a
    // proxy that stalled mid-body could hang indefinitely past
    // `fetchTimeoutMs`. Pass the body-reading code as a callback
    // so its execution is included in the timer scope; the
    // composed abort signal still flows through to fetch's body
    // stream, so an in-progress `res.json()` rejects cleanly when
    // the timer fires.
    if (!this.fetchTimeoutMs || !Number.isFinite(this.fetchTimeoutMs)) {
      const res = await this._fetch(url, init);
      if (consume) return consume(res);
      return res as unknown as T;
    }
    // Use AbortController + cancellable setTimeout instead of
    // `AbortSignal.timeout()` (the polyfill `abortTimeout` is the
    // same shape — fires once, never disarms). On a fast-resolving
    // request with a long `fetchTimeoutMs` (e.g. 30s default), the
    // pending timer keeps the event loop registration alive even
    // after the fetch already returned. High request volume × long
    // timeout = accumulating timers + retained closures. Clearing
    // in `finally` releases each timer the moment its fetch (and
    // body consume callback, if any) settles.
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort(new DOMException('The operation timed out', 'TimeoutError'));
    }, this.fetchTimeoutMs);
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    const callerSignal = init.signal ?? undefined;
    const signal = callerSignal
      ? composeAbortSignals([callerSignal, ctrl.signal])
      : ctrl.signal;
    try {
      const res = await this._fetch(url, { ...init, signal });
      if (consume) return await consume(res);
      return res as unknown as T;
    } finally {
      clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
    }
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
    return await this.fetchWithTimeout(
      `${this.baseUrl}/health`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, 'GET /health');
        return (await res.json()) as { status: string };
      },
    );
  }

  async capabilities(): Promise<DaemonCapabilities> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/capabilities`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, 'GET /capabilities');
        return (await res.json()) as DaemonCapabilities;
      },
    );
  }

  // -- Sessions ----------------------------------------------------------

  async createOrAttachSession(
    req: CreateSessionRequest,
  ): Promise<DaemonSession> {
    // Per #3803 §02: omitting `cwd` lets the daemon fall back to its
    // bound workspace. JSON.stringify strips `undefined` values, so
    // `cwd: undefined` becomes "no `cwd` key" on the wire — and the
    // server then takes the documented fallback path.
    //
    // Send EVERY defined `workspaceCwd` value through as-is, including
    // the empty string. A truthy guard would silently swallow
    // `workspaceCwd: ""` (a likely client-side bug) and let the server
    // fall back instead of returning a clear 400 for the malformed
    // input. The SDK should be a transparent layer here: passing the
    // caller's value verbatim lets the server's validation surface
    // bugs that would otherwise hide as "wrong workspace bound".
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          cwd: req.workspaceCwd,
          ...(req.modelServiceId ? { modelServiceId: req.modelServiceId } : {}),
        }),
      },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, 'POST /session');
        return (await res.json()) as DaemonSession;
      },
    );
  }

  /**
   * Enumerate live sessions in the given workspace. Used by session-picker
   * UIs. Returns an empty list (not 404) when the workspace has no sessions.
   */
  async listWorkspaceSessions(
    workspaceCwd: string,
  ): Promise<DaemonSessionSummary[]> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/${encodeURIComponent(workspaceCwd)}/sessions`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/:id/sessions');
        }
        const body = (await res.json()) as {
          sessions: DaemonSessionSummary[];
        };
        return body.sessions;
      },
    );
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
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/model`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ modelId }),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /session/:id/model');
        }
        return (await res.json()) as SetModelResult;
      },
    );
  }

  /**
   * Send a prompt to the agent. Long-lived: a model + tool turn can
   * take minutes, so this method bypasses `fetchTimeoutMs` (which
   * would force a default 30s deadline that's too short for normal
   * use). Cancellation is via the optional `signal` — when it fires,
   * the daemon receives the underlying TCP close and forwards an
   * ACP `cancel` notification to the agent, resolving the prompt
   * with `stopReason: 'cancelled'`. `cancel(sessionId)` is the
   * out-of-band alternative.
   */
  async prompt(
    sessionId: string,
    req: PromptRequest,
    signal?: AbortSignal,
  ): Promise<PromptResult> {
    const res = await this._fetch(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/prompt`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(req),
        signal,
      },
    );
    if (!res.ok) throw await this.failOnError(res, 'POST /session/:id/prompt');
    return (await res.json()) as PromptResult;
  }

  async cancel(sessionId: string): Promise<void> {
    await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/cancel`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: '{}',
      },
      async (res) => {
        if (!res.ok && res.status !== 204) {
          throw await this.failOnError(res, 'POST /session/:id/cancel');
        }
        // Drain so undici doesn't keep the socket pinned waiting for
        // the consumer (matches the respondToPermission rationale).
        try {
          await res.body?.cancel();
        } catch {
          /* body already consumed or no body */
        }
      },
    );
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
    // Apply `fetchTimeoutMs` to the CONNECT phase only (request → headers
    // received). The SSE body itself must NOT be timed out — it's
    // long-lived by design — so once `_fetch` returns the timer is
    // cleared. Without this, an unresponsive daemon (TCP open but no
    // headers) blocks `subscribeEvents` indefinitely instead of
    // failing with the same 30s default the rest of the SDK uses.
    const connectCtrl = new AbortController();
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    if (this.fetchTimeoutMs && Number.isFinite(this.fetchTimeoutMs)) {
      connectTimer = setTimeout(
        () =>
          connectCtrl.abort(
            new DOMException('Initial connect timed out', 'TimeoutError'),
          ),
        this.fetchTimeoutMs,
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
      res = await this._fetch(
        `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/events`,
        { headers, signal: fetchSignal },
      );
    } finally {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
    }
    if (!res.ok) {
      throw await this.failOnError(res, 'GET /session/:id/events');
    }
    // A 200 with the wrong content type usually means a misconfigured
    // proxy or middleware swallowed our SSE response and replaced it
    // with JSON/HTML. Without this check `parseSseStream` would
    // silently produce zero frames — a confusing "no events" symptom
    // that's easy to misdiagnose. Fail fast with the actual mime type.
    //
    // Cancel the body before throwing so undici doesn't keep the
    // underlying socket pinned waiting for the consumer. Same
    // reasoning as `respondToPermission` — long-running clients
    // hitting this path repeatedly would otherwise exhaust the
    // connection pool.
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
    return await this.fetchWithTimeout(
      `${this.baseUrl}/permission/${encodeURIComponent(requestId)}`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(response),
      },
      async (res) => {
        if (res.status === 200) {
          // Drain the body so undici doesn't keep the underlying socket
          // pinned waiting for the consumer. On long-running clients with
          // frequent permission votes this would exhaust the connection
          // pool. Use `res.body?.cancel()` rather than `await res.json()`
          // because the daemon returns `{}` (no useful payload here) and
          // cancel is cheaper than a parse round-trip.
          try {
            await res.body?.cancel();
          } catch {
            /* body already consumed or no body */
          }
          return true;
        }
        if (res.status === 404) {
          try {
            await res.body?.cancel();
          } catch {
            /* body already consumed or no body */
          }
          return false;
        }
        throw await this.failOnError(res, 'POST /permission/:requestId');
      },
    );
  }
}

/**
 * `AbortSignal.timeout` is in every Node version this package supports
 * (`engines.node >=22.0.0` ships it natively). The feature-detect below
 * is defensive against non-Node runtimes — browsers / edge workers /
 * stripped-down V8 hosts that may consume the SDK and ship an
 * incomplete `AbortSignal` shape.
 */
// Exported solely for direct unit testing — production callers go
// through `fetchWithTimeout` above. The polyfill branch only fires on
// runtimes where `AbortSignal.timeout` isn't natively available
// (non-Node hosts), which can't easily be exercised from the public
// API surface in unit tests.
export function abortTimeout(ms: number): AbortSignal {
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
  // Native `AbortSignal.timeout()` aborts with a DOMException whose
  // `name === 'TimeoutError'` (per WHATWG). Constructor signature is
  // `new DOMException(message, name)` — calling `new DOMException(
  // 'TimeoutError')` would set the *message* to "TimeoutError" and
  // leave `name` at its default ("Error"), so callers doing
  // `if (err.name === 'TimeoutError')` would see the polyfill
  // differently from the native runtime.
  const handle = setTimeout(
    () =>
      ctrl.abort(new DOMException('The operation timed out', 'TimeoutError')),
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
 * `AbortSignal.any` is available natively in every Node version this
 * package supports (`engines.node >=22.0.0` ships it). The polyfill
 * branch below is defensive against non-Node runtimes (browsers /
 * edge workers / stripped-down V8 hosts) that may consume the SDK
 * and lack `AbortSignal.any` — without it those callers would throw
 * `TypeError: AbortSignal.any is not a function` on every
 * non-streaming method.
 *
 * The polyfill creates a fresh controller and forwards the first abort
 * from any input signal, including any that are already aborted at call
 * time. It does NOT support every native edge-case (cleanup of remaining
 * listeners after the first fire is best-effort), but for `fetch`-style
 * single-shot use the difference is invisible.
 */
// Exported solely for direct unit testing — see note on `abortTimeout`.
export function composeAbortSignals(signals: AbortSignal[]): AbortSignal {
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
