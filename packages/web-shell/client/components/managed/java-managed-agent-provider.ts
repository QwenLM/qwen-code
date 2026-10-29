import { requireExtensionSnapshot } from './managed-extension-types';
import type { components } from './generated/managed-agent-api';
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
} from './java-managed-agent-event-projector';
import { managedRequestId } from './managed-session-storage';
import { isManagedApprovalMode } from './managed-agent-provider';
import { browserArtifactSave } from './managed-artifact-download';
import type { ManagedArtifactSave } from './managed-tool-result-types';
import type { ManagedMcpManagementSnapshot } from './managed-mcp-management-types';
import { parseManagedPermissionRules } from '@qwen-code/qwen-code-core/managed-runtime/managed-permission-rules.js';
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
  ManagedModelPreset,
} from './managed-agent-provider';

export interface JavaManagedAgentProviderOptions
  extends JavaManagedAgentClientOptions {
  agentId?: string;
  /** Include tenant and actor identity; replace this scope/provider when either changes. Token refresh alone can use getHeaders. */
  productScope?: string;
  enableWorkspaceBinding?: boolean;
  modelPresets?: readonly ManagedModelPreset[];
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
      modelId?: string;
      workspaceId: string;
      cwdRelative: string;
      text?: string;
      input?: import('./managed-agent-provider').ManagedInputBlock[];
      approvalMode?: ManagedApprovalMode;
      planMode?: boolean;
      skills?: import('./managed-agent-provider').ManagedSessionSkill[];
      extensionPins?: import('./managed-extension-types').ManagedExtensionPin[];
      worktree?: { baseRef?: string };
    },
    command: ManagedAgentCommandOptions,
  ) {
    const approvalMode = request.approvalMode;
    if (approvalMode === 'auto')
      throw new Error('Select Auto after creating the Managed Session.');
    const result = await client.createSession(
      {
        requestId: managedRequestId(),
        idempotencyKey: command.idempotencyKey,
        agentId: request.agentId,
        ...(request.worktree === undefined
          ? {}
          : { worktree: request.worktree }),
        ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
        ...(request.skills?.length ? { skills: request.skills } : {}),
        ...(request.extensionPins === undefined
          ? {}
          : { extensionPins: request.extensionPins }),
        // Without a title the Session list and header fall back to a UUID
        // prefix, unlike the standard shell's prompt-derived title.
        ...(request.text === undefined
          ? {}
          : { title: titleFor(request.text) }),
        ...(approvalMode === undefined ? {} : { approvalMode }),
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
    userMessages: {
      query: (sessionId, options) =>
        client.queryUserMessages(sessionId, options.signal),
      command: (sessionId, command, options) =>
        client.commandUserMessages(
          sessionId,
          command,
          options.idempotencyKey,
          options.signal,
        ),
    },
    lifecycle: {
      submit: (kind, sessionId, command) =>
        client.lifecycleCommand(
          kind,
          {
            sessionId,
            idempotencyKey: command.idempotencyKey,
            requestId: managedRequestId(),
          },
          command.signal,
        ),
      async unarchive(sessionId, command) {
        return toSessionSummary(
          await client.unarchiveSession(
            {
              sessionId,
              idempotencyKey: command.idempotencyKey,
              requestId: managedRequestId(),
            },
            command.signal,
          ),
        );
      },
      async query(sessionId, operationId, request) {
        const operation = await client.queryOperation(
          { sessionId, operationId },
          request.signal,
        );
        if (!['close', 'archive', 'delete'].includes(operation.type))
          throw new Error('Unexpected lifecycle operation type');
        return operation as components['schemas']['WebShellCommandOperation'];
      },
    },
    exportSnapshot: (sessionId, request) =>
      client.exportSnapshot(
        { sessionId, cursor: request.cursor, limit: 100, view: 'messages' },
        request.signal,
      ),
    exportConsistency: 'live',
    storageKey: storageKey(options),
    workspaceFiles: {
      query: (request, command) =>
        client.queryWorkspaceFiles(request, command.signal),
      read: (request, command) =>
        client.readWorkspaceFile(request, command.signal),
      upload: (request, data, command) =>
        client.uploadWorkspaceFile(request, data, command.signal),
      queryUpload: (uploadId, command) =>
        client.queryWorkspaceFileUpload(uploadId, command.signal),
    },
    canCancel: true,
    titleSearch: true,
    recovery: {
      query: (sessionId, request) =>
        client.getRecovery(sessionId, request.signal),
      recheck: (sessionId, turnId, request) =>
        client.recheckRecovery(sessionId, turnId, request.signal),
    },
    async queryCancelOperation(sessionId, operationId, request) {
      const operation = await client.queryOperation(
        { sessionId, operationId },
        request.signal,
      );
      if (
        operation.type !== 'cancel' ||
        operation.sessionId !== sessionId ||
        operation.operationId !== operationId
      ) {
        throw new Error('Managed Turn cancellation identity mismatch');
      }
      return operation;
    },
    async renameSession(sessionId, displayName, command) {
      const result = await client.renameSession(
        {
          sessionId,
          title: displayName,
          idempotencyKey: command.idempotencyKey,
        },
        command.signal,
      );
      if (
        result.sessionId !== sessionId ||
        typeof result.title !== 'string' ||
        !result.title.trim()
      ) {
        throw new Error('Managed Agent rename response is invalid');
      }
      return { displayName: result.title };
    },
    skills: {
      list: (sessionId, request) =>
        client.getSessionSkills(sessionId, request.signal),
    },
    mcp: {
      list: (sessionId, request) =>
        client.getSessionMcp(sessionId, request.signal),
    },
    extensions: {
      storageScope: options.productScope?.trim()
        ? storageKey(options)
        : undefined,
      list: (workspaceId, request) =>
        client.listExtensionPackages(workspaceId, request.signal),
      publish: (workspaceId, extensionId, digest, manifest, archive, request) =>
        client.publishExtensionPackage(
          workspaceId,
          extensionId,
          digest,
          manifest,
          archive,
          request.idempotencyKey,
          request.signal,
        ),
      settings: (workspaceId, extensionId, request) =>
        client.getExtensionSettings(workspaceId, extensionId, request.signal),
      saveSettings: (workspaceId, extensionId, revision, values, request) =>
        client.saveExtensionSettings(
          workspaceId,
          extensionId,
          revision,
          values,
          request.idempotencyKey,
          request.signal,
        ),
      query: async (sessionId, request) =>
        requireExtensionSnapshot(
          await client.queryExtensionConfiguration(
            sessionId,
            undefined,
            request.signal,
          ),
          sessionId,
        ),
      apply: async (sessionId, selection, request) =>
        requireExtensionSnapshot(
          await client.applyExtensionConfiguration(
            sessionId,
            selection,
            request.idempotencyKey,
            request.signal,
          ),
          sessionId,
        ),
      operation: async (sessionId, operationId, request) =>
        requireExtensionSnapshot(
          await client.queryExtensionConfiguration(
            sessionId,
            operationId,
            request.signal,
          ),
          sessionId,
        ),
      resume: async (sessionId, operationId, recoverPrevious, request) =>
        requireExtensionSnapshot(
          await client.resumeExtensionConfiguration(
            sessionId,
            operationId,
            recoverPrevious,
            request.signal,
          ),
          sessionId,
        ),
      package: (workspaceId, pin, request) =>
        client.getExtensionPackage(workspaceId, pin, request.signal),
    },
    mcpManagement: {
      storageScope: options.productScope?.trim()
        ? storageKey(options)
        : undefined,
      async query(sessionId, request) {
        return requireMcpManagementSnapshot(
          await client.queryMcpManagement(
            { sessionId, requestId: managedRequestId() },
            request.signal,
          ),
          sessionId,
        );
      },
      async submit(sessionId, command, request) {
        const snapshot = requireMcpManagementSnapshot(
          await client.submitMcpManagement(
            {
              ...command,
              sessionId,
              requestId: request.requestId,
              idempotencyKey: request.idempotencyKey,
            },
            request.signal,
          ),
          sessionId,
        );
        if (
          !snapshot.operation ||
          snapshot.operation.action !== command.action ||
          snapshot.operation.serverId !== command.serverId ||
          snapshot.operation.revision !== command.expectedRevision + 1
        )
          throw new Error('Managed MCP operation identity mismatch');
        return snapshot;
      },
      async operation(sessionId, operationId, request) {
        const snapshot = requireMcpManagementSnapshot(
          await client.getMcpManagementOperation(
            { sessionId, operationId, requestId: managedRequestId() },
            request.signal,
          ),
          sessionId,
        );
        if (snapshot.operation?.operationId !== operationId)
          throw new Error('Managed MCP operation identity mismatch');
        return snapshot;
      },
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
                !result.availableApprovalModes.includes(result.approvalMode) ||
                (result.permissionRulesSupported !== undefined &&
                  typeof result.permissionRulesSupported !== 'boolean')
              )
                throw new Error('Invalid Session approval options');
              return {
                approvalMode: result.approvalMode,
                approvalRevision: result.approvalRevision,
                availableApprovalModes: result.availableApprovalModes,
                supported: result.supported,
                ...(result.permissionRulesSupported === true
                  ? { permissionRulesSupported: true }
                  : {}),
                ...(result.permissionRules === undefined
                  ? {}
                  : {
                      permissionRules: parseManagedPermissionRules(
                        result.permissionRules,
                      ),
                    }),
                ...(result.liveSupported === true
                  ? { liveSupported: true }
                  : {}),
                ...(typeof result.planMode === 'boolean'
                  ? { planMode: result.planMode }
                  : {}),
                ...(typeof result.planModeSupported === 'boolean'
                  ? { planModeSupported: result.planModeSupported }
                  : {}),
              };
            },
            async submit(sessionId, request, command) {
              const { permissionRules, ...selection } = request;
              const result = await client.changeApproval(
                {
                  ...selection,
                  ...(permissionRules === undefined
                    ? {}
                    : {
                        permissionRules: {
                          allow: [...permissionRules.allow],
                          ask: [...permissionRules.ask],
                          deny: [...permissionRules.deny],
                        },
                      }),
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
                ...(result.permissionRules === undefined
                  ? {}
                  : {
                      permissionRules: parseManagedPermissionRules(
                        result.permissionRules,
                      ),
                    }),
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
          contextCompression: {
            async submit(sessionId, request, command) {
              return requireContextCompressionOperation(
                await client.compressContext(
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
              const operation = requireContextCompressionOperation(
                await client.queryOperation(
                  { sessionId, operationId },
                  request.signal,
                ),
                sessionId,
              );
              if (operation.operationId !== operationId)
                throw new Error(
                  'Context compression operation identity mismatch',
                );
              return operation;
            },
          },
        }
      : {}),
    actions: {
      async listPending(sessionId, request) {
        const actions: ManagedAgentPendingAction[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const page = await client.queryActions(
            {
              sessionId,
              limit: 20,
              ...(cursor ? { cursor } : {}),
              ...(request.includeChildren ? { includeChildren: true } : {}),
            },
            request.signal,
          );
          actions.push(...page.data.flatMap(toPendingAction));
          cursor = page.hasMore ? (page.nextCursor ?? undefined) : undefined;
          if (cursor && cursors.has(cursor))
            throw new Error('Action cursor repeated');
          if (cursor) cursors.add(cursor);
        } while (cursor && !request.signal?.aborted);
        return [
          ...new Map(
            actions.map((action) => [
              `${action.sessionId}:${action.actionId}`,
              action,
            ]),
          ).values(),
        ];
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
                canImportLocalDirectory:
                  page.capabilities?.localDirectoryImport === true,
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
              {
                agentId,
                modelId,
                workspaceId,
                cwdRelative,
                approvalMode,
                planMode,
                skills,
                extensionPins,
                worktree,
              },
              command,
            ) =>
              createWorkspaceSession(
                {
                  agentId,
                  modelId,
                  workspaceId,
                  cwdRelative,
                  approvalMode,
                  planMode,
                  skills,
                  extensionPins,
                  worktree,
                },
                command,
              ),
            createSession: createWorkspaceSession,
          },
          sessionWorktrees: {
            options: (request, options) =>
              client.worktreeOptions(request, options.signal),
            list: (workspaceId, options) =>
              client.listSessionWorktrees(workspaceId, options.signal),
            inspect: (workspaceId, worktreeId, options) =>
              client.inspectSessionWorktree(
                workspaceId,
                worktreeId,
                options.signal,
              ),
            cleanup: (workspaceId, worktreeId, options) =>
              client.cleanupSessionWorktree(
                {
                  workspaceId,
                  worktreeId,
                  idempotencyKey: options.idempotencyKey,
                },
                options.signal,
              ),
          },
        }
      : {}),
    async listSessions(request) {
      const page = await client.listSessions(
        {
          cursor: request.cursor,
          limit: request.limit,
          archiveState: request.archiveState,
          titleQuery: request.titleQuery,
        },
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
          view: 'messages',
        },
        request.signal,
      );
      if (
        !Number.isSafeInteger(transcript.coveredSequence) ||
        transcript.coveredSequence < 0
      ) {
        throw new Error('Invalid message transcript coverage.');
      }
      const itemEvents = transcript.items.flatMap(projectJavaAgentItem);
      const tailEvents = transcript.events.flatMap((event) => {
        const projected = projectJavaAgentEvent(event);
        return projected ? [projected] : [];
      });
      return {
        events: [...itemEvents, ...tailEvents].sort(
          (left, right) => left.id - right.id,
        ),
        olderCursor: transcript.olderCursor ?? undefined,
        lastEventId: transcript.coveredSequence,
        history: 'items',
      };
    },
    async createSession(request, command) {
      const result = await client.createSession(
        {
          requestId: managedRequestId(),
          idempotencyKey: command.idempotencyKey,
          agentId,
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
      if (
        result.sessionId !== sessionId ||
        !result.turnId ||
        !result.operationId
      ) {
        throw new Error(
          'Managed Agent submit response is missing admission identity',
        );
      }
      return {
        sessionId,
        turnId: result.turnId,
        operationId: result.operationId,
      };
    },
    async cancel(sessionId, turnId, command) {
      const result = await client.cancelTurn(
        {
          requestId: managedRequestId(),
          idempotencyKey: command.idempotencyKey,
          sessionId,
          turnId,
        },
        command.signal,
      );
      if (
        result.sessionId !== sessionId ||
        result.turnId !== turnId ||
        !result.operationId
      ) {
        throw new Error('Managed Turn cancellation identity mismatch');
      }
      return { sessionId, turnId, operationId: result.operationId };
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
  const recoveryBlocked = turnStatus === 'recovery_blocked';
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
    compactionRevision: session.compactionRevision ?? 0,
    ...(session.contextCompressionOperationId
      ? { contextCompressionOperationId: session.contextCompressionOperationId }
      : {}),
    lifecycleStatus: session.status.toLowerCase(),
    lastSequence: session.lastSequence,
    lifecycleOperation: session.lifecycleOperation,
    activeTurnId: session.activeTurn?.turnId,
    ...(session.recovery ? { recovery: session.recovery } : {}),
    title: session.title || session.sessionId,
    workspace: session.workspace,
    ...(session.worktree ? { worktree: session.worktree } : {}),
    createdAt: session.createdAt,
    admittedAt: session.activeTurn?.submittedAt ?? session.createdAt,
    updatedAt: session.updatedAt,
    phase,
    runtimeReady: runtimeState === 'ready',
    runtimeState,
    capabilities: {
      ...(session.capabilities?.sessionClose === true
        ? { sessionClose: true }
        : {}),
      ...(session.capabilities?.sessionArchive === true
        ? { sessionArchive: true }
        : {}),
      ...(session.capabilities?.sessionUnarchive === true
        ? { sessionUnarchive: true }
        : {}),
      ...(session.capabilities?.sessionDelete === true
        ? { sessionDelete: true }
        : {}),
      ...(session.capabilities?.rename === true ? { canRename: true } : {}),
      ...(session.capabilities?.tasks === true ? { tasks: true } : {}),
      ...(session.capabilities?.artifacts === true ? { artifacts: true } : {}),
      canSend:
        sessionActive &&
        !active &&
        !session.contextCompressionOperationId &&
        !recoveryBlocked &&
        session.recovery?.nextTurnAllowed !== false &&
        (!session.workspace ||
          (workspaceTurns && session.capabilities?.foregroundShell !== false)),
      // The creator may cancel a running bound Turn after the Workspace stops
      // admitting new work, so cancel is not tied to workspaceTurns; the
      // server refuses anyone else.
      canCancel:
        sessionActive &&
        (active || recoveryBlocked) &&
        turnStatus !== 'cancelling' &&
        session.recovery?.actions.cancel !== false,
      ...(workspaceTurns ? { workspaceTurns: true } : {}),
      ...(session.capabilities?.modelChange === true
        ? { modelChange: true }
        : {}),
      ...(session.capabilities?.contextCompression === true
        ? { contextCompression: true }
        : {}),
      ...(session.capabilities?.approvalModeChange === true
        ? { approvalModeChange: true }
        : {}),
      ...(session.capabilities?.actions === true ? { actions: true } : {}),
      ...(session.capabilities?.childAgents === true
        ? { childAgents: true }
        : {}),
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

function requireContextCompressionOperation(
  operation: Awaited<ReturnType<JavaManagedAgentClient['queryOperation']>>,
  sessionId: string,
) {
  if (
    operation.type !== 'context_compression' ||
    operation.sessionId !== sessionId ||
    !operation.operationId ||
    !Number.isSafeInteger(operation.expectedCompactionRevision) ||
    operation.expectedCompactionRevision < 0 ||
    !['pending', 'running', 'recovery_blocked', 'completed', 'failed'].includes(
      operation.status,
    )
  )
    throw new Error('Context compression operation identity mismatch');
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
  // Slice by code point: a code-unit cut can leave a lone high surrogate, which
  // no store column keeps, so the server would persist it as '?'.
  const units = Array.from(title);
  return units.length <= 80 ? title : `${units.slice(0, 77).join('')}...`;
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

function requireMcpManagementSnapshot(
  snapshot: ManagedMcpManagementSnapshot,
  sessionId: string,
): ManagedMcpManagementSnapshot {
  if (
    snapshot.sessionId !== sessionId ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    typeof snapshot.supported !== 'boolean' ||
    !Array.isArray(snapshot.servers) ||
    !Array.isArray(snapshot.availableServers)
  )
    throw new Error('Managed MCP Session identity mismatch');
  return snapshot;
}

function storageKey(options: JavaManagedAgentProviderOptions): string {
  const base = new URL(
    options.baseUrl,
    typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  );
  base.search = '';
  base.hash = '';
  const baseKey = `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
  const scope = options.productScope ?? 'default';
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
