/**
 * Boundary adapters between the Public REST wire (snake_case, generated in
 * managed-agent-api.ts) and the frozen camelCase client contract
 * (java-agent-contract-types.ts). Pure functions only: the client casts each
 * response to its Public wire type and adapts it here before anything
 * downstream sees it; request builders go the other way.
 *
 * Timestamps: the Public wire carries epoch SECONDS for Session, Turn, Event
 * and Item only; every other family (tasks, actions, artifacts, side queries,
 * client files, recovery, model context) is epoch millis on both wires and
 * passes through untouched. Event `data` payloads are shared record bodies
 * and must never be re-keyed.
 */
import type { components } from './generated/managed-agent-api';
import type { ManagedPermissionRules } from './java-agent-contract-types';
import type {
  WebShellAction,
  WebShellActionPage,
  WebShellActionQuestion,
  WebShellAdmission,
  WebShellApprovalChangeResult,
  WebShellCommandOperation,
  WebShellContentPart,
  WebShellContextCompressionOperation,
  WebShellCwdOperation,
  WebShellEvent,
  WebShellExportPage,
  WebShellItem,
  WebShellLifecycleOperation,
  WebShellModelChangeResult,
  WebShellModelContext,
  WebShellModelSelection,
  WebShellOperation,
  WebShellPermissionAction,
  WebShellQuestionAction,
  WebShellResyncRequired,
  WebShellRuntimeNodePage,
  WebShellSession,
  WebShellSessionApproval,
  WebShellSessionCapabilities,
  WebShellSessionModels,
  WebShellSessionOptions,
  WebShellSessionPage,
  WebShellSessionSkills,
  WebShellSessionWorktree,
  WebShellSessionWorktreeInspection,
  WebShellSessionWorktreeOptions,
  WebShellSessionWorktreePage,
  WebShellShellResult,
  WebShellSideQuery,
  WebShellSideQueryContext,
  WebShellSideQueryPage,
  WebShellSideQueryPrefix,
  WebShellTask,
  WebShellTaskEvent,
  WebShellTaskEventPage,
  WebShellTaskPage,
  WebShellToolDetails,
  WebShellTranscript,
  WebShellTurn,
  WebShellTurnAdmission,
  WebShellWorkspace,
  WebShellWorkspaceCreateOperation,
  WebShellWorkspaceDirectory,
  WebShellWorkspaceDirectoryPage,
  WebShellWorkspaceFilePage,
  WebShellWorkspaceFileSnapshot,
  WebShellWorkspaceFileUploadResult,
  WebShellWorkspaceFileUploadStatus,
  WebShellWorkspacePage,
} from './java-agent-contract-types';

type Schemas = components['schemas'];

type ApprovalMode = 'default' | 'auto' | 'auto-edit' | 'yolo';
type CreationApprovalMode = 'default' | 'auto-edit' | 'yolo';

/** The Public approval schemas inline the rules map; the frozen contract
 * keeps the named allow/ask/deny structure the WebShell wire emitted. */
function permissionRulesToJava(rules?: {
  [key: string]: string[];
}): ManagedPermissionRules | undefined {
  if (rules === undefined) return undefined;
  return {
    allow: rules['allow'] ?? [],
    ask: rules['ask'] ?? [],
    deny: rules['deny'] ?? [],
  };
}

const millis = (seconds: number): number => seconds * 1000;
const optionalMillis = (seconds?: number | null): number | null | undefined =>
  seconds == null ? seconds : seconds * 1000;

export function publicTurnToJava(turn: Schemas['PublicTurn']): WebShellTurn {
  return {
    turnId: turn.id,
    sessionId: turn.session_id,
    status: turn.status,
    submittedAt: millis(turn.created_at),
    completedAt: optionalMillis(turn.completed_at),
    errorCode: turn.error_code,
  };
}

