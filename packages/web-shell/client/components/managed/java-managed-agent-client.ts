import type {
  ManagedExtensionManifest,
  ManagedExtensionPin,
  ManagedExtensionCatalog,
  ManagedExtensionPackageOperation,
  ManagedExtensionSettings,
  ManagedExtensionSnapshot,
  ManagedExtensionSelection,
  ManagedExtensionImportMetadata,
  ManagedExtensionInspection,
  ManagedRuntimeSkillCandidates,
  ManagedRuntimeSkillSnapshot,
  ManagedRuntimeSkillImport,
  ManagedRuntimeSkillOwner,
} from './managed-extension-types';
import type { components } from './generated/managed-agent-api';
import {
  publicActionPageToJava,
  publicAdmissionFromSession,
  publicApprovalChangeResultToJava,
  publicCommandOperationToJava,
  publicContextCompressionToJava,
  publicDirectoryPageToJava,
  publicDirectoryToJava,
  publicEventToJava,
  publicFileQueryResultToJava,
  publicFileResultToJava,
  publicFileUploadResultToJava,
  publicFileUploadStatusToJava,
  publicItemListToJava,
  publicModelChangeResultToJava,
  publicOperationToJava,
  publicResyncToJava,
  publicRuntimeNodePageToJava,
  publicSessionApprovalToJava,
  publicSessionModelsToJava,
  publicSessionOptionsToJava,
  publicSessionPageToJava,
  publicSessionSkillsToJava,
  publicSessionToJava,
  publicSideQueryContextToJava,
  publicSideQueryPageToJava,
  publicSideQueryToJava,
  publicTaskEventPageToJava,
  publicTaskPageToJava,
  publicTaskToJava,
  publicToolDetailsToJava,
  publicTranscriptToJava,
  publicTurnAdmissionToJava,
  publicWorktreeInspectionToJava,
  publicWorktreeOptionsToJava,
  publicWorktreePageToJava,
  publicWorktreeToJava,
  publicWorkspacePageToJava,
  publicWorkspaceRegistrationToJava,
  publicWorkspaceSummaryToJava,
  publicWorkspaceToJava,
} from './java-managed-public-adapter';
import type { ManagedMcpManagementSnapshot } from './managed-mcp-management-types';
import type {
  ManagedWorkspaceFileQueryRequest,
  ManagedWorkspaceFileReadRequest,
  ManagedWorkspaceFileUploadRequest,
} from './managed-agent-provider';
import type {
  ManagedArtifact,
  ManagedArtifactPage,
  ManagedArtifactResponse,
  ManagedToolResultResponse,
} from './managed-tool-result-types';
import type {
  ManagedSideQuery,
  ManagedSideQueryCreate,
  ManagedSideQueryPage,
} from './managed-side-query-types';

import type {
  WebShellAction,
  WebShellActionPage,
  WebShellActionQueryRequest,
  WebShellActionRespondRequest,
  WebShellActivityQueryRequest,
  WebShellAdmission,
  WebShellApprovalChangeResult,
  WebShellCancelRequest,
  WebShellChangeApprovalRequest,
  WebShellChangeModelRequest,
  WebShellCommandOperation,
  WebShellContentPart,
  WebShellContextCompressionOperation,
  WebShellContextCompressionRequest,
  WebShellCreateRequest,
  WebShellDiagnosticTraceRequest,
  WebShellEvent,
  WebShellExportPage,
  WebShellExportRequest,
  WebShellItem,
  WebShellLifecycleRequest,
  WebShellListRequest,
  WebShellMcpManagementOperationQuery,
  WebShellMcpManagementQuery,
  WebShellMcpManagementSubmit,
  WebShellModelChangeResult,
  WebShellOperation,
  WebShellOperationRequest,
  WebShellRenameRequest,
  WebShellRenameResult,
  WebShellResyncRequired,
  WebShellSession,
  WebShellSessionApproval,
  WebShellSessionOptions,
  WebShellSessionPage,
  WebShellSessionWorktree,
  WebShellSessionWorktreeCleanupRequest,
  WebShellSessionWorktreeInspection,
  WebShellSessionWorktreeOptions,
  WebShellSessionWorktreeOptionsRequest,
  WebShellSessionWorktreePage,
  WebShellStreamRequest,
  WebShellSubmitRequest,
  WebShellTaskCancelRequest,
  WebShellTaskEventQueryRequest,
  WebShellTaskGetRequest,
  WebShellTaskQueryRequest,
  WebShellTerminalTicket,
  WebShellTranscript,
  WebShellTranscriptRequest,
  WebShellTurn,
  WebShellTurnAdmission,
  WebShellWorkspace,
  WebShellWorkspaceCreateRequest,
  WebShellWorkspaceDirectoryPage,
  WebShellWorkspaceDirectoryQueryRequest,
  WebShellWorkspaceDirectoryRequest,
  WebShellWorkspaceFilePage,
  WebShellWorkspaceFileSnapshot,
  WebShellWorkspaceFileUploadResult,
  WebShellWorkspaceFileUploadStatus,
  WebShellWorkspacePage,
  WebShellWorkspaceQueryRequest,
  WebShellWorkspaceRegisterRequest,
} from './java-agent-contract-types';
type Schemas = components['schemas'];

export type JavaAgentTurn = WebShellTurn;

export interface JavaAgentEnvironment {
  environmentId?: string;
  state?: string;
  errorCode?: string;
}

export type JavaAgentSession = Omit<WebShellSession, 'environment'> & {
  environment?: JavaAgentEnvironment | null;
};

export type JavaAgentWorkspace = WebShellWorkspace;

export type JavaAgentWorkspacePage = WebShellWorkspacePage;

export type JavaAgentSessionPage = Omit<WebShellSessionPage, 'data'> & {
  data: JavaAgentSession[];
};

export type JavaAgentEvent = WebShellEvent;

export type JavaAgentResyncRequired = WebShellResyncRequired;

export type JavaAgentTerminalTicket = WebShellTerminalTicket;

const RESYNC_REQUIRED = 'agent.session.resync_required';

// Corrupt frames tolerated in a row before the stream resyncs past the
// poisoned run. Only a decoded event resets the count: heartbeats must not
// dilute a stream that serves nothing but corrupt frames.
const MAX_CONSECUTIVE_CORRUPT_FRAMES = 3;
// Skip warnings are rate-limited per connection: the first carries the frame
// identity, and alternating corruption would otherwise log at stream rate.
const SKIP_LOG_EVERY = 50;

// The only corrupt frames a skip can survive: delta text the durable
// snapshot re-assembles. Anything else resyncs — a lost approval update
// leaves the Hosted approval unreachable, a lost turn terminal leaves the
// last message streaming forever, a lost turn.accepted drops the user's own
// prompt, a lost stream.reconciled keeps retracted text on screen, and an
// unknown name is by definition one the panel has not budgeted for.
export const SKIP_ON_CORRUPT: ReadonlySet<string> = new Set([
  'item.output_text.delta',
  'item.reasoning.delta',
]);

export function isJavaAgentResyncRequired(
  frame: JavaAgentEvent | JavaAgentResyncRequired,
): frame is JavaAgentResyncRequired {
  return frame.type === RESYNC_REQUIRED && !('sequence' in frame);
}

export type JavaAgentContentPart = WebShellContentPart;

export type JavaAgentItem = WebShellItem;

export type JavaAgentCommandAdmission = WebShellAdmission;
export type JavaAgentTurnAdmission = WebShellTurnAdmission;

