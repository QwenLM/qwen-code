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
  DaemonClient,
  DaemonHttpError,
  DaemonSessionClient,
  createDaemonTranscriptStore,
  extractServerTimestamp,
  matchTurnEvent,
  normalizeDaemonEvent,
  type CreateSessionRequest,
  type DaemonCapabilities,
  type DaemonEvent,
  type DaemonFollowupSuggestionData,
  type DaemonSseConnectReason,
  type DaemonTranscriptBlock,
  type DaemonTranscriptState,
  type DaemonTranscriptStore,
  type DaemonTurnCompleteData,
  type DaemonUiEvent,
} from '@qwen-code/sdk/daemon';
import {
  createDaemonSessionActions,
  getPromptSettledKey,
  normalizeWorkspaceIdentity,
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
import { useOptionalDaemonWorkspace } from '../workspace/DaemonWorkspaceProvider.js';
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
  clearSidechannelFollowupSuggestion,
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
  DaemonSessionProviderProps,
  DaemonSessionOwnerGuard,
  DaemonWorkspaceEventSignals,
  PendingSessionLoad,
  SettledPrompt,
} from './types.js';

export type {
  DaemonCommandInfo,
  DaemonConnectionState,
  DaemonConnectionStatus,
  DaemonModelInfo,
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
  toolBlockByCallId: Record<string, string>;
  permissionBlockByRequestId: Record<string, string>;
}
type TranscriptHistoryState = Omit<DaemonTranscriptHistory, 'loadMore'> & {
  sessionId?: string;
  beforeRecordId?: string;
  cursor?: string;
};
interface SessionRunnerControl {
  session?: DaemonSessionClient;
  capture?: SameSessionCapture;
  flush(): void;
  stop(): void;
  snapshot(): SessionRunnerSnapshot;
}
interface SessionRunnerSnapshot {
  session?: DaemonSessionClient;
  clientId?: string;
  eventEpoch?: string;
  processedEventId?: number;
  lastPromptTerminalEventId?: number;
  ready: boolean;
  activeTurn: boolean;
}
interface SameSessionCapture {
  source: DaemonSessionClient;
  sourceClientId: string;
  eventEpoch: string;
  startEventId: number;
  lastCapturedEventId: number;
  bytes: number;
  events: DaemonEvent[];
  invalidReason?: string;
}
interface PreparedRunnerHandoff {
  session: DaemonSessionClient;
  capabilities: DaemonCapabilities;
}
interface StagedCrossSession {
  session: DaemonSessionClient;
  capabilities: DaemonCapabilities;
  connection: DaemonConnectionState;
  transcript: DaemonTranscriptState;
  history: TranscriptHistoryState;
  signals: DaemonWorkspaceEventSignals;
  notices: SessionNoticeInput[];
  dismissNoticeIds: Set<string>;
  followupSuggestion?: DaemonFollowupSuggestionData;
  midTurnEvents: DaemonEvent[];
  pendingPromptEvents: DaemonEvent[];
  repair?: LiveJournalRepairEpisode;
}
interface CrossSessionTarget {
  sessionId: string;
  workspaceCwd?: string;
  targetClientId?: string;
  mode: 'load' | 'resume';
  origin: 'action' | 'controlled';
  sameLogical?: boolean;
  signal?: AbortSignal;
}
interface CrossSessionIntent extends CrossSessionTarget {
  key: string;
  effectiveHistoryPageSize?: number;
  resultSuperseded?: true;
  source: DaemonSessionClient;
  baseUrl: string;
  token?: string;
  lifecycle: number;
  environmentGeneration: number;
  deadlineAt?: number;
  timeout?: ReturnType<typeof setTimeout>;
  retryAttempt?: number;
  sourceClientId: string;
  capture?: SameSessionCapture;
  candidate?: DaemonSessionClient;
  candidateCapabilities?: DaemonCapabilities;
  deadlineStarted?: true;
  removeAbortListener?: () => void;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}
const SESSION_TRANSCRIPT_PAGINATION_FEATURE = 'session_transcript_pagination';
const CLIENT_IDENTITY_FEATURE = 'client_identity';
const WORKSPACE_ACP_PREHEAT_FEATURE = 'workspace_acp_preheat';
const WORKSPACE_ACP_STATUS_FEATURE = 'workspace_acp_status';
const STAGING_BATCH_SIZE = 512;
const SAME_SESSION_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();
function crossSessionKey(
  sessionId: string,
  workspaceCwd: string | undefined,
  mode: CrossSessionTarget['mode'],
  historyPageSize: number | undefined,
  clientId: string | undefined,
): string {
  const replayShape =
    mode === 'resume'
      ? 'resume:none'
      : historyPageSize === undefined
        ? 'load:all'
        : `load:recent:${historyPageSize}`;
  return `${sessionId}\0${normalizeWorkspaceIdentity(workspaceCwd)}\0${replayShape}\0${clientId ?? ''}`;
}
function transitionState(
  target: CrossSessionTarget,
  phase: 'queued' | 'preparing' | 'failed',
  error?: NonNullable<DaemonConnectionState['sessionTransition']>['error'],
): NonNullable<DaemonConnectionState['sessionTransition']> {
  return {
    phase,
    operation: target.mode,
    origin: target.origin,
    targetSessionId: target.sessionId,
    targetWorkspaceCwd: target.workspaceCwd,
    targetClientId: target.targetClientId,
    ...(error ? { error } : {}),
  };
}
function settleCrossSessionIntent(
  intent: CrossSessionIntent,
  error?: unknown,
): void {
  if (intent.timeout !== undefined) clearTimeout(intent.timeout);
  intent.removeAbortListener?.();
  intent.removeAbortListener = undefined;
  if (error === undefined) intent.resolve();
  else intent.reject(error);
}
function findFirstPersistedRecordId(
  session: DaemonSessionClient,
): string | undefined {
  for (const type of ['session_update', 'history_truncated'] as const) {
    for (const events of [
      session.replaySnapshot.compactedReplay,
      session.replaySnapshot.liveJournal,
    ]) {
      for (const event of events) {
        if (event.type !== type) continue;
        const id = getPersistedReplayRecordId(event);
        if (id !== undefined) return id;
      }
    }
  }
  return session.historyAnchorRecordId;
}

