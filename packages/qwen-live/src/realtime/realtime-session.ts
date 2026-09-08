/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DashScope qwen-omni realtime client, ported from
 * packages/cli/src/serve/live/qwen-realtime-session.ts.
 *
 * The transport, response-arbitration, and defensive-validation layers are
 * unchanged from the port. What changed for the standalone live daemon is the
 * tool surface: instead of a single hardcoded `background_agent` handoff tool
 * whose call stays open for the whole backend turn, the session accepts an
 * arbitrary tool list via config and dispatches every function call through
 * `onFunctionCall`, expecting a prompt receipt-style output for each call via
 * `submitFunctionOutput`.
 */
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { SocketLike } from './socket.js';
import { deriveWebSocketBase } from './socket.js';
import { escapeAnsiCtrlCodes } from './sanitize.js';

export type RealtimeCallEpoch = string | number;

export const QWEN_REALTIME_INPUT_SAMPLE_RATE = 16_000;
export const QWEN_REALTIME_OUTPUT_SAMPLE_RATE = 24_000;

export const QWEN_REALTIME_LIMITS = {
  maxInputAudioFrameBytes: 64 * 1024,
  maxInputImageBytes: 190 * 1024,
  maxOutputAudioFrameBytes: 256 * 1024,
  maxBufferedSocketBytes: 1024 * 1024,
  maxIncomingMessageBytes: 1024 * 1024,
  maxTranscriptChars: 256 * 1024,
  maxTextDeltaChars: 64 * 1024,
  maxFunctionArgumentsChars: 32 * 1024,
  maxFunctionOutputChars: 64 * 1024,
  maxPendingFunctionCalls: 8,
  maxIdentifierChars: 256,
} as const;

const CONNECT_TIMEOUT_MS = 8000;
const NON_DIRECT_RESPONSE_CREATED_TIMEOUT_MS = 15_000;
const NON_DIRECT_RESPONSE_DONE_TIMEOUT_MS = 120_000;
const MAX_ERROR_MESSAGE_CHARS = 300;
const MAX_ERROR_RESPONSE_BYTES = 16 * 1024;
const MAX_RECENT_EVENT_IDS = 512;
const MAX_TRACKED_INPUT_ITEMS = 32;
const MAX_RETAINED_TRANSCRIPT_ENTRIES = 512;
const PROTOCOL_DEBUG_EVENT_TYPES = new Set([
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
  'conversation.item.created',
  'conversation.item.input_audio_transcription.completed',
  'conversation.item.input_audio_transcription.failed',
  'response.created',
  'response.done',
]);
export const REMAIN_SILENT_TOOL_NAME = 'remain_silent';
const REALTIME_BACKEND_TEXT_PREFIX = '[BACKEND] ';
const REALTIME_SPEAK_TO_USER_PREFIX = '[SPEAK_TO_USER] ';
const REALTIME_MERGED_SPEECH_PREFIX = '[MERGE_WITH_USER] ';
const PROACTIVE_REPAIR_REJECTION_OUTPUT = JSON.stringify({
  status: 'error',
  note: 'This tool is not authorized for the Proactive repair turn.',
});
const RESPONSE_TOOL_REJECTION_OUTPUT = JSON.stringify({
  status: 'error',
  note: 'This response is not authorized to call tools.',
});

/**
 * OpenAI-style function tool declaration forwarded to the realtime provider.
 *
 * `capturesTranscript` marks handoff-style tools: when the model calls one,
 * the session captures the live transcript tail (so the orchestrator can pack
 * the recent voice context into the backend prompt) and marks the response as
 * delegated, which keeps the same user turn out of the direct-answer
 * transcript collection.
 *
 * `continuesResponse` marks receipt tools whose result needs another model
 * response. Asynchronous handoff receipts leave it unset because their later
 * backend events are the user-visible result.
 */
export interface RealtimeToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  capturesTranscript?: boolean;
  continuesResponse?: boolean;
}
export interface QwenRealtimeConfig {
  endpoint: string;
  apiKey?: string;
  model: string;
  callEpoch: RealtimeCallEpoch;
  voice?: string;
  instructions: string;
  tools: readonly RealtimeToolDefinition[];
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
  responseCreatedTimeoutMs?: number;
  responseDoneTimeoutMs?: number;
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
  inputItemId?: string;
  status?: string;
}

export type RealtimeResponseAuthority =
  | 'direct'
  | 'tool_continuation'
  | 'backend_speech'
  | 'proactive'
  | 'proactive_repair';

type RealtimeToolCapability = 'none' | 'direct';

export type RealtimeResponseCancellationReason =
  | 'user_interrupted'
  | 'client_cancelled'
  | 'superseded';

export interface RealtimeResponseDoneEvent extends RealtimeResponseEvent {
  authority?: RealtimeResponseAuthority;
  cancellationReason?: RealtimeResponseCancellationReason;
}

export interface RealtimeResponseCreatedEvent extends RealtimeResponseEvent {
  authority: RealtimeResponseAuthority;
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

export interface RealtimeTranscriptEntry {
  role: 'user' | 'assistant';
  text: string;
}

export interface RealtimeDirectTranscriptEvent extends RealtimeEventContext {
  responseId?: string;
  inputItemId?: string;
  entries: readonly RealtimeTranscriptEntry[];
}

export interface RealtimeImageDroppedEvent extends RealtimeEventContext {
  reason:
    | 'audio_not_started'
    | 'connection_unavailable'
    | 'socket_backpressure'
    | 'speech_superseded';
  bufferedBytes: number;
}

export interface RealtimeFunctionCall extends RealtimeResponseEvent {
  itemId?: string;
  callId: string;
  name: string;
  /** Raw JSON argument string as sent by the model; parsing is the caller's job. */
  arguments: string;
  /** Transcript tail captured at call time for `capturesTranscript` tools; empty otherwise. */
  activeTranscript: readonly RealtimeTranscriptEntry[];
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
  onDialogue?: (
    event: RealtimeEventContext & {
      inputItemId: string;
      role: 'user' | 'assistant';
      text: string;
      source?: 'normal' | 'filler';
      interrupted?: boolean;
    },
  ) => void;
  onReady?: (event: RealtimeEventContext & { sessionId?: string }) => void;
  onSpeechStarted?: (event: RealtimeSpeechEvent) => void;
  onSpeechStopped?: (event: RealtimeSpeechEvent) => void;
  onInputCommitted?: (
    event: RealtimeSpeechEvent & { responsePending: boolean },
  ) => void;
  onInputTranscriptDelta?: (event: RealtimeInputTranscriptEvent) => void;
  onInputTranscriptDone?: (event: RealtimeInputTranscriptEvent) => void;
  onOutputTextDelta?: (event: RealtimeOutputTextEvent) => void;
  onOutputTextDone?: (event: RealtimeOutputTextEvent) => void;
  onOutputAudioDelta?: (event: RealtimeOutputAudioEvent) => void;
  onOutputAudioDone?: (
    event: RealtimeResponseEvent & { itemId?: string },
  ) => void;
  onFunctionArgumentsDelta?: (event: RealtimeFunctionArgumentsEvent) => void;
  onFunctionCall?: (event: RealtimeFunctionCall) => void;
  onResponseCreated?: (event: RealtimeResponseCreatedEvent) => void;
  onResponseDone?: (event: RealtimeResponseDoneEvent) => void;
  onDirectTranscript?: (event: RealtimeDirectTranscriptEvent) => void;
  onBargeIn?: (event: RealtimeResponseEvent) => void;
  onIgnoredEvent?: (event: RealtimeIgnoredEvent) => void;
  onProtocolDebug?: (details: Record<string, unknown>) => void;
  onAudioDropped?: (event: RealtimeEventContext) => void;
  onImageDropped?: (event: RealtimeImageDroppedEvent) => void;
  onError?: (error: QwenRealtimeError) => void;
  onClose?: (info: RealtimeCloseInfo) => void;
}

export interface RealtimeFunctionCallRef {
  callEpoch: RealtimeCallEpoch;
  callId: string;
}

export interface RealtimeCloseOptions {
  discardPendingInput?: boolean;
}

export interface QwenRealtimeSession {
  readonly callEpoch: RealtimeCallEpoch;
  readonly closed: Promise<RealtimeCloseInfo>;
  flushDialogue: () => void;
  configure: (update: {
    instructions: string;
    tools: readonly RealtimeToolDefinition[];
  }) => boolean;
  pushAudio: (pcm16: Uint8Array) => boolean;
  pushImage: (jpegBase64: string) => boolean;
  commitInputAudio: () => boolean;
  clearInputAudio: () => boolean;
  cancelResponse: () => boolean;
  /** Submit the (receipt-style) output for a dispatched function call. */
  submitFunctionOutput: (
    ref: RealtimeFunctionCallRef,
    output: string,
  ) => boolean;
  sendBackendContext: (text: string) => boolean;
  speakToUser: (message: string) => boolean;
  respondToProactiveEvent: (event: string) => boolean;
  requestProactiveRepair: (
    instruction: string,
    allowedToolNames: readonly string[],
  ) => boolean;
  takeTranscriptTail: () => readonly RealtimeTranscriptEntry[];
  close: (options?: RealtimeCloseOptions) => void;
}

export type QwenRealtimeErrorKind = 'configuration' | 'transient' | 'protocol';

export interface QwenRealtimeErrorOptions {
  kind?: QwenRealtimeErrorKind;
  status?: number;
  providerType?: string;
  param?: string;
  closeCode?: number;
}

function classifyRealtimeErrorKind(
  code: string | undefined,
  message: string,
  status?: number,
): QwenRealtimeErrorKind {
  const normalized = `${code ?? ''} ${message}`.toLowerCase();
  if (
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599) ||
    [
      'connection_closed',
      'connection_failed',
      'connection_timeout',
      'socket_error',
      'send_failed',
    ].includes(code ?? '') ||
    /\b429\b|rate[ _.-]?limit|throttl|limit_requests|limitrequests|resourceexhausted|resource_exhausted|limit_burst_rate|insufficient_quota|service_unavailable|internal[ _.-]?error|system[ _.-]?error|modelservicefailed|timeout|temporar/.test(
      normalized,
    )
  ) {
    return 'transient';
  }
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    /invalid[ _.-]?(api[ _.-]?key|endpoint|model|request)|authentication|unauthori[sz]ed|forbidden|permission|model[ _.-]?(not[ _.-]?found|not[ _.-]?supported)/.test(
      normalized,
    )
  ) {
    return 'configuration';
  }
  return 'protocol';
}

