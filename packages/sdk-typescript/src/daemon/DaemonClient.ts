/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MCP_RESTART_SERVER_DEADLINE_MS,
  MCP_RESTART_CLIENT_HEADROOM_MS,
} from '@qwen-code/acp-bridge/mcpTimeouts';
import { CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS } from '@qwen-code/acp-bridge/channelControlTimeouts';
import { DaemonAuthFlow } from './DaemonAuthFlow.js';
import { DaemonHttpError } from './DaemonHttpError.js';
import type { DaemonTransport } from './DaemonTransport.js';
import { RestSseTransport } from './RestSseTransport.js';
import { DaemonCapabilityMissingError } from './types.js';
import type {
  DaemonAgentMutationResult,
  DaemonAuthProviderId,
  DaemonAuthProviderCatalog,
  DaemonAuthProviderInstallRequest,
  DaemonAuthProviderInstallResult,
  DaemonAuthStatusSnapshot,
  DaemonCapabilities,
  DaemonCreateAgentRequest,
  DaemonArchiveSessionsResult,
  DaemonGeneratedAgentContent,
  DaemonDeviceFlowStartResult,
  DaemonDeviceFlowState,
  DaemonEvent,
  DaemonSessionContextStatus,
  DaemonSessionContextUsageStatus,
  BranchSessionRequest,
  DaemonBranchedSession,
  DaemonForkSessionResult,
  DaemonRestoredSession,
  DaemonSession,
  DaemonSessionArchiveState,
  DaemonSessionExportFormat,
  DaemonSessionExportResult,
  DaemonSessionTranscriptPage,
  DaemonSessionTranscriptPageOptions,
  DaemonSessionGroup,
  DaemonSessionGroupCatalog,
  DaemonSessionGroupInput,
  DaemonSessionGroupUpdate,
  DaemonSessionLspStatus,
  DaemonSessionListPage,
  DaemonSessionListPageOptions,
  DaemonSessionOrganizationResult,
  DaemonSessionOrganizationUpdate,
  DaemonSessionSummary,
  DaemonSessionSupportedCommandsStatus,
  DaemonSessionStatsStatus,
  DaemonUsageDashboard,
  DaemonUsageRange,
  DaemonStatusReport,
  DaemonStatusReportDetail,
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
  DaemonWorkspaceGitStatus,
  DaemonWorkspaceMcpStatus,
  DaemonWorkspaceMcpInitializeResult,
  DaemonWorkspaceMcpToolsStatus,
  DaemonWorkspaceMcpResourcesStatus,
  DaemonWorkspaceMemoryStatus,
  DaemonWorkspacePreflightStatus,
  DaemonWorkspaceProvidersStatus,
  DaemonWorkspaceAcpStatusResult,
  DaemonWorkspaceAcpPreheatResult,
  DaemonWorkspaceSkillsStatus,
  DaemonWorkspaceToolsStatus,
  DaemonWriteMemoryRequest,
  DaemonWriteMemoryResult,
  DaemonWorkspaceMemoryDreamOptions,
  DaemonWorkspaceMemoryDreamTask,
  DaemonWorkspaceMemoryForgetOptions,
  DaemonWorkspaceMemoryForgetTask,
  DaemonWorkspaceMemoryRememberOptions,
  DaemonWorkspaceMemoryRememberTask,
  DaemonWorkspaceRemovalResult,
  HeartbeatResult,
  PermissionResponse,
  PromptContentBlock,
  PromptResult,
  SetModelResult,
  SetSessionLanguageResult,
  SessionMetadataResult,
  DaemonApprovalMode,
  DaemonApprovalModeResult,
  DaemonGithubSetupRequest,
  DaemonGithubSetupResult,
  DaemonInitWorkspaceResult,
  DaemonMcpRestartResult,
  DaemonReloadResponse,
  DaemonChannelReloadResult,
  DaemonChannelControlState,
  DaemonChannelSelection,
  DaemonChannelSetResult,
  DaemonChannelStopResult,
  DaemonMcpManageAction,
  DaemonMcpManageResult,
  DaemonSessionBtwResult,
  DaemonSessionGenerationEvent,
  DaemonMidTurnMessageResult,
  DaemonPendingPromptsResult,
  DaemonRemovePendingPromptResult,
  DaemonSessionRecapResult,
  DaemonShellCommandResult,
  DaemonRuntimeMcpAddRequest,
  DaemonRuntimeMcpAddResult,
  DaemonRuntimeMcpRemoveResult,
  DaemonToolToggleResult,
  DaemonSkillToggleResult,
  DaemonSessionArtifactInput,
  DaemonSessionArtifactMutationResult,
  DaemonSessionArtifactsEnvelope,
  DaemonRewindSnapshotInfo,
  DaemonRewindResult,
  ForkSessionRequest,
  DaemonSessionHooksStatus,
  DaemonWorkspaceExtensionsStatus,
  ExtensionMutationResponse,
  ExtensionInstallRequest,
  ExtensionManagementInstallRequest,
  ExtensionActivationState,
  ExtensionCatalog,
  ExtensionInstallResponse,
  ExtensionInteractionResponse,
  ExtensionInteractionResponseResult,
  ExtensionActiveOperations,
  ExtensionOperationStatus,
  ExtensionScopeRequest,
  ExtensionRefreshResponse,
  ExtensionUpdateCheckResponse,
  WorkspaceExtensionProjection,
  DaemonWorkspaceHooksStatus,
  DaemonPermissionRuleType,
  DaemonPermissionScope,
  DaemonWorkspaceSettingsStatus,
  DaemonWorkspacePermissionsStatus,
  DaemonSettingUpdateResult,
  DaemonModelDeleteRequest,
  DaemonModelDeleteResult,
  DaemonVoiceAudioInput,
  DaemonWorkspaceVoiceStatus,
  DaemonWorkspaceVoiceTranscribeOptions,
  DaemonWorkspaceVoiceTranscriptionResult,
  DaemonWorkspaceVoiceUpdate,
  DaemonWorkspaceTrustChangeRequest,
  DaemonWorkspaceTrustChangeResult,
  DaemonWorkspaceTrustStatus,
  DaemonUnarchiveSessionsResult,
} from './types.js';
import { parseSseStream } from './sse.js';

const WORKSPACE_MEMORY_REMEMBER_PATH = '/workspace/memory/remember';
const WORKSPACE_MEMORY_FORGET_PATH = '/workspace/memory/forget';
const WORKSPACE_MEMORY_DREAM_PATH = '/workspace/memory/dream';

function parseSessionGenerationEvent(
  value: unknown,
): DaemonSessionGenerationEvent | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const event = value as Record<string, unknown>;
  if (event['v'] !== 1 || typeof event['type'] !== 'string') return undefined;

  const requestId = event['requestId'];
  const modelSource = event['modelSource'];
  const validRequestId = typeof requestId === 'string' && requestId.length > 0;
  const validModelSource = modelSource === 'fast' || modelSource === 'main';
  const validTokenCount = (count: unknown) =>
    count === undefined ||
    (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0);

  if (event['type'] === 'started') {
    if (
      !validRequestId ||
      typeof event['model'] !== 'string' ||
      !validModelSource
    ) {
      return undefined;
    }
  } else if (event['type'] === 'thinking') {
    if (!validRequestId) return undefined;
  } else if (event['type'] === 'delta') {
    if (
      !validRequestId ||
      !Number.isSafeInteger(event['seq']) ||
      (event['seq'] as number) < 0 ||
      typeof event['text'] !== 'string' ||
      event['text'].length === 0
    ) {
      return undefined;
    }
  } else if (event['type'] === 'done') {
    if (
      !validRequestId ||
      typeof event['model'] !== 'string' ||
      !validModelSource ||
      !validTokenCount(event['inputTokens']) ||
      !validTokenCount(event['outputTokens'])
    ) {
      return undefined;
    }
  } else if (event['type'] === 'error') {
    if (
      typeof event['code'] !== 'string' ||
      typeof event['message'] !== 'string'
    ) {
      return undefined;
    }
  } else {
    return undefined;
  }

  return event as unknown as DaemonSessionGenerationEvent;
}

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
   * `AcpHttpTransport` to use JSON-RPC over WebSocket or HTTP. Rewind APIs
   * intentionally use direct REST even when an ACP transport is configured so
   * owner routing and strict mutation authentication remain authoritative.
   */
  transport?: DaemonTransport;
}

const DEFAULT_SESSION_LIST_PAGE_SIZE = 20;

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const VOICE_TRANSCRIPTION_DEFAULT_TIMEOUT_MS = 65_000;
const GITHUB_SETUP_DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// Keep in sync with acp-bridge bridge.ts and CLI serve/server.ts.
const DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION = 5;
// Server deadline + headroom so the client never races the daemon's own budget.
const MCP_RESTART_DEFAULT_TIMEOUT_MS =
  MCP_RESTART_SERVER_DEADLINE_MS + MCP_RESTART_CLIENT_HEADROOM_MS;
const CLIENT_ID_HEADER = 'X-Qwen-Client-Id';
const urlEncode = encodeURIComponent;

function transcriptPageSuffix(
  opts: DaemonSessionTranscriptPageOptions,
): string {
  const query = new URLSearchParams();
  if (opts.cursor !== undefined) query.set('cursor', opts.cursor);
  if (opts.beforeRecordId !== undefined) {
    query.set('beforeRecordId', opts.beforeRecordId);
  }
  if (opts.limit !== undefined) query.set('limit', String(opts.limit));
  const value = query.toString();
  return value ? `?${value}` : '';
}