export function publicEventToJava(
  event: Schemas['PublicEvent'],
): WebShellEvent {
  return {
    schemaVersion: event.schema_version,
    projectionVersion: event.projection_version,
    sequence: event.sequence,
    eventId: event.event_id,
    sessionId: event.session_id,
    turnId: event.turn_id,
    itemId: event.item_id,
    contentPartId: event.content_part_id,
    type: event.type,
    createdAt: millis(event.created_at),
    data: event.data,
    terminal: event.terminal,
  };
}

export function publicResyncToJava(
  frame: Schemas['SessionResyncRequired'],
): WebShellResyncRequired {
  return {
    type: frame.type,
    sessionId: frame.session_id,
    replayFloorSequence: frame.replay_floor_sequence,
    snapshotThroughSequence: frame.snapshot_through_sequence,
    action: frame.action,
  };
}

function publicContentPartToJava(
  part: Schemas['PublicContentPart'],
): WebShellContentPart {
  return {
    partId: part.part_id,
    type: part.type,
    text: part.text,
    firstSequence: part.first_sequence,
    lastSequence: part.last_sequence,
  };
}

export function publicItemToJava(item: Schemas['PublicItem']): WebShellItem {
  return {
    itemId: item.id,
    sessionId: item.session_id,
    turnId: item.turn_id ?? '',
    type: item.type,
    role: item.role,
    status: item.status,
    content: item.content.map(publicContentPartToJava),
    attributes: item.attributes ?? {},
    firstSequence: item.first_sequence,
    lastSequence: item.last_sequence,
    createdAt: millis(item.created_at ?? 0),
    updatedAt: millis(item.updated_at ?? 0),
  };
}

function publicModelContextToJava(
  context: Schemas['PublicModelContext'],
): WebShellModelContext {
  return {
    modelId: context.model_id ?? '',
    inputTokens: context.input_tokens,
    contextWindowSize: context.context_window_size,
    observedAt: context.observed_at,
  };
}

function publicModelSelectionToJava(
  selection: Schemas['PublicModelSelection'],
): WebShellModelSelection {
  return { modelId: selection.model_id, revision: selection.revision };
}

function publicLifecycleOperationToJava(
  operation: Schemas['PublicLifecycleOperation'],
): WebShellLifecycleOperation {
  return {
    operationId: operation.operation_id,
    type: operation.type,
    status: operation.status,
    failureCode: operation.failure_code,
  };
}

function publicCapabilitiesToJava(
  capabilities: Schemas['SessionCapabilities'],
): WebShellSessionCapabilities {
  return {
    tasks: capabilities.tasks,
    artifacts: capabilities.artifacts,
    actions: capabilities.actions,
    workspaceTurns: capabilities.workspace_turns,
    sessionClose: capabilities.session_close,
    sessionArchive: capabilities.session_archive,
    sessionUnarchive: capabilities.session_unarchive,
    sessionDelete: capabilities.session_delete,
    cwdChange: capabilities.cwd_change,
    foregroundShell: capabilities.foreground_shell,
    modelChange: capabilities.model_change,
    approvalModeChange: capabilities.approval_mode_change,
    inputAttachments: capabilities.input_attachments,
    rename: capabilities.rename,
    contextCompression: capabilities.context_compression,
    childAgents: capabilities.child_agents,
    // WebShell derives diagnostics from tasks; the Public contract keeps
    // only tasks, so the adapter restores the derived flag.
    diagnostics: capabilities.tasks,
    btw: capabilities.btw,
    recap: capabilities.recap,
    terminal: capabilities.terminal,
    clientFiles: capabilities.client_files,
  };
}

function publicWorkspaceContextToJava(
  workspace: Schemas['WorkspaceContext'],
): WebShellSession['workspace'] {
  return {
    workspaceId: workspace.workspace_id,
    cwdRelative: workspace.cwd_relative,
    contextRevision: workspace.context_revision,
    state: workspace.state,
  };
}

export function publicWorktreeToJava(
  worktree: Schemas['SessionWorktree'],
): WebShellSessionWorktree {
  return {
    id: worktree.id,
    sessionId: worktree.session_id,
    workspaceId: worktree.workspace_id,
    branch: worktree.branch,
    baseCommit: worktree.base_commit,
    cwdRelative: worktree.cwd_relative,
    operationId: worktree.operation_id,
    state: worktree.state,
    revision: worktree.revision,
    errorCode: worktree.error_code,
  };
}

