/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  DaemonClient,
  DaemonHttpError,
  DaemonSessionClient,
  createDaemonTranscriptStore,
  normalizeDaemonEvent,
  type CreateSessionRequest,
  type DaemonTranscriptBlock,
  type DaemonTranscriptState,
  type DaemonTranscriptStore,
  type DaemonUiEvent,
  type DaemonUiSessionActions,
  type PermissionResponse,
  type PromptResult,
  type SetModelResult,
} from '@qwen-code/sdk/daemon';

export type DaemonConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface DaemonConnectionState {
  status: DaemonConnectionStatus;
  sessionId?: string;
  workspaceCwd?: string;
  error?: string;
  /**
   * True while the daemon is replaying buffered history after a resume
   * (a `Last-Event-ID` subscription), cleared when the `replay_complete`
   * sentinel arrives. Lets the UI show a deterministic "catching up"
   * indicator instead of guessing with a spinner timeout. Only set on
   * resume — a fresh live-tail subscription has no replay phase.
   */
  catchingUp?: boolean;
}

export interface DaemonSessionProviderProps {
  baseUrl: string;
  token?: string;
  workspaceCwd?: string;
  createSessionRequest?: Omit<CreateSessionRequest, 'workspaceCwd'>;
  maxQueued?: number;
  suppressOwnUserEcho?: boolean;
  includeRawEvent?: boolean;
  autoConnect?: boolean;
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  children: ReactNode;
}

export interface DaemonSessionContextValue {
  store: DaemonTranscriptStore;
  connection: DaemonConnectionState;
  actions: DaemonUiSessionActions;
}

const DaemonStoreContext = createContext<DaemonTranscriptStore | undefined>(
  undefined,
);
const DaemonConnectionContext = createContext<
  DaemonConnectionState | undefined
