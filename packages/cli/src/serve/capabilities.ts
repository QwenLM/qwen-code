/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const SERVE_PROTOCOL_VERSION = 'v1' as const;

export const SUPPORTED_SERVE_PROTOCOL_VERSIONS = [
  SERVE_PROTOCOL_VERSION,
] as const;

export type ServeProtocolVersion =
  (typeof SUPPORTED_SERVE_PROTOCOL_VERSIONS)[number];

export interface ServeProtocolVersions {
  current: ServeProtocolVersion;
  supported: ServeProtocolVersion[];
}

export interface ServeCapabilityDescriptor {
  since: ServeProtocolVersion;
  /**
   * Sub-mode names supported by this capability, when the feature has
   * more than one operating mode and clients benefit from feature-
   * detecting the active set. Optional — baseline tags (always-on,
   * single behavior) omit this field.
   */
  modes?: readonly string[];
}

export const SERVE_CAPABILITY_REGISTRY = {
  health: { since: 'v1' },
  daemon_status: { since: 'v1' },
  capabilities: { since: 'v1' },
  session_create: { since: 'v1' },
  session_scope_override: { since: 'v1' },
  session_load: { since: 'v1' },
  session_resume: { since: 'v1' },
  // Deprecated alias — kept until @agentclientprotocol/sdk graduates
  // the underlying ACP method from unstable_resumeSession to resumeSession.
  unstable_session_resume: { since: 'v1' },
  session_list: { since: 'v1' },
  session_prompt: { since: 'v1' },
  session_cancel: { since: 'v1' },
  session_events: { since: 'v1' },
  // Daemon emits `slow_client_warning` synthetic frames at 75% queue
  // fill and honors `?maxQueued=N` (range [16, 2048]) on
  // `GET /session/:id/events`. Old daemons silently lack both — SDK
  // clients pre-flight this tag before opting in.
  slow_client_warning: { since: 'v1' },
  // SDK consumers can detect `KnownDaemonEvent` schema support without
  // pinning against this SDK release — `narrowDaemonEvent` falls back
  // to `kind: 'unknown'` for daemons that don't advertise the tag,
  // so the tag is purely informational.
  typed_event_schema: { since: 'v1' },
  session_set_model: { since: 'v1' },
  client_identity: { since: 'v1' },
  client_heartbeat: { since: 'v1' },
  session_permission_vote: { since: 'v1' },
  permission_vote: { since: 'v1' },
  workspace_mcp: { since: 'v1' },
  workspace_skills: { since: 'v1' },
  workspace_providers: { since: 'v1' },
  auth_provider_install: { since: 'v1' },
  // Workspace memory CRUD (`GET/POST /workspace/memory`). Daemon exposes
  // hierarchical QWEN.md state and accepts append/replace writes scoped
  // to either the bound workspace or the global ~/.qwen directory.
  workspace_memory: { since: 'v1' },
  // Workspace agents CRUD (`GET/POST /workspace/agents` +
  // `GET/POST/DELETE /workspace/agents/:agentType`). Wraps
  // `SubagentManager` over HTTP so remote clients can list / read /
  // create / update / delete project- and user-level subagent
  // definitions. Built-in / extension agents stay read-only.
  workspace_agents: { since: 'v1' },
  workspace_agent_generate: { since: 'v1' },
  workspace_env: { since: 'v1' },
  workspace_preflight: { since: 'v1' },
  session_context: { since: 'v1' },
  session_context_usage: { since: 'v1' },
  session_supported_commands: { since: 'v1' },
  session_tasks: { since: 'v1' },
  session_stats: { since: 'v1' },
  session_lsp_status: { since: 'v1' },
  session_close: { since: 'v1' },
  session_metadata: { since: 'v1' },
  // Daemon supports the MCP client guardrail surface: an in-process
  // counter exposed on `GET /workspace/mcp`, a `--mcp-client-budget=N`
  // flag with `--mcp-budget-mode={enforce, warn, off}`, and a
  // `disabledReason: 'budget'` tag on per-server cells when refused at
  // discovery. `modes` enumerates the implemented behaviors.
  mcp_guardrails: { since: 'v1', modes: ['warn', 'enforce'] },
  workspace_mcp_manage: { since: 'v1' },
  // Daemon emits typed push events for MCP budget state crossings:
  // `mcp_budget_warning` and `mcp_child_refused_batch`. Always-on;
  // orthogonal to `mcp_guardrails` (the snapshot surface).
  mcp_guardrail_events: { since: 'v1' },
  // Always-on. Daemon supports runtime MCP server mutation via
  // `POST /workspace/mcp/servers` (add) and
  // `DELETE /workspace/mcp/servers/:name` (remove). SDK clients
  // pre-flight this tag before calling those routes.
  mcp_server_runtime_mutation: { since: 'v1' },
  // Daemon supports the read-only workspace file surface:
  // `GET /file`, `GET /list`, `GET /glob`, `GET /stat`. The four
  // routes are gated as a single feature because they share the same
  // backing `WorkspaceFileSystem` boundary and failure shape.
  workspace_file_read: { since: 'v1' },
  // Daemon supports bounded raw byte reads via `GET /file/bytes`.
  // Separate from `workspace_file_read` because older daemons may
  // advertise the text/list/stat/glob surface without byte-window
  // support.
  workspace_file_bytes: { since: 'v1' },
  // Daemon supports hash-aware text mutation routes
  // (`POST /file/write`, `POST /file/edit`) behind the strict mutation
  // gate. Clients should still pre-flight `require_auth` separately for
  // deployment posture; this tag only means the route contract exists.
  workspace_file_write: { since: 'v1' },
  // Daemon hosts the session-level approval-mode
  // control route `POST /session/:id/approval-mode` (gated by the
  // mutation gate, strict). The route accepts `{mode, persist?}` —
  // `persist:true` also writes `tools.approvalMode` to workspace
  // settings via the daemon's `loadedSettings` handle. SDK helper:
  // `DaemonClient.setSessionApprovalMode`.
  session_approval_mode_control: { since: 'v1' },
  // `POST /workspace/tools/:name/enable` toggles a
  // tool name in the workspace's `tools.disabled` settings list. The
  // bridge writes the settings file directly (no ACP roundtrip) and
  // fan-outs a `tool_toggled` event to all live session SSE buses.
  // Already-registered tools in active sessions are NOT retroactively
  // unregistered — the toggle takes effect on the next ACP child spawn
  // (`tools.disabled` is consulted at `Config` construction time).
  workspace_tool_toggle: { since: 'v1' },
  workspace_settings: { since: 'v1' },
  // `POST /workspace/init` scaffolds an empty
  // `QWEN.md` (or whatever `getCurrentGeminiMdFilename()` returns) at
  // the bound workspace root. Body: `{force?: boolean}`. Default
  // refuses with 409 when the file already exists; `force: true`
  // overwrites. Mechanical only — does NOT call the LLM. To AI-fill
  // the file, the caller should follow up with
  // `POST /session/:id/prompt`.
  workspace_init: { since: 'v1' },
  // `POST /workspace/mcp/:server/restart` performs
  // a single-server MCP restart (disconnect + reconnect + rediscover)
  // through the ACP child's `McpClientManager`. Pre-checks the live
  // budget snapshot: when the target server is not
  // already in `reservedSlots` AND the live count would exceed the
  // configured budget under `enforce` mode, returns 200 with
  // `{restarted:false, skipped:true, reason:'budget_would_exceed'}`
  // rather than triggering a refusal cascade. Other skip reasons:
  // `'in_flight'` (concurrent discovery in progress), `'disabled'`
  // (server is configured but explicitly disabled).
  workspace_mcp_restart: { since: 'v1' },
  // Daemon hosts `POST /session/:id/recap`, which
  // generates a one-sentence "where did I leave off" summary by
  // running `generateSessionRecap` (`core/services/sessionRecap.ts`) as
  // a side-query against the fast model. Non-strict mutation gate —
  // posture mirrors `/session/:id/prompt` (token cost, not state
  // mutation). The route returns `{sessionId, recap}` where `recap`
  // may be `null` for too-short histories or transient model failures
  // (best-effort, never throws). SDK helper: `DaemonClient.recapSession`.
  session_recap: { since: 'v1' },
  // Side question (/btw) against the session's conversation context.
  // Single-turn, tool-free LLM call via runForkedAgent (cache path).
  session_btw: { since: 'v1' },
  // Direct daemon-side shell execution for an existing session.
  // Advertised CONDITIONALLY: operators must explicitly enable it and
  // configure bearer auth. Clients must still send a session-bound
  // X-Qwen-Client-Id when calling the route.
  session_shell_command: { since: 'v1' },
  // Daemon hosts a workspace-shared MCP transport
  // pool (`QwenAgent.mcpPool`); `GET /workspace/mcp` reflects pool-level
  // accounting (`entryCount`, `entrySummary` on each per-server cell).
  // Advertised CONDITIONALLY — the kill switch
  // `QWEN_SERVE_NO_MCP_POOL=1` env var falls back to per-session MCP
  // clients and the tag is omitted so SDK consumers
  // pre-flighting on the tag get accurate "pool is on" semantics.
  mcp_workspace_pool: { since: 'v1' },
  // `POST /workspace/mcp/:server/restart`
  // accepts an optional `?entryIndex=N` (or `*`) query parameter
  // and may return the new `{entries: RestartResult[]}` shape when
  // the pool holds multiple entries for the same server name (e.g.
  // sessions injected divergent OAuth headers). Single-entry
  // restarts continue to return the legacy `{restarted, durationMs}`
  // shape for compatibility with pre-F2 SDK clients. Advertised
  // CONDITIONALLY in lockstep with `mcp_workspace_pool`: pool
  // off → both tags absent, pool on → both tags present. Operators
  // pre-flighting on this tag can branch on whether the response
  // shape may include `entries[]`.
  mcp_pool_restart: { since: 'v1' },
  // Daemon was booted with `--require-auth` (or
  // `requireAuth: true`), so even loopback callers must carry a bearer
  // token. Advertised CONDITIONALLY — only when the flag is on — so
  // SDK clients can branch on its presence to surface a clear "this
  // deployment requires auth" hint instead of speculatively trying
  // requests and parsing the resulting 401 body. Loopback developer
  // defaults (no flag) omit the tag, preserving the bit-for-bit shape
  // older clients expect.
  require_auth: { since: 'v1' },
  // Daemon was booted with `--allow-origin <pattern>`
  // (at least one entry, including the `*` literal). Advertised
  // CONDITIONALLY — only when the flag is set — so browser SDK clients
  // can pre-flight whether the daemon will honor their cross-origin
  // request before issuing it (and parsing a 403). The configured
  // pattern list is intentionally NOT echoed in the capabilities
  // envelope — browser webui knows its own origin, and surfacing the
  // list would let an unauthenticated `/capabilities` reader
  // enumerate every trusted origin, which is useful recon for a
  // misconfigured deployment.
  allow_origin: { since: 'v1' },
  // Daemon exposes the device-flow auth surface
  // (`POST /workspace/auth/device-flow`, GET/DELETE on `/:id`, and
  // `GET /workspace/auth/status`). Advertised UNCONDITIONALLY: the
  // routes themselves return `400 unsupported_provider` if the daemon
  // can't satisfy a specific provider, so clients always probe via the
  // route. The list of supported providers is surfaced through the
  // status route (extension data on `/capabilities` would inflate the
  // descriptor shape; we keep the registry uniform).
  auth_device_flow: { since: 'v1' },
  permission_mediation: {
    since: 'v1',
    modes: ['first-responder', 'designated', 'consensus', 'local-only'],
  },
  prompt_absolute_deadline: { since: 'v1' },
  writer_idle_timeout: { since: 'v1' },
  non_blocking_prompt: { since: 'v1' },
  session_language: { since: 'v1' },
  session_rewind: { since: 'v1' },
  workspace_hooks: { since: 'v1' },
  session_hooks: { since: 'v1' },
  workspace_extensions: { since: 'v1' },
  session_branch: { since: 'v1' },
  rate_limit: { since: 'v1' },
  workspace_reload: { since: 'v1' },
} as const satisfies Record<string, ServeCapabilityDescriptor>;