function normalizePermissionRuleInput(rule: string): string {
  const trimmed = rule.trim();
  if (!trimmed) {
    throw new Error('rule must be a non-empty string');
  }
  return trimmed;
}

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
   * Workspace path the daemon must have registered. When
   * omitted, the SDK sends no `cwd` field and the daemon route falls
   * back to its primary workspace. Pass `caps.workspaceCwd` to be
   * explicit, pass a trusted `caps.workspaces[].cwd` when
   * `multi_workspace_sessions` is advertised, or omit it for the
   * daemon-knows-best path. A non-empty `workspaceCwd` that doesn't
   * canonicalize to a registered workspace yields a
   * `400 workspace_mismatch` `DaemonHttpError`.
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
  approvalMode?: string;
  /** Immutable creator attribution stored with a newly created session. */
  sourceType?: string;
  /** Optional source-specific identifier. Requires `sourceType`. */
  sourceId?: string;
}

export interface RestoreSessionRequest {
  /**
   * Workspace path the daemon must have registered. Omit to let the daemon use
   * its advertised primary workspace, mirroring `createOrAttachSession`.
   */
  workspaceCwd?: string;
  approvalMode?: string;
  /** Latest persisted records to include in the initial load replay. */
  historyPageSize?: number;
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
    this._fetch =
      opts.fetch ??
      opts.transport?.restFetch ??
      globalThis.fetch.bind(globalThis);
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
    mode: 'transport' | 'rest' = 'transport',
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
      const res =
        mode === 'rest'
          ? await this._fetch(url, init)
          : await this.transport.fetch(url, init);
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
      const res =
        mode === 'rest'
          ? await this._fetch(url, { ...init, signal })
          : await this.transport.fetch(url, { ...init, signal });
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

  private async jsonRequest<T>(
    path: string,
    label: string,
    opts: {
      method?: string;
      body?: unknown;
      clientId?: string;
      timeoutMs?: number;
      mode?: 'transport' | 'rest';
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const hasBody = opts.body !== undefined;
    return await this.fetchWithTimeout(
      `${this.baseUrl}${path}`,
      {
        ...(opts.method ? { method: opts.method } : {}),
        headers: this.headers(
          hasBody ? { 'Content-Type': 'application/json' } : {},
          opts.clientId,
        ),
        ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, label);
        return (await res.json()) as T;
      },
      opts.timeoutMs,
      opts.mode,
    );
  }

