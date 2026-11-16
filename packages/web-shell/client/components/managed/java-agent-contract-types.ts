/**
 * The camelCase contract between the Java managed agent client, its provider
 * and the Web Shell components, frozen verbatim from the generated WebShell
 * schemas at OpenAPI 1.122.0 (commit 26f69b8064, before the generator switched
 * to the Public operation set in slice 4b).
 *
 * The wire is now the Public REST surface (snake_case, epoch seconds for
 * Session/Turn/Event/Item); java-managed-public-adapter.ts converts Public
 * responses into these shapes and these request shapes into Public calls.
 * Downstream components keep consuming this contract unchanged. Shared
 * schemas that the Public contract still generates (SessionRecovery,
 * InputBlock, TaskState, ...) are referenced through the generated
 * components type, not duplicated here. ManagedPermissionRules is the one
 * exception: the Public approval schemas inline the rules map, so the named
 * schema is pruned by the Public-only render and is frozen here as well.
 *
 * Slice 4c may rename these types; their shapes are the stable client API.
 */
import type { components } from './generated/managed-agent-api';

export type ManagedPermissionRules = {
  allow: string[];
  ask: string[];
  deny: string[];
};

export type WebShellAction = WebShellPermissionAction | WebShellQuestionAction;

export type WebShellActionInputPreview = {
  /** @description Exact UTF-8 prefix of payloadJson ({toolName,input}). Ordinary tools retain the 8192-byte preview. exit_plan_mode includes its complete input within the 64 KiB resource ceiling so a plan can be reviewed after refresh. Truncated ordinary previews may not be valid JSON. */
  text: string;
  /** @description True when text is shorter than the complete UTF-8 input. */
  truncated: boolean;
  /**
   * Format: int64
   * @description Byte length of the complete payloadJson in UTF-8, before truncation.
   */
  byteLength: number;
};

export type WebShellActionOption = {
  id: string;
  label: string;
  description?: string;
};

export type WebShellActionPage = {
  data: WebShellAction[];
  hasMore: boolean;
  nextCursor?: string | null;
};

export type WebShellActionQueryRequest = {
  /** Format: uuid */
  sessionId: string;
  cursor?: string;
  /** @default 20 */
  limit?: number;
  /**
   * @description Include pending Actions of this public root Session and its direct children; each Action retains its actual owning sessionId.
   * @default false
   */
  includeChildren?: boolean;
};

export type WebShellActionQuestion = {
  id: string;
  prompt: string;
  required: boolean;
  multiple: boolean;
  allowText: boolean;
  options: WebShellActionOption[];
};
/** @description Receipt IDs are opaque authorized product handles, not private journal or storage refs. Input completion means a Harness admitted its Turn, not that the Turn completed; an input whose Turn failed after a submission no Harness answered is recovery_blocked until the Session journal proves whether a Harness admitted it. For submit_input and task cancel, recovery_blocked means acceptance is unknown: the operation is never delivered again and settles only from its own durable evidence. For close and delete it is a published wait that delivery re-drives. Cancel completion means its Turn reached cancelled; a cancel fails with turn_already_settled when its Turn ended otherwise, except one that already existed when its Turn failed with managed_runtime_recovery_blocked after a Harness admitted it or a submission was attempted, which parks recovery_blocked with cancel_unconfirmed. A cancel submitted after the Turn ended still fails turn_already_settled. Action completion may only record one vote. Lifecycle completion requires its cleanup facts; archive may remain java_durable because Java is its authority. Task cancel 202 is Java durable admission; completion means the authority durably recorded cancellation and returned a receipt, not that the task stopped. Task cancel failed proves non-acceptance and no further delivery, with a failure code; recovery_blocked means acceptance is unknown and needs reconciliation before re-execution. Its status is never cancelled. Physical settlement and an unknown physical outcome belong to the task, independently of operation acceptance. A completed task cancel carries admission stage harness_confirmed and delivery state confirmed with the authority's receipt; failed and recovery_blocked carry java_durable and blocked, so they are never delivered again without reconciliation. A cancel parked as recovery_blocked/cancel_unconfirmed by unobserved-Turn recovery reconciles only from the original prompt's retained durable terminal event: cancelled completes it, completed or error fails it with turn_already_settled, and missing or unreadable evidence stays parked. A recorded stop request alone does not prove cancellation completed. */

export type WebShellActionResolution = {
  actionId: string;
  /**
   * @description D6 supports decided only; vote_recorded is planned.
   * @enum {unknown}
   */
  outcome: 'vote_recorded' | 'decided';
  receiptId: string;
  decisionReceiptId?: string;
} & unknown;

export type WebShellActionRespondRequest = {
  /** Format: uuid */
  sessionId: string;
  actionId: string;
  idempotencyKey: string;
  response: WebShellActionResponseRequest;
  requestId?: string;
};

export type WebShellActionResponseRequest =
  | WebShellPermissionResponse
  | WebShellQuestionResponse;

export type WebShellActionSource = {
  /** @enum {unknown} */
  kind: 'tool_call' | 'automation_run' | 'team_plan' | 'user_operation';
  id: string;
};
/** @description Validate IDs, required answers, selection cardinality, text eligibility and current responder permission against the original Action. Unknown/expired/cancelled/conflicting revisions cannot grant execution. */

export type WebShellActivityQueryRequest = {
  /** Format: uuid */
  sessionId: string;
  /** @enum {string} */
  kind: 'tools' | 'files' | 'skills';
  cursor?: string;
  /** @default 50 */
  limit?: number;
};

export type WebShellAdmission = {
  /** Format: uuid */
  sessionId: string;
  turnId?: string | null;
  status: string;
  replayed: boolean;
  /** @description Durable operation identifier for turn submission or cancellation. */
  operationId?: string;
  /**
   * @description Persisted admission stage of the operation.
   * @enum {string}
   */
  admissionStage?: 'java_durable' | 'harness_confirmed';
  /**
   * @description Current delivery state of the operation.
   * @enum {string}
   */
  deliveryState?: 'pending' | 'leased' | 'confirmed' | 'blocked';
};

export type WebShellApprovalChangeResult = {
  sessionId: string;
  /** @enum {string} */
  approvalMode: 'default' | 'auto' | 'auto-edit' | 'yolo';
  /** Format: int64 */
  approvalRevision: number;
  replayed: boolean;
  /** @description Persisted public Plan overlay, independent of execution permission. Omission on a change preserves the selected state. */
  planMode?: boolean;
  /** @description Committed rules; omitted when empty. Replayed requests return their original policy receipt. */
  permissionRules?: ManagedPermissionRules;
};

