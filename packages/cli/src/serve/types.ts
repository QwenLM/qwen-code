/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SERVE_FEATURES,
  type ServeFeature,
  type ServeProtocolVersions,
} from './capabilities.js';
// Import the canonical `PermissionPolicy` union from acp-bridge
// instead of inlining the string literals, so upstream changes
// are compiler-flagged here.
import type { PermissionPolicy } from '@qwen-code/acp-bridge';
import type {
  AuthType,
  InputModalities,
  Protocol,
} from '@qwen-code/qwen-code-core';

/**
 * Stage 1 daemon mode shape.
 *
 * `http-bridge` (Stage 1): one `qwen --acp` child per daemon (the
 *   daemon binds to ONE workspace at boot). Multiple
 *   sessions multiplex onto that child via the agent's native
 *   `connection.newSession()` (see `acp-integration/acpAgent.ts:194`),
 *   sharing the child's process / OAuth / file-cache / hierarchy-memory
 *   parse. The daemon pipes ACP NDJSON over HTTP/SSE. Same-session
 *   multi-client requests serialize through the bridge's per-session
 *   FIFO; cross-session requests on the same channel can run
 *   concurrently (the ACP layer demultiplexes by sessionId).
 * `native` (Stage 2+): in-process multi-session, AsyncLocalStorage; not yet
 *   implemented.
 */
export type ServeMode = 'http-bridge' | 'native';

