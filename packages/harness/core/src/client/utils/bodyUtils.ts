/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Whether a request `body` can be re-serialized on a retry: self-contained
 * payloads (strings, params, blobs, form data, byte buffers) are replayable;
 * only a stream — single-read by nature — refuses replay. GET/HEAD carry no
 * meaningful body and are always replayable.
 */
export function deriveBodyReplayable(
  method: string,
  body: BodyInit | undefined | null,
): boolean {
  if (body === undefined || body === null) return true;
  const normalized = method.toUpperCase();
  if (normalized === 'GET' || normalized === 'HEAD') return true;
  if (typeof body === 'string') return true;
  if (body instanceof URLSearchParams) return true;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return true;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return true;
  if (body instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(body)) return true;
  return false;
}
