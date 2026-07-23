/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createHash,
  createHmac,
  timingSafeEqual,
  type BinaryLike,
} from 'node:crypto';

export interface RequestBindingInput {
  method: string;
  route: string;
  operationId: string;
  bodyDigest: string;
}

export function sha256Base64Url(value: BinaryLike): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function serializeRequestBinding(input: RequestBindingInput): string {
  return JSON.stringify([
    'qwen-enterprise-memory-request-v1',
    input.method.toUpperCase(),
    input.route,
    input.operationId,
    input.bodyDigest,
  ]);
}

export function computeRequestHmac(
  secret: BinaryLike,
  input: RequestBindingInput,
): string {
  return createHmac('sha256', secret)
    .update(serializeRequestBinding(input))
    .digest('base64url');
}

export function requestHmacMatches(expected: string, actual: string): boolean {
  const expectedBytes = decodeSha256Base64Url(expected);
  const actualBytes = decodeSha256Base64Url(actual);
  return (
    expectedBytes !== undefined &&
    actualBytes !== undefined &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

function decodeSha256Base64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return undefined;
  }
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value
    ? bytes
    : undefined;
}
