/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon-backed IDE connection spike. It mirrors the ACP process connection
 * shape while replacing the local child process with a qwen serve session.
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

// Uses new Function to bypass esbuild static analysis so @qwen-code/sdk is
// loaded dynamically at runtime rather than bundled into the extension.
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

function validateDaemonBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Daemon baseUrl must use http or https scheme');
  }
  if (url.username || url.password) {
    throw new Error('Daemon baseUrl must not contain credentials');
  }
  return baseUrl;
}

function normalizePrompt(prompt: string | ContentBlock[]): ContentBlock[] {
  return typeof prompt === 'string'
    ? ([{ type: 'text', text: prompt }] as ContentBlock[])
    : prompt;
}

function toSafeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPermissionRequestData(
  value: unknown,
): value is RequestPermissionRequest & { requestId: string } {
  return (
    isRecord(value) &&
    typeof value['requestId'] === 'string' &&
    isRecord(value['toolCall']) &&
    Array.isArray(value['options'])
  );
}

export function createSdkDaemonSessionFactory(): DaemonIdeSessionFactory {
  return async (opts: DaemonIdeSessionFactoryOptions) => {
    const sdk = await dynamicImport('@qwen-code/sdk');
    if (!isSdkModule(sdk)) {
      throw new Error('Loaded @qwen-code/sdk does not expose daemon clients');
    }

    const daemon = new sdk.DaemonClient({
      baseUrl: validateDaemonBaseUrl(opts.baseUrl),
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
  }> = () => Promise.resolve({ optionId: 'cancel' });
  onAskUserQuestion: (data: AskUserQuestionRequest) => Promise<{
    optionId: string;
    answers?: Record<string, string>;
  }> = () => Promise.resolve({ optionId: 'cancel' });
  onEndTurn: (reason?: string) => void = () => {};
  onDisconnected: (code: number | null, signal: string | null) => void =
    () => {};

  async connect(options: DaemonIdeConnectionOptions): Promise<void> {
    if (this.session) {
      await this.disconnect();
    }

    const factory = options.sessionFactory ?? createSdkDaemonSessionFactory();
    this.session = await factory({
      baseUrl: validateDaemonBaseUrl(options.baseUrl),
      token: options.token,
      workspaceCwd: options.workspaceCwd,
      modelServiceId: options.modelServiceId,
      lastEventId: options.lastEventId,
    });
    this.lastSeenEventId = options.lastEventId ?? this.session.lastEventId;

    this.eventController = new AbortController();
    this.eventPump = this.pumpEvents(this.session, this.eventController.signal);
  }

  async sendPrompt(
    prompt: string | ContentBlock[],
  ): Promise<DaemonIdePromptResult> {
    const session = this.ensureSession();
    const promptBlocks = normalizePrompt(prompt);
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

  async disconnect(): Promise<void> {
    this.eventController?.abort();
    if (this.eventPump) {
      try {
        await this.eventPump;
      } catch {
        /* pump errors are converted into callbacks */
      }
    }
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
    return this.lastSeenEventId ?? this.session?.lastEventId;
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
      const resumeId = this.lastSeenEventId ?? session.lastEventId;
      for await (const event of session.events({
        signal,
        lastEventId: resumeId,
        resume: true,
      })) {
        try {
          await this.handleEvent(event);
        } catch (error) {
          console.warn('[DaemonIdeConnection] Event handler failed:', {
            eventType: event.type,
            eventId: event.id,
            error: toSafeErrorMessage(error),
          });
        } finally {
          if (event.id !== undefined) {
            this.lastSeenEventId = event.id;
          }
        }
      }
      if (!signal.aborted) {
        this.clearCurrentSession(session, 'stream_ended');
      }
    } catch (error) {
      if (!signal.aborted) {
        console.warn(
          '[DaemonIdeConnection] Event stream failed:',
          toSafeErrorMessage(error),
        );
        this.eventController?.abort();
        this.clearCurrentSession(session, 'daemon_error');
      }
    } finally {
      if (this.session === session) {
        this.eventPump = null;
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
    if (!isPermissionRequestData(data)) {
      return;
    }

    const requestId = data['requestId'];
    const request = data;
    const response = await this.resolvePermissionResponse(request);
    const accepted = await this.ensureSession().respondToPermission(
      requestId,
      response,
    );
    if (!accepted) {
      console.warn(
        '[DaemonIdeConnection] Permission response rejected by daemon for request:',
        requestId,
      );
    }
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
      if (
        !askResponse.optionId ||
        this.isCancelledOption(askResponse.optionId)
      ) {
        return { outcome: { outcome: 'cancelled' } };
      }
      const optionId =
        this.resolvePermissionOptionId(request, askResponse.optionId) ??
        askResponse.optionId;
      return {
        outcome: {
          outcome: 'selected',
          optionId,
        },
        // Daemon's HTTP permission route preserves top-level passthrough
        // fields and the ACP session consumes `answers` from this position.
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
    if (this.session) {
      this.clearCurrentSession(this.session, reason);
    } else {
      this.onDisconnected(null, reason);
    }
  }

  private isCancelledOption(optionId?: string): boolean {
    return (
      !optionId ||
      optionId === 'cancel' ||
      optionId === 'reject' ||
      optionId.startsWith('reject_')
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

    if (preferredOptionId) {
      return options.some((option) => option.optionId === preferredOptionId)
        ? preferredOptionId
        : undefined;
    }

    return (
      options.find((option) => option.kind === 'allow_once')?.optionId ||
      options.find((option) => option.optionId === 'proceed_once')?.optionId ||
      // Some ACP producers namespace standard option ids. Prefer an
      // explicit allow_once kind first, then tolerate namespaced proceed_once.
      options.find((option) => option.optionId.includes('proceed_once'))
        ?.optionId ||
      options[0]?.optionId
    );
  }

  private clearCurrentSession(
    session: DaemonIdeSessionClient,
    reason: string,
  ): void {
    if (this.session !== session) {
      return;
    }
    this.eventController = null;
    this.eventPump = null;
    this.session = null;
    this.onDisconnected(null, reason);
  }
}
