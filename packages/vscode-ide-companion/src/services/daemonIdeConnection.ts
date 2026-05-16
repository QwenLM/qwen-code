/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AskUserQuestionRequest } from '../types/acpTypes.js';

export interface DaemonIdeEvent {
  id?: number;
  v: 1;
  type: string;
  data: unknown;
  originatorClientId?: string;
}

export interface DaemonIdePromptResult {
  stopReason?: string;
  [key: string]: unknown;
}

export interface DaemonIdeSetModelResult {
  [key: string]: unknown;
}

export interface DaemonIdeSessionClient {
  readonly sessionId: string;
  readonly workspaceCwd: string;
  readonly lastEventId?: number;
  setLastEventId?(lastEventId: number | undefined): void;
  prompt(
    req: { prompt: ContentBlock[] },
    signal?: AbortSignal,
  ): Promise<DaemonIdePromptResult>;
  events(opts?: {
    signal?: AbortSignal;
    lastEventId?: number;
    resume?: boolean;
  }): AsyncGenerator<DaemonIdeEvent>;
  cancel(): Promise<void>;
  setModel(modelId: string): Promise<DaemonIdeSetModelResult>;
  respondToPermission(
    requestId: string,
    response: RequestPermissionResponse,
  ): Promise<boolean>;
}

export interface DaemonIdeSessionFactoryOptions {
  baseUrl: string;
  token?: string;
  workspaceCwd?: string;
  modelServiceId?: string;
  lastEventId?: number;
}

export type DaemonIdeSessionFactory = (
  opts: DaemonIdeSessionFactoryOptions,
) => Promise<DaemonIdeSessionClient>;

export interface DaemonIdeConnectionOptions
  extends DaemonIdeSessionFactoryOptions {
  sessionFactory?: DaemonIdeSessionFactory;
}

type SdkModule = {
  DaemonClient: new (opts: { baseUrl: string; token?: string }) => unknown;
  DaemonSessionClient: {
    createOrAttach(
      client: unknown,
      req?: {
        workspaceCwd?: string;
        modelServiceId?: string;
      },
    ): Promise<DaemonIdeSessionClient>;
  };
};

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSdkModule(value: unknown): value is SdkModule {
  if (!isRecord(value)) {
    return false;
  }

  const sessionClient = value['DaemonSessionClient'];
  return (
    typeof value['DaemonClient'] === 'function' &&
    isRecord(sessionClient) &&
    typeof sessionClient['createOrAttach'] === 'function'
  );
}

export function createSdkDaemonSessionFactory(): DaemonIdeSessionFactory {
  return async (opts: DaemonIdeSessionFactoryOptions) => {
    const sdk = await dynamicImport('@qwen-code/sdk');
    if (!isSdkModule(sdk)) {
      throw new Error('Loaded @qwen-code/sdk does not expose daemon clients');
    }

    const daemon = new sdk.DaemonClient({
      baseUrl: opts.baseUrl,
      token: opts.token,
    });
    const session = await sdk.DaemonSessionClient.createOrAttach(daemon, {
      workspaceCwd: opts.workspaceCwd,
      modelServiceId: opts.modelServiceId,
    });
    session.setLastEventId?.(opts.lastEventId);
    return session;
  };
}

export class DaemonIdeConnection {
  private session: DaemonIdeSessionClient | null = null;
  private eventController: AbortController | null = null;
  private eventPump: Promise<void> | null = null;
  private lastSeenEventId: number | undefined;

  onSessionUpdate: (data: SessionNotification) => void = () => {};
  onPermissionRequest: (data: RequestPermissionRequest) => Promise<{
    optionId: string;
  }> = (data) =>
    Promise.resolve({
      optionId: this.resolvePermissionOptionId(data) || '',
    });
  onAskUserQuestion: (data: AskUserQuestionRequest) => Promise<{
    optionId: string;
    answers?: Record<string, string>;
  }> = () => Promise.resolve({ optionId: 'cancel' });
  onEndTurn: (reason?: string) => void = () => {};
  onDisconnected: (code: number | null, signal: string | null) => void =
    () => {};

  async connect(options: DaemonIdeConnectionOptions): Promise<void> {
    if (this.session) {
      this.disconnect();
    }

    const factory = options.sessionFactory ?? createSdkDaemonSessionFactory();
    this.session = await factory({
      baseUrl: options.baseUrl,
      token: options.token,
      workspaceCwd: options.workspaceCwd,
      modelServiceId: options.modelServiceId,
      lastEventId: options.lastEventId,
    });
    this.lastSeenEventId = this.session.lastEventId ?? options.lastEventId;

    this.eventController = new AbortController();
    this.eventPump = this.pumpEvents(this.session, this.eventController.signal);
  }

