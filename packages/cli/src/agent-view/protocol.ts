/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const AGENT_VIEW_PROTOCOL_VERSION = 1;

export type AgentViewOwnership =
  | 'unmanaged'
  | 'adopting'
  | 'managed'
  | 'removing';

export type AgentViewSessionState =
  | 'starting'
  | 'working'
  | 'needs_input'
  | 'idle'
  | 'completed'
  | 'stopped'
  | 'failed';

export type AgentViewProcessState =
  | 'starting'
  | 'alive'
  | 'hibernating'
  | 'hibernated'
  | 'restarting'
  | 'exited';

export type AgentViewAttachState = 'detached' | 'attaching' | 'attached';

export interface AgentViewLastError {
  code: string;
  message: string;
  at: string;
}

export type AgentViewInputKind = 'blocking' | 'soft';

export interface AgentViewWorktreeState {
  mode: 'none' | 'worktree' | 'shared-unisolated';
  path?: string;
  owner?: 'agent-view' | 'user';
  dirtySnapshot?: 'copied' | 'blocked' | 'not-needed';
  warning?: string;
}

export interface AgentViewSessionStateFile {
  [key: string]: unknown;
  schemaVersion: 1;
  sessionId: string;
  ownership: AgentViewOwnership;
  sessionState: AgentViewSessionState;
  processState: AgentViewProcessState;
  attachState: AgentViewAttachState;
  projectCwd: string;
  originalCwd: string;
  activeCwd: string;
  createdAt: string;
  updatedAt: string;
  lastError?: AgentViewLastError;
  worktree: AgentViewWorktreeState;
}

export interface AgentViewLaunchFile {
  [key: string]: unknown;
  schemaVersion: 1;
  sessionId: string;
  /**
   * The spelling-preserving id passed to --resume. The store canonicalizes
   * sessionIds for directory naming, but the native session store keeps the
   * original spelling; resuming with a rewritten id fails on
   * case-sensitive filesystems.
   */
  resumeSessionId?: string;
  argv: string[];
  env: Record<string, string>;
  entrypoint: string;
  projectCwd: string;
  activeCwd: string;
  model?: string;
  approvalMode?: string;
  sandbox?: string;
  settingsDigest?: string;
  mcpDigest?: string;
  includeDirectories: string[];
  initialPrompt?: string;
  terminal: {
    columns: number;
    rows: number;
  };
}

export interface AgentViewActivityFile {
  [key: string]: unknown;
  schemaVersion: 1;
  summary?: string;
  waitingFor?: string;
  inputKind?: AgentViewInputKind;
  lastResult?: string;
  queuedPromptCount?: number;
  queuedPromptPreview?: string;
  queuedPromptId?: string;
  queuedPromptText?: string;
  queuedPromptDeliveredAt?: string;
  lastQueuedPromptAt?: string;
  lastActivityAt: string;
  capabilities: string[];
}

export interface AgentViewWorkerFile {
  [key: string]: unknown;
  schemaVersion: 1;
  hostPid?: number;
  workerPid?: number;
  endpoint?: string;
  hostEndpoint?: string;
  hostAuthToken?: string;
  hostId?: string;
  tokenDigest?: string;
  lastHeartbeatAt?: string;
  protocolVersion: number;
  platform: NodeJS.Platform;
  recentOutputBytes: number;
}

export interface AgentViewRosterEntry {
  [key: string]: unknown;
  sessionId: string;
  projectCwd: string;
  activeCwd: string;
  displayName?: string;
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentViewRosterFile {
  [key: string]: unknown;
  schemaVersion: 1;
  updatedAt: string;
  sessions: AgentViewRosterEntry[];
}

export interface AgentViewSupervisorFile {
  [key: string]: unknown;
  schemaVersion: 1;
  pid: number;
  socketPath: string;
  authToken?: string;
  startedAt: string;
  updatedAt: string;
  protocolVersion: number;
}

export interface AgentViewSessionSnapshot {
  sessionId: string;
  state: AgentViewSessionStateFile;
  launch?: AgentViewLaunchFile;
  activity?: AgentViewActivityFile;
  worker?: AgentViewWorkerFile;
  rosterEntry?: AgentViewRosterEntry;
}

export type AgentViewWorkerEvent =
  | {
      type: 'ready';
      sessionId: string;
      cwd: string;
      capabilities?: string[];
      summary?: string;
      at?: string;
    }
  | {
      type: 'heartbeat';
      sessionId: string;
      at?: string;
    }
  | {
      type: 'detach';
      sessionId: string;
      at?: string;
    }
  | {
      type: 'state';
      sessionId: string;
      sessionState: AgentViewSessionState;
      cwd?: string;
      summary?: string;
      waitingFor?: string;
      inputKind?: AgentViewInputKind;
      lastResult?: string;
      promptId?: string;
      at?: string;
    };

export type AgentViewWorkerControlEvent =
  | {
      type: 'redraw';
      sequence: number;
      at: string;
    }
  | {
      type: 'prompt';
      sequence: number;
      promptId: string;
      text: string;
      at: string;
    }
  | {
      type: 'answer';
      sequence: number;
      at: string;
      text?: string;
      callId?: string;
      outcome?: AgentViewWorkerAnswerOutcome;
      payload?: Record<string, unknown>;
    }
  | {
      type: 'stop';
      sequence: number;
      at: string;
    };

export type AgentViewWorkerAnswerOutcome =
  | 'proceed_once'
  | 'proceed_always'
  | 'proceed_always_project'
  | 'proceed_always_user'
  | 'modify_with_editor'
  | 'restore_previous'
  | 'cancel';
