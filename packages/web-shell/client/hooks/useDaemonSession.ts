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
  type DaemonWorkspaceMcpToolsStatus,
  type DaemonMcpRestartResult,
  type DaemonWorkspaceSkillsStatus,
  type DaemonWorkspaceToolsStatus,
  type DaemonWorkspaceMemoryStatus,
  type DaemonWriteMemoryRequest,
  type DaemonWriteMemoryResult,
  type DaemonWorkspaceAgentsStatus,
  type DaemonWorkspaceAgentDetail,
  type DaemonCreateAgentRequest,
  type DaemonAgentMutationResult,
  type DaemonWorkspaceProvidersStatus,
  type SessionMetadataResult,
  type PermissionResponse,
  type PromptResult,
  type HeartbeatResult,
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
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export interface DaemonActions {
  sendPrompt(text: string, images?: PromptImage[]): Promise<PromptResult>;
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
  newSession(): Promise<void>;
  closeSession(): Promise<void>;
  loadMcpStatus(): Promise<DaemonWorkspaceMcpStatus>;
  loadMcpTools(serverName: string): Promise<DaemonWorkspaceMcpToolsStatus>;
  restartMcpServer(serverName: string): Promise<DaemonMcpRestartResult>;
  loadSkillsStatus(): Promise<DaemonWorkspaceSkillsStatus>;
  loadToolsStatus(): Promise<DaemonWorkspaceToolsStatus>;
  setWorkspaceToolEnabled(toolName: string, enabled: boolean): Promise<unknown>;
  loadMemoryStatus(): Promise<DaemonWorkspaceMemoryStatus>;
  writeMemory(req: DaemonWriteMemoryRequest): Promise<DaemonWriteMemoryResult>;
  listAgents(): Promise<DaemonWorkspaceAgentsStatus>;
  getAgent(agentType: string): Promise<DaemonWorkspaceAgentDetail>;
  createAgent(
    req: DaemonCreateAgentRequest,
  ): Promise<DaemonAgentMutationResult>;
  deleteAgent(agentType: string, scope?: 'workspace' | 'global'): Promise<void>;
  renameSession(displayName: string): Promise<SessionMetadataResult>;
}

interface ActivePrompt {
  controller: AbortController;
}

const DEFAULT_CONFIG: DaemonSessionConfig = {
  baseUrl: '',
  autoReconnect: true,
  reconnectDelayMs: 1_000,
  maxReconnectDelayMs: 10_000,
};

export function useDaemonSession(config: Partial<DaemonSessionConfig> = {}) {
  const opts = { ...DEFAULT_CONFIG, ...config };
  const store = useMemo(() => createDaemonTranscriptStore(), []);
  const sessionRef = useRef<DaemonSessionClient | undefined>(undefined);
  const activePromptsRef = useRef<Map<string, ActivePrompt>>(new Map());
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

    const run = async () => {
      const client = new DaemonClient({
        baseUrl: opts.baseUrl,
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
            heartbeatSupportedRef.current =
              caps.features.includes('client_heartbeat');
            const workspaceCwd = opts.workspaceCwd ?? caps.workspaceCwd;
            session = restoreSessionId
              ? await DaemonSessionClient.load(client, restoreSessionId, {
                  workspaceCwd,
                })
              : reconnectSessionId
                ? await DaemonSessionClient.load(client, reconnectSessionId, {
                    workspaceCwd,
                  })
                : await DaemonSessionClient.createOrAttach(client, {
                    workspaceCwd,
                    ...(shouldCreateFreshSession
                      ? { sessionScope: 'thread' as const }
                      : {}),
                  });
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
              ? '模型列表加载失败，部分模型信息可能不可用'
              : undefined,
            commandResult.status === 'rejected'
              ? '命令列表加载失败，斜杠命令可能不完整'
              : undefined,
            contextResult.status === 'rejected'
              ? '会话上下文加载失败，当前模式可能显示不准确'
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
              if (handleSilentDaemonEvent(event, setConnection)) {
                continue;
              }
              const uiEvents = normalizeDaemonEvent(event, {
                clientId: activeSession.clientId,
                suppressOwnUserEcho: true,
              });
              if (uiEvents.length > 0) {
                setPromptStatus((cur) =>
                  cur === 'waiting' ? 'streaming' : cur,
                );
              }
              store.dispatch(uiEvents);
              if (
                !activePromptsRef.current.has(activeSession.sessionId) &&
                hasAssistantDelta(uiEvents)
              ) {
                schedulePassiveAssistantDone(
                  store,
                  passiveAssistantDoneTimerRef,
                );
              }
            } catch {
              // skip malformed events
            }
          }

          if (!disposed && !abort.signal.aborted) {
            session = undefined;
            sessionRef.current = undefined;
          }
        } catch (error) {
          if (disposed || abort.signal.aborted) return;
          const message =
            error instanceof Error ? error.message : String(error);

          session = undefined;
          sessionRef.current = undefined;

          if (error instanceof DaemonHttpError && error.status === 404) {
            const missingSessionId = restoreSessionId ?? reconnectSessionId;
            reconnectSessionId = undefined;
            if (restoreSessionId) {
              setRestoreSessionId(undefined);
            }
            store.dispatch([
              {
                type: 'error',
                text: missingSessionId
                  ? `Session ${missingSessionId} no longer exists. A fresh session will be opened.`
                  : 'Session no longer exists. A fresh session will be opened.',
              },
            ]);
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
      disposed = true;
      abort.abort();
      clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
      setPromptStatus('idle');
      sessionRef.current = undefined;
    };
  }, [
    opts.baseUrl,
    opts.token,
    opts.workspaceCwd,
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
          store.appendLocalUserMessage(text);
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
          await DaemonSessionClient.load(currentSession.client, sessionId, {
            workspaceCwd: currentSession.workspaceCwd,
          });
        }
        setPromptStatus('idle');
        clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
        store.reset();
        setRestoreSessionId(sessionId);
        setRestoreSessionNonce((nonce) => nonce + 1);
      },

      async newSession(): Promise<void> {
        setPromptStatus('idle');
        clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
        store.reset();
        setRestoreSessionId(undefined);
        setNewSessionNonce((nonce) => nonce + 1);
      },

      async closeSession(): Promise<void> {
        const session = sessionRef.current;
        if (!session) return;
        await session.close();
      },

      async loadMcpStatus(): Promise<DaemonWorkspaceMcpStatus> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        return session.client.workspaceMcp();
      },

      async loadMcpTools(
        serverName: string,
      ): Promise<DaemonWorkspaceMcpToolsStatus> {
        const session = sessionRef.current;
        if (!session) throw new Error('Not connected');
        return session.client.workspaceMcpTools(serverName);
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
    }),
    [store],
  );

  useEffect(() => {
    if (!connection.sessionId || !heartbeatSupportedRef.current) return;
    const timer = setInterval(() => {
      sessionRef.current?.heartbeat().catch(() => {});
    }, 30_000);
    return () => clearInterval(timer);
  }, [connection.sessionId]);

  return { store, state, connection, actions, promptStatus };
}
