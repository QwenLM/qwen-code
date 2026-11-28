/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ClientError, NETWORK_FAILURE_CODE } from '../clientError.js';

/** Shared model-stream budgets; provider configs may override them. */
export const DEFAULT_MODEL_STREAM_FIRST_PAYLOAD_TIMEOUT_MS = 120_000;
export const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 300_000;

/** First-payload timeout stays replayable: no observable output was committed. */
export function createModelStreamFirstPayloadTimeoutError(
  operation: string,
  statusCode?: number,
): ClientError {
  return Object.assign(
    new ClientError(`${operation}: first payload timeout`, {
      code: NETWORK_FAILURE_CODE,
      operation,
      ...(statusCode === undefined ? {} : { statusCode }),
    }),
    { phase: 'first_payload' as const },
  );
}

/** Idle timeout after output may resume the stream with settled tools. */
export function createModelStreamIdleTimeoutError(
  operation: string,
  statusCode?: number,
): ClientError {
  return Object.assign(
    new ClientError(`${operation}: stream idle timeout`, {
      code: NETWORK_FAILURE_CODE,
      operation,
      ...(statusCode === undefined ? {} : { statusCode }),
    }),
    { phase: 'stream_idle' as const },
  );
}
