import type {
  ManagedExtensionManifest,
  ManagedExtensionPin,
  ManagedExtensionCatalog,
  ManagedExtensionPackageOperation,
  ManagedExtensionSettings,
  ManagedExtensionSnapshot,
  ManagedExtensionSelection,
} from './managed-extension-types';
import type { components } from './generated/managed-agent-api';
import type {
  ManagedMcpManagementCommand,
  ManagedMcpManagementSnapshot,
} from './managed-mcp-management-types';
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

export function isManagedSessionRunning(
  phase: ManagedAgentSessionPhase,
): boolean {
  return !['created', 'completed', 'failed', 'cancelled'].includes(phase);
}

export type ManagedAgentRuntimeState =
  | 'unknown'
  | 'starting'
  | 'ready'
  | 'failed';

export interface ManagedPermissionRules {
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly deny: readonly string[];
}

export type ManagedApprovalMode = 'default' | 'auto-edit' | 'auto' | 'yolo';
export type ManagedInputBlock = components['schemas']['InputBlock'];
export type ManagedSessionSkills =
  components['schemas']['WebShellSessionSkills'];
export type ManagedSessionMcp = components['schemas']['PublicMcpCatalog'];
export type ManagedWorkspaceFileLocator =
  | { sessionId: string; workspaceId?: never; cwdRelative?: never }
  | { sessionId?: never; workspaceId: string; cwdRelative: string };

export type ManagedWorkspaceFileQueryRequest = ManagedWorkspaceFileLocator &
  Omit<
    components['schemas']['WebShellWorkspaceFileQueryRequest'],
    'sessionId' | 'workspaceId' | 'cwdRelative'
  >;

export type ManagedWorkspaceFileReadRequest = ManagedWorkspaceFileLocator &
  Omit<
    components['schemas']['WebShellWorkspaceFileReadRequest'],
    'sessionId' | 'workspaceId' | 'cwdRelative'
  >;

export type ManagedWorkspaceFileUploadRequest = ManagedWorkspaceFileLocator & {
  path: string;
  expectedScopeRevision: string;
  uploadId: string;
};

export function isManagedApprovalMode(
  value: unknown,
): value is ManagedApprovalMode {
  return (
    value === 'default' ||
    value === 'auto-edit' ||
    value === 'auto' ||
    value === 'yolo'
  );
}

export function isManagedInitialApprovalMode(
  value: unknown,
): value is Exclude<ManagedApprovalMode, 'auto'> {
  return isManagedApprovalMode(value) && value !== 'auto';
}

export function managedPermissionRulesEqual(
  left: ManagedPermissionRules | undefined,
  right: ManagedPermissionRules | undefined,
): boolean {
  return (['allow', 'ask', 'deny'] as const).every((kind) => {
    const a = left?.[kind] ?? [];
    const b = right?.[kind] ?? [];
    return a.length === b.length && a.every((rule, index) => rule === b[index]);
  });
}

export type ManagedSessionSkill = components['schemas']['SessionCreationSkill'];
export type ManagedSessionRecovery = components['schemas']['SessionRecovery'];
export type ManagedTurnCancelOperation =
  components['schemas']['WebShellCommandOperation'];

export interface ManagedModelPreset {
  agentId: string;
  label: string;
  modelId?: string;
}

export interface ManagedSessionOptions {
  approvalMode: ManagedApprovalMode;
  availableApprovalModes: ManagedApprovalMode[];
  planModeSupported?: boolean;
  inputAttachments?: boolean;
  skillsSupported?: boolean;
  modelSelectionSupported?: boolean;
}

export interface ManagedSessionApproval extends ManagedSessionOptions {
  approvalRevision: number;
  supported: boolean;
  planMode?: boolean;
  liveSupported?: boolean;
  permissionRulesSupported?: boolean;
  permissionRules?: ManagedPermissionRules;
}

