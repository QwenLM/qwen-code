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
 * signals breaking wire changes (per the design doc).
 */

export type DaemonMode = 'http-bridge' | 'native';

export interface DaemonProtocolVersions {
  current: string;
  supported: string[];
}

export interface DaemonCapabilitiesLimits {
  maxPendingPromptsPerSession?: number | null;
}

/** Capabilities envelope returned from `GET /capabilities`. */
export interface DaemonCapabilities {
  v: 1;
  /**
   * Serve protocol versions supported by the daemon. Optional because this is
   * additive to v=1; older v=1 daemons omit it.
   */
  protocolVersions?: DaemonProtocolVersions;
  /**
   * Qwen Code CLI/SDK version served by this daemon. Optional because this is
   * additive to v=1; older v=1 daemons omit it.
   */
  qwenCodeVersion?: string;
  mode: DaemonMode;
  /**
   * Feature tags the client should gate UI off (e.g. `permission_vote`,
   * `session_events`). Never gate UI off `mode`.
   */
  features: string[];
  /**
   * Numeric daemon limits. `null` means the daemon advertises the limit as
   * disabled; absence means an older daemon did not advertise it.
   */
  limits?: DaemonCapabilitiesLimits;
  modelServices: string[];
  /**
   * Transport protocols the daemon advertises. Clients use this to
   * negotiate the preferred transport (e.g. `['rest-sse', 'acp-ws',
   * 'acp-http']`). Optional because older v=1 daemons predate
   * transport negotiation — absence implies `['rest-sse']` only.
   */
  transports?: readonly string[];
  /**
   * Absolute canonical workspace path this daemon is bound to
   * (1 daemon = 1 workspace). Clients use this to
   * (a) detect mismatch before posting `/session` (vs. waiting for
   * a 400 `workspace_mismatch` response), and (b) omit `cwd` on
   * `POST /session` — the route falls back to this path when the
   * body has no `cwd` field. Multi-workspace deployments expose
   * multiple daemons on different ports, each advertising its own
   * `workspaceCwd`.
   *
   * Optional at the type level because the field is an additive
   * extension to v=1 envelopes. Daemons
   * predating this feature still announce `v: 1` but omit this field; the
   * protocol's "bump v only on incompatible frame changes" stance
   * (see `qwen-serve-protocol.md`) makes additive optionality the
   * correct shape. All newer daemons populate it.
   *
   * **SDK consumers**: if you need the value as a non-undefined
   * `string` (e.g. to call `.startsWith()` or pass into a function
   * typed `string`), use the `requireWorkspaceCwd` helper from this
   * module — it throws `DaemonCapabilityMissingError` with an
   * actionable "this daemon predates workspaceCwd support" message instead of
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
 * built with workspaceCwd support) and return it as a non-undefined `string`. Throws
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
        ? 'daemon returned an empty workspaceCwd (newer daemon with a bug)'
        : 'daemon predates workspaceCwd support (1 daemon = 1 workspace); upgrade it',
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
  /** Compacted events for completed turns (load only). */
  compactedReplay?: DaemonEvent[];
  /** Raw events since last turn boundary — current incomplete turn (load only). */
  liveJournal?: DaemonEvent[];
  /** Event bus watermark — used as initial SSE cursor. */
  lastEventId?: number;
}

export interface BranchSessionRequest {
  name?: string;
}

export interface DaemonBranchedSession extends DaemonRestoredSession {
  displayName: string;
  forkedFrom: { sessionId: string; displayName: string };
}

export interface ForkSessionRequest {
  directive: string;
}

export interface DaemonForkSessionResult {
  sessionId: string;
  description: string;
  launched: boolean;
}

