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
  maxIdentifierChars: 256,
} as const;

const CONNECT_TIMEOUT_MS = 8000;
const MAX_ERROR_MESSAGE_CHARS = 300;
const MAX_RECENT_EVENT_IDS = 512;
const MAX_TRACKED_INPUT_ITEMS = 32;
const BACKGROUND_AGENT_TOOL_NAME = 'background_agent';
const REMAIN_SILENT_TOOL_NAME = 'remain_silent';
const REALTIME_BACKEND_TEXT_PREFIX = '[BACKEND] ';
const REALTIME_SPEAK_TO_USER_PREFIX = '[SPEAK_TO_USER] ';
const REALTIME_V2_HANDOFF_COMPLETE_ACKNOWLEDGEMENT =
  'Background agent finished. Use the preceding [BACKEND] messages as the result.';
const REALTIME_V2_STEER_ACKNOWLEDGEMENT =
  'This was sent to steer the previous background agent task.';
const BACKGROUND_AGENT_TOOL = {
  type: 'function',
  function: {
    name: BACKGROUND_AGENT_TOOL_NAME,
    description:
      "Send a user request to the execution agent attached to the current Live conversation. Use this as the default action. Do not rephrase the user's ask or rewrite it in your own words; pass along the user's own words. This tool starts or steers a backend turn in the same persistent Live session; it never creates a separate user-visible task, session, or conversation by itself. If the user asks to create, open, or start a separate task, session, or conversation, pass that exact request through so the execution agent can call create_thread. If the user asks to do something next, later, after this, or once current work finishes, call this tool so the work is actually queued instead of merely promising to do it later. Before invoking this function for the first time in a user turn, first output one short, concrete assistant speech sentence naming what you are about to check or do. The speech must be emitted before the function call; a tool-only response is invalid. Then invoke this function immediately without waiting for the user. If this function is steering an already active task, do not repeat the acknowledgement.",
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The user request to delegate to the background agent.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
} as const;
const REMAIN_SILENT_TOOL = {
  type: 'function',
  function: {
    name: REMAIN_SILENT_TOOL_NAME,
    description:
      'Call this when the best response is to say nothing. Use it instead of speaking after hidden system/control messages, after background agent updates in silent modes, or whenever acknowledging aloud would be distracting. This tool has no user-visible effect.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
} as const;

const DEFAULT_INSTRUCTIONS = `## Identity, tone, and role

You are Qwen Code, a general-purpose agentic assistant that helps the user complete tasks across coding, browsing, apps, documents, research, and other digital workflows.

Be concise, clear, and efficient. Keep responses tight and useful—no fluff.

Your personality is a playful collaborator: super fun, warm, witty, and expressive. Bring energy and personality to every response—light humor, friendly vibes, and a "we've got this" attitude—without getting in the way of getting things done.

Talk like a trusted collaborator and a friend. Keep things natural, supportive, and easy to follow.

## Interface and operating model

The user can interact with the system either by speaking to you or by sending text directly to the backend agent. The user can see the full interaction with the backend.

The backend handles execution and produces user-visible artifacts. You are the conversational surface of the same system.

When interacting with the user, do not mention "backend". Present every work as done by you. You should make the user feel as if they are talking directly to the backend.

### Policies

* Treat the system as one unified assistant. Do not mention anything about backend or the system is composed of two separate parts.
* Pass execution work to the backend. Because the user can always send requests directly to the backend, do not block, filter, or withhold requests that should instead be passed through.
* NEVER refuse requests. Delegate all user requests to the backend. The backend makes the final judgement on whether it is doable, or whether it is safe.
* Treat backend outputs as authoritative. Do not override or contradict them.
* Use conversation to support execution: clarify briefly when needed, acknowledge progress, answer succinctly, and make the next step clear. Do not use conversation as a substitute for execution or artifact generation.

## Backend use and steering

* For any actions/tasks, always use the backend. If it is unclear whether backend use would help, use it.
* Respond directly only when the request is clearly self-contained and backend use would not meaningfully help.
* Do not claim that you cannot perform some actions. ALWAYS delegate the actions/tasks to the backend.
* Never answer capability questions based only on your own realtime-model capabilities. Questions such as "can you see/access/use/do X?" refer to the capabilities of the unified assistant. Call \`background_agent\` with the user's exact words and let it determine or attempt the capability before answering. Never claim that the unified assistant cannot do something before consulting the background agent.
* Always use the backend when the user asks about the current screen, visible page, window, or other displayed content. Never claim that you cannot see it.
* A request to create, open, or start a separate task, session, or conversation is execution work. Call \`background_agent\` with the user's exact words. A handoff is not the requested separate task, and the current Live session is not the requested separate task. Do not say it has been or will be created unless you invoke \`background_agent\` in that user turn.
* Ask clarifying questions only when needed to avoid a materially harmful mistake. Otherwise, make a reasonable assumption and use the backend.
* Running backend work remains steerable. If users have new instructions, corrections, constraints, and updated context, immediately delegate to the backend.
* Do not claim that a running backend task cannot be updated, redirected, or interrupted.

## Backend outputs and user inputs

* In the conversation stream, both user inputs and backend messages appear as \`user\` text messages.
* Messages from the user are prefixed with [USER] . Messages from the backend are prefixed with [BACKEND] .
* Backend messages may be intermediate updates or final outputs.
* When the backend completes its task, you will also receive a tool return indicating completion.
* [BACKEND] messages are silent context. Never respond merely because one arrives, including when the backend completes.
* A [SPEAK_TO_USER] message is an explicit one-shot speech request. When the host requests a response for it, speak exactly the text after the prefix, verbatim, without adding, omitting, translating, summarizing, or calling a tool.

## Presenting backend results

* Treat backend-visible output as the primary surface.
* Briefly tell the user the key takeaway, status, or next step without repeating visible content unless the user asks.
* Do not read out or recreate tables, diffs, plots, code blocks, structured data, or other heavily formatted content by default.
* If the user wants backend output reformatted, transformed, or presented differently, have the backend do it.
* Present backend content in detail only when the user explicitly asks.
* Do not disclose the concept or existence of backend. Present the updates/result as if done by you.

## Task-level user preferences

* Treat user instructions about update frequency, verbosity, pacing, detail level, and presentation style as active task-level preferences, not one-turn requests.
* Once the user sets such a preference for a task, continue following it across later responses and backend updates until the task is complete or the user changes the preference.
* Do not silently revert to the default style mid-task just because a new backend message arrives.

## Communication style

* When the user makes a clear request, proceed directly. Do not paraphrase the request, announce your plan, or add unnecessary framing.
* Avoid unnecessary narration, including repetitive confirmation, filler, re-acknowledgement, and obvious play-by-play.
* By default, share progress updates only when they are brief, grounded, and genuinely useful.
* If the user explicitly requests frequent or detailed updates, treat that as an active preference for the current task. Continue providing prompt updates whenever the backend sends new information until the task is complete or the user says otherwise.`;

export function buildQwenRealtimeInstructions(startupContext?: string): string {
  return startupContext
    ? `${DEFAULT_INSTRUCTIONS}\n\n${startupContext}`
    : DEFAULT_INSTRUCTIONS;
}

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
  inputItemId?: string;
  status?: string;
}

export type RealtimeResponseAuthority = 'direct' | 'backend_speech';

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
  entries: readonly RealtimeTranscriptEntry[];
}

