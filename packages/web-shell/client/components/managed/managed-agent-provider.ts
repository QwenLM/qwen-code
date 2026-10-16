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

export type ManagedApprovalMode = 'default' | 'auto-edit' | 'yolo';

export function isManagedApprovalMode(
  value: unknown,
): value is ManagedApprovalMode {
  return value === 'default' || value === 'auto-edit' || value === 'yolo';
}

export interface ManagedSessionOptions {
  approvalMode: ManagedApprovalMode;
  availableApprovalModes: ManagedApprovalMode[];
}

export interface ManagedModelContext {
  modelId: string;
  inputTokens?: number;
  contextWindowSize?: number;
  observedAt: number;
}

export interface ManagedModelSelection {
  modelId?: string;
  revision: number;
}

export interface ManagedSessionModels {
  models: { modelId: string; label: string }[];
  modelSelection: ManagedModelSelection;
  supported: boolean;
}

export interface ManagedModelChangeResult {
  sessionId: string;
  modelSelection: ManagedModelSelection;
  replayed: boolean;
}

export interface ManagedAgentSessionSummary {
  sessionId: string;
  agentId?: string;
  approvalMode?: ManagedApprovalMode;
  modelContext?: ManagedModelContext;
  modelSelection?: ManagedModelSelection;
  activeTurnId?: string;
  title: string;
  workspaceCwd?: string;
  workspace?: {
    workspaceId: string;
    cwdRelative: string;
    contextRevision?: number;
    state?: 'ready' | 'changing' | 'recovery_blocked';
  };
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
    tasks?: boolean;
    artifacts?: boolean;
    /** The caller may submit later Turns to this Workspace-bound Session. */
    workspaceTurns?: boolean;
    cwdChange?: boolean;
    modelChange?: boolean;
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
  | 'context_changed'
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

export type ManagedCwdOperation = components['schemas']['WebShellCwdOperation'];
export type ManagedTask = components['schemas']['WebShellTask'];
export type ManagedTaskPage = components['schemas']['WebShellTaskPage'];
export type ManagedTaskEvent = components['schemas']['WebShellTaskEvent'];
export type ManagedTaskEventPage =
  components['schemas']['WebShellTaskEventPage'];
export type ManagedTaskCancelOperation =
  components['schemas']['WebShellCommandOperation'] & { type: 'task_cancel' };

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
  readonly tasks?: {
    list(
      sessionId: string,
      options: ManagedAgentRequestOptions & { cursor?: string; limit?: number },
    ): Promise<ManagedTaskPage>;
    get(
      sessionId: string,
      taskId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedTask>;
    listEvents(
      sessionId: string,
      taskId: string,
      options: ManagedAgentRequestOptions & { after?: string; limit?: number },
    ): Promise<ManagedTaskEventPage>;
    readonly cancel?: {
      submit(
        sessionId: string,
        taskId: string,
        options: ManagedAgentCommandOptions,
      ): Promise<ManagedTaskCancelOperation>;
      query(
        sessionId: string,
        taskId: string,
        operationId: string,
        options: ManagedAgentRequestOptions,
      ): Promise<ManagedTaskCancelOperation>;
    };
  };
  readonly cwdChange?: {
    submit(
      sessionId: string,
      request: { cwdRelative: string; expectedContextRevision: number },
      options: ManagedAgentCommandOptions,
    ): Promise<ManagedCwdOperation>;
    query(
      sessionId: string,
      operationId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedCwdOperation>;
  };
  readonly modelChange?: {
    queryOptions(
      sessionId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedSessionModels>;
    submit(
      sessionId: string,
      request: { modelId: string; expectedRevision: number },
      options: ManagedAgentCommandOptions,
    ): Promise<ManagedModelChangeResult>;
  };
  readonly workspaceBinding?: {
    readonly agentId: string;
    /** Host-published model-specific AgentDefinitions available for new Sessions. */
    readonly modelPresets?: readonly { agentId: string; label: string }[];
    list(
      options: ManagedAgentRequestOptions & { cursor?: string; limit?: number },
    ): Promise<{
      data: ManagedAgentWorkspace[];
      defaultWorkspace?: ManagedAgentWorkspace | null;
      nextCursor?: string;
      supported: boolean;
      canCreateWorkspace?: boolean;
      supportsApprovalModeSelection?: boolean;
    }>;
    get(
      workspaceId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedAgentWorkspace>;
    createWorkspace?(
      request: { displayName: string },
      options: ManagedAgentCommandOptions,
    ): Promise<ManagedAgentWorkspace>;
    getSessionOptions?(
      agentId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedSessionOptions>;
    createEmpty(
      request: {
        agentId: string;
        workspaceId: string;
        cwdRelative: string;
        approvalMode?: ManagedApprovalMode;
      },
      options: ManagedAgentCommandOptions,
    ): Promise<{ sessionId: string }>;
    createSession?(
      request: {
        agentId: string;
        workspaceId: string;
        cwdRelative: string;
        text: string;
        approvalMode?: ManagedApprovalMode;
      },
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
      /**
       * Called for each complete heartbeat or comment frame the stream
       * delivers. Heartbeats never decode into events, so on an idle
       * Session this is the only sign of life an established stream gives.
       */
      onAlive?(): void;
    },
  ): AsyncIterable<ManagedAgentSessionEvent>;
}

export interface ManagedAgentWorkspace {
  workspaceId: string;
  displayName: string;
  state: string;
  canCreateSession: boolean;
}