export function publicSessionToJava(
  session: Schemas['PublicSession'],
): WebShellSession {
  return {
    sessionId: session.id,
    title: session.title,
    agentId: session.agent_id,
    status: session.status,
    createdAt: millis(session.created_at),
    updatedAt: millis(session.updated_at),
    // The WebShell activeTurn projection is the latest Turn regardless of
    // status; the Public active_turn stays ACTIVE-only and latest_turn
    // carries the WebShell semantics.
    activeTurn: session.latest_turn
      ? publicTurnToJava(session.latest_turn)
      : null,
    environment: session.environment,
    lastSequence: session.last_event_id,
    workspace: session.workspace
      ? publicWorkspaceContextToJava(session.workspace)
      : undefined,
    capabilities: publicCapabilitiesToJava(session.capabilities),
    approvalMode: session.approval_mode,
    modelContext: session.model_context
      ? publicModelContextToJava(session.model_context)
      : undefined,
    modelSelection: session.model_selection
      ? publicModelSelectionToJava(session.model_selection)
      : undefined,
    approvalRevision: session.approval_revision,
    initialApprovalMode: session.initial_approval_mode,
    planMode: session.plan_mode,
    planModeSupported: session.plan_mode_supported,
    compactionRevision: session.compaction_revision,
    contextCompressionOperationId: session.context_compression_operation_id,
    lifecycleOperation: session.lifecycle_operation
      ? publicLifecycleOperationToJava(session.lifecycle_operation)
      : undefined,
    recovery: session.recovery,
    worktree:
      session.worktree == null
        ? session.worktree
        : publicWorktreeToJava(session.worktree),
  };
}

export function publicSessionPageToJava(
  page: Schemas['PublicSessionList'],
): WebShellSessionPage {
  return {
    data: page.data.map(publicSessionToJava),
    nextCursor: page.next_cursor,
    hasMore: page.has_more,
  };
}

/** Synthesizes the WebShell create admission from the Public Session body:
 * the provider requires turnId, and the initial Turn is always present in
 * latest_turn (creation always carries input; a replay returns the settled
 * initial Turn). replayed rides the X-Qwen-Idempotent-Replay header. */
export function publicAdmissionFromSession(
  session: Schemas['PublicSession'],
  replayed: boolean,
): WebShellAdmission {
  return {
    sessionId: session.id,
    turnId: session.latest_turn?.id ?? null,
    status: 'accepted',
    replayed,
  };
}

export function publicWorkspaceToJava(
  workspace: Schemas['PublicWorkspace'],
): WebShellWorkspace {
  return {
    workspaceId: workspace.id,
    displayName: workspace.display_name,
    canCreateSession: workspace.can_create_session,
    state: workspace.state,
    defaultCwdRelative: workspace.default_cwd_relative,
    canSelectDirectory: workspace.can_select_directory,
  };
}

export function publicWorkspaceSummaryToJava(
  summary: Schemas['PublicWorkspaceSummary'],
): WebShellWorkspace {
  return {
    workspaceId: summary.workspace_id,
    displayName: summary.display_name,
    canCreateSession: summary.can_create_session,
    state: summary.state,
    defaultCwdRelative: summary.default_cwd_relative ?? undefined,
    canSelectDirectory: summary.can_select_directory,
  };
}

export function publicWorkspacePageToJava(
  page: Schemas['PublicWorkspaceList'],
): WebShellWorkspacePage {
  return {
    data: page.data.map(publicWorkspaceToJava),
    hasMore: page.has_more,
    nextCursor: page.next_cursor,
    capabilities: {
      workspaceContext: page.capabilities.workspace_context,
      workspaceBinding: page.capabilities.workspace_binding,
      workspaceCreation: page.capabilities.workspace_creation,
      approvalModeSelection: page.capabilities.approval_mode_selection,
      workspaceDirectorySelection: page.capabilities.directory_selection,
      localDirectoryImport: page.capabilities.local_directory_import,
    },
    defaultWorkspace: page.default_workspace
      ? {
          ...publicWorkspaceToJava(page.default_workspace),
          state: page.default_workspace.state,
          canCreateSession: page.default_workspace.can_create_session,
        }
      : null,
  };
}

