/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react';
import type {
  CreateSessionRequest,
  DaemonCapabilities,
  DaemonApprovalMode,
  DaemonApprovalModeResult,
  DaemonAvailableCommand,
  DaemonForkSessionResult,
  DaemonInputAnnotation,
  DaemonSessionBtwResult,
  DaemonSessionGenerationEvent,
  DaemonSessionAttachmentReference,
  DaemonSessionAttachmentData,
  DaemonMidTurnMessageResult,
  DaemonMidTurnMessagesResult,
  DaemonRemoveMidTurnMessageResult,
  DaemonPendingPromptsResult,
  DaemonRemovePendingPromptResult,
  DaemonSessionContextStatus,
  DaemonSessionContextUsageStatus,
  DaemonSessionRecapResult,
  DaemonRewindResult,
  DaemonRewindSnapshotInfo,
  DaemonSession,
  DaemonSessionSummary,
  DaemonSessionSupportedCommandsStatus,
  DaemonSessionTaskWithWorkflowStatus,
  DaemonSessionTasksStatus,
  DaemonSessionWorkflowTaskStatus,
  DaemonSessionWorkflowTasksStatus,
  DaemonSessionStatsStatus,
  DaemonSessionArtifactsEnvelope,
  DaemonSkillToggleMutation,
  DaemonShellCommandResult,
  DaemonTranscriptBlock,
  DaemonTranscriptStore,
  DaemonWorkspaceGitStatus,
  DaemonWorkspaceProvidersStatus,
  HeartbeatResult,
  GoalControlRequest,
  GoalSnapshotV2,
  GoalStateResponse,
  PermissionResponse,
  PromptContentBlock,
  PromptResult,
  SessionMetadataResult,
  SetModelResult,
} from '@qwen-code/sdk/daemon';

export type DaemonConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface DaemonSessionOwnerSnapshot {
  isCurrent(): boolean;
}

export interface DaemonSessionOwnerGuard {
  capture(): DaemonSessionOwnerSnapshot;
}

export interface DaemonConnectionState {
  status: DaemonConnectionStatus;
  sessionId?: string;
  /**
   * Daemon-confirmed client identity bound to this session (the value sent as
   * `X-Qwen-Client-Id`). Consumers use it to recognize their OWN
   * originator-stamped legacy frames. Stable-id mid-turn queues are shared by
   * the session and do not use this id as an ownership boundary.
   */
  clientId?: string;
  workspaceCwd?: string;
  /** Current Git branch, short detached-HEAD hash, or undefined outside Git. */
  gitBranch?: string;
  /**
   * Last enriched working-tree summary for the current workspace, pushed by
   * the daemon via `git_status_changed` (only set when the event's
   * workspaceCwd matches this connection's workspace).
   */
  gitStatus?: DaemonWorkspaceGitStatus;
  commands?: DaemonCommandInfo[];
  skills?: string[];
  models?: DaemonModelInfo[];
  currentModel?: string;
  reasoning?: DaemonReasoningControls;
  currentMode?: string;
  displayName?: string;
  /** Latest main-conversation model usage event. */
  tokenUsage?: DaemonTokenUsage;
  /** Authoritative Goal v2 state for the current session. */
  goalState?: GoalSnapshotV2;
  /** Current context-window occupancy, used with contextWindow for percentages. */
  tokenCount?: number;
  contextWindow?: number;
  providers?: DaemonWorkspaceProvidersStatus;
  supportedCommands?: DaemonSessionSupportedCommandsStatus;
  context?: DaemonSessionContextStatus;
  capabilities?: DaemonCapabilities;
  /** True while the current session transcript is being loaded. */
  loadingTranscript?: boolean;
  /** True while replaying buffered events after a reconnect. */
  catchingUp?: boolean;
  error?: string;
  /** Latest HTTP error status kept for diagnostics; use missingSession for UI. */
  errorStatus?: number;
  /** True only when the server confirmed the current session is missing. */
  missingSession?: boolean;
}

export interface DaemonReasoningControls {
  enabled: boolean;
  effort: string;
  efforts: string[];
  /** Defaults to true. False means effort is mutable but thinking is required. */
  canDisable?: boolean;
}

export interface DaemonTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
}