function stageCrossSession(input: {
  session: DaemonSessionClient;
  capabilities: DaemonCapabilities;
  maxBlocks: number;
  subagentTranscriptMode: 'full' | 'summary';
  eventOptions: { suppressOwnUserEcho: boolean; includeRawEvent: boolean };
  additionalEvents?: readonly DaemonEvent[];
}): StagedCrossSession {
  const { session, capabilities, maxBlocks, subagentTranscriptMode } = input;
  const notices: SessionNoticeInput[] = [];
  const dismissNoticeIds = new Set<string>();
  let noticeId = 0;
  const addStagedNotice: AddDaemonSessionNotice = (notice) => {
    const stagedNotice = {
      ...notice,
      id: notice.id ?? `staged-daemon-notice-${++noticeId}`,
      createdAt: notice.createdAt ?? Date.now(),
    };
    const existingIndex = notices.findIndex(
      (existing) => existing.id === stagedNotice.id,
    );
    if (!dismissNoticeIds.delete(stagedNotice.id) && existingIndex >= 0)
      return stagedNotice;
    if (existingIndex >= 0) notices.splice(existingIndex, 1);
    notices.push(stagedNotice);
    if (notices.length > 50) notices.shift();
    return stagedNotice;
  };
  let connection: DaemonConnectionState = {
    status: 'connected',
    sessionId: session.sessionId,
    ...(session.clientId ? { clientId: session.clientId } : {}),
    workspaceCwd: session.workspaceCwd,
    displayName: getSessionDisplayName(session.state),
    capabilities,
    catchingUp: session.lastEventId !== undefined ? true : undefined,
  };
  const updateConnection: Dispatch<SetStateAction<DaemonConnectionState>> = (
    update,
  ) => {
    connection = typeof update === 'function' ? update(connection) : update;
  };
  let signals = { ...INITIAL_WORKSPACE_EVENT_SIGNALS };
  const updateSignals: Dispatch<SetStateAction<DaemonWorkspaceEventSignals>> = (
    update,
  ) => {
    signals = typeof update === 'function' ? update(signals) : update;
  };
  const shadow = createDaemonTranscriptStore({
    maxBlocks: Number.MAX_SAFE_INTEGER,
    retainSubagentBlocks: subagentTranscriptMode === 'full',
  });
  let transcriptBatch: DaemonUiEvent[] = [];
  const repairTarget = findLiveJournalRepairTarget(
    session.sessionId,
    session.replaySnapshot.liveJournal,
    session.lastEventId,
    session.replayDegraded === true,
  );
  let repairCheckpoint: DaemonTranscriptState | undefined;
  const midTurnEvents: DaemonEvent[] = [];
  const pendingPromptEvents: DaemonEvent[] = [];
  let followupSuggestion: DaemonFollowupSuggestionData | undefined;
  const observedSnapshotEventIds = new Set<number>();
  const flush = () => {
    if (transcriptBatch.length === 0) return;
    shadow.dispatch(transcriptBatch);
    transcriptBatch = [];
  };
  const enqueueTranscript = (events: readonly DaemonUiEvent[]) => {
    for (const uiEvent of events) {
      transcriptBatch.push(uiEvent);
      if (transcriptBatch.length === STAGING_BATCH_SIZE) flush();
    }
  };
  const firstPersistedRecordId = findFirstPersistedRecordId(session);
  const replayWasTruncated =
    session.replaySnapshot.compactedReplay.some(
      hasFullTranscriptBeforeReplay,
    ) || session.replaySnapshot.liveJournal.some(hasFullTranscriptBeforeReplay);
  const historyHasMore =
    capabilities.features.includes(SESSION_TRANSCRIPT_PAGINATION_FEATURE) &&
    (session.historyHasMore || replayWasTruncated) &&
    firstPersistedRecordId !== undefined;
  const replayOpts = {
    ...input.eventOptions,
    suppressOwnUserEcho: false,
  };
  const consume = (event: DaemonEvent) => {
    try {
      const normalized = normalizeAndFilterEvent(
        event,
        session.clientId,
        replayOpts,
        updateConnection,
        { suppressLog: true },
      );
      bumpWorkspaceEventSignals(normalized, updateSignals);
      let transcript = filterDaemonUiEventsForTranscript(
        event,
        normalized,
        addStagedNotice,
        (id) => dismissNoticeIds.add(id),
        { hideHistoryTruncation: historyHasMore, suppressLogs: true },
      );
      if (subagentTranscriptMode === 'summary') {
        transcript = projectMainTranscriptEvents(transcript);
      }
      enqueueTranscript(transcript);
      if (event.type === 'turn_complete') {
        enqueueTranscript([
          assistantDoneFromTurnEvent(
            event,
            (event.data as DaemonTurnCompleteData | undefined)?.stopReason ??
              'end_turn',
          ),
        ]);
      } else if (event.type === 'turn_error') {
        enqueueTranscript([assistantDoneFromTurnEvent(event, 'error')]);
      }
      if (parseSidechannelMidTurnInjected(event)) {
        midTurnEvents.push(event);
        if (midTurnEvents.length > 64) midTurnEvents.shift();
      }
      followupSuggestion =
        parseSidechannelFollowupSuggestion(event) ?? followupSuggestion;
      if (isPendingPromptEvent(event)) {
        pendingPromptEvents.push(event);
        if (pendingPromptEvents.length > 200) pendingPromptEvents.shift();
      }
    } catch (error) {
      addStagedNotice({
        severity: 'warning',
        category: 'protocol',
        operation: 'normalize_event',
        code: 'daemon.replay_event_malformed',
        message: 'Skipped malformed replay event',
        debugMessage: error instanceof Error ? error.message : String(error),
        recoverable: true,
      });
    }
  };
  for (const event of session.replaySnapshot.compactedReplay) consume(event);
  for (const event of session.replaySnapshot.liveJournal) {
    if (event.id !== undefined) observedSnapshotEventIds.add(event.id);
    if (event === repairTarget?.marker) {
      flush();
      repairCheckpoint = shadow.getSnapshot();
    }
    consume(event);
  }
  for (const event of input.additionalEvents ?? []) consume(event);
  flush();
  const replayTokenUsage =
    getReplayTokenUsage(session.replaySnapshot.liveJournal) ??
    getReplayTokenUsage(session.replaySnapshot.compactedReplay);
  connection = {
    ...connection,
    status: 'connected',
    displayName: getSessionDisplayName(session.state),
    tokenUsage: replayTokenUsage,
    tokenCount: getTokenCountFromUsage(replayTokenUsage) ?? 0,
    error: undefined,
    errorStatus: undefined,
    missingSession: false,
    sessionTransition: undefined,
  };
  const transcript = shadow.getSnapshot();
  const replayExceededCapacity = transcript.blocks.length > maxBlocks;
  transcript.maxBlocks = Math.max(maxBlocks, transcript.blocks.length);
  if (repairCheckpoint) repairCheckpoint.maxBlocks = transcript.maxBlocks;
  const repair =
    repairTarget && repairCheckpoint
      ? {
          sessionId: session.sessionId,
          target: repairTarget,
          checkpoint: repairCheckpoint,
          observedSnapshotEventIds,
          snapshotLastEventId: session.lastEventId ?? 0,
          lastObservedEventId: session.lastEventId ?? 0,
          terminalSeen: false,
          attempted: false,
        }
      : undefined;
  return {
    session,
    capabilities,
    connection,
    transcript,
    history: {
      sessionId: session.sessionId,
      beforeRecordId: firstPersistedRecordId,
      hasMore: historyHasMore && !replayExceededCapacity,
      loading: false,
      capacityReached: historyHasMore && replayExceededCapacity,
      paginationError: false,
    },
    signals,
    notices,
    dismissNoticeIds,
    ...(followupSuggestion ? { followupSuggestion } : {}),
    midTurnEvents,
    pendingPromptEvents,
    ...(repair ? { repair } : {}),
  };
}

function assistantDoneFromTurnEvent(
  event: DaemonEvent,
  reason: string,
): DaemonUiEvent {
  const serverTimestamp = extractServerTimestamp(event);
  return {
    type: 'assistant.done',
    reason,
    eventId: event.id,
    ...(serverTimestamp !== undefined ? { serverTimestamp } : {}),
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
): TranscriptHistoryMaterialization | undefined {
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
    nextOrdinal: current.nextOrdinal,
    retainSubagentBlocks: current.retainSubagentBlocks,
  });
  historyStore.dispatch(freshEvents);
  const history = historyStore.getSnapshot();
  if (history.blocks.length + current.blocks.length > maxBlocks) {
    return undefined;
  }
  return {
    blocks: history.blocks,
    nextOrdinal: history.nextOrdinal,
    toolBlockByCallId: history.toolBlockByCallId,
    permissionBlockByRequestId: history.permissionBlockByRequestId,
  };
}