export type WebShellArtifactPage = {
  data: components['schemas']['ArtifactResponse'][];
  nextCursor: string | null;
  hasMore: boolean;
};

export type WebShellCancelRequest = {
  /** @description Trace correlation only. */
  requestId?: string | null;
  idempotencyKey: string;
  /** Format: uuid */
  sessionId: string;
  turnId: string;
};
/** @description Arbitrary caller metadata, as a JSON object (or null). Accepted and ignored in Phase 1: nothing from it is persisted. On WebShellCreateRequest the Session title travels in that request's own `title` field; WebShellSubmitRequest has no title surface. Any keys are valid. */

export type WebShellChangeApprovalRequest = {
  sessionId: string;
  /** Format: int64 */
  expectedRevision: number;
  idempotencyKey: string;
  requestId?: string;
  /** @enum {string} */
  approvalMode: 'default' | 'auto' | 'auto-edit' | 'yolo';
  /** @description Persisted public Plan overlay, independent of execution permission. Omission on a change preserves the selected state. */
  planMode?: boolean;
  /** @description Omission preserves the persisted rules. Supplying three empty arrays clears them. Rule edits require an idle Session, and share the approval revision and idempotency receipt with mode changes. */
  permissionRules?: ManagedPermissionRules;
};

export type WebShellChangeModelRequest = {
  sessionId: string;
  modelId: string;
  /** Format: int64 */
  expectedRevision: number;
  idempotencyKey: string;
  requestId?: string;
};

export type WebShellCommandOperation = {
  operationId: string;
  /** Format: uuid */
  sessionId: string;
  /** @enum {unknown} */
  type:
    | 'create_session'
    | 'submit_input'
    | 'cancel'
    | 'action_response'
    | 'close'
    | 'archive'
    | 'delete'
    | 'task_cancel';
  /** @description Task that a task_cancel operation targets. */
  taskId?: string;
  /** @enum {unknown} */
  status:
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'recovery_blocked';
  /** @enum {unknown} */
  admissionStage: 'java_durable' | 'harness_confirmed';
  /** @enum {unknown} */
  deliveryState: 'pending' | 'leased' | 'confirmed' | 'blocked';
  receiptId?: string;
  actionResolution?: WebShellActionResolution;
  /** @description Reason a durable response or task cancellation failed. Action response failures come from the original committed Action, or a definitive invalid response. Task cancel failures are task_already_settled (the run ended before the stop request was recorded), task_action_unavailable and task_not_found; a recovery_blocked task cancel reports task_cancel_unconfirmed. A lifecycle operation that exhausted its retry budget fails with the settle's failure: session_lifecycle_delivery_failed, managed_capability_mismatch or hosted_harness_protocol_error when the Hosted Harness refused to negotiate, a workspace close or lifecycle refusal (a workspace_close_* or workspace_lifecycle_* code, or runtime_admission_closed; a Runtime Broker runtime_broker_recovery_blocked refusal is reported as workspace_close_identity_unverified), or another Runtime Broker refusal code; one whose settle reached the Harness but stayed unsettled past the larger settled budget fails with session_close_completion_unsettled. A lifecycle recovery_blocked operation reports the refusal it waits on, original resource identity or unsettled execution for a Workspace close, session_close_writer_live while a Harness holds the journal writer or while that check itself fails, or hosted_harness_generation_mismatch while this replica's view of the Harness boot is stale, or hosted_lifecycle_recovery_required while the daemon settles a previous prompt, or hosted_turn_active while a turn, MCP call or hook is still draining; the Session remains closing. A submit_input failure carries its Turn's error code, and a recovery_blocked submit_input reports submit_input_unconfirmed; a cancel fails with turn_already_settled when its Turn completed or failed without being cancelled, except one that already existed when its Turn failed with managed_runtime_recovery_blocked after a Harness admitted it or a submission was attempted: it parks recovery_blocked with cancel_unconfirmed. A cancel submitted after the Turn ended still fails turn_already_settled. A cancel parked as recovery_blocked/cancel_unconfirmed by unobserved-Turn recovery reconciles only from the original prompt's retained durable terminal event: cancelled completes it, completed or error fails it with turn_already_settled, and missing or unreadable evidence stays parked. A recorded stop request alone does not prove cancellation completed. */
  failureCode?: string;
  replayed: boolean;
} & (unknown & unknown & unknown & unknown & unknown);

export type WebShellContentPart = {
  partId: string;
  type: string;
  text: string;
  /** Format: int64 */
  firstSequence: number;
  /** Format: int64 */
  lastSequence: number;
};

export type WebShellContextCompressionOperation = {
  operationId: string;
  /** Format: uuid */
  sessionId: string;
  /** @constant */
  type: 'context_compression';
  /** @enum {string} */
  status: 'pending' | 'running' | 'recovery_blocked' | 'completed' | 'failed';
  /** Format: int64 */
  expectedCompactionRevision: number;
  /** Format: int64 */
  compactionRevision?: number | null;
  /** @enum {string|null} */
  outcome?: 'compressed' | 'noop' | null;
  failureCode?: string | null;
  replayed: boolean;
};

export type WebShellContextCompressionRequest = {
  requestId?: string;
  sessionId: string;
  idempotencyKey: string;
  /** Format: int64 */
  expectedCompactionRevision: number;
};

