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
  const expectedBytes = Buffer.from(expected, 'base64url');
  const actualBytes = Buffer.from(actual, 'base64url');
  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}