export interface DaemonSessionProviderProps {
  /** Daemon base URL. Optional when nested inside DaemonWorkspaceProvider (inherited). */
  baseUrl?: string;
  /** Bearer token. Optional when nested inside DaemonWorkspaceProvider (inherited). */
  token?: string;
  /** Workspace cwd used when creating, loading, or resuming daemon sessions. */
  workspaceCwd?: string;
  /** Session id to load. Undefined keeps the page empty until a prompt creates one. */
  sessionId?: string;
  /** Stable client identity to reuse for session-scoped daemon requests. */
  clientId?: string;
  /** Extra create-session options, excluding workspaceCwd which is owned by the provider. */
  createSessionRequest?: Omit<CreateSessionRequest, 'workspaceCwd'>;
  /** Maximum queued SSE events requested from the daemon per subscription. */
  maxQueued?: number;
  /** Maximum normalized transcript blocks retained in memory. */
  maxBlocks?: number;
  /**
   * Maximum estimated bytes of transcript blocks retained in memory.
   * Trimming evicts oldest blocks until the estimate is back under this
   * budget; a block-count window alone is not a memory ceiling because
   * blocks can carry large raw tool payloads. Defaults to the transcript
   * store's built-in budget.
   */
  maxRetainedBytes?: number;
  /** Latest persisted records requested during an existing-session load. */
  historyPageSize?: number;
  /** Keep the full subagent transcript, or retain only bounded root summaries. */
  subagentTranscriptMode?: 'full' | 'summary';
  /** Hide this client's own user prompt echo when the daemon replays events. */
  suppressOwnUserEcho?: boolean;
  /** Attach raw daemon events to normalized transcript blocks for debugging. */
  includeRawEvent?: boolean;
  /** Connect to the daemon automatically on mount. */
  autoConnect?: boolean;
  /** Reconnect automatically after recoverable daemon/session failures. */
  autoReconnect?: boolean;
  /**
   * Restart a live SSE event stream after each accepted prompt. A stream that
   * is already down is always rebuilt immediately on prompt admission,
   * regardless of this flag.
   */
  restartEventStreamOnPrompt?: boolean;
  /** Initial reconnect delay in milliseconds. */
  reconnectDelayMs?: number;
  /** Maximum reconnect delay in milliseconds after backoff. */
  maxReconnectDelayMs?: number;
  /** Interval in milliseconds for client heartbeat checks. */
  heartbeatIntervalMs?: number;
  /** Consecutive heartbeat failures before marking the session disconnected. */
  heartbeatFailureThreshold?: number;
  /** Optional user-facing fallback warnings for partial session load failures. */
  loadWarnings?: {
    /** Warning shown when model/provider status cannot be loaded. */
    models?: string;
    /** Warning shown when supported command metadata cannot be loaded. */
    commands?: string;
    /** Warning shown when session context metadata cannot be loaded. */
    context?: string;
  };
  /** React children rendered inside the daemon session contexts. */
  children: ReactNode;
}

export type DaemonPromptStatus = 'idle' | 'waiting' | 'streaming';

export type DaemonNoticeSeverity = 'info' | 'warning' | 'error';

export type DaemonNoticeCategory =
  | 'validation'
  | 'user_action'
  | 'connection'
  | 'protocol'
  | 'lifecycle'
  | 'system';

export type DaemonNoticeOperation =
  | 'send_prompt'
  | 'send_shell_command'
  | 'switch_model'
  | 'set_reasoning_effort'
  | 'set_approval_mode'
  | 'submit_permission'
  | 'cancel_prompt'
  | 'attach_session'
  | 'load_session'
  | 'resume_session'
  | 'create_session'
  | 'close_session'
  | 'rename_session'
  | 'release_session'
  | 'list_sessions'
  | 'load_context'
  | 'load_context_usage'
  | 'load_tasks'
  | 'load_artifacts'
  | 'read_attachment'
  | 'remove_attachment'
  | 'cancel_task'
  | 'control_workflow'
  | 'run_saved_workflow'
  | 'load_goal'
  | 'control_goal'
  | 'clear_goal'
  | 'load_stats'
  | 'rewind_snapshots'
  | 'rewind_session'
  | 'refresh_commands'
  | 'recap_session'
  | 'generate_session_content'
  | 'btw_session'
  | 'branch_session'
  | 'fork_session'
  | 'record_session'
  | 'stream'
  | 'normalize_event';

