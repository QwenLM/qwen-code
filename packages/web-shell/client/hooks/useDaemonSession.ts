import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  DaemonClient,
  DaemonHttpError,
  DaemonSessionClient,
  createDaemonTranscriptStore,
  normalizeDaemonEvent,
  type DaemonEvent,
  type DaemonTranscriptStore,
  type DaemonSessionSummary,
  type DaemonApprovalMode,
  type DaemonApprovalModeResult,
  type DaemonSessionContextStatus,
  type DaemonSessionSupportedCommandsStatus,
  type DaemonWorkspaceMcpStatus,
  type DaemonMcpRestartResult,
  type DaemonWorkspaceSkillsStatus,
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
  type PromptContentBlock,
  type PromptResult,
} from '@qwen-code/sdk/daemon';
import type { CommandInfo, ModelInfo } from '../adapters/types';

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
  restartMcpServer(serverName: string): Promise<DaemonMcpRestartResult>;
  loadSkillsStatus(): Promise<DaemonWorkspaceSkillsStatus>;
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

export interface PromptImage {
  data: string;
  media_type: string;
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
  const passiveAssistantDoneTimerRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const [promptStatus, setPromptStatus] = useState<PromptStatus>('idle');
  const [restoreSessionId, setRestoreSessionId] = useState<string | undefined>(
    opts.initialSessionId,
  );
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
            setConnection({ status: 'connecting' });
            const caps = await client.capabilities();
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

          const [providerStatus, commandStatus, contextStatus] =
            await Promise.all([
              client.workspaceProviders().catch(() => undefined),
              session.supportedCommands().catch(() => undefined),
              session.context().catch(() => undefined),
            ]);
          const { models, currentModel, contextWindow } =
            mapProviderStatus(providerStatus);
          const { commands, skills } = mapSupportedCommands(commandStatus);
          const currentMode = getCurrentMode(contextStatus);

          setConnection({
            status: 'connected',
            sessionId: session.sessionId,
            workspaceCwd: session.workspaceCwd,
            commands,
            skills,
            models,
            currentModel,
            currentMode,
            tokenCount: 0,
            contextWindow,
          });

