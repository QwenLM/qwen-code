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

/** Capabilities envelope returned from `GET /capabilities`. */
export interface DaemonCapabilities {
  v: 1;
  mode: DaemonMode;
  /**
   * Feature tags the client should gate UI off (e.g. `permission_vote`,
   * `session_events`). Never gate UI off `mode` — see §10.
   */
  features: string[];
  modelServices: string[];
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