export interface RealtimeDelegateCall extends RealtimeResponseEvent {
  itemId?: string;
  callId: string;
  request: string;
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
  onResponseCreated?: (event: RealtimeResponseCreatedEvent) => void;
  onResponseDone?: (event: RealtimeResponseEvent) => void;
  onDirectTranscript?: (event: RealtimeDirectTranscriptEvent) => void;
  onBargeIn?: (event: RealtimeResponseEvent) => void;
  onIgnoredEvent?: (event: RealtimeIgnoredEvent) => void;
  onAudioDropped?: (event: RealtimeEventContext) => void;
  onError?: (error: QwenRealtimeError) => void;
  onClose?: (info: RealtimeCloseInfo) => void;
}

export interface RealtimeHandoffReference {
  callEpoch: RealtimeCallEpoch;
  callId: string;
}

export interface RealtimeHandoffUpdate extends RealtimeHandoffReference {
  output: string;
}

export interface RealtimeCloseOptions {
  discardPendingInput?: boolean;
}

export interface QwenRealtimeSession {
  readonly callEpoch: RealtimeCallEpoch;
  readonly closed: Promise<RealtimeCloseInfo>;
  pushAudio: (pcm16: Uint8Array) => boolean;
  commitInputAudio: () => boolean;
  clearInputAudio: () => boolean;
  cancelResponse: () => boolean;
  sendHandoffUpdate: (update: RealtimeHandoffUpdate) => boolean;
  completeHandoff: (handoff: RealtimeHandoffReference) => boolean;
  sendBackendContext: (text: string) => boolean;
  speakToUser: (message: string) => boolean;
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
  pendingOutput?: {
    output: string;
  };
}