export function publicTranscriptToJava(
  transcript: Schemas['PublicTranscript'],
): WebShellTranscript {
  return {
    items: transcript.items.map(publicItemToJava),
    events: transcript.events.map(publicEventToJava),
    coveredSequence: transcript.covered_sequence,
    olderCursor: transcript.older_cursor,
    hasMore: transcript.has_more,
    lastSequence: transcript.last_sequence,
  };
}

export function publicItemListToJava(
  page: Schemas['PublicItemList'],
): WebShellExportPage {
  return {
    items: page.data.map(publicItemToJava),
    nextCursor: page.next_cursor,
    hasMore: page.has_more,
    snapshotThroughSequence: page.snapshot_through_sequence,
  };
}

export function publicTaskToJava(task: Schemas['PublicTask']): WebShellTask {
  return {
    taskId: task.id,
    sessionId: task.session_id,
    childSessionId: task.child_session_id,
    kind: task.kind,
    state: task.state,
    definitionRevision: task.definition_revision,
    runtimeState: task.runtime_state,
    createdAt: task.created_at,
    startedAt: task.started_at,
    settledAt: task.settled_at,
    outputCursor: task.output_cursor,
    artifactRefs: task.artifact_refs,
    actionCapabilities: task.action_capabilities,
    stopRequested: task.stop_requested,
    approvalMode: task.approval_mode,
  };
}

export function publicTaskPageToJava(
  page: Schemas['PublicTaskList'],
): WebShellTaskPage {
  return {
    data: page.data.map(publicTaskToJava),
    hasMore: page.has_more,
    nextCursor: page.next_cursor,
    activeChildCount: page.active_child_count,
  };
}

function publicTaskEventToJava(
  event: Schemas['PublicTaskEvent'],
): WebShellTaskEvent {
  return {
    schemaVersion: event.schema_version,
    projectionVersion: event.projection_version,
    taskId: event.task_id,
    sessionId: event.session_id,
    type: event.type,
    cursor: event.cursor,
    createdAt: event.created_at,
    state: event.state,
    runtimeState: event.runtime_state,
    text: event.text,
    truncated: event.truncated,
    artifactId: event.artifact_id,
  };
}

export function publicTaskEventPageToJava(page: {
  object: 'list';
  data: Schemas['PublicTaskEvent'][];
  has_more: boolean;
  next_cursor?: string | null;
}): WebShellTaskEventPage {
  return {
    data: page.data.map(publicTaskEventToJava),
    hasMore: page.has_more,
    nextCursor: page.next_cursor ?? '',
  };
}

function publicActionToJava(action: Schemas['PublicAction']): WebShellAction {
  const common = {
    actionId: action.id,
    sessionId: action.session_id,
    source: action.source,
    state: action.state,
    inputRevision: action.input_revision,
    policyRevision: action.policy_revision,
    createdAt: action.created_at,
    expiresAt: action.expires_at,
    decisionReceiptId: action.decision_receipt_id,
    turnId: action.turn_id,
    functionCallId: action.function_call_id,
    toolName: action.tool_name,
  };
  if (action.kind === 'permission') {
    const permission: WebShellPermissionAction = {
      ...common,
      kind: 'permission',
      options: action.options,
      inputPreview: action.input_preview
        ? {
            text: action.input_preview.text,
            truncated: action.input_preview.truncated,
            byteLength: action.input_preview.byte_length,
          }
        : undefined,
    };
    return permission;
  }
  const question: WebShellQuestionAction = {
    ...common,
    kind: 'question',
    questions: action.questions.map(
      (entry): WebShellActionQuestion => ({
        id: entry.id,
        prompt: entry.prompt,
        required: entry.required,
        multiple: entry.multiple,
        allowText: entry.allow_text,
        options: entry.options,
      }),
    ),
  };
  return question;
}