export type ServeFeature = keyof typeof SERVE_CAPABILITY_REGISTRY;

/**
 * Per-deployment feature toggles surfaced through `/capabilities`.
 *
 * advertised.
 */
export interface AdvertiseFeatureToggles {
  requireAuth?: boolean;
  mcpPoolActive?: boolean;
  allowOriginActive?: boolean;
  promptDeadlineMs?: number;
  writerIdleTimeoutMs?: number;
  persistSettingAvailable?: boolean;
  sessionShellCommandEnabled?: boolean;
  rateLimit?: boolean;
  reloadAvailable?: boolean;
}

/**
 * Subset of `ServeFeature` whose advertisement depends on runtime config
 * (currently just `require_auth`, which is announced only when the
 * daemon was started with `--require-auth`). Each entry pairs the
 * feature key with a predicate over `AdvertiseFeatureToggles` — the
 * toggle decision lives next to the feature key, so adding a new
 * conditional tag is **two coordinated changes** instead of four:
 *
 * 1. Register the tag in `SERVE_CAPABILITY_REGISTRY` above with its
 *    `since` protocol version (just like baseline tags).
 * 2. Add an entry to THIS Map mapping the tag to a toggle predicate
 *    (extend `AdvertiseFeatureToggles` first if the predicate needs a
 *    new field to read).
 *
 * The previous `Set` + per-feature `if`-branch shape needed FOUR
 * coordinated changes (registry, set, toggles interface, predicate
 * branch) and silently fail-CLOSED when the branch was missed —
 * fail-CLOSED is good, but invisible to the contributor adding the
 * tag. The Map shape collapses the predicate-decision and the
 * set-membership into one entry, so a future contributor either
 * registers the predicate (advertised when toggle on) or doesn't
 * register the tag in the Map at all (advertised unconditionally
 * like baseline tags) — both are intentional, neither is a silent
 * miss.
 *
 * Reviewed-through-failure: the
 * `every conditional tag advertises when its toggle is on` test in
 * `server.test.ts` iterates this Map's keys, so a future tag added
 * here whose predicate isn't honored by `getAdvertisedServeFeatures`
 * fails the suite — adoption-of-record for the Map shape rather than
 * relying on a hand-maintained invariant.
 */
