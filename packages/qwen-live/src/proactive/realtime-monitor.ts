/**
 * @license
 * Copyright 2026 Alibaba Group Holding Limited
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 * Adapted to TypeScript from qwen-omni-realtime-agent; modified for Qwen Live.
 */

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  deriveQwenOmniRealtimeUrl,
  QwenRealtimeError,
  QWEN_REALTIME_LIMITS,
} from '../realtime/realtime-session.js';
import type { SocketLike } from '../realtime/socket.js';
import {
  parseMonitorAction,
  PROACTIVE_MONITOR_SYSTEM_PROMPT,
  type MonitorEvaluationResult,
  type ProactiveMonitorMode,
} from './monitor-protocol.js';

const CONNECT_TIMEOUT_MS = 8_000;
const EVALUATION_TIMEOUT_MS = 30_000;
const SILENCE_PCM = Buffer.alloc(16_000 * 2 * 0.1);
const MAX_RECENT_INPUTS = 4_096;
const MAX_PROVIDER_METADATA_CHARS = 256;

type MonitorModality = 'audio' | 'vision';

interface RecentAudio {
  sequence: number;
  capturedAt: number;
  modality: 'audio';
  payload: Uint8Array;
}

interface RecentImage {
  sequence: number;
  capturedAt: number;
  modality: 'vision';
  payload: string;
}

type RecentInput = RecentAudio | RecentImage;

interface ProviderMessage extends Record<string, unknown> {
  type?: unknown;
}

export interface DashScopeRealtimeMonitorOptions {
  endpoint: string;
  apiKey?: string;
  model: string;
  taskId: string;
  taskGeneration: number;
  instruction: string;
  monitorMode: ProactiveMonitorMode;
  modalities: readonly MonitorModality[];
  contextWindowSec: Record<MonitorModality, number>;
  sessionRecycleEvals: number;
}

export interface DashScopeRealtimeMonitorCallbacks {
  onReady?: (taskGeneration: number) => void;
  onResult: (result: MonitorEvaluationResult, taskGeneration: number) => void;
  onLifecycleError?: (error: Error, taskGeneration: number) => void;
  onDebug?: (event: string, details: Record<string, unknown>) => void;
}

export interface DashScopeRealtimeMonitorDeps {
  createWebSocket?: (
    url: string,
    options: {
      headers: Record<string, string>;
      maxPayload: number;
      perMessageDeflate: false;
      handshakeTimeout: number;
    },
  ) => SocketLike;
  now?: () => number;
  connectTimeoutMs?: number;
  evaluationTimeoutMs?: number;
  maxQueuedInputs?: number;
}

export interface ProactiveRealtimeMonitor {
  start(): Promise<void>;
  feedAudio(pcm16: Uint8Array): boolean;
  feedImage(jpegBase64: string): boolean;
  requestEvaluation(): boolean;
  resetPendingCapture(): void;
  close(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseIdOf(message: ProviderMessage): string | undefined {
  if (typeof message['response_id'] === 'string') {
    return message['response_id'];
  }
  const response = isRecord(message['response']) ? message['response'] : {};
  return typeof response['id'] === 'string' ? response['id'] : undefined;
}

function providerMetadata(value: unknown, apiKey?: string): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_PROVIDER_METADATA_CHARS ||
    (apiKey !== undefined && apiKey.length > 0 && value.includes(apiKey)) ||
    !/^[A-Za-z0-9_.:/-]+$/u.test(value)
  ) {
    return undefined;
  }
  return value;
}

function providerStatus(value: unknown): number | undefined {
  const status =
    typeof value === 'string' && /^\d{3}$/u.test(value)
      ? Number(value)
      : typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : undefined;
  return status !== undefined && status >= 100 && status <= 599
    ? status
    : undefined;
}

function monitorError(
  message: string,
  code: string,
  kind: 'configuration' | 'transient' | 'protocol',
  status?: number,
): QwenRealtimeError {
  return new QwenRealtimeError(message, code, true, {
    kind,
    ...(status !== undefined ? { status } : {}),
  });
}