export function publicActionPageToJava(
  page: Schemas['PublicActionList'],
): WebShellActionPage {
  return {
    data: page.data.map(publicActionToJava),
    hasMore: page.has_more,
    nextCursor: page.next_cursor,
  };
}

export function publicCommandOperationToJava(
  operation: Schemas['PublicCommandOperation'],
): WebShellCommandOperation {
  return {
    operationId: operation.id,
    sessionId: operation.session_id,
    type: operation.type,
    taskId: operation.task_id,
    status: operation.status,
    admissionStage: operation.admission_stage,
    deliveryState: operation.delivery_state,
    receiptId: operation.receipt_id,
    actionResolution: operation.action_resolution
      ? {
          actionId: operation.action_resolution.action_id,
          outcome: operation.action_resolution.outcome,
          receiptId: operation.action_resolution.receipt_id,
          decisionReceiptId: operation.action_resolution.decision_receipt_id,
        }
      : undefined,
    failureCode: operation.failure_code,
    replayed: operation.replayed,
  };
}

function publicCwdOperationToJava(
  operation: Schemas['PublicCwdOperation'],
): WebShellCwdOperation {
  return {
    operationId: operation.id,
    sessionId: operation.session_id,
    type: operation.type,
    status: operation.status,
    expectedContextRevision: operation.expected_context_revision,
    targetCwdRelative: operation.target_cwd_relative,
    resultContextRevision: operation.result_context_revision,
    failureCode: operation.failure_code,
    replayed: operation.replayed,
  };
}

function publicContextCompressionOperationToJava(
  operation: Schemas['PublicContextCompressionOperation'],
): WebShellContextCompressionOperation {
  return {
    operationId: operation.id,
    sessionId: operation.session_id,
    type: operation.type,
    status: operation.status,
    expectedCompactionRevision: operation.expected_compaction_revision,
    compactionRevision: operation.compaction_revision,
    outcome: operation.outcome,
    failureCode: operation.failure_code,
    replayed: operation.replayed,
  };
}

export function publicOperationToJava(
  operation: Schemas['PublicOperation'],
): WebShellOperation {
  switch (operation.type) {
    case 'cwd_change':
      return publicCwdOperationToJava(operation);
    case 'context_compression':
      return publicContextCompressionOperationToJava(operation);
    default:
      return publicCommandOperationToJava(operation);
  }
}

export function publicContextCompressionToJava(
  operation: Schemas['PublicContextCompressionOperation'],
): WebShellContextCompressionOperation {
  return publicContextCompressionOperationToJava(operation);
}

export function publicTurnAdmissionToJava(
  admission: Schemas['TurnCommandAdmission'],
): WebShellTurnAdmission {
  return {
    sessionId: admission.session_id,
    turnId: admission.turn_id,
    status: admission.status,
    replayed: admission.replayed,
    operationId: admission.operation_id,
    admissionStage: admission.admission_stage,
    deliveryState: admission.delivery_state,
  };
}

export function publicSessionApprovalToJava(
  approval: Schemas['PublicSessionApproval'],
): WebShellSessionApproval {
  return {
    liveSupported: approval.live_supported,
    approvalMode: (approval.approval_mode ?? 'default') as ApprovalMode,
    approvalRevision: approval.approval_revision,
    availableApprovalModes: approval.available_approval_modes as ApprovalMode[],
    supported: approval.supported,
    planMode: approval.plan_mode,
    planModeSupported: approval.plan_mode_supported,
    permissionRules: permissionRulesToJava(approval.permission_rules),
    permissionRulesSupported: approval.permission_rules_supported,
  };
}

export function publicApprovalChangeResultToJava(
  result: Schemas['PublicApprovalChangeResult'],
): WebShellApprovalChangeResult {
  return {
    sessionId: result.session_id,
    approvalMode: (result.approval_mode ?? 'default') as ApprovalMode,
    approvalRevision: result.approval_revision,
    replayed: result.replayed,
    planMode: result.plan_mode,
    permissionRules: permissionRulesToJava(result.permission_rules),
  };
}

