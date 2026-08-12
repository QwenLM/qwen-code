/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { AnyMessage, Stream } from '@agentclientprotocol/sdk';

export interface NdJsonMessageObservation {
  direction: 'sent' | 'received';
  bytes: number;
  message: AnyMessage;
}

export interface NdJsonStreamHooks {
  onMessageReceived?: (bytes: number) => void;
  onMessageSent?: (bytes: number) => void;
  onMessageObserved?: (observation: NdJsonMessageObservation) => void;
  onTransportError?: (error: unknown) => void;
}

export interface NdJsonStreamLimits {
  maxFrameBytes: number;
  maxQueuedMessages: number;
  maxQueuedBytes: number;
}

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

export class NdJsonQueueLimitError extends Error {
  readonly code = 'ndjson_queue_limit_exceeded';

  constructor(
    readonly maxQueuedMessages: number,
    readonly maxQueuedBytes: number,
    readonly requiredBytes: number,
    readonly availableBytes: number,
  ) {
    super(
      `NDJSON decoded queue is full ` +
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

interface TextDecoderLike {
  decode(input?: Uint8Array): string;
}

export function ndJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  hooks?: NdJsonStreamHooks,
  limits?: NdJsonStreamLimits,
): Stream {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  if (limits) validateNdJsonStreamLimits(limits);

  const readable = limits
    ? createBoundedReadable(input, textDecoder, hooks, limits)
    : createLegacyReadable(input, textDecoder, hooks);

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const content = JSON.stringify(message);
      const payload = textEncoder.encode(content);
      const frameBytes = payload.byteLength + 1;
      if (limits && frameBytes > limits.maxFrameBytes) {
        const error = new NdJsonFrameTooLargeError(
          'sent',
          limits.maxFrameBytes,
          frameBytes,
        );
        callHook(hooks?.onTransportError, error);
        throw error;
      }
      const frame = new Uint8Array(frameBytes);
      frame.set(payload);
      frame[payload.byteLength] = 0x0a;
      const writer = output.getWriter();
      try {
        await writer.write(frame);
        callHook(hooks?.onMessageSent, payload.byteLength);
        callHook(hooks?.onMessageObserved, {
          direction: 'sent',
          bytes: payload.byteLength,
          message,
        });
      } catch (error) {
        if (limits) callHook(hooks?.onTransportError, error);
        throw error;
      } finally {
        writer.releaseLock();
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
): ReadableStream<AnyMessage> {
  const pending = new BoundedFrameBuffer(limits.maxFrameBytes);
  const minimumQueueCharge = Math.ceil(
    limits.maxQueuedBytes / limits.maxQueuedMessages,
  );
  let nextQueueCharge = minimumQueueCharge;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let canceled = false;

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
          minimumQueueCharge,
          (charge) => {
            nextQueueCharge = charge;
          },
          () => canceled,
        );
      },
      async cancel(reason) {
        canceled = true;
        pending.clear();
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
  minimumQueueCharge: number,
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
        controller.close();
        return;
      }
      if (!result.value) continue;
      readBoundedChunk(
        result.value,
        pending,
        controller,
        textDecoder,
        hooks,
        limits,
        minimumQueueCharge,
        setNextQueueCharge,
      );
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

function readBoundedChunk(
  chunk: Uint8Array,
  pending: BoundedFrameBuffer,
  controller: ReadableStreamDefaultController<AnyMessage>,
  textDecoder: TextDecoderLike,
  hooks: NdJsonStreamHooks | undefined,
  limits: NdJsonStreamLimits,
  minimumQueueCharge: number,
  setNextQueueCharge: (charge: number) => void,
): void {
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
    const availableBytes = controller.desiredSize;
    if (availableBytes === null || queueCharge > availableBytes) {
      throw new NdJsonQueueLimitError(
        limits.maxQueuedMessages,
        limits.maxQueuedBytes,
        queueCharge,
        Math.max(0, availableBytes ?? 0),
      );
    }
    setNextQueueCharge(queueCharge);
    handleBoundedLine(pending.take(current), controller, textDecoder, hooks);
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
): void {
  const line = textDecoder.decode(lineBytes);
  const trimmedLine = line.trim();
  if (!trimmedLine) return;

  let message: AnyMessage;
  try {
    message = JSON.parse(trimmedLine) as AnyMessage;
  } catch {
    const bytes = jsonPayloadByteLength(lineBytes);
    const digest = createHash('sha256')
      .update(lineBytes.subarray(0, bytes))
      .digest('hex');
    // eslint-disable-next-line no-console -- bounded metadata only
    console.error('Failed to parse JSON message:', {
      errorKind: 'ndjson_parse_error',
      bytes,
      sha256: digest,
      payloadOmitted: true,
    });
    return;
  }

  controller.enqueue(message);
  reportReceivedMessage(lineBytes, message, hooks);
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
