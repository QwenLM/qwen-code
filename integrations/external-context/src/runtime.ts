/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import type { ProviderBinding } from './types.js';

export async function withProviderTimeout<T>(
  timeoutMs: number,
  requestSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return operation(
    AbortSignal.any([requestSignal, AbortSignal.timeout(timeoutMs)]),
  );
}

export async function observeProviderOperation<T>(input: {
  binding: ProviderBinding;
  operation: string;
  execute: () => Promise<T>;
  count?: (result: T) => number;
}): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await input.execute();
    log({
      provider: input.binding.type,
      operation: input.operation,
      status: 'ok',
      durationMs: performance.now() - startedAt,
      count: input.count?.(result),
    });
    return result;
  } catch (error) {
    log({
      provider: input.binding.type,
      operation: input.operation,
      status:
        error instanceof Error && error.name === 'TimeoutError'
          ? 'timeout'
          : 'error',
      durationMs: performance.now() - startedAt,
    });
    throw error;
  }
}

function log(input: {
  provider: string;
  operation: string;
  status: string;
  durationMs: number;
  count?: number;
}): void {
  const count = input.count === undefined ? '' : ` count=${input.count}`;
  process.stderr.write(
    `[external-context] provider=${input.provider} operation=${input.operation} status=${input.status} duration_ms=${Math.round(input.durationMs)}${count}\n`,
  );
}
