import {
  isJavaAgentResyncRequired,
  JavaManagedAgentClient,
  type JavaAgentAction,
  type JavaAgentSession,
  type JavaManagedAgentClientOptions,
} from './java-managed-agent-client';
import {
  projectJavaAgentEvent,
  projectJavaAgentItem,
  toTimestamp,
} from './java-managed-agent-event-projector';
import { managedRequestId } from './managed-session-storage';
import { browserArtifactSave } from './managed-artifact-download';
import type { ManagedArtifactSave } from './managed-tool-result-types';
import type {
  ManagedAgentPendingAction,
  ManagedAgentProvider,
  ManagedAgentRuntimeState,
  ManagedAgentSessionPhase,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';

export interface JavaManagedAgentProviderOptions
  extends JavaManagedAgentClientOptions {
  agentId?: string;
  environmentId?: string;
  /** Include tenant and actor identity; replace this scope/provider when either changes. Token refresh alone can use getHeaders. */
  productScope?: string;
  enableWorkspaceBinding?: boolean;
  /** Acquire a streaming save target during the user gesture, then call openStream. */
  saveArtifact?: ManagedArtifactSave;
}

type JavaCommandOperation = Awaited<
  ReturnType<JavaManagedAgentClient['respondAction']>
>;

// Waits between reads of an accepted approval answer's operation. The service
// forwards the answer to the Harness right away and retries a failed delivery
// with its own backoff, so a few reads over half a minute see it settle.
const ACTION_RESPONSE_POLL_DELAYS_MS = [
  250, 500, 1_000, 2_000, 2_000, 4_000, 4_000, 8_000, 8_000,
];

/**
 * Follows an accepted approval answer to the end of its operation. `202` only
 * means the answer was admitted: delivery can still fail, for example when the
 * Workspace stops accepting it, and the operation stays `running` while the
 * Session is blocked. Reading the same operation, rather than answering again,
 * keeps the original attempt and its idempotency key (#12867 D6). An answer
 * still unsettled after the polling budget is reported as unconfirmed; the
 * same key replays this operation when the user answers again.
 */
async function settleActionResponse(
  client: JavaManagedAgentClient,
  sessionId: string,
  operation: JavaCommandOperation,
  signal: AbortSignal | undefined,
): Promise<JavaCommandOperation> {
  let current = operation;
  for (const delay of ACTION_RESPONSE_POLL_DELAYS_MS) {
    if (current.status !== 'pending' && current.status !== 'running') {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    signal?.throwIfAborted();
    const read = await client.queryOperation(
      { sessionId, operationId: current.operationId },
      signal,
    );
    if (read.type !== 'action_response') {
      throw new Error(
        `Managed Agent operation ${read.operationId} is not an approval answer`,
      );
    }
    current = read;
  }
  if (current.status !== 'pending' && current.status !== 'running') {
    return current;
  }
  throw new Error(
    `Managed Agent approval answer not confirmed yet (operation ${current.operationId} is ${current.status})`,
  );
}

export function createJavaManagedAgentProvider(
  options: JavaManagedAgentProviderOptions,
): ManagedAgentProvider {
  const client = new JavaManagedAgentClient(options);
  const saveArtifact = options.saveArtifact ?? browserArtifactSave();
  const agentId = options.agentId ?? 'qwen-code';
  if (options.enableWorkspaceBinding && !options.productScope?.trim()) {
    throw new Error('Workspace binding requires an explicit productScope');
  }
  return {
    kind: 'java',
    storageKey: storageKey(options),
    canCancel: true,
    acceptsWorkspaceCwd: false,
    actions: {
      async listPending(sessionId, request) {
        // The service lists only requested Actions, newest first, so one page
        // holds every pending one unless more than 20 wait at once.
        const page = await client.queryActions(
          { sessionId, limit: 20 },
          request.signal,
        );
        return page.data.flatMap(toPendingAction);
      },
      async respond(action, optionId, command) {
        const accepted = await client.respondAction(
          {
            requestId: managedRequestId(),
            idempotencyKey: command.idempotencyKey,
            sessionId: action.sessionId,
            actionId: action.actionId,
            response: {
              kind: 'permission',
              inputRevision: action.inputRevision,
              policyRevision: action.policyRevision,
              optionId,
            },
          },
          command.signal,
        );
        const result = await settleActionResponse(
          client,
          action.sessionId,
          accepted,
          command.signal,
        );
        // A cancelled or recovery-blocked operation did not apply the answer,
        // so the card must stay rather than hide as if it had.
        if (
          result.status === 'failed' ||
          result.status === 'cancelled' ||
          result.status === 'recovery_blocked'
        ) {
          throw new Error(
            `Managed Agent approval answer ${result.status} (${result.failureCode ?? 'unknown'})`,
          );
        }
      },
    },
    toolResults: {
      canDownload: saveArtifact !== undefined,
      getResult: (sessionId, itemId, request) =>
        client.getToolResult(sessionId, itemId, request.signal),
      listArtifacts: (sessionId, request) =>
        client.listArtifacts(
          { sessionId, cursor: request.cursor, limit: request.limit },
          request.signal,
        ),
      getArtifact: (sessionId, artifactId, request) =>
        client.getArtifact(sessionId, artifactId, request.signal),
      readRange: (artifact, offset, length, request) =>
        client.readArtifactRange(artifact, offset, length, request.signal),
      async downloadArtifact(artifact, request) {
        if (!saveArtifact) {
          throw new Error('This host does not support streaming downloads');
        }
        await saveArtifact(artifact, {
          signal: request.signal,
          openStream: () => client.openArtifactStream(artifact, request.signal),
        });
      },
    },
    ...(options.enableWorkspaceBinding
      ? {
          workspaceBinding: {
            agentId,
            async list(request) {
              const page = await client.listWorkspaces(
                { cursor: request.cursor, limit: request.limit },
                request.signal,
              );
              return {
                data: page.data,
                defaultWorkspace: page.defaultWorkspace,
                nextCursor: page.nextCursor ?? undefined,
                supported: page.capabilities?.workspaceBinding === true,
              };
            },
            async get(workspaceId, request) {
              return client.getWorkspace(workspaceId, request.signal);
            },
            async createEmpty(request, command) {
              const result = await client.createSession(
                {
                  requestId: managedRequestId(),
                  idempotencyKey: command.idempotencyKey,
                  agentId: request.agentId,
                  input: [],
                  metadata: { clientId: command.clientId },
                  workspace: {
                    workspaceId: request.workspaceId,
                    cwdRelative: request.cwdRelative,
                  },
                },
                command.signal,
              );
              if (!result.sessionId) {
                throw new Error(
                  'Managed Agent create response is missing sessionId',
                );
              }
              return { sessionId: result.sessionId };
            },
          },
        }
      : {}),
    async listSessions(request) {
      const page = await client.listSessions(
        { cursor: request.cursor, limit: request.limit },
        request.signal,
      );
      return {
        sessions: page.data.map(toSessionSummary),
        nextCursor: page.nextCursor ?? undefined,
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
        olderCursor: transcript.olderCursor ?? undefined,
        lastEventId: transcript.lastSequence,
      };
    },
    async createSession(request, command) {
      const result = await client.createSession(
        {
          requestId: managedRequestId(),
          idempotencyKey: command.idempotencyKey,
          agentId,
          // environmentId scopes the storageKey only: the standalone Java
          // server 400s any non-blank value with unsupported_feature.
          title: titleFor(request.text),
          input: [{ type: 'input_text', text: request.text }],
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
          requestId: managedRequestId(),
          idempotencyKey: command.idempotencyKey,
          sessionId,
          input: [{ type: 'input_text', text: request.text }],
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
          requestId: managedRequestId(),
          idempotencyKey: command.idempotencyKey,
          sessionId,
          turnId,
        },
        command.signal,
      );
    },
    async *subscribeEvents(sessionId, request) {
      for await (const event of client.streamEvents(
        { sessionId, afterSequence: request.lastEventId },
        request.signal,
        request.onEstablished,
      )) {
        if (isJavaAgentResyncRequired(event)) {
          // Events after the cursor are gone: reload the transcript.
          yield {
            id: request.lastEventId ?? 0,
            at: Date.now(),
            type: 'stream_gap',
            sessionId,
            turnId: '',
            data: event,
          };
          return;
        }
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
  const sessionActive = session.status.toLowerCase() === 'active';
  // A bound Session takes later Turns only from the caller the service
  // allows; everything else about a bound Session stays read-only.
  const workspaceTurns =
    Boolean(session.workspace) && session.capabilities?.workspaceTurns === true;
  const errorCode =
    session.activeTurn?.errorCode ?? session.environment?.errorCode;
  return {
    sessionId: session.sessionId,
    activeTurnId: session.activeTurn?.turnId,
    title: session.title || session.sessionId,
    workspace: session.workspace,
    createdAt: toTimestamp(session.createdAt),
    admittedAt: toTimestamp(
      session.activeTurn?.submittedAt ?? session.createdAt,
    ),
    updatedAt: toTimestamp(session.updatedAt),
    phase,
    runtimeReady: runtimeState === 'ready',
    runtimeState,
    capabilities: {
      ...(session.capabilities?.artifacts === true ? { artifacts: true } : {}),
      canSend:
        sessionActive && !active && (!session.workspace || workspaceTurns),
      canCancel:
        sessionActive &&
        active &&
        turnStatus !== 'cancelling' &&
        (!session.workspace || workspaceTurns),
      ...(workspaceTurns ? { workspaceTurns: true } : {}),
      ...(session.capabilities?.actions === true ? { actions: true } : {}),
    },
    ...(errorCode ? { failure: { code: errorCode, message: errorCode } } : {}),
  };
}

function toPendingAction(action: JavaAgentAction): ManagedAgentPendingAction[] {
  if (action.kind !== 'permission' || action.state !== 'requested') return [];
  return [
    {
      actionId: action.actionId,
      sessionId: action.sessionId,
      ...(action.turnId ? { turnId: action.turnId } : {}),
      functionCallId: action.functionCallId,
      toolName: action.toolName,
      inputRevision: action.inputRevision,
      policyRevision: action.policyRevision,
      expiresAt: action.expiresAt,
      options: action.options.map(({ id, label }) => ({ id, label })),
      ...(action.inputPreview ? { inputPreview: action.inputPreview } : {}),
    },
  ];
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
  if (turnStatus === 'cancelling') return 'cancelling';
  if (
    turnStatus === 'running' ||
    turnStatus === 'in_progress' ||
    turnStatus === 'requires_action'
  ) {
    return 'agent_running';
  }
  if (turnStatus === 'accepted' || turnStatus === 'queued') {
    return runtimeState === 'starting' ? 'runtime_starting' : 'admitted';
  }
  return turnStatus === undefined ? 'created' : 'admitted';
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
  const baseKey = `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
  const scope = options.productScope ?? options.environmentId ?? 'default';
  const prefix = `${baseKey}:managed:${scope}`;
  return options.enableWorkspaceBinding
    ? JSON.stringify([
        baseKey,
        scope,
        options.agentId ?? 'qwen-code',
        'workspace-binding-v1',
      ])
    : prefix;
}
