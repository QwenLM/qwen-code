/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ApprovalMode,
  GoalControlRequest,
  GoalSnapshotV2,
  GoalStateResponse,
  SessionGroupPresetColor,
  TurnResultCode,
  TurnResultErrorPayload,
} from '@qwen-code/qwen-code-core';
import type {
  CancelNotification,
  ContentBlock,
  LoadSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionResponse,
  ResumeSessionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type {
  BridgeEvent,
  LiveReplayMode,
  SessionReplaySnapshot,
  SubscribeOptions,
} from './eventBus.js';
import type { PermissionPolicy } from './permission.js';
import type {
  SessionArtifactInput,
  SessionArtifactMutationResult,
  SessionArtifactsEnvelope,
} from './sessionArtifacts.js';
import type { SessionAttachmentReference } from './sessionAttachments.js';
import type {
  ServeSessionContextStatus,
  ServeSessionHooksStatus,
  ServeSessionLspStatus,
  ServeSessionSupportedCommandsStatus,
  ServeSessionTasksStatus,
  ServeWorkspaceExtensionsStatus,
  ServeWorkspaceHooksStatus,
  ServeWorkspaceMcpToolsStatus,
  ServeWorkspaceMcpResourcesStatus,
  ServeWorkspaceToolsStatus,
  ServeSessionContextUsageStatus,
  ServeSessionStatsStatus,
} from './status.js';

export interface RewindSnapshotInfo {
  promptId: string;
  turnIndex: number;
  timestamp: string;
  diffStats: { filesChanged: number; insertions: number; deletions: number };
}

/**
 * An ACP child's lifetime V8 old-generation high-water marks, self-reported
 * through the `workspaceResource` extMethod.
 *
 * Observational. Nothing here sizes a child, refuses a spawn, or widens
 * `limits.memory.enforced` — these exist so a future child-heap policy can be
 * judged against real workloads instead of against a refusal count that cannot
 * answer whether a child would survive a smaller ceiling.
 *
 * Every figure covers the **old generation**, the thing
 * `--max-old-space-size` actually bounds, and not `old_space` alone: a child
 * can OOM against its ceiling with `old_space` at 3 MB while
 * `large_object_space` holds everything.
 */
export interface ChildHeapReport {
  /** High-water committed old-generation bytes. Rises with the ceiling the
   *  child was given, so read it as an upper bound on what the workload needs
   *  rather than as its requirement. */
  peakOldGenerationBytes: number;
  /** High-water old-generation bytes still live after a major GC, i.e. what
   *  the workload retains. Independent of the ceiling, which is what makes it
   *  the figure able to say a child cannot fit one. An upper bound rather than
   *  an exact live set: GC entries arrive asynchronously, so allocation
   *  between the collection and the read is counted. 0 when no major GC has
   *  been observed — not a measured zero. */
  peakLiveSetBytes: number;
  /** High-water `total_heap_size`. A cross-check needing no space name; it
   *  includes the young generation, so it cannot localise a missing space. */
  peakTotalHeapBytes: number;
  /** Major collections over the child's lifetime. */
  majorGcCount: number;
  /** Total major-GC pause time in ms — the cost side of a smaller ceiling. */
  majorGcMs: number;
  /** Heap spaces the child could classify as neither old- nor young-
   *  generation. Non-empty means the sums above are incomplete and must not be
   *  read as a full measurement. */
  unclassifiedSpaceNames: string[];
}

export type BridgePromptContentBlock =
  | ContentBlock
  | SessionAttachmentReference;

export type BridgePromptRequest = Omit<PromptRequest, 'prompt'> & {
  prompt: BridgePromptContentBlock[];
};

export interface RewindRequest {
  promptId: string;
  rewindFiles?: boolean;
}

export interface RewindResponse {
  rewound: boolean;
  targetTurnIndex: number;
  filesChanged: string[];
  filesFailed: string[];
  warnings?: string[];
}

export interface BridgeSpawnRequest {
  /** Absolute path to the workspace root the child inherits as cwd. */
  workspaceCwd: string;
  /** Optional explicit model service id; falls back to settings default. */
  modelServiceId?: string;
  /**
   * Optional echo of a daemon-issued client id from a previous attach to the
   * same live session. Unknown ids are ignored on create/attach and replaced
   * with a freshly stamped id.
   */
  clientId?: string;
  /**
   * Per-request override for `sessionScope`. When set, takes precedence
   * over the bridge-wide default (`BridgeOptions.sessionScope`). When
   * omitted, the bridge-wide default applies.
   */
  sessionScope?: 'single' | 'thread';
  /**
   * Id of the session that spawned this one (a `create_sub_session` caller).
   * Recorded as the new session's immutable parent lineage, only when a fresh
   * session is created — an attach never adopts a parent. Absent for a
   * top-level session that no other session spawned.
   */
  parentSessionId?: string;
  /** Immutable attribution supplied by the creator of a fresh session. */
  sourceType?: string;
  /** Optional source-specific identifier. Valid only with `sourceType`. */
  sourceId?: string;
  approvalMode?: ApprovalMode;
  /** Worktree isolation metadata, set by the daemon route before spawn. */
  worktree?: { slug: string; path: string; branch: string };
  /** Branch metadata, set by the daemon route before spawn. */
  branch?: { name: string; baseBranch: string };
  /**
   * Optional caller-supplied session id. When provided, the agent uses this
   * id instead of generating a random UUID. Must be validated at the route
   * boundary since the core Config constructor uses it verbatim. Passed
   * through ACP `_meta` since the protocol's NewSessionRequest has no native
   * sessionId field.
   */
  sessionId?: string;
}

/** Internal daemon-only creation surface for a managed standalone session. */
export interface BridgeStandaloneSpawnRequest {
  /** Runtime ownership root inherited only during provisional bootstrap. */
  workspaceCwd: string;
  /** Daemon-reserved canonical session id for the managed child directory. */
  sessionId: string;
  /** Explicit standalone parent lineage for a depth-1 sub-session. */
  parentSessionId?: string;
  /** Optional explicit model service id; falls back to settings default. */
  modelServiceId?: string;
  approvalMode?: ApprovalMode;
}

export interface BridgeSession {
  sessionId: string;
  /**
   * Runtime ownership root used for routing and persisted-session lookup.
   * This does not change when the agent session changes cwd.
   */
  workspaceCwd: string;
  /** Current agent cwd when it differs from {@link workspaceCwd}. */
  currentCwd?: string;
  /** True if this attach reused an existing session under `sessionScope: 'single'`. */
  attached: boolean;
  /**
   * Opaque daemon-issued id for the attaching HTTP client. Subsequent
   * session-scoped requests may echo it so daemon events can identify the
   * initiating client without trusting request bodies.
   */
  clientId?: string;
  /** ISO 8601 timestamp of when the session was created. */
  createdAt?: string;
  /** True while the live session has an in-flight prompt. */
  hasActivePrompt?: boolean;
  /**
   * Only present when this spawn carried a `parentSessionId`. `true` iff the
   * parent lineage was durably written to the child's transcript (survives a
   * daemon restart); `false` means the link is live-only and will disappear
   * from the persisted session list on restart. Lets `create_sub_session` / the
   * SDK distinguish a durably linked child from a degraded one instead of
   * treating every spawn as an equally successful link.
   */
  parentSessionPersisted?: boolean;
  /** Immutable creator attribution for this session, when supplied. */
  sourceType?: string;
  /** Optional source-specific identifier paired with `sourceType`. */
  sourceId?: string;
  /** True iff the source metadata was durably written to the transcript. */
  sourcePersisted?: boolean;
  /** Present when the session was created with worktree isolation. */
  worktree?: { slug: string; path: string; branch: string };
  /** Present when the session was created with a new branch. */
  branch?: { name: string; baseBranch: string };
}

export interface BridgeRestoreSessionRequest {
  /** Session id to restore through ACP `session/load` or `session/resume`. */
  sessionId: string;
  /** Absolute path to the workspace root the child inherits as cwd. */
  workspaceCwd: string;
  /** Optional echo of a daemon-issued client id for this session. */
  clientId?: string;
  /** Internal replay transport for `session/load`; defaults to stream. */
  historyReplay?: 'stream' | 'response';
  /** Optional newest persisted-record page requested for response replay. */
  historyPageSize?: number;
  /** Load-only live-turn replay projection; defaults to the complete journal. */
  liveReplayMode?: LiveReplayMode;
  /** Keep inherited fork records as model context without replaying them. */
  hideInheritedHistory?: boolean;
  approvalMode?: ApprovalMode;
  /**
   * Persisted parent lineage recovered from the transcript by the caller (the
   * serve layer reads it before restore). Re-seeds the restored live entry so a
   * restored sub-session's `getSessionSummary`/status still reports its parent
   * after a daemon restart — the entry is otherwise created without it. Absent
   * for a top-level session.
   */
  parentSessionId?: string;
  /** Persisted creator attribution recovered from the transcript. */
  sourceType?: string;
  /** Optional persisted identifier paired with `sourceType`. */
  sourceId?: string;
}

/** Internal daemon-only restore surface for a managed standalone session. */
export type BridgeStandaloneRestoreSessionRequest = Omit<
  BridgeRestoreSessionRequest,
  'sourceType' | 'sourceId'
>;

export const LOAD_REPLAY_MODE_META_KEY = 'qwen.session.loadReplayMode';
export const LOAD_REPLAY_META_KEY = 'qwen.session.loadReplay';
export const LOAD_REPLAY_PAGE_SIZE_META_KEY = 'qwen.session.loadReplayPageSize';
export const LOAD_REPLAY_HIDE_INHERITED_META_KEY =
  'qwen.session.loadReplayHideInherited';
export const LOAD_REPLAY_BULK_MODE = 'bulk';
export const LOAD_REPLAY_VERSION = 1 as const;
export const LOAD_REPLAY_MAX_BYTES = 32 * 1024 * 1024;
export const LOAD_REPLAY_MAX_UPDATES = 10_000;

export const REQUESTED_SESSION_ID_META_KEY = 'qwen-code/sessionId';

export const CHANNEL_STARTUP_PROFILE_META_KEY =
  'qwen.daemon.channelStartupProfile';
export const CHANNEL_STARTUP_PROFILE_VERSION = 1 as const;
export const CHANNEL_LIVENESS_META_KEY = 'qwen.daemon.channelLiveness';
export const CHANNEL_LIVENESS_VERSION = 1 as const;
export const ACTIVE_WORK_HEARTBEAT_META_KEY = 'qwen.daemon.activeWorkHeartbeat';
export const ACTIVE_WORK_HEARTBEAT_VERSION = 1 as const;
/** Reporting cadence the daemon asks for; the child may choose another value
 *  inside [MIN, MAX] and the daemon clamps whatever comes back. */
export const ACTIVE_WORK_HEARTBEAT_INTERVAL_MS = 15_000;
export const ACTIVE_WORK_HEARTBEAT_MIN_INTERVAL_MS = 5_000;
export const ACTIVE_WORK_HEARTBEAT_MAX_INTERVAL_MS = 60_000;
/** A channel's cached snapshot goes stale after this many report intervals. */
export const ACTIVE_WORK_STALE_INTERVALS = 3;
export const ACTIVE_WORK_NOTIFICATION_METHOD =
  'qwen/notify/channel/active-work';
export const ACTIVE_WORK_CLOSE_IF_UNHELD_PARAM = 'onlyIfUnheld';
/** Bound on the conditional-close round trip. Its own constant rather than the
 *  handshake timeout: this runs on the automatic-cleanup path, where waiting
 *  longer buys nothing — an unanswered request is simply left for the next
 *  snapshot to settle. */
export const ACTIVE_WORK_CLOSE_TIMEOUT_MS = 10_000;

/**
 * The child's drain budget for a `sessionClose` round trip: strictly under
 * the daemon's outer wait so the child deadline always fires first, clamped
 * to ≥1ms so a tiny outer wait still yields a usable budget. An outer wait
 * that fires first leaves the close outcome unknown, which the close path
 * recovers by killing the whole channel — the coupling lives here exactly
 * once so the ratio cannot drift between call sites.
 */
export function sessionCloseDrainBudgetMs(outerWaitMs: number): number {
  return Math.max(1, Math.floor(outerWaitMs * 0.8));
}
/** Bounds on a single snapshot. Generous next to any real deployment — it
 *  exists so a version-skewed or buggy child cannot make the daemon walk an
 *  unbounded Session list per report. An oversized packet is discarded whole. */
export const ACTIVE_WORK_MAX_SNAPSHOT_SESSIONS = 1024;
/** Shared per-Session hold bound. Oversized snapshots are discarded whole;
 *  oversized close refusals retain the Session without replacing its cache. */
export const ACTIVE_WORK_MAX_SESSION_HOLDS = 1024;
export const WORKTREE_MCP_DEFER_META_KEY = 'qwen.session.deferMcpDiscovery';

/**
 * Work categories a child reports holds for. Monitors, workflows, and cron
 * remain outside `activeWork`'s declared scope. The category travels on every
 * hold so peers can negotiate coverage explicitly when the scope widens.
 */
export type ActiveWorkHoldCategory = 'agent' | 'notification' | 'shell';

/** Categories understood by active-work v1 before category negotiation was
 * added to the daemon's initialize request. */
export const ACTIVE_WORK_LEGACY_HOLD_CATEGORIES: readonly ActiveWorkHoldCategory[] =
  ['agent', 'notification'];

export const ACTIVE_WORK_HOLD_CATEGORIES: readonly ActiveWorkHoldCategory[] = [
  'agent',
  'notification',
  'shell',
];

export interface ActiveWorkHeartbeatCapabilityV1 {
  v: typeof ACTIVE_WORK_HEARTBEAT_VERSION;
  intervalMs: number;
  /** Which categories this child actually reports. A daemon that cares about
   *  a category the child omits degrades its reporting grade rather than
   *  silently treating the gap as "no work". */
  categories: ActiveWorkHoldCategory[];
}

/**
 * Coerce a peer-supplied reporting cadence into the agreed range.
 *
 * Both sides call this on whatever the other side sent. Neither is treated as
 * hostile, but a version-skewed or buggy peer proposing 1ms would flood the
 * transport and one proposing hours would make the daemon's freshness grade
 * meaningless, so the value is never used raw. Anything unusable falls back to
 * the default cadence rather than disabling reporting.
 */
export function clampActiveWorkIntervalMs(raw: unknown): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : NaN;
  if (Number.isNaN(value)) return ACTIVE_WORK_HEARTBEAT_INTERVAL_MS;
  return Math.min(
    ACTIVE_WORK_HEARTBEAT_MAX_INTERVAL_MS,
    Math.max(ACTIVE_WORK_HEARTBEAT_MIN_INTERVAL_MS, Math.round(value)),
  );
}

