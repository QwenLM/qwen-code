/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export async function readBoundedJson<T>(
  response: Response,
  limitBytes: number,
): Promise<T> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new Error('External service response is too large');
  }
  if (!response.body) {
    throw new Error('External service returned an empty response');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > limitBytes) {
      await reader.cancel();
      throw new Error('External service response is too large');
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new Error('External service returned invalid JSON');
  }
}
