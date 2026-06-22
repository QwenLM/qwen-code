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
  DaemonSessionBtwResult,
  DaemonMidTurnMessageResult,
  DaemonSessionContextStatus,
  DaemonSessionContextUsageStatus,
  DaemonSessionRecapResult,
  DaemonSessionSummary,
  DaemonSessionSupportedCommandsStatus,
  DaemonSessionTaskStatus,
  DaemonSessionTasksStatus,
  DaemonSessionStatsStatus,
  DaemonShellCommandResult,
  DaemonTranscriptBlock,
  DaemonTranscriptStore,
  DaemonWorkspaceProvidersStatus,
  HeartbeatResult,
  PermissionResponse,
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

export interface DaemonConnectionState {
  status: DaemonConnectionStatus;
  sessionId?: string;
  /**
   * Daemon-confirmed client identity bound to this session (the value sent as
   * `X-Qwen-Client-Id`). Consumers use it to recognize their OWN
   * originator-stamped frames — e.g. the web-shell dedupes a
   * `mid_turn_message_injected` batch only when its `originatorClientId`
   * matches this id (a peer on the same session must keep its own entry).
   */
  clientId?: string;
  workspaceCwd?: string;
  commands?: DaemonCommandInfo[];
  skills?: string[];
  models?: DaemonModelInfo[];
  currentModel?: string;
  currentMode?: string;
  displayName?: string;
  /** Latest main-conversation model usage event. */
  tokenUsage?: DaemonTokenUsage;
  /** Current context-window occupancy, used with contextWindow for percentages. */
  tokenCount?: number;
  contextWindow?: number;
  providers?: DaemonWorkspaceProvidersStatus;
  supportedCommands?: DaemonSessionSupportedCommandsStatus;
  context?: DaemonSessionContextStatus;
  capabilities?: DaemonCapabilities;
  /** True while replaying buffered events after a reconnect. */
  catchingUp?: boolean;
  error?: string;
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
  /** Session id to load on mount instead of creating or attaching automatically. */
  initialSessionId?: string;
  /** Stable client identity to reuse for session-scoped daemon requests. */
  clientId?: string;
  /** Extra create-session options, excluding workspaceCwd which is owned by the provider. */
  createSessionRequest?: Omit<CreateSessionRequest, 'workspaceCwd'>;
  /** Maximum queued SSE events requested from the daemon per subscription. */
  maxQueued?: number;
  /** Maximum normalized transcript blocks retained in memory. */
  maxBlocks?: number;
  /** Hide this client's own user prompt echo when the daemon replays events. */
  suppressOwnUserEcho?: boolean;
  /** Attach raw daemon events to normalized transcript blocks for debugging. */
  includeRawEvent?: boolean;
  /** Connect to the daemon automatically on mount. */
  autoConnect?: boolean;
  /** Reconnect automatically after recoverable daemon/session failures. */
  autoReconnect?: boolean;
  /** Behavior when the active session is missing (404/410). Defaults to create. */
  missingSessionBehavior?: 'create' | 'disconnect';
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
  | 'set_approval_mode'
  | 'submit_permission'
  | 'cancel_prompt'
  | 'load_session'
  | 'resume_session'
  | 'close_session'
  | 'rename_session'
  | 'release_session'
  | 'list_sessions'
  | 'load_context'
  | 'load_context_usage'
  | 'load_tasks'
  | 'cancel_task'
  | 'clear_goal'
  | 'load_stats'
  | 'refresh_commands'
  | 'recap_session'
  | 'btw_session'
  | 'branch_session'
  | 'fork_session'
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
  /**
   * When true, the daemon strips orphaned user entries from the chat
   * history before re-sending, and skips recording a duplicate user
   * message in the JSONL transcript. Used by Ctrl+Y retry.
   */
  retry?: boolean;
}

export interface DaemonPromptImage {
  data: string;
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
}

export interface DaemonTodoList {
  blockId: string;
  toolCallId: string;
  title: string;
  status: string;
  items: DaemonTodoItem[];
  raw: Extract<DaemonTranscriptBlock, { kind: 'tool' }>;
}

export interface DaemonSessionActions {
  sendPrompt(text: string, options?: SendPromptOptions): Promise<PromptResult>;
  cancel(): Promise<void>;
  setModel(modelId: string): Promise<SetModelResult>;
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
  listSessions(): Promise<DaemonSessionSummary[]>;
  loadSession(sessionId: string): Promise<void>;
  resumeSession(sessionId: string): Promise<void>;
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
  btwSession(
    question: string,
    opts?: { signal?: AbortSignal },
  ): Promise<DaemonSessionBtwResult>;
  /**
   * Best-effort: queue a message typed while a turn is running so the daemon
   * can drain it mid-turn. Resolves `{ accepted: false }` (never throws/raises
   * a notice) when there is no session, the session is idle, or the push
   * fails — the caller then keeps the message in its own next-turn queue.
   */
  enqueueMidTurnMessage(
    message: string,
    opts?: { signal?: AbortSignal },
  ): Promise<DaemonMidTurnMessageResult>;
  sendShellCommand(command: string): Promise<DaemonShellCommandResult>;
  getTasks(): Promise<DaemonSessionTasksStatus>;
  cancelTask(
    taskId: string,
    kind: DaemonSessionTaskStatus['kind'],
  ): Promise<{ cancelled: boolean }>;
  clearGoal(): Promise<{ cleared: boolean; condition?: string }>;
  getStats(): Promise<DaemonSessionStatsStatus>;
  branchSession(
    name?: string,
  ): Promise<{ sessionId: string; displayName: string }>;
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
  mcpVersion: number;
  extensionsVersion: number;
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
  mode: 'load' | 'resume';
  timeout: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: unknown) => void;
}