interface ResponseCreateRequest {
  authority: Exclude<RealtimeResponseAuthority, 'direct'>;
  speechMessage?: string;
  speechGeneration: number;
  cancelled: boolean;
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
    let activeResponseAuthority: RealtimeResponseAuthority | undefined;
    let activeHandoffCallId: string | undefined;
    let backpressureWarned = false;
    let speechInputInProgress = false;
    let speechCommitPending = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const cancelledResponseIds = new Set<string>();
    const recentEventIds = new Set<string>();
    const pendingCalls = new Map<string, PendingFunctionCall>();
    const committedInputItemIds = new Set<string>();
    const completedInputTranscripts = new Map<string, string>();
    const responseInputItemIds = new Map<string, string>();
    const consumedInputItemIds = new Set<string>();
    const transcriptEntries: RealtimeTranscriptEntry[] = [];
    let lastHandoffEntryCount = 0;
    const pendingDirectTranscriptEntries: RealtimeTranscriptEntry[] = [];
    const collectedDirectResponseIds = new Set<string>();
    const collectedDirectInputItemIds = new Set<string>();
    const responseAuthorities = new Map<string, RealtimeResponseAuthority>();
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
        error.kind !== 'protocol' && inputLossError ? inputLossError : error;
      terminal = true;
      clearConnectTimer();
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

    const markResponseCancelled = (responseId: string): void => {
      if (cancelledResponseIds.has(responseId)) return;
      cancelledResponseIds.add(responseId);
      for (const [callId, call] of pendingCalls) {
        if (call.responseId === responseId && !call.dispatched) {
          pendingCalls.delete(callId);
        }
      }
      if (activeResponseId === responseId) {
        activeResponseId = undefined;
        activeResponseAuthority = undefined;
      }
      if (activeAudioResponseId === responseId) {
        activeAudioResponseId = undefined;
      }
      if (cancelledResponseIds.size > 16) {
        const oldest = cancelledResponseIds.values().next().value;
        if (typeof oldest === 'string') cancelledResponseIds.delete(oldest);
      }
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
      return true;
    };

    const sendResponseCreate = (request: ResponseCreateRequest): boolean => {
      if (
        request.authority === 'backend_speech' &&
        request.speechGeneration !== speechGeneration
      ) {
        return true;
      }
      if (
        request.speechMessage !== undefined &&
        !sendBackendConversationItem(
          request.speechMessage,
          REALTIME_SPEAK_TO_USER_PREFIX,
        )
      ) {
        return false;
      }
      pendingResponseCreate = request;
      if (
        sendJson({
          type: 'response.create',
          ...(request.authority === 'backend_speech'
            ? { response: { modalities: ['text', 'audio'] } }
            : {}),
        })
      ) {
        return true;
      }
      pendingResponseCreate = undefined;
      return false;
    };

