import {
  JavaManagedAgentClient,
  type JavaAgentSession,
  type JavaManagedAgentClientOptions,
} from './java-managed-agent-client';
import {
  projectJavaAgentEvent,
  projectJavaAgentItem,
  toTimestamp,
} from './java-managed-agent-event-projector';
import type {
  ManagedAgentProvider,
  ManagedAgentRuntimeState,
  ManagedAgentSessionPhase,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';

export interface JavaManagedAgentProviderOptions
  extends JavaManagedAgentClientOptions {
  agentId?: string;
  environmentId?: string;
  productScope?: string;
}

export function createJavaManagedAgentProvider(
  options: JavaManagedAgentProviderOptions,
): ManagedAgentProvider {
  const client = new JavaManagedAgentClient(options);
  const agentId = options.agentId ?? 'dataworks_data_agent';
  return {
    kind: 'java',
    storageKey: storageKey(options),
    canCancel: true,
    acceptsWorkspaceCwd: false,
    async listSessions(request) {
      const page = await client.listSessions(
        { cursor: request.cursor, limit: request.limit },
        request.signal,
      );
      return {
        sessions: page.data.map(toSessionSummary),
        nextCursor: page.nextCursor,
      };
    },
    async getSession(sessionId, request) {
      return toSessionSummary(
        await client.getSession(sessionId, request.signal),
      );
    },
    async getTranscript(sessionId, request) {
      const transcript = await client.getTranscript(
        {
          sessionId,
          cursor: request.before,
          limit: request.limit,
        },
        request.signal,
      );
      const itemEvents = (transcript.items ?? []).flatMap(projectJavaAgentItem);
      const tailEvents = transcript.events.flatMap((event) => {
        const projected = projectJavaAgentEvent(event);
        return projected ? [projected] : [];
      });
      return {
        events: [...itemEvents, ...tailEvents].sort(
          (left, right) => left.id - right.id,
        ),
        olderCursor: transcript.olderCursor,
        lastEventId: transcript.lastSequence,
      };
    },
    async createSession(request, command) {
      const result = await client.createSession(
        {
          requestId: command.idempotencyKey,
          idempotencyKey: command.idempotencyKey,
          agentId,
          environmentId: options.environmentId,
          title: titleFor(request.text),
          input: [{ type: 'text', text: request.text }],
          metadata: { clientId: command.clientId },
        },
        command.signal,
      );
      if (!result.turnId) {
        throw new Error('Managed Agent create response is missing turnId');
      }
      return { sessionId: result.sessionId, turnId: result.turnId };
    },
    async submitPrompt(sessionId, request, command) {
      const result = await client.submitTurn(
        {
          requestId: command.idempotencyKey,
          idempotencyKey: command.idempotencyKey,
          sessionId,
          input: [{ type: 'text', text: request.text }],
          metadata: { clientId: command.clientId },
        },
        command.signal,
      );
      if (!result.turnId) {
        throw new Error('Managed Agent submit response is missing turnId');
      }
      return { sessionId: result.sessionId, turnId: result.turnId };
    },
    async cancel(sessionId, turnId, command) {
      await client.cancelTurn(
        {
          requestId: command.idempotencyKey,
          idempotencyKey: command.idempotencyKey,
          sessionId,
          turnId,
        },
        command.signal,
      );
    },
    async *subscribeEvents(sessionId, request) {
      for await (const event of client.streamEvents(
        { sessionId, afterSequence: request.lastEventId, limit: 100 },
        request.signal,
      )) {
        const projected = projectJavaAgentEvent(event);
        if (projected) yield projected;
      }
    },
  };
}

function toSessionSummary(
  session: JavaAgentSession,
): ManagedAgentSessionSummary {
  const turnStatus = session.activeTurn?.status.toLowerCase();
  const runtimeState = toRuntimeState(session.environment?.state);
  const phase = toPhase(turnStatus, runtimeState);
  const active =
    turnStatus !== undefined &&
    !['completed', 'failed', 'cancelled', 'recovery_blocked'].includes(
      turnStatus,
    );
  const errorCode =
    session.activeTurn?.errorCode ?? session.environment?.errorCode;
  return {
    sessionId: session.sessionId,
    activeTurnId: session.activeTurn?.turnId,
    title: session.title || session.sessionId,
    createdAt: toTimestamp(session.createdAt),
    admittedAt: toTimestamp(
      session.activeTurn?.submittedAt ?? session.createdAt,
    ),
    updatedAt: toTimestamp(session.updatedAt),
    phase,
    runtimeReady: runtimeState === 'ready',
    runtimeState,
    capabilities: { canSend: !active, canCancel: active },
    ...(errorCode ? { failure: { code: errorCode, message: errorCode } } : {}),
  };
}

function toRuntimeState(value: string | undefined): ManagedAgentRuntimeState {
  const normalized = value?.toLowerCase();
  return normalized === 'starting' ||
    normalized === 'ready' ||
    normalized === 'failed'
    ? normalized
    : 'unknown';
}

function toPhase(
  turnStatus: string | undefined,
  runtimeState: ManagedAgentRuntimeState,
): ManagedAgentSessionPhase {
  if (turnStatus === 'completed') return 'completed';
  if (turnStatus === 'failed' || turnStatus === 'recovery_blocked') {
    return 'failed';
  }
  if (turnStatus === 'cancelled') return 'cancelled';
  if (turnStatus === 'in_progress' || turnStatus === 'requires_action') {
    return 'agent_running';
  }
  if (turnStatus === 'accepted' || turnStatus === 'queued') {
    return runtimeState === 'starting' ? 'runtime_starting' : 'admitted';
  }
  return 'admitted';
}

function titleFor(text: string): string {
  const title = text.trim().replace(/\s+/g, ' ');
  return title.length <= 80 ? title : `${title.slice(0, 77)}...`;
}

function storageKey(options: JavaManagedAgentProviderOptions): string {
  const base = new URL(
    options.baseUrl,
    typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  );
  base.search = '';
  base.hash = '';
  const scope = options.productScope ?? options.environmentId ?? 'default';
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}:managed:${scope}`;
}