export type JavaAgentTranscript = WebShellTranscript;
export type JavaAgentAction = WebShellAction;
export type JavaAgentActionPage = WebShellActionPage;

export interface JavaManagedAgentClientOptions {
  baseUrl: string;
  getHeaders?: () => HeadersInit | Promise<HeadersInit>;
  credentials?: RequestCredentials;
  fetch?: typeof fetch;
}

export class JavaManagedAgentHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'JavaManagedAgentHttpError';
  }
}

const API_PREFIX = '/v1/agents';

// The Managed Web Terminal ticket mint and WebSocket upgrade stay on the
// broker-mounted WebShell surface: that is where the deployment authentication
// headers are available and where the Runtime Broker mounts the relay. Every
// other client method uses the Public surface above.
const WEBSHELL_API_PREFIX = '/api/agent/web-shell/v1';

/** Builds a Public query string, dropping null/undefined parameters. */
function query(
  params: Record<string, string | number | boolean | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

/** The create/rename replay flag rides this response header on the Public
 * surface instead of a body field. */
const REPLAY_HEADER = 'x-qwen-idempotent-replay';

function replayedFrom(response: Response): boolean {
  return response.headers.get(REPLAY_HEADER) === 'true';
}

const enc = encodeURIComponent;

/** The Public create body; requestId is dropped (the server assigns its own
 * X-Request-Id) and idempotencyKey travels as a header, not a body field. */
function publicCreateBody(
  request: WebShellCreateRequest,
): Schemas['CreateSessionRequest'] {
  return {
    agent_id: request.agentId,
    model_config: request.modelConfig,
    input: request.input,
    metadata: request.metadata ?? undefined,
    workspace: request.workspace
      ? {
          workspace_id: request.workspace.workspaceId,
          cwd_relative: request.workspace.cwdRelative,
        }
      : undefined,
    skills: request.skills,
    // The Public create contract keeps this one camelCase field.
    extensionPins: request.extensionPins,
    worktree: request.worktree
      ? { base_ref: request.worktree.baseRef }
      : undefined,
    memory_store_id: request.memoryStoreId,
    title: request.title,
    approval_mode: request.approvalMode,
    plan_mode: request.planMode,
    model_id: request.modelId,
  };
}

function publicActionResponse(
  response: WebShellActionRespondRequest['response'],
): Schemas['PermissionResponse'] | Schemas['QuestionResponse'] {
  if (response.kind === 'permission') {
    return {
      kind: 'permission',
      input_revision: response.inputRevision,
      policy_revision: response.policyRevision,
      option_id: response.optionId,
    };
  }
  return {
    kind: 'question',
    input_revision: response.inputRevision,
    policy_revision: response.policyRevision,
    answers: response.answers.map((answer) => ({
      question_id: answer.questionId,
      option_ids: answer.optionIds,
      text: answer.text,
    })),
  };
}

export class JavaManagedAgentClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly credentials: RequestCredentials;

  constructor(private readonly options: JavaManagedAgentClientOptions) {
    const base = new URL(
      options.baseUrl,
      typeof window === 'undefined'
        ? 'http://localhost'
        : window.location.origin,
    );
    base.search = '';
    base.hash = '';
    this.baseUrl = `${base.origin}${base.pathname.replace(/\/+$/, '')}`;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.credentials = options.credentials ?? 'include';
  }

  async listSessions(
    request: WebShellListRequest,
    signal?: AbortSignal,
  ): Promise<JavaAgentSessionPage> {
    const page = await this.get<Schemas['PublicSessionList']>(
      `/sessions${query({
        cursor: request.cursor,
        limit: request.limit,
        archive_state: request.archiveState,
        title_query: request.titleQuery,
      })}`,
      signal,
    );
    return publicSessionPageToJava(page) as JavaAgentSessionPage;
  }

  async getSession(sessionId: string, signal?: AbortSignal) {
    const session = await this.get<Schemas['PublicSession']>(
      `/sessions/${enc(sessionId)}`,
      signal,
    );
    return publicSessionToJava(session) as JavaAgentSession;
  }

  terminalTicket(
    sessionId: string,
    terminalId: string,
    signal?: AbortSignal,
  ): Promise<JavaAgentTerminalTicket> {
    return this.post(
      '/sessions/terminal-ticket',
      { sessionId, terminalId },
      signal,
      undefined,
      WEBSHELL_API_PREFIX,
    );
  }

  terminalWebSocketUrl(sessionId: string, terminalId: string): string {
    const url = new URL(
      `${this.baseUrl}${WEBSHELL_API_PREFIX}/sessions/${encodeURIComponent(sessionId)}/terminal`,
    );
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('terminalId', terminalId);
    url.searchParams.set('replay', '1');
    return url.toString();
  }

  getRecovery(sessionId: string, signal?: AbortSignal) {
    return this.get<Schemas['SessionRecovery']>(
      `/sessions/${enc(sessionId)}/recovery`,
      signal,
    );
  }

  recheckRecovery(sessionId: string, turnId: string, signal?: AbortSignal) {
    // The Public recheck body keeps the camelCase turnId field.
    return this.post<Schemas['SessionRecovery']>(
      `/sessions/${enc(sessionId)}/recovery/recheck`,
      { turnId },
      signal,
    );
  }

  async renameSession(
    request: WebShellRenameRequest,
    signal?: AbortSignal,
  ): Promise<WebShellRenameResult> {
    const response = await this.request(
      `/sessions/${enc(request.sessionId)}`,
      { title: request.title },
      signal,
      false,
      'PATCH',
      request.idempotencyKey,
    );
    if (response.status !== 200) {
      throw new JavaManagedAgentHttpError(
        response.status,
        'session_rename_unconfirmed',
        'Managed Agent rename was not confirmed',
      );
    }
    const session = (await response.json()) as Schemas['PublicSession'];
    return {
      sessionId: session.id,
      // A confirmed rename always carries the stored title; an absent or
      // null one is an anomalous confirmation. Yield '' so the provider's
      // trim guard refuses it, as the WebShell-era required-title contract
      // did — do not paper over it with the requested title.
      title: session.title ?? '',
      replayed: replayedFrom(response),
    };
  }

  async listWorkspaces(
    request: WebShellWorkspaceQueryRequest,
    signal?: AbortSignal,
  ): Promise<JavaAgentWorkspacePage> {
    const page = await this.get<Schemas['PublicWorkspaceList']>(
      `/workspaces${query({ cursor: request.cursor, limit: request.limit })}`,
      signal,
    );
    return publicWorkspacePageToJava(page);
  }

  async getWorkspace(workspaceId: string, signal?: AbortSignal) {
    const workspace = await this.get<Schemas['PublicWorkspace']>(
      `/workspaces/${enc(workspaceId)}`,
      signal,
    );
    return publicWorkspaceToJava(workspace);
  }

  async listRuntimeNodes(signal?: AbortSignal) {
    const page = await this.get<Schemas['PublicRuntimeNodePage']>(
      '/runtime-nodes',
      signal,
    );
    return publicRuntimeNodePageToJava(page);
  }

  async checkWorkspaceDirectory(
    request: WebShellWorkspaceDirectoryRequest,
    signal?: AbortSignal,
  ) {
    const directory = await this.post<Schemas['PublicWorkspaceDirectory']>(
      `/runtime-nodes/${enc(request.nodeId)}/check-directory`,
      { path: request.path },
      signal,
    );
    return publicDirectoryToJava(directory);
  }

  async registerWorkspace(
    request: WebShellWorkspaceRegisterRequest,
    signal?: AbortSignal,
  ) {
    const operation = await this.post<
      Schemas['PublicWorkspaceRegistrationOperation']
    >(
      '/workspaces/registrations',
      {
        node_id: request.nodeId,
        path: request.path,
        display_name: request.displayName,
      },
      signal,
      request.idempotencyKey,
    );
    return publicWorkspaceRegistrationToJava(operation);
  }

  async getWorkspaceOperation(operationId: string, signal?: AbortSignal) {
    const operation = await this.get<
      Schemas['PublicWorkspaceRegistrationOperation']
    >(`/workspaces/registrations/${enc(operationId)}`, signal);
    return publicWorkspaceRegistrationToJava(operation);
  }

  async createWorkspace(
    request: WebShellWorkspaceCreateRequest,
    signal?: AbortSignal,
  ): Promise<JavaAgentWorkspace> {
    const summary = await this.post<Schemas['PublicWorkspaceSummary']>(
      '/workspaces',
      {
        display_name: request.displayName,
        source_workspace_id: request.sourceWorkspaceId,
        cwd_relative: request.cwdRelative,
        local_path: request.localPath,
      },
      signal,
      request.idempotencyKey,
    );
    return publicWorkspaceSummaryToJava(summary);
  }

  async queryWorkspaceFiles(
    request: ManagedWorkspaceFileQueryRequest,
    signal?: AbortSignal,
  ): Promise<WebShellWorkspaceFilePage> {
    const result = await this.get<Schemas['PublicFileQueryResult']>(
      `/workspace-files${query({
        session_id: request.sessionId,
        workspace_id: request.workspaceId,
        cwd_relative: request.cwdRelative,
        directory: request.directory,
        query: request.query,
        expected_scope_revision: request.expectedScopeRevision,
      })}`,
      signal,
    );
    return publicFileQueryResultToJava(result);
  }

  async readWorkspaceFile(
    request: ManagedWorkspaceFileReadRequest,
    signal?: AbortSignal,
  ): Promise<WebShellWorkspaceFileSnapshot> {
    const result = await this.get<Schemas['PublicFileResult']>(
      `/workspace-files/content${query({
        session_id: request.sessionId,
        workspace_id: request.workspaceId,
        cwd_relative: request.cwdRelative,
        path: request.path,
        expected_scope_revision: request.expectedScopeRevision,
      })}`,
      signal,
    );
    return publicFileResultToJava(result);
  }

  async uploadWorkspaceFile(
    request: ManagedWorkspaceFileUploadRequest,
    data: Blob,
    signal?: AbortSignal,
  ): Promise<WebShellWorkspaceFileUploadResult> {
    const search = query({
      session_id: request.sessionId,
      workspace_id: request.workspaceId,
      cwd_relative: request.cwdRelative,
      path: request.path,
      expected_scope_revision: request.expectedScopeRevision,
      upload_id: request.uploadId,
    });
    const response = await this.fetchRequest(
      `/workspace-files/uploads${search}`,
      data,
      signal,
      false,
      'application/octet-stream',
    );
    return publicFileUploadResultToJava(
      (await response.json()) as Schemas['PublicFileUploadResult'],
    );
  }

  async queryWorkspaceFileUpload(
    uploadId: string,
    signal?: AbortSignal,
  ): Promise<WebShellWorkspaceFileUploadStatus> {
    const status = await this.get<Schemas['PublicFileUploadStatus']>(
      `/workspace-files/uploads/${enc(uploadId)}`,
      signal,
    );
    return publicFileUploadStatusToJava(status);
  }

  async workspaceDirectories(
    request: WebShellWorkspaceDirectoryQueryRequest,
    signal?: AbortSignal,
  ): Promise<WebShellWorkspaceDirectoryPage> {
    const page = await this.get<Schemas['PublicWorkspaceDirectoryPage']>(
      `/workspaces/directories${query(
        'workspaceId' in request
          ? {
              workspace_id: request.workspaceId,
              cwd_relative: request.cwdRelative,
            }
          : { local_path: request.localPath },
      )}`,
      signal,
    );
    return publicDirectoryPageToJava(page);
  }

  async getSessionApproval(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<WebShellSessionApproval> {
    const approval = await this.get<Schemas['PublicSessionApproval']>(
      `/sessions/${enc(sessionId)}/approval`,
      signal,
    );
    return publicSessionApprovalToJava(approval);
  }

  async changeApproval(
    request: WebShellChangeApprovalRequest,
    signal?: AbortSignal,
  ): Promise<WebShellApprovalChangeResult> {
    const result = await this.post<Schemas['PublicApprovalChangeResult']>(
      `/sessions/${enc(request.sessionId)}/approval`,
      {
        approval_mode: request.approvalMode,
        expected_revision: request.expectedRevision,
        plan_mode: request.planMode,
        permission_rules: request.permissionRules,
      },
      signal,
      request.idempotencyKey,
    );
    return publicApprovalChangeResultToJava(result);
  }

  async getSessionOptions(
    agentId: string,
    signal?: AbortSignal,
  ): Promise<WebShellSessionOptions> {
    const options = await this.get<Schemas['PublicSessionOptions']>(
      `/session-options${query({ agent_id: agentId })}`,
      signal,
    );
    return publicSessionOptionsToJava(options);
  }

  async lifecycleCommand(
    kind: 'close' | 'archive' | 'delete',
    request: WebShellLifecycleRequest,
    signal?: AbortSignal,
  ) {
    const path =
      kind === 'delete'
        ? `/sessions/${enc(request.sessionId)}`
        : `/sessions/${enc(request.sessionId)}/${kind}`;
    const operation = await this.request(
      path,
      undefined,
      signal,
      false,
      kind === 'delete' ? 'DELETE' : 'POST',
      request.idempotencyKey,
    );
    return publicCommandOperationToJava(
      (await operation.json()) as Schemas['PublicCommandOperation'],
    );
  }

  async unarchiveSession(
    request: WebShellLifecycleRequest,
    signal?: AbortSignal,
  ) {
    const response = await this.request(
      `/sessions/${enc(request.sessionId)}/unarchive`,
      undefined,
      signal,
      false,
      'POST',
      request.idempotencyKey,
    );
    return publicSessionToJava(
      (await response.json()) as Schemas['PublicSession'],
    ) as JavaAgentSession;
  }

  async exportSnapshot(
    request: WebShellExportRequest,
    signal?: AbortSignal,
  ): Promise<WebShellExportPage> {
    const page = await this.get<Schemas['PublicItemList']>(
      `/sessions/${enc(request.sessionId)}/export${query({
        cursor: request.cursor,
        limit: request.limit,
      })}`,
      signal,
    );
    return publicItemListToJava(page);
  }

  async getTranscript(
    request: WebShellTranscriptRequest,
    signal?: AbortSignal,
  ): Promise<JavaAgentTranscript> {
    const transcript = await this.get<Schemas['PublicTranscript']>(
      `/sessions/${enc(request.sessionId)}/transcript${query({
        cursor: request.cursor,
        limit: request.limit,
      })}`,
      signal,
    );
    return publicTranscriptToJava(transcript);
  }

  async getRecentTranscriptItems(
    request: WebShellExportRequest,
    signal?: AbortSignal,
  ): Promise<WebShellExportPage> {
    const page = await this.get<Schemas['PublicItemList']>(
      `/sessions/${enc(request.sessionId)}/transcript/items${query({
        cursor: request.cursor,
        limit: request.limit,
      })}`,
      signal,
    );
    return publicItemListToJava(page);
  }

  async createSession(
    request: WebShellCreateRequest,
    signal?: AbortSignal,
  ): Promise<JavaAgentCommandAdmission> {
    const response = await this.request(
      '/sessions',
      publicCreateBody(request),
      signal,
      false,
      'POST',
      request.idempotencyKey,
    );
    const session = (await response.json()) as Schemas['PublicSession'];
    return publicAdmissionFromSession(session, replayedFrom(response));
  }

  async worktreeOptions(
    request: WebShellSessionWorktreeOptionsRequest,
    signal?: AbortSignal,
  ): Promise<WebShellSessionWorktreeOptions> {
    const options = await this.get<Schemas['SessionWorktreeOptions']>(
      `/workspaces/${enc(request.workspaceId)}/worktrees/options${query({
        cwd_relative: request.cwdRelative,
        base_ref: request.baseRef,
      })}`,
      signal,
    );
    return publicWorktreeOptionsToJava(options);
  }

  async listSessionWorktrees(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WebShellSessionWorktreePage> {
    const page = await this.get<Schemas['SessionWorktreePage']>(
      `/workspaces/${enc(workspaceId)}/worktrees`,
      signal,
    );
    return publicWorktreePageToJava(page);
  }

  async inspectSessionWorktree(
    workspaceId: string,
    worktreeId: string,
    signal?: AbortSignal,
  ): Promise<WebShellSessionWorktreeInspection> {
    const inspection = await this.get<Schemas['SessionWorktreeInspection']>(
      `/workspaces/${enc(workspaceId)}/worktrees/${enc(worktreeId)}`,
      signal,
    );
    return publicWorktreeInspectionToJava(inspection);
  }

  async cleanupSessionWorktree(
    request: WebShellSessionWorktreeCleanupRequest,
    signal?: AbortSignal,
  ): Promise<WebShellSessionWorktree> {
    const response = await this.request(
      `/workspaces/${enc(request.workspaceId)}/worktrees/${enc(request.worktreeId)}/cleanup`,
      undefined,
      signal,
      false,
      'POST',
      request.idempotencyKey,
    );
    return publicWorktreeToJava(
      (await response.json()) as Schemas['SessionWorktree'],
    );
  }

  async submitTurn(
    request: WebShellSubmitRequest,
    signal?: AbortSignal,
  ): Promise<JavaAgentTurnAdmission> {
    // The Public input event carries only type + input; the WebShell
    // metadata echo has no Public counterpart and is dropped.
    const admission = await this.post<Schemas['TurnCommandAdmission']>(
      `/sessions/${enc(request.sessionId)}/events`,
      { type: 'agent.session.input.message', input: request.input ?? [] },
      signal,
      request.idempotencyKey,
    );
    return publicTurnAdmissionToJava(admission);
  }

  async cancelTurn(
    request: WebShellCancelRequest,
    signal?: AbortSignal,
  ): Promise<JavaAgentTurnAdmission> {
    const admission = await this.post<Schemas['TurnCommandAdmission']>(
      `/sessions/${enc(request.sessionId)}/events`,
      { type: 'agent.session.cancel', turn_id: request.turnId },
      signal,
      request.idempotencyKey,
    );
    return publicTurnAdmissionToJava(admission);
  }

  async queryActions(
    request: WebShellActionQueryRequest,
    signal?: AbortSignal,
  ): Promise<JavaAgentActionPage> {
    const page = await this.get<Schemas['PublicActionList']>(
      `/sessions/${enc(request.sessionId)}/actions${query({
        cursor: request.cursor,
        limit: request.limit,
        include_children: request.includeChildren,
      })}`,
      signal,
    );
    return publicActionPageToJava(page);
  }

  async listTasks(request: WebShellTaskQueryRequest, signal?: AbortSignal) {
    const page = await this.get<Schemas['PublicTaskList']>(
      `/sessions/${enc(request.sessionId)}/tasks${query({
        cursor: request.cursor,
        limit: request.limit,
      })}`,
      signal,
    );
    return publicTaskPageToJava(page);
  }

  async getTask(request: WebShellTaskGetRequest, signal?: AbortSignal) {
    const task = await this.get<Schemas['PublicTask']>(
      `/sessions/${enc(request.sessionId)}/tasks/${enc(request.taskId)}`,
      signal,
    );
    return publicTaskToJava(task);
  }

  async listTaskEvents(
    request: WebShellTaskEventQueryRequest,
    signal?: AbortSignal,
  ) {
    const page = await this.get<{
      object: 'list';
      data: Schemas['PublicTaskEvent'][];
      has_more: boolean;
      next_cursor?: string | null;
    }>(
      `/sessions/${enc(request.sessionId)}/tasks/${enc(request.taskId)}/events${query(
        { after: request.after, limit: request.limit },
      )}`,
      signal,
    );
    return publicTaskEventPageToJava(page);
  }

  async cancelTask(
    request: WebShellTaskCancelRequest,
    signal?: AbortSignal,
  ): Promise<WebShellCommandOperation> {
    const operation = await this.request(
      `/sessions/${enc(request.sessionId)}/tasks/${enc(request.taskId)}/cancel`,
      undefined,
      signal,
      false,
      'POST',
      request.idempotencyKey,
    );
    return publicCommandOperationToJava(
      (await operation.json()) as Schemas['PublicCommandOperation'],
    );
  }

  async respondAction(
    request: WebShellActionRespondRequest,
    signal?: AbortSignal,
  ): Promise<WebShellCommandOperation> {
    const operation = await this.post<Schemas['PublicCommandOperation']>(
      `/sessions/${enc(request.sessionId)}/actions/${enc(request.actionId)}/responses`,
      publicActionResponse(request.response),
      signal,
      request.idempotencyKey,
    );
    return publicCommandOperationToJava(operation);
  }

  /** Reads an operation's latest durable status; polling is not a replay. */
  async queryOperation(
    request: WebShellOperationRequest,
    signal?: AbortSignal,
  ): Promise<WebShellOperation> {
    const operation = await this.get<Schemas['PublicOperation']>(
      `/sessions/${enc(request.sessionId)}/operations/${enc(request.operationId)}`,
      signal,
    );
    return publicOperationToJava(operation);
  }

  async compressContext(
    request: WebShellContextCompressionRequest,
    signal?: AbortSignal,
  ): Promise<WebShellContextCompressionOperation> {
    const operation = await this.post<
      Schemas['PublicContextCompressionOperation']
    >(
      `/sessions/${enc(request.sessionId)}/compress`,
      { expected_compaction_revision: request.expectedCompactionRevision },
      signal,
      request.idempotencyKey,
    );
    return publicContextCompressionToJava(operation);
  }

  async getSessionModels(sessionId: string, signal?: AbortSignal) {
    const models = await this.get<Schemas['PublicSessionModels']>(
      `/sessions/${enc(sessionId)}/models`,
      signal,
    );
    return publicSessionModelsToJava(models);
  }

  async getSessionSkills(sessionId: string, signal?: AbortSignal) {
    const skills = await this.get<Schemas['PublicSessionSkills']>(
      `/sessions/${enc(sessionId)}/skills`,
      signal,
    );
    return publicSessionSkillsToJava(skills);
  }

  getDiagnosticContextUsage(sessionId: string, signal?: AbortSignal) {
    return this.get<Schemas['ManagedDiagnosticContextUsage']>(
      `/sessions/${enc(sessionId)}/context-usage`,
      signal,
    );
  }

  getDiagnosticStatistics(sessionId: string, signal?: AbortSignal) {
    return this.get<Schemas['ManagedDiagnosticStats']>(
      `/sessions/${enc(sessionId)}/stats`,
      signal,
    );
  }

  getActivityStatistics(sessionId: string, signal?: AbortSignal) {
    return this.get<Schemas['ManagedDiagnosticActivityStats']>(
      `/sessions/${enc(sessionId)}/activity-stats`,
      signal,
    );
  }

  listActivity(request: WebShellActivityQueryRequest, signal?: AbortSignal) {
    return this.get<Schemas['ManagedDiagnosticActivityPage']>(
      `/sessions/${enc(request.sessionId)}/activity${query({
        kind: request.kind,
        cursor: request.cursor,
        limit: request.limit,
      })}`,
      signal,
    );
  }

  getDiagnosticResources(sessionId: string, signal?: AbortSignal) {
    return this.get<Schemas['ManagedDiagnosticResources']>(
      `/sessions/${enc(sessionId)}/resources`,
      signal,
    );
  }

  listDiagnosticAgentTrace(
    request: WebShellDiagnosticTraceRequest,
    signal?: AbortSignal,
  ) {
    return this.get<Schemas['ManagedDiagnosticAgentTrace']>(
      `/sessions/${enc(request.sessionId)}/agent-trace${query({
        cursor: request.cursor,
        limit: request.limit,
      })}`,
      signal,
    );
  }

  getSessionMcp(sessionId: string, signal?: AbortSignal) {
    return this.get<Schemas['PublicMcpCatalog']>(
      `/sessions/${enc(sessionId)}/mcp-catalog`,
      signal,
    );
  }

  /**
   * The transport the client filesystem bridge drives: the Managed API
   * origin base plus a fetch that attaches the provider's auth headers
   * (resolved per call so token refresh is honoured) and credentials. The
   * bridge owns the register/SSE/response exchange and appends the
   * per-session Public client-files path; this only supplies the
   * authenticated pipe.
   */
  clientFilesTransport(): {
    baseUrl: string;
    fetch: import('../../local-files/managed-client-files-bridge.js').ManagedFetch;
  } {
    return {
      baseUrl: this.baseUrl,
      fetch: async (url, init) => {
        const supplied = await this.options.getHeaders?.();
        const headers = new Headers(supplied);
        if (init?.headers) {
          for (const [key, value] of Object.entries(init.headers)) {
            headers.set(key, value);
          }
        }
        if (!headers.has('content-type')) {
          headers.set('content-type', 'application/json');
        }
        return this.fetchImpl(url, {
          method: init?.method,
          headers,
          body: init?.body,
          signal: init?.signal,
          credentials: this.credentials,
        });
      },
    };
  }

  listExtensionPackages(workspaceId: string, signal?: AbortSignal) {
    return this.get<ManagedExtensionCatalog>(
      `/workspaces/${enc(workspaceId)}/extensions`,
      signal,
    );
  }

  async publishExtensionPackage(
    workspaceId: string,
    extensionId: string | undefined,
    packageDigest: string,
    manifest: ManagedExtensionManifest,
    archive: Blob,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ManagedExtensionPackageOperation> {
    if (archive.size > 100 * 1024 * 1024)
      throw new Error('Managed package exceeds 100 MiB');
    const encoded = btoa(
      String.fromCharCode(
        ...new TextEncoder().encode(JSON.stringify(manifest)),
      ),
    )
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    // Publishing a new package creates the extension; publishing a new
    // revision of an existing one targets it directly.
    const target = extensionId
      ? `${this.baseUrl}${API_PREFIX}/workspaces/${enc(workspaceId)}/extensions/${enc(extensionId)}/packages/${enc(packageDigest)}?${new URLSearchParams({ manifest: encoded })}`
      : `${this.baseUrl}${API_PREFIX}/workspaces/${enc(workspaceId)}/extensions?${new URLSearchParams({ packageDigest, manifest: encoded })}`;
    const headers = new Headers(await this.options.getHeaders?.());
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Idempotency-Key', idempotencyKey);
    const response = await this.fetchImpl(target, {
      method: extensionId ? 'PUT' : 'POST',
      headers,
      body: archive,
      credentials: this.credentials,
      signal,
    });
    if (!response.ok) throw await toHttpError(response);
    return response.json();
  }

  getExtensionSettings(
    workspaceId: string,
    extensionId: string,
    signal?: AbortSignal,
  ) {
    return this.get<ManagedExtensionSettings>(
      `/workspaces/${enc(workspaceId)}/extensions/${enc(extensionId)}/settings`,
      signal,
    );
  }

  async importExtensionPackage(
    workspaceId: string,
    extensionId: string | undefined,
    metadata: ManagedExtensionImportMetadata,
    source: Blob,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ManagedExtensionPackageOperation> {
    if (source.size > 100 * 1024 * 1024)
      throw new Error('Managed package exceeds 100 MiB');
    const search = new URLSearchParams({
      metadata: JSON.stringify(metadata),
    });
    if (extensionId) search.set('extensionId', extensionId);
    const headers = new Headers(await this.options.getHeaders?.());
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Idempotency-Key', idempotencyKey);
    const response = await this.fetchImpl(
      `${this.baseUrl}${API_PREFIX}/workspaces/${enc(workspaceId)}/extensions/imports?${search}`,
      {
        method: 'POST',
        headers,
        body: source,
        credentials: this.credentials,
        signal,
      },
    );
    if (!response.ok) throw await toHttpError(response);
    return response.json();
  }

  inspectExtensionPackage(
    workspaceId: string,
    pin: ManagedExtensionPin,
    signal?: AbortSignal,
  ) {
    return this.get<ManagedExtensionInspection>(
      `/workspaces/${enc(workspaceId)}/extensions/${enc(pin.extensionId)}/packages/${enc(String(pin.packageRevision))}/inspection${query({ packageDigest: pin.packageDigest })}`,
      signal,
    );
  }

  async previewExtensionPackage(
    workspaceId: string,
    metadata: ManagedExtensionImportMetadata,
    source: Blob,
    signal?: AbortSignal,
  ): Promise<ManagedExtensionInspection> {
    if (source.size > 100 * 1024 * 1024)
      throw new Error('Managed package exceeds 100 MiB');
    const search = new URLSearchParams({
      metadata: JSON.stringify(metadata),
    });
    const headers = new Headers(await this.options.getHeaders?.());
    headers.set('Content-Type', 'application/octet-stream');
    const response = await this.fetchImpl(
      `${this.baseUrl}${API_PREFIX}/workspaces/${enc(workspaceId)}/extensions/imports/preview?${search}`,
      {
        method: 'POST',
        headers,
        body: source,
        credentials: this.credentials,
        signal,
      },
    );
    if (!response.ok) throw await toHttpError(response);
    return response.json();
  }

  lookupExtensionPackageOperation(
    workspaceId: string,
    kind: 'publish' | 'settings',
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    // The lookup body keeps camelCase and carries the key in the body: it
    // is a read-only receipt query, not a mutation.
    return this.post<ManagedExtensionPackageOperation>(
      `/workspaces/${enc(workspaceId)}/extensions/operations/lookup`,
      { kind, idempotencyKey },
      signal,
    );
  }

  lookupExtensionApplyOperation(
    sessionId: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    return this.post<ManagedExtensionSnapshot>(
      `/sessions/${enc(sessionId)}/extensions/operations/lookup`,
      { idempotencyKey },
      signal,
    );
  }

  getRuntimeSkillCandidates(sessionId: string, signal?: AbortSignal) {
    return this.get<ManagedRuntimeSkillCandidates>(
      `/sessions/${enc(sessionId)}/extensions/skills/candidates`,
      signal,
    );
  }

  snapshotRuntimeSkill(
    sessionId: string,
    input: {
      owner: ManagedRuntimeSkillOwner;
      path: string;
      digest: string;
      target: ManagedExtensionImportMetadata['target'];
    },
    signal?: AbortSignal,
  ) {
    return this.post<ManagedRuntimeSkillSnapshot>(
      `/sessions/${enc(sessionId)}/extensions/skills/snapshot`,
      input,
      signal,
    );
  }

  importRuntimeSkill(
    sessionId: string,
    input: ManagedRuntimeSkillImport & { extensionId?: string },
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    return this.post<ManagedExtensionPackageOperation>(
      `/sessions/${enc(sessionId)}/extensions/skills/imports`,
      input,
      signal,
      idempotencyKey,
    );
  }

  saveExtensionSettings(
    workspaceId: string,
    extensionId: string,
    expectedRevision: number,
    values: Record<string, string>,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    return this.post<ManagedExtensionPackageOperation>(
      `/workspaces/${enc(workspaceId)}/extensions/${enc(extensionId)}/settings`,
      { expectedRevision, values },
      signal,
      idempotencyKey,
    );
  }

  queryExtensionConfiguration(
    sessionId: string,
    operationId?: string,
    signal?: AbortSignal,
  ) {
    return this.get<ManagedExtensionSnapshot>(
      operationId
        ? `/sessions/${enc(sessionId)}/extensions/operations/${enc(operationId)}`
        : `/sessions/${enc(sessionId)}/extensions`,
      signal,
    );
  }

  applyExtensionConfiguration(
    sessionId: string,
    command: ManagedExtensionSelection,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    return this.post<ManagedExtensionSnapshot>(
      `/sessions/${enc(sessionId)}/extensions`,
      command,
      signal,
      idempotencyKey,
    );
  }

  resumeExtensionConfiguration(
    sessionId: string,
    operationId: string,
    recoverPrevious: boolean,
    signal?: AbortSignal,
  ) {
    return this.post<ManagedExtensionSnapshot>(
      `/sessions/${enc(sessionId)}/extensions/operations/${enc(operationId)}/${recoverPrevious ? 'recover-previous' : 'continue'}`,
      undefined,
      signal,
    );
  }

  getExtensionPackage(
    workspaceId: string,
    pin: ManagedExtensionPin,
    signal?: AbortSignal,
  ) {
    return this.get<ManagedExtensionCatalog['extensions'][number]>(
      `/workspaces/${enc(workspaceId)}/extensions/${enc(pin.extensionId)}/packages/${enc(String(pin.packageRevision))}${query({ packageDigest: pin.packageDigest })}`,
      signal,
    );
  }

  queryMcpManagement(
    request: WebShellMcpManagementQuery,
    signal?: AbortSignal,
  ) {
    return this.get<ManagedMcpManagementSnapshot>(
      `/sessions/${enc(request.sessionId)}/mcp-management`,
      signal,
    );
  }

  submitMcpManagement(
    request: WebShellMcpManagementSubmit,
    signal?: AbortSignal,
  ) {
    // The Public command body keeps the camelCase server pin fields.
    return this.post<ManagedMcpManagementSnapshot>(
      `/sessions/${enc(request.sessionId)}/mcp-management/commands`,
      {
        action: request.action,
        serverId: request.serverId,
        expectedRevision: request.expectedRevision,
        server: request.server,
      },
      signal,
      request.idempotencyKey,
    );
  }

  getMcpManagementOperation(
    request: WebShellMcpManagementOperationQuery,
    signal?: AbortSignal,
  ) {
    return this.get<ManagedMcpManagementSnapshot>(
      `/sessions/${enc(request.sessionId)}/mcp-management/commands/${enc(request.operationId)}`,
      signal,
    );
  }

  async changeModel(
    request: WebShellChangeModelRequest,
    signal?: AbortSignal,
  ): Promise<WebShellModelChangeResult> {
    const result = await this.post<Schemas['PublicModelChangeResult']>(
      `/sessions/${enc(request.sessionId)}/models`,
      {
        model_id: request.modelId,
        expected_revision: request.expectedRevision,
      },
      signal,
      request.idempotencyKey,
    );
    return publicModelChangeResultToJava(result);
  }

  async getToolDetails(
    sessionId: string,
    itemId: string,
    signal?: AbortSignal,
  ) {
    const details = await this.get<Schemas['PublicToolDetails']>(
      `/sessions/${enc(sessionId)}/items/${enc(itemId)}/tool-details`,
      signal,
    );
    return publicToolDetailsToJava(details);
  }

  getToolResult(sessionId: string, itemId: string, signal?: AbortSignal) {
    return this.get<ManagedToolResultResponse>(
      `/sessions/${enc(sessionId)}/items/${enc(itemId)}/tool-result`,
      signal,
    );
  }

  async listArtifacts(
    request: { sessionId: string; cursor?: string; limit?: number },
    signal?: AbortSignal,
  ) {
    const page = await this.get<Schemas['PublicArtifactList']>(
      `/sessions/${enc(request.sessionId)}/artifacts${query({
        cursor: request.cursor,
        limit: request.limit,
      })}`,
      signal,
    );
    const adapted: ManagedArtifactPage = {
      data: page.data,
      nextCursor: page.next_cursor ?? null,
      hasMore: page.has_more,
    };
    return adapted;
  }

  getArtifact(sessionId: string, artifactId: string, signal?: AbortSignal) {
    return this.get<ManagedArtifactResponse>(
      `/sessions/${enc(sessionId)}/artifacts/${enc(artifactId)}`,
      signal,
    );
  }

  async readArtifactRange(
    artifact: ManagedArtifact,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 1 ||
      length > 1024 * 1024 ||
      offset >= artifact.byte_length
    ) {
      throw new Error('Invalid artifact byte range');
    }
    const end = Math.min(offset + length, artifact.byte_length) - 1;
    const response = await this.artifactContent(
      artifact,
      signal,
      `bytes=${offset}-${end}`,
    );
    if (
      response.status !== 206 ||
      response.headers.get('content-range') !==
        `bytes ${offset}-${end}/${artifact.byte_length}`
    ) {
      await response.body?.cancel();
      throw new Error('Artifact response does not match the requested range');
    }
    const bytes = new Uint8Array(end - offset + 1);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Artifact response has no byte stream');
    let received = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (received + chunk.value.byteLength > bytes.byteLength) {
          throw new Error('Artifact response exceeds the requested range');
        }
        bytes.set(chunk.value, received);
        received += chunk.value.byteLength;
      }
      if (received !== bytes.byteLength) {
        throw new Error('Artifact response ended before the requested range');
      }
      return bytes;
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async openArtifactStream(
    artifact: ManagedArtifact,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await this.artifactContent(artifact, signal);
    if (
      response.status !== 200 ||
      response.headers.get('content-length') !== String(artifact.byte_length) ||
      !response.body
    ) {
      await response.body?.cancel();
      throw new Error('Artifact download does not match its metadata');
    }
    let received = 0;
    return response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (received > artifact.byte_length) {
            throw new Error('Artifact download exceeds its declared length');
          }
          controller.enqueue(chunk);
        },
        flush() {
          if (received !== artifact.byte_length) {
            throw new Error('Artifact download is incomplete');
          }
        },
      }),
      { signal },
    );
  }

  private async artifactContent(
    artifact: ManagedArtifact,
    signal?: AbortSignal,
    range?: string,
  ): Promise<Response> {
    if (
      !/^[a-f0-9]{64}$/.test(artifact.revision) ||
      artifact.sha256 !== artifact.revision ||
      !Number.isSafeInteger(artifact.byte_length) ||
      artifact.byte_length < 0
    ) {
      throw new Error('Artifact byte identity is invalid');
    }
    const headers = new Headers(await this.options.getHeaders?.());
    headers.set('accept', 'application/octet-stream');
    headers.set('if-match', `"${artifact.sha256}"`);
    if (range) headers.set('range', range);
    const path = `/v1/agents/sessions/${encodeURIComponent(artifact.session_id)}/artifacts/${encodeURIComponent(artifact.id)}/content`;
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await this.fetchImpl(
        `${this.baseUrl}${path}?revision=${encodeURIComponent(artifact.revision)}`,
        {
          method: 'GET',
          headers,
          credentials: this.credentials,
          signal,
          redirect: 'error',
        },
      );
      if (attempt > 0 || ![429, 503].includes(response.status)) break;
      const retryAfter = response.headers.get('retry-after');
      const delay =
        retryAfter === null
          ? 1000
          : Number.isFinite(Number(retryAfter))
            ? Number(retryAfter) * 1000
            : Date.parse(retryAfter) - Date.now();
      const wait = Number.isFinite(delay) ? Math.max(0, delay) : 1000;
      if (wait > 5000) break;
      await response.body?.cancel();
      signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, wait);
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (!response.ok) throw await toHttpError(response);
    if (
      response.headers.get('etag') !== `"${artifact.sha256}"` ||
      ![null, 'identity'].includes(response.headers.get('content-encoding'))
    ) {
      await response.body?.cancel();
      throw new Error('Artifact validator does not match its metadata');
    }
    return response;
  }

  async *streamEvents(
    request: WebShellStreamRequest,
    signal?: AbortSignal,
    onOpen?: () => void,
    onAlive?: () => void,
  ): AsyncGenerator<JavaAgentEvent | JavaAgentResyncRequired> {
    const response = await this.request(
      `/sessions/${enc(request.sessionId)}/events${query({
        stream: 'true',
        after: request.afterSequence,
      })}`,
      undefined,
      signal,
      true,
      'GET',
    );
    if (!response.body) {
      throw new JavaManagedAgentHttpError(
        response.status,
        'agent_api_stream_unavailable',
        'Managed Agent event stream is unavailable',
      );
    }
    // The response headers are back and the body is attached: the stream
    // is established even when it then idles on heartbeats, which never
    // decode into events.
    onOpen?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let consecutiveCorrupt = 0;
    let skippedTotal = 0;
    let yieldedAny = false;
    // The fields are informational and never read, hence the placeholders.
    const resyncFrame = (): JavaAgentResyncRequired => ({
      type: RESYNC_REQUIRED,
      sessionId: request.sessionId,
      replayFloorSequence: 0,
      snapshotThroughSequence: 0,
      action: 'reload_snapshot',
    });
    const decodeFrame = (
      frame: string,
      trailing = false,
    ): JavaAgentEvent | JavaAgentResyncRequired | undefined => {
      let event: JavaAgentEvent | JavaAgentResyncRequired | undefined;
      let failure: unknown;
      try {
        event = decodeEventFrame(frame);
      } catch (error) {
        failure = error;
      }
      if (event) {
        consecutiveCorrupt = 0;
        return event;
      }
      const { data, id, name } = parseEventFrameFields(frame);
      if (data.length === 0) {
        const hasContent = frame
          .split(/\r?\n/)
          .some((line) => line && !line.startsWith(':'));
        if (!hasContent) {
          // A complete heartbeat or comment frame is the server answering:
          // on an idle Session it is the only sign of life the stream
          // gives. A trailing fragment is a mid-frame disconnect, never a
          // complete frame, so it does not count.
          if (!trailing) onAlive?.();
          return undefined;
        }
        if (!trailing) {
          // A mid-stream frame with id/event lines but no data line is
          // malformed server output, not a heartbeat: count it as corrupt
          // below instead of dropping it silently.
          failure ??= new Error('frame has no data payload');
        }
      }
      if (trailing) {
        // A leftover buffer at end of stream is a mid-frame disconnect, not
        // a corrupt persisted frame: log it as such and spare the budget.
        console.warn(
          `[web-shell] the Managed Agent event stream closed mid-frame; the frame at id ${id ?? 'none'} was discarded`,
        );
        return undefined;
      }
      // Corrupt frame: unparseable JSON, a payload that is not an event
      // object, or a mid-stream frame with no data line. Skip it and let
      // later frames move the consumer's cursor past it — except the shapes
      // a skip cannot recover from, which resync.
      consecutiveCorrupt += 1;
      if (
        // A run of corrupt frames means the log itself is poisoned: resync
        // past the whole run instead of skipping forever. (The id-less
        // resync marker is covered by the fail-closed rule too.)
        consecutiveCorrupt > MAX_CONSECUTIVE_CORRUPT_FRAMES ||
        // Fail closed: only delta text the snapshot re-assembles may skip.
        !SKIP_ON_CORRUPT.has(name ?? '')
      ) {
        console.warn(
          `[web-shell] resyncing on a corrupt Managed Agent frame (id: ${id ?? 'none'}, event: ${name ?? 'unknown'}):`,
          failure ?? 'non-event payload',
        );
        consecutiveCorrupt = 0;
        return resyncFrame();
      }
      skippedTotal += 1;
      if (skippedTotal === 1 || skippedTotal % SKIP_LOG_EVERY === 0) {
        console.warn(
          `[web-shell] skipping a corrupt Managed Agent event frame (id: ${id ?? 'none'}, event: ${name ?? 'unknown'}):`,
          failure ?? 'non-event payload',
        );
      }
      return undefined;
    };
    try {
      while (true) {
        const result = await reader.read();
        buffer += decoder.decode(result.value, { stream: !result.done });
        let boundary = nextFrameBoundary(buffer);
        while (boundary) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          const event = decodeFrame(frame);
          if (event) {
            yieldedAny = true;
            yield event;
          }
          boundary = nextFrameBoundary(buffer);
        }
        if (result.done) break;
      }
      const event = decodeFrame(buffer, true);
      if (event) {
        yieldedAny = true;
        yield event;
      }
      // A connection that delivered nothing but skips means the rest of the
      // replay log is undeliverable: end with a resync so the consumer
      // reloads the durable transcript instead of retrying the same cursor.
      if (!yieldedAny && skippedTotal > 0) {
        console.warn(
          `[web-shell] resyncing a Managed Agent stream that delivered only corrupt frames (${skippedTotal} skipped)`,
        );
        yield resyncFrame();
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async sideQueryContext(sessionId: string, signal?: AbortSignal) {
    const context = await this.get<Schemas['SideQueryContext']>(
      `/sessions/${enc(sessionId)}/side-queries/context`,
      signal,
    );
    return publicSideQueryContextToJava(context);
  }

  async createSideQuery(
    sessionId: string,
    request: ManagedSideQueryCreate,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    const query_ = await this.post<Schemas['SideQuery']>(
      `/sessions/${enc(sessionId)}/side-queries`,
      {
        kind: request.kind,
        trigger: request.trigger,
        question: request.question,
        expected_content_version: request.expectedContentVersion,
        expected_main_input_boundary: request.expectedMainInputBoundary,
      },
      signal,
      idempotencyKey,
    );
    return publicSideQueryToJava(query_);
  }

  async listSideQueries(
    request: { sessionId: string; cursor?: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<ManagedSideQueryPage> {
    const page = await this.get<Schemas['SideQueryPage']>(
      `/sessions/${enc(request.sessionId)}/side-queries${query({
        cursor: request.cursor,
        limit: request.limit,
      })}`,
      signal,
    );
    return publicSideQueryPageToJava(page);
  }

  async getSideQuery(sessionId: string, queryId: string, signal?: AbortSignal) {
    const value = await this.get<Schemas['SideQuery']>(
      `/sessions/${enc(sessionId)}/side-queries/${enc(queryId)}`,
      signal,
    );
    return publicSideQueryToJava(value);
  }

  async cancelSideQuery(
    sessionId: string,
    queryId: string,
    signal?: AbortSignal,
  ) {
    const value = await this.post<Schemas['SideQuery']>(
      `/sessions/${enc(sessionId)}/side-queries/${enc(queryId)}/cancel`,
      undefined,
      signal,
    );
    return publicSideQueryToJava(value);
  }

  async *streamSideQuery(
    request: { sessionId: string; queryId: string; afterRevision?: number },
    signal?: AbortSignal,
  ): AsyncGenerator<ManagedSideQuery> {
    const response = await this.request(
      `/sessions/${enc(request.sessionId)}/side-queries/${enc(request.queryId)}/events`,
      undefined,
      signal,
      true,
      'GET',
    );
    if (!response.body) throw new Error('Side query stream is unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let revision = request.afterRevision ?? -1;
    try {
      while (true) {
        const result = await reader.read();
        buffer += decoder.decode(result.value, { stream: !result.done });
        let boundary = nextFrameBoundary(buffer);
        while (boundary) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          const { data } = parseEventFrameFields(frame);
          if (data.length) {
            const value = publicSideQueryToJava(
              JSON.parse(data.join('\n')) as Schemas['SideQuery'],
            );
            if (
              value.sessionId !== request.sessionId ||
              value.queryId !== request.queryId ||
              !Number.isSafeInteger(value.resultRevision)
            )
              throw new Error('Side query stream identity mismatch');
            if (value.resultRevision > revision) {
              revision = value.resultRevision;
              yield value;
            }
          }
          boundary = nextFrameBoundary(buffer);
        }
        if (result.done) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  queryUserMessages(sessionId: string, signal?: AbortSignal) {
    return this.get<
      import('./use-managed-user-messages').ManagedUserMessageSnapshot
    >(`/sessions/${enc(sessionId)}/user-messages`, signal);
  }

  commandUserMessages(
    sessionId: string,
    command: import('./use-managed-user-messages').ManagedUserMessageCommand,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    // The Public command body is the camelCase command itself.
    return this.post<
      import('./use-managed-user-messages').ManagedUserMessageSnapshot
    >(
      `/sessions/${enc(sessionId)}/user-messages`,
      command,
      signal,
      idempotencyKey,
    );
  }

  private async post<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    idempotencyKey?: string,
    prefix: string = API_PREFIX,
  ): Promise<T> {
    const response = await this.request(
      path,
      body,
      signal,
      false,
      'POST',
      idempotencyKey,
      prefix,
    );
    return (await response.json()) as T;
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchRequest(
      path,
      undefined,
      signal,
      false,
      'application/json',
      'GET',
    );
    return (await response.json()) as T;
  }

  private async request(
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    stream: boolean,
    method: string = 'POST',
    idempotencyKey?: string,
    prefix: string = API_PREFIX,
  ): Promise<Response> {
    return this.fetchRequest(
      path,
      body === undefined ? undefined : JSON.stringify(body),
      signal,
      stream,
      'application/json',
      method,
      idempotencyKey,
      prefix,
    );
  }

  private async fetchRequest(
    path: string,
    body: BodyInit | undefined,
    signal: AbortSignal | undefined,
    stream: boolean,
    contentType: string,
    method: string = 'POST',
    idempotencyKey?: string,
    prefix: string = API_PREFIX,
  ): Promise<Response> {
    const supplied = await this.options.getHeaders?.();
    const headers = new Headers(supplied);
    if (
      body !== undefined &&
      (contentType === 'application/octet-stream' ||
        !headers.has('content-type'))
    ) {
      headers.set('content-type', contentType);
    }
    headers.set('accept', stream ? 'text/event-stream' : 'application/json');
    if (idempotencyKey !== undefined) {
      headers.set('idempotency-key', idempotencyKey);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${prefix}${path}`, {
      method,
      headers,
      credentials: this.credentials,
      body,
      signal,
    });
    if (!response.ok) {
      throw await toHttpError(response);
    }
    return response;
  }
}

function nextFrameBoundary(
  value: string,
): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(value);
  return match?.index === undefined
    ? undefined
    : { index: match.index, length: match[0].length };
}

function parseEventFrameFields(frame: string): {
  data: string[];
  id?: number;
  name?: string;
} {
  const data: string[] = [];
  let id: number | undefined;
  let name: string | undefined;
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value =
      separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    if (field === 'id' && /^\d+$/.test(value)) id = Number(value);
    if (field === 'event') name = value;
  }
  return { data, id, name };
}

function decodeEventFrame(
  frame: string,
): JavaAgentEvent | JavaAgentResyncRequired | undefined {
  const { data, id, name } = parseEventFrameFields(frame);
  if (data.length === 0) return undefined;
  const parsed: unknown = JSON.parse(data.join('\n'));
  // Both frame shapes this stream carries are objects with a string `type`
  // (PublicEvent and SessionResyncRequired); anything else is corrupt.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== 'string'
  )
    return undefined;
  // The server's only frame without an id: the cursor fell below the replay
  // floor, and the stream ends after it.
  if (name === RESYNC_REQUIRED && id === undefined) {
    return publicResyncToJava(parsed as Schemas['SessionResyncRequired']);
  }
  const event = parsed as Schemas['PublicEvent'];
  return publicEventToJava(
    id === undefined || event.sequence === id
      ? event
      : { ...event, sequence: id },
  );
}

async function toHttpError(
  response: Response,
): Promise<JavaManagedAgentHttpError> {
  let code = `http_${response.status}`;
  let message = `Managed Agent request failed (${response.status})`;
  let requestId = response.headers.get('x-request-id')?.trim() || undefined;
  try {
    const payload: unknown = await response.json();
    if (typeof payload === 'object' && payload !== null) {
      const error = (payload as Record<string, unknown>)['error'];
      if (typeof error === 'object' && error !== null) {
        const fields = error as Record<string, unknown>;
        if (typeof fields['code'] === 'string') code = fields['code'];
        if (typeof fields['message'] === 'string') message = fields['message'];
        if (typeof fields['request_id'] === 'string')
          requestId = fields['request_id'].trim() || undefined;
      }
    }
  } catch {
    // Preserve the stable HTTP fallback when the response is not JSON.
  }
  return new JavaManagedAgentHttpError(
    response.status,
    code,
    message,
    requestId,
  );
}
