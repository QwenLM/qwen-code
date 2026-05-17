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
  /**
   * Opaque id stamped by the daemon for this attached HTTP client. Newer
   * daemons return it from create/load/resume; older daemons omit it.
   */
  clientId?: string;
  /** ISO 8601 timestamp of when the session was created. */
  createdAt?: string;
}

/**
 * ACP state returned by session load/resume routes.
 *
 * Fields mirror the ACP `LoadSessionResponse` / `ResumeSessionResponse`
 * shapes (see `@agentclientprotocol/sdk`):
 * - `models`: the agent's `SessionModelState` — current model id +
 *   available models the session can switch to.
 * - `modes`: the agent's `SessionModeState` — current mode id +
 *   available approval / interaction modes.
 * - `configOptions`: array of `SessionConfigOption` describing
 *   per-session toggles the client can flip via
 *   `POST /session/:id/config-option`.
 *
 * They are typed as `unknown` here to avoid coupling the SDK to ACP's
 * internal protocol types, which the SDK doesn't re-export. Callers
 * that need richer typing should narrow to the ACP shapes themselves.
 */
export interface DaemonSessionState {
  _meta?: Record<string, unknown> | null;
  models?: unknown;
  modes?: unknown;
  configOptions?: unknown[] | null;
  [key: string]: unknown;
}

/** Returned from `POST /session/:id/load` and `POST /session/:id/resume`. */
export interface DaemonRestoredSession extends DaemonSession {
  state: DaemonSessionState;
}

/** Sparse session record returned by `GET /workspace/:id/sessions`. */
export interface DaemonSessionSummary {
  sessionId: string;
  workspaceCwd: string;
  createdAt?: string;
  displayName?: string;
  clientCount?: number;
  hasActivePrompt?: boolean;
}

/** Effective mutable metadata returned from `PATCH /session/:id/metadata`. */
export interface SessionMetadataResult {
  displayName?: string;
}

export type DaemonStatus =
  | 'ok'
  | 'warning'
  | 'error'
  | 'disabled'
  | 'not_started'
  | 'unknown';

export interface DaemonStatusCell {
  kind: string;
  status: DaemonStatus;
  error?: string;
  errorKind?: string;
  hint?: string;
}

export type DaemonMcpDiscoveryState =
  | 'not_started'
  | 'in_progress'
  | 'completed';

export type DaemonMcpServerRuntimeStatus =
  | 'connected'
  | 'connecting'
  | 'disconnected';

export type DaemonMcpTransport =
  | 'stdio'
  | 'sse'
  | 'http'
  | 'websocket'
  | 'sdk'
  | 'unknown';

export interface DaemonWorkspaceMcpServerStatus extends DaemonStatusCell {
  kind: 'mcp_server';
  name: string;
  mcpStatus?: DaemonMcpServerRuntimeStatus;
  transport: DaemonMcpTransport;
  disabled: boolean;
  description?: string;
  extensionName?: string;
}

export interface DaemonWorkspaceMcpStatus {
  v: 1;
  workspaceCwd: string;
  initialized: boolean;
  discoveryState?: DaemonMcpDiscoveryState;
  servers: DaemonWorkspaceMcpServerStatus[];
  errors?: DaemonStatusCell[];
}

export type DaemonSkillLevel = 'project' | 'user' | 'extension' | 'bundled';

export interface DaemonWorkspaceSkillStatus extends DaemonStatusCell {
  kind: 'skill';
  name: string;
  description: string;
  level: DaemonSkillLevel;
  modelInvocable: boolean;
  argumentHint?: string;
  model?: string;
  extensionName?: string;
}

export interface DaemonWorkspaceSkillsStatus {
  v: 1;
  workspaceCwd: string;
  initialized: boolean;
  skills: DaemonWorkspaceSkillStatus[];
  errors?: DaemonStatusCell[];
}

export interface DaemonWorkspaceProviderCurrent {
  authType?: string;
  modelId?: string;
}

export interface DaemonWorkspaceProviderModel {
  modelId: string;
  baseModelId: string;
  name: string;
  description?: string | null;
  contextLimit?: number;
  isCurrent: boolean;
  isRuntime: boolean;
}

export interface DaemonWorkspaceProviderStatus extends DaemonStatusCell {
  kind: 'model_provider';
  authType: string;
  current: boolean;
  models: DaemonWorkspaceProviderModel[];
}

export interface DaemonWorkspaceProvidersStatus {
  v: 1;
  workspaceCwd: string;
  initialized: boolean;
  current?: DaemonWorkspaceProviderCurrent;
  providers: DaemonWorkspaceProviderStatus[];
  errors?: DaemonStatusCell[];
}

/**
 * Issue #4175 PR 16: workspace memory snapshot returned from
 * `GET /workspace/memory`. Mirrors the `kind / status / error?` cell
 * pattern used by mcp/skills/providers — adapters can render any of
 * the four with the same component.
 */
export type DaemonContextFileScope = 'workspace' | 'global';

export interface DaemonWorkspaceMemoryFile {
  kind: 'memory_file';
  path: string;
  scope: DaemonContextFileScope;
  bytes: number;
}