  async sendPrompt(
    prompt: string | ContentBlock[],
  ): Promise<DaemonIdePromptResult> {
    const session = this.ensureSession();
    const promptBlocks =
      typeof prompt === 'string'
        ? ([{ type: 'text', text: prompt }] as ContentBlock[])
        : prompt;
    const response = await session.prompt({ prompt: promptBlocks });
    this.onEndTurn(response.stopReason);
    return response;
  }

  async cancelSession(): Promise<void> {
    const session = this.session;
    if (!session) {
      return;
    }
    await session.cancel();
  }

  async setModel(modelId: string): Promise<DaemonIdeSetModelResult> {
    return await this.ensureSession().setModel(modelId);
  }

  disconnect(): void {
    this.eventController?.abort();
    this.eventController = null;
    this.eventPump = null;
    this.session = null;
  }

  get isConnected(): boolean {
    return this.session !== null;
  }

  get hasActiveSession(): boolean {
    return this.session !== null;
  }

  get currentSessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  get lastEventId(): number | undefined {
    return this.session?.lastEventId ?? this.lastSeenEventId;
  }

  private ensureSession(): DaemonIdeSessionClient {
    if (!this.session) {
      throw new Error('Not connected to daemon session');
    }
    return this.session;
  }

  private async pumpEvents(
    session: DaemonIdeSessionClient,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for await (const event of session.events({ signal })) {
        if (event.id !== undefined) {
          this.lastSeenEventId = event.id;
        }
        await this.handleEvent(event);
      }
    } catch (error) {
      if (!signal.aborted) {
        console.warn('[DaemonIdeConnection] Event stream failed:', error);
        this.session = null;
        this.onDisconnected(null, 'daemon_error');
      }
    }
  }

  private async handleEvent(event: DaemonIdeEvent): Promise<void> {
    switch (event.type) {
      case 'session_update':
        this.onSessionUpdate(event.data as SessionNotification);
        break;
      case 'permission_request':
        await this.handlePermissionRequest(event.data);
        break;
      case 'session_died':
        this.handleSessionDied(event.data);
        break;
      default:
        break;
    }
  }

  private async handlePermissionRequest(data: unknown): Promise<void> {
    if (!isRecord(data) || typeof data['requestId'] !== 'string') {
      return;
    }

    const requestId = data['requestId'];
    const request = data as unknown as RequestPermissionRequest;
    const response = await this.resolvePermissionResponse(request);
    await this.ensureSession().respondToPermission(requestId, response);
  }

  private async resolvePermissionResponse(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const rawInput = request.toolCall?.rawInput;
    const isAskUserQuestion =
      isRecord(rawInput) && Array.isArray(rawInput['questions']);

    if (isAskUserQuestion) {
      const askResponse = await this.onAskUserQuestion({
        sessionId: request.sessionId,
        questions: rawInput['questions'] as AskUserQuestionRequest['questions'],
        metadata: rawInput['metadata'] as AskUserQuestionRequest['metadata'],
      });
      if (this.isCancelledOption(askResponse.optionId)) {
        return { outcome: { outcome: 'cancelled' } };
      }
      return {
        outcome: {
          outcome: 'selected',
          optionId: askResponse.optionId || 'proceed_once',
        },
        answers: askResponse.answers,
      } as RequestPermissionResponse;
    }

    const response = await this.onPermissionRequest(request);
    if (this.isCancelledOption(response.optionId)) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const optionId = this.resolvePermissionOptionId(request, response.optionId);
    if (!optionId) {
      return { outcome: { outcome: 'cancelled' } };
    }

    return {
      outcome: {
        outcome: 'selected',
        optionId,
      },
    };
  }

  private handleSessionDied(data: unknown): void {
    const reason =
      isRecord(data) && typeof data['reason'] === 'string'
        ? data['reason']
        : 'session_died';
    this.eventController?.abort();
    this.eventController = null;
    this.eventPump = null;
    this.session = null;
    this.onDisconnected(null, reason);
  }

  private isCancelledOption(optionId?: string): boolean {
    return Boolean(
      optionId && (optionId.includes('reject') || optionId === 'cancel'),
    );
  }

  private resolvePermissionOptionId(
    request: RequestPermissionRequest,
    preferredOptionId?: string,
  ): string | undefined {
    const options = Array.isArray(request.options) ? request.options : [];
    if (options.length === 0) {
      return undefined;
    }

    if (
      preferredOptionId &&
      options.some((option) => option.optionId === preferredOptionId)
    ) {
      return preferredOptionId;
    }

    return (
      options.find((option) => option.kind === 'allow_once')?.optionId ||
      options.find((option) => option.optionId === 'proceed_once')?.optionId ||
      options.find((option) => option.optionId.includes('proceed_once'))
        ?.optionId ||
      options[0]?.optionId
    );
  }
}
