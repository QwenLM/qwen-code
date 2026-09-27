export type ManagedAgentSessionPhase =
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
  createdAt: number;
  admittedAt: number;
  updatedAt: number;
  phase: ManagedAgentSessionPhase;
  runtimeReady: boolean;
  runtimeState: ManagedAgentRuntimeState;
  capabilities: { canSend: boolean; canCancel: boolean };
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
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'
  | 'stream_gap';

export interface ManagedAgentSessionEvent {
  id: number;
  at: number;
  type: ManagedAgentSessionEventType;
  sessionId: string;
  turnId: string;
  data?: unknown;
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

export interface ManagedAgentProvider {
  readonly kind: 'daemon' | 'java';
  readonly storageKey: string;
  readonly canCancel: boolean;
  readonly acceptsWorkspaceCwd: boolean;
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
    options: ManagedAgentRequestOptions & { lastEventId?: number },
  ): AsyncIterable<ManagedAgentSessionEvent>;
}
