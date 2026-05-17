/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wire types for the `qwen serve` daemon HTTP API.
 *
 * These mirror the shapes emitted by `packages/cli/src/serve` but are
 * defined SDK-side to avoid an SDK→CLI dependency. The shapes are stable
 * once the capabilities envelope's `v` advances; bumping `v` is what
 * signals breaking wire changes (per design §04).
 */

export type DaemonMode = 'http-bridge' | 'native';

export interface DaemonProtocolVersions {
  current: string;
  supported: string[];
}

/** Capabilities envelope returned from `GET /capabilities`. */
export interface DaemonCapabilities {
  v: 1;
  /**
   * Serve protocol versions supported by the daemon. Optional because this is
   * additive to v=1; older v=1 daemons omit it.
   */
  protocolVersions?: DaemonProtocolVersions;
  mode: DaemonMode;
  /**
   * Feature tags the client should gate UI off (e.g. `permission_vote`,
   * `session_events`). Never gate UI off `mode` — see §10.
   */
  features: string[];
  modelServices: string[];
  /**
   * Absolute canonical workspace path this daemon is bound to
   * (per #3803 §02: 1 daemon = 1 workspace). Clients use this to
   * (a) detect mismatch before posting `/session` (vs. waiting for
   * a 400 `workspace_mismatch` response), and (b) omit `cwd` on
   * `POST /session` — the route falls back to this path when the
   * body has no `cwd` field. Multi-workspace deployments expose
   * multiple daemons on different ports, each advertising its own
   * `workspaceCwd`.
   *
   * Optional at the type level because the field is an additive
   * extension to v=1 envelopes (added by #3803 §02). Daemons
   * predating §02 still announce `v: 1` but omit this field; the
   * protocol's "bump v only on incompatible frame changes" stance
   * (see `qwen-serve-protocol.md`) makes additive optionality the
   * correct shape. All post-§02 daemons populate it.
   *
   * **SDK consumers**: if you need the value as a non-undefined
   * `string` (e.g. to call `.startsWith()` or pass into a function
   * typed `string`), use the `requireWorkspaceCwd` helper from this
   * module — it throws `DaemonCapabilityMissingError` with an
   * actionable "this daemon predates §02" message instead of
   * letting the call site hit a cryptic
   * "Cannot read properties of undefined".
   */
  workspaceCwd?: string;
}

/**
 * Thrown by `requireWorkspaceCwd` (and any future
 * `requireCapability` helpers) when the daemon's
 * `/capabilities` envelope is missing a field the caller needs.
 * Carries the field name so handlers can branch on it.
 */
export class DaemonCapabilityMissingError extends Error {
  readonly capability: string;
  constructor(capability: string, hint: string) {
    super(
      `DaemonCapabilities.${capability} is missing — ${hint}. The daemon ` +
        `you are connected to likely predates the feature that added ` +
        `this field; upgrade the daemon or fall back to a different ` +
        `code path that doesn't require it.`,
    );
    this.name = 'DaemonCapabilityMissingError';
    this.capability = capability;
  }
}

/**
 * Assert that `caps.workspaceCwd` is populated (i.e. the daemon was
 * built post-§02) and return it as a non-undefined `string`. Throws
 * `DaemonCapabilityMissingError` otherwise so the call site gets an
 * actionable error rather than a downstream
 * `Cannot read properties of undefined`.
 *
 * Use this when you need the value as a guaranteed `string` —
 * e.g. to render in UI, log, compare with `.startsWith()`, or pass
 * into a function typed `string`. If your code is fine with the
 * value being absent (e.g. you fall back to `POST /session` without
 * `workspaceCwd` and let the daemon choose), just read
 * `caps.workspaceCwd` directly.
 */
export function requireWorkspaceCwd(caps: DaemonCapabilities): string {
  if (typeof caps.workspaceCwd !== 'string' || caps.workspaceCwd.length === 0) {
    throw new DaemonCapabilityMissingError(
      'workspaceCwd',
      caps.workspaceCwd === ''
        ? 'daemon returned an empty workspaceCwd (post-§02 daemon with a bug)'
        : 'daemon predates #3803 §02 (1 daemon = 1 workspace); upgrade it',
    );
  }
  return caps.workspaceCwd;
}

/** Returned from `POST /session`. */
export interface DaemonSession {
  sessionId: string;
  workspaceCwd: string;
  /** True when an existing session was reused under sessionScope:single. */
  attached: boolean;
}

/** Sparse session record returned by `GET /workspace/:id/sessions`. */
export interface DaemonSessionSummary {
  sessionId: string;
  workspaceCwd: string;
}

/** Returned from `POST /session/:id/model`. ACP currently allows an opaque body. */
export interface SetModelResult {
  [key: string]: unknown;
}

/** A frame in the SSE event stream. */
export interface DaemonEvent {
  /**
   * Monotonic per-session id; pass back as `Last-Event-ID` to resume.
   *
   * Optional because terminal/synthetic frames (notably `stream_error`)
   * are emitted without an `id` line so they don't pollute the
   * Last-Event-ID sequence the client uses for resume tracking. Consumers
   * persisting the last-seen id should ignore frames where `id === undefined`.
   */
  id?: number;
  /** Schema version; clients should ignore frames whose `v` they don't understand. */
  v: 1;
  /** Frame discriminator: `session_update`, `permission_request`, etc. */
  type: string;
  /** Frame payload — opaque JSON. */
  data: unknown;
  originatorClientId?: string;
}

export interface PromptTextContent {
  type: 'text';
  text: string;
}

/**
 * The set of content blocks the daemon's prompt route accepts. The full ACP
 * `ContentBlock` union is wider; SDK clients can pass any of those shapes
 * through — the route forwards the array verbatim.
 */
export type PromptContentBlock = PromptTextContent | Record<string, unknown>;

/** Returned from `POST /session/:id/prompt`. */
export interface PromptResult {
  stopReason: string;
  [key: string]: unknown;
}

export interface PermissionOutcomeCancelled {
  outcome: 'cancelled';
}

export interface PermissionOutcomeSelected {
  outcome: 'selected';
  optionId: string;
}

export type PermissionOutcome =
  | PermissionOutcomeCancelled
  | PermissionOutcomeSelected;

export interface PermissionResponse {
  outcome: PermissionOutcome;
  [key: string]: unknown;
}
