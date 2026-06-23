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
  matchTurnEvent,
  normalizeDaemonEvent,
  type DaemonEvent,
  type DaemonTranscriptBlock,
  type DaemonTranscriptState,
  type DaemonTranscriptStore,
  type DaemonTurnCompleteData,
  type DaemonUiEvent,
} from '@qwen-code/sdk/daemon';
import { createDaemonSessionActions, getPromptSettledKey } from './actions.js';
import {
  detachDaemonClient,
  getStableClientId,
  persistStableClientId,
} from './clientLifecycle.js';
import { useOptionalDaemonWorkspace } from '../workspace/DaemonWorkspaceProvider.js';
import {
  getCurrentMode,
  getSessionDisplayName,
  getReplayTokenUsage,
  getTokenCountFromUsage,
  mapProviderStatus,
  mapSupportedCommands,
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
import type {
  ActivePrompt,
  AddDaemonSessionNotice,
  DaemonConnectionState,
  DaemonPromptStatus,
  DaemonSessionActions,
  DaemonSessionContextValue,
  DaemonSessionNotice,
  DaemonSessionProviderProps,
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

const DaemonStoreContext = createContext<DaemonTranscriptStore | undefined>(
  undefined,
);
const DaemonConnectionContext = createContext<
  DaemonConnectionState | undefined
>(undefined);
const DaemonActionsContext = createContext<DaemonSessionActions | undefined>(
  undefined,
);
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
const TERMINAL_SESSION_HTTP_STATUSES = new Set([401, 403, 404, 410]);
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
  initVersion: 0,
  authVersion: 0,
};

/**
 * Subset of TERMINAL_SESSION_HTTP_STATUSES that represent **credential
 * failures** (vs session-not-found 404/410). Auth failures should NOT enter
 * the reconnect loop even when `autoReconnect: true` — retrying with the
 * same bad token loops forever, hammering the server with bad credentials
 * and risking transcript wipes if reconnect later attaches a different
 * session and hits the sessionId-change `store.reset()` branch.
 *
 * 404/410 (session-not-found) normally keep the reconnect-then-recreate
 * behavior, unless the caller opts into leaving missing sessions disconnected.
 */
const AUTH_FAILURE_HTTP_STATUSES = new Set([401, 403]);

export function DaemonSessionProvider({
  baseUrl,
  token,
  workspaceCwd,
  initialSessionId,
  clientId,
  createSessionRequest,
  maxQueued = 1024,
  maxBlocks = DEFAULT_MAX_BLOCKS,
  suppressOwnUserEcho = true,
  includeRawEvent = false,
  autoConnect = true,
  autoReconnect = true,
  missingSessionBehavior = 'create',
  reconnectDelayMs = 1_000,
  maxReconnectDelayMs = 10_000,
  heartbeatIntervalMs = 30_000,
  heartbeatFailureThreshold = 3,
  loadWarnings,
  children,
}: DaemonSessionProviderProps) {
  const workspace = useOptionalDaemonWorkspace();
  const resolvedBaseUrl = baseUrl ?? workspace?.baseUrl;
  const resolvedToken = token ?? workspace?.token;
  const resolvedWorkspaceCwd = workspaceCwd ?? workspace?.workspaceCwd;
  const workspaceClientRef = useRef(workspace?.client);
  workspaceClientRef.current = workspace?.client;
  const workspaceCapabilitiesRef = useRef(workspace?.capabilities);
  workspaceCapabilitiesRef.current = workspace?.capabilities;
  const workspaceGetCapabilitiesRef = useRef(workspace?.getCapabilities);
  workspaceGetCapabilitiesRef.current = workspace?.getCapabilities;
  const resolvedWorkspaceCwdRef = useRef(resolvedWorkspaceCwd);
  resolvedWorkspaceCwdRef.current = resolvedWorkspaceCwd;

  const store = useMemo(
    () => createDaemonTranscriptStore({ maxBlocks }),
    [maxBlocks],
  );
  const sessionRef = useRef<DaemonSessionClient | undefined>(undefined);
  const lastSessionIdRef = useRef<string | undefined>(undefined);
  const activePromptsRef = useRef<Map<string, ActivePrompt>>(new Map());
  const settledPromptsRef = useRef<Map<string, SettledPrompt>>(new Map());
  const pendingSessionLoadRef = useRef<PendingSessionLoad | undefined>(
    undefined,
  );
  const pendingSessionLoadIdRef = useRef(0);
  const passiveAssistantDoneTimerRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const heartbeatSupportedRef = useRef(false);
  const eventOptionsRef = useRef({ suppressOwnUserEcho, includeRawEvent });
  const reconnectConfigRef = useRef({ reconnectDelayMs, maxReconnectDelayMs });
  const loadWarningsRef = useRef(loadWarnings);
  const clientIdRef = useRef<string | undefined>(undefined);
  if (!clientIdRef.current || clientId) {
    clientIdRef.current = getStableClientId(clientId);
  }
  eventOptionsRef.current = { suppressOwnUserEcho, includeRawEvent };
  reconnectConfigRef.current = { reconnectDelayMs, maxReconnectDelayMs };
  loadWarningsRef.current = loadWarnings;
  const modelServiceId = createSessionRequest?.modelServiceId;
  const sessionScope = createSessionRequest?.sessionScope;
  const [promptStatus, setPromptStatus] = useState<DaemonPromptStatus>('idle');
  const [restoreSessionId, setRestoreSessionId] = useState<string | undefined>(
    initialSessionId,
  );
  const [restoreMode, setRestoreMode] = useState<'load' | 'resume'>('load');
  const [restoreSessionNonce, setRestoreSessionNonce] = useState(0);
  const [newSessionNonce, setNewSessionNonce] = useState(0);
  const [connection, setConnection] = useState<DaemonConnectionState>({
    status: autoConnect ? 'connecting' : 'idle',
  });
  const noticeIdRef = useRef(0);
  const [notices, setNotices] = useState<DaemonSessionNotice[]>([]);
  const addNotice = useCallback<AddDaemonSessionNotice>((input) => {
    const notice: DaemonSessionNotice = {
      ...input,
      id: input.id ?? `daemon-notice-${Date.now()}-${++noticeIdRef.current}`,
      createdAt: input.createdAt ?? Date.now(),
    };
    setNotices((current) => [...current.slice(-49), notice]);
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

    const run = async () => {
      const client =
        workspaceClientRef.current ??
        new DaemonClient({ baseUrl: resolvedBaseUrl!, token: resolvedToken });
      let session: DaemonSessionClient | undefined;
      let capabilities:
        | Awaited<ReturnType<DaemonClient['capabilities']>>
        | undefined;
      let reconnectSessionId = restoreSessionId;
      let shouldCreateFreshSession = !restoreSessionId && newSessionNonce > 0;
      let reconnectAttempt = 0;
      // Set when the user explicitly deletes the session (server
      // publishes session_closed with reason 'client_close').
      // Reconnecting would auto-create a new session, undoing the
      // user's delete. Other session_closed reasons (idle_timeout,
      // last_client_detached) fall through to normal reconnect.
      let userDeletedSession = false;

      while (!disposed && !abort.signal.aborted) {
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
          // PATH B — Full reload (session cleared, terminal/auth errors,
          //   ring eviction):
          //   `session` is null → enter this block → DaemonSessionClient
          //   .load() fetches compactedReplay + liveJournal → deferred
          //   store.reset() + store.dispatch(replayEvents) rebuilds the
          //   full transcript in a single synchronous batch.
          //
          // The `needsStoreReset` flag defers store.reset() to avoid an
          // intermediate empty-blocks state that causes virtualizer
          // removeChild errors (see replay injection section below).
          // ─────────────────────────────────────────────────────────────
          let isSameSessionReconnect = false;
          let shouldInjectReplaySnapshot = false;
          let needsStoreReset = false;
          // Only populated when this attempt (re)loads the session: a reused
          // session object carries the snapshot from its original load, whose
          // usage may be older than the in-memory count.
          let replayTokenUsage: DaemonConnectionState['tokenUsage'];
          let replayTokenCount: number | undefined;
          if (!session) {
            setConnection((current) => ({
              ...current,
              status: 'connecting',
              error: undefined,
            }));
            const getWorkspaceCapabilities =
              workspaceGetCapabilitiesRef.current;
            const caps =
              workspaceCapabilitiesRef.current ??
              (getWorkspaceCapabilities
                ? await getWorkspaceCapabilities()
                : await client.capabilities());
            if (disposed || abort.signal.aborted) return;
            capabilities = caps;
            heartbeatSupportedRef.current =
              Array.isArray(caps.features) &&
              caps.features.includes('client_heartbeat');
            const effectWorkspaceCwd =
              resolvedWorkspaceCwdRef.current ?? caps.workspaceCwd;
            const restoreMethod =
              restoreSessionId && restoreMode === 'resume'
                ? DaemonSessionClient.resume
                : DaemonSessionClient.load;
            const targetSessionId = restoreSessionId ?? reconnectSessionId;
            const requestClientId = clientId
              ? clientIdRef.current
              : getStableClientId(undefined, targetSessionId);
            const nextSession = restoreSessionId
              ? await restoreMethod(
                  client,
                  restoreSessionId,
                  { workspaceCwd: effectWorkspaceCwd },
                  requestClientId,
                )
              : reconnectSessionId
                ? await DaemonSessionClient.load(
                    client,
                    reconnectSessionId,
                    { workspaceCwd: effectWorkspaceCwd },
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
            if (!clientId && nextSession.clientId) {
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
          const [providerResult, commandResult, contextResult] =
            await Promise.allSettled([
              client.workspaceProviders(),
              activeSession.supportedCommands(),
              activeSession.context(),
            ]);
          const providers =
            providerResult.status === 'fulfilled'
              ? providerResult.value
              : undefined;
          const supportedCommands =
            commandResult.status === 'fulfilled'
              ? commandResult.value
              : undefined;
          const context =
            contextResult.status === 'fulfilled'
              ? contextResult.value
              : undefined;
          const loadWarningTexts = [
            providerResult.status === 'rejected'
              ? loadWarningsRef.current?.models
              : undefined,
            commandResult.status === 'rejected'
              ? loadWarningsRef.current?.commands
              : undefined,
            contextResult.status === 'rejected'
              ? loadWarningsRef.current?.context
              : undefined,
          ].filter((warning): warning is string => Boolean(warning));
          const { models, currentModel, contextWindow } =
            mapProviderStatus(providers);
          const { commands, skills } = mapSupportedCommands(supportedCommands);
          const currentMode = getCurrentMode(context);

          setConnection((current) => ({
            status: 'connected',
            sessionId: activeSession.sessionId,
            // Surface the bound client id so consumers can recognize their own
            // originator-stamped frames (e.g. the web-shell's mid-turn dedupe).
            ...(activeSession.clientId
              ? { clientId: activeSession.clientId }
              : {}),
            workspaceCwd: activeSession.workspaceCwd,
            commands,
            skills,
            models,
            currentModel,
            currentMode,
            displayName:
              getSessionDisplayName(activeSession.state) ??
              (current.sessionId === activeSession.sessionId
                ? current.displayName
                : undefined),
            tokenUsage:
              // Keep token usage in sync with tokenCount: replay usage
              // supersedes in-memory state, same-session reconnect keeps it,
              // and a different session without replay usage starts empty.
              replayTokenUsage !== undefined
                ? replayTokenUsage
                : current.sessionId === activeSession.sessionId
                  ? current.tokenUsage
                  : undefined,
            tokenCount:
              // A freshly loaded snapshot covers everything up to the SSE
              // resume point, so its usage supersedes the in-memory count;
              // without one (or with a usage-less replay) keep the
              // same-session value and start anything else at 0.
              replayTokenCount !== undefined
                ? replayTokenCount
                : current.sessionId === activeSession.sessionId
                  ? (current.tokenCount ?? 0)
                  : 0,
            contextWindow,
            providers,
            supportedCommands,
            context,
            capabilities,
            catchingUp:
              isSameSessionReconnect ||
              activeSession.lastEventId != null ||
              undefined,
          }));
          setPromptStatus(
            activePromptsRef.current.has(activeSession.sessionId)
              ? 'streaming'
              : 'idle',
          );
          if (loadWarningTexts.length > 0) {
            store.dispatch(
              loadWarningTexts.map((text) => ({
                type: 'status' as const,
                text,
              })),
            );
          }

          const pendingLoad = pendingSessionLoadRef.current;
          const pendingLoadToResolve =
            pendingLoad?.sessionId === activeSession.sessionId
              ? pendingLoad
              : undefined;

          // Feed replay snapshot (compacted history + live journal) into
          // the store before starting the SSE loop. The SSE stream begins
          // from lastEventId, so only post-snapshot events are delivered.
          //
          // The deferred store.reset() runs here — in the same synchronous
          // block as store.dispatch() — so the queueMicrotask notification
          // only fires once with the fully-populated state.
          const { compactedReplay, liveJournal } = activeSession.replaySnapshot;
          const replayEvents = [...compactedReplay, ...liveJournal];
          if (
            needsStoreReset &&
            !(shouldInjectReplaySnapshot && replayEvents.length > 0)
          ) {
            // Reset needed but no replay data (e.g. fresh session) — reset
            // immediately since there is no dispatch to batch with.
            store.reset();
          }
          if (shouldInjectReplaySnapshot && replayEvents.length > 0) {
            const replayOpts = {
              ...eventOptionsRef.current,
              suppressOwnUserEcho: false,
            };
            const allUiEvents: DaemonUiEvent[] = [];
            for (const replayEvent of replayEvents) {
              try {
                const replayUiEvents = normalizeAndFilterEvent(
                  replayEvent,
                  activeSession.clientId,
                  replayOpts,
                  setConnection,
                  { updateConnection: false },
                );
                allUiEvents.push(
                  ...filterDaemonUiEventsForTranscript(
                    replayEvent,
                    replayUiEvents,
                    addNotice,
                  ),
                );
                if (replayEvent.type === 'turn_complete') {
                  const stopReason =
                    (replayEvent.data as DaemonTurnCompleteData | undefined)
                      ?.stopReason ?? 'end_turn';
                  allUiEvents.push({
                    type: 'assistant.done',
                    reason: stopReason,
                  });
                } else if (replayEvent.type === 'turn_error') {
                  allUiEvents.push({ type: 'assistant.done', reason: 'error' });
                }
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
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
            }
            if (needsStoreReset) {
              store.reset();
            }
            if (allUiEvents.length > 0) {
              store.dispatch(allUiEvents);
              bumpWorkspaceEventSignals(allUiEvents, setWorkspaceEventSignals);
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
            // If replay has a user message but no terminal signal
            // (turn_complete/turn_error/prompt_cancelled), the turn was
            // likely still in progress — seed promptStatus so the loading
            // indicator shows immediately instead of flickering.
            const hasTurnTerminalEvent = replayEvents.some(
              (e) =>
                e.type === 'turn_complete' ||
                e.type === 'turn_error' ||
                e.type === 'prompt_cancelled',
            );
            const hasReplayUserMessage = replayEvents.some(isUserMessageEvent);
            if (hasReplayUserMessage && !hasTurnTerminalEvent) {
              setPromptStatus((s) => (s === 'idle' ? 'waiting' : s));
            }
            setConnection((c) => ({ ...c, catchingUp: undefined }));
          }
          if (pendingLoadToResolve) {
            pendingSessionLoadRef.current = undefined;
            clearTimeout(pendingLoadToResolve.timeout);
            pendingLoadToResolve.resolve();
          }

          let sawEvent = false;
          let resyncRequested = false;
          let epochReplayUiEvents: DaemonUiEvent[] | undefined;
          let epochReplaySourceEvents: DaemonEvent[] = [];
          for await (const event of activeSession.events({
            signal: abort.signal,
            maxQueued,
          })) {
            if (!sawEvent) {
              sawEvent = true;
              reconnectAttempt = 0;
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
                // Transient UX signal — consumers drop these from their pending
                // queue. Not a transcript item, so skip normalization.
                publishSidechannelMidTurnInjected(midTurnInjected);
                continue;
              }
              const normalizedUiEvents = normalizeAndFilterEvent(
                event,
                activeSession.clientId,
                eventOptionsRef.current,
                setConnection,
              );
              const uiEvents = filterDaemonUiEventsForTranscript(
                event,
                normalizedUiEvents,
                addNotice,
              );
              if (event.type === 'state_resync_required') {
                const reason =
                  typeof event.data === 'object' && event.data !== null
                    ? (event.data as Record<string, unknown>).reason
                    : undefined;
                if (reason === 'epoch_reset') {
                  setPromptStatus('idle');
                  clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                  activeSession.setLastEventId(0);
                  epochReplayUiEvents = [];
                  epochReplaySourceEvents = [];
                  continue;
                }
              }
              if (epochReplayUiEvents) {
                epochReplaySourceEvents.push(event);
                epochReplayUiEvents.push(...uiEvents);
                if (event.type === 'turn_complete') {
                  const stopReason =
                    (event.data as DaemonTurnCompleteData | undefined)
                      ?.stopReason ?? 'end_turn';
                  epochReplayUiEvents.push({
                    type: 'assistant.done',
                    reason: stopReason,
                  });
                } else if (event.type === 'turn_error') {
                  epochReplayUiEvents.push({
                    type: 'assistant.done',
                    reason: 'error',
                  });
                }

                const replayComplete = uiEvents.some(
                  (uiEvent) => uiEvent.type === 'session.replay_complete',
                );
                if (replayComplete) {
                  if (!activePromptsRef.current.has(activeSession.sessionId)) {
                    clearPassiveAssistantDoneTimer(
                      passiveAssistantDoneTimerRef,
                    );
                    epochReplayUiEvents.push({
                      type: 'assistant.done',
                      reason: 'replay_complete',
                    });
                    setPromptStatus('idle');
                  }
                  const replayUiEvents = epochReplayUiEvents;
                  const replaySourceEvents = epochReplaySourceEvents;
                  epochReplayUiEvents = undefined;
                  epochReplaySourceEvents = [];
                  store.reset();
                  if (replayUiEvents.length > 0) {
                    store.dispatch(replayUiEvents);
                    bumpWorkspaceEventSignals(
                      replayUiEvents,
                      setWorkspaceEventSignals,
                    );
                  }
                  for (const replayEvent of replaySourceEvents) {
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

                // session_closed with client_close during epoch replay
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

                continue;
              }
              bumpWorkspaceEventSignals(uiEvents, setWorkspaceEventSignals);
              if (uiEvents.length > 0) {
                setPromptStatus((current) =>
                  current === 'waiting' ? 'streaming' : current,
                );
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
              const shouldGuardAssistant =
                !activePromptsRef.current.has(activeSession.sessionId) &&
                store.getSnapshot().activeAssistantBlockId != null;
              const eventsToDispatch = shouldGuardAssistant
                ? uiEvents.filter((e) => e.type !== 'debug')
                : uiEvents;
              store.dispatch(eventsToDispatch);
              for (const uiEvent of uiEvents) {
                if (
                  uiEvent.type === 'prompt.cancelled' &&
                  uiEvent.originatorClientId !== activeSession.clientId
                ) {
                  setPromptStatus('idle');
                  clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                  activePromptsRef.current.delete(activeSession.sessionId);
                } else if (uiEvent.type === 'session.replay_complete') {
                  setConnection((c) => ({ ...c, catchingUp: undefined }));
                  if (store.getSnapshot().awaitingResync) {
                    store.clearAwaitingResync();
                  }
                  if (!activePromptsRef.current.has(activeSession.sessionId)) {
                    clearPassiveAssistantDoneTimer(
                      passiveAssistantDoneTimerRef,
                    );
                    store.dispatch({
                      type: 'assistant.done',
                      reason: 'replay_complete',
                    });
                    setPromptStatus('idle');
                  }
                }
              }
              const isObserver =
                !activePromptSettled &&
                !activePromptsRef.current.has(activeSession.sessionId);
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
                store.dispatch({ type: 'assistant.done', reason: stopReason });
                setPromptStatus('idle');
              } else if (isObserver && event.type === 'turn_error') {
                clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                store.dispatch({ type: 'assistant.done', reason: 'error' });
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
              // ── state_resync_required handling ──────────────────────
              // Two sub-cases:
              //   epoch_reset — daemon restarted but ring is intact; reset
              //     store + rewind lastEventId so subsequent events rebuild
              //     the transcript from the ring on this same SSE stream.
              //   ring_evicted — too many events accumulated while we were
              //     disconnected; the ring lost earlier events, so we must
              //     break out and do a full session load (PATH B).
              if (event.type === 'state_resync_required') {
                const reason =
                  typeof event.data === 'object' && event.data !== null
                    ? (event.data as Record<string, unknown>).reason
                    : undefined;
                setPromptStatus('idle');
                clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                store.reset();
                if (reason === 'epoch_reset') {
                  activeSession.setLastEventId(0);
                } else {
                  // Ring eviction means the SSE replay window has a real gap.
                  // Resetting and continuing on the same stream can only replay
                  // the surviving tail; reload the session snapshot instead so
                  // compactedReplay/liveJournal rebuild the full transcript.
                  console.warn(
                    '[DaemonSessionProvider] ring eviction detected, reloading session (sessionId=%s)',
                    activeSession.sessionId,
                  );
                  resyncRequested = true;
                  session = undefined;
                  sessionRef.current = undefined;
                  setConnection((current) => ({
                    ...current,
                    status: 'connecting',
                    error: undefined,
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
          if (userDeletedSession) {
            // Session was explicitly closed (user deleted it). Do NOT
            // reconnect — doing so would auto-create a new session.
            // Note: we intentionally do NOT call setRestoreSessionId(undefined)
            // here because restoreSessionId is in the useEffect dependency
            // array — changing it would trigger an effect re-run that could
            // create a new session via createOrAttach.
            store.dispatch({ type: 'assistant.done', reason: 'cancelled' });
            setPromptStatus('idle');
            clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
            setConnection((current) => ({
              ...current,
              status: 'disconnected',
              sessionId: undefined,
              error: undefined,
            }));
            return;
          }
          if (!disposed && !abort.signal.aborted && !resyncRequested) {
            // Keep the session handle after a normal SSE close so the next
            // subscription can resume from DaemonSessionClient.lastEventId.
            if (sessionRef.current?.sessionId === activeSession.sessionId) {
              clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
              setPromptStatus('idle');
              console.debug('[DaemonSessionProvider] SSE stream ended');
              store.dispatch({
                type: 'assistant.done',
                reason: 'stream_ended',
              });
            }
            setConnection((current) => ({
              ...current,
              status: 'disconnected',
              error: undefined,
            }));
          }
        } catch (error) {
          if (disposed || abort.signal.aborted) return;
          const message =
            error instanceof Error ? error.message : String(error);
          const failedSessionId = session?.sessionId;
          const isAuthFailure = isAuthFailureHttpError(error);
          const isTerminal = isTerminalSessionHttpError(error);
          const shouldDisconnectMissingSession =
            isTerminal &&
            !isAuthFailure &&
            missingSessionBehavior === 'disconnect';
          if (failedSessionId && (isAuthFailure || isTerminal)) {
            const active = activePromptsRef.current.get(failedSessionId);
            active?.controller.abort();
            activePromptsRef.current.delete(failedSessionId);
          }
          clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
          setPromptStatus('idle');
          const pendingLoad = pendingSessionLoadRef.current;
          if (
            pendingLoad &&
            (pendingLoad.sessionId === restoreSessionId ||
              pendingLoad.sessionId === reconnectSessionId)
          ) {
            pendingSessionLoadRef.current = undefined;
            clearTimeout(pendingLoad.timeout);
            pendingLoad.reject(error);
          }
          if (isAuthFailure || isTerminal) {
            // Auth failures (401/403) and terminal session errors (404/410)
            // must clear the session — the server-side state is gone or
            // inaccessible, so delta resume is impossible.
            session = undefined;
            sessionRef.current = undefined;
            if (isAuthFailure) {
              setConnection({ status: 'error', error: message });
              return;
            }
            if (shouldDisconnectMissingSession) {
              setConnection((current) => ({
                ...current,
                status: 'disconnected',
                sessionId: undefined,
                error: message,
              }));
              return;
            }
            reconnectSessionId = undefined;
            if (restoreSessionId) {
              setRestoreSessionId(undefined);
            }
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
          }
          if (!autoReconnect) {
            session = undefined;
            sessionRef.current = undefined;
            setConnection({
              status: 'error',
              error: message,
            });
            return;
          }
          setConnection((current) => ({
            ...current,
            status: 'disconnected',
            error: message,
          }));
        }

        if (!autoReconnect) {
          sessionRef.current = undefined;
          setConnection((current) => ({
            ...current,
            status: 'disconnected',
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
          error: `Reconnecting in ${delayMs}ms`,
        }));
        await delay(delayMs, abort.signal);
      }
    };

    void run();
    return () => {
      const session = sessionRef.current;
      disposed = true;
      abort.abort();
      setPromptStatus('idle');
      clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
      if (pendingSessionLoadRef.current) {
        clearTimeout(pendingSessionLoadRef.current.timeout);
        pendingSessionLoadRef.current.reject(
          new DOMException('Session load interrupted by cleanup', 'AbortError'),
        );
        pendingSessionLoadRef.current = undefined;
      }
      if (session?.clientId) {
        void detachDaemonClient({
          baseUrl: resolvedBaseUrl!,
          token: resolvedToken,
          sessionId: session.sessionId,
          clientId: session.clientId,
        }).catch((err) =>
          console.warn('[DaemonSessionProvider] detach failed:', err),
        );
      }
      sessionRef.current = undefined;
    };
  }, [
    autoConnect,
    autoReconnect,
    missingSessionBehavior,
    resolvedBaseUrl,
    resolvedToken,
    workspaceCwd,
    modelServiceId,
    sessionScope,
    maxQueued,
    store,
    restoreSessionId,
    restoreMode,
    restoreSessionNonce,
    newSessionNonce,
    clientId,
    clearNotices,
    addNotice,
  ]);

  useEffect(() => {
    if (
      !heartbeatSupportedRef.current ||
      heartbeatIntervalMs <= 0 ||
      heartbeatFailureThreshold <= 0 ||
      !connection.sessionId
    ) {
      return undefined;
    }
    let disposed = false;
    let consecutiveFailures = 0;
    const timer = setInterval(() => {
      const session = sessionRef.current;
      if (!session) return;
      session
        .heartbeat()
        .then(() => {
          if (disposed) return;
          if (consecutiveFailures >= heartbeatFailureThreshold) {
            setConnection((current) =>
              current.sessionId === session.sessionId
                ? { ...current, status: 'connected', error: undefined }
                : current,
            );
          }
          consecutiveFailures = 0;
        })
        .catch((error: unknown) => {
          if (disposed) return;
          consecutiveFailures += 1;
          if (consecutiveFailures < heartbeatFailureThreshold) return;
          const message =
            error instanceof Error ? error.message : 'Session heartbeat failed';
          setConnection((current) =>
            current.sessionId === session.sessionId
              ? { ...current, status: 'disconnected', error: message }
              : current,
          );
        });
    }, heartbeatIntervalMs);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [connection.sessionId, heartbeatFailureThreshold, heartbeatIntervalMs]);

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
        passiveAssistantDoneTimerRef,
        addNotice,
        setConnection,
        setPromptStatus,
        setRestoreSessionId,
        setRestoreMode,
        setRestoreSessionNonce,
        setNewSessionNonce,
      }),
    [addNotice, store],
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
                {children}
              </DaemonActionsContext.Provider>
            </DaemonWorkspaceEventSignalsContext.Provider>
          </DaemonSessionNoticesContext.Provider>
        </DaemonPromptStatusContext.Provider>
      </DaemonConnectionContext.Provider>
    </DaemonStoreContext.Provider>
  );
}

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
    store.dispatch({ type: 'assistant.done', reason: result.stopReason });
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
    store.dispatch({ type: 'assistant.done', reason: 'error' });
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

function isUserMessageEvent(event: DaemonEvent): boolean {
  if (event.type !== 'session_update') return false;
  const data = event.data as
    | { update?: { sessionUpdate?: unknown } }
    | null
    | undefined;
  return data?.update?.sessionUpdate === 'user_message_chunk';
}

function normalizeAndFilterEvent(
  event: DaemonEvent,
  clientId: string | undefined,
  opts: { suppressOwnUserEcho: boolean; includeRawEvent: boolean },
  setConnection: Dispatch<SetStateAction<DaemonConnectionState>>,
  behavior: { updateConnection?: boolean } = {},
): DaemonUiEvent[] {
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

function filterDaemonUiEventsForTranscript(
  sourceEvent: DaemonEvent,
  events: DaemonUiEvent[],
  addNotice: AddDaemonSessionNotice,
): DaemonUiEvent[] {
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
  const blocks = useDaemonTranscriptBlocks();
  const promptStatus = useDaemonPromptStatus();

  return useMemo(
    () => selectDaemonStreamingState(blocks, promptStatus),
    [blocks, promptStatus],
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
    kind !== 'aborted'
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

  if (memory + agents + tools + settings + mcp + extensions + init + auth === 0)
    return;

  setSignals((current) => ({
    memoryVersion: current.memoryVersion + memory,
    agentsVersion: current.agentsVersion + agents,
    toolsVersion: current.toolsVersion + tools,
    settingsVersion: current.settingsVersion + settings,
    mcpVersion: current.mcpVersion + mcp,
    extensionsVersion: current.extensionsVersion + extensions,
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

function extractHttpStatus(error: unknown): number | undefined {
  if (error instanceof DaemonHttpError) return error.status;
  if (isRecord(error) && typeof error['status'] === 'number') {
    return error['status'];
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
