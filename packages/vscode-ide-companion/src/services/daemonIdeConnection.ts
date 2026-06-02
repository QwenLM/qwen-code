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
// This SDK is intentionally statically imported so the VSIX bundling path can
// include it; keep it pure JS with no native runtime dependency assumptions.
import {
  DaemonClient,
  DaemonSessionClient as SdkDaemonSessionClient,
} from '@qwen-code/sdk';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLoopbackHostname(hostname: string): boolean {
  // Keep this client-side policy aligned with
  // packages/cli/src/serve/loopbackBinds.ts when daemon bind rules change.
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackHostname(normalized.slice('::ffff:'.length));
  }
  const parts = normalized.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => {
      const value = Number(part);
      return /^\d+$/.test(part) && value >= 0 && value <= 255;
    })
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
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(
      `Daemon baseUrl must target a loopback address, got "${url.hostname}"`,
    );
  }
  return url.href;
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
    const daemon = new DaemonClient({
      baseUrl: validateDaemonBaseUrl(opts.baseUrl),
      token: opts.token,
    });
    const session = await SdkDaemonSessionClient.createOrAttach(daemon, {
      workspaceCwd: opts.workspaceCwd,
      modelServiceId: opts.modelServiceId,
    });
    if (opts.lastEventId !== undefined) {
      session.setLastEventId?.(opts.lastEventId);
    }
    return session;
  };
}

export class DaemonIdeConnection {
  private session: DaemonIdeSessionClient | null = null;
  private eventController: AbortController | null = null;
  private eventPump: Promise<void> | null = null;
  // Authoritative replay cursor for IDE processing. It may intentionally lag
  // behind the SDK cursor when permission responses fail, preserving replay.
  private lastSeenEventId: number | undefined;
  private connectPromise: Promise<void> | null = null;
  private pumpGeneration = 0;

  onSessionUpdate: (data: SessionNotification) => void = () => {};
  onPermissionRequest: (data: RequestPermissionRequest) => Promise<{
    optionId?: string;
  }> = () => Promise.resolve({ optionId: 'cancel' });
  onAskUserQuestion: (data: AskUserQuestionRequest) => Promise<{
    optionId: string;
    answers?: Record<string, string>;
  }> = () => Promise.resolve({ optionId: 'cancel' });
  onEndTurn: (reason?: string) => void = () => {};
  onDisconnected: (code: number | null, signal: string | null) => void =
    () => {};

