import type {
  DaemonClient,
  DaemonManagedSessionEvent,
  DaemonManagedSessionSummary,
} from '@qwen-code/sdk/daemon';

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

export function createDaemonManagedAgentProvider(
  client: DaemonClient,
  baseUrl: string,
): ManagedAgentProvider {
  return {
    kind: 'daemon',
    storageKey: baseUrl,
    canCancel: true,
    acceptsWorkspaceCwd: true,
    async listSessions(options) {
      const page = await client.listManagedSessions({
        clientId: options.clientId,
        cwd: options.workspaceCwd,
        limit: options.limit,
        cursor: options.cursor,
        signal: options.signal,
      });
      return {
        sessions: page.sessions.map(toSessionSummary),
        nextCursor: page.nextCursor,
      };
    },
    async getSession(sessionId, options) {
      return toSessionSummary(
        await client.getManagedSession(sessionId, options),
      );
    },
    async getTranscript(sessionId, options) {
      const transcript = await client.getManagedSessionTranscript(sessionId, {
        ...options,
        before: options.before,
        limit: options.limit,
      });
      return {
        events: transcript.events.map(toSessionEvent),
        olderCursor: transcript.olderCursor,
        lastEventId: transcript.lastEventId,
      };
    },
    async createSession(request, options) {
      const result = await client.createManagedSession(
        {
          prompt: [{ type: 'text', text: request.text }],
          cwd: request.workspaceCwd,
        },
        options,
      );
      return { sessionId: result.sessionId, turnId: result.promptId };
    },
    async submitPrompt(sessionId, request, options) {
      const result = await client.sendManagedPrompt(
        sessionId,
        { prompt: [{ type: 'text', text: request.text }] },
        options,
      );
      return { sessionId: result.sessionId, turnId: result.promptId };
    },
    async cancel(sessionId, turnId, options) {
      await client.cancelManagedPrompt(sessionId, turnId, options);
    },
    async *subscribeEvents(sessionId, options) {
      for await (const event of client.subscribeManagedSessionEvents(
        sessionId,
        options,
      )) {
        yield toSessionEvent(event);
      }
    },
  };
}

function toSessionSummary(
  session: DaemonManagedSessionSummary,
): ManagedAgentSessionSummary {
  const { promptId, ...summary } = session;
  return { ...summary, activeTurnId: promptId };
}

function toSessionEvent(
  event: DaemonManagedSessionEvent,
): ManagedAgentSessionEvent {
  const { promptId, ...mapped } = event;
  return { ...mapped, turnId: promptId };
}
