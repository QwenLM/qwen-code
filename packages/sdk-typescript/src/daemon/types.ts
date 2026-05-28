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
  updatedAt?: string;
  title?: string;
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

/**
 * Closed taxonomy of structured error categories surfaced on diagnostic
 * status cells (workspace preflight, env, MCP guardrails). SDK consumers
 * can switch on a known set rather than parsing free-form messages.
 */
export const DAEMON_ERROR_KINDS = [
  'missing_binary',
  'blocked_egress',
  'auth_env_error',
  'init_timeout',
  'protocol_error',
  'missing_file',
  'parse_error',
  // Issue #4175 PR 14: budget refusal under `--mcp-budget-mode=enforce`.
  // Mirrors the serve-side `SERVE_ERROR_KINDS` addition.
  'budget_exhausted',
  // Issue #4514 T2.9: a prompt exceeded the daemon-configured wallclock
  // cap (or the request's own `deadlineMs`, capped at the server flag).
  // Surfaced on the `POST /session/:id/prompt` 504 response. Mirrors
  // the serve-side `SERVE_ERROR_KINDS` addition.
  'prompt_deadline_exceeded',
  // Issue #4514 T2.9: an SSE writer's last successful flush was older
  // than the daemon's writer-idle deadline. Daemon emits a terminal
  // `client_evicted` frame with `reason: 'writer_idle_timeout'`; the
  // kind appears on that frame's `errorKind` field. Mirrors the
  // serve-side `SERVE_ERROR_KINDS` addition.
  'writer_idle_timeout',
] as const;

export type DaemonErrorKind = (typeof DAEMON_ERROR_KINDS)[number];

export interface DaemonStatusCell {
  kind: string;
  status: DaemonStatus;
  error?: string;
  errorKind?: DaemonErrorKind;
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
  /**
   * Why this server is not live, when known (issue #4175 PR 14).
   * `'config'`  — operator-disabled via `disabledMcpServers`.
   * `'budget'`  — refused by the workspace MCP client budget
   *               (snapshot also surfaces `errorKind:
   *               'budget_exhausted'`).
   * Absent on pre-PR-14 daemons.
   */
  disabledReason?: 'config' | 'budget';
}

/** Budget enforcement mode for MCP client guardrails (issue #4175 PR 14). */
export type DaemonMcpBudgetMode = 'enforce' | 'warn' | 'off';

/**
 * MCP client budget status cell. Issue #4175 PR 14 v1 emits one
 * entry with `scope: 'session'` (per-session enforcement; see the
 * `scope` field doc for why). Wave 5 PR 23 shared pool will add
 * `scope: 'workspace'`. Consumers MUST tolerate unrecognized scope
 * values — drop, don't fail.
 */
export interface DaemonMcpBudgetStatusCell extends DaemonStatusCell {
  kind: 'mcp_budget';
  /**
   * **PR 14 v1 emits `'session'`** — the budget caps live MCP
   * clients per ACP session, not per-workspace. Each session has its
   * own `McpClientManager` (created via `acpAgent.newSessionConfig`).
   * Wave 5 PR 23 (shared MCP pool) will introduce a workspace-scoped
   * manager and emit `'workspace'` (or `'pool'`) cells.
   *
   * The `string & {}` widening keeps IDE autocomplete + literal
   * narrowing for known scopes while allowing unknown scopes through
   * — the protocol contract is "consumers MUST tolerate additional
   * scope values, drop don't fail." See `qwen-serve-protocol.md`.
   */
  scope: 'session' | 'workspace' | (string & {});
  liveCount: number;
  /** Configured cap. Absent when mode is `off`. */
  budget?: number;
  mode: DaemonMcpBudgetMode;
  refusedCount: number;
}

export interface DaemonWorkspaceMcpStatus {
  v: 1;
  workspaceCwd: string;
  initialized: boolean;
  discoveryState?: DaemonMcpDiscoveryState;
  servers: DaemonWorkspaceMcpServerStatus[];
  errors?: DaemonStatusCell[];
  /** PR 14: live MCP client count, all transports. Absent on pre-PR-14 daemons. */
  clientCount?: number;
  /** PR 14: configured budget. Absent when no cap set. */
  clientBudget?: number;
  /** PR 14: active enforcement mode. Absent on pre-PR-14 daemons. */
  budgetMode?: DaemonMcpBudgetMode;
  /**
   * PR 14: workspace-level budget cells. Empty array (not absent)
   * on post-PR-14 daemons when no budget is configured AND mode
   * resolves to `off`. Pre-PR-14 daemons omit the field.
   */
  budgets?: DaemonMcpBudgetStatusCell[];
}

