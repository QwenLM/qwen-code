/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight Server-Sent Events parser for native fetch.
 *
 * Async generator that yields parsed SSE events from a fetch Response.
 * Supports an optional raw-chunk idle timeout plus AbortSignal. Model startup
 * deadlines are owned by the transport lifecycle, not by the SSE parser.
 *
 * Ported from the original SSE client module.
 */

import { createAbortRejection } from '../../utils/abort-race.js';
import { getErrorDiagnostic } from '../../utils/error-fields.js';
import {
  MAX_MODEL_STREAM_EVENT_BYTES,
  MAX_SSE_LINE_BYTES,
  ProtocolLimitError,
} from '../../utils/protocol-limits.js';
import { normalizePositiveTimeoutMs } from '../../utils/timeouts.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SseEvent {
  id?: string;
  event?: string;
  data: string;
}

export type SseStreamDiagnosticPhase =
  | 'start'
  | 'read'
  | 'event'
  | 'end'
  | 'cancel'
  | 'timeout'
  | 'error';

export type SseStreamTimeoutKind =
  | 'first_payload'
  | 'body_idle';

export interface SseStreamDiagnosticEvent {
  phase: SseStreamDiagnosticPhase;
  elapsedMs: number;
  timeoutMs: number;
  readCount: number;
  byteCount: number;
  sseEventCount: number;
  heartbeatCount: number;
  lineCount: number;
  bufferChars: number;
  lastReadAgeMs: number;
  lastEventAgeMs: number;
  readGapMs?: number;
  eventGapMs?: number;
  chunkBytes?: number;
  done?: boolean;
  timeoutKind?: SseStreamTimeoutKind;
  errorMessage?: string;
  errorName?: string;
  errorCode?: string;
  errorStackTop?: string;
  errorCauseName?: string;
  errorCauseMessage?: string;
  errorCauseCode?: string;
  errorCauseStackTop?: string;
}

