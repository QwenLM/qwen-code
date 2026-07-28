/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { SocketLike } from '../../ui/voice/voice-stream-session.js';
import { deriveWebSocketBase } from '../../ui/voice/voice-stream-session.js';
import { escapeAnsiCtrlCodes } from '../../ui/utils/textUtils.js';

export type RealtimeCallEpoch = string | number;

export const QWEN_REALTIME_INPUT_SAMPLE_RATE = 16_000;
export const QWEN_REALTIME_OUTPUT_SAMPLE_RATE = 24_000;

export const QWEN_REALTIME_LIMITS = {
  maxInputAudioFrameBytes: 64 * 1024,
  maxOutputAudioFrameBytes: 256 * 1024,
  maxBufferedSocketBytes: 1024 * 1024,
  maxIncomingMessageBytes: 1024 * 1024,
  maxTranscriptChars: 256 * 1024,
  maxTextDeltaChars: 64 * 1024,
  maxFunctionArgumentsChars: 32 * 1024,
  maxFunctionOutputChars: 64 * 1024,
  maxPendingFunctionCalls: 8,
  maxPendingCoordinatorUpdates: 8,
  maxIdentifierChars: 256,
  maxRateLimitEntries: 16,
} as const;

const CONNECT_TIMEOUT_MS = 8000;
const MAX_ERROR_MESSAGE_CHARS = 300;
const MAX_RECENT_EVENT_IDS = 512;
const MAX_TRACKED_INPUT_ITEMS = 32;
const DELEGATE_TOOL_NAME = 'delegate_to_coordinator';
const NEW_CONVERSATION_TOOL_NAME = 'start_new_live_conversation';
const COORDINATOR_UPDATE_PREFIX = '[QWEN_CODE_COORDINATOR_UPDATE]\n';

const DEFAULT_INSTRUCTIONS =
  'You are the realtime voice frontend for Qwen Code. When the user explicitly asks to start, reset, or switch to a new Live conversation, call start_new_live_conversation exactly once and do not call delegate_to_coordinator. For every other meaningful user request, call delegate_to_coordinator exactly once. Do not answer from your own knowledge before the tool returns. After the tool result arrives, give a concise, natural spoken answer that preserves the authoritative result. A message prefixed [QWEN_CODE_COORDINATOR_UPDATE] is a trusted asynchronous result: speak it concisely without calling any tool.';

export interface QwenRealtimeConfig {
  endpoint: string;
  apiKey?: string;
  model: string;
  callEpoch: RealtimeCallEpoch;
  voice?: string;
  instructions?: string;
}

export interface QwenRealtimeDeps {
  createWebSocket?: (
    url: string,
    options: {
      headers: Record<string, string>;
      maxPayload: number;
      perMessageDeflate: false;
      handshakeTimeout: number;
    },
  ) => SocketLike;
  abortSignal?: AbortSignal;
  connectTimeoutMs?: number;
}

export interface RealtimeEventContext {
  callEpoch: RealtimeCallEpoch;
  eventId?: string;
}

export interface RealtimeSpeechEvent extends RealtimeEventContext {
  itemId?: string;
  audioStartMs?: number;
  audioEndMs?: number;
}

export interface RealtimeInputTranscriptEvent extends RealtimeEventContext {
  itemId?: string;
  text: string;
  stash?: string;
  language?: string;
  emotion?: string;
}

export interface RealtimeResponseEvent extends RealtimeEventContext {
  responseId: string;
  status?: string;
}

export interface RealtimeOutputTextEvent extends RealtimeResponseEvent {
  itemId?: string;
  text: string;
  source: 'text' | 'audio_transcript';
}

export interface RealtimeOutputAudioEvent extends RealtimeResponseEvent {
  itemId?: string;
  audio: Uint8Array;
}

export interface RealtimeFunctionArgumentsEvent extends RealtimeResponseEvent {
  itemId?: string;
  callId: string;
  delta: string;
}

export interface RealtimeDelegateCall extends RealtimeResponseEvent {
  itemId?: string;
  callId: string;
  request: string;
  recentTranscript?: string;
}

export interface RealtimeNewConversationRequest extends RealtimeResponseEvent {
  itemId?: string;
  callId: string;
}

export interface RealtimeRateLimit {
  name: string;
  limit?: number;
  remaining?: number;
  resetSeconds?: number;
}

export interface RealtimeRateLimitEvent extends RealtimeEventContext {
  limits: RealtimeRateLimit[];
}

export interface RealtimeIgnoredEvent extends RealtimeEventContext {
  type: string;
  reason:
    | 'duplicate_event'
    | 'stale_response'
    | 'stale_input'
    | 'stale_call'
    | 'cancelled_response';
}

export interface RealtimeCloseInfo {
  reason: 'client' | 'remote' | 'error';
  error?: QwenRealtimeError;
}

export interface QwenRealtimeCallbacks {
  onReady?: (event: RealtimeEventContext & { sessionId?: string }) => void;
  onSpeechStarted?: (event: RealtimeSpeechEvent) => void;
  onSpeechStopped?: (event: RealtimeSpeechEvent) => void;
  onInputCommitted?: (event: RealtimeSpeechEvent) => void;
  onInputTranscriptDelta?: (event: RealtimeInputTranscriptEvent) => void;
  onInputTranscriptDone?: (event: RealtimeInputTranscriptEvent) => void;
  onOutputTextDelta?: (event: RealtimeOutputTextEvent) => void;
  onOutputTextDone?: (event: RealtimeOutputTextEvent) => void;
  onOutputAudioDelta?: (event: RealtimeOutputAudioEvent) => void;
  onOutputAudioDone?: (
    event: RealtimeResponseEvent & { itemId?: string },
  ) => void;
  onFunctionArgumentsDelta?: (event: RealtimeFunctionArgumentsEvent) => void;
  onDelegateCall?: (event: RealtimeDelegateCall) => void;
  onNewConversationRequest?: (event: RealtimeNewConversationRequest) => void;
  onResponseCreated?: (event: RealtimeResponseEvent) => void;
  onResponseDone?: (event: RealtimeResponseEvent) => void;
  onBargeIn?: (event: RealtimeResponseEvent) => void;
  onRateLimit?: (event: RealtimeRateLimitEvent) => void;
  onIgnoredEvent?: (event: RealtimeIgnoredEvent) => void;
  onAudioDropped?: (event: RealtimeEventContext) => void;
  onError?: (error: QwenRealtimeError) => void;
  onClose?: (info: RealtimeCloseInfo) => void;
}

