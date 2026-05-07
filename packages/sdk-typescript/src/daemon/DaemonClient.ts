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

  constructor(opts: DaemonClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
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
    let body: unknown = undefined;
    try {
      body = await res.json();
    } catch {
      try {
        body = await res.text();
      } catch {
        /* drop */
      }
    }
    const detail =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    return new DaemonHttpError(res.status, body, `${label}: ${detail}`);
  }

  // -- Lifecycle / discovery ---------------------------------------------

  async health(): Promise<{ status: string }> {
    const res = await this._fetch(`${this.baseUrl}/health`, {
      headers: this.headers(),
    });
    if (!res.ok) throw await this.failOnError(res, 'GET /health');
    return (await res.json()) as { status: string };
  }

  async capabilities(): Promise<DaemonCapabilities> {
    const res = await this._fetch(`${this.baseUrl}/capabilities`, {
      headers: this.headers(),
    });
    if (!res.ok) throw await this.failOnError(res, 'GET /capabilities');
    return (await res.json()) as DaemonCapabilities;
  }

  // -- Sessions ----------------------------------------------------------

  async createOrAttachSession(
    req: CreateSessionRequest,
  ): Promise<DaemonSession> {
    const res = await this._fetch(`${this.baseUrl}/session`, {
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
    const res = await this._fetch(
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
    const res = await this._fetch(
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
    const res = await this._fetch(
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
    if (!res.body) {
      throw new Error('SSE response has no body');
    }
    yield* parseSseStream(res.body);
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
    const res = await this._fetch(
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