export interface DaemonWorkspaceMcpToolStatus {
  name: string;
  serverToolName?: string;
  description?: string;
  schema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  isValid: boolean;
  invalidReason?: string;
}

export interface DaemonWorkspaceMcpToolsStatus {
  v: 1;
  workspaceCwd: string;
  serverName: string;
  initialized: boolean;
  acpChannelLive: boolean;
  tools: DaemonWorkspaceMcpToolStatus[];
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
  /**
   * Bytes actually written by THIS request. `0` when the daemon
   * short-circuited the write (`changed: false`) — e.g. whitespace-
   * only append. NOT the on-disk file size; callers needing that
   * should issue a `GET /workspace/memory` for the file's current
   * `bytes`.
   */
  bytesWritten: number;
  mode: 'append' | 'replace';
  /**
   * `true` when the daemon actually mutated the file on disk. `false`
   * for whitespace-only `append` requests that short-circuited
   * upstream — the route accepted the request as well-formed (200
   * OK) but the helper detected the trimmed content was empty and
   * skipped the write to avoid an mtime bump + a misleading
   * `memory_changed` event. SDK consumers can branch on this to
   * suppress redundant cache invalidation. Optional at the type
   * level for forward-compat with daemons that predate the field —
   * those return undefined and callers should treat that as
   * `changed: true` (the legacy contract).
   */
  changed?: boolean;
}

export type DaemonContentHash = `sha256:${string}`;

const DAEMON_CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

export function isDaemonContentHash(
  value: unknown,
): value is DaemonContentHash {
  return typeof value === 'string' && DAEMON_CONTENT_HASH_RE.test(value);
}

export interface DaemonWorkspaceFile {
  kind: 'file';
  path: string;
  content: string;
  encoding: string;
  bom: boolean;
  lineEnding: 'crlf' | 'lf';
  sizeBytes: number;
  returnedBytes: number;
  truncated: boolean;
  hash?: DaemonContentHash;
  matchedIgnore: 'file' | 'directory' | null;
  originalLineCount: number | null;
}

export interface DaemonWorkspaceFileBytes {
  kind: 'file_bytes';
  path: string;
  offset: number;
  sizeBytes: number;
  returnedBytes: number;
  truncated: boolean;
  contentBase64: string;
  hash?: DaemonContentHash;
}

interface DaemonWorkspaceFileWriteRequestBase {
  path: string;
  content: string;
  bom?: boolean;
  encoding?: string;
  lineEnding?: 'crlf' | 'lf';
}

export type DaemonWorkspaceFileWriteRequest =
  | (DaemonWorkspaceFileWriteRequestBase & {
      mode: 'create';
      expectedHash?: DaemonContentHash;
    })
  | (DaemonWorkspaceFileWriteRequestBase & {
      mode: 'replace';
      expectedHash: DaemonContentHash;
    });

export interface DaemonWorkspaceFileEditRequest {
  path: string;
  oldText: string;
  newText: string;
  expectedHash: DaemonContentHash;
}

export interface DaemonWorkspaceFileWriteResult {
  kind: 'file_write';
  path: string;
  mode: 'create' | 'replace';
  created: boolean;
  sizeBytes: number;
  hash: DaemonContentHash;
  encoding: string;
  bom: boolean;
  lineEnding: 'crlf' | 'lf';
  matchedIgnore: 'file' | 'directory' | null;
}