  /** @internal */
  async workspaceJsonRequest<T>(
    workspaceSelector: string,
    path: string,
    label: string,
    opts: {
      method?: string;
      body?: unknown;
      clientId?: string;
      timeoutMs?: number;
      mode?: 'transport' | 'rest';
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    return await this.jsonRequest<T>(
      `/workspaces/${workspaceSelector}${path}`,
      label,
      opts,
    );
  }

  /** @internal */
  async sessionExportRequest(
    path: string,
    label: string,
    opts: {
      format?: DaemonSessionExportFormat;
      clientId?: string;
    } = {},
  ): Promise<DaemonSessionExportResult> {
    const format = opts.format ?? 'html';
    const query = opts.format ? `?format=${urlEncode(opts.format)}` : '';
    return await this.fetchWithTimeout(
      `${this.baseUrl}${path}${query}`,
      { headers: this.headers({}, opts.clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, label);
        }
        const content = await res.text();
        const mimeType = res.headers.get('content-type') ?? '';
        const filename =
          /filename="([^"]+)"/i.exec(
            res.headers.get('content-disposition') ?? '',
          )?.[1] ?? `export.${format}`;
        return {
          content,
          filename,
          mimeType,
          format,
        };
      },
      undefined,
      'rest',
    );
  }

  /** @internal */
  async workspaceNoContentRequest(
    workspaceSelector: string,
    path: string,
    label: string,
    opts: {
      method?: string;
      clientId?: string;
      timeoutMs?: number;
      okNotFoundCode?: string;
    } = {},
  ): Promise<void> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspaces/${workspaceSelector}${path}`,
      {
        ...(opts.method ? { method: opts.method } : {}),
        headers: this.headers({}, opts.clientId),
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
        if (res.status === 404 && opts.okNotFoundCode) {
          const err = await this.failOnError(res, label);
          const body = err.body as { code?: unknown } | undefined;
          if (body?.code === opts.okNotFoundCode) return;
          throw err;
        }
        throw await this.failOnError(res, label);
      },
      opts.timeoutMs,
    );
  }

  workspaceById(workspaceId: string): WorkspaceDaemonClient {
    return new WorkspaceDaemonClient(this, urlEncode(workspaceId));
  }

  workspaceByCwd(workspaceCwd: string): WorkspaceDaemonClient {
    return new WorkspaceDaemonClient(this, urlEncode(workspaceCwd));
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

  async requireCapability(capability: string): Promise<void> {
    const caps = await this.capabilities();
    if (!caps.features.includes(capability)) {
      throw new DaemonCapabilityMissingError(
        capability,
        `daemon does not advertise the ${capability} feature`,
      );
    }
  }

  /**
   * Consolidated daemon status report (`GET /daemon/status`). The default
   * `summary` detail reads cheap in-memory counters; `full` adds per-session,
   * ACP-connection, auth, and workspace diagnostics sections.
   */
  async daemonStatus(
    detail: DaemonStatusReportDetail = 'summary',
  ): Promise<DaemonStatusReport> {
    const query = detail === 'summary' ? '' : `?detail=${detail}`;
    return await this.jsonRequest<DaemonStatusReport>(
      `/daemon/status${query}`,
      'GET /daemon/status',
    );
  }

  /**
   * Aggregate local token-usage dashboard (`GET /usage/dashboard`): the
   * selected range's flattened totals plus a trailing per-day heatmap, read
   * from the durable local usage history (global, cross-project). `range`
   * scopes the summary (default `today`); `heatmapDays` sets the heatmap
   * window (default ~6 months, server-clamped to 1..366).
   */
  async usageDashboard(
    opts: { range?: DaemonUsageRange; heatmapDays?: number } = {},
  ): Promise<DaemonUsageDashboard> {
    const params = new URLSearchParams();
    if (opts.range !== undefined) params.set('range', opts.range);
    if (opts.heatmapDays !== undefined) {
      params.set('heatmapDays', String(opts.heatmapDays));
    }
    const query = params.toString();
    return await this.jsonRequest<DaemonUsageDashboard>(
      `/usage/dashboard${query ? `?${query}` : ''}`,
      'GET /usage/dashboard',
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

  async initializeWorkspaceMcp(): Promise<DaemonWorkspaceMcpInitializeResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/initialize`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: '{}',
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /workspace/mcp/initialize');
        }
        return (await res.json()) as DaemonWorkspaceMcpInitializeResult;
      },
    );
  }

  async reloadWorkspaceMcp(): Promise<DaemonWorkspaceMcpInitializeResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/reload`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: '{}',
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /workspace/mcp/reload');
        }
        return (await res.json()) as DaemonWorkspaceMcpInitializeResult;
      },
    );
  }

  async workspaceGit(): Promise<DaemonWorkspaceGitStatus> {
    return await this.jsonRequest<DaemonWorkspaceGitStatus>(
      '/workspace/git',
      'GET /workspace/git',
      { mode: 'rest' },
    );
  }

  async workspaceMcpTools(
    serverName: string,
  ): Promise<DaemonWorkspaceMcpToolsStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/${urlEncode(serverName)}/tools`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/mcp/:server/tools');
        }
        return (await res.json()) as DaemonWorkspaceMcpToolsStatus;
      },
    );
  }

  async workspaceMcpResources(
    serverName: string,
  ): Promise<DaemonWorkspaceMcpResourcesStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/${urlEncode(serverName)}/resources`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            'GET /workspace/mcp/:server/resources',
          );
        }
        return (await res.json()) as DaemonWorkspaceMcpResourcesStatus;
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

  async workspaceAcpPreheat(
    timeoutMs?: number,
  ): Promise<DaemonWorkspaceAcpPreheatResult> {
    const serverBudgetMs = timeoutMs ?? 5_000;
    const suffix =
      timeoutMs !== undefined
        ? `?timeoutMs=${encodeURIComponent(timeoutMs)}`
        : '';
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/acp/preheat${suffix}`,
      { method: 'POST', headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /workspace/acp/preheat');
        }
        return (await res.json()) as DaemonWorkspaceAcpPreheatResult;
      },
      serverBudgetMs + 2_000,
    );
  }

  async workspaceAcpStatus(): Promise<DaemonWorkspaceAcpStatusResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/acp/status`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/acp/status');
        }
        return (await res.json()) as DaemonWorkspaceAcpStatusResult;
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/hooks`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok)
          throw await this.failOnError(res, 'GET /session/:id/hooks');
        return (await res.json()) as DaemonSessionHooksStatus;
      },
    );
  }

  async workspaceExtensions(): Promise<DaemonWorkspaceExtensionsStatus> {
    return await this.jsonRequest<DaemonWorkspaceExtensionsStatus>(
      '/workspace/extensions',
      'GET /workspace/extensions',
      { mode: 'rest' },
    );
  }

  async installExtension(
    params: ExtensionInstallRequest,
    clientId?: string,
  ): Promise<ExtensionInstallResponse> {
    return await this.jsonRequest<ExtensionInstallResponse>(
      '/workspace/extensions/install',
      'POST /workspace/extensions/install',
      { method: 'POST', body: params, clientId, mode: 'rest' },
    );
  }

  async extensionOperationStatus(
    operationId: string,
  ): Promise<ExtensionOperationStatus> {
    return await this.jsonRequest<ExtensionOperationStatus>(
      `/workspace/extensions/operations/${urlEncode(operationId)}`,
      'GET /workspace/extensions/operations/:operationId',
      { mode: 'rest' },
    );
  }

  async activeExtensionOperations(): Promise<ExtensionActiveOperations> {
    return await this.jsonRequest<ExtensionActiveOperations>(
      '/workspace/extensions/operations',
      'GET /workspace/extensions/operations',
      { mode: 'rest' },
    );
  }

  async respondToExtensionInteraction(
    operationId: string,
    interactionId: string,
    response: ExtensionInteractionResponse,
    clientId?: string,
  ): Promise<ExtensionInteractionResponseResult> {
    return await this.jsonRequest<ExtensionInteractionResponseResult>(
      `/workspace/extensions/operations/${urlEncode(operationId)}/interactions/${urlEncode(interactionId)}`,
      'POST /workspace/extensions/operations/:operationId/interactions/:interactionId',
      { method: 'POST', body: response, clientId, mode: 'rest' },
    );
  }

  async checkExtensionUpdates(
    clientId?: string,
  ): Promise<ExtensionUpdateCheckResponse> {
    return await this.jsonRequest<ExtensionUpdateCheckResponse>(
      '/workspace/extensions/check-updates',
      'POST /workspace/extensions/check-updates',
      { method: 'POST', body: {}, clientId, mode: 'rest' },
    );
  }

  async refreshExtensions(
    clientId?: string,
  ): Promise<ExtensionRefreshResponse> {
    return await this.jsonRequest<ExtensionRefreshResponse>(
      '/workspace/extensions/refresh',
      'POST /workspace/extensions/refresh',
      { method: 'POST', body: {}, clientId, mode: 'rest' },
    );
  }

  async enableExtension(
    name: string,
    params: ExtensionScopeRequest,
    clientId?: string,
  ): Promise<ExtensionMutationResponse> {
    return await this.jsonRequest<ExtensionMutationResponse>(
      `/workspace/extensions/${urlEncode(name)}/enable`,
      'POST /workspace/extensions/:name/enable',
      { method: 'POST', body: params, clientId, mode: 'rest' },
    );
  }

  async disableExtension(
    name: string,
    params: ExtensionScopeRequest,
    clientId?: string,
  ): Promise<ExtensionMutationResponse> {
    return await this.jsonRequest<ExtensionMutationResponse>(
      `/workspace/extensions/${urlEncode(name)}/disable`,
      'POST /workspace/extensions/:name/disable',
      { method: 'POST', body: params, clientId, mode: 'rest' },
    );
  }

  async updateExtension(
    name: string,
    clientId?: string,
  ): Promise<ExtensionMutationResponse> {
    return await this.jsonRequest<ExtensionMutationResponse>(
      `/workspace/extensions/${urlEncode(name)}/update`,
      'POST /workspace/extensions/:name/update',
      { method: 'POST', body: {}, clientId, mode: 'rest' },
    );
  }

  async uninstallExtension(
    name: string,
    clientId?: string,
  ): Promise<ExtensionMutationResponse> {
    return await this.jsonRequest<ExtensionMutationResponse>(
      `/workspace/extensions/${urlEncode(name)}`,
      'DELETE /workspace/extensions/:name',
      { method: 'DELETE', clientId, mode: 'rest' },
    );
  }

  async extensionCatalog(): Promise<ExtensionCatalog> {
    return await this.jsonRequest<ExtensionCatalog>(
      '/extensions',
      'GET /extensions',
      { mode: 'rest' },
    );
  }

  async installUserExtension(
    params: ExtensionManagementInstallRequest,
    clientId?: string,
  ): Promise<ExtensionInstallResponse> {
    return await this.jsonRequest<ExtensionInstallResponse>(
      '/extensions/install',
      'POST /extensions/install',
      { method: 'POST', body: params, clientId, mode: 'rest' },
    );
  }

  async checkUserExtensionUpdates(
    clientId?: string,
  ): Promise<ExtensionInstallResponse> {
    return await this.jsonRequest<ExtensionInstallResponse>(
      '/extensions/check-updates',
      'POST /extensions/check-updates',
      { method: 'POST', body: {}, clientId, mode: 'rest' },
    );
  }

  async updateUserExtension(
    extensionId: string,
    clientId?: string,
  ): Promise<ExtensionMutationResponse> {
    return await this.jsonRequest<ExtensionMutationResponse>(
      `/extensions/${urlEncode(extensionId)}/update`,
      'POST /extensions/:extensionId/update',
      { method: 'POST', body: {}, clientId, mode: 'rest' },
    );
  }

  async uninstallUserExtension(
    extensionId: string,
    clientId?: string,
  ): Promise<ExtensionMutationResponse | undefined> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/extensions/${urlEncode(extensionId)}`,
      {
        method: 'DELETE',
        headers: this.headers({}, clientId),
      },
      async (res) => {
        if (res.status === 204) {
          await res.body?.cancel().catch(() => undefined);
          return undefined;
        }
        if (!res.ok) {
          throw await this.failOnError(res, 'DELETE /extensions/:extensionId');
        }
        return (await res.json()) as ExtensionMutationResponse;
      },
      undefined,
      'rest',
    );
  }

  async setExtensionDefaultActivation(
    extensionId: string,
    state: ExtensionActivationState,
    clientId?: string,
  ): Promise<ExtensionMutationResponse> {
    return await this.jsonRequest<ExtensionMutationResponse>(
      `/extensions/${urlEncode(extensionId)}/activation`,
      'PUT /extensions/:extensionId/activation',
      { method: 'PUT', body: { state }, clientId, mode: 'rest' },
    );
  }

  async extensionOperation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ExtensionOperationStatus> {
    return await this.jsonRequest<ExtensionOperationStatus>(
      `/extensions/operations/${urlEncode(operationId)}`,
      'GET /extensions/operations/:operationId',
      signal ? { signal, mode: 'rest' } : { mode: 'rest' },
    );
  }

  async waitForExtensionOperation(
    handle: ExtensionInstallResponse,
    options: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ExtensionOperationStatus> {
    const pollIntervalMs = options.pollIntervalMs ?? 1_000;
    const timeoutMs = options.timeoutMs ?? 10 * 60_000;
    const hasDeadline = timeoutMs !== Number.POSITIVE_INFINITY;
    const deadline = Date.now() + timeoutMs;
    const timeoutError = () =>
      new Error(
        `Timed out waiting for extension operation ${handle.operationId}. The server operation was not cancelled.`,
      );
    for (;;) {
      options.signal?.throwIfAborted();
      const pollBudgetMs = deadline - Date.now();
      if (pollBudgetMs <= 0 || Number.isNaN(pollBudgetMs)) {
        throw timeoutError();
      }
      let operation: ExtensionOperationStatus;
      if (!hasDeadline) {
        operation = await this.extensionOperation(
          handle.operationId,
          options.signal,
        );
      } else {
        const deadlineController = new AbortController();
        const pollSignal = options.signal
          ? composeAbortSignals([options.signal, deadlineController.signal])
          : deadlineController.signal;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        const deadlinePromise = new Promise<never>((_, reject) => {
          const expire = () => {
            const error = timeoutError();
            reject(error);
            deadlineController.abort(error);
          };
          const schedule = () => {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
              expire();
              return;
            }
            deadlineTimer = setTimeout(
              () => {
                if (Date.now() >= deadline) {
                  expire();
                } else {
                  schedule();
                }
              },
              Math.min(remainingMs, MAX_TIMER_DELAY_MS),
            );
          };
          schedule();
        });
        try {
          operation = await Promise.race([
            this.extensionOperation(handle.operationId, pollSignal),
            deadlinePromise,
          ]);
        } finally {
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
          deadlineController.abort();
        }
      }
      if (operation.status !== 'queued' && operation.status !== 'running') {
        return operation;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw timeoutError();
      }
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const timer = setTimeout(
          finish,
          Math.min(pollIntervalMs, remainingMs, MAX_TIMER_DELAY_MS),
        );
        const onAbort = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
          reject(
            options.signal?.reason ?? new DOMException('Aborted', 'AbortError'),
          );
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
      });
    }
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

  /**
   * Queue a hidden managed-memory remember task for the daemon's bound
   * workspace. This does not require an existing session; callers should
   * poll `getWorkspaceMemoryRememberTask()` until the task is terminal.
   */
  async rememberWorkspaceMemory(
    content: string,
    opts: DaemonWorkspaceMemoryRememberOptions = {},
  ): Promise<DaemonWorkspaceMemoryRememberTask> {
    return await this.jsonRequest<DaemonWorkspaceMemoryRememberTask>(
      WORKSPACE_MEMORY_REMEMBER_PATH,
      `POST ${WORKSPACE_MEMORY_REMEMBER_PATH}`,
      {
        method: 'POST',
        body: {
          content,
          contextMode: opts.contextMode ?? 'workspace',
        },
        clientId: opts.clientId,
      },
    );
  }

  async getWorkspaceMemoryRememberTask(
    taskId: string,
    opts?: { clientId?: string },
  ): Promise<DaemonWorkspaceMemoryRememberTask> {
    return await this.jsonRequest(
      `${WORKSPACE_MEMORY_REMEMBER_PATH}/${urlEncode(taskId)}`,
      `GET ${WORKSPACE_MEMORY_REMEMBER_PATH}/:taskId`,
      { clientId: opts?.clientId },
    );
  }

  async forgetWorkspaceMemory(
    query: string,
    opts: DaemonWorkspaceMemoryForgetOptions = {},
  ): Promise<DaemonWorkspaceMemoryForgetTask> {
    return await this.jsonRequest<DaemonWorkspaceMemoryForgetTask>(
      WORKSPACE_MEMORY_FORGET_PATH,
      `POST ${WORKSPACE_MEMORY_FORGET_PATH}`,
      {
        method: 'POST',
        body: { query },
        clientId: opts.clientId,
      },
    );
  }

  async getWorkspaceMemoryForgetTask(
    taskId: string,
    opts?: { clientId?: string },
  ): Promise<DaemonWorkspaceMemoryForgetTask> {
    return await this.jsonRequest(
      `${WORKSPACE_MEMORY_FORGET_PATH}/${urlEncode(taskId)}`,
      `GET ${WORKSPACE_MEMORY_FORGET_PATH}/:taskId`,
      { clientId: opts?.clientId },
    );
  }

  async dreamWorkspaceMemory(
    opts: DaemonWorkspaceMemoryDreamOptions = {},
  ): Promise<DaemonWorkspaceMemoryDreamTask> {
    return await this.jsonRequest<DaemonWorkspaceMemoryDreamTask>(
      WORKSPACE_MEMORY_DREAM_PATH,
      `POST ${WORKSPACE_MEMORY_DREAM_PATH}`,
      {
        method: 'POST',
        body: {},
        clientId: opts.clientId,
      },
    );
  }

  async getWorkspaceMemoryDreamTask(
    taskId: string,
    opts?: { clientId?: string },
  ): Promise<DaemonWorkspaceMemoryDreamTask> {
    return await this.jsonRequest(
      `${WORKSPACE_MEMORY_DREAM_PATH}/${urlEncode(taskId)}`,
      `GET ${WORKSPACE_MEMORY_DREAM_PATH}/:taskId`,
      { clientId: opts?.clientId },
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
      `${this.baseUrl}/workspace/agents/${urlEncode(agentType)}`,
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
      ? `${this.baseUrl}/workspace/agents/${urlEncode(agentType)}?scope=${urlEncode(opts.scope)}`
      : `${this.baseUrl}/workspace/agents/${urlEncode(agentType)}`;
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
      ? `${this.baseUrl}/workspace/agents/${urlEncode(agentType)}?scope=${urlEncode(opts.scope)}`
      : `${this.baseUrl}/workspace/agents/${urlEncode(agentType)}`;
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
    if (req.sourceType !== undefined || req.sourceId !== undefined) {
      await this.requireCapability('session_source_metadata');
    }
    // Omitting `cwd` lets the daemon fall back to its
    // primary workspace. JSON.stringify strips `undefined` values, so
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
          ...(req.approvalMode !== undefined
            ? { approvalMode: req.approvalMode }
            : {}),
          ...(req.sourceType !== undefined
            ? { sourceType: req.sourceType }
            : {}),
          ...(req.sourceId !== undefined ? { sourceId: req.sourceId } : {}),
        }),
      },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, 'POST /session');
        return (await res.json()) as DaemonSession;
      },
    );
  }

  /**
   * Enumerate the session catalog for a workspace. Used by session-picker UIs.
   * Returns an empty list (not 404) when the workspace has no sessions.
   */
  async listWorkspaceSessions(
    workspaceCwd: string,
    options?: {
      pageSize?: number;
      archiveState?: DaemonSessionArchiveState;
      parentSessionId?: string;
      sourceType?: string;
      sourceId?: string;
    },
  ): Promise<DaemonSessionSummary[]> {
    const page = await this.listWorkspaceSessionsPage(workspaceCwd, options);
    return page.sessions;
  }

  async listWorkspaceSessionsPage(
    workspaceCwd: string,
    options?: DaemonSessionListPageOptions,
  ): Promise<DaemonSessionListPage> {
    if (options?.sourceType !== undefined || options?.sourceId !== undefined) {
      await this.requireCapability('session_source_metadata');
    }
    const requestedPageSize =
      options?.pageSize ?? DEFAULT_SESSION_LIST_PAGE_SIZE;
    const pageSize = Math.max(
      1,
      Math.min(
        1000,
        Math.round(
          Number.isFinite(requestedPageSize)
            ? requestedPageSize
            : DEFAULT_SESSION_LIST_PAGE_SIZE,
        ),
      ),
    );
    const query = new URLSearchParams({ size: String(pageSize) });
    if (options?.cursor !== undefined) {
      query.set('cursor', options.cursor);
    }
    if (options?.archiveState !== undefined) {
      query.set('archiveState', options.archiveState);
    }
    if (options?.view !== undefined) {
      query.set('view', options.view);
    }
    if (options?.group !== undefined) {
      query.set('group', options.group);
    }
    if (options?.parentSessionId !== undefined) {
      query.set('parentSessionId', options.parentSessionId);
    }
    if (options?.sourceType !== undefined) {
      query.set('sourceType', options.sourceType);
    }
    if (options?.sourceId !== undefined) {
      query.set('sourceId', options.sourceId);
    }
    return await this.jsonRequest<DaemonSessionListPage>(
      `/workspace/${urlEncode(workspaceCwd)}/sessions?${query.toString()}`,
      'GET /workspace/sessions',
    );
  }

  async listSessionGroups(
    workspaceCwd: string,
  ): Promise<DaemonSessionGroupCatalog> {
    return await this.jsonRequest<DaemonSessionGroupCatalog>(
      `/workspace/${urlEncode(workspaceCwd)}/session-groups`,
      'GET /workspace/session-groups',
    );
  }

  async createSessionGroup(
    workspaceCwd: string,
    input: DaemonSessionGroupInput,
  ): Promise<DaemonSessionGroup> {
    const body = await this.jsonRequest<{ group: DaemonSessionGroup }>(
      `/workspace/${urlEncode(workspaceCwd)}/session-groups`,
      'POST /workspace/session-groups',
      { method: 'POST', body: input },
    );
    return body.group;
  }

  async updateSessionGroup(
    workspaceCwd: string,
    groupId: string,
    update: DaemonSessionGroupUpdate,
  ): Promise<DaemonSessionGroup> {
    const body = await this.jsonRequest<{ group: DaemonSessionGroup }>(
      `/workspace/${urlEncode(workspaceCwd)}/session-groups/${urlEncode(groupId)}`,
      'PATCH /workspace/session-groups/:groupId',
      { method: 'PATCH', body: update },
    );
    return body.group;
  }

  async deleteSessionGroup(
    workspaceCwd: string,
    groupId: string,
  ): Promise<{ deleted: boolean }> {
    return await this.jsonRequest<{ deleted: boolean }>(
      `/workspace/${urlEncode(workspaceCwd)}/session-groups/${urlEncode(groupId)}`,
      'DELETE /workspace/session-groups/:groupId',
      { method: 'DELETE' },
    );
  }

  async updateSessionOrganization(
    sessionId: string,
    update: DaemonSessionOrganizationUpdate,
    clientId?: string,
  ): Promise<DaemonSessionOrganizationResult> {
    return await this.jsonRequest<DaemonSessionOrganizationResult>(
      `/session/${urlEncode(sessionId)}/organization`,
      'PATCH /session/:id/organization',
      { method: 'PATCH', body: update, clientId },
    );
  }

  async loadSession(
    sessionId: string,
    req: RestoreSessionRequest = {},
    clientId?: string,
  ): Promise<DaemonRestoredSession> {
    return this.restoreSession('load', sessionId, req, clientId);
  }

  async exportSession(
    sessionId: string,
    opts: {
      format?: DaemonSessionExportFormat;
      clientId?: string;
    } = {},
  ): Promise<DaemonSessionExportResult> {
    return await this.sessionExportRequest(
      `/session/${urlEncode(sessionId)}/export`,
      'GET /session/:id/export',
      opts,
    );
  }

  async getSessionTranscriptPage(
    sessionId: string,
    opts: DaemonSessionTranscriptPageOptions = {},
  ): Promise<DaemonSessionTranscriptPage> {
    return await this.jsonRequest<DaemonSessionTranscriptPage>(
      `/session/${urlEncode(sessionId)}/transcript${transcriptPageSuffix(opts)}`,
      'GET /session/:id/transcript',
      {
        clientId: opts.clientId,
        mode: 'rest',
      },
    );
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/branch`,
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

  async forkSession(
    sessionId: string,
    req: ForkSessionRequest,
    clientId?: string,
  ): Promise<DaemonForkSessionResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/fork`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify({ directive: req.directive }),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /session/:id/fork');
        }
        return (await res.json()) as DaemonForkSessionResult;
      },
    );
  }

  async sessionContext(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionContextStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/context`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /session/:id/context');
        }
        return (await res.json()) as DaemonSessionContextStatus;
      },
    );
  }

  /**
   * Read the current in-memory runtime status for one live daemon session.
   */
  async sessionStatus(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionSummary> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/status`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /session/:id/status');
        }
        return (await res.json()) as DaemonSessionSummary;
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/context-usage${
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/supported-commands`,
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/tasks`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /session/:id/tasks');
        }
        return (await res.json()) as DaemonSessionTasksStatus;
      },
    );
  }

  async sessionLspStatus(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionLspStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/lsp`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /session/:id/lsp');
        }
        return (await res.json()) as DaemonSessionLspStatus;
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/tasks/${urlEncode(taskId)}/cancel`,
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/goal/clear`,
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/stats`,
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/${action}`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify({
          cwd: req.workspaceCwd,
          ...(req.approvalMode !== undefined
            ? { approvalMode: req.approvalMode }
            : {}),
          ...(action === 'load' && req.historyPageSize !== undefined
            ? { historyPageSize: req.historyPageSize }
            : {}),
        }),
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/approval-mode`,
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/rewind/snapshots`,
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
      undefined,
      'rest',
    );
  }

  async rewindSession(
    sessionId: string,
    promptId: string,
    opts?: { clientId?: string; rewindFiles?: boolean },
  ): Promise<DaemonRewindResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/rewind`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: JSON.stringify({
          promptId,
          ...(opts?.rewindFiles !== undefined
            ? { rewindFiles: opts.rewindFiles }
            : {}),
        }),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /session/:id/rewind');
        }
        return (await res.json()) as DaemonRewindResult;
      },
      undefined,
      'rest',
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/recap`,
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

  async *generateSessionContent(
    sessionId: string,
    prompt: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): AsyncGenerator<DaemonSessionGenerationEvent> {
    const res = await this.transport.fetch(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/generate`,
      {
        method: 'POST',
        headers: this.headers(
          {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
          },
          opts?.clientId,
        ),
        body: JSON.stringify({ prompt }),
        signal: opts?.signal,
      },
    );
    if (!res.ok) {
      throw await this.failOnError(res, 'POST /session/:id/generate');
    }
    if (!res.body) throw new Error('Generation response body is missing');
    for await (const event of parseSseStream(res.body, opts?.signal)) {
      const generationEvent = parseSessionGenerationEvent(event);
      if (generationEvent) yield generationEvent;
    }
  }

  async btwSession(
    sessionId: string,
    question: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<DaemonSessionBtwResult> {
    const res = await this.transport.fetch(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/btw`,
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
   * Queue a user message typed while the session's turn is still running. The
   * ACP child drains it between tool batches so the model sees it before the
   * turn ends. Resolves `{ accepted: false }` when the session is idle — the
   * caller should then send the message as a normal next-turn prompt.
   */
  async enqueueMidTurnMessage(
    sessionId: string,
    message: string,
    opts?: { signal?: AbortSignal; clientId?: string },
  ): Promise<DaemonMidTurnMessageResult> {
    // Route through `fetchWithTimeout` like every other method so a hung daemon
    // can't wedge this promise forever (the caller in `actions.ts` awaits it).
    // The helper composes any caller `signal` (the turn-scoped abort) WITH its
    // timeout controller, so the mid-turn-settle abort still propagates.
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/mid-turn-message`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: JSON.stringify({ message }),
        signal: opts?.signal,
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            'POST /session/:id/mid-turn-message',
          );
        }
        return (await res.json()) as DaemonMidTurnMessageResult;
      },
    );
  }

  /**
   * List prompts in the daemon's per-session pending queue. Includes the
   * currently running prompt (`state: 'running'`) and any FIFO-waiting
   * prompts (`state: 'queued'`). Returns an empty array when no prompts
   * are pending.
   */
  async getPendingPrompts(
    sessionId: string,
    opts?: { clientId?: string },
  ): Promise<DaemonPendingPromptsResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/pending-prompts`,
      {
        method: 'GET',
        headers: this.headers({}, opts?.clientId),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /session/:id/pending-prompts');
        }
        return (await res.json()) as DaemonPendingPromptsResult;
      },
    );
  }

  /**
   * Remove a specific prompt from the daemon's pending queue. For queued
   * prompts this aborts them so the FIFO skips dispatch; for the running
   * prompt this triggers a cancel. Returns `{ removed: false }` when the
   * promptId is not found.
   */
  async removePendingPrompt(
    sessionId: string,
    promptId: string,
    opts?: { clientId?: string },
  ): Promise<DaemonRemovePendingPromptResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/pending-prompts/${urlEncode(promptId)}`,
      {
        method: 'DELETE',
        headers: this.headers({}, opts?.clientId),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            'DELETE /session/:id/pending-prompts/:promptId',
          );
        }
        return (await res.json()) as DaemonRemovePendingPromptResult;
      },
    );
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/shell`,
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
      `${this.baseUrl}/workspace/tools/${urlEncode(toolName)}/enable`,
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

  /**
   * Toggle a user-invocable skill in workspace `skills.disabled` settings.
   * Active ACP sessions refresh their skill validation and command lists before
   * the response returns; `activation` reports deferred or partial refreshes.
   *
   * Pre-flight `caps.features.includes('workspace_skill_toggle')` before calling.
   */
  async setWorkspaceSkillEnabled(
    skillName: string,
    enabled: boolean,
    opts?: { clientId?: string },
  ): Promise<DaemonSkillToggleResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/skills/${urlEncode(skillName)}/enable`,
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
            'POST /workspace/skills/:name/enable',
          );
        }
        return (await res.json()) as DaemonSkillToggleResult;
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
    scope: 'workspace' | 'user',
    key: string,
    value: unknown,
    opts?: {
      clientId?: string;
      mcpServerMutation?: { operation: 'set' | 'remove'; name: string };
    },
  ): Promise<DaemonSettingUpdateResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/settings`,
      {
        method: 'POST',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: JSON.stringify({
          scope,
          key,
          value,
          ...(opts?.mcpServerMutation
            ? { mcpServerMutation: opts.mcpServerMutation }
            : {}),
        }),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /workspace/settings');
        }
        return (await res.json()) as DaemonSettingUpdateResult;
      },
    );
  }

  async deleteModel(
    target: DaemonModelDeleteRequest,
    opts?: { clientId?: string },
  ): Promise<DaemonModelDeleteResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/models`,
      {
        method: 'DELETE',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: JSON.stringify(target),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'DELETE /workspace/models');
        }
        return (await res.json()) as DaemonModelDeleteResult;
      },
    );
  }

  async workspaceVoice(clientId?: string): Promise<DaemonWorkspaceVoiceStatus> {
    return await this.jsonRequest<DaemonWorkspaceVoiceStatus>(
      '/workspace/voice',
      'GET /workspace/voice',
      { clientId },
    );
  }

  async setWorkspaceVoice(
    update: DaemonWorkspaceVoiceUpdate,
    clientId?: string,
  ): Promise<DaemonWorkspaceVoiceStatus> {
    return await this.jsonRequest<DaemonWorkspaceVoiceStatus>(
      '/workspace/voice',
      'POST /workspace/voice',
      { method: 'POST', body: update, clientId },
    );
  }

  async transcribeWorkspaceVoice(
    audio: DaemonVoiceAudioInput,
    opts: DaemonWorkspaceVoiceTranscribeOptions,
  ): Promise<DaemonWorkspaceVoiceTranscriptionResult> {
    return await this.voiceTranscriptionRequest(
      '/workspace/voice/transcribe',
      'POST /workspace/voice/transcribe',
      audio,
      opts,
    );
  }

  /** @internal */
  async workspaceVoiceTranscriptionRequest(
    workspaceSelector: string,
    audio: DaemonVoiceAudioInput,
    opts: DaemonWorkspaceVoiceTranscribeOptions,
  ): Promise<DaemonWorkspaceVoiceTranscriptionResult> {
    return await this.voiceTranscriptionRequest(
      `/workspaces/${workspaceSelector}/voice/transcribe`,
      'POST /workspaces/:workspace/voice/transcribe',
      audio,
      opts,
    );
  }

  private async voiceTranscriptionRequest(
    path: string,
    label: string,
    audio: DaemonVoiceAudioInput,
    opts: DaemonWorkspaceVoiceTranscribeOptions,
  ): Promise<DaemonWorkspaceVoiceTranscriptionResult> {
    const query = opts.voiceModel
      ? `?${new URLSearchParams({ voiceModel: opts.voiceModel }).toString()}`
      : '';
    return await this.fetchWithTimeout(
      `${this.baseUrl}${path}${query}`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': opts.mimeType }, opts.clientId),
        body: audio as BodyInit,
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, label);
        }
        return (await res.json()) as DaemonWorkspaceVoiceTranscriptionResult;
      },
      opts.timeoutMs ?? VOICE_TRANSCRIPTION_DEFAULT_TIMEOUT_MS,
      'rest',
    );
  }

  async workspaceTrust(opts?: {
    clientId?: string;
  }): Promise<DaemonWorkspaceTrustStatus> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/trust`,
      {
        method: 'GET',
        headers: this.headers({}, opts?.clientId),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/trust');
        }
        return (await res.json()) as DaemonWorkspaceTrustStatus;
      },
    );
  }

  async requestWorkspaceTrustChange(
    request: DaemonWorkspaceTrustChangeRequest,
    clientId?: string,
  ): Promise<DaemonWorkspaceTrustChangeResult> {
    return await this.jsonRequest<DaemonWorkspaceTrustChangeResult>(
      '/workspace/trust/request',
      'POST /workspace/trust/request',
      { method: 'POST', body: request, clientId },
    );
  }

  async workspacePermissions(opts?: {
    clientId?: string;
  }): Promise<DaemonWorkspacePermissionsStatus> {
    return await this.jsonRequest<DaemonWorkspacePermissionsStatus>(
      '/workspace/permissions',
      'GET /workspace/permissions',
      { clientId: opts?.clientId },
    );
  }

  /**
   * Replace one permission rule list.
   *
   * `capabilities.features` including `workspace_permissions` means the
   * daemon exposes the permissions surface. A write still needs a live ACP
   * session so the active child can receive the update; without one the
   * daemon rejects the request with `permission_session_required`.
   */
  async setWorkspacePermissionRules(
    scope: DaemonPermissionScope,
    ruleType: DaemonPermissionRuleType,
    rules: readonly string[],
    opts?: { clientId?: string },
  ): Promise<DaemonWorkspacePermissionsStatus> {
    return await this.jsonRequest<DaemonWorkspacePermissionsStatus>(
      '/workspace/permissions',
      'POST /workspace/permissions',
      {
        method: 'POST',
        body: { scope, ruleType, rules: [...rules] },
        clientId: opts?.clientId,
      },
    );
  }

  /**
   * Convenience helper that appends a single rule to the specified scope/type
   * list. Performs a non-atomic read-modify-write: GETs the current rules,
   * appends the new rule locally, then POSTs the full replacement list.
   *
   * @remarks Not safe for concurrent use — a concurrent modification between
   * the GET and POST will be silently overwritten (lost-update / TOCTOU).
   */
  async addWorkspacePermissionRule(
    scope: DaemonPermissionScope,
    ruleType: DaemonPermissionRuleType,
    rule: string,
    opts?: { clientId?: string },
  ): Promise<DaemonWorkspacePermissionsStatus> {
    const normalized = normalizePermissionRuleInput(rule);
    const current = await this.workspacePermissions(opts);
    const rules = current[scope].rules[ruleType];
    if (rules.includes(normalized)) return current;
    return await this.setWorkspacePermissionRules(
      scope,
      ruleType,
      [...rules, normalized],
      opts,
    );
  }

  /**
   * Convenience helper that removes a single rule from the specified scope/type
   * list. Performs a non-atomic read-modify-write: GETs the current rules,
   * removes the rule locally, then POSTs the full replacement list.
   *
   * @remarks Not safe for concurrent use — a concurrent modification between
   * the GET and POST will be silently overwritten (lost-update / TOCTOU).
   */
  async removeWorkspacePermissionRule(
    scope: DaemonPermissionScope,
    ruleType: DaemonPermissionRuleType,
    rule: string,
    opts?: { clientId?: string },
  ): Promise<DaemonWorkspacePermissionsStatus> {
    const normalized = normalizePermissionRuleInput(rule);
    const current = await this.workspacePermissions(opts);
    const rules = current[scope].rules[ruleType];
    if (!rules.includes(normalized)) return current;
    return await this.setWorkspacePermissionRules(
      scope,
      ruleType,
      rules.filter((item) => item !== normalized),
      opts,
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
        : `?entryIndex=${urlEncode(String(opts.entryIndex))}`;
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/${urlEncode(serverName)}/restart${query}`,
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

  /**
   * Reload the daemon-managed channel worker: the daemon stops and relaunches
   * it so it re-reads settings.json (channels / proxy / per-channel model).
   * Requires an enabled runtime selection; otherwise the route responds 409.
   * Pre-flight the dynamic `channel_reload` capability.
   */
  async reloadChannelWorker(opts?: {
    clientId?: string;
    timeoutMs?: number;
  }): Promise<DaemonChannelReloadResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/channel/reload`,
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
          throw await this.failOnError(res, 'POST /workspace/channel/reload');
        }
        return (await res.json()) as DaemonChannelReloadResult;
      },
      opts?.timeoutMs ?? CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS,
    );
  }

  async getChannelWorkerControl(opts?: {
    clientId?: string;
    timeoutMs?: number;
  }): Promise<DaemonChannelControlState> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/channel`,
      {
        method: 'GET',
        headers: this.headers({}, opts?.clientId),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'GET /workspace/channel');
        }
        return (await res.json()) as DaemonChannelControlState;
      },
      opts?.timeoutMs,
    );
  }

  async setChannelWorkerSelection(
    selection: DaemonChannelSelection,
    opts?: { clientId?: string; timeoutMs?: number },
  ): Promise<DaemonChannelSetResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/channel`,
      {
        method: 'PUT',
        headers: this.headers(
          { 'Content-Type': 'application/json' },
          opts?.clientId,
        ),
        body: JSON.stringify({ selection }),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'PUT /workspace/channel');
        }
        return (await res.json()) as DaemonChannelSetResult;
      },
      opts?.timeoutMs ?? CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS,
    );
  }

  async stopChannelWorker(opts?: {
    clientId?: string;
    timeoutMs?: number;
  }): Promise<DaemonChannelStopResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/channel`,
      {
        method: 'DELETE',
        headers: this.headers({}, opts?.clientId),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'DELETE /workspace/channel');
        }
        return (await res.json()) as DaemonChannelStopResult;
      },
      opts?.timeoutMs ?? CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS,
    );
  }

  async manageMcpServer(
    serverName: string,
    action: DaemonMcpManageAction,
    opts?: { clientId?: string; timeoutMs?: number },
  ): Promise<DaemonMcpManageResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/${urlEncode(serverName)}/${urlEncode(action)}`,
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
      `${this.baseUrl}/workspace/mcp/servers/${urlEncode(name)}`,
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

  async setupGithub(
    params: DaemonGithubSetupRequest,
    clientId?: string,
  ): Promise<DaemonGithubSetupResult> {
    return await this.jsonRequest<DaemonGithubSetupResult>(
      '/workspace/setup-github',
      'POST /workspace/setup-github',
      {
        method: 'POST',
        body: params,
        clientId,
        timeoutMs: GITHUB_SETUP_DEFAULT_TIMEOUT_MS,
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/model`,
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/language`,
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
        `${this.baseUrl}/session/${urlEncode(sessionId)}/prompt`,
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/prompt`,
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/heartbeat`,
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/cancel`,
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
      `${this.baseUrl}/permission/${urlEncode(requestId)}`,
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/permission/${urlEncode(requestId)}`,
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}`,
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

  async detachSession(sessionId: string, clientId?: string): Promise<void> {
    if (!clientId) return;
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/detach`,
      {
        method: 'POST',
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
        throw await this.failOnError(res, 'POST /session/:id/detach');
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

  async archiveSessionsData(
    sessionIds: string[],
    clientId?: string,
  ): Promise<DaemonArchiveSessionsResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/sessions/archive`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify({ sessionIds }),
      },
      async (res) => {
        if (res.ok) {
          return (await res.json()) as DaemonArchiveSessionsResult;
        }
        throw await this.failOnError(res, 'POST /sessions/archive');
      },
    );
  }

  async unarchiveSessionsData(
    sessionIds: string[],
    clientId?: string,
  ): Promise<DaemonUnarchiveSessionsResult> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/sessions/unarchive`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }, clientId),
        body: JSON.stringify({ sessionIds }),
      },
      async (res) => {
        if (res.ok) {
          return (await res.json()) as DaemonUnarchiveSessionsResult;
        }
        throw await this.failOnError(res, 'POST /sessions/unarchive');
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
      `${this.baseUrl}/workspace/auth/device-flow/${urlEncode(deviceFlowId)}`,
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
      `${this.baseUrl}/workspace/auth/device-flow/${urlEncode(deviceFlowId)}`,
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

  async addWorkspace(
    cwd: string,
    options: { persist?: boolean } = {},
  ): Promise<{
    id: string;
    cwd: string;
    primary: boolean;
    trusted: boolean;
    persisted?: boolean;
  }> {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspaces`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          cwd,
          ...(options.persist ? { persist: true } : {}),
        }),
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, 'POST /workspaces');
        }
        return (await res.json()) as {
          id: string;
          cwd: string;
          primary: boolean;
          trusted: boolean;
          persisted?: boolean;
        };
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

  // -- Session artifacts ---------------------------------------------------

  async listSessionArtifacts(
    sessionId: string,
    clientId?: string,
  ): Promise<DaemonSessionArtifactsEnvelope> {
    return await this.jsonRequest<DaemonSessionArtifactsEnvelope>(
      `/session/${urlEncode(sessionId)}/artifacts`,
      'GET /session/:id/artifacts',
      { clientId },
    );
  }

  async addSessionArtifact(
    sessionId: string,
    artifact: DaemonSessionArtifactInput,
    clientId?: string,
  ): Promise<DaemonSessionArtifactMutationResult> {
    return await this.jsonRequest<DaemonSessionArtifactMutationResult>(
      `/session/${urlEncode(sessionId)}/artifacts`,
      'POST /session/:id/artifacts',
      {
        method: 'POST',
        body: artifact,
        clientId,
      },
    );
  }

  async removeSessionArtifact(
    sessionId: string,
    artifactId: string,
    clientId?: string,
  ): Promise<DaemonSessionArtifactMutationResult> {
    return await this.jsonRequest<DaemonSessionArtifactMutationResult>(
      `/session/${urlEncode(sessionId)}/artifacts/${urlEncode(artifactId)}`,
      'DELETE /session/:id/artifacts/:artifactId',
      {
        method: 'DELETE',
        clientId,
      },
    );
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
      `${this.baseUrl}/session/${urlEncode(sessionId)}/metadata`,
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

export class WorkspaceDaemonClient {
  constructor(
    private readonly client: DaemonClient,
    private readonly workspaceSelector: string,
  ) {}

  workspaceMcp(): Promise<DaemonWorkspaceMcpStatus> {
    return this.get('/mcp', 'GET /workspaces/:workspace/mcp');
  }

  initializeWorkspaceMcp(): Promise<DaemonWorkspaceMcpInitializeResult> {
    return this.post(
      '/mcp/initialize',
      'POST /workspaces/:workspace/mcp/initialize',
      {},
    );
  }

  reloadWorkspaceMcp(): Promise<DaemonWorkspaceMcpInitializeResult> {
    return this.post(
      '/mcp/reload',
      'POST /workspaces/:workspace/mcp/reload',
      {},
    );
  }

  workspaceVoice(clientId?: string): Promise<DaemonWorkspaceVoiceStatus> {
    return this.client.workspaceJsonRequest<DaemonWorkspaceVoiceStatus>(
      this.workspaceSelector,
      '/voice',
      'GET /workspaces/:workspace/voice',
      { clientId, mode: 'rest' },
    );
  }

  setWorkspaceVoice(
    update: DaemonWorkspaceVoiceUpdate,
    clientId?: string,
  ): Promise<DaemonWorkspaceVoiceStatus> {
    return this.client.workspaceJsonRequest<DaemonWorkspaceVoiceStatus>(
      this.workspaceSelector,
      '/voice',
      'POST /workspaces/:workspace/voice',
      { method: 'POST', body: update, clientId, mode: 'rest' },
    );
  }

  transcribeWorkspaceVoice(
    audio: DaemonVoiceAudioInput,
    opts: DaemonWorkspaceVoiceTranscribeOptions,
  ): Promise<DaemonWorkspaceVoiceTranscriptionResult> {
    return this.client.workspaceVoiceTranscriptionRequest(
      this.workspaceSelector,
      audio,
      opts,
    );
  }

  workspaceGit(): Promise<DaemonWorkspaceGitStatus> {
    return this.client.workspaceJsonRequest<DaemonWorkspaceGitStatus>(
      this.workspaceSelector,
      '/git',
      'GET /workspaces/:workspace/git',
      { mode: 'rest' },
    );
  }

  workspaceSkills(): Promise<DaemonWorkspaceSkillsStatus> {
    return this.get('/skills', 'GET /workspaces/:workspace/skills');
  }

  workspaceProviders(): Promise<DaemonWorkspaceProvidersStatus> {
    return this.get('/providers', 'GET /workspaces/:workspace/providers');
  }

  workspaceHooks(): Promise<DaemonWorkspaceHooksStatus> {
    return this.get('/hooks', 'GET /workspaces/:workspace/hooks');
  }

  workspaceEnv(): Promise<DaemonWorkspaceEnvStatus> {
    return this.get('/env', 'GET /workspaces/:workspace/env');
  }

  workspacePreflight(): Promise<DaemonWorkspacePreflightStatus> {
    return this.get('/preflight', 'GET /workspaces/:workspace/preflight');
  }

  workspaceTools(): Promise<DaemonWorkspaceToolsStatus> {
    return this.get('/tools', 'GET /workspaces/:workspace/tools');
  }

  workspaceMemory(): Promise<DaemonWorkspaceMemoryStatus> {
    return this.get('/memory', 'GET /workspaces/:workspace/memory');
  }

  remove(options?: {
    force?: boolean;
    timeoutMs?: number;
  }): Promise<DaemonWorkspaceRemovalResult> {
    const body =
      options?.force === undefined
        ? undefined
        : {
            force: options.force,
          };
    return this.client.workspaceJsonRequest<DaemonWorkspaceRemovalResult>(
      this.workspaceSelector,
      '',
      'DELETE /workspaces/:workspace',
      {
        method: 'DELETE',
        ...(body ? { body } : {}),
        ...(options?.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
        mode: 'rest',
      },
    );
  }

  writeWorkspaceMemory(
    req: Omit<DaemonWriteMemoryRequest, 'scope'> & { scope?: 'workspace' },
    clientId?: string,
  ): Promise<DaemonWriteMemoryResult> {
    return this.post(
      '/memory',
      'POST /workspaces/:workspace/memory',
      { ...req, scope: 'workspace' },
      clientId,
    );
  }

  listWorkspaceAgents(): Promise<DaemonWorkspaceAgentsStatus> {
    return this.get('/agents', 'GET /workspaces/:workspace/agents');
  }

  createWorkspaceAgent(
    req: Omit<DaemonCreateAgentRequest, 'scope'> & {
      scope?: 'workspace' | 'project';
    },
    clientId?: string,
  ): Promise<DaemonAgentMutationResult> {
    return this.post(
      '/agents',
      'POST /workspaces/:workspace/agents',
      { ...req, scope: req.scope ?? 'workspace' },
      clientId,
    );
  }

  getWorkspaceAgent(agentType: string): Promise<DaemonWorkspaceAgentDetail> {
    return this.get(
      `/agents/${urlEncode(agentType)}`,
      'GET /workspaces/:workspace/agents/:agentType',
    );
  }

  updateWorkspaceAgent(
    agentType: string,
    req: DaemonUpdateAgentRequest,
    opts: { scope?: 'workspace' | 'project'; clientId?: string } = {},
  ): Promise<DaemonAgentMutationResult> {
    const query = opts.scope ? `?scope=${urlEncode(opts.scope)}` : '';
    return this.post(
      `/agents/${urlEncode(agentType)}${query}`,
      'POST /workspaces/:workspace/agents/:agentType',
      req,
      opts.clientId,
    );
  }

  async deleteWorkspaceAgent(
    agentType: string,
    opts: { scope?: 'workspace' | 'project'; clientId?: string } = {},
  ): Promise<void> {
    const query = opts.scope ? `?scope=${urlEncode(opts.scope)}` : '';
    return await this.client.workspaceNoContentRequest(
      this.workspaceSelector,
      `/agents/${urlEncode(agentType)}${query}`,
      'DELETE /workspaces/:workspace/agents/:agentType',
      {
        method: 'DELETE',
        clientId: opts.clientId,
        okNotFoundCode: 'agent_not_found',
      },
    );
  }

  async listWorkspaceSessionsPage(
    options?: DaemonSessionListPageOptions,
  ): Promise<DaemonSessionListPage> {
    if (options?.sourceType !== undefined || options?.sourceId !== undefined) {
      await this.client.requireCapability('session_source_metadata');
    }
    const requestedPageSize =
      options?.pageSize ?? DEFAULT_SESSION_LIST_PAGE_SIZE;
    const pageSize = Math.max(
      1,
      Math.min(
        1000,
        Math.round(
          Number.isFinite(requestedPageSize)
            ? requestedPageSize
            : DEFAULT_SESSION_LIST_PAGE_SIZE,
        ),
      ),
    );
    const query = new URLSearchParams({ size: String(pageSize) });
    if (options?.cursor !== undefined) query.set('cursor', options.cursor);
    if (options?.archiveState !== undefined) {
      query.set('archiveState', options.archiveState);
    }
    if (options?.view !== undefined) query.set('view', options.view);
    if (options?.group !== undefined) query.set('group', options.group);
    if (options?.parentSessionId !== undefined) {
      query.set('parentSessionId', options.parentSessionId);
    }
    if (options?.sourceType !== undefined) {
      query.set('sourceType', options.sourceType);
    }
    if (options?.sourceId !== undefined) {
      query.set('sourceId', options.sourceId);
    }
    return await this.get(
      `/sessions?${query.toString()}`,
      'GET /workspaces/:workspace/sessions',
    );
  }

  async listWorkspaceSessions(
    options?: DaemonSessionListPageOptions,
  ): Promise<DaemonSessionSummary[]> {
    const page = await this.listWorkspaceSessionsPage(options);
    return page.sessions;
  }

  /**
   * Read one page from an active persisted session transcript in this
   * workspace.
   * The daemon performs replay locally without attaching to the session or
   * starting ACP. This method always uses native REST transport.
   */
  getSessionTranscriptPage(
    sessionId: string,
    opts: DaemonSessionTranscriptPageOptions = {},
  ): Promise<DaemonSessionTranscriptPage> {
    return this.client.workspaceJsonRequest<DaemonSessionTranscriptPage>(
      this.workspaceSelector,
      `/session/${urlEncode(sessionId)}/transcript${transcriptPageSuffix(opts)}`,
      'GET /workspaces/:workspace/session/:id/transcript',
      { clientId: opts.clientId, mode: 'rest' },
    );
  }

  /** Export an active persisted session from this registered workspace. */
  exportSession(
    sessionId: string,
    opts: {
      format?: DaemonSessionExportFormat;
      clientId?: string;
    } = {},
  ): Promise<DaemonSessionExportResult> {
    return this.client.sessionExportRequest(
      `/workspaces/${this.workspaceSelector}/session/${urlEncode(sessionId)}/export`,
      'GET /workspaces/:workspace/session/:id/export',
      opts,
    );
  }

  /** Export an archived persisted session from this registered workspace. */
  exportArchivedSession(
    sessionId: string,
    opts: {
      format?: DaemonSessionExportFormat;
      clientId?: string;
    } = {},
  ): Promise<DaemonSessionExportResult> {
    return this.client.sessionExportRequest(
      `/workspaces/${this.workspaceSelector}/session/${urlEncode(sessionId)}/archive/export`,
      'GET /workspaces/:workspace/session/:id/archive/export',
      opts,
    );
  }

  listSessionGroups(): Promise<DaemonSessionGroupCatalog> {
    return this.get(
      '/session-groups',
      'GET /workspaces/:workspace/session-groups',
    );
  }

  async createSessionGroup(
    input: DaemonSessionGroupInput,
  ): Promise<DaemonSessionGroup> {
    const body = await this.post<{ group: DaemonSessionGroup }>(
      '/session-groups',
      'POST /workspaces/:workspace/session-groups',
      input,
    );
    return body.group;
  }

  async updateSessionGroup(
    groupId: string,
    update: DaemonSessionGroupUpdate,
  ): Promise<DaemonSessionGroup> {
    const body = await this.client.workspaceJsonRequest<{
      group: DaemonSessionGroup;
    }>(
      this.workspaceSelector,
      `/session-groups/${urlEncode(groupId)}`,
      'PATCH /workspaces/:workspace/session-groups/:groupId',
      { method: 'PATCH', body: update },
    );
    return body.group;
  }

  deleteSessionGroup(groupId: string): Promise<{ deleted: boolean }> {
    return this.client.workspaceJsonRequest<{ deleted: boolean }>(
      this.workspaceSelector,
      `/session-groups/${urlEncode(groupId)}`,
      'DELETE /workspaces/:workspace/session-groups/:groupId',
      { method: 'DELETE' },
    );
  }

  updateSessionOrganization(
    sessionId: string,
    update: DaemonSessionOrganizationUpdate,
    clientId?: string,
  ): Promise<DaemonSessionOrganizationResult> {
    return this.client.workspaceJsonRequest<DaemonSessionOrganizationResult>(
      this.workspaceSelector,
      `/session/${urlEncode(sessionId)}/organization`,
      'PATCH /workspaces/:workspace/session/:id/organization',
      { method: 'PATCH', body: update, clientId },
    );
  }

  deleteSessionsData(
    sessionIds: string[],
    clientId?: string,
  ): Promise<{
    removed: string[];
    notFound: string[];
    errors: Array<{ sessionId: string; error: string }>;
  }> {
    return this.post(
      '/sessions/delete',
      'POST /workspaces/:workspace/sessions/delete',
      { sessionIds },
      clientId,
    );
  }

  archiveSessionsData(
    sessionIds: string[],
    clientId?: string,
  ): Promise<DaemonArchiveSessionsResult> {
    return this.post(
      '/sessions/archive',
      'POST /workspaces/:workspace/sessions/archive',
      { sessionIds },
      clientId,
    );
  }

  unarchiveSessionsData(
    sessionIds: string[],
    clientId?: string,
  ): Promise<DaemonUnarchiveSessionsResult> {
    return this.post(
      '/sessions/unarchive',
      'POST /workspaces/:workspace/sessions/unarchive',
      { sessionIds },
      clientId,
    );
  }

  readWorkspaceFile(
    filePath: string,
    opts: { maxBytes?: number; line?: number; limit?: number } = {},
    clientId?: string,
  ): Promise<DaemonWorkspaceFile> {
    const query = new URLSearchParams({ path: filePath });
    if (opts.maxBytes !== undefined)
      query.set('maxBytes', String(opts.maxBytes));
    if (opts.line !== undefined) query.set('line', String(opts.line));
    if (opts.limit !== undefined) query.set('limit', String(opts.limit));
    return this.get(
      `/file?${query.toString()}`,
      'GET /workspaces/:workspace/file',
      clientId,
    );
  }

  readWorkspaceFileBytes(
    filePath: string,
    opts: { offset?: number; maxBytes?: number } = {},
    clientId?: string,
  ): Promise<DaemonWorkspaceFileBytes> {
    const query = new URLSearchParams({ path: filePath });
    if (opts.offset !== undefined) query.set('offset', String(opts.offset));
    if (opts.maxBytes !== undefined)
      query.set('maxBytes', String(opts.maxBytes));
    return this.get(
      `/file/bytes?${query.toString()}`,
      'GET /workspaces/:workspace/file/bytes',
      clientId,
    );
  }

  fileStat(filePath: string): Promise<unknown> {
    const query = new URLSearchParams({ path: filePath });
    return this.get(
      `/stat?${query.toString()}`,
      'GET /workspaces/:workspace/stat',
    );
  }

  dirList(dirPath: string): Promise<unknown> {
    const query = new URLSearchParams({ path: dirPath });
    return this.get(
      `/list?${query.toString()}`,
      'GET /workspaces/:workspace/list',
    );
  }

  glob(
    pattern: string,
    opts: { maxResults?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const query = new URLSearchParams({ pattern });
    if (opts.maxResults !== undefined) {
      query.set('maxResults', String(opts.maxResults));
    }
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/glob?${query.toString()}`,
      'GET /workspaces/:workspace/glob',
      { signal: opts.signal },
    );
  }

  writeWorkspaceFile(
    req: DaemonWorkspaceFileWriteRequest,
    clientId?: string,
  ): Promise<DaemonWorkspaceFileWriteResult> {
    return this.post(
      '/file/write',
      'POST /workspaces/:workspace/file/write',
      req,
      clientId,
    );
  }

  editWorkspaceFile(
    req: DaemonWorkspaceFileEditRequest,
    clientId?: string,
  ): Promise<DaemonWorkspaceFileEditResult> {
    return this.post(
      '/file/edit',
      'POST /workspaces/:workspace/file/edit',
      req,
      clientId,
    );
  }

  workspaceSettings(opts?: {
    clientId?: string;
  }): Promise<DaemonWorkspaceSettingsStatus> {
    return this.get(
      '/settings',
      'GET /workspaces/:workspace/settings',
      opts?.clientId,
    );
  }

  setWorkspaceSetting(
    // The workspace-qualified settings route is workspace-only (see
    // QUALIFIED_WRITE_SCOPES); only the primary DaemonClient writes user scope.
    scope: 'workspace',
    key: string,
    value: unknown,
    opts?: {
      clientId?: string;
      mcpServerMutation?: { operation: 'set' | 'remove'; name: string };
    },
  ): Promise<DaemonSettingUpdateResult> {
    return this.post(
      '/settings',
      'POST /workspaces/:workspace/settings',
      {
        scope,
        key,
        value,
        ...(opts?.mcpServerMutation
          ? { mcpServerMutation: opts.mcpServerMutation }
          : {}),
      },
      opts?.clientId,
    );
  }

  workspaceTrust(opts?: {
    clientId?: string;
  }): Promise<DaemonWorkspaceTrustStatus> {
    return this.get(
      '/trust',
      'GET /workspaces/:workspace/trust',
      opts?.clientId,
    );
  }

  requestWorkspaceTrustChange(
    request: DaemonWorkspaceTrustChangeRequest,
    clientId?: string,
  ): Promise<DaemonWorkspaceTrustChangeResult> {
    return this.post(
      '/trust/request',
      'POST /workspaces/:workspace/trust/request',
      request,
      clientId,
    );
  }

  workspacePermissions(opts?: {
    clientId?: string;
  }): Promise<DaemonWorkspacePermissionsStatus> {
    return this.get(
      '/permissions',
      'GET /workspaces/:workspace/permissions',
      opts?.clientId,
    );
  }

  setWorkspacePermissionRules(
    ruleType: DaemonPermissionRuleType,
    rules: readonly string[],
    opts?: { clientId?: string },
  ): Promise<DaemonWorkspacePermissionsStatus> {
    return this.post(
      '/permissions',
      'POST /workspaces/:workspace/permissions',
      { scope: 'workspace', ruleType, rules: [...rules] },
      opts?.clientId,
    );
  }

  setWorkspaceToolEnabled(
    toolName: string,
    enabled: boolean,
    opts?: { clientId?: string },
  ): Promise<DaemonToolToggleResult> {
    return this.post(
      `/tools/${urlEncode(toolName)}/enable`,
      'POST /workspaces/:workspace/tools/:name/enable',
      { enabled },
      opts?.clientId,
    );
  }

  setWorkspaceSkillEnabled(
    skillName: string,
    enabled: boolean,
    opts?: { clientId?: string },
  ): Promise<DaemonSkillToggleResult> {
    return this.post(
      `/skills/${urlEncode(skillName)}/enable`,
      'POST /workspaces/:workspace/skills/:name/enable',
      { enabled },
      opts?.clientId,
    );
  }

  restartMcpServer(
    serverName: string,
    opts?: { clientId?: string; entryIndex?: number | '*'; timeoutMs?: number },
  ): Promise<DaemonMcpRestartResult> {
    const query =
      opts?.entryIndex === undefined
        ? ''
        : `?entryIndex=${urlEncode(String(opts.entryIndex))}`;
    return this.post(
      `/mcp/${urlEncode(serverName)}/restart${query}`,
      'POST /workspaces/:workspace/mcp/:server/restart',
      {},
      opts?.clientId,
      opts?.timeoutMs ?? MCP_RESTART_DEFAULT_TIMEOUT_MS,
    );
  }

  reload(opts?: {
    clientId?: string;
    timeoutMs?: number;
  }): Promise<DaemonReloadResponse> {
    return this.post(
      '/reload',
      'POST /workspaces/:workspace/reload',
      {},
      opts?.clientId,
      opts?.timeoutMs,
    );
  }

  initWorkspace(opts?: {
    force?: boolean;
    clientId?: string;
  }): Promise<DaemonInitWorkspaceResult> {
    return this.post(
      '/init',
      'POST /workspaces/:workspace/init',
      opts?.force === true ? { force: true } : {},
      opts?.clientId,
    );
  }

  workspaceExtensions(): Promise<WorkspaceExtensionProjection> {
    return this.client.workspaceJsonRequest<WorkspaceExtensionProjection>(
      this.workspaceSelector,
      '/extensions',
      'GET /workspaces/:workspace/extensions',
      { mode: 'rest' },
    );
  }

  setExtensionActivation(
    extensionId: string,
    state: ExtensionActivationState,
    clientId?: string,
  ): Promise<ExtensionMutationResponse> {
    return this.client.workspaceJsonRequest<ExtensionMutationResponse>(
      this.workspaceSelector,
      `/extensions/${urlEncode(extensionId)}/activation`,
      'PUT /workspaces/:workspace/extensions/:extensionId/activation',
      { method: 'PUT', body: { state }, clientId, mode: 'rest' },
    );
  }

  clearExtensionActivation(
    extensionId: string,
    clientId?: string,
  ): Promise<ExtensionMutationResponse> {
    return this.client.workspaceJsonRequest<ExtensionMutationResponse>(
      this.workspaceSelector,
      `/extensions/${urlEncode(extensionId)}/activation`,
      'DELETE /workspaces/:workspace/extensions/:extensionId/activation',
      { method: 'DELETE', clientId, mode: 'rest' },
    );
  }

  refreshExtensionRuntime(
    clientId?: string,
  ): Promise<ExtensionMutationResponse> {
    return this.client.workspaceJsonRequest<ExtensionMutationResponse>(
      this.workspaceSelector,
      '/extensions/refresh',
      'POST /workspaces/:workspace/extensions/refresh',
      { method: 'POST', body: {}, clientId, mode: 'rest' },
    );
  }

  private get<T>(path: string, label: string, clientId?: string): Promise<T> {
    return this.client.workspaceJsonRequest<T>(
      this.workspaceSelector,
      path,
      label,
      { clientId },
    );
  }

  private post<T>(
    path: string,
    label: string,
    body: unknown,
    clientId?: string,
    timeoutMs?: number,
  ): Promise<T> {
    return this.client.workspaceJsonRequest<T>(
      this.workspaceSelector,
      path,
      label,
      { method: 'POST', body, clientId, timeoutMs },
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