          let sawEvent = false;
          for await (const event of session.events({
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
                clientId: session.clientId,
                suppressOwnUserEcho: true,
              });
              if (uiEvents.length > 0) {
                setPromptStatus((cur) =>
                  cur === 'waiting' ? 'streaming' : cur,
                );
              }
              store.dispatch(uiEvents);
              if (
                !activePromptsRef.current.has(session.sessionId) &&
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

          if (error instanceof DaemonHttpError && error.status === 404) {
            session = undefined;
            sessionRef.current = undefined;
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
        const ctrl = new AbortController();
        activePromptsRef.current.set(sessionId, {
          controller: ctrl,
        });

        try {
          store.appendLocalUserMessage(text);
          const prompt = toPromptContent(text, images);
          const result = await session.prompt({ prompt }, ctrl.signal);
          if (sessionRef.current?.sessionId === sessionId) {
            store.dispatch({
              type: 'assistant.done',
              reason: result.stopReason,
            });
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
        setPromptStatus('idle');
        clearPassiveAssistantDoneTimer(passiveAssistantDoneTimerRef);
        store.reset();
        setRestoreSessionId(sessionId);
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

  return { store, state, connection, actions, promptStatus };
}

type TimerRef = MutableRefObject<ReturnType<typeof setTimeout> | undefined>;

function hasAssistantDelta(events: readonly { type: string }[]): boolean {
  return events.some((event) => event.type === 'assistant.text.delta');
}

function clearPassiveAssistantDoneTimer(timerRef: TimerRef): void {
  if (timerRef.current) {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }
}

function schedulePassiveAssistantDone(
  store: DaemonTranscriptStore,
  timerRef: TimerRef,
): void {
  clearPassiveAssistantDoneTimer(timerRef);
  timerRef.current = setTimeout(() => {
    timerRef.current = undefined;
    if (!store.getSnapshot().activeAssistantBlockId) return;
    store.dispatch({ type: 'assistant.done', reason: 'replay' });
  }, 80);
}

function getReconnectDelay(attempt: number, base: number, max: number): number {
  const exponential = base * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, max);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

function mapProviderStatus(
  status: DaemonWorkspaceProvidersStatus | undefined,
): {
  models: ModelInfo[];
  currentModel?: string;
  contextWindow?: number;
} {
  if (!status) {
    return { models: [] };
  }

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  let currentModel = status.current?.modelId;
  let contextWindow: number | undefined;

  for (const provider of status.providers) {
    for (const model of provider.models) {
      if (!currentModel && model.isCurrent) {
        currentModel = model.modelId;
      }
      if (
        !contextWindow &&
        (model.isCurrent || model.modelId === currentModel)
      ) {
        contextWindow = model.contextLimit;
      }
      if (seen.has(model.modelId)) {
        continue;
      }
      seen.add(model.modelId);
      models.push({
        id: model.modelId,
        label: model.name || model.modelId,
      });
    }
  }

  return { models, currentModel, contextWindow };
}

function mapSupportedCommands(
  status: DaemonSessionSupportedCommandsStatus | undefined,
): {
  commands: CommandInfo[];
  skills: string[];
} {
  if (!status) {
    return { commands: [], skills: [] };
  }

  const commands = status.availableCommands.map((command) => ({
    name: command.name,
    description: command.description || '',
    ...(command.input?.hint ? { argumentHint: command.input.hint } : {}),
  }));

  const skillCommands = status.availableSkills.map((skill) => ({
    name: skill,
    description: '运行 skill',
  }));

  return {
    commands: mergeCommands(commands, skillCommands),
    skills: status.availableSkills,
  };
}

function mergeCommands(...groups: CommandInfo[][]): CommandInfo[] {
  const byName = new Map<string, CommandInfo>();
  for (const group of groups) {
    for (const command of group) {
      byName.set(command.name, {
        ...byName.get(command.name),
        ...command,
      });
    }
  }
  return [...byName.values()];
}

function getCurrentMode(
  status: DaemonSessionContextStatus | undefined,
): string | undefined {
  const modes = getRecord(status?.state?.modes);
  return getString(modes, 'currentModeId') ?? getString(modes, 'currentMode');
}

function handleSilentDaemonEvent(
  event: DaemonEvent,
  setConnection: Dispatch<SetStateAction<DaemonConnectionState>>,
): boolean {
  if (event.type === 'session_update') {
    const update = getRecord(getRecord(event.data)?.['update']);
    const tokenCount = getUsageTokenCount(update);
    if (tokenCount !== undefined) {
      setConnection((cur) => ({ ...cur, tokenCount }));
    }
    if (getString(update, 'sessionUpdate') === 'available_commands_update') {
      const { commands, skills } = mapAvailableCommandsUpdate(update);
      setConnection((cur) => ({
        ...cur,
        commands: commands.length > 0 ? commands : cur.commands,
        skills,
      }));
      return true;
    }
  }

  switch (event.type) {
    case 'model_switched': {
      const modelId = getString(getRecord(event.data), 'modelId');
      if (modelId) {
        setConnection((cur) => ({ ...cur, currentModel: modelId }));
      }
      return true;
    }
    case 'approval_mode_changed': {
      const data = getRecord(event.data);
      const mode = getString(data, 'next') ?? getString(data, 'mode');
      if (mode) {
        setConnection((cur) => ({ ...cur, currentMode: mode }));
      }
      return true;
    }
    case 'session_metadata_updated':
    case 'memory_changed':
    case 'agent_changed':
    case 'tool_toggled':
    case 'mcp_server_restarted':
    case 'mcp_server_restart_refused':
      return true;
    default:
      return false;
  }
}

function getUsageTokenCount(
  update: Record<string, unknown> | undefined,
): number | undefined {
  const usage = getRecord(getRecord(update?.['_meta'])?.['usage']);
  const count =
    getNumber(usage, 'inputTokens') ?? getNumber(usage, 'totalTokens');
  return count !== undefined && count > 0 ? count : undefined;
}

function mapAvailableCommandsUpdate(
  update: Record<string, unknown> | undefined,
): {
  commands: CommandInfo[];
  skills: string[];
} {
  if (!update) {
    return { commands: [], skills: [] };
  }
  const commandRecords = Array.isArray(update['availableCommands'])
    ? update['availableCommands']
    : [];
  const commands = commandRecords.flatMap((raw): CommandInfo[] => {
    const command = getRecord(raw);
    const name = getString(command, 'name');
    if (!name) return [];
    const input = getRecord(command?.['input']);
    return [
      {
        name,
        description: getString(command, 'description') ?? '',
        ...(getString(input, 'hint')
          ? { argumentHint: getString(input, 'hint') }
          : {}),
      },
    ];
  });
  const skills = Array.isArray(update['availableSkills'])
    ? update['availableSkills'].filter(
        (skill): skill is string => typeof skill === 'string',
      )
    : [];
  const skillCommands = skills.map((skill) => ({
    name: skill,
    description: '运行 skill',
  }));
  return {
    commands: mergeCommands(commands, skillCommands),
    skills,
  };
}

function toPromptContent(
  text: string,
  images?: PromptImage[],
): PromptContentBlock[] {
  const prompt: PromptContentBlock[] = [{ type: 'text', text }];
  for (const image of images ?? []) {
    prompt.push({
      type: 'image',
      mimeType: image.media_type,
      data: image.data,
    });
  }
  return prompt;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}