export function publicSessionModelsToJava(
  models: Schemas['PublicSessionModels'],
): WebShellSessionModels {
  return {
    models: models.models.map((model) => ({
      modelId: model.model_id,
      label: model.label,
    })),
    modelSelection: publicModelSelectionToJava(models.model_selection),
    supported: models.supported,
  };
}

export function publicModelChangeResultToJava(
  result: Schemas['PublicModelChangeResult'],
): WebShellModelChangeResult {
  return {
    sessionId: result.session_id,
    modelSelection: publicModelSelectionToJava(result.model_selection),
    replayed: result.replayed,
  };
}

export function publicSessionOptionsToJava(
  options: Schemas['PublicSessionOptions'],
): WebShellSessionOptions {
  return {
    approvalMode: (options.approval_mode ?? 'default') as CreationApprovalMode,
    availableApprovalModes:
      options.available_approval_modes as CreationApprovalMode[],
    planModeSupported: options.plan_mode_supported,
    inputAttachments: options.input_attachments,
    modelSelectionSupported: options.model_selection_supported,
    skillsSupported: options.skills_supported,
  };
}

export function publicSessionSkillsToJava(
  skills: Schemas['PublicSessionSkills'],
): WebShellSessionSkills {
  return { skills: skills.skills };
}

function publicShellResultToJava(
  result: Schemas['PublicShellResult'],
): WebShellShellResult {
  return {
    type: result.type,
    version: result.version,
    text: result.text,
    output: result.output,
    directory: result.directory,
    exitCode: result.exit_code,
    signal: result.signal,
    pid: result.pid,
    error: result.error,
    outcome: result.outcome,
    notices: result.notices,
    truncated: result.truncated,
    outputFiles: result.output_files,
  };
}

export function publicToolDetailsToJava(
  details: Schemas['PublicToolDetails'],
): WebShellToolDetails {
  return {
    input: details.input,
    output: details.output,
    truncated: details.truncated,
    shellResult: details.shell_result
      ? publicShellResultToJava(details.shell_result)
      : undefined,
  };
}

export function publicFileQueryResultToJava(
  result: Schemas['PublicFileQueryResult'],
): WebShellWorkspaceFilePage {
  return {
    scopeRevision: result.scope_revision,
    directory: result.directory,
    entries: result.entries.map((entry) => ({
      path: entry.path,
      name: entry.name,
      kind: entry.kind as 'file' | 'directory',
    })),
    truncated: result.truncated,
    maxUploadBytes: result.max_upload_bytes ?? undefined,
  };
}

export function publicFileResultToJava(
  result: Schemas['PublicFileResult'],
): WebShellWorkspaceFileSnapshot {
  return {
    scopeRevision: result.scope_revision,
    path: result.path,
    name: result.name,
    mimeType: result.mime_type as 'text/plain',
    text: result.text,
    byteLength: result.byte_length,
    sha256: result.sha256,
  };
}

export function publicFileUploadResultToJava(
  result: Schemas['PublicFileUploadResult'],
): WebShellWorkspaceFileUploadResult {
  return {
    scopeRevision: result.scope_revision,
    uploadId: result.upload_id,
    path: result.path,
    sizeBytes: result.size_bytes,
    sha256: result.sha256,
  };
}

export function publicFileUploadStatusToJava(
  status: Schemas['PublicFileUploadStatus'],
): WebShellWorkspaceFileUploadStatus {
  return {
    scopeRevision: status.scope_revision,
    uploadId: status.upload_id,
    path: status.path,
    sizeBytes: status.size_bytes,
    sha256: status.sha256 ?? '',
    state: status.state as 'completed' | 'failed' | 'pending',
    code: status.code ?? undefined,
  };
}

