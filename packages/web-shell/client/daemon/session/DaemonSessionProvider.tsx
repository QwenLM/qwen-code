/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createContext,
  type Dispatch,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
  useSyncExternalStore,
} from 'react';
import {
  DAEMON_APPROVAL_MODES,
  DaemonClient,
  DaemonCapabilityMissingError,
  DaemonHttpError,
  DaemonSessionClient,
  DaemonStandaloneCreationOutcomeUnknownError,
  STANDALONE_SESSION_OPTIONS_CAPABILITY,
  UNRECOGNIZED_DIAGNOSTICS_LIMIT,
  createDaemonTranscriptStore,
  estimateDaemonTranscriptBlockBytes,
  extractServerTimestamp,
  isTaskExecutionMode,
  isTrimmedPermissionBlockId,
  isTrimmedToolBlockId,
  isUnrecognizedDiagnosticReason,
  matchTurnEvent,
  normalizeDaemonEvent,
  type CreateSessionRequest,
  type DaemonApprovalMode,
  type DaemonEvent,
  type DaemonSseConnectReason,
  type DaemonStandaloneSessionOptions,
  type DaemonTranscriptBlock,
  type DaemonTranscriptState,
  type DaemonTranscriptStore,
  type DaemonTranscriptTruncationDetail,
  type DaemonTurnCompleteData,
  type DaemonUiEvent,
  type DaemonUnrecognizedDiagnostic,
} from '@qwen-code/sdk/daemon';
import {
  createDaemonSessionActions,
  getConnectionAfterSessionClear,
  getPromptSettledKey,
  getWorkspaceModelsAfterSessionClear,
  resolveSessionRestoreTimeouts,
} from './actions.js';
import {
  eventPromptId,
  findLiveJournalRepairSuffix,
  findLiveJournalRepairTarget,
  type LiveJournalRepairSuffix,
  type LiveJournalRepairTarget,
} from './live-journal-repair.js';
import {
  detachDaemonClient,
  getStableClientId,
  persistStableClientId,
} from './clientLifecycle.js';
import { extractHttpStatus, isRecord } from './httpErrors.js';
import {
  getDaemonErrorCode,
  getStandaloneConnectionState,
  isDaemonErrorExplicitlyNonRetryable,
  resolveLiveSessionWorkspaceCwd,
  resolveProviderSessionContext,
  restoreSessionContextMatches,
  sessionContextKey,
} from './session-context.js';
import { useOptionalDaemonWorkspace } from '../workspace/DaemonWorkspaceProvider.js';
import { loadReadyWorkspaceSkills } from '../workspace/load-ready-skills.js';
import {
  getCurrentMode,
  getSessionDisplayName,
  getReplayTokenUsage,
  getTokenCountFromUsage,
  mapProviderStatus,
  mapSessionContextModels,
  mapSessionContextReasoning,
  mapSupportedCommands,
  mapWorkspaceSkills,
  selectGoalStateFromRead,
  updateConnectionFromDaemonEvent,
} from './mappers.js';
import {
  selectDaemonActiveTodoList,
  selectDaemonPendingPermissions,
  selectDaemonStreamingState,
} from './selectors.js';
import {
  clearPassiveAssistantDoneTimer,
  delay,
  getReconnectDelayMs,
  schedulePassiveAssistantDone,
  type TimerRef,
} from '../timing.js';
import {
  parseSidechannelFollowupSuggestion,
  publishSidechannelFollowupSuggestion,
} from '../followupSidechannel.js';
import {
  parseSidechannelMidTurnInjected,
  publishSidechannelMidTurnInjected,
} from '../midTurnInjectedSidechannel.js';
import {
  isPendingPromptEvent,
  publishPendingPromptEvent,
} from '../pendingPromptVersion.js';
import {
  MISSING_SESSION_HTTP_STATUSES,
  isMissingSessionHttpStatus,
  resolveConnectionErrorStatus,
} from './status.js';
import type {
  ActivePrompt,
  AddDaemonSessionNotice,
  DaemonConnectionState,
  DaemonPromptStatus,
  DaemonSessionActions,
  DaemonSessionContextValue,
  DaemonSessionNotice,
  DaemonSessionOwnerGuard,
  DaemonSessionProviderProps,
  DaemonProductSessionContext,
  DaemonWorkspaceEventSignals,
  PendingSessionLoad,
  SettledPrompt,
} from './types.js';

export type {
  DaemonCommandInfo,
  DaemonConnectionState,
  DaemonConnectionStatus,
  DaemonModelInfo,
  DaemonProductSessionContext,
  DaemonStandaloneConnectionState,
  DaemonNoticeCategory,
  DaemonNoticeOperation,
  DaemonNoticeSeverity,
  DaemonPromptImage,
  DaemonPromptStatus,
  DaemonSessionActions,
  DaemonSessionContextValue,
  DaemonSessionNotice,
  DaemonSessionProviderProps,
  DaemonTodoItem,
  DaemonTodoList,
  DaemonTodoPriority,
  DaemonTodoStatus,
  DaemonWorkspaceEventSignals,
  SendPromptOptions,
} from './types.js';

export interface DaemonTranscriptHistory {
  hasMore: boolean;
  loading: boolean;
  capacityReached: boolean;
  paginationError: boolean;
  loadMore(options?: { force?: boolean }): Promise<void>;
}

interface LiveJournalRepairEpisode {
  sessionId: string;
  target: LiveJournalRepairTarget;
  checkpoint: DaemonTranscriptState;
  markerBlockId?: string;
  observedSnapshotEventIds: ReadonlySet<number>;
  snapshotLastEventId: number;
  lastObservedEventId: number;
  terminalSeen: boolean;
  attempted: boolean;
  controller?: AbortController;
}

interface TranscriptHistoryMaterialization {
  blocks: readonly DaemonTranscriptBlock[];
  nextOrdinal: number;
  retainedBytes: number;
  toolBlockByCallId: Record<string, string>;
  permissionBlockByRequestId: Record<string, string>;
  unrecognizedDiagnostics: readonly DaemonUnrecognizedDiagnostic[];
}

type TranscriptHistoryAdmission =
  | { admitted: true; materialization: TranscriptHistoryMaterialization }
  | {
      admitted: false;
      reason: 'count' | 'bytes';
      pageBlocks: number;
      pageBytes: number;
      /** True when the page can never be admitted, even into an empty window. */
      impossible: boolean;
    };

const SESSION_TRANSCRIPT_PAGINATION_FEATURE = 'session_transcript_pagination';
const CLIENT_IDENTITY_FEATURE = 'client_identity';
const WORKSPACE_ACP_PREHEAT_FEATURE = 'workspace_acp_preheat';
const WORKSPACE_ACP_STATUS_FEATURE = 'workspace_acp_status';
const WORKSPACE_SKILLS_CONFIG_RUNTIME_FEATURE =
  'workspace_skills_config_runtime';
function resolveStandaloneApprovalMode(
  value: string | undefined,
): DaemonApprovalMode | undefined {
  if (value === undefined) return undefined;
  if (DAEMON_APPROVAL_MODES.includes(value as DaemonApprovalMode)) {
    return value as DaemonApprovalMode;
  }
  throw new Error(`Unsupported standalone approval mode: ${value}`);
}
// Cap the daemon-advertised restore retry delay: an unbounded value overflows
// setTimeout's 2^31-1 ms limit (firing instantly, retry storm) or leaves the
// UI stuck connecting for hours.
const RESTORE_IN_PROGRESS_RETRY_MAX_MS = 60_000;

const RECORD_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assistantDoneFromTurnEvent(
  event: DaemonEvent,
  reason: string,
): DaemonUiEvent {
  const serverTimestamp = extractServerTimestamp(event);
  const data = isRecord(event.data) ? event.data : undefined;
  const rawBranchPoint =
    event.type === 'turn_complete' &&
    reason === 'end_turn' &&
    isRecord(data?.['branchPoint'])
      ? data['branchPoint']
      : undefined;
  const assistantRecordUuid =
    typeof rawBranchPoint?.['assistantRecordUuid'] === 'string'
      ? rawBranchPoint['assistantRecordUuid']
      : undefined;
  const checkpointUuid =
    typeof rawBranchPoint?.['checkpointUuid'] === 'string'
      ? rawBranchPoint['checkpointUuid']
      : undefined;
  const branchPointValid =
    assistantRecordUuid !== undefined &&
    RECORD_UUID_PATTERN.test(assistantRecordUuid) &&
    checkpointUuid !== undefined &&
    RECORD_UUID_PATTERN.test(checkpointUuid);
  return {
    type: 'assistant.done',
    reason,
    eventId: event.id,
    ...(event.promptId ? { promptId: event.promptId } : {}),
    ...(serverTimestamp !== undefined ? { serverTimestamp } : {}),
    ...(branchPointValid
      ? {
          sourceRecordIds: [assistantRecordUuid],
          branchRecordId: checkpointUuid,
        }
      : {}),
  };
}

function getPersistedReplayRecordId(event: DaemonEvent): string | undefined {
  // A `history_truncated` marker may carry a `recordId` anchor stamped by
  // the daemon's compaction engine — the last recordId it saw before the
  // truncation point. This is the fallback used when the retained window
  // lost every turn-boundary `session_update` (e.g. live-journal cap hit
  // during a single long in-flight turn) and the client would otherwise
  // have no `beforeRecordId` for transcript pagination.
  if (event.type === 'history_truncated') {
    try {
      if (!isRecord(event.data)) return undefined;
      return getString(event.data, 'recordId');
    } catch {
      return undefined;
    }
  }
  if (event.type !== 'session_update') {
    return undefined;
  }
  try {
    if (!isRecord(event.data)) return undefined;
    const update = event.data['update'];
    const meta = isRecord(update) ? update['_meta'] : event.data['_meta'];
    return isRecord(meta)
      ? getString(meta, 'qwen.session.recordId')
      : undefined;
  } catch {
    return undefined;
  }
}

function hasFullTranscriptBeforeReplay(event: DaemonEvent): boolean {
  return (
    event.type === 'history_truncated' &&
    isRecord(event.data) &&
    event.data['fullTranscriptAvailable'] === true
  );
}

function isHistoricalReplayMarker(event: DaemonEvent): boolean {
  return (
    hasFullTranscriptBeforeReplay(event) &&
    isRecord(event.data) &&
    event.data['scope'] === undefined
  );
}

function materializeTranscriptHistory(
  current: DaemonTranscriptState,
  events: DaemonUiEvent[],
  maxBlocks: number,
): TranscriptHistoryAdmission {
  // Drop fetched events whose source records are already displayed.
  // `beforeRecordId` pagination is exclusive of the anchor but the anchor
  // can sit inside the retained window (e.g. the daemon's transcript
  // backfill for a live-journal overflow returns the latest recordId), so
  // a page may include records the client already shows. Prepend has no
  // other dedup, so without this filter those records would render twice.
  const displayedRecordIds = new Set<string>();
  for (const block of current.blocks) {
    for (const recordId of block.sourceRecordIds ?? []) {
      displayedRecordIds.add(recordId);
    }
  }
  for (const diagnostic of current.unrecognizedDiagnostics) {
    for (const recordId of diagnostic.sourceRecordIds ?? []) {
      displayedRecordIds.add(recordId);
    }
  }
  // Secondary content-aware dedup for blocks that carry no recordId — the
  // locally echoed user prompt, which `suppressOwnUserEcho` keeps from ever
  // unioning the daemon's recordId-stamped echo. RecordId dedup is blind to
  // it, so once a trim leaves it as the oldest retained block, a load-older
  // page returning that same prompt's persisted record would materialize a
  // second user block and double-count it. The collision is strictly a
  // boundary pair — the window's oldest block (the echo) against the page's
  // newest user block (that same prompt's persisted record, adjacent to the
  // window) — so only that pair is compared below. Keying on text window-wide
  // would instead drop DISTINCT older prompts the user happened to send twice
  // ("yes", a retry), permanently orphaning their assistant replies.
  // The key must key on echo PRESENCE, not non-empty text: image/file-only
  // prompts submit with empty text, so a `text !== ''` gate would skip their
  // dedup and double-render the prompt. Fold media into the key (image/file
  // counts) so two distinct media-only prompts at the boundary don't collapse.
  const userBlockBoundaryKey = (
    block: DaemonTranscriptBlock | undefined,
  ): string | undefined => {
    if (block?.kind !== 'user') return undefined;
    const text = (block as { text?: string }).text ?? '';
    const images = (block as { images?: unknown[] }).images?.length ?? 0;
    const files = (block as { files?: unknown[] }).files?.length ?? 0;
    return `${text} img:${images} file:${files}`;
  };
  const oldestRetainedBlock = current.blocks[0];
  const boundaryEchoKey =
    (oldestRetainedBlock?.sourceRecordIds?.length ?? 0) === 0
      ? userBlockBoundaryKey(oldestRetainedBlock)
      : undefined;
  const freshEvents =
    displayedRecordIds.size === 0
      ? events
      : events.filter(
          (event) =>
            !event.sourceRecordIds?.some((recordId) =>
              displayedRecordIds.has(recordId),
            ),
        );
  const historyStore = createDaemonTranscriptStore({
    maxBlocks: Number.MAX_SAFE_INTEGER,
    // Trim-free by intent: a media-heavy page would otherwise cross the
    // default byte budget mid-build and evict the page's oldest records,
    // which the exclusive pagination anchor can never re-fetch.
    maxRetainedBytes: Number.POSITIVE_INFINITY,
    nextOrdinal: current.nextOrdinal,
    retainSubagentBlocks: current.retainSubagentBlocks,
  });
  historyStore.dispatch(freshEvents);
  const history = historyStore.getSnapshot();
  // Drop the page's newest user block only when it duplicates the window's
  // oldest recordId-less echo (the boundary pair). A same-text user block
  // deeper in older history is a distinct prompt and must survive.
  let pageBlockList = history.blocks;
  if (boundaryEchoKey !== undefined) {
    for (let i = history.blocks.length - 1; i >= 0; i -= 1) {
      const block = history.blocks[i];
      if (block?.kind !== 'user') continue;
      if (userBlockBoundaryKey(block) === boundaryEchoKey) {
        pageBlockList = [
          ...history.blocks.slice(0, i),
          ...history.blocks.slice(i + 1),
        ];
      }
      break;
    }
  }
  let pageBytes = 0;
  for (const block of pageBlockList) {
    pageBytes += estimateDaemonTranscriptBlockBytes(block);
  }
  const pageBlocks = pageBlockList.length;
  // `impossible` must be evaluated across BOTH dimensions, regardless of
  // which branch rejects: a page that alone fills the whole block window can
  // never be admitted (an anchored window always retains at least one block),
  // and likewise for the byte budget. Equality is already impossible, hence
  // `>=`. A page rejected by one dimension but impossible in the other would
  // route to the re-openable latch whose re-open gate is then unsatisfiable —
  // terminal either way.
  const impossible =
    pageBlocks >= maxBlocks || pageBytes >= current.maxRetainedBytes;
  // Count admission: an over-count merge stays untrimmed while the session
  // is idle, and the next live trim evicts the freshly prepended oldest
  // records, which the exclusive pagination anchor can never re-fetch — a
  // permanent silent gap. Reject atomically.
  if (pageBlocks + current.blocks.length > maxBlocks) {
    return {
      admitted: false,
      reason: 'count',
      pageBlocks,
      pageBytes,
      impossible,
    };
  }
  // Byte-budget admission: same silent-gap hazard as the count cap — an
  // over-budget merge is evicted oldest-first by the next live trim.
  if (current.retainedBytes + pageBytes > current.maxRetainedBytes) {
    return {
      admitted: false,
      reason: 'bytes',
      pageBlocks,
      pageBytes,
      impossible,
    };
  }
  return {
    admitted: true,
    materialization: {
      blocks: pageBlockList,
      nextOrdinal: history.nextOrdinal,
      retainedBytes: pageBytes,
      toolBlockByCallId: history.toolBlockByCallId,
      permissionBlockByRequestId: history.permissionBlockByRequestId,
      // History pages can carry frames recorded by newer daemon versions, exactly
      // forward-compat case the sidechannel exists for (#8823); keep them
      // instead of dropping the throwaway store's diagnostics.
      unrecognizedDiagnostics: history.unrecognizedDiagnostics,
    },
  };
}