/**
 * Collapse coverage counts into the grade `/health?deep=1` reports.
 *
 * Deliberately a function over summed counts rather than a per-runtime getter:
 * grades do not compose. A runtime with no Sessions vouches for everything it
 * has, so folding its vacuous `full` in as evidence let an empty workspace
 * vouch for another workspace's unreported Sessions. Callers sum the counts
 * across every runtime first, then grade once.
 */
export function gradeActiveWorkCoverage(totals: {
  total: number;
  covered: number;
  onNegotiatedChannel: number;
}): 'full' | 'partial' | 'none' {
  // No Sessions means nothing is unreported, so the picture is complete.
  if (totals.total === 0 || totals.covered === totals.total) return 'full';
  // `none` is reserved for "not one Session sits on a channel that negotiated
  // reporting" — the case where acting on `activeWork` is unsafe rather than
  // merely degraded.
  return totals.onNegotiatedChannel === 0 ? 'none' : 'partial';
}

export interface ActiveWorkHoldV1 {
  category: ActiveWorkHoldCategory;
  id: string;
}

export interface ActiveWorkSessionSnapshotV1 {
  sessionId: string;
  holds: ActiveWorkHoldV1[];
}

/**
 * A full, channel-wide snapshot: every Session the child currently owns, with
 * every hold it currently holds. Full-snapshot (rather than incremental
 * transition) semantics are what make a dropped report self-correcting in
 * both directions, and a Session's *absence* from a fresh snapshot is
 * positive evidence the child no longer owns it.
 */
export interface ActiveWorkSnapshotV1 {
  v: typeof ACTIVE_WORK_HEARTBEAT_VERSION;
  seq: number;
  sessions: ActiveWorkSessionSnapshotV1[];
}

export interface ChannelStartupProfileV1 {
  v: typeof CHANNEL_STARTUP_PROFILE_VERSION;
  complete: boolean;
  responseBuiltAtEpochMs?: number;
  processToResponseMs?: number;
  phases: {
    processToProfilerReadyMs?: number;
    geminiImportMs?: number;
    argsParseMs?: number;
    settingsLoadMs?: number;
    configConstructionMs?: number;
    appInitializationMs?: number;
    acpImportMs?: number;
    bootstrapConfigInitializationMs?: number;
    transportSetupMs?: number;
    initializeHandlerMs?: number;
    unattributedMs?: number;
  };
  config: {
    extensionsInitialMs?: number;
    hooksMs?: number;
    skillsMs?: number;
    extensionsFinalMs?: number;
    hierarchicalMemoryMs?: number;
    toolRegistryMs?: number;
    ripgrepProbeMs?: number;
    toolWarmupMs?: number;
    otherMs?: number;
  };
}

export interface BridgeLoadReplayEnvelope {
  v: typeof LOAD_REPLAY_VERSION;
  updates: SessionUpdate[];
  anchorRecordId?: string;
  hasMore?: boolean;
  partial?: true;
  replayError?: string;
}

export type BridgeSessionState = (
  | LoadSessionResponse
  | ResumeSessionResponse
) & {
  artifactSnapshot?: unknown;
  artifactSnapshotUnavailable?: unknown;
};

export interface BridgeRestoredSession extends BridgeSession {
  /** ACP state returned by `session/load` / `session/resume`. */
  state: BridgeSessionState;
  /** Artifact restore warnings surfaced during session load/resume. */
  artifactWarnings?: string[];
  /** True when response-mode history replay aborted after emitting a prefix. */
  partial?: true;
  /** Agent-provided replay failure detail when `partial` is true. */
  replayError?: string;
  /** Compacted events for all completed turns (O(turns) size). */
  compactedReplay?: BridgeEvent[];
  /** Bounded replay events for the current incomplete turn. */
  liveJournal?: BridgeEvent[];
  /** True when persisted records exist before the returned replay page. */
  historyHasMore?: boolean;
  /**
   * Fallback pagination anchor: the oldest recordId in the last
   * persisted transcript page, read when the replay snapshot's
   * `history_truncated` marker carries none (live session whose
   * in-flight turn capped the journal
   * before any turn boundary). Clients use it as `beforeRecordId` when
   * no recordId is available in the retained window. Absent when no
   * anchor was needed or none could be read.
   */
  historyAnchorRecordId?: string;
  /** High-water mark event ID — client uses this as initial SSE cursor. */
  lastEventId?: number;
  /**
   * Epoch token of the session's event bus. Clients echo it (with
   * `lastEventId`) on SSE subscribe so a daemon restart between this
   * response and the subscribe is detected deterministically instead of
   * via the numeric heuristic.
   */
  eventEpoch?: string;
  /**
   * True when the compaction engine failed at some point, so
   * `compactedReplay`/`liveJournal` may silently miss events. Clients
   * should prefer the full transcript over this replay.
   */
  replayDegraded?: boolean;
}

export interface BridgeSessionTranscriptPageRequest {
  sessionId: string;
  cursor?: string;
  beforeRecordId?: string;
  /** Internal newest-page read used to refresh an attached session's UI. */
  direction?: 'backward';
  limit?: number;
}

export interface BridgeSessionTranscriptPage {
  v: 1;
  sessionId: string;
  events: BridgeEvent[];
  nextCursor?: string;
  hasMore: boolean;
  startTime?: string;
  lastUpdated?: string;
  partial?: true;
  replayError?: string;
}

export interface BridgeBranchSessionRequest {
  name?: string;
  sourceType?: string;
  sourceId?: string;
  replayInheritedHistory?: boolean;
  atRecordId?: string;
}

export interface BridgePersistedBranchedSession {
  sessionId: string;
  displayName: string;
  forkedFrom: { sessionId: string; displayName: string };
}

export interface BridgeBranchedSession
  extends BridgeRestoredSession,
    BridgePersistedBranchedSession {}

export type BridgeBranchSessionResult =
  | BridgeBranchedSession
  | BridgePersistedBranchedSession;

export interface BridgeSideTaskSessionRequest {
  name?: string;
}

export interface BridgeSideTaskSession extends BridgeRestoredSession {
  displayName: string;
  parentSessionId: string;
}

export interface BridgeForkAgentResult {
  sessionId: string;
  description: string;
  launched: boolean;
}