function providerError(
  message: ProviderMessage,
  apiKey?: string,
): QwenRealtimeError {
  const detail = isRecord(message['error']) ? message['error'] : {};
  const code =
    providerMetadata(detail['code'], apiKey) ?? 'monitor_provider_error';
  const status = providerStatus(detail['status'] ?? message['status']);
  const providerType = providerMetadata(detail['type'], apiKey);
  const param = providerMetadata(detail['param'], apiKey);
  return new QwenRealtimeError(
    'DashScope monitor provider request failed.',
    code,
    true,
    {
      ...(status !== undefined ? { status } : {}),
      ...(providerType ? { providerType } : {}),
      ...(param ? { param } : {}),
    },
  );
}

function failureDebugDetails(
  error: QwenRealtimeError,
): Record<string, unknown> {
  return {
    error: true,
    kind: error.kind,
    ...(error.code ? { code: error.code } : {}),
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.providerType ? { providerType: error.providerType } : {}),
    ...(error.param ? { param: error.param } : {}),
  };
}

function isBoundedJpegBase64(value: string): boolean {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    value.length > Math.ceil(QWEN_REALTIME_LIMITS.maxInputImageBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) {
    return false;
  }
  const image = Buffer.from(value, 'base64');
  return (
    image.byteLength >= 4 &&
    image.byteLength <= QWEN_REALTIME_LIMITS.maxInputImageBytes &&
    image[0] === 0xff &&
    image[1] === 0xd8 &&
    image[image.byteLength - 2] === 0xff &&
    image[image.byteLength - 1] === 0xd9 &&
    image.toString('base64') === value
  );
}

export class DashScopeRealtimeMonitor implements ProactiveRealtimeMonitor {
  private readonly createWebSocket: NonNullable<
    DashScopeRealtimeMonitorDeps['createWebSocket']
  >;
  private readonly now: () => number;
  private readonly connectTimeoutMs: number;
  private readonly evaluationTimeoutMs: number;
  private readonly maxQueuedInputs: number;
  private readonly modalities: ReadonlySet<MonitorModality>;
  private socket: SocketLike | undefined;
  private transportGeneration = 0;
  private ready = false;
  private closed = false;
  private recycling = false;
  private needsRecycle = false;
  private evaluationPhase:
    | 'idle'
    | 'commit_pending'
    | 'response_requested'
    | 'responding' = 'idle';
  private activeResponseId: string | undefined;
  private deltaText = '';
  private finalText = '';
  private evaluationCount = 0;
  private evaluationTimer: ReturnType<typeof setTimeout> | undefined;
  private recentInputs: RecentInput[] = [];
  private writerQueue: RecentInput[] = [];
  private nextSequence = 0;
  private audioInCurrentBuffer = false;
  private failureSeenTransportGeneration: number | undefined;
  private failureDeliveredTransportGeneration: number | undefined;
  private pendingConnect:
    | {
        generation: number;
        finish: (error?: QwenRealtimeError) => void;
      }
    | undefined;

  constructor(
    private readonly options: DashScopeRealtimeMonitorOptions,
    private readonly callbacks: DashScopeRealtimeMonitorCallbacks,
    deps: DashScopeRealtimeMonitorDeps = {},
  ) {
    this.modalities = new Set(options.modalities);
    this.now = deps.now ?? Date.now;
    this.connectTimeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.evaluationTimeoutMs =
      deps.evaluationTimeoutMs ?? EVALUATION_TIMEOUT_MS;
    this.maxQueuedInputs = Math.max(
      1,
      Math.floor(deps.maxQueuedInputs ?? MAX_RECENT_INPUTS),
    );
    this.createWebSocket =
      deps.createWebSocket ??
      ((url, socketOptions) =>
        new WebSocket(url, {
          headers: socketOptions.headers,
          maxPayload: socketOptions.maxPayload,
          perMessageDeflate: socketOptions.perMessageDeflate,
          handshakeTimeout: socketOptions.handshakeTimeout,
        }) as unknown as SocketLike);
  }

  start(): Promise<void> {
    if (this.closed) {
      return Promise.reject(
        monitorError('Monitor is closed.', 'monitor_closed', 'protocol'),
      );
    }
    return this.connect();
  }

