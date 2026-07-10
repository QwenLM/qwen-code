import { EventEmitter } from 'node:events';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type {
  AvailableCommand,
  BridgeSessionInfo,
  ChannelAgentBridge,
  ToolCallEvent,
} from './ChannelAgentBridge.js';
import { readAvailableCommandAltNames } from './AcpBridge.js';
import type { SessionScope } from './types.js';

const MAX_RESPONDED_PERMISSION_REQUESTS = 256;

export interface DaemonChannelEvent {
  id?: number;
  v: 1;
  type: string;
  data: unknown;
  originatorClientId?: string;
}

export interface DaemonChannelSessionClient {
  readonly sessionId: string;
  readonly workspaceCwd: string;
  readonly lastEventId?: number;
  prompt(
    req: {
      prompt: Array<Record<string, unknown>>;
    },
    signal?: AbortSignal,
  ): Promise<{ stopReason?: string; [key: string]: unknown }>;
  events(opts?: {
    signal?: AbortSignal;
    lastEventId?: number;
    resume?: boolean;
  }): AsyncGenerator<DaemonChannelEvent>;
  detach?(): Promise<void>;
  cancel(): Promise<void>;
  setModel(modelId: string): Promise<Record<string, unknown>>;
  respondToPermission(
    requestId: string,
    response: RequestPermissionResponse,
  ): Promise<boolean>;
  shellCommand?(
    command: string,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; output: string; aborted: boolean }>;
}

export interface DaemonChannelSessionFactoryRequest {
  workspaceCwd: string;
  modelServiceId?: string;
  sessionId?: string;
  sessionScope?: SessionScope;
  approvalMode?: string;
}

export type DaemonChannelSessionFactory = (
  req: DaemonChannelSessionFactoryRequest,
) => Promise<DaemonChannelSessionClient>;

export interface DaemonChannelBridgeOptions {
  cwd: string;
  sessionFactory: DaemonChannelSessionFactory;
  modelServiceId?: string;
  sessionScope?: SessionScope;
}

export interface DaemonPermissionRequestEvent {
  requestId: string;
  sessionId: string;
  request: RequestPermissionRequest;
}

export interface DaemonPermissionResolvedEvent {
  requestId: string;
  outcome?: DaemonPermissionOutcome;
}

export interface DaemonPromptCompleteEvent {
  sessionId: string;
  text: string;
  stopReason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getTextContent(content: unknown): string | undefined {
  if (!isRecord(content)) {
    return undefined;
  }
  return getString(content['text']);
}

function getSessionUpdate(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data) || !isRecord(data['update'])) {
    return undefined;
  }
  return data['update'];
}

function isAvailableCommand(value: unknown): value is AvailableCommand {
  if (!isRecord(value) || typeof value['name'] !== 'string') return false;
  // altNames is optional; when present it MUST be a string[] (so the type guard is
  // honest). A malformed wire payload — e.g. `altNames: 5` — would otherwise survive
  // onto the command and throw at the downstream `altNames.some(...)` recognition
  // site in ChannelBase.matchAgentCommand.
  const altNames = value['altNames'];
  return (
    altNames === undefined ||
    (Array.isArray(altNames) && altNames.every((n) => typeof n === 'string'))
  );
}

function isPermissionRequestData(
  value: unknown,
): value is RequestPermissionRequest & { requestId: string } {
  if (
    !isRecord(value) ||
    typeof value['requestId'] !== 'string' ||
    !isRecord(value['toolCall']) ||
    typeof value['toolCall']['toolCallId'] !== 'string' ||
    typeof value['toolCall']['kind'] !== 'string' ||
    !Array.isArray(value['options'])
  ) {
    return false;
  }
  return value['options'].every(
    (option) => isRecord(option) && typeof option['optionId'] === 'string',
  );
}

type DaemonPermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string };

function parsePermissionOutcome(
  value: unknown,
): DaemonPermissionOutcome | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value['outcome'] === 'cancelled') {
    return { outcome: 'cancelled' };
  }
  if (
    value['outcome'] === 'selected' &&
    typeof value['optionId'] === 'string'
  ) {
    return { outcome: 'selected', optionId: value['optionId'] };
  }
  return undefined;
}