export interface BridgeConversationDirectoryExpectation {
  canonicalSessionId: string;
  root: {
    canonicalPath: string;
    device: number;
    inode: number;
  };
  child: {
    name: string;
    canonicalPath: string;
    device: number;
    inode: number;
  };
}

export interface ChangeSessionCwdRequest {
  path: string;
  /**
   * Server-controlled containment roots. When present, the agent-side
   * sessionCd handler verifies (after its own realpath) that the
   * canonical target is under one of these roots. Only set by daemon-owned
   * relocation paths; direct user cd omits this field, preserving existing
   * behavior.
   */
  allowedRoots?: string[];
  /**
   * Private daemon capability for a Live conversation directory. The ACP
   * child validates the authenticated parent, private root, and direct child
   * before this may bypass the independent global folder-trust registry.
   */
  managedRelocation?: 'live-conversation';
  /**
   * Exact daemon-pinned identity for a standalone Conversations child.
   * The bridge forwards this proof verbatim; the ACP child validates it
   * before and after mutating the session Config.
   */
  conversationDirectoryExpectation?: BridgeConversationDirectoryExpectation;
}

export interface ChangeSessionCwdResult {
  sessionId: string;
  previousCwd: string;
  newCwd: string;
  warnings: string[];
}

export type BridgeWorkspaceMemoryRememberContextMode = 'workspace' | 'clean';
export type BridgeAutoMemoryTopic =
  | 'user'
  | 'feedback'
  | 'project'
  | 'reference';

export interface BridgeWorkspaceMemoryRememberRequest {
  content: string;
  contextMode: BridgeWorkspaceMemoryRememberContextMode;
}

export interface BridgeWorkspaceMemoryRememberResult {
  summary?: string;
  filesTouched: string[];
  touchedScopes: Array<'user' | 'project'>;
}

export interface BridgeWorkspaceMemoryForgetRequest {
  query: string;
}

export interface BridgeWorkspaceMemoryForgetMatch {
  topic: BridgeAutoMemoryTopic;
  summary: string;
  filePath: string;
}

export interface BridgeWorkspaceMemoryForgetResult {
  summary?: string;
  removedEntries: BridgeWorkspaceMemoryForgetMatch[];
  touchedTopics: BridgeAutoMemoryTopic[];
  touchedScopes: Array<'user' | 'project'>;
}

export interface BridgeWorkspaceMemoryDreamResult {
  summary?: string;
  touchedTopics: BridgeAutoMemoryTopic[];
  dedupedEntries: number;
}

/**
 * Wire-format mirror of `DaemonPendingInteraction*` in
 * `packages/sdk-typescript/src/daemon/types.ts`; keep fields synchronized.
 * Pending interaction details are exposed by live session status endpoints.
 */
export interface BridgePendingInteractionOption {
  optionId: string;
  label?: string;
  kind?: string;
}

export interface BridgePendingPermissionInteraction {
  requestId: string;
  kind: 'permission';
  createdAt: string;
  action: {
    type?: string;
    title?: string;
    content?: unknown;
    locations?: unknown;
    input?: unknown;
  };
  options: BridgePendingInteractionOption[];
}

export interface BridgePendingUserQuestion {
  /** Key to use in `PermissionResponse.answers` when voting. */
  answerKey: string;
  header?: string;
  question?: string;
  options?: Array<{ label?: string; description?: string }>;
  multiSelect?: boolean;
  [key: string]: unknown;
}

export interface BridgePendingUserQuestionInteraction {
  requestId: string;
  kind: 'user_question';
  createdAt: string;
  title?: string;
  questions: BridgePendingUserQuestion[];
  options: BridgePendingInteractionOption[];
}

export type BridgePendingInteraction =
  | BridgePendingPermissionInteraction
  | BridgePendingUserQuestionInteraction;

/** Wire-format mirror of the SDK's `DaemonSessionSummary`; keep fields synchronized. */
export interface BridgeSessionSummary {
  sessionId: string;
  workspaceCwd: string;
  createdAt: string;
  updatedAt?: string;
  displayName?: string;
  /** Id of the session that spawned this one (via `create_sub_session`), or
   * absent for a top-level session. Lets a UI link a sub-session back to its
   * parent. Immutable — set when the session is created. */
  parentSessionId?: string;
  /** Immutable creator attribution, absent on legacy/unattributed sessions. */
  sourceType?: string;
  /** Optional source-specific identifier paired with `sourceType`. */
  sourceId?: string;
  clientCount: number;
  hasActivePrompt: boolean;
  /** True while a non-question permission request awaits a response. */
  isWaitingForPermission?: boolean;
  /** True while an ask_user_question request awaits a response. */
  isWaitingForUserQuestion?: boolean;
  /** Number of permission or user-question interactions awaiting a response. */
  pendingInteractionCount?: number;
  /** True when the most recently completed turn failed. */
  hasTurnError?: boolean;
  /** Present for live sessions in status and workspace-list responses. */
  turnError?: {
    message: string;
    code?: string;
    errorKind?: string;
  };
  /**
   * Pending approvals/questions that can be resolved through the vote API.
   * Present for live sessions in status and workspace-list responses.
   */
  pendingInteractions?: BridgePendingInteraction[];
  isArchived?: boolean;
  isPinned?: boolean;
  pinnedAt?: string;
  groupId?: string | null;
  /** Quick color grouping tag; mutually exclusive with `groupId` in the UI. */
  color?: SessionGroupPresetColor | null;
  /** Present when the session was created with worktree isolation. */
  worktree?: { slug: string; path: string; branch: string };
  /** Present when the session was created with a new branch. */
  branch?: { name: string; baseBranch: string };
  /**
   * GitHub PRs bound to the session, in binding order (last = latest). A
   * session can produce several PRs (stacked or follow-up work).
   */
  prs?: SessionPrInfo[];
}

/**
 * In-memory equality token for daemon-observed session-catalog changes.
 * `generation` is unique to a bridge instance; `revision` increases
 * monotonically within it. The only supported operation is equality over
 * the whole pair — no revision arithmetic, no cross-generation comparison,
 * and conservative extra increments are allowed.
 */
export interface BridgeSessionCatalogVersion {
  readonly generation: string;
  readonly revision: number;
}

/**
 * A session's live canonical Goal state, as reported by the `qwen --acp`
 * child. `active` remains as a compatibility projection for existing hosts.
 */
export interface BridgeSessionGoal {
  snapshot: GoalSnapshotV2;
  active: {
    condition: string;
    /** Canonical Goal turns completed so far. */
    iterations: number;
    setAt: number;
    /** The judge's verdict on the most recent turn, when it has run. */
    lastReason?: string;
  } | null;
}

export interface SessionPrInfo {
  number: number;
  url: string;
  /** Snapshot of the PR's state at last bind/refresh; optional. */
  state?: 'open' | 'merged' | 'closed';
}

export interface SessionMetadataUpdate {
  displayName?: string;
  pr?: SessionPrInfo;
  /** Full binding list after the update (return value only; ignored on input). */
  prs?: SessionPrInfo[];
}

export interface CloseSessionOpts {
  /** Override the default `'client_close'` reason in the `session_closed` event. */
  reason?: string;
  /**
   * Require pending recorder writes to flush successfully. All closes await
   * the ACP child acknowledgement and may cancel in-flight turns even when
   * the close attempt ultimately fails.
   */
  requireAgentClose?: boolean;
  /**
   * Bound the agent-close round trip. The close notification is otherwise
   * unbounded (it only loses to transport close), which is correct for an
   * ordinary close but not when the caller already has reason to believe the
   * child cannot answer. A timeout lands in the same unknown-outcome recovery
   * as any other non-definitive failure: the channel is killed, which is what
   * unblocks callers waiting on the session to drain.
   */
  agentCloseTimeoutMs?: number;
}

export interface BridgeClientRequestContext {
  /** Daemon-issued client id echoed through the HTTP transport header. */
  clientId?: string;
  /**
   * `true` when the request arrived from a loopback peer (kernel-stamped
   * `req.socket.remoteAddress` ∈ {`127.0.0.1`, `::1`, `::ffff:127.0.0.1`}).
   * Populated by permission-vote routes for the `local-only` mediation
   * policy; other routes leave this undefined.
   *
   * **Security**: this is NOT computed from `X-Forwarded-For` or any
   * other forwardable HTTP header — those are forgeable. Callers that
   * reverse-proxy `qwen serve` should not rely on `local-only` (use a
   * dedicated daemon or `designated` policy instead).
   */
  fromLoopback?: boolean;
  /**
   * Caller-generated correlation id for non-blocking prompt mode.
   * When present, the bridge stamps turn-scoped event envelopes with this id.
   * The legacy `turn_complete.data.promptId` / `turn_error.data.promptId`
   * fields remain populated so the SDK's `prompt()` can match the terminal
   * SSE event to the pending HTTP 202 request.
   */
  promptId?: string;
  /**
   * Internal originator for a daemon-owned mid-turn message promoted into the
   * normal prompt FIFO. It was authenticated when the message was enqueued,
   * so promotion must not revalidate it after that client has detached.
   * Transport routes never populate this field from request input.
   */
  promotedMidTurn?: { originatorClientId?: string };
  /**
   * Internal synchronous admission signal. The bridge invokes it only after
   * the prompt owns a pending-queue slot. Transport routes never populate it
   * from request input.
   */
  onPromptAdmitted?: () => void;
  /**
   * Internal model input that replaces the public prompt only inside the
   * trusted ACP child. The bridge still echoes and persists `PromptRequest`
   * unchanged. HTTP routes never populate this from request input.
   */
  modelPrompt?: string;
  /** User-facing projection supplied by an authenticated channel worker. */
  promptDisplayText?: string;
  /**
   * Trusted channel-turn classification injected by the daemon prompt route
   * after validating the channel-worker prompt authorization. Never
   * populated from caller-controlled ACP metadata: `sendPrompt` strips the
   * wire key from untrusted callers and re-injects it only from this flag.
   */
  channelPrompt?: boolean;
  /** Trusted Channel delivery correlation injected by the daemon prompt
   * route. Never populated from caller-controlled ACP metadata. */
  channelDelivery?: {
    deliveryId: string;
    target: {
      channelName: string;
      type: 'user' | 'chat';
      id: string;
    };
  };
  /**
   * Internal: set ONLY by `continueSession` to re-arm the continuation meta
   * key that `sendPrompt` strips from untrusted callers. HTTP routes never
   * populate this from request input, so an external caller cannot use it to
   * smuggle a continuation through the prompt path.
   */
  continue?: boolean;
  /**
   * Internal: set ONLY after load/resume when the child hinted that a trailing
   * ask_user_question should be re-hung. HTTP routes never populate this from
   * request input.
   */
  restoreAskUserQuestion?: boolean;
  /**
   * Absolute wallclock budget (ms) for this prompt, measured from admission
   * (the 202 semantic point) and covering queue wait. When exceeded, the
   * bridge publishes a `turn_error{code:'prompt_deadline_exceeded'}` terminal,
   * releases the FIFO, and best-effort cancels the agent. Populated by the
   * REST prompt route from `resolvePromptDeadlineMs(serverMs, requestMs)`.
   */
  deadlineMs?: number;
}