/** Sparse session record returned by `GET /workspace/:id/sessions`. */
export interface DaemonSessionSummary {
  sessionId: string;
  workspaceCwd: string;
  createdAt?: string;
  updatedAt?: string;
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
  // Budget refusal under `--mcp-budget-mode=enforce`.
  'budget_exhausted',
  // Runtime MCP mutation routes (POST/DELETE /workspace/mcp/servers).
  'mcp_budget_would_exceed',
  'mcp_server_spawn_failed',
  'invalid_config',
  // A prompt exceeded the daemon-configured wallclock cap (or the
  // request's own `deadlineMs`, capped at the server flag).
  'prompt_deadline_exceeded',
  // An SSE writer's last successful flush was older than the daemon's
  // writer-idle deadline.
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
  hasOAuthTokens?: boolean;
  source?: 'user' | 'project' | 'extension';
  config?: {
    command?: string;
    args?: string[];
    httpUrl?: string;
    url?: string;
    cwd?: string;
  };
  description?: string;
  extensionName?: string;
  /**
   * Why this server is not live, when known.
   * `'config'`  -- operator-disabled via `disabledMcpServers`.
   * `'budget'`  -- refused by the workspace MCP client budget
   *               (snapshot also surfaces `errorKind:
   *               'budget_exhausted'`).
   * Absent on older daemons.
   */
  disabledReason?: 'config' | 'budget';
}

/** Budget enforcement mode for MCP client guardrails. */
export type DaemonMcpBudgetMode = 'enforce' | 'warn' | 'off';

/**
 * MCP client budget status cell. Currently emits one entry with
 * `scope: 'session'` (per-session enforcement; see the `scope` field
 * doc for why). A future shared pool may add `scope: 'workspace'`.
 * Consumers MUST tolerate unrecognized scope
 * values — drop, don't fail.
 */
