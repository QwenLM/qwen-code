import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  DaemonClient,
  DaemonHttpError,
  DaemonSessionClient,
  createDaemonTranscriptStore,
  normalizeDaemonEvent,
  type DaemonSessionSummary,
  type DaemonApprovalMode,
  type DaemonApprovalModeResult,
  type DaemonWorkspaceMcpStatus,
  type DaemonMcpRestartResult,
  type DaemonWorkspaceSkillsStatus,
  type DaemonWorkspaceToolsStatus,
  type DaemonWorkspaceMemoryStatus,
  type DaemonWriteMemoryRequest,
  type DaemonWriteMemoryResult,
  type DaemonWorkspaceFile,
  type DaemonWorkspaceAgentsStatus,
  type DaemonWorkspaceAgentDetail,
  type DaemonCreateAgentRequest,
  type DaemonAgentMutationResult,
  type SessionMetadataResult,
  type PermissionResponse,
  type PromptResult,
  type HeartbeatResult,
  type DaemonShellCommandResult,
} from '@qwen-code/sdk/daemon';
import type { CommandInfo, ModelInfo } from '../adapters/types';
import type { PromptImage } from '../adapters/promptTypes';
import {
  getCurrentMode,
  mapProviderStatus,
  mapSupportedCommands,
} from './daemonSessionMappers';
import {
  handleSilentDaemonEvent,
  hasAssistantDelta,
} from './daemonSessionEvents';
import { toPromptContent } from './daemonPromptContent';
import { getRecord, getString } from './daemonSessionUtils';
import {
  clearPassiveAssistantDoneTimer,
  getReconnectDelay,
  schedulePassiveAssistantDone,
  sleep,
} from './daemonSessionTimers';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';
export type PromptStatus = 'idle' | 'waiting' | 'streaming';

export interface DaemonConnectionState {
  status: ConnectionStatus;
  sessionId?: string;
  workspaceCwd?: string;
  commands?: CommandInfo[];
  skills?: string[];
  models?: ModelInfo[];
  currentModel?: string;
  currentMode?: string;
  tokenCount?: number;
  contextWindow?: number;
  error?: string;
}

export interface DaemonSessionConfig {
  baseUrl: string;
  token?: string;
  workspaceCwd?: string;
  initialSessionId?: string;
  clientId?: string;
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  loadWarnings?: {
    models: string;
    commands: string;
    context: string;
  };
}

