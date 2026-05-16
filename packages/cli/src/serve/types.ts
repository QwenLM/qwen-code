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
}

export const CAPABILITIES_SCHEMA_VERSION = 1 as const;

/** @deprecated Use SERVE_FEATURES from the capability registry. */
export const STAGE1_FEATURES = SERVE_FEATURES;

/** @deprecated Use ServeFeature from the capability registry. */
export type Stage1Feature = ServeFeature;
