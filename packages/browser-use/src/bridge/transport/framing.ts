/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MAX_BRIDGE_FRAME_BYTES } from '../protocol.js';

export function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.byteLength > MAX_BRIDGE_FRAME_BYTES) {
    throw new Error(`Bridge frame exceeds ${MAX_BRIDGE_FRAME_BYTES} bytes`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([header, payload]);
}

export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffered =
      this.buffered.byteLength === 0
        ? chunk
        : Buffer.concat([this.buffered, chunk]);
    const messages: unknown[] = [];
    while (this.buffered.byteLength >= 4) {
      const length = this.buffered.readUInt32LE(0);
      if (length > MAX_BRIDGE_FRAME_BYTES) {
        throw new Error(
          `Bridge frame declares ${length} bytes; maximum is ${MAX_BRIDGE_FRAME_BYTES}`,
        );
      }
      if (this.buffered.byteLength < length + 4) break;
      const payload = this.buffered.subarray(4, length + 4);
      this.buffered = this.buffered.subarray(length + 4);
      messages.push(JSON.parse(payload.toString('utf8')) as unknown);
    }
    return messages;
  }
}