export interface ServeOptions {
  hostname: string;
  port: number;
  /**
   * Bearer token required on every request. Optional when bound to loopback
   * (developer convenience); required when bound beyond loopback (boot fails
   * without one — see runQwenServe).
   */
  token?: string;
  mode: ServeMode;
  /**
   * Cap on concurrent live sessions. Once `bridge.sessionCount` reaches
   * this, new `POST /session` requests that would spawn fresh sessions
   * return 503. Attaching to an existing session (same workspace under
   * `sessionScope: 'single'`) still works — so an idle daemon doesn't
   * block reconnects from existing users. Defaults to 20: comfortably
   * above single-user usage, well below the design's N≈50 cliff where
   * per-session RSS (~30–50 MB) and FD pressure start to bite. Set to
   * `0` or `Infinity` to disable.
   */
  maxSessions?: number;
  /**
   * Per-session cap on accepted prompts that have not settled yet.
   * Defaults to 5. `0` or `Infinity` disables the cap.
   */
  maxPendingPromptsPerSession?: number;
  /**
   * Listener-level TCP connection cap (`server.maxConnections`).
   * Defaults to 256 — bounds the raw socket count regardless of
   * session count, so a slow / phantom SSE client can't pin the
   * daemon's FD table even when it isn't holding a live ACP session.
   * `0` (or `Infinity`) disables the cap by leaving
   * `server.maxConnections` unset, which falls back to Node's
   * built-in unlimited default. We avoid actually setting
   * `server.maxConnections = 0` because on Node 22 that causes the
   * listener to refuse EVERY connection.
   * NaN / negative values throw at boot. Independent of
   * `maxSessions` because one session can have many SSE subscribers
   * (default cap 64) plus short-lived REST calls.
   */
  maxConnections?: number;
  /**
   * Per-session SSE replay ring depth. Threaded into the bridge as
   * `BridgeOptions.eventRingSize` and used at every `new EventBus(...)`
   * construction site. Defaults to 8000. Must be a positive
   * finite integer — `0` / `NaN` / negative fail at boot. Larger
   * rings let clients with longer reconnect gaps replay more history
   * at the cost of a few hundred KB extra RAM per session.
   */
  eventRingSize?: number;
  /**
   * Absolute workspace path this daemon binds to. The daemon is
   * **1 daemon = 1 workspace × N sessions**: one bound
   * workspace at boot, sessions multiplexed on the single
   * `qwen --acp` child via `connection.newSession()`.
   *
   * `POST /session` calls whose `cwd` doesn't canonicalize to this
   * path are rejected with `400 workspace_mismatch`. Clients may
   * also omit `cwd` — the route falls back to this bound path.
   *
   * Multi-workspace deployments use **multiple daemon processes**
   * (one per workspace, each on its own port), supervised by
   * systemd / docker-compose / k8s / `qwen-coordinator` reference
   * orchestrator. There is no intra-daemon multi-workspace mode
   * (the previous Stage 1 `byWorkspaceChannel` routing layer was
   * removed in the design revision).
   *
   * Defaults to `process.cwd()` when omitted.
   */
  workspace?: string;
  /**
   * When true, refuses to boot without a bearer
   * token — even on loopback. Loopback's no-token developer default
   * is convenient for local prototyping but unsafe to ship inside
   * shared dev environments / CI runners / multi-tenant workstations
   * (any local user can hit `127.0.0.1:4170` and drive the agent).
   * `--require-auth` opts the operator into "token mandatory"
   * regardless of bind interface; the global `bearerAuth` middleware
   * then gates every route, including `/health`.
   *
   * Default `false` so existing single-user loopback workflows keep
   * working bit-for-bit. Non-loopback binds already require a token
   * irrespective of this flag.
   */
  requireAuth?: boolean;
  /**
   * Opt in to direct session shell execution. The effective policy also
   * requires a configured bearer token and a session-bound client id.
   */
  enableSessionShell?: boolean;
  /**
   * Serve the built Web Shell SPA at the daemon root (default true). Set
   * false (the CLI's `--no-web`) for an API-only daemon. No effect when the
   * Web Shell assets aren't present in the build.
   */
  serveWebShell?: boolean;
  /**
   * Cap on live MCP clients spawned inside the
   * ACP child for the bound workspace. When set, the daemon
   * forwards `QWEN_SERVE_MCP_CLIENT_BUDGET` to the child's env so
   * core's `McpClientManager` picks it up. Combined with
   * `mcpBudgetMode`:
   *   - `warn` (default when budget set): no refusal, snapshot
   *     surfaces `status: 'warning'` at >=75% of budget.
   *   - `enforce`: connects past the cap are refused, per-server
   *     cell shows `disabledReason: 'budget'`, deterministic by
   *     `Object.entries(mcpServers)` declaration order.
   *   - `off`: no accounting-driven enforcement (the implicit
   *     default when no budget is configured).
   *
   * Positive integer required; non-positive / NaN values throw at
   * boot.
   */
  mcpClientBudget?: number;
  /**
   * Enforcement mode for `mcpClientBudget`.
   * Boot rejects `enforce` without a budget; otherwise resolves to
   * `warn` when budget set / `off` when budget unset.
   */
  mcpBudgetMode?: 'enforce' | 'warn' | 'off';
  /**
   * Whether the daemon advertises the
   * `mcp_workspace_pool` + `mcp_pool_restart` capability tags.
   */
  mcpPoolActive?: boolean;
  /**
   * Cross-origin allowlist for browser webui
   * deployments.
   */
  allowOrigins?: string[];
  /**
   * Allow auth provider baseUrl values that point at localhost/private
   * networks. Off by default because the daemon exposes this as an HTTP
   * mutation; local development can opt in explicitly for local model
   * endpoints.
   */
  allowPrivateAuthBaseUrl?: boolean;
  /**
   * Server-side wallclock cap on a single
   * `POST /session/:id/prompt` from receipt to completion.
   */
  promptDeadlineMs?: number;
  /**
   * Per-SSE-connection idle deadline.
   */
  writerIdleTimeoutMs?: number;
  /** Non-negative ms to keep ACP child alive after last session closes. 0 = immediate kill (default). */
  channelIdleTimeoutMs?: number;
  /** Session reaper scan interval in ms. 0 = disabled. Default: 60000. */
  sessionReapIntervalMs?: number;
  /** Session idle timeout in ms. 0 = disabled. Default: 1800000 (30 min). */
  sessionIdleTimeoutMs?: number;
  /**
   * Wall-clock timeout in ms for a single human permission /
   * ask_user_question response in daemon (ACP) mode. 0 = disabled
   * (wait forever). Default: 300000 (5 min).
   */
  permissionResponseTimeoutMs?: number;
  /**
   * Enable per-tier HTTP rate limiting. Off by default. When enabled,
   * requests exceeding per-tier limits receive 429 + Retry-After.
   */
  rateLimit?: boolean;
  /** Max prompt requests per window per key (default 10). Requires --rate-limit. */
  rateLimitPrompt?: number;
  /** Max mutation requests per window per key (default 30). Requires --rate-limit. */
  rateLimitMutation?: number;
  /** Max read requests per window per key (default 120). Requires --rate-limit. */
  rateLimitRead?: number;
  /** Rate limit window duration in ms (default 60000). Requires --rate-limit. */
  rateLimitWindowMs?: number;
}

/**
 * Capability envelope returned from `GET /capabilities`. Clients gate UI off
 * `features`, never off `mode` (per protocol-compatibility design).
 *
 * `v` is the wire schema version; bumped only on breaking frame changes.
 */