export interface RealtimeFunctionCallOutput {
  callEpoch: RealtimeCallEpoch;
  callId: string;
  output: string;
}

export interface QwenRealtimeSession {
  readonly callEpoch: RealtimeCallEpoch;
  readonly closed: Promise<RealtimeCloseInfo>;
  pushAudio: (pcm16: Uint8Array) => boolean;
  commitInputAudio: () => boolean;
  clearInputAudio: () => boolean;
  cancelResponse: () => boolean;
  submitFunctionCallOutput: (result: RealtimeFunctionCallOutput) => boolean;
  sendCoordinatorUpdate: (text: string) => boolean;
  close: () => void;
}

export class QwenRealtimeError extends Error {
  readonly code?: string;
  readonly fatal: boolean;

  constructor(message: string, code?: string, fatal = true) {
    super(message);
    this.name = 'QwenRealtimeError';
    this.code = code;
    this.fatal = fatal;
  }
}

interface PendingFunctionCall {
  responseId: string;
  itemId?: string;
  callId: string;
  name?: string;
  arguments: string;
  dispatched: boolean;
  outputSubmitted: boolean;
  origin: 'provider' | 'transcript_fallback';
}

type ResponseAuthority =
  | 'untrusted_input'
  | 'delegate_result'
  | 'coordinator_update';

interface ProviderMessage extends Record<string, unknown> {
  type?: unknown;
  event_id?: unknown;
}

