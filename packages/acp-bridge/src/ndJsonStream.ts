/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { inspect } from 'node:util';
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk';

export interface NdJsonMessageObservation {
  direction: 'sent' | 'received';
  bytes: number;
  message: AnyMessage;
}

export interface NdJsonQueueSaturationInfo {
  requiredBytes: number;
  availableBytes: number;
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  graceMs: number;
}

export interface NdJsonStreamHooks {
  onMessageReceived?: (bytes: number) => void;
  onMessageSent?: (bytes: number) => void;
  onMessageObserved?: (observation: NdJsonMessageObservation) => void;
  onTransportError?: (error: unknown) => void;
  /**
   * Fired once per saturation episode, before the bounded backpressure wait
   * starts. An episode ends when the queue fully drains, so a chronically
   * borderline consumer produces one warning per episode, not one per frame.
   * Warns that the decoded queue is full BEFORE the fail-closed guard can
   * fire (issue #10162).
   */
  onQueueSaturated?: (info: NdJsonQueueSaturationInfo) => void;
}

/**
 * How long the bounded reader waits for the consumer to drain the decoded
 * queue before falling back to the fail-closed `NdJsonQueueLimitError`.
 * Transient slow consumers (channel clients reconnecting, blocked outbound
 * SSE) resolve within this window and keep the channel alive; a genuinely
 * stalled consumer still tears the transport down afterwards so the memory
 * bound remains effective.
 *
 * Must stay below `CHANNEL_LIVENESS_PROBE_TIMEOUT_MS`: the liveness probe's
 * response travels over this same stream, so a parked pump cannot answer it.
 * At parity the grace window burns a probe every episode, and two episodes
 * inside `CHANNEL_LIVENESS_INTERVAL_MS * 2` would tear the channel down as a
 * liveness timeout — the outage this backpressure exists to prevent, with a
 * misleading cause. `ndJsonStream.test.ts` pins the relation.
 */
export const NDJSON_QUEUE_SATURATION_GRACE_MS = 5_000;

export interface NdJsonStreamLimits {
  maxFrameBytes: number;
  maxQueuedMessages: number;
  maxQueuedBytes: number;
  queueSaturationGraceMs?: number;
}

export type NdJsonInboundMessageValidator = (message: AnyMessage) => boolean;

export class NdJsonFrameTooLargeError extends Error {
  readonly code = 'ndjson_frame_too_large';

  constructor(
    readonly direction: 'sent' | 'received',
    readonly limitBytes: number,
    readonly observedBytes: number,
  ) {
    super(
      `NDJSON ${direction} frame exceeds ${limitBytes} bytes ` +
        `(observed ${observedBytes} bytes)`,
    );
    this.name = 'NdJsonFrameTooLargeError';
  }
}

export type NdJsonQueueBudget =
  | 'decoded'
  | 'inbound_request'
  | 'outbound_request'
  | 'prepared_response'
  | 'outbound_operation';

export class NdJsonQueueLimitError extends Error {
  readonly code = 'ndjson_queue_limit_exceeded';

  constructor(
    readonly budget: NdJsonQueueBudget,
    readonly maxQueuedMessages: number,
    readonly maxQueuedBytes: number,
    readonly requiredBytes: number,
    readonly availableBytes: number,
  ) {
    super(
      `NDJSON ${budget} queue limit exceeded ` +
        `(required ${requiredBytes} bytes, available ${availableBytes} bytes)`,
    );
    this.name = 'NdJsonQueueLimitError';
  }
}

export class NdJsonIncompleteFrameError extends Error {
  readonly code = 'ndjson_incomplete_frame';

  constructor(readonly observedBytes: number) {
    super(`NDJSON input ended with an incomplete ${observedBytes}-byte frame`);
    this.name = 'NdJsonIncompleteFrameError';
  }
}

export class NdJsonUnexpectedEofError extends Error {
  readonly code = 'ndjson_unexpected_eof';

  constructor() {
    super('NDJSON input ended while the bounded transport was active');
    this.name = 'NdJsonUnexpectedEofError';
  }
}

