/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClientError, RESPONSE_TOO_LARGE_CODE } from '../clientError.js';

/** 按响应头与累计读取量限制缓冲字节数，退出时取消 reader。 */
export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  operation: string,
): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ClientError(
      `${operation}: response exceeds the ${maxBytes}-byte download limit`,
      { code: RESPONSE_TOO_LARGE_CODE, operation, statusCode: response.status },
    );
  }
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ClientError(
          `${operation}: response exceeds the ${maxBytes}-byte download limit`,
          {
            code: RESPONSE_TOO_LARGE_CODE,
            operation,
            statusCode: response.status,
          },
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