export type WebShellCreateRequest = {
  /** @description Trace correlation only. */
  requestId?: string | null;
  idempotencyKey: string;
  agentId: string;
  /** @description Optional host-catalog model for a bound built-in qwen-code Session. Requires modelSelectionSupported. Persisted atomically before the first Turn and included in creation idempotency; omission preserves the default model and old digest. */
  modelId?: string;
  modelConfig?: components['schemas']['SessionModelConfig'];
  /** @description The server enforces the bound in UTF-16 code units (Java String.length()), so an astral character counts as two: a title this schema's code-point maxLength accepts can still exceed the server's 256-unit bound and answer 400 invalid_title. */
  title?: string | null;
  /** @description Text has a 4,000,000-character aggregate budget and per-block 1,000,000-character cap, counted in code points. Hosted also enforces its 64 KiB durable-record limit for text-only inputs and a 32 MiB prepared-snapshot ceiling. A complete canonical input containing file/image attachments must fit within 8 MiB and requires input-attachments/1. */
  input?: components['schemas']['InputBlock'][];
  metadata?: WebShellMetadata;
  workspace?: WebShellWorkspaceSelection;
  /**
   * @description Optional initial execution policy for Workspace creation, validated against the resolved Agent and profile. Omission preserves its default and idempotency digest. Independent of planMode.
   * @enum {string}
   */
  approvalMode?: 'default' | 'auto-edit' | 'yolo';
  /** @description Persisted public Plan overlay, independent of execution permission. Omission on a change preserves the selected state. */
  planMode?: boolean;
  /** @description Optional static Skills imported from the enabled management catalog or added explicitly to the pinned AgentDefinition catalog. The merged catalog has unique names, at most 256 entries, 512 KiB per body and 2 MiB compact JSON. Requires session-skills/2; persisted immutably and included in creation idempotency. */
  skills?: components['schemas']['SessionCreationSkill'][];
  /** @description Optional immutable initial extension selection. Omission keeps the legacy configuration path; an explicit empty array starts the unified configuration format. Included in creation idempotency and applied before the first model request. Requires session-extension-packages/1 and an extension-capable original Runtime. */
  extensionPins?: components['schemas']['ManagedExtensionPackagePin'][];
  /** @description Opt into a main Session worktree on supported LOCAL storage. Omission uses the current directory; an empty object freezes HEAD at first admission. Requires an explicit Workspace. Preparation is durable and gates Runtime execution; replay preserves the original commit, directory and branch. */
  worktree?: {
    baseRef?: string;
  };
  /** @description Optional immutable binding to the authenticated user's personal MemoryStore. Omission disables long-term memory. Bound Sessions require owner access as well as existing Workspace grants; creation idempotency includes this field. */
  memoryStoreId?: string;
};

export type WebShellCwdOperation = {
  operationId: string;
  /** Format: uuid */
  sessionId: string;
  /** @constant */
  type: 'cwd_change';
  status: components['schemas']['CwdOperationStatus'];
  /** Format: int64 */
  expectedContextRevision: number;
  targetCwdRelative: components['schemas']['WorkspaceRelativePath'];
  /** Format: int64 */
  resultContextRevision?: number | null;
  failureCode?: string | null;
  replayed: boolean;
} & (unknown & unknown);

export type WebShellDiagnosticTraceRequest = {
  /** Format: uuid */
  sessionId: string;
  cursor?: string | null;
  limit?: number | null;
};

export type WebShellEvent = {
  /** @default 1 */
  schemaVersion?: number;
  /** @default 1 */
  projectionVersion?: number;
  /** Format: int64 */
  sequence: number;
  eventId: string;
  /** Format: uuid */
  sessionId: string;
  turnId?: string | null;
  itemId?: string | null;
  contentPartId?: string | null;
  type: string;
  /** Format: int64 */
  createdAt: number;
  data: {
    [key: string]: unknown;
  };
  terminal: boolean;
};
/** @description Data of the agent.session.resync_required SSE frame. Reload the transcript, then resume after its lastSequence. */

export type WebShellExportPage = {
  items: WebShellItem[];
  nextCursor?: string | null;
  hasMore: boolean;
  /**
   * Format: int64
   * @description Fixed first-request sequence membership upper bound. Bodies and statuses are read live on every page; this does not identify a retained content version.
   */
  snapshotThroughSequence: number;
};

export type WebShellExportRequest = {
  /** Format: uuid */
  sessionId: string;
  cursor?: string | null;
  /** @default 100 */
  limit?: number | null;
};
/** @description Durable Turn input or cancellation admission. The operation identifies the saved command and remains stable across idempotent retries. */

export type WebShellItem = {
  itemId: string;
  /** Format: uuid */
  sessionId: string;
  turnId: string;
  type: string;
  role?: string | null;
  status: string;
  content: WebShellContentPart[];
  attributes: {
    [key: string]: unknown;
  };
  /** Format: int64 */
  firstSequence: number;
  /** Format: int64 */
  lastSequence: number;
  /** Format: int64 */
  createdAt: number;
  /** Format: int64 */
  updatedAt: number;
};
/** @description A committed event, replayed with the versions and identity it was accepted with. A stream.reconciled event is the exception: it means that Harness recovery retracted earlier deltas of its Turn, which now have empty text and no itemId or contentPartId, and that later deltas may name other Parts. Reload the transcript and resume after its lastSequence. */

export type WebShellLifecycleOperation = {
  operationId: string;
  /** @enum {string} */
  type: 'close' | 'archive' | 'delete';
  /** @enum {string} */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'recovery_blocked';
  failureCode?: string | null;
};

export type WebShellLifecycleRequest = {
  /** Format: uuid */
  sessionId: string;
  idempotencyKey: string;
  /** @description Trace-only client request identity, excluded from idempotency digests. */
  requestId?: string | null;
};

export type WebShellListRequest = {
  cursor?: string | null;
  /** @default 20 */
  limit?: number | null;
  /**
   * @description Filter before pagination. Omission preserves all readable, undeleted Sessions. Cursors are bound to the normalized archive state and title query.
   * @default all
   * @enum {string}
   */
  archiveState?: 'unarchived' | 'archived' | 'all';
  /** @description Case-insensitive literal title substring, with surrounding whitespace stripped. Empty means no title filter; %, _ and backslash are literal. Applied before pagination. Cursors are bound to the stripped query and archiveState; listing is not a snapshot across title or archive changes. */
  titleQuery?: string | null;
};

export type WebShellMcpManagementOperationQuery = {
  sessionId: string;
  /** Format: uuid */
  operationId: string;
  requestId?: string;
};

export type WebShellMcpManagementQuery = {
  sessionId: string;
  requestId?: string;
};

export type WebShellMcpManagementSubmit = {
  sessionId: string;
  requestId?: string;
  idempotencyKey: string;
  /** @enum {string} */
  action:
    | 'add'
    | 'edit'
    | 'remove'
    | 'enable'
    | 'disable'
    | 'reload'
    | 'restart';
  serverId: string;
  expectedRevision: number;
  server?: components['schemas']['ManagedMcpServerPin'];
};

export type WebShellMetadata = {
  [key: string]: unknown;
} | null;
/** @description Command admission. Session creation and internal commands may omit operation fields. */

export type WebShellModelChangeResult = {
  sessionId: string;
  modelSelection: WebShellModelSelection;
  replayed: boolean;
};

export type WebShellModelContext = {
  /** @description Actual model identity from the committed main-model usage resource. */
  modelId: string;
  /** @description Provider prompt token count for the latest successfully committed main-model request; not cumulative billing usage. */
  inputTokens?: number;
  /** @description Context capacity from the same resolved model configuration. Missing means unknown. */
  contextWindowSize?: number;
  /** @description Timestamp of the committed source observation, in Unix epoch milliseconds. */
  observedAt: number;
};

export type WebShellModelOption = {
  modelId: string;
  label: string;
};

export type WebShellModelSelection = {
  modelId?: string;
  /** Format: int64 */
  revision: number;
};

