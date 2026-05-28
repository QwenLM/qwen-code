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
  normalizeDaemonEvent,
  type DaemonTranscriptBlock,
  type DaemonTranscriptState,
  type DaemonTranscriptStore,
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
import { transcriptBlocksToDaemonMessages } from './transcriptToMessages.js';
import type { DaemonMessage } from './messageTypes.js';
import {
  clearPassiveAssistantDoneTimer,
  delay,
  getReconnectDelayMs,
  schedulePassiveAssistantDone,
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

  const store = useMemo(() => createDaemonTranscriptStore(), []);
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
              store.dispatch({ type: 'assistant.done', reason: 'reconnected' });
              if (store.getSnapshot().awaitingResync) {
                store.clearAwaitingResync();
              }
            }
            isSameSessionReconnect =
              previousSessionId !== undefined &&
              previousSessionId === nextSession.sessionId;
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
          const pendingLoad = pendingSessionLoadRef.current;
          if (pendingLoad?.sessionId === activeSession.sessionId) {
            pendingSessionLoadRef.current = undefined;
            clearTimeout(pendingLoad.timeout);
            pendingLoad.resolve();
          }
          if (loadWarningTexts.length > 0) {
            store.dispatch(
              loadWarningTexts.map((text) => ({
                type: 'status' as const,
                text,
              })),
            );
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
              updateConnectionFromDaemonEvent(event, setConnection);
              const eventOptions = eventOptionsRef.current;
              const uiEvents = normalizeDaemonEvent(event, {
                clientId: activeSession.clientId,
                suppressOwnUserEcho: eventOptions.suppressOwnUserEcho,
                includeRawEvent: eventOptions.includeRawEvent,
              });
              bumpWorkspaceEventSignals(uiEvents, setWorkspaceEventSignals);
              if (uiEvents.length > 0) {
                setPromptStatus((current) =>
                  current === 'waiting' ? 'streaming' : current,
                );
              }
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
              const isObserver = !activePromptsRef.current.has(
                activeSession.sessionId,
              );
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
              if (isObserver && hasActiveGenerationSignal(uiEvents)) {
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
                if (reason === 'epoch_reset') {
                  store.reset();
                  activeSession.setLastEventId(0);
                } else if (reason !== 'ring_evicted') {
                  resyncRequested = true;
                  store.reset();
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

export function useDaemonMessages(): DaemonMessage[] {
  const blocks = useDaemonTranscriptBlocks();
  return useMemo(() => transcriptBlocksToDaemonMessages(blocks), [blocks]);
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
