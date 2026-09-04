/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

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
  /**
   * Process start tokens for the pids above, and the PID namespace they
   * were recorded in.
   *
   * A pid number does not identify a process. Nothing reaps this store
   * while no supervisor runs, so a crash or a reboot leaves recorded pids
   * behind that the OS later recycles to unrelated processes; and a
   * shared `~/.qwen` — an NFS home, a devcontainer with the home mounted
   * — puts another machine's pids in front of a reader who would resolve
   * them in its own namespace. A reader pairs these with `isSameProcess`
   * to answer the question the live-session registry already answers for
   * its own records.
   *
   * All three are optional on purpose: this is a durable
   * `schemaVersion: 1` record, and a file written before these fields
   * existed must stay readable. A reader that finds them absent degrades
   * to a bare liveness check — the same rule `isSameProcess` applies on a
   * platform that has no start token.
   */
  hostProcStart?: string | null;
  workerProcStart?: string | null;
  pidNs?: number | null;
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

/**
 * The directory name a session id is filed under.
 *
 * This lives with the on-disk shapes rather than with the store because
 * it *is* one: it defines the identity two readers must agree on. The
 * store files a session under this name and reports it back as the
 * session's id, while the live-session registry keeps the raw spelling
 * the worker registered with — adoption deliberately keeps both, because
 * the native session store is case-sensitive. Anything that joins the two
 * sources has to canonicalize through this one function, or a mixed-case
 * session is two sessions to whichever half is comparing raw strings.
 */
export function sanitizeSessionId(sessionId: string): string {
  const safe = path
    .basename(sessionId.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/^\.+/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\x00-\x1F]/g, '_');
  return safe || '_';
}