export type WebShellOperation =
  | WebShellCwdOperation
  | WebShellCommandOperation
  | WebShellContextCompressionOperation;

export type WebShellOperationRequest = {
  /** Format: uuid */
  sessionId: string;
  operationId: string;
};
/** @description A completed operation returns the committed target revision. A replay returns the same operation identity and latest durable status, with replayed=true; polling itself is not replay. */

export type WebShellPermissionAction = {
  actionId: string;
  /** Format: uuid */
  sessionId: string;
  /** @constant */
  kind: 'permission';
  source: WebShellActionSource;
  /** @enum {unknown} */
  state: 'requested' | 'decided' | 'cancelled' | 'expired';
  /** Format: int64 */
  inputRevision: number;
  policyRevision: string;
  /** Format: int64 */
  createdAt: number;
  /** Format: int64 */
  expiresAt: number;
  decisionReceiptId?: string;
  options: WebShellActionOption[];
  turnId?: string;
  functionCallId: string;
  toolName: string;
  inputPreview?: WebShellActionInputPreview;
} & unknown;

export type WebShellPermissionResponse = {
  /** @constant */
  kind: 'permission';
  /** Format: int64 */
  inputRevision: number;
  policyRevision: string;
  optionId: string;
};

export type WebShellQuestionAction = {
  actionId: string;
  /** Format: uuid */
  sessionId: string;
  /** @constant */
  kind: 'question';
  source: WebShellActionSource;
  /** @enum {unknown} */
  state: 'requested' | 'decided' | 'cancelled' | 'expired';
  /** Format: int64 */
  inputRevision: number;
  policyRevision: string;
  /** Format: int64 */
  createdAt: number;
  /** Format: int64 */
  expiresAt: number;
  decisionReceiptId?: string;
  turnId?: string;
  functionCallId: string;
  toolName: string;
  questions: WebShellActionQuestion[];
} & unknown;
/** @description At most one requested Hosted approval per Turn. allow and deny are stable option IDs. A requested native-tool Action may carry a bounded input preview when the producer supplies an input reference. Version 1 Actions and unavailable inputs omit it. Public timestamps are milliseconds, as recorded by the Harness. Decision receipts are opaque product IDs. */

export type WebShellQuestionAnswer = {
  questionId: string;
  optionIds?: string[];
  text?: string;
} & (unknown | unknown);

export type WebShellQuestionResponse = {
  /** @constant */
  kind: 'question';
  /** Format: int64 */
  inputRevision: number;
  policyRevision: string;
  answers: WebShellQuestionAnswer[];
};

export type WebShellRenameRequest = {
  requestId?: string;
  sessionId: string;
  idempotencyKey: string;
  /** @description The server enforces the bound in UTF-16 code units (Java String.length()), so an astral character counts as two: a title this schema's code-point maxLength accepts can still exceed the server's 256-unit bound and answer 400 invalid_title. */
  title: string;
};

export type WebShellRenameResult = {
  sessionId: string;
  /** @description Current persisted title from the confirmed mutation or completed replay. */
  title: string;
  replayed: boolean;
};

export type WebShellResyncRequired = {
  /** @constant */
  type: 'agent.session.resync_required';
  /** Format: uuid */
  sessionId: string;
  /** Format: int64 */
  replayFloorSequence: number;
  /**
   * Format: int64
   * @description Retained wire name for current message projection coverage; no persisted conversation snapshot is implied.
   */
  snapshotThroughSequence: number;
  /** @constant */
  action: 'reload_snapshot';
};

export type WebShellRuntimeNode = {
  nodeId: string;
  displayName: string;
};
/** @description Disabled registration returns supported=false and no nodes. This capability controls fresh registration only; existing operation queries remain available. */

export type WebShellRuntimeNodePage = {
  /** @default false */
  supported: boolean;
  data: WebShellRuntimeNode[];
} & unknown;

export type WebShellSession = {
  /** Format: uuid */
  sessionId: string;
  title?: string | null;
  agentId: string;
  status: string;
  /** Format: int64 */
  createdAt: number;
  /** Format: int64 */
  updatedAt: number;
  activeTurn?: WebShellTurn | null;
  environment?: {
    [key: string]: unknown;
  } | null;
  /** Format: int64 */
  lastSequence: number;
  workspace?: WebShellWorkspaceContext;
  capabilities: WebShellSessionCapabilities;
  /**
   * @description Current effective approval policy; initialApprovalMode retains the immutable creation policy.
   * @enum {string}
   */
  approvalMode?: 'default' | 'auto' | 'auto-edit' | 'yolo';
  modelContext?: WebShellModelContext;
  modelSelection?: WebShellModelSelection;
  /** Format: int64 */
  approvalRevision?: number;
  /**
   * @description Immutable creation-time policy, used to confirm creation replay.
   * @enum {string}
   */
  initialApprovalMode?: 'default' | 'auto-edit' | 'yolo';
  /** @description Persisted public Plan overlay, independent of execution permission. Omission on a change preserves the selected state. */
  planMode?: boolean;
  /** @description Optional deployment capability; missing means false. */
  planModeSupported?: boolean;
  /**
   * Format: int64
   * @description Sequence of the most recent native context.compacted event; independent of Workspace context revision. Omitted when retained pre-upgrade evidence cannot establish the revision, and context compression is unavailable.
   * @default 0
   */
  compactionRevision?: number | null;
  /** @description Current durable context compression operation, including recovery_blocked; absent when none is active. */
  contextCompressionOperationId?: string | null;
  /** @description Current unsettled lifecycle operation, queried in batch under Session read authorization. A failed close/delete may leave the Session closing/deleting; only explicit retry starts a new operation. Settled Sessions omit this projection. */
  lifecycleOperation?: WebShellLifecycleOperation;
  recovery?: components['schemas']['SessionRecovery'];
  worktree?: WebShellSessionWorktree | null;
};

export type WebShellSessionApproval = {
  /** @description Execution approval can change during a Turn when true. Missing means idle-only; Plan changes remain idle-only. */
  liveSupported?: boolean;
  /** @enum {string} */
  approvalMode: 'default' | 'auto' | 'auto-edit' | 'yolo';
  /** Format: int64 */
  approvalRevision: number;
  availableApprovalModes: ('default' | 'auto' | 'auto-edit' | 'yolo')[];
  supported: boolean;
  /** @description Persisted public Plan overlay, independent of execution permission. Omission on a change preserves the selected state. */
  planMode?: boolean;
  /** @description Optional deployment capability; missing means false. */
  planModeSupported?: boolean;
  /** @description Persisted rules, including when execution capability is unavailable. Omitted when empty. */
  permissionRules?: ManagedPermissionRules;
  /** @description Owner-authorized Session rule editing is available only with Harness permission-rules/1 support. Missing means false. Rule changes require an idle Session. */
  permissionRulesSupported?: boolean;
};