export class QwenRealtimeError extends Error {
  readonly code?: string;
  readonly fatal: boolean;
  readonly kind: QwenRealtimeErrorKind;
  readonly status?: number;
  readonly providerType?: string;
  readonly param?: string;
  readonly closeCode?: number;

  constructor(
    message: string,
    code?: string,
    fatal = true,
    options: QwenRealtimeErrorOptions = {},
  ) {
    super(message);
    this.name = 'QwenRealtimeError';
    this.code = code;
    this.fatal = fatal;
    this.kind =
      options.kind ?? classifyRealtimeErrorKind(code, message, options.status);
    this.status = options.status;
    this.providerType = options.providerType;
    this.param = options.param;
    this.closeCode = options.closeCode;
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
  responseCompleted: boolean;
  speechGeneration: number;
  repairDeferred?: boolean;
  repairEventId?: string;
  pendingOutput?: {
    output: string;
  };
}

interface ResponseCreateRequest {
  requestId: string;
  authority: RealtimeResponseAuthority;
  speechMessage?: string;
  inputItemId?: string;
  speechGeneration: number;
  cancelled: boolean;
  cancellationReason?: RealtimeResponseCancellationReason;
  repairAllowedToolNames?: ReadonlySet<string>;
  toolCapability: RealtimeToolCapability;
}

interface ToolContinuationState {
  speechGeneration: number;
  toolCapability: RealtimeToolCapability;
  inputItemId?: string;
}

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
      : Buffer.isBuffer(raw) || raw instanceof Uint8Array
        ? Buffer.from(raw).toString('utf8')
        : 'Qwen Realtime request failed.';
  if (apiKey) text = text.split(apiKey).join('[REDACTED]');
  return escapeAnsiCtrlCodes(text).slice(0, MAX_ERROR_MESSAGE_CHARS);
}

function optionalHttpStatus(value: unknown): number | undefined {
  const status =
    typeof value === 'string' && /^\d{3}$/.test(value)
      ? Number(value)
      : optionalFiniteNumber(value);
  return status !== undefined && status >= 100 && status <= 599
    ? Math.trunc(status)
    : undefined;
}

function responseFailureError(
  response: Record<string, unknown> | undefined,
  apiKey?: string,
): QwenRealtimeError {
  const details = isRecord(response?.['status_details'])
    ? response['status_details']
    : undefined;
  const providerError = isRecord(details?.['error'])
    ? details['error']
    : undefined;
  const code = optionalString(providerError?.['code']) ?? 'response_failed';
  const status = optionalHttpStatus(
    providerError?.['status'] ?? details?.['status'],
  );
  const providerType = optionalString(providerError?.['type']);
  const param = optionalString(providerError?.['param']);
  const message = sanitizeErrorText(
    providerError?.['message'] ??
      details?.['reason'] ??
      'Realtime response failed.',
    apiKey,
  );
  return new QwenRealtimeError(message, code, false, {
    kind: classifyRealtimeErrorKind(code, message, status),
    ...(status !== undefined ? { status } : {}),
    ...(providerType ? { providerType } : {}),
    ...(param ? { param } : {}),
  });
}

function upgradeFailureError(
  status: number | undefined,
  body: string,
  apiKey?: string,
): QwenRealtimeError {
  let payload: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    payload = isRecord(parsed) ? parsed : undefined;
  } catch {
    payload = undefined;
  }
  const providerError = isRecord(payload?.['error'])
    ? payload['error']
    : payload;
  const code =
    optionalString(providerError?.['code']) ??
    (status ? `http_${status}` : 'connection_failed');
  const fallback = status
    ? `Realtime provider rejected the WebSocket upgrade (${status}).`
    : 'Realtime provider rejected the WebSocket upgrade.';
  const message =
    typeof providerError?.['message'] === 'string'
      ? sanitizeErrorText(providerError['message'], apiKey)
      : fallback;
  return new QwenRealtimeError(message, code, true, {
    kind: classifyRealtimeErrorKind(code, message, status),
    ...(status !== undefined ? { status } : {}),
  });
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

function isBoundedJpegBase64(value: string): boolean {
  const maxBase64Chars =
    Math.ceil(QWEN_REALTIME_LIMITS.maxInputImageBytes / 3) * 4;
  if (
    value.length === 0 ||
    value.length > maxBase64Chars ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    return false;
  }
  const jpeg = Buffer.from(value, 'base64');
  return (
    jpeg.byteLength >= 4 &&
    jpeg.byteLength <= QWEN_REALTIME_LIMITS.maxInputImageBytes &&
    jpeg[0] === 0xff &&
    jpeg[1] === 0xd8 &&
    jpeg[jpeg.byteLength - 2] === 0xff &&
    jpeg[jpeg.byteLength - 1] === 0xd9 &&
    jpeg.toString('base64') === value
  );
}