  async connect(options: DaemonIdeConnectionOptions): Promise<void> {
    while (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch (previousError) {
        // Let this connect attempt proceed with its own options after the
        // in-flight attempt reports its failure to its caller.
        console.debug('[DaemonIdeConnection] Previous connect failed:', {
          error: toSafeErrorMessage(previousError),
        });
      }
    }

    const connectPromise = this.connectInternal(options);
    this.connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = null;
      }
    }
  }

  private async connectInternal(
    options: DaemonIdeConnectionOptions,
  ): Promise<void> {
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
    const generation = ++this.pumpGeneration;
    this.eventPump = this.pumpEvents(
      this.session,
      this.eventController.signal,
      generation,
    );
  }

  async sendPrompt(
    prompt: string | ContentBlock[],
  ): Promise<DaemonIdePromptResult> {
    const session = this.ensureSession();
    const promptBlocks = normalizePrompt(prompt);
    console.debug('[DaemonIdeConnection] Sending prompt:', {
      sessionId: session.sessionId,
    });
    try {
      const response = await session.prompt(
        { prompt: promptBlocks },
        this.eventController?.signal,
      );
      console.debug('[DaemonIdeConnection] Prompt completed:', {
        sessionId: session.sessionId,
        stopReason: response.stopReason,
      });
      this.onEndTurn(response.stopReason);
      return response;
    } catch (error) {
      console.warn('[DaemonIdeConnection] Prompt failed:', {
        sessionId: session.sessionId,
        error: toSafeErrorMessage(error),
      });
      if (!isAbortError(error)) {
        this.onEndTurn('error');
      }
      throw error;
    }
  }

  async cancelSession(): Promise<void> {
    const session = this.session;
    if (!session) {
      console.debug(
        '[DaemonIdeConnection] cancelSession ignored without active session',
      );
      return;
    }
    await session.cancel();
  }

  async setModel(modelId: string): Promise<DaemonIdeSetModelResult> {
    return await this.ensureSession().setModel(modelId);
  }

  async disconnect(): Promise<void> {
    const session = this.session;
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
    if (session && this.session === session) {
      this.session = null;
      this.onDisconnected(null, 'disconnected');
    }
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
    generation: number,
  ): Promise<void> {
    try {
      const resumeId = this.lastSeenEventId ?? session.lastEventId;
      for await (const event of session.events({
        signal,
        lastEventId: resumeId,
        resume: true,
      })) {
        let shouldAdvanceLastSeenEventId = true;
        try {
          shouldAdvanceLastSeenEventId = await this.handleEvent(event, signal);
        } catch (error) {
          console.warn('[DaemonIdeConnection] Event handler failed:', {
            sessionId: session.sessionId,
            eventType: event.type,
            eventId: event.id,
            error: toSafeErrorMessage(error),
          });
        } finally {
          if (shouldAdvanceLastSeenEventId && event.id !== undefined) {
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
        console.debug('[DaemonIdeConnection] Event stream session:', {
          sessionId: session.sessionId,
        });
        this.eventController?.abort();
        this.clearCurrentSession(session, 'daemon_error');
      }
    } finally {
      // A disconnect callback may synchronously reconnect before the old pump
      // reaches finally; only the active generation may clear eventPump.
      if (this.pumpGeneration === generation) {
        this.eventPump = null;
      }
    }
  }

  private async handleEvent(
    event: DaemonIdeEvent,
    signal: AbortSignal,
  ): Promise<boolean> {
    switch (event.type) {
      case 'session_update':
        this.onSessionUpdate(event.data as SessionNotification);
        return true;
      case 'permission_request':
        return await this.handlePermissionRequest(event.data, signal);
      case 'session_died':
        this.handleSessionDied(event.data);
        return true;
      default:
        console.debug('[DaemonIdeConnection] Ignoring daemon event:', {
          sessionId: this.session?.sessionId,
          eventType: event.type,
          eventId: event.id,
        });
        return true;
    }
  }

  private async handlePermissionRequest(
    data: unknown,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!isPermissionRequestData(data)) {
      console.warn('[DaemonIdeConnection] Malformed permission request data');
      return true;
    }

    const requestId = data['requestId'];
    const request = data;
    const session = this.session;
    if (!session) {
      console.warn(
        '[DaemonIdeConnection] Dropping permission request: not connected',
        { requestId },
      );
      return true;
    }
    const response = await this.resolvePermissionResponseUntilAbort(
      request,
      signal,
    );
    if (!response) {
      return true;
    }
    if (this.session !== session) {
      console.warn(
        '[DaemonIdeConnection] Permission response dropped: session changed',
        {
          requestId,
          originalSessionId: session.sessionId,
          currentSessionId: this.session?.sessionId,
        },
      );
      return true;
    }
    try {
      const accepted = await session.respondToPermission(requestId, response);
      if (!accepted) {
        console.warn(
          '[DaemonIdeConnection] Permission response rejected by daemon for request:',
          requestId,
        );
        console.debug('[DaemonIdeConnection] Permission response session:', {
          sessionId: session.sessionId,
        });
      }
      return true;
    } catch (error) {
      console.warn(
        '[DaemonIdeConnection] Permission response failed:',
        toSafeErrorMessage(error),
      );
      return false;
    }
  }

  private async resolvePermissionResponseUntilAbort(
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse | undefined> {
    if (signal.aborted) {
      return undefined;
    }

    const responsePromise = this.resolvePermissionResponse(request).catch(
      (error: unknown) => {
        console.warn(
          '[DaemonIdeConnection] Permission handler failed:',
          toSafeErrorMessage(error),
        );
        return {
          outcome: { outcome: 'cancelled' },
        } as RequestPermissionResponse;
      },
    );

    return await new Promise<RequestPermissionResponse | undefined>(
      (resolve) => {
        const onAbort = () => resolve(undefined);
        signal.addEventListener('abort', onAbort, { once: true });
        responsePromise.then((response) => {
          signal.removeEventListener('abort', onAbort);
          resolve(signal.aborted ? undefined : response);
        });
      },
    );
  }

  private async resolvePermissionResponse(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const rawInput = request.toolCall?.rawInput;
    const toolCallKind = request.toolCall?.kind as string | undefined;
    const isAskUserQuestion =
      toolCallKind === 'ask_user_question' &&
      isRecord(rawInput) &&
      Array.isArray(rawInput['questions']);

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
      const optionId = this.resolvePermissionOptionId(
        request,
        askResponse.optionId,
      );
      if (!optionId) {
        console.warn(
          '[DaemonIdeConnection] AskUserQuestion option not advertised; cancelling',
          {
            requestId: (request as { requestId?: string }).requestId,
            optionId: askResponse.optionId,
          },
        );
        return { outcome: { outcome: 'cancelled' } };
      }
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
    if (!response.optionId || this.isCancelledOption(response.optionId)) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const optionId = this.resolvePermissionOptionId(request, response.optionId);
    if (!optionId) {
      console.warn(
        '[DaemonIdeConnection] Permission option not advertised; cancelling',
        {
          requestId: (request as { requestId?: string }).requestId,
          optionId: response.optionId,
        },
      );
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
    const eventSessionId =
      isRecord(data) && typeof data['sessionId'] === 'string'
        ? data['sessionId']
        : undefined;
    if (!this.session) {
      console.debug(
        '[DaemonIdeConnection] session_died received with no active session',
        { eventSessionId },
      );
      return;
    }
    if (eventSessionId === undefined) {
      console.warn('[DaemonIdeConnection] Malformed session_died event');
      return;
    }
    if (eventSessionId !== this.session.sessionId) {
      return;
    }

    const reason =
      isRecord(data) && typeof data['reason'] === 'string'
        ? data['reason']
        : 'session_died';
    console.debug('[DaemonIdeConnection] Session died:', {
      sessionId: this.session.sessionId,
      reason,
    });
    this.eventController?.abort();
    this.clearCurrentSession(this.session, reason);
  }

  private isCancelledOption(optionId?: string): boolean {
    return (
      optionId === 'cancel' ||
      optionId === 'reject' ||
      (optionId !== undefined && optionId.startsWith('reject_'))
    );
  }

  private resolvePermissionOptionId(
    request: RequestPermissionRequest,
    preferredOptionId?: string,
  ): string | undefined {
    const options = Array.isArray(request.options) ? request.options : [];
    if (!preferredOptionId || options.length === 0) {
      return undefined;
    }

    return options.some((option) => option.optionId === preferredOptionId)
      ? preferredOptionId
      : undefined;
  }

  private clearCurrentSession(
    session: DaemonIdeSessionClient,
    reason: string,
  ): void {
    if (this.session !== session) {
      return;
    }
    console.debug('[DaemonIdeConnection] Clearing session:', {
      sessionId: session.sessionId,
      reason,
    });
    this.eventController = null;
    this.eventPump = null;
    this.session = null;
    this.onDisconnected(null, reason);
  }
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error['name'] === 'AbortError';
}
