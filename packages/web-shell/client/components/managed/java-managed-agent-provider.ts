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
import { isManagedApprovalMode } from './managed-agent-provider';
import { browserArtifactSave } from './managed-artifact-download';
import type { ManagedArtifactSave } from './managed-tool-result-types';
import type {
  ManagedAgentCommandOptions,
  ManagedAgentPendingAction,
  ManagedAgentProvider,
  ManagedAgentRuntimeState,
  ManagedAgentSessionPhase,
  ManagedAgentSessionSummary,
  ManagedTaskCancelOperation,
  ManagedApprovalMode,
  ManagedModelContext,
  ManagedModelSelection,
} from './managed-agent-provider';

export interface JavaManagedAgentProviderOptions
  extends JavaManagedAgentClientOptions {
  agentId?: string;
  environmentId?: string;
  /** Include tenant and actor identity; replace this scope/provider when either changes. Token refresh alone can use getHeaders. */
  productScope?: string;
  enableWorkspaceBinding?: boolean;
  modelPresets?: readonly { agentId: string; label: string }[];
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
  async function createWorkspaceSession(
    request: {
      agentId: string;
      workspaceId: string;
      cwdRelative: string;
      text?: string;
      input?: import('./managed-agent-provider').ManagedInputBlock[];
      approvalMode?: ManagedApprovalMode;
      planMode?: boolean;
    },
    command: ManagedAgentCommandOptions,
  ) {
    const result = await client.createSession(
      {
        requestId: managedRequestId(),
        idempotencyKey: command.idempotencyKey,
        agentId: request.agentId,
        ...(request.approvalMode === undefined
          ? {}
          : { approvalMode: request.approvalMode }),
        ...(request.planMode === undefined
          ? {}
          : { planMode: request.planMode }),
        input:
          request.input ??
          (request.text === undefined
            ? []
            : [{ type: 'input_text', text: request.text }]),
        metadata: { clientId: command.clientId },
        workspace: {
          workspaceId: request.workspaceId,
          cwdRelative: request.cwdRelative,
        },
      },
      command.signal,
    );
    if (!result.sessionId || (request.text !== undefined && !result.turnId))
      throw new Error(
        'Managed Agent create response is missing admission identity',
      );
    return { sessionId: result.sessionId };
  }
  return {
    kind: 'java',
    storageKey: storageKey(options),
    workspaceFiles: {
      query: (request, command) =>
        client.queryWorkspaceFiles(request, command.signal),
      read: (request, command) =>
        client.readWorkspaceFile(request, command.signal),
    },
    canCancel: true,
    acceptsWorkspaceCwd: false,
    skills: {
      list: (sessionId, request) =>
        client.getSessionSkills(sessionId, request.signal),
    },
    tasks: {
      list: (sessionId, request) =>
        client.listTasks(
          { sessionId, cursor: request.cursor, limit: request.limit },
          request.signal,
        ),
      async get(sessionId, taskId, request) {
        const task = await client.getTask(
          { sessionId, taskId },
          request.signal,
        );
        if (task.sessionId !== sessionId || task.taskId !== taskId)
          throw new Error('Task identity mismatch');
        return task;
      },
      listEvents: (sessionId, taskId, request) =>
        client.listTaskEvents(
          { sessionId, taskId, after: request.after, limit: request.limit },
          request.signal,
        ),
      ...(options.productScope?.trim()
        ? {
            cancel: {
              async submit(sessionId, taskId, command) {
                return requireTaskCancelOperation(
                  await client.cancelTask(
                    {
                      sessionId,
                      taskId,
                      idempotencyKey: command.idempotencyKey,
                      requestId: managedRequestId(),
                    },
                    command.signal,
                  ),
                  sessionId,
                  taskId,
                );
              },
              async query(sessionId, taskId, operationId, request) {
                const operation = requireTaskCancelOperation(
                  await client.queryOperation(
                    { sessionId, operationId },
                    request.signal,
                  ),
                  sessionId,
                  taskId,
                );
                if (operation.operationId !== operationId)
                  throw new Error('Task cancel operation identity mismatch');
                return operation;
              },
            },
          }
        : {}),
    },
    ...(options.productScope?.trim()
      ? {
          approvalChange: {
            async queryOptions(sessionId, request) {
              const result = await client.getSessionApproval(
                sessionId,
                request.signal,
              );
              if (
                !isManagedApprovalMode(result.approvalMode) ||
                !Number.isSafeInteger(result.approvalRevision) ||
                result.approvalRevision < 0 ||
                typeof result.supported !== 'boolean' ||
                !Array.isArray(result.availableApprovalModes) ||
                !result.availableApprovalModes.every(isManagedApprovalMode) ||
                !result.availableApprovalModes.includes(result.approvalMode)
              )
                throw new Error('Invalid Session approval options');
              return {
                approvalMode: result.approvalMode,
                approvalRevision: result.approvalRevision,
                availableApprovalModes: result.availableApprovalModes,
                supported: result.supported,
                ...(typeof result.planMode === 'boolean'
                  ? { planMode: result.planMode }
                  : {}),
                ...(typeof result.planModeSupported === 'boolean'
                  ? { planModeSupported: result.planModeSupported }
                  : {}),
              };
            },
            async submit(sessionId, request, command) {
              const result = await client.changeApproval(
                {
                  ...request,
                  sessionId,
                  idempotencyKey: command.idempotencyKey,
                  requestId: command.requestId,
                },
                command.signal,
              );
              if (
                result.sessionId !== sessionId ||
                result.approvalMode !== request.approvalMode ||
                !Number.isSafeInteger(result.approvalRevision) ||
                result.approvalRevision <= request.expectedRevision ||
                typeof result.replayed !== 'boolean'
              )
                throw new Error('Approval change identity mismatch');
              return {
                sessionId: result.sessionId,
                approvalMode: result.approvalMode,
                approvalRevision: result.approvalRevision,
                replayed: result.replayed,
                ...(typeof result.planMode === 'boolean'
                  ? { planMode: result.planMode }
                  : {}),
              };
            },
          },
          modelChange: {
            async queryOptions(sessionId, request) {
              const result = await client.getSessionModels(
                sessionId,
                request.signal,
              );
              const selection = modelSelection(result.modelSelection);
              if (
                !selection ||
                typeof result.supported !== 'boolean' ||
                !Array.isArray(result.models) ||
                result.models.some(
                  (item) =>
                    !modelId(item.modelId) ||
                    typeof item.label !== 'string' ||
                    !item.label.trim(),
                ) ||
                new Set(result.models.map((item) => item.modelId)).size !==
                  result.models.length
              )
                throw new Error('Invalid Session model options');
              return {
                supported: result.supported,
                modelSelection: selection,
                models: result.models.map(({ modelId, label }) => ({
                  modelId,
                  label,
                })),
              };
            },
            async submit(sessionId, request, command) {
              const result = await client.changeModel(
                {
                  ...request,
                  sessionId,
                  idempotencyKey: command.idempotencyKey,
                  requestId: managedRequestId(),
                },
                command.signal,
              );
              const selection = modelSelection(result.modelSelection);
              if (
                result.sessionId !== sessionId ||
                !selection ||
                selection.modelId !== request.modelId ||
                selection.revision <= request.expectedRevision ||
                typeof result.replayed !== 'boolean'
              )
                throw new Error('Model change identity mismatch');
              return {
                sessionId,
                modelSelection: selection,
                replayed: result.replayed,
              };
            },
          },
          cwdChange: {
            async submit(sessionId, request, command) {
              return requireCwdOperation(
                await client.changeCwd(
                  {
                    ...request,
                    sessionId,
                    idempotencyKey: command.idempotencyKey,
                    requestId: managedRequestId(),
                  },
                  command.signal,
                ),
                sessionId,
              );
            },
            async query(sessionId, operationId, request) {
              const result = requireCwdOperation(
                await client.queryOperation(
                  { sessionId, operationId },
                  request.signal,
                ),
                sessionId,
              );
              if (result.operationId !== operationId)
                throw new Error('Cwd operation identity mismatch');
              return result;
            },
          },
        }
      : {}),
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
        // so the card must stay rather than hide as if it had. The failure
        // code rides the error so the hook can tell an ended Action (no
        // retry can succeed) from a delivery failure worth retrying.
        if (
          result.status === 'failed' ||
          result.status === 'cancelled' ||
          result.status === 'recovery_blocked'
        ) {
          throw Object.assign(
            new Error(
              `Managed Agent approval answer ${result.status} (${result.failureCode ?? 'unknown'})`,
            ),
            { code: result.failureCode ?? 'unknown' },
          );
        }
      },
    },
    toolDetails: {
      get: (sessionId, itemId, request) =>
        client.getToolDetails(sessionId, itemId, request.signal),
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
            modelPresets: options.modelPresets,
            registration: {
              listNodes: (request) => client.listRuntimeNodes(request.signal),
              async checkDirectory(request, options) {
                const checked = await client.checkWorkspaceDirectory(
                  request,
                  options.signal,
                );
                if (checked.nodeId !== request.nodeId)
                  throw new Error('Workspace directory identity mismatch');
                return checked;
              },
              async create(request, command) {
                const operation = await client.registerWorkspace(
                  {
                    ...request,
                    idempotencyKey: command.idempotencyKey,
                    requestId: managedRequestId(),
                  },
                  command.signal,
                );
                if (
                  operation.type !== 'workspace_create' ||
                  !operation.operationId
                )
                  throw new Error('Workspace operation identity mismatch');
                return operation;
              },
              async query(operationId, request) {
                const operation = await client.getWorkspaceOperation(
                  operationId,
                  request.signal,
                );
                if (
                  operation.type !== 'workspace_create' ||
                  operation.operationId !== operationId
                )
                  throw new Error('Workspace operation identity mismatch');
                return operation;
              },
            },
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
                canCreateWorkspace:
                  page.capabilities?.workspaceCreation === true,
                canSelectDirectory:
                  page.capabilities?.workspaceDirectorySelection === true,
                supportsApprovalModeSelection:
                  page.capabilities?.approvalModeSelection === true,
              };
            },
            async get(workspaceId, request) {
              return client.getWorkspace(workspaceId, request.signal);
            },
            createWorkspace: (request, command) =>
              client.createWorkspace(
                { ...request, idempotencyKey: command.idempotencyKey },
                command.signal,
              ),
            directories: (request, command) =>
              client.workspaceDirectories(request, command.signal),
            getSessionOptions: (agentId, request) =>
              client.getSessionOptions(agentId, request.signal),
            createEmpty: (
              { agentId, workspaceId, cwdRelative, approvalMode, planMode },
              command,
            ) =>
              createWorkspaceSession(
                { agentId, workspaceId, cwdRelative, approvalMode, planMode },
                command,
              ),
            createSession: createWorkspaceSession,
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
          input: request.input ?? [{ type: 'input_text', text: request.text }],
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
          input: request.input ?? [{ type: 'input_text', text: request.text }],
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
        request.onAlive,
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
  const observation = modelContext(session.modelContext);
  const selectedModel = modelSelection(session.modelSelection);
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    ...(typeof session.planMode === 'boolean'
      ? { planMode: session.planMode }
      : {}),
    ...(typeof session.planModeSupported === 'boolean'
      ? { planModeSupported: session.planModeSupported }
      : {}),
    ...(isManagedApprovalMode(session.approvalMode)
      ? { approvalMode: session.approvalMode }
      : {}),
    ...(isManagedApprovalMode(session.initialApprovalMode)
      ? { initialApprovalMode: session.initialApprovalMode }
      : {}),
    ...(Number.isSafeInteger(session.approvalRevision) &&
    Number(session.approvalRevision) >= 0
      ? { approvalRevision: session.approvalRevision }
      : {}),
    ...(observation ? { modelContext: observation } : {}),
    ...(selectedModel ? { modelSelection: selectedModel } : {}),
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
      ...(session.capabilities?.tasks === true ? { tasks: true } : {}),
      ...(session.capabilities?.artifacts === true ? { artifacts: true } : {}),
      canSend:
        sessionActive &&
        !active &&
        (!session.workspace ||
          (workspaceTurns && session.capabilities?.foregroundShell !== false)),
      // The creator may cancel a running bound Turn after the Workspace stops
      // admitting new work, so cancel is not tied to workspaceTurns; the
      // server refuses anyone else.
      canCancel: sessionActive && active && turnStatus !== 'cancelling',
      ...(workspaceTurns ? { workspaceTurns: true } : {}),
      ...(session.capabilities?.cwdChange === true ? { cwdChange: true } : {}),
      ...(session.capabilities?.modelChange === true
        ? { modelChange: true }
        : {}),
      ...(session.capabilities?.approvalModeChange === true
        ? { approvalModeChange: true }
        : {}),
      ...(session.capabilities?.actions === true ? { actions: true } : {}),
      ...(session.capabilities?.inputAttachments === true
        ? { inputAttachments: true }
        : {}),
    },
    ...(errorCode ? { failure: { code: errorCode, message: errorCode } } : {}),
  };
}