export function publicDirectoryPageToJava(
  page: Schemas['PublicWorkspaceDirectoryPage'],
): WebShellWorkspaceDirectoryPage {
  return {
    root: page.root,
    cwdRelative: page.cwd_relative,
    truncated: page.truncated,
    directories: page.directories.map((directory) => ({
      name: directory.name,
      cwdRelative: directory.cwd_relative,
    })),
  };
}

export function publicDirectoryToJava(
  directory: Schemas['PublicWorkspaceDirectory'],
): WebShellWorkspaceDirectory {
  return {
    nodeId: directory.node_id,
    canonicalPath: directory.canonical_path,
    platform: directory.platform,
  };
}

export function publicRuntimeNodePageToJava(
  page: Schemas['PublicRuntimeNodePage'],
): WebShellRuntimeNodePage {
  return {
    supported: page.supported,
    data: page.data.map((node) => ({
      nodeId: node.node_id,
      displayName: node.display_name,
    })),
  };
}

export function publicWorkspaceRegistrationToJava(
  operation: Schemas['PublicWorkspaceRegistrationOperation'],
): WebShellWorkspaceCreateOperation {
  return {
    operationId: operation.operation_id,
    type: operation.type,
    status: operation.status,
    workspaceId: operation.workspace_id,
    failureCode: operation.failure_code,
    replayed: operation.replayed,
  };
}

export function publicWorktreeOptionsToJava(
  options: Schemas['SessionWorktreeOptions'],
): WebShellSessionWorktreeOptions {
  return {
    supported: options.supported,
    reason: options.reason,
    baseCommit: options.base_commit,
    currentBranch: options.current_branch,
    branches: options.branches,
  };
}

export function publicWorktreePageToJava(
  page: Schemas['SessionWorktreePage'],
): WebShellSessionWorktreePage {
  return { data: page.data.map(publicWorktreeToJava) };
}

export function publicWorktreeInspectionToJava(
  inspection: Schemas['SessionWorktreeInspection'],
): WebShellSessionWorktreeInspection {
  return {
    worktree: publicWorktreeToJava(inspection.worktree),
    canCleanup: inspection.can_cleanup,
    cleanupBlocker: inspection.cleanup_blocker,
  };
}

function publicSideQueryPrefixToJava(
  prefix: Schemas['SideQueryPrefix'],
): WebShellSideQueryPrefix {
  return {
    journalRevision: prefix.journal_revision,
    committedSequence: prefix.committed_sequence,
    lastCommitDigest: prefix.last_commit_digest,
    completedTurnSequence: prefix.completed_turn_sequence,
    contentVersion: prefix.content_version,
    completedUserTurnCount: prefix.completed_user_turn_count,
    mainInputBoundary: prefix.main_input_boundary,
  };
}

export function publicSideQueryToJava(
  query: Schemas['SideQuery'],
): WebShellSideQuery {
  return {
    queryId: query.query_id,
    sessionId: query.session_id,
    kind: query.kind,
    trigger: query.trigger,
    question: query.question,
    status: query.status,
    outcome: query.outcome,
    source: publicSideQueryPrefixToJava(query.source),
    resultRevision: query.result_revision,
    text: query.text,
    usage: query.usage,
    errorCode: query.error_code,
    createdAt: query.created_at,
    updatedAt: query.updated_at,
    deadlineAt: query.deadline_at,
  };
}

export function publicSideQueryContextToJava(
  context: Schemas['SideQueryContext'],
): WebShellSideQueryContext {
  return {
    actorScopeKey: context.actor_scope_key,
    contentVersion: context.content_version,
    completedUserTurnCount: context.completed_user_turn_count,
    mainInputBoundary: context.main_input_boundary,
    automaticEligible: context.automatic_eligible,
    generationAvailable: context.generation_available,
    unavailableReason: context.unavailable_reason,
    latestRecapContentVersion: context.latest_recap_content_version,
    latestRecapUserTurnCount: context.latest_recap_user_turn_count,
  };
}

export function publicSideQueryPageToJava(
  page: Schemas['SideQueryPage'],
): WebShellSideQueryPage {
  return {
    items: page.items.map(publicSideQueryToJava),
    nextCursor: page.next_cursor,
  };
}