export class NdJsonInvalidMessageError extends Error {
  constructor(
    readonly code: 'ndjson_parse_error' | 'ndjson_invalid_message',
    readonly observedBytes: number,
  ) {
    super(`NDJSON input contains an invalid ${observedBytes}-byte message`);
    this.name = 'NdJsonInvalidMessageError';
  }
}

interface TextDecoderLike {
  decode(input?: Uint8Array): string;
}

const MAX_JSON_RPC_METHOD_BYTES = 1024;
const MAX_JSON_RPC_ID_BYTES = 256;
const MAX_JSON_RPC_ERROR_MESSAGE_BYTES = 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_ARRAY_LENGTH = 4096;

export function ndJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  hooks?: NdJsonStreamHooks,
  limits?: NdJsonStreamLimits,
  validateInboundMessage?: NdJsonInboundMessageValidator,
  fatalCleanEof = false,
): Stream {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  if (limits) validateNdJsonStreamLimits(limits);
  const outboundRequests = limits
    ? new BoundedOutstandingRequestLedger(limits)
    : undefined;
  const inboundRequests = limits
    ? new BoundedInboundRequestLedger(limits)
    : undefined;

  const readable = limits
    ? createBoundedReadable(
        input,
        textDecoder,
        hooks,
        limits,
        outboundRequests!,
        inboundRequests!,
        validateInboundMessage,
        fatalCleanEof,
      )
    : createLegacyReadable(input, textDecoder, hooks);

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
      let expectedResponseId: string | number | null | undefined;
      try {
        const content = JSON.stringify(message);
        const payload = textEncoder.encode(content);
        const frameBytes = payload.byteLength + 1;
        if (limits && frameBytes > limits.maxFrameBytes) {
          throw new NdJsonFrameTooLargeError(
            'sent',
            limits.maxFrameBytes,
            frameBytes,
          );
        }
        const frame = new Uint8Array(frameBytes);
        frame.set(payload);
        frame[payload.byteLength] = 0x0a;
        if (outboundRequests && isJsonRpcRequestMessage(message)) {
          outboundRequests.admit(message.id, frameBytes);
          expectedResponseId = message.id;
        }
        writer = output.getWriter();
        await writer.write(frame);
        inboundRequests?.release(message);
        callHook(hooks?.onMessageSent, payload.byteLength);
        callHook(hooks?.onMessageObserved, {
          direction: 'sent',
          bytes: payload.byteLength,
          message,
        });
      } catch (error) {
        if (expectedResponseId !== undefined) {
          outboundRequests?.discard(expectedResponseId);
        }
        if (limits) callHook(hooks?.onTransportError, error);
        throw error;
      } finally {
        writer?.releaseLock();
      }
    },
  });

  return { readable, writable };
}