export interface ManagedApprovalChangeResult {
  sessionId: string;
  approvalMode: ManagedApprovalMode;
  approvalRevision: number;
  replayed: boolean;
  planMode?: boolean;
  permissionRules?: ManagedPermissionRules;
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

export type ManagedLifecycleKind = 'close' | 'archive' | 'delete';
export type ManagedLifecycleAction =
  | ManagedLifecycleKind
  | 'unarchive'
  | 'close_archive';
export type ManagedLifecycleOperation =
  components['schemas']['WebShellCommandOperation'];
export type ManagedExportPage = components['schemas']['WebShellExportPage'];
export type ManagedExportItem = components['schemas']['WebShellItem'];

export type ManagedSessionWorktree =
  components['schemas']['WebShellSessionWorktree'];
export type ManagedSessionWorktreeOptions =
  components['schemas']['WebShellSessionWorktreeOptions'];

export interface ManagedAgentSessionSummary {
  sessionId: string;
  agentId?: string;
  worktree?: ManagedSessionWorktree | null;
  approvalMode?: ManagedApprovalMode;
  initialApprovalMode?: ManagedApprovalMode;
  approvalRevision?: number;
  planMode?: boolean;
  planModeSupported?: boolean;
  modelContext?: ManagedModelContext;
  modelSelection?: ManagedModelSelection;
  compactionRevision?: number;
  contextCompressionOperationId?: string;
  lifecycleStatus?: string;
  lastSequence?: number;
  lifecycleOperation?: components['schemas']['WebShellLifecycleOperation'];
  activeTurnId?: string;
  title: string;
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
    canRename?: boolean;
    sessionClose?: boolean;
    sessionArchive?: boolean;
    sessionUnarchive?: boolean;
    sessionDelete?: boolean;
    actions?: boolean;
    childAgents?: boolean;
    tasks?: boolean;
    artifacts?: boolean;
    /** The caller may submit later Turns to this Workspace-bound Session. */
    workspaceTurns?: boolean;
    modelChange?: boolean;
    contextCompression?: boolean;
    approvalModeChange?: boolean;
    inputAttachments?: boolean;
  };
  failure?: { code: string; message: string };
  recovery?: ManagedSessionRecovery;
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
   * Projected from a materialized Item rather than a raw event. The
   * server can retract its items (reconciliation), after which these
   * projections must not survive a resync.
   */
  assembledFromItem?: boolean;
}