function applyTranscriptHistory(
  current: DaemonTranscriptState,
  history: TranscriptHistoryMaterialization,
): DaemonTranscriptState {
  // A page-resurrected real block mapping must win over the current window's
  // TRIMMED sentinel for the same callId — otherwise the resurrected block is
  // orphaned and every later live update for that tool hits the sentinel
  // branch (a false "output trimmed" error block plus dropped updates).
  // Real-vs-real collisions cannot occur (the recordId dedup filter drops
  // already-displayed records before materialization).
  const toolBlockByCallId: Record<string, string> = {
    ...history.toolBlockByCallId,
  };
  for (const [callId, blockId] of Object.entries(current.toolBlockByCallId)) {
    if (
      isTrimmedToolBlockId(blockId) &&
      toolBlockByCallId[callId] !== undefined
    ) {
      continue;
    }
    toolBlockByCallId[callId] = blockId;
  }
  // A resurrected tool is live content again; clear its trimmed-notification
  // flag so a future re-trim reports it once instead of staying silent.
  const trimmedToolNotificationByCallId: Record<string, true> = {
    ...current.trimmedToolNotificationByCallId,
  };
  for (const callId of Object.keys(history.toolBlockByCallId)) {
    delete trimmedToolNotificationByCallId[callId];
  }
  // Same sentinel-aware merge for permission blocks: a page-resurrected real
  // mapping must win over the current window's TRIMMED_PERMISSION sentinel, or
  // a resurrected pending permission never flips to resolved (the permission
  // upsert/resolve paths early-return on the sentinel).
  const permissionBlockByRequestId: Record<string, string> = {
    ...history.permissionBlockByRequestId,
  };
  for (const [requestId, blockId] of Object.entries(
    current.permissionBlockByRequestId,
  )) {
    if (
      isTrimmedPermissionBlockId(blockId) &&
      permissionBlockByRequestId[requestId] !== undefined
    ) {
      continue;
    }
    permissionBlockByRequestId[requestId] = blockId;
  }
  return {
    ...current,
    blocks: [...history.blocks, ...current.blocks],
    retainedBytes: current.retainedBytes + history.retainedBytes,
    nextOrdinal: history.nextOrdinal,
    toolBlockByCallId,
    trimmedToolNotificationByCallId,
    permissionBlockByRequestId,
    // History entries are older than anything received live, so they go
    // first; the slice keeps the newest entries within the sidechannel cap.
    unrecognizedDiagnostics: [
      ...history.unrecognizedDiagnostics,
      ...current.unrecognizedDiagnostics,
    ].slice(-UNRECOGNIZED_DIAGNOSTICS_LIMIT),
  };
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function projectSubagentToolUpdate(
  event: Extract<DaemonUiEvent, { type: 'tool.update' }>,
): DaemonUiEvent {
  const rawInput = isRecord(event.rawInput) ? event.rawInput : undefined;
  const rawOutput = isRecord(event.rawOutput) ? event.rawOutput : undefined;
  const name = event.toolName?.toLowerCase();
  const isSubagent =
    name === 'agent' ||
    name === 'task' ||
    typeof rawInput?.['subagent_type'] === 'string' ||
    rawOutput?.['type'] === 'task_execution';
  if (!isSubagent) return event;

  const executionSummary = isRecord(rawOutput?.['executionSummary'])
    ? rawOutput['executionSummary']
    : undefined;
  const subagentType = boundedString(rawInput?.['subagent_type'], 120);
  const prompt = boundedString(rawInput?.['prompt'], 240);
  const description = boundedString(rawInput?.['description'], 240);
  const workingDir = boundedString(rawInput?.['working_dir'], 240);
  const agentName = boundedString(rawInput?.['name'], 120);
  const todoId =
    typeof rawInput?.['todo_id'] === 'string' ? rawInput['todo_id'] : undefined;
  const subagentName = boundedString(rawOutput?.['subagentName'], 120);
  const subagentColor = boundedString(rawOutput?.['subagentColor'], 80);
  const taskDescription = boundedString(rawOutput?.['taskDescription'], 240);
  const status = boundedString(rawOutput?.['status'], 80);
  const executionMode = rawOutput?.['executionMode'];
  const terminateReason = boundedString(rawOutput?.['terminateReason'], 240);
  const skills = Array.isArray(rawOutput?.['skills'])
    ? rawOutput['skills']
        .slice(0, 32)
        .flatMap((skill) =>
          boundedString(skill, 120) ? [boundedString(skill, 120)!] : [],
        )
    : [];
  const projectedInput = rawInput
    ? {
        ...(subagentType ? { subagent_type: subagentType } : {}),
        ...(prompt ? { prompt } : {}),
        ...(description ? { description } : {}),
        ...(todoId ? { todo_id: todoId } : {}),
        ...(typeof rawInput['run_in_background'] === 'boolean'
          ? { run_in_background: rawInput['run_in_background'] }
          : {}),
        ...(workingDir ? { working_dir: workingDir } : {}),
        ...(agentName ? { name: agentName } : {}),
      }
    : undefined;
  const projectedOutput = rawOutput
    ? {
        ...(rawOutput['type'] === 'task_execution'
          ? { type: 'task_execution' }
          : {}),
        ...(subagentName ? { subagentName } : {}),
        ...(subagentColor ? { subagentColor } : {}),
        ...(taskDescription ? { taskDescription } : {}),
        ...(status ? { status } : {}),
        ...(isTaskExecutionMode(executionMode) ? { executionMode } : {}),
        ...(terminateReason ? { terminateReason } : {}),
        ...(typeof rawOutput['tokenCount'] === 'number'
          ? { tokenCount: rawOutput['tokenCount'] }
          : {}),
        ...(skills.length > 0 ? { skills } : {}),
        ...(executionSummary
          ? {
              executionSummary: {
                ...(typeof executionSummary['totalToolCalls'] === 'number'
                  ? { totalToolCalls: executionSummary['totalToolCalls'] }
                  : {}),
                ...(typeof executionSummary['totalDurationMs'] === 'number'
                  ? { totalDurationMs: executionSummary['totalDurationMs'] }
                  : {}),
                ...(typeof executionSummary['outputTokens'] === 'number'
                  ? { outputTokens: executionSummary['outputTokens'] }
                  : {}),
                ...(typeof executionSummary['inputTokens'] === 'number'
                  ? { inputTokens: executionSummary['inputTokens'] }
                  : {}),
                ...(typeof executionSummary['cachedTokens'] === 'number'
                  ? { cachedTokens: executionSummary['cachedTokens'] }
                  : {}),
                ...(typeof executionSummary['totalTokens'] === 'number'
                  ? { totalTokens: executionSummary['totalTokens'] }
                  : {}),
              },
            }
          : {}),
      }
    : undefined;

  return {
    ...event,
    ...(projectedInput && Object.keys(projectedInput).length > 0
      ? { rawInput: projectedInput }
      : { rawInput: undefined }),
    ...(projectedOutput && Object.keys(projectedOutput).length > 0
      ? { rawOutput: projectedOutput }
      : { rawOutput: undefined }),
    content: undefined,
    details: undefined,
  };
}

function projectMainTranscriptEvents(events: DaemonUiEvent[]): DaemonUiEvent[] {
  const projected: DaemonUiEvent[] = [];
  for (const event of events) {
    if (
      'parentToolCallId' in event &&
      event.parentToolCallId &&
      event.type !== 'assistant.usage'
    ) {
      continue;
    }
    projected.push(
      event.type === 'tool.update' ? projectSubagentToolUpdate(event) : event,
    );
  }
  return projected;
}

export const projectMainTranscriptEventsForTesting =
  projectMainTranscriptEvents;

const DaemonStoreContext = createContext<DaemonTranscriptStore | undefined>(
  undefined,
);
const DaemonConnectionContext = createContext<
  DaemonConnectionState | undefined
>(undefined);
const DaemonActionsContext = createContext<DaemonSessionActions | undefined>(
  undefined,
);
const DaemonTranscriptHistoryContext = createContext<
  DaemonTranscriptHistory | undefined
>(undefined);
const DaemonPromptStatusContext = createContext<DaemonPromptStatus | undefined>(
  undefined,
);
interface SessionNoticesValue {
  notices: readonly DaemonSessionNotice[];
  dismissNotice(id: string): void;
  clearNotices(): void;
}

type SessionNoticeInput = Parameters<AddDaemonSessionNotice>[0];

const DaemonSessionNoticesContext = createContext<
  SessionNoticesValue | undefined
>(undefined);
const DaemonWorkspaceEventSignalsContext = createContext<
  DaemonWorkspaceEventSignals | undefined
>(undefined);
const DaemonSessionOwnerGuardContext = createContext<
  DaemonSessionOwnerGuard | undefined
>(undefined);
/**
 * Subset of TERMINAL_SESSION_HTTP_STATUSES that represent **credential
 * failures** (vs session-not-found 404/410). Auth failures should NOT enter
 * the reconnect loop even when `autoReconnect: true` — retrying with the
 * same bad token loops forever, hammering the server with bad credentials
 * and risking transcript wipes if reconnect later attaches a different
 * session and hits the sessionId-change `store.reset()` branch.
 *
 * 404/410 (session-not-found) leave the requested session disconnected instead
 * of silently creating a replacement empty session.
 */
const AUTH_FAILURE_HTTP_STATUSES = new Set([401, 403]);
const TERMINAL_SESSION_HTTP_STATUSES = new Set([
  ...AUTH_FAILURE_HTTP_STATUSES,
  ...MISSING_SESSION_HTTP_STATUSES,
]);

interface HeartbeatFailureState {
  session?: DaemonSessionClient;
  consecutiveFailures: number;
  lastHttpError?: { status: number; message: string };
}

// Keep enough transcript history for large daemon replay streams so event order
// and subagent grouping survive replay. Rendering is virtualized, but message
// normalization still rebuilds from retained blocks today, so this default is a
// history-preservation tradeoff rather than a claim that large transcripts are
// CPU-free. This is a block-COUNT ceiling; the memory ceiling is enforced
// separately by the transcript store's retention byte budget, because blocks
// can carry large raw tool payloads (an implicit 200k window let a single busy
// session exhaust renderer memory). Callers can pass a smaller maxBlocks in
// constrained contexts.
export const DEFAULT_MAX_BLOCKS = 50_000;
const TRANSCRIPT_DISPATCH_BATCH_MS = 16;

const INITIAL_WORKSPACE_EVENT_SIGNALS: DaemonWorkspaceEventSignals = {
  memoryVersion: 0,
  agentsVersion: 0,
  toolsVersion: 0,
  settingsVersion: 0,
  skillsVersion: 0,
  mcpVersion: 0,
  extensionsVersion: 0,
  artifactsVersion: 0,
  initVersion: 0,
  authVersion: 0,
};

const UNHANDLED_SESSION = Symbol('unhandled session');

function clearNonWorkspaceSessionState(
  current: DaemonConnectionState,
): DaemonConnectionState {
  return current.sessionContext !== undefined &&
    current.sessionContext.kind !== 'workspace'
    ? getConnectionAfterSessionClear(current, current.sessionId)
    : current;
}

function useStableProductSessionContext(
  context: DaemonProductSessionContext | undefined,
): DaemonProductSessionContext | undefined {
  const identity = sessionContextKey(context);
  const stableRef = useRef({ identity, context });
  if (stableRef.current.identity !== identity) {
    stableRef.current = { identity, context };
  }
  return stableRef.current.context;
}

export function DaemonSessionProvider(props: DaemonSessionProviderProps) {
  const {
    baseUrl,
    token,
    workspaceCwd,
    sessionContext,
    sessionId,
    clientId,
    createSessionRequest,
    maxQueued = 1024,
    maxBlocks = DEFAULT_MAX_BLOCKS,
    maxRetainedBytes,
    historyPageSize,
    subagentTranscriptMode = 'full',
    suppressOwnUserEcho = true,
    includeRawEvent = false,
    autoConnect = true,
    autoReconnect = true,
    restartEventStreamOnPrompt = false,
    reconnectDelayMs = 1_000,
    maxReconnectDelayMs = 10_000,
    heartbeatIntervalMs = 30_000,
    heartbeatFailureThreshold = 3,
    loadWarnings,
    children,
  } = props;
  const workspace = useOptionalDaemonWorkspace();
  const resolvedBaseUrl = baseUrl ?? workspace?.baseUrl;
  const resolvedToken = token ?? workspace?.token;
  const sessionContextResolution = useMemo(() => {
    try {
      return {
        value: resolveProviderSessionContext(
          sessionContext,
          workspaceCwd,
          workspace?.workspaceCwd,
        ),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [sessionContext, workspace?.workspaceCwd, workspaceCwd]);
  const resolvedSessionContext = useStableProductSessionContext(
    sessionContextResolution.value,
  );
  const sessionContextResolutionError = sessionContextResolution.error;
  const resolvedWorkspaceCwd =
    resolvedSessionContext?.kind === 'workspace'
      ? resolvedSessionContext.cwd
      : undefined;
  const sessionCapabilitiesRef = useRef<DaemonConnectionState['capabilities']>(
    workspace?.capabilities,
  );
  const workspaceClientRef = useRef(workspace?.client);
  workspaceClientRef.current = workspace?.client;
  const workspaceCapabilitiesRef = useRef(workspace?.capabilities);
  workspaceCapabilitiesRef.current = workspace?.capabilities;
  const workspaceGetCapabilitiesRef = useRef(workspace?.getCapabilities);
  workspaceGetCapabilitiesRef.current = workspace?.getCapabilities;
  const workspaceAcpPreheatInFlightRef = useRef(false);
  const initialRestoreSessionIdRef = useRef(sessionId);
  const initialRestoreSessionId = initialRestoreSessionIdRef.current;
  // Captured once at mount: if the host did not provide an initial session,
  // keep the provider empty until the first prompt creates one. Later
  // sessionId prop changes are handled by the controlled-session effect below.
  const shouldDeferInitialSessionCreation =
    initialRestoreSessionId === undefined;
  const resolvedWorkspaceCwdRef = useRef(resolvedWorkspaceCwd);
  resolvedWorkspaceCwdRef.current = resolvedWorkspaceCwd;
  const resolvedSessionContextRef = useRef(resolvedSessionContext);
  resolvedSessionContextRef.current = resolvedSessionContext;
  const sessionContextResolutionErrorRef = useRef(
    sessionContextResolutionError,
  );
  sessionContextResolutionErrorRef.current = sessionContextResolutionError;
  const activeSessionContextRef = useRef(resolvedSessionContext);
  const activeWorkspaceCwdRef = useRef(resolvedWorkspaceCwd);
  if (resolvedWorkspaceCwd) {
    activeWorkspaceCwdRef.current = resolvedWorkspaceCwd;
  }

  const sessionRef = useRef<DaemonSessionClient | undefined>(undefined);
  const sessionConfigGenerationRef = useRef(
    new WeakMap<DaemonSessionClient, number>(),
  );
  const transcriptHistoryRef = useRef<{
    sessionId?: string;
    beforeRecordId?: string;
    cursor?: string;
    hasMore: boolean;
    loading: boolean;
    capacityReached: boolean;
    paginationError: boolean;
    /**
     * Footprint of the last page rejected by admission. The eviction
     * re-open of the capacity latch consults it so the affordance only
     * reappears once enough capacity has been freed for that page to be
     * admitted; undefined when the latch came from replay saturation.
     */
    rejectedPage?: { blocks: number; bytes: number };
  }>({
    hasMore: false,
    loading: false,
    capacityReached: false,
    paginationError: false,
  });
  const [transcriptHistoryState, setTranscriptHistoryState] = useState({
    hasMore: false,
    loading: false,
    capacityReached: false,
    paginationError: false,
  });
  // Monotonic counter bumped whenever a block trim invalidates the
  // pagination position (the anchor record may have been evicted). A
  // load-older fetch captures it before the await and drops the page if it
  // moved mid-fetch, so a stale page can never advance the anchor below the
  // evicted band.
  const paginationGenerationRef = useRef(0);
  const store = useMemo(
    () =>
      createDaemonTranscriptStore({
        maxBlocks,
        ...(maxRetainedBytes !== undefined ? { maxRetainedBytes } : {}),
        retainSubagentBlocks: subagentTranscriptMode === 'full',
        onTruncation: (detail) => {
          if (detail.kind !== 'blocks') return;
          const history = transcriptHistoryRef.current;
          const activeSession = sessionRef.current;
          if (!activeSession || history.sessionId !== activeSession.sessionId) {
            return;
          }
          // Trimming evicts oldest-first, so it can remove the very record
          // the exclusive `beforeRecordId` anchor points at; the daemon
          // never returns the anchor itself, so the evicted stretch would
          // become unreachable. Re-anchor to the oldest retained record and
          // atomically drop a stale cursor (loadMore prefers cursor over
          // beforeRecordId, and a cursor-addressed position can never be
          // re-based after the blocks it points past are evicted). A rewind
          // (`evictedOldest === false`) drops the newest blocks and leaves
          // the oldest anchor intact, so it must not trigger re-anchoring.
          if (detail.evictedOldest !== false) {
            if (detail.oldestRetainedRecordId !== undefined) {
              history.beforeRecordId = detail.oldestRetainedRecordId;
              history.cursor = undefined;
              // A re-anchoring trim invalidates a latched rejectedPage
              // footprint: the daemon (exclusive-before, served from disk)
              // re-serves the evicted band on the next fetch, so the page will
              // be larger than latched. Grow the latched footprint by the
              // evicted band so the re-open gate measures the page the
              // re-anchored fetch actually gets — a stale (too-small) footprint
              // would churn fetch/reject, or misclassify a now-larger page as
              // terminal. `store.getSnapshot()` is still pre-trim here: the
              // store swaps its state only after the reduce completes.
              if (history.rejectedPage) {
                const preTrim = store.getSnapshot();
                const postTrimBlockCount =
                  detail.blockCount ?? preTrim.blocks.length;
                const postTrimRetainedBytes =
                  detail.retainedBytes ?? preTrim.retainedBytes;
                history.rejectedPage = {
                  blocks:
                    history.rejectedPage.blocks +
                    Math.max(0, preTrim.blocks.length - postTrimBlockCount),
                  bytes:
                    history.rejectedPage.bytes +
                    Math.max(0, preTrim.retainedBytes - postTrimRetainedBytes),
                };
              }
              // A live trim evicts oldest blocks that stay persisted
              // daemon-side, so there is now fetchable content older than the
              // re-set anchor. A session that loaded unlatched (hasMore=false,
              // capacityReached=false) must surface that affordance, or the
              // evicted band is unreachable until a reload. Mirror the replay
              // path's olderHistoryReachable gates.
              if (!history.capacityReached && !history.hasMore) {
                const features = sessionCapabilitiesRef.current?.features;
                const windowCaps = store.getSnapshot();
                const postTrimRetainedBytes =
                  detail.retainedBytes ?? windowCaps.retainedBytes;
                const byteCap =
                  detail.maxRetainedBytes ?? windowCaps.maxRetainedBytes;
                const olderHistoryReachable =
                  Array.isArray(features) &&
                  features.includes(SESSION_TRANSCRIPT_PAGINATION_FEATURE) &&
                  postTrimRetainedBytes < byteCap;
                if (olderHistoryReachable) {
                  history.hasMore = true;
                  setTranscriptHistoryState({
                    hasMore: true,
                    loading: false,
                    capacityReached: false,
                    paginationError: history.paginationError,
                  });
                }
              }
            } else {
              // Re-anchor uncomputable — no retained block carries a
              // recordId. The current anchor points at an evicted record the
              // exclusive pagination contract can never return again; fail
              // closed instead of offering an affordance that skips the
              // evicted band.
              history.beforeRecordId = undefined;
              history.cursor = undefined;
              if (history.hasMore) {
                history.hasMore = false;
                setTranscriptHistoryState({
                  hasMore: false,
                  loading: history.loading,
                  capacityReached: history.capacityReached,
                  paginationError: history.paginationError,
                });
              }
            }
          }
          // Oldest-first eviction can invalidate an in-flight page's anchor;
          // bump the generation so the stale page is dropped on resolve. A
          // rewind leaves the anchor band untouched, so in-flight pages stay
          // valid and must not be dropped.
          if (detail.evictedOldest !== false) {
            paginationGenerationRef.current += 1;
          }
          if (history.capacityReached) {
            // Eviction freed retention capacity, so the page rejected at the
            // latch may fit now — re-open the load-older affordance, but
            // only where the sibling paths would have offered it: the daemon
            // must support pagination and a positional anchor must exist.
            const features = sessionCapabilitiesRef.current?.features;
            const paginationSupported =
              Array.isArray(features) &&
              features.includes(SESSION_TRANSCRIPT_PAGINATION_FEATURE);
            const anchored =
              history.beforeRecordId !== undefined ||
              history.cursor !== undefined;
            if (!paginationSupported || !anchored) {
              return;
            }
            // Admission-headroom gate: only re-open when the rejected page
            // would actually be admitted now. A count trim restores the
            // window to exactly maxBlocks (zero headroom), so without this
            // check every live block during streaming would re-open the
            // latch into an immediate fetch/reject cycle. Caps are stable
            // across a trim; the snapshot only backs detail-field fallbacks.
            const windowCaps = store.getSnapshot();
            const postTrimBlockCount =
              detail.blockCount ?? windowCaps.blocks.length;
            const postTrimRetainedBytes =
              detail.retainedBytes ?? windowCaps.retainedBytes;
            const blockCap = detail.maxBlocks ?? windowCaps.maxBlocks;
            const byteCap =
              detail.maxRetainedBytes ?? windowCaps.maxRetainedBytes;
            const rejected = history.rejectedPage;
            // A footprint-less latch (replay saturation) re-opens only on
            // real count headroom: while the count window is saturated,
            // count admission rejects every page regardless of bytes.
            const admissionHeadroom = rejected
              ? rejected.blocks + postTrimBlockCount <= blockCap &&
                rejected.bytes + postTrimRetainedBytes <= byteCap
              : postTrimBlockCount < blockCap;
            if (!admissionHeadroom) {
              return;
            }
            history.rejectedPage = undefined;
            history.hasMore = true;
            history.capacityReached = false;
            setTranscriptHistoryState({
              hasMore: true,
              loading: false,
              capacityReached: false,
              paginationError: history.paginationError,
            });
          }
        },
      }),
    [maxBlocks, maxRetainedBytes, subagentTranscriptMode],
  );
  const eventStreamRef = useRef<
    | {
        sessionId: string;
        controller: AbortController;
        restartRequested: boolean;
      }
    | undefined
  >(undefined);
  const lastSessionIdRef = useRef<string | undefined>(undefined);
  const activePromptsRef = useRef<Map<string, ActivePrompt>>(new Map());
  const settledPromptsRef = useRef<Map<string, SettledPrompt>>(new Map());
  const pendingSessionLoadRef = useRef<PendingSessionLoad | undefined>(
    undefined,
  );
  const pendingSessionLoadIdRef = useRef(0);
  const liveJournalRepairRef = useRef<LiveJournalRepairEpisode | undefined>(
    undefined,
  );
  const repairReloadRef = useRef<
    DaemonSessionActions['reloadSession'] | undefined
  >(undefined);
  const tryLiveJournalRepairRef = useRef<(() => void) | undefined>(undefined);
  const passiveAssistantDoneTimerRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const heartbeatSupportedRef = useRef(false);
  const heartbeatFailureStateRef = useRef<HeartbeatFailureState>({
    consecutiveFailures: 0,
  });
  const manualSessionClearRef = useRef(false);
  const skipNextCleanupDetachSessionRef = useRef<
    DaemonSessionClient | undefined
  >(undefined);
  const contextErrorPreservedSessionRef = useRef<
    DaemonSessionClient | undefined
  >(undefined);
  const contextErrorPreservedProductContextRef = useRef<
    DaemonProductSessionContext | undefined
  >(undefined);
  const settledRestoredActivePromptSessionsRef = useRef<
    WeakSet<DaemonSessionClient>
  >(new WeakSet());
  const eventOptionsRef = useRef({ suppressOwnUserEcho, includeRawEvent });
  const reconnectConfigRef = useRef({ reconnectDelayMs, maxReconnectDelayMs });
  // Aborts the reconnect backoff wait so a caller can force an immediate SSE
  // rebuild (e.g. a prompt submitted while the stream is down).
  const reconnectAbortRef = useRef<AbortController | undefined>(undefined);
  const loadWarningsRef = useRef(loadWarnings);
  const historyPageSizeRef = useRef(historyPageSize);
  const subagentTranscriptModeRef = useRef(subagentTranscriptMode);
  const clientIdRef = useRef<string | undefined>(getStableClientId(clientId));
  eventOptionsRef.current = { suppressOwnUserEcho, includeRawEvent };
  reconnectConfigRef.current = { reconnectDelayMs, maxReconnectDelayMs };
  loadWarningsRef.current = loadWarnings;
  historyPageSizeRef.current = historyPageSize;
  subagentTranscriptModeRef.current = subagentTranscriptMode;
  const modelServiceId = createSessionRequest?.modelServiceId;
  const sessionScope = createSessionRequest?.sessionScope;
  const createSessionRequestRef = useRef(createSessionRequest);
  createSessionRequestRef.current = createSessionRequest;
  const [promptStatus, setPromptStatus] = useState<DaemonPromptStatus>('idle');
  const [restoreSessionId, setRestoreSessionId] = useState<string | undefined>(
    initialRestoreSessionId,
  );
  const [restoreSessionContext, setRestoreSessionContext] = useState<
    DaemonProductSessionContext | undefined
  >(resolvedSessionContext);
  const [restoreMode, setRestoreMode] = useState<'load' | 'resume'>('load');
  const [restoreSessionNonce, setRestoreSessionNonce] = useState(0);
  const [attachSessionNonce, setAttachSessionNonce] = useState(0);
  const [newSessionNonce, setNewSessionNonce] = useState(0);
  const [connection, setConnection] = useState<DaemonConnectionState>({
    status: sessionContextResolutionError
      ? 'error'
      : autoConnect
        ? 'connecting'
        : 'idle',
    ...(initialRestoreSessionId ? { sessionId: initialRestoreSessionId } : {}),
    ...(resolvedSessionContext
      ? { sessionContext: resolvedSessionContext }
      : {}),
    ...(resolvedWorkspaceCwd ? { workspaceCwd: resolvedWorkspaceCwd } : {}),
    ...(sessionContextResolutionError
      ? { error: sessionContextResolutionError }
      : {}),
  });
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const initialClientIdDependencyRef = useRef(clientId);
  const knownCapabilities =
    workspace?.capabilities ??
    sessionCapabilitiesRef.current ??
    connection.capabilities;
  const legacyClientIdDependency =
    knownCapabilities &&
    !knownCapabilities.features.includes(CLIENT_IDENTITY_FEATURE)
      ? clientId
      : initialClientIdDependencyRef.current;
  if (
    knownCapabilities &&
    !knownCapabilities.features.includes(CLIENT_IDENTITY_FEATURE) &&
    legacyClientIdDependency
  ) {
    clientIdRef.current = getStableClientId(legacyClientIdDependency);
  }
  const setConnectionSynchronous = useCallback(
    (update: SetStateAction<DaemonConnectionState>) => {
      const next =
        typeof update === 'function' ? update(connectionRef.current) : update;
      connectionRef.current = next;
      setConnection(update);
    },
    [],
  );
  useEffect(() => {
    if (!workspace?.capabilities) return;
    setConnection((current) =>
      current.capabilities === workspace.capabilities
        ? current
        : { ...current, capabilities: workspace.capabilities },
    );
  }, [workspace?.capabilities]);
  const noticeIdRef = useRef(0);
  const [notices, setNotices] = useState<DaemonSessionNotice[]>([]);
  const addNotice = useCallback<AddDaemonSessionNotice>((input) => {
    const notice: DaemonSessionNotice = {
      ...input,
      id: input.id ?? `daemon-notice-${Date.now()}-${++noticeIdRef.current}`,
      createdAt: input.createdAt ?? Date.now(),
    };
    setNotices((current) =>
      current.some((existing) => existing.id === notice.id)
        ? current
        : [...current.slice(-49), notice],
    );
    return notice;
  }, []);
  const dismissNotice = useCallback((id: string) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);
  const clearNotices = useCallback(() => {
    setNotices([]);
  }, []);
  const noticesValue = useMemo<SessionNoticesValue>(
    () => ({
      notices,
      dismissNotice,
      clearNotices,
    }),
    [clearNotices, dismissNotice, notices],
  );
  const [workspaceEventSignals, setWorkspaceEventSignals] =
    useState<DaemonWorkspaceEventSignals>(INITIAL_WORKSPACE_EVENT_SIGNALS);
  const hasCurrentSessionActivePromptRef = useRef<() => boolean>(() => false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      liveJournalRepairRef.current?.controller?.abort();
      liveJournalRepairRef.current = undefined;
      tryLiveJournalRepairRef.current = undefined;
    };
  }, []);

  const sessionEffectContext = restoreSessionContext ?? resolvedSessionContext;

  useEffect(() => {
    if (!autoConnect) return undefined;
    if (sessionContextResolutionError) {
      setConnectionSynchronous((current) => ({
        ...current,
        status: 'error',
        error: sessionContextResolutionError,
      }));
      return undefined;
    }
    if (sessionEffectContext) {
      activeSessionContextRef.current = sessionEffectContext;
    }
    if (!workspaceClientRef.current && !resolvedBaseUrl) {
      setConnection({
        status: 'error',
        error:
          'DaemonSessionProvider requires a baseUrl prop or an ancestor DaemonWorkspaceProvider.',
      });
      return undefined;
    }
    const abort = new AbortController();
    let disposed = false;
    const preservingTranscriptDuringLoad =
      restoreMode === 'load' &&
      restoreSessionId !== undefined &&
      restoreSessionId === sessionRef.current?.sessionId &&
      sessionRef.current === skipNextCleanupDetachSessionRef.current;
    const effectPendingSessionLoad = pendingSessionLoadRef.current;
    let runnerSession = sessionRef.current;

    // ── Batched transcript dispatch ────────────────────────────────
    // The live SSE loop dispatches transcript events through this batcher
    // instead of one `store.dispatch` per event. Each dispatch costs O(B) in
    // the reducer (block-array copy in `takeBlocksOwnership` + freeze), so a
    // burst of E buffered events draining at once — e.g. the stream catching
    // up when the tab returns from being hidden — is O(E×B) and can freeze the
    // main thread for minutes on a large transcript. Coalescing into one
    // dispatch per macrotask makes a burst O(B) once.
    //
    // The flush MUST be a macrotask (setTimeout), not a microtask: `for await`
    // drains already-buffered events back-to-back via microtasks, so a
    // microtask flush would run between every event and never coalesce. A
    // macrotask only runs once the generator blocks on a genuinely new network
    // event. Holding the batch for one frame also coalesces steady streaming:
    // copying a 50k-block immutable snapshot once per token otherwise consumes
    // the main thread before the render throttle can help. Control and terminal
    // paths call flushTranscriptSync below, so ordering and completion are not
    // delayed by the window.
    let pendingTranscriptEvents: DaemonUiEvent[] = [];
    let transcriptFlushTimer: ReturnType<typeof setTimeout> | undefined;
    const runTranscriptFlush = (force = false) => {
      transcriptFlushTimer = undefined;
      if (pendingTranscriptEvents.length === 0) return;
      if (
        !force &&
        runnerSession !== undefined &&
        sessionRef.current !== runnerSession
      ) {
        pendingTranscriptEvents = [];
        return;
      }
      const batch = pendingTranscriptEvents;
      pendingTranscriptEvents = [];
      // Swallow a reducer throw (log it) so it cannot escape as an uncaught
      // timer error or — via flushTranscriptSync — abort the catch block's
      // error recovery and the unmount cleanup.
      try {
        store.dispatch(batch);
      } catch (error) {
        console.error(
          '[DaemonSessionProvider] batched transcript dispatch failed',
          { eventCount: batch.length, error },
        );
      }
    };
    const cancelTranscriptFlush = () => {
      if (transcriptFlushTimer === undefined) return;
      clearTimeout(transcriptFlushTimer);
      transcriptFlushTimer = undefined;
    };
    const enqueueTranscriptEvents = (events: DaemonUiEvent[]) => {
      if (events.length === 0) return;
      for (const event of events) pendingTranscriptEvents.push(event);
      if (transcriptFlushTimer === undefined) {
        transcriptFlushTimer = setTimeout(
          runTranscriptFlush,
          TRANSCRIPT_DISPATCH_BATCH_MS,
        );
      }
    };
    // Apply buffered transcript events immediately. Called before any control
    // interaction that reads the store or dispatches a control event, so the
    // buffered content stays correctly ordered ahead of it.
    const flushTranscriptSync = () => {
      cancelTranscriptFlush();
      runTranscriptFlush(true);
    };
    const dispatchTranscriptNow = (events: DaemonUiEvent | DaemonUiEvent[]) => {
      flushTranscriptSync();
      store.dispatch(events);
    };
    // Drop buffered events. Used before `store.reset()`: pending events belong
    // to the epoch the reset is discarding, so flushing them would be wrong.
    const clearPendingTranscriptEvents = () => {
      cancelTranscriptFlush();
      pendingTranscriptEvents = [];
    };
    const tryLiveJournalRepair = () => {
      if (disposed || abort.signal.aborted) return;
      const repair = liveJournalRepairRef.current;
      if (
        !repair ||
        repair.attempted ||
        !repair.terminalSeen ||
        pendingSessionLoadRef.current ||
        transcriptHistoryRef.current.loading ||
        sessionRef.current?.sessionId !== repair.sessionId ||
        hasCurrentSessionActivePromptRef.current()
      ) {
        return;
      }
      const reload = repairReloadRef.current;
      if (!reload) return;
      repair.attempted = true;
      const controller = new AbortController();
      repair.controller = controller;
      void reload(controller.signal, { replaySource: 'memory' }).catch(
        (error: unknown) => {
          if (liveJournalRepairRef.current !== repair) return;
          addNotice({
            id: `daemon.live_journal_repair.failed:${repair.target.signature}`,
            severity: 'warning',
            category: 'connection',
            operation: 'load_session',
            code: 'daemon.live_journal_repair.failed',
            message:
              'Could not restore the complete turn. The retained replay remains visible.',
            debugMessage:
              error instanceof Error ? error.message : String(error),
            recoverable: true,
          });
          liveJournalRepairRef.current = undefined;
        },
      );
    };
    tryLiveJournalRepairRef.current = tryLiveJournalRepair;

    const run = async () => {
      const client =
        workspaceClientRef.current ??
        new DaemonClient({ baseUrl: resolvedBaseUrl!, token: resolvedToken });
      let session: DaemonSessionClient | undefined;
      let capabilities:
        | Awaited<ReturnType<DaemonClient['capabilities']>>
        | undefined;
      let reconnectSessionId = restoreSessionId;
      let shouldCreateFreshSession =
        !manualSessionClearRef.current &&
        !restoreSessionId &&
        newSessionNonce > 0;
      let reconnectAttempt = 0;
      let nextSseConnectReason: DaemonSseConnectReason | undefined;
      let skipMetadataRefresh = false;
      let standaloneCreateAttempted = false;
      let productContextFailure = false;
      let hasCurrentSessionActivePrompt = () => false;
      if (
        !restoreSessionId &&
        !reconnectSessionId &&
        !shouldCreateFreshSession &&
        (connectionRef.current.standaloneSession?.creationRecovery ||
          (manualSessionClearRef.current &&
            connectionRef.current.status === 'error'))
      ) {
        return;
      }
      // Set when the user explicitly deletes the session (server
      // publishes session_closed with reason 'client_close').
      // Reconnecting would auto-create a new session, undoing the
      // user's delete. Other session_closed reasons (idle_timeout,
      // last_client_detached) fall through to normal reconnect.
      let userDeletedSession = false;

      while (!disposed && !abort.signal.aborted) {
        const skipMetadataRefreshThisIteration = skipMetadataRefresh;
        skipMetadataRefresh = false;
        let loadingRequestedSession = false;
        let eventStream:
          | {
              sessionId: string;
              controller: AbortController;
              restartRequested: boolean;
            }
          | undefined;
        let removeProviderAbortListener: (() => void) | undefined;
        const clearEventStream = () => {
          removeProviderAbortListener?.();
          removeProviderAbortListener = undefined;
          if (eventStreamRef.current === eventStream) {
            eventStreamRef.current = undefined;
          }
        };
        try {
          // ── SSE Reconnection Strategy ────────────────────────────────
          //
          // Two reconnection paths depending on whether `session` survived
          // the previous iteration's error handler:
          //
          // PATH A — Incremental (session preserved, retriable errors):
          //   `session` is non-null → skip this entire `if (!session)` block
          //   → go straight to `activeSession.events()` which sends
          //   `Last-Event-ID` → daemon serves only missed events →
          //   store.dispatch() appends to existing blocks. No reset, no
          //   load(), minimal re-render.
          //
          // PATH B — Snapshot reload (session cleared, terminal/auth errors,
          //   ring eviction):
          //   `session` is null → enter this block → DaemonSessionClient
          //   .load() fetches compactedReplay + liveJournal → deferred
          //   store.reset() + store.dispatch(replayEvents) rebuilds the
          //   current bounded replay window in a single synchronous batch.
          //
          // The `needsStoreReset` flag defers store.reset() to avoid an
          // intermediate empty-blocks state that causes virtualizer
          // removeChild errors (see replay injection section below).
          // ─────────────────────────────────────────────────────────────
          let isSameSessionReconnect = false;
          let shouldInjectReplaySnapshot = false;
          let needsStoreReset = false;
          let attachedExistingSession = false;
          // Only populated when this attempt (re)loads the session: a reused
          // session object carries the snapshot from its original load, whose
          // usage may be older than the in-memory count.
          let replayTokenUsage: DaemonConnectionState['tokenUsage'];
          let replayTokenCount: number | undefined;
          let repairingEpisode: LiveJournalRepairEpisode | undefined;
          let repairSuffix: LiveJournalRepairSuffix | undefined;
          if (!session) {
            const existingSession = sessionRef.current;
            const reusingContextErrorSession =
              existingSession !== undefined &&
              existingSession === contextErrorPreservedSessionRef.current &&
              restoreSessionId === existingSession.sessionId &&
              sessionContextKey(sessionEffectContext) ===
                sessionContextKey(
                  contextErrorPreservedProductContextRef.current,
                );
            if (
              existingSession &&
              ((!restoreSessionId &&
                !reconnectSessionId &&
                !shouldCreateFreshSession) ||
                reusingContextErrorSession)
            ) {
              session = existingSession;
              reconnectSessionId = existingSession.sessionId;
              lastSessionIdRef.current = existingSession.sessionId;
              attachedExistingSession = true;
              if (reusingContextErrorSession) {
                contextErrorPreservedSessionRef.current = undefined;
                contextErrorPreservedProductContextRef.current = undefined;
              }
            }
          }
          if (!session) {
            if (!preservingTranscriptDuringLoad) {
              setConnection((current) => ({
                ...current,
                status: 'connecting',
                error: undefined,
                errorStatus: resolveConnectionErrorStatus(
                  undefined,
                  current.errorStatus,
                ),
              }));
            }
            const getWorkspaceCapabilities =
              workspaceGetCapabilitiesRef.current;
            const caps =
              workspaceCapabilitiesRef.current ??
              (getWorkspaceCapabilities
                ? await getWorkspaceCapabilities()
                : await client.capabilities());
            if (disposed || abort.signal.aborted) return;
            capabilities = caps;
            sessionCapabilitiesRef.current = caps;
            const historyPaginationSupported =
              Array.isArray(caps.features) &&
              caps.features.includes(SESSION_TRANSCRIPT_PAGINATION_FEATURE);
            heartbeatSupportedRef.current =
              Array.isArray(caps.features) &&
              caps.features.includes('client_heartbeat');
            const legacyWorkspaceCwd =
              resolvedWorkspaceCwdRef.current ?? caps.workspaceCwd;
            const effectSessionContext =
              restoreSessionContext ??
              resolvedSessionContextRef.current ??
              (legacyWorkspaceCwd
                ? {
                    kind: 'workspace' as const,
                    cwd: legacyWorkspaceCwd,
                  }
                : undefined);
            let effectWorkspaceCwd: string | undefined;
            if (effectSessionContext?.kind === 'workspace') {
              effectWorkspaceCwd = effectSessionContext.cwd;
            } else if (effectSessionContext?.kind === 'live') {
              try {
                effectWorkspaceCwd = resolveLiveSessionWorkspaceCwd(caps);
              } catch (error) {
                productContextFailure = true;
                throw error;
              }
            }
            const workspaceScoped =
              effectSessionContext?.kind === 'workspace' ||
              effectSessionContext === undefined;
            activeSessionContextRef.current = effectSessionContext;
            activeWorkspaceCwdRef.current = effectWorkspaceCwd;
            const capabilityFeatures = Array.isArray(caps.features)
              ? caps.features
              : [];
            const canPreheatPrimaryWorkspace =
              workspaceScoped &&
              effectWorkspaceCwd === caps.workspaceCwd &&
              capabilityFeatures.includes(WORKSPACE_ACP_PREHEAT_FEATURE);
            const canReadPrimaryAcpStatus =
              canPreheatPrimaryWorkspace &&
              capabilityFeatures.includes(WORKSPACE_ACP_STATUS_FEATURE);
            const canUseSkillsConfigRuntime =
              workspaceScoped &&
              effectWorkspaceCwd !== undefined &&
              capabilityFeatures.includes(
                WORKSPACE_SKILLS_CONFIG_RUNTIME_FEATURE,
              );
            const skillsRuntimeClient =
              canUseSkillsConfigRuntime && effectWorkspaceCwd
                ? client.workspaceByCwd(effectWorkspaceCwd)
                : undefined;
            if (
              (shouldDeferInitialSessionCreation ||
                manualSessionClearRef.current) &&
              !restoreSessionId &&
              !reconnectSessionId &&
              !shouldCreateFreshSession
            ) {
              if (!workspaceScoped) {
                let standaloneOptions:
                  | DaemonStandaloneSessionOptions
                  | undefined;
                if (
                  effectSessionContext?.kind === 'standalone' &&
                  capabilityFeatures.includes(
                    STANDALONE_SESSION_OPTIONS_CAPABILITY,
                  )
                ) {
                  try {
                    standaloneOptions =
                      await client.getStandaloneSessionOptions();
                  } catch (error) {
                    console.warn(
                      '[DaemonSessionProvider] standalone session options failed in deferred connect:',
                      error,
                    );
                  }
                }
                if (disposed || abort.signal.aborted) return;
                const providerModelStatus =
                  mapProviderStatus(standaloneOptions);
                // The options request can outlive a first-prompt create: the
                // composer does not block while this branch is still
                // connecting, so the session may already be attached by the
                // time the response lands. Never publish over it.
                setConnection((current) =>
                  current.status === 'error' || current.sessionId
                    ? current
                    : {
                        ...clearNonWorkspaceSessionState(current),
                        status: 'connected',
                        sessionContext: effectSessionContext,
                        workspaceCwd: undefined,
                        standaloneSession: undefined,
                        gitBranch: undefined,
                        gitStatus: undefined,
                        commands: undefined,
                        skills: undefined,
                        models: standaloneOptions
                          ? providerModelStatus.models
                          : undefined,
                        currentModel: providerModelStatus.currentModel,
                        currentMode: providerModelStatus.currentMode,
                        contextWindow: providerModelStatus.contextWindow,
                        providers: undefined,
                        capabilities: caps,
                        error: undefined,
                        errorStatus: undefined,
                      },
                );
                return;
              }
              // Fetch skills alongside providers so skill-backed slash
              // commands (e.g. /review) can autocomplete before the first
              // prompt. Both are session-less workspace queries; the
              // session-scoped supported-commands snapshot (which also carries
              // custom/MCP/workflow commands) still lands once the first prompt
              // creates a session.
              const [providerResult, skillsResult, acpStatusResult, gitResult] =
                await Promise.allSettled([
                  client.workspaceProviders(),
                  skillsRuntimeClient
                    ? skillsRuntimeClient.workspaceConfigSkills()
                    : client.workspaceSkills(),
                  !canUseSkillsConfigRuntime && canReadPrimaryAcpStatus
                    ? client.workspaceAcpStatus()
                    : Promise.resolve(undefined),
                  effectWorkspaceCwd
                    ? client.workspaceByCwd(effectWorkspaceCwd).workspaceGit()
                    : client.workspaceGit(),
                ]);
              if (providerResult.status === 'rejected') {
                console.warn(
                  '[DaemonSessionProvider] workspaceProviders failed in deferred connect:',
                  providerResult.reason,
                );
              }
              if (skillsResult.status === 'rejected') {
                console.warn(
                  '[DaemonSessionProvider] workspaceSkills failed in deferred connect:',
                  skillsResult.reason,
                );
              }
              if (
                canReadPrimaryAcpStatus &&
                acpStatusResult.status === 'rejected'
              ) {
                console.warn(
                  '[DaemonSessionProvider] workspaceAcpStatus failed in deferred connect:',
                  acpStatusResult.reason,
                );
              }
              const providers =
                providerResult.status === 'fulfilled'
                  ? providerResult.value
                  : undefined;
              const providerModelStatus = mapProviderStatus(providers);
              const {
                commands: deferredSkillCommands,
                skills: deferredSkills,
              } = mapWorkspaceSkills(
                skillsResult.status === 'fulfilled'
                  ? skillsResult.value
                  : undefined,
              );
              const preserveClearedSessionCommands =
                skillsResult.status === 'rejected' ||
                (manualSessionClearRef.current &&
                  deferredSkillCommands.length === 0);
              setConnection((current) => ({
                ...current,
                status: 'connected',
                sessionContext: effectSessionContext,
                workspaceCwd: effectWorkspaceCwd,
                standaloneSession: undefined,
                gitBranch:
                  gitResult.status === 'fulfilled'
                    ? (gitResult.value.branch ?? undefined)
                    : undefined,
                models: providerModelStatus.models,
                currentModel: providerModelStatus.currentModel,
                currentMode: providerModelStatus.currentMode,
                contextWindow: providerModelStatus.contextWindow,
                providers,
                capabilities: caps,
                commands: preserveClearedSessionCommands
                  ? current.commands
                  : deferredSkillCommands,
                skills: preserveClearedSessionCommands
                  ? current.skills
                  : deferredSkills,
              }));
              if (skillsRuntimeClient) {
                void (async () => {
                  try {
                    const runtime = await skillsRuntimeClient.ensureRuntime();
                    const refreshed = await loadReadyWorkspaceSkills(
                      skillsRuntimeClient,
                      runtime,
                      () =>
                        disposed ||
                        abort.signal.aborted ||
                        connectionRef.current.sessionId !== undefined,
                    );
                    if (!refreshed) return;
                    const { commands, skills: refreshedSkills } =
                      mapWorkspaceSkills(refreshed);
                    setConnection((current) =>
                      current.sessionId
                        ? current
                        : { ...current, commands, skills: refreshedSkills },
                    );
                  } catch (error) {
                    console.warn(
                      '[DaemonSessionProvider] workspace Skills runtime preparation failed:',
                      error,
                    );
                  }
                })();
              } else if (
                canPreheatPrimaryWorkspace &&
                !(
                  acpStatusResult.status === 'fulfilled' &&
                  acpStatusResult.value?.channelLive === true
                ) &&
                !workspaceAcpPreheatInFlightRef.current
              ) {
                workspaceAcpPreheatInFlightRef.current = true;
                void (async () => {
                  try {
                    const preheat = await client.workspaceAcpPreheat(5_000);
                    if (
                      disposed ||
                      abort.signal.aborted ||
                      !preheat.ready ||
                      connectionRef.current.sessionId
                    ) {
                      return;
                    }
                    const refreshed = await client.workspaceSkills();
                    if (
                      disposed ||
                      abort.signal.aborted ||
                      connectionRef.current.sessionId
                    ) {
                      return;
                    }
                    const { commands, skills } = mapWorkspaceSkills(refreshed);
                    setConnection((current) =>
                      current.sessionId
                        ? current
                        : { ...current, commands, skills },
                    );
                  } catch (error) {
                    console.warn(
                      '[DaemonSessionProvider] ACP preheat for workspace skills failed:',
                      error,
                    );
                  } finally {
                    workspaceAcpPreheatInFlightRef.current = false;
                  }
                })();
              }
              return;
            }
            const targetSessionId = restoreSessionId ?? reconnectSessionId;
            const requestClientId = legacyClientIdDependency
              ? clientIdRef.current
              : getStableClientId(undefined, targetSessionId);
            const legacyClientRebind =
              targetSessionId !== undefined &&
              targetSessionId === connectionRef.current.sessionId &&
              connectionRef.current.clientId !== undefined &&
              requestClientId !== connectionRef.current.clientId;
            const shouldResumeRequestedSession =
              Boolean(restoreSessionId) &&
              restoreMode === 'resume' &&
              !legacyClientRebind;
            loadingRequestedSession = Boolean(restoreSessionId);
            if (targetSessionId && !preservingTranscriptDuringLoad) {
              setConnection((current) => ({
                ...current,
                sessionId: targetSessionId,
                error: undefined,
                errorStatus: undefined,
                missingSession: false,
                loadingTranscript: true,
              }));
            }
            const currentPendingLoad = pendingSessionLoadRef.current;
            const attemptedLoad =
              currentPendingLoad !== undefined &&
              currentPendingLoad.sessionId === targetSessionId &&
              restoreSessionContextMatches(
                currentPendingLoad.sessionContext,
                effectSessionContext,
              )
                ? currentPendingLoad
                : undefined;
            const restoreRequestTimeoutMs =
              attemptedLoad?.requestTimeoutMs ??
              resolveSessionRestoreTimeouts(capabilities).requestTimeoutMs;
            const restoreRequest = {
              timeoutMs: restoreRequestTimeoutMs,
              ...(!shouldResumeRequestedSession &&
              subagentTranscriptModeRef.current === 'summary'
                ? { liveReplayMode: 'summary' as const }
                : {}),
              ...(historyPaginationSupported &&
              (!restoreSessionId || restoreMode === 'load') &&
              attemptedLoad?.replaySource !== 'memory' &&
              historyPageSizeRef.current !== undefined
                ? { historyPageSize: historyPageSizeRef.current }
                : {}),
            };
            let nextSession: DaemonSessionClient;
            if (restoreSessionId) {
              if (effectSessionContext?.kind === 'standalone') {
                nextSession = shouldResumeRequestedSession
                  ? await DaemonSessionClient.resumeStandalone(
                      client,
                      restoreSessionId,
                      restoreRequest,
                      requestClientId,
                    )
                  : await DaemonSessionClient.loadStandalone(
                      client,
                      restoreSessionId,
                      restoreRequest,
                      requestClientId,
                    );
              } else {
                nextSession = shouldResumeRequestedSession
                  ? await DaemonSessionClient.resume(
                      client,
                      restoreSessionId,
                      {
                        ...restoreRequest,
                        workspaceCwd: effectWorkspaceCwd,
                      },
                      requestClientId,
                    )
                  : await DaemonSessionClient.load(
                      client,
                      restoreSessionId,
                      {
                        ...restoreRequest,
                        workspaceCwd: effectWorkspaceCwd,
                      },
                      requestClientId,
                    );
              }
            } else if (reconnectSessionId) {
              nextSession =
                effectSessionContext?.kind === 'standalone'
                  ? await DaemonSessionClient.loadStandalone(
                      client,
                      reconnectSessionId,
                      restoreRequest,
                      requestClientId,
                    )
                  : await DaemonSessionClient.load(
                      client,
                      reconnectSessionId,
                      {
                        ...restoreRequest,
                        workspaceCwd: effectWorkspaceCwd,
                      },
                      requestClientId,
                    );
            } else if (effectSessionContext?.kind === 'standalone') {
              standaloneCreateAttempted = true;
              nextSession = await DaemonSessionClient.createStandalone(client, {
                ...(modelServiceId !== undefined ? { modelServiceId } : {}),
                ...(createSessionRequestRef.current?.approvalMode !== undefined
                  ? {
                      approvalMode: resolveStandaloneApprovalMode(
                        createSessionRequestRef.current.approvalMode,
                      ),
                    }
                  : {}),
              });
              standaloneCreateAttempted = false;
            } else {
              if (effectSessionContext?.kind === 'live') {
                productContextFailure = true;
                throw new Error('Live session context does not support create');
              }
              nextSession = await DaemonSessionClient.createOrAttach(
                client,
                {
                  ...(modelServiceId !== undefined ? { modelServiceId } : {}),
                  ...(shouldCreateFreshSession
                    ? { sessionScope: 'thread' as const }
                    : sessionScope !== undefined
                      ? { sessionScope }
                      : {}),
                  workspaceCwd: effectWorkspaceCwd,
                },
                requestClientId,
              );
            }
            loadingRequestedSession = false;
            if (!legacyClientIdDependency && nextSession.clientId) {
              clientIdRef.current = nextSession.clientId;
              persistStableClientId(
                nextSession.clientId,
                nextSession.sessionId,
              );
            }
            if (disposed || abort.signal.aborted) {
              void detachDaemonClient({
                baseUrl: resolvedBaseUrl!,
                token: resolvedToken,
                sessionId: nextSession.sessionId,
                clientId: nextSession.clientId,
              }).catch((err) =>
                console.warn('[DaemonSessionProvider] detach failed:', err),
              );
              return;
            }
            // A tail refresh may finish after the reader leaves the bottom or
            // after its action times out. Undo that new attachment and keep the
            // old session rather than committing a now-unwanted snapshot.
            if (
              preservingTranscriptDuringLoad &&
              attemptedLoad?.sessionId === nextSession.sessionId &&
              (attemptedLoad.signal?.aborted ||
                pendingSessionLoadRef.current !== attemptedLoad)
            ) {
              const previousSession = sessionRef.current;
              if (nextSession !== previousSession) {
                await nextSession.detach().catch((error: unknown) => {
                  console.warn(
                    '[DaemonSessionProvider] detach cancelled reload failed:',
                    error,
                  );
                });
              }
              if (pendingSessionLoadRef.current === attemptedLoad) {
                pendingSessionLoadRef.current = undefined;
                if (attemptedLoad.timeout !== undefined) {
                  clearTimeout(attemptedLoad.timeout);
                }
                attemptedLoad.reject(
                  new DOMException('Session load cancelled', 'AbortError'),
                );
              }
              if (skipNextCleanupDetachSessionRef.current === previousSession) {
                skipNextCleanupDetachSessionRef.current = undefined;
              }
              loadingRequestedSession = false;
              if (previousSession?.sessionId === nextSession.sessionId) {
                session = previousSession;
                reconnectSessionId = previousSession.sessionId;
                reconnectAttempt = 0;
                skipMetadataRefresh = true;
                continue;
              }
              return;
            }
            if (attemptedLoad?.replaySource === 'memory') {
              const episode = liveJournalRepairRef.current;
              const freshReplayEvents = [
                ...nextSession.replaySnapshot.compactedReplay,
                ...nextSession.replaySnapshot.liveJournal,
              ];
              const suffix = episode
                ? findLiveJournalRepairSuffix(
                    freshReplayEvents,
                    episode.target.promptId,
                  )
                : undefined;
              if (
                !episode ||
                episode.sessionId !== nextSession.sessionId ||
                nextSession.replayDegraded === true ||
                !suffix
              ) {
                const previousSession = sessionRef.current;
                if (nextSession !== previousSession) {
                  await nextSession.detach().catch((error: unknown) => {
                    console.warn(
                      '[DaemonSessionProvider] detach rejected repair load failed:',
                      error,
                    );
                  });
                }
                if (pendingSessionLoadRef.current === attemptedLoad) {
                  pendingSessionLoadRef.current = undefined;
                  if (attemptedLoad.timeout !== undefined) {
                    clearTimeout(attemptedLoad.timeout);
                  }
                  attemptedLoad.reject(
                    new Error(
                      nextSession.replayDegraded === true
                        ? 'Fresh replay is degraded'
                        : 'Fresh replay does not contain the complete target turn',
                    ),
                  );
                }
                if (
                  skipNextCleanupDetachSessionRef.current === previousSession
                ) {
                  skipNextCleanupDetachSessionRef.current = undefined;
                }
                if (previousSession?.sessionId === nextSession.sessionId) {
                  session = previousSession;
                  reconnectSessionId = previousSession.sessionId;
                  reconnectAttempt = 0;
                  skipMetadataRefresh = true;
                  continue;
                }
                return;
              }
              repairingEpisode = episode;
              repairSuffix = suffix;
            }
            const previousSessionId = lastSessionIdRef.current;
            if (previousSessionId !== nextSession.sessionId) {
              clearNotices();
            }
            // Defer store.reset() until right before replay dispatch
            // (after the await below) so that reset + dispatch share a
            // single queueMicrotask notification. Without deferral, the
            // microtask fires during the await and React sees an
            // intermediate empty-blocks state, which causes removeChild
            // errors in the virtualizer.
            if (
              previousSessionId !== undefined &&
              nextSession.sessionId !== previousSessionId
            ) {
              setPromptStatus('idle');
              clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
              needsStoreReset = true;
            } else if (previousSessionId !== undefined) {
              const replaySnapshotEventCount =
                nextSession.replaySnapshot.compactedReplay.length +
                nextSession.replaySnapshot.liveJournal.length;
              if (replaySnapshotEventCount > 0) {
                setPromptStatus('idle');
                clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                needsStoreReset = true;
              } else {
                store.dispatch({
                  type: 'assistant.done',
                  reason: 'reconnected',
                });
                if (store.getSnapshot().awaitingResync) {
                  store.clearAwaitingResync();
                }
              }
            }
            isSameSessionReconnect =
              previousSessionId !== undefined &&
              previousSessionId === nextSession.sessionId;
            shouldInjectReplaySnapshot =
              nextSession.replaySnapshot.compactedReplay.length > 0 ||
              nextSession.replaySnapshot.liveJournal.length > 0;
            const replayEvents = [
              ...nextSession.replaySnapshot.compactedReplay,
              ...nextSession.replaySnapshot.liveJournal,
            ];
            replayTokenUsage = getReplayTokenUsage(replayEvents);
            replayTokenCount = getTokenCountFromUsage(replayTokenUsage);
            session = nextSession;
            reconnectSessionId = session.sessionId;
            shouldCreateFreshSession = false;
            lastSessionIdRef.current = session.sessionId;
            sessionRef.current = session;
          }

          const activeSession = session;
          const activeStandaloneState = getStandaloneConnectionState(
            activeSession.session,
          );
          const activeProductSessionContext =
            activeStandaloneState !== undefined ||
            activeSessionContextRef.current?.kind === 'standalone'
              ? ({ kind: 'standalone' } as const)
              : activeSessionContextRef.current?.kind === 'live'
                ? activeSessionContextRef.current
                : {
                    kind: 'workspace' as const,
                    cwd: activeSession.workspaceCwd,
                  };
          const activeWorkspaceScoped =
            activeProductSessionContext.kind === 'workspace';
          runnerSession = activeSession;
          // Prompt activity is session state returned by /load. Surface it
          // immediately so a refreshed page shows the running state without
          // waiting for auxiliary data such as providers, commands, or context.
          //
          // `activePromptsRef` only tracks prompts submitted by this browser
          // instance. After a page refresh, `/load` can attach to a daemon
          // session whose prompt is still running, but there is no local
          // controller/promise to put in `activePromptsRef`. Keep that restored
          // live state separately so `session.replay_complete` (history caught
          // up) does not get mistaken for `turn_complete` (prompt finished).
          const restoredActivePromptSettled =
            settledRestoredActivePromptSessionsRef.current.has(activeSession);
          let restoredActivePrompt =
            activeSession.hasActivePrompt === true &&
            !restoredActivePromptSettled;
          const settleRestoredActivePrompt = () => {
            // `hasActivePrompt` is a load/resume snapshot on this session client.
            // Once a terminal event consumes it, keep it consumed across SSE
            // reconnects for the same client; later prompts from this page are
            // still tracked independently in activePromptsRef.
            settledRestoredActivePromptSessionsRef.current.add(activeSession);
            restoredActivePrompt = false;
          };
          const hasSessionActivePrompt = () =>
            restoredActivePrompt ||
            activePromptsRef.current.has(activeSession.sessionId) ||
            activePromptsRef.current.has(`${activeSession.sessionId}:shell`);
          hasCurrentSessionActivePrompt = hasSessionActivePrompt;
          hasCurrentSessionActivePromptRef.current = hasSessionActivePrompt;
          setPromptStatus(hasSessionActivePrompt() ? 'streaming' : 'idle');

          const pendingLoad = pendingSessionLoadRef.current;
          const pendingLoadToResolve =
            pendingLoad?.sessionId === activeSession.sessionId &&
            restoreSessionContextMatches(
              pendingLoad.sessionContext,
              activeSessionContextRef.current,
            )
              ? pendingLoad
              : undefined;
          activeSessionContextRef.current = activeProductSessionContext;

          // Feed replay snapshot (compacted history + live journal) into
          // the store before starting the SSE loop. The SSE stream begins
          // from lastEventId, so only post-snapshot events are delivered.
          //
          // This runs before the providers/commands/context fetches below:
          // the snapshot is already in hand, so the transcript paints one
          // metadata round-trip earlier (visible on high-latency mobile).
          //
          // The deferred store.reset() runs here — in the same synchronous
          // block as store.dispatch() — so the queueMicrotask notification
          // only fires once with the fully-populated state.
          const { compactedReplay, liveJournal } = activeSession.replaySnapshot;
          const replayEvents = [...compactedReplay, ...liveJournal];
          const markerStillVisible =
            repairingEpisode?.markerBlockId !== undefined &&
            store
              .getSnapshot()
              .blocks.some(
                (block) => block.id === repairingEpisode?.markerBlockId,
              );
          // Prefer a recordId carried by an actual `session_update` in the
          // retained window; fall back to the `history_truncated` marker's
          // stamped anchor only when no session_update has one. The marker
          // sits at position 0, so a single `.find()` would let its (more
          // recent) anchor win over earlier session_update recordIds still
          // in the window, causing `beforeRecordId` to re-fetch records
          // the client already displays. Last resort: the daemon's
          // `historyAnchorRecordId` — the latest recordId it read from the
          // persisted transcript — which covers live sessions whose
          // in-flight turn capped the journal before any turn boundary
          // (no recordId anywhere in the retained window or marker).
          const firstPersistedRecordId =
            replayEvents
              .filter((e) => e.type === 'session_update')
              .map(getPersistedReplayRecordId)
              .find((recordId): recordId is string => recordId !== undefined) ??
            replayEvents
              .filter((e) => e.type === 'history_truncated')
              .map(getPersistedReplayRecordId)
              .find((recordId): recordId is string => recordId !== undefined) ??
            activeSession.historyAnchorRecordId;
          const replayHistoryWasTruncated = replayEvents.some(
            hasFullTranscriptBeforeReplay,
          );
          const historyHasMore = repairingEpisode
            ? transcriptHistoryRef.current.hasMore
            : Array.isArray(capabilities?.features) &&
              capabilities.features.includes(
                SESSION_TRANSCRIPT_PAGINATION_FEATURE,
              ) &&
              (activeSession.historyHasMore || replayHistoryWasTruncated) &&
              firstPersistedRecordId !== undefined;
          const replayInjected =
            shouldInjectReplaySnapshot && replayEvents.length > 0;
          // After the snapshot is consumed the replay-derived inputs above
          // (firstPersistedRecordId, replayHistoryWasTruncated) recompute
          // empty on delta-resume reconnects; keep the history state that
          // the original injection initialized instead of clobbering it.
          if (
            !repairingEpisode &&
            (replayInjected ||
              transcriptHistoryRef.current.sessionId !==
                activeSession.sessionId)
          ) {
            transcriptHistoryRef.current = {
              sessionId: activeSession.sessionId,
              ...(firstPersistedRecordId !== undefined
                ? { beforeRecordId: firstPersistedRecordId }
                : {}),
              hasMore: historyHasMore,
              loading: false,
              capacityReached: false,
              paginationError: false,
            };
            setTranscriptHistoryState({
              hasMore: historyHasMore,
              loading: false,
              capacityReached: false,
              paginationError: false,
            });
          } else if (
            repairingEpisode &&
            !markerStillVisible &&
            firstPersistedRecordId !== undefined
          ) {
            transcriptHistoryRef.current.beforeRecordId =
              firstPersistedRecordId;
            transcriptHistoryRef.current.cursor = undefined;
          }
          if (needsStoreReset && !replayInjected) {
            // Reset needed but no replay data (e.g. fresh session) — reset
            // immediately since there is no dispatch to batch with.
            store.reset();
          }
          if (replayInjected) {
            const replayOpts = {
              ...eventOptionsRef.current,
              suppressOwnUserEcho: false,
            };
            const sourceEvents =
              repairingEpisode && repairSuffix && markerStillVisible
                ? repairSuffix.events
                : replayEvents;
            const replayTarget = findLiveJournalRepairTarget(
              activeSession.sessionId,
              liveJournal,
              activeSession.lastEventId,
              activeSession.replayDegraded,
            );
            const markerIndex = replayTarget
              ? sourceEvents.indexOf(replayTarget.marker)
              : -1;
            const eventGroups: Array<{
              transcript: DaemonUiEvent[];
              sideEffects: DaemonUiEvent[];
            }> = [];
            for (const replayEvent of sourceEvents) {
              const isNewRepairEvent =
                repairingEpisode !== undefined &&
                replayEvent.id !== undefined &&
                !repairingEpisode.observedSnapshotEventIds.has(
                  replayEvent.id,
                ) &&
                !(
                  replayEvent.id > repairingEpisode.snapshotLastEventId &&
                  replayEvent.id <= repairingEpisode.lastObservedEventId
                );
              try {
                const replayUiEvents = normalizeAndFilterEvent(
                  replayEvent,
                  activeSession.clientId,
                  replayOpts,
                  setConnection,
                  {
                    updateConnection:
                      repairingEpisode !== undefined && isNewRepairEvent,
                    suppressLog:
                      repairingEpisode !== undefined && !isNewRepairEvent,
                  },
                );
                const transcriptEvents = filterDaemonUiEventsForTranscript(
                  replayEvent,
                  replayUiEvents,
                  addNotice,
                  dismissNotice,
                  {
                    hideHistoryTruncation: historyHasMore,
                    suppressSideEffects:
                      repairingEpisode !== undefined && !isNewRepairEvent,
                  },
                );
                const projectedEvents =
                  subagentTranscriptModeRef.current === 'summary'
                    ? projectMainTranscriptEvents(transcriptEvents)
                    : transcriptEvents;
                const groupEvents = [...projectedEvents];
                if (replayEvent.type === 'turn_complete') {
                  const stopReason =
                    (replayEvent.data as DaemonTurnCompleteData | undefined)
                      ?.stopReason ?? 'end_turn';
                  groupEvents.push(
                    assistantDoneFromTurnEvent(replayEvent, stopReason),
                  );
                } else if (replayEvent.type === 'turn_error') {
                  groupEvents.push(
                    assistantDoneFromTurnEvent(replayEvent, 'error'),
                  );
                }
                eventGroups.push({
                  transcript: groupEvents,
                  sideEffects:
                    repairingEpisode === undefined
                      ? projectedEvents
                      : isNewRepairEvent
                        ? replayUiEvents
                        : [],
                });
                if (isNewRepairEvent) {
                  const followupSuggestion =
                    parseSidechannelFollowupSuggestion(replayEvent);
                  if (followupSuggestion) {
                    publishSidechannelFollowupSuggestion(followupSuggestion);
                  }
                  const midTurnInjected =
                    parseSidechannelMidTurnInjected(replayEvent);
                  if (midTurnInjected) {
                    publishSidechannelMidTurnInjected(midTurnInjected);
                  }
                  if (isPendingPromptEvent(replayEvent)) {
                    publishPendingPromptEvent(replayEvent);
                  }
                }
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                if (repairingEpisode === undefined || isNewRepairEvent) {
                  addNotice({
                    severity: 'warning',
                    category: 'protocol',
                    operation: 'normalize_event',
                    code: 'daemon.replay_event_malformed',
                    message: 'Skipped malformed replay event',
                    debugMessage: message,
                    recoverable: true,
                  });
                  console.warn(
                    '[DaemonSessionProvider] skipped malformed replay event:',
                    error,
                  );
                }
                eventGroups.push({ transcript: [], sideEffects: [] });
              }
            }
            const allUiEvents = eventGroups.flatMap(
              (group) => group.transcript,
            );
            let replayExceededCapacity = false;
            let replayTrimmed = false;
            let replayTrimmedAnchor: string | undefined;
            const rebuildReplay =
              repairingEpisode !== undefined ||
              replayTarget !== undefined ||
              needsStoreReset ||
              store.getSnapshot().blocks.length === 0;
            if (rebuildReplay) {
              // Ordinary replay rebuilds under the same cap as live growth:
              // a session loaded mid-turn can carry a live journal with tens
              // of thousands of events, and retaining it all (the previous
              // uncapped rebuild) exhausted renderer memory. Trimming keeps
              // the most recent blocks; older history stays reachable via
              // pagination.
              const replayMaxBlocks =
                repairingEpisode && markerStillVisible
                  ? repairingEpisode.checkpoint.maxBlocks
                  : maxBlocks;
              const observeReplayTrim = (
                detail: DaemonTranscriptTruncationDetail,
              ) => {
                // A rewind also fires `kind: 'blocks'` but with
                // `evictedOldest: false` — it drops the NEWEST blocks and
                // leaves the oldest pagination anchor valid, so it must not
                // latch the capacity/re-anchor path (same gate as the live
                // store's onTruncation handler above).
                if (detail.kind === 'blocks' && detail.evictedOldest !== false)
                  replayTrimmed = true;
              };
              // Both rebuild branches can trim (count cap or byte budget), so
              // both observe it — a marker-visible repair seeded from the
              // checkpoint is just as able to evict the pagination anchor as
              // an ordinary rebuild.
              const replayStore = createDaemonTranscriptStore(
                repairingEpisode && markerStillVisible
                  ? {
                      ...repairingEpisode.checkpoint,
                      maxBlocks: replayMaxBlocks,
                      onTruncation: observeReplayTrim,
                    }
                  : {
                      maxBlocks: replayMaxBlocks,
                      retainSubagentBlocks:
                        subagentTranscriptModeRef.current === 'full',
                      // Rebuild under the same byte budget as the live store
                      // so an oversized replay is trimmed to the same ceiling.
                      ...(maxRetainedBytes !== undefined
                        ? { maxRetainedBytes }
                        : {}),
                      // The count cap and the default byte budget can both
                      // evict mid-rebuild; observe either so the pagination
                      // anchor and capacity indicator reconcile below.
                      onTruncation: observeReplayTrim,
                    },
              );
              let nextCheckpoint: DaemonTranscriptState | undefined;
              if (markerIndex < 0 && repairingEpisode === undefined) {
                // Ordinary replay needs no intermediate checkpoint. Dispatch
                // once so rebuilding a long transcript stays O(B), not O(E×B).
                replayStore.dispatch(allUiEvents);
              } else {
                for (const [index, group] of eventGroups.entries()) {
                  if (index === markerIndex) {
                    nextCheckpoint = replayStore.getSnapshot();
                  }
                  replayStore.dispatch(group.transcript);
                }
              }
              const replayState = replayStore.getSnapshot();
              // A rebuild trim (count cap or byte budget) evicted older
              // blocks; a merely saturated window leaves no in-store room
              // for pagination either way — surface capacityReached for both.
              // Repair rebuilds reconcile too: they evict the anchor just as
              // an ordinary rebuild does.
              replayExceededCapacity =
                replayTrimmed || replayState.blocks.length >= replayMaxBlocks;
              if (replayExceededCapacity) {
                // The pre-trim anchor can sit inside the trimmed stretch;
                // re-anchor below to the oldest RETAINED record so
                // pagination fetches exactly the dropped records.
                replayTrimmedAnchor = replayState.blocks.find(
                  (block) => (block.sourceRecordIds?.length ?? 0) > 0,
                )?.sourceRecordIds?.[0];
              }
              // Replay must never ratchet the retention window above the
              // configured cap: the committed cap is what bounds every
              // later dispatch, and an escalation here turned one large
              // replay into permanent unbounded retention.
              const committedMaxBlocks = replayMaxBlocks;
              store.reset({
                ...replayState,
                maxBlocks: committedMaxBlocks,
              });
              if (replayTarget && nextCheckpoint) {
                const markerBlock = store
                  .getSnapshot()
                  .blocks.find(
                    (block) =>
                      block.kind === 'status' &&
                      block.source === 'history_truncated' &&
                      isRecord(block.data) &&
                      block.data['scope'] === 'live_journal',
                  );
                const existingRepair = liveJournalRepairRef.current;
                liveJournalRepairRef.current =
                  existingRepair?.target.signature === replayTarget.signature &&
                  existingRepair.attempted
                    ? existingRepair
                    : {
                        sessionId: activeSession.sessionId,
                        target: replayTarget,
                        checkpoint: {
                          ...nextCheckpoint,
                          maxBlocks: committedMaxBlocks,
                        },
                        ...(markerBlock
                          ? { markerBlockId: markerBlock.id }
                          : {}),
                        observedSnapshotEventIds: new Set(
                          liveJournal.flatMap((event) =>
                            event.id === undefined ? [] : [event.id],
                          ),
                        ),
                        snapshotLastEventId: activeSession.lastEventId ?? 0,
                        lastObservedEventId: activeSession.lastEventId ?? 0,
                        terminalSeen: false,
                        attempted: false,
                      };
              } else if (repairingEpisode) {
                liveJournalRepairRef.current = undefined;
              }
            } else if (allUiEvents.length > 0) {
              store.dispatch(allUiEvents);
            }
            const sideEffectEvents = eventGroups.flatMap(
              (group) => group.sideEffects,
            );
            if (activeWorkspaceScoped && sideEffectEvents.length > 0) {
              bumpWorkspaceEventSignals(
                sideEffectEvents,
                setWorkspaceEventSignals,
                activeSession.workspaceCwd,
              );
            }
            if (replayExceededCapacity) {
              if (replayTrimmed) {
                if (replayTrimmedAnchor !== undefined) {
                  transcriptHistoryRef.current.beforeRecordId =
                    replayTrimmedAnchor;
                } else {
                  // The rebuild trimmed but no retained block carries a
                  // recordId, so a re-anchor to a retained record is
                  // uncomputable. Any pre-trim anchor points at an evicted
                  // record the exclusive pagination contract can never return
                  // again — drop it unconditionally, mirroring the live store's
                  // fail-closed branch. Scanning only the fresh replayEvents
                  // would miss recordIds trimmed from the repair checkpoint in
                  // a marker-visible live-journal repair, leaving a stale anchor
                  // with the affordance still on; when no recordId ever existed
                  // the anchor is already undefined, so the drop is a no-op.
                  transcriptHistoryRef.current.beforeRecordId = undefined;
                }
                // A rebuild trim can evict the records a cursor points past;
                // drop it so the beforeRecordId (re-anchored or pre-trim) is
                // authoritative.
                transcriptHistoryRef.current.cursor = undefined;
              }
              // Trimmed/saturated replay content stays persisted daemon-side
              // and is fetchable through pagination, so keep the load-older
              // affordance — but only while admission has real headroom: a
              // positional anchor and byte-budget room. Without byte-budget
              // headroom (e.g. a single oversized block whose estimate alone
              // exceeds the budget) no page can ever be admitted, so offering
              // the affordance would burn it on the first click with no
              // terminal signal.
              const postRebuild = store.getSnapshot();
              const olderHistoryReachable =
                Array.isArray(capabilities?.features) &&
                capabilities.features.includes(
                  SESSION_TRANSCRIPT_PAGINATION_FEATURE,
                ) &&
                transcriptHistoryRef.current.beforeRecordId !== undefined &&
                postRebuild.retainedBytes < postRebuild.maxRetainedBytes;
              transcriptHistoryRef.current.hasMore = olderHistoryReachable;
              transcriptHistoryRef.current.capacityReached = true;
              setTranscriptHistoryState({
                hasMore: olderHistoryReachable,
                loading: false,
                capacityReached: true,
                paginationError: false,
              });
            }
            for (const replayEvent of replayEvents) {
              settleActivePromptFromTurnEvent(
                activePromptsRef.current,
                settledPromptsRef.current,
                activeSession.sessionId,
                replayEvent,
                store,
                setPromptStatus,
                passiveAssistantDoneTimerRef,
                { requireBoundPromptId: true },
              );
            }
            setConnection((c) => ({ ...c, catchingUp: undefined }));
            // Release the raw snapshot only after the injection above
            // completed: if normalization/dispatch threw, the recovery path
            // reloads the session, and the still-retained snapshot keeps the
            // window consistent until then. On success it is never read again
            // (SSE continues from lastEventId; older history via pagination),
            // so dropping it unpins busy-session snapshots that can reach
            // tens of MiB after adaptive journal growth.
            activeSession.consumeReplaySnapshot();
          }
          setConnection((current) => ({
            ...current,
            status: 'connected',
            sessionId: activeSession.sessionId,
            sessionContext: activeProductSessionContext,
            ...(activeSession.clientId
              ? { clientId: activeSession.clientId }
              : {}),
            workspaceCwd: activeWorkspaceScoped
              ? activeProductSessionContext.cwd
              : undefined,
            standaloneSession:
              activeProductSessionContext.kind === 'standalone'
                ? getStandaloneConnectionState(activeSession.session)
                : undefined,
            displayName:
              getSessionDisplayName(activeSession.state) ??
              (current.sessionId === activeSession.sessionId
                ? current.displayName
                : undefined),
            tokenUsage:
              replayTokenUsage !== undefined
                ? replayTokenUsage
                : current.sessionId === activeSession.sessionId
                  ? current.tokenUsage
                  : undefined,
            tokenCount:
              replayTokenCount !== undefined
                ? replayTokenCount
                : current.sessionId === activeSession.sessionId
                  ? (current.tokenCount ?? 0)
                  : 0,
            goalState:
              current.sessionId === activeSession.sessionId
                ? current.goalState
                : undefined,
            loadingTranscript: undefined,
            catchingUp: replayInjected
              ? current.catchingUp
              : isSameSessionReconnect ||
                activeSession.lastEventId != null ||
                undefined,
          }));
          if (pendingLoadToResolve) {
            lastHandledSessionIdRef.current = activeSession.sessionId;
            lastHandledSessionContextRef.current = activeProductSessionContext;
            lastHandledClientIdRef.current = undefined;
            pendingSessionLoadRef.current = undefined;
            if (pendingLoadToResolve.timeout !== undefined) {
              clearTimeout(pendingLoadToResolve.timeout);
            }
            if (skipNextCleanupDetachSessionRef.current === activeSession) {
              skipNextCleanupDetachSessionRef.current = undefined;
            }
            pendingLoadToResolve.resolve();
          }

          const canReuseSessionMetadata =
            skipMetadataRefreshThisIteration ||
            (attachedExistingSession &&
              connectionRef.current.commands !== undefined &&
              connectionRef.current.skills !== undefined &&
              connectionRef.current.supportedCommands !== undefined &&
              connectionRef.current.context !== undefined);
          const configGeneration =
            sessionConfigGenerationRef.current.get(activeSession) ?? 0;
          const goalStateAtLoadStart =
            connectionRef.current.sessionId === activeSession.sessionId
              ? connectionRef.current.goalState
              : undefined;
          const gitPromise = skipMetadataRefreshThisIteration
            ? Promise.resolve({ branch: connectionRef.current.gitBranch })
            : activeWorkspaceScoped
              ? activeSession.workspaceCwd
                ? client
                    .workspaceByCwd(activeSession.workspaceCwd)
                    .workspaceGit()
                : client.workspaceGit()
              : Promise.resolve(undefined);
          const metadataPromise = Promise.allSettled([
            canReuseSessionMetadata || !activeWorkspaceScoped
              ? Promise.resolve(undefined)
              : client.workspaceProviders(),
            canReuseSessionMetadata
              ? Promise.resolve(undefined)
              : activeSession.supportedCommands(),
            canReuseSessionMetadata
              ? Promise.resolve(undefined)
              : activeSession.context(),
            gitPromise,
          ]);
          // Hydrate Goal ownership independently so unrelated metadata cannot
          // leave Slash commands blocked. Reconcile against any Goal frame
          // that landed while the read was in flight.
          const goalPromise = activeSession
            .goal()
            .then(
              (response) => response.snapshot,
              () => undefined,
            )
            .then((goalState) => {
              if (
                disposed ||
                abort.signal.aborted ||
                sessionRef.current !== activeSession
              ) {
                return goalState;
              }
              setConnection((current) => {
                if (
                  sessionRef.current !== activeSession ||
                  current.sessionId !== activeSession.sessionId
                ) {
                  return current;
                }
                if (!goalState && goalStateAtLoadStart !== undefined) {
                  return current;
                }
                return {
                  ...current,
                  goalState: goalState
                    ? selectGoalStateFromRead(
                        current.goalState,
                        goalState,
                        goalStateAtLoadStart?.goal?.goalId,
                      )
                    : (current.goalState ?? {
                        v: 2,
                        goal: null,
                        activity: 'idle',
                      }),
                };
              });
              return goalState;
            });
          const [
            [providerResult, commandResult, contextResult, gitResult],
            goalState,
          ] = await Promise.all([metadataPromise, goalPromise]);
          if (
            disposed ||
            abort.signal.aborted ||
            sessionRef.current !== activeSession
          ) {
            return;
          }
          const providers =
            providerResult?.status === 'fulfilled'
              ? providerResult.value
              : undefined;
          const supportedCommands =
            commandResult?.status === 'fulfilled'
              ? commandResult.value
              : undefined;
          const context =
            contextResult?.status === 'fulfilled'
              ? contextResult.value
              : undefined;
          const gitBranch =
            gitResult?.status === 'fulfilled'
              ? (gitResult.value?.branch ?? undefined)
              : undefined;
          const goalStateFallback =
            goalState === undefined && goalStateAtLoadStart === undefined
              ? ({ v: 2, goal: null, activity: 'idle' } as const)
              : undefined;
          const loadWarningTexts = [
            providerResult?.status === 'rejected'
              ? loadWarningsRef.current?.models
              : undefined,
            commandResult?.status === 'rejected'
              ? loadWarningsRef.current?.commands
              : undefined,
            contextResult?.status === 'rejected'
              ? loadWarningsRef.current?.context
              : undefined,
          ].filter((warning): warning is string => Boolean(warning));
          const providerModelStatus = mapProviderStatus(providers);
          const contextModelStatus = mapSessionContextModels(context);
          const sessionModels =
            contextModelStatus && contextModelStatus.models.length > 0
              ? contextModelStatus.models
              : providerModelStatus.models;
          const sessionCurrentModel =
            contextModelStatus?.currentModel ??
            providerModelStatus.currentModel;
          const providerContextWindow =
            sessionCurrentModel === providerModelStatus.currentModel
              ? providerModelStatus.contextWindow
              : providerModelStatus.models.find(
                  (model) => model.id === sessionCurrentModel,
                )?.contextWindow;
          const sessionContextWindow =
            contextModelStatus?.contextWindow ??
            sessionModels.find((model) => model.id === sessionCurrentModel)
              ?.contextWindow ??
            providerContextWindow;
          const { commands, skills } = mapSupportedCommands(supportedCommands);
          const currentMode =
            getCurrentMode(context) ?? providerModelStatus.currentMode;

          setConnection((current) => {
            if (
              abort.signal.aborted ||
              (sessionRef.current !== undefined &&
                sessionRef.current !== activeSession) ||
              current.sessionId !== activeSession.sessionId
            ) {
              return current;
            }
            const configSnapshotCurrent =
              configGeneration % 2 === 0 &&
              (sessionConfigGenerationRef.current.get(activeSession) ?? 0) ===
                configGeneration;
            return {
              ...current,
              status: 'connected',
              sessionId: activeSession.sessionId,
              // Surface the bound client id for consumers of legacy
              // originator-stamped frames.
              ...(activeSession.clientId
                ? { clientId: activeSession.clientId }
                : {}),
              sessionContext: activeProductSessionContext,
              workspaceCwd: activeWorkspaceScoped
                ? activeProductSessionContext.cwd
                : undefined,
              standaloneSession:
                activeProductSessionContext.kind === 'standalone'
                  ? getStandaloneConnectionState(activeSession.session)
                  : undefined,
              // A fulfilled supported-commands fetch is authoritative even when
              // it returns an empty list: fall back to the preserved
              // `current.commands` only when the fetch was skipped or failed
              // (supportedCommands === undefined). Keying on length instead
              // would let a genuinely-empty snapshot leave a stale command list
              // in place (see getConnectionAfterSessionClear, which now
              // preserves commands across a clear).
              commands:
                supportedCommands !== undefined ? commands : current.commands,
              skills: supportedCommands !== undefined ? skills : current.skills,
              models: sessionModels.length > 0 ? sessionModels : current.models,
              currentModel: configSnapshotCurrent
                ? (sessionCurrentModel ?? current.currentModel)
                : current.currentModel,
              currentMode: currentMode ?? current.currentMode,
              reasoning:
                configSnapshotCurrent && context !== undefined
                  ? mapSessionContextReasoning(context)
                  : current.reasoning,
              displayName:
                getSessionDisplayName(activeSession.state) ??
                current.displayName,
              contextWindow: configSnapshotCurrent
                ? (sessionContextWindow ?? current.contextWindow)
                : current.contextWindow,
              providers: activeWorkspaceScoped
                ? configSnapshotCurrent
                  ? (providers ?? current.providers)
                  : current.providers
                : undefined,
              supportedCommands: supportedCommands ?? current.supportedCommands,
              context: configSnapshotCurrent
                ? (context ?? current.context)
                : current.context,
              // Reconcile rather than reference-compare: the load response and
              // any frame that arrived during the load window share a revision
              // domain, and routing through `selectGoalState` is what registers
              // the cleared-goal tombstone that keeps a later stale frame from
              // resurrecting a cleared goal. The read is stamped with the goal
              // observed when it was issued (`goalStateAtLoadStart`) — a create
              // that lands inside the load window must not be wiped, and
              // tombstoned, by a bare-null answer that predates it.
              goalState: goalState
                ? selectGoalStateFromRead(
                    current.goalState,
                    goalState,
                    goalStateAtLoadStart?.goal?.goalId,
                  )
                : (current.goalState ?? goalStateFallback),
              gitBranch:
                activeWorkspaceScoped && gitResult.status === 'fulfilled'
                  ? gitBranch
                  : activeWorkspaceScoped
                    ? current.gitBranch
                    : undefined,
              gitStatus: activeWorkspaceScoped ? current.gitStatus : undefined,
              capabilities: capabilities ?? current.capabilities,
              loadingTranscript: undefined,
              catchingUp:
                // Replay already injected above — keep the cleared flag rather
                // than re-arming it (nothing before SSE would clear it again).
                replayInjected
                  ? current.catchingUp
                  : isSameSessionReconnect ||
                    activeSession.lastEventId != null ||
                    undefined,
            };
          });
          if (loadWarningTexts.length > 0) {
            const existingWarningTexts = repairingEpisode
              ? new Set(
                  store
                    .getSnapshot()
                    .blocks.flatMap((block) =>
                      block.kind === 'status' ? [block.text] : [],
                    ),
                )
              : undefined;
            const warningEvents = loadWarningTexts
              .filter((text) => !existingWarningTexts?.has(text))
              .map((text) => ({
                type: 'status' as const,
                text,
              }));
            if (warningEvents.length > 0) {
              store.dispatch(warningEvents);
            }
            const repair = liveJournalRepairRef.current;
            if (
              warningEvents.length > 0 &&
              repair?.sessionId === activeSession.sessionId
            ) {
              const checkpointStore = createDaemonTranscriptStore({
                ...repair.checkpoint,
                maxBlocks: repair.checkpoint.maxBlocks,
              });
              checkpointStore.dispatch(warningEvents);
              repair.checkpoint = checkpointStore.getSnapshot();
            }
          }
          let sawEvent = false;
          let resyncRequested = false;
          const requestEpochResetReload = () => {
            // An epoch reset means the daemon/EventBus timeline was rebuilt.
            // The current SSE cursor and any restored/local prompt activity may
            // describe the old epoch, so do a full /load and let
            // hasActivePrompt from that fresh snapshot become authoritative.
            const active = activePromptsRef.current.get(
              activeSession.sessionId,
            );
            active?.controller.abort();
            activePromptsRef.current.delete(activeSession.sessionId);
            if (restoredActivePrompt) {
              settleRestoredActivePrompt();
            }
            clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
            setPromptStatus('idle');
            clearPendingTranscriptEvents();
            store.reset();
            activeSession.setLastEventId(0);
            reconnectSessionId = activeSession.sessionId;
            resyncRequested = true;
            nextSseConnectReason = 'state_resync';
            session = undefined;
            sessionRef.current = undefined;
            hasCurrentSessionActivePromptRef.current = () => false;
            setConnection((current) => ({
              ...current,
              status: 'connecting',
              error: undefined,
              errorStatus: resolveConnectionErrorStatus(
                undefined,
                current.errorStatus,
              ),
            }));
          };
          const eventStreamController = new AbortController();
          eventStream = {
            sessionId: activeSession.sessionId,
            controller: eventStreamController,
            restartRequested: false,
          };
          eventStreamRef.current = eventStream;
          const abortEventStream = () =>
            eventStreamController.abort(abort.signal.reason);
          abort.signal.addEventListener('abort', abortEventStream, {
            once: true,
          });
          removeProviderAbortListener = () =>
            abort.signal.removeEventListener('abort', abortEventStream);
          const sseConnectReason = nextSseConnectReason;
          nextSseConnectReason = undefined;
          for await (const event of activeSession.events({
            signal: eventStreamController.signal,
            maxQueued,
            ...(sseConnectReason ? { sseConnectReason } : {}),
          })) {
            if (sessionRef.current !== activeSession) {
              break;
            }
            if (!sawEvent) {
              sawEvent = true;
              reconnectAttempt = 0;
            }
            const currentRepair = liveJournalRepairRef.current;
            if (
              currentRepair?.sessionId === activeSession.sessionId &&
              event.id !== undefined
            ) {
              currentRepair.lastObservedEventId = Math.max(
                currentRepair.lastObservedEventId,
                event.id,
              );
            }
            try {
              const followupSuggestion =
                parseSidechannelFollowupSuggestion(event);
              if (followupSuggestion) {
                publishSidechannelFollowupSuggestion(followupSuggestion);
                continue;
              }
              const midTurnInjected = parseSidechannelMidTurnInjected(event);
              if (midTurnInjected) {
                // Keep the sidechannel for queue dedupe, but still normalize the
                // event below so chat UIs can render the inserted-message status.
                publishSidechannelMidTurnInjected(midTurnInjected);
                if (sessionRef.current !== activeSession) break;
              }
              if (isPendingPromptEvent(event)) {
                publishPendingPromptEvent(event);
                if (sessionRef.current !== activeSession) break;
                if (event.type === 'pending_prompt_started') {
                  clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                  setPromptStatus('waiting');
                }
              }
              const normalizedUiEvents = normalizeAndFilterEvent(
                event,
                activeSession.clientId,
                eventOptionsRef.current,
                (update) => {
                  if (sessionRef.current !== activeSession) return;
                  setConnectionSynchronous(update);
                },
              );
              const uiEvents = filterDaemonUiEventsForTranscript(
                event,
                normalizedUiEvents,
                addNotice,
                dismissNotice,
              );
              const transcriptUiEvents =
                subagentTranscriptModeRef.current === 'summary'
                  ? projectMainTranscriptEvents(uiEvents)
                  : uiEvents;
              if (event.type === 'state_resync_required') {
                const reason =
                  typeof event.data === 'object' && event.data !== null
                    ? (event.data as Record<string, unknown>).reason
                    : undefined;
                if (reason === 'epoch_reset') {
                  requestEpochResetReload();
                  break;
                }
              }
              if (activeWorkspaceScoped) {
                bumpWorkspaceEventSignals(
                  uiEvents,
                  setWorkspaceEventSignals,
                  activeProductSessionContext.cwd,
                );
              }
              if (uiEvents.length > 0) {
                const hasGenerationSignal = hasActiveGenerationSignal(uiEvents);
                setPromptStatus((current) =>
                  current === 'waiting' ||
                  (current === 'idle' && hasGenerationSignal)
                    ? 'streaming'
                    : current,
                );
              }
              // Flush buffered transcript events before settling a turn so the
              // turn's content is applied ahead of the assistant.done that
              // settle (and the restored-prompt / observer branches below)
              // dispatch. Guarded to turn terminals so steady streaming keeps
              // batching.
              if (
                event.type === 'turn_complete' ||
                event.type === 'turn_error'
              ) {
                flushTranscriptSync();
              }
              const activePromptSettled = settleActivePromptFromTurnEvent(
                activePromptsRef.current,
                settledPromptsRef.current,
                activeSession.sessionId,
                event,
                store,
                setPromptStatus,
                passiveAssistantDoneTimerRef,
              );
              let restoredPromptSettled = false;
              if (
                !activePromptSettled &&
                restoredActivePrompt &&
                (event.type === 'turn_complete' || event.type === 'turn_error')
              ) {
                // A refreshed page restores an already-running prompt without a
                // local ActivePrompt entry or prompt promise to settle. The daemon
                // terminal event is still authoritative, so end the restored
                // running state here instead of relying on the observer branch.
                settleRestoredActivePrompt();
                restoredPromptSettled = true;
                clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                const stopReason =
                  event.type === 'turn_complete'
                    ? ((event.data as DaemonTurnCompleteData | undefined)
                        ?.stopReason ?? 'end_turn')
                    : 'error';
                dispatchTranscriptNow(
                  assistantDoneFromTurnEvent(event, stopReason),
                );
                if (!hasSessionActivePrompt()) {
                  setPromptStatus('idle');
                }
              }
              const hasBlockPathDebugEvent = uiEvents.some(
                (e) =>
                  e.type === 'debug' &&
                  !isUnrecognizedDiagnosticReason(e.debugReason),
              );
              // The debug guard below reads the committed store's active
              // assistant block, but batching leaves earlier chunks from this
              // same burst in the pending buffer until the macrotask flush. An
              // observer burst that interleaves a debug event between assistant
              // chunks would otherwise miss the still-pending assistant block
              // and let the debug event split it. Commit the buffer first so the
              // guard sees the effective state. Scoped to block-path debug events
              // because unrecognized diagnostics route to the sidechannel.
              if (!hasSessionActivePrompt() && hasBlockPathDebugEvent) {
                flushTranscriptSync();
              }
              const shouldGuardAssistant =
                !hasSessionActivePrompt() &&
                store.getSnapshot().activeAssistantBlockId != null;
              // `unrecognized_*` debug events route to the sidechannel
              // instead of `blocks[]` (#8823), so they cannot split the
              // streaming assistant block and must not be dropped here;
              // only block-path debug events still need the guard.
              const eventsToDispatch = shouldGuardAssistant
                ? transcriptUiEvents.filter(
                    (e) =>
                      e.type !== 'debug' ||
                      isUnrecognizedDiagnosticReason(e.debugReason),
                  )
                : transcriptUiEvents;
              enqueueTranscriptEvents(eventsToDispatch);
              for (const uiEvent of uiEvents) {
                if (
                  uiEvent.type === 'prompt.cancelled' &&
                  (restoredActivePrompt ||
                    uiEvent.originatorClientId !== activeSession.clientId)
                ) {
                  dispatchTranscriptNow(
                    assistantDoneFromTurnEvent(event, 'cancelled'),
                  );
                  const cancellingRestoredPrompt = restoredActivePrompt;
                  settleRestoredActivePrompt();
                  restoredPromptSettled = true;
                  clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                  if (!cancellingRestoredPrompt) {
                    activePromptsRef.current.delete(activeSession.sessionId);
                  }
                  if (!hasSessionActivePrompt()) {
                    setPromptStatus('idle');
                  }
                } else if (uiEvent.type === 'session.replay_complete') {
                  // Flush first so the awaitingResync read below reflects every
                  // event up to replay_complete (e.g. a buffered
                  // state_resync_required from this same burst).
                  flushTranscriptSync();
                  setConnection((c) => ({ ...c, catchingUp: undefined }));
                  if (store.getSnapshot().awaitingResync) {
                    store.clearAwaitingResync();
                  }
                  if (!hasSessionActivePrompt()) {
                    clearPassiveAssistantDoneTimer(
                      passiveAssistantDoneTimerRef,
                    );
                    dispatchTranscriptNow({
                      type: 'assistant.done',
                      reason: 'replay_complete',
                    });
                    setPromptStatus('idle');
                  }
                }
              }
              // A restored active prompt is not in activePromptsRef because this
              // browser did not submit it. Treat it as active here too; otherwise
              // the passive observer timer can briefly mark a still-running turn
              // idle between sparse tool/thinking updates.
              const isObserver =
                !activePromptSettled &&
                !restoredPromptSettled &&
                !hasSessionActivePrompt();
              if (isObserver) {
                const hasUserMsg = uiEvents.some(
                  (e) => e.type === 'user.text.delta',
                );
                if (hasUserMsg) {
                  setPromptStatus('waiting');
                } else if (hasActiveGenerationSignal(uiEvents)) {
                  setPromptStatus((current) =>
                    current === 'idle' ? 'streaming' : current,
                  );
                }
              }
              if (isObserver && event.type === 'turn_complete') {
                clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                const stopReason =
                  (event.data as DaemonTurnCompleteData | undefined)
                    ?.stopReason ?? 'end_turn';
                dispatchTranscriptNow(
                  assistantDoneFromTurnEvent(event, stopReason),
                );
                setPromptStatus('idle');
              } else if (isObserver && event.type === 'turn_error') {
                clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                dispatchTranscriptNow(
                  assistantDoneFromTurnEvent(event, 'error'),
                );
                setPromptStatus('idle');
              } else if (isObserver && hasActiveGenerationSignal(uiEvents)) {
                schedulePassiveAssistantDone(
                  store,
                  passiveAssistantDoneTimerRef,
                  'passive_observer',
                  3000,
                  () => setPromptStatus('idle'),
                );
              }
              const pendingRepair = liveJournalRepairRef.current;
              if (
                pendingRepair?.sessionId === activeSession.sessionId &&
                (event.type === 'turn_complete' ||
                  event.type === 'turn_error') &&
                eventPromptId(event) === pendingRepair.target.promptId
              ) {
                pendingRepair.terminalSeen = true;
                queueMicrotask(tryLiveJournalRepair);
              } else if (pendingRepair?.terminalSeen) {
                queueMicrotask(tryLiveJournalRepair);
              }
              // ── state_resync_required handling ──────────────────────
              // Resyncs are transcript recovery signals, not prompt terminal
              // signals. For epoch_reset and ring_evicted we reload the session
              // snapshot; the fresh /load response is the source of truth for
              // hasActivePrompt and transcript replay.
              if (event.type === 'state_resync_required') {
                const reason =
                  typeof event.data === 'object' && event.data !== null
                    ? (event.data as Record<string, unknown>).reason
                    : undefined;
                if (reason !== 'epoch_reset') {
                  // Resync asks us to rebuild transcript state, but it is not a
                  // prompt terminal signal. Keep loading alive for local/restored
                  // prompts until turn_complete, turn_error, or prompt_cancelled.
                  if (!hasSessionActivePrompt()) {
                    setPromptStatus('idle');
                    clearPassiveAssistantDoneTimer(
                      passiveAssistantDoneTimerRef,
                    );
                  }
                  clearPendingTranscriptEvents();
                  store.reset();
                  // Ring eviction means the SSE replay window has a real gap.
                  // Resetting and continuing on the same stream can only replay
                  // the surviving tail; reload the session snapshot instead so
                  // compactedReplay/liveJournal rebuild the bounded replay
                  // window.
                  console.warn(
                    '[DaemonSessionProvider] ring eviction detected, reloading session (sessionId=%s)',
                    activeSession.sessionId,
                  );
                  resyncRequested = true;
                  nextSseConnectReason = 'state_resync';
                  session = undefined;
                  sessionRef.current = undefined;
                  hasCurrentSessionActivePromptRef.current = () => false;
                  setConnection((current) => ({
                    ...current,
                    status: 'connecting',
                    error: undefined,
                    errorStatus: resolveConnectionErrorStatus(
                      undefined,
                      current.errorStatus,
                    ),
                  }));
                  break;
                }
              }
              // session_closed with reason 'client_close' means the
              // user explicitly deleted the session. Stop the
              // reconnect loop — without this, the next iteration
              // would call createOrAttach and auto-create a new
              // session, undoing the user's delete action.
              // Other reasons (idle_timeout, last_client_detached)
              // fall through to the normal reconnect path.
              if (
                event.type === 'session_closed' &&
                (event.data as Record<string, unknown> | undefined)?.reason ===
                  'client_close'
              ) {
                userDeletedSession = true;
                const closedSessionId = activeSession.sessionId;
                const active = activePromptsRef.current.get(closedSessionId);
                active?.controller.abort();
                activePromptsRef.current.delete(closedSessionId);
                session = undefined;
                sessionRef.current = undefined;
                break;
              }
            } catch (error) {
              if (sessionRef.current !== activeSession) break;
              const message =
                error instanceof Error ? error.message : String(error);
              addNotice({
                severity: 'warning',
                category: 'protocol',
                operation: 'normalize_event',
                code: 'daemon.event_malformed',
                message: 'Skipped malformed daemon event',
                debugMessage: message,
                recoverable: true,
              });
              console.warn(
                '[DaemonSessionProvider] skipped malformed daemon event:',
                error,
              );
            }
          }
          if (
            sessionRef.current !== activeSession &&
            !resyncRequested &&
            !userDeletedSession
          ) {
            clearPendingTranscriptEvents();
            clearEventStream();
            return;
          }
          // The stream ended or broke: apply any buffered transcript events now
          // so post-loop handling (and consumers reading the snapshot) see a
          // complete transcript without waiting for the scheduled flush.
          flushTranscriptSync();
          const restartRequested = eventStream.restartRequested;
          clearEventStream();
          if (restartRequested) {
            nextSseConnectReason = 'prompt_restart';
            reconnectAttempt = 0;
            skipMetadataRefresh = true;
            continue;
          }
          if (userDeletedSession) {
            // Session was explicitly closed (user deleted it). Do NOT
            // reconnect — doing so would auto-create a new session.
            // Note: we intentionally do NOT call setRestoreSessionId(undefined)
            // here because restoreSessionId is in the useEffect dependency
            // array — changing it would trigger an effect re-run that could
            // create a new session via createOrAttach.
            dispatchTranscriptNow({
              type: 'assistant.done',
              reason: 'cancelled',
            });
            setPromptStatus('idle');
            clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
            setConnection((current) => ({
              ...clearNonWorkspaceSessionState(current),
              status: 'disconnected',
              sessionId: undefined,
              context: undefined,
              reasoning: undefined,
              models: getWorkspaceModelsAfterSessionClear(current),
              goalState: undefined,
              error: undefined,
              errorStatus: undefined,
              missingSession: false,
            }));
            return;
          }
          if (manualSessionClearRef.current) {
            session = undefined;
            sessionRef.current = undefined;
            hasCurrentSessionActivePromptRef.current = () => false;
            return;
          }
          if (!disposed && !abort.signal.aborted && !resyncRequested) {
            nextSseConnectReason = 'stream_end';
            // Keep the session handle after a normal SSE close so the next
            // subscription can resume from DaemonSessionClient.lastEventId.
            if (sessionRef.current === activeSession) {
              console.debug('[DaemonSessionProvider] SSE stream ended');
              if (!hasSessionActivePrompt()) {
                // A transport close is only a safe "done" signal for passive
                // observers. When a local/restored prompt is still active, the
                // daemon may continue running while we reconnect via
                // Last-Event-ID, so keep the prompt in streaming state until a
                // real turn_complete/turn_error/prompt_cancelled arrives.
                clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                setPromptStatus('idle');
                dispatchTranscriptNow({
                  type: 'assistant.done',
                  reason: 'stream_ended',
                });
              }
            }
            setConnection((current) => ({
              ...current,
              status: current.status === 'error' ? 'error' : 'disconnected',
              error: current.status === 'error' ? current.error : undefined,
              errorStatus: resolveConnectionErrorStatus(
                undefined,
                current.errorStatus,
              ),
            }));
          }
        } catch (error) {
          const restartRequested = eventStream?.restartRequested === true;
          clearEventStream();
          if (session && sessionRef.current !== session) {
            clearPendingTranscriptEvents();
            return;
          }
          if (restartRequested && !disposed && !abort.signal.aborted) {
            flushTranscriptSync();
            nextSseConnectReason = 'prompt_restart';
            reconnectAttempt = 0;
            skipMetadataRefresh = true;
            continue;
          }
          if (disposed || abort.signal.aborted) return;
          // The loop threw, so the in-try post-loop flush was skipped. Apply
          // buffered transcript events now: leaving them with a scheduled timer
          // would let it fire after a reconnect reset and dispatch stale events.
          // Flush (not clear) because the retriable path below resumes via
          // Last-Event-ID without resetting the store — clearing would drop
          // events the SSE client already yielded (lastSeenEventId has advanced
          // past them).
          flushTranscriptSync();
          const message =
            error instanceof Error ? error.message : String(error);
          const errorStatus = extractHttpStatus(error);
          if (
            activeSessionContextRef.current?.kind === 'standalone' &&
            !standaloneCreateAttempted
          ) {
            setConnection((current) => ({
              ...current,
              standaloneSession: {
                ...current.standaloneSession,
                errorCode: getDaemonErrorCode(error),
              },
            }));
          }
          if (standaloneCreateAttempted) {
            standaloneCreateAttempted = false;
            manualSessionClearRef.current = true;
            const outcomeUnknown =
              error instanceof DaemonStandaloneCreationOutcomeUnknownError;
            setConnection((current) => ({
              ...getConnectionAfterSessionClear(
                current,
                current.sessionId,
                false,
              ),
              status: 'error',
              ...(outcomeUnknown ? { sessionId: error.sessionId } : {}),
              sessionContext: { kind: 'standalone' },
              workspaceCwd: undefined,
              standaloneSession: outcomeUnknown
                ? {
                    creationRecovery: error.recovery,
                    errorCode: getDaemonErrorCode(error.originalError),
                  }
                : {
                    errorCode:
                      error instanceof DaemonCapabilityMissingError
                        ? error.capability
                        : getDaemonErrorCode(error),
                  },
              error: message,
              errorStatus: resolveConnectionErrorStatus(
                outcomeUnknown
                  ? extractHttpStatus(error.originalError)
                  : errorStatus,
                current.errorStatus,
              ),
              missingSession: false,
              loadingTranscript: undefined,
              catchingUp: undefined,
            }));
            return;
          }
          const pendingLoad = pendingSessionLoadRef.current;
          const pendingLoadContextMatches =
            pendingLoad === undefined ||
            restoreSessionContextMatches(
              pendingLoad.sessionContext,
              activeSessionContextRef.current,
            );
          const restoreRetryDelayMs = getRestoreInProgressRetryDelayMs(error);
          const pendingLoadMatches =
            pendingLoadContextMatches &&
            (pendingLoad === undefined ||
              pendingLoad.sessionId === restoreSessionId);
          if (
            autoReconnect &&
            loadingRequestedSession &&
            ((restoreRetryDelayMs !== undefined && pendingLoadMatches) ||
              (pendingLoad?.sessionId === restoreSessionId &&
                pendingLoadContextMatches &&
                isClosingSessionLoadError(
                  error,
                  !capabilities?.features.includes(CLIENT_IDENTITY_FEATURE),
                )))
          ) {
            reconnectAttempt += 1;
            const reconnectConfig = reconnectConfigRef.current;
            await delay(
              restoreRetryDelayMs ??
                getReconnectDelayMs(
                  reconnectAttempt,
                  reconnectConfig.reconnectDelayMs,
                  reconnectConfig.maxReconnectDelayMs,
                ),
              abort.signal,
            );
            if (
              pendingLoad !== undefined &&
              pendingSessionLoadRef.current !== pendingLoad
            ) {
              return;
            }
            continue;
          }
          const failedSessionId = session?.sessionId;
          const isAuthFailure = isAuthFailureHttpError(error);
          const isTerminal = isTerminalSessionHttpError(error);
          if (failedSessionId && (isAuthFailure || isTerminal)) {
            const active = activePromptsRef.current.get(failedSessionId);
            active?.controller.abort();
            activePromptsRef.current.delete(failedSessionId);
          }
          // Retriable transport failures are not prompt terminal events. Keep
          // restored/local prompts in streaming state until the daemon sends
          // turn_complete, turn_error, or prompt_cancelled.
          if (isAuthFailure || isTerminal || !hasCurrentSessionActivePrompt()) {
            clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
            setPromptStatus('idle');
          }
          if (
            pendingLoad &&
            pendingLoadContextMatches &&
            (pendingLoad.sessionId === restoreSessionId ||
              pendingLoad.sessionId === reconnectSessionId)
          ) {
            if (
              skipNextCleanupDetachSessionRef.current?.sessionId ===
              pendingLoad.sessionId
            ) {
              skipNextCleanupDetachSessionRef.current = undefined;
            }
            pendingSessionLoadRef.current = undefined;
            if (pendingLoad.timeout !== undefined) {
              clearTimeout(pendingLoad.timeout);
            }
            pendingLoad.reject(error);
          }
          if (
            productContextFailure ||
            error instanceof DaemonCapabilityMissingError ||
            (session === undefined &&
              activeSessionContextRef.current?.kind !== 'workspace' &&
              activeSessionContextRef.current !== undefined &&
              isDaemonErrorExplicitlyNonRetryable(error))
          ) {
            setConnection((current) => ({
              ...current,
              status: 'error',
              error: message,
              errorStatus: resolveConnectionErrorStatus(
                errorStatus,
                current.errorStatus,
              ),
              standaloneSession:
                activeSessionContextRef.current?.kind === 'standalone'
                  ? {
                      ...current.standaloneSession,
                      errorCode:
                        error instanceof DaemonCapabilityMissingError
                          ? error.capability
                          : getDaemonErrorCode(error),
                    }
                  : undefined,
              missingSession: false,
              loadingTranscript: undefined,
              catchingUp: undefined,
            }));
            return;
          }
          if (isAuthFailure || isTerminal) {
            // Auth failures (401/403) and terminal session errors (404/410)
            // must clear the session — the server-side state is gone or
            // inaccessible, so delta resume is impossible.
            session = undefined;
            sessionRef.current = undefined;
            if (isAuthFailure) {
              setConnection((current) => ({
                ...clearNonWorkspaceSessionState(current),
                status: 'error',
                sessionId: undefined,
                context: undefined,
                reasoning: undefined,
                models: getWorkspaceModelsAfterSessionClear(current),
                goalState: undefined,
                error: message,
                errorStatus: resolveConnectionErrorStatus(
                  errorStatus,
                  current.errorStatus,
                ),
                missingSession: false,
                capabilities: capabilities ?? current.capabilities,
                loadingTranscript: undefined,
                catchingUp: undefined,
              }));
              return;
            }
            const missingLoadedSession =
              loadingRequestedSession &&
              isMissingSessionHttpStatus(errorStatus);
            console.warn(
              '[DaemonSessionProvider] terminal session error (sessionId=%s, status=%d, message=%s)',
              failedSessionId,
              errorStatus,
              message,
            );
            setConnection((current) => ({
              ...clearNonWorkspaceSessionState(current),
              status: 'disconnected',
              sessionId: undefined,
              context: undefined,
              reasoning: undefined,
              models: getWorkspaceModelsAfterSessionClear(current),
              goalState: undefined,
              error: message,
              errorStatus: resolveConnectionErrorStatus(
                errorStatus,
                current.errorStatus,
              ),
              // SSE errors should not create the missing-session empty state,
              // but they also must not clear one confirmed by load/heartbeat.
              missingSession:
                missingLoadedSession || current.missingSession === true,
              capabilities: capabilities ?? current.capabilities,
              loadingTranscript: undefined,
              catchingUp: undefined,
            }));
            return;
          } else if (
            preservingTranscriptDuringLoad &&
            session === undefined &&
            pendingLoad?.sessionId === restoreSessionId &&
            sessionRef.current?.sessionId === restoreSessionId
          ) {
            // The refresh failed before replacing the old handle. Resume its
            // SSE directly instead of retrying load and registering another
            // attachment after the caller's promise has already been rejected.
            session = sessionRef.current;
            reconnectSessionId = session.sessionId;
            reconnectAttempt = 0;
            skipMetadataRefresh = true;
            continue;
          } else if (isRestoreInProgressLoadError(error)) {
            setConnection((current) => ({
              ...current,
              status: 'error',
              error: message,
              errorStatus: resolveConnectionErrorStatus(
                errorStatus,
                current.errorStatus,
              ),
              missingSession: false,
              loadingTranscript: undefined,
              catchingUp: undefined,
            }));
            return;
          } else {
            // Retriable error (network failure, timeout, etc.) — preserve
            // the session so the next iteration skips the full load() and
            // goes straight to events(). DaemonSessionClient tracks
            // lastSeenEventId internally; the next SSE subscription sends
            // Last-Event-ID and the daemon serves only delta events.
            // The transcript store is NOT reset — new events append to
            // existing blocks, avoiding a full re-render.
            console.debug(
              '[DaemonSessionProvider] retriable SSE error, preserving session for delta resume (sessionId=%s)',
              session?.sessionId,
            );
            if (eventStream) {
              nextSseConnectReason = 'transport_error';
            }
          }
          if (!autoReconnect) {
            session = undefined;
            sessionRef.current = undefined;
            setConnection((current) => ({
              ...current,
              status: 'error',
              error: message,
              errorStatus: resolveConnectionErrorStatus(
                errorStatus,
                current.errorStatus,
              ),
              missingSession: false,
            }));
            return;
          }
          setConnection((current) => ({
            ...current,
            status: 'disconnected',
            errorStatus: resolveConnectionErrorStatus(
              errorStatus,
              current.errorStatus,
            ),
            missingSession: false,
            loadingTranscript: undefined,
          }));
        }

        if (disposed || abort.signal.aborted) return;
        if (!autoReconnect) {
          sessionRef.current = undefined;
          setConnection((current) => ({
            ...current,
            status: 'disconnected',
            loadingTranscript: undefined,
            catchingUp: undefined,
          }));
          return;
        }

        reconnectAttempt += 1;
        const reconnectConfig = reconnectConfigRef.current;
        const delayMs = getReconnectDelayMs(
          reconnectAttempt,
          reconnectConfig.reconnectDelayMs,
          reconnectConfig.maxReconnectDelayMs,
        );
        setConnection((current) => ({
          ...current,
          status: 'disconnected',
          error: undefined,
        }));
        reconnectAbortRef.current?.abort();
        const reconnectAbort = new AbortController();
        reconnectAbortRef.current = reconnectAbort;
        const onEffectAbort = () => reconnectAbort.abort();
        abort.signal.addEventListener('abort', onEffectAbort, { once: true });
        await delay(delayMs, reconnectAbort.signal);
        abort.signal.removeEventListener('abort', onEffectAbort);
      }
    };

    void run();
    return () => {
      const session = runnerSession;
      disposed = true;
      abort.abort();
      const ownsCurrentSession =
        session !== undefined && sessionRef.current === session;
      const ownsEmptyState =
        session === undefined && sessionRef.current === undefined;
      const keepSessionForNextEffect =
        ownsCurrentSession &&
        (session === skipNextCleanupDetachSessionRef.current ||
          sessionContextResolutionErrorRef.current !== undefined);
      if (
        ownsCurrentSession &&
        sessionContextResolutionErrorRef.current !== undefined
      ) {
        contextErrorPreservedSessionRef.current = session;
        contextErrorPreservedProductContextRef.current =
          activeSessionContextRef.current;
      } else if (contextErrorPreservedSessionRef.current === session) {
        contextErrorPreservedSessionRef.current = undefined;
        contextErrorPreservedProductContextRef.current = undefined;
      }
      const isUnmounting = !mountedRef.current;
      if (ownsCurrentSession || ownsEmptyState) {
        // A same-attachment effect restart must flush events already yielded by
        // the SSE client, because its resume cursor has advanced past them.
        flushTranscriptSync();
      } else {
        // A replacement attachment owns the store now. Never let the old
        // runner's pending macrotask append its buffered events to that owner.
        clearPendingTranscriptEvents();
      }
      if (ownsCurrentSession && (!keepSessionForNextEffect || isUnmounting)) {
        hasCurrentSessionActivePromptRef.current = () => false;
        setPromptStatus('idle');
        clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
      }
      if (
        effectPendingSessionLoad !== undefined &&
        pendingSessionLoadRef.current === effectPendingSessionLoad &&
        (ownsCurrentSession || ownsEmptyState) &&
        (!keepSessionForNextEffect || isUnmounting)
      ) {
        if (pendingSessionLoadRef.current.timeout !== undefined) {
          clearTimeout(pendingSessionLoadRef.current.timeout);
        }
        pendingSessionLoadRef.current.reject(
          new DOMException('Session load interrupted by cleanup', 'AbortError'),
        );
        pendingSessionLoadRef.current = undefined;
      }
      if (
        ownsCurrentSession &&
        (!keepSessionForNextEffect || isUnmounting) &&
        session.clientId
      ) {
        void detachDaemonClient({
          baseUrl: resolvedBaseUrl!,
          token: resolvedToken,
          sessionId: session.sessionId,
          clientId: session.clientId,
        }).catch((err) =>
          console.warn('[DaemonSessionProvider] detach failed:', err),
        );
      }
      if (ownsCurrentSession && (!keepSessionForNextEffect || isUnmounting)) {
        sessionRef.current = undefined;
      }
    };
  }, [
    autoConnect,
    autoReconnect,
    resolvedBaseUrl,
    resolvedToken,
    sessionEffectContext,
    sessionContextResolutionError,
    modelServiceId,
    sessionScope,
    maxQueued,
    maxBlocks,
    maxRetainedBytes,
    store,
    restoreSessionId,
    restoreSessionContext,
    restoreMode,
    restoreSessionNonce,
    attachSessionNonce,
    newSessionNonce,
    legacyClientIdDependency,
    shouldDeferInitialSessionCreation,
    clearNotices,
    addNotice,
    dismissNotice,
    setConnectionSynchronous,
  ]);

  useEffect(() => {
    if (
      !heartbeatSupportedRef.current ||
      connection.status !== 'connected' ||
      heartbeatIntervalMs <= 0 ||
      heartbeatFailureThreshold <= 0 ||
      !connection.sessionId
    ) {
      return undefined;
    }
    let disposed = false;
    const timer = setInterval(() => {
      const session = sessionRef.current;
      if (!session) return;
      if (heartbeatFailureStateRef.current.session !== session) {
        heartbeatFailureStateRef.current = {
          session,
          consecutiveFailures: 0,
        };
      }
      const heartbeatFailureState = heartbeatFailureStateRef.current;
      session
        .heartbeat()
        .then(() => {
          if (
            disposed ||
            sessionRef.current !== session ||
            heartbeatFailureStateRef.current !== heartbeatFailureState
          ) {
            return;
          }
          if (
            heartbeatFailureState.consecutiveFailures >=
            heartbeatFailureThreshold
          ) {
            setConnection((current) =>
              current.sessionId === session.sessionId
                ? {
                    ...current,
                    status: 'connected',
                    error: undefined,
                    errorStatus: undefined,
                  }
                : current,
            );
          }
          heartbeatFailureState.consecutiveFailures = 0;
          heartbeatFailureState.lastHttpError = undefined;
        })
        .catch((error: unknown) => {
          if (
            disposed ||
            sessionRef.current !== session ||
            heartbeatFailureStateRef.current !== heartbeatFailureState
          ) {
            return;
          }
          heartbeatFailureState.consecutiveFailures += 1;
          const message =
            error instanceof Error ? error.message : 'Session heartbeat failed';
          const thisErrorStatus = extractHttpStatus(error);
          if (thisErrorStatus !== undefined) {
            const lastStatus = heartbeatFailureState.lastHttpError?.status;
            heartbeatFailureState.lastHttpError = {
              status:
                resolveConnectionErrorStatus(thisErrorStatus, lastStatus) ??
                thisErrorStatus,
              message: isMissingSessionHttpStatus(lastStatus)
                ? (heartbeatFailureState.lastHttpError?.message ?? message)
                : message,
            };
          }
          if (
            heartbeatFailureState.consecutiveFailures <
            heartbeatFailureThreshold
          ) {
            return;
          }
          const errorStatus = heartbeatFailureState.lastHttpError?.status;
          const effectiveMessage =
            heartbeatFailureState.lastHttpError?.message ?? message;
          const authFailure =
            errorStatus !== undefined &&
            AUTH_FAILURE_HTTP_STATUSES.has(errorStatus);
          const missingSession = isMissingSessionHttpStatus(errorStatus);
          if (authFailure || missingSession) {
            const deadSessionId = session.sessionId;
            if (missingSession) {
              console.warn(
                '[DaemonSessionProvider] heartbeat detected missing session (sessionId=%s, status=%d)',
                deadSessionId,
                errorStatus,
              );
            } else {
              console.warn(
                '[DaemonSessionProvider] heartbeat auth failure (sessionId=%s, status=%d)',
                deadSessionId,
                errorStatus,
              );
            }
            const active = activePromptsRef.current.get(deadSessionId);
            active?.controller.abort();
            activePromptsRef.current.delete(deadSessionId);
            clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
            setPromptStatus('idle');
            if (sessionRef.current === session) {
              if (missingSession) {
                manualSessionClearRef.current = true;
              }
              sessionRef.current = undefined;
            }
          }
          setConnection((current) =>
            current.sessionId === session.sessionId
              ? {
                  ...(authFailure || missingSession
                    ? clearNonWorkspaceSessionState(current)
                    : current),
                  status: authFailure ? 'error' : 'disconnected',
                  error: effectiveMessage,
                  errorStatus: resolveConnectionErrorStatus(
                    errorStatus,
                    current.errorStatus,
                  ),
                  missingSession,
                  ...(authFailure || missingSession
                    ? {
                        sessionId: undefined,
                        context: undefined,
                        reasoning: undefined,
                        models: getWorkspaceModelsAfterSessionClear(current),
                        goalState: undefined,
                        loadingTranscript: undefined,
                        catchingUp: undefined,
                      }
                    : {}),
                }
              : current,
          );
        });
    }, heartbeatIntervalMs);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [
    connection.sessionId,
    connection.status,
    heartbeatFailureThreshold,
    heartbeatIntervalMs,
  ]);

  const actions = useMemo<DaemonSessionActions>(
    () =>
      createDaemonSessionActions({
        store,
        sessionRef,
        activePromptsRef,
        settledPromptsRef,
        pendingSessionLoadRef,
        pendingSessionLoadIdRef,
        sessionConfigGeneration: sessionConfigGenerationRef.current,
        heartbeatSupportedRef,
        manualSessionClearRef,
        skipNextCleanupDetachSessionRef,
        passiveAssistantDoneTimerRef,
        hasSessionActivePrompt: () =>
          hasCurrentSessionActivePromptRef.current(),
        resetCurrentSessionActivePrompt: () => {
          hasCurrentSessionActivePromptRef.current = () => false;
        },
        restartEventStream: (sessionId: string) => {
          const eventStream = eventStreamRef.current;
          if (eventStream?.sessionId === sessionId) {
            // Live stream: restart it only in the opt-in prompt-restart mode.
            if (!restartEventStreamOnPrompt) return;
            eventStream.restartRequested = true;
            eventStream.controller.abort();
            return;
          }
          // The stream is already down (reconnecting with backoff): a prompt
          // was submitted, so skip the remaining wait and rebuild the SSE
          // immediately so the response events land without the backoff delay.
          if (sessionRef.current?.sessionId === sessionId) {
            reconnectAbortRef.current?.abort();
          }
        },
        getCreateSessionRequest: () => ({
          ...createSessionRequestRef.current,
          sessionScope: 'thread',
          workspaceCwd:
            activeWorkspaceCwdRef.current ?? sessionRef.current?.workspaceCwd,
        }),
        createDetachedSession: (
          workspaceCwd?: string,
          overrides?: Pick<
            CreateSessionRequest,
            'approvalMode' | 'sourceType' | 'worktree' | 'branch'
          >,
        ) => {
          const client =
            workspaceClientRef.current ??
            new DaemonClient({
              baseUrl: resolvedBaseUrl!,
              token: resolvedToken,
            });
          const request = {
            ...createSessionRequestRef.current,
            sessionScope: 'thread' as const,
            workspaceCwd:
              workspaceCwd ??
              activeWorkspaceCwdRef.current ??
              sessionRef.current?.workspaceCwd,
            ...(overrides?.approvalMode !== undefined
              ? { approvalMode: overrides.approvalMode }
              : {}),
            ...(overrides?.sourceType !== undefined
              ? { sourceType: overrides.sourceType }
              : {}),
            ...(overrides?.worktree !== undefined
              ? { worktree: overrides.worktree }
              : {}),
            ...(overrides?.branch !== undefined
              ? { branch: overrides.branch }
              : {}),
          };
          const requestClientId = clientId
            ? clientIdRef.current
            : getStableClientId(undefined);
          return DaemonSessionClient.createOrAttach(
            client,
            request,
            requestClientId,
          );
        },
        createDetachedStandaloneSession: (overrides) => {
          const client =
            workspaceClientRef.current ??
            new DaemonClient({
              baseUrl: resolvedBaseUrl!,
              token: resolvedToken,
            });
          const approvalMode = resolveStandaloneApprovalMode(
            overrides?.approvalMode ??
              createSessionRequestRef.current?.approvalMode,
          );
          const modelServiceId =
            overrides?.modelServiceId ??
            createSessionRequestRef.current?.modelServiceId;
          return DaemonSessionClient.createStandalone(client, {
            ...(modelServiceId !== undefined ? { modelServiceId } : {}),
            ...(approvalMode !== undefined ? { approvalMode } : {}),
          });
        },
        getDefaultSessionContext: () => {
          const error = sessionContextResolutionErrorRef.current;
          if (error !== undefined) throw new Error(error);
          return resolvedSessionContextRef.current;
        },
        getConnection: () => connectionRef.current,
        addNotice,
        setConnection,
        setPromptStatus: (update) => {
          setPromptStatus(update);
        },
        setRestoreSessionId,
        setRestoreSessionContext,
        setRestoreMode,
        setRestoreSessionNonce,
        setAttachSessionNonce,
        setNewSessionNonce,
        clearLiveJournalRepair: () => {
          liveJournalRepairRef.current?.controller?.abort();
          liveJournalRepairRef.current = undefined;
        },
      }),
    [
      addNotice,
      clientId,
      resolvedBaseUrl,
      resolvedToken,
      restartEventStreamOnPrompt,
      store,
    ],
  );
  repairReloadRef.current = actions.reloadSession;
  useEffect(() => {
    if (promptStatus !== 'idle') return;
    queueMicrotask(() => tryLiveJournalRepairRef.current?.());
  }, [promptStatus]);
  const loadMoreTranscript = useCallback(
    async (options?: { force?: boolean }) => {
      const history = transcriptHistoryRef.current;
      const activeSession = sessionRef.current;
      if (
        history.loading ||
        !activeSession ||
        activeSession.sessionId !== history.sessionId
      ) {
        return;
      }
      if (history.paginationError) {
        if (options?.force !== true) {
          return;
        }
        // A fail-closed trim can drop both anchors. With neither cursor nor
        // beforeRecordId, the daemon defaults the request to the journal's
        // oldest page, which would be prepended below the window and re-stamp
        // a bogus anchor. Refuse to re-arm anchor-less; the affordance stays
        // closed until a later trim re-establishes an anchor.
        if (
          history.beforeRecordId === undefined &&
          history.cursor === undefined
        ) {
          return;
        }
        // The failed page's cursor was never advanced, so clearing the
        // latched error retries that exact page.
        history.paginationError = false;
        history.hasMore = true;
      } else if (!history.hasMore) {
        return;
      }

      history.loading = true;
      setTranscriptHistoryState({
        hasMore: true,
        loading: true,
        capacityReached: false,
        paginationError: false,
      });
      const fetchPaginationGeneration = paginationGenerationRef.current;
      let terminalFailure = false;
      try {
        const page = await activeSession.getTranscriptPage({
          ...(history.cursor !== undefined
            ? { cursor: history.cursor }
            : history.beforeRecordId !== undefined
              ? { beforeRecordId: history.beforeRecordId }
              : {}),
          limit: historyPageSizeRef.current ?? 100,
          clientId: activeSession.clientId,
        });
        if (
          sessionRef.current !== activeSession ||
          transcriptHistoryRef.current !== history
        ) {
          return;
        }
        if (paginationGenerationRef.current !== fetchPaginationGeneration) {
          // A retention trim re-anchored pagination while this page was in
          // flight. The page was fetched against the stale anchor; merging it
          // would advance the anchor below the evicted band and make the
          // evicted-but-persisted records unreachable. Drop it without
          // mutating pagination state — every record it carries is older
          // than the new anchor and will be re-served by the next fetch.
          history.loading = false;
          setTranscriptHistoryState({
            hasMore: history.hasMore,
            loading: false,
            capacityReached: history.capacityReached,
            paginationError: history.paginationError,
          });
          return;
        }
        if (page.partial || page.replayError) {
          terminalFailure = true;
          throw new Error(
            page.replayError ??
              'Earlier session history was only partially read',
          );
        }

        const replayOpts = {
          ...eventOptionsRef.current,
          suppressOwnUserEcho: false,
        };
        const nextBeforeRecordId = page.events
          .map(getPersistedReplayRecordId)
          .find((recordId): recordId is string => recordId !== undefined);
        const uiEvents: DaemonUiEvent[] = [];
        for (const replayEvent of page.events) {
          try {
            const transcriptEvents = filterDaemonUiEventsForTranscript(
              replayEvent,
              normalizeAndFilterEvent(
                replayEvent,
                activeSession.clientId,
                replayOpts,
                setConnection,
                { updateConnection: false },
              ),
              addNotice,
              dismissNotice,
            );
            uiEvents.push(
              ...(subagentTranscriptModeRef.current === 'summary'
                ? projectMainTranscriptEvents(transcriptEvents)
                : transcriptEvents),
            );
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            addNotice({
              severity: 'warning',
              category: 'protocol',
              operation: 'normalize_event',
              code: 'daemon.replay_event_malformed',
              message: 'Skipped malformed history event',
              debugMessage: message,
              recoverable: true,
            });
            console.warn(
              '[DaemonSessionProvider] skipped malformed history event:',
              error,
            );
          }
        }
        const admission =
          uiEvents.length > 0
            ? materializeTranscriptHistory(
                store.getSnapshot(),
                uiEvents,
                maxBlocks,
              )
            : undefined;
        if (admission && !admission.admitted) {
          if (admission.impossible) {
            // A page that alone exceeds the whole window (block count or
            // byte budget) can never be admitted in any occupancy state.
            // Surface a terminal pagination failure instead of a re-openable
            // capacity latch — otherwise every later trim would re-offer the
            // same doomed page, and everything older than it would stay
            // unreachable with no terminal signal.
            history.rejectedPage = undefined;
            terminalFailure = true;
            throw new Error(
              'Earlier history page exceeds the transcript retention window',
            );
          }
          history.hasMore = false;
          history.loading = false;
          history.capacityReached = true;
          // Remember the rejected page's footprint: the eviction re-open
          // must only fire once enough capacity has been freed for THIS page
          // to be admitted, or streaming trims churn fetch/reject/re-render.
          history.rejectedPage = {
            blocks: admission.pageBlocks,
            bytes: admission.pageBytes,
          };
          setTranscriptHistoryState({
            hasMore: false,
            loading: false,
            capacityReached: true,
            paginationError: false,
          });
          return;
        }
        const historyMaterialization = admission?.admitted
          ? admission.materialization
          : undefined;
        if (historyMaterialization) {
          history.rejectedPage = undefined;
          store.reset(
            applyTranscriptHistory(store.getSnapshot(), historyMaterialization),
          );
          const repair = liveJournalRepairRef.current;
          if (repair?.sessionId === activeSession.sessionId) {
            repair.checkpoint = applyTranscriptHistory(
              repair.checkpoint,
              historyMaterialization,
            );
          }
        }
        const hasCapacity = store.getSnapshot().blocks.length < maxBlocks;
        history.capacityReached = page.hasMore && !hasCapacity;
        history.cursor =
          nextBeforeRecordId === undefined ? page.nextCursor : undefined;
        history.beforeRecordId = nextBeforeRecordId;
        history.hasMore = page.hasMore && hasCapacity;
        history.loading = false;
        setTranscriptHistoryState({
          hasMore: history.hasMore,
          loading: false,
          capacityReached: history.capacityReached,
          paginationError: false,
        });
      } catch (error) {
        if (
          sessionRef.current !== activeSession ||
          transcriptHistoryRef.current !== history
        ) {
          return;
        }
        if (paginationGenerationRef.current !== fetchPaginationGeneration) {
          // A retention trim re-anchored — or the fail-closed branch dropped —
          // the pagination anchor while this fetch was in flight. Restoring
          // `hasMore` here would revive the load-older affordance in the
          // anchor-less state the fail-closed branch just closed, and the next
          // fetch (no cursor, no beforeRecordId) would default to the oldest
          // page and corrupt the anchor. Leave the fail-closed state intact.
          history.loading = false;
          setTranscriptHistoryState({
            hasMore: history.hasMore,
            loading: false,
            capacityReached: history.capacityReached,
            paginationError: history.paginationError,
          });
          return;
        }
        const retryable =
          !terminalFailure &&
          (!(error instanceof DaemonHttpError) ||
            error.status >= 500 ||
            error.status === 408 ||
            error.status === 429);
        history.hasMore = retryable;
        history.loading = false;
        history.capacityReached = false;
        history.paginationError = !retryable;
        setTranscriptHistoryState({
          hasMore: retryable,
          loading: false,
          capacityReached: false,
          paginationError: !retryable,
        });
        if (retryable) {
          addNotice({
            severity: 'warning',
            category: 'user_action',
            operation: 'load_session',
            code: 'daemon.transcript_history.failed',
            message: 'Failed to load earlier session history',
            debugMessage:
              error instanceof Error ? error.message : String(error),
            recoverable: retryable,
          });
        }
        throw error;
      } finally {
        tryLiveJournalRepairRef.current?.();
      }
    },
    [addNotice, dismissNotice, maxBlocks, store],
  );
  const transcriptHistoryValue = useMemo<DaemonTranscriptHistory>(() => {
    const active =
      connection.sessionId === transcriptHistoryRef.current.sessionId &&
      sessionRef.current?.sessionId === transcriptHistoryRef.current.sessionId;
    return {
      hasMore: active && transcriptHistoryState.hasMore,
      loading: active && transcriptHistoryState.loading,
      capacityReached: active && transcriptHistoryState.capacityReached,
      paginationError: active && transcriptHistoryState.paginationError,
      loadMore: loadMoreTranscript,
    };
  }, [connection.sessionId, loadMoreTranscript, transcriptHistoryState]);
  const lastHandledSessionIdRef = useRef<
    string | undefined | typeof UNHANDLED_SESSION
  >(UNHANDLED_SESSION);
  const lastHandledSessionContextRef = useRef<
    DaemonProductSessionContext | undefined
  >(undefined);
  const lastHandledClientIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (sessionContextResolutionError) return;
    const targetSessionContext =
      resolvedSessionContext ??
      // A failed controlled load leaves the target's workspace on the
      // connection for error rendering; never feed it back into the next
      // workspace-less switch.
      (connectionRef.current.error
        ? undefined
        : connectionRef.current.sessionContext);
    if (
      lastHandledSessionIdRef.current === sessionId &&
      sessionContextKey(lastHandledSessionContextRef.current) ===
        sessionContextKey(targetSessionContext) &&
      lastHandledClientIdRef.current === clientId
    ) {
      return;
    }
    lastHandledSessionIdRef.current = sessionId;
    lastHandledSessionContextRef.current = targetSessionContext;
    lastHandledClientIdRef.current = clientId;

    const currentSessionId = connectionRef.current.sessionId;
    if (
      sessionId === currentSessionId &&
      sessionContextKey(targetSessionContext) ===
        sessionContextKey(connectionRef.current.sessionContext) &&
      !connectionRef.current.standaloneSession?.creationRecovery
    ) {
      return;
    }
    setRestoreSessionContext(targetSessionContext);

    const request = sessionId
      ? actions.loadSession(sessionId, {
          ...(targetSessionContext !== undefined
            ? { sessionContext: targetSessionContext }
            : {}),
        })
      : currentSessionId
        ? actions.clearSession()
        : undefined;

    if (!request) return;

    void request.catch((error: unknown) => {
      console.warn(
        '[DaemonSessionProvider] controlled session transition failed:',
        error,
      );
    });
  }, [
    actions,
    clientId,
    resolvedSessionContext,
    sessionContextResolutionError,
    sessionId,
  ]);

  const ownerGuardValue = useMemo<DaemonSessionOwnerGuard>(
    () => ({
      capture: () => {
        const session = sessionRef.current;
        return { isCurrent: () => sessionRef.current === session };
      },
    }),
    [],
  );

  return (
    <DaemonStoreContext.Provider value={store}>
      <DaemonConnectionContext.Provider value={connection}>
        <DaemonPromptStatusContext.Provider value={promptStatus}>
          <DaemonSessionNoticesContext.Provider value={noticesValue}>
            <DaemonWorkspaceEventSignalsContext.Provider
              value={workspaceEventSignals}
            >
              <DaemonActionsContext.Provider value={actions}>
                <DaemonSessionOwnerGuardContext.Provider
                  value={ownerGuardValue}
                >
                  <DaemonTranscriptHistoryContext.Provider
                    value={transcriptHistoryValue}
                  >
                    {children}
                  </DaemonTranscriptHistoryContext.Provider>
                </DaemonSessionOwnerGuardContext.Provider>
              </DaemonActionsContext.Provider>
            </DaemonWorkspaceEventSignalsContext.Provider>
          </DaemonSessionNoticesContext.Provider>
        </DaemonPromptStatusContext.Provider>
      </DaemonConnectionContext.Provider>
    </DaemonStoreContext.Provider>
  );
}

/**
 * Settle the session's active prompt from a `turn_complete` / `turn_error`
 * event. Dispatches `assistant.done` directly on `store`, so callers that have
 * buffered (batched) transcript events must flush them first
 * (`flushTranscriptSync()`) — otherwise `assistant.done` is applied ahead of
 * the turn's still-buffered transcript content.
 */
function settleActivePromptFromTurnEvent(
  activePrompts: Map<string, ActivePrompt>,
  settledPrompts: Map<string, SettledPrompt>,
  sessionId: string,
  event: DaemonEvent,
  store: DaemonTranscriptStore,
  setPromptStatus: Dispatch<SetStateAction<DaemonPromptStatus>>,
  passiveAssistantDoneTimerRef: TimerRef,
  opts: { requireBoundPromptId?: boolean } = {},
): boolean {
  if (event.type !== 'turn_complete' && event.type !== 'turn_error') {
    return false;
  }
  const promptId = (event.data as { promptId?: string } | null | undefined)
    ?.promptId;
  if (!promptId) return false;
  const active = activePrompts.get(sessionId);
  if (!active) return false;
  if (opts.requireBoundPromptId && active.promptId === undefined) {
    return false;
  }
  if (active.promptId !== undefined && active.promptId !== promptId) {
    return false;
  }

  clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
  try {
    const result = matchTurnEvent(event, promptId);
    if (!result) return false;
    store.dispatch(assistantDoneFromTurnEvent(event, result.stopReason));
    setPromptStatus('idle');
    if (active.resolve) {
      activePrompts.delete(sessionId);
      active.resolve(result);
    } else {
      activePrompts.delete(sessionId);
      settledPrompts.set(getPromptSettledKey(sessionId, promptId), {
        status: 'resolved',
        result,
      });
    }
  } catch (error) {
    store.dispatch(assistantDoneFromTurnEvent(event, 'error'));
    setPromptStatus('idle');
    if (active.reject) {
      activePrompts.delete(sessionId);
      active.reject(error);
    } else {
      activePrompts.delete(sessionId);
      settledPrompts.set(getPromptSettledKey(sessionId, promptId), {
        status: 'rejected',
        error,
      });
    }
  }
  return true;
}

function isPromptLifecycleTurnEvent(event: DaemonEvent): boolean {
  return event.type === 'turn_complete';
}

function normalizeAndFilterEvent(
  event: DaemonEvent,
  clientId: string | undefined,
  opts: { suppressOwnUserEcho: boolean; includeRawEvent: boolean },
  setConnection: Dispatch<SetStateAction<DaemonConnectionState>>,
  behavior: { updateConnection?: boolean; suppressLog?: boolean } = {},
): DaemonUiEvent[] {
  if (!behavior.suppressLog) {
    logSettingsReloadEvent(event);
  }
  if (behavior.updateConnection !== false) {
    updateConnectionFromDaemonEvent(event, setConnection);
  }
  const normalized = normalizeDaemonEvent(event, {
    clientId,
    suppressOwnUserEcho: opts.suppressOwnUserEcho,
    includeRawEvent: opts.includeRawEvent,
  });
  const goalStatusEvent = normalizeGoalStatusEvent(event);
  if (isPromptLifecycleTurnEvent(event)) {
    return goalStatusEvent ? [goalStatusEvent] : [];
  }
  return goalStatusEvent ? [...normalized, goalStatusEvent] : normalized;
}

function logSettingsReloadEvent(event: DaemonEvent): void {
  if (event.type !== 'settings_reloaded') return;
  console.debug(
    '[DaemonSessionProvider] settings reloaded:',
    getSettingsReloadLogData(event),
  );
}

function getSettingsReloadLogData(event: DaemonEvent): Record<string, unknown> {
  const log: Record<string, unknown> = {};
  if (event.id !== undefined) log['eventId'] = event.id;
  if (!isRecord(event.data)) {
    log['payload'] = 'non-object';
    return log;
  }

  const env = getSettingsReloadEnvLog(event.data['env']);
  const changedKeys = getStringArray(event.data['changedKeys']);
  const sessionsRefreshed = getStringArray(event.data['sessionsRefreshed']);
  const sessionsSkipped = getStringArray(event.data['sessionsSkipped']);
  const childReloaded = event.data['childReloaded'];
  const childError = getString(event.data, 'childError');

  if (env) log['env'] = env;
  if (changedKeys) log['changedKeys'] = changedKeys;
  if (typeof childReloaded === 'boolean') log['childReloaded'] = childReloaded;
  if (sessionsRefreshed) log['sessionsRefreshed'] = sessionsRefreshed;
  if (sessionsSkipped) log['sessionsSkipped'] = sessionsSkipped;
  if (childError) log['childError'] = childError;
  return log;
}

function getSettingsReloadEnvLog(
  value: unknown,
): { updatedKeys: string[]; removedKeys: string[] } | undefined {
  if (!isRecord(value)) return undefined;
  return {
    updatedKeys: getStringArray(value['updatedKeys']) ?? [],
    removedKeys: getStringArray(value['removedKeys']) ?? [],
  };
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function filterDaemonUiEventsForTranscript(
  sourceEvent: DaemonEvent,
  events: DaemonUiEvent[],
  addNotice: AddDaemonSessionNotice,
  dismissNotice: (id: string) => void,
  behavior: {
    hideHistoryTruncation?: boolean;
    suppressSideEffects?: boolean;
  } = {},
): DaemonUiEvent[] {
  if (behavior.hideHistoryTruncation && isHistoricalReplayMarker(sourceEvent)) {
    return [];
  }
  if (
    !behavior.suppressSideEffects &&
    sourceEvent.type === 'session_snapshot' &&
    isRecord(sourceEvent.data) &&
    sourceEvent.data['recordingDegraded'] === false
  ) {
    const sessionId = getString(sourceEvent.data, 'sessionId');
    if (sessionId) {
      dismissNotice(`daemon.session_recording_degraded:${sessionId}`);
    }
  }
  const filtered: DaemonUiEvent[] = [];
  for (const event of events) {
    if (event.type !== 'error') {
      filtered.push(event);
      continue;
    }
    if (sourceEvent.type === 'turn_error') {
      filtered.push(event);
      continue;
    }
    if (behavior.suppressSideEffects) continue;
    const notice = addNotice(
      daemonErrorEventToNotice(sourceEvent, event as DaemonUiErrorEvent),
    );
    if (notice.category === 'protocol' || notice.category === 'connection') {
      console.warn('[DaemonSessionProvider] daemon notice:', notice);
    }
  }
  return filtered;
}

type DaemonUiErrorEvent = Extract<DaemonUiEvent, { type: 'error' }>;

function daemonErrorEventToNotice(
  sourceEvent: DaemonEvent,
  event: DaemonUiErrorEvent,
): SessionNoticeInput {
  const base = {
    message: event.text,
    debugMessage: event.text,
    recoverable: event.recoverable,
  };

  switch (sourceEvent.type) {
    case 'session_recording_degraded':
    case 'session_snapshot': {
      const sessionId = isRecord(sourceEvent.data)
        ? getString(sourceEvent.data, 'sessionId')
        : undefined;
      return {
        ...base,
        ...(sessionId
          ? { id: `daemon.session_recording_degraded:${sessionId}` }
          : {}),
        severity: 'warning',
        category: 'system',
        operation: 'record_session',
        code: 'daemon.session_recording_degraded',
      };
    }
    case 'model_switch_failed':
      return {
        ...base,
        severity: 'error',
        category: 'user_action',
        operation: 'switch_model',
        code: 'daemon.switch_model.failed',
      };
    case 'session_died':
      return {
        ...base,
        severity: 'error',
        category: 'connection',
        operation: 'stream',
        code: event.errorKind ?? 'daemon.session_died',
      };
    case 'client_evicted':
      return {
        ...base,
        severity: 'warning',
        category: 'connection',
        operation: 'stream',
        code: 'daemon.client_evicted',
      };
    case 'stream_error':
      return {
        ...base,
        severity: 'warning',
        category: 'connection',
        operation: 'stream',
        code: event.errorKind ?? 'daemon.stream_error',
      };
    default:
      return {
        ...base,
        severity: 'warning',
        category: 'protocol',
        operation: 'normalize_event',
        code: event.code ?? 'daemon.protocol.error',
      };
  }
}

export function useDaemonSession(): DaemonSessionContextValue {
  return {
    store: useDaemonTranscriptStore(),
    connection: useDaemonConnection(),
    promptStatus: useDaemonPromptStatus(),
    actions: useDaemonActions(),
  };
}

export function useDaemonTranscriptStore(): DaemonTranscriptStore {
  const store = useContext(DaemonStoreContext);
  if (!store) {
    throw new Error(
      'useDaemonTranscriptStore must be used within DaemonSessionProvider',
    );
  }
  return store;
}

export function useDaemonTranscriptHistory(): DaemonTranscriptHistory {
  const history = useContext(DaemonTranscriptHistoryContext);
  if (!history) {
    throw new Error(
      'useDaemonTranscriptHistory must be used within DaemonSessionProvider',
    );
  }
  return history;
}

export function useDaemonTranscriptState(): DaemonTranscriptState {
  const store = useDaemonTranscriptStore();
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

export function useDaemonTranscriptBlocks(): readonly DaemonTranscriptBlock[] {
  const store = useDaemonTranscriptStore();
  const getBlocks = useCallback(() => store.getSnapshot().blocks, [store]);
  return useSyncExternalStore(store.subscribe, getBlocks, getBlocks);
}

export function useDaemonPendingPermissions() {
  // wenshao R5 (qwen3.7-max): subscribe at the blocks level instead of
  // the full transcript state. `selectPendingPermissionBlocks` reads
  // only `state.blocks`; subscribing to the full state caused this
  // hook to re-render on every daemon event (text deltas, tool
  // updates, sidechannel changes) even when blocks were unchanged.
  const blocks = useDaemonTranscriptBlocks();
  return useMemo(() => selectDaemonPendingPermissions(blocks), [blocks]);
}

export function useDaemonActiveTodoList() {
  const blocks = useDaemonTranscriptBlocks();
  return useMemo(() => selectDaemonActiveTodoList(blocks), [blocks]);
}

export function useDaemonStreamingState() {
  const store = useDaemonTranscriptStore();
  const promptStatus = useDaemonPromptStatus();
  const getStreamingState = useCallback(
    () => selectDaemonStreamingState(store.getSnapshot().blocks, promptStatus),
    [promptStatus, store],
  );
  return useSyncExternalStore(
    store.subscribe,
    getStreamingState,
    getStreamingState,
  );
}

export function useDaemonActions(): DaemonSessionActions {
  const actions = useContext(DaemonActionsContext);
  if (!actions) {
    throw new Error(
      'useDaemonActions must be used within DaemonSessionProvider',
    );
  }
  return actions;
}

export function useOptionalDaemonActions(): DaemonSessionActions | undefined {
  return useContext(DaemonActionsContext);
}

export function useDaemonSessionOwnerGuard(): DaemonSessionOwnerGuard {
  const guard = useContext(DaemonSessionOwnerGuardContext);
  if (!guard) {
    throw new Error(
      'useDaemonSessionOwnerGuard must be used within DaemonSessionProvider',
    );
  }
  return guard;
}

export function useDaemonWorkspaceEventSignals():
  | DaemonWorkspaceEventSignals
  | undefined {
  return useContext(DaemonWorkspaceEventSignalsContext);
}

export function useDaemonPromptStatus(): DaemonPromptStatus {
  const promptStatus = useContext(DaemonPromptStatusContext);
  if (!promptStatus) {
    throw new Error(
      'useDaemonPromptStatus must be used within DaemonSessionProvider',
    );
  }
  return promptStatus;
}

export function useDaemonConnection(): DaemonConnectionState {
  const connection = useContext(DaemonConnectionContext);
  if (!connection) {
    throw new Error(
      'useDaemonConnection must be used within DaemonSessionProvider',
    );
  }
  return connection;
}

export function useDaemonSessionNotices(): {
  notices: readonly DaemonSessionNotice[];
  dismissNotice(id: string): void;
  clearNotices(): void;
} {
  const value = useContext(DaemonSessionNoticesContext);
  if (!value) {
    throw new Error(
      'useDaemonSessionNotices must be used within DaemonSessionProvider',
    );
  }
  return value;
}

function hasActiveGenerationSignal(
  events: ReadonlyArray<{ type: string }>,
): boolean {
  return events.some(
    (event) =>
      event.type === 'assistant.text.delta' ||
      event.type === 'thought.text.delta' ||
      event.type === 'tool.update',
  );
}

function normalizeGoalStatusEvent(event: DaemonEvent): DaemonUiEvent | null {
  if (event.type !== 'session_update') return null;
  const data = isRecord(event.data) ? event.data : undefined;
  const update = isRecord(data?.['update'])
    ? data['update']
    : isRecord(event.data)
      ? event.data
      : undefined;
  if (!update || update['sessionUpdate'] !== 'agent_message_chunk') {
    return null;
  }
  const meta = update['_meta'];
  if (!isRecord(meta)) return null;
  const status = normalizeGoalStatus(meta['goalStatus']);
  if (status) {
    return createGoalStatusUiEvent(event, status);
  }

  const terminal = normalizeGoalTerminal(meta['goalTerminal']);
  if (terminal) {
    return createGoalStatusUiEvent(event, terminal);
  }

  const loop = meta['stopHookLoop'];
  if (!isRecord(loop)) return null;
  const goal = loop['goal'];
  if (!isRecord(goal)) return null;
  const condition = getString(goal, 'condition');
  if (!condition) return null;

  // Suppress per-iteration "checking" events from the transcript to avoid
  // flooding with one card per stop-hook turn. The active goal state is
  // already visible in the status bar; only terminal events and the initial
  // "set" event are shown as transcript cards.
  return null;
}

function createGoalStatusUiEvent(
  event: DaemonEvent,
  status: Record<string, unknown>,
): DaemonUiEvent {
  return {
    type: 'status',
    ...(event.id !== undefined ? { eventId: event.id } : {}),
    ...(event.originatorClientId
      ? { originatorClientId: event.originatorClientId }
      : {}),
    text: '',
    source: 'goal',
    data: status,
  };
}

function normalizeGoalStatus(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const kind = getString(value, 'kind');
  if (
    kind !== 'set' &&
    kind !== 'cleared' &&
    kind !== 'achieved' &&
    kind !== 'failed' &&
    kind !== 'aborted' &&
    // Rejecting 'paused' made every surface keep showing a paused goal as
    // actively running: the card never rendered and the active-goal
    // derivation fell back to the previous 'set' card.
    kind !== 'paused'
  ) {
    return null;
  }
  const condition = getString(value, 'condition');
  if (!condition) return null;
  const iterations = getNumber(value, 'iterations');
  const durationMs = getNumber(value, 'durationMs');
  const setAt = getNumber(value, 'setAt');
  const lastReason = getString(value, 'lastReason');
  return {
    kind,
    condition,
    ...(iterations !== undefined ? { iterations } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(setAt !== undefined ? { setAt } : {}),
    ...(lastReason ? { lastReason } : {}),
  };
}

function normalizeGoalTerminal(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const kind = getString(value, 'kind');
  if (kind !== 'achieved' && kind !== 'failed' && kind !== 'aborted') {
    return null;
  }
  const condition = getString(value, 'condition');
  if (!condition) return null;
  const iterations = getNumber(value, 'iterations');
  const durationMs = getNumber(value, 'durationMs');
  const lastReason = getString(value, 'lastReason');
  return {
    kind,
    condition,
    ...(iterations !== undefined ? { iterations } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(lastReason ? { lastReason } : {}),
  };
}

function getString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = value[key];
  return typeof raw === 'string' ? raw : undefined;
}

function getNumber(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const raw = value[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function bumpWorkspaceEventSignals(
  events: readonly DaemonUiEvent[],
  setSignals: Dispatch<SetStateAction<DaemonWorkspaceEventSignals>>,
  workspaceCwd: string,
): void {
  let memory = 0;
  let agents = 0;
  let tools = 0;
  let settings = 0;
  const skillMutations: Array<
    NonNullable<DaemonWorkspaceEventSignals['lastSkillMutation']>
  > = [];
  const seenSkillMutationIds = new Set<string>();
  let mcp = 0;
  let extensions = 0;
  let artifacts = 0;
  let lastExtensionChange:
    | DaemonWorkspaceEventSignals['lastExtensionChange']
    | undefined;
  let init = 0;
  let auth = 0;

  for (const event of events) {
    switch (event.type) {
      case 'workspace.memory.changed':
        memory += 1;
        break;
      case 'workspace.agent.changed':
        agents += 1;
        break;
      case 'workspace.tool.toggled':
        tools += 1;
        break;
      case 'workspace.settings.changed':
        if (event.mutation?.kind === 'skill_toggle') {
          if (!seenSkillMutationIds.has(event.mutation.id)) {
            seenSkillMutationIds.add(event.mutation.id);
            skillMutations.push(event.mutation);
          }
        } else {
          settings += 1;
        }
        break;
      case 'workspace.mcp.budget_warning':
      case 'workspace.mcp.child_refused':
      case 'workspace.mcp.server_restarted':
      case 'workspace.mcp.server_restart_refused':
      case 'workspace.mcp.server_changed':
        mcp += 1;
        break;
      case 'workspace.extensions.changed':
        extensions += 1;
        lastExtensionChange = {
          ...(event.status ? { status: event.status } : {}),
          ...(event.source ? { source: event.source } : {}),
          ...(event.name ? { name: event.name } : {}),
          ...(event.version ? { version: event.version } : {}),
          ...(event.error ? { error: event.error } : {}),
          refreshed: event.refreshed,
          failed: event.failed,
        };
        break;
      case 'session.artifact.changed':
        artifacts += 1;
        break;
      case 'workspace.initialized':
        init += 1;
        break;
      case 'auth.device_flow.started':
      case 'auth.device_flow.throttled':
      case 'auth.device_flow.authorized':
      case 'auth.device_flow.failed':
      case 'auth.device_flow.cancelled':
        auth += 1;
        break;
      default:
        break;
    }
  }

  if (
    memory +
      agents +
      tools +
      settings +
      mcp +
      extensions +
      artifacts +
      init +
      auth ===
      0 &&
    skillMutations.length === 0
  )
    return;

  setSignals((current) => {
    const existing = current.skillMutationsByCwd?.[workspaceCwd] ?? [];
    const existingIds = new Set(existing.map((mutation) => mutation.id));
    const newSkillMutations = skillMutations.filter(
      (mutation) => !existingIds.has(mutation.id),
    );
    if (
      memory +
        agents +
        tools +
        settings +
        mcp +
        extensions +
        artifacts +
        init +
        auth ===
        0 &&
      newSkillMutations.length === 0
    ) {
      return current;
    }
    return {
      memoryVersion: current.memoryVersion + memory,
      agentsVersion: current.agentsVersion + agents,
      toolsVersion: current.toolsVersion + tools,
      settingsVersion: current.settingsVersion + settings,
      skillsVersion: current.skillsVersion + newSkillMutations.length,
      mcpVersion: current.mcpVersion + mcp,
      extensionsVersion: current.extensionsVersion + extensions,
      artifactsVersion: current.artifactsVersion + artifacts,
      ...(newSkillMutations.length > 0
        ? { lastSkillMutation: newSkillMutations.at(-1) }
        : current.lastSkillMutation
          ? { lastSkillMutation: current.lastSkillMutation }
          : {}),
      ...(newSkillMutations.length > 0
        ? {
            skillMutationsByCwd: {
              ...current.skillMutationsByCwd,
              [workspaceCwd]: [...existing, ...newSkillMutations],
            },
          }
        : current.skillMutationsByCwd
          ? { skillMutationsByCwd: current.skillMutationsByCwd }
          : {}),
      ...(lastExtensionChange ? { lastExtensionChange } : {}),
      initVersion: current.initVersion + init,
      authVersion: current.authVersion + auth,
    };
  });
}

function isTerminalSessionHttpError(error: unknown): boolean {
  const status = extractHttpStatus(error);
  return status !== undefined && TERMINAL_SESSION_HTTP_STATUSES.has(status);
}

function isAuthFailureHttpError(error: unknown): boolean {
  const status = extractHttpStatus(error);
  return status !== undefined && AUTH_FAILURE_HTTP_STATUSES.has(status);
}

function isClosingSessionLoadError(
  error: unknown,
  allowLegacyMessage = false,
): boolean {
  if (!(error instanceof DaemonHttpError) || error.status !== 404) return false;
  const body = isRecord(error.body) ? error.body : undefined;
  return (
    body?.['code'] === 'session_closing' ||
    (allowLegacyMessage &&
      typeof body?.['error'] === 'string' &&
      body['error'].endsWith(
        'The session is closing; retry after close completes',
      ))
  );
}

function isRestoreInProgressLoadError(
  error: unknown,
): error is DaemonHttpError {
  if (!(error instanceof DaemonHttpError) || error.status !== 409) return false;
  const body = isRecord(error.body) ? error.body : undefined;
  return body?.['code'] === 'restore_in_progress';
}

function getRestoreInProgressRetryDelayMs(error: unknown): number | undefined {
  if (!isRestoreInProgressLoadError(error)) return undefined;
  const body = isRecord(error.body) ? error.body : undefined;
  if (
    body?.['retryable'] !== true ||
    body['reason'] === 'awaiting_abandoned_cleanup'
  ) {
    return undefined;
  }
  const retryAfterSeconds = body['retryAfterSeconds'];
  return typeof retryAfterSeconds === 'number' &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
    ? Math.min(
        Math.ceil(retryAfterSeconds * 1000),
        RESTORE_IN_PROGRESS_RETRY_MAX_MS,
      )
    : 5000;
}