export type WebShellSessionCapabilities = {
  /**
   * @deprecated
   * @description Retired: Session directory-change submission has been removed; always false.
   * @default false
   */
  cwdChange?: boolean;
  /** @default false */
  actions: boolean;
  /**
   * @description True when the caller may submit later Turns of this Workspace-bound Session: the deployment enables Workspace files, the caller holds the OPERATOR role on a Workspace registry row whose state is ACTIVE and still backs the Session's binding, the actor recorded by the Workspace create command keeps OPERATOR or above, and the Session is active and undeleted and is either a qwen-code Session or a Session pinned to a stored definition (both on the Workspace's frozen execution profile). Cancelling only aborts work already running, so an OPERATOR caller may cancel a running Turn even when this is false; the capability does not gate cancellation. False for every other caller and for unbound Sessions, which do not use it. Shell Sessions also require foregroundShell=true for fresh sending; workspaceTurns may remain true with Shell admission disabled and is not sufficient Shell Turn admission. Manual rename uses the independent rename capability.
   * @default false
   */
  workspaceTurns: boolean;
  tasks: boolean;
  artifacts: boolean;
  /**
   * @description Close support including current actor authority. Workspace-bound Sessions require the recorded Session owner and current read access. Source-state and idle admission remain authoritative on the server.
   * @default false
   */
  sessionClose?: boolean;
  /**
   * @description Archive support including current actor authority. Workspace-bound Sessions require completed reliable-close evidence, the recorded Session owner and current read access. Source-state and idle admission remain authoritative on the server.
   * @default false
   */
  sessionArchive?: boolean;
  /**
   * @description Unarchive support including current actor authority. Workspace-bound Sessions require completed reliable-close evidence, the recorded Session owner and current read access. Source-state and idle admission remain authoritative on the server.
   * @default false
   */
  sessionUnarchive?: boolean;
  /**
   * @description Delete support including current actor authority. ACTIVE Workspace Sessions require a supported reliable-close protocol; CLOSED/ARCHIVED Sessions use completed close evidence. Workspace-bound Sessions require the recorded Session owner and current read access. Source-state and idle admission remain authoritative on the server. The aggregate session lifecycle capability is unchanged.
   * @default false
   */
  sessionDelete?: boolean;
  /** @description Present only for persisted Shell Sessions, with no schema default; files and unbound Sessions omit it. True when Workspace files, Shell deployment admission and a valid persisted approval mode are valid. False prevents fresh sending. Disabling only the Shell flag preserves accepted cancellation and approval while Workspace files remain enabled and persisted approval remains valid; files-off or invalid approval can refuse attachment. This capability does not override authorization or recovery refusals. */
  foregroundShell?: boolean;
  /** @description The caller may change the Session model selection for later Turns using the server model catalog, including while a Turn or approval is active. Missing means unsupported; authorization, recovery and revision admission still apply. */
  modelChange?: boolean;
  /** @description The caller owns this eligible Workspace Session with current OPERATOR or OWNER access. Built-in qwen-code requires approval-selection/1; stored AgentDefinitions on exactly hosted-workspace-files/1, hosted-workspace-files/3, hosted-workspace-shell/1 or hosted-workspace-shell/3 also require agent-definition-approval-selection/1. Idle-state admission is checked separately. Missing means false. */
  approvalModeChange?: boolean;
  /** @description Optional deployment capability; missing means false. */
  inputAttachments?: boolean;
  /**
   * @description True for a visible ACTIVE Session when the Harness supports fenced title persistence and is available. Workspace-bound Sessions additionally require Workspace files admission, current OPERATOR access and the original binding's frozen execution facts, independently of approval or fresh Turn sending support. Unbound Sessions use the existing tenant-scoped rename permission. An active Turn does not itself make this false. Missing means false. This advertises fresh rename only; authorized completed original-key replay remains available under the rename service's replay rules.
   * @default false
   */
  rename?: boolean;
  /**
   * @description Requires a compatible Hosted Harness and an active Workspace Session. WebShell also reflects the current caller OPERATOR or OWNER grant; admission separately checks idle state.
   * @default false
   */
  contextCompression?: boolean;
  /**
   * @description Public child orchestration support for this persisted Session; launch and caller authorization are checked separately.
   * @default false
   */
  childAgents?: boolean;
  /**
   * @description Passive persisted context, model statistics, resource inventory and direct child invocation queries are available. Each response declares its observation coverage independently of Runtime readiness or fresh Turn admission.
   * @default false
   */
  diagnostics?: boolean;
  /** @default false */
  btw?: boolean;
  /** @default false */
  recap?: boolean;
  /** @description UI hint that this Session may open a Managed Web Terminal: the terminal deployment opt-in is enabled, the caller may submit (OPERATOR on the bound Workspace), and the Session is a Shell Session. The relay re-runs the full admission on the WebSocket attach; this field does not gate it. */
  terminal?: boolean | null;
  /**
   * @description Browser local-files registration is available for this Session: the Session is bound to a Workspace, the caller holds current execution authority, the deployment enables the client-files relay and the Harness supports it. A Workspace-less Session never advertises this capability. Registration admission still checks the actor grant and idle state separately.
   * @default false
   */
  clientFiles?: boolean;
};

export type WebShellSessionModels = {
  models: WebShellModelOption[];
  modelSelection: WebShellModelSelection;
  supported: boolean;
};

export type WebShellSessionOptions = {
  /** @enum {string} */
  approvalMode: 'default' | 'auto-edit' | 'yolo';
  /** @description Execution policies available at creation. Stored definitions retain their initial policy; existing eligible Sessions may select a policy separately. Plan is an independent overlay. */
  availableApprovalModes: ('default' | 'auto-edit' | 'yolo')[];
  /** @description Optional deployment capability; missing means false. */
  planModeSupported?: boolean;
  /** @description Optional deployment capability; missing means false. */
  inputAttachments?: boolean;
  /** @description Optional capability for modelId on Workspace creation. Missing means false. */
  modelSelectionSupported?: boolean;
  /** @description Optional deployment capability; missing means false. Requires a compatible Harness and durable Session Store. */
  skillsSupported?: boolean;
};
/** @description Safe allowlisted observation for a Workspace-bound Session. Unknown counts are omitted, never estimated. */

export type WebShellSessionPage = {
  data: WebShellSession[];
  nextCursor?: string | null;
  hasMore: boolean;
};