export function deriveQwenOmniRealtimeUrl(
  endpoint: string,
  model: string,
): string {
  const parsed = new URL(endpoint);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error('Realtime endpoint must use HTTP or WebSocket.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Realtime endpoint must not contain credentials.');
  }
  for (const name of parsed.searchParams.keys()) {
    if (/api.?key|authorization|token/i.test(name)) {
      throw new Error('Realtime endpoint must not contain credentials.');
    }
  }

  let url: URL;
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    const base = deriveWebSocketBase(parsed.toString());
    url = new URL(
      parsed.pathname.replace(/\/+$/, '').endsWith('/api-ws/v1/realtime')
        ? base
        : `${base}/api-ws/v1/realtime`,
    );
    for (const [name, value] of parsed.searchParams) {
      url.searchParams.append(name, value);
    }
  } else {
    url = parsed;
    if (!url.pathname.replace(/\/+$/, '').endsWith('/api-ws/v1/realtime')) {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/api-ws/v1/realtime`;
    }
  }
  url.searchParams.set('model', model);
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(
  value: unknown,
  maxChars: number = QWEN_REALTIME_LIMITS.maxIdentifierChars,
): string | undefined {
  return typeof value === 'string' && value.length <= maxChars
    ? value
    : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function sanitizeErrorText(raw: unknown, apiKey?: string): string {
  let text =
    typeof raw === 'string'
      ? raw
      : raw instanceof Uint8Array
        ? Buffer.from(raw).toString('utf8')
        : 'Qwen Realtime request failed.';
  if (apiKey) text = text.split(apiKey).join('[REDACTED]');
  return escapeAnsiCtrlCodes(text).slice(0, MAX_ERROR_MESSAGE_CHARS);
}

function isRateLimitCode(code: string | undefined, message: string): boolean {
  return (
    code === '429' ||
    code?.toLowerCase().includes('rate_limit') === true ||
    /\brate[ _-]?limit\b|\b429\b/i.test(message)
  );
}

function parseRateLimits(value: unknown): RealtimeRateLimit[] {
  if (!Array.isArray(value)) return [];
  const parsed: RealtimeRateLimit[] = [];
  for (const entry of value.slice(
    0,
    QWEN_REALTIME_LIMITS.maxRateLimitEntries,
  )) {
    if (!isRecord(entry)) continue;
    const name = optionalString(entry['name']);
    if (!name) continue;
    parsed.push({
      name,
      limit: optionalFiniteNumber(entry['limit']),
      remaining: optionalFiniteNumber(entry['remaining']),
      resetSeconds: optionalFiniteNumber(
        entry['reset_seconds'] ?? entry['resetSeconds'],
      ),
    });
  }
  return parsed;
}

function parseAudioDelta(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const maxBase64Chars =
    Math.ceil(QWEN_REALTIME_LIMITS.maxOutputAudioFrameBytes / 3) * 4 + 4;
  if (value.length > maxBase64Chars || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.length === 0 ||
    decoded.length % 2 !== 0 ||
    decoded.length > QWEN_REALTIME_LIMITS.maxOutputAudioFrameBytes
  ) {
    return undefined;
  }
  return new Uint8Array(decoded);
}

function parseDelegateArguments(raw: string): {
  request: string;
  recentTranscript?: string;
} {
  if (raw.length > QWEN_REALTIME_LIMITS.maxFunctionArgumentsChars) {
    throw new QwenRealtimeError(
      'Realtime function arguments exceeded the allowed size.',
      'function_arguments_too_large',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new QwenRealtimeError(
      'Realtime function arguments were not valid JSON.',
      'invalid_function_arguments',
    );
  }
  if (!isRecord(value)) {
    throw new QwenRealtimeError(
      'Realtime function arguments must be an object.',
      'invalid_function_arguments',
    );
  }
  const request = value['request'];
  const recentTranscript = value['recent_transcript'];
  if (
    typeof request !== 'string' ||
    request.trim().length === 0 ||
    request.length > QWEN_REALTIME_LIMITS.maxTranscriptChars
  ) {
    throw new QwenRealtimeError(
      'Realtime delegation requires a bounded request.',
      'invalid_function_arguments',
    );
  }
  if (
    recentTranscript !== undefined &&
    (typeof recentTranscript !== 'string' ||
      recentTranscript.length > QWEN_REALTIME_LIMITS.maxTranscriptChars)
  ) {
    throw new QwenRealtimeError(
      'Realtime delegation included an invalid recent transcript.',
      'invalid_function_arguments',
    );
  }
  return {
    request,
    ...(typeof recentTranscript === 'string' ? { recentTranscript } : {}),
  };
}

export function openQwenRealtimeSession(
  config: QwenRealtimeConfig,
  callbacks: QwenRealtimeCallbacks = {},
  deps: QwenRealtimeDeps = {},
): Promise<QwenRealtimeSession> {
  const connectTimeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const createWebSocket =
    deps.createWebSocket ??
    ((url, options) =>
      new WebSocket(url, {
        headers: options.headers,
        maxPayload: options.maxPayload,
        perMessageDeflate: options.perMessageDeflate,
        handshakeTimeout: options.handshakeTimeout,
      }) as unknown as SocketLike);

  return new Promise<QwenRealtimeSession>((resolve, reject) => {
    if (deps.abortSignal?.aborted) {
      reject(new QwenRealtimeError('Realtime connection was aborted.'));
      return;
    }

    let ws: SocketLike;
    try {
      ws = createWebSocket(
        deriveQwenOmniRealtimeUrl(config.endpoint, config.model),
        {
          headers: config.apiKey
            ? { Authorization: `Bearer ${config.apiKey}` }
            : {},
          maxPayload: QWEN_REALTIME_LIMITS.maxIncomingMessageBytes,
          perMessageDeflate: false,
          handshakeTimeout: connectTimeoutMs,
        },
      );
    } catch (error) {
      reject(
        new QwenRealtimeError(
          sanitizeErrorText(
            error instanceof Error ? error.message : error,
            config.apiKey,
          ),
          'connection_failed',
        ),
      );
      return;
    }

    let ready = false;
    let settled = false;
    let terminal = false;
    let closedByClient = false;
    let sessionUpdateSent = false;
    let activeResponseId: string | undefined;
    let activeAudioResponseId: string | undefined;
    let responseCreatePending = false;
    let pendingResponseAuthority:
      | Exclude<ResponseAuthority, 'untrusted_input'>
      | undefined;
    let activeResponseAuthority: ResponseAuthority | undefined;
    let activeApprovedCallId: string | undefined;
    let activeApprovedToolName: string | undefined;
    let latestInputItemId: string | undefined;
    let backpressureWarned = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const cancelledResponseIds = new Set<string>();
    const recentEventIds = new Set<string>();
    const pendingCalls = new Map<string, PendingFunctionCall>();
    const pendingFollowupResponses = new Set<string>();
    const pendingCoordinatorUpdates: string[] = [];
    const completedInputTranscripts = new Map<string, string>();
    const responseInputItemIds = new Map<string, string>();
    const consumedInputItemIds = new Set<string>();
    const fallbackDelegatedResponseIds = new Set<string>();
    let resolveClosed: (info: RealtimeCloseInfo) => void = () => undefined;
    const closed = new Promise<RealtimeCloseInfo>((res) => {
      resolveClosed = res;
    });
    let closedSettled = false;

    const callback = (fn: (() => void) | undefined): boolean => {
      if (!fn) return true;
      try {
        fn();
        return true;
      } catch (error) {
        fail(
          new QwenRealtimeError(
            sanitizeErrorText(
              error instanceof Error ? error.message : error,
              config.apiKey,
            ),
            'callback_failed',
          ),
        );
        return false;
      }
    };

    const settleClosed = (info: RealtimeCloseInfo) => {
      if (closedSettled) return;
      closedSettled = true;
      resolveClosed(info);
      try {
        callbacks.onClose?.(info);
      } catch {
        /* ignore observer failures after shutdown */
      }
    };

    const clearConnectTimer = () => {
      if (!connectTimer) return;
      clearTimeout(connectTimer);
      connectTimer = undefined;
    };

    const removeAbortListener = () => {
      if (!abortListener) return;
      deps.abortSignal?.removeEventListener('abort', abortListener);
      abortListener = undefined;
    };

    const closeSocket = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };

    const notifyError = (error: QwenRealtimeError) => {
      try {
        callbacks.onError?.(error);
      } catch {
        /* ignore error observer failures */
      }
    };

    function fail(error: QwenRealtimeError): void {
      if (terminal) return;
      terminal = true;
      clearConnectTimer();
      removeAbortListener();
      closeSocket();
      if (!settled) {
        settled = true;
        reject(error);
      } else {
        notifyError(error);
      }
      settleClosed({ reason: 'error', error });
    }

    const protocolError = (message: string, code: string) => {
      fail(new QwenRealtimeError(message, code));
    };

    const sendJson = (body: Record<string, unknown>): boolean => {
      if (terminal || closedByClient || ws.readyState !== ws.OPEN) return false;
      try {
        ws.send(JSON.stringify({ event_id: randomUUID(), ...body }));
        return true;
      } catch (error) {
        fail(
          new QwenRealtimeError(
            sanitizeErrorText(
              error instanceof Error ? error.message : error,
              config.apiKey,
            ),
            'send_failed',
          ),
        );
        return false;
      }
    };

    const sendResponseCreate = (
      authority: Exclude<ResponseAuthority, 'untrusted_input'>,
    ): boolean => {
      if (responseCreatePending || activeResponseId) return false;
      const sent = sendJson({ type: 'response.create' });
      if (sent) {
        responseCreatePending = true;
        pendingResponseAuthority = authority;
      }
      return sent;
    };

    const sendCoordinatorUpdateNow = (text: string): boolean => {
      if (
        !sendJson({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `${COORDINATOR_UPDATE_PREFIX}${text}`,
              },
            ],
          },
        })
      ) {
        return false;
      }
      return sendResponseCreate('coordinator_update');
    };

    const deletePendingCallsForResponse = (responseId: string): void => {
      for (const [callId, call] of pendingCalls) {
        if (call.responseId === responseId) pendingCalls.delete(callId);
      }
    };

    const finishPendingCallsForResponse = (responseId: string): void => {
      for (const [callId, call] of pendingCalls) {
        if (call.responseId !== responseId) continue;
        if (
          call.origin === 'provider' &&
          call.name === DELEGATE_TOOL_NAME &&
          call.dispatched &&
          !call.outputSubmitted
        ) {
          continue;
        }
        pendingCalls.delete(callId);
      }
    };

    const rememberCompletedInputTranscript = (
      itemId: string,
      transcript: string,
    ): void => {
      if (consumedInputItemIds.has(itemId)) return;
      completedInputTranscripts.delete(itemId);
      completedInputTranscripts.set(itemId, transcript);
      while (completedInputTranscripts.size > MAX_TRACKED_INPUT_ITEMS) {
        const oldest = completedInputTranscripts.keys().next().value;
        if (typeof oldest !== 'string') break;
        completedInputTranscripts.delete(oldest);
      }
    };

    const consumeInputItem = (itemId: string): void => {
      completedInputTranscripts.delete(itemId);
      consumedInputItemIds.add(itemId);
      while (consumedInputItemIds.size > MAX_TRACKED_INPUT_ITEMS) {
        const oldest = consumedInputItemIds.values().next().value;
        if (typeof oldest !== 'string') break;
        consumedInputItemIds.delete(oldest);
      }
    };

    const consumeResponseInput = (responseId: string): string | undefined => {
      const itemId = responseInputItemIds.get(responseId);
      responseInputItemIds.delete(responseId);
      if (itemId) consumeInputItem(itemId);
      return itemId;
    };

    const flushCoordinatorUpdate = (): void => {
      if (activeResponseId || responseCreatePending) return;
      const next = pendingCoordinatorUpdates.shift();
      if (next !== undefined && !sendCoordinatorUpdateNow(next)) {
        pendingCoordinatorUpdates.unshift(next);
      }
    };

    const eventContext = (message: ProviderMessage): RealtimeEventContext => ({
      callEpoch: config.callEpoch,
      eventId: optionalString(message.event_id),
    });

    const ignoreEvent = (
      message: ProviderMessage,
      type: string,
      reason: RealtimeIgnoredEvent['reason'],
    ) => {
      callback(() =>
        callbacks.onIgnoredEvent?.({
          ...eventContext(message),
          type,
          reason,
        }),
      );
    };

    const readResponseId = (
      message: ProviderMessage,
      fromResponseObject = false,
    ): string | undefined => {
      const response = isRecord(message['response'])
        ? message['response']
        : undefined;
      return optionalString(
        fromResponseObject ? response?.['id'] : message['response_id'],
      );
    };

    const isCurrentResponse = (
      message: ProviderMessage,
      type: string,
      responseId: string,
    ): boolean => {
      if (cancelledResponseIds.has(responseId)) {
        ignoreEvent(message, type, 'cancelled_response');
        return false;
      }
      if (activeResponseId !== responseId) {
        ignoreEvent(message, type, 'stale_response');
        return false;
      }
      return true;
    };

    const dispatchTranscriptFallback = (
      message: ProviderMessage,
      responseId: string,
    ): boolean => {
      if (
        !callbacks.onDelegateCall ||
        fallbackDelegatedResponseIds.has(responseId) ||
        pendingCalls.size >= QWEN_REALTIME_LIMITS.maxPendingFunctionCalls
      ) {
        return false;
      }
      const itemId = responseInputItemIds.get(responseId);
      const transcript = itemId
        ? completedInputTranscripts.get(itemId)?.trim()
        : undefined;
      if (!itemId || !transcript || consumedInputItemIds.has(itemId)) {
        return false;
      }
      const request = transcript.slice(
        0,
        QWEN_REALTIME_LIMITS.maxFunctionArgumentsChars,
      );
      const callId = `transcript-fallback:${randomUUID()}`;
      fallbackDelegatedResponseIds.add(responseId);
      while (fallbackDelegatedResponseIds.size > MAX_TRACKED_INPUT_ITEMS) {
        const oldest = fallbackDelegatedResponseIds.values().next().value;
        if (typeof oldest !== 'string') break;
        fallbackDelegatedResponseIds.delete(oldest);
      }
      consumeResponseInput(responseId);
      pendingCalls.set(callId, {
        responseId,
        itemId,
        callId,
        name: DELEGATE_TOOL_NAME,
        arguments: '',
        dispatched: true,
        outputSubmitted: false,
        origin: 'transcript_fallback',
      });
      return callback(() =>
        callbacks.onDelegateCall?.({
          ...eventContext(message),
          responseId,
          itemId,
          callId,
          request,
        }),
      );
    };

    const dispatchFunctionCall = (
      message: ProviderMessage,
      call: PendingFunctionCall,
      rawArguments: string,
    ) => {
      if (call.dispatched) return;
      if (activeResponseAuthority !== 'untrusted_input') {
        protocolError(
          'Realtime model requested a tool from an authorized spoken response.',
          'unexpected_tool_call',
        );
        return;
      }
      if (
        activeApprovedCallId !== undefined &&
        activeApprovedCallId !== call.callId
      ) {
        protocolError(
          'Realtime model requested multiple approved tools in one response.',
          'multiple_approved_tools',
        );
        return;
      }
      if (call.name === NEW_CONVERSATION_TOOL_NAME) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawArguments);
        } catch {
          protocolError(
            'Realtime new-conversation arguments were not valid JSON.',
            'invalid_function_arguments',
          );
          return;
        }
        if (!isRecord(parsed) || Object.keys(parsed).length > 0) {
          protocolError(
            'Realtime new-conversation request must not include arguments.',
            'invalid_function_arguments',
          );
          return;
        }
        call.arguments = rawArguments;
        call.dispatched = true;
        activeApprovedCallId = call.callId;
        activeApprovedToolName = NEW_CONVERSATION_TOOL_NAME;
        callback(() =>
          callbacks.onNewConversationRequest?.({
            ...eventContext(message),
            responseId: call.responseId,
            itemId: call.itemId,
            callId: call.callId,
          }),
        );
        return;
      }
      if (call.name !== DELEGATE_TOOL_NAME) {
        protocolError(
          'Realtime model requested an unsupported tool.',
          'unsupported_tool',
        );
        return;
      }
      let parsed: ReturnType<typeof parseDelegateArguments>;
      try {
        parsed = parseDelegateArguments(rawArguments);
      } catch (error) {
        fail(
          error instanceof QwenRealtimeError
            ? error
            : new QwenRealtimeError(
                'Realtime function arguments were invalid.',
                'invalid_function_arguments',
              ),
        );
        return;
      }
      call.arguments = rawArguments;
      call.dispatched = true;
      activeApprovedCallId = call.callId;
      activeApprovedToolName = DELEGATE_TOOL_NAME;
      callback(() =>
        callbacks.onDelegateCall?.({
          ...eventContext(message),
          responseId: call.responseId,
          itemId: call.itemId,
          callId: call.callId,
          request: parsed.request,
          recentTranscript: parsed.recentTranscript,
        }),
      );
    };

    const session: QwenRealtimeSession = {
      callEpoch: config.callEpoch,
      closed,
      pushAudio: (pcm16) => {
        if (pcm16.length === 0) return false;
        if (
          pcm16.length % 2 !== 0 ||
          pcm16.length > QWEN_REALTIME_LIMITS.maxInputAudioFrameBytes
        ) {
          throw new RangeError(
            'Realtime input must be a bounded PCM16 audio frame.',
          );
        }
        if (
          terminal ||
          closedByClient ||
          ws.readyState !== ws.OPEN ||
          (ws.bufferedAmount ?? 0) > QWEN_REALTIME_LIMITS.maxBufferedSocketBytes
        ) {
          if (!backpressureWarned) {
            backpressureWarned = true;
            callback(() =>
              callbacks.onAudioDropped?.({ callEpoch: config.callEpoch }),
            );
          }
          return false;
        }
        backpressureWarned = false;
        return sendJson({
          type: 'input_audio_buffer.append',
          audio: Buffer.from(pcm16).toString('base64'),
        });
      },
      commitInputAudio: () => sendJson({ type: 'input_audio_buffer.commit' }),
      clearInputAudio: () => sendJson({ type: 'input_audio_buffer.clear' }),
      cancelResponse: () => {
        if (!activeResponseId || cancelledResponseIds.has(activeResponseId)) {
          return false;
        }
        const responseId = activeResponseId;
        cancelledResponseIds.add(responseId);
        for (const [callId, call] of pendingCalls) {
          if (call.responseId === responseId) pendingCalls.delete(callId);
        }
        activeAudioResponseId = undefined;
        if (cancelledResponseIds.size > 16) {
          const oldest = cancelledResponseIds.values().next().value;
          if (typeof oldest === 'string') cancelledResponseIds.delete(oldest);
        }
        return sendJson({ type: 'response.cancel' });
      },
      submitFunctionCallOutput: (result) => {
        const call = pendingCalls.get(result.callId);
        if (
          result.callEpoch !== config.callEpoch ||
          !call ||
          !call.dispatched ||
          call.outputSubmitted ||
          terminal ||
          closedByClient
        ) {
          callback(() =>
            callbacks.onIgnoredEvent?.({
              callEpoch: config.callEpoch,
              type: 'conversation.item.create',
              reason: 'stale_call',
            }),
          );
          return false;
        }
        if (call.name !== DELEGATE_TOOL_NAME) {
          callback(() =>
            callbacks.onIgnoredEvent?.({
              callEpoch: config.callEpoch,
              type: 'conversation.item.create',
              reason: 'stale_call',
            }),
          );
          return false;
        }
        if (
          typeof result.output !== 'string' ||
          result.output.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars
        ) {
          throw new RangeError(
            'Realtime function output exceeded the allowed size.',
          );
        }
        if (call.origin === 'transcript_fallback') {
          call.outputSubmitted = true;
          pendingCalls.delete(call.callId);
          if (!result.output || result.output.trim().length === 0) {
            return false;
          }
          return session.sendCoordinatorUpdate(result.output);
        }
        if (activeResponseId && activeResponseId !== call.responseId) {
          pendingCalls.delete(result.callId);
          callback(() =>
            callbacks.onIgnoredEvent?.({
              callEpoch: config.callEpoch,
              type: 'conversation.item.create',
              reason: 'stale_call',
            }),
          );
          return false;
        }
        if (
          !sendJson({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: call.callId,
              output: result.output,
            },
          })
        ) {
          return false;
        }
        call.outputSubmitted = true;
        if (activeResponseId === call.responseId) {
          pendingFollowupResponses.add(call.responseId);
          return true;
        }
        pendingCalls.delete(call.callId);
        return sendResponseCreate('delegate_result');
      },
      sendCoordinatorUpdate: (text) => {
        if (
          typeof text !== 'string' ||
          text.trim().length === 0 ||
          text.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars
        ) {
          throw new RangeError(
            'Realtime coordinator update exceeded the allowed size.',
          );
        }
        if (terminal || closedByClient) return false;
        if (activeResponseId || responseCreatePending) {
          if (
            pendingCoordinatorUpdates.length >=
            QWEN_REALTIME_LIMITS.maxPendingCoordinatorUpdates
          ) {
            return false;
          }
          pendingCoordinatorUpdates.push(text);
          return true;
        }
        return sendCoordinatorUpdateNow(text);
      },
      close: () => {
        if (closedByClient || terminal) return;
        closedByClient = true;
        clearConnectTimer();
        removeAbortListener();
        closeSocket();
        settleClosed({ reason: 'client' });
      },
    };

    const sendSessionUpdate = () => {
      if (sessionUpdateSent) return;
      sessionUpdateSent = true;
      sendJson({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          ...(config.voice ? { voice: config.voice } : {}),
          input_audio_format: 'pcm',
          output_audio_format: 'pcm',
          input_audio_transcription: {
            model: 'qwen3-asr-flash-realtime',
          },
          instructions: config.instructions ?? DEFAULT_INSTRUCTIONS,
          turn_detection: {
            type: 'semantic_vad',
            create_response: true,
            interrupt_response: true,
          },
          tools: [
            {
              type: 'function',
              function: {
                name: DELEGATE_TOOL_NAME,
                description:
                  'Delegate the complete user request to the authoritative Qwen Code coordinator.',
                parameters: {
                  type: 'object',
                  properties: {
                    request: {
                      type: 'string',
                      description:
                        'The complete user request, preserving references and intent.',
                    },
                    recent_transcript: {
                      type: 'string',
                      description:
                        'Only the bounded recent transcript needed to disambiguate the request.',
                    },
                  },
                  required: ['request'],
                  additionalProperties: false,
                },
              },
            },
            {
              type: 'function',
              function: {
                name: NEW_CONVERSATION_TOOL_NAME,
                description:
                  'Start a separate new Live voice conversation only when the user explicitly asks to switch or reset the Live conversation.',
                parameters: {
                  type: 'object',
                  properties: {},
                  additionalProperties: false,
                },
              },
            },
          ],
        },
      });
    };

    ws.on('message', (...args: unknown[]) => {
      if (terminal || closedByClient) return;
      if (args[1] === true) {
        protocolError(
          'Realtime provider sent an unexpected binary message.',
          'unexpected_binary_message',
        );
        return;
      }
      const raw = String(args[0]);
      if (
        Buffer.byteLength(raw) > QWEN_REALTIME_LIMITS.maxIncomingMessageBytes
      ) {
        protocolError(
          'Realtime provider message exceeded the allowed size.',
          'message_too_large',
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        protocolError(
          'Realtime provider sent invalid JSON.',
          'invalid_provider_message',
        );
        return;
      }
      if (!isRecord(parsed)) {
        protocolError(
          'Realtime provider message must be an object.',
          'invalid_provider_message',
        );
        return;
      }
      const message = parsed as ProviderMessage;
      const type = optionalString(message.type);
      if (!type) {
        protocolError(
          'Realtime provider message omitted its type.',
          'invalid_provider_message',
        );
        return;
      }
      const eventId = optionalString(message.event_id);
      if (eventId) {
        if (recentEventIds.has(eventId)) {
          ignoreEvent(message, type, 'duplicate_event');
          return;
        }
        recentEventIds.add(eventId);
        if (recentEventIds.size > MAX_RECENT_EVENT_IDS) {
          const oldest = recentEventIds.values().next().value;
          if (typeof oldest === 'string') recentEventIds.delete(oldest);
        }
      }

      switch (type) {
        case 'session.created': {
          sendSessionUpdate();
          break;
        }
        case 'session.updated': {
          if (ready) break;
          ready = true;
          clearConnectTimer();
          const providerSession = isRecord(message['session'])
            ? message['session']
            : undefined;
          if (
            !callback(() =>
              callbacks.onReady?.({
                ...eventContext(message),
                sessionId: optionalString(providerSession?.['id']),
              }),
            )
          ) {
            break;
          }
          settled = true;
          resolve(session);
          break;
        }
        case 'input_audio_buffer.speech_started': {
          const itemId = optionalString(message['item_id']);
          if (itemId) latestInputItemId = itemId;
          if (
            activeResponseId &&
            activeAudioResponseId === activeResponseId &&
            !cancelledResponseIds.has(activeResponseId)
          ) {
            const interruptedResponseId = activeResponseId;
            callback(() =>
              callbacks.onBargeIn?.({
                ...eventContext(message),
                responseId: interruptedResponseId,
              }),
            );
            session.cancelResponse();
          }
          callback(() =>
            callbacks.onSpeechStarted?.({
              ...eventContext(message),
              itemId,
              audioStartMs: optionalFiniteNumber(message['audio_start_ms']),
            }),
          );
          break;
        }
        case 'input_audio_buffer.speech_stopped': {
          const itemId = optionalString(message['item_id']);
          if (itemId) latestInputItemId = itemId;
          callback(() =>
            callbacks.onSpeechStopped?.({
              ...eventContext(message),
              itemId,
              audioEndMs: optionalFiniteNumber(message['audio_end_ms']),
            }),
          );
          break;
        }
        case 'input_audio_buffer.committed': {
          const itemId = optionalString(message['item_id']);
          if (itemId) latestInputItemId = itemId;
          callback(() =>
            callbacks.onInputCommitted?.({
              ...eventContext(message),
              itemId,
            }),
          );
          break;
        }
        case 'conversation.item.input_audio_transcription.delta':
        case 'conversation.item.input_audio_transcription.text': {
          const itemId = optionalString(message['item_id']);
          if (itemId && latestInputItemId && itemId !== latestInputItemId) {
            ignoreEvent(message, type, 'stale_input');
            break;
          }
          const text = optionalString(
            message['text'] ?? message['delta'] ?? '',
            QWEN_REALTIME_LIMITS.maxTranscriptChars,
          );
          const stash = optionalString(
            message['stash'] ?? '',
            QWEN_REALTIME_LIMITS.maxTranscriptChars,
          );
          if (
            text === undefined ||
            stash === undefined ||
            text.length + stash.length > QWEN_REALTIME_LIMITS.maxTranscriptChars
          ) {
            protocolError(
              'Realtime input transcript exceeded the allowed size.',
              'transcript_too_large',
            );
            break;
          }
          callback(() =>
            callbacks.onInputTranscriptDelta?.({
              ...eventContext(message),
              itemId,
              text: `${text}${stash}`,
              stash,
              language: optionalString(message['language']),
              emotion: optionalString(message['emotion']),
            }),
          );
          break;
        }
        case 'conversation.item.input_audio_transcription.completed': {
          const itemId = optionalString(message['item_id']);
          if (itemId && latestInputItemId && itemId !== latestInputItemId) {
            ignoreEvent(message, type, 'stale_input');
            break;
          }
          const transcript = optionalString(
            message['transcript'],
            QWEN_REALTIME_LIMITS.maxTranscriptChars,
          );
          if (transcript === undefined) {
            protocolError(
              'Realtime input transcript exceeded the allowed size.',
              'transcript_too_large',
            );
            break;
          }
          if (itemId && transcript.trim().length > 0) {
            rememberCompletedInputTranscript(itemId, transcript);
          }
          callback(() =>
            callbacks.onInputTranscriptDone?.({
              ...eventContext(message),
              itemId,
              text: transcript,
            }),
          );
          break;
        }
        case 'conversation.item.input_audio_transcription.failed': {
          const error = isRecord(message['error'])
            ? message['error']
            : undefined;
          notifyError(
            new QwenRealtimeError(
              sanitizeErrorText(
                error?.['message'] ??
                  error?.['code'] ??
                  'Realtime input transcription failed.',
                config.apiKey,
              ),
              optionalString(error?.['code']),
              false,
            ),
          );
          break;
        }
        case 'response.created': {
          const responseId = readResponseId(message, true);
          if (!responseId) {
            protocolError(
              'Realtime response omitted its identifier.',
              'invalid_response',
            );
            break;
          }
          activeResponseId = responseId;
          activeResponseAuthority = responseCreatePending
            ? (pendingResponseAuthority ?? 'untrusted_input')
            : 'untrusted_input';
          if (
            activeResponseAuthority === 'untrusted_input' &&
            latestInputItemId
          ) {
            responseInputItemIds.set(responseId, latestInputItemId);
          }
          activeApprovedCallId = undefined;
          activeApprovedToolName = undefined;
          responseCreatePending = false;
          pendingResponseAuthority = undefined;
          activeAudioResponseId = undefined;
          const response = isRecord(message['response'])
            ? message['response']
            : undefined;
          callback(() =>
            callbacks.onResponseCreated?.({
              ...eventContext(message),
              responseId,
              status: optionalString(response?.['status']),
            }),
          );
          break;
        }
        case 'response.audio.delta':
        case 'response.output_audio.delta': {
          const responseId = readResponseId(message);
          if (!responseId || !isCurrentResponse(message, type, responseId)) {
            break;
          }
          const audio = parseAudioDelta(message['delta']);
          if (!audio) {
            protocolError(
              'Realtime output audio frame was invalid or too large.',
              'invalid_audio_frame',
            );
            break;
          }
          if (activeResponseAuthority === 'untrusted_input') break;
          activeAudioResponseId = responseId;
          callback(() =>
            callbacks.onOutputAudioDelta?.({
              ...eventContext(message),
              responseId,
              itemId: optionalString(message['item_id']),
              audio,
            }),
          );
          break;
        }
        case 'response.audio.done':
        case 'response.output_audio.done': {
          const responseId = readResponseId(message);
          if (!responseId || !isCurrentResponse(message, type, responseId)) {
            break;
          }
          if (activeAudioResponseId === responseId) {
            activeAudioResponseId = undefined;
          }
          if (activeResponseAuthority === 'untrusted_input') break;
          callback(() =>
            callbacks.onOutputAudioDone?.({
              ...eventContext(message),
              responseId,
              itemId: optionalString(message['item_id']),
            }),
          );
          break;
        }
        case 'response.text.delta':
        case 'response.output_text.delta':
        case 'response.audio_transcript.delta': {
          const responseId = readResponseId(message);
          if (!responseId || !isCurrentResponse(message, type, responseId)) {
            break;
          }
          const delta = optionalString(
            message['delta'],
            QWEN_REALTIME_LIMITS.maxTextDeltaChars,
          );
          if (delta === undefined) {
            protocolError(
              'Realtime output text delta exceeded the allowed size.',
              'text_delta_too_large',
            );
            break;
          }
          if (activeResponseAuthority === 'untrusted_input') break;
          callback(() =>
            callbacks.onOutputTextDelta?.({
              ...eventContext(message),
              responseId,
              itemId: optionalString(message['item_id']),
              text: delta,
              source: type.includes('audio_transcript')
                ? 'audio_transcript'
                : 'text',
            }),
          );
          break;
        }
        case 'response.text.done':
        case 'response.output_text.done':
        case 'response.audio_transcript.done': {
          const responseId = readResponseId(message);
          if (!responseId || !isCurrentResponse(message, type, responseId)) {
            break;
          }
          const text = optionalString(
            message['text'] ?? message['transcript'],
            QWEN_REALTIME_LIMITS.maxTranscriptChars,
          );
          if (text === undefined) {
            protocolError(
              'Realtime output text exceeded the allowed size.',
              'transcript_too_large',
            );
            break;
          }
          if (activeResponseAuthority === 'untrusted_input') break;
          callback(() =>
            callbacks.onOutputTextDone?.({
              ...eventContext(message),
              responseId,
              itemId: optionalString(message['item_id']),
              text,
              source: type.includes('audio_transcript')
                ? 'audio_transcript'
                : 'text',
            }),
          );
          break;
        }
        case 'response.function_call_arguments.delta': {
          const responseId = readResponseId(message);
          if (!responseId || !isCurrentResponse(message, type, responseId)) {
            break;
          }
          const callId = optionalString(message['call_id']);
          const delta = optionalString(
            message['delta'],
            QWEN_REALTIME_LIMITS.maxFunctionArgumentsChars,
          );
          if (!callId || delta === undefined) {
            protocolError(
              'Realtime function argument event was invalid.',
              'invalid_function_arguments',
            );
            break;
          }
          const existing = pendingCalls.get(callId);
          if (existing && existing.responseId !== responseId) {
            ignoreEvent(message, type, 'stale_call');
            break;
          }
          if (existing?.dispatched) {
            protocolError(
              'Realtime model changed an approved tool call after dispatch.',
              'multiple_approved_tools',
            );
            break;
          }
          if (
            !existing &&
            pendingCalls.size >= QWEN_REALTIME_LIMITS.maxPendingFunctionCalls
          ) {
            protocolError(
              'Realtime provider created too many pending function calls.',
              'too_many_function_calls',
            );
            break;
          }
          const call: PendingFunctionCall = existing ?? {
            responseId,
            itemId: optionalString(message['item_id']),
            callId,
            arguments: '',
            dispatched: false,
            outputSubmitted: false,
            origin: 'provider',
          };
          if (
            call.arguments.length + delta.length >
            QWEN_REALTIME_LIMITS.maxFunctionArgumentsChars
          ) {
            protocolError(
              'Realtime function arguments exceeded the allowed size.',
              'function_arguments_too_large',
            );
            break;
          }
          call.arguments += delta;
          pendingCalls.set(callId, call);
          callback(() =>
            callbacks.onFunctionArgumentsDelta?.({
              ...eventContext(message),
              responseId,
              itemId: call.itemId,
              callId,
              delta,
            }),
          );
          break;
        }
        case 'response.function_call_arguments.done': {
          const responseId = readResponseId(message);
          if (!responseId || !isCurrentResponse(message, type, responseId)) {
            break;
          }
          const callId = optionalString(message['call_id']);
          const name = optionalString(message['name']);
          const args = optionalString(
            message['arguments'],
            QWEN_REALTIME_LIMITS.maxFunctionArgumentsChars,
          );
          if (!callId || !name || args === undefined) {
            protocolError(
              'Realtime function completion was invalid.',
              'invalid_function_arguments',
            );
            break;
          }
          const existing = pendingCalls.get(callId);
          if (existing && existing.responseId !== responseId) {
            ignoreEvent(message, type, 'stale_call');
            break;
          }
          if (existing?.dispatched) {
            if (existing.name !== name || existing.arguments !== args) {
              protocolError(
                'Realtime model changed an approved tool call after dispatch.',
                'multiple_approved_tools',
              );
            }
            break;
          }
          if (
            !existing &&
            pendingCalls.size >= QWEN_REALTIME_LIMITS.maxPendingFunctionCalls
          ) {
            protocolError(
              'Realtime provider created too many pending function calls.',
              'too_many_function_calls',
            );
            break;
          }
          const call: PendingFunctionCall = existing ?? {
            responseId,
            itemId: optionalString(message['item_id']),
            callId,
            arguments: '',
            dispatched: false,
            outputSubmitted: false,
            origin: 'provider',
          };
          call.name = name;
          pendingCalls.set(callId, call);
          dispatchFunctionCall(message, call, args);
          break;
        }
        case 'response.output_item.done': {
          const responseId = readResponseId(message);
          if (!responseId || !isCurrentResponse(message, type, responseId)) {
            break;
          }
          const item = isRecord(message['item']) ? message['item'] : undefined;
          if (item?.['type'] !== 'function_call') break;
          const callId = optionalString(item['call_id']);
          const name = optionalString(item['name']);
          const args = optionalString(
            item['arguments'],
            QWEN_REALTIME_LIMITS.maxFunctionArgumentsChars,
          );
          if (!callId || !name || args === undefined) break;
          const existing = pendingCalls.get(callId);
          if (existing && existing.responseId !== responseId) {
            ignoreEvent(message, type, 'stale_call');
            break;
          }
          if (existing?.dispatched) {
            if (existing.name !== name || existing.arguments !== args) {
              protocolError(
                'Realtime model changed an approved tool call after dispatch.',
                'multiple_approved_tools',
              );
            }
            break;
          }
          if (
            !existing &&
            pendingCalls.size >= QWEN_REALTIME_LIMITS.maxPendingFunctionCalls
          ) {
            protocolError(
              'Realtime provider created too many pending function calls.',
              'too_many_function_calls',
            );
            break;
          }
          const call: PendingFunctionCall = existing ?? {
            responseId,
            itemId: optionalString(item['id']),
            callId,
            arguments: '',
            dispatched: false,
            outputSubmitted: false,
            origin: 'provider',
          };
          call.name = name;
          pendingCalls.set(callId, call);
          dispatchFunctionCall(message, call, args);
          break;
        }
        case 'response.done': {
          const responseId = readResponseId(message, true);
          if (!responseId) {
            protocolError(
              'Realtime response completion omitted its identifier.',
              'invalid_response',
            );
            break;
          }
          if (cancelledResponseIds.has(responseId)) {
            cancelledResponseIds.delete(responseId);
            pendingFollowupResponses.delete(responseId);
            deletePendingCallsForResponse(responseId);
            consumeResponseInput(responseId);
            if (activeResponseId === responseId) activeResponseId = undefined;
            activeResponseAuthority = undefined;
            activeApprovedCallId = undefined;
            activeApprovedToolName = undefined;
            if (activeAudioResponseId === responseId) {
              activeAudioResponseId = undefined;
            }
            callback(() =>
              callbacks.onResponseDone?.({
                ...eventContext(message),
                responseId,
                status: 'cancelled',
              }),
            );
            break;
          }
          if (!isCurrentResponse(message, type, responseId)) break;
          const response = isRecord(message['response'])
            ? message['response']
            : undefined;
          const status = optionalString(response?.['status']);
          const responseAuthority = activeResponseAuthority;
          const approvedToolName = activeApprovedToolName;
          if (status === 'failed') deletePendingCallsForResponse(responseId);
          else finishPendingCallsForResponse(responseId);
          activeResponseId = undefined;
          activeResponseAuthority = undefined;
          activeApprovedCallId = undefined;
          activeApprovedToolName = undefined;
          activeAudioResponseId = undefined;
          const needsTranscriptFallback =
            responseAuthority === 'untrusted_input' &&
            approvedToolName === undefined &&
            status !== 'cancelled' &&
            status !== 'failed';
          const fallbackDispatched =
            needsTranscriptFallback &&
            dispatchTranscriptFallback(message, responseId);
          if (!fallbackDispatched) consumeResponseInput(responseId);
          callback(() =>
            callbacks.onResponseDone?.({
              ...eventContext(message),
              responseId,
              status,
            }),
          );
          if (needsTranscriptFallback && !fallbackDispatched) {
            protocolError(
              'Realtime model completed a user response without an approved tool or an attributable transcript.',
              'missing_approved_tool',
            );
            break;
          }
          if (
            status === 'completed' &&
            pendingFollowupResponses.delete(responseId)
          ) {
            sendResponseCreate('delegate_result');
          } else if (status === 'completed') {
            flushCoordinatorUpdate();
          }
          if (status === 'failed') {
            pendingFollowupResponses.delete(responseId);
            notifyError(
              new QwenRealtimeError(
                'Realtime response failed.',
                'response_failed',
                false,
              ),
            );
            flushCoordinatorUpdate();
          }
          break;
        }
        case 'rate_limits.updated':
        case 'rate_limit.updated': {
          callback(() =>
            callbacks.onRateLimit?.({
              ...eventContext(message),
              limits: parseRateLimits(
                message['rate_limits'] ?? message['rate_limit'],
              ),
            }),
          );
          break;
        }
        case 'error': {
          const providerError = isRecord(message['error'])
            ? message['error']
            : undefined;
          const code = optionalString(providerError?.['code']);
          const errorMessage = sanitizeErrorText(
            providerError?.['message'] ??
              providerError?.['code'] ??
              'Qwen Realtime request failed.',
            config.apiKey,
          );
          if (isRateLimitCode(code, errorMessage)) {
            callback(() =>
              callbacks.onRateLimit?.({
                ...eventContext(message),
                limits: [],
              }),
            );
          }
          fail(new QwenRealtimeError(errorMessage, code));
          break;
        }
        default:
          break;
      }
    });

    ws.on('error', (rawError: unknown) => {
      fail(
        new QwenRealtimeError(
          sanitizeErrorText(
            rawError instanceof Error ? rawError.message : rawError,
            config.apiKey,
          ),
          'socket_error',
        ),
      );
    });

    ws.on('close', (...args: unknown[]) => {
      clearConnectTimer();
      removeAbortListener();
      if (closedByClient || terminal) return;
      const code = optionalFiniteNumber(args[0]);
      const reason = sanitizeErrorText(args[1], config.apiKey);
      const suffix = code ? ` (${code}${reason ? `: ${reason}` : ''})` : '';
      const error = new QwenRealtimeError(
        `Realtime connection closed unexpectedly${suffix}.`,
        'connection_closed',
      );
      if (!settled) {
        settled = true;
        reject(error);
      } else {
        notifyError(error);
      }
      terminal = true;
      settleClosed({ reason: 'remote', error });
    });

    abortListener = () => {
      fail(new QwenRealtimeError('Realtime connection was aborted.'));
    };
    deps.abortSignal?.addEventListener('abort', abortListener, { once: true });
    if (deps.abortSignal?.aborted) abortListener();

    connectTimer = setTimeout(() => {
      if (!ready) {
        fail(
          new QwenRealtimeError(
            'Realtime connection timed out.',
            'connection_timeout',
          ),
        );
      }
    }, connectTimeoutMs);
  });
}