export function openQwenRealtimeSession(
  config: QwenRealtimeConfig,
  callbacks: QwenRealtimeCallbacks = {},
  deps: QwenRealtimeDeps = {},
): Promise<QwenRealtimeSession> {
  const connectTimeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const responseCreatedTimeoutMs =
    deps.responseCreatedTimeoutMs ?? NON_DIRECT_RESPONSE_CREATED_TIMEOUT_MS;
  const responseDoneTimeoutMs =
    deps.responseDoneTimeoutMs ?? NON_DIRECT_RESPONSE_DONE_TIMEOUT_MS;
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
    if (
      typeof config.instructions !== 'string' ||
      config.instructions.length > 100_000
    ) {
      reject(
        new RangeError('Realtime instructions exceed the supported size.'),
      );
      return;
    }
    if (deps.abortSignal?.aborted) {
      reject(new QwenRealtimeError('Realtime connection was aborted.'));
      return;
    }

    let realtimeUrl: string;
    try {
      realtimeUrl = deriveQwenOmniRealtimeUrl(config.endpoint, config.model);
    } catch (error) {
      reject(
        new QwenRealtimeError(
          sanitizeErrorText(
            error instanceof Error ? error.message : error,
            config.apiKey,
          ),
          'invalid_endpoint',
          true,
          { kind: 'configuration' },
        ),
      );
      return;
    }

    let ws: SocketLike;
    try {
      ws = createWebSocket(realtimeUrl, {
        headers: config.apiKey
          ? { Authorization: `Bearer ${config.apiKey}` }
          : {},
        maxPayload: QWEN_REALTIME_LIMITS.maxIncomingMessageBytes,
        perMessageDeflate: false,
        handshakeTimeout: connectTimeoutMs,
      });
    } catch (error) {
      reject(
        new QwenRealtimeError(
          sanitizeErrorText(
            error instanceof Error ? error.message : error,
            config.apiKey,
          ),
          'connection_failed',
          true,
          { kind: 'transient' },
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
    let lastCompletedResponseId: string | undefined;
    let activeAudioResponseId: string | undefined;
    let pendingResponseCreate: ResponseCreateRequest | undefined;
    let responseCreateQueue: ResponseCreateRequest[] = [];
    let speechGeneration = 0;
    let speechGenerationAdvancedForInput = false;
    let directResponsePending = false;
    let activeResponseAuthority: RealtimeResponseAuthority | undefined;
    let effectiveInstructions = config.instructions;
    let effectiveTools = [...config.tools];
    let configurationDirty = false;
    let responseInstructions = false;
    const toolsByName = new Map<string, RealtimeToolDefinition>(
      config.tools.map((tool) => [tool.function.name, tool]),
    );
    let backpressureWarned = false;
    let hasSentInputAudio = false;
    let speechInputInProgress = false;
    let speechCommitPending = false;
    let responseCreatedInProgress = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let responseCreatedTimer: ReturnType<typeof setTimeout> | undefined;
    let responseDoneTimer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const cancelledResponseIds = new Set<string>();
    const cancelledResponseReasons = new Map<
      string,
      RealtimeResponseCancellationReason
    >();
    const recentEventIds = new Set<string>();
    const pendingCalls = new Map<string, PendingFunctionCall>();
    const toolContinuationStates = new Map<string, ToolContinuationState>();
    const pendingSpeechItemIds = new Set<string>();
    const committedInputItemIds = new Set<string>();
    const completedInputTranscripts = new Map<string, string>();
    const responseInputItemIds = new Map<string, string>();
    const consumedInputItemIds = new Set<string>();
    const transcriptEntries: RealtimeTranscriptEntry[] = [];
    const pendingDirectTranscriptEntries: RealtimeTranscriptEntry[] = [];
    const collectedDirectResponseIds = new Set<string>();
    const collectedDirectInputItemIds = new Set<string>();
    const responseAuthorities = new Map<string, RealtimeResponseAuthority>();
    const responseToolCapabilities = new Map<string, RealtimeToolCapability>();
    const responseWithTools = new Set<string>();
    const dialogueInputs = new Set<string>();
    const dialogueResponses = new Set<string>();
    const dialoguePrefixes = new Map<string, string>();
    const repairToolAllowlists = new Map<string, ReadonlySet<string>>();
    const delegatedResponseIds = new Set<string>();
    const responseOutputText = new Map<
      string,
      { text: string; audioTranscript: string }
    >();
    let newInputEntry = false;
    let newOutputEntry = false;
    let resolveClosed: (info: RealtimeCloseInfo) => void = () => undefined;
    const closed = new Promise<RealtimeCloseInfo>((res) => {
      resolveClosed = res;
    });
    let closedSettled = false;

    const protocolDebug = (message: ProviderMessage, type: string): void => {
      if (!callbacks.onProtocolDebug || !PROTOCOL_DEBUG_EVENT_TYPES.has(type))
        return;
      try {
        const identifier = (value: unknown): string | undefined => {
          const id = optionalString(value);
          return id &&
            /^[A-Za-z0-9_.:-]+$/.test(id) &&
            (!config.apiKey || !id.includes(config.apiKey))
            ? id
            : undefined;
        };
        const enumeration = (value: unknown, allowed: readonly string[]) =>
          typeof value === 'string' && allowed.includes(value)
            ? value
            : undefined;
        const item = isRecord(message['item']) ? message['item'] : undefined;
        const response = isRecord(message['response'])
          ? message['response']
          : undefined;
        const details = isRecord(response?.['status_details'])
          ? response['status_details']
          : undefined;
        const itemId = optionalString(
          type === 'conversation.item.created'
            ? item?.['id']
            : message['item_id'],
        );
        const responseId = optionalString(
          response?.['id'] ?? message['response_id'],
        );
        const contentKinds = Array.isArray(item?.['content'])
          ? [
              ...new Set(
                item['content'].flatMap((part) => {
                  const kind = isRecord(part)
                    ? enumeration(part['type'], [
                        'input_audio',
                        'input_text',
                        'input_image',
                        'audio',
                        'text',
                      ])
                    : undefined;
                  return kind ? [kind] : [];
                }),
              ),
            ]
          : undefined;
        callbacks.onProtocolDebug({
          type,
          eventId: identifier(message.event_id),
          itemId: identifier(itemId),
          responseId: identifier(responseId),
          activeResponseId: identifier(activeResponseId),
          activeResponseAuthority,
          responseCancelled:
            responseId !== undefined && cancelledResponseIds.has(responseId),
          cancellationReason:
            responseId === undefined
              ? undefined
              : cancelledResponseReasons.get(responseId),
          itemType: enumeration(item?.['type'], [
            'message',
            'function_call',
            'function_call_output',
          ]),
          role: enumeration(item?.['role'], ['user', 'assistant', 'system']),
          contentKinds,
          responseStatus: enumeration(response?.['status'], [
            'in_progress',
            'completed',
            'cancelled',
            'failed',
            'incomplete',
          ]),
          statusType: enumeration(details?.['type'], [
            'completed',
            'cancelled',
            'failed',
            'incomplete',
          ]),
          statusReason: enumeration(details?.['reason'], [
            'turn_detected',
            'client_cancelled',
            'user_interrupted',
            'superseded',
            'max_output_tokens',
            'content_filter',
          ]),
          pendingSpeechItems: pendingSpeechItemIds.size,
          committedInputItems: committedInputItemIds.size,
          completedInputTranscripts: completedInputTranscripts.size,
          consumedInputItems: consumedInputItemIds.size,
          hasPendingSpeechItem:
            itemId !== undefined && pendingSpeechItemIds.has(itemId),
          hasCommittedInputItem:
            itemId !== undefined && committedInputItemIds.has(itemId),
          hasCompletedInputTranscript:
            itemId !== undefined && completedInputTranscripts.has(itemId),
          hasConsumedInputItem:
            itemId !== undefined && consumedInputItemIds.has(itemId),
          hasPendingResponseCreate: pendingResponseCreate !== undefined,
          queuedResponseCreates: responseCreateQueue.length,
          hasSentInputAudio,
          speechInputInProgress,
          speechCommitPending,
          directResponsePending,
        });
      } catch {
        // Diagnostics must not change the call's protocol or lifecycle.
      }
    };

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

    const clearResponseCreatedTimer = () => {
      if (!responseCreatedTimer) return;
      clearTimeout(responseCreatedTimer);
      responseCreatedTimer = undefined;
    };

    const clearResponseDoneTimer = () => {
      if (!responseDoneTimer) return;
      clearTimeout(responseDoneTimer);
      responseDoneTimer = undefined;
    };

    const clearResponseTimers = () => {
      clearResponseCreatedTimer();
      clearResponseDoneTimer();
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

    const unrecoverableInputError = (): QwenRealtimeError =>
      new QwenRealtimeError(
        'Realtime connection ended before accepted speech finished transcribing.',
        'unrecoverable_input',
        true,
        { kind: 'protocol' },
      );

    const pendingInputLossError = (): QwenRealtimeError | undefined => {
      const hasUnresolvedCommittedInput = [...committedInputItemIds].some(
        (itemId) => !completedInputTranscripts.has(itemId),
      );
      return speechInputInProgress ||
        speechCommitPending ||
        hasUnresolvedCommittedInput
        ? unrecoverableInputError()
        : undefined;
    };

    function fail(error: QwenRealtimeError): void {
      if (terminal) return;
      const inputLossError = pendingInputLossError();
      const reportedError =
        error.kind === 'transient' && inputLossError ? inputLossError : error;
      terminal = true;
      if (activeResponseId) collectDialogueResponse(activeResponseId, true);
      clearConnectTimer();
      clearResponseTimers();
      removeAbortListener();
      closeSocket();
      if (!settled) {
        settled = true;
        reject(reportedError);
      } else {
        notifyError(reportedError);
      }
      settleClosed({ reason: 'error', error: reportedError });
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

    const reportResponseTimeout = (
      request: ResponseCreateRequest,
      responseId: string,
      phase: 'created' | 'done',
    ): void => {
      callback(() =>
        callbacks.onResponseDone?.({
          callEpoch: config.callEpoch,
          responseId,
          status: 'failed',
          authority: request.authority,
          ...(request.cancellationReason
            ? { cancellationReason: request.cancellationReason }
            : {}),
        }),
      );
      fail(
        new QwenRealtimeError(
          `Realtime ${request.authority} response timed out waiting for response.${phase}.`,
          `response_${phase}_timeout`,
          true,
          { kind: 'transient' },
        ),
      );
    };

    const flushConfiguration = (): boolean => {
      if (
        !configurationDirty ||
        !ready ||
        activeResponseId ||
        pendingResponseCreate ||
        responseCreatedInProgress
      )
        return true;
      if (
        !sendJson({
          type: 'session.update',
          session: {
            instructions: effectiveInstructions,
            tools: effectiveTools.map((tool) => ({
              type: tool.type,
              function: tool.function,
            })),
          },
        })
      )
        return false;
      configurationDirty = false;
      return true;
    };

    const armResponseCreatedTimer = (request: ResponseCreateRequest): void => {
      clearResponseCreatedTimer();
      if (request.authority === 'direct') return;
      responseCreatedTimer = setTimeout(() => {
        responseCreatedTimer = undefined;
        if (pendingResponseCreate !== request || terminal || closedByClient) {
          return;
        }
        pendingResponseCreate = undefined;
        reportResponseTimeout(
          request,
          `unacknowledged-${request.requestId}`,
          'created',
        );
      }, responseCreatedTimeoutMs);
      responseCreatedTimer.unref?.();
    };

    const armResponseDoneTimer = (
      request: ResponseCreateRequest,
      responseId: string,
    ): void => {
      clearResponseDoneTimer();
      if (request.authority === 'direct') return;
      responseDoneTimer = setTimeout(() => {
        responseDoneTimer = undefined;
        if (activeResponseId !== responseId || terminal || closedByClient) {
          return;
        }
        sendJson({ type: 'response.cancel' });
        reportResponseTimeout(request, responseId, 'done');
      }, responseDoneTimeoutMs);
      responseDoneTimer.unref?.();
    };

    const markResponseCancelled = (
      responseId: string,
      retainActive = false,
      reason: RealtimeResponseCancellationReason = 'superseded',
    ): void => {
      if (cancelledResponseIds.has(responseId)) {
        if (!cancelledResponseReasons.has(responseId)) {
          cancelledResponseReasons.set(responseId, reason);
        }
        return;
      }
      cancelledResponseIds.add(responseId);
      cancelledResponseReasons.set(responseId, reason);
      for (const [callId, call] of pendingCalls) {
        if (
          call.responseId === responseId &&
          (!call.dispatched || call.repairDeferred)
        ) {
          pendingCalls.delete(callId);
        }
      }
      if (!retainActive && activeResponseId === responseId) {
        activeResponseId = undefined;
        activeResponseAuthority = undefined;
      }
      if (activeAudioResponseId === responseId) {
        activeAudioResponseId = undefined;
      }
      if (cancelledResponseIds.size > 16) {
        const oldest = cancelledResponseIds.values().next().value;
        if (typeof oldest === 'string') {
          cancelledResponseIds.delete(oldest);
          cancelledResponseReasons.delete(oldest);
        }
      }
    };

    const reportDroppedImage = (
      reason: RealtimeImageDroppedEvent['reason'],
    ): void => {
      callback(() =>
        callbacks.onImageDropped?.({
          callEpoch: config.callEpoch,
          reason,
          bufferedBytes: ws.bufferedAmount ?? 0,
        }),
      );
    };

    const dropImage = (reason: RealtimeImageDroppedEvent['reason']): false => {
      reportDroppedImage(reason);
      return false;
    };

    const sendFunctionCallOutput = (
      call: PendingFunctionCall,
      output: string,
    ): boolean => {
      if (
        !sendJson({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: call.callId,
            output,
          },
        })
      ) {
        return false;
      }
      call.outputSubmitted = true;
      call.pendingOutput = undefined;
      pendingCalls.delete(call.callId);
      maybeRequestToolContinuation(call.responseId);
      return true;
    };

    const sendResponseCreate = (request: ResponseCreateRequest): boolean => {
      if (request.speechGeneration !== speechGeneration) {
        return true;
      }
      if (!flushConfiguration()) return false;
      if (
        request.speechMessage !== undefined &&
        !sendBackendConversationItem(
          request.speechMessage,
          request.authority === 'proactive' ||
            request.authority === 'proactive_repair'
            ? ''
            : REALTIME_SPEAK_TO_USER_PREFIX,
        )
      ) {
        return false;
      }
      pendingResponseCreate = request;
      if (
        sendJson({
          type: 'response.create',
          response: {
            ...(responseInstructions
              ? { instructions: effectiveInstructions }
              : {}),
            modalities:
              request.authority === 'proactive_repair'
                ? ['text']
                : ['text', 'audio'],
          },
        })
      ) {
        armResponseCreatedTimer(request);
        return true;
      }
      pendingResponseCreate = undefined;
      clearResponseCreatedTimer();
      return false;
    };

    const requestResponseCreate = (
      authority: RealtimeResponseAuthority,
      speechMessage?: string,
      inputItemId?: string,
      repairAllowedToolNames?: ReadonlySet<string>,
      toolCapability: RealtimeToolCapability = authority === 'direct' &&
      inputItemId !== undefined
        ? 'direct'
        : 'none',
    ): boolean => {
      if (authority !== 'direct' && directResponsePending) {
        if (
          speechMessage !== undefined &&
          !sendBackendConversationItem(
            speechMessage,
            REALTIME_MERGED_SPEECH_PREFIX,
          )
        ) {
          return false;
        }
        // The direct request has left the socket but has not been accepted by
        // the provider yet. Cancel and replace it so the merged item, which is
        // ordered after that first request on the wire, is guaranteed to be in
        // the response context instead of becoming a second spoken turn.
        if (
          pendingResponseCreate?.authority === 'direct' &&
          !pendingResponseCreate.cancelled
        ) {
          const pendingDirect = pendingResponseCreate;
          pendingDirect.cancelled = true;
          pendingDirect.cancellationReason = 'superseded';
          responseCreateQueue.unshift({
            requestId: randomUUID(),
            authority: 'direct',
            ...(pendingDirect.inputItemId
              ? { inputItemId: pendingDirect.inputItemId }
              : {}),
            speechGeneration,
            cancelled: false,
            toolCapability: pendingDirect.toolCapability,
          });
        }
        return true;
      }
      const request = {
        requestId: randomUUID(),
        authority,
        ...(speechMessage !== undefined ? { speechMessage } : {}),
        ...(inputItemId !== undefined ? { inputItemId } : {}),
        ...(repairAllowedToolNames !== undefined
          ? { repairAllowedToolNames }
          : {}),
        speechGeneration,
        cancelled: false,
        toolCapability,
      };
      if (pendingResponseCreate || activeResponseId) {
        responseCreateQueue.push(request);
        return true;
      }
      return sendResponseCreate(request);
    };

    const flushResponseCreate = (): void => {
      if (pendingResponseCreate || activeResponseId) {
        return;
      }
      if (!flushConfiguration()) return;
      const next = responseCreateQueue.shift();
      if (!next) return;
      if (next.cancelled) {
        queueMicrotask(flushResponseCreate);
        return;
      }
      sendResponseCreate(next);
    };

    const maybeRequestToolContinuation = (responseId: string): void => {
      if (
        [...pendingCalls.values()].some(
          (call) => call.responseId === responseId,
        )
      ) {
        return;
      }
      const continuation = toolContinuationStates.get(responseId);
      if (!continuation) return;
      toolContinuationStates.delete(responseId);
      if (continuation.speechGeneration !== speechGeneration) return;
      requestResponseCreate(
        'tool_continuation',
        undefined,
        continuation.inputItemId,
        undefined,
        continuation.toolCapability,
      );
    };

    const sendBackendConversationItem = (
      text: string,
      prefix = REALTIME_BACKEND_TEXT_PREFIX,
    ): boolean =>
      sendJson({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `${prefix}${text}`,
            },
          ],
        },
      });

    const queueFunctionCallOutput = (
      call: PendingFunctionCall,
      output: string,
    ): boolean => {
      if (call.outputSubmitted || call.pendingOutput) return false;
      if (!call.responseCompleted && activeResponseId === call.responseId) {
        call.pendingOutput = { output };
        return true;
      }
      if (!sendFunctionCallOutput(call, output)) return false;
      return true;
    };

    const completePendingCallsForResponse = (
      responseId: string,
      status: string | undefined,
    ): void => {
      if (status === 'failed' || status === 'cancelled') {
        toolContinuationStates.delete(responseId);
      }
      for (const [callId, call] of [...pendingCalls]) {
        if (call.responseId !== responseId) continue;
        call.responseCompleted = true;
        if (status === 'failed' || !call.dispatched || call.repairDeferred) {
          pendingCalls.delete(callId);
          continue;
        }
        const pendingOutput = call.pendingOutput;
        if (!pendingOutput) continue;
        call.pendingOutput = undefined;
        if (!sendFunctionCallOutput(call, pendingOutput.output) && !terminal) {
          fail(
            new QwenRealtimeError(
              'Realtime function output could not be sent.',
              'function_output_send_failed',
              true,
              { kind: 'transient' },
            ),
          );
          return;
        }
      }
      maybeRequestToolContinuation(responseId);
    };

    const rememberCompletedInputTranscript = (
      itemId: string,
      transcript: string,
    ): boolean => {
      if (consumedInputItemIds.has(itemId)) return false;
      const existing = completedInputTranscripts.get(itemId);
      if (existing !== undefined) {
        protocolError(
          'Realtime provider supplied multiple final transcripts for one input.',
          'ambiguous_final_transcript',
        );
        return false;
      }
      if (
        completedInputTranscripts.size >= MAX_TRACKED_INPUT_ITEMS &&
        !completedInputTranscripts.has(itemId)
      ) {
        protocolError(
          'Realtime provider created too many pending final transcripts.',
          'too_many_pending_inputs',
        );
        return false;
      }
      completedInputTranscripts.set(itemId, transcript);
      return true;
    };

    const consumeInputItem = (itemId: string): void => {
      completedInputTranscripts.delete(itemId);
      committedInputItemIds.delete(itemId);
      collectedDirectInputItemIds.delete(itemId);
      consumedInputItemIds.add(itemId);
      while (consumedInputItemIds.size > MAX_TRACKED_INPUT_ITEMS) {
        const oldest = consumedInputItemIds.values().next().value;
        if (typeof oldest !== 'string') break;
        consumedInputItemIds.delete(oldest);
      }
    };

    const consumeResponseInput = (responseId: string): string | undefined => {
      responseWithTools.delete(responseId);
      dialoguePrefixes.delete(responseId);
      const itemId = responseInputItemIds.get(responseId);
      responseInputItemIds.delete(responseId);
      if (itemId) consumeInputItem(itemId);
      return itemId;
    };

    const pushTranscriptEntry = (entry: RealtimeTranscriptEntry): void => {
      transcriptEntries.push(entry);
      // Long stretches without a capturing handoff must not grow the
      // retained transcript without bound: evict the oldest entries past a
      // fixed cap.
      while (transcriptEntries.length > MAX_RETAINED_TRANSCRIPT_ENTRIES) {
        transcriptEntries.shift();
      }
    };

    const appendTranscriptDelta = (
      role: RealtimeTranscriptEntry['role'],
      delta: string,
      forceNew: boolean,
    ): void => {
      if (!delta) return;
      const last = transcriptEntries.at(-1);
      if (!forceNew && last?.role === role) {
        last.text += delta;
        return;
      }
      pushTranscriptEntry({ role, text: delta });
    };

    const applyTranscriptDone = (
      role: RealtimeTranscriptEntry['role'],
      text: string,
      forceNew: boolean,
    ): void => {
      if (!text) return;
      const last = transcriptEntries.at(-1);
      if (!forceNew && last?.role === role) {
        last.text = text;
        return;
      }
      pushTranscriptEntry({ role, text });
    };

    const deliverDirectTranscript = (
      entries: readonly RealtimeTranscriptEntry[],
      responseId?: string,
      inputItemId?: string,
    ): void => {
      if (entries.length === 0) return;
      const copiedEntries = entries.map((entry) => ({ ...entry }));
      if (!callbacks.onDirectTranscript) {
        pendingDirectTranscriptEntries.push(...copiedEntries);
        return;
      }
      if (
        !callback(() =>
          callbacks.onDirectTranscript?.({
            callEpoch: config.callEpoch,
            ...(responseId ? { responseId } : {}),
            ...(inputItemId ? { inputItemId } : {}),
            entries: copiedEntries,
          }),
        )
      ) {
        pendingDirectTranscriptEntries.push(...copiedEntries);
      }
    };

    const collectDirectTranscript = (responseId: string): void => {
      if (
        collectedDirectResponseIds.has(responseId) ||
        responseAuthorities.get(responseId) !== 'direct' ||
        delegatedResponseIds.has(responseId)
      ) {
        return;
      }
      const inputItemId = responseInputItemIds.get(responseId);
      const input = inputItemId
        ? completedInputTranscripts.get(inputItemId)
        : undefined;
      const output = responseOutputText.get(responseId);
      const assistant = output?.audioTranscript || output?.text;
      const entries: RealtimeTranscriptEntry[] = [];
      if (inputItemId && input?.trim()) {
        collectedDirectInputItemIds.add(inputItemId);
        entries.push({ role: 'user', text: input });
      }
      if (assistant?.trim()) {
        entries.push({ role: 'assistant', text: assistant });
      }
      if (entries.length === 0) return;
      collectedDirectResponseIds.add(responseId);
      deliverDirectTranscript(entries, responseId, inputItemId);
    };

    const collectDialogueResponse = (
      responseId: string,
      interrupted = false,
    ): void => {
      if (
        dialogueResponses.has(responseId) ||
        responseToolCapabilities.get(responseId) !== 'direct'
      )
        return;
      const inputItemId = responseInputItemIds.get(responseId);
      const output = responseOutputText.get(responseId);
      const text = [
        dialoguePrefixes.get(responseId),
        output?.audioTranscript || output?.text,
      ]
        .filter(Boolean)
        .join('\n');
      if (!inputItemId || !text) return;
      dialogueResponses.add(responseId);
      if (dialogueResponses.size > MAX_TRACKED_INPUT_ITEMS)
        dialogueResponses.delete(dialogueResponses.values().next().value!);
      callback(() =>
        callbacks.onDialogue?.({
          callEpoch: config.callEpoch,
          inputItemId,
          role: 'assistant',
          text,
          source:
            responseWithTools.has(responseId) && !interrupted
              ? 'filler'
              : 'normal',
          interrupted,
        }),
      );
    };

    const collectDialogueInput = (itemId: string, text: string): void => {
      if (dialogueInputs.has(itemId)) return;
      dialogueInputs.add(itemId);
      if (dialogueInputs.size > MAX_TRACKED_INPUT_ITEMS)
        dialogueInputs.delete(dialogueInputs.values().next().value!);
      callback(() =>
        callbacks.onDialogue?.({
          callEpoch: config.callEpoch,
          inputItemId: itemId,
          role: 'user',
          text,
        }),
      );
    };

    const takeTranscriptTail = (): readonly RealtimeTranscriptEntry[] => {
      for (const responseId of responseAuthorities.keys()) {
        collectDirectTranscript(responseId);
      }
      const delegatedInputItemIds = new Set(
        [...delegatedResponseIds]
          .map((responseId) => responseInputItemIds.get(responseId))
          .filter((itemId): itemId is string => itemId !== undefined),
      );
      for (const [itemId, text] of completedInputTranscripts) {
        if (
          collectedDirectInputItemIds.has(itemId) ||
          delegatedInputItemIds.has(itemId) ||
          !text.trim()
        ) {
          continue;
        }
        collectedDirectInputItemIds.add(itemId);
        deliverDirectTranscript([{ role: 'user', text }]);
      }
      return pendingDirectTranscriptEntries.splice(0).map((entry) => ({
        ...entry,
      }));
    };

    const takeHandoffTranscriptTail =
      (): readonly RealtimeTranscriptEntry[] => {
        const tail = transcriptEntries.map((entry) => ({ ...entry }));
        // Everything up to here has now been handed off and is never read
        // again; drop the consumed entries (instead of only advancing a
        // cursor) so retention and the dedup scan in takeHandoffTranscript
        // stay bounded by one capture window, not the whole call history.
        transcriptEntries.length = 0;
        return tail;
      };

    const updateResponseOutputText = (
      responseId: string,
      source: RealtimeOutputTextEvent['source'],
      text: string,
      done: boolean,
    ): void => {
      const current = responseOutputText.get(responseId) ?? {
        text: '',
        audioTranscript: '',
      };
      const key = source === 'audio_transcript' ? 'audioTranscript' : 'text';
      current[key] = done ? text : `${current[key]}${text}`;
      responseOutputText.set(responseId, current);
    };

    const takeHandoffTranscript = (
      input: string,
    ): readonly RealtimeTranscriptEntry[] => {
      const trimmed = input.trim();
      if (
        trimmed &&
        !transcriptEntries.some(
          (entry) => entry.role === 'user' && entry.text.trim() === trimmed,
        )
      ) {
        pushTranscriptEntry({ role: 'user', text: trimmed });
      }
      const transcript = takeHandoffTranscriptTail();
      newInputEntry = true;
      newOutputEntry = true;
      return transcript;
    };

    const bindResponseInput = (responseId: string): boolean => {
      if (responseInputItemIds.has(responseId)) return true;
      const boundInputItemIds = new Set(responseInputItemIds.values());
      const candidates = [...committedInputItemIds].filter(
        (itemId) =>
          !boundInputItemIds.has(itemId) && !consumedInputItemIds.has(itemId),
      );
      if (candidates.length > 1) {
        protocolError(
          'Realtime response could not be associated with one unique input.',
          'ambiguous_input_transcript',
        );
        return false;
      }
      const itemId = candidates[0];
      if (!itemId) return false;
      responseInputItemIds.set(responseId, itemId);
      return true;
    };

    const finalizeCancelledResponse = (responseId: string): void => {
      if (activeResponseId === responseId) clearResponseDoneTimer();
      if (!cancelledResponseIds.has(responseId)) {
        markResponseCancelled(responseId);
      }
      const authority =
        responseAuthorities.get(responseId) ??
        (activeResponseId === responseId
          ? activeResponseAuthority
          : undefined) ??
        'direct';
      const cancellationReason = cancelledResponseReasons.get(responseId);
      const responseInputItemId = responseInputItemIds.get(responseId);
      collectDialogueResponse(responseId, true);
      collectDirectTranscript(responseId);
      completePendingCallsForResponse(responseId, 'cancelled');
      consumeResponseInput(responseId);
      if (activeResponseId === responseId) {
        activeResponseId = undefined;
        activeResponseAuthority = undefined;
      }
      if (activeAudioResponseId === responseId) {
        activeAudioResponseId = undefined;
      }
      lastCompletedResponseId = responseId;
      cancelledResponseIds.delete(responseId);
      callback(() =>
        callbacks.onResponseDone?.({
          callEpoch: config.callEpoch,
          responseId,
          ...(responseInputItemId ? { inputItemId: responseInputItemId } : {}),
          status: 'cancelled',
          authority,
          ...(cancellationReason ? { cancellationReason } : {}),
        }),
      );
      cancelledResponseReasons.delete(responseId);
      responseAuthorities.delete(responseId);
      responseToolCapabilities.delete(responseId);
      repairToolAllowlists.delete(responseId);
      delegatedResponseIds.delete(responseId);
      responseOutputText.delete(responseId);
      collectedDirectResponseIds.delete(responseId);
      queueMicrotask(flushResponseCreate);
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

    const isProactiveRepairResponse = (responseId: string): boolean =>
      responseAuthorities.get(responseId) === 'proactive_repair';

    const commitInputItem = (
      message: ProviderMessage,
      type: string,
      itemId: string,
    ): void => {
      if (
        committedInputItemIds.has(itemId) ||
        consumedInputItemIds.has(itemId)
      ) {
        pendingSpeechItemIds.delete(itemId);
        ignoreEvent(message, type, 'duplicate_event');
        return;
      }
      if (committedInputItemIds.size >= MAX_TRACKED_INPUT_ITEMS) {
        protocolError(
          'Realtime provider created too many pending input items.',
          'too_many_pending_inputs',
        );
        return;
      }
      pendingSpeechItemIds.delete(itemId);
      speechInputInProgress = false;
      speechCommitPending = false;
      if (!speechGenerationAdvancedForInput) speechGeneration += 1;
      speechGenerationAdvancedForInput = false;
      const activeDirectResponse =
        activeResponseId !== undefined &&
        activeResponseAuthority === 'direct' &&
        !cancelledResponseIds.has(activeResponseId);
      if (!activeDirectResponse) {
        directResponsePending = true;
      }
      lastCompletedResponseId = undefined;
      committedInputItemIds.add(itemId);
      if (
        activeDirectResponse &&
        activeResponseId &&
        !bindResponseInput(activeResponseId)
      ) {
        return;
      }
      callback(() =>
        callbacks.onInputCommitted?.({
          ...eventContext(message),
          itemId,
          responsePending: !activeDirectResponse,
        }),
      );
      if (terminal) return;
      if (activeDirectResponse) {
        directResponsePending = false;
        if (activeResponseId) {
          responseToolCapabilities.set(activeResponseId, 'direct');
        }
      } else if (directResponsePending) {
        requestResponseCreate('direct', undefined, itemId);
      }
    };

    /**
     * Best-effort extraction of the user-request text from a tool-call
     * argument payload. Only used to augment the captured transcript for
     * `capturesTranscript` tools (ASR may lag behind the model's call); the
     * raw argument string is always handed to the orchestrator untouched.
     */
    const extractInputTranscript = (rawArguments: string): string => {
      if (rawArguments.length === 0) return '';
      try {
        const parsed = JSON.parse(rawArguments) as unknown;
        if (isRecord(parsed)) {
          for (const key of [
            'task',
            'input_transcript',
            'input',
            'text',
            'prompt',
            'query',
          ]) {
            const value = parsed[key];
            if (typeof value === 'string' && value.trim()) {
              return value.trim();
            }
          }
        }
      } catch {
        /* match the Codex V2 parser: use raw arguments when JSON is invalid */
      }
      return '';
    };

    const dispatchFunctionCall = (
      message: ProviderMessage,
      call: PendingFunctionCall,
      rawArguments: string,
    ): void => {
      if (call.dispatched) {
        if (call.arguments !== rawArguments) {
          protocolError(
            'Realtime model changed a function call after dispatch.',
            'ambiguous_handoff',
          );
        }
        return;
      }
      if (repairToolAllowlists.has(call.responseId)) {
        call.arguments = rawArguments;
        call.dispatched = true;
        call.repairDeferred = true;
        call.repairEventId = optionalString(message.event_id);
        return;
      }
      if (call.name === REMAIN_SILENT_TOOL_NAME) {
        call.arguments = rawArguments;
        call.dispatched = true;
        queueFunctionCallOutput(call, '');
        return;
      }
      const toolCapability =
        responseToolCapabilities.get(call.responseId) ?? 'none';
      const tool = call.name ? toolsByName.get(call.name) : undefined;
      if (toolCapability !== 'direct') {
        call.arguments = rawArguments;
        call.dispatched = true;
        queueFunctionCallOutput(call, RESPONSE_TOOL_REJECTION_OUTPUT);
        return;
      }
      responseWithTools.add(call.responseId);
      if (!tool) {
        // A tool the config never declared: answer with an error receipt so
        // the model can recover aloud instead of waiting on a call that no
        // handler will ever complete.
        call.arguments = rawArguments;
        call.dispatched = true;
        toolContinuationStates.set(call.responseId, {
          speechGeneration: call.speechGeneration,
          toolCapability,
          inputItemId: responseInputItemIds.get(call.responseId),
        });
        queueFunctionCallOutput(
          call,
          JSON.stringify({
            status: 'error',
            note: `Unknown tool: ${call.name ?? '(unnamed)'}`,
          }),
        );
        return;
      }
      call.arguments = rawArguments;
      call.dispatched = true;
      if (tool.continuesResponse) {
        toolContinuationStates.set(call.responseId, {
          speechGeneration: call.speechGeneration,
          toolCapability,
          inputItemId: responseInputItemIds.get(call.responseId),
        });
      }
      let activeTranscript: readonly RealtimeTranscriptEntry[] = [];
      if (tool.capturesTranscript) {
        activeTranscript = takeHandoffTranscript(
          extractInputTranscript(rawArguments),
        );
        delegatedResponseIds.add(call.responseId);
      }
      callback(() =>
        callbacks.onFunctionCall?.({
          ...eventContext(message),
          responseId: call.responseId,
          inputItemId: responseInputItemIds.get(call.responseId),
          itemId: call.itemId,
          callId: call.callId,
          name: call.name ?? '',
          arguments: rawArguments,
          activeTranscript,
        }),
      );
    };

    const dispatchCompletedRepairCalls = (responseId: string): void => {
      const allowlist = repairToolAllowlists.get(responseId);
      if (!allowlist) return;
      let authorizedCallDispatched = false;
      for (const call of pendingCalls.values()) {
        if (call.responseId !== responseId || !call.repairDeferred) continue;
        call.repairDeferred = false;
        const name = call.name ?? '';
        const authorized =
          !authorizedCallDispatched &&
          allowlist.has(name) &&
          toolsByName.has(name);
        if (!authorized) {
          queueFunctionCallOutput(call, PROACTIVE_REPAIR_REJECTION_OUTPUT);
          continue;
        }
        authorizedCallDispatched = true;
        toolContinuationStates.set(responseId, {
          speechGeneration: call.speechGeneration,
          toolCapability: 'none',
        });
        callback(() =>
          callbacks.onFunctionCall?.({
            callEpoch: config.callEpoch,
            ...(call.repairEventId ? { eventId: call.repairEventId } : {}),
            responseId,
            itemId: call.itemId,
            callId: call.callId,
            name,
            arguments: call.arguments,
            activeTranscript: [],
          }),
        );
        if (terminal) return;
      }
    };

    const session: QwenRealtimeSession = {
      callEpoch: config.callEpoch,
      closed,
      flushDialogue: () => {
        if (activeResponseId) collectDialogueResponse(activeResponseId, true);
      },
      configure: (update) => {
        if (terminal || closedByClient) return false;
        if (
          typeof update.instructions !== 'string' ||
          update.instructions.length > 100_000
        )
          throw new RangeError(
            'Realtime instructions exceed the supported size.',
          );
        const changed =
          effectiveInstructions !== update.instructions ||
          JSON.stringify(effectiveTools) !== JSON.stringify(update.tools);
        effectiveInstructions = update.instructions;
        effectiveTools = [...update.tools];
        toolsByName.clear();
        for (const tool of effectiveTools)
          toolsByName.set(tool.function.name, tool);
        configurationDirty ||= changed;
        responseInstructions = true;
        return flushConfiguration();
      },
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
        const sent = sendJson({
          type: 'input_audio_buffer.append',
          audio: Buffer.from(pcm16).toString('base64'),
        });
        if (sent) hasSentInputAudio = true;
        return sent;
      },
      pushImage: (jpegBase64) => {
        if (!isBoundedJpegBase64(jpegBase64)) {
          throw new RangeError(
            'Realtime image input must be a bounded JPEG base64 frame.',
          );
        }
        if (!hasSentInputAudio) return dropImage('audio_not_started');
        if (terminal || closedByClient || ws.readyState !== ws.OPEN) {
          return dropImage('connection_unavailable');
        }
        if (
          (ws.bufferedAmount ?? 0) > QWEN_REALTIME_LIMITS.maxBufferedSocketBytes
        ) {
          return dropImage('socket_backpressure');
        }
        return sendJson({
          type: 'input_image_buffer.append',
          image: jpegBase64,
        });
      },
      commitInputAudio: () => sendJson({ type: 'input_audio_buffer.commit' }),
      clearInputAudio: () => {
        const sent = sendJson({ type: 'input_audio_buffer.clear' });
        if (sent) {
          speechInputInProgress = false;
          speechCommitPending = false;
          speechGenerationAdvancedForInput = false;
          directResponsePending = false;
          pendingSpeechItemIds.clear();
        }
        return sent;
      },
      cancelResponse: () => {
        if (!activeResponseId || cancelledResponseIds.has(activeResponseId)) {
          return false;
        }
        const responseId = activeResponseId;
        clearResponseDoneTimer();
        markResponseCancelled(responseId, false, 'client_cancelled');
        const sent = sendJson({ type: 'response.cancel' });
        finalizeCancelledResponse(responseId);
        return sent;
      },
      submitFunctionOutput: (ref, output) => {
        const call = pendingCalls.get(ref.callId);
        if (
          ref.callEpoch !== config.callEpoch ||
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
        if (
          typeof output !== 'string' ||
          output.trim().length === 0 ||
          output.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars
        ) {
          throw new RangeError(
            'Realtime function output exceeded the allowed size.',
          );
        }
        return queueFunctionCallOutput(call, output);
      },
      sendBackendContext: (text) => {
        if (
          typeof text !== 'string' ||
          text.trim().length === 0 ||
          text.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars
        ) {
          throw new RangeError(
            'Realtime backend context exceeded the allowed size.',
          );
        }
        if (terminal || closedByClient) return false;
        return sendBackendConversationItem(text);
      },
      speakToUser: (message) => {
        if (
          typeof message !== 'string' ||
          message.trim().length === 0 ||
          message.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars
        ) {
          throw new RangeError(
            'Realtime speech request exceeded the allowed size.',
          );
        }
        if (terminal || closedByClient) return false;
        return requestResponseCreate('backend_speech', message);
      },
      respondToProactiveEvent: (event) => {
        if (
          typeof event !== 'string' ||
          event.trim().length === 0 ||
          event.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars
        ) {
          throw new RangeError(
            'Realtime Proactive event exceeded the allowed size.',
          );
        }
        if (terminal || closedByClient) return false;
        // Injector owns Proactive retry/FIFO ordering. Never admit one into
        // Realtime's private response queue: queued requests can be discarded
        // by a later speech_started event without a response.done callback,
        // which would leave Injector waiting forever for that delivery.
        if (
          responseCreatedInProgress ||
          directResponsePending ||
          pendingResponseCreate !== undefined ||
          activeResponseId !== undefined ||
          toolContinuationStates.size > 0 ||
          responseCreateQueue.length > 0
        ) {
          return false;
        }
        return requestResponseCreate('proactive', event);
      },
      requestProactiveRepair: (instruction, allowedToolNames) => {
        if (
          typeof instruction !== 'string' ||
          instruction.trim().length === 0 ||
          instruction.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars
        ) {
          throw new RangeError(
            'Realtime Proactive repair instruction exceeded the allowed size.',
          );
        }
        const allowlist = new Set(allowedToolNames);
        if (
          allowlist.size === 0 ||
          allowlist.size > QWEN_REALTIME_LIMITS.maxPendingFunctionCalls ||
          [...allowlist].some(
            (name) =>
              typeof name !== 'string' ||
              name.length === 0 ||
              name.length > QWEN_REALTIME_LIMITS.maxIdentifierChars ||
              !toolsByName.has(name),
          )
        ) {
          throw new RangeError(
            'Realtime Proactive repair tools must be a bounded allowlist of declared tools.',
          );
        }
        if (
          terminal ||
          closedByClient ||
          speechInputInProgress ||
          speechCommitPending ||
          directResponsePending ||
          pendingResponseCreate !== undefined ||
          activeResponseId !== undefined ||
          toolContinuationStates.size > 0 ||
          responseCreateQueue.length > 0
        ) {
          return false;
        }
        return requestResponseCreate(
          'proactive_repair',
          instruction,
          undefined,
          allowlist,
        );
      },
      takeTranscriptTail,
      close: (options) => {
        if (closedByClient || terminal) return;
        if (!options?.discardPendingInput) {
          const inputLossError = pendingInputLossError();
          if (inputLossError) {
            fail(inputLossError);
            return;
          }
        }
        closedByClient = true;
        if (activeResponseId) collectDialogueResponse(activeResponseId, true);
        clearConnectTimer();
        clearResponseTimers();
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
          ...(config.model === 'qwen3.5-omni-plus-realtime' ||
          config.model === 'qwen3.5-omni-flash-realtime'
            ? {
                audio: {
                  input: { format: { type: 'pcm', sample_rate: 16_000 } },
                  output: { format: { type: 'pcm', sample_rate: 24_000 } },
                },
              }
            : { input_audio_format: 'pcm', output_audio_format: 'pcm' }),
          input_audio_transcription: {
            model: 'qwen3-asr-flash-realtime',
          },
          instructions: effectiveInstructions,
          turn_detection: {
            type: 'semantic_vad',
            create_response: false,
            interrupt_response: true,
          },
          // Strip local-only behavior flags from the wire shape.
          tools: effectiveTools.map((tool) => ({
            type: tool.type,
            function: tool.function,
          })),
          tool_choice: 'auto',
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

      protocolDebug(message, type);
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
          const supersededInputItemIds = new Set<string>();
          pendingSpeechItemIds.clear();
          if (itemId) pendingSpeechItemIds.add(itemId);
          newInputEntry = true;
          speechInputInProgress = true;
          speechCommitPending = true;
          directResponsePending = true;
          if (!speechGenerationAdvancedForInput) {
            speechGeneration += 1;
            speechGenerationAdvancedForInput = true;
          }
          for (const request of responseCreateQueue) {
            if (request.authority === 'direct' && request.inputItemId) {
              supersededInputItemIds.add(request.inputItemId);
            }
            if (request.speechMessage !== undefined) {
              sendBackendConversationItem(
                request.speechMessage,
                REALTIME_MERGED_SPEECH_PREFIX,
              );
            }
          }
          responseCreateQueue = [];
          if (pendingResponseCreate) {
            if (
              pendingResponseCreate.authority === 'direct' &&
              pendingResponseCreate.inputItemId
            ) {
              supersededInputItemIds.add(pendingResponseCreate.inputItemId);
            }
            pendingResponseCreate.cancelled = true;
            pendingResponseCreate.cancellationReason = 'user_interrupted';
          }
          for (const supersededInputItemId of supersededInputItemIds) {
            consumeInputItem(supersededInputItemId);
          }
          if (
            !callback(() =>
              callbacks.onSpeechStarted?.({
                ...eventContext(message),
                itemId,
                audioStartMs: optionalFiniteNumber(message['audio_start_ms']),
              }),
            )
          ) {
            break;
          }
          if (activeResponseId && !cancelledResponseIds.has(activeResponseId)) {
            const interruptedResponseId = activeResponseId;
            collectDialogueResponse(interruptedResponseId, true);
            callback(() =>
              callbacks.onBargeIn?.({
                ...eventContext(message),
                responseId: interruptedResponseId,
              }),
            );
            markResponseCancelled(
              interruptedResponseId,
              true,
              'user_interrupted',
            );
          }
          break;
        }
        case 'input_audio_buffer.speech_stopped': {
          const itemId = optionalString(message['item_id']);
          speechInputInProgress = false;
          callback(() =>
            callbacks.onSpeechStopped?.({
              ...eventContext(message),
              itemId,
              audioEndMs: optionalFiniteNumber(message['audio_end_ms']),
            }),
          );
          break;
        }
        case 'conversation.item.created': {
          const item = isRecord(message['item']) ? message['item'] : undefined;
          const itemId = optionalString(item?.['id']);
          const content = Array.isArray(item?.['content'])
            ? item['content']
            : [];
          const isPendingAudioInput =
            itemId !== undefined &&
            item?.['type'] === 'message' &&
            content.some(
              (part) => isRecord(part) && part['type'] === 'input_audio',
            ) &&
            (pendingSpeechItemIds.has(itemId) ||
              (speechCommitPending && pendingSpeechItemIds.size === 0));
          if (isPendingAudioInput) {
            commitInputItem(message, type, itemId);
          }
          break;
        }
        case 'input_audio_buffer.committed': {
          const itemId = optionalString(message['item_id']);
          if (!itemId) {
            protocolError(
              'Realtime committed input omitted its identifier.',
              'invalid_input_item',
            );
            break;
          }
          commitInputItem(message, type, itemId);
          break;
        }
        case 'conversation.item.input_audio_transcription.delta':
        case 'conversation.item.input_audio_transcription.text': {
          const itemId = optionalString(message['item_id']);
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
          const transcriptText = `${text}${stash}`;
          if (type === 'conversation.item.input_audio_transcription.delta') {
            appendTranscriptDelta('user', transcriptText, newInputEntry);
          } else {
            applyTranscriptDone('user', transcriptText, newInputEntry);
          }
          newInputEntry = false;
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
          if (itemId && consumedInputItemIds.has(itemId)) {
            const transcript = optionalString(
              message['transcript'],
              QWEN_REALTIME_LIMITS.maxTranscriptChars,
            );
            if (transcript !== undefined)
              collectDialogueInput(itemId, transcript);
            // A benign late final: barge-in or response.done already consumed
            // this input before the ASR stream delivered its transcript. Drop
            // it instead of treating a healthy call as a protocol violation.
            ignoreEvent(message, type, 'stale_input');
            break;
          }
          if (!itemId || !committedInputItemIds.has(itemId)) {
            protocolError(
              'Realtime final transcript had no committed input item.',
              'unattributed_final_transcript',
            );
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
          if (!rememberCompletedInputTranscript(itemId, transcript)) break;
          collectDialogueInput(itemId, transcript);
          applyTranscriptDone('user', transcript, newInputEntry);
          newInputEntry = false;
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
          const itemId = optionalString(message['item_id']);
          if (
            itemId &&
            (committedInputItemIds.has(itemId) ||
              consumedInputItemIds.has(itemId))
          )
            collectDialogueInput(itemId, '');
          const error = isRecord(message['error'])
            ? message['error']
            : undefined;
          const inputLossError = pendingInputLossError();
          if (inputLossError) {
            fail(inputLossError);
          } else {
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
          }
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
          responseCreatedInProgress = true;
          try {
            const responseRequest = pendingResponseCreate;
            let splitResponseInputItemId: string | undefined;
            let splitDialogueText: string | undefined;
            let supersededResponseId: string | undefined;
            if (activeResponseId && activeResponseId !== responseId) {
              supersededResponseId = activeResponseId;
              const supersededInputItemId =
                responseInputItemIds.get(supersededResponseId);
              if (
                responseRequest === undefined &&
                activeResponseAuthority === 'direct' &&
                !cancelledResponseIds.has(supersededResponseId) &&
                supersededInputItemId !== undefined &&
                committedInputItemIds.has(supersededInputItemId)
              ) {
                const boundInputItemIds = new Set(
                  responseInputItemIds.values(),
                );
                const hasNewUnboundInput = [...committedInputItemIds].some(
                  (itemId) =>
                    itemId !== supersededInputItemId &&
                    !boundInputItemIds.has(itemId),
                );
                if (!hasNewUnboundInput) {
                  // Some providers split one direct answer across consecutive
                  // responses without issuing another response.create request.
                  // Preserve the real microphone capability for that same turn
                  // instead of consuming it with the superseded segment.
                  splitResponseInputItemId = supersededInputItemId;
                  const priorOutput =
                    responseOutputText.get(supersededResponseId);
                  splitDialogueText = [
                    dialoguePrefixes.get(supersededResponseId),
                    priorOutput?.audioTranscript || priorOutput?.text,
                  ]
                    .filter(Boolean)
                    .join('\n');
                  responseInputItemIds.delete(supersededResponseId);
                }
              }
              clearResponseDoneTimer();
              markResponseCancelled(supersededResponseId, false, 'superseded');
            }
            clearResponseCreatedTimer();
            const responseAuthority: RealtimeResponseAuthority =
              responseRequest?.authority ?? 'direct';
            activeResponseId = responseId;
            activeResponseAuthority = responseAuthority;
            responseAuthorities.set(responseId, responseAuthority);
            if (splitDialogueText)
              dialoguePrefixes.set(responseId, splitDialogueText);
            newOutputEntry = true;
            pendingResponseCreate = undefined;
            activeAudioResponseId = undefined;
            if (responseRequest) {
              armResponseDoneTimer(responseRequest, responseId);
            }
            // Register the replacement before notifying observers that the
            // prior response ended. Those callbacks may synchronously enqueue
            // another response, which must queue behind this provider-created
            // response instead of being mistaken for it.
            if (supersededResponseId) {
              finalizeCancelledResponse(supersededResponseId);
              if (terminal || closedByClient) break;
            }
            if (responseRequest?.cancelled) {
              markResponseCancelled(
                responseId,
                true,
                responseRequest.cancellationReason ?? 'superseded',
              );
              sendJson({ type: 'response.cancel' });
              break;
            }
            if (
              responseAuthority === 'proactive_repair' &&
              responseRequest?.repairAllowedToolNames
            ) {
              repairToolAllowlists.set(
                responseId,
                responseRequest.repairAllowedToolNames,
              );
            }
            if (
              responseAuthority === 'tool_continuation' &&
              responseRequest?.toolCapability === 'direct' &&
              responseRequest.inputItemId
            ) {
              responseInputItemIds.set(responseId, responseRequest.inputItemId);
            } else if (activeResponseAuthority === 'direct') {
              if (responseRequest?.inputItemId) {
                responseInputItemIds.set(
                  responseId,
                  responseRequest.inputItemId,
                );
              } else if (splitResponseInputItemId) {
                responseInputItemIds.set(responseId, splitResponseInputItemId);
              } else {
                bindResponseInput(responseId);
              }
              if (terminal) break;
            }
            const responseInputItemId = responseInputItemIds.get(responseId);
            const hasDirectInput =
              responseAuthority === 'direct' &&
              responseInputItemId !== undefined &&
              committedInputItemIds.has(responseInputItemId);
            responseToolCapabilities.set(
              responseId,
              hasDirectInput
                ? 'direct'
                : responseRequest?.toolCapability === 'direct' &&
                    responseAuthority === 'tool_continuation'
                  ? 'direct'
                  : 'none',
            );
            if (responseAuthority === 'direct') directResponsePending = false;
            const response = isRecord(message['response'])
              ? message['response']
              : undefined;
            callback(() =>
              callbacks.onResponseCreated?.({
                ...eventContext(message),
                responseId,
                ...(responseInputItemId
                  ? { inputItemId: responseInputItemId }
                  : {}),
                authority: responseAuthority,
                status: optionalString(response?.['status']),
              }),
            );
            break;
          } finally {
            responseCreatedInProgress = false;
          }
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
          if (isProactiveRepairResponse(responseId)) break;
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
          if (isProactiveRepairResponse(responseId)) break;
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
          if (isProactiveRepairResponse(responseId)) break;
          appendTranscriptDelta('assistant', delta, newOutputEntry);
          newOutputEntry = false;
          updateResponseOutputText(
            responseId,
            type.includes('audio_transcript') ? 'audio_transcript' : 'text',
            delta,
            false,
          );
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
          if (isProactiveRepairResponse(responseId)) break;
          applyTranscriptDone('assistant', text, newOutputEntry);
          newOutputEntry = false;
          updateResponseOutputText(
            responseId,
            type.includes('audio_transcript') ? 'audio_transcript' : 'text',
            text,
            true,
          );
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
              'Realtime model changed a handoff call after dispatch.',
              'ambiguous_handoff',
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
            responseCompleted: false,
            speechGeneration,
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
          if (isProactiveRepairResponse(responseId)) break;
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
                'Realtime model changed a handoff call after dispatch.',
                'ambiguous_handoff',
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
            responseCompleted: false,
            speechGeneration,
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
                'Realtime model changed a handoff call after dispatch.',
                'ambiguous_handoff',
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
            responseCompleted: false,
            speechGeneration,
          };
          call.name = name;
          pendingCalls.set(callId, call);
          dispatchFunctionCall(message, call, args);
          break;
        }
        case 'response.done': {
          const responseId =
            readResponseId(message, true) ??
            readResponseId(message) ??
            activeResponseId;
          if (!responseId) {
            if (lastCompletedResponseId) {
              ignoreEvent(message, type, 'stale_response');
              break;
            }
            protocolError(
              'Realtime response completion omitted its identifier.',
              'invalid_response',
            );
            break;
          }
          if (cancelledResponseIds.has(responseId)) {
            if (activeResponseId === responseId) clearResponseDoneTimer();
            const authority =
              responseAuthorities.get(responseId) ??
              activeResponseAuthority ??
              'direct';
            const cancellationReason = cancelledResponseReasons.get(responseId);
            const responseInputItemId = responseInputItemIds.get(responseId);
            collectDialogueResponse(responseId, true);
            collectDirectTranscript(responseId);
            cancelledResponseIds.delete(responseId);
            completePendingCallsForResponse(responseId, 'cancelled');
            consumeResponseInput(responseId);
            if (activeResponseId === responseId) {
              activeResponseId = undefined;
              activeResponseAuthority = undefined;
            }
            if (activeAudioResponseId === responseId) {
              activeAudioResponseId = undefined;
            }
            lastCompletedResponseId = responseId;
            callback(() =>
              callbacks.onResponseDone?.({
                ...eventContext(message),
                responseId,
                ...(responseInputItemId
                  ? { inputItemId: responseInputItemId }
                  : {}),
                status: 'cancelled',
                authority,
                ...(cancellationReason ? { cancellationReason } : {}),
              }),
            );
            cancelledResponseReasons.delete(responseId);
            queueMicrotask(flushResponseCreate);
            responseAuthorities.delete(responseId);
            responseToolCapabilities.delete(responseId);
            repairToolAllowlists.delete(responseId);
            delegatedResponseIds.delete(responseId);
            responseOutputText.delete(responseId);
            collectedDirectResponseIds.delete(responseId);
            break;
          }
          if (!isCurrentResponse(message, type, responseId)) break;
          clearResponseDoneTimer();
          const response = isRecord(message['response'])
            ? message['response']
            : undefined;
          const status = optionalString(response?.['status']);
          const responseAuthority =
            responseAuthorities.get(responseId) ??
            activeResponseAuthority ??
            'direct';
          const responseInputItemId = responseInputItemIds.get(responseId);
          if (activeResponseAuthority === 'direct' && status === 'failed') {
            const inputLossError = pendingInputLossError();
            if (inputLossError) fail(inputLossError);
            if (terminal) break;
          }
          if (status === 'completed') {
            dispatchCompletedRepairCalls(responseId);
            if (terminal) break;
          }
          completePendingCallsForResponse(responseId, status);
          collectDialogueResponse(
            responseId,
            status === 'cancelled' || status === 'failed',
          );
          collectDirectTranscript(responseId);
          lastCompletedResponseId = responseId;
          activeResponseId = undefined;
          activeResponseAuthority = undefined;
          activeAudioResponseId = undefined;
          consumeResponseInput(responseId);
          responseAuthorities.delete(responseId);
          responseToolCapabilities.delete(responseId);
          repairToolAllowlists.delete(responseId);
          delegatedResponseIds.delete(responseId);
          responseOutputText.delete(responseId);
          collectedDirectResponseIds.delete(responseId);
          callback(() =>
            callbacks.onResponseDone?.({
              ...eventContext(message),
              responseId,
              ...(responseInputItemId
                ? { inputItemId: responseInputItemId }
                : {}),
              status,
              authority: responseAuthority,
            }),
          );
          if (status === 'failed') {
            notifyError(responseFailureError(response, config.apiKey));
          }
          queueMicrotask(flushResponseCreate);
          break;
        }
        case 'rate_limits.updated':
        case 'rate_limit.updated': {
          break;
        }
        case 'error': {
          const providerError = isRecord(message['error'])
            ? message['error']
            : undefined;
          const code = optionalString(providerError?.['code']);
          const providerType = optionalString(providerError?.['type']);
          const param = optionalString(providerError?.['param']);
          const status = optionalHttpStatus(
            providerError?.['status'] ?? message['status'],
          );
          const errorMessage = sanitizeErrorText(
            providerError?.['message'] ??
              providerError?.['code'] ??
              'Qwen Realtime request failed.',
            config.apiKey,
          );
          const kind = classifyRealtimeErrorKind(code, errorMessage, status);
          fail(
            new QwenRealtimeError(errorMessage, code, true, {
              kind,
              status,
              providerType,
              param,
            }),
          );
          break;
        }
        default:
          break;
      }
    });

    ws.on('unexpected-response', (...args: unknown[]) => {
      const response = isRecord(args[1]) ? args[1] : undefined;
      const status = optionalHttpStatus(response?.['statusCode']);
      const on = response?.['on'];
      if (typeof on !== 'function') {
        fail(upgradeFailureError(status, '', config.apiKey));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let complete = false;
      const finish = () => {
        if (complete) return;
        complete = true;
        fail(
          upgradeFailureError(
            status,
            Buffer.concat(chunks).toString('utf8'),
            config.apiKey,
          ),
        );
      };
      on.call(response, 'data', (chunk: unknown) => {
        if (bytes >= MAX_ERROR_RESPONSE_BYTES) return;
        const data =
          typeof chunk === 'string'
            ? Buffer.from(chunk)
            : Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
              ? Buffer.from(chunk)
              : undefined;
        if (!data) return;
        const bounded = data.subarray(0, MAX_ERROR_RESPONSE_BYTES - bytes);
        chunks.push(bounded);
        bytes += bounded.byteLength;
      });
      on.call(response, 'end', finish);
      on.call(response, 'aborted', finish);
      on.call(response, 'error', finish);
    });

    ws.on('error', (rawError: unknown) => {
      const errorText = sanitizeErrorText(
        rawError instanceof Error ? rawError.message : rawError,
        config.apiKey,
      );
      const statusMatch = /unexpected server response:\s*(\d{3})/i.exec(
        errorText,
      );
      const status = optionalHttpStatus(statusMatch?.[1]);
      fail(
        new QwenRealtimeError(
          errorText,
          status ? `http_${status}` : 'socket_error',
          true,
          { status },
        ),
      );
    });

    ws.on('close', (...args: unknown[]) => {
      clearConnectTimer();
      clearResponseTimers();
      removeAbortListener();
      if (closedByClient || terminal) return;
      const inputLossError = pendingInputLossError();
      if (inputLossError) {
        fail(inputLossError);
        return;
      }
      const code = optionalFiniteNumber(args[0]);
      terminal = true;
      if (activeResponseId) collectDialogueResponse(activeResponseId, true);
      const reason = sanitizeErrorText(args[1], config.apiKey);
      const suffix = code ? ` (${code}${reason ? `: ${reason}` : ''})` : '';
      const reasonKind = classifyRealtimeErrorKind(undefined, reason);
      const error = new QwenRealtimeError(
        `Realtime connection closed unexpectedly${suffix}.`,
        'connection_closed',
        true,
        {
          kind:
            code !== undefined && [1001, 1006, 1011, 1012, 1013].includes(code)
              ? 'transient'
              : reasonKind,
          closeCode: code,
        },
      );
      if (!settled) {
        settled = true;
        reject(error);
      } else {
        notifyError(error);
      }
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