export const DAEMON_MODEL_PROMPT_META_KEY = 'qwen.daemon.modelPrompt';
export const DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY =
  'qwen.daemon.restoreAskUserQuestion';
/**
 * Response `_meta` key on `session/request_permission` cancellations telling
 * the child WHY the bridge resolved a cancel (`timeout` / `agent_cancelled`
 * / `session_closed`). The ACP wire frame itself only carries
 * `{outcome:'cancelled'}`; the child uses this to avoid persisting a
 * fabricated "canceled by the user" tool result when an unattended restore
 * prompt's permission wait timed out or the session closed.
 */
export const DAEMON_PERMISSION_CANCEL_REASON_META_KEY =
  'qwen.daemon.permissionCancelReason';
/**
 * Request `_meta` key on the child-bound `session/load` / `session/resume`
 * telling the child NOT to emit the restore hint and NOT to skip finalizing
 * the trailing ask_user_question during replay. The daemon sets it when it
 * already knows it will decline the re-hang (no attached client, fork
 * restore) — keeping the replay skip and the re-hang decision in lockstep.
 */
export const DAEMON_SUPPRESS_RESTORE_ASK_USER_QUESTION_META_KEY =
  'qwen.daemon.suppressRestoreAskUserQuestion';
export const DAEMON_ATTACHMENT_REFERENCES_META_KEY =
  'qwen.daemon.attachmentReferences';
export const MAX_TRUSTED_MODEL_PROMPT_CHARS = 64 * 1024;

export function isValidTrustedModelPrompt(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_TRUSTED_MODEL_PROMPT_CHARS
  );
}

export const DAEMON_CHANNEL_DELIVERY_META_KEY = 'qwen.daemon.channelDelivery';
export const DAEMON_PROMPT_DISPLAY_TEXT_META_KEY =
  'qwen.daemon.promptDisplayText';
// Wire twin of channel-base's CHANNEL_PROMPT_META_KEY; the packages have no
// dependency path between them, so a cross-package test pins the value.
export const CHANNEL_PROMPT_META_KEY = 'qwen.channel.prompt';

/**
 * Returned from `recordHeartbeat`. `lastSeenAt` is the server-side
 * `Date.now()` epoch (ms) the bridge stored for this session/client
 * pair. `clientId` is echoed only when the caller provided a trusted
 * one through `X-Qwen-Client-Id`; anonymous heartbeats omit it but
 * still bump the per-session timestamp.
 */
export interface BridgeHeartbeatResult {
  sessionId: string;
  clientId?: string;
  lastSeenAt: number;
}

/**
 * Read-only snapshot of last-seen timestamps the bridge has recorded for
 * a session. `sessionLastSeenAt` is the most recent heartbeat across any
 * client (anonymous or identified). `clientLastSeenAt` maps each
 * registered `clientId` to its own last heartbeat. Returned by
 * `getHeartbeatState` for in-process diagnostics.
 */
export interface BridgeHeartbeatState {
  sessionLastSeenAt?: number;
  clientLastSeenAt: ReadonlyMap<string, number>;
}

/**
 * ACP ext-method the spawned `qwen --acp` child calls between tool batches to
 * pull user messages the browser queued mid-turn. The child-side caller
 * (`cli/src/acp-integration/session/Session.ts`) and the daemon-side answerer
 * (`bridgeClient.ts`) both import THIS single definition, so a rename can't
 * silently desync them into a runtime `-32601 methodNotFound` (which would
 * latch the drain off for the session). The desktop ACP client answers the same
 * method from its own in-memory queue; in `qwen serve` the daemon answers it
 * from `SessionEntry.midTurnMessageQueue`. Responses may also carry
 * `hasQueuedPrompt` so an armed daemon Todo guard yields to complete FIFO
 * prompts; older clients can omit it.
 */
export const MID_TURN_QUEUE_DRAIN_METHOD = 'craft/drainMidTurnQueue';

/**
 * Cap on each per-session mid-turn reconciliation ring.
 */
export const MID_TURN_RECONCILIATION_RING_SIZE = 200;

/**
 * Child-to-parent request that atomically assigns the next Todo Stop Guard
 * model send to the current daemon FIFO owner. `promptId`, when present, is
 * the trusted bridge invocation id rather than the provider-facing prompt id.
 */
export const TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD =
  'craft/claimTodoStopGuardContinuation';

export interface TodoStopGuardContinuationClaimRequest {
  sessionId: string;
  promptId?: string;
}

export interface TodoStopGuardContinuationClaimResponse {
  claimed: boolean;
  hasQueuedPrompt: boolean;
}

/**
 * Parent-to-agent request reporting that the daemon FIFO no longer contains the
 * complete prompt an active Todo Stop Guard yielded to. The child clears the
 * old guard instead of letting background work revive it or leaving unrelated
 * automatic turns blocked forever.
 */
export const TODO_STOP_GUARD_QUEUE_RELEASE_METHOD =
  'craft/todoStopGuardQueueReleased';

export interface TodoStopGuardQueueReleasedRequest {
  sessionId: string;
  promptId: string;
}

/** Parent-to-agent request that acknowledges prompt cancellation handling. */
export const PROMPT_CANCEL_METHOD = 'craft/cancelPendingPrompt';

/**
 * Reverse tool channel marker (issue #5626, Phase 2). The parent serve process
 * stamps this boolean on a client-hosted (extension) MCP server's
 * runtime-MCP-add config. The `qwen --acp` child reads it in its
 * `workspaceMcpRuntimeAdd` handler to (1) KEEP `type: 'sdk'` instead of
 * stripping it and (2) let the session `McpClientManager` bind that server's
 * `sendSdkMcpMessage` to the `qwen/control/client_mcp/message` ext-method.
 * Defined here — the single contract package both the parent provider
 * (`cli/src/serve/acp-http`) and the child handler (`cli/src/acp-integration`)
 * import — so a rename can't silently break the handshake.
 */
export const CLIENT_MCP_OVER_WS_CONFIG_FLAG = '__clientMcpOverWs';

/**
 * Typed carrier for the reverse tool channel's runtime-MCP-add config: the
 * plain `Record<string, unknown>` shape `addRuntimeMcpServer` accepts, plus the
 * optional {@link CLIENT_MCP_OVER_WS_CONFIG_FLAG} marker declared as a real
 * (boolean) property. Lets the parent provider stamp the flag and the child
 * handler read it through one shared, type-checked shape instead of an untyped
 * string-keyed access on a bare `Record`.
 */
export type ClientMcpOverWsRuntimeConfig = Record<string, unknown> & {
  [CLIENT_MCP_OVER_WS_CONFIG_FLAG]?: boolean;
};

/** One daemon-owned, session-global queued mid-turn message. */
export interface MidTurnQueueEntry {
  messageId: string;
  text: string;
  /**
   * Image content blocks attached to the message. The drain
   * combines them with `text` into structured `items` for the ACP child;
   * the promotion path sends them alongside the text block.
   */
  content?: BridgePromptContentBlock[];
  originatorClientId?: string;
  queueOnly?: boolean;
  onSettledWithoutDrain?: () => void;
}

/**
 * Reconciliation snapshot returned by `getMidTurnMessages`. `messages` is the
 * current queue content plus bounded rings for messages drained into the
 * running turn and messages promoted into the normal pending-prompt FIFO.
 */
export interface BridgeMidTurnMessagesSnapshot {
  messages: Array<Pick<MidTurnQueueEntry, 'messageId' | 'text' | 'content'>>;
  settledMessageIds: string[];
  promotedMessageIds: string[];
}

/**
 * Internal record for a prompt accepted into the per-session FIFO queue.
 * Lives on `SessionEntry.pendingPromptList` so the daemon can report
 * pending prompts and let callers remove specific items. The
 * `abortController` is wired to the caller's signal (if any) so
 * `removePendingPrompt` can cancel a queued-but-not-yet-started prompt.
 */
export interface PendingPromptEntry {
  promptId: string;
  queuedAt: number;
  startedAt?: number;
  originatorClientId?: string;
  promotedMidTurn?: true;
  text: string;
  /**
   * Image content blocks attached to this prompt. Used by
   * `getPendingPrompts` so a refreshed client can restore the full payload
   * (text + images) instead of just the text.
   */
  content?: BridgePromptContentBlock[];
  abortController: AbortController;
  state: 'queued' | 'running';
  /**
   * Exactly-once latch for the prompt's formal terminal event
   * (`turn_complete` / `turn_error`). Set by `publishPromptTerminal`;
   * later publish attempts for the same prompt are suppressed.
   */
  terminalPublished?: boolean;
  /** Cancellation handshake; duplicate callers await rather than resend it. */
  cancelForwardInitial?: Promise<void>;
  /** Full cancellation handshake, used to fence the next FIFO dispatch. */
  cancelForwardDrain?: Promise<void>;
  /** Releases the cancellation fence when the prompt deadline expires. */
  cancelForwardDeadline?: Promise<void>;
  /** True after the prompt request has been handed to the ACP connection. */
  dispatched?: boolean;
  /**
   * Set when `removePendingPrompt` cancels a RUNNING prompt. The entry
   * stays on `pendingPromptList` (hidden from `getPendingPrompts`) until
   * the prompt settles, so the teardown flush can still publish its
   * terminal if the session closes before the agent cooperates.
   */
  removed?: boolean;
}

/**
 * Public projection of `PendingPromptEntry` returned by
 * `getPendingPrompts` and the HTTP API. Omits the internal
 * `abortController` and raw prompt content blocks.
 */
export interface PendingPromptSummary {
  promptId: string;
  text: string;
  /**
   * Image content blocks attached to this prompt, so a
   * refreshed client can restore the full payload (text + images) instead
   * of just the text.
   */
  content?: BridgePromptContentBlock[];
  queuedAt: number;
  state: 'queued' | 'running';
  originatorClientId?: string;
}

