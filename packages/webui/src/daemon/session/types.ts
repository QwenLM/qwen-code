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
  DaemonSessionBtwResult,
  DaemonSessionContextStatus,
  DaemonSessionContextUsageStatus,
  DaemonSessionRecapResult,
  DaemonSessionSummary,
  DaemonSessionSupportedCommandsStatus,
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
  workspaceCwd?: string;
  commands?: DaemonCommandInfo[];
  skills?: string[];
  models?: DaemonModelInfo[];
  currentModel?: string;
  currentMode?: string;
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

export interface DaemonSessionProviderProps {
  /** Daemon base URL. Optional when nested inside DaemonWorkspaceProvider (inherited). */
  baseUrl?: string;
  /** Bearer token. Optional when nested inside DaemonWorkspaceProvider (inherited). */
  token?: string;
  workspaceCwd?: string;
  initialSessionId?: string;
  clientId?: string;
  createSessionRequest?: Omit<CreateSessionRequest, 'workspaceCwd'>;
  maxQueued?: number;
  maxBlocks?: number;
  suppressOwnUserEcho?: boolean;
  includeRawEvent?: boolean;
  autoConnect?: boolean;
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatFailureThreshold?: number;
  loadWarnings?: {
    models?: string;
    commands?: string;
    context?: string;
  };
  children: ReactNode;
}

export type DaemonPromptStatus = 'idle' | 'waiting' | 'streaming';

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
  sendShellCommand(command: string): Promise<DaemonShellCommandResult>;
  getTasks(): Promise<DaemonSessionTasksStatus>;
  getStats(): Promise<DaemonSessionStatsStatus>;
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
  initVersion: number;
  authVersion: number;
}

export interface ActivePrompt {
  controller: AbortController;
  promptId?: string;
  resolve?: (result: PromptResult) => void;
  reject?: (error: unknown) => void;
  pendingResult?: PromptResult;
  pendingError?: unknown;
}

export interface PendingSessionLoad {
  id: number;
  sessionId: string;
  mode: 'load' | 'resume';
  timeout: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: unknown) => void;
}