function createLegacyReadable(
  input: ReadableStream<Uint8Array>,
  textDecoder: TextDecoderLike,
  hooks?: NdJsonStreamHooks,
): ReadableStream<AnyMessage> {
  return new ReadableStream<AnyMessage>({
    async start(controller) {
      const pending: Uint8Array[] = [];
      const reader = input.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          readLegacyChunk(value, pending, controller, textDecoder, hooks);
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

function createBoundedReadable(
  input: ReadableStream<Uint8Array>,
  textDecoder: TextDecoderLike,
  hooks: NdJsonStreamHooks | undefined,
  limits: NdJsonStreamLimits,
  outboundRequests: BoundedOutstandingRequestLedger,
  inboundRequests: BoundedInboundRequestLedger,
  validateInboundMessage: NdJsonInboundMessageValidator | undefined,
  fatalCleanEof: boolean,
): ReadableStream<AnyMessage> {
  const pending = new BoundedFrameBuffer(limits.maxFrameBytes);
  const minimumQueueCharge = Math.ceil(
    limits.maxQueuedBytes / limits.maxQueuedMessages,
  );
  const graceMs =
    limits.queueSaturationGraceMs ?? NDJSON_QUEUE_SATURATION_GRACE_MS;
  let nextQueueCharge = minimumQueueCharge;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let canceled = false;
  // One onQueueSaturated warning per uninterrupted saturation episode; reset
  // once the queue fully drains.
  let saturationWarned = false;
  // Single waiter: only the pump loop ever waits for queue space.
  let wakeQueueWaiter: (() => void) | undefined;
  const waitForQueueSpace = (timeoutMs: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(
        finish,
        // Node clamps delays above 2^31-1 ms to 1 ms (and warns), which would
        // spin the wait loop; cap so a long grace waits instead.
        Math.min(Math.max(0, timeoutMs), 2_147_483_647),
      );
      function finish() {
        clearTimeout(timer);
        wakeQueueWaiter = undefined;
        resolve();
      }
      wakeQueueWaiter = finish;
    });

  /**
   * Waits (bounded) for room in the decoded queue instead of failing the
   * transport immediately (issue #10162). Saturating the queue means the
   * consumer is slow; pausing the producer backpressures the agent's stdout
   * pipe and keeps the memory bound intact. Only if the consumer stays slow
   * for the whole grace window does the original fail-closed guard fire.
   */
  const ensureQueueSpace = async (
    controller: ReadableStreamDefaultController<AnyMessage>,
    queueCharge: number,
  ): Promise<void> => {
    const queueLimitError = (available: number) =>
      new NdJsonQueueLimitError(
        'decoded',
        limits.maxQueuedMessages,
        limits.maxQueuedBytes,
        queueCharge,
        Math.max(0, available),
      );
    let availableBytes = controller.desiredSize;
    if (availableBytes === null) throw queueLimitError(0);
    // The queue fully drained: the previous saturation episode is over and a
    // new one may warn again.
    if (availableBytes === limits.maxQueuedBytes) saturationWarned = false;
    if (queueCharge <= availableBytes) return;
    // A frame that would not fit even in a fully drained queue can never be
    // rescued by waiting.
    if (queueCharge > limits.maxQueuedBytes) {
      throw queueLimitError(availableBytes);
    }

    if (!saturationWarned) {
      saturationWarned = true;
      callHook(hooks?.onQueueSaturated, {
        requiredBytes: queueCharge,
        availableBytes: Math.max(0, availableBytes),
        maxQueuedMessages: limits.maxQueuedMessages,
        maxQueuedBytes: limits.maxQueuedBytes,
        graceMs,
      });
    }

    // Monotonic: wall-clock steps must not extend or shorten the grace window.
    const deadline = performance.now() + graceMs;
    while (queueCharge > availableBytes) {
      if (canceled) return;
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) throw queueLimitError(availableBytes);
      await waitForQueueSpace(remainingMs);
      if (canceled) return;
      const nextAvailableBytes = controller.desiredSize;
      if (nextAvailableBytes === null) throw queueLimitError(0);
      availableBytes = nextAvailableBytes;
    }
  };

  return new ReadableStream<AnyMessage>(
    {
      start(controller) {
        reader = input.getReader();
        void pumpBoundedInput(
          reader,
          pending,
          controller,
          textDecoder,
          hooks,
          limits,
          outboundRequests,
          inboundRequests,
          validateInboundMessage,
          fatalCleanEof,
          minimumQueueCharge,
          ensureQueueSpace,
          (charge) => {
            nextQueueCharge = charge;
          },
          () => canceled,
        );
      },
      pull() {
        // The consumer drained enough to want more: wake a pump that is
        // backpressured on a saturated decoded queue.
        wakeQueueWaiter?.();
      },
      async cancel(reason) {
        canceled = true;
        pending.clear();
        wakeQueueWaiter?.();
        if (reader) await cancelReader(reader, reason);
      },
    },
    {
      highWaterMark: limits.maxQueuedBytes,
      size: () => nextQueueCharge,
    },
  );
}

async function pumpBoundedInput(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pending: BoundedFrameBuffer,
  controller: ReadableStreamDefaultController<AnyMessage>,
  textDecoder: TextDecoderLike,
  hooks: NdJsonStreamHooks | undefined,
  limits: NdJsonStreamLimits,
  outboundRequests: BoundedOutstandingRequestLedger,
  inboundRequests: BoundedInboundRequestLedger,
  validateInboundMessage: NdJsonInboundMessageValidator | undefined,
  fatalCleanEof: boolean,
  minimumQueueCharge: number,
  ensureQueueSpace: (
    controller: ReadableStreamDefaultController<AnyMessage>,
    queueCharge: number,
  ) => Promise<void>,
  setNextQueueCharge: (charge: number) => void,
  isCanceled: () => boolean,
): Promise<void> {
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        if (isCanceled()) return;
        if (pending.byteLength > 0) {
          throw new NdJsonIncompleteFrameError(pending.byteLength);
        }
        if (fatalCleanEof) throw new NdJsonUnexpectedEofError();
        controller.close();
        return;
      }
      if (!result.value) continue;
      await readBoundedChunk(
        result.value,
        pending,
        controller,
        textDecoder,
        hooks,
        limits,
        outboundRequests,
        inboundRequests,
        validateInboundMessage,
        minimumQueueCharge,
        ensureQueueSpace,
        setNextQueueCharge,
        isCanceled,
      );
      if (isCanceled()) return;
    }
  } catch (error) {
    if (isCanceled()) return;
    pending.clear();
    callHook(hooks?.onTransportError, error);
    await cancelReader(reader, error);
    // ACP SDK's receive loop closes in `finally` but does not catch a rejected
    // `reader.read()`. Report the typed cause through the lifecycle hook and
    // close here so a transport guard cannot become an unhandled rejection.
    if (!isCanceled()) controller.close();
  } finally {
    pending.clear();
    outboundRequests.clear();
    inboundRequests.clear();
    reader.releaseLock();
  }
}