>(undefined);
const DaemonActionsContext = createContext<DaemonUiSessionActions | undefined>(
  undefined,
);
const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const TERMINAL_SESSION_HTTP_STATUSES = new Set([401, 403, 404, 410]);
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
  createSessionRequest,
  maxQueued = 1024,
  suppressOwnUserEcho = true,
  includeRawEvent = false,
  autoConnect = true,
  autoReconnect = true,
  reconnectDelayMs = 1_000,
  maxReconnectDelayMs = 10_000,
  children,
}: DaemonSessionProviderProps) {
  const store = useMemo(() => createDaemonTranscriptStore(), []);
  const sessionRef = useRef<DaemonSessionClient | undefined>(undefined);
  const lastSessionIdRef = useRef<string | undefined>(undefined);
  const promptAbortRef = useRef<AbortController | undefined>(undefined);
  const promptBusyRef = useRef(false);
  const eventOptionsRef = useRef({ suppressOwnUserEcho, includeRawEvent });
  const reconnectConfigRef = useRef({ reconnectDelayMs, maxReconnectDelayMs });
  eventOptionsRef.current = { suppressOwnUserEcho, includeRawEvent };
  reconnectConfigRef.current = { reconnectDelayMs, maxReconnectDelayMs };
  const modelServiceId = createSessionRequest?.modelServiceId;
  const sessionScope = createSessionRequest?.sessionScope;
  const [connection, setConnection] = useState<DaemonConnectionState>({
    status: autoConnect ? 'connecting' : 'idle',
  });

  useEffect(() => {
    if (!autoConnect) return undefined;
    const abort = new AbortController();
    let disposed = false;

    const run = async () => {
      const client = new DaemonClient({ baseUrl, token });
      let session: DaemonSessionClient | undefined;
      let reconnectAttempt = 0;

      while (!disposed && !abort.signal.aborted) {
        try {
          if (!session) {
            setConnection({ status: 'connecting' });
            const caps = await client.capabilities();
            if (disposed || abort.signal.aborted) return;
            const nextSession = await DaemonSessionClient.createOrAttach(
              client,
              {
                ...(modelServiceId !== undefined ? { modelServiceId } : {}),
                ...(sessionScope !== undefined ? { sessionScope } : {}),
                workspaceCwd: workspaceCwd ?? caps.workspaceCwd,
              },
            );
            if (disposed || abort.signal.aborted) return;
            const previousSessionId = lastSessionIdRef.current;
            if (
              previousSessionId !== undefined &&
              nextSession.sessionId !== previousSessionId
            ) {
              promptAbortRef.current?.abort();
              promptAbortRef.current = undefined;
              promptBusyRef.current = false;
              store.reset();
            } else if (previousSessionId !== undefined) {
              store.dispatch({ type: 'assistant.done', reason: 'reconnected' });
              const snapshot = store.getSnapshot();
              if (snapshot.awaitingResync) {
                if (snapshot.lastResyncRequired?.reason === 'epoch_reset') {
                  // Defensive: epoch_reset is normally caught by
                  // resetStoreForEpochResync in the event loop before the
                  // reducer arms awaitingResync. If a previous iteration did
                  // dispatch it, the count already includes that event.
                  nextSession.setLastEventId(0);
                  store.reset({
                    resyncRequiredCount: snapshot.resyncRequiredCount,
                    lastResyncRequired: snapshot.lastResyncRequired,
                  });
                } else {
                  store.clearAwaitingResync();
                }
              }
            }
            session = nextSession;
            lastSessionIdRef.current = session.sessionId;
            sessionRef.current = session;
          }

          // `catchingUp` arms a positive "replaying history" indicator that
          // the daemon's `replay_complete` sentinel deterministically
          // clears (no spinner-timeout heuristics). The daemon only emits
          // `replay_complete` when the subscription carried a
          // `Last-Event-ID` (i.e. a resume), so only arm it then —
          // otherwise a live-tail subscribe would never see the sentinel
          // and the indicator would stick on forever.
          const expectingReplay = session.lastEventId !== undefined;
          setConnection({
            status: 'connected',
            sessionId: session.sessionId,
            workspaceCwd: session.workspaceCwd,
            ...(expectingReplay ? { catchingUp: true } : {}),
          });

          let sawEvent = false;
          for await (const event of session.events({
            signal: abort.signal,
            maxQueued,
          })) {
            if (!sawEvent) {
              sawEvent = true;
              reconnectAttempt = 0;
            }
            if (event.type === 'replay_complete') {
              // Replay drained — flip from "catching up" to "live".
              // For non-epoch resyncs (ring_evicted), the daemon keeps the
              // stream open after state_resync_required. Clear the latch here
              // so post-replay live events are accepted. Epoch reset is
              // handled before dispatch by resetStoreForEpochResync.
              if (store.getSnapshot().awaitingResync) {
                store.clearAwaitingResync();
              }
              setConnection((current) =>
                current.catchingUp
                  ? { ...current, catchingUp: false }
                  : current,
              );
            }
            try {
              const eventOptions = eventOptionsRef.current;
              const uiEvents = normalizeDaemonEvent(event, {
                clientId: session.clientId,
                suppressOwnUserEcho: eventOptions.suppressOwnUserEcho,
                includeRawEvent: eventOptions.includeRawEvent,
              });
              if (resetStoreForEpochResync(store, session, uiEvents)) {
                continue;
              }
              store.dispatch(uiEvents);
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
          if (!disposed && !abort.signal.aborted) {
            // Keep the session handle after a normal SSE close so the next
            // subscription can resume from DaemonSessionClient.lastEventId.
            store.dispatch({ type: 'assistant.done', reason: 'stream_ended' });
            store.dispatch({
              type: 'status',
              text: 'SSE stream ended',
            });
            setConnection((current) => ({
              ...current,
              status: 'disconnected',
              // Clear the catch-up indicator: if the stream ended mid-replay
              // (before `replay_complete`), spreading `current` would leak
              // `catchingUp: true` into the disconnected state.
              catchingUp: false,
              error: 'SSE stream ended',
            }));
          }
        } catch (error) {
          if (disposed || abort.signal.aborted) return;
          const message =
            error instanceof Error ? error.message : String(error);
          store.dispatch({ type: 'error', text: message, recoverable: true });
          const terminalSessionError = isTerminalSessionHttpError(error);
          if (terminalSessionError) {
            session = undefined;
            sessionRef.current = undefined;
          }
          // Auth failures (401 / 403) must NOT retry even when
          // `autoReconnect: true`. Retrying with the same invalid token
          // loops forever — the daemon keeps returning 401, each cycle
          // risks transcript wipes via the sessionId-change branch above,
          // and the user sees no actionable error state.
          // Surface as a terminal 'error' connection state regardless of
          // the autoReconnect setting; the user must update credentials.
          if (isAuthFailureHttpError(error)) {
            promptAbortRef.current?.abort();
            promptAbortRef.current = undefined;
            promptBusyRef.current = false;
            sessionRef.current = undefined;
            setConnection({
              status: 'error',
              error: message,
            });
            return;
          }
          if (!autoReconnect) {
            sessionRef.current = undefined;
            setConnection({
              status: 'error',
              ...(session
                ? {
                    sessionId: session.sessionId,
                    workspaceCwd: session.workspaceCwd,
                  }
                : {}),
              error: message,
            });
            return;
          }
          setConnection({
            status: 'disconnected',
            ...(session
              ? {
                  sessionId: session.sessionId,
                  workspaceCwd: session.workspaceCwd,
                }
              : {}),
            error: message,
          });
        }

        if (!autoReconnect) {
          sessionRef.current = undefined;
          setConnection((current) => ({
            ...current,
            status: 'disconnected',
            catchingUp: false,
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
          catchingUp: false,
          error: `Reconnecting in ${delayMs}ms`,
        }));
        await delay(delayMs, abort.signal);
      }
    };

    void run();
    return () => {
      disposed = true;
      abort.abort();
      promptAbortRef.current?.abort();
      promptAbortRef.current = undefined;
      promptBusyRef.current = false;
      sessionRef.current = undefined;
    };
  }, [
    autoConnect,
    autoReconnect,
    baseUrl,
    token,
    workspaceCwd,
    modelServiceId,
    sessionScope,
    maxQueued,
    store,
  ]);

  const actions = useMemo<DaemonUiSessionActions>(
    () => ({
      async sendPrompt(text: string): Promise<PromptResult> {
        const session = requireSessionForAction(
          store,
          sessionRef.current,
          'Prompt failed',
        );
        if (promptBusyRef.current) {
          throw dispatchActionError(
            store,
            'Prompt failed',
            'A prompt is already in progress',
          );
        }
        promptBusyRef.current = true;
        const promptAbort = new AbortController();
        promptAbortRef.current = promptAbort;
        try {
          store.appendLocalUserMessage(text);
          const result = await session.prompt(
            {
              prompt: [{ type: 'text', text }],
            },
            promptAbort.signal,
          );
          store.dispatch({ type: 'assistant.done', reason: result.stopReason });
          return result;
        } catch (error) {
          if (isAbortError(error)) {
            store.dispatch({ type: 'assistant.done', reason: 'cancelled' });
            return { stopReason: 'cancelled' };
          }
          store.dispatch({ type: 'assistant.done', reason: 'error' });
          throw dispatchActionError(store, 'Prompt failed', error);
        } finally {
          if (promptAbortRef.current === promptAbort) {
            promptAbortRef.current = undefined;
            promptBusyRef.current = false;
          }
        }
      },
      async cancel(): Promise<void> {
        const hadActivePrompt = promptAbortRef.current !== undefined;
        promptAbortRef.current?.abort();
        promptAbortRef.current = undefined;
        let session: DaemonSessionClient;
        try {
          session = requireSessionForAction(
            store,
            sessionRef.current,
            'Cancel failed',
          );
        } catch (error) {
          if (hadActivePrompt) {
            promptBusyRef.current = false;
          }
          throw error;
        }
        try {
          await withActionTimeout(session.cancel(), 'Cancel timed out');
        } catch (error) {
          throw dispatchActionError(store, 'Cancel failed', error);
        } finally {
          if (hadActivePrompt) {
            promptBusyRef.current = false;
          }
        }
      },
      async setModel(modelId: string): Promise<SetModelResult> {
        const session = requireSessionForAction(
          store,
          sessionRef.current,
          'Set model failed',
        );
        try {
          return await withActionTimeout(
            session.setModel(modelId),
            'Set model timed out',
          );
        } catch (error) {
          throw dispatchActionError(store, 'Set model failed', error);
        }
      },
      async respondToPermission(
        requestId: string,
        response: PermissionResponse,
      ): Promise<boolean> {
        const session = requireSessionForAction(
          store,
          sessionRef.current,
          'Permission response failed',
        );
        try {
          return await withActionTimeout(
            session.respondToSessionPermission(requestId, response),
            'Permission response timed out',
          );
        } catch (error) {
          throw dispatchActionError(store, 'Permission response failed', error);
        }
      },
    }),
    [store],
  );

  return (
    <DaemonStoreContext.Provider value={store}>
      <DaemonConnectionContext.Provider value={connection}>
        <DaemonActionsContext.Provider value={actions}>
          {children}
        </DaemonActionsContext.Provider>
      </DaemonConnectionContext.Provider>
    </DaemonStoreContext.Provider>
  );
}

export function useDaemonSession(): DaemonSessionContextValue {
  return {
    store: useDaemonTranscriptStore(),
    connection: useDaemonConnection(),
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
  return useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().blocks,
    () => store.getSnapshot().blocks,
  );
}

export function useDaemonPendingPermissions() {
  // wenshao R5 (qwen3.7-max): subscribe at the blocks level instead of
  // the full transcript state. `selectPendingPermissionBlocks` reads
  // only `state.blocks`; subscribing to the full state caused this
  // hook to re-render on every daemon event (text deltas, tool
  // updates, sidechannel changes) even when blocks were unchanged.
  const blocks = useDaemonTranscriptBlocks();
  return useMemo(
    () =>
      blocks.filter(
        (
          block,
        ): block is Extract<DaemonTranscriptBlock, { kind: 'permission' }> =>
          block.kind === 'permission' && block.resolved === undefined,
      ),
    [blocks],
  );
}

export function useDaemonActions(): DaemonUiSessionActions {
  const actions = useContext(DaemonActionsContext);
  if (!actions) {
    throw new Error(
      'useDaemonActions must be used within DaemonSessionProvider',
    );
  }
  return actions;
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

function requireSessionForAction(
  store: DaemonTranscriptStore,
  session: DaemonSessionClient | undefined,
  action: string,
): DaemonSessionClient {
  if (!session) {
    throw dispatchActionError(store, action, 'Daemon session is not connected');
  }
  return session;
}

function dispatchActionError(
  store: DaemonTranscriptStore,
  action: string,
  error: unknown,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  store.dispatch({
    type: 'error',
    text: `${action}: ${message}`,
    recoverable: true,
  });
  return error instanceof Error ? error : new Error(message);
}

type DaemonStateResyncUiEvent = Extract<
  DaemonUiEvent,
  { type: 'session.state_resync_required' }
>;

function resetStoreForEpochResync(
  store: DaemonTranscriptStore,
  session: DaemonSessionClient,
  events: readonly DaemonUiEvent[],
): boolean {
  const resync = events.find(isEpochResetResyncEvent);
  if (!resync) return false;

  // The cursor belongs to a dead daemon epoch. Reset it before the generator
  // resumes so replayed low-id events from the new epoch can advance it again.
  session.setLastEventId(0);
  const snapshot = store.getSnapshot();
  store.reset({
    resyncRequiredCount: snapshot.resyncRequiredCount + 1,
    lastResyncRequired: {
      reason: resync.reason,
      lastDeliveredId: resync.lastDeliveredId,
      earliestAvailableId: resync.earliestAvailableId,
    },
  });
  return true;
}

function isEpochResetResyncEvent(
  event: DaemonUiEvent,
): event is DaemonStateResyncUiEvent {
  return (
    event.type === 'session.state_resync_required' &&
    event.reason === 'epoch_reset'
  );
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
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

function getReconnectDelayMs(
  attempt: number,
  reconnectDelayMs: number,
  maxReconnectDelayMs: number,
): number {
  const base =
    Number.isFinite(reconnectDelayMs) && reconnectDelayMs > 0
      ? reconnectDelayMs
      : 1_000;
  const max =
    Number.isFinite(maxReconnectDelayMs) && maxReconnectDelayMs > 0
      ? Math.max(base, maxReconnectDelayMs)
      : base;
  const exponential = base * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, max);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.min(max, Math.max(1, Math.round(capped * jitter)));
}

async function withActionTimeout<T>(
  promise: Promise<T>,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${message} after ${DEFAULT_ACTION_TIMEOUT_MS}ms`));
        }, DEFAULT_ACTION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function delay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, delayMs);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}