export interface DaemonMcpBudgetStatusCell extends DaemonStatusCell {
  kind: 'mcp_budget';
  /**
   * **Currently emits `'session'`** -- the budget caps live MCP
   * clients per ACP session, not per-workspace. Each session has its
   * own `McpClientManager` (created via `acpAgent.newSessionConfig`).
   * A future shared MCP pool may introduce a workspace-scoped manager
   * and emit `'workspace'` (or `'pool'`) cells.
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
  /** Live MCP client count, all transports. Absent on older daemons. */
  clientCount?: number;
  /** Configured budget. Absent when no cap set. */
  clientBudget?: number;
  /** Active enforcement mode. Absent on older daemons. */
  budgetMode?: DaemonMcpBudgetMode;
  /**
   * Workspace-level budget cells. Empty array (not absent) on newer
   * daemons when no budget is configured AND mode resolves to `off`.
   * Older daemons omit the field.
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
  baseUrl?: string;
  fastModelId?: string;
}

export interface DaemonWorkspaceProviderModel {
  modelId: string;
  baseModelId: string;
  name: string;
  description?: string | null;
  contextLimit?: number;
  modalities?: {
    image?: boolean;
    pdf?: boolean;
    audio?: boolean;
    video?: boolean;
  };
  baseUrl?: string;
  envKey?: string;
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
 * Workspace memory snapshot returned from
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
 * Subagent CRUD types. `agentType` on the wire is
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

export interface DaemonGeneratedAgentContent {
  name: string;
  description: string;
  systemPrompt: string;
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
   * short-circuit); create responses currently omit it
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
  | 'env_var'
  | 'memory';

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

export interface DaemonContextCategoryBreakdown {
  systemPrompt: number;
  builtinTools: number;
  mcpTools: number;
  memoryFiles: number;
  skills: number;
  messages: number;
  freeSpace: number;
  autocompactBuffer: number;
}

export interface DaemonContextToolDetail {
  name: string;
  tokens: number;
}

export interface DaemonContextMemoryDetail {
  path: string;
  tokens: number;
}

export interface DaemonContextSkillDetail {
  name: string;
  tokens: number;
  loaded?: boolean;
  bodyTokens?: number;
}

export interface DaemonSessionContextUsage {
  modelName: string;
  totalTokens: number;
  contextWindowSize: number;
  breakdown: DaemonContextCategoryBreakdown;
  builtinTools: DaemonContextToolDetail[];
  mcpTools: DaemonContextToolDetail[];
  memoryFiles: DaemonContextMemoryDetail[];
  skills: DaemonContextSkillDetail[];
  isEstimated?: boolean;
  showDetails?: boolean;
}

export interface DaemonSessionContextUsageStatus {
  v: 1;
  sessionId: string;
  workspaceCwd: string;
  usage: DaemonSessionContextUsage;
  formattedText: string;
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
  stats?: { totalTokens: number; toolUses: number; durationMs: number };
  recentActivities?: Array<{ name: string; description: string; at: number }>;
  prompt?: string;
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

export interface DaemonSessionStatsModelMetrics {
  api: {
    totalRequests: number;
    totalErrors: number;
    totalLatencyMs: number;
  };
  tokens: {
    prompt: number;
    candidates: number;
    total: number;
    cached: number;
    thoughts: number;
  };
}

export interface DaemonSessionStatsToolByName {
  count: number;
  success: number;
  fail: number;
  durationMs: number;
  decisions: {
    accept: number;
    reject: number;
    modify: number;
    auto_accept: number;
  };
}

/** Returned from `GET /session/:id/stats`. */
export interface DaemonSessionStatsStatus {
  v: 1;
  sessionId: string;
  workspaceCwd: string;
  sessionStartTimeMs: number;
  durationMs: number;
  promptCount: number;
  models: Record<string, DaemonSessionStatsModelMetrics>;
  tools: {
    totalCalls: number;
    totalSuccess: number;
    totalFail: number;
    totalDurationMs: number;
    byName: Record<string, DaemonSessionStatsToolByName>;
  };
  files: {
    totalLinesAdded: number;
    totalLinesRemoved: number;
  };
}

/** Returned from `POST /session/:id/model`. ACP currently allows an opaque body. */
export interface SetModelResult {
  [key: string]: unknown;
}

/** Returned from `POST /session/:id/language`. */
export interface SetSessionLanguageResult {
  language: string;
  outputLanguage: string | null;
  refreshed: boolean;
}

/**
 * Closed enumeration of session approval modes the
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
 * Result body of `POST /workspace/tools/:name/
 * enable`. The `enabled` flag echoes the requested state; daemon
 * always succeeds when the bridge has a `persistDisabledTools` hook
 * (production wires it). Already-registered tools in active sessions
 * are not retroactively unregistered — see `tool_toggled` event docs.
 */
export interface DaemonToolToggleResult {
  toolName: string;
  enabled: boolean;
}

export interface DaemonSettingDescriptor {
  key: string;
  type: string;
  label: string;
  category: string;
  description?: string;
  requiresRestart: boolean;
  default: unknown;
  options?: ReadonlyArray<{ value: string | number; label: string }>;
  values: {
    effective: unknown;
    user?: unknown;
    workspace?: unknown;
  };
}

export interface DaemonWorkspaceSettingsStatus {
  v: 1;
  warnings?: Array<{
    type: 'corrupted';
    recovered: boolean;
  }>;
  settings: DaemonSettingDescriptor[];
}

export interface DaemonSettingUpdateResult {
  key: string;
  scope: 'workspace';
  value: unknown;
  requiresRestart: boolean;
}

/**
 * Result body of `POST /workspace/init`.
 *
 * - `'created'`: the target file did not exist; daemon scaffolded an
 *   empty file fresh.
 * - `'overwrote'`: the target file had non-whitespace content and the
 *   caller passed `force: true`; daemon truncated to empty.
 * - `'noop'`: the target file already existed but contained only
 *   whitespace, so the daemon left it alone (no write, no on-disk
 *   change). Honors the "init only if absent" intent without
 *   requiring `force: true`.
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
 * Returned from `POST /session/:id/recap`. The recap
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

export interface DaemonSessionBtwResult {
  sessionId: string;
  answer: string | null;
}

/**
 * Result body of `POST /session/:id/mid-turn-message`. `accepted` is `true`
 * when the message was queued for the running turn (the ACP child drains it
 * between tool batches); `false` when the session was idle, in which case the
 * caller should send the message as a normal next-turn prompt instead.
 */
export interface DaemonMidTurnMessageResult {
  accepted: boolean;
}

export interface DaemonShellCommandResult {
  exitCode: number | null;
  output: string;
  aborted: boolean;
}

/**
 * Result body of `POST /workspace/mcp/:server/
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
export interface DaemonReloadResponse {
  env: { updatedKeys: string[]; removedKeys: string[] };
  changedKeys: string[];
  childReloaded: boolean;
  sessionsRefreshed?: string[];
  sessionsSkipped?: string[];
  childError?: string;
}

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
    }
  | {
      serverName: string;
      entries: Array<{
        entryIndex: number;
        restarted: boolean;
        durationMs?: number;
        reason?: string;
      }>;
    };

export type DaemonMcpManageAction =
  | 'enable'
  | 'disable'
  | 'authenticate'
  | 'clear-auth';

export interface DaemonMcpManageResult {
  serverName: string;
  action: DaemonMcpManageAction;
  ok: true;
  changed?: boolean;
  messages?: string[];
  authUrl?: string;
}

/**
 * Structural subset of core's `MCPServerConfig` exposed
 * on the `POST /workspace/mcp/servers` route body. Covers all wire-
 * relevant transport fields without pulling in core-only concerns
 * (e.g. `includeTools` / `excludeTools` filtering, `extensionName`).
 *
 * All fields are optional — the daemon infers transport family from
 * whichever set of fields is populated (stdio: `command`; SSE: `url`;
 * HTTP: `httpUrl`; WebSocket: `tcp`; SDK: `type: 'sdk'`).
 */
export interface MCPServerConfigShape {
  readonly type?: 'stdio' | 'sse' | 'http' | 'websocket' | 'sdk';
  readonly command?: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
  readonly cwd?: string;
  readonly url?: string;
  readonly httpUrl?: string;
  readonly headers?: Record<string, string>;
  readonly tcp?: string;
  readonly timeout?: number;
  readonly discoveryTimeoutMs?: number;
  readonly trust?: boolean;
  readonly description?: string;
  readonly oauth?: Record<string, unknown>;
}

/**
 * Body of `POST /workspace/mcp/servers` — adds (or
 * replaces) a runtime MCP server.
 */
export interface DaemonRuntimeMcpAddRequest {
  readonly name: string;
  readonly config: MCPServerConfigShape;
  readonly displayName?: string;
}

/**
 * Response of `POST /workspace/mcp/servers`.
 * Discriminated union: `.skipped` is absent (or `never`) on the
 * success branch and `true` on the soft-refuse branch. Callers
 * narrow with `if ('skipped' in res && res.skipped)`.
 */
export type DaemonRuntimeMcpAddResult =
  | {
      readonly name: string;
      readonly transport: DaemonMcpTransport;
      readonly replaced: boolean;
      readonly shadowedSettings: boolean;
      readonly toolCount: number;
      readonly originatorClientId: string;
      readonly skipped?: never;
    }
  | {
      readonly name: string;
      readonly skipped: true;
      readonly reason: 'budget_warning_only';
    };

/**
 * Response of `DELETE /workspace/mcp/servers/:name`.
 * Discriminated union: `.skipped` absent on success, `true` on
 * soft-refuse (server was not present — idempotent skip).
 */
export type DaemonRuntimeMcpRemoveResult =
  | {
      readonly name: string;
      readonly removed: true;
      readonly wasShadowingSettings: boolean;
      readonly originatorClientId: string;
      readonly skipped?: never;
    }
  | {
      readonly name: string;
      readonly skipped: true;
      readonly reason: 'not_present';
    };

/**
 * Returned from `POST /session/:id/heartbeat`. `lastSeenAt` is the
 * server-side `Date.now()` epoch (ms) the daemon stored for this
 * session. `clientId` is echoed back only when the caller supplied a
 * trusted one through `X-Qwen-Client-Id`. Older daemons do
 * not expose this route — clients should pre-flight
 * `caps.features.client_heartbeat` before sending.
 */
export interface HeartbeatResult {
  sessionId: string;
  clientId?: string;
  lastSeenAt: number;
}

/** Auth device-flow wire types. */

export type DaemonAuthProviderId = 'qwen-oauth' | (string & {});

// Sdk-prefixed aliases single-source the canonical definitions from
// `./events.js` so a single source of truth governs both layers
// (event payloads + REST wire shapes). TypeScript handles the
// circular type-only import cleanly because there is no runtime
// dependency direction. Local `type X = ...` aliases (rather than a
// re-export) make the symbols usable INSIDE this module too -- required
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

export interface DaemonAuthProviderModel {
  id: string;
  contextWindowSize?: number;
  enableThinking?: boolean;
  modalities?: {
    image?: boolean;
    pdf?: boolean;
    audio?: boolean;
    video?: boolean;
  };
  description?: string;
}

export interface DaemonAuthProviderBaseUrlOption {
  id: string;
  label: string;
  url: string;
  documentationUrl?: string;
  apiKeyUrl?: string;
}

export interface DaemonAuthProviderDescriptor {
  id: string;
  label: string;
  description: string;
  uiGroup?: string;
  protocol: string;
  protocolOptions?: string[];
  baseUrl?: string | DaemonAuthProviderBaseUrlOption[];
  envKey?: string;
  models?: DaemonAuthProviderModel[];
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

export interface DaemonAuthProviderCatalog {
  v: 1;
  workspaceCwd: string;
  providers: DaemonAuthProviderDescriptor[];
  groups: Array<{
    id: 'alibaba' | 'third-party' | 'custom';
    label: string;
    description: string;
    providerIds: string[];
  }>;
}

export interface DaemonAuthProviderInstallRequest {
  providerId: string;
  protocol?: string;
  baseUrl?: string;
  apiKey: string;
  modelIds?: string[];
  advancedConfig?: {
    enableThinking?: boolean;
    multimodal?: {
      image?: boolean;
      pdf?: boolean;
      audio?: boolean;
      video?: boolean;
    };
    contextWindowSize?: number;
    maxTokens?: number;
  };
}

export interface DaemonAuthProviderInstallResult {
  v: 1;
  providerId: string;
  providerLabel: string;
  authType: string;
  modelId?: string;
  baseUrl?: string;
  message: string;
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
  /** Envelope metadata, including daemon-emitted timestamps when available. */
  _meta?: Record<string, unknown>;
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

export interface DaemonRewindSnapshotInfo {
  promptId: string;
  turnIndex: number;
  timestamp: string;
  diffStats: { filesChanged: number; insertions: number; deletions: number };
}

export interface DaemonRewindResult {
  rewound: boolean;
  targetTurnIndex: number;
  filesChanged: string[];
  filesFailed: string[];
}

// ---------------------------------------------------------------------------
// Issue #4514 T3.9: workspace + session hooks diagnostic surfaces.
// ---------------------------------------------------------------------------

/**
 * Widened event-name union for hook events. Core's `HookEventName` is a
 * closed enum; the `(string & {})` arm keeps SDK consumers forward-compat
 * when the daemon returns a new event name not yet in the SDK's enum.
 */
export type DaemonHookEventName =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch'
  | 'Notification'
  | 'UserPromptSubmit'
  | 'UserPromptExpansion'
  | 'SessionStart'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'SessionEnd'
  | 'PermissionRequest'
  | 'PermissionDenied'
  | 'StopFailure'
  | 'TodoCreated'
  | 'TodoCompleted'
  | 'InstructionsLoaded'
  | (string & {});

export type DaemonHookMatcherKind =
  | 'toolName'
  | 'agentType'
  | 'trigger'
  | 'sessionTrigger'
  | 'error'
  | 'notificationType'
  | 'commandName'
  | 'filePath';

export interface DaemonHookEventMeta {
  description: string;
  matcherKind?: DaemonHookMatcherKind;
}

export interface DaemonCommandHookConfig {
  type: 'command';
  command: string;
  name?: string;
  description?: string;
  timeout?: number;
  env?: Record<string, string>;
  async?: boolean;
  shell?: 'bash' | 'powershell';
  statusMessage?: string;
}

export interface DaemonHttpHookConfig {
  type: 'http';
  url: string;
  name?: string;
  description?: string;
  timeout?: number;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  if?: string;
  statusMessage?: string;
  once?: boolean;
}

export interface DaemonFunctionHookConfig {
  type: 'function';
  id?: string;
  name?: string;
  description?: string;
  timeout?: number;
  errorMessage?: string;
  statusMessage?: string;
}

export interface DaemonPromptHookConfig {
  type: 'prompt';
  prompt: string;
  name?: string;
  description?: string;
  timeout?: number;
  model?: string;
  statusMessage?: string;
}

export interface DaemonUnknownHookConfig {
  type: string;
  name?: string;
  description?: string;
  timeout?: number;
  statusMessage?: string;
}

export type DaemonHookConfig =
  | DaemonCommandHookConfig
  | DaemonHttpHookConfig
  | DaemonFunctionHookConfig
  | DaemonPromptHookConfig
  | DaemonUnknownHookConfig;

export type DaemonHookSource =
  | 'project'
  | 'user'
  | 'system'
  | 'extensions'
  | 'session';

export interface DaemonHookEntry {
  kind: 'hook';
  eventName: DaemonHookEventName;
  config: DaemonHookConfig;
  source: DaemonHookSource;
  matcher?: string;
  sequential?: boolean;
  enabled: boolean;
  hookId?: string;
  skillRoot?: string;
}

export interface DaemonWorkspaceHooksStatus {
  v: 1;
  workspaceCwd: string;
  initialized: boolean;
  disabled: boolean;
  hooks: DaemonHookEntry[];
  events: Record<string, DaemonHookEventMeta>;
  errors?: DaemonStatusCell[];
}

export interface DaemonSessionHooksStatus {
  v: 1;
  sessionId: string;
  workspaceCwd: string;
  disabled: boolean;
  hooks: DaemonHookEntry[];
  errors?: DaemonStatusCell[];
}

// ---------------------------------------------------------------------------
// Workspace extensions diagnostic surface.
// ---------------------------------------------------------------------------

export type DaemonExtensionInstallType =
  | 'git'
  | 'local'
  | 'link'
  | 'github-release'
  | 'npm';

export type DaemonExtensionOriginSource = 'QwenCode' | 'Claude' | 'Gemini';

export interface DaemonExtensionCapabilities {
  mcpServerCount: number;
  skillCount: number;
  agentCount: number;
  hookCount: number;
  commandCount: number;
  contextFileCount: number;
  channelCount: number;
  hasSettings: boolean;
}

export type DaemonExtensionUpdateState =
  | 'checking for updates'
  | 'updated, needs restart'
  | 'updating'
  | 'updated'
  | 'update available'
  | 'up to date'
  | 'error'
  | 'not updatable'
  | 'unknown';

export interface DaemonExtensionDetails {
  mcpServers: string[];
  commands: string[];
  skills: string[];
  agents: string[];
  contextFiles: string[];
  settings: string[];
}

export interface DaemonExtensionEntry {
  kind: 'extension';
  id: string;
  name: string;
  displayName?: string;
  version: string;
  isActive: boolean;
  path: string;
  source?: string;
  installType?: DaemonExtensionInstallType;
  originSource?: DaemonExtensionOriginSource;
  ref?: string;
  autoUpdate?: boolean;
  updateState?: DaemonExtensionUpdateState;
  capabilities: DaemonExtensionCapabilities;
  details?: DaemonExtensionDetails;
}

export interface DaemonWorkspaceExtensionsStatus {
  v: 1;
  workspaceCwd: string;
  initialized: boolean;
  extensions: DaemonExtensionEntry[];
  errors?: DaemonStatusCell[];
}

export interface ExtensionInstallRequest {
  source: string;
  ref?: string;
  autoUpdate?: boolean;
  allowPreRelease?: boolean;
  registry?: string;
  consent?: boolean;
}

export interface ExtensionInstallResponse {
  accepted: true;
}

export type ExtensionMutationResponse = ExtensionInstallResponse;

export type ExtensionScope = 'user' | 'workspace';

export interface ExtensionScopeRequest {
  scope: ExtensionScope;
}

export interface ExtensionUpdateCheckResponse {
  states: Record<string, DaemonExtensionUpdateState>;
}

export interface ExtensionRefreshResponse {
  refreshed: number;
  failed: number;
}
