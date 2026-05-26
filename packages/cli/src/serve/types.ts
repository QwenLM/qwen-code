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
// Wenshao review #4335 / 3271978342 — import the canonical
// `PermissionPolicy` union from acp-bridge instead of inlining
// the four string literals below. Without the import, adding a
// 5th policy literal upstream would silently widen the union
// over there while this envelope kept accepting only the older
// 4-literal narrower set, with no compiler error to flag the drift.
import type { PermissionPolicy } from '@qwen-code/acp-bridge';

/**
 * Stage 1 daemon mode shape.
 *
 * `http-bridge` (Stage 1): per #3803 §02, one `qwen --acp` child per
 *   daemon (the daemon binds to ONE workspace at boot). Multiple
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
   * Listener-level TCP connection cap (`server.maxConnections`).
   * Defaults to 256 — bounds the raw socket count regardless of
   * session count, so a slow / phantom SSE client can't pin the
   * daemon's FD table even when it isn't holding a live ACP session.
   * `0` (or `Infinity`) disables the cap by leaving
   * `server.maxConnections` unset, which falls back to Node's
   * built-in unlimited default. We avoid actually setting
   * `server.maxConnections = 0` because on Node 22 that causes the
   * listener to refuse EVERY connection (tanzhenxin issue 1).
   * NaN / negative values throw at boot. Independent of
   * `maxSessions` because one session can have many SSE subscribers
   * (default cap 64) plus short-lived REST calls.
   */
  maxConnections?: number;
  /**
   * Per-session SSE replay ring depth. Threaded into the bridge as
   * `BridgeOptions.eventRingSize` and used at every `new EventBus(...)`
   * construction site. Defaults to 8000 (the target named in
   * #3803 §02 for chatty Stage 1 sessions). Must be a positive
   * finite integer — `0` / `NaN` / negative fail at boot. Larger
   * rings let clients with longer reconnect gaps replay more history
   * at the cost of a few hundred KB extra RAM per session.
   */
  eventRingSize?: number;
  /**
   * Absolute workspace path this daemon binds to. Per #3803 §02 the
   * daemon is **1 daemon = 1 workspace × N sessions**: one bound
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
   * removed in the §02 design revision).
   *
   * Defaults to `process.cwd()` when omitted.
   */
  workspace?: string;
  /**
   * Issue #4175 PR 15. When true, refuses to boot without a bearer
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
   * Issue #4175 PR 14. Cap on live MCP clients spawned inside the
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
   * Issue #4175 PR 14. Enforcement mode for `mcpClientBudget`.
   * Boot rejects `enforce` without a budget; otherwise resolves to
   * `warn` when budget set / `off` when budget unset.
   */
  mcpBudgetMode?: 'enforce' | 'warn' | 'off';
  /**
   * F2 (#4175 commit 5). Whether the daemon advertises the
   * `mcp_workspace_pool` + `mcp_pool_restart` capability tags.
   * Defaults to `true` (the F2 pool is always on except under the
   * env-var kill switch). Operators set this to `false` when
   * `QWEN_SERVE_NO_MCP_POOL=1` is in scope so SDK clients pre-flighting
   * on the tags don't speculatively send `?entryIndex=` queries the
   * legacy single-entry path can't honor. The tag advertisement is
   * orthogonal to ACP child behavior — the child reads its own env
   * var copy independently — but they're driven from the same source
   * via `runQwenServe.ts`.
   */
  mcpPoolActive?: boolean;
  /**
   * T2.4 (issue #4514). Cross-origin allowlist for browser webui
   * deployments. Each entry is either the `*` literal (any origin
   * allowed, advertised loudly in the boot breadcrumb) or a canonical
   * URL origin (`<scheme>://<host>[:<port>]`, no trailing slash / path /
   * userinfo / query). When at least one pattern is configured, the
   * daemon installs `allowOriginCors` instead of `denyBrowserOriginCors`
   * — matched cross-origin requests get proper CORS response headers
   * (`Access-Control-Allow-Origin: <echoed>`, `Vary: Origin`,
   * standard methods / headers / max-age, exposed `Retry-After`),
   * unmatched cross-origin requests still get a 403 with the same error
   * envelope as today.
   *
   * Empty / undefined preserves the default wall (any `Origin` header →
   * 403 from `denyBrowserOriginCors`). Boot validates each entry through
   * `parseAllowOriginPatterns` in
   * `packages/cli/src/serve/auth.ts`; malformed entries throw
   * `InvalidAllowOriginPatternError` and refuse to start.
   *
   * Loopback self-hits are unaffected — the demo-page Origin-strip
   * shim (`server.ts` near `cachedSelfOrigins`) runs first and removes
   * the `Origin` header for self-loopback addresses, so neither the
   * old wall nor the new allowlist needs to know about them.
   */
  allowOrigins?: string[];
}

/**
 * Capability envelope returned from `GET /capabilities`. Clients gate UI off
 * `features`, never off `mode` (per design §10 protocol-compatibility).
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
   * Absolute workspace path this daemon is bound to (per #3803 §02:
   * `1 daemon = 1 workspace`). Clients use this to:
   *   - Detect mismatch before posting `/session` (vs. waiting for
   *     400 workspace_mismatch from the bridge).
   *   - Omit `cwd` on `POST /session` — the route falls back to this
   *     path when the body has no `cwd` field.
   *
   * Optional at the type level (matches the SDK's `DaemonCapabilities`
   * type) because the field is an additive extension of the v=1
   * envelope introduced by #3803 §02. Daemons predating §02 still
   * announce `v: 1` and omit this field; the protocol's "bump v only
   * on incompatible frame changes" stance (see `qwen-serve-protocol.md`
   * "Additive to v=1" note) makes additive optionality the correct
   * shape. The post-§02 server code here always populates it.
   */
  workspaceCwd?: string;
  /**
   * #4175 F3 Commit 6 — daemon-policy namespace. Active values for
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
}

export const CAPABILITIES_SCHEMA_VERSION = 1 as const;

/** @deprecated Use SERVE_FEATURES from the capability registry. */
export const STAGE1_FEATURES = SERVE_FEATURES;

/** @deprecated Use ServeFeature from the capability registry. */
export type Stage1Feature = ServeFeature;
