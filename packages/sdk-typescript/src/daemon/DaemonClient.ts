/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MCP_RESTART_SERVER_DEADLINE_MS,
  MCP_RESTART_CLIENT_HEADROOM_MS,
} from '@qwen-code/acp-bridge/mcpTimeouts';
import { DaemonAuthFlow } from './DaemonAuthFlow.js';
import { DaemonHttpError } from './DaemonHttpError.js';
import type { DaemonTransport } from './DaemonTransport.js';
import { RestSseTransport } from './RestSseTransport.js';
import type {
  DaemonAgentMutationResult,
  DaemonAuthProviderId,
  DaemonAuthProviderCatalog,
  DaemonAuthProviderInstallRequest,
  DaemonAuthProviderInstallResult,
  DaemonAuthStatusSnapshot,
  DaemonCapabilities,
  DaemonCreateAgentRequest,
  DaemonGeneratedAgentContent,
  DaemonDeviceFlowStartResult,
  DaemonDeviceFlowState,
  DaemonEvent,
  DaemonSessionContextStatus,
  DaemonSessionContextUsageStatus,
  BranchSessionRequest,
  DaemonBranchedSession,
  DaemonRestoredSession,
  DaemonSession,
  DaemonSessionSummary,
  DaemonSessionSupportedCommandsStatus,
  DaemonSessionStatsStatus,
  DaemonSessionTaskStatus,
  DaemonSessionTasksStatus,
  DaemonUpdateAgentRequest,
  DaemonWorkspaceFile,
  DaemonWorkspaceFileBytes,
  DaemonWorkspaceFileEditRequest,
  DaemonWorkspaceFileEditResult,
  DaemonWorkspaceFileWriteRequest,
  DaemonWorkspaceFileWriteResult,
  DaemonWorkspaceAgentDetail,
  DaemonWorkspaceAgentsStatus,
  DaemonWorkspaceEnvStatus,
  DaemonWorkspaceMcpStatus,
  DaemonWorkspaceMcpToolsStatus,
  DaemonWorkspaceMemoryStatus,
  DaemonWorkspacePreflightStatus,
  DaemonWorkspaceProvidersStatus,
  DaemonWorkspaceSkillsStatus,
  DaemonWorkspaceToolsStatus,
  DaemonWriteMemoryRequest,
  DaemonWriteMemoryResult,
  HeartbeatResult,
  PermissionResponse,
  PromptContentBlock,
  PromptResult,
  SetModelResult,
  SetSessionLanguageResult,
  SessionMetadataResult,
  DaemonApprovalMode,
  DaemonApprovalModeResult,
  DaemonInitWorkspaceResult,
  DaemonMcpRestartResult,
  DaemonReloadResponse,
  DaemonMcpManageAction,
  DaemonMcpManageResult,
  DaemonSessionBtwResult,
  DaemonSessionRecapResult,
  DaemonShellCommandResult,
  DaemonRuntimeMcpAddRequest,
  DaemonRuntimeMcpAddResult,
  DaemonRuntimeMcpRemoveResult,
  DaemonToolToggleResult,
  DaemonRewindSnapshotInfo,
  DaemonRewindResult,
  DaemonSessionHooksStatus,
  DaemonWorkspaceExtensionsStatus,
  DaemonWorkspaceHooksStatus,
  DaemonWorkspaceSettingsStatus,
  DaemonSettingUpdateResult,
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
   * `listWorkspaceSessions`, read-only status routes, `setSessionModel`,
   * `cancel`, `respondToPermission`) so an unresponsive daemon doesn't block
   * callers indefinitely. **NOT** applied to `prompt()` — model + tool
   * turns can take minutes, so prompt explicitly bypasses
   * `fetchTimeoutMs`; cancellation is via the optional `signal` arg.
   * Streaming (`subscribeEvents`) is similarly excluded for the
   * long-lived SSE body, though it does apply `fetchTimeoutMs` to the
   * initial connect phase (request → headers received).
   * Defaults to 30s. Set to `0` or `Infinity` to disable.
   */
  fetchTimeoutMs?: number;
  /**
   * Per-session cap on local `prompt()` calls that have been admitted but
   * not completed. For 202 daemons the slot is held until the temporary
   * SSE wait finishes. Defaults to 5. Set to `0` or `Infinity` to
   * disable; `null` is accepted for direct
   * `/capabilities.limits` passthrough.
   */
  maxPendingPromptsPerSession?: number | null;
  /**
   * Pluggable transport. When omitted, a `RestSseTransport` is created
   * automatically — this preserves the existing REST+SSE behavior with
   * zero caller-side changes. Pass an `AcpWsTransport` or
   * `AcpHttpTransport` to use JSON-RPC over WebSocket or HTTP.
   */
  transport?: DaemonTransport;
}

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
// Keep in sync with acp-bridge bridge.ts and CLI serve/server.ts.
const DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION = 5;
// Server deadline + headroom so the client never races the daemon's own budget.
const MCP_RESTART_DEFAULT_TIMEOUT_MS =
  MCP_RESTART_SERVER_DEADLINE_MS + MCP_RESTART_CLIENT_HEADROOM_MS;
const CLIENT_ID_HEADER = 'X-Qwen-Client-Id';

export function normalizePendingPromptLimit(
  value: number | null | undefined,
): number {
  if (value === undefined) return DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION;
  if (value === null || value === 0 || value === Infinity) {
    return Infinity;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError('bad maxPendingPromptsPerSession');
  }
  return value;
}

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
 * SDK env fallback for the daemon bearer token. Mirrors the daemon-side
 * `--token` CLI fallback to `QWEN_SERVER_TOKEN` so a developer with
 * `export QWEN_SERVER_TOKEN=...` in their shell never has to thread the
 * value through every `DaemonClient` construction.
 *
 * Defensive on three axes:
 *   1. **Browser-safe**: `globalThis.process` indirection. The SDK is
 *      imported by `@qwen-code/webui`; a literal
 *      `process.env[...]` would explode at module load on browser
 *      bundles. Browser globals don't expose `process` so this returns
 *      `undefined` cleanly there.
 *   2. **Whitespace stripped**: matches the daemon-side trim behavior
 *      documented in the `qwen-serve` user guide under the CLI flags
 *      section — handy for `$(cat token.txt)` that produces a trailing
 *      newline.
 *   3. **Empty / whitespace-only treated as unset**: a stale
 *      `export QWEN_SERVER_TOKEN=""` would otherwise let the
 *      Authorization header through as `Bearer ` (no token), which
 *      the daemon rejects but is confusing to debug. Returning
 *      `undefined` here means the constructor's `?? readTokenFromEnv()`
 *      fallback chain treats both "unset" and "set-but-empty"
 *      identically — no header sent.
 */
