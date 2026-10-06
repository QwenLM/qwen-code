import type { components } from './generated/managed-agent-api';
import type { ManagedToolResultReader } from './managed-tool-result-types';

export type ManagedAgentSessionPhase =
  | 'created'
  | 'admitted'
  | 'runtime_starting'
  | 'agent_running'
  | 'waiting_runtime'
  | 'tool_running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ManagedAgentRuntimeState =
  | 'unknown'
  | 'starting'
  | 'ready'
  | 'failed';

export interface ManagedAgentSessionSummary {
  sessionId: string;
  activeTurnId?: string;
  title: string;
  workspaceCwd?: string;
  workspace?: { workspaceId: string; cwdRelative: string };
  createdAt: number;
  admittedAt: number;
  updatedAt: number;
  phase: ManagedAgentSessionPhase;
  runtimeReady: boolean;
  runtimeState: ManagedAgentRuntimeState;
  capabilities: {
    canSend: boolean;
    canCancel: boolean;
    actions?: boolean;
    artifacts?: boolean;
    /** The caller may submit later Turns to this Workspace-bound Session. */
    workspaceTurns?: boolean;
  };
  failure?: { code: string; message: string };
}

export type ManagedAgentSessionEventType =
  | 'accepted'
  | 'runtime_starting'
  | 'runtime_ready'
  | 'runtime_failed'
  | 'runtime_released'
  | 'agent_started'
  | 'assistant_thought'
  | 'assistant_delta'
  | 'tool_requested'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_result_updated'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'action_updated'
  | 'stream_gap';

export interface ManagedAgentSessionEvent {
  id: number;
  at: number;
  type: ManagedAgentSessionEventType;
  sessionId: string;
  turnId: string;
  data?: unknown;
  /**
   * Projected from a durable snapshot item rather than a raw event. The
   * server can retract its items (reconciliation), after which these
   * projections must not survive a resync.
   */
  assembledFromItem?: boolean;
}

export interface ManagedAgentSessionTranscript {
  events: ManagedAgentSessionEvent[];
  olderCursor?: string;
  lastEventId: number;
}

export interface ManagedAgentTurnAdmission {
  sessionId: string;
  turnId: string;
}

export interface ManagedAgentRequestOptions {
  clientId: string;
  signal?: AbortSignal;
}

export interface ManagedAgentCommandOptions extends ManagedAgentRequestOptions {
  idempotencyKey: string;
}

/** A Hosted tool approval waiting for the Session owner's answer. */
export interface ManagedAgentPendingAction {
  actionId: string;
  sessionId: string;
  /** Public Turn ID; absent when the Turn could not be resolved. */
  turnId?: string;
  functionCallId: string;
  toolName: string;
  inputRevision: number;
  policyRevision: string;
  expiresAt: number;
  options: Array<{ id: string; label: string }>;
  inputPreview?: components['schemas']['WebShellActionInputPreview'];
}

export interface ManagedAgentProvider {
  readonly kind: 'daemon' | 'java';
  readonly storageKey: string;
  readonly canCancel: boolean;
  readonly acceptsWorkspaceCwd: boolean;
  /** Present when the provider can serve Hosted permission Actions. */
  readonly actions?: {
    listPending(
      sessionId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedAgentPendingAction[]>;
    respond(
      action: ManagedAgentPendingAction,
      optionId: string,
      options: ManagedAgentCommandOptions,
    ): Promise<void>;
  };
  readonly toolResults?: ManagedToolResultReader;
  readonly workspaceBinding?: {
    readonly agentId: string;
    list(
      options: ManagedAgentRequestOptions & { cursor?: string; limit?: number },
    ): Promise<{
      data: ManagedAgentWorkspace[];
      defaultWorkspace?: ManagedAgentWorkspace | null;
      nextCursor?: string;
      supported: boolean;
    }>;
    get(
      workspaceId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedAgentWorkspace>;
    createEmpty(
      request: { agentId: string; workspaceId: string; cwdRelative: string },
      options: ManagedAgentCommandOptions,
    ): Promise<{ sessionId: string }>;
  };
  listSessions(
    options: ManagedAgentRequestOptions & {
      workspaceCwd?: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<{
    sessions: ManagedAgentSessionSummary[];
    nextCursor?: string;
  }>;
  getSession(
    sessionId: string,
    options: ManagedAgentRequestOptions,
  ): Promise<ManagedAgentSessionSummary>;
  getTranscript(
    sessionId: string,
    options: ManagedAgentRequestOptions & {
      before?: string;
      limit?: number;
    },
  ): Promise<ManagedAgentSessionTranscript>;
  createSession(
    request: { text: string; workspaceCwd?: string },
    options: ManagedAgentCommandOptions,
  ): Promise<ManagedAgentTurnAdmission>;
  submitPrompt(
    sessionId: string,
    request: { text: string },
    options: ManagedAgentCommandOptions,
  ): Promise<ManagedAgentTurnAdmission>;
  cancel(
    sessionId: string,
    turnId: string,
    options: ManagedAgentCommandOptions,
  ): Promise<void>;
  subscribeEvents(
    sessionId: string,
    options: ManagedAgentRequestOptions & {
      lastEventId?: number;
      /**
       * Called once the stream connection has been (re-)established. An
       * established stream can stay silent indefinitely — heartbeats are
       * not events — so this is the only liveness signal that does not
       * depend on stream activity.
       */
      onEstablished?(): void;
    },
  ): AsyncIterable<ManagedAgentSessionEvent>;
}

export interface ManagedAgentWorkspace {
  workspaceId: string;
  displayName: string;
  state: string;
  canCreateSession: boolean;
}
