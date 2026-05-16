import { EventEmitter } from 'node:events';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { AvailableCommand, ToolCallEvent } from './AcpBridge.js';

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
  prompt(req: {
    prompt: Array<Record<string, unknown>>;
  }): Promise<{ stopReason?: string; [key: string]: unknown }>;
  events(opts?: {
    signal?: AbortSignal;
    lastEventId?: number;
    resume?: boolean;
  }): AsyncGenerator<DaemonChannelEvent>;
  cancel(): Promise<void>;
  setModel(modelId: string): Promise<Record<string, unknown>>;
  respondToPermission(
    requestId: string,
    response: RequestPermissionResponse,
  ): Promise<boolean>;
}

export interface DaemonChannelSessionFactoryRequest {
  workspaceCwd: string;
  modelServiceId?: string;
  sessionId?: string;
}

export type DaemonChannelSessionFactory = (
  req: DaemonChannelSessionFactoryRequest,
) => Promise<DaemonChannelSessionClient>;

export interface DaemonChannelBridgeOptions {
  cwd: string;
  sessionFactory: DaemonChannelSessionFactory;
  modelServiceId?: string;
}

export interface DaemonPermissionRequestEvent {
  requestId: string;
  sessionId: string;
  request: RequestPermissionRequest;
}

export interface DaemonPermissionResolvedEvent {
  requestId: string;
  outcome?: unknown;
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

export class DaemonChannelBridge extends EventEmitter {
  private readonly options: DaemonChannelBridgeOptions;
  private readonly sessions = new Map<string, DaemonChannelSessionClient>();
  private readonly eventControllers = new Map<string, AbortController>();
  private readonly requestToSession = new Map<string, string>();
  private connected = false;
  private _availableCommands: AvailableCommand[] = [];

  constructor(options: DaemonChannelBridgeOptions) {
    super();
    this.options = options;
  }

  get availableCommands(): AvailableCommand[] {
    return this._availableCommands;
  }

  async start(): Promise<void> {
    this.connected = true;
  }

  async newSession(cwd: string): Promise<string> {
    const session = await this.options.sessionFactory({
      workspaceCwd: cwd || this.options.cwd,
      modelServiceId: this.options.modelServiceId,
    });
    this.attachSession(session);
    return session.sessionId;
  }

  async loadSession(sessionId: string, cwd: string): Promise<string> {
    const session = await this.options.sessionFactory({
      workspaceCwd: cwd || this.options.cwd,
      modelServiceId: this.options.modelServiceId,
      sessionId,
    });
    this.attachSession(session);
    return session.sessionId;
  }

  async prompt(
    sessionId: string,
    text: string,
    options?: { imageBase64?: string; imageMimeType?: string },
  ): Promise<string> {
    const session = this.ensureSession(sessionId);
    const chunks: string[] = [];
    const onChunk = (sid: string, chunk: string) => {
      if (sid === sessionId) {
        chunks.push(chunk);
      }
    };
    this.on('textChunk', onChunk);

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
      await session.prompt({ prompt });
    } finally {
      this.off('textChunk', onChunk);
    }

    return chunks.join('');
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.ensureSession(sessionId).cancel();
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
    return await this.ensureSession(sessionId).respondToPermission(
      requestId,
      response,
    );
  }

  stop(): void {
    for (const controller of this.eventControllers.values()) {
      controller.abort();
    }
    this.eventControllers.clear();
    this.sessions.clear();
    this.requestToSession.clear();
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private attachSession(session: DaemonChannelSessionClient): void {
    const existing = this.eventControllers.get(session.sessionId);
    existing?.abort();

    this.sessions.set(session.sessionId, session);
    const controller = new AbortController();
    this.eventControllers.set(session.sessionId, controller);
    void this.pumpEvents(session, controller.signal);
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
      for await (const event of session.events({ signal })) {
        this.handleEvent(session, event);
      }
    } catch (error) {
      if (!signal.aborted) {
        this.emit('error', error);
      }
    }
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
        this.handlePermissionResolved(event.data);
        break;
      case 'model_switched':
        this.handleModelSwitched(session.sessionId, event.data);
        break;
      case 'session_died':
        this.handleSessionDied(session.sessionId, event.data);
        break;
      default:
        break;
    }
  }

  private handleSessionUpdate(sessionId: string, data: unknown): void {
    const update = getSessionUpdate(data);
    if (!update) {
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
        const event: ToolCallEvent = {
          sessionId,
          toolCallId: getString(update['toolCallId']) ?? '',
          kind: getString(update['kind']) ?? '',
          title: getString(update['title']) ?? '',
          status: getString(update['status']) ?? 'pending',
          rawInput: isRecord(update['rawInput'])
            ? update['rawInput']
            : undefined,
        };
        this.emit('toolCall', event);
        break;
      }
      case 'available_commands_update': {
        if (Array.isArray(update['availableCommands'])) {
          this._availableCommands = update[
            'availableCommands'
          ] as AvailableCommand[];
        }
        break;
      }
      default:
        break;
    }

    this.emit('sessionUpdate', data);
  }

  private handlePermissionRequest(sessionId: string, data: unknown): void {
    if (!isRecord(data) || typeof data['requestId'] !== 'string') {
      return;
    }
    const requestId = data['requestId'];
    this.requestToSession.set(requestId, sessionId);
    this.emit('permissionRequest', {
      requestId,
      sessionId,
      request: data as unknown as RequestPermissionRequest,
    } satisfies DaemonPermissionRequestEvent);
  }

  private handlePermissionResolved(data: unknown): void {
    if (!isRecord(data) || typeof data['requestId'] !== 'string') {
      return;
    }
    const requestId = data['requestId'];
    this.requestToSession.delete(requestId);
    this.emit('permissionResolved', {
      requestId,
      outcome: data['outcome'],
    } satisfies DaemonPermissionResolvedEvent);
  }

  private handleModelSwitched(sessionId: string, data: unknown): void {
    if (!isRecord(data) || typeof data['modelId'] !== 'string') {
      return;
    }
    this.emit('modelSwitched', {
      sessionId,
      modelId: data['modelId'],
    });
  }

  private handleSessionDied(sessionId: string, data: unknown): void {
    const reason =
      isRecord(data) && typeof data['reason'] === 'string'
        ? data['reason']
        : 'session_died';
    this.eventControllers.get(sessionId)?.abort();
    this.eventControllers.delete(sessionId);
    this.sessions.delete(sessionId);
    this.emit('sessionDied', { sessionId, reason });
  }
}