export type WebShellSessionSkills = {
  skills: WebShellSkill[];
};

export type WebShellSessionWorktree = {
  id: string;
  sessionId: string;
  workspaceId: string;
  branch: string;
  baseCommit: string;
  cwdRelative: string;
  operationId: string;
  /** @enum {string} */
  state: 'preparing' | 'ready' | 'failed' | 'blocked' | 'removing' | 'removed';
  revision: number;
  errorCode?: string | null;
};

export type WebShellSessionWorktreeCleanupRequest = {
  workspaceId: string;
  worktreeId: string;
  idempotencyKey: string;
};

export type WebShellSessionWorktreeInspection = {
  worktree: WebShellSessionWorktree;
  canCleanup: boolean;
  cleanupBlocker?: string | null;
};

export type WebShellSessionWorktreeOptions = {
  supported: boolean;
  reason?: string | null;
  baseCommit?: string | null;
  /** @description Source checkout branch independent of base ref; HEAD when detached, null when unavailable. */
  currentBranch?: string | null;
  branches: string[];
};

export type WebShellSessionWorktreeOptionsRequest = {
  workspaceId: string;
  cwdRelative: string;
  baseRef?: string;
};

export type WebShellSessionWorktreePage = {
  data: WebShellSessionWorktree[];
};

export type WebShellShellResult = {
  /** @constant */
  type: 'shell_result';
  /** @constant */
  version: 1;
  text: string;
  output: string;
  directory: string;
  exitCode: number | null;
  signal: number | null;
  pid: number | null;
  error: string | null;
  /** @enum {string} */
  outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out';
  notices: string[];
  truncated: boolean;
  outputFiles: string[];
};

export type WebShellSideQuery = {
  /** Format: uuid */
  queryId: string;
  /** Format: uuid */
  sessionId: string;
  /** @enum {unknown} */
  kind: 'btw' | 'recap';
  /** @enum {unknown} */
  trigger: 'manual' | 'automatic';
  question: string | null;
  /** @enum {unknown} */
  status:
    | 'preparing'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';
  outcome: string | null;
  source: WebShellSideQueryPrefix;
  resultRevision: number;
  text: string | null;
  usage: {
    [key: string]: unknown;
  } | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
};

export type WebShellSideQueryContext = {
  actorScopeKey: string;
  contentVersion: string | null;
  completedUserTurnCount: number;
  mainInputBoundary: number;
  automaticEligible: boolean;
  generationAvailable: boolean;
  unavailableReason: string | null;
  latestRecapContentVersion: string | null;
  latestRecapUserTurnCount: number | null;
};

export type WebShellSideQueryCreateRequest = {
  sessionId: string;
  /** @enum {unknown} */
  kind: 'btw' | 'recap';
  /** @enum {unknown} */
  trigger?: 'manual' | 'automatic';
  question?: string;
  expectedContentVersion?: string;
  expectedMainInputBoundary?: number;
  idempotencyKey: string;
  requestId?: string;
};

export type WebShellSideQueryPage = {
  items: WebShellSideQuery[];
  nextCursor: string | null;
};

export type WebShellSideQueryPrefix = {
  journalRevision: number;
  committedSequence: number;
  lastCommitDigest: string | null;
  completedTurnSequence: number;
  contentVersion: string;
  completedUserTurnCount: number;
  mainInputBoundary: number;
};

export type WebShellSkill = {
  name: string;
  description: string;
};

export type WebShellStreamRequest = {
  /** Format: uuid */
  sessionId: string;
  /**
   * Format: int64
   * @default 0
   */
  afterSequence?: number | null;
};

export type WebShellSubmitRequest = {
  /** @description Trace correlation only. */
  requestId?: string | null;
  idempotencyKey: string;
  /** Format: uuid */
  sessionId: string;
  /** @description Text has a 4,000,000-character aggregate budget and per-block 1,000,000-character cap, counted in code points. Hosted also enforces its 64 KiB durable-record limit for text-only inputs and a 32 MiB prepared-snapshot ceiling. A complete canonical input containing file/image attachments must fit within 8 MiB and requires input-attachments/1. */
  input?: components['schemas']['InputBlock'][];
  metadata?: WebShellMetadata;
};

export type WebShellTask = {
  taskId: string;
  /** Format: uuid */
  sessionId: string;
  /**
   * Format: uuid
   * @description The child Session that runs this task: present for a child_agent or workflow task once the run's committed record names it (the child's attach, or a terminal verdict that names a minted child), and absent for every other kind and before then. The child is a Session in the same Workspace, readable by exactly the callers that can read this task, so its Turns, items and events are the task's own output; reading them needs no other grant.
   */
  childSessionId?: string;
  kind: components['schemas']['TaskKind'];
  state: components['schemas']['TaskState'];
  /**
   * Format: int64
   * @description Immutable definition revision this run is pinned to, when the kind has a definition.
   */
  definitionRevision?: number;
  runtimeState?: components['schemas']['TaskRuntimeState'];
  /**
   * Format: int64
   * @description Unix epoch milliseconds.
   */
  createdAt: number;
  /**
   * Format: int64
   * @description Unix epoch milliseconds.
   */
  startedAt?: number;
  /**
   * Format: int64
   * @description Unix epoch milliseconds.
   */
  settledAt?: number;
  /** @description Stable task event cursor after the committed tail at view read time. No event can later appear at or before it. Pass it as after to follow only new events; recovery must instead keep its saved event page cursor so it does not skip intervening output. Normal retention may expire it. */
  outputCursor?: string;
  /** @description The newest Artifacts that hold durable task output, at most 100, oldest first. Entries must not rotate out until older Artifacts can be enumerated and attributed to the task: an evicted Artifact stays readable by id through the Session artifact routes but is no longer discoverable from the task. */
  artifactRefs: string[];
  actionCapabilities: components['schemas']['TaskActionCapability'][];
  /** @description A durable stop request has been recorded. This does not prove that the task has terminated. */
  stopRequested?: boolean;
  /**
   * @description The actual immutable approval mode of this public child Session.
   * @enum {string}
   */
  approvalMode?: 'default' | 'auto-edit' | 'yolo';
} & (unknown & unknown & unknown & unknown & unknown);

export type WebShellTaskCancelRequest = {
  /** @description Trace correlation only; excluded from the request digest, so a retry with another requestId still replays. A header-safe value (1 to 128 visible ASCII characters) is echoed as X-Request-Id; any other value is replaced by a server-chosen id. */
  requestId?: string | null;
  /** Format: uuid */
  sessionId: string;
  taskId: string;
  idempotencyKey: string;
};
/** @description state_changed, output or artifact. The set is open: a later minor version may add types and optional fields. Clients ignore unknown optional fields and unknown types, while still checkpointing event cursors; strict validation against an older minor response schema is not supported. Existing fields forbidden for a known type cannot be repurposed on that type. */

