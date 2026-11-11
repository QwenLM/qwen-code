/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

import {
  ClientError,
  type ClientErrorOptions,
} from '../../../../../client/clientError.js';
import type { CustomInferenceApi } from '../../../../../client/api/inference/inference.js';

/** Per-request billing identity; unrelated to the authenticated account. */
export interface QoderInferenceBusiness {
  readonly id: string;
  readonly type: string;
  /** Existing runtime task label, forwarded as metadata.sub_task. */
  readonly sub_task?: string;
  /** User-selected model at turn creation; forwarded for usage attribution. */
  readonly model_key?: string;
}

export interface QoderInferenceRequest {
  /** Responses request body, already converted from the host's model input. */
  readonly body: ResponseCreateParamsStreaming;
  /** Logical model call ID for local correlation, not the physical HTTP ID. */
  readonly requestId?: string;
  readonly business?: QoderInferenceBusiness;
  /** Optional runtime task-routing label; no implicit default. */
  readonly taskId?: string;
  /** Selected input context tier, used for attribution only. */
  readonly contextLength?: number;
  /** Stable per host session; falls back to a generated value for this call. */
  readonly sessionId?: string;
  /** Existing source session for derived execution; never substitutes sessionId. */
  readonly sourceSessionId?: string;
  /** Stable per user turn; tool continuations must reuse the same value. */
  readonly requestSetId?: string;
}

export interface QoderInferenceStreamOptions {
  readonly signal?: AbortSignal;
  readonly sessionId?: string;
  readonly requestSetId?: string;
}

export interface QoderInferenceErrorOptions
  extends Pick<ClientErrorOptions, 'requestId' | 'responseBody' | 'code'> {
  readonly status?: number;
  readonly traceId?: string;
  readonly subCode?: string;
  readonly modelKey?: string;
  readonly confirmationExpiresAt?: number;
}

export class QoderInferenceError extends ClientError {
  readonly status?: number;
  readonly traceId?: string;
  readonly subCode?: string;
  readonly modelKey?: string;
  readonly confirmationExpiresAt?: number;

  constructor(
    message: string,
    options?: QoderInferenceErrorOptions,
  ) {
    super(message, {
      operation: 'inference.responses.stream',
      statusCode: options?.status,
      responseBody: options?.responseBody,
      requestId: options?.requestId,
      code: options?.code,
    });
    this.name = 'QoderInferenceError';
    if (options?.status !== undefined) {
      this.status = options.status;
    }
    if (options?.traceId !== undefined) {
      this.traceId = options.traceId;
    }
    if (options?.subCode !== undefined) {
      this.subCode = options.subCode;
    }
    if (options?.modelKey !== undefined) {
      this.modelKey = options.modelKey;
    }
    if (options?.confirmationExpiresAt !== undefined) {
      this.confirmationExpiresAt = options.confirmationExpiresAt;
    }
  }
}

/**
 * Qoder Responses gateway streaming.
 *
 * Extends the generic inference facade so `QoderClient` structurally satisfies
 * `CustomClient`. The compatibility `responses.stream` accepts a prebuilt body;
 * the Qoder provider uses `stream` for explicit per-request attribution.
 */
export interface QoderInferenceApi extends CustomInferenceApi {
  stream(
    request: QoderInferenceRequest,
    options?: QoderInferenceStreamOptions,
  ): AsyncIterable<ResponseStreamEvent>;
}