export interface CapabilitiesEnvelope {
  v: 1;
  /**
   * Serve protocol versions supported by this daemon. Optional because this is
   * additive to v=1; older v=1 daemons omit it.
   */
  protocolVersions?: ServeProtocolVersions;
  /**
   * Qwen Code CLI/SDK version served by this daemon. Optional because this is
   * additive to v=1; older v=1 daemons omit it.
   */
  qwenCodeVersion?: string;
  mode: ServeMode;
  features: string[];
  /**
   * Configured model services advertised over HTTP. **Stage 1 always
   * returns `[]`** — the agent uses its single default service and
   * doesn't enumerate it over the wire. Stage 2 will populate this
   * from the registered model adapters so SDK clients can build
   * service-pickers. Until then, SDK consumers should NOT rely on
   * this field being non-empty.
   */
  modelServices: string[];
  /**
   * Absolute workspace path this daemon is bound to
   * (`1 daemon = 1 workspace`). Clients use this to:
   *   - Detect mismatch before posting `/session` (vs. waiting for
   *     400 workspace_mismatch from the bridge).
   *   - Omit `cwd` on `POST /session` — the route falls back to this
   *     path when the body has no `cwd` field.
   *
   * Optional at the type level (matches the SDK's `DaemonCapabilities`
   * type) because the field is an additive extension of the v=1
   * envelope. Older daemons may omit this field; additive optionality
   * is the correct shape per the protocol's versioning stance. The
   * current server code always populates it.
   */
  workspaceCwd?: string;
  /**
   * Transport families this daemon supports. Always includes `'rest'`;
   * future builds may add `'acp-http'` and/or `'acp-ws'`. SDK clients
   * use `negotiateTransport()` to auto-select the best available.
   * Additive — older daemons omit this field; SDK consumers should
   * treat absence as `['rest']`.
   */
  transports?: string[];
  /**
   * Daemon-policy namespace. Active values for
   * cross-cutting daemon coordination policies that don't fit on a
   * per-feature flag. Today only `permission` is populated (active
   * `PermissionMediator` strategy); future entries (e.g. `network`,
   * `audit`) extend the namespace without polluting the top-level
   * envelope. Optional / additive — daemons predating F3 omit it.
   */
  policy?: {
    /**
     * Active permission mediation policy. Distinct from the
     * `permission_mediation` capability `modes` list, which
     * advertises the build-supported set; this field tells clients
     * which one is currently in effect.
     */
    permission?: PermissionPolicy;
  };
  /**
   * Active daemon resource limits. Additive to v=1; older daemons may omit it.
   * `null` means the operator explicitly disabled that cap.
   */
  limits?: {
    maxPendingPromptsPerSession?: number | null;
  };
  /**
   * Language codes accepted by `POST /session/:id/language`.
   * Additive — older daemons omit this field; clients should
   * treat absence as "unknown" rather than "none".
   */
  supportedLanguages?: string[];
}

export interface ServeAuthProviderModel {
  id: string;
  contextWindowSize?: number;
  enableThinking?: boolean;
  modalities?: InputModalities;
  description?: string;
}

export interface ServeAuthProviderBaseUrlOption {
  id: string;
  label: string;
  url: string;
  documentationUrl?: string;
  apiKeyUrl?: string;
}

export interface ServeAuthProviderDescriptor {
  id: string;
  label: string;
  description: string;
  uiGroup?: string;
  protocol: Protocol;
  protocolOptions?: Protocol[];
  baseUrl?: string | ServeAuthProviderBaseUrlOption[];
  envKey?: string;
  models?: ServeAuthProviderModel[];
  modelsEditable?: boolean;
  apiKeyPlaceholder?: string;
  documentationUrl?: string;
  showAdvancedConfig?: boolean;
  uiLabels?: {
    flowTitle?: string;
    baseUrlStepTitle?: string;
  };
  steps: Array<'protocol' | 'baseUrl' | 'apiKey' | 'models' | 'advancedConfig'>;
}

export interface ServeAuthProviderCatalog {
  v: 1;
  workspaceCwd: string;
  providers: ServeAuthProviderDescriptor[];
  groups: Array<{
    id: 'alibaba' | 'third-party' | 'custom';
    label: string;
    description: string;
    providerIds: string[];
  }>;
}

export interface ServeAuthProviderInstallRequest {
  providerId: string;
  protocol?: AuthType;
  baseUrl?: string;
  apiKey: string;
  modelIds?: string[];
  advancedConfig?: {
    enableThinking?: boolean;
    multimodal?: InputModalities;
    contextWindowSize?: number;
    maxTokens?: number;
  };
}

export interface ServeAuthProviderInstallResult {
  v: 1;
  providerId: string;
  providerLabel: string;
  authType: AuthType;
  modelId?: string;
  baseUrl?: string;
  message: string;
}

export const CAPABILITIES_SCHEMA_VERSION = 1 as const;

/** @deprecated Use SERVE_FEATURES from the capability registry. */
export const STAGE1_FEATURES = SERVE_FEATURES;

/** @deprecated Use ServeFeature from the capability registry. */
export type Stage1Feature = ServeFeature;