export type WebShellTaskEvent = {
  schemaVersion: number;
  projectionVersion: number;
  taskId: string;
  /** Format: uuid */
  sessionId: string;
  type: components['schemas']['TaskEventType'];
  /** @description Stable opaque position after this event and its identity. Atomically apply the event and save this cursor to avoid duplicate application after a crash. It is never reassigned; normal retention can expire it. */
  cursor: string;
  /** Format: int64 */
  createdAt: number;
  state?: components['schemas']['TaskState'];
  runtimeState?: components['schemas']['TaskRuntimeState'];
  text?: string;
  /** @description True when the chunk was cut to the event limit; its full output is already durably readable and discoverable in the task Artifacts when the event is published. */
  truncated?: boolean;
  artifactId?: string;
} & (unknown & unknown & unknown);

export type WebShellTaskEventPage = {
  data: WebShellTaskEvent[];
  hasMore: boolean;
  /** @description The last returned event cursor, never passing an event held back by limit. On an empty page, the requested position, or the durable retention floor if after was omitted. Required and never null, including when no events remain. No event may later become visible at or before this position. */
  nextCursor: string;
};

export type WebShellTaskEventQueryRequest = {
  /** Format: uuid */
  sessionId: string;
  taskId: string;
  /** @description Opaque task event cursor: an event cursor, a page nextCursor or a task outputCursor. Omit it to read from the durable retention floor. Strictly below the floor is 409 cursor_expired; equality is valid, including with no retained events. */
  after?: string;
  /** @default 20 */
  limit?: number;
};

export type WebShellTaskGetRequest = {
  /** Format: uuid */
  sessionId: string;
  taskId: string;
};

export type WebShellTaskPage = {
  data: WebShellTask[];
  hasMore: boolean;
  nextCursor?: string | null;
  /** @description The total number of nonterminal child Agent tasks in this Session, independent of pagination. */
  activeChildCount?: number;
} & unknown;
/** @description One task event: a logical state change, a bounded output chunk, or an Artifact reference. High-volume output goes to Artifacts or bounded chunks in this paged stream, never one Session event per raw line. The closed schema validates the server's own version; clients ignore unknown optional fields and unknown types and checkpoint their cursors. Strict response validation against an older minor version is not supported. Event identity, position, payload and accepted schema/projection versions are immutable across restart, projection rebuild and archival. */

export type WebShellTaskQueryRequest = {
  /** Format: uuid */
  sessionId: string;
  cursor?: string;
  /** @default 20 */
  limit?: number;
};

export type WebShellToolDetails = {
  /** @description Allowlisted display arguments, or null when unavailable or larger than 4 KiB. */
  input: {
    [key: string]: unknown;
  } | null;
  /** @description Recorded text or error, bounded to 8 KiB and 200 lines; null means unavailable, an empty string means recorded empty output. */
  output: string | null;
  truncated: boolean;
  /** @description Validated saved Shell display, when available. Text fields share an 8 KiB/200-line budget; directory and output-file paths share an 8 KiB UTF-8 budget. Legacy text remains in output. */
  shellResult?: WebShellShellResult;
};

export type WebShellTerminalTicketRequest = {
  sessionId: string;
  terminalId: string;
};

export type WebShellTerminalTicket = {
  ticket: string;
  /** Format: int64 */
  expiresInSeconds: number;
};

export type WebShellTranscript = {
  items: WebShellItem[];
  events: WebShellEvent[];
  /**
   * Format: int64
   * @description Actual message projection coverage of this read; resume SSE after this sequence.
   */
  coveredSequence: number;
  olderCursor?: string | null;
  hasMore: boolean;
  /**
   * Format: int64
   * @description Actual message projection coverage for SSE handoff, equal to coveredSequence; unmaterialized tail events are delivered by SSE.
   */
  lastSequence: number;
};

export type WebShellTranscriptRequest = {
  /** Format: uuid */
  sessionId: string;
  cursor?: string | null;
  /** @default 100 */
  limit?: number | null;
};

export type WebShellTurn = {
  turnId: string;
  /** Format: uuid */
  sessionId: string;
  /** @description recovery_blocked with hosted_harness_recovery_blocked means the Harness stopped without a safely settled Turn. The input remains active internally. Execution redispatch is parked, while bounded read-only observation of the original Harness journal may settle a later terminal result. Policy changes and lifecycle close wait for settlement; explicit cancellation remains available. */
  status: string;
  /** Format: int64 */
  submittedAt: number;
  /** Format: int64 */
  completedAt?: number | null;
  errorCode?: string | null;
};

export type WebShellTurnAdmission = {
  /** Format: uuid */
  sessionId: string;
  turnId: string;
  status: string;
  replayed: boolean;
  /** @description Durable operation identifier for turn submission or cancellation. */
  operationId: string;
  /**
   * @description Persisted admission stage of the operation.
   * @enum {string}
   */
  admissionStage: 'java_durable' | 'harness_confirmed';
  /**
   * @description Current delivery state of the operation.
   * @enum {string}
   */
  deliveryState: 'pending' | 'leased' | 'confirmed' | 'blocked';
};
/** @description Session-scoped portable permission-rules/1. Each rule must be trimmed, nonempty, free of control characters, and at most 512 UTF-8 bytes. At most 32 unique strings per list, 64 across all lists and 8192 UTF-8 bytes of compact JSON. Tool names and aliases match whole tools; MCP names may end with a wildcard. Bash/Shell/run_shell_command/monitor command globs and WebFetch/web_fetch(domain:host) are supported; file-path specifiers and arbitrary tool predicates are rejected. Deny takes precedence over ask, then allow, in every mode. Rules do not provide filesystem or process isolation. */

export type WebShellWorkspace = {
  workspaceId: string;
  displayName: string;
  /** @description Current actor permission hint only; creation rechecks ACL, state and Agent/config compatibility. */
  canCreateSession: boolean;
  /** @enum {string} */
  state: 'active' | 'draining' | 'removed';
  /** @description Persisted default working directory for new WebShell Sessions; absent means dot. */
  defaultCwdRelative?: string;
  /** @description Current actor owns this active root Workspace; directory discovery rechecks authorization and native storage. */
  canSelectDirectory?: boolean;
};