export interface DaemonWorkspaceFileEditResult {
  kind: 'file_edit';
  path: string;
  replacements: 1;
  sizeBytes: number;
  hash: DaemonContentHash;
  encoding: string;
  bom: boolean;
  lineEnding: 'crlf' | 'lf';
  matchedIgnore: 'file' | 'directory' | null;
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
 * `project` / `user` / `builtin` are the levels the `qwen serve`
 * daemon currently surfaces through `GET /workspace/agents` and the
 * per-`agentType` detail route.
 *
 * `extension` and `session` are present on the union for forward-
 * compat but the daemon does NOT return them today — the daemon-
 * scoped `SubagentManager` is constructed against a stub `Config`
 * whose `getActiveExtensions()` returns `[]` (extension plumbing has
 * no entry point through the workspace daemon yet) and session-level
 * subagents live in a runtime-only cache no CRUD route reads. SDK
 * consumers writing exhaustive switches over `DaemonAgentLevel`
 * should therefore include arms for both values but treat them as
 * unreachable on today's route surface — having them on the type
 * avoids a breaking SDK change when a future PR exposes either
 * source.
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
  /**
   * `true` when the daemon actually rewrote the agent definition;
   * `false` when the request was a no-op (every supplied field
   * already matched the existing record). The update route emits
   * the field on every response (introduced alongside the no-op
   * short-circuit in PR 16); create responses currently omit it
   * because every successful create is a write — typed consumers
   * should treat `undefined` as `true` (the legacy contract). This
   * mirrors `DaemonWriteMemoryResult.changed`. Optional at the type
   * level for forward-compat with daemons that predate the field.
   */
  changed?: boolean;
}

export type DaemonEnvKind =
  | 'runtime'
  | 'platform'
  | 'sandbox'
  | 'proxy'
  | 'env_var';

export interface DaemonEnvCell extends DaemonStatusCell {
  kind: DaemonEnvKind;
  name: string;
  present?: boolean;
  /** Non-sensitive value; ALWAYS omitted for kind='env_var'. */
  value?: string;
}

export interface DaemonWorkspaceEnvStatus {
  v: 1;
  workspaceCwd: string;
  initialized: true;
  acpChannelLive: boolean;
  cells: DaemonEnvCell[];
  errors?: DaemonStatusCell[];
}

export type DaemonPreflightKind =
  | 'node_version'
  | 'cli_entry'
  | 'workspace_dir'
  | 'ripgrep'
  | 'git'
  | 'npm'
  | 'auth'
  | 'mcp_discovery'
  | 'skills'
  | 'providers'
  | 'tool_registry'
  | 'egress';

export interface DaemonPreflightCell extends DaemonStatusCell {
  kind: DaemonPreflightKind;
  locality: 'daemon' | 'acp';
  detail?: Record<string, unknown>;
}

export interface DaemonWorkspacePreflightStatus {
  v: 1;
  workspaceCwd: string;
  initialized: true;
  acpChannelLive: boolean;
  cells: DaemonPreflightCell[];
  errors?: DaemonStatusCell[];
}

export interface DaemonWorkspaceToolStatus {
  name: string;
  displayName?: string;
  description?: string;
  enabled: boolean;
}

