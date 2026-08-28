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
import type { DaemonMemoryBudget } from '@qwen-code/acp-bridge/daemonMemoryBudget';
// Type-only, so it is erased before the serve fast-path bundle closure check
// ever sees it. Reused only for the child-heap knob: `memoryPressureMode`
// happens to share the same two values today but is an independent switch, and
// aliasing them would couple whichever one gains `enforce` first to the other.
import type { ChildHeapMode } from '@qwen-code/acp-bridge/childHeapPolicy';
import type {
  AuthType,
  InputModalities,
  MemoryProjectScope,
} from '@qwen-code/qwen-code-core';

/**
 * Stage 1 daemon mode shape.
 *
 * `http-bridge` (Stage 1): production attempts to preheat the primary
 *   `qwen --acp` child and retries on first use after failure; trusted
 *   secondaries start one on demand, while untrusted secondaries do not.
 *   Multiple sessions in one runtime multiplex onto its child via the
 *   agent's native `connection.newSession()` (see
 *   `acp-integration/acpAgent.ts:194`),
 *   sharing the child's process / OAuth / file-cache / hierarchy-memory
 *   parse. The daemon pipes ACP NDJSON over HTTP/SSE. Same-session
 *   multi-client requests serialize through the bridge's per-session
 *   FIFO; cross-session requests on the same channel can run
 *   concurrently (the ACP layer demultiplexes by sessionId).
 * `native` (Stage 2+): in-process multi-session, AsyncLocalStorage; not yet
 *   implemented.
 */
export type ServeMode = 'http-bridge' | 'native';

export type ServeChannelSelection =
  | { mode: 'all' }
  | { mode: 'names'; names: string[] };