function modelId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    new TextEncoder().encode(value).length <= 512 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  );
}

function modelSelection(value: unknown): ManagedModelSelection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(data['revision']) ||
    Number(data['revision']) < 0 ||
    (data['modelId'] !== undefined && !modelId(data['modelId'])) ||
    (Number(data['revision']) > 0 && data['modelId'] === undefined)
  )
    return undefined;
  return {
    revision: Number(data['revision']),
    ...(modelId(data['modelId']) ? { modelId: data['modelId'] } : {}),
  };
}

function modelContext(value: unknown): ManagedModelContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  if (
    typeof data['modelId'] !== 'string' ||
    !data['modelId'].trim() ||
    typeof data['observedAt'] !== 'number' ||
    !Number.isSafeInteger(data['observedAt']) ||
    data['observedAt'] < 0
  )
    return undefined;
  const inputTokens = data['inputTokens'];
  const contextWindowSize = data['contextWindowSize'];
  return {
    modelId: data['modelId'],
    observedAt: data['observedAt'],
    ...(typeof inputTokens === 'number' &&
    Number.isSafeInteger(inputTokens) &&
    inputTokens >= 0
      ? { inputTokens }
      : {}),
    ...(typeof contextWindowSize === 'number' &&
    Number.isSafeInteger(contextWindowSize) &&
    contextWindowSize > 0
      ? { contextWindowSize }
      : {}),
  };
}

function requireCwdOperation(
  operation: Awaited<ReturnType<JavaManagedAgentClient['queryOperation']>>,
  sessionId: string,
) {
  if (
    operation.type !== 'cwd_change' ||
    operation.sessionId !== sessionId ||
    !operation.operationId
  ) {
    throw new Error('Cwd operation identity mismatch');
  }
  return operation;
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
  // The server refuses C0 control characters and DEL in a title; pasted
  // terminal output carries ANSI escapes verbatim, so fold them to spaces
  // beside the whitespace collapse instead of failing the Session create.
  const title = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return title.length <= 80 ? title : `${title.slice(0, 77)}...`;
}

function requireTaskCancelOperation(
  operation: Awaited<ReturnType<JavaManagedAgentClient['queryOperation']>>,
  sessionId: string,
  taskId: string,
): ManagedTaskCancelOperation {
  if (
    operation.type !== 'task_cancel' ||
    operation.sessionId !== sessionId ||
    operation.taskId !== taskId ||
    !operation.operationId ||
    operation.status === 'cancelled'
  )
    throw new Error('Task cancel operation identity mismatch');
  return operation as ManagedTaskCancelOperation;
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
