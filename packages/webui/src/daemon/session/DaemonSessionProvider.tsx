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
import { createDaemonSessionActions } from './actions.js';
import { detachDaemonClient, getStableClientId } from './clientLifecycle.js';
import { useOptionalDaemonWorkspace } from '../workspace/DaemonWorkspaceProvider.js';
import {
  getCurrentMode,
  mapProviderStatus,
  mapSupportedCommands,
  updateConnectionFromDaemonEvent,
} from './mappers.js';
import {
  selectDaemonActiveTodoList,
  selectDaemonLatestTodoList,
  selectDaemonPendingPermissions,
  selectDaemonPendingPermissionRequest,
  selectDaemonStreamingState,
  selectDaemonTodoLists,
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
import type {
  ActivePrompt,
  DaemonConnectionState,
  DaemonPromptStatus,
  DaemonSessionActions,
  DaemonSessionContextValue,
  DaemonSessionProviderProps,
  DaemonWorkspaceEventSignals,
  PendingSessionLoad,
} from './types.js';

export type {
  DaemonCommandInfo,
  DaemonConnectionState,
  DaemonConnectionStatus,
  DaemonModelInfo,
  DaemonPendingPermissionRequest,
  DaemonPermissionOptionKind,
  DaemonPermissionRequestOption,
  DaemonPromptImage,
  DaemonPromptStatus,
  DaemonSessionActions,
  DaemonSessionContextValue,
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
  mcpVersion: 0,
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
 * 404/410 (session-not-found) keep the reconnect-then-recreate behavior —
 * those are recoverable by creating a fresh session.
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
  const resolvedWorkspaceCwdRef = useRef(resolvedWorkspaceCwd);
  resolvedWorkspaceCwdRef.current = resolvedWorkspaceCwd;

  const store = useMemo(
    () => createDaemonTranscriptStore({ maxBlocks }),
    [maxBlocks],
  );
  const sessionRef = useRef<DaemonSessionClient | undefined>(undefined);
  const lastSessionIdRef = useRef<string | undefined>(undefined);
  const activePromptsRef = useRef<Map<string, ActivePrompt>>(new Map());
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

      while (!disposed && !abort.signal.aborted) {
        try {
          let isSameSessionReconnect = false;
          let shouldInjectReplaySnapshot = false;
          if (!session) {
            setConnection((current) => ({
              ...current,
              status: 'connecting',
              error: undefined,
            }));
            const caps = await client.capabilities();
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
            const nextSession = restoreSessionId
              ? await restoreMethod(
                  client,
                  restoreSessionId,
                  { workspaceCwd: effectWorkspaceCwd },
                  clientIdRef.current,
                )
              : reconnectSessionId
                ? await DaemonSessionClient.load(
                    client,
                    reconnectSessionId,
                    { workspaceCwd: effectWorkspaceCwd },
                    clientIdRef.current,
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
                    clientIdRef.current,
                  );
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
            if (
              previousSessionId !== undefined &&
              nextSession.sessionId !== previousSessionId
            ) {
              setPromptStatus('idle');
              clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
              store.reset();
            } else if (previousSessionId !== undefined) {
              const replaySnapshotEventCount =
                nextSession.replaySnapshot.compactedReplay.length +
                nextSession.replaySnapshot.liveJournal.length;
              if (replaySnapshotEventCount > 0) {
                setPromptStatus('idle');
                clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                store.reset();
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
            workspaceCwd: activeSession.workspaceCwd,
            commands,
            skills,
            models,
            currentModel,
            currentMode,
            tokenCount:
              current.sessionId === activeSession.sessionId
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
          const { compactedReplay, liveJournal } = activeSession.replaySnapshot;
          const replayEvents = [...compactedReplay, ...liveJournal];
          if (shouldInjectReplaySnapshot && replayEvents.length > 0) {
            const replayOpts = {
              ...eventOptionsRef.current,
              suppressOwnUserEcho: false,
            };
            const allUiEvents: DaemonUiEvent[] = [];
            for (const replayEvent of replayEvents) {
              try {
                allUiEvents.push(
                  ...normalizeAndFilterEvent(
                    replayEvent,
                    activeSession.clientId,
                    replayOpts,
                    setConnection,
                    { updateConnection: false },
                  ),
                );
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                allUiEvents.push({
                  type: 'error',
                  text: `Skipped malformed replay event: ${message}`,
                  recoverable: true,
                });
              }
            }
            if (allUiEvents.length > 0) {
              store.dispatch(allUiEvents);
              bumpWorkspaceEventSignals(allUiEvents, setWorkspaceEventSignals);
            }
            let activePromptSettled = false;
            for (const replayEvent of replayEvents) {
              activePromptSettled =
                settleActivePromptFromTurnEvent(
                  activePromptsRef.current,
                  activeSession.sessionId,
                  replayEvent,
                  store,
                  setPromptStatus,
                  passiveAssistantDoneTimerRef,
                  { requireBoundPromptId: true },
                ) || activePromptSettled;
            }
            const lastReplayEvent = replayEvents[replayEvents.length - 1];
            if (
              !activePromptSettled &&
              lastReplayEvent &&
              (lastReplayEvent.type === 'turn_complete' ||
                lastReplayEvent.type === 'turn_error') &&
              !activePromptsRef.current.has(activeSession.sessionId)
            ) {
              store.dispatch({
                type: 'assistant.done',
                reason: 'replay_complete',
              });
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
              const uiEvents = normalizeAndFilterEvent(
                event,
                activeSession.clientId,
                eventOptionsRef.current,
                setConnection,
              );
              bumpWorkspaceEventSignals(uiEvents, setWorkspaceEventSignals);
              if (uiEvents.length > 0) {
                setPromptStatus((current) =>
                  current === 'waiting' ? 'streaming' : current,
                );
              }
              const activePromptSettled = settleActivePromptFromTurnEvent(
                activePromptsRef.current,
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
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              store.dispatch({
                type: 'error',
                text: `Skipped malformed daemon event: ${message}`,
                recoverable: true,
              });
            }
          }
          if (!disposed && !abort.signal.aborted && !resyncRequested) {
            // Keep the session handle after a normal SSE close so the next
            // subscription can resume from DaemonSessionClient.lastEventId.
            if (sessionRef.current?.sessionId === activeSession.sessionId) {
              clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
              setPromptStatus('idle');
              store.dispatch({
                type: 'assistant.done',
                reason: 'stream_ended',
              });
            }
            store.dispatch({
              type: 'status',
              text: 'SSE stream ended',
            });
            setConnection((current) => ({
              ...current,
              status: 'disconnected',
              error: 'SSE stream ended',
            }));
          }
        } catch (error) {
          if (disposed || abort.signal.aborted) return;
          const message =
            error instanceof Error ? error.message : String(error);
          const failedSessionId = session?.sessionId;
          if (
            failedSessionId &&
            (isAuthFailureHttpError(error) || isTerminalSessionHttpError(error))
          ) {
            const active = activePromptsRef.current.get(failedSessionId);
            active?.controller.abort();
            activePromptsRef.current.delete(failedSessionId);
          }
          store.dispatch({ type: 'error', text: message, recoverable: true });
          session = undefined;
          sessionRef.current = undefined;
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
          // Auth failures (401 / 403) must NOT retry even when
          // `autoReconnect: true`. Retrying with the same invalid token
          // loops forever — the daemon keeps returning 401, each cycle
          // risks transcript wipes via the sessionId-change branch above,
          // and the user sees no actionable error state.
          // Surface as a terminal 'error' connection state regardless of
          // the autoReconnect setting; the user must update credentials.
          if (isAuthFailureHttpError(error)) {
            setConnection({
              status: 'error',
              error: message,
            });
            return;
          }
          if (isTerminalSessionHttpError(error)) {
            reconnectSessionId = undefined;
            if (restoreSessionId) {
              setRestoreSessionId(undefined);
            }
          }
          if (!autoReconnect) {
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
          new Error('Session load interrupted by cleanup'),
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
        pendingSessionLoadRef,
        pendingSessionLoadIdRef,
        heartbeatSupportedRef,
        passiveAssistantDoneTimerRef,
        setConnection,
        setPromptStatus,
        setRestoreSessionId,
        setRestoreMode,
        setRestoreSessionNonce,
        setNewSessionNonce,
      }),
    [store],
  );
  return (
    <DaemonStoreContext.Provider value={store}>
      <DaemonConnectionContext.Provider value={connection}>
        <DaemonPromptStatusContext.Provider value={promptStatus}>
          <DaemonWorkspaceEventSignalsContext.Provider
            value={workspaceEventSignals}
          >
            <DaemonActionsContext.Provider value={actions}>
              {children}
            </DaemonActionsContext.Provider>
          </DaemonWorkspaceEventSignalsContext.Provider>
        </DaemonPromptStatusContext.Provider>
      </DaemonConnectionContext.Provider>
    </DaemonStoreContext.Provider>
  );
}

function settleActivePromptFromTurnEvent(
  activePrompts: Map<string, ActivePrompt>,
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
      activePrompts.set(sessionId, {
        ...active,
        promptId,
        pendingResult: result,
      });
    }
  } catch (error) {
    store.dispatch({ type: 'assistant.done', reason: 'error' });
    setPromptStatus('idle');
    if (active.reject) {
      activePrompts.delete(sessionId);
      active.reject(error);
    } else {
      activePrompts.set(sessionId, {
        ...active,
        promptId,
        pendingError: error,
      });
    }
  }
  return true;
}

function isPromptLifecycleTurnEvent(event: DaemonEvent): boolean {
  return event.type === 'turn_complete' || event.type === 'turn_error';
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
  return isPromptLifecycleTurnEvent(event) ? [] : normalized;
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

export function useDaemonPendingPermissionRequest() {
  const blocks = useDaemonTranscriptBlocks();
  return useMemo(() => selectDaemonPendingPermissionRequest(blocks), [blocks]);
}

export function useDaemonTodoLists() {
  const blocks = useDaemonTranscriptBlocks();
  return useMemo(() => selectDaemonTodoLists(blocks), [blocks]);
}

export function useDaemonLatestTodoList() {
  const blocks = useDaemonTranscriptBlocks();
  return useMemo(() => selectDaemonLatestTodoList(blocks), [blocks]);
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

function bumpWorkspaceEventSignals(
  events: ReadonlyArray<{ type: string }>,
  setSignals: Dispatch<SetStateAction<DaemonWorkspaceEventSignals>>,
): void {
  let memory = 0;
  let agents = 0;
  let tools = 0;
  let mcp = 0;
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
      case 'workspace.mcp.budget_warning':
      case 'workspace.mcp.child_refused':
      case 'workspace.mcp.server_restarted':
      case 'workspace.mcp.server_restart_refused':
        mcp += 1;
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

  if (memory + agents + tools + mcp + init + auth === 0) return;

  setSignals((current) => ({
    memoryVersion: current.memoryVersion + memory,
    agentsVersion: current.agentsVersion + agents,
    toolsVersion: current.toolsVersion + tools,
    mcpVersion: current.mcpVersion + mcp,
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
