/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
}

interface TextDecoderLike {
  decode(input?: Uint8Array): string;
}

export function ndJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  hooks?: NdJsonStreamHooks,
): Stream {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      const pending: Uint8Array[] = [];
      const reader = input.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          readChunk(value, pending, controller, textDecoder, hooks);
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });

  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const content = JSON.stringify(message);
      const payload = textEncoder.encode(content);
      const frame = new Uint8Array(payload.byteLength + 1);
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
      } finally {
        writer.releaseLock();
      }
    },
  });

  return { readable, writable };
}

function readChunk(
  chunk: Uint8Array,
  pending: Uint8Array[],
  controller: ReadableStreamDefaultController<AnyMessage>,
  textDecoder: TextDecoderLike,
  hooks?: NdJsonStreamHooks,
): void {
  let start = 0;
  let newline = chunk.indexOf(0x0a, start);
  while (newline !== -1) {
    const lineBytes = takeLineBytes(pending, chunk.subarray(start, newline));
    handleLine(lineBytes, controller, textDecoder, hooks);
    start = newline + 1;
    newline = chunk.indexOf(0x0a, start);
  }
  if (start < chunk.length) {
    pending.push(chunk.subarray(start));
  }
}

function takeLineBytes(pending: Uint8Array[], current: Uint8Array): Uint8Array {
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

function handleLine(
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
    const bytes = jsonPayloadByteLength(lineBytes);
    callHook(hooks?.onMessageReceived, bytes);
    callHook(hooks?.onMessageObserved, {
      direction: 'received',
      bytes,
      message,
    });
  } catch (err) {
    // eslint-disable-next-line no-console -- match ACP SDK parse-error behavior
    console.error('Failed to parse JSON message:', trimmedLine, err);
  }
}

function jsonPayloadByteLength(lineBytes: Uint8Array): number {
  return lineBytes[lineBytes.byteLength - 1] === 0x0d
    ? lineBytes.byteLength - 1
    : lineBytes.byteLength;
}

function callHook<T>(hook: ((value: T) => void) | undefined, value: T): void {
  try {
    hook?.(value);
  } catch {
    /* metrics hooks must not break the transport */
  }
}