export interface DaemonSessionNotice {
  id: string;
  severity: DaemonNoticeSeverity;
  category: DaemonNoticeCategory;
  operation?: DaemonNoticeOperation;
  code: string;
  message: string;
  debugMessage?: string;
  recoverable?: boolean;
  createdAt: number;
}

type AddDaemonSessionNoticeInput = Omit<
  DaemonSessionNotice,
  'id' | 'createdAt'
> & {
  id?: string;
  createdAt?: number;
};

export type AddDaemonSessionNotice = (
  notice: AddDaemonSessionNoticeInput,
) => DaemonSessionNotice;

export interface DaemonModelInfo {
  id: string;
  baseModelId?: string;
  label: string;
  authType?: string;
  contextWindow?: number;
  modalities?: {
    image?: boolean;
    pdf?: boolean;
    audio?: boolean;
    video?: boolean;
  };
  baseUrl?: string;
  envKey?: string;
  isRuntime?: boolean;
  reasoningPreview?: DaemonReasoningControls;
}

export interface DaemonCommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
  source?: string;
  raw: DaemonAvailableCommand;
}

export interface SendPromptOptions {
  optimisticUserMessage?: boolean;
  images?: DaemonPromptImage[];
  files?: DaemonPromptFile[];
  inputAnnotations?: DaemonInputAnnotation[];
  /**
   * When true, the daemon strips orphaned user entries from the chat
   * history before re-sending, and skips recording a duplicate user
   * message in the JSONL transcript. Used by Ctrl+Y retry.
   */
  retry?: boolean;
  /** Fired after local validation, immediately before dispatch to the daemon. */
  onAdmissionStarted?: () => void;
  /**
   * Fired once the daemon has ACCEPTED the prompt (admission), before the turn
   * runs to completion. Lets a caller act on "the prompt reached the session"
   * without waiting for the whole turn — e.g. the scheduled-tasks "run now",
   * which records the run at admission so a long/stalled turn or a closed tab
   * can't lose the record.
   */
  onAdmitted?: () => void;
}

export interface SubmitPromptOptions extends SendPromptOptions {
  sessionId?: string;
  signal?: AbortSignal;
}

export interface PendingPromptActionOptions {
  sessionId?: string;
}

export interface GetTasksActionOptions {
  silent?: boolean;
}

export interface DaemonPromptImage {
  data: string;
  mimeType?: string;
  mediaType?: string;
  media_type?: string;
}

export interface DaemonPromptFile {
  name: string;
  data?: Blob;
  text?: string;
  mimeType?: string;
  mediaType?: string;
  media_type?: string;
}

export type DaemonTodoStatus = 'pending' | 'in_progress' | 'completed';
export type DaemonTodoPriority = 'low' | 'medium' | 'high';

export interface DaemonTodoItem {
  id: string;
  content: string;
  status: DaemonTodoStatus;
  priority?: DaemonTodoPriority;
  blockedBy?: string[];
}

export interface DaemonTodoList {
  blockId: string;
  toolCallId: string;
  title: string;
  status: string;
  planId?: string;
  sourceCallId?: string;
  items: DaemonTodoItem[];
  raw: Extract<DaemonTranscriptBlock, { kind: 'tool' }>;
}

export interface SubmitPromptResult {
  promptId: string;
  removedAfterAbort?: true;
}

