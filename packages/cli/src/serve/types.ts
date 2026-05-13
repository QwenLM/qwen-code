/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stage 1 daemon mode shape.
 *
 * `http-bridge` (Stage 1): one `qwen --acp` child PER WORKSPACE, with
 *   multiple sessions multiplexed onto that child via the agent's native
 *   `connection.newSession()` (see `acp-integration/acpAgent.ts:194`).
 *   Sessions on the same workspace share the child's process / OAuth /
 *   file-cache / hierarchy-memory parse. The daemon pipes ACP NDJSON over
 *   HTTP/SSE. Same-session multi-client requests serialize through the
 *   bridge's per-session FIFO; cross-session requests on the same channel
 *   can run concurrently (the ACP layer demultiplexes by sessionId).
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
}

/**
 * Capability envelope returned from `GET /capabilities`. Clients gate UI off
 * `features`, never off `mode` (per design §10 protocol-compatibility).
 *
 * `v` is the wire schema version; bumped only on breaking frame changes.
 */
export interface CapabilitiesEnvelope {
  v: 1;
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
}

export const CAPABILITIES_SCHEMA_VERSION = 1 as const;

/**
 * Stage 1 ships only the routes wired in `server.ts`. As routes land in
 * follow-up PRs, append the corresponding feature tag here so clients can
 * progressively enable UI affordances.
 *
 * The annotation is intentionally absent: `as const` widens to
 * `readonly ['health', 'capabilities', ...]` and the derived
 * `Stage1Feature` union catches typos at compile time. Annotating as
 * `readonly string[]` would erase the literal information.
 */
// FIXME(stage-1.5, chiga0 finding 5):
// `STAGE1_FEATURES` is a hard-coded constant — `extMethod` plugins
// can't contribute to the capability set without editing the daemon.
// Stage 1.5 should convert this to a registry that bridges and
// plugins push into, alongside an `ext_*` event family + a
// `POST /ext/:method` route. Tracked under #3803.
// Reference: https://github.com/QwenLM/qwen-code/pull/3889#issuecomment-4427773706
export const STAGE1_FEATURES = [
  'health',
  'capabilities',
  'session_create',
  'session_list',
  'session_prompt',
  'session_cancel',
  'session_events',
  'session_set_model',
  'permission_vote',
] as const;

/** Compile-time-checked feature identifier — element of STAGE1_FEATURES. */
export type Stage1Feature = (typeof STAGE1_FEATURES)[number];