export interface ChannelWebhookConfigSource {
  workspaceCwd: string;
  channelNames?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
}

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
   * Per-workspace cap on concurrent live sessions. Once a runtime's
   * `bridge.sessionCount` reaches
   * this, new `POST /session` requests that would spawn fresh sessions
   * return 503. Attaching to an existing session (same workspace under
   * `sessionScope: 'single'`) still works — so an idle daemon doesn't
   * block reconnects from existing users. Defaults to 32: comfortably
   * above single-user usage, well below the design's N≈50 cliff where
   * per-session RSS (~30–50 MB) and FD pressure start to bite. Set to
   * `0` or `Infinity` to disable.
   *
   * This is a fairness and FD lever rather than a memory lever. Sessions
   * multiplex onto their workspace's single ACP child, so per-session RSS is
   * spent inside that child's heap, which nothing currently bounds beyond
   * V8's own ceiling.
   */
  maxSessions?: number;
  /**
   * Non-negative integer cap on concurrent live sessions across all workspace
   * runtimes. `runQwenServe` derives a default once from the per-workspace cap
   * and startup workspace count when several startup/restored workspaces are
   * present; direct embeds may leave it unlimited. Dynamic registration does
   * not recompute it. `0` or `Infinity` disables the cap.
   */
  maxTotalSessions?: number;
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
   * Per-session in-memory compacted replay snapshot byte cap. Threaded into
   * `BridgeOptions.compactedReplayMaxBytes`. Defaults to 4 MiB. Must be a
   * positive safe integer; there is no unlimited sentinel.
   */
  compactedReplayMaxBytes?: number;
  /**
   * Per-session BASELINE cap on replay entries retained in the in-flight
   * live journal. Compatible text/thought chunks share bounded entries.
   * Threaded into `BridgeOptions.maxJournalEvents`. Defaults to 10 000.
   * Must be a positive safe integer.
   *
   * Growth semantics: leaving BOTH this and `maxJournalBytes` unset enables
   * adaptive growth — the daemon raises a breaching session's caps within a
   * pool derived from the memory budget. Pinning either one fixes both
   * dimensions at the configured baselines and disables growth entirely.
   */
  maxJournalEvents?: number;
  /**
   * Per-session BASELINE source-event byte cap on the in-flight live
   * journal. Truncation drops whole entries, so the retained tail can be
   * much smaller than the cap. Threaded into `BridgeOptions.maxJournalBytes`.
   * Defaults to 8 MiB. Must be a positive safe integer.
   *
   * Growth semantics: leaving BOTH this and `maxJournalEvents` unset
   * enables adaptive growth — the daemon raises a breaching session's caps
   * within a pool derived from the memory budget. Pinning either one fixes
   * both dimensions at the configured baselines and disables growth
   * entirely.
   */
  maxJournalBytes?: number;
  /**
   * Absolute workspace path this daemon binds as its primary workspace.
   * The CLI parser accepts repeated `--workspace` values to register isolated
   * runtimes, but this public option remains the primary workspace string so
   * existing embeds do not need to understand the internal runtime registry.
   *
   * `POST /session` calls whose `cwd` doesn't canonicalize to this
   * path, or to another registered runtime's canonical workspace, are
   * rejected with `400 workspace_mismatch`. Clients may also omit `cwd` —
   * the route falls back to this primary path.
   *
   * Defaults to `process.cwd()` when omitted.
   */
  workspace?: string;
  /**
   * Project-memory partitioning for every runtime owned by `runQwenServe`.
   * `workspace` keys memory by the exact registered workspace; `git-root`
   * preserves the legacy behavior that shares memory among workspaces
   * resolved to the same Git root. When omitted,
   * `QWEN_CODE_MEMORY_PROJECT_SCOPE` is read from the environment before
   * defaulting to `workspace`. Direct `createServeApp` callers must instead
   * provide the scope through `deps.daemonEnv`.
   */
  memoryProjectScope?: MemoryProjectScope;
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
   * requires either a configured bearer token or trusted-loopback mode, plus
   * a session-bound client id.
   */
  enableSessionShell?: boolean;
  /**
   * Path to a PEM certificate file. When both `tlsCert` and `tlsKey`
   * are set, the daemon serves over HTTPS (`https.createServer`) instead
   * of plain HTTP. Both must be provided together. The main motivation is
   * mobile/cross-device access: browsers only expose secure-context APIs
   * (`getUserMedia` for voice input, WebRTC) over HTTPS or `localhost`, so
   * a LAN IP like `192.168.x.x` needs TLS. Scope is TLS termination only —
   * no auto-generation, no ACME. TLS is orthogonal to the bearer-token
   * auth layer; both still apply on non-loopback binds.
   */
  tlsCert?: string;
  /**
   * Path to a PEM private key file. See `tlsCert` — both must be set
   * together to enable HTTPS.
   */
  tlsKey?: string;
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
   * Total memory budget in MB for the whole daemon process tree — the root
   * plus every `qwen --acp` child it spawns. When unset, derived as half of
   * the cgroup-constrained or host memory.
   *
   * Observed and reported only. No child is sized from it and no spawn is
   * refused on its basis: `childHeapMode: 'observe'` models a partition of it
   * and publishes the model, but there is no mode that applies one. Sizing
   * children arrives with the peak old-space measurement that can tell an
   * operator beforehand whether their workload fits the partition.
   */
  memoryBudgetMb?: number;
  /**
   * Whether the daemon derives and acts on a memory-pressure level.
   *
   * `observe` (default) reports the level alongside the raw figures and raises
   * a status issue when it leaves `normal`. `off` still reports the figures —
   * the point of this phase is to gather data, including from deployments that
   * do not want the signal acting on them yet — but raises no issue, so the
   * daemon's overall `status` rollup is unchanged.
   *
   * There is deliberately no `enforce`: nothing here remediates, and a value a
   * caller can pass but never use is a dead switch. It arrives with the
   * enforcement.
   */
  memoryPressureMode?: 'off' | 'observe';
  /**
   * Whether the daemon models a per-child heap partition of the budget.
   *
   * `observe` (default) computes the partition and counts the spawns it would
   * have refused; nothing is applied. There is no `enforce` yet — applying it
   * needs a way to tell an operator in advance whether their workload fits
   * the ceiling, and `refusals` cannot answer that: it counts admission
   * pressure, while children still run on the far larger host-derived
   * ceiling. `off` models nothing.
   */
  childHeapMode?: ChildHeapMode;
  /**
   * Resolved at boot by `runQwenServe`. Not an operator input, and not
   * consumed by any spawn path — it is reported under `limits.memory` on
   * `GET /daemon/status` so the daemon's memory denominator is observable
   * before a child-capacity policy is designed against it.
   */
  daemonMemoryBudget?: DaemonMemoryBudget;
  /**
   * Required external pre-execution policy for managed ACP tools. Omitted
   * means fully off. The token remains daemon-local and is never forwarded to
   * the ACP child or any executor environment.
   */
  externalToolGuard?: {
    mode: 'required';
    endpoint: string;
    token: string;
    timeoutMs?: number;
  };
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
   * ACP child request timeout, including the `initialize` handshake,
   * in ms. Must be a positive
   * integer. Default: 10000 (10 s).
   */
  initializeTimeoutMs?: number;
  /**
   * ACP session load/resume timeout in ms. Defaults to 60000 (60 s), raised
   * to an explicitly set initialize timeout when that value is larger. An
   * explicit value here wins outright, including below the default.
   */
  sessionRestoreTimeoutMs?: number;
  /**
   * Wall-clock timeout in ms for a human permission or `ask_user_question`
   * response in daemon mode. 0 = disabled. Default: 0 (wait until an explicit
   * decision or session lifecycle cancellation).
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
  /**
   * Accept client-hosted MCP servers over the daemon WS (issue #5626,
   * Phase 2 "reverse tool channel"). When enabled, a connected WS client may
   * send `mcp_register` / `mcp_message` / `mcp_unregister` frames so the
   * daemon's agent can call tools that execute in the client (e.g. the Chrome
   * extension's browser tools). `runQwenServe` only enables this when a caller
   * or environment variable opts in.
   */
  clientMcpOverWs?: boolean;
  /**
   * Tunnel raw CDP to a real browser tab over the reverse `/acp` WS
   * (Plan C "CDP tunnel", issue #5626). When enabled, a loopback CDP client can
   * connect to a new `/cdp` WebSocket and drive ONE real tab via the extension's
   * `chrome.debugger`, reusing browser automation tools. `runQwenServe` enables this for
   * Chrome extension origins or explicit env opt-in; callers may pass `false`.
   */
  cdpTunnelOverWs?: boolean;
  /** Forward the experimental LSP opt-in to spawned ACP children. */
  experimentalLsp?: boolean;
  /**
   * When true, load/resume re-hangs a trailing unanswered ask_user_question.
   * Default false. Forwarded to spawned ACP children.
   */
  restoreAskUserQuestion?: boolean;
  /**
   * Experimental: channels to host in a daemon-managed worker process.
   * Omitted means plain daemon mode with no channel worker.
   */
  channelSelection?: ServeChannelSelection;
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
   * Absolute primary workspace path. Clients use this to:
   *   - Preserve single-workspace compatibility.
   *   - Omit `cwd` on `POST /session` — the route falls back to this
   *     path when the body has no `cwd` field.
   *
   * Newer daemons list every registered runtime in `workspaces[]`, including
   * the primary runtime when `multi_workspace_sessions` is absent.
   * `workspaceCwd` remains the primary entry for old clients.
   *
   * Optional at the type level (matches the SDK's `DaemonCapabilities`
   * type) because the field is an additive extension of the v=1
   * envelope. Older daemons may omit this field; additive optionality
   * is the correct shape per the protocol's versioning stance. The
   * current server code always populates it.
   */
  workspaceCwd?: string;
  /** Registered workspace runtimes. Older single-workspace daemons may omit it. */
  workspaces?: Array<{
    id: string;
    cwd: string;
    displayName?: string;
    primary: boolean;
    trusted: boolean;
    removable?: boolean;
    kind?: 'live';
  }>;
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
    maxSessionsPerWorkspace?: number | null;
    maxTotalSessions?: number | null;
    sessionRestoreTimeoutMs?: number;
    /** Present when `workspace_file_upload` is advertised. */
    maxWorkspaceFileUploadBytes?: number;
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
  protocol: AuthType;
  protocolOptions?: AuthType[];
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