function readTokenFromEnv(): string | undefined {
  try {
    const proc = (
      globalThis as {
        process?: { env?: Record<string, string | undefined> };
      }
    ).process;
    const raw = proc?.env?.['QWEN_SERVER_TOKEN'];
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

// Re-export DaemonHttpError from its dedicated module so existing
// `import { DaemonHttpError } from './DaemonClient.js'` continues to
// work. The class itself lives in DaemonHttpError.ts to break the
// import chain from RestSseTransport → DaemonClient (browser bundle).
export { DaemonHttpError } from './DaemonHttpError.js';

/**
 * SDK-side representation of the daemon's `prompt_queue_full` condition.
 * Mirrors the bridge-side `PromptQueueFullError` wire data.
 */
export class DaemonPendingPromptLimitError extends Error {
  declare readonly sessionId: string;
  declare readonly limit: number;
  declare readonly pendingCount: number;

  constructor(sessionId: string, limit: number, pendingCount: number) {
    super(`Pending prompts full: "${sessionId}" (${pendingCount}/${limit})`);
    this.name = 'DaemonPendingPromptLimitError';
    this.sessionId = sessionId;
    this.limit = limit;
    this.pendingCount = pendingCount;
  }
}

export interface DaemonTurnError extends DaemonHttpError {
  _daemonTurnError: true;
}

export function isDaemonTurnError(error: unknown): error is DaemonTurnError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { _daemonTurnError?: unknown })._daemonTurnError === true
  );
}

export interface CreateSessionRequest {
  /**
   * Workspace path the daemon must be bound to. When
   * omitted, the SDK sends no `cwd` field and the daemon route falls
   * back to its boot-time `boundWorkspace`. Pass `caps.workspaceCwd`
   * to be explicit, or omit it for the daemon-knows-best path. A
   * non-empty `workspaceCwd` that doesn't canonicalize to the
   * daemon's bound path yields a `400 workspace_mismatch`
   * `DaemonHttpError`.
   */
  workspaceCwd?: string;
  modelServiceId?: string;
  /**
   * Per-request session-scope override. The production daemon defaults
   * to `'single'`, which coalesces same-workspace `POST /session` calls
   * into one shared session; passing `sessionScope: 'thread'` here
   * forces a distinct session for this call. The reverse override
   * (per-request `'single'` against a daemon defaulting to `'thread'`)
   * is also supported, though the daemon's default is hardcoded to
   * `'single'` today. Omit
   * to inherit the daemon-wide default.
   *
   * Only `'single'` and `'thread'` are accepted; anything else yields
   * `400 invalid_session_scope`. Old daemons silently
   * ignore the field — clients should pre-flight
   * `caps.features.session_scope_override` before sending.
   */
  sessionScope?: 'single' | 'thread';
}

export interface RestoreSessionRequest {
  /**
   * Workspace path the daemon must be bound to. Omit to let the daemon use
   * its advertised bound workspace, mirroring `createOrAttachSession`.
   */
  workspaceCwd?: string;
}

export interface PromptRequest {
  prompt: PromptContentBlock[];
  /** Optional ACP _meta passthrough. */
  _meta?: Record<string, unknown> | null;
  /**
   * Per-prompt wallclock cap (positive integer ms).
   * The effective deadline is `min(server flag, this)` — the request
   * can shorten, never extend. When omitted, the server's
   * `--prompt-deadline-ms` flag governs alone (unlimited when both
   * are unset). On expiry the daemon returns 504 +
   * `errorKind: 'prompt_deadline_exceeded'`.
   *
   * Daemons without `prompt_absolute_deadline` capability
   * tag) silently ignore the field — pre-flight
   * `caps.features.includes('prompt_absolute_deadline')` before
   * relying on it.
   */
  deadlineMs?: number;
  [key: string]: unknown;
}

/**
 * 202 Accepted envelope returned by non-blocking
 * `POST /session/:id/prompt`.
 */
export interface NonBlockingPromptAccepted {
  promptId: string;
  lastEventId: number;
}

export interface SubscribeOptions {
  /** Resume from after this event id (`Last-Event-ID` header). */
  lastEventId?: number;
  /** Aborts the subscription cleanly. */
  signal?: AbortSignal;
  /**
   * Per-subscriber backlog cap requested from the daemon. Forwarded as
   * `?maxQueued=N` on `GET /session/:id/events`. Daemon-side range is
   * `[16, 2048]` (default 256); out-of-range or non-decimal values get
   * a `400 invalid_max_queued` response. Old daemons without the
   * `slow_client_warning` capability silently ignore the param — SDK
   * clients should pre-flight `caps.features.slow_client_warning`
   * before opting in. Useful for cold reconnects with a large
   * `Last-Event-ID: 0` replay backlog so the force-pushed replay
   * frames don't trip the warn / eviction path on the first publish.
   */
  maxQueued?: number;
}

