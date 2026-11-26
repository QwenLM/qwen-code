/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isServerRetryDisabled } from '../../../protocol/provider/qoder-api-error.js';
import type { CustomRequest } from '../../request/customRequest.js';
import type { CustomResponse } from '../../response/customResponse.js';
import {
  isPreRequestFailurePhase,
  isTlsCertRouteFailure,
  type NetworkFailurePhase,
  readNetworkFailurePhase,
} from '../../utils/networkUtils.js';
import { BaseValve } from './valve.js';

const UNEXECUTED_STATUSES: readonly number[] = [429, 503];

const UNDECIDED_STATUSES: readonly number[] = [408, 500, 502, 504];

const REPLAYABLE_PHASES: ReadonlySet<NetworkFailurePhase> = new Set([
  'dns',
  'proxy_connect',
  'connect',
  'tls',
  'request_write',
  'response_headers',
  'timeout',
]);

export class RetryValve extends BaseValve {
  async invoke(
    request: CustomRequest,
    response: CustomResponse,
  ): Promise<void> {
    try {
      await this.getNext()!.invoke(request, response);
    } catch (error) {
      const attempts = request.maxAttempts ?? 0;
      if (attempts <= 1 || !this.retryable(error, request)) {
        throw error;
      }
      response.raw = undefined;
      request.maxAttempts = attempts - 1;
      return this.invoke(request, response);
    }
  }

  private retryable(error: unknown, request: CustomRequest): boolean {
    if (request.signal?.aborted) return false;
    if (request.bodyReplayable === false) return false;
    if (isServerRetryDisabled(error)) return false;

    const status = this.thrownStatus(error);
    if (status !== undefined) return this.statusReplayable(status, request);

    const phase = readNetworkFailurePhase(error, {
      callerSignal: request.signal,
    });
    if (isTlsCertRouteFailure(phase, error)) return false;
    return this.phaseReplayable(phase, request);
  }

  private statusReplayable(status: number, request: CustomRequest): boolean {
    if (UNEXECUTED_STATUSES.includes(status)) return true;
    return request.idempotent === true && UNDECIDED_STATUSES.includes(status);
  }

  private phaseReplayable(
    phase: NetworkFailurePhase,
    request: CustomRequest,
  ): boolean {
    if (request.idempotent === true) return REPLAYABLE_PHASES.has(phase);
    return isPreRequestFailurePhase(phase);
  }

  private thrownStatus(error: unknown): number | undefined {
    const status = (error as { statusCode?: unknown } | undefined)?.statusCode;
    return typeof status === 'number' ? status : undefined;
  }
}