function readLegacyChunk(
  chunk: Uint8Array,
  pending: Uint8Array[],
  controller: ReadableStreamDefaultController<AnyMessage>,
  textDecoder: TextDecoderLike,
  hooks?: NdJsonStreamHooks,
): void {
  let start = 0;
  let newline = chunk.indexOf(0x0a, start);
  while (newline !== -1) {
    const lineBytes = takeLegacyLineBytes(
      pending,
      chunk.subarray(start, newline),
    );
    handleLegacyLine(lineBytes, controller, textDecoder, hooks);
    start = newline + 1;
    newline = chunk.indexOf(0x0a, start);
  }
  if (start < chunk.length) {
    pending.push(chunk.subarray(start));
  }
}

async function readBoundedChunk(
  chunk: Uint8Array,
  pending: BoundedFrameBuffer,
  controller: ReadableStreamDefaultController<AnyMessage>,
  textDecoder: TextDecoderLike,
  hooks: NdJsonStreamHooks | undefined,
  limits: NdJsonStreamLimits,
  outboundRequests: BoundedOutstandingRequestLedger,
  inboundRequests: BoundedInboundRequestLedger,
  validateInboundMessage: NdJsonInboundMessageValidator | undefined,
  minimumQueueCharge: number,
  ensureQueueSpace: (
    controller: ReadableStreamDefaultController<AnyMessage>,
    queueCharge: number,
  ) => Promise<void>,
  setNextQueueCharge: (charge: number) => void,
  isCanceled: () => boolean,
): Promise<void> {
  let start = 0;
  let newline = chunk.indexOf(0x0a, start);
  while (newline !== -1) {
    const current = chunk.subarray(start, newline);
    const frameBytes = pending.byteLength + current.byteLength + 1;
    assertFrameSize('received', limits.maxFrameBytes, frameBytes);
    if (pending.isJsonWhitespaceLine(current)) {
      pending.clear();
      start = newline + 1;
      newline = chunk.indexOf(0x0a, start);
      continue;
    }
    const queueCharge = Math.max(frameBytes, minimumQueueCharge);
    await ensureQueueSpace(controller, queueCharge);
    if (isCanceled()) return;
    setNextQueueCharge(queueCharge);
    handleBoundedLine(
      pending.take(current),
      controller,
      textDecoder,
      hooks,
      outboundRequests,
      inboundRequests,
      validateInboundMessage,
    );
    start = newline + 1;
    newline = chunk.indexOf(0x0a, start);
  }
  if (start < chunk.length) pending.append(chunk.subarray(start));
}