function applyTranscriptHistory(
  current: DaemonTranscriptState,
  history: TranscriptHistoryMaterialization,
): DaemonTranscriptState {
  return {
    ...current,
    blocks: [...history.blocks, ...current.blocks],
    nextOrdinal: history.nextOrdinal,
    toolBlockByCallId: {
      ...history.toolBlockByCallId,
      ...current.toolBlockByCallId,
    },
    permissionBlockByRequestId: {
      ...history.permissionBlockByRequestId,
      ...current.permissionBlockByRequestId,
    },
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
  const todoId =
    typeof rawInput?.['todo_id'] === 'string' ? rawInput['todo_id'] : undefined;
  const subagentName = boundedString(rawOutput?.['subagentName'], 120);
  const subagentColor = boundedString(rawOutput?.['subagentColor'], 80);
  const taskDescription = boundedString(rawOutput?.['taskDescription'], 240);
  const status = boundedString(rawOutput?.['status'], 80);
  const terminateReason = boundedString(rawOutput?.['terminateReason'], 240);
  const projectedInput = rawInput
    ? {
        ...(subagentType ? { subagent_type: subagentType } : {}),
        ...(prompt ? { prompt } : {}),
        ...(description ? { description } : {}),
        ...(todoId ? { todo_id: todoId } : {}),
        ...(rawInput['run_in_background'] === true
          ? { run_in_background: true }
          : {}),
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
        ...(terminateReason ? { terminateReason } : {}),
        ...(typeof rawOutput['tokenCount'] === 'number'
          ? { tokenCount: rawOutput['tokenCount'] }
          : {}),
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
// normalization still rebuilds from retained blocks today, so this high default
// is a history-preservation tradeoff rather than a claim that large transcripts
// are CPU-free. Callers can pass a smaller maxBlocks in constrained contexts.
const DEFAULT_MAX_BLOCKS = 200_000;

const INITIAL_WORKSPACE_EVENT_SIGNALS: DaemonWorkspaceEventSignals = {
  memoryVersion: 0,
  agentsVersion: 0,
  toolsVersion: 0,
  settingsVersion: 0,
  mcpVersion: 0,
  extensionsVersion: 0,
  artifactsVersion: 0,
  initVersion: 0,
  authVersion: 0,
};

const UNHANDLED_SESSION = Symbol('unhandled session');

export function DaemonSessionProvider(props: DaemonSessionProviderProps) {
  const {
    baseUrl,
    token,
    workspaceCwd,
    sessionId,
    clientId,
    createSessionRequest,
    maxQueued = 1024,
    maxBlocks = DEFAULT_MAX_BLOCKS,
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
    onSessionTransitionCommit,
    children,
  } = props;
  const workspace = useOptionalDaemonWorkspace();
  const resolvedBaseUrl = baseUrl ?? workspace?.baseUrl;
  const resolvedToken = token ?? workspace?.token;
  const resolvedWorkspaceCwd = workspaceCwd ?? workspace?.workspaceCwd;
  const sessionCapabilitiesRef = useRef<DaemonCapabilities | undefined>(
    workspace?.capabilities,
  );
  const environmentRef = useRef({
    baseUrl: resolvedBaseUrl,
    token: resolvedToken,
    client: workspace?.client,
    maxBlocks,
    subagentTranscriptMode,
    generation: 0,
  });
  if (
    environmentRef.current.baseUrl !== resolvedBaseUrl ||
    environmentRef.current.token !== resolvedToken ||
    environmentRef.current.client !== workspace?.client ||
    environmentRef.current.maxBlocks !== maxBlocks ||
    environmentRef.current.subagentTranscriptMode !== subagentTranscriptMode
  ) {
    sessionCapabilitiesRef.current = workspace?.capabilities;
    environmentRef.current = {
      baseUrl: resolvedBaseUrl,
      token: resolvedToken,
      client: workspace?.client,
      maxBlocks,
      subagentTranscriptMode,
      generation: environmentRef.current.generation + 1,
    };
  }
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
  const activeWorkspaceCwdRef = useRef(resolvedWorkspaceCwd);

  const store = useMemo(
    () =>
      createDaemonTranscriptStore({
        maxBlocks,
        retainSubagentBlocks: subagentTranscriptMode === 'full',
      }),
    [maxBlocks, subagentTranscriptMode],
  );
  const sessionRef = useRef<DaemonSessionClient | undefined>(undefined);
  const runnerControlRef = useRef<SessionRunnerControl | undefined>(undefined);
  const preparedRunnerRef = useRef<PreparedRunnerHandoff | undefined>(
    undefined,
  );
  const desiredTransitionRef = useRef<CrossSessionIntent | undefined>(
    undefined,
  );
  if (
    !sessionRef.current &&
    !desiredTransitionRef.current &&
    resolvedWorkspaceCwd
  ) {
    activeWorkspaceCwdRef.current = resolvedWorkspaceCwd;
  }
  const rawTransitionRef = useRef<CrossSessionIntent | undefined>(undefined);
  const pumpTransitionRef = useRef<() => void>(() => undefined);
  const lifecycleRef = useRef(0);
  const sourceBoundOperationCountRef = useRef(0);
  const sessionConfigGenerationRef = useRef(
    new WeakMap<DaemonSessionClient, number>(),
  );
  const controlledRetryPendingRef = useRef(false);
  const cancelTransitionRef = useRef<(reason: string) => void>(() => undefined);
  const controlledTransitionOriginRef = useRef(false);
  const transcriptHistoryRef = useRef<TranscriptHistoryState>({
    hasMore: false,
    loading: false,
    capacityReached: false,
    paginationError: false,
  });
  const [transcriptHistoryState, setTranscriptHistoryState] =
    useState<TranscriptHistoryState>(transcriptHistoryRef.current);
  const [controlledRetryNonce, setControlledRetryNonce] = useState(0);
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
  const settledRestoredActivePromptSessionsRef = useRef<
    WeakSet<DaemonSessionClient>
  >(new WeakSet());
  const eventOptionsRef = useRef({ suppressOwnUserEcho, includeRawEvent });
  const reconnectConfigRef = useRef({ reconnectDelayMs, maxReconnectDelayMs });
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
  const [restoreWorkspaceCwd, setRestoreWorkspaceCwd] = useState<
    string | undefined
  >(undefined);
  const [restoreMode, setRestoreMode] = useState<'load' | 'resume'>('load');
  const [restoreSessionNonce, setRestoreSessionNonce] = useState(0);
  const [attachSessionNonce, setAttachSessionNonce] = useState(0);
  const [newSessionNonce, setNewSessionNonce] = useState(0);
  const [connection, setConnection] = useState<DaemonConnectionState>({
    status: autoConnect ? 'connecting' : 'idle',
    ...(initialRestoreSessionId ? { sessionId: initialRestoreSessionId } : {}),
    ...(resolvedWorkspaceCwd ? { workspaceCwd: resolvedWorkspaceCwd } : {}),
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
      setConnection(next);
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
  const mountGenerationRef = useRef(0);

  useEffect(() => {
    const generation = ++mountGenerationRef.current;
    const mountGeneration = mountGenerationRef;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      queueMicrotask(() => {
        if (mountedRef.current || mountGeneration.current !== generation) {
          return;
        }
        cancelTransitionRef.current('Session transition interrupted');
        liveJournalRepairRef.current?.controller?.abort();
        liveJournalRepairRef.current = undefined;
        tryLiveJournalRepairRef.current = undefined;
      });
    };
  }, []);

  useEffect(() => {
    if (!autoConnect) return undefined;
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
    // event, so a whole burst collapses into a single dispatch while steady
    // streaming stays at ~one dispatch per network chunk.
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
        transcriptFlushTimer = setTimeout(runTranscriptFlush, 0);
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
    let runnerEventEpoch = runnerSession?.eventEpoch;
    let processedEventId = runnerSession?.lastEventId;
    let lastPromptTerminalEventId: number | undefined;
    let runnerReady = false;
    let runnerActiveTurn = false;
    const runnerControl: SessionRunnerControl = {
      session: runnerSession,
      flush: flushTranscriptSync,
      stop: () => abort.abort(),
      snapshot: () => ({
        session: runnerControl.session,
        clientId: runnerControl.session?.clientId,
        eventEpoch: runnerEventEpoch,
        processedEventId,
        lastPromptTerminalEventId,
        ready: runnerReady,
        activeTurn: runnerActiveTurn,
      }),
    };
    runnerControlRef.current = runnerControl;
    const captureSourceEvent = (event: DaemonEvent) => {
      const capture = runnerControl.capture;
      if (!capture || capture.invalidReason) return;
      if (
        runnerControl.session !== capture.source ||
        capture.source.clientId !== capture.sourceClientId ||
        capture.source.eventEpoch !== capture.eventEpoch
      ) {
        capture.invalidReason = 'Source attachment changed during refresh';
        return;
      }
      if (event.id === undefined) {
        if (event.type !== 'replay_complete') {
          capture.invalidReason = `Source emitted id-less ${event.type}`;
        }
        return;
      }
      if (event.id <= capture.lastCapturedEventId) return;
      if (event.id !== capture.lastCapturedEventId + 1) {
        capture.invalidReason = 'Source event sequence contains a gap';
        return;
      }
      let serializedBytes: number;
      try {
        serializedBytes = UTF8_ENCODER.encode(JSON.stringify(event)).byteLength;
      } catch (error) {
        capture.invalidReason =
          error instanceof Error ? error.message : String(error);
        return;
      }
      if (
        capture.events.length >= maxQueued ||
        capture.bytes + serializedBytes > SAME_SESSION_CAPTURE_MAX_BYTES
      ) {
        capture.invalidReason = 'Source event capture exceeded its bound';
        return;
      }
      capture.events.push(event);
      capture.bytes += serializedBytes;
      capture.lastCapturedEventId = event.id;
    };
    const markSourceEventProcessed = (event: DaemonEvent) => {
      const learnedEpoch = runnerControl.session?.eventEpoch;
      if (learnedEpoch !== runnerEventEpoch) {
        if (runnerControl.capture && !runnerControl.capture.invalidReason) {
          runnerControl.capture.invalidReason =
            'Source event epoch changed during refresh';
        }
        runnerEventEpoch = learnedEpoch;
      }
      if (event.id !== undefined) {
        processedEventId = Math.max(processedEventId ?? 0, event.id);
      }
      queueMicrotask(pumpTransitionRef.current);
    };
    const tryLiveJournalRepair = () => {
      if (disposed || abort.signal.aborted) return;
      const repair = liveJournalRepairRef.current;
      if (
        !repair ||
        repair.attempted ||
        !repair.terminalSeen ||
        pendingSessionLoadRef.current ||
        desiredTransitionRef.current ||
        rawTransitionRef.current ||
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
      let prepared =
        preparedRunnerRef.current?.session === sessionRef.current
          ? preparedRunnerRef.current
          : undefined;
      if (preparedRunnerRef.current === prepared) {
        preparedRunnerRef.current = undefined;
      }
      let session: DaemonSessionClient | undefined = prepared?.session;
      let capabilities:
        | Awaited<ReturnType<DaemonClient['capabilities']>>
        | undefined = prepared?.capabilities;
      let reconnectSessionId = restoreSessionId;
      let shouldCreateFreshSession =
        !manualSessionClearRef.current &&
        !restoreSessionId &&
        newSessionNonce > 0;
      let reconnectAttempt = 0;
      let nextSseConnectReason: DaemonSseConnectReason | undefined;
      let skipMetadataRefresh = false;
      let hasCurrentSessionActivePrompt = () => false;
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
            if (
              existingSession &&
              !restoreSessionId &&
              !reconnectSessionId &&
              !shouldCreateFreshSession
            ) {
              session = existingSession;
              reconnectSessionId = existingSession.sessionId;
              lastSessionIdRef.current = existingSession.sessionId;
              attachedExistingSession = true;
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
            const effectWorkspaceCwd =
              restoreWorkspaceCwd ??
              activeWorkspaceCwdRef.current ??
              caps.workspaceCwd;
            activeWorkspaceCwdRef.current = effectWorkspaceCwd;
            const capabilityFeatures = Array.isArray(caps.features)
              ? caps.features
              : [];
            const canPreheatPrimaryWorkspace =
              effectWorkspaceCwd === caps.workspaceCwd &&
              capabilityFeatures.includes(WORKSPACE_ACP_PREHEAT_FEATURE);
            const canReadPrimaryAcpStatus =
              canPreheatPrimaryWorkspace &&
              capabilityFeatures.includes(WORKSPACE_ACP_STATUS_FEATURE);
            if (
              (shouldDeferInitialSessionCreation ||
                manualSessionClearRef.current) &&
              !restoreSessionId &&
              !reconnectSessionId &&
              !shouldCreateFreshSession
            ) {
              // Fetch skills alongside providers so skill-backed slash
              // commands (e.g. /review) can autocomplete before the first
              // prompt. Both are session-less workspace queries; the
              // session-scoped supported-commands snapshot (which also carries
              // custom/MCP/workflow commands) still lands once the first prompt
              // creates a session.
              const [providerResult, skillsResult, acpStatusResult, gitResult] =
                await Promise.allSettled([
                  client.workspaceProviders(),
                  client.workspaceSkills(),
                  canReadPrimaryAcpStatus
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
                workspaceCwd: effectWorkspaceCwd,
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
              if (
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
            const restoreMethod =
              restoreSessionId &&
              restoreMode === 'resume' &&
              !legacyClientRebind
                ? DaemonSessionClient.resume
                : DaemonSessionClient.load;
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
            const attemptedLoad =
              pendingSessionLoadRef.current?.sessionId === targetSessionId
                ? pendingSessionLoadRef.current
                : undefined;
            const restoreRequestTimeoutMs =
              attemptedLoad?.requestTimeoutMs ??
              resolveSessionRestoreTimeouts(capabilities).requestTimeoutMs;
            const nextSession = restoreSessionId
              ? await restoreMethod(
                  client,
                  restoreSessionId,
                  {
                    workspaceCwd: effectWorkspaceCwd,
                    timeoutMs: restoreRequestTimeoutMs,
                    ...(historyPaginationSupported &&
                    restoreMode === 'load' &&
                    attemptedLoad?.replaySource !== 'memory' &&
                    historyPageSizeRef.current !== undefined
                      ? { historyPageSize: historyPageSizeRef.current }
                      : {}),
                  },
                  requestClientId,
                )
              : reconnectSessionId
                ? await DaemonSessionClient.load(
                    client,
                    reconnectSessionId,
                    {
                      workspaceCwd: effectWorkspaceCwd,
                      timeoutMs: restoreRequestTimeoutMs,
                      ...(historyPaginationSupported &&
                      historyPageSizeRef.current !== undefined
                        ? { historyPageSize: historyPageSizeRef.current }
                        : {}),
                    },
                    requestClientId,
                  )
                : await DaemonSessionClient.createOrAttach(
                    client,
                    {
                      ...(modelServiceId !== undefined
                        ? { modelServiceId }
                        : {}),
                      ...(shouldCreateFreshSession
                        ? { sessionScope: 'thread' as const }
                        : sessionScope !== undefined
                          ? { sessionScope }
                          : {}),
                      workspaceCwd: effectWorkspaceCwd,
                    },
                    requestClientId,
                  );
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
          runnerSession = activeSession;
          runnerControl.session = activeSession;
          runnerEventEpoch = activeSession.eventEpoch;
          processedEventId = activeSession.lastEventId;
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
          runnerActiveTurn = false;
          setPromptStatus(hasSessionActivePrompt() ? 'streaming' : 'idle');

          const pendingLoad = pendingSessionLoadRef.current;
          const pendingLoadToResolve =
            pendingLoad?.sessionId === activeSession.sessionId
              ? pendingLoad
              : undefined;

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
          const preparedHandoff = prepared !== undefined;
          const { compactedReplay, liveJournal } = preparedHandoff
            ? { compactedReplay: [], liveJournal: [] }
            : activeSession.replaySnapshot;
          prepared = undefined;
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
          const historyHasMore = preparedHandoff
            ? transcriptHistoryRef.current.hasMore
            : repairingEpisode
              ? transcriptHistoryRef.current.hasMore
              : Array.isArray(capabilities?.features) &&
                capabilities.features.includes(
                  SESSION_TRANSCRIPT_PAGINATION_FEATURE,
                ) &&
                (activeSession.historyHasMore || replayHistoryWasTruncated) &&
                firstPersistedRecordId !== undefined;
          if (!repairingEpisode && !preparedHandoff) {
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
            !markerStillVisible &&
            firstPersistedRecordId !== undefined
          ) {
            transcriptHistoryRef.current.beforeRecordId =
              firstPersistedRecordId;
            transcriptHistoryRef.current.cursor = undefined;
          }
          const replayInjected =
            shouldInjectReplaySnapshot && replayEvents.length > 0;
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
            const rebuildReplay =
              repairingEpisode !== undefined ||
              replayTarget !== undefined ||
              needsStoreReset ||
              store.getSnapshot().blocks.length === 0;
            if (rebuildReplay) {
              const replayMaxBlocks = repairingEpisode
                ? markerStillVisible
                  ? repairingEpisode.checkpoint.maxBlocks
                  : maxBlocks
                : Number.MAX_SAFE_INTEGER;
              const replayStore = createDaemonTranscriptStore(
                repairingEpisode && markerStillVisible
                  ? {
                      ...repairingEpisode.checkpoint,
                      maxBlocks: replayMaxBlocks,
                    }
                  : {
                      maxBlocks: replayMaxBlocks,
                      retainSubagentBlocks:
                        subagentTranscriptModeRef.current === 'full',
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
              replayExceededCapacity =
                repairingEpisode === undefined &&
                replayState.blocks.length > maxBlocks;
              const committedMaxBlocks = repairingEpisode
                ? replayMaxBlocks
                : Math.max(maxBlocks, replayState.blocks.length);
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
            if (sideEffectEvents.length > 0) {
              bumpWorkspaceEventSignals(
                sideEffectEvents,
                setWorkspaceEventSignals,
              );
            }
            if (replayExceededCapacity && historyHasMore) {
              transcriptHistoryRef.current.hasMore = false;
              transcriptHistoryRef.current.capacityReached = true;
              setTranscriptHistoryState({
                hasMore: false,
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
          }
          setConnection((current) => ({
            ...current,
            status: 'connected',
            sessionId: activeSession.sessionId,
            ...(activeSession.clientId
              ? { clientId: activeSession.clientId }
              : {}),
            workspaceCwd: activeSession.workspaceCwd,
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
            loadingTranscript: undefined,
            catchingUp: replayInjected
              ? current.catchingUp
              : isSameSessionReconnect ||
                activeSession.lastEventId != null ||
                undefined,
          }));
          if (pendingLoadToResolve) {
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
          const gitPromise = skipMetadataRefreshThisIteration
            ? Promise.resolve({ branch: connectionRef.current.gitBranch })
            : activeSession.workspaceCwd
              ? client.workspaceByCwd(activeSession.workspaceCwd).workspaceGit()
              : client.workspaceGit();
          const [providerResult, commandResult, contextResult, gitResult] =
            await Promise.allSettled([
              canReuseSessionMetadata
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
              ? (gitResult.value.branch ?? undefined)
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
              sessionRef.current !== activeSession ||
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
              workspaceCwd: activeSession.workspaceCwd,
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
                  ? mapSessionContextReasoning(
                      context,
                      current.reasoning?.effort,
                    )
                  : current.reasoning,
              displayName:
                getSessionDisplayName(activeSession.state) ??
                current.displayName,
              contextWindow: configSnapshotCurrent
                ? (sessionContextWindow ?? current.contextWindow)
                : current.contextWindow,
              providers: providers ?? current.providers,
              supportedCommands: supportedCommands ?? current.supportedCommands,
              context: configSnapshotCurrent
                ? (context ?? current.context)
                : current.context,
              gitBranch:
                gitResult.status === 'fulfilled'
                  ? gitBranch
                  : current.gitBranch,
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
            cancelTransitionRef.current(
              'Session transition cancelled by state resync',
            );
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
          runnerReady = activeSession.lastEventId === undefined;
          if (runnerReady) queueMicrotask(pumpTransitionRef.current);
          for await (const event of activeSession.events({
            signal: eventStreamController.signal,
            maxQueued,
            ...(sseConnectReason ? { sseConnectReason } : {}),
          })) {
            if (sessionRef.current !== activeSession) {
              break;
            }
            captureSourceEvent(event);
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
                    runnerActiveTurn = true;
                    clearPassiveAssistantDoneTimer(
                      passiveAssistantDoneTimerRef,
                    );
                    setPromptStatus('waiting');
                  }
                }
                const normalizedUiEvents = normalizeAndFilterEvent(
                  event,
                  activeSession.clientId,
                  eventOptionsRef.current,
                  (update) => {
                    setConnectionSynchronous((current) => {
                      if (sessionRef.current !== activeSession) return current;
                      return typeof update === 'function'
                        ? update(current)
                        : update;
                    });
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
                bumpWorkspaceEventSignals(uiEvents, setWorkspaceEventSignals);
                if (uiEvents.length > 0) {
                  const hasGenerationSignal =
                    hasActiveGenerationSignal(uiEvents);
                  if (hasGenerationSignal) runnerActiveTurn = true;
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
                  (event.type === 'turn_complete' ||
                    event.type === 'turn_error')
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
                // The debug guard below reads the committed store's active
                // assistant block, but batching leaves earlier chunks from this
                // same burst in the pending buffer until the macrotask flush. An
                // observer burst that interleaves a debug event between assistant
                // chunks would otherwise miss the still-pending assistant block
                // and let the debug event split it. Commit the buffer first so the
                // guard sees the effective state. Scoped to observer-mode debug
                // events (rare) so steady streaming keeps batching.
                if (
                  !hasSessionActivePrompt() &&
                  uiEvents.some((e) => e.type === 'debug')
                ) {
                  flushTranscriptSync();
                }
                const shouldGuardAssistant =
                  !hasSessionActivePrompt() &&
                  store.getSnapshot().activeAssistantBlockId != null;
                const eventsToDispatch = shouldGuardAssistant
                  ? transcriptUiEvents.filter((e) => e.type !== 'debug')
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
                    clearPassiveAssistantDoneTimer(
                      passiveAssistantDoneTimerRef,
                    );
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
                    runnerReady = true;
                    queueMicrotask(pumpTransitionRef.current);
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
                    runnerActiveTurn = true;
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
                if (
                  event.id !== undefined &&
                  (event.type === 'turn_complete' ||
                    event.type === 'turn_error' ||
                    uiEvents.some(
                      (uiEvent) => uiEvent.type === 'prompt.cancelled',
                    ))
                ) {
                  lastPromptTerminalEventId = event.id;
                  runnerActiveTurn = false;
                  queueMicrotask(pumpTransitionRef.current);
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
                    cancelTransitionRef.current(
                      'Session transition cancelled by state resync',
                    );
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
                  (event.data as Record<string, unknown> | undefined)
                    ?.reason === 'client_close'
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
            } finally {
              markSourceEventProcessed(event);
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
          runnerReady = false;
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
              ...current,
              status: 'disconnected',
              sessionId: undefined,
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
          runnerReady = false;
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
          const pendingLoad = pendingSessionLoadRef.current;
          if (
            autoReconnect &&
            loadingRequestedSession &&
            pendingLoad?.sessionId === restoreSessionId &&
            isClosingSessionLoadError(
              error,
              !capabilities?.features.includes(CLIENT_IDENTITY_FEATURE),
            )
          ) {
            reconnectAttempt += 1;
            const reconnectConfig = reconnectConfigRef.current;
            await delay(
              getReconnectDelayMs(
                reconnectAttempt,
                reconnectConfig.reconnectDelayMs,
                reconnectConfig.maxReconnectDelayMs,
              ),
              abort.signal,
            );
            if (pendingSessionLoadRef.current !== pendingLoad) return;
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
          if (isAuthFailure || isTerminal) {
            // Auth failures (401/403) and terminal session errors (404/410)
            // must clear the session — the server-side state is gone or
            // inaccessible, so delta resume is impossible.
            session = undefined;
            sessionRef.current = undefined;
            if (isAuthFailure) {
              setConnection((current) => ({
                ...current,
                status: 'error',
                sessionId: undefined,
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
              ...current,
              status: 'disconnected',
              sessionId: undefined,
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
        await delay(delayMs, abort.signal);
      }
    };

    void run();
    return () => {
      const session = runnerSession;
      if (desiredTransitionRef.current && sessionRef.current === session) {
        cancelTransitionRef.current('Session runner restarted');
      }
      if (runnerControlRef.current === runnerControl) {
        runnerControlRef.current = undefined;
      }
      disposed = true;
      abort.abort();
      const ownsCurrentSession =
        session !== undefined && sessionRef.current === session;
      const ownsEmptyState =
        session === undefined && sessionRef.current === undefined;
      if (ownsCurrentSession || ownsEmptyState) {
        // A same-attachment effect restart must flush events already yielded by
        // the SSE client, because its resume cursor has advanced past them.
        flushTranscriptSync();
      } else {
        // A replacement attachment owns the store now. Never let the old
        // runner's pending macrotask append its buffered events to that owner.
        clearPendingTranscriptEvents();
      }
      const releaseOwnedSession = (unmounting: boolean) => {
        const ownedSession = unmounting ? sessionRef.current : session;
        const stillOwnsSession =
          ownedSession !== undefined && sessionRef.current === ownedSession;
        const stillOwnsEmptyState =
          session === undefined && sessionRef.current === undefined;
        if (!stillOwnsSession && !stillOwnsEmptyState) return;
        const keepSessionForNextEffect =
          !unmounting &&
          stillOwnsSession &&
          ownedSession === skipNextCleanupDetachSessionRef.current;
        if (keepSessionForNextEffect) return;
        if (stillOwnsSession) {
          hasCurrentSessionActivePromptRef.current = () => false;
          setPromptStatus('idle');
          clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
        }
        const pendingLoad = pendingSessionLoadRef.current;
        if (
          pendingLoad &&
          (unmounting || pendingLoad === effectPendingSessionLoad) &&
          (stillOwnsEmptyState ||
            (stillOwnsSession &&
              ownedSession.sessionId === pendingLoad.sessionId))
        ) {
          if (pendingLoad.timeout !== undefined) {
            clearTimeout(pendingLoad.timeout);
          }
          pendingLoad.reject(
            new DOMException(
              'Session load interrupted by cleanup',
              'AbortError',
            ),
          );
          pendingSessionLoadRef.current = undefined;
        }
        if (stillOwnsSession) {
          if (ownedSession.clientId) {
            void detachDaemonClient({
              baseUrl: resolvedBaseUrl!,
              token: resolvedToken,
              sessionId: ownedSession.sessionId,
              clientId: ownedSession.clientId,
            }).catch((err) =>
              console.warn('[DaemonSessionProvider] detach failed:', err),
            );
          }
          sessionRef.current = undefined;
        }
      };
      if (!mountedRef.current) {
        queueMicrotask(() => {
          if (!mountedRef.current) releaseOwnedSession(true);
        });
      } else {
        releaseOwnedSession(false);
      }
    };
  }, [
    autoConnect,
    autoReconnect,
    resolvedBaseUrl,
    resolvedToken,
    modelServiceId,
    sessionScope,
    maxQueued,
    maxBlocks,
    store,
    restoreSessionId,
    restoreWorkspaceCwd,
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
                  ...current,
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

  const publishCrossSessionFailure = useCallback(
    (target: CrossSessionTarget, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const status = extractHttpStatus(error);
      const code =
        error instanceof DaemonHttpError &&
        isRecord(error.body) &&
        typeof error.body['code'] === 'string'
          ? error.body['code']
          : undefined;
      setConnectionSynchronous((current) => ({
        ...current,
        sessionTransition: transitionState(target, 'failed', {
          message,
          ...(code !== undefined ? { code } : {}),
          ...(status !== undefined ? { status } : {}),
        }),
      }));
      addNotice({
        severity: 'warning',
        category: 'connection',
        operation: target.mode === 'resume' ? 'resume_session' : 'load_session',
        code: 'daemon.session_transition.failed',
        message: target.sameLogical
          ? `Could not refresh session ${target.sessionId}. The current attachment is still active.`
          : `Could not open session ${target.sessionId}. The current session is still active.`,
        debugMessage: message,
        recoverable: true,
      });
    },
    [addNotice, setConnectionSynchronous],
  );

  const retireAttachment = useCallback(
    (session: DaemonSessionClient, intent: CrossSessionIntent) => {
      const clientId = session.clientId || intent.targetClientId;
      if (!clientId) return;
      void detachDaemonClient({
        baseUrl: intent.baseUrl,
        token: intent.token,
        sessionId: session.sessionId || intent.sessionId,
        clientId,
      }).catch((error: unknown) => {
        console.warn('[DaemonSessionProvider] detach failed:', error);
      });
    },
    [],
  );

  const cleanupTransitionArtifacts = useCallback(
    (
      intent: CrossSessionIntent,
      options: { preserveInFlightCapture?: boolean } = {},
    ) => {
      const candidate = intent.candidate;
      intent.candidate = undefined;
      if (candidate) retireAttachment(candidate, intent);
      if (options.preserveInFlightCapture) return;
      const control = runnerControlRef.current;
      if (intent.capture && control?.capture === intent.capture) {
        control.capture = undefined;
      }
    },
    [retireAttachment],
  );

  const exposeCrossSessionFailure = useCallback(
    (
      intent: CrossSessionIntent,
      error: unknown,
      options?: { preserveInFlightCapture?: boolean },
    ) => {
      if (desiredTransitionRef.current !== intent) return;
      cleanupTransitionArtifacts(intent, options);
      desiredTransitionRef.current = undefined;
      if (mountedRef.current) publishCrossSessionFailure(intent, error);
      settleCrossSessionIntent(intent, error);
    },
    [cleanupTransitionArtifacts, publishCrossSessionFailure],
  );

  const armTransitionDeadline = useCallback(
    (intent: CrossSessionIntent, capabilities: DaemonCapabilities) => {
      if (intent.deadlineStarted) return;
      intent.deadlineStarted = true;
      const timeoutMs =
        resolveSessionRestoreTimeouts(capabilities).watchdogTimeoutMs;
      if (timeoutMs === undefined) return;
      intent.deadlineAt = Date.now() + timeoutMs;
      intent.timeout = setTimeout(() => {
        exposeCrossSessionFailure(
          intent,
          new Error('Session transition timed out'),
          {
            preserveInFlightCapture: rawTransitionRef.current === intent,
          },
        );
      }, timeoutMs);
    },
    [exposeCrossSessionFailure],
  );

  const commitCrossSession = useCallback(
    (intent: CrossSessionIntent, staged: StagedCrossSession): boolean => {
      if (
        !mountedRef.current ||
        desiredTransitionRef.current !== intent ||
        intent.lifecycle !== lifecycleRef.current ||
        intent.environmentGeneration !== environmentRef.current.generation ||
        (intent.deadlineAt !== undefined && Date.now() >= intent.deadlineAt)
      ) {
        return false;
      }
      const current = sessionRef.current;
      if (
        current !== undefined &&
        (!current.clientId ||
          current.sessionId !== intent.source.sessionId ||
          normalizeWorkspaceIdentity(current.workspaceCwd) !==
            normalizeWorkspaceIdentity(intent.source.workspaceCwd))
      ) {
        return false;
      }
      const sourceToRetire = current ?? intent.source;
      if (intent.timeout !== undefined) clearTimeout(intent.timeout);
      if (runnerControlRef.current?.session === sourceToRetire) {
        runnerControlRef.current.flush();
        runnerControlRef.current.stop();
      }
      store.reset(staged.transcript);
      transcriptHistoryRef.current = staged.history;
      setTranscriptHistoryState({
        hasMore: staged.history.hasMore,
        loading: false,
        capacityReached: staged.history.capacityReached,
        paginationError: false,
      });
      sessionRef.current = staged.session;
      lastSessionIdRef.current = staged.session.sessionId;
      activeWorkspaceCwdRef.current = staged.session.workspaceCwd;
      clientIdRef.current = staged.session.clientId;
      persistStableClientId(staged.session.clientId!, staged.session.sessionId);
      setConnectionSynchronous(staged.connection);
      desiredTransitionRef.current = undefined;
      try {
        onSessionTransitionCommit?.({
          sessionId: staged.session.sessionId,
          workspaceCwd: staged.session.workspaceCwd,
        });
      } catch (error) {
        console.warn('[DaemonSessionProvider] commit observer failed:', error);
      }
      clearSidechannelFollowupSuggestion();
      if (staged.followupSuggestion) {
        publishSidechannelFollowupSuggestion(staged.followupSuggestion);
      }
      clearNotices();
      for (const notice of staged.notices) addNotice(notice);
      for (const id of staged.dismissNoticeIds) dismissNotice(id);
      setWorkspaceEventSignals((currentSignals) => ({
        memoryVersion:
          currentSignals.memoryVersion + staged.signals.memoryVersion,
        agentsVersion:
          currentSignals.agentsVersion + staged.signals.agentsVersion,
        toolsVersion: currentSignals.toolsVersion + staged.signals.toolsVersion,
        settingsVersion:
          currentSignals.settingsVersion + staged.signals.settingsVersion,
        mcpVersion: currentSignals.mcpVersion + staged.signals.mcpVersion,
        extensionsVersion:
          currentSignals.extensionsVersion + staged.signals.extensionsVersion,
        artifactsVersion:
          currentSignals.artifactsVersion + staged.signals.artifactsVersion,
        initVersion: currentSignals.initVersion + staged.signals.initVersion,
        authVersion: currentSignals.authVersion + staged.signals.authVersion,
        ...(staged.signals.lastExtensionChange
          ? { lastExtensionChange: staged.signals.lastExtensionChange }
          : {}),
      }));
      for (const event of staged.midTurnEvents) {
        const injected = parseSidechannelMidTurnInjected(event);
        if (injected) publishSidechannelMidTurnInjected(injected);
      }
      for (const event of staged.pendingPromptEvents) {
        publishPendingPromptEvent(event);
      }
      const active = activePromptsRef.current.get(sourceToRetire.sessionId);
      active?.controller.abort(
        new DOMException(
          'Session switch interrupted prompt wait',
          'AbortError',
        ),
      );
      activePromptsRef.current.delete(sourceToRetire.sessionId);
      settledPromptsRef.current.clear();
      hasCurrentSessionActivePromptRef.current = () =>
        staged.session.hasActivePrompt === true;
      clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
      setPromptStatus(staged.session.hasActivePrompt ? 'streaming' : 'idle');
      liveJournalRepairRef.current?.controller?.abort();
      liveJournalRepairRef.current = staged.repair;
      preparedRunnerRef.current = staged;
      manualSessionClearRef.current = false;
      setRestoreMode(intent.mode);
      setRestoreSessionId(staged.session.sessionId);
      setRestoreWorkspaceCwd(staged.session.workspaceCwd);
      setRestoreSessionNonce((nonce) => nonce + 1);
      settleCrossSessionIntent(intent);
      retireAttachment(sourceToRetire, intent);
      return true;
    },
    [
      addNotice,
      clearNotices,
      dismissNotice,
      onSessionTransitionCommit,
      retireAttachment,
      setConnectionSynchronous,
      store,
    ],
  );

  const commitSameSession = useCallback(
    (
      intent: CrossSessionIntent,
      candidate: DaemonSessionClient,
      capabilities: DaemonCapabilities,
      capture: SameSessionCapture | undefined,
    ): boolean => {
      const control = runnerControlRef.current;
      if (!control) return false;
      const snapshot = control?.snapshot();
      const watermark = candidate.lastEventId;
      if (
        !mountedRef.current ||
        desiredTransitionRef.current !== intent ||
        intent.lifecycle !== lifecycleRef.current ||
        intent.environmentGeneration !== environmentRef.current.generation ||
        sessionRef.current !== intent.source ||
        intent.source.clientId !== intent.sourceClientId ||
        snapshot?.session !== intent.source ||
        snapshot.clientId !== intent.sourceClientId ||
        snapshot.eventEpoch !== candidate.eventEpoch ||
        snapshot.eventEpoch === undefined ||
        snapshot.processedEventId === undefined ||
        !Number.isSafeInteger(snapshot.processedEventId) ||
        snapshot.processedEventId < 0 ||
        !snapshot.ready ||
        snapshot.activeTurn ||
        hasCurrentSessionActivePromptRef.current() ||
        watermark === undefined ||
        !Number.isSafeInteger(watermark) ||
        watermark < 0 ||
        snapshot.processedEventId < watermark ||
        (intent.deadlineAt !== undefined && Date.now() >= intent.deadlineAt)
      ) {
        return false;
      }
      if (
        candidate.hasActivePrompt &&
        (snapshot.lastPromptTerminalEventId === undefined ||
          snapshot.lastPromptTerminalEventId <= watermark)
      ) {
        return false;
      }

      let staged: StagedCrossSession | undefined;
      if (intent.mode === 'load') {
        if (
          !capture ||
          capture.invalidReason ||
          capture.source !== intent.source ||
          capture.sourceClientId !== intent.sourceClientId ||
          capture.eventEpoch !== candidate.eventEpoch ||
          watermark < capture.startEventId
        ) {
          return false;
        }
        const tail = capture.events.filter(
          (event) =>
            event.id !== undefined &&
            event.id > watermark &&
            event.id <= snapshot.processedEventId!,
        );
        candidate.setLastEventId(snapshot.processedEventId);
        try {
          staged = stageCrossSession({
            session: candidate,
            capabilities,
            maxBlocks,
            subagentTranscriptMode: subagentTranscriptModeRef.current,
            eventOptions: eventOptionsRef.current,
            additionalEvents: tail,
          });
        } catch {
          return false;
        }
        if (
          staged.repair ||
          staged.notices.some(
            (notice) => notice.code === 'daemon.replay_event_malformed',
          )
        ) {
          return false;
        }
      }

      const finalSnapshot = control?.snapshot();
      if (
        desiredTransitionRef.current !== intent ||
        sessionRef.current !== intent.source ||
        intent.source.clientId !== intent.sourceClientId ||
        finalSnapshot?.session !== intent.source ||
        finalSnapshot.clientId !== intent.sourceClientId ||
        finalSnapshot.eventEpoch !== candidate.eventEpoch ||
        finalSnapshot.processedEventId !== snapshot.processedEventId ||
        !finalSnapshot.ready ||
        finalSnapshot.activeTurn ||
        (intent.deadlineAt !== undefined && Date.now() >= intent.deadlineAt)
      ) {
        return false;
      }

      if (intent.timeout !== undefined) clearTimeout(intent.timeout);
      if (control.capture === capture) control.capture = undefined;
      control.flush();
      control.stop();
      candidate.setLastEventId(finalSnapshot.processedEventId);
      if (staged) {
        store.reset(staged.transcript);
        transcriptHistoryRef.current = staged.history;
        setTranscriptHistoryState({
          hasMore: staged.history.hasMore,
          loading: false,
          capacityReached: staged.history.capacityReached,
          paginationError: false,
        });
      } else {
        const history = {
          ...transcriptHistoryRef.current,
          loading: false,
        };
        transcriptHistoryRef.current = history;
        setTranscriptHistoryState({
          hasMore: history.hasMore,
          loading: false,
          capacityReached: history.capacityReached,
          paginationError: history.paginationError,
        });
      }
      sessionRef.current = candidate;
      lastSessionIdRef.current = candidate.sessionId;
      activeWorkspaceCwdRef.current = candidate.workspaceCwd;
      clientIdRef.current = candidate.clientId;
      persistStableClientId(candidate.clientId!, candidate.sessionId);
      setConnectionSynchronous((current) => {
        const next = {
          ...current,
          status: 'connected' as const,
          sessionId: candidate.sessionId,
          clientId: candidate.clientId,
          workspaceCwd: candidate.workspaceCwd,
          capabilities,
          loadingTranscript: undefined,
          catchingUp: undefined,
          error: undefined,
          errorStatus: undefined,
          missingSession: false,
        };
        delete next.sessionTransition;
        return next;
      });
      desiredTransitionRef.current = undefined;
      if (candidate.hasActivePrompt) {
        settledRestoredActivePromptSessionsRef.current.add(candidate);
      }
      hasCurrentSessionActivePromptRef.current = () => false;
      clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
      setPromptStatus('idle');
      liveJournalRepairRef.current?.controller?.abort();
      liveJournalRepairRef.current = undefined;
      preparedRunnerRef.current = { session: candidate, capabilities };
      manualSessionClearRef.current = false;
      setRestoreMode(intent.mode);
      setRestoreSessionId(candidate.sessionId);
      setRestoreWorkspaceCwd(candidate.workspaceCwd);
      setRestoreSessionNonce((nonce) => nonce + 1);
      settleCrossSessionIntent(intent);
      retireAttachment(intent.source, intent);
      return true;
    },
    [maxBlocks, retireAttachment, setConnectionSynchronous, store],
  );

  const pumpCrossSessionTransition = useCallback(() => {
    const intent = desiredTransitionRef.current;
    if (!intent) return;
    if (
      intent.lifecycle !== lifecycleRef.current ||
      intent.environmentGeneration !== environmentRef.current.generation
    ) {
      exposeCrossSessionFailure(
        intent,
        new DOMException(
          'Session transition environment changed',
          'AbortError',
        ),
      );
      return;
    }
    if (intent.deadlineAt !== undefined && Date.now() >= intent.deadlineAt) {
      exposeCrossSessionFailure(
        intent,
        new Error('Session transition timed out before restore started'),
        {
          preserveInFlightCapture: rawTransitionRef.current === intent,
        },
      );
      return;
    }
    const capabilities =
      workspaceCapabilitiesRef.current ??
      sessionCapabilitiesRef.current ??
      connectionRef.current.capabilities;
    if (!capabilities?.features.includes(CLIENT_IDENTITY_FEATURE)) return;

    if (intent.sameLogical && intent.candidate) {
      const candidate = intent.candidate;
      const snapshot = runnerControlRef.current?.snapshot();
      if (
        intent.capture?.invalidReason ||
        sessionRef.current !== intent.source ||
        intent.source.clientId !== intent.sourceClientId ||
        snapshot?.session !== intent.source ||
        snapshot.clientId !== intent.sourceClientId ||
        snapshot.eventEpoch !== candidate.eventEpoch
      ) {
        exposeCrossSessionFailure(
          intent,
          new Error(
            intent.capture?.invalidReason ??
              'Current attachment changed before refresh commit',
          ),
        );
        return;
      }
      if (intent.deadlineAt !== undefined && Date.now() >= intent.deadlineAt) {
        exposeCrossSessionFailure(
          intent,
          new Error('Session transition timed out'),
        );
        return;
      }
      if (
        !snapshot.ready ||
        snapshot.activeTurn ||
        hasCurrentSessionActivePromptRef.current() ||
        snapshot.processedEventId === undefined ||
        candidate.lastEventId === undefined ||
        snapshot.processedEventId < candidate.lastEventId ||
        (candidate.hasActivePrompt &&
          (snapshot.lastPromptTerminalEventId === undefined ||
            snapshot.lastPromptTerminalEventId <= candidate.lastEventId))
      ) {
        return;
      }
      if (
        !commitSameSession(
          intent,
          candidate,
          intent.candidateCapabilities ?? capabilities,
          intent.capture,
        )
      ) {
        exposeCrossSessionFailure(
          intent,
          new Error('Session refresh failed integrity validation'),
        );
      }
      return;
    }

    if (rawTransitionRef.current) return;
    if (intent.sameLogical) {
      const snapshot = runnerControlRef.current?.snapshot();
      if (
        snapshot?.session !== intent.source ||
        snapshot.clientId !== intent.sourceClientId ||
        snapshot.eventEpoch === undefined ||
        snapshot.processedEventId === undefined ||
        !Number.isSafeInteger(snapshot.processedEventId) ||
        snapshot.processedEventId < 0
      ) {
        exposeCrossSessionFailure(
          intent,
          new Error(
            'Current attachment cursor is unavailable; session was preserved',
          ),
        );
        return;
      }
      if (
        !snapshot.ready ||
        snapshot.activeTurn ||
        hasCurrentSessionActivePromptRef.current()
      ) {
        setConnectionSynchronous((current) => ({
          ...current,
          sessionTransition: transitionState(intent, 'queued'),
        }));
        return;
      }
      const capture: SameSessionCapture = {
        source: intent.source,
        sourceClientId: intent.sourceClientId,
        eventEpoch: snapshot.eventEpoch,
        startEventId: snapshot.processedEventId,
        lastCapturedEventId: snapshot.processedEventId,
        bytes: 0,
        events: [],
      };
      intent.capture = capture;
      if (intent.mode === 'load') {
        runnerControlRef.current!.capture = capture;
      }
      armTransitionDeadline(intent, capabilities);
    }
    const requestClientId = intent.targetClientId;
    if (!requestClientId) {
      exposeCrossSessionFailure(
        intent,
        new Error('Session restore client identity is unavailable'),
      );
      return;
    }
    rawTransitionRef.current = intent;
    setConnectionSynchronous((current) => ({
      ...current,
      sessionTransition: transitionState(intent, 'preparing'),
    }));
    const client =
      workspaceClientRef.current ??
      new DaemonClient({ baseUrl: resolvedBaseUrl!, token: resolvedToken });
    const remaining =
      intent.deadlineAt === undefined
        ? undefined
        : Math.max(1, intent.deadlineAt - Date.now());
    const requestBudget =
      resolveSessionRestoreTimeouts(capabilities).requestTimeoutMs;
    const timeoutMs =
      requestBudget === 0
        ? (remaining ?? 0)
        : remaining === undefined
          ? requestBudget
          : Math.min(requestBudget, remaining);
    const restore =
      intent.mode === 'resume'
        ? DaemonSessionClient.resume
        : DaemonSessionClient.load;
    let retryScheduled = false;
    void restore(
      client,
      intent.sessionId,
      {
        workspaceCwd: intent.workspaceCwd,
        timeoutMs,
        ...(intent.effectiveHistoryPageSize !== undefined
          ? { historyPageSize: intent.effectiveHistoryPageSize }
          : {}),
      },
      requestClientId,
    )
      .then((candidate) => {
        const latest = desiredTransitionRef.current;
        if (
          !candidate.clientId ||
          (intent.sameLogical && candidate.clientId !== requestClientId) ||
          candidate.sessionId !== intent.sessionId ||
          normalizeWorkspaceIdentity(candidate.workspaceCwd) !==
            normalizeWorkspaceIdentity(intent.workspaceCwd)
        ) {
          retireAttachment(candidate, intent);
          if (latest === intent) {
            exposeCrossSessionFailure(
              latest,
              new Error('Session restore returned an invalid owner identity'),
            );
          }
          return;
        }
        if (
          intent.sameLogical &&
          (candidate.eventEpoch === undefined ||
            candidate.eventEpoch !== intent.capture?.eventEpoch ||
            candidate.lastEventId === undefined ||
            !Number.isSafeInteger(candidate.lastEventId) ||
            candidate.lastEventId < 0 ||
            candidate.replayPartial ||
            candidate.replayError !== undefined ||
            candidate.replayDegraded ||
            (intent.mode === 'load' &&
              (!candidate.replaySnapshotComplete ||
                !intent.capture ||
                candidate.lastEventId < intent.capture.startEventId)))
        ) {
          retireAttachment(candidate, intent);
          if (latest?.key === intent.key) {
            exposeCrossSessionFailure(
              latest,
              new Error('Session refresh returned an incomplete snapshot'),
            );
          }
          return;
        }
        if (
          intent.resultSuperseded === true ||
          latest?.key !== intent.key ||
          latest.lifecycle !== intent.lifecycle ||
          latest.environmentGeneration !== intent.environmentGeneration
        ) {
          retireAttachment(candidate, intent);
          return;
        }
        if (latest.sameLogical) {
          latest.capture = intent.capture;
          latest.candidate = candidate;
          latest.candidateCapabilities = capabilities;
          return;
        }
        let staged: StagedCrossSession;
        try {
          staged = stageCrossSession({
            session: candidate,
            capabilities,
            maxBlocks,
            subagentTranscriptMode: subagentTranscriptModeRef.current,
            eventOptions: eventOptionsRef.current,
          });
        } catch (error) {
          retireAttachment(candidate, intent);
          exposeCrossSessionFailure(latest, error);
          return;
        }
        if (!commitCrossSession(latest, staged)) {
          retireAttachment(candidate, intent);
          exposeCrossSessionFailure(
            latest,
            new DOMException(
              'Session transition became stale before commit',
              'AbortError',
            ),
          );
        }
      })
      .catch((error: unknown) => {
        const latest = desiredTransitionRef.current;
        if (
          autoReconnect &&
          latest === intent &&
          isClosingSessionLoadError(error)
        ) {
          retryScheduled = true;
          intent.retryAttempt = (intent.retryAttempt ?? 0) + 1;
          const reconnectConfig = reconnectConfigRef.current;
          setTimeout(
            pumpTransitionRef.current,
            getReconnectDelayMs(
              intent.retryAttempt,
              reconnectConfig.reconnectDelayMs,
              reconnectConfig.maxReconnectDelayMs,
            ),
          );
        } else if (latest === intent) {
          exposeCrossSessionFailure(latest, error);
        }
      })
      .finally(() => {
        if (rawTransitionRef.current === intent) {
          rawTransitionRef.current = undefined;
        }
        const capture = intent.capture;
        const latest = desiredTransitionRef.current;
        if (
          capture &&
          latest?.capture !== capture &&
          runnerControlRef.current?.capture === capture
        ) {
          runnerControlRef.current.capture = undefined;
        }
        if (!retryScheduled) pumpTransitionRef.current();
      });
  }, [
    armTransitionDeadline,
    autoReconnect,
    commitCrossSession,
    commitSameSession,
    exposeCrossSessionFailure,
    maxBlocks,
    resolvedBaseUrl,
    resolvedToken,
    retireAttachment,
    setConnectionSynchronous,
  ]);
  pumpTransitionRef.current = pumpCrossSessionTransition;

  const cancelCrossSessionTransition = useCallback(
    (reason: string) => {
      lifecycleRef.current += 1;
      const intent = desiredTransitionRef.current;
      desiredTransitionRef.current = undefined;
      if (intent) {
        cleanupTransitionArtifacts(intent, {
          preserveInFlightCapture: rawTransitionRef.current === intent,
        });
        settleCrossSessionIntent(
          intent,
          new DOMException(reason, 'AbortError'),
        );
      }
      setConnectionSynchronous((current) => {
        if (!current.sessionTransition) return current;
        const next = { ...current };
        delete next.sessionTransition;
        return next;
      });
    },
    [cleanupTransitionArtifacts, setConnectionSynchronous],
  );
  cancelTransitionRef.current = cancelCrossSessionTransition;

  const beginCrossSessionTransition = useCallback(
    (
      request: CrossSessionTarget,
      startLegacy: () => Promise<void>,
    ): Promise<void> => {
      const capabilities =
        workspaceCapabilitiesRef.current ??
        sessionCapabilitiesRef.current ??
        connectionRef.current.capabilities;
      const rejectPreflight = (error: Error) => {
        publishCrossSessionFailure(request, error);
        return Promise.reject(error);
      };
      if (!capabilities) {
        return rejectPreflight(
          new Error(
            'Daemon capabilities are unavailable; current session was preserved',
          ),
        );
      }
      if (sourceBoundOperationCountRef.current > 0) {
        return rejectPreflight(
          new DOMException(
            'Another session operation is already in progress',
            'InvalidStateError',
          ),
        );
      }
      if (!capabilities.features.includes(CLIENT_IDENTITY_FEATURE)) {
        return startLegacy();
      }
      if (!resolvedBaseUrl) {
        return rejectPreflight(
          new Error(
            'Daemon endpoint is unavailable; current session was preserved',
          ),
        );
      }
      const source = sessionRef.current;
      if (!source?.clientId) {
        return rejectPreflight(
          new Error(
            'The daemon advertises client identity but the current session has no clientId',
          ),
        );
      }
      if (pendingSessionLoadRef.current) {
        return rejectPreflight(
          new DOMException(
            'Another session restore is already in progress',
            'InvalidStateError',
          ),
        );
      }
      const pending = desiredTransitionRef.current;
      if (request.sameLogical && pending && !pending.sameLogical) {
        return Promise.reject(
          new DOMException(
            'A session switch is still preparing',
            'InvalidStateError',
          ),
        );
      }
      const effectiveHistoryPageSize =
        request.mode === 'load' &&
        historyPageSizeRef.current !== undefined &&
        capabilities.features.includes(SESSION_TRANSCRIPT_PAGINATION_FEATURE)
          ? historyPageSizeRef.current
          : undefined;
      const requestShape = crossSessionKey(
        request.sessionId,
        request.workspaceCwd,
        request.mode,
        effectiveHistoryPageSize,
        undefined,
      );
      const raw = rawTransitionRef.current;
      const rawShape = raw
        ? crossSessionKey(
            raw.sessionId,
            raw.workspaceCwd,
            raw.mode,
            raw.effectiveHistoryPageSize,
            undefined,
          )
        : undefined;
      const targetClientId =
        clientId ??
        (request.sameLogical
          ? source.clientId
          : rawShape === requestShape
            ? raw?.targetClientId
            : undefined) ??
        getStableClientId(undefined, request.sessionId);
      const key = crossSessionKey(
        request.sessionId,
        request.workspaceCwd,
        request.mode,
        effectiveHistoryPageSize,
        targetClientId,
      );
      if (raw && raw.key !== key) raw.resultSuperseded = true;
      const current = desiredTransitionRef.current;
      if (
        current?.key === key &&
        request.signal === undefined &&
        current.signal === undefined
      ) {
        return current.promise;
      }
      if (current) {
        cleanupTransitionArtifacts(current, {
          preserveInFlightCapture: rawTransitionRef.current === current,
        });
        settleCrossSessionIntent(
          current,
          new DOMException(
            'Session transition superseded by a newer request',
            'AbortError',
          ),
        );
      }
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const intent: CrossSessionIntent = {
        key,
        ...(effectiveHistoryPageSize !== undefined
          ? { effectiveHistoryPageSize }
          : {}),
        ...request,
        source,
        baseUrl: resolvedBaseUrl,
        token: resolvedToken,
        lifecycle: lifecycleRef.current,
        environmentGeneration: environmentRef.current.generation,
        sourceClientId: source.clientId,
        targetClientId,
        promise,
        resolve,
        reject,
      };
      desiredTransitionRef.current = intent;
      const adoptingRaw = rawTransitionRef.current?.key === key;
      if (request.sameLogical && adoptingRaw) {
        armTransitionDeadline(intent, capabilities);
      }
      if (request.signal) {
        const abort = () => {
          if (desiredTransitionRef.current !== intent) return;
          desiredTransitionRef.current = undefined;
          cleanupTransitionArtifacts(intent, {
            preserveInFlightCapture: rawTransitionRef.current === intent,
          });
          settleCrossSessionIntent(
            intent,
            request.signal?.reason ??
              new DOMException('Session transition cancelled', 'AbortError'),
          );
          setConnectionSynchronous((connectionState) => {
            if (!connectionState.sessionTransition) return connectionState;
            const next = { ...connectionState };
            delete next.sessionTransition;
            return next;
          });
          pumpTransitionRef.current();
        };
        request.signal.addEventListener('abort', abort, { once: true });
        intent.removeAbortListener = () =>
          request.signal?.removeEventListener('abort', abort);
        if (request.signal.aborted) {
          abort();
          return promise;
        }
      }
      if (!request.sameLogical) armTransitionDeadline(intent, capabilities);
      setConnectionSynchronous((connectionState) => ({
        ...connectionState,
        sessionTransition: transitionState(
          request,
          adoptingRaw
            ? 'preparing'
            : request.sameLogical || rawTransitionRef.current
              ? 'queued'
              : 'preparing',
        ),
      }));
      pumpTransitionRef.current();
      return promise;
    },
    [
      armTransitionDeadline,
      clientId,
      cleanupTransitionArtifacts,
      publishCrossSessionFailure,
      resolvedBaseUrl,
      resolvedToken,
      setConnectionSynchronous,
    ],
  );

  const actions = useMemo<DaemonSessionActions>(
    () =>
      createDaemonSessionActions({
        store,
        sessionRef,
        activePromptsRef,
        settledPromptsRef,
        pendingSessionLoadRef,
        pendingSessionLoadIdRef,
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
          if (!restartEventStreamOnPrompt) return;
          const eventStream = eventStreamRef.current;
          if (eventStream?.sessionId !== sessionId) return;
          eventStream.restartRequested = true;
          eventStream.controller.abort();
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
        getConnection: () => connectionRef.current,
        addNotice,
        setConnection,
        setPromptStatus: (update) => {
          setPromptStatus(update);
          queueMicrotask(pumpTransitionRef.current);
        },
        setRestoreSessionId,
        setRestoreWorkspaceCwd,
        setRestoreMode,
        setRestoreSessionNonce,
        setAttachSessionNonce,
        setNewSessionNonce,
        beginCrossSessionTransition,
        cancelCrossSessionTransition,
        isCrossSessionTransitionPending: () =>
          desiredTransitionRef.current !== undefined,
        isDifferentLogicalTransitionPending: () =>
          desiredTransitionRef.current?.sameLogical === false,
        isSourceBoundOperationInFlight: () =>
          sourceBoundOperationCountRef.current > 0,
        setSourceBoundOperationInFlight: (inFlight) => {
          sourceBoundOperationCountRef.current += inFlight ? 1 : -1;
          if (
            !inFlight &&
            sourceBoundOperationCountRef.current === 0 &&
            controlledRetryPendingRef.current
          ) {
            controlledRetryPendingRef.current = false;
            queueMicrotask(() => {
              if (mountedRef.current) {
                setControlledRetryNonce((nonce) => nonce + 1);
              }
            });
          }
        },
        sessionConfigGeneration: sessionConfigGenerationRef.current,
        getTransitionOrigin: () => {
          const controlled = controlledTransitionOriginRef.current;
          controlledTransitionOriginRef.current = false;
          return controlled ? 'controlled' : 'action';
        },
        clearLiveJournalRepair: () => {
          liveJournalRepairRef.current?.controller?.abort();
          liveJournalRepairRef.current = undefined;
        },
      }),
    [
      addNotice,
      beginCrossSessionTransition,
      cancelCrossSessionTransition,
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
      let terminalFailure = false;
      try {
        const page = await activeSession.client.getSessionTranscriptPage(
          activeSession.sessionId,
          {
            ...(history.cursor !== undefined
              ? { cursor: history.cursor }
              : history.beforeRecordId !== undefined
                ? { beforeRecordId: history.beforeRecordId }
                : {}),
            limit: historyPageSizeRef.current ?? 100,
            clientId: activeSession.clientId,
          },
        );
        if (
          sessionRef.current !== activeSession ||
          transcriptHistoryRef.current !== history
        ) {
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
        const historyMaterialization =
          uiEvents.length > 0
            ? materializeTranscriptHistory(
                store.getSnapshot(),
                uiEvents,
                maxBlocks,
              )
            : undefined;
        if (uiEvents.length > 0 && !historyMaterialization) {
          history.hasMore = false;
          history.loading = false;
          history.capacityReached = true;
          setTranscriptHistoryState({
            hasMore: false,
            loading: false,
            capacityReached: true,
            paginationError: false,
          });
          return;
        }
        if (historyMaterialization) {
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
  const lastHandledWorkspaceRef = useRef<string | undefined>(undefined);
  const lastHandledClientIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const targetWorkspaceCwd =
      resolvedWorkspaceCwd ?? connectionRef.current.workspaceCwd;
    const previousSessionId = lastHandledSessionIdRef.current;
    if (
      lastHandledSessionIdRef.current === sessionId &&
      normalizeWorkspaceIdentity(lastHandledWorkspaceRef.current) ===
        normalizeWorkspaceIdentity(targetWorkspaceCwd) &&
      lastHandledClientIdRef.current === clientId
    ) {
      return;
    }
    if (sessionId && sourceBoundOperationCountRef.current > 0) {
      controlledRetryPendingRef.current = true;
      return;
    }
    controlledRetryPendingRef.current = false;
    lastHandledSessionIdRef.current = sessionId;
    lastHandledWorkspaceRef.current = targetWorkspaceCwd;
    lastHandledClientIdRef.current = clientId;

    if (sessionId === undefined && previousSessionId === undefined) return;

    const pending = desiredTransitionRef.current;
    if (
      pending &&
      (pending.sessionId !== sessionId ||
        normalizeWorkspaceIdentity(pending.workspaceCwd) !==
          normalizeWorkspaceIdentity(targetWorkspaceCwd) ||
        (clientId !== undefined && pending.targetClientId !== clientId))
    ) {
      cancelTransitionRef.current(
        'Session transition cancelled by controlled target change',
      );
    }

    const currentSessionId = connectionRef.current.sessionId;
    const currentSession = sessionRef.current;
    const sameLogicalTarget =
      sessionId === currentSessionId &&
      normalizeWorkspaceIdentity(targetWorkspaceCwd) ===
        normalizeWorkspaceIdentity(connectionRef.current.workspaceCwd);
    const clientIdChanged =
      sameLogicalTarget &&
      currentSession !== undefined &&
      clientId !== undefined &&
      currentSession.clientId !== clientId;
    const controlledCapabilities =
      workspaceCapabilitiesRef.current ??
      sessionCapabilitiesRef.current ??
      connectionRef.current.capabilities;
    const needsTransactionalClientRebind =
      clientIdChanged &&
      (controlledCapabilities === undefined ||
        controlledCapabilities.features.includes(CLIENT_IDENTITY_FEATURE));
    if (sameLogicalTarget && !needsTransactionalClientRebind) {
      if (connectionRef.current.sessionTransition?.phase === 'failed') {
        setConnectionSynchronous((current) => {
          if (current.sessionTransition?.phase !== 'failed') return current;
          const next = { ...current };
          delete next.sessionTransition;
          return next;
        });
      }
      return;
    }

    if (sessionId) controlledTransitionOriginRef.current = true;
    const request = sessionId
      ? (needsTransactionalClientRebind
          ? actions.resumeSession
          : actions.loadSession)(sessionId, {
          ...(targetWorkspaceCwd !== undefined
            ? { workspaceCwd: targetWorkspaceCwd }
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
    controlledRetryNonce,
    resolvedWorkspaceCwd,
    sessionId,
    setConnectionSynchronous,
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
    suppressLogs?: boolean;
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
    if (
      !behavior.suppressLogs &&
      (notice.category === 'protocol' || notice.category === 'connection')
    ) {
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
): void {
  let memory = 0;
  let agents = 0;
  let tools = 0;
  let settings = 0;
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
        settings += 1;
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
    0
  )
    return;

  setSignals((current) => ({
    memoryVersion: current.memoryVersion + memory,
    agentsVersion: current.agentsVersion + agents,
    toolsVersion: current.toolsVersion + tools,
    settingsVersion: current.settingsVersion + settings,
    mcpVersion: current.mcpVersion + mcp,
    extensionsVersion: current.extensionsVersion + extensions,
    artifactsVersion: current.artifactsVersion + artifacts,
    ...(lastExtensionChange ? { lastExtensionChange } : {}),
    initVersion: current.initVersion + init,
    authVersion: current.authVersion + auth,
  }));
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