export const CONDITIONAL_SERVE_FEATURES: ReadonlyMap<
  ServeFeature,
  (toggles: AdvertiseFeatureToggles) => boolean
> = new Map<ServeFeature, (toggles: AdvertiseFeatureToggles) => boolean>([
  ['require_auth', (toggles) => toggles.requireAuth === true],
  ['mcp_workspace_pool', (toggles) => toggles.mcpPoolActive === true],
  ['mcp_pool_restart', (toggles) => toggles.mcpPoolActive === true],
  ['allow_origin', (toggles) => toggles.allowOriginActive === true],
  [
    'prompt_absolute_deadline',
    (toggles) =>
      typeof toggles.promptDeadlineMs === 'number' &&
      toggles.promptDeadlineMs > 0,
  ],
  [
    'writer_idle_timeout',
    (toggles) =>
      typeof toggles.writerIdleTimeoutMs === 'number' &&
      toggles.writerIdleTimeoutMs > 0,
  ],
  ['workspace_settings', (toggles) => toggles.persistSettingAvailable === true],
  [
    'session_shell_command',
    (toggles) => toggles.sessionShellCommandEnabled === true,
  ],
  ['rate_limit', (toggles) => toggles.rateLimit === true],
  ['workspace_reload', (toggles) => toggles.reloadAvailable === true],
]);