function takeLegacyLineBytes(
  pending: Uint8Array[],
  current: Uint8Array,
): Uint8Array {
  if (pending.length === 0) return current;

  const totalLength =
    pending.reduce((sum, part) => sum + part.byteLength, 0) +
    current.byteLength;
  const line = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of pending) {
    line.set(part, offset);
    offset += part.byteLength;
  }
  line.set(current, offset);
  pending.length = 0;
  return line;
}

function handleLegacyLine(
  lineBytes: Uint8Array,
  controller: ReadableStreamDefaultController<AnyMessage>,
  textDecoder: TextDecoderLike,
  hooks?: NdJsonStreamHooks,
): void {
  const line = textDecoder.decode(lineBytes);
  const trimmedLine = line.trim();
  if (!trimmedLine) return;

  try {
    const message = JSON.parse(trimmedLine) as AnyMessage;
    controller.enqueue(message);
    reportReceivedMessage(lineBytes, message, hooks);
  } catch (err) {
    // eslint-disable-next-line no-console -- match ACP SDK parse-error behavior
    console.error('Failed to parse JSON message:', trimmedLine, err);
  }
}

function handleBoundedLine(
  lineBytes: Uint8Array,
  controller: ReadableStreamDefaultController<AnyMessage>,
  textDecoder: TextDecoderLike,
  hooks?: NdJsonStreamHooks,
  outboundRequests?: BoundedOutstandingRequestLedger,
  inboundRequests?: BoundedInboundRequestLedger,
  validateInboundMessage?: NdJsonInboundMessageValidator,
): void {
  const line = textDecoder.decode(lineBytes);
  const trimmedLine = line.trim();
  if (!trimmedLine) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedLine);
  } catch {
    throw logBoundedInvalidMessage('ndjson_parse_error', lineBytes);
  }
  if (!isJsonRpcMessage(parsed)) {
    throw logBoundedInvalidMessage('ndjson_invalid_message', lineBytes);
  }
  const isResponse = isJsonRpcResponseMessage(parsed);
  if (
    (!isResponse && !hasBoundedJsonStructure(parsed)) ||
    (validateInboundMessage && !validateInboundMessage(parsed))
  ) {
    throw logBoundedInvalidMessage('ndjson_invalid_message', lineBytes);
  }
  if (
    isJsonRpcResponseMessage(parsed) &&
    !outboundRequests?.consumeResponse(parsed.id)
  ) {
    throw logBoundedInvalidMessage('ndjson_invalid_message', lineBytes);
  }
  inboundRequests?.admit(parsed, lineBytes.byteLength + 1);
  const message = installBoundedLogRedaction(parsed);

  controller.enqueue(message);
  reportReceivedMessage(lineBytes, message, hooks);
}

function installBoundedLogRedaction(message: AnyMessage): AnyMessage {
  Object.defineProperty(message, inspect.custom, {
    configurable: false,
    enumerable: false,
    value: inspectBoundedJsonRpcMessage,
    writable: false,
  });
  return message;
}

function inspectBoundedJsonRpcMessage(this: AnyMessage): object {
  return {
    jsonrpc: '2.0',
    messageType:
      'method' in this
        ? 'id' in this
          ? 'request'
          : 'notification'
        : 'response',
    payloadOmitted: true,
  };
}