export interface BridgeTurnStatus {
  sessionId: string;
  state: 'idle' | 'queued' | 'running' | 'completed' | 'cancelled' | 'error';
  promptId?: string;
  promptText?: string;
  promptTextTruncated?: boolean;
  queuedAt?: number;
  startedAt?: number;
  endedAt?: number;
  stopReason?: string;
  error?: TurnResultErrorPayload;
  resultText?: string;
  resultTruncated?: boolean;
  resultCode?: TurnResultCode;
  originatorClientId?: string;
}

export interface BridgeDaemonStatusLimits {
  maxSessions: number | null;
  maxPendingPromptsPerSession: number | null;
  eventRingSize: number;
  compactedReplayMaxBytes: number;
  /**
   * Per-session BASELINE journal caps. A session's effective caps can be
   * higher mid-turn under adaptive growth — see
   * `BridgeDaemonSessionDiagnostic.maxJournalEvents` /
   * `maxJournalBytes` and `journalGrowth` below.
   */
  maxJournalEvents: number;
  maxJournalBytes: number;
  /**
   * Adaptive live-journal growth configuration, or `null` when growth is
   * disabled (fixed caps above). The pool is daemon-wide: every bridge of
   * the daemon accounts its sessions against the same aggregate.
   */
  journalGrowth: {
    poolBytes: number;
    hardCapBytes: number;
  } | null;
  channelIdleTimeoutMs: number;
  sessionIdleTimeoutMs: number;
}

export interface BridgeDaemonSessionDiagnostic {
  sessionId: string;
  workspaceCwd: string;
  createdAt: string;
  displayName?: string;
  clientCount: number;
  subscriberCount: number;
  attachCount: number;
  pendingPromptCount: number;
  pendingPermissionCount: number;
  hasActivePrompt: boolean;
  lastEventId: number;
  lastSeenAt?: number;
  currentModelId?: string;
  currentApprovalMode?: string;
  /**
   * The session's EFFECTIVE live-journal caps right now — the configured
   * baseline, or higher when adaptive growth raised them mid-turn. One
   * session retains two journals (full + summary) under the SAME caps, so
   * its live-journal heap can reach twice the reported byte cap.
   */
  maxJournalEvents: number;
  maxJournalBytes: number;
}

export interface BridgeDaemonStatusSnapshot {
  limits: BridgeDaemonStatusLimits;
  sessionCount: number;
  pendingPermissionCount: number;
  channelLive: boolean;
  permissionPolicy: PermissionPolicy;
  sessions: BridgeDaemonSessionDiagnostic[];
}

export interface BridgeExtensionsChangedData {
  refreshed: number;
  failed: number;
  status?:
    | 'installed'
    | 'enabled'
    | 'disabled'
    | 'updated'
    | 'uninstalled'
    | 'failed';
  source?: string;
  name?: string;
  version?: string;
  error?: string;
}

export type BridgeGenerationModelSource = 'fast' | 'main';

export type BridgeGenerationStreamEvent =
  | {
      type: 'started';
      requestId: string;
      model: string;
      modelSource: BridgeGenerationModelSource;
    }
  | {
      type: 'thinking';
      requestId: string;
    }
  | {
      type: 'delta';
      requestId: string;
      seq: number;
      text: string;
    }
  | {
      type: 'done';
      requestId: string;
      model: string;
      modelSource: BridgeGenerationModelSource;
      inputTokens?: number;
      outputTokens?: number;
    };

export type BridgeGenerationNotificationEvent = Exclude<
  BridgeGenerationStreamEvent,
  { type: 'done' }
>;

export type BridgeWorkspaceGenerationStreamEvent =
  | {
      type: 'started';
      requestId: string;
      model: string;
      modelSource: BridgeGenerationModelSource;
    }
  | {
      type: 'thinking';
      requestId: string;
    }
  | {
      type: 'delta';
      requestId: string;
      seq: number;
      text: string;
    }
  | {
      type: 'done';
      requestId: string;
      model: string;
      modelSource: BridgeGenerationModelSource;
      inputTokens?: number;
      outputTokens?: number;
    };

export type BridgeWorkspaceGenerationNotificationEvent = Exclude<
  BridgeWorkspaceGenerationStreamEvent,
  { type: 'done' }
>;

/** A daemon-owned worker completion injected into its parent session. */
export interface BridgeBackgroundNotification {
  displayText: string;
  modelText: string;
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  kind: 'agent';
  toolUseId?: string;
}

export type RuntimeMcpServerAddResult =
  | {
      name: string;
      transport: string;
      replaced: boolean;
      shadowedSettings: boolean;
      toolCount: number;
      originatorClientId: string;
    }
  | {
      name: string;
      skipped: true;
      reason: 'budget_warning_only' | 'runtime_name_conflict';
    };

export type RuntimeMcpServerRemoveResult =
  | {
      name: string;
      removed: true;
      wasShadowingSettings: boolean;
      originatorClientId: string;
    }
  | { name: string; skipped: true; reason: 'not_present' };

export interface WorkspaceEventPublisher {
  /**
   * Workspace-level event fan-out for mutations that change daemon-wide state.
   * Best-effort per session; closed buses silently skipped.
   */
  publishWorkspaceEvent(event: Omit<BridgeEvent, 'id' | 'v'>): void;
}

export interface WorkspaceEventBridge extends WorkspaceEventPublisher {
  /**
   * Union of every live session's `clientIds`. Used by workspace-level
   * mutation routes to validate the optional `X-Qwen-Client-Id` header.
   * Returns a snapshot — callers must not mutate.
   */
  knownClientIds(): ReadonlySet<string>;
}

export interface AcpSessionBridge extends WorkspaceEventBridge {
  /** Read-only daemon diagnostics for status endpoints. */
  getDaemonStatusSnapshot(): BridgeDaemonStatusSnapshot;

  /**
   * Installs the daemon-owned capture handler used by the dedicated Live
   * `capture_screen_context` tool. Undefined disables the child-to-daemon
   * route. The bridge authenticates the caller session before invoking it.
   */
  setLiveScreenContextCaptureHandler?(
    handler:
      | import('./bridgeOptions.js').LiveScreenContextCaptureHandler
      | undefined,
  ): void;

  /** Installs the daemon-owned handler for the five Codex-parity Live task tools. */
  setLiveTaskToolRequestHandler?(
    handler:
      | import('./bridgeOptions.js').LiveTaskToolRequestHandler
      | undefined,
  ): void;

  /** Installs the daemon-owned handler for the backend-only Live speech tool. */
  setLiveSpeakToUserHandler?(
    handler: import('./bridgeOptions.js').LiveSpeakToUserHandler | undefined,
  ): void;

  /**
   * Create a new session, or — under `sessionScope: 'single'` — attach to an
   * existing session for the same workspace.
   */
  spawnOrAttach(req: BridgeSpawnRequest): Promise<BridgeSession>;

  /** Create a fresh daemon-owned standalone session in provisional mode. */
  spawnStandaloneSession(
    req: BridgeStandaloneSpawnRequest,
  ): Promise<BridgeSession>;

  /** Restore a daemon-owned standalone session in provisional mode. */
  restoreStandaloneSession(
    action: 'load' | 'resume',
    req: BridgeStandaloneRestoreSessionRequest,
  ): Promise<BridgeRestoredSession>;

  /**
   * Load an existing persisted session and replay its history through
   * session_update notifications. Returns `attached: true` when the requested
   * session is already live in this daemon.
   */
  loadSession(req: BridgeRestoreSessionRequest): Promise<BridgeRestoredSession>;

  /**
   * Resume an existing persisted session without requesting history replay.
   * Returns `attached: true` when the requested session is already live in
   * this daemon.
   */
  resumeSession(
    req: BridgeRestoreSessionRequest,
  ): Promise<BridgeRestoredSession>;

  /** Restore latest-state forks; leave historical checkpoint forks persisted. */
  branchSession(
    sessionId: string,
    req: BridgeBranchSessionRequest,
    context?: BridgeClientRequestContext,
  ): Promise<BridgeBranchSessionResult>;

  /** Create a persisted side task with a snapshot of the parent's context. */
  createSideTaskSession(
    sessionId: string,
    req: BridgeSideTaskSessionRequest,
    context?: BridgeClientRequestContext,
  ): Promise<BridgeSideTaskSession>;

  /**
   * Change the working directory of a live session. The session must be
   * idle (no active prompt). Chains onto `entry.promptQueue` and updates
   * the tail to prevent concurrent mutations.
   *
   * Throws `CdWhilePromptActiveError` when a prompt is running,
   * `SessionNotFoundError` for unknown ids, and `InvalidClientIdError`
   * when the caller's client id is not bound to the session.
   */
  changeSessionCwd(
    sessionId: string,
    req: ChangeSessionCwdRequest,
    context?: BridgeClientRequestContext,
  ): Promise<ChangeSessionCwdResult>;

  commitManagedConversationBinding(
    sessionId: string,
    expectation: BridgeConversationDirectoryExpectation,
  ): Promise<void>;

  releaseManagedConversationBinding(
    sessionId: string,
    expectation: BridgeConversationDirectoryExpectation,
  ): Promise<void>;

  /**
   * Set worktree metadata on an existing session entry. Used when
   * restoring a worktree session after daemon restart — the sidecar
   * file provides the metadata, and this populates the in-memory entry
   * so `getSessionSummary` returns it.
   */
  setSessionWorktree(
    sessionId: string,
    worktree: { slug: string; path: string; branch: string },
  ): void;

  /**
   * Forward a prompt to the agent. Concurrent prompts against the same
   * session FIFO-serialize through a per-session queue.
   *
   * Admission contract: implementations must not be `async`. Admission
   * failures such as `InvalidClientIdError`, `PromptQueueFullError`, and
   * pre-aborted signals throw synchronously so HTTP routes can reject before
   * returning 202. Deferred failures such as `SessionNotFoundError` may be
   * returned as rejected promises.
   */
  sendPrompt(
    sessionId: string,
    req: BridgePromptRequest,
    signal?: AbortSignal,
    context?: BridgeClientRequestContext,
  ): Promise<PromptResponse>;

  /**
   * Return the pending prompt queue for a session. Includes the currently
   * running prompt (state `'running'`) and any prompts waiting in the FIFO
   * (state `'queued'`). Throws `SessionNotFoundError` for unknown ids.
   */
  getPendingPrompts(
    sessionId: string,
    context?: BridgeClientRequestContext,
  ): readonly PendingPromptSummary[];

  /** Read an exact prompt, or the current/newest turn when omitted. */
  getSessionTurnStatus(
    sessionId: string,
    context?: BridgeClientRequestContext,
    promptId?: string,
  ): Promise<BridgeTurnStatus | undefined>;

