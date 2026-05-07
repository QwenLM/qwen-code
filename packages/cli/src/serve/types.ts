/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stage 1 daemon mode shape.
 *
 * `http-bridge` (Stage 1): each session spawns a `qwen --acp` child process;
 *   the daemon pipes ACP NDJSON over HTTP/SSE. Startup cost is not amortized
 *   across sessions; multi-client requests serialize through the bridge.
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