export interface DaemonWorkspaceMemoryStatus {
  v: 1;
  workspaceCwd: string;
  initialized: boolean;
  files: DaemonWorkspaceMemoryFile[];
  totalBytes: number;
  fileCount: number;
  ruleCount: number;
  errors?: DaemonStatusCell[];
}

/**
 * Body of `POST /workspace/memory`. `mode` defaults to `'append'`
 * server-side when omitted; clients SHOULD send it explicitly so a
 * future server-side default flip doesn't silently change semantics.
 */
export interface DaemonWriteMemoryRequest {
  scope: DaemonContextFileScope;
  content: string;
  mode?: 'append' | 'replace';
}

export interface DaemonWriteMemoryResult {
  ok: true;
  filePath: string;
  bytesWritten: number;
  mode: 'append' | 'replace';
}

/**
 * Issue #4175 PR 16: subagent CRUD types. `agentType` on the wire is
 * the `name` field from the agent's frontmatter (case-insensitive);
 * `level` distinguishes project-/user-/builtin-/extension-level
 * registrations. Built-in / extension agents are read-only — POST and
 * DELETE return 403 `agent_readonly`.
 */
/**
 * Storage level for a subagent definition.
 *
 * `project` / `user` / `builtin` / `extension` are the levels the
 * `qwen serve` daemon currently surfaces through `GET /workspace/agents`
 * and the per-`agentType` detail route.
 *
 * `session` is reserved for forward-compat: the `SubagentManager` core
 * tracks session-scoped agents in a separate cache populated only at
 * runtime, and the daemon's CRUD routes do not return them today. SDK
 * consumers writing exhaustive switches over `DaemonAgentLevel` should
 * therefore include a `'session'` arm but treat it as unreachable on
 * the current route surface — its presence on the type avoids a
 * breaking SDK change when a future PR exposes session agents.
 */
export type DaemonAgentLevel =
  | 'project'
  | 'user'
  | 'builtin'
  | 'extension'
  | 'session';

export interface DaemonWorkspaceAgentSummary {
  kind: 'agent';
  name: string;
  description: string;
  level: DaemonAgentLevel;
  isBuiltin: boolean;
  hasTools: boolean;
  model?: string;
  color?: string;
  background?: boolean;
  approvalMode?: string;
  extensionName?: string;
  filePath?: string;
}

export interface DaemonWorkspaceAgentDetail
  extends DaemonWorkspaceAgentSummary {
  systemPrompt: string;
  tools?: string[];
  disallowedTools?: string[];
  runConfig?: { max_time_minutes?: number; max_turns?: number };
}

export interface DaemonWorkspaceAgentsStatus {
  v: 1;
  workspaceCwd: string;
  agents: DaemonWorkspaceAgentSummary[];
  errors?: DaemonStatusCell[];
}

/**
 * Body of `POST /workspace/agents`. The daemon translates `scope` into
 * the corresponding `SubagentLevel` (`workspace`→`project`,
 * `global`→`user`).
 */
export interface DaemonCreateAgentRequest {
  name: string;
  description: string;
  systemPrompt: string;
  scope: 'workspace' | 'global';
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  runConfig?: { max_time_minutes?: number; max_turns?: number };
  color?: string;
  approvalMode?: string;
  background?: boolean;
}

/**
 * Body of `POST /workspace/agents/:agentType`. `name` / `level` /
 * `filePath` / `isBuiltin` are intentionally omitted — agent type
 * comes from the URL, level is determined by the existing record, and
 * the other two are server-managed.
 */
export interface DaemonUpdateAgentRequest {
  description?: string;
  systemPrompt?: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  runConfig?: { max_time_minutes?: number; max_turns?: number };
  color?: string;
  approvalMode?: string;
  background?: boolean;
}

export interface DaemonAgentMutationResult {
  ok: true;
  agent: DaemonWorkspaceAgentDetail;
}

export interface DaemonSessionContextStatus {
  v: 1;
  sessionId: string;
  workspaceCwd: string;
  state: DaemonSessionState;
}

export interface DaemonAvailableCommand {
  name: string;
  description?: string;
  input: { hint: string } | null;
  _meta?: Record<string, unknown> | null;
}

export interface DaemonSessionSupportedCommandsStatus {
  v: 1;
  sessionId: string;
  availableCommands: DaemonAvailableCommand[];
  availableSkills: string[];
}

/** Returned from `POST /session/:id/model`. ACP currently allows an opaque body. */
export interface SetModelResult {
  [key: string]: unknown;
}

/**
 * Returned from `POST /session/:id/heartbeat`. `lastSeenAt` is the
 * server-side `Date.now()` epoch (ms) the daemon stored for this
 * session. `clientId` is echoed back only when the caller supplied a
 * trusted one through `X-Qwen-Client-Id`. Older daemons (pre-PR 9) do
 * not expose this route — clients should pre-flight
 * `caps.features.client_heartbeat` before sending.
 */
export interface HeartbeatResult {
  sessionId: string;
  clientId?: string;
  lastSeenAt: number;
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