function isJsonRpcMessage(value: unknown): value is AnyMessage {
  if (!isRecord(value) || value['jsonrpc'] !== '2.0') return false;

  const hasMethod = Object.hasOwn(value, 'method');
  const hasId = Object.hasOwn(value, 'id');
  if (hasMethod) {
    return (
      typeof value['method'] === 'string' &&
      Buffer.byteLength(value['method']) <= MAX_JSON_RPC_METHOD_BYTES &&
      (!hasId || isJsonRpcId(value['id']))
    );
  }
  if (!hasId || !isJsonRpcId(value['id'])) return false;

  const hasResult = Object.hasOwn(value, 'result');
  const hasError = Object.hasOwn(value, 'error');
  if (hasResult === hasError) return false;
  if (!hasError) return true;
  const error = value['error'];
  return (
    isRecord(error) &&
    typeof error['code'] === 'number' &&
    Number.isFinite(error['code']) &&
    typeof error['message'] === 'string' &&
    Buffer.byteLength(error['message']) <= MAX_JSON_RPC_ERROR_MESSAGE_BYTES
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasBoundedJsonStructure(value: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes++;
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) return false;
    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_JSON_ARRAY_LENGTH) return false;
      for (let index = current.value.length - 1; index >= 0; index--) {
        if (
          nodes + stack.length >= MAX_JSON_NODES ||
          current.depth + 1 > MAX_JSON_DEPTH
        ) {
          return false;
        }
        stack.push({
          value: current.value[index],
          depth: current.depth + 1,
        });
      }
    } else if (isRecord(current.value)) {
      for (const key in current.value) {
        if (!Object.hasOwn(current.value, key)) continue;
        if (
          nodes + stack.length >= MAX_JSON_NODES ||
          current.depth + 1 > MAX_JSON_DEPTH
        ) {
          return false;
        }
        stack.push({
          value: current.value[key],
          depth: current.depth + 1,
        });
      }
    }
  }
  return true;
}

function isJsonRpcId(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'string' &&
      Buffer.byteLength(value) <= MAX_JSON_RPC_ID_BYTES) ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function isJsonRpcRequestMessage(
  value: AnyMessage,
): value is AnyMessage & { id: string | number | null; method: string } {
  return (
    'method' in value &&
    'id' in value &&
    typeof value.method === 'string' &&
    isJsonRpcId(value.id)
  );
}

function isJsonRpcResponseMessage(
  value: AnyMessage,
): value is AnyMessage & { id: string | number | null } {
  return !('method' in value) && 'id' in value;
}

class BoundedInboundRequestLedger {
  private readonly requests = new Map<string | number | null, number>();
  private retainedBytes = 0;

  constructor(private readonly limits: NdJsonStreamLimits) {}

  admit(message: AnyMessage, frameBytes: number): void {
    if (!isJsonRpcRequestMessage(message)) return;
    const availableBytes = Math.max(
      0,
      this.limits.maxQueuedBytes - this.retainedBytes,
    );
    if (
      this.requests.has(message.id) ||
      this.requests.size >= this.limits.maxQueuedMessages ||
      frameBytes > availableBytes
    ) {
      throw new NdJsonQueueLimitError(
        'inbound_request',
        this.limits.maxQueuedMessages,
        this.limits.maxQueuedBytes,
        frameBytes,
        this.requests.has(message.id) ? 0 : availableBytes,
      );
    }
    this.requests.set(message.id, frameBytes);
    this.retainedBytes += frameBytes;
  }

  release(message: AnyMessage): void {
    if (!isJsonRpcResponseMessage(message)) return;
    const frameBytes = this.requests.get(message.id);
    if (frameBytes === undefined) return;
    this.requests.delete(message.id);
    this.retainedBytes -= frameBytes;
  }

  clear(): void {
    this.requests.clear();
    this.retainedBytes = 0;
  }
}

class BoundedOutstandingRequestLedger {
  private readonly requests = new Map<string | number | null, number>();
  private retainedBytes = 0;

  constructor(private readonly limits: NdJsonStreamLimits) {}

  admit(id: string | number | null, frameBytes: number): void {
    const availableBytes = Math.max(
      0,
      this.limits.maxQueuedBytes - this.retainedBytes,
    );
    if (
      this.requests.has(id) ||
      this.requests.size >= this.limits.maxQueuedMessages ||
      frameBytes > availableBytes
    ) {
      throw new NdJsonQueueLimitError(
        'outbound_request',
        this.limits.maxQueuedMessages,
        this.limits.maxQueuedBytes,
        frameBytes,
        this.requests.has(id) ? 0 : availableBytes,
      );
    }
    this.requests.set(id, frameBytes);
    this.retainedBytes += frameBytes;
  }

  consumeResponse(id: string | number | null): boolean {
    return this.discard(id);
  }

  discard(id: string | number | null): boolean {
    const frameBytes = this.requests.get(id);
    if (frameBytes === undefined) return false;
    this.requests.delete(id);
    this.retainedBytes -= frameBytes;
    return true;
  }

  clear(): void {
    this.requests.clear();
    this.retainedBytes = 0;
  }
}