export const SERVE_FEATURES = Object.freeze(
  Object.keys(SERVE_CAPABILITY_REGISTRY) as ServeFeature[],
);

function serveProtocolVersionIndex(version: ServeProtocolVersion): number {
  return SUPPORTED_SERVE_PROTOCOL_VERSIONS.indexOf(version);
}

function isFeatureAvailableInProtocol(
  feature: ServeFeature,
  protocolVersion: ServeProtocolVersion,
): boolean {
  return (
    serveProtocolVersionIndex(SERVE_CAPABILITY_REGISTRY[feature].since) <=
    serveProtocolVersionIndex(protocolVersion)
  );
}

export function getRegisteredServeFeatures(): ServeFeature[] {
  return [...SERVE_FEATURES];
}

export function getAdvertisedServeFeatures(
  protocolVersion: ServeProtocolVersion = SERVE_PROTOCOL_VERSION,
  toggles: AdvertiseFeatureToggles = {},
): ServeFeature[] {
  return SERVE_FEATURES.filter((feature) => {
    if (!isFeatureAvailableInProtocol(feature, protocolVersion)) return false;
    // Conditional tags route through the per-feature toggle predicate;
    // baseline tags (no Map entry) advertise unconditionally. Without
    // this gate every daemon would advertise the conditional tags
    // regardless of operator opt-in, breaking the "tag presence =
    // behavior is on" contract clients depend on.
    const predicate = CONDITIONAL_SERVE_FEATURES.get(feature);
    if (predicate !== undefined) return predicate(toggles);
    return true;
  });
}

export function getServeFeatures(): ServeFeature[] {
  return getAdvertisedServeFeatures();
}

export function getServeProtocolVersions(): ServeProtocolVersions {
  return {
    current: SERVE_PROTOCOL_VERSION,
    supported: [...SUPPORTED_SERVE_PROTOCOL_VERSIONS],
  };
}