  feedAudio(pcm16: Uint8Array): boolean {
    if (!this.modalities.has('audio')) return true;
    if (
      pcm16.byteLength === 0 ||
      pcm16.byteLength % 2 !== 0 ||
      pcm16.byteLength > QWEN_REALTIME_LIMITS.maxInputAudioFrameBytes
    ) {
      return false;
    }
    const input: RecentAudio = {
      sequence: ++this.nextSequence,
      capturedAt: this.now(),
      modality: 'audio',
      payload: Uint8Array.from(pcm16),
    };
    this.remember(input);
    if (!this.ready || this.needsRecycle) return true;
    if (!this.enqueueWriterInput(input)) return false;
    this.drainWriterQueue();
    return true;
  }

  feedImage(jpegBase64: string): boolean {
    if (!this.modalities.has('vision')) return true;
    if (!isBoundedJpegBase64(jpegBase64)) return false;
    const input: RecentImage = {
      sequence: ++this.nextSequence,
      capturedAt: this.now(),
      modality: 'vision',
      payload: jpegBase64,
    };
    this.remember(input);
    if (!this.ready || this.needsRecycle) return true;
    if (!this.enqueueWriterInput(input)) return false;
    this.drainWriterQueue();
    return true;
  }

  requestEvaluation(): boolean {
    if (this.closed) return false;
    if (this.needsRecycle) {
      this.beginRecycle();
      return false;
    }
    if (!this.ready || this.recycling || this.evaluationPhase !== 'idle') {
      return false;
    }
    if (!this.drainWriterQueue() || this.writerQueue.length > 0) return false;
    if (this.socketIsBackpressured()) return false;
    this.evaluationPhase = 'commit_pending';
    this.activeResponseId = undefined;
    this.deltaText = '';
    this.finalText = '';
    if (
      !this.appendSilence() ||
      !this.send({ type: 'input_audio_buffer.commit' })
    ) {
      const error = monitorError(
        'Monitor could not commit its input buffer.',
        'monitor_commit_failed',
        'transient',
      );
      this.finishEvaluation(
        {
          triggered: false,
          summary: '',
          currentState: '',
          error: error.message,
        },
        error,
      );
      return true;
    }
    this.audioInCurrentBuffer = false;
    this.armEvaluationTimeout();
    return true;
  }

  resetPendingCapture(): void {
    // Preserve the resident conversation and its Reply/wait action history.
    this.recentInputs = [];
    this.writerQueue = [];
    this.audioInCurrentBuffer = false;
    if (this.ready && !this.send({ type: 'input_audio_buffer.clear' })) {
      this.failCurrentTransport(
        monitorError(
          'Monitor could not clear its pending input buffer.',
          'monitor_clear_failed',
          'transient',
        ),
      );
    }
  }

