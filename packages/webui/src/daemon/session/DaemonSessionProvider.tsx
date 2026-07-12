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
  mapSessionContextModels,
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
  sessionId?: string;
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
  } = props;
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
  const activeWorkspaceCwdRef = useRef(resolvedWorkspaceCwd);
  if (resolvedWorkspaceCwd) {
    activeWorkspaceCwdRef.current = resolvedWorkspaceCwd;
  }

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
  const heartbeatFailureStateRef = useRef<HeartbeatFailureState>({
    consecutiveFailures: 0,
  });
  const manualSessionClearRef = useRef(false);
  const skipNextCleanupDetachSessionIdRef = useRef<string | undefined>(
    undefined,
  );
  const settledRestoredActivePromptSessionsRef = useRef<
    WeakSet<DaemonSessionClient>
  >(new WeakSet());
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
  const createSessionRequestRef = useRef(createSessionRequest);
  createSessionRequestRef.current = createSessionRequest;
  const [promptStatus, setPromptStatus] = useState<DaemonPromptStatus>('idle');
  const [restoreSessionId, setRestoreSessionId] = useState<string | undefined>(
    initialRestoreSessionId,
  );
  const [restoreMode, setRestoreMode] = useState<'load' | 'resume'>('load');
  const [restoreSessionNonce, setRestoreSessionNonce] = useState(0);
  const [attachSessionNonce, setAttachSessionNonce] = useState(0);
  const [newSessionNonce, setNewSessionNonce] = useState(0);
  const [connection, setConnection] = useState<DaemonConnectionState>({
    status: autoConnect ? 'connecting' : 'idle',
    ...(initialRestoreSessionId ? { sessionId: initialRestoreSessionId } : {}),
  });
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
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
  const hasCurrentSessionActivePromptRef = useRef<() => boolean>(() => false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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
      let hasCurrentSessionActivePrompt = () => false;
      // Set when the user explicitly deletes the session (server
      // publishes session_closed with reason 'client_close').
      // Reconnecting would auto-create a new session, undoing the
      // user's delete. Other session_closed reasons (idle_timeout,
      // last_client_detached) fall through to normal reconnect.
      let userDeletedSession = false;

      while (!disposed && !abort.signal.aborted) {
        let loadingRequestedSession = false;
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
            setConnection((current) => ({
              ...current,
              status: 'connecting',
              error: undefined,
              errorStatus: resolveConnectionErrorStatus(
                undefined,
                current.errorStatus,
              ),
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
            activeWorkspaceCwdRef.current = effectWorkspaceCwd;
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
              const [providerResult, skillsResult, acpStatusResult] =
                await Promise.allSettled([
                  client.workspaceProviders(),
                  client.workspaceSkills(),
                  client.workspaceAcpStatus(),
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
              if (acpStatusResult.status === 'rejected') {
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
                acpStatusResult.status === 'fulfilled' &&
                !acpStatusResult.value.channelLive &&
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
            const restoreMethod =
              restoreSessionId && restoreMode === 'resume'
                ? DaemonSessionClient.resume
                : DaemonSessionClient.load;
            const targetSessionId = restoreSessionId ?? reconnectSessionId;
            const requestClientId = clientId
              ? clientIdRef.current
              : getStableClientId(undefined, targetSessionId);
            loadingRequestedSession = Boolean(restoreSessionId);
            if (targetSessionId) {
              setConnection((current) => ({
                ...current,
                sessionId: targetSessionId,
                error: undefined,
                errorStatus: undefined,
                missingSession: false,
                loadingTranscript: true,
              }));
            }
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
            loadingRequestedSession = false;
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
            activePromptsRef.current.has(activeSession.sessionId);
          hasCurrentSessionActivePrompt = hasSessionActivePrompt;
          hasCurrentSessionActivePromptRef.current = hasSessionActivePrompt;
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
          const { compactedReplay, liveJournal } = activeSession.replaySnapshot;
          const replayEvents = [...compactedReplay, ...liveJournal];
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
                  allUiEvents.push(
                    assistantDoneFromTurnEvent(replayEvent, stopReason),
                  );
                } else if (replayEvent.type === 'turn_error') {
                  allUiEvents.push(
                    assistantDoneFromTurnEvent(replayEvent, 'error'),
                  );
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
            clearTimeout(pendingLoadToResolve.timeout);
            if (
              skipNextCleanupDetachSessionIdRef.current ===
              activeSession.sessionId
            ) {
              skipNextCleanupDetachSessionIdRef.current = undefined;
            }
            pendingLoadToResolve.resolve();
          }

          const canReuseSessionMetadata =
            attachedExistingSession &&
            connectionRef.current.commands !== undefined &&
            connectionRef.current.skills !== undefined &&
            connectionRef.current.supportedCommands !== undefined &&
            connectionRef.current.context !== undefined;
          const [providerResult, commandResult, contextResult] =
            canReuseSessionMetadata
              ? [undefined, undefined, undefined]
              : await Promise.allSettled([
                  client.workspaceProviders(),
                  activeSession.supportedCommands(),
                  activeSession.context(),
                ]);
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
            if (current.sessionId !== activeSession.sessionId) return current;
            return {
              ...current,
              status: 'connected',
              sessionId: activeSession.sessionId,
              // Surface the bound client id so consumers can recognize their own
              // originator-stamped frames (e.g. the web-shell's mid-turn dedupe).
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
              currentModel: sessionCurrentModel ?? current.currentModel,
              currentMode: currentMode ?? current.currentMode,
              displayName:
                getSessionDisplayName(activeSession.state) ??
                current.displayName,
              contextWindow: sessionContextWindow ?? current.contextWindow,
              providers: providers ?? current.providers,
              supportedCommands: supportedCommands ?? current.supportedCommands,
              context: context ?? current.context,
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
            store.dispatch(
              loadWarningTexts.map((text) => ({
                type: 'status' as const,
                text,
              })),
            );
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
            store.reset();
            activeSession.setLastEventId(0);
            reconnectSessionId = activeSession.sessionId;
            resyncRequested = true;
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
          for await (const event of activeSession.events({
            signal: abort.signal,
            maxQueued,
          })) {
            if (sessionRef.current?.sessionId !== activeSession.sessionId) {
              break;
            }
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
                // Keep the sidechannel for queue dedupe, but still normalize the
                // event below so chat UIs can render the inserted-message status.
                publishSidechannelMidTurnInjected(midTurnInjected);
              }
              if (isPendingPromptEvent(event)) {
                publishPendingPromptEvent(event);
                if (event.type === 'pending_prompt_started') {
                  clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                  setPromptStatus('waiting');
                }
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
                  requestEpochResetReload();
                  break;
                }
              }
              bumpWorkspaceEventSignals(uiEvents, setWorkspaceEventSignals);
              if (uiEvents.length > 0) {
                const hasGenerationSignal = hasActiveGenerationSignal(uiEvents);
                setPromptStatus((current) =>
                  current === 'waiting' ||
                  (current === 'idle' && hasGenerationSignal)
                    ? 'streaming'
                    : current,
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
                store.dispatch(assistantDoneFromTurnEvent(event, stopReason));
                if (!hasSessionActivePrompt()) {
                  setPromptStatus('idle');
                }
              }
              const shouldGuardAssistant =
                !hasSessionActivePrompt() &&
                store.getSnapshot().activeAssistantBlockId != null;
              const eventsToDispatch = shouldGuardAssistant
                ? uiEvents.filter((e) => e.type !== 'debug')
                : uiEvents;
              store.dispatch(eventsToDispatch);
              for (const uiEvent of uiEvents) {
                if (
                  uiEvent.type === 'prompt.cancelled' &&
                  (restoredActivePrompt ||
                    uiEvent.originatorClientId !== activeSession.clientId)
                ) {
                  store.dispatch(
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
                  setConnection((c) => ({ ...c, catchingUp: undefined }));
                  if (store.getSnapshot().awaitingResync) {
                    store.clearAwaitingResync();
                  }
                  if (!hasSessionActivePrompt()) {
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
                store.dispatch(assistantDoneFromTurnEvent(event, stopReason));
                setPromptStatus('idle');
              } else if (isObserver && event.type === 'turn_error') {
                clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                store.dispatch(assistantDoneFromTurnEvent(event, 'error'));
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
            // Keep the session handle after a normal SSE close so the next
            // subscription can resume from DaemonSessionClient.lastEventId.
            if (sessionRef.current?.sessionId === activeSession.sessionId) {
              console.debug('[DaemonSessionProvider] SSE stream ended');
              if (!hasSessionActivePrompt()) {
                // A transport close is only a safe "done" signal for passive
                // observers. When a local/restored prompt is still active, the
                // daemon may continue running while we reconnect via
                // Last-Event-ID, so keep the prompt in streaming state until a
                // real turn_complete/turn_error/prompt_cancelled arrives.
                clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                setPromptStatus('idle');
                store.dispatch({
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
          if (disposed || abort.signal.aborted) return;
          const message =
            error instanceof Error ? error.message : String(error);
          const errorStatus = extractHttpStatus(error);
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
          const pendingLoad = pendingSessionLoadRef.current;
          if (
            pendingLoad &&
            (pendingLoad.sessionId === restoreSessionId ||
              pendingLoad.sessionId === reconnectSessionId)
          ) {
            if (
              skipNextCleanupDetachSessionIdRef.current ===
              pendingLoad.sessionId
            ) {
              skipNextCleanupDetachSessionIdRef.current = undefined;
            }
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
            error: message,
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
      hasCurrentSessionActivePromptRef.current = () => false;
      setPromptStatus('idle');
      clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
      const keepSessionForNextEffect =
        session?.sessionId === skipNextCleanupDetachSessionIdRef.current;
      const isUnmounting = !mountedRef.current;
      if (
        pendingSessionLoadRef.current &&
        (!keepSessionForNextEffect || isUnmounting)
      ) {
        clearTimeout(pendingSessionLoadRef.current.timeout);
        pendingSessionLoadRef.current.reject(
          new DOMException('Session load interrupted by cleanup', 'AbortError'),
        );
        pendingSessionLoadRef.current = undefined;
      }
      if ((!keepSessionForNextEffect || isUnmounting) && session?.clientId) {
        void detachDaemonClient({
          baseUrl: resolvedBaseUrl!,
          token: resolvedToken,
          sessionId: session.sessionId,
          clientId: session.clientId,
        }).catch((err) =>
          console.warn('[DaemonSessionProvider] detach failed:', err),
        );
      }
      if (!keepSessionForNextEffect || isUnmounting) {
        sessionRef.current = undefined;
      }
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
    attachSessionNonce,
    newSessionNonce,
    clientId,
    shouldDeferInitialSessionCreation,
    clearNotices,
    addNotice,
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
    if (heartbeatFailureStateRef.current.sessionId !== connection.sessionId) {
      heartbeatFailureStateRef.current = {
        sessionId: connection.sessionId,
        consecutiveFailures: 0,
      };
    }
    const heartbeatFailureState = heartbeatFailureStateRef.current;
    let disposed = false;
    const timer = setInterval(() => {
      const session = sessionRef.current;
      if (!session) return;
      session
        .heartbeat()
        .then(() => {
          if (disposed) return;
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
          if (disposed) return;
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
            if (sessionRef.current?.sessionId === deadSessionId) {
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
        skipNextCleanupDetachSessionIdRef,
        passiveAssistantDoneTimerRef,
        hasSessionActivePrompt: () =>
          hasCurrentSessionActivePromptRef.current(),
        resetCurrentSessionActivePrompt: () => {
          hasCurrentSessionActivePromptRef.current = () => false;
        },
        getCreateSessionRequest: () => ({
          ...createSessionRequestRef.current,
          sessionScope: 'thread',
          workspaceCwd:
            activeWorkspaceCwdRef.current ?? sessionRef.current?.workspaceCwd,
        }),
        createDetachedSession: (
          workspaceCwd?: string,
          overrides?: Pick<CreateSessionRequest, 'approvalMode'>,
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
        setPromptStatus,
        setRestoreSessionId,
        setRestoreMode,
        setRestoreSessionNonce,
        setAttachSessionNonce,
        setNewSessionNonce,
      }),
    [addNotice, clientId, resolvedBaseUrl, resolvedToken, store],
  );
  const lastHandledSessionIdRef = useRef<
    string | undefined | typeof UNHANDLED_SESSION
  >(UNHANDLED_SESSION);

  useEffect(() => {
    if (lastHandledSessionIdRef.current === sessionId) return;
    lastHandledSessionIdRef.current = sessionId;

    const currentSessionId = connectionRef.current.sessionId;
    if (sessionId === currentSessionId) return;

    const request = sessionId
      ? actions.loadSession(sessionId)
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
  }, [actions, sessionId]);

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
  behavior: { updateConnection?: boolean } = {},
): DaemonUiEvent[] {
  logSettingsReloadEvent(event);
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