export interface DaemonWorkspaceToolsStatus {
  v: 1;
  workspaceCwd: string;
  initialized: true;
  acpChannelLive: boolean;
  tools: DaemonWorkspaceToolStatus[];
  errors?: DaemonStatusCell[];
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

export type DaemonSessionTaskLifecycleStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type DaemonSessionProcessTaskLifecycleStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface DaemonSessionAgentTaskStatus {
  kind: 'agent';
  id: string;
  label: string;
  description: string;
  status: DaemonSessionTaskLifecycleStatus;
  startTime: number;
  endTime?: number;
  runtimeMs: number;
  outputFile?: string;
  subagentType?: string;
  isBackgrounded: boolean;
  error?: string;
  resumeBlockedReason?: string;
}

export interface DaemonSessionShellTaskStatus {
  kind: 'shell';
  id: string;
  label: string;
  description: string;
  status: DaemonSessionProcessTaskLifecycleStatus;
  startTime: number;
  endTime?: number;
  runtimeMs: number;
  outputFile?: string;
  command: string;
  cwd: string;
  pid?: number;
  exitCode?: number;
  error?: string;
}

export interface DaemonSessionMonitorTaskStatus {
  kind: 'monitor';
  id: string;
  label: string;
  description: string;
  status: DaemonSessionProcessTaskLifecycleStatus;
  startTime: number;
  endTime?: number;
  runtimeMs: number;
  command: string;
  pid?: number;
  eventCount: number;
  lastEventTime: number;
  droppedLines: number;
  exitCode?: number;
  error?: string;
  ownerAgentId?: string;
}

export type DaemonSessionTaskStatus =
  | DaemonSessionAgentTaskStatus
  | DaemonSessionShellTaskStatus
  | DaemonSessionMonitorTaskStatus;

export interface DaemonSessionTasksStatus {
  v: 1;
  sessionId: string;
  now: number;
  tasks: DaemonSessionTaskStatus[];
}

/** Returned from `POST /session/:id/model`. ACP currently allows an opaque body. */
export interface SetModelResult {
  [key: string]: unknown;
}

/**
 * #4175 Wave 4 PR 17. Closed enumeration of session approval modes the
 * daemon exposes via `POST /session/:id/approval-mode`. Mirrors core's
 * `ApprovalMode` enum — the drift detector test in
 * `packages/cli/src/acp-integration/approvalMode.test.ts` walks the
 * core enum and fails CI if any value is missing here.
 *
 * Order matters for diagnostic UIs that render the modes in the
 * advertised sequence.
 */
export const DAEMON_APPROVAL_MODES = [
  'plan',
  'default',
  'auto-edit',
  'auto',
  'yolo',
] as const;
export type DaemonApprovalMode = (typeof DAEMON_APPROVAL_MODES)[number];

/**
 * Result body of `POST /session/:id/approval-mode`. `previous` and
 * `mode` are typed as `string` (rather than `DaemonApprovalMode`) so
 * older SDK builds against a hypothetical future fifth mode literal
 * still parse — branch on the values you handle and treat the rest as
 * opaque. `persisted: true` indicates the change was also written to
 * `tools.approvalMode` in workspace settings (set via the route's
 * optional `persist: true` body flag).
 */
export interface DaemonApprovalModeResult {
  sessionId: string;
  mode: string;
  previous: string;
  persisted: boolean;
}

/**
 * #4175 Wave 4 PR 17. Result body of `POST /workspace/tools/:name/
 * enable`. The `enabled` flag echoes the requested state; daemon
 * always succeeds when the bridge has a `persistDisabledTools` hook
 * (production wires it). Already-registered tools in active sessions
 * are not retroactively unregistered — see `tool_toggled` event docs.
 */
export interface DaemonToolToggleResult {
  toolName: string;
  enabled: boolean;
}

/**
 * #4175 Wave 4 PR 17. Result body of `POST /workspace/init`.
 *
 * - `'created'`: the target file did not exist; daemon scaffolded an
 *   empty file fresh.
 * - `'overwrote'`: the target file had non-whitespace content and the
 *   caller passed `force: true`; daemon truncated to empty.
 * - `'noop'`: the target file already existed but contained only
 *   whitespace, so the daemon left it alone (no write, no on-disk
 *   change). Honors the "init only if absent" intent without
 *   requiring `force: true` (#4282 fold-in 1, wenshao H4).
 *
 * Note: `path` is the absolute path on the daemon host filesystem —
 * not the client's. Per the runtime-locality contract, file ops
 * resolve in the daemon environment.
 */
export interface DaemonInitWorkspaceResult {
  path: string;
  action: 'created' | 'overwrote' | 'noop';
}

/**
 * #4175 follow-up. Returned from `POST /session/:id/recap`. The recap
 * is a one-sentence "where did I leave off" summary generated by core's
 * `generateSessionRecap` via a side-query against the fast model.
 *
 * `recap` is `null` (not absent, not an empty string) when:
 * - the session has fewer than two dialog turns yet,
 * - the side-query returns no extractable `<recap>...</recap>` payload,
 * - or any underlying model error occurred (the core helper is
 *   best-effort and never throws).
 *
 * The route returns 200 in all three cases; only hard errors (unknown
 * session, ACP transport down, bridge timeout) surface as non-2xx.
 * Pre-flight `caps.features.session_recap` before calling.
 */
export interface DaemonSessionRecapResult {
  sessionId: string;
  recap: string | null;
}

export interface DaemonShellCommandResult {
  exitCode: number | null;
  output: string;
  aborted: boolean;
}

/**
 * #4175 Wave 4 PR 17. Result body of `POST /workspace/mcp/:server/
 * restart`. Discriminated by `restarted`: `true` carries the wall-
 * clock duration of the disconnect+reconnect+rediscover sequence;
 * `false` is a soft skip with the reason. Both shapes return HTTP
 * 200 — only hard errors (server not configured, no live ACP child)
 * surface as non-2xx.
 *
 * Soft skip reasons:
 * - `'in_flight'`: another restart / discovery is already in progress
 *   for this server. Caller should wait or retry.
 * - `'disabled'`: the server is configured but in
 *   `excludedMcpServers`. Re-enable it before restart.
 * - `'budget_would_exceed'`: under `--mcp-budget-mode=enforce`, the
 *   target server is not currently in `reservedSlots` and the live
 *   total has reached `clientBudget`. Caller should free a slot
 *   (disconnect another server) before retrying.
 */
export type DaemonMcpRestartResult =
  | {
      serverName: string;
      restarted: true;
      durationMs: number;
    }
  | {
      serverName: string;
      restarted: false;
      skipped: true;
      reason: 'in_flight' | 'disabled' | 'budget_would_exceed';
    };

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

/** Issue #4175 PR 21 — auth device-flow wire types. */

export type DaemonAuthProviderId = 'qwen-oauth' | (string & {});

// PR #4255 review S4: Sdk-prefixed aliases USED to be parallel literal
// unions, which silently diverged from the canonical event-side types
// the moment one was extended. Single-source the canonical definitions
// from `./events.js` so a single source of truth governs both layers
// (event payloads + REST wire shapes). TypeScript handles the
// circular type-only import cleanly because there is no runtime
// dependency direction. Local `type X = ...` aliases (rather than a
// re-export) make the symbols usable INSIDE this module too — required
// by `DaemonDeviceFlowState` / `DaemonAuthProviderStatus` below.
import type {
  DaemonAuthDeviceFlowStatus,
  DaemonAuthDeviceFlowErrorKind,
} from './events.js';
export type DaemonAuthDeviceFlowSdkStatus = DaemonAuthDeviceFlowStatus;
export type DaemonAuthDeviceFlowSdkErrorKind = DaemonAuthDeviceFlowErrorKind;

/** Returned from `POST /workspace/auth/device-flow`. */
export interface DaemonDeviceFlowStartResult {
  deviceFlowId: string;
  providerId: DaemonAuthProviderId;
  status: DaemonAuthDeviceFlowSdkStatus;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalMs: number;
  /** True iff the daemon returned an existing pending entry rather than
   *  starting a fresh flow (per-provider singleton take-over). */
  attached: boolean;
  initiatorClientId?: string;
}

/** Returned from `GET /workspace/auth/device-flow/:id`. */
export interface DaemonDeviceFlowState {
  deviceFlowId: string;
  providerId: DaemonAuthProviderId;
  status: DaemonAuthDeviceFlowSdkStatus;
  errorKind?: DaemonAuthDeviceFlowSdkErrorKind;
  hint?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt?: number;
  intervalMs?: number;
  lastPolledAt?: number;
  createdAt: number;
  initiatorClientId?: string;
}

export interface DaemonAuthProviderStatus extends DaemonStatusCell {
  kind: 'auth_provider';
  providerId: DaemonAuthProviderId;
  expiresAt?: number;
  /** Best-effort non-PII account label. Never email/phone/username. */
  accountAlias?: string;
}

/** Returned from `GET /workspace/auth/status`. */
export interface DaemonAuthStatusSnapshot {
  v: 1;
  workspaceCwd: string;
  /** Currently registered providers and their auth status. */
  providers: DaemonAuthProviderStatus[];
  /** Pending flows; userCode/verificationUri intentionally redacted (the
   *  full record is fetched via GET /workspace/auth/device-flow/:id). */
  pendingDeviceFlows: Array<{
    deviceFlowId: string;
    providerId: DaemonAuthProviderId;
    expiresAt: number;
  }>;
  /** Provider ids the daemon advertises support for under
   *  `POST /workspace/auth/device-flow`. */
  supportedDeviceFlowProviders: DaemonAuthProviderId[];
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