  close(): void {
    if (this.closed) return;
    const pendingConnect = this.pendingConnect;
    this.closed = true;
    this.ready = false;
    this.transportGeneration += 1;
    this.clearEvaluationTimer();
    this.evaluationPhase = 'idle';
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close();
    } catch {
      /* already closed */
    }
    this.recentInputs = [];
    this.writerQueue = [];
    pendingConnect?.finish(
      monitorError(
        'Monitor was closed while connecting.',
        'monitor_connection_closed',
        'transient',
      ),
    );
  }

  private connect(): Promise<void> {
    this.pendingConnect?.finish(
      monitorError(
        'Monitor connection was superseded.',
        'monitor_connection_superseded',
        'transient',
      ),
    );
    const old = this.socket;
    this.ready = false;
    this.audioInCurrentBuffer = false;
    this.writerQueue = [];
    const generation = ++this.transportGeneration;
    this.socket = undefined;
    try {
      old?.close();
    } catch {
      /* old generation is already fenced */
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let sessionUpdateSent = false;
      const timeout: {
        timer: ReturnType<typeof setTimeout> | undefined;
      } = { timer: undefined };
      let socket: SocketLike;
      const finishConnect = (error?: QwenRealtimeError): void => {
        if (settled) return;
        settled = true;
        if (timeout.timer !== undefined) clearTimeout(timeout.timer);
        if (this.pendingConnect?.generation === generation) {
          this.pendingConnect = undefined;
        }
        if (error) reject(error);
        else resolve();
      };
      this.pendingConnect = { generation, finish: finishConnect };
      try {
        socket = this.createWebSocket(
          deriveQwenOmniRealtimeUrl(this.options.endpoint, this.options.model),
          {
            headers: this.options.apiKey
              ? { Authorization: `Bearer ${this.options.apiKey}` }
              : {},
            maxPayload: QWEN_REALTIME_LIMITS.maxIncomingMessageBytes,
            perMessageDeflate: false,
            handshakeTimeout: this.connectTimeoutMs,
          },
        );
      } catch {
        finishConnect(
          monitorError(
            'Monitor connection could not be created.',
            'monitor_connection_failed',
            'configuration',
          ),
        );
        return;
      }
      this.socket = socket;

      const current = (): boolean =>
        !this.closed &&
        generation === this.transportGeneration &&
        this.socket === socket;

      const failConnection = (error: QwenRealtimeError): void => {
        if (!current()) return;
        if (this.failureSeenTransportGeneration === generation) return;
        this.failureSeenTransportGeneration = generation;
        this.ready = false;
        this.needsRecycle = true;
        if (!settled) {
          finishConnect(error);
          return;
        }
        if (this.evaluationPhase !== 'idle') {
          this.failureDeliveredTransportGeneration = generation;
          this.finishEvaluation(
            {
              triggered: false,
              summary: '',
              currentState: '',
              error: error.message,
            },
            error,
          );
        } else {
          this.deliverLifecycleFailure(error, generation);
        }
      };

      socket.on('message', (...args: unknown[]) => {
        if (!current() || args[1] === true) return;
        let parsed: unknown;
        try {
          const raw = String(args[0]);
          if (
            Buffer.byteLength(raw) >
            QWEN_REALTIME_LIMITS.maxIncomingMessageBytes
          ) {
            failConnection(
              monitorError(
                'Monitor provider message was too large.',
                'monitor_message_too_large',
                'protocol',
              ),
            );
            return;
          }
          parsed = JSON.parse(raw) as unknown;
        } catch {
          failConnection(
            monitorError(
              'Monitor provider message was invalid JSON.',
              'monitor_invalid_json',
              'protocol',
            ),
          );
          return;
        }
        if (!isRecord(parsed) || typeof parsed['type'] !== 'string') {
          failConnection(
            monitorError(
              'Monitor provider message was invalid.',
              'monitor_invalid_message',
              'protocol',
            ),
          );
          return;
        }
        const message = parsed as ProviderMessage;
        const type = message.type as string;
        if (type === 'session.created' && !sessionUpdateSent) {
          sessionUpdateSent = true;
          if (!this.sendSessionUpdate()) {
            failConnection(
              monitorError(
                'Monitor session update was rejected.',
                'monitor_session_update_failed',
                'transient',
              ),
            );
          }
          return;
        }
        if (type === 'session.updated' && !this.ready) {
          if (!this.initializeConversation()) {
            failConnection(
              monitorError(
                'Monitor initialization was rejected.',
                'monitor_initialization_failed',
                'transient',
              ),
            );
            return;
          }
          this.ready = true;
          this.needsRecycle = false;
          this.rebuildWriterQueue();
          if (!this.drainWriterQueue(false)) {
            failConnection(
              monitorError(
                'Monitor media replay failed.',
                'monitor_media_replay_failed',
                'transient',
              ),
            );
            return;
          }
          this.debug('proactive.monitor_ready', { generation });
          finishConnect();
          this.callbacks.onReady?.(this.options.taskGeneration);
          return;
        }
        if (type === 'input_audio_buffer.committed') {
          if (this.evaluationPhase !== 'commit_pending') return;
          this.evaluationPhase = 'response_requested';
          if (!this.send({ type: 'response.create' })) {
            const error = monitorError(
              'Monitor response request was rejected.',
              'monitor_response_request_failed',
              'transient',
            );
            this.finishEvaluation(
              {
                triggered: false,
                summary: '',
                currentState: '',
                error: error.message,
              },
              error,
            );
          }
          return;
        }
        if (type === 'response.created') {
          this.acceptResponse(message);
          return;
        }
        if (
          type === 'response.text.delta' ||
          type === 'response.output_text.delta' ||
          type === 'response.audio_transcript.delta'
        ) {
          if (!this.acceptResponse(message)) return;
          if (typeof message['delta'] === 'string') {
            this.deltaText = `${this.deltaText}${message['delta']}`.slice(
              0,
              QWEN_REALTIME_LIMITS.maxTranscriptChars,
            );
          }
          return;
        }
        if (
          type === 'response.text.done' ||
          type === 'response.output_text.done' ||
          type === 'response.audio_transcript.done'
        ) {
          if (!this.acceptResponse(message)) return;
          const text = message['text'] ?? message['transcript'];
          if (typeof text === 'string') {
            this.finalText = text.slice(
              0,
              QWEN_REALTIME_LIMITS.maxTranscriptChars,
            );
          }
          return;
        }
        if (type === 'response.done') {
          if (!this.acceptResponse(message)) return;
          const response = isRecord(message['response'])
            ? message['response']
            : {};
          if (
            response['status'] !== undefined &&
            response['status'] !== 'completed'
          ) {
            const error = monitorError(
              'Monitor response did not complete successfully.',
              'monitor_response_incomplete',
              'protocol',
            );
            this.finishEvaluation(
              {
                triggered: false,
                summary: '',
                currentState: '',
                error: error.message,
              },
              error,
            );
            return;
          }
          this.completeResponse();
          return;
        }
        if (type === 'error') {
          failConnection(providerError(message, this.options.apiKey));
        }
      });

      socket.on('error', () => {
        failConnection(
          monitorError(
            'Monitor WebSocket failed.',
            'monitor_socket_error',
            'transient',
          ),
        );
      });
      socket.on('close', () => {
        if (!current()) return;
        failConnection(
          monitorError(
            'Monitor WebSocket closed.',
            'monitor_connection_closed',
            'transient',
          ),
        );
      });
      socket.on('unexpected-response', () => {
        failConnection(
          monitorError(
            'Monitor WebSocket upgrade was rejected.',
            'monitor_upgrade_rejected',
            'configuration',
          ),
        );
      });

      timeout.timer = setTimeout(() => {
        failConnection(
          monitorError(
            'Monitor connection timed out.',
            'monitor_connection_timeout',
            'transient',
          ),
        );
      }, this.connectTimeoutMs);
      timeout.timer.unref?.();
    });
  }

  private sendSessionUpdate(): boolean {
    return this.send({
      type: 'session.update',
      session: {
        modalities: ['text'],
        input_audio_format: 'pcm',
        output_audio_format: 'pcm',
        input_audio_transcription: null,
        turn_detection: null,
        instructions: PROACTIVE_MONITOR_SYSTEM_PROMPT,
        smooth_output: false,
        tools: [],
        tool_choice: 'none',
      },
    });
  }

  private initializeConversation(): boolean {
    if (!this.options.instruction.trim()) return false;
    if (
      !this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: this.options.instruction.trim() },
          ],
        },
      }) ||
      !this.appendSilence()
    ) {
      return false;
    }
    return true;
  }

  private remember(input: RecentInput): void {
    this.recentInputs.push(input);
    this.pruneRecentInputs();
    while (this.recentInputs.length > this.maxQueuedInputs) {
      this.recentInputs.shift();
    }
  }

  private enqueueWriterInput(input: RecentInput): boolean {
    if (this.writerQueue.length >= this.maxQueuedInputs) {
      const firstVision = this.writerQueue.findIndex(
        (candidate) => candidate.modality === 'vision',
      );
      if (firstVision >= 0) {
        const [dropped] = this.writerQueue.splice(firstVision, 1);
        if (dropped) this.dropQueuedInput(dropped);
      } else if (input.modality === 'vision') {
        this.dropQueuedInput(input);
        return false;
      } else {
        const dropped = this.writerQueue.shift();
        if (dropped) this.dropQueuedInput(dropped);
      }
    }
    this.writerQueue.push(input);
    return true;
  }

  private dropQueuedInput(input: RecentInput): void {
    this.recentInputs = this.recentInputs.filter(
      (candidate) => candidate.sequence !== input.sequence,
    );
    this.debug('proactive.monitor_input_dropped', {
      modality: input.modality,
      reason: 'writer_queue_full',
    });
  }

  private pruneRecentInputs(): void {
    const now = this.now();
    const inWindow = (input: RecentInput): boolean =>
      input.capturedAt >=
      now - this.options.contextWindowSec[input.modality] * 1_000;
    this.recentInputs = this.recentInputs.filter(inWindow);
    this.writerQueue = this.writerQueue.filter(inWindow);
  }

  private rebuildWriterQueue(): void {
    this.pruneRecentInputs();
    this.writerQueue = [...this.recentInputs];
  }

  /**
   * Drain capture writes in FIFO order without ever blocking the producer.
   * A backpressured socket keeps the head queued; the next media arrival or
   * scheduler evaluation retries it. A commit is admitted only after this
   * queue is empty, so it can never overtake accepted media.
   */
  private drainWriterQueue(reportFailure = true): boolean {
    if (!this.ready || this.needsRecycle) return true;
    this.pruneRecentInputs();
    while (this.writerQueue.length > 0) {
      if (this.socketIsBackpressured()) return true;
      const input = this.writerQueue[0]!;
      if (!this.appendInput(input)) {
        if (this.socketIsBackpressured()) return true;
        if (reportFailure) {
          this.failCurrentTransport(
            monitorError(
              'Monitor media writer failed.',
              'monitor_media_writer_failed',
              'transient',
            ),
          );
        }
        return false;
      }
      this.writerQueue.shift();
    }
    return true;
  }

  private appendInput(input: RecentInput): boolean {
    if (input.modality === 'audio') {
      const sent = this.send(
        {
          type: 'input_audio_buffer.append',
          audio: Buffer.from(input.payload).toString('base64'),
        },
        true,
      );
      if (sent) this.audioInCurrentBuffer = true;
      return sent;
    }
    if (!this.audioInCurrentBuffer && !this.appendSilence()) return false;
    return this.send(
      { type: 'input_image_buffer.append', image: input.payload },
      true,
    );
  }

  private appendSilence(): boolean {
    const sent = this.send(
      {
        type: 'input_audio_buffer.append',
        audio: SILENCE_PCM.toString('base64'),
      },
      true,
    );
    if (sent) this.audioInCurrentBuffer = true;
    return sent;
  }

  private acceptResponse(message: ProviderMessage): boolean {
    if (
      this.evaluationPhase !== 'response_requested' &&
      this.evaluationPhase !== 'responding'
    ) {
      return false;
    }
    const responseId = responseIdOf(message);
    if (
      this.activeResponseId !== undefined &&
      responseId !== undefined &&
      responseId !== this.activeResponseId
    ) {
      return false;
    }
    if (this.activeResponseId === undefined && responseId !== undefined) {
      this.activeResponseId = responseId;
    }
    this.evaluationPhase = 'responding';
    return true;
  }

  private completeResponse(): void {
    const raw = this.finalText || this.deltaText;
    this.evaluationCount += 1;
    if (this.evaluationCount >= this.options.sessionRecycleEvals) {
      this.needsRecycle = true;
    }
    try {
      this.finishEvaluation(parseMonitorAction(raw, this.options.monitorMode));
    } catch {
      this.needsRecycle = true;
      const error = monitorError(
        'Monitor returned an invalid action.',
        'monitor_invalid_action',
        'protocol',
      );
      this.finishEvaluation(
        {
          triggered: false,
          summary: '',
          currentState: '',
          error: error.message,
        },
        error,
      );
    }
  }

  private finishEvaluation(
    result: MonitorEvaluationResult,
    failure?: QwenRealtimeError,
  ): void {
    if (this.evaluationPhase === 'idle') return;
    this.clearEvaluationTimer();
    this.evaluationPhase = 'idle';
    this.activeResponseId = undefined;
    this.deltaText = '';
    this.finalText = '';
    const safeResult = failure
      ? { ...result, error: failure.message }
      : result.error
        ? { ...result, error: 'Monitor evaluation failed.' }
        : result;
    const safeFailure =
      failure ??
      (safeResult.error
        ? monitorError(
            safeResult.error,
            'monitor_evaluation_failed',
            'protocol',
          )
        : undefined);
    if (safeResult.error) this.needsRecycle = true;
    this.debug('proactive.monitor_result', {
      triggered: safeResult.triggered,
      ...(safeFailure ? failureDebugDetails(safeFailure) : {}),
    });
    this.callbacks.onResult(safeResult, this.options.taskGeneration);
  }

  private armEvaluationTimeout(): void {
    this.clearEvaluationTimer();
    this.evaluationTimer = setTimeout(() => {
      this.evaluationTimer = undefined;
      const error = monitorError(
        'Monitor evaluation timed out.',
        'monitor_evaluation_timeout',
        'transient',
      );
      this.finishEvaluation(
        {
          triggered: false,
          summary: '',
          currentState: '',
          error: error.message,
        },
        error,
      );
    }, this.evaluationTimeoutMs);
    this.evaluationTimer.unref?.();
  }

  private clearEvaluationTimer(): void {
    if (this.evaluationTimer !== undefined) {
      clearTimeout(this.evaluationTimer);
      this.evaluationTimer = undefined;
    }
  }

  private beginRecycle(): void {
    if (this.recycling || this.closed) return;
    this.recycling = true;
    this.ready = false;
    const connecting = this.connect();
    const generation = this.transportGeneration;
    void connecting
      .then(() => {
        this.evaluationCount = 0;
        this.needsRecycle = false;
      })
      .catch((error: unknown) => {
        this.needsRecycle = true;
        if (!this.closed && generation === this.transportGeneration) {
          this.deliverLifecycleFailure(
            error instanceof QwenRealtimeError
              ? error
              : monitorError(
                  'Monitor recycle failed.',
                  'monitor_recycle_failed',
                  'transient',
                ),
            generation,
          );
        }
      })
      .finally(() => {
        this.recycling = false;
      });
  }

  private socketIsBackpressured(): boolean {
    const socket = this.socket;
    return Boolean(
      socket &&
        socket.readyState === socket.OPEN &&
        (socket.bufferedAmount ?? 0) >
          QWEN_REALTIME_LIMITS.maxBufferedSocketBytes,
    );
  }

  private failCurrentTransport(error: QwenRealtimeError): void {
    const generation = this.transportGeneration;
    if (this.closed || this.failureSeenTransportGeneration === generation) {
      return;
    }
    this.failureSeenTransportGeneration = generation;
    this.ready = false;
    this.needsRecycle = true;
    if (this.evaluationPhase !== 'idle') {
      this.failureDeliveredTransportGeneration = generation;
      this.finishEvaluation(
        {
          triggered: false,
          summary: '',
          currentState: '',
          error: error.message,
        },
        error,
      );
      return;
    }
    this.deliverLifecycleFailure(error, generation);
  }

  private deliverLifecycleFailure(
    error: QwenRealtimeError,
    generation: number,
  ): void {
    if (
      this.closed ||
      generation !== this.transportGeneration ||
      this.failureDeliveredTransportGeneration === generation
    ) {
      return;
    }
    this.failureDeliveredTransportGeneration = generation;
    this.callbacks.onLifecycleError?.(error, this.options.taskGeneration);
  }

  private send(
    body: Record<string, unknown>,
    enforceBackpressure = false,
  ): boolean {
    const socket = this.socket;
    if (
      this.closed ||
      !socket ||
      socket.readyState !== socket.OPEN ||
      (enforceBackpressure &&
        (socket.bufferedAmount ?? 0) >
          QWEN_REALTIME_LIMITS.maxBufferedSocketBytes)
    ) {
      return false;
    }
    try {
      socket.send(JSON.stringify({ event_id: randomUUID(), ...body }));
      return true;
    } catch {
      return false;
    }
  }

  private debug(event: string, details: Record<string, unknown>): void {
    this.callbacks.onDebug?.(event, {
      taskId: this.options.taskId,
      taskGeneration: this.options.taskGeneration,
      ...details,
    });
  }
}
