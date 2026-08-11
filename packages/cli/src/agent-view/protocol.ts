/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentMessage,
  AgentSessionEvents,
  ApprovalMode,
  ToolConfirmationPayload,
  ToolResultDisplay,
} from '@qwen-code/qwen-code-core';

export const AGENT_VIEW_PROTOCOL_VERSION = 2;
export const QWEN_FLEET_WORKER_TOKEN_ENV = 'QWEN_FLEET_WORKER_TOKEN';
export const QWEN_FLEET_WORKER_SPEC_PATH_ENV = 'QWEN_FLEET_WORKER_SPEC_PATH';
export const QWEN_FLEET_SUPERVISOR_SOCKET_ENV = 'QWEN_FLEET_SUPERVISOR_SOCKET';

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
  lastResult?: string;
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
  activity?: AgentViewActivityFile;
  worker?: AgentViewWorkerFile;
  rosterEntry?: AgentViewRosterEntry;
  viewSnapshot?: AgentViewWorkerViewSnapshot;
}

export interface AgentViewDispatchParams {
  sessionId: string;
  specPath: string;
  projectCwd: string;
  activeCwd: string;
  displayName?: string;
}

export interface AgentViewDispatchResult {
  sessionId: string;
}

export type AgentViewSerializableSessionEvent = {
  [Event in keyof AgentSessionEvents]: {
    event: Event;
    payload: AgentSessionEvents[Event];
  };
}[keyof AgentSessionEvents];

export interface AgentViewWorkerViewSnapshot {
  messages: AgentMessage[];
  pendingApprovals: Array<
    [string, AgentSessionEvents['approvalRequest']['details']]
  >;
  liveOutputs: Array<[string, ToolResultDisplay]>;
  shellPids: Array<[string, number]>;
  executionStartTimes: Array<[string, number]>;
  workingDir: string;
  modelId: string;
  lastPromptTokenCount?: number;
  lastRoundError?: string;
  approvalMode?: ApprovalMode;
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
      lastResult?: string;
      /**
       * Why the session reached a failed/stopped state. Set by the supervisor
       * when it observes a worker exit, so the leader can report the exit code
       * and captured output instead of a bare "did not become ready".
       */
      lastError?: AgentViewLastError;
      at?: string;
    }
  | ({
      type: 'sessionEvent';
      sessionId: string;
      at?: string;
    } & AgentViewSerializableSessionEvent)
  | {
      type: 'viewSnapshot';
      sessionId: string;
      snapshot: AgentViewWorkerViewSnapshot;
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
      turnId: string;
      text: string;
      at: string;
    }
  | {
      type: 'cancel';
      sequence: number;
      at: string;
    }
  | {
      type: 'stop';
      sequence: number;
      at: string;
    }
  | {
      type: 'answer';
      sequence: number;
      at: string;
      callId: string;
      outcome: AgentViewWorkerAnswerOutcome;
      payload?: AgentViewWorkerAnswerPayload;
    };

export type AgentViewWorkerAnswerOutcome =
  | 'proceed_once'
  | 'proceed_once_and_switch_to_default'
  | 'proceed_always'
  | 'proceed_always_server'
  | 'proceed_always_tool'
  | 'proceed_always_project'
  | 'proceed_always_user'
  | 'modify_with_editor'
  | 'restore_previous'
  | 'cancel';

export type AgentViewWorkerAnswerPayload = ToolConfirmationPayload;

export interface AgentViewWorkerControlRequest {
  sessionId: string;
  token?: string;
  afterSequence?: number;
  acknowledgeThrough?: number;
}

export interface AgentViewWorkerControlResult {
  sessionId: string;
  events: AgentViewWorkerControlEvent[];
  nextSequence: number;
}