  /**
   * Remove a specific prompt from the pending queue. For `queued` prompts,
   * aborts them so the FIFO skips dispatch. For `running` prompts, aborts
   * the in-flight turn (equivalent to cancel). Returns `{ removed: false }`
   * when the promptId is not found. Throws `SessionNotFoundError` for
   * unknown session ids.
   */
  removePendingPrompt(
    sessionId: string,
    promptId: string,
    context?: BridgeClientRequestContext,
  ): { removed: boolean };

  /**
   * Cancel the in-flight prompt on the session. Throws
   * `SessionNotFoundError` when the id is unknown.
   */
  cancelSession(
    sessionId: string,
    req?: CancelNotification,
    context?: BridgeClientRequestContext,
  ): Promise<void>;

  /**
   * Subscribe to the session's event stream. Throws
   * `SessionNotFoundError` when the id is unknown.
   */
  subscribeEvents(
    sessionId: string,
    opts?: SubscribeOptions & {
      /** Yield a synthetic `session_snapshot` frame after replay completes. */
      snapshot?: boolean;
    },
  ): AsyncIterable<BridgeEvent>;

  /**
   * Return the most recent monotonic event id for this session's bus.
   * Used by non-blocking prompt responses to tell the client where to
   * start SSE replay so no events are missed.
   */
  getSessionLastEventId(sessionId: string): number;

  /**
   * Return the epoch token of this session's event bus. Regenerated on
   * every bus construction (daemon restart), never persisted. Throws
   * `SessionNotFoundError` when the id is unknown.
   */
  getSessionEventEpoch(sessionId: string): string;

  /**
   * Return the daemon's current effective cwd for a live session without
   * exposing it through public session summaries.
   */
  getSessionCurrentCwd(sessionId: string): string;

  /**
   * Return the current compacted replay snapshot for a loaded session, when
   * the bridge has a compaction engine configured.
   */
  getSessionReplaySnapshot(
    sessionId: string,
  ): SessionReplaySnapshot | undefined;

  /**
   * Explicitly close a live session. Force-closes even when other clients
   * are attached. Throws `SessionNotFoundError` for unknown ids.
   */
  closeSession(
    sessionId: string,
    context?: BridgeClientRequestContext,
    opts?: CloseSessionOpts,
  ): Promise<void>;

  /** Durably anchor an eligible live default session before task binding. */
  ensureDefaultSessionPersisted?(sessionId: string): Promise<void>;

  /**
   * Update mutable session metadata. Supports `displayName` and `pr`.
   * Throws `SessionNotFoundError` for unknown ids.
   */
  updateSessionMetadata(
    sessionId: string,
    metadata: SessionMetadataUpdate,
    context?: BridgeClientRequestContext,
  ): SessionMetadataUpdate;

  /**
   * Re-hydrate the in-memory PR binding list of a live session from the
   * persisted sidecar after the entry was re-created empty (daemon
   * restart, close/reload, archive/restore). No-op when the entry is
   * unknown or already holds bindings, so this-daemon-lifetime state
   * always wins. Callers own sidecar I/O; the bridge stays
   * storage-agnostic. Optional so lightweight fakes may omit it.
   */
  seedSessionPrs?(sessionId: string, prs: SessionPrInfo[]): void;

  /**
   * Replace the in-memory PR binding list of a live session with the
   * authoritative persisted one. The metadata routes call this after the
   * sidecar upsert succeeds: the sidecar cap evicts by provenance
   * authority while the bridge merge caps positionally, so once the list
   * overflows the cap the two stores evict different entries — the live
   * entry must mirror the persisted list or later events and rename
   * responses serve the diverged one. Optional like
   * {@link seedSessionPrs}. Callers own sidecar I/O; the bridge stays
   * storage-agnostic.
   */
  setSessionPrs?(sessionId: string, prs: SessionPrInfo[]): void;

  /**
   * List the structured artifacts registered for a live session. Throws
   * `SessionNotFoundError` when the id is unknown.
   */
  getSessionArtifacts(
    sessionId: string,
    context?: BridgeClientRequestContext,
  ): Promise<SessionArtifactsEnvelope>;

  /**
   * Register a client-supplied artifact for the session. Client artifacts use
   * the daemon-issued client id from the request context for retention/audit;
   * request bodies cannot self-assign client ids.
   */
  addSessionArtifact(
    sessionId: string,
    artifact: SessionArtifactInput,
    context?: BridgeClientRequestContext,
  ): Promise<SessionArtifactMutationResult>;

  /**
   * Remove an artifact from the session. Missing artifact ids are idempotent
   * no-ops; unknown session ids still throw `SessionNotFoundError`.
   */
  removeSessionArtifact(
    sessionId: string,
    artifactId: string,
    context?: BridgeClientRequestContext,
  ): Promise<SessionArtifactMutationResult>;

  /**
   * Cast a vote on a pending `permission_request` (first-responder wins).
   */
  respondToPermission(
    requestId: string,
    response: RequestPermissionResponse,
    context?: BridgeClientRequestContext,
  ): boolean;

  /**
   * Cast a vote scoped to an explicit session route.
   */
  respondToSessionPermission(
    sessionId: string,
    requestId: string,
    response: RequestPermissionResponse,
    context?: BridgeClientRequestContext,
  ): boolean;

  /**
   * List all live sessions whose canonical workspace path matches the
   * supplied cwd. Empty array (not throw) when no sessions exist.
   */
  listWorkspaceSessions(workspaceCwd: string): BridgeSessionSummary[];

  /**
   * Read the current in-memory session-catalog version. The returned value
   * is an immutable snapshot — a later {@link markSessionCatalogChanged}
   * call never mutates a previously returned version.
   */
  getSessionCatalogVersion(): BridgeSessionCatalogVersion;

  /**
   * Advance the session-catalog revision. Marks daemon-observed catalog
   * membership and static-metadata changes that the bridge does not track
   * internally (e.g. persisted mutations performed by serve-layer helpers).
   * Conservative extra increments are safe and preferred over a missed mark.
   */
  markSessionCatalogChanged(): void;

  /**
   * Live status summary for a single session by id — the same shape
   * `listWorkspaceSessions` produces per item. Throws
   * `SessionNotFoundError` when no live session with that id exists on
   * this daemon. Lets a caller that already holds a session id poll
   * `hasActivePrompt` / `clientCount` without scanning the whole list.
   */
  getSessionSummary(sessionId: string): BridgeSessionSummary;

  /**
   * Record a client heartbeat for the session. Throws
   * `SessionNotFoundError` for unknown ids and `InvalidClientIdError`
   * when the supplied `clientId` is not registered for this session.
   */
  recordHeartbeat(
    sessionId: string,
    context?: BridgeClientRequestContext,
  ): BridgeHeartbeatResult;

  /**
   * Read the bridge's recorded last-seen timestamps for a session.
   * Returns `undefined` for unknown sessions.
   */
  getHeartbeatState(sessionId: string): BridgeHeartbeatState | undefined;

  /**
   * Generic workspace-status query delegated through the live ACP channel.
   * Returns `idle()` when no child is running. Used by DaemonWorkspaceService
   * to forward status methods without coupling to their concrete shapes.
   */
  queryWorkspaceStatus<T>(method: string, idle: () => T): Promise<T>;

  /**
   * Generic workspace command invocation delegated through the live ACP
   * channel. Throws `SessionNotFoundError` when no child is running (no
   * idle fallback). Used by DaemonWorkspaceService for mutations that
   * require an active channel (e.g. MCP restart).
   */
  invokeWorkspaceCommand<T>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T>;

  /**
   * Run a hidden workspace-level managed-memory remember task. This
   * ensures the ACP child exists but must not create/load/resume an ACP
   * session or touch the per-session prompt queue.
   */
  runWorkspaceMemoryRemember(
    request: BridgeWorkspaceMemoryRememberRequest,
  ): Promise<BridgeWorkspaceMemoryRememberResult>;

  /**
   * Run a hidden workspace-level managed-memory forget task. This
   * ensures the ACP child exists but must not create/load/resume an ACP
   * session or touch the per-session prompt queue.
   */
  runWorkspaceMemoryForget(
    request: BridgeWorkspaceMemoryForgetRequest,
  ): Promise<BridgeWorkspaceMemoryForgetResult>;

  /**
   * Run a hidden workspace-level managed-memory dream task. This
   * ensures the ACP child exists but must not create/load/resume an ACP
   * session or touch the per-session prompt queue.
   */
  runWorkspaceMemoryDream(): Promise<BridgeWorkspaceMemoryDreamResult>;

  /**
   * Check whether the ACP child can run managed-memory remember for the
   * current workspace. Used by HTTP POST to return a synchronous 409 in
   * bare/unavailable modes without creating a session.
   */
  isWorkspaceMemoryRememberAvailable(): Promise<boolean>;

  /**
   * Start workspace-scoped MCP discovery without creating an ACP session.
   * The result only confirms the background task was accepted; callers read
   * progress from the normal workspace MCP status endpoint.
   */
  initializeWorkspaceMcp(): Promise<{ accepted: boolean }>;

  /** Reload persisted MCP settings into workspace and active session configs. */
  reloadWorkspaceMcp(options?: {
    forceReconnectAll?: boolean;
    forceReconnectWhich?: string[];
  }): Promise<{ accepted: boolean }>;

  /**
   * Read discovered MCP tools for one server from the live ACP registry.
   * (New in upstream — kept in bridge pending workspace service migration.)
   */
  getWorkspaceMcpToolsStatus(
    serverName: string,
  ): Promise<ServeWorkspaceMcpToolsStatus>;

  /**
   * Read discovered MCP resources (`resources/list`) for one server from
   * the live ACP registry. Drill-down companion to
   * `getWorkspaceMcpToolsStatus`; the per-server `resourceCount` rides
   * the base `/workspace/mcp` status.
   */
  getWorkspaceMcpResourcesStatus(
    serverName: string,
  ): Promise<ServeWorkspaceMcpResourcesStatus>;

  /**
   * Read the live built-in tool registry for the bound workspace.
   * (New in upstream — kept in bridge pending workspace service migration.)
   */
  getWorkspaceToolsStatus(): Promise<ServeWorkspaceToolsStatus>;

  /** Read the current ACP context/config state for a live session. */
  getSessionContextStatus(
    sessionId: string,
  ): Promise<ServeSessionContextStatus>;

  /** Read structured context-window usage for a live session. */
  getSessionContextUsageStatus(
    sessionId: string,
    opts?: { detail?: boolean },
  ): Promise<ServeSessionContextUsageStatus>;