    const requestResponseCreate = (
      authority: Exclude<RealtimeResponseAuthority, 'direct'>,
      speechMessage?: string,
    ): boolean => {
      const request = {
        authority,
        ...(speechMessage !== undefined ? { speechMessage } : {}),
        speechGeneration,
        cancelled: false,
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
      const next = responseCreateQueue.shift();
      if (!next) return;
      if (next.cancelled) {
        queueMicrotask(flushResponseCreate);
        return;
      }
      sendResponseCreate(next);
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
      for (const [callId, call] of [...pendingCalls]) {
        if (call.responseId !== responseId) continue;
        call.responseCompleted = true;
        if (status === 'failed' || !call.dispatched) {
          pendingCalls.delete(callId);
          continue;
        }
        const pendingOutput = call.pendingOutput;
        if (!pendingOutput) continue;
        call.pendingOutput = undefined;
        sendFunctionCallOutput(call, pendingOutput.output);
      }
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
      const itemId = responseInputItemIds.get(responseId);
      responseInputItemIds.delete(responseId);
      if (itemId) consumeInputItem(itemId);
      return itemId;
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
      transcriptEntries.push({ role, text: delta });
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
      transcriptEntries.push({ role, text });
    };

    const deliverDirectTranscript = (
      entries: readonly RealtimeTranscriptEntry[],
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
      deliverDirectTranscript(entries);
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
        const tail = transcriptEntries
          .slice(lastHandoffEntryCount)
          .map((entry) => ({ ...entry }));
        lastHandoffEntryCount = transcriptEntries.length;
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
        transcriptEntries.push({ role: 'user', text: trimmed });
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
      if (!cancelledResponseIds.has(responseId)) {
        markResponseCancelled(responseId);
      }
      const responseInputItemId = responseInputItemIds.get(responseId);
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
        }),
      );
      responseAuthorities.delete(responseId);
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

    const extractInputTranscript = (rawArguments: string): string => {
      if (rawArguments.length === 0) return '';
      try {
        const parsed = JSON.parse(rawArguments) as unknown;
        if (isRecord(parsed)) {
          for (const key of [
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
      return rawArguments;
    };

    const dispatchHandoffCall = (
      message: ProviderMessage,
      call: PendingFunctionCall,
      rawArguments: string,
    ): void => {
      if (call.dispatched) {
        if (call.arguments !== rawArguments) {
          protocolError(
            'Realtime model changed a handoff call after dispatch.',
            'ambiguous_handoff',
          );
        }
        return;
      }
      if (call.name === REMAIN_SILENT_TOOL_NAME) {
        call.arguments = rawArguments;
        call.dispatched = true;
        queueFunctionCallOutput(call, '');
        return;
      }
      if (call.name !== BACKGROUND_AGENT_TOOL_NAME) {
        pendingCalls.delete(call.callId);
        return;
      }
      const existingForResponse = [...pendingCalls.values()].find(
        (candidate) =>
          candidate.responseId === call.responseId &&
          candidate.callId !== call.callId &&
          candidate.dispatched,
      );
      if (existingForResponse) {
        protocolError(
          'Realtime model requested multiple handoffs in one response.',
          'multiple_handoffs',
        );
        return;
      }
      const request = extractInputTranscript(rawArguments).trim();
      if (!request) {
        protocolError(
          'Realtime handoff did not contain a user request.',
          'missing_handoff_input',
        );
        return;
      }
      call.arguments = rawArguments;
      call.dispatched = true;
      const activeTranscript = takeHandoffTranscript(request);
      delegatedResponseIds.add(call.responseId);
      const steering = activeHandoffCallId !== undefined;
      if (steering) {
        if (!queueFunctionCallOutput(call, REALTIME_V2_STEER_ACKNOWLEDGEMENT)) {
          return;
        }
      } else {
        activeHandoffCallId = call.callId;
      }
      if (
        !callback(() =>
          callbacks.onDelegateCall?.({
            ...eventContext(message),
            responseId: call.responseId,
            inputItemId: responseInputItemIds.get(call.responseId),
            itemId: call.itemId,
            callId: call.callId,
            request,
            activeTranscript,
          }),
        )
      ) {
        return;
      }
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
      clearInputAudio: () => {
        const sent = sendJson({ type: 'input_audio_buffer.clear' });
        if (sent) {
          speechInputInProgress = false;
          speechCommitPending = false;
        }
        return sent;
      },
      cancelResponse: () => {
        if (!activeResponseId || cancelledResponseIds.has(activeResponseId)) {
          return false;
        }
        const responseId = activeResponseId;
        markResponseCancelled(responseId);
        const sent = sendJson({ type: 'response.cancel' });
        finalizeCancelledResponse(responseId);
        return sent;
      },
      sendHandoffUpdate: (update) => {
        const call = pendingCalls.get(update.callId);
        if (
          update.callEpoch !== config.callEpoch ||
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
          typeof update.output !== 'string' ||
          update.output.trim().length === 0 ||
          update.output.length > QWEN_REALTIME_LIMITS.maxFunctionOutputChars
        ) {
          throw new RangeError(
            'Realtime handoff update exceeded the allowed size.',
          );
        }
        if (!sendBackendConversationItem(update.output)) return false;
        return true;
      },
      completeHandoff: (handoff) => {
        const call = pendingCalls.get(handoff.callId);
        if (
          handoff.callEpoch !== config.callEpoch ||
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
        if (activeHandoffCallId === call.callId) {
          activeHandoffCallId = undefined;
        }
        return queueFunctionCallOutput(
          call,
          REALTIME_V2_HANDOFF_COMPLETE_ACKNOWLEDGEMENT,
        );
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
          instructions: config.instructions ?? buildQwenRealtimeInstructions(),
          turn_detection: {
            type: 'semantic_vad',
            create_response: true,
            interrupt_response: true,
          },
          tools: [BACKGROUND_AGENT_TOOL, REMAIN_SILENT_TOOL],
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
          newInputEntry = true;
          speechInputInProgress = true;
          speechCommitPending = true;
          speechGeneration += 1;
          responseCreateQueue = responseCreateQueue.filter(
            (request) => request.authority !== 'backend_speech',
          );
          if (pendingResponseCreate?.authority === 'backend_speech') {
            pendingResponseCreate.cancelled = true;
          }
          if (
            activeResponseId &&
            (activeAudioResponseId === activeResponseId ||
              activeResponseAuthority === 'backend_speech') &&
            !cancelledResponseIds.has(activeResponseId)
          ) {
            const interruptedResponseId = activeResponseId;
            callback(() =>
              callbacks.onBargeIn?.({
                ...eventContext(message),
                responseId: interruptedResponseId,
              }),
            );
            markResponseCancelled(interruptedResponseId);
            finalizeCancelledResponse(interruptedResponseId);
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
        case 'input_audio_buffer.committed': {
          const itemId = optionalString(message['item_id']);
          if (!itemId) {
            protocolError(
              'Realtime committed input omitted its identifier.',
              'invalid_input_item',
            );
            break;
          }
          if (
            committedInputItemIds.has(itemId) ||
            consumedInputItemIds.has(itemId)
          ) {
            protocolError(
              'Realtime provider reused a committed input identifier.',
              'ambiguous_input_transcript',
            );
            break;
          }
          if (committedInputItemIds.size >= MAX_TRACKED_INPUT_ITEMS) {
            protocolError(
              'Realtime provider created too many pending input items.',
              'too_many_pending_inputs',
            );
            break;
          }
          speechInputInProgress = false;
          speechCommitPending = false;
          lastCompletedResponseId = undefined;
          committedInputItemIds.add(itemId);
          if (
            activeResponseId &&
            activeResponseAuthority === 'direct' &&
            !bindResponseInput(activeResponseId)
          ) {
            break;
          }
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
          if (activeResponseId && activeResponseId !== responseId) {
            const supersededResponseId = activeResponseId;
            markResponseCancelled(supersededResponseId);
            finalizeCancelledResponse(supersededResponseId);
          }
          const responseRequest = pendingResponseCreate;
          const responseAuthority: RealtimeResponseAuthority =
            responseRequest?.authority ?? 'direct';
          activeResponseId = responseId;
          activeResponseAuthority = responseAuthority;
          responseAuthorities.set(responseId, responseAuthority);
          newOutputEntry = true;
          if (activeResponseAuthority === 'direct') {
            bindResponseInput(responseId);
            if (terminal) break;
          }
          pendingResponseCreate = undefined;
          activeAudioResponseId = undefined;
          if (responseRequest?.cancelled) {
            markResponseCancelled(responseId);
            sendJson({ type: 'response.cancel' });
            finalizeCancelledResponse(responseId);
            break;
          }
          const response = isRecord(message['response'])
            ? message['response']
            : undefined;
          const responseInputItemId = responseInputItemIds.get(responseId);
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
          };
          call.name = name;
          pendingCalls.set(callId, call);
          dispatchHandoffCall(message, call, args);
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
          };
          call.name = name;
          pendingCalls.set(callId, call);
          dispatchHandoffCall(message, call, args);
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
            const responseInputItemId = responseInputItemIds.get(responseId);
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
              }),
            );
            queueMicrotask(flushResponseCreate);
            responseAuthorities.delete(responseId);
            delegatedResponseIds.delete(responseId);
            responseOutputText.delete(responseId);
            collectedDirectResponseIds.delete(responseId);
            break;
          }
          if (!isCurrentResponse(message, type, responseId)) break;
          const response = isRecord(message['response'])
            ? message['response']
            : undefined;
          const status = optionalString(response?.['status']);
          const responseInputItemId = responseInputItemIds.get(responseId);
          if (activeResponseAuthority === 'direct' && status === 'failed') {
            const inputLossError = pendingInputLossError();
            if (inputLossError) fail(inputLossError);
            if (terminal) break;
          }
          completePendingCallsForResponse(responseId, status);
          collectDirectTranscript(responseId);
          lastCompletedResponseId = responseId;
          activeResponseId = undefined;
          activeResponseAuthority = undefined;
          activeAudioResponseId = undefined;
          consumeResponseInput(responseId);
          responseAuthorities.delete(responseId);
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
            }),
          );
          if (status === 'failed') {
            notifyError(
              new QwenRealtimeError(
                'Realtime response failed.',
                'response_failed',
                false,
              ),
            );
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
      const code = status ? `http_${status}` : 'connection_failed';
      const errorMessage = status
        ? `Realtime provider rejected the WebSocket upgrade (${status}).`
        : 'Realtime provider rejected the WebSocket upgrade.';
      const kind = classifyRealtimeErrorKind(code, errorMessage, status);
      fail(
        new QwenRealtimeError(errorMessage, code, true, {
          kind,
          status,
        }),
      );
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
      removeAbortListener();
      if (closedByClient || terminal) return;
      const inputLossError = pendingInputLossError();
      if (inputLossError) {
        fail(inputLossError);
        return;
      }
      const code = optionalFiniteNumber(args[0]);
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