export interface ManagedAgentSessionTranscript {
  events: ManagedAgentSessionEvent[];
  olderCursor?: string;
  lastEventId: number;
  history?: 'items';
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

export type ManagedContextCompressionOperation =
  components['schemas']['WebShellContextCompressionOperation'];
export type ManagedTask = components['schemas']['WebShellTask'];
export type ManagedTaskPage = components['schemas']['WebShellTaskPage'];
export type ManagedTaskEvent = components['schemas']['WebShellTaskEvent'];
export type ManagedTaskEventPage =
  components['schemas']['WebShellTaskEventPage'];
export type ManagedTaskCancelOperation =
  components['schemas']['WebShellCommandOperation'] & { type: 'task_cancel' };

export type ManagedRuntimeNode = components['schemas']['WebShellRuntimeNode'];

export type ManagedWorkspaceDirectory =
  components['schemas']['WebShellWorkspaceDirectory'];

export type ManagedWorkspaceCreateOperation =
  components['schemas']['WebShellWorkspaceCreateOperation'];

export interface ManagedWorkspaceRegistration {
  listNodes(
    options: ManagedAgentRequestOptions,
  ): Promise<components['schemas']['WebShellRuntimeNodePage']>;
  checkDirectory(
    request: components['schemas']['WebShellWorkspaceDirectoryRequest'],
    options: ManagedAgentRequestOptions,
  ): Promise<ManagedWorkspaceDirectory>;
  create(
    request: Omit<
      components['schemas']['WebShellWorkspaceRegisterRequest'],
      'idempotencyKey' | 'requestId'
    >,
    options: ManagedAgentCommandOptions,
  ): Promise<ManagedWorkspaceCreateOperation>;
  query(
    operationId: string,
    options: ManagedAgentRequestOptions,
  ): Promise<ManagedWorkspaceCreateOperation>;
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
  readonly userMessages?: {
    query(
      sessionId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<
      import('./use-managed-user-messages').ManagedUserMessageSnapshot
    >;
    command(
      sessionId: string,
      command: import('./use-managed-user-messages').ManagedUserMessageCommand,
      options: { idempotencyKey: string; signal?: AbortSignal },
    ): Promise<
      import('./use-managed-user-messages').ManagedUserMessageSnapshot
    >;
  };

  readonly lifecycle?: {
    submit(
      kind: ManagedLifecycleKind,
      sessionId: string,
      options: ManagedAgentCommandOptions,
    ): Promise<ManagedLifecycleOperation>;
    unarchive(
      sessionId: string,
      options: ManagedAgentCommandOptions,
    ): Promise<ManagedAgentSessionSummary>;
    query(
      sessionId: string,
      operationId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedLifecycleOperation>;
  };
  exportSnapshot?(
    sessionId: string,
    options: ManagedAgentRequestOptions & { cursor?: string },
  ): Promise<ManagedExportPage>;
  readonly exportConsistency?: 'live';
  readonly storageKey: string;
  readonly canCancel: boolean;
  /** Present when the provider can filter the complete Session history by title. */
  readonly titleSearch?: boolean;
  readonly recovery?: {
    query(
      sessionId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedSessionRecovery>;
    recheck(
      sessionId: string,
      turnId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedSessionRecovery>;
  };
  queryCancelOperation(
    sessionId: string,
    operationId: string,
    options: ManagedAgentRequestOptions,
  ): Promise<ManagedTurnCancelOperation>;
  readonly skills?: {
    list(
      sessionId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedSessionSkills>;
  };
  readonly mcp?: {
    list(
      sessionId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedSessionMcp>;
  };
  readonly extensions?: {
    readonly storageScope?: string;
    list(
      workspaceId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedExtensionCatalog>;
    publish(
      workspaceId: string,
      extensionId: string | undefined,
      packageDigest: string,
      manifest: ManagedExtensionManifest,
      archive: Blob,
      options: ManagedAgentCommandOptions,
    ): Promise<ManagedExtensionPackageOperation>;
    settings(
      workspaceId: string,
      extensionId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedExtensionSettings>;
    saveSettings(
      workspaceId: string,
      extensionId: string,
      expectedRevision: number,
      values: Record<string, string>,
      options: ManagedAgentCommandOptions,
    ): Promise<ManagedExtensionPackageOperation>;
    query(
      sessionId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedExtensionSnapshot>;
    apply(
      sessionId: string,
      selection: ManagedExtensionSelection,
      options: ManagedAgentCommandOptions,
    ): Promise<ManagedExtensionSnapshot>;
    operation(
      sessionId: string,
      operationId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedExtensionSnapshot>;
    resume(
      sessionId: string,
      operationId: string,
      recoverPrevious: boolean,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedExtensionSnapshot>;
    package(
      workspaceId: string,
      pin: ManagedExtensionPin,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedExtensionCatalog['extensions'][number]>;
  };
  readonly mcpManagement?: {
    /** Explicit tenant/actor namespace for pending commands saved in this tab. */
    readonly storageScope?: string;
    query(
      sessionId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedMcpManagementSnapshot>;
    submit(
      sessionId: string,
      command: ManagedMcpManagementCommand,
      options: ManagedAgentCommandOptions & { requestId: string },
    ): Promise<ManagedMcpManagementSnapshot>;
    operation(
      sessionId: string,
      operationId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedMcpManagementSnapshot>;
  };
  /** Present when the provider can serve Hosted permission Actions. */
  readonly actions?: {
    listPending(
      sessionId: string,
      options: ManagedAgentRequestOptions & { includeChildren?: boolean },
    ): Promise<ManagedAgentPendingAction[]>;
    respond(
      action: ManagedAgentPendingAction,
      optionId: string,
      options: ManagedAgentCommandOptions,
    ): Promise<void>;
  };
  readonly toolResults?: ManagedToolResultReader;
  readonly toolDetails?: {
    get(
      sessionId: string,
      itemId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<components['schemas']['WebShellToolDetails']>;
  };
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
  readonly contextCompression?: {
    submit(
      sessionId: string,
      request: { expectedCompactionRevision: number },
      options: ManagedAgentCommandOptions,
    ): Promise<ManagedContextCompressionOperation>;
    query(
      sessionId: string,
      operationId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedContextCompressionOperation>;
  };
  readonly approvalChange?: {
    queryOptions(
      sessionId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedSessionApproval>;
    submit(
      sessionId: string,
      request: {
        approvalMode: ManagedApprovalMode;
        expectedRevision: number;
        planMode?: boolean;
        permissionRules?: ManagedPermissionRules;
      },
      options: ManagedAgentCommandOptions & { requestId: string },
    ): Promise<ManagedApprovalChangeResult>;
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
  readonly workspaceFiles?: {
    query(
      request: ManagedWorkspaceFileQueryRequest,
      options: ManagedAgentRequestOptions,
    ): Promise<components['schemas']['WebShellWorkspaceFilePage']>;
    read(
      request: ManagedWorkspaceFileReadRequest,
      options: ManagedAgentRequestOptions,
    ): Promise<components['schemas']['WebShellWorkspaceFileSnapshot']>;
    upload?(
      request: ManagedWorkspaceFileUploadRequest,
      data: Blob,
      options: ManagedAgentRequestOptions,
    ): Promise<components['schemas']['WebShellWorkspaceFileUploadResult']>;
    queryUpload?(
      uploadId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<components['schemas']['WebShellWorkspaceFileUploadStatus']>;
  };
  readonly workspaceBinding?: {
    readonly agentId: string;
    readonly registration?: ManagedWorkspaceRegistration;
    /** Host-published models and legacy AgentDefinition presets for new Sessions. */
    readonly modelPresets?: readonly ManagedModelPreset[];
    list(
      options: ManagedAgentRequestOptions & { cursor?: string; limit?: number },
    ): Promise<{
      data: ManagedAgentWorkspace[];
      defaultWorkspace?: ManagedAgentWorkspace | null;
      nextCursor?: string;
      supported: boolean;
      canCreateWorkspace?: boolean;
      canSelectDirectory?: boolean;
      canImportLocalDirectory?: boolean;
      supportsApprovalModeSelection?: boolean;
    }>;
    get(
      workspaceId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedAgentWorkspace>;
    createWorkspace?(
      request: {
        displayName: string;
        sourceWorkspaceId?: string;
        cwdRelative?: string;
        localPath?: string;
      },
      options: ManagedAgentCommandOptions,
    ): Promise<ManagedAgentWorkspace>;
    directories?(
      request:
        | { workspaceId: string; cwdRelative: string; localPath?: never }
        | { localPath: string; workspaceId?: never; cwdRelative?: never },
      options: ManagedAgentRequestOptions,
    ): Promise<components['schemas']['WebShellWorkspaceDirectoryPage']>;
    getSessionOptions?(
      agentId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedSessionOptions>;
    createEmpty(
      request: {
        agentId: string;
        modelId?: string;
        workspaceId: string;
        cwdRelative: string;
        approvalMode?: ManagedApprovalMode;
        planMode?: boolean;
        skills?: ManagedSessionSkill[];
        extensionPins?: ManagedExtensionPin[];
        worktree?: { baseRef?: string };
      },
      options: ManagedAgentCommandOptions,
    ): Promise<{ sessionId: string }>;
    createSession?(
      request: {
        agentId: string;
        modelId?: string;
        workspaceId: string;
        cwdRelative: string;
        text: string;
        input?: ManagedInputBlock[];
        approvalMode?: ManagedApprovalMode;
        planMode?: boolean;
        skills?: ManagedSessionSkill[];
        extensionPins?: ManagedExtensionPin[];
        worktree?: { baseRef?: string };
      },
      options: ManagedAgentCommandOptions,
    ): Promise<{ sessionId: string }>;
  };
  readonly sessionWorktrees?: {
    options(
      request: { workspaceId: string; cwdRelative: string; baseRef?: string },
      options: ManagedAgentRequestOptions,
    ): Promise<ManagedSessionWorktreeOptions>;
    list(
      workspaceId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<{ data: ManagedSessionWorktree[] }>;
    inspect(
      workspaceId: string,
      worktreeId: string,
      options: ManagedAgentRequestOptions,
    ): Promise<components['schemas']['WebShellSessionWorktreeInspection']>;
    cleanup(
      workspaceId: string,
      worktreeId: string,
      options: ManagedAgentCommandOptions,
    ): Promise<ManagedSessionWorktree>;
  };
  listSessions(
    options: ManagedAgentRequestOptions & {
      archiveState?: 'unarchived' | 'archived' | 'all';
      titleQuery?: string;
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
  renameSession?(
    sessionId: string,
    displayName: string,
    options: ManagedAgentCommandOptions,
  ): Promise<{ displayName: string }>;
  getTranscript(
    sessionId: string,
    options: ManagedAgentRequestOptions & {
      before?: string;
      limit?: number;
    },
  ): Promise<ManagedAgentSessionTranscript>;
  createSession(
    request: {
      text: string;
      input?: ManagedInputBlock[];
    },
    options: ManagedAgentCommandOptions,
  ): Promise<ManagedAgentTurnAdmission>;
  submitPrompt(
    sessionId: string,
    request: { text: string; input?: ManagedInputBlock[] },
    options: ManagedAgentCommandOptions,
  ): Promise<ManagedAgentTurnAdmission & { operationId: string }>;
  cancel(
    sessionId: string,
    turnId: string,
    options: ManagedAgentCommandOptions,
  ): Promise<{
    sessionId: string;
    turnId: string;
    operationId: string;
  }>;
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
  defaultCwdRelative?: string;
  canSelectDirectory?: boolean;
}
