/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactQoderApiSensitiveText } from '../protocol/provider/qoder-api-error.js';
import { classifyStopFailureError } from '../core/stream-errors.js';

export {
  observationMonotonicNow,
  observationElapsedMs,
  observationWaitFailureStatus,
} from '../utils/observation-clock.js';

function read(value: unknown, key: string): unknown {
  try {
    return value !== null &&
      (typeof value === 'object' || typeof value === 'function')
      ? (value as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return redactQoderApiSensitiveText(value).slice(0, 2_048);
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : safeText(value);
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** Bounded error metadata, including causes, without sharing the original Error. */
export function modelRequestObservationError(
  error: unknown,
): Record<string, unknown> {
  try {
    if (error === undefined || error === null) return {};
    const chain: Array<Record<string, unknown>> = [];
    const seen = new Set<unknown>();
    let current: unknown = error;
    for (
      let depth = 0;
      current !== undefined && current !== null && depth < 4;
      depth++
    ) {
      if (seen.has(current)) break;
      seen.add(current);
      const details =
        read(current, 'qoderApiError') ?? read(current, 'providerError');
      chain.push({
        error_type: safeText(read(current, 'name')),
        error_code:
          safeCode(read(details, 'code')) ??
          safeCode(read(current, 'code')) ??
          safeCode(read(current, 'error_code')),
        error_message: safeText(read(current, 'message')) ?? safeText(current),
        status_code:
          safeNumber(read(current, 'httpStatus')) ??
          safeNumber(read(current, 'status')) ??
          safeNumber(read(current, 'statusCode')) ??
          safeNumber(read(details, 'status_code')) ??
          safeNumber(read(details, 'statusCode')),
      });
      current = read(current, 'cause');
    }
    let failureReason: string | undefined;
    try {
      failureReason = classifyStopFailureError(error);
    } catch {
      // Hostile getters or unusual errors must not suppress the safe fields.
    }
    const first = chain[0] ?? {};
    return {
      ...first,
      failure_reason: failureReason,
      ...(chain.length > 1 ? { error_causes: chain.slice(1) } : {}),
    };
  } catch {
    return {};
  }
}