export interface StreamSSEOptions {
  /** Maximum gap between raw response-body chunks. Undefined disables it. */
  idleTimeoutMs?: number;
  /** Allows model transports to activate idle detection after first payload. */
  isIdleTimeoutActive?: () => boolean;
  onDiagnostic?: (event: SseStreamDiagnosticEvent) => void;
  diagnosticReadEvery?: number;
  diagnosticReadIntervalMs?: number;
  /** Maximum UTF-8 byte size of one physical SSE line. */
  maxLineBytes?: number;
  /** Maximum UTF-8 byte size of the accumulated `data:` event payload. */
  maxEventBytes?: number;
  /**
   * Receives a bounded raw-body sample only after a clean EOF with no SSE event
   * or unfinished SSE frame. The sample is parser input and must never be
   * written to logs; callers should surface only allowlisted fields
   * from a validated error envelope.
   */
  onEventlessBodyPreview?: (preview: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DIAGNOSTIC_READ_EVERY = 128;
const DEFAULT_DIAGNOSTIC_READ_INTERVAL_MS = 15_000;
export const DEFAULT_SSE_MAX_LINE_BYTES = MAX_SSE_LINE_BYTES;
export const DEFAULT_SSE_MAX_EVENT_BYTES = MAX_MODEL_STREAM_EVENT_BYTES;
/**
 * Raw-body sample kept while a stream has produced no SSE event. Bounded so an
 * event-less stream of any size costs a fixed, small amount of memory.
 */
export const DEFAULT_SSE_BODY_PREVIEW_CHARS = 2048;
/** Field names the parser recognizes, per the SSE spec. */
const SSE_FIELD_NAMES = ['data', 'event', 'id', 'retry'] as const;
const TRAILING_CR = /\r$/;

// ---------------------------------------------------------------------------
// SSE stream parser
// ---------------------------------------------------------------------------

/**
 * Stream SSE events from a fetch Response body.
 *
 * Parses the standard SSE wire format:
 * - `data: <value>` — event data (multiple data lines concatenated with \n)
 * - `event: <value>` — event type
 * - `id: <value>` — event ID
 * - Empty line — event boundary
 *
 * @param response - The fetch Response with a readable body stream
 * @param signal - AbortSignal for cancellation
 * @param options - SSE stream options including timeout and diagnostics.
 */
export async function* streamSSE(
  response: Response,
  signal?: AbortSignal,
  options: StreamSSEOptions = {},
): AsyncGenerator<SseEvent> {
  const idleTimeoutMs = normalizePositiveTimeoutMs(options.idleTimeoutMs);
  const isIdleTimeoutActive = options.isIdleTimeoutActive ?? (() => true);
  const diagnosticReadEvery =
    options.diagnosticReadEvery ?? DEFAULT_DIAGNOSTIC_READ_EVERY;
  const diagnosticReadIntervalMs =
    options.diagnosticReadIntervalMs ?? DEFAULT_DIAGNOSTIC_READ_INTERVAL_MS;
  const onDiagnostic = options.onDiagnostic;
  const onEventlessBodyPreview = options.onEventlessBodyPreview;
  const maxLineBytes = normalizePositiveLimit(
    options.maxLineBytes,
    DEFAULT_SSE_MAX_LINE_BYTES,
  );
  const maxEventBytes = normalizePositiveLimit(
    options.maxEventBytes,
    DEFAULT_SSE_MAX_EVENT_BYTES,
  );
  const guardLineBytes = (bytes: number): void => {
    if (bytes > maxLineBytes) {
      throw createSseSizeLimitError('line', maxLineBytes, bytes);
    }
  };

  const body = response.body;
  if (!body) {
    throw new Error('Response body is null');
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();

  const startedAt = Date.now();
  let readCount = 0;
  let byteCount = 0;
  let sseEventCount = 0;
  let heartbeatCount = 0;
  let lineCount = 0;
  let buffer = '';
  let bufferBytes = 0;
  let currentEvent: Partial<SseEvent> = {};
  let currentData: string[] = [];
  let currentDataBytes = 0;
  let lastReadTime = startedAt;
  let lastEventTime = startedAt;
  let lastDiagnosticReadAt = 0;
  let terminalDiagnosticEmitted = false;
  let bodyPreview = '';
  // Characters still worth sampling. Zeroed once an SSE event proves the body
  // carries model output rather than an envelope the parser could not decode.
  let bodyPreviewBudget =
    onEventlessBodyPreview === undefined ? 0 : DEFAULT_SSE_BODY_PREVIEW_CHARS;

  const getFetchBodyIdleTimeoutDetails = (
    error: unknown,
  ): {
    timeoutKind: SseStreamTimeoutKind;
    timeoutMs: number;
    message: string;
  } => {
    const timeoutMs = readFetchBodyIdleTimeoutMs(error) ?? idleTimeoutMs ?? 0;
    return {
      timeoutKind: 'body_idle',
      timeoutMs,
      message: `Model stream idle timeout after ${Math.round(timeoutMs / 1000)}s without data`,
    };
  };

  const emitDiagnostic = (
    phase: SseStreamDiagnosticPhase,
    now: number,
    extra: Partial<SseStreamDiagnosticEvent> = {},
  ) => {
    if (!onDiagnostic) return;
    try {
      onDiagnostic({
        phase,
        elapsedMs: now - startedAt,
        timeoutMs: idleTimeoutMs ?? 0,
        readCount,
        byteCount,
        sseEventCount,
        heartbeatCount,
        lineCount,
        bufferChars: buffer.length,
        lastReadAgeMs: now - lastReadTime,
        lastEventAgeMs: now - lastEventTime,
        ...extra,
      });
    } catch {
      // Diagnostics must never affect stream parsing.
    }
  };

  const shouldEmitReadDiagnostic = (now: number) => {
    if (readCount === 1) return true;
    if (diagnosticReadEvery > 0 && readCount % diagnosticReadEvery === 0) {
      return true;
    }
    return now - lastDiagnosticReadAt >= diagnosticReadIntervalMs;
  };

  // Abort handler
  const abortHandler = () => {
    try {
      reader.cancel(signal?.reason).catch(() => {});
    } catch {
      // A runtime-specific reader implementation may throw synchronously.
      // The independent abort race below still terminates the pending read.
    }
  };
  if (signal) {
    signal.addEventListener('abort', abortHandler, { once: true });
  }
  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
  };

  try {
    emitDiagnostic('start', Date.now());
    while (true) {
      throwIfAborted();

      const readPromise = reader.read();
      const enforceIdleTimeout =
        idleTimeoutMs !== undefined && isIdleTimeoutActive();
      // Per-iteration on purpose: a fresh abort race is created and cleaned up
      // each read so its listener/handlers are bounded. Racing one long-lived
      // pending promise across every read would instead accumulate Promise.race
      // reaction handlers on it until the stream ends.
      const abortWait = signal ? createAbortRejection(signal) : undefined;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        const pendingReads: Array<
          Promise<ReadableStreamReadResult<Uint8Array>>
        > = [readPromise];
        if (abortWait) {
          pendingReads.push(abortWait.promise);
        }
        if (enforceIdleTimeout) {
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(createStreamIdleTimeoutError(idleTimeoutMs));
            }, idleTimeoutMs);
            timeoutId.unref?.();
          });
          pendingReads.push(timeoutPromise);
        }
        result = await Promise.race(pendingReads);
      } catch (err) {
        const isReadTimeout = isStreamIdleTimeoutError(err);
        const isBodyIdleTimeout =
          isFetchBodyIdleTimeoutError(err) &&
          (idleTimeoutMs !== undefined ||
            readFetchBodyIdleTimeoutMs(err) !== undefined);
        if (isReadTimeout || isBodyIdleTimeout) {
          terminalDiagnosticEmitted = true;
          const timeoutNow = Date.now();
          const { timeoutKind, timeoutMs, message } = isBodyIdleTimeout
            ? getFetchBodyIdleTimeoutDetails(err)
            : {
                timeoutKind: 'body_idle' as const,
                timeoutMs: idleTimeoutMs ?? 0,
                message:
                  err instanceof Error
                    ? err.message
                    : 'Model stream idle timeout',
              };
          emitDiagnostic('timeout', timeoutNow, {
            ...getErrorDiagnostic(err),
            timeoutMs,
            timeoutKind,
            readGapMs: timeoutNow - lastReadTime,
            errorMessage: message,
          });
          throw isReadTimeout ? err : createStreamIdleTimeoutError(timeoutMs);
        }
        throw err;
      } finally {
        abortWait?.cleanup();
        clearTimeout(timeoutId);
      }

      throwIfAborted();

      readCount++;
      const readNow = Date.now();
      const readGapMs = readNow - lastReadTime;
      const chunkBytes = result.done ? 0 : result.value.byteLength;
      lastReadTime = readNow;
      byteCount += chunkBytes;

      if (shouldEmitReadDiagnostic(readNow)) {
        lastDiagnosticReadAt = readNow;
        emitDiagnostic('read', readNow, {
          chunkBytes,
          readGapMs,
          done: result.done,
        });
      }

      if (result.done) {
        // Stream ended — flush any remaining event
        if (currentData.length > 0) {
          sseEventCount++;
          const endNow = Date.now();
          emitDiagnostic('event', endNow, {
            eventGapMs: endNow - lastEventTime,
            done: true,
          });
          yield {
            ...currentEvent,
            data: currentData.join('\n'),
          } as SseEvent;
        }
        if (
          sseEventCount === 0 &&
          bodyPreview.length > 0 &&
          !hasUnfinishedSSEFrame(buffer, currentEvent)
        ) {
          try {
            onEventlessBodyPreview?.(bodyPreview);
          } catch {
            // Raw-body inspection is diagnostic-only and cannot affect parsing.
          }
        }
        terminalDiagnosticEmitted = true;
        emitDiagnostic('end', Date.now(), { done: true });
        return;
      }

      const decodedChunk = decoder.decode(result.value, { stream: true });
      if (bodyPreviewBudget > 0) {
        const sampled = decodedChunk.slice(0, bodyPreviewBudget);
        bodyPreview += sampled;
        bodyPreviewBudget -= sampled.length;
      }
      const fragments = decodedChunk.split('\n');
      if (fragments.length === 1) {
        buffer += decodedChunk;
        bufferBytes += Buffer.byteLength(decodedChunk, 'utf8');
        guardLineBytes(bufferBytes);
        continue;
      }

      const firstFragment = fragments.shift() ?? '';
      const lastFragment = fragments.pop() ?? '';
      const lines: Array<{ value: string; byteLength: number }> = [
        {
          value: buffer + firstFragment,
          byteLength:
            bufferBytes + Buffer.byteLength(firstFragment, 'utf8'),
        },
        ...fragments.map((value) => ({
          value,
          byteLength: Buffer.byteLength(value, 'utf8'),
        })),
      ];
      buffer = lastFragment;
      bufferBytes = Buffer.byteLength(lastFragment, 'utf8');
      guardLineBytes(bufferBytes);

      for (const line of lines) {
        guardLineBytes(line.byteLength);
        lineCount++;
        const trimmed = line.value.replace(/\r$/, '');

        if (trimmed === '') {
          // Empty line = event boundary
          const eventNow = Date.now();
          const eventGapMs = eventNow - lastEventTime;
          lastEventTime = eventNow;
          if (currentData.length > 0 || currentEvent.event || currentEvent.id) {
            sseEventCount++;
            // The sample is provably dead once an event exists, and a slice of a
            // decoded chunk keeps that whole chunk alive. Release it here rather
            // than at EOF so a long-lived stream stops pinning its first chunk.
            bodyPreview = '';
            bodyPreviewBudget = 0;
            emitDiagnostic('event', eventNow, { eventGapMs });
            yield {
              ...currentEvent,
              data: currentData.join('\n'),
            } as SseEvent;
          } else {
            heartbeatCount++;
          }
          currentEvent = {};
          currentData = [];
          currentDataBytes = 0;
          continue;
        }

        // Comment line (starts with ':')
        if (trimmed.startsWith(':')) {
          continue;
        }

        // Parse field
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) {
          // Line with no colon — treat as field name with empty value
          continue;
        }

        const field = trimmed.slice(0, colonIdx);
        // Value: skip optional leading space after colon
        let value = trimmed.slice(colonIdx + 1);
        if (value.startsWith(' ')) {
          value = value.slice(1);
        }

        switch (field) {
          case 'data':
            currentDataBytes +=
              Buffer.byteLength(value, 'utf8') +
              (currentData.length > 0 ? 1 : 0);
            if (currentDataBytes > maxEventBytes) {
              throw createSseSizeLimitError(
                'event',
                maxEventBytes,
                currentDataBytes,
              );
            }
            currentData.push(value);
            break;
          case 'event':
            currentEvent.event = value;
            break;
          case 'id':
            currentEvent.id = value;
            break;
          case 'retry':
            // Ignore retry field
            break;
          default:
            // Unknown fields are ignored per SSE spec
            break;
        }
      }
    }
  } catch (error) {
    if (!terminalDiagnosticEmitted) {
      terminalDiagnosticEmitted = true;
      const timeoutDetails = readFirstPayloadTimeoutDetails(error);
      const phase = timeoutDetails
        ? 'timeout'
        : signal?.aborted
          ? 'cancel'
          : 'error';
      emitDiagnostic(phase, Date.now(), {
        ...getErrorDiagnostic(error),
        ...(timeoutDetails ?? {}),
      });
    }
    throw error;
  } finally {
    // AsyncGenerator.return() enters finally without an error or EOF. Surface
    // that clean consumer cancellation as a terminal diagnostic so route
    // health does not remain permanently unresolved after useful output.
    if (!terminalDiagnosticEmitted) {
      terminalDiagnosticEmitted = true;
      emitDiagnostic('cancel', Date.now(), { done: false });
    }
    if (signal) {
      signal.removeEventListener('abort', abortHandler);
    }
    reader.cancel().catch(() => {});
  }
}

function normalizePositiveLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

/** Prevent a truncated first SSE frame from being mistaken for an error body. */
function hasUnfinishedSSEFrame(
  buffer: string,
  currentEvent: Partial<SseEvent>,
): boolean {
  if (currentEvent.event !== undefined || currentEvent.id !== undefined) {
    return true;
  }
  const line = buffer.replace(TRAILING_CR, '');
  if (!line) return false;
  if (line.startsWith(':')) return true;
  // The tail line was never newline-terminated, so its field name may itself be
  // truncated: a prefix of a known field still means SSE syntax, not an error.
  const colonIdx = line.indexOf(':');
  const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
  return SSE_FIELD_NAMES.some((knownField) => knownField.startsWith(field));
}

function createSseSizeLimitError(
  kind: 'line' | 'event',
  limitBytes: number,
  actualBytes: number,
): Error {
  return new ProtocolLimitError(
    `SSE ${kind} exceeds ${limitBytes} bytes`,
    kind === 'line' ? 'sse_line' : 'sse_event',
    limitBytes,
    actualBytes,
  );
}

function createStreamIdleTimeoutError(timeoutMs: number): Error {
  return Object.assign(
    new Error(
      `Model stream idle timeout after ${Math.round(timeoutMs / 1000)}s without data`,
    ),
    {
      name: 'ModelStreamIdleTimeoutError',
      code: 'ETIMEDOUT',
      status: 408,
      phase: 'stream_idle',
      timeoutMs,
    },
  );
}

function isStreamIdleTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { phase?: unknown }).phase === 'stream_idle'
  );
}

function readFirstPayloadTimeoutDetails(
  error: unknown,
):
  | {
      timeoutKind: 'first_payload';
      timeoutMs: number;
      errorMessage: string;
    }
  | undefined {
  if (!(error instanceof Error)) return undefined;
  const candidate = error as Error & { phase?: unknown; timeoutMs?: unknown };
  if (candidate.phase !== 'first_payload') return undefined;
  return {
    timeoutKind: 'first_payload',
    timeoutMs:
      typeof candidate.timeoutMs === 'number' ? candidate.timeoutMs : 0,
    errorMessage: error.message,
  };
}

const INTERNAL_FETCH_BODY_IDLE_TIMEOUT_PATTERN =
  /^Response body idle timeout after (\d+)ms$/;

function readFetchBodyIdleTimeoutMs(error: unknown): number | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      message?: unknown;
    };
    if (typeof candidate.message === 'string') {
      const match = INTERNAL_FETCH_BODY_IDLE_TIMEOUT_PATTERN.exec(
        candidate.message,
      );
      if (match?.[1]) {
        return Number(match[1]);
      }
    }
    current = candidate.cause;
  }
  return undefined;
}

function isFetchBodyIdleTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      name?: unknown;
      message?: unknown;
    };
    if (typeof candidate.message === 'string') {
      if (INTERNAL_FETCH_BODY_IDLE_TIMEOUT_PATTERN.test(candidate.message)) {
        return true;
      }
    }
    if (
      candidate.code === 'UND_ERR_BODY_TIMEOUT' ||
      candidate.name === 'BodyTimeoutError'
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}