export type WebShellWorkspaceContext = {
  workspaceId: string;
  cwdRelative: components['schemas']['WorkspaceRelativePath'];
  /** Format: int64 */
  contextRevision: number;
  /** @enum {string} */
  state: 'ready' | 'changing' | 'recovery_blocked';
};

export type WebShellWorkspaceCreateOperation = {
  operationId: string;
  /** @constant */
  type: 'workspace_create';
  /** @enum {string} */
  status:
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'recovery_blocked';
  workspaceId?: string | null;
  failureCode?: string | null;
  replayed: boolean;
};

export type WebShellWorkspaceCreateRequest = {
  /** @description Trimmed display name, without control characters. The server validates the normalized name. */
  displayName: string;
  idempotencyKey: string;
  sourceWorkspaceId?: string;
  cwdRelative?: string;
  /** @description Absolute execution-host directory. Requires localDirectoryImport; exclusive with Workspace-relative fields. An empty path is allowed only for directory browsing and starts at the host home directory. */
  localPath?: string;
};

export type WebShellWorkspaceDirectory = {
  nodeId: string;
  /** @description Canonical absolute path after remote directory validation. */
  canonicalPath: string;
  /** @enum {string} */
  platform: 'linux' | 'darwin';
};

export type WebShellWorkspaceDirectoryPage = {
  root: string;
  cwdRelative: string;
  truncated: boolean;
  directories: {
    name: string;
    cwdRelative: string;
  }[];
};

export type WebShellWorkspaceDirectoryQueryRequest =
  | {
      workspaceId: string;
      cwdRelative: string;
    }
  | {
      /** @description Absolute execution-host directory. Requires localDirectoryImport; exclusive with Workspace-relative fields. An empty path is allowed only for directory browsing and starts at the host home directory. */
      localPath: string;
    };

export type WebShellWorkspaceDirectoryRequest = {
  nodeId: string;
  /** @description Existing absolute directory on the selected node; no directory or repository is created. */
  path: string;
};

export type WebShellWorkspaceFileEntry = {
  path: string;
  name: string;
  /** @enum {string} */
  kind: 'file' | 'directory';
};

export type WebShellWorkspaceFilePage = {
  scopeRevision: string;
  directory: string;
  entries: WebShellWorkspaceFileEntry[];
  truncated: boolean;
  /** @description Present only when the selected CLI supports durable Workspace uploads. */
  maxUploadBytes?: number;
};

export type WebShellWorkspaceFileQueryRequest = {
  workspaceId?: string;
  cwdRelative?: string;
  directory: string;
  query?: string;
  expectedScopeRevision?: string;
  /** Format: uuid */
  sessionId?: string;
} & (unknown | unknown);

export type WebShellWorkspaceFileReadRequest = {
  workspaceId?: string;
  cwdRelative?: string;
  path: string;
  expectedScopeRevision: string;
  /** Format: uuid */
  sessionId?: string;
} & (unknown | unknown);

export type WebShellWorkspaceFileSnapshot = {
  scopeRevision: string;
  path: string;
  name: string;
  /** @enum {string} */
  mimeType: 'text/plain';
  text: string;
  byteLength: number;
  sha256: string;
};

export type WebShellWorkspaceFileUploadResult = {
  scopeRevision: string;
  /** Format: uuid */
  uploadId: string;
  path: string;
  sizeBytes: number;
  sha256: string;
};

export type WebShellWorkspaceFileUploadStatus = {
  scopeRevision: string;
  /** Format: uuid */
  uploadId: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  /** @enum {string} */
  state: 'completed' | 'failed' | 'pending';
  code?: string;
};

export type WebShellWorkspacePage = {
  data: WebShellWorkspace[];
  hasMore: boolean;
  nextCursor?: string | null;
  capabilities: {
    /**
     * @description Same end-to-end W0 readiness as public workspace_context; missing means unsupported.
     * @default false
     */
    workspaceContext: boolean;
    /** @description Supports authorized Workspace discovery, Session creation, and saved binding read-back. This capability does not advertise execution readiness. Deployments may separately opt in to an initial Workspace Turn at creation: Read/Write/Edit under hosted-workspace-files/1, or file tools plus mandatory-approval foreground Shell under hosted-workspace-shell/1 when the Shell opt-in is enabled. Qualified new public Shell Sessions expose agent by default under the public-child deployment switch and runtime/Harness admission; existing Sessions retain their original tool scope. Callers holding the OPERATOR role may submit later Turns or rename under the same opt-in while the registry row stays ACTIVE and still backs the Session's binding and the actor recorded by the Workspace create command keeps OPERATOR or above, and may cancel a running Turn (its delivery re-checks no grants). Shell fresh sending also requires foregroundShell=true. Public Shell close and active delete require lifecycle v2 and reliable original-Worker stop support; archive and unarchive require completed close proof, while close of other profiles follows its separate capability and lifecycle admission; archive, delete and unarchive follow their separate retention capabilities after reliable Workspace close. */
    workspaceBinding: boolean;
    /** @description Supports creating empty Workspaces under the operator-controlled root. Missing or false means unsupported; current actor and server admission checks still apply. */
    workspaceCreation?: boolean;
    /** @description Supports effective Session policy options and explicit Workspace-bound creation policy. Missing or false means unsupported. */
    approvalModeSelection?: boolean;
    /** @description Supports browsing and selecting existing directories on authorized Linux or macOS storage; absent means unsupported. */
    workspaceDirectorySelection?: boolean;
    /** @description Trusted single-user local deployment can browse and import existing host directories without a pre-registered Workspace. Missing or false means unsupported. */
    localDirectoryImport?: boolean;
  };
  /** @description Same authorized explicit default as default_workspace, including when outside this page; null if absent or not creatable. A non-null default is active and has canCreateSession=true. */
  defaultWorkspace:
    | (WebShellWorkspace & {
        /** @constant */
        state?: 'active';
        /** @constant */
        canCreateSession?: true;
      })
    | null;
};

export type WebShellWorkspaceQueryRequest = {
  cursor?: string | null;
  /** @default 50 */
  limit?: number | null;
};

export type WebShellWorkspaceRegisterRequest = {
  nodeId: string;
  path: string;
  displayName: string;
  /** @description Actor-scoped registration key. Reuse this key and the same semantic fields until the operation identity is known. */
  idempotencyKey: string;
  /** @description Trace correlation only; excluded from the request digest, so a retry with another requestId still replays. A header-safe value (1 to 128 visible ASCII characters) is echoed as X-Request-Id; any other value is replaced by a server-chosen id. */
  requestId?: string | null;
};

export type WebShellWorkspaceSelection = {
  workspaceId: string;
  /** @default . */
  cwdRelative?: components['schemas']['WorkspaceRelativePath'];
};