  /** Read slash-command/skill command availability for a live session. */
  getSessionSupportedCommandsStatus(
    sessionId: string,
  ): Promise<ServeSessionSupportedCommandsStatus>;

  /** Read the live background task snapshot for a live session. */
  getSessionTasksStatus(sessionId: string): Promise<ServeSessionTasksStatus>;

  /** Read sanitized LSP server status for a live session. */
  getSessionLspStatus(sessionId: string): Promise<ServeSessionLspStatus>;

  /**
   * Read a page of persisted transcript replay events through the ACP child.
   * This is workspace-scoped and read-only: implementations must not attach a
   * session client, seed the EventBus, or create a live SessionEntry.
   */
  getSessionTranscriptPage(
    req: BridgeSessionTranscriptPageRequest,
  ): Promise<BridgeSessionTranscriptPage>;

  /** Cancel a background task in a live session. */
  cancelSessionTask(
    sessionId: string,
    taskId: string,
    taskKind: 'agent' | 'shell' | 'monitor',
  ): Promise<{ cancelled: boolean }>;

  /** Clear an active goal in a live session without cancelling the running prompt. */
  clearSessionGoal(
    sessionId: string,
  ): Promise<{ cleared: boolean; condition?: string }>;

  /** Atomically apply a typed Goal lifecycle control in a live session. */
  controlSessionGoal(
    sessionId: string,
    request: GoalControlRequest,
    context?: BridgeClientRequestContext,
  ): Promise<GoalStateResponse>;

  /**
   * Read a live session's Goal state. Throws `SessionNotFoundError` when the
   * session is not resident because this route addresses the selected runtime.
   */
  getSessionGoal(sessionId: string): Promise<BridgeSessionGoal>;

  /**
   * Resume a live session's unfinished previous turn — an interrupted prompt
   * (model never answered) or a turn left with dangling tool calls — without
   * injecting a synthetic "continue" user message. Idempotent no-op when the
   * last turn ended cleanly. Mirrors the SDK's `continueLastTurn` and the core
   * `detectTurnInterruption` classification.
   */
  continueSession(
    sessionId: string,
    context?: BridgeClientRequestContext,
  ): Promise<{
    accepted: boolean;
    interruption: 'none' | 'interrupted_prompt' | 'interrupted_turn';
    /**
     * Replay cursor + correlation id for an accepted continuation, mirroring
     * the `POST /session/:id/prompt` 202 body. Present only when `accepted` —
     * the continuation runs as a tracked async turn, so clients use `promptId`
     * to correlate turn-scoped events, including `turn_complete` /
     * `turn_error`, while `lastEventId` resumes events emitted before they
     * (re)attach the SSE stream.
     */
    promptId?: string;
    lastEventId?: number;
    /**
     * Epoch token of the event bus that produced `lastEventId`, mirroring
     * the `POST /session/:id/prompt` 202 envelope: a client seeding its SSE
     * resume position from an accepted continuation must also learn the bus
     * epoch so a daemon restart in between is detected (DAEMON-001).
     */
    eventEpoch?: string;
  }>;

  /** Read structured session usage stats (tokens, tools, files). */
  getSessionStatsStatus(sessionId: string): Promise<ServeSessionStatsStatus>;

  /** Read workspace-level hook configuration status. */
  getWorkspaceHooksStatus(): Promise<ServeWorkspaceHooksStatus>;

  /** Read session-scoped hook status for a live session. */
  getSessionHooksStatus(sessionId: string): Promise<ServeSessionHooksStatus>;

  /** Read workspace-level installed extension status. */
  getWorkspaceExtensionsStatus(): Promise<ServeWorkspaceExtensionsStatus>;

  /**
   * Broadcast extension refresh to all active sessions and emit an
   * `extensions_changed` workspace event when complete.
   */
  refreshExtensionsForAllSessions(
    data?: Omit<BridgeExtensionsChangedData, 'refreshed' | 'failed'>,
  ): Promise<{
    refreshed: number;
    failed: number;
  }>;

  /** Emit an extension lifecycle event without refreshing sessions. */
  broadcastExtensionsChanged(data: BridgeExtensionsChangedData): void;

  /**
   * Switch the active model service for a session. Throws
   * `SessionNotFoundError` for unknown ids.
   */
  setSessionModel(
    sessionId: string,
    req: SetSessionModelRequest,
    context?: BridgeClientRequestContext,
  ): Promise<SetSessionModelResponse>;