export interface WebShellMcpToolStatus {
  name: string;
  serverToolName?: string;
  description?: string;
  isValid: boolean;
  invalidReason?: string;
  schema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface WebShellMcpToolsStatus {
  v: 1;
  serverName: string;
  tools: WebShellMcpToolStatus[];
  errors?: Array<{ error?: string }>;
}

export interface DaemonActions {
  sendPrompt(
    text: string,
    images?: PromptImage[],
    options?: SendPromptOptions,
  ): Promise<PromptResult>;
  heartbeat(): Promise<HeartbeatResult | undefined>;
  cancel(): Promise<void>;
  setModel(modelId: string): Promise<unknown>;
  setApprovalMode(mode: DaemonApprovalMode): Promise<DaemonApprovalModeResult>;
  respondToPermission(
    requestId: string,
    optionId: string,
    answers?: Record<string, string>,
  ): Promise<boolean>;
  listSessions(): Promise<DaemonSessionSummary[]>;
  loadSession(sessionId: string): Promise<void>;
  releaseSession(sessionId: string): Promise<void>;
  newSession(): Promise<void>;
  closeSession(): Promise<void>;
  refreshCommands(): Promise<void>;
  loadMcpStatus(): Promise<DaemonWorkspaceMcpStatus>;
  loadMcpTools(serverName: string): Promise<WebShellMcpToolsStatus>;
  restartMcpServer(serverName: string): Promise<DaemonMcpRestartResult>;
  loadSkillsStatus(): Promise<DaemonWorkspaceSkillsStatus>;
  loadToolsStatus(): Promise<DaemonWorkspaceToolsStatus>;
  setWorkspaceToolEnabled(toolName: string, enabled: boolean): Promise<unknown>;
  loadMemoryStatus(): Promise<DaemonWorkspaceMemoryStatus>;
  readWorkspaceFile(filePath: string): Promise<DaemonWorkspaceFile>;
  writeMemory(req: DaemonWriteMemoryRequest): Promise<DaemonWriteMemoryResult>;
  listAgents(): Promise<DaemonWorkspaceAgentsStatus>;
  getAgent(agentType: string): Promise<DaemonWorkspaceAgentDetail>;
  createAgent(
    req: DaemonCreateAgentRequest,
  ): Promise<DaemonAgentMutationResult>;
  deleteAgent(agentType: string, scope?: 'workspace' | 'global'): Promise<void>;
  renameSession(displayName: string): Promise<SessionMetadataResult>;
  sendShellCommand(command: string): Promise<DaemonShellCommandResult>;
}

interface ActivePrompt {
  controller: AbortController;
}

interface PendingSessionLoad {
  id: number;
  sessionId: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export interface SendPromptOptions {
  optimisticUserMessage?: boolean;
}

const DEFAULT_CONFIG: DaemonSessionConfig = {
  baseUrl: '',
  autoReconnect: true,
  reconnectDelayMs: 1_000,
  maxReconnectDelayMs: 10_000,
};

const WEB_SHELL_CLIENT_ID_KEY = 'qwen-code-web-shell-client-id';

function createWebShellClientId(): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `web-shell-${random}`;
}

function getStableClientId(providedClientId?: string): string {
  if (providedClientId) return providedClientId;
  if (typeof window === 'undefined') return createWebShellClientId();
  try {
    const existing = window.sessionStorage.getItem(WEB_SHELL_CLIENT_ID_KEY);
    if (existing) return existing;
    const next = createWebShellClientId();
    window.sessionStorage.setItem(WEB_SHELL_CLIENT_ID_KEY, next);
    return next;
  } catch {
    return createWebShellClientId();
  }
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function detachDaemonClient(input: {
  baseUrl: string;
  token?: string;
  sessionId: string;
  clientId: string;
}) {
  const headers: Record<string, string> = {
    'X-Qwen-Client-Id': input.clientId,
  };
  if (input.token) {
    headers['Authorization'] = `Bearer ${input.token}`;
  }
  void fetch(
    `${stripTrailingSlashes(input.baseUrl)}/session/${encodeURIComponent(
      input.sessionId,
    )}/detach`,
    {
      method: 'POST',
      headers,
      keepalive: true,
    },
  ).catch((err) => {
    console.warn('[web-shell] detachDaemonClient failed:', err);
  });
}

function isOwnUserMessageChunk(event: unknown, clientId?: string): boolean {
  if (!clientId) return false;
  const record = getRecord(event);
  if (!record || record['originatorClientId'] !== clientId) return false;
  const update = getRecord(getRecord(record['data'])?.['update']);
  return getString(update, 'sessionUpdate') === 'user_message_chunk';
}

export function useDaemonSession(config: Partial<DaemonSessionConfig> = {}) {
  const opts = { ...DEFAULT_CONFIG, ...config };
  const store = useMemo(() => createDaemonTranscriptStore(), []);
  const loadWarningsRef = useRef(config.loadWarnings);
  loadWarningsRef.current = config.loadWarnings;
  const clientIdRef = useRef<string | undefined>(undefined);
  if (!clientIdRef.current || opts.clientId) {
    clientIdRef.current = getStableClientId(opts.clientId);
  }
  const sessionRef = useRef<DaemonSessionClient | undefined>(undefined);
  const activePromptsRef = useRef<Map<string, ActivePrompt>>(new Map());
  const pendingSessionLoadRef = useRef<PendingSessionLoad | undefined>(
    undefined,
  );
  const pendingSessionLoadIdRef = useRef(0);
  const suppressedOwnUserEchoCountRef = useRef(0);
  const heartbeatSupportedRef = useRef(false);
  const passiveAssistantDoneTimerRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const [promptStatus, setPromptStatus] = useState<PromptStatus>('idle');
  const [restoreSessionId, setRestoreSessionId] = useState<string | undefined>(
    opts.initialSessionId,
  );
  const [restoreSessionNonce, setRestoreSessionNonce] = useState(0);
  const [newSessionNonce, setNewSessionNonce] = useState(0);

  const [connection, setConnection] = useState<DaemonConnectionState>({
    status: 'connecting',
  });

  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  useEffect(() => {
    const abort = new AbortController();
    let disposed = false;
    const effectiveBaseUrl = opts.baseUrl || window.location.origin;

    const run = async () => {
      const client = new DaemonClient({
        baseUrl: effectiveBaseUrl,
        token: opts.token,
      });
      let session: DaemonSessionClient | undefined;
      let reconnectSessionId = restoreSessionId;
      let shouldCreateFreshSession = !restoreSessionId && newSessionNonce > 0;
      let reconnectAttempt = 0;

      while (!disposed && !abort.signal.aborted) {
        try {
          if (!session) {
            setConnection((cur) => ({
              ...cur,
              status: 'connecting',
              error: undefined,
            }));
            const caps = await client.capabilities();
            if (disposed || abort.signal.aborted) return;
            heartbeatSupportedRef.current =
              caps.features.includes('client_heartbeat');
            const workspaceCwd = opts.workspaceCwd ?? caps.workspaceCwd;
            const nextSession = restoreSessionId
              ? await DaemonSessionClient.load(
                  client,
                  restoreSessionId,
                  {
                    workspaceCwd,
                  },
                  clientIdRef.current,
                )
              : reconnectSessionId
                ? await DaemonSessionClient.load(
                    client,
                    reconnectSessionId,
                    {
                      workspaceCwd,
                    },
                    clientIdRef.current,
                  )
                : await DaemonSessionClient.createOrAttach(
                    client,
                    {
                      workspaceCwd,
                      ...(shouldCreateFreshSession
                        ? { sessionScope: 'thread' as const }
                        : {}),
                    },
                    clientIdRef.current,
                  );
            if (disposed || abort.signal.aborted) {
              if (nextSession.clientId) {
                detachDaemonClient({
                  baseUrl: effectiveBaseUrl,
                  token: opts.token,
                  sessionId: nextSession.sessionId,
                  clientId: nextSession.clientId,
                });
              }
              return;
            }
            session = nextSession;
            reconnectSessionId = session.sessionId;
            shouldCreateFreshSession = false;
            sessionRef.current = session;
          }

          const activeSession = session;
          const [providerResult, commandResult, contextResult] =
            await Promise.allSettled([
              client.workspaceProviders(),
              activeSession.supportedCommands(),
              activeSession.context(),
            ]);
          const providerStatus =
            providerResult.status === 'fulfilled'
              ? providerResult.value
              : undefined;
          const commandStatus =
            commandResult.status === 'fulfilled'
              ? commandResult.value
              : undefined;
          const contextStatus =
            contextResult.status === 'fulfilled'
              ? contextResult.value
              : undefined;
          const loadWarnings = [
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
            mapProviderStatus(providerStatus);
          const { commands, skills } = mapSupportedCommands(commandStatus);
          const currentMode = getCurrentMode(contextStatus);

          setConnection((cur) => ({
            status: 'connected',
            sessionId: activeSession.sessionId,
            workspaceCwd: activeSession.workspaceCwd,
            commands,
            skills,
            models,
            currentModel,
            currentMode,
            tokenCount:
              cur.sessionId === activeSession.sessionId
                ? (cur.tokenCount ?? 0)
                : 0,
            contextWindow,
          }));
          const pendingLoad = pendingSessionLoadRef.current;
          if (pendingLoad?.sessionId === activeSession.sessionId) {
            pendingSessionLoadRef.current = undefined;
            clearTimeout(pendingLoad.timeout);
            pendingLoad.resolve();
          }
          if (loadWarnings.length > 0) {
            store.dispatch(
              loadWarnings.map((text) => ({
                type: 'status' as const,
                text,
              })),
            );
          }

          let sawEvent = false;
          for await (const event of activeSession.events({
            signal: abort.signal,
            maxQueued: 1024,
          })) {
            if (!sawEvent) {
              sawEvent = true;
              reconnectAttempt = 0;
            }
            try {
              if (event.type === 'state_resync_required') {
                setPromptStatus('idle');
                store.reset();
                setConnection((cur) => ({
                  ...cur,
                  status: 'connecting',
                }));
                break;
              }
              if (handleSilentDaemonEvent(event, setConnection)) {
                continue;
              }
              const suppressOwnUserEcho =
                suppressedOwnUserEchoCountRef.current > 0 &&
                isOwnUserMessageChunk(event, activeSession.clientId);
              const uiEvents = normalizeDaemonEvent(event, {
                clientId: activeSession.clientId,
                suppressOwnUserEcho,
              });
              if (suppressOwnUserEcho) {
                suppressedOwnUserEchoCountRef.current -= 1;
              }
              if (uiEvents.length > 0) {
                setPromptStatus((cur) =>
                  cur === 'waiting' ? 'streaming' : cur,
                );
              }
              store.dispatch(uiEvents);
              if (
                event.type === 'turn_complete' &&
                !activePromptsRef.current.has(activeSession.sessionId)
              ) {
                clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
                const stopReason =
                  (event.data as { stopReason?: string })?.stopReason ??
                  'end_turn';
                store.dispatch({ type: 'assistant.done', reason: stopReason });
              } else if (
                !activePromptsRef.current.has(activeSession.sessionId) &&
                hasAssistantDelta(uiEvents)
              ) {
                schedulePassiveAssistantDone(
                  store,
                  passiveAssistantDoneTimerRef,
                );
              }
            } catch (eventError) {
              console.warn(
                '[web-shell] malformed SSE event skipped:',
                eventError,
              );
            }
          }

          if (!disposed && !abort.signal.aborted) {
            const stalePrompt = activePromptsRef.current.get(
              activeSession.sessionId,
            );
            if (stalePrompt) {
              stalePrompt.controller.abort();
              activePromptsRef.current.delete(activeSession.sessionId);
            }
            session = undefined;
            sessionRef.current = undefined;
          }
        } catch (error) {
          if (disposed || abort.signal.aborted) return;
          const message =
            error instanceof Error ? error.message : String(error);

          session = undefined;
          sessionRef.current = undefined;
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

          if (
            error instanceof DaemonHttpError &&
            (error.status === 404 ||
              error.status === 401 ||
              error.status === 403)
          ) {
            const missingSessionId = restoreSessionId ?? reconnectSessionId;
            reconnectSessionId = undefined;
            if (restoreSessionId) {
              setRestoreSessionId(undefined);
            }
            const reason =
              error.status === 401 || error.status === 403
                ? 'Authentication failed. Please refresh with a valid token.'
                : missingSessionId
                  ? `Session ${missingSessionId} no longer exists. A fresh session will be opened.`
                  : 'Session no longer exists. A fresh session will be opened.';
            store.dispatch([{ type: 'error', text: reason }]);
            if (error.status === 401 || error.status === 403) {
              console.error(
                `[web-shell] auth failure: status=${error.status}, session=${missingSessionId ?? 'unknown'}`,
              );
              setConnection({ status: 'error', error: reason });
              return;
            }
          }

          if (!opts.autoReconnect) {
            setConnection({ status: 'error', error: message });
            return;
          }

          setConnection((cur) => ({
            ...cur,
            status: 'disconnected',
            error: message,
          }));
        }

        if (!opts.autoReconnect) return;

        reconnectAttempt += 1;
        const delayMs = getReconnectDelay(
          reconnectAttempt,
          opts.reconnectDelayMs!,
          opts.maxReconnectDelayMs!,
        );
        await sleep(delayMs, abort.signal);
      }
    };

    void run();
    return () => {
      const session = sessionRef.current;
      disposed = true;
      abort.abort();
      clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
      setPromptStatus('idle');
      if (pendingSessionLoadRef.current) {
        clearTimeout(pendingSessionLoadRef.current.timeout);
        pendingSessionLoadRef.current.reject(
          new Error('Session effect disposed'),
        );
        pendingSessionLoadRef.current = undefined;
      }
      if (session?.clientId) {
        detachDaemonClient({
          baseUrl: effectiveBaseUrl,
          token: opts.token,
          sessionId: session.sessionId,
          clientId: session.clientId,
        });
      }
      sessionRef.current = undefined;
    };
  }, [
    opts.baseUrl,
    opts.token,
    opts.workspaceCwd,
    opts.clientId,
    opts.autoReconnect,
    opts.reconnectDelayMs,
    opts.maxReconnectDelayMs,
    store,
    restoreSessionId,
    restoreSessionNonce,
    newSessionNonce,
  ]);

  const actions = useMemo<DaemonActions>(
    () => ({
      async sendPrompt(
        text: string,
        images?: PromptImage[],
        options?: SendPromptOptions,
      ): Promise<PromptResult> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        const sessionId = session.sessionId;
        if (activePromptsRef.current.has(sessionId)) {
          throw new Error('A prompt is already in progress');
        }

        setPromptStatus('waiting');
        clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
        const ctrl = new AbortController();
        activePromptsRef.current.set(sessionId, {
          controller: ctrl,
        });

        try {
          if (options?.optimisticUserMessage === false) {
            suppressedOwnUserEchoCountRef.current += 1;
          }
          const prompt = toPromptContent(text, images);
          const result = await session.prompt({ prompt }, ctrl.signal);
          if (sessionRef.current?.sessionId === sessionId) {
            schedulePassiveAssistantDone(
              store,
              passiveAssistantDoneTimerRef,
              result.stopReason,
              120,
            );
          }
          return result;
        } catch (error) {
          if (options?.optimisticUserMessage === false) {
            suppressedOwnUserEchoCountRef.current = Math.max(
              0,
              suppressedOwnUserEchoCountRef.current - 1,
            );
          }
          if (error instanceof DOMException && error.name === 'AbortError') {
            return { stopReason: 'cancelled' };
          }
          throw error;
        } finally {
          const active = activePromptsRef.current.get(sessionId);
          if (active?.controller === ctrl) {
            activePromptsRef.current.delete(sessionId);
          }
          if (sessionRef.current?.sessionId === sessionId) {
            setPromptStatus('idle');
          }
        }
      },

      async heartbeat(): Promise<HeartbeatResult | undefined> {
        const session = sessionRef.current;
        if (!session || !heartbeatSupportedRef.current) return undefined;
        return session.heartbeat();
      },

      async cancel(): Promise<void> {
        const session = sessionRef.current;
        if (!session) return;
        const active = activePromptsRef.current.get(session.sessionId);
        active?.controller.abort();
        activePromptsRef.current.delete(session.sessionId);
        setPromptStatus('idle');
        clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
        try {
          await session.cancel();
        } finally {
          setPromptStatus('idle');
        }
      },

      async setModel(modelId: string): Promise<unknown> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        const result = await session.setModel(modelId);
        setConnection((cur) => ({ ...cur, currentModel: modelId }));
        return result;
      },

      async setApprovalMode(
        mode: DaemonApprovalMode,
      ): Promise<DaemonApprovalModeResult> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        const result = await session.client.setSessionApprovalMode(
          session.sessionId,
          mode,
          {
            clientId: session.clientId,
          },
        );
        setConnection((cur) => ({ ...cur, currentMode: result.mode || mode }));
        return result;
      },

      async respondToPermission(
        requestId: string,
        optionId: string,
        answers?: Record<string, string>,
      ): Promise<boolean> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        const response: PermissionResponse = {
          outcome: optionId
            ? { outcome: 'selected', optionId }
            : { outcome: 'cancelled' },
        };
        if (answers) {
          response.answers = answers;
        }
        return session.respondToSessionPermission(requestId, response);
      },

      async listSessions(): Promise<DaemonSessionSummary[]> {
        const session = sessionRef.current;
        if (!session) return [];
        const cwd = session.workspaceCwd;
        return session.client.listWorkspaceSessions(cwd);
      },

      async loadSession(sessionId: string): Promise<void> {
        const currentSession = sessionRef.current;
        if (currentSession) {
          const activePrompt = activePromptsRef.current.get(
            currentSession.sessionId,
          );
          if (activePrompt) {
            activePrompt.controller.abort();
            activePromptsRef.current.delete(currentSession.sessionId);
          }
        }
        const loadId = pendingSessionLoadIdRef.current + 1;
        pendingSessionLoadIdRef.current = loadId;
        if (pendingSessionLoadRef.current) {
          clearTimeout(pendingSessionLoadRef.current.timeout);
          pendingSessionLoadRef.current.reject(
            new Error('Session load superseded by a newer request'),
          );
        }
        const loadPromise = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (pendingSessionLoadRef.current?.id === loadId) {
              pendingSessionLoadRef.current = undefined;
              reject(new Error('Session load timed out'));
            }
          }, 30_000);
          pendingSessionLoadRef.current = {
            id: loadId,
            sessionId,
            timeout,
            resolve,
            reject,
          };
        });
        setPromptStatus('idle');
        clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
        store.reset();
        setRestoreSessionId(sessionId);
        setRestoreSessionNonce((nonce) => nonce + 1);
        return loadPromise;
      },

      async releaseSession(sessionId: string): Promise<void> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        await session.client.closeSession(sessionId);
      },

      async newSession(): Promise<void> {
        setPromptStatus('idle');
        clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
        if (pendingSessionLoadRef.current) {
          clearTimeout(pendingSessionLoadRef.current.timeout);
          pendingSessionLoadRef.current.reject(
            new Error('New session requested'),
          );
          pendingSessionLoadRef.current = undefined;
        }
        store.reset();
        setRestoreSessionId(undefined);
        setNewSessionNonce((nonce) => nonce + 1);
      },

      async closeSession(): Promise<void> {
        const session = sessionRef.current;
        if (!session) return;
        await session.close();
      },

      async refreshCommands(): Promise<void> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        const commandStatus = await session.supportedCommands();
        const { commands, skills } = mapSupportedCommands(commandStatus);
        setConnection((cur) => ({ ...cur, commands, skills }));
      },

      async loadMcpStatus(): Promise<DaemonWorkspaceMcpStatus> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        return session.client.workspaceMcp();
      },

      async loadMcpTools(serverName: string): Promise<WebShellMcpToolsStatus> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        try {
          const result = await session.client.workspaceMcpTools(serverName);
          return {
            v: 1,
            serverName: result.serverName,
            tools: (result.tools ?? []).map((t) => ({
              name: t.name,
              serverToolName: t.serverToolName,
              description: t.description,
              isValid: t.isValid,
              invalidReason: t.invalidReason,
              schema: t.schema,
              annotations: t.annotations,
            })),
            errors: result.errors,
          };
        } catch (error) {
          const isNotImplemented =
            error instanceof DaemonHttpError &&
            (error.status === 404 || error.status === 501);
          return {
            v: 1,
            serverName,
            tools: [],
            errors: [
              {
                error: isNotImplemented
                  ? 'The connected daemon does not expose MCP tool details.'
                  : `Failed to load MCP tools: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      },

      async restartMcpServer(
        serverName: string,
      ): Promise<DaemonMcpRestartResult> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        return session.client.restartMcpServer(serverName, {
          clientId: session.clientId,
        });
      },

      async loadSkillsStatus(): Promise<DaemonWorkspaceSkillsStatus> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        return session.client.workspaceSkills();
      },

      async loadToolsStatus(): Promise<DaemonWorkspaceToolsStatus> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        return session.client.workspaceTools();
      },

      async setWorkspaceToolEnabled(
        toolName: string,
        enabled: boolean,
      ): Promise<unknown> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        return session.client.setWorkspaceToolEnabled(toolName, enabled, {
          clientId: session.clientId,
        });
      },

      async loadMemoryStatus(): Promise<DaemonWorkspaceMemoryStatus> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        return session.client.workspaceMemory();
      },

      async readWorkspaceFile(filePath: string): Promise<DaemonWorkspaceFile> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        return session.client.readWorkspaceFile(filePath, {}, session.clientId);
      },

      async writeMemory(
        req: DaemonWriteMemoryRequest,
      ): Promise<DaemonWriteMemoryResult> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        return session.client.writeWorkspaceMemory(req, session.clientId);
      },

      async listAgents(): Promise<DaemonWorkspaceAgentsStatus> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        return session.client.listWorkspaceAgents();
      },

      async getAgent(agentType: string): Promise<DaemonWorkspaceAgentDetail> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        return session.client.getWorkspaceAgent(agentType);
      },

      async createAgent(
        req: DaemonCreateAgentRequest,
      ): Promise<DaemonAgentMutationResult> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        return session.client.createWorkspaceAgent(req, session.clientId);
      },

      async deleteAgent(
        agentType: string,
        scope?: 'workspace' | 'global',
      ): Promise<void> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        await session.client.deleteWorkspaceAgent(
          agentType,
          scope ? { scope } : {},
          session.clientId,
        );
      },

      async renameSession(displayName: string): Promise<SessionMetadataResult> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        return session.updateMetadata({ displayName });
      },

      async sendShellCommand(
        command: string,
      ): Promise<DaemonShellCommandResult> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        return session.shellCommand(command);
      },
    }),
    // Actions access the server via sessionRef (set by the connection effect), not opts directly.
    [store],
  );

  useEffect(() => {
    if (!connection.sessionId || !heartbeatSupportedRef.current) return;
    let cancelled = false;
    let consecutiveFailures = 0;
    const timer = setInterval(() => {
      if (!sessionRef.current) return;
      sessionRef.current
        .heartbeat()
        .then(() => {
          if (cancelled) return;
          if (consecutiveFailures >= 3) {
            setConnection((cur) =>
              cur.status === 'connected'
                ? cur
                : { ...cur, status: 'connected', error: undefined },
            );
          } else {
            setConnection((cur) =>
              cur.error
                ? { ...cur, status: 'connected', error: undefined }
                : cur,
            );
          }
          consecutiveFailures = 0;
        })
        .catch((err) => {
          if (cancelled) return;
          consecutiveFailures += 1;
          if (consecutiveFailures === 3) {
            console.warn('[web-shell] heartbeat failed 3 times:', err);
            setConnection((cur) => ({
              ...cur,
              status: 'disconnected',
              error: 'Session heartbeat failed — connection may be lost.',
            }));
          }
        });
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection.sessionId]);

  return { store, state, connection, actions, promptStatus };
}
