/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { encodeFrame } from '../transport/framing.js';

export const NATIVE_MESSAGE_CHUNK_TYPE = 'qwen.browser.chunk';
const MAX_NATIVE_MESSAGE_BYTES = 1_048_576;
const CHUNK_BYTES = 700_000;

export function encodeNativeMessagingOutput(
  message: unknown,
  chunkId: string,
): Buffer[] {
  const direct = encodeFrame(message);
  if (direct.length <= MAX_NATIVE_MESSAGE_BYTES) return [direct];

  const payload = Buffer.from(JSON.stringify(message));
  const total = Math.ceil(payload.length / CHUNK_BYTES);
  return Array.from({ length: total }, (_, index) =>
    encodeFrame({
      type: NATIVE_MESSAGE_CHUNK_TYPE,
      id: chunkId,
      index,
      total,
      data: payload
        .subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)
        .toString('base64'),
    }),
  );
}