export class DaemonClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly fetchTimeoutMs: number;
  private readonly promptLimit: number;
  private readonly promptCounts: Record<string, number> = Object.create(null);
  /**
   * Pluggable transport layer. Defaults to `RestSseTransport` when
   * no explicit transport is supplied — preserving the pre-abstraction
   * REST+SSE behavior with zero breaking changes.
   */
  readonly transport: DaemonTransport;
  // Lazy singleton so clients that never touch auth pay no allocation cost.
  // Exposed via the readonly `auth` accessor below.
  private _authFlow?: DaemonAuthFlow;

  /**
   * High-level auth helper. Wraps the four
   * `*DeviceFlow*` methods with a `start(...).awaitCompletion()` shape
   * for the common "log in remotely" UX. Lazy-constructed.
   */
  get auth(): DaemonAuthFlow {
    if (!this._authFlow) {
      this._authFlow = new DaemonAuthFlow(this);
    }
    return this._authFlow;
  }

  constructor(opts: DaemonClientOptions) {
    this.baseUrl = stripTrailingSlashes(opts.baseUrl);
    // When no explicit token is passed, fall back to
    // QWEN_SERVER_TOKEN env var so clients with
    // `export QWEN_SERVER_TOKEN=...` in their shell don't have to
    // thread the value through every construction. See
    // `readTokenFromEnv` above for browser-safety + trim semantics.
    this.token = opts.token ?? readTokenFromEnv();
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
    this.promptLimit = normalizePendingPromptLimit(
      opts.maxPendingPromptsPerSession,
    );
    this.transport =
      opts.transport ??
      new RestSseTransport(this.baseUrl, this.token, this._fetch);
  }

  get maxPendingPromptsPerSession(): number {
    return this.promptLimit;
  }

  /** @internal */
  reservePromptSlot(sessionId: string, limit = this.promptLimit): () => void {
    if (limit === Infinity) return () => {};
    const promptCounts = this.promptCounts;
    const pendingCount = promptCounts[sessionId] ?? 0;
    if (pendingCount >= limit) {
      throw new DaemonPendingPromptLimitError(sessionId, limit, pendingCount);
    }
    promptCounts[sessionId] = pendingCount + 1;
    let released: boolean | undefined;
    return () => {
      if (released) return;
      released = true;
      if ((promptCounts[sessionId] ?? 0) <= 1) {
        delete promptCounts[sessionId];
      } else {
        --promptCounts[sessionId]!;
      }
    };
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
    perCallTimeoutMs?: number,
  ): Promise<T> {
    // When `consume` is provided, the timer must remain
    // armed through the entire callback (body read + parse). The
    // previous `Response`-returning shape cleared the timer the
    // moment headers arrived, so `await res.json()` against a
    // proxy that stalled mid-body could hang indefinitely past
    // `fetchTimeoutMs`. Pass the body-reading code as a callback
    // so its execution is included in the timer scope; the
    // composed abort signal still flows through to fetch's body
    // stream, so an in-progress `res.json()` rejects cleanly when
    // the timer fires.
    //
    // `perCallTimeoutMs` lets a single call (e.g. `restartMcpServer`,
    // where the daemon waits up to 300s for MCP rediscovery) override
    // the client-wide default.
    //
    // Accept finite, non-negative values -- including `0`, which the
    // `restartMcpServer` JSDoc documents as "disable the timeout
    // entirely". Zero falls through to the no-timeout branch below
    // via the `!effectiveTimeoutMs` truthiness check. NaN / negative
    // inputs still coerce back to the client-wide default so callers
    // can pass a derived expression without defending the math at
    // every site.
    let effectiveTimeoutMs = this.fetchTimeoutMs;
    if (
      perCallTimeoutMs !== undefined &&
      Number.isFinite(perCallTimeoutMs) &&
      perCallTimeoutMs >= 0
    ) {
      effectiveTimeoutMs = perCallTimeoutMs;
    }
    if (!effectiveTimeoutMs || !Number.isFinite(effectiveTimeoutMs)) {
      const res = await this.transport.fetch(url, init);
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
      ctrl.abort(new DOMException('timeout', 'TimeoutError'));
    }, effectiveTimeoutMs);
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    const callerSignal = init.signal ?? undefined;
    const signal = callerSignal
      ? composeAbortSignals([callerSignal, ctrl.signal])
      : ctrl.signal;
    try {
      const res = await this.transport.fetch(url, { ...init, signal });
      if (consume) return await consume(res);
      return res as unknown as T;
    } finally {
      clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
    }
  }

  // -- Plumbing -----------------------------------------------------------

  private headers(
    extra: Record<string, string> = {},
    clientId?: string,
  ): Record<string, string> {
    const out: Record<string, string> = { ...extra };
    if (this.token) out['Authorization'] = `Bearer ${this.token}`;
    if (clientId) out[CLIENT_ID_HEADER] = clientId;
    return out;
  }

  private async failOnError(
    res: Response,
    label: string,
  ): Promise<DaemonHttpError>;
  private async failOnError(
    res: Response,
    label: string,
    sessionId: string,
  ): Promise<DaemonHttpError | DaemonPendingPromptLimitError>;
  private async failOnError(
    res: Response,
    label: string,
    sessionId?: string,
  ): Promise<DaemonHttpError | DaemonPendingPromptLimitError> {
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
    if (sessionId && res.status === 503 && body && typeof body === 'object') {
      const data = body as {
        code?: unknown;
        limit?: unknown;
        pendingCount?: unknown;
        sessionId?: unknown;
      };
      if (data.code === 'prompt_queue_full') {
        return new DaemonPendingPromptLimitError(
          typeof data.sessionId === 'string' ? data.sessionId : sessionId,
          typeof data.limit === 'number' ? data.limit : 0,
          typeof data.pendingCount === 'number' ? data.pendingCount : 0,
        );
      }
    }
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

  async workspaceMcp(): Promise<DaemonWorkspaceMcpStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, 'GET /workspace/mcp');
        return (await res.json()) as DaemonWorkspaceMcpStatus;
      },
    );
  }

  async workspaceMcpTools(
    serverName: string,
  ): Promise<DaemonWorkspaceMcpToolsStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/${encodeURIComponent(serverName)}/tools`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/mcp/:server/tools');
        }
        return (await res.json()) as DaemonWorkspaceMcpToolsStatus;
      },
    );
  }

  async workspaceSkills(): Promise<DaemonWorkspaceSkillsStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/skills`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/skills');
        }
        return (await res.json()) as DaemonWorkspaceSkillsStatus;
      },
    );
  }

  async workspaceProviders(): Promise<DaemonWorkspaceProvidersStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/providers`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/providers');
        }
        return (await res.json()) as DaemonWorkspaceProvidersStatus;
      },
    );
  }

  async workspaceHooks(): Promise<DaemonWorkspaceHooksStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/hooks`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, 'GET /workspace/hooks');
        return (await res.json()) as DaemonWorkspaceHooksStatus;
      },
    );
  }

  async sessionHooks(sessionId: string): Promise<DaemonSessionHooksStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/hooks`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok)
          throw await this.failOnError(res, 'GET /session/:id/hooks');
        return (await res.json()) as DaemonSessionHooksStatus;
      },
    );
  }

  async workspaceExtensions(): Promise<DaemonWorkspaceExtensionsStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/extensions`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok)
          throw await this.failOnError(res, 'GET /workspace/extensions');
        return (await res.json()) as DaemonWorkspaceExtensionsStatus;
      },
    );
  }

  // -- Workspace files (workspace files) -------------------------------

  async readWorkspaceFile(
    filePath: string,
    opts: { maxBytes?: number; line?: number; limit?: number } = {},
    clientId?: string,
  ): Promise<DaemonWorkspaceFile> {
    const url = new URL(`${this.baseUrl}/file`);
    url.searchParams.set('path', filePath);
    if (opts.maxBytes !== undefined) {
      url.searchParams.set('maxBytes', String(opts.maxBytes));
    }
    if (opts.line !== undefined) {
      url.searchParams.set('line', String(opts.line));
    }
    if (opts.limit !== undefined) {
      url.searchParams.set('limit', String(opts.limit));
    }
    return await this.fetchWithTimeout(
      url.toString(),
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, 'GET /file');
        return (await res.json()) as DaemonWorkspaceFile;
      },
    );
  }

  async readWorkspaceFileBytes(
    filePath: string,
    opts: { offset?: number; maxBytes?: number } = {},
    clientId?: string,
  ): Promise<DaemonWorkspaceFileBytes> {
    const url = new URL(`${this.baseUrl}/file/bytes`);
    url.searchParams.set('path', filePath);
    if (opts.offset !== undefined) {
      url.searchParams.set('offset', String(opts.offset));
    }
    if (opts.maxBytes !== undefined) {
      url.searchParams.set('maxBytes', String(opts.maxBytes));
    }
    return await this.fetchWithTimeout(
      url.toString(),
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, 'GET /file/bytes');
        return (await res.json()) as DaemonWorkspaceFileBytes;
      },
    );
  }

  async fileStat(filePath: string): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/stat`);
    url.searchParams.set('path', filePath);
    return await this.fetchWithTimeout(
      url.toString(),
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, 'GET /stat');
        return (await res.json()) as unknown;
      },
    );
  }

  async dirList(dirPath: string): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/list`);
    url.searchParams.set('path', dirPath);
    return await this.fetchWithTimeout(
      url.toString(),
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, 'GET /list');
        return (await res.json()) as unknown;
      },
    );
  }

  async glob(pattern: string): Promise<unknown> {
    const url = new URL(`${this.baseUrl}/glob`);
    url.searchParams.set('pattern', pattern);
    return await this.fetchWithTimeout(
      url.toString(),
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, 'GET /glob');
        return (await res.json()) as unknown;
      },
    );
  }

  async writeWorkspaceFile(
    req: DaemonWorkspaceFileWriteRequest,
    clientId?: string,
  ): Promise<DaemonWorkspaceFileWriteResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/file/write`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify(req),
      },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, 'POST /file/write');
        return (await res.json()) as DaemonWorkspaceFileWriteResult;
      },
    );
  }

  async editWorkspaceFile(
    req: DaemonWorkspaceFileEditRequest,
    clientId?: string,
  ): Promise<DaemonWorkspaceFileEditResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/file/edit`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify(req),
      },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, 'POST /file/edit');
        return (await res.json()) as DaemonWorkspaceFileEditResult;
      },
    );
  }

  // -- Workspace memory (workspace memory/agents) ------------------------------

  /**
   * Fetch the daemon's `QWEN.md` / `AGENTS.md` snapshot. Read-only;
   * pre-flight `caps.features.workspace_memory` before calling
   * against an unknown daemon. Returns `initialized: false` and an
   * empty `files` array when no memory files exist at the bound
   * workspace root or `~/.qwen`.
   *
   * v1 discovers files at the bound workspace ROOT only, plus the
   * user's global `~/.qwen` directory — it does NOT walk parent
   * directories or recurse into the workspace tree. The route's
   * companion helper `walkWorkspaceForMemory` keeps a guarded
   * upward-walk loop body for a future hierarchical mode but breaks
   * after iteration 1 in this release.
   */
  async workspaceMemory(): Promise<DaemonWorkspaceMemoryStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/memory`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/memory');
        }
        return (await res.json()) as DaemonWorkspaceMemoryStatus;
      },
    );
  }

  /**
   * Append to or replace `QWEN.md` at workspace or global scope.
   * Strict mutation gate (`token_required` on no-token loopback
   * defaults). When the daemon advertises `workspace_memory`, expect
   * 200 with `{ ok, filePath, bytesWritten, mode }`; older daemons
   * without the capability return 404.
   */
  async writeWorkspaceMemory(
    req: DaemonWriteMemoryRequest,
    clientId?: string,
  ): Promise<DaemonWriteMemoryResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/memory`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify(req),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /workspace/memory');
        }
        return (await res.json()) as DaemonWriteMemoryResult;
      },
    );
  }

  // -- Workspace agents (workspace memory/agents) ------------------------------

  async listWorkspaceAgents(): Promise<DaemonWorkspaceAgentsStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/agents`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/agents');
        }
        return (await res.json()) as DaemonWorkspaceAgentsStatus;
      },
    );
  }

  /**
   * Create a project- or user-level subagent. 409 `agent_already_exists`
   * when a same-name agent is already registered at the chosen level;
   * 422 `invalid_config` for validation failures.
   */
  async createWorkspaceAgent(
    req: DaemonCreateAgentRequest,
    clientId?: string,
  ): Promise<DaemonAgentMutationResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/agents`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify(req),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /workspace/agents');
        }
        return (await res.json()) as DaemonAgentMutationResult;
      },
    );
  }

  async generateWorkspaceAgent(
    description: string,
    clientId?: string,
  ): Promise<DaemonGeneratedAgentContent> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/agents/generate`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify({ description }),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /workspace/agents/generate');
        }
        return (await res.json()) as DaemonGeneratedAgentContent;
      },
      MCP_RESTART_DEFAULT_TIMEOUT_MS,
    );
  }

  async getWorkspaceAgent(
    agentType: string,
  ): Promise<DaemonWorkspaceAgentDetail> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/agents/${encodeURIComponent(agentType)}`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/agents/:agentType');
        }
        return (await res.json()) as DaemonWorkspaceAgentDetail;
      },
    );
  }

  /**
   * Update a project- or user-level subagent definition. Built-in /
   * extension / session-level agents are read-only and return 403
   * `agent_readonly`; missing agents return 404 `agent_not_found`.
   *
   * Optional `scope` mirrors the delete helper: when a project agent
   * shadows a user-level agent of the same name, pass
   * `{ scope: 'global' }` to update the user-level definition
   * specifically. Without the scope the daemon resolves through the
   * default precedence (project > user) and updates the project entry.
   */
  async updateWorkspaceAgent(
    agentType: string,
    req: DaemonUpdateAgentRequest,
    opts: { scope?: 'workspace' | 'global' } = {},
    clientId?: string,
  ): Promise<DaemonAgentMutationResult> {
    const url = opts.scope
      ? `${this.baseUrl}/workspace/agents/${encodeURIComponent(agentType)}?scope=${encodeURIComponent(opts.scope)}`
      : `${this.baseUrl}/workspace/agents/${encodeURIComponent(agentType)}`;
    return await this.fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify(req),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            'POST /workspace/agents/:agentType',
          );
        }
        return (await res.json()) as DaemonAgentMutationResult;
      },
    );
  }

  /**
   * Delete a project- or user-level subagent definition. Optional
   * `scope` query narrows deletion to one level when the same name
   * exists at both. Idempotent for SDK callers — both 204 (deleted)
   * and 404 (already gone) resolve successfully.
   */
  async deleteWorkspaceAgent(
    agentType: string,
    opts: { scope?: 'workspace' | 'global' } = {},
    clientId?: string,
  ): Promise<void> {
    const url = opts.scope
      ? `${this.baseUrl}/workspace/agents/${encodeURIComponent(agentType)}?scope=${encodeURIComponent(opts.scope)}`
      : `${this.baseUrl}/workspace/agents/${encodeURIComponent(agentType)}`;
    return await this.fetchWithTimeout(
      url,
      {
        method: 'DELETE',
        headers: this.headers({}, clientId),
      },
      async (res) => {
        if (res.status === 204) {
          try {
            await res.body?.cancel();
          } catch {
            /* body already consumed or no body */
          }
          return;
        }
        // Treat as idempotent ONLY when the daemon explicitly says
        // `agent_not_found`. A bare 404 (e.g. an HTTP proxy returning
        // a generic page, an older daemon that doesn't know the
        // route, a misrouted load balancer) would otherwise be
        // silently swallowed and the SDK caller would believe the
        // agent was deleted when the request never reached a route
        // that understands workspace agents. Failing on non-
        // structured 404s makes routing errors visible.
        if (res.status === 404) {
          const err = await this.failOnError(
            res,
            'DELETE /workspace/agents/:agentType',
          );
          const body = err.body as { code?: unknown } | undefined;
          if (body && body.code === 'agent_not_found') return;
          throw err;
        }
        throw await this.failOnError(
          res,
          'DELETE /workspace/agents/:agentType',
        );
      },
    );
  }

  async workspaceEnv(): Promise<DaemonWorkspaceEnvStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/env`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, 'GET /workspace/env');
        return (await res.json()) as DaemonWorkspaceEnvStatus;
      },
    );
  }

  async workspacePreflight(): Promise<DaemonWorkspacePreflightStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/preflight`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/preflight');
        }
        return (await res.json()) as DaemonWorkspacePreflightStatus;
      },
    );
  }

  async workspaceTools(): Promise<DaemonWorkspaceToolsStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/tools`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/tools');
        }
        return (await res.json()) as DaemonWorkspaceToolsStatus;
      },
    );
  }

  // -- Sessions ----------------------------------------------------------

  async createOrAttachSession(
    req: CreateSessionRequest,
    clientId?: string,
  ): Promise<DaemonSession> {
    // Omitting `cwd` lets the daemon fall back to its
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
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify({
          cwd: req.workspaceCwd,
          ...(req.modelServiceId ? { modelServiceId: req.modelServiceId } : {}),
          // `!== undefined` (not truthy) so a buggy caller passing
          // `sessionScope: '' | null` doesn't get the field silently
          // erased on the wire — let the daemon's `400
          // invalid_session_scope` surface the bug. Same shape the
          // bridge's own validation uses (`httpAcpBridge.ts:
          // spawnOrAttach`); SDK should be a transparent layer here.
          ...(req.sessionScope !== undefined
            ? { sessionScope: req.sessionScope }
            : {}),
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

  async loadSession(
    sessionId: string,
    req: RestoreSessionRequest = {},
    clientId?: string,
  ): Promise<DaemonRestoredSession> {
    return this.restoreSession('load', sessionId, req, clientId);
  }

  async resumeSession(
    sessionId: string,
    req: RestoreSessionRequest = {},
    clientId?: string,
  ): Promise<DaemonRestoredSession> {
    return this.restoreSession('resume', sessionId, req, clientId);
  }

  async branchSession(
    sessionId: string,
    req: BranchSessionRequest = {},
    clientId?: string,
  ): Promise<DaemonBranchedSession> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/branch`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify({ name: req.name }),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /session/:id/branch');
        }
        return (await res.json()) as DaemonBranchedSession;
      },
    );
  }

  async sessionContext(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionContextStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/context`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /session/:id/context');
        }
        return (await res.json()) as DaemonSessionContextStatus;
      },
    );
  }

  async sessionContextUsage(
    sessionId: string,
    opts: { detail?: boolean } = {},
    clientId?: string,
  ): Promise<DaemonSessionContextUsageStatus> {
    const params = new URLSearchParams();
    if (opts.detail === true) params.set('detail', 'true');
    const query = params.toString();
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/context-usage${
        query ? `?${query}` : ''
      }`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /session/:id/context-usage');
        }
        return (await res.json()) as DaemonSessionContextUsageStatus;
      },
    );
  }

  async sessionSupportedCommands(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionSupportedCommandsStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/supported-commands`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            'GET /session/:id/supported-commands',
          );
        }
        return (await res.json()) as DaemonSessionSupportedCommandsStatus;
      },
    );
  }

  async sessionTasks(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionTasksStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/tasks`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /session/:id/tasks');
        }
        return (await res.json()) as DaemonSessionTasksStatus;
      },
    );
  }

  async sessionTaskCancel(
    sessionId: string,
    taskId: string,
    kind: DaemonSessionTaskStatus['kind'],
    clientId?: string,
  ): Promise<{ cancelled: boolean }> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/cancel`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify({ kind }),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            'POST /session/:id/tasks/:taskId/cancel',
          );
        }
        return (await res.json()) as { cancelled: boolean };
      },
    );
  }

  async sessionGoalClear(
    sessionId: string,
    clientId?: string,
  ): Promise<{ cleared: boolean; condition?: string }> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/goal/clear`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify({}),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /session/:id/goal/clear');
        }
        return (await res.json()) as { cleared: boolean; condition?: string };
      },
    );
  }

  async sessionStats(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionStatsStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/stats`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /session/:id/stats');
        }
        return (await res.json()) as DaemonSessionStatsStatus;
      },
    );
  }

  /**
   * Shared transport for `loadSession` / `resumeSession`. Both routes
   * share an identical wire shape (POST /session/:id/{load|resume}
   * with optional `cwd` body) and identical error envelopes from the
   * daemon, so they collapse into a single fetch path that only
   * differs in the URL suffix and the route name reported on errors.
   */
  private async restoreSession(
    action: 'load' | 'resume',
    sessionId: string,
    req: RestoreSessionRequest,
    clientId?: string,
  ): Promise<DaemonRestoredSession> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/${action}`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify({ cwd: req.workspaceCwd }),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, `POST /session/:id/${action}`);
        }
        return (await res.json()) as DaemonRestoredSession;
      },
    );
  }

  /**
   * Change the approval mode of a live session.
   * The daemon applies the change in the ACP child's per-session
   * `Config` and publishes an `approval_mode_changed` event. Pass
   * `opts.persist: true` to also write `tools.approvalMode` to the
   * workspace settings file (default is ephemeral so a remote caller
   * does not pollute the user's host settings unless asked).
   *
   * Pre-flight `caps.features.session_approval_mode_control` before
   * calling — older daemons reject the route with 404.
   *
   * The trust-folder gate inside core's `setApprovalMode` rejects
   * privileged modes in untrusted folders; the route surfaces that
   * with HTTP 403 + `errorKind: 'auth_env_error'`.
   */
  async setSessionApprovalMode(
    sessionId: string,
    mode: DaemonApprovalMode,
    opts?: { persist?: boolean; clientId?: string },
  ): Promise<DaemonApprovalModeResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/approval-mode`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: JSON.stringify({
          mode,
          ...(opts?.persist === true ? { persist: true } : {}),
        }),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /session/:id/approval-mode');
        }
        return (await res.json()) as DaemonApprovalModeResult;
      },
    );
  }

  async getRewindSnapshots(
    sessionId: string,
  ): Promise<{ snapshots: DaemonRewindSnapshotInfo[] }> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/rewind/snapshots`,
      { method: 'GET', headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            'GET /session/:id/rewind/snapshots',
          );
        }
        return (await res.json()) as { snapshots: DaemonRewindSnapshotInfo[] };
      },
    );
  }

  async rewindSession(
    sessionId: string,
    promptId: string,
    opts?: { clientId?: string },
  ): Promise<DaemonRewindResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/rewind`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: JSON.stringify({ promptId }),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /session/:id/rewind');
        }
        return (await res.json()) as DaemonRewindResult;
      },
    );
  }

  /**
   * Generate a one-sentence "where did I leave off"
   * recap of the session. Wraps `generateSessionRecap` (core/services/
   * sessionRecap.ts) via an ACP control-channel ext-method, so the
   * summary is computed against the active GeminiClient chat history
   * inside the daemon's ACP child.
   *
   * Non-strict mutation gate — posture matches `/session/:id/prompt`
   * (the route costs tokens but mutates no state). Calls `_fetch`
   * directly without the per-call `fetchTimeoutMs` wrapper because the
   * underlying side-query can take longer than the default 30s under
   * a slow model. Older daemons (pre-recap support) return 404 —
   * pre-flight `caps.features.session_recap` before calling.
   *
   * Cancellation: the optional `signal` aborts only the LOCAL HTTP
   * fetch. It does NOT propagate to the daemon — the bridge-side wait
   * continues until the 60s `SESSION_RECAP_TIMEOUT_MS` backstop, and
   * the side-query inside the ACP child always runs to completion (no
   * cross-process abort plumbing in v1). A future request-id-based
   * cancel ext-method will plumb a real signal end-to-end if/when the
   * bandwidth cost justifies it.
   *
   * `recap` may be `null` on too-short histories or transient model
   * failures (a 200 response with `recap: null`), per the best-effort
   * contract of the core helper.
   */
  async recapSession(
    sessionId: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<DaemonSessionRecapResult> {
    const res = await this.transport.fetch(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/recap`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: '{}',
        signal: opts?.signal,
      },
    );
    if (!res.ok) throw await this.failOnError(res, 'POST /session/:id/recap');
    return (await res.json()) as DaemonSessionRecapResult;
  }

  async btwSession(
    sessionId: string,
    question: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<DaemonSessionBtwResult> {
    const res = await this.transport.fetch(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/btw`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: JSON.stringify({ question }),
        signal: opts?.signal,
      },
    );
    if (!res.ok) throw await this.failOnError(res, 'POST /session/:id/btw');
    return (await res.json()) as DaemonSessionBtwResult;
  }

  /**
   * Execute a direct daemon-side shell command for a session. The daemon must
   * be started with direct session shell enabled and bearer auth configured;
   * callers must also provide a client id already bound to this session.
   * Prefer `DaemonSessionClient.shellCommand()` when available because it
   * forwards the session-bound client id automatically.
   */
  async shellCommand(
    sessionId: string,
    command: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<DaemonShellCommandResult> {
    const res = await this.transport.fetch(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/shell`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: JSON.stringify({ command }),
        signal: opts?.signal,
      },
    );
    if (!res.ok) throw await this.failOnError(res, 'POST /session/:id/shell');
    return (await res.json()) as DaemonShellCommandResult;
  }

  /**
   * Toggle a tool name in the workspace's
   * `tools.disabled` settings list. Strict-gated mutation route — the
   * daemon must be configured with a bearer token. The daemon writes
   * the settings file directly and fan-outs a `tool_toggled` event to
   * every live session SSE bus.
   *
   * Already-registered tools in active sessions are NOT retroactively
   * unregistered. The toggle takes effect on the next ACP child spawn
   * — listeners that need the live tool list to reflect the change
   * should also `POST /workspace/mcp/:server/restart` (when the tool
   * is MCP-discovered) or open a new session.
   *
   * Pre-flight `caps.features.workspace_tool_toggle` before calling.
   */
  async setWorkspaceToolEnabled(
    toolName: string,
    enabled: boolean,
    opts?: { clientId?: string },
  ): Promise<DaemonToolToggleResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/tools/${encodeURIComponent(toolName)}/enable`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: JSON.stringify({ enabled }),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            'POST /workspace/tools/:name/enable',
          );
        }
        return (await res.json()) as DaemonToolToggleResult;
      },
    );
  }

  async workspaceSettings(opts?: {
    clientId?: string;
  }): Promise<DaemonWorkspaceSettingsStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/settings`,
      {
        method: 'GET',
        headers: this.headers({}, opts?.clientId),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/settings');
        }
        return (await res.json()) as DaemonWorkspaceSettingsStatus;
      },
    );
  }

  async setWorkspaceSetting(
    scope: 'workspace',
    key: string,
    value: unknown,
    opts?: { clientId?: string },
  ): Promise<DaemonSettingUpdateResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/settings`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: JSON.stringify({ scope, key, value }),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /workspace/settings');
        }
        return (await res.json()) as DaemonSettingUpdateResult;
      },
    );
  }

  /**
   * Restart a configured MCP server through the ACP child's
   * `McpClientManager`. The daemon pre-checks the live budget
   * snapshot; soft refusals (in-flight discovery,
   * disabled server, budget would exceed under `enforce` mode) come
   * back as 200 OK with `{restarted: false, skipped: true, reason}`.
   * Only hard errors (unknown server name, no live ACP channel)
   * surface as non-2xx.
   *
   * The daemon-side restart waits up to 5 minutes for stdio MCP
   * discovery; the SDK default allows that budget plus 30s headroom
   * so a slow but valid restart isn't
   * aborted client-side while the daemon continues working. Callers can pass a custom
   * `timeoutMs` when their threat model needs a tighter cap, or `0`
   * to disable the timeout entirely.
   *
   * `entryIndex` targets one pooled entry by index. Use `'*'` to
   * restart all entries for a pooled server.
   *
   * Pre-flight `caps.features.workspace_mcp_restart` before calling.
   */
  async restartMcpServer(
    serverName: string,
    opts?: { clientId?: string; entryIndex?: number | '*'; timeoutMs?: number },
  ): Promise<DaemonMcpRestartResult> {
    const query =
      opts?.entryIndex === undefined
        ? ''
        : `?entryIndex=${encodeURIComponent(String(opts.entryIndex))}`;
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/${encodeURIComponent(serverName)}/restart${query}`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: '{}',
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            'POST /workspace/mcp/:server/restart',
          );
        }
        return (await res.json()) as DaemonMcpRestartResult;
      },
      opts?.timeoutMs ?? MCP_RESTART_DEFAULT_TIMEOUT_MS,
    );
  }

  async reload(opts?: {
    clientId?: string;
    timeoutMs?: number;
  }): Promise<DaemonReloadResponse> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/reload`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: '{}',
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /workspace/reload');
        }
        return (await res.json()) as DaemonReloadResponse;
      },
      opts?.timeoutMs,
    );
  }

  async manageMcpServer(
    serverName: string,
    action: DaemonMcpManageAction,
    opts?: { clientId?: string; timeoutMs?: number },
  ): Promise<DaemonMcpManageResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/${encodeURIComponent(serverName)}/${encodeURIComponent(action)}`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: '{}',
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            'POST /workspace/mcp/:server/:action',
          );
        }
        return (await res.json()) as DaemonMcpManageResult;
      },
      opts?.timeoutMs ?? MCP_RESTART_DEFAULT_TIMEOUT_MS,
    );
  }

  /**
   * Add (or replace) a runtime MCP server. The daemon
   * validates the config, starts the server, and emits an
   * `mcp_server_added` SSE event to all live sessions. Callers
   * pre-flight `caps.features.mcp_server_runtime_mutation` before
   * calling — older daemons return 404.
   */
  async addRuntimeMcpServer(
    request: DaemonRuntimeMcpAddRequest,
    opts?: { clientId?: string; timeoutMs?: number },
  ): Promise<DaemonRuntimeMcpAddResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/servers`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: JSON.stringify(request),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /workspace/mcp/servers');
        }
        return (await res.json()) as DaemonRuntimeMcpAddResult;
      },
      opts?.timeoutMs ?? MCP_RESTART_DEFAULT_TIMEOUT_MS,
    );
  }

  /**
   * Remove a runtime MCP server by name. The daemon
   * tears down the server process, removes it from the runtime
   * overlay, and emits an `mcp_server_removed` SSE event. Idempotent
   * at the HTTP level: if the server was never present the daemon
   * returns 200 with `{ skipped: true, reason: 'not_present' }`.
   * Pre-flight `caps.features.mcp_server_runtime_mutation` before
   * calling.
   */
  async removeRuntimeMcpServer(
    name: string,
    opts?: { clientId?: string; timeoutMs?: number },
  ): Promise<DaemonRuntimeMcpRemoveResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/servers/${encodeURIComponent(name)}`,
      {
        method: 'DELETE',
        headers: this.headers({}, opts?.clientId),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            'DELETE /workspace/mcp/servers/:name',
          );
        }
        return (await res.json()) as DaemonRuntimeMcpRemoveResult;
      },
      opts?.timeoutMs ?? MCP_RESTART_DEFAULT_TIMEOUT_MS,
    );
  }

  /**
   * Scaffold a `QWEN.md` at the daemon's bound
   * workspace root. Mechanical only — does NOT invoke the LLM. The
   * daemon writes an empty file; clients that want AI-driven content
   * fill should follow up with `POST /session/:id/prompt`.
   *
   * Default refuses to overwrite — when the file exists with non-
   * whitespace content the daemon returns 409
   * `workspace_init_conflict` with the existing path and size in the
   * body. Pass `opts.force: true` to overwrite unconditionally.
   *
   * Pre-flight `caps.features.workspace_init` before calling.
   */
  async initWorkspace(opts?: {
    force?: boolean;
    clientId?: string;
  }): Promise<DaemonInitWorkspaceResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/init`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: JSON.stringify(opts?.force === true ? { force: true } : {}),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /workspace/init');
        }
        return (await res.json()) as DaemonInitWorkspaceResult;
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
    clientId?: string,
  ): Promise<SetModelResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/model`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
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

  async setSessionLanguage(
    sessionId: string,
    language: string,
    opts?: { syncOutputLanguage?: boolean; clientId?: string },
  ): Promise<SetSessionLanguageResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/language`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: JSON.stringify({
          language,
          syncOutputLanguage: opts?.syncOutputLanguage ?? false,
        }),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /session/:id/language');
        }
        return (await res.json()) as SetSessionLanguageResult;
      },
    );
  }

  /**
   * Send a prompt to the agent. Supports both blocking (legacy 200)
   * and non-blocking (202 + SSE `turn_complete`) daemon responses.
   *
   * For 202 daemons this opens a **temporary** SSE subscription to
   * await the matching `turn_complete`/`turn_error`. Callers that
   * already manage a long-lived SSE subscription (e.g.
   * `DaemonSessionClient`) should prefer {@link promptNonBlocking}
   * and correlate via their existing event stream to avoid the extra
   * connection.
   */
  async prompt(
    sessionId: string,
    req: PromptRequest,
    signal?: AbortSignal,
    clientId?: string,
  ): Promise<PromptResult> {
    signal?.throwIfAborted();
    const releasePromptSlot = this.reservePromptSlot(sessionId);
    let releaseOnExit = true;
    try {
      const res = await this.transport.fetch(
        `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/prompt`,
        {
          method: 'POST',
          headers: this.headers(
            { 'Content-Type': 'application/json' },
            clientId,
          ),
          body: JSON.stringify(req),
          signal,
        },
      );

      if (res.status === 202) {
        const accept = (await res.json()) as NonBlockingPromptAccepted;
        releaseOnExit = false;
        try {
          return await this._awaitTurnComplete(
            sessionId,
            accept.promptId,
            accept.lastEventId,
            signal,
            clientId,
          );
        } finally {
          releasePromptSlot();
        }
      }

      if (!res.ok) {
        throw await this.failOnError(
          res,
          'POST /session/:id/prompt',
          sessionId,
        );
      }
      return (await res.json()) as PromptResult;
    } finally {
      if (releaseOnExit) releasePromptSlot();
    }
  }

  /**
   * Fire-and-forget prompt trigger. Returns the 202 acceptance
   * envelope (`{ promptId, lastEventId }`) without waiting for the
   * turn to complete. The caller is responsible for observing
   * `turn_complete` / `turn_error` on the session's SSE stream,
   * matching by `promptId`.
   *
   * This is the recommended path for callers that already maintain a
   * long-lived SSE subscription (like `DaemonSessionClient`) —
   * avoids the extra SSE connection that {@link prompt} opens for
   * the temporary 202 fallback.
   *
   * Falls back to `prompt()` for legacy 200 daemons.
   *
   * Note: this method does not enforce the local pending-prompt cap.
   * Callers that need early-fail behavior should use {@link prompt} or
   * reserve a slot before calling this method.
   */
  async promptNonBlocking(
    sessionId: string,
    req: PromptRequest,
    signal?: AbortSignal,
    clientId?: string,
  ): Promise<NonBlockingPromptAccepted | PromptResult> {
    const res = await this.transport.fetch(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/prompt`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify(req),
        signal,
      },
    );

    if (res.status === 202) {
      return (await res.json()) as NonBlockingPromptAccepted;
    }

    if (!res.ok) {
      throw await this.failOnError(res, 'POST /session/:id/prompt', sessionId);
    }
    return (await res.json()) as PromptResult;
  }

  private async _awaitTurnComplete(
    sessionId: string,
    promptId: string,
    lastEventId: number,
    signal?: AbortSignal,
    clientId?: string,
  ): Promise<PromptResult> {
    const sseAbort = new AbortController();
    const composedSignal = signal
      ? composeAbortSignals([signal, sseAbort.signal])
      : sseAbort.signal;

    try {
      const events = this.subscribeEvents(sessionId, {
        lastEventId,
        signal: composedSignal,
      });
      for await (const event of events) {
        const result = matchTurnEvent(event, promptId);
        if (result !== undefined) return result;
      }
      throw new Error('SSE stream ended');
    } catch (err) {
      if (
        signal?.aborted &&
        err instanceof DOMException &&
        err.name === 'AbortError'
      ) {
        this.cancel(sessionId, clientId).catch(() => {});
        throw err;
      }
      throw err;
    } finally {
      if (!sseAbort.signal.aborted) sseAbort.abort();
    }
  }

  /**
   * Bump the daemon's last-seen bookkeeping for this session. The
   * route is short-lived — drives diagnostics and future revocation
   * policy -- so it goes through the standard
   * `fetchTimeoutMs`. Older daemons return 404 for
   * `/heartbeat`; clients should pre-flight
   * `caps.features.client_heartbeat` before calling.
   */
  async heartbeat(
    sessionId: string,
    clientId?: string,
  ): Promise<HeartbeatResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/heartbeat`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: '{}',
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /session/:id/heartbeat');
        }
        return (await res.json()) as HeartbeatResult;
      },
    );
  }

  async cancel(sessionId: string, clientId?: string): Promise<void> {
    await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/cancel`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
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
    // Delegate entirely to the transport. The transport handles
    // connect-phase timeout, Last-Event-ID, maxQueued, content-type
    // validation, and SSE parsing (for REST) or JSON-RPC notification
    // filtering (for ACP transports).
    yield* this.transport.subscribeEvents(sessionId, {
      lastEventId: opts.lastEventId,
      maxQueued: opts.maxQueued,
      signal: opts.signal,
      connectTimeoutMs: this.fetchTimeoutMs || undefined,
    });
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
    clientId?: string,
  ): Promise<boolean> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/permission/${encodeURIComponent(requestId)}`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
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

  /**
   * Cast a permission vote against an explicit daemon session. New clients
   * should prefer this once `capabilities.features` includes
   * `session_permission_vote`; the legacy request-id-only route remains for
   * older daemons.
   */
  async respondToSessionPermission(
    sessionId: string,
    requestId: string,
    response: PermissionResponse,
    clientId?: string,
  ): Promise<boolean> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify(response),
      },
      async (res) => {
        if (res.status === 200) {
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
        throw await this.failOnError(
          res,
          'POST /session/:id/permission/:requestId',
        );
      },
    );
  }

  // -- Session lifecycle ---------------------------------------------------

  /**
   * Close a daemon session. The daemon treats DELETE as idempotent for SDK
   * callers: both 204 (closed) and 404 (already gone) resolve successfully.
   */
  async closeSession(sessionId: string, clientId?: string): Promise<void> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}`,
      {
        method: 'DELETE',
        headers: this.headers({}, clientId),
      },
      async (res) => {
        if (res.status === 204 || res.status === 404) {
          try {
            await res.body?.cancel();
          } catch {
            /* body already consumed or no body */
          }
          return;
        }
        throw await this.failOnError(res, 'DELETE /session/:id');
      },
    );
  }

  async deleteSessionsData(
    sessionIds: string[],
    clientId?: string,
  ): Promise<{
    removed: string[];
    notFound: string[];
    errors: Array<{ sessionId: string; error: string }>;
  }> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/sessions/delete`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify({ sessionIds }),
      },
      async (res) => {
        if (res.ok) {
          return (await res.json()) as {
            removed: string[];
            notFound: string[];
            errors: Array<{ sessionId: string; error: string }>;
          };
        }
        throw await this.failOnError(res, 'POST /sessions/delete');
      },
    );
  }

  // -- Auth device-flow ---------------------------------------------------

  /**
   * Start an OAuth device-flow login for the given provider. The daemon
   * polls the IdP in the background and emits typed `auth_device_flow_*`
   * SSE events; callers can also poll `getDeviceFlow(...)`.
   *
   * Per-provider singleton: a repeat call while a flow is already pending
   * for the same provider is an idempotent take-over and returns the
   * existing entry rather than starting a fresh IdP request. The
   * `attached` field on the result distinguishes the two cases.
   */
  async startDeviceFlow(opts: {
    providerId: DaemonAuthProviderId;
    clientId?: string;
  }): Promise<DaemonDeviceFlowStartResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/auth/device-flow`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts.clientId,
        ),
        body: JSON.stringify({ providerId: opts.providerId }),
      },
      async (res) => {
        if (res.status !== 200 && res.status !== 201) {
          throw await this.failOnError(res, 'POST /workspace/auth/device-flow');
        }
        return (await res.json()) as DaemonDeviceFlowStartResult;
      },
    );
  }

  async getDeviceFlow(
    deviceFlowId: string,
    opts: { clientId?: string; signal?: AbortSignal } = {},
  ): Promise<DaemonDeviceFlowState> {
    // Forward `signal` into `fetchWithTimeout`, which composes it
    // with the per-request `fetchTimeoutMs` controller. Without this,
    // an `awaitCompletion` caller that aborts mid-poll could not cancel
    // the in-flight GET -- only the post-await guard would notice, but
    // that runs only after the body is already settled (or the
    // daemon-side `fetchTimeoutMs` fires, which can be 30s+).
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/auth/device-flow/${encodeURIComponent(deviceFlowId)}`,
      { headers: this.headers({}, opts.clientId), signal: opts.signal },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            'GET /workspace/auth/device-flow/:id',
          );
        }
        return (await res.json()) as DaemonDeviceFlowState;
      },
    );
  }

  /**
   * Cancel a pending device-flow. Idempotent: terminal entries return
   * 204 (no-op); unknown ids return 404 — both resolve here, matching
   * the SDK's `closeSession` shape.
   */
  async cancelDeviceFlow(
    deviceFlowId: string,
    opts: { clientId?: string } = {},
  ): Promise<void> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/auth/device-flow/${encodeURIComponent(deviceFlowId)}`,
      {
        method: 'DELETE',
        headers: this.headers({}, opts.clientId),
      },
      async (res) => {
        if (res.status === 204 || res.status === 404) {
          try {
            await res.body?.cancel();
          } catch {
            /* body already consumed or no body */
          }
          return;
        }
        throw await this.failOnError(
          res,
          'DELETE /workspace/auth/device-flow/:id',
        );
      },
    );
  }

  /** Snapshot of persisted auth credentials + currently pending device-flows. */
  async getAuthStatus(
    opts: { clientId?: string } = {},
  ): Promise<DaemonAuthStatusSnapshot> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/auth/status`,
      { headers: this.headers({}, opts.clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/auth/status');
        }
        return (await res.json()) as DaemonAuthStatusSnapshot;
      },
    );
  }

  async getAuthProviders(): Promise<DaemonAuthProviderCatalog> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/auth/providers`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/auth/providers');
        }
        return (await res.json()) as DaemonAuthProviderCatalog;
      },
    );
  }

  async installAuthProvider(
    req: DaemonAuthProviderInstallRequest,
  ): Promise<DaemonAuthProviderInstallResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/auth/provider`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(req),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /workspace/auth/provider');
        }
        return (await res.json()) as DaemonAuthProviderInstallResult;
      },
    );
  }

  // -- Lifecycle / disposal ------------------------------------------------

  /**
   * Release transport resources (WS close, etc.). Idempotent.
   * After `dispose()`, further calls to `fetch` / `subscribeEvents`
   * on the underlying transport throw `DaemonTransportClosedError`.
   */
  dispose(): void {
    this.transport.dispose();
  }

  // -- Session metadata ----------------------------------------------------

  /**
   * Patch mutable session metadata and return the effective stored metadata
   * reported by the daemon.
   */
  async updateSessionMetadata(
    sessionId: string,
    metadata: { displayName?: string },
    clientId?: string,
  ): Promise<SessionMetadataResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/metadata`,
      {
        method: 'PATCH',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify(metadata),
      },
      async (res) => {
        if (res.status === 200) {
          const body = (await res.json()) as {
            displayName?: unknown;
          };
          return typeof body.displayName === 'string'
            ? { displayName: body.displayName }
            : {};
        }
        throw await this.failOnError(res, 'PATCH /session/:id/metadata');
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
    () => ctrl.abort(new DOMException('timeout', 'TimeoutError')),
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

/**
 * Check whether a daemon SSE event is a `turn_complete` or
 * `turn_error` matching `promptId`. Returns `PromptResult` on
 * `turn_complete`, throws `DaemonHttpError` on `turn_error`,
 * returns `undefined` for non-matching / unrelated events.
 *
 * Extracted so both `DaemonClient._awaitTurnComplete` (temporary SSE
 * fallback) and `DaemonSessionClient.prompt` (existing subscription
 * path) share the same matching logic.
 */
export function matchTurnEvent(
  event: DaemonEvent,
  promptId: string,
): PromptResult | undefined {
  if (event.type === 'turn_complete') {
    const data = event.data as { promptId?: string; stopReason?: string };
    if (data.promptId === promptId) {
      return { stopReason: data.stopReason ?? 'end_turn' };
    }
  }
  if (event.type === 'turn_error') {
    const data = event.data as {
      promptId?: string;
      message?: string;
      code?: string;
    };
    if (data.promptId === promptId) {
      throw Object.assign(
        new DaemonHttpError(
          500,
          data.code ?? 'turn_error',
          data.message ?? 'Prompt failed',
        ),
        { _daemonTurnError: true as const },
      );
    }
  }
  return undefined;
}

export function isNonBlockingAccepted(
  result: NonBlockingPromptAccepted | PromptResult,
): result is NonBlockingPromptAccepted {
  return 'promptId' in result && 'lastEventId' in result;
}