  /** Change one advertised ACP configuration option for a live session. */
  setSessionConfigOption(
    sessionId: string,
    req: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse>;

  /**
   * Switch UI language and optionally LLM output language for a live
   * session, then broadcast a `language_changed` event.  When
   * `syncOutputLanguage` is true the handler also refreshes every
   * session's system prompt so the next LLM call uses the new language.
   */
  setSessionLanguage(
    sessionId: string,
    params: { language: string; syncOutputLanguage: boolean },
    context?: BridgeClientRequestContext,
  ): Promise<{
    language: string;
    outputLanguage: string | null;
    refreshed: boolean;
  }>;

  /** Apply Codex's realtime-active world-state transition to one session. */
  setSessionLiveConversationActive(
    sessionId: string,
    active: boolean,
  ): Promise<void>;

  /** Persist Realtime-owned dialogue without starting a backend model turn. */
  appendSessionLiveTranscript(
    sessionId: string,
    entries: ReadonlyArray<{
      role: 'user' | 'assistant';
      text: string;
    }>,
    model: string,
  ): Promise<void>;

  /**
   * Change the approval mode of a live session and broadcast an
   * `approval_mode_changed` event. `opts.persist === true` also writes
   * `tools.approvalMode` to workspace settings.
   */
  setSessionApprovalMode(
    sessionId: string,
    mode: ApprovalMode,
    opts: { persist: boolean },
    context?: BridgeClientRequestContext,
  ): Promise<{
    sessionId: string;
    mode: ApprovalMode;
    previous: ApprovalMode;
    persisted: boolean;
  }>;

  /**
   * Generate a one-sentence "where did I leave off" recap of a live
   * session. Forwards through `qwen/control/session/recap`, which
   * invokes `generateSessionRecap` (`core/services/sessionRecap.ts`) in
   * the ACP child against the per-session chat history.
   *
   * Best-effort: the helper returns `null` when history is too short or
   * the underlying side-query fails — both surface as a 200 response
   * with `recap: null`. Hard errors (unknown session, ACP transport
   * down) throw as usual.
   */
  generateSessionRecap(
    sessionId: string,
    context?: BridgeClientRequestContext,
  ): Promise<{ sessionId: string; recap: string | null }>;

  /**
   * Run a stateless, tool-free text generation request in the ACP child and
   * stream model deltas back only to this caller. The child prefers the
   * configured fast model and falls back to the session's main model.
   */
  generateSessionContent?(
    sessionId: string,
    prompt: string,
    signal: AbortSignal,
    context?: BridgeClientRequestContext,
  ): AsyncIterable<BridgeGenerationStreamEvent>;

  /**
   * Run a side question (/btw) against the session's conversation context.
   * Uses runForkedAgent (cache path) for a single-turn, tool-free LLM call.
   * Returns `answer: null` on empty/failed generation.
   */
  generateSessionBtw(
    sessionId: string,
    question: string,
    signal?: AbortSignal,
    context?: BridgeClientRequestContext,
  ): Promise<{ sessionId: string; answer: string | null }>;

  /**
   * Launch a background fork agent that inherits the live session's current
   * conversation context. This is CLI `/fork`, not ACP `session/fork`
   * (which maps to `/branch`).
   */
  launchSessionForkAgent(
    sessionId: string,
    directive: string,
    context?: BridgeClientRequestContext,
  ): Promise<BridgeForkAgentResult>;

  /**
   * Queue a daemon-owned mid-turn user message. The ACP child drains it between
   * tool batches while a turn is active; a message admitted after the session
   * becomes idle is promoted into the normal prompt FIFO. A full queue returns
   * `{ accepted: false }` without taking ownership. `context.clientId` is
   * authorized against the session like `/prompt` and `/btw` — throws
   * `InvalidClientIdError` when the id is not bound to the session, and
   * `SessionNotFoundError` for unknown ids. Ownership is session-wide.
   * With `options.rejectIfIdle` an idle session rejects instead of taking
   * ownership. A message accepted while busy keeps the ordinary public queue
   * semantics: it is echoed when drained and promoted if the turn settles
   * first. `options.queueOnly` is reserved for internal live steering; if a
   * busy session settles before draining one of those messages,
   * `onSettledWithoutDrain` lets that internal caller drive the next turn.
   * `options.content` carries image blocks with the message;
   * an empty `message` is admitted when media blocks are present.
   */
  enqueueMidTurnMessage(
    sessionId: string,
    message: string,
    context?: BridgeClientRequestContext,
    messageId?: string,
    options?: {
      rejectIfIdle?: boolean;
      queueOnly?: boolean;
      onSettledWithoutDrain?: () => void;
      content?: readonly BridgePromptContentBlock[];
    },
  ): { accepted: boolean; messageId?: string };

  storeSessionAttachment(
    sessionId: string,
    data: Uint8Array,
    mimeType: string,
    context?: BridgeClientRequestContext,
    name?: string,
  ): Promise<SessionAttachmentReference>;

  readSessionAttachment(
    sessionId: string,
    attachmentId: string,
    context?: BridgeClientRequestContext,
  ): Promise<{ data: Buffer; mimeType: string } | undefined>;

  removeSessionAttachment(
    sessionId: string,
    attachmentId: string,
    context?: BridgeClientRequestContext,
  ): Promise<boolean>;

  /** Delete all persisted attachments after the session itself is deleted. */
  deleteSessionAttachments(
    sessionId: string,
    options?: { assertCanCommit?: () => void },
  ): Promise<void>;

  /** Remove a queued or promoted mid-turn message. */
  removeMidTurnMessage(
    sessionId: string,
    messageId: string,
    context?: BridgeClientRequestContext,
  ): { removed: boolean };

  /**
   * Queue a daemon-owned worker completion in its live parent session. The
   * session records the notification and runs its normal automatic follow-up
   * turn, matching the return path used by in-process background agents.
   */
  enqueueBackgroundNotification(
    sessionId: string,
    notification: BridgeBackgroundNotification,
  ): Promise<{ sessionId: string; accepted: boolean }>;

  /**
   * Return the mid-turn reconciliation snapshot for a session: messages still
   * waiting in the queue plus bounded terminal id rings. Lets clients project
   * daemon state after a page refresh or a missed event frame.
   * `context.clientId` is authorized against the session like the sibling
   * mid-turn routes; throws `InvalidClientIdError` when the id is not bound
   * to the session, and `SessionNotFoundError` for unknown ids.
   */
  getMidTurnMessages(
    sessionId: string,
    context?: BridgeClientRequestContext,
  ): BridgeMidTurnMessagesSnapshot;

  /**
   * Execute a shell command directly on the daemon (no LLM involvement).
   * Streams output through the session's SSE bus and injects the
   * command+result into the LLM's chat history via extMethod.
   * Throws `SessionShellDisabledError` when direct shell is not enabled,
   * `SessionShellClientRequiredError` when no session-bound client id is
   * provided, `InvalidClientIdError` when the client id is not bound to the
   * session, and `SessionNotFoundError` for unknown ids.
   */
  executeShellCommand(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
    context?: BridgeClientRequestContext,
  ): Promise<ShellCommandResult>;

  /**
   * List rewindable snapshots for a session with per-turn diff stats.
   */
  getRewindSnapshots(
    sessionId: string,
  ): Promise<{ snapshots: RewindSnapshotInfo[] }>;

  /**
   * Rewind a session to a previous turn: truncates conversation history
   * and restores files. File restore is best-effort — if the snapshot
   * is missing, conversation is still rewound and `filesChanged` is empty.
   */
  rewindSession(
    sessionId: string,
    req: RewindRequest,
    context?: BridgeClientRequestContext,
  ): Promise<RewindResponse>;

  /**
   * T2.8 (#4514): Add a runtime MCP server through the ACP child's
   * `McpClientManager.addRuntimeMcpServer`. On success, broadcasts an
   * `mcp_server_added` event to every session bus. Soft-refuse
   * (`budget_warning_only` skip) does NOT emit an event — the caller
   * receives the skip shape and decides locally.
   *
   * Throws `SessionNotFoundError` when no ACP channel is live (caller
   * should spawn or attach first). Typed ACP errors (budget-exceeded,
   * spawn-failed, invalid-config) are re-instantiated from the
   * JSON-RPC `data.errorKind` so the route's `sendBridgeError` can
   * map them to stable HTTP status codes.
   */
  addRuntimeMcpServer(
    name: string,
    config: Record<string, unknown>,
    originatorClientId?: string,
  ): Promise<RuntimeMcpServerAddResult>;

  /**
   * Remove a runtime MCP server through the ACP child's
   * `McpClientManager.removeRuntimeMcpServer`. On success, broadcasts
   * an `mcp_server_removed` event. Idempotent skip (`not_present`)
   * does NOT emit — the caller receives the skip shape.
   *
   * Throws `SessionNotFoundError` when no ACP channel is live.
   */
  removeRuntimeMcpServer(
    name: string,
    originatorClientId?: string,
  ): Promise<RuntimeMcpServerRemoveResult>;

  /**
   * Add a runtime MCP server to one live session only. This does not mutate
   * workspace bootstrap state, affect sibling sessions, or emit a workspace
   * event.
   */
  addSessionRuntimeMcpServer(
    sessionId: string,
    name: string,
    config: Record<string, unknown>,
    originatorClientId?: string,
  ): Promise<RuntimeMcpServerAddResult>;

  /** Remove a runtime MCP server from one live session only. */
  removeSessionRuntimeMcpServer(
    sessionId: string,
    name: string,
    originatorClientId?: string,
  ): Promise<RuntimeMcpServerRemoveResult>;

  manageMcpServer(
    serverName: string,
    action: 'approve' | 'enable' | 'disable' | 'authenticate' | 'clear-auth',
    originatorClientId: string | undefined,
  ): Promise<{
    serverName: string;
    action: 'approve' | 'enable' | 'disable' | 'authenticate' | 'clear-auth';
    ok: true;
    changed?: boolean;
    messages?: string[];
    authUrl?: string;
    pending?: boolean;
  }>;

  generateWorkspaceAgent(
    description: string,
    originatorClientId: string | undefined,
  ): Promise<{
    name: string;
    description: string;
    systemPrompt: string;
  }>;

  /** Run stateless, tool-free generation in the resolved workspace runtime. */
  generateWorkspaceContent?(
    prompt: string,
    signal: AbortSignal,
    originatorClientId: string | undefined,
  ): AsyncIterable<BridgeWorkspaceGenerationStreamEvent>;

  /**
   * Tear down a session — kill the child, drop from maps, publish
   * `session_died`. Idempotent on already-dead sessions.
   *
   * `requireZeroAttaches: true` makes the call a no-op when at
   * least one other client has called `spawnOrAttach` for this
   * entry and got `attached: true`.
   *
   * Returns true only when this call removed the live session.
   */
  killSession(
    sessionId: string,
    opts?: { requireZeroAttaches?: boolean },
  ): Promise<boolean>;

  /**
   * Roll back a prior attach: decrement `attachCount` and reap if the
   * session has no other live attaches/subscribers.
   */
  detachClient(sessionId: string, clientId?: string): Promise<void>;

  /** Test/inspection hook: number of live sessions. */
  readonly sessionCount: number;

  /**
   * Whether an ACP channel is currently live (spawned and not dying).
   * Distinct from `sessionCount > 0`: a channel can be live with zero
   * attached sessions during the cold-spawn window, and conversely a
   * killed channel may briefly retain sessions before reaping. Consumers
   * that need true channel liveness (e.g. the workspace service's
   * `acpChannelLive` envelope field) must use this rather than the
   * session count.
   */
  isChannelLive(): boolean;

  /** Number of sessions with an active prompt. */
  readonly activePromptCount: number;

  /**
   * Whether an accepted prompt, a running background Agent, an Agent terminal
   * notification, or Session-managed background shell work is unsettled.
   * Monitors, workflows, and cron are deliberately outside this.
   */
  readonly activeWork: boolean;

  /**
   * How much of `activeWork` this runtime can vouch for, as counts rather than
   * a grade.
   *
   * Counts, because the daemon-wide grade cannot be assembled from per-runtime
   * grades: a runtime with zero Sessions vouches for everything it has and is
   * therefore vacuously complete, which must not count as evidence that some
   * *other* runtime's unreported Sessions are covered. Summing counts and
   * grading once at the end is the only composition that gets that right.
   *
   * A Session counts as covered only when its owning channel negotiated
   * reporting, reports every category, and its last snapshot is still inside
   * the freshness window. Without this a controller cannot tell "nothing is
   * running" from "nobody told me what is running", and those must not lead to
   * the same decision.
   */
  readonly activeWorkCoverage: {
    /** Live Sessions in this runtime. */
    total: number;
    /** Of those, how many `activeWork` actually speaks for. */
    covered: number;
    /** Of those, how many sit on a channel that negotiated reporting at all.
     *  Zero is what distinguishes `none` from `partial`. */
    onNegotiatedChannel: number;
    /** Epoch ms of the oldest snapshot among the *covered* Sessions, or null
     *  when none are covered. Diagnostic: the freshness decision is already
     *  folded into `covered`, because only the daemon knows each channel's
     *  negotiated cadence. */
    oldestCoveredReportAt: number | null;
  };

  /** Queued prompts across all sessions — accepted but not yet dispatched,
   *  excluding the one running per session — i.e. the queue-depth gauge for the
   *  Daemon Status charts (distinct from `activePromptCount`). Optional: a
   *  bridge injected via `RunQwenServeDeps.bridge` may predate these Daemon
   *  Status hooks, so the sampler treats them as absent (→ 0 / skipped). */
  readonly pendingPromptTotal?: number;

  /** Latest self-reported ACP-child rss/cpu (Daemon Status child-resource
   *  chart), or undefined before the first successful poll / when no child is
   *  live. Synchronous cache read for the metrics sampler. Optional — see
   *  {@link pendingPromptTotal}. */
  getChildResourceSnapshot?():
    | {
        rssBytes: number;
        cpuPercent: number;
        /** How old this reading is, in ms. Absent on bridges predating the
         *  field — see {@link pendingPromptTotal} — so a caller aggregating
         *  several children must treat it as unknown rather than as fresh. */
        ageMs?: number;
        /** The child's lifetime old-generation high-water marks. Absent when
         *  the child does not report them — a child predating the fields, or
         *  one spawned outside the daemon. Never substituted with zeros: a
         *  measured zero and an unmeasured child are different claims, and
         *  only the first may be read as "this child needed no heap". */
        heap?: ChildHeapReport;
      }
    | undefined;
  /** Poll the live child's resource extMethod and refresh the cache that
   *  {@link getChildResourceSnapshot} reads. Fired fire-and-forget by the
   *  sampler each tick. Optional — see {@link pendingPromptTotal}. */
  refreshChildResource?(): Promise<void>;

  /**
   * Epoch-ms timestamp of the last "activity" event (prompt start/end,
   * session spawn/restore). `null` when the daemon has never processed
   * any activity since boot.
   */
  readonly lastActivityAt: number | null;

  /**
   * Milliseconds since the last activity event (`Date.now() - lastActivityAt`).
   * `null` when no activity has occurred since boot. Computed atomically to
   * avoid race windows between reading `lastActivityAt` and `Date.now()`.
   */
  readonly idleSinceMs: number | null;

  /** Test/inspection hook: number of permission requests awaiting a vote. */
  readonly pendingPermissionCount: number;

  /**
   * Active permission mediation policy. Reflects
   * the value `runQwenServe` resolved from
   * `settings.policy.permissionStrategy` (or the
   * `'first-responder'` default). Surfaced through the
   * `/capabilities` envelope's `policy.permission` field so SDK
   * clients can feature-detect at runtime which strategy is in
   * effect, distinct from the build-supported set advertised on
   * the `permission_mediation` capability tag.
   */
  readonly permissionPolicy: PermissionPolicy;

  /**
   * Synchronous force-kill of every live channel. Called by signal
   * handlers when the operator double-taps Ctrl+C.
   */
  killAllSync(): void;

  /** Close all live child processes; called on daemon/workspace shutdown. */
  shutdown(options?: BridgeShutdownOptions): Promise<void>;

  /**
   * Eagerly spawn the ACP child so the first session doesn't pay
   * cold-start latency. Fire-and-forget; failures are logged and the
   * first session falls back to lazy spawn.
   */
  preheat(): Promise<void>;
}

export interface BridgeShutdownOptions {
  reason?: 'daemon_shutdown' | 'workspace_removed' | 'trust_reconfigured';
}

export interface ShellCommandResult {
  exitCode: number | null;
  output: string;
  aborted: boolean;
}

/** @deprecated Use `AcpSessionBridge` instead. */
export type HttpAcpBridge = AcpSessionBridge;
