/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const INVOCATION_CONTEXT_META_KEY = 'qwen-code/invocation';
export const PRIVATE_PARENT_CAPABILITY_META_KEY =
  'qwen-code/private-parent-capability';
export const PRIVATE_ACP_CAPABILITY_ENV = 'QWEN_CODE_PRIVATE_ACP_CAPABILITY';

export interface InvocationContextV1 {
  readonly version: 1;
  readonly sessionId: string;
  readonly promptId: string;
  readonly originatorClientId?: string;
}

const invocationContextKeys = new Set([
  'version',
  'sessionId',
  'promptId',
  'originatorClientId',
]);

const invocationContextStorage = new AsyncLocalStorage<
  InvocationContextV1 | undefined
>();

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseInvocationContext(
  value: unknown,
): InvocationContextV1 | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !invocationContextKeys.has(key))) {
    return undefined;
  }
  if (
    record['version'] !== 1 ||
    !isNonBlankString(record['sessionId']) ||
    !isNonBlankString(record['promptId'])
  ) {
    return undefined;
  }

  let originatorClientId: string | undefined;
  if (Object.hasOwn(record, 'originatorClientId')) {
    if (!isNonBlankString(record['originatorClientId'])) {
      return undefined;
    }
    originatorClientId = record['originatorClientId'];
  }

  return Object.freeze({
    version: 1,
    sessionId: record['sessionId'],
    promptId: record['promptId'],
    ...(originatorClientId ? { originatorClientId } : {}),
  });
}

export function runWithInvocationContext<T>(
  context: InvocationContextV1 | undefined,
  callback: () => T,
): T {
  return invocationContextStorage.run(context, callback);
}

export function getInvocationContext(): InvocationContextV1 | undefined {
  return invocationContextStorage.getStore();
}