function logBoundedInvalidMessage(
  errorKind: 'ndjson_parse_error' | 'ndjson_invalid_message',
  lineBytes: Uint8Array,
): NdJsonInvalidMessageError {
  const bytes = jsonPayloadByteLength(lineBytes);
  const digest = createHash('sha256')
    .update(lineBytes.subarray(0, bytes))
    .digest('hex');
  // eslint-disable-next-line no-console -- bounded metadata only
  console.error('Failed to parse JSON message:', {
    errorKind,
    bytes,
    sha256: digest,
    payloadOmitted: true,
  });
  return new NdJsonInvalidMessageError(errorKind, bytes);
}

function reportReceivedMessage(
  lineBytes: Uint8Array,
  message: AnyMessage,
  hooks?: NdJsonStreamHooks,
): void {
  const bytes = jsonPayloadByteLength(lineBytes);
  callHook(hooks?.onMessageReceived, bytes);
  callHook(hooks?.onMessageObserved, {
    direction: 'received',
    bytes,
    message,
  });
}

function jsonPayloadByteLength(lineBytes: Uint8Array): number {
  return lineBytes[lineBytes.byteLength - 1] === 0x0d
    ? lineBytes.byteLength - 1
    : lineBytes.byteLength;
}

export function validateNdJsonStreamLimits(limits: NdJsonStreamLimits): void {
  const values = [
    ['maxFrameBytes', limits.maxFrameBytes],
    ['maxQueuedMessages', limits.maxQueuedMessages],
    ['maxQueuedBytes', limits.maxQueuedBytes],
    ...(limits.queueSaturationGraceMs !== undefined
      ? ([['queueSaturationGraceMs', limits.queueSaturationGraceMs]] as const)
      : []),
  ] as const;
  for (const [name, value] of values) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
}

function assertFrameSize(
  direction: 'sent' | 'received',
  limitBytes: number,
  observedBytes: number,
): void {
  if (observedBytes > limitBytes) {
    throw new NdJsonFrameTooLargeError(direction, limitBytes, observedBytes);
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): Promise<void> {
  try {
    await reader.cancel(reason);
  } catch {
    /* preserve the transport error that caused cancellation */
  }
}

function callHook<T>(hook: ((value: T) => void) | undefined, value: T): void {
  try {
    hook?.(value);
  } catch {
    /* metrics and lifecycle hooks must not break the transport */
  }
}

class BoundedFrameBuffer {
  private buffer: Uint8Array | undefined;
  private length = 0;

  constructor(private readonly maxFrameBytes: number) {}

  get byteLength(): number {
    return this.length;
  }

  append(bytes: Uint8Array): void {
    const requiredBytes = this.length + bytes.byteLength;
    assertFrameSize('received', this.maxFrameBytes, requiredBytes);
    if (requiredBytes === 0) return;

    if (!this.buffer || this.buffer.byteLength < requiredBytes) {
      const doubledCapacity = Math.min(
        this.maxFrameBytes,
        Math.max(1024, (this.buffer?.byteLength ?? 0) * 2),
      );
      const next = new Uint8Array(Math.max(requiredBytes, doubledCapacity));
      if (this.buffer) next.set(this.buffer.subarray(0, this.length));
      this.buffer = next;
    }
    this.buffer.set(bytes, this.length);
    this.length = requiredBytes;
  }

  take(current: Uint8Array): Uint8Array {
    if (this.length === 0) return current;

    const line = new Uint8Array(this.length + current.byteLength);
    line.set(this.buffer!.subarray(0, this.length));
    line.set(current, this.length);
    this.clear();
    return line;
  }

  isJsonWhitespaceLine(current: Uint8Array): boolean {
    if (this.buffer) {
      for (let index = 0; index < this.length; index++) {
        if (!isJsonWhitespaceByte(this.buffer[index]!)) return false;
      }
    }
    for (const byte of current) {
      if (!isJsonWhitespaceByte(byte)) return false;
    }
    return true;
  }

  clear(): void {
    this.buffer = undefined;
    this.length = 0;
  }
}

function isJsonWhitespaceByte(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d;
}