function summarizeProtocolDetails(details: unknown): unknown {
  if (!isRecord(details)) {
    return { type: typeof details };
  }
  const summary: Record<string, unknown> = {};
  for (const key of [
    'requestId',
    'sessionId',
    'sessionUpdate',
    'modelId',
    'requestedModelId',
    'toolCallId',
    'kind',
  ]) {
    const value = details[key];
    if (typeof value === 'string') {
      summary[key] = value;
    }
  }
  return summary;
}

export class DaemonChannelBridge
  extends EventEmitter
  implements ChannelAgentBridge
{
  private readonly options: DaemonChannelBridgeOptions;
  private readonly sessions = new Map<string, DaemonChannelSessionClient>();
  private readonly sessionBindingTokens = new Map<string, object | undefined>();
  private readonly eventControllers = new Map<string, AbortController>();
  private readonly requestToSession = new Map<string, string>();
  private readonly respondedRequestToSession = new Map<string, string>();
  private readonly activePrompts = new Set<string>();
  private readonly activePromptControllers = new Map<
    string,
    Set<AbortController>
  >();
  private readonly availableCommandsBySession = new Map<
    string,
    AvailableCommand[]
  >();
  private readonly turnBarriers = new Map<string, () => void>();
  private connected = false;
  private lifecycleGeneration = 0;
  private latestAvailableCommandsSessionId: string | undefined;
  private lastError: unknown;

  constructor(options: DaemonChannelBridgeOptions) {
    super();
    this.options = options;
    this.on('error', (error) => {
      this.lastError = error;
    });
  }

  get availableCommands(): AvailableCommand[] {
    if (this.latestAvailableCommandsSessionId) {
      return (
        this.availableCommandsBySession.get(
          this.latestAvailableCommandsSessionId,
        ) ?? []
      );
    }
    return Array.from(this.availableCommandsBySession.values()).at(-1) ?? [];
  }

  get lastDaemonError(): unknown {
    return this.lastError;
  }

  getAvailableCommands(sessionId: string): AvailableCommand[] {
    return this.availableCommandsBySession.get(sessionId) ?? [];
  }

  listSessions(): BridgeSessionInfo[] {
    const result: BridgeSessionInfo[] = [];
    for (const session of this.sessions.values()) {
      result.push({
        sessionId: session.sessionId,
        workspaceCwd: session.workspaceCwd,
        hasActivePrompt: this.activePrompts.has(session.sessionId),
      });
    }
    return result;
  }

  async start(): Promise<void> {
    this.connected = true;
  }

  async newSession(
    cwd: string,
    options?: { approvalMode?: string },
    bindingToken?: object,
  ): Promise<string> {
    const lifecycleGeneration = this.lifecycleGeneration;
    const session = await this.options.sessionFactory({
      workspaceCwd: cwd || this.options.cwd,
      modelServiceId: this.options.modelServiceId,
      sessionScope: this.options.sessionScope ?? 'thread',
      ...(options?.approvalMode ? { approvalMode: options.approvalMode } : {}),
    });
    if (lifecycleGeneration !== this.lifecycleGeneration) {
      await this.rejectStaleSession(session);
    }
    this.attachSession(session, bindingToken);
    return session.sessionId;
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    options?: { approvalMode?: string },
    bindingToken?: object,
  ): Promise<string> {
    const lifecycleGeneration = this.lifecycleGeneration;
    const session = await this.options.sessionFactory({
      workspaceCwd: cwd || this.options.cwd,
      modelServiceId: this.options.modelServiceId,
      sessionId,
      sessionScope: this.options.sessionScope ?? 'thread',
      ...(options?.approvalMode ? { approvalMode: options.approvalMode } : {}),
    });
    if (lifecycleGeneration !== this.lifecycleGeneration) {
      await this.rejectStaleSession(session);
    }
    if (session.sessionId !== sessionId) {
      throw new Error(
        `Daemon returned session ${session.sessionId} while loading ${sessionId}`,
      );
    }
    this.attachSession(session, bindingToken);
    return session.sessionId;
  }

  async prompt(
    sessionId: string,
    text: string,
    options?: { imageBase64?: string; imageMimeType?: string },
  ): Promise<string> {
    const session = this.ensureSession(sessionId);
    if (this.activePrompts.has(sessionId)) {
      throw new Error(
        `Prompt already in flight for daemon session ${sessionId}`,
      );
    }
    this.activePrompts.add(sessionId);

    const controller = new AbortController();
    let controllers = this.activePromptControllers.get(sessionId);
    if (!controllers) {
      controllers = new Set();
      this.activePromptControllers.set(sessionId, controllers);
    }
    controllers.add(controller);

    const chunks: string[] = [];
    const onChunk = (sid: string, chunk: string) => {
      if (sid === sessionId) {
        chunks.push(chunk);
      }
    };
    const clearChunks = (sid: string) => {
      if (sid === sessionId) {
        chunks.length = 0;
      }
    };
    const onSessionDied = (info: { sessionId: string }) => {
      if (info.sessionId === sessionId) {
        controller.abort();
      }
    };
    this.on('textChunk', onChunk);
    this.on('responseBoundary', clearChunks);
    this.on('sessionDied', onSessionDied);
    const turnBarrier = this.createTurnBarrier(sessionId);

    const prompt: Array<Record<string, unknown>> = [];
    if (options?.imageBase64 && options.imageMimeType) {
      prompt.push({
        type: 'image',
        data: options.imageBase64,
        mimeType: options.imageMimeType,
      });
    }
    prompt.push({ type: 'text', text });

    try {
      const result = await session.prompt({ prompt }, controller.signal);
      // Prefer turn_complete for deterministic chunk collection (SSE path).
      // Fall back to one event-loop tick for non-SSE prompt paths (blocking
      // HTTP, non-202 responses) where turn_complete never arrives.
      await Promise.race([
        turnBarrier,
        new Promise<void>((resolve) => setTimeout(resolve, 0)),
      ]);
      const textResult = chunks.join('');
      this.emit('promptComplete', {
        sessionId,
        text: textResult,
        stopReason: result.stopReason,
      } satisfies DaemonPromptCompleteEvent);
      return textResult;
    } finally {
      this.clearTurnBarrier(sessionId);
      this.off('textChunk', onChunk);
      this.off('responseBoundary', clearChunks);
      this.off('sessionDied', onSessionDied);
      this.activePrompts.delete(sessionId);
      controllers.delete(controller);
      if (
        controllers.size === 0 &&
        this.activePromptControllers.get(sessionId) === controllers
      ) {
        this.activePromptControllers.delete(sessionId);
      }
    }
  }

  async shellCommand(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; output: string; aborted: boolean }> {
    const session = this.ensureSession(sessionId);
    if (!session.shellCommand) {
      throw new Error('Shell command not supported by this session client');
    }
    return session.shellCommand(command, signal);
  }

  async cancelSession(sessionId: string): Promise<void> {
    const session = this.ensureSession(sessionId);
    this.resolveTurnBarrier(sessionId);
    this.abortActivePrompts(sessionId);
    this.activePrompts.delete(sessionId);
    await session.cancel();
  }

  async discardSession(
    sessionId: string,
    expectedBindingToken?: object,
  ): Promise<void> {
    if (
      expectedBindingToken !== undefined &&
      this.sessionBindingTokens.get(sessionId) !== expectedBindingToken
    ) {
      return;
    }
    const session = this.removeSessionBinding(sessionId);
    if (!session) return;
    await this.releaseSessionClient(session);
  }

  private async releaseSessionClient(
    session: DaemonChannelSessionClient,
  ): Promise<void> {
    if (session.detach) {
      try {
        await session.detach();
        return;
      } catch {
        // Fall back to cancellation for clients that cannot detach cleanly.
      }
    }
    await session.cancel();
  }

  async setSessionModel(
    sessionId: string,
    modelId: string,
  ): Promise<Record<string, unknown>> {
    return await this.ensureSession(sessionId).setModel(modelId);
  }

  async respondToPermission(
    requestId: string,
    response: RequestPermissionResponse,
  ): Promise<boolean> {
    const sessionId = this.requestToSession.get(requestId);
    if (!sessionId) {
      return false;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.requestToSession.delete(requestId);
      this.respondedRequestToSession.delete(requestId);
      return false;
    }
    try {
      const accepted = await session.respondToPermission(requestId, response);
      this.requestToSession.delete(requestId);
      if (accepted) {
        this.rememberRespondedPermissionRequest(requestId, sessionId);
      } else {
        this.respondedRequestToSession.delete(requestId);
      }
      return accepted;
    } catch (error) {
      this.requestToSession.delete(requestId);
      this.respondedRequestToSession.delete(requestId);
      throw error;
    }
  }

  stop(): void {
    this.lifecycleGeneration++;
    for (const sessionId of Array.from(this.sessions.keys())) {
      const session = this.sessions.get(sessionId);
      if (session) {
        void session.cancel().catch((error: unknown) => {
          this.lastError = error;
        });
      }
      this.dropSession(sessionId, 'bridge_stopped');
    }
    this.latestAvailableCommandsSessionId = undefined;
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private attachSession(
    session: DaemonChannelSessionClient,
    bindingToken?: object,
  ): void {
    if (this.sessions.has(session.sessionId)) {
      this.dropSession(session.sessionId, 'session_replaced');
    }

    this.sessions.set(session.sessionId, session);
    this.sessionBindingTokens.set(session.sessionId, bindingToken);
    const controller = new AbortController();
    this.eventControllers.set(session.sessionId, controller);
    void this.pumpEvents(session, controller.signal);
  }

  private async rejectStaleSession(
    session: DaemonChannelSessionClient,
  ): Promise<void> {
    try {
      await this.releaseSessionClient(session);
    } catch (error) {
      this.lastError = error;
    }
    throw new Error('Daemon channel bridge stopped during session creation');
  }

  private ensureSession(sessionId: string): DaemonChannelSessionClient {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No daemon session bound for ${sessionId}`);
    }
    return session;
  }

  private async pumpEvents(
    session: DaemonChannelSessionClient,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for await (const event of session.events({
        signal,
        lastEventId: session.lastEventId,
        resume: true,
      })) {
        if (!this.isCurrentPump(session, signal)) {
          return;
        }
        this.handleEvent(session, event);
      }
      if (!signal.aborted && this.isCurrentPump(session, signal)) {
        this.dropSession(session.sessionId, 'stream_ended');
      }
    } catch (error) {
      if (!signal.aborted && this.isCurrentPump(session, signal)) {
        this.emit('error', error);
        this.dropSession(
          session.sessionId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private isCurrentPump(
    session: DaemonChannelSessionClient,
    signal: AbortSignal,
  ): boolean {
    return (
      this.sessions.get(session.sessionId) === session &&
      this.eventControllers.get(session.sessionId)?.signal === signal
    );
  }

  private handleEvent(
    session: DaemonChannelSessionClient,
    event: DaemonChannelEvent,
  ): void {
    switch (event.type) {
      case 'session_update':
        this.handleSessionUpdate(session.sessionId, event.data);
        break;
      case 'permission_request':
        this.handlePermissionRequest(session.sessionId, event.data);
        break;
      case 'permission_resolved':
        this.handlePermissionResolved(session.sessionId, event.data);
        break;
      case 'model_switched':
        this.handleModelSwitched(session.sessionId, event.data);
        break;
      case 'model_switch_failed':
        this.handleModelSwitchFailed(session.sessionId, event.data);
        break;
      case 'session_died':
        this.handleSessionDied(session.sessionId, event.data);
        break;
      case 'client_evicted':
        this.dropSession(
          session.sessionId,
          this.getStringField(event.data, 'reason', 'client_evicted'),
        );
        break;
      case 'stream_error':
        this.dropSession(
          session.sessionId,
          this.getStringField(event.data, 'error', 'stream_error'),
        );
        break;
      case 'turn_complete':
        this.resolveTurnBarrier(session.sessionId);
        break;
      case 'turn_error':
        this.emitProtocolError(
          `Daemon turn error for session ${session.sessionId}`,
          event.data,
        );
        this.resolveTurnBarrier(session.sessionId);
        break;
      default:
        break;
    }
  }

  private handleSessionUpdate(sessionId: string, data: unknown): void {
    const update = getSessionUpdate(data);
    if (!update) {
      this.emitProtocolError('Malformed daemon session_update event', data);
      return;
    }

    const type = getString(update['sessionUpdate']);
    switch (type) {
      case 'agent_message_chunk': {
        const text = getTextContent(update['content']);
        if (text) {
          this.emit('textChunk', sessionId, text);
        }
        break;
      }
      case 'agent_thought_chunk': {
        const text = getTextContent(update['content']);
        if (text) {
          this.emit('thoughtChunk', sessionId, text);
        }
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const toolCallId = getString(update['toolCallId']);
        const kind = getString(update['kind']);
        if (!toolCallId || !kind) {
          this.emitProtocolError(`Malformed daemon ${type} event`, update);
          break;
        }
        const event: ToolCallEvent = {
          sessionId,
          toolCallId,
          kind,
          title: getString(update['title']) ?? '',
          status: getString(update['status']) ?? 'pending',
          rawInput: isRecord(update['rawInput'])
            ? update['rawInput']
            : undefined,
        };
        if (event.status === 'pending' || event.status === 'in_progress') {
          this.emitResponseBoundary(sessionId);
        }
        this.emit('toolCall', event);
        break;
      }
      case 'plan': {
        this.emitResponseBoundary(sessionId);
        break;
      }
      case 'available_commands_update': {
        if (Array.isArray(update['availableCommands'])) {
          const commands = update['availableCommands']
            .filter(isAvailableCommand)
            .map((cmd) => {
              const altNames = readAvailableCommandAltNames(cmd);
              return altNames ? { ...cmd, altNames } : cmd;
            });
          this.availableCommandsBySession.set(sessionId, commands);
          this.latestAvailableCommandsSessionId = sessionId;
        } else {
          this.emitProtocolError(
            'Malformed daemon available_commands_update event',
            data,
          );
        }
        break;
      }
      default:
        break;
    }

    this.emit('sessionUpdate', data);
  }

  private handlePermissionRequest(sessionId: string, data: unknown): void {
    if (!isPermissionRequestData(data)) {
      this.emitProtocolError('Malformed daemon permission_request event', data);
      return;
    }
    const requestId = data['requestId'];
    this.requestToSession.set(requestId, sessionId);
    this.emitResponseBoundary(sessionId);
    this.emit('permissionRequest', {
      requestId,
      sessionId,
      request: data as unknown as RequestPermissionRequest,
    } satisfies DaemonPermissionRequestEvent);
  }

  private rememberRespondedPermissionRequest(
    requestId: string,
    sessionId: string,
  ): void {
    this.respondedRequestToSession.set(requestId, sessionId);
    while (
      this.respondedRequestToSession.size > MAX_RESPONDED_PERMISSION_REQUESTS
    ) {
      const oldestRequestId = this.respondedRequestToSession
        .keys()
        .next().value;
      if (oldestRequestId === undefined) {
        return;
      }
      this.respondedRequestToSession.delete(oldestRequestId);
    }
  }

  private handlePermissionResolved(sessionId: string, data: unknown): void {
    if (!isRecord(data) || typeof data['requestId'] !== 'string') {
      this.emitProtocolError(
        'Malformed daemon permission_resolved event',
        data,
      );
      return;
    }
    const requestId = data['requestId'];
    const mappedSessionId =
      this.requestToSession.get(requestId) ??
      this.respondedRequestToSession.get(requestId);
    if (!mappedSessionId) {
      this.emitProtocolError(
        `Ignoring daemon permission_resolved for unknown request ${requestId}`,
        data,
      );
      return;
    }
    if (mappedSessionId !== sessionId) {
      this.requestToSession.delete(requestId);
      this.respondedRequestToSession.delete(requestId);
      this.emitProtocolError(
        `Ignoring daemon permission_resolved for request ${requestId} from non-owning session ${sessionId}`,
        data,
      );
      return;
    }
    const outcome = parsePermissionOutcome(data['outcome']);
    if (!outcome) {
      this.requestToSession.delete(requestId);
      this.respondedRequestToSession.delete(requestId);
      this.emitProtocolError(
        'Malformed daemon permission_resolved outcome',
        data,
      );
      return;
    }
    this.requestToSession.delete(requestId);
    this.respondedRequestToSession.delete(requestId);
    this.emit('permissionResolved', {
      requestId,
      outcome,
    } satisfies DaemonPermissionResolvedEvent);
  }

  private handleModelSwitched(sessionId: string, data: unknown): void {
    if (!isRecord(data) || typeof data['modelId'] !== 'string') {
      this.emitProtocolError('Malformed daemon model_switched event', data);
      return;
    }
    this.emit('modelSwitched', {
      sessionId,
      modelId: data['modelId'],
    });
  }

  private handleModelSwitchFailed(sessionId: string, data: unknown): void {
    if (!isRecord(data)) {
      this.emitProtocolError(
        'Malformed daemon model_switch_failed event',
        data,
      );
      return;
    }
    this.emit('modelSwitchFailed', {
      sessionId,
      requestedModelId: getString(data['requestedModelId']),
      error: getString(data['error']) ?? 'model_switch_failed',
    });
  }

  private handleSessionDied(sessionId: string, data: unknown): void {
    this.dropSession(
      sessionId,
      this.getStringField(data, 'reason', 'session_died'),
    );
  }

  private dropSession(sessionId: string, reason: string): void {
    if (!this.removeSessionBinding(sessionId)) return;
    this.emit('sessionDied', { sessionId, reason });
  }

  private removeSessionBinding(
    sessionId: string,
  ): DaemonChannelSessionClient | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    this.resolveTurnBarrier(sessionId);
    this.eventControllers.get(sessionId)?.abort();
    this.eventControllers.delete(sessionId);
    this.sessions.delete(sessionId);
    this.sessionBindingTokens.delete(sessionId);
    this.abortActivePrompts(sessionId);
    this.activePrompts.delete(sessionId);
    this.availableCommandsBySession.delete(sessionId);
    if (this.latestAvailableCommandsSessionId === sessionId) {
      this.latestAvailableCommandsSessionId = Array.from(
        this.availableCommandsBySession.keys(),
      ).at(-1);
    }
    for (const [requestId, mappedSessionId] of this.requestToSession) {
      if (mappedSessionId === sessionId) {
        this.requestToSession.delete(requestId);
      }
    }
    for (const [requestId, mappedSessionId] of this.respondedRequestToSession) {
      if (mappedSessionId === sessionId) {
        this.respondedRequestToSession.delete(requestId);
      }
    }
    return session;
  }

  private getStringField(
    data: unknown,
    field: string,
    fallback: string,
  ): string {
    return isRecord(data) && typeof data[field] === 'string'
      ? (data[field] as string)
      : fallback;
  }

  private abortActivePrompts(sessionId: string): void {
    const promptControllers = this.activePromptControllers.get(sessionId);
    if (!promptControllers) {
      return;
    }
    for (const controller of promptControllers) {
      controller.abort();
    }
    this.activePromptControllers.delete(sessionId);
  }

  private emitResponseBoundary(sessionId: string): void {
    this.emit('responseBoundary', sessionId);
  }

  private createTurnBarrier(sessionId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.turnBarriers.set(sessionId, resolve);
    });
  }

  private resolveTurnBarrier(sessionId: string): void {
    const resolve = this.turnBarriers.get(sessionId);
    if (resolve) {
      this.turnBarriers.delete(sessionId);
      resolve();
    }
  }

  private clearTurnBarrier(sessionId: string): void {
    this.turnBarriers.delete(sessionId);
  }

  private emitProtocolError(message: string, details: unknown): void {
    const error = new Error(message) as Error & { details?: unknown };
    error.details = summarizeProtocolDetails(details);
    this.emit('error', error);
  }
}