export interface DaemonSessionActions {
  sendPrompt(text: string, options?: SendPromptOptions): Promise<PromptResult>;
  /**
   * Non-blocking prompt submission. POSTs to the daemon and returns
   * immediately with the `promptId`. The daemon queues the prompt in its
   * FIFO if a turn is already running. Use this during streaming to
   * enqueue prompts without waiting for the current turn to complete.
   */
  submitPrompt(
    text: string,
    options?: SubmitPromptOptions,
  ): Promise<SubmitPromptResult>;
  cancel(): Promise<void>;
  setModel(modelId: string): Promise<SetModelResult>;
  setReasoningEffort(value: string): Promise<void>;
  setApprovalMode(
    mode: DaemonApprovalMode,
    opts?: { persist?: boolean },
  ): Promise<DaemonApprovalModeResult>;
  respondToPermission(
    requestId: string,
    response: PermissionResponse,
  ): Promise<boolean>;
  respondToGlobalPermission(
    requestId: string,
    response: PermissionResponse,
  ): Promise<boolean>;
  submitPermission(
    requestId: string,
    optionId?: string,
    answers?: Record<string, string>,
  ): Promise<boolean>;
  heartbeat(): Promise<HeartbeatResult | undefined>;
  listSessions(options?: {
    pageSize?: number;
  }): Promise<DaemonSessionSummary[]>;
  loadSession(
    sessionId: string,
    options?: { workspaceCwd?: string },
  ): Promise<void>;
  /** `memory` replay is reserved for the provider's live-journal repair. */
  reloadSession(
    signal: AbortSignal,
    options?: { replaySource?: 'configured' | 'memory' },
  ): Promise<void>;
  resumeSession(
    sessionId: string,
    options?: { workspaceCwd?: string },
  ): Promise<void>;
  /**
   * Create a daemon session and update local session state. Callers that need
   * transcript/event streaming must follow with `attachSession()`.
   *
   * `options.workspaceCwd` targets a specific registered workspace runtime for
   * this call only (multi-workspace daemons). Omit it to keep the provider's
   * active workspace / primary fallback.
   *
   * `options.approvalMode` seeds the session's approval mode in the create
   * request itself, so the daemon applies it atomically at spawn instead of
   * requiring a follow-up `setApprovalMode` call.
   *
   * `options.sourceType` records immutable creator attribution.
   */
  createSession(options?: {
    workspaceCwd?: string;
    approvalMode?: DaemonApprovalMode;
    sourceType?: string;
    worktree?: { slug?: string };
    branch?: { name: string };
  }): Promise<DaemonSession>;
  attachSession(): Promise<void>;
  clearSession(): Promise<void>;
  newSession(): Promise<void>;
  releaseSession(sessionId: string): Promise<void>;
  closeSession(): Promise<void>;
  refreshCommands(): Promise<void>;
  getContext(): Promise<DaemonSessionContextStatus>;
  getContextUsage(opts?: {
    detail?: boolean;
  }): Promise<DaemonSessionContextUsageStatus>;
  renameSession(displayName: string): Promise<SessionMetadataResult>;
  recapSession(): Promise<DaemonSessionRecapResult>;
  generateSessionContent(
    prompt: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<DaemonSessionGenerationEvent>;
  getRewindSnapshots(): Promise<{ snapshots: DaemonRewindSnapshotInfo[] }>;
  rewindSession(
    promptId: string,
    opts?: { rewindFiles?: boolean },
  ): Promise<DaemonRewindResult>;
  btwSession(
    question: string,
    opts?: { signal?: AbortSignal },
  ): Promise<DaemonSessionBtwResult>;
  uploadAttachment(
    attachment: DaemonPromptImage | DaemonPromptFile,
    opts?: { signal?: AbortSignal; sessionId?: string },
  ): Promise<DaemonSessionAttachmentReference>;
  readAttachment(attachmentId: string): Promise<DaemonSessionAttachmentData>;
  removeAttachment(
    attachmentId: string,
    opts?: { sessionId?: string },
  ): Promise<boolean>;
  /**
   * Queue a message typed while a turn is running. Calls without an id support
   * old daemons and are best-effort; calls with a stable `messageId` may reject
   * on an ambiguous transport failure so the caller can reconcile. `content`
   * carries attachment blocks — pre-flight the daemon's
   * `session_attachments` capability before attaching references.
   */
  enqueueMidTurnMessage(
    message: string,
    opts?: {
      signal?: AbortSignal;
      messageId?: string;
      content?: PromptContentBlock[];
      onAdmissionStarted?: () => void;
    },
  ): Promise<DaemonMidTurnMessageResult>;
  removeMidTurnMessage(
    messageId: string,
    opts?: PendingPromptActionOptions,
  ): Promise<DaemonRemoveMidTurnMessageResult>;
  /**
   * Best-effort reconciliation snapshot (queue + delivery-state rings) from the
   * daemon. Resolves `undefined` (never throws/raises a notice) when there
   * is no session or the query fails — callers preserve current state.
   * Pre-flight the
   * `session_mid_turn_message_query` capability before relying on it: older
   * daemons lack the route.
   */
  getMidTurnMessages(opts?: {
    signal?: AbortSignal;
  }): Promise<DaemonMidTurnMessagesResult | undefined>;
  getPendingPrompts(
    opts?: PendingPromptActionOptions,
  ): Promise<DaemonPendingPromptsResult>;
  removePendingPrompt(
    promptId: string,
    opts?: PendingPromptActionOptions,
  ): Promise<DaemonRemovePendingPromptResult>;
  sendShellCommand(command: string): Promise<DaemonShellCommandResult>;
  getTasks(opts?: GetTasksActionOptions): Promise<DaemonSessionTasksStatus>;
  getWorkflowTasks(
    opts?: GetTasksActionOptions,
  ): Promise<DaemonSessionWorkflowTasksStatus>;
  cancelTask(
    taskId: string,
    kind: DaemonSessionTaskWithWorkflowStatus['kind'],
  ): Promise<{ cancelled: boolean }>;
  controlWorkflowTask(
    taskId: string,
    action: 'pause' | 'resume' | 'retry' | 'rerun' | 'delete-history',
  ): Promise<{
    changed: boolean;
    status?: DaemonSessionWorkflowTaskStatus['status'];
    taskId?: string;
  }>;
  runSavedWorkflow(name: string): Promise<{
    started: boolean;
    status?: DaemonSessionWorkflowTaskStatus['status'];
    taskId?: string;
  }>;
  getGoal(): Promise<GoalStateResponse>;
  controlGoal(request: GoalControlRequest): Promise<GoalStateResponse>;
  /**
   * Install a Goal snapshot obtained outside the session action layer — a
   * workspace-scoped control against the session this connection is attached
   * to — reconciled like any other snapshot. A no-op once the connection has
   * moved to another session.
   */
  applyGoalSnapshot(sessionId: string, snapshot: GoalSnapshotV2): void;
  clearGoal(): Promise<{ cleared: boolean; condition?: string }>;
  getStats(): Promise<DaemonSessionStatsStatus>;
  loadArtifacts(): Promise<DaemonSessionArtifactsEnvelope>;
  branchSession(
    name?: string,
    atRecordId?: string,
  ): Promise<{
    sessionId: string;
    displayName: string;
    switchStarted: boolean;
  }>;
  forkSession(directive: string): Promise<DaemonForkSessionResult>;
}

export interface DaemonSessionContextValue {
  store: DaemonTranscriptStore;
  connection: DaemonConnectionState;
  promptStatus: DaemonPromptStatus;
  actions: DaemonSessionActions;
}

export interface DaemonWorkspaceEventSignals {
  memoryVersion: number;
  agentsVersion: number;
  toolsVersion: number;
  settingsVersion: number;
  skillsVersion: number;
  lastSkillMutation?: DaemonSkillToggleMutation;
  skillMutationsByCwd?: Record<string, DaemonSkillToggleMutation[]>;
  mcpVersion: number;
  extensionsVersion: number;
  artifactsVersion: number;
  lastExtensionChange?: {
    status?:
      | 'installed'
      | 'enabled'
      | 'disabled'
      | 'updated'
      | 'uninstalled'
      | 'failed';
    source?: string;
    name?: string;
    version?: string;
    error?: string;
    refreshed: number;
    failed: number;
  };
  initVersion: number;
  authVersion: number;
}

export interface ActivePrompt {
  controller: AbortController;
  promptId?: string;
  resolve?: (result: PromptResult) => void;
  reject?: (error: unknown) => void;
}

export type SettledPrompt =
  | { status: 'resolved'; result: PromptResult }
  | { status: 'rejected'; error: unknown };

export interface PendingSessionLoad {
  id: number;
  sessionId: string;
  mode: 'load' | 'resume' | 'attach';
  timeout?: ReturnType<typeof setTimeout>;
  /** SDK timeout for load/resume; `0` disables its timer. */
  requestTimeoutMs?: number;
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  replaySource?: 'configured' | 'memory';
}
