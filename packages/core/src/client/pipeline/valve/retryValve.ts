/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isServerRetryDisabled } from '../../../protocol/provider/qoder-api-error.js';
import { calculateExponentialBackoffMs } from '../../../utils/backoff.js';
import { delay } from '../../../utils/delay.js';
import {
  composeAbortSignals,
  discardResponseBody,
} from '../../../utils/fetch.js';
import { readRetryAfterHeaderMs } from '../../../utils/retry-after.js';
import type { CustomRequest } from '../../request/customRequest.js';
import type { CustomResponse } from '../../response/customResponse.js';
import {
  isPreRequestFailurePhase,
  readNetworkFailurePhase,
  type NetworkFailurePhase,
} from '../../utils/networkUtils.js';
import { BaseValve } from './valve.js';
import { ValveError } from './valveError.js';

const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Statuses proving the peer declined to serve the request at all: no work was
 * started, so even a non-idempotent request may be re-issued.
 */
const UNEXECUTED_RETRY_STATUSES = Object.freeze([429, 503]);

/**
 * Statuses leaving execution undecided: the peer may have run the request
 * before failing, so only an idempotent request may be re-issued.
 */
const UNDECIDED_RETRY_STATUSES = Object.freeze([408, 500, 502, 504]);

/**
 * Phases an idempotent request may replay. A phase proving the request was
 * never committed is replayable for any request; the rest are only safe when
 * re-running the work is harmless.
 */
const IDEMPOTENT_RETRIABLE_FAILURE_PHASES: ReadonlySet<NetworkFailurePhase> =
  new Set([
    'dns',
    'proxy_connect',
    'connect',
    'tls',
    'request_write',
    'response_headers',
    'timeout',
  ]);

type RetryTerminalReason = 'deadline' | 'retries_exhausted';

const RETRY_TERMINAL_MESSAGES: Record<RetryTerminalReason, string> = {
  deadline: 'Retry deadline exceeded',
  retries_exhausted: 'Retries exhausted after replayable failures',
};

/**
 * Re-issues a failed send to the very same target, placed immediately before
 * the transport stage so one pass drives exactly one wire send.
 *
 * This valve owns "send it again", nothing else. It never changes where the
 * request goes: the URL, the pinned address and every header stay as its
 * upstream valves left them. Choosing a different domain or a different
 * address belongs to the route layers above it, which re-enter this valve with
 * a new target once they decide to move.
 *
 * Two counters are kept apart. Physical sends bound the loop, while logical
 * attempts — the ones that actually reached the peer — spend the contract
 * budget, so a connect or TLS failure never burns an attempt the peer never saw.
 *
 * A non-idempotent request is re-issued only on evidence that the peer did
 * nothing: a pre-request failure phase, or a status that declines service
 * outright. Anything ambiguous surfaces unchanged rather than risk a duplicate.
 */
export class RetryValve extends BaseValve {
  async invoke(request: CustomRequest, response: CustomResponse): Promise<void> {
    const maxAttempts = request.maxAttempts;
    if (maxAttempts === undefined) {
      throw new ValveError('Retry budget is not settled', {
        valveName: 'retry',
        step: 'budget',
      });
    }

    const establishmentTimeoutMs = request.establishmentTimeoutMs;
    const deadline = makeDeadline(establishmentTimeoutMs);
    const backoff = request.signal
      ? composeAbortSignals([request.signal, deadline.signal])
      : { signal: deadline.signal, cleanup: () => {} };

    let physicalAttempts = 0;
    let logicalAttempts = 0;

    try {
      while (true) {
        request.signal?.throwIfAborted();
        // The first send is unconditional; only a re-issue needs remaining time.
        if (physicalAttempts > 0 && deadline.remainingMs() <= 0) {
          throw terminal('deadline');
        }
        physicalAttempts++;
        if (establishmentTimeoutMs !== undefined) {
          request.establishmentTimeoutMs = deadline.remainingMs();
        }

        let waitMs: number | undefined;
        try {
          await this.getNext()!.invoke(request, response);
        } catch (error) {
          // A server veto and a caller abort are both final: never re-issued.
          if (isServerRetryDisabled(error) || request.signal?.aborted) {
            throw error;
          }
          const phase = readNetworkFailurePhase(error, {
            callerSignal: request.signal,
            deadlineSignal: deadline.signal,
          });
          if (phase === 'abort') throw error;
          if (phase === 'timeout' && deadline.signal.aborted) {
            throw terminal('deadline', error);
          }
          // A failure before the request was committed never reached the peer,
          // so it does not spend the logical budget.
          if (!isPreRequestFailurePhase(phase)) logicalAttempts++;
          if (!canReplayFailure(request, maxAttempts, phase)) throw error;
          if (logicalAttempts >= maxAttempts) {
            throw terminal('retries_exhausted', error);
          }
          waitMs = backoffMs(logicalAttempts);
        }

        if (waitMs === undefined) {
          logicalAttempts++;
          if (
            logicalAttempts >= maxAttempts ||
            !shouldRetryStatus(response.raw?.status, request)
          ) {
            // A status this valve will not re-issue is surfaced verbatim for
            // the outer error stage to judge.
            return;
          }
          waitMs = retryAfterMs(response) ?? backoffMs(logicalAttempts);
          // Drain the discarded body before re-issuing so the socket frees.
          await discardResponseBody(response.raw, { timeoutMs: 500 });
          response.raw = undefined;
        }

        if (deadline.remainingMs() <= waitMs) throw terminal('deadline');
        await delay(waitMs, backoff.signal);
        request.signal?.throwIfAborted();
      }
    } finally {
      backoff.cleanup();
      deadline.cleanup();
      request.establishmentTimeoutMs = establishmentTimeoutMs;
    }
  }
}

function terminal(reason: RetryTerminalReason, cause?: unknown): ValveError {
  return new ValveError(RETRY_TERMINAL_MESSAGES[reason], {
    valveName: 'retry',
    step: reason,
    cause,
  });
}

/**
 * Whether a completed response carries a status worth sending again. A send
 * that produced no response at all leaves nothing to judge, so it stands.
 */
function shouldRetryStatus(
  status: number | undefined,
  request: CustomRequest,
): boolean {
  if (status === undefined) return false;
  if (request.bodyReplayable !== true) return false;
  if (UNEXECUTED_RETRY_STATUSES.includes(status)) return true;
  return (
    request.idempotent === true && UNDECIDED_RETRY_STATUSES.includes(status)
  );
}

/** Whether a thrown failure may be sent again to the same target. */
function canReplayFailure(
  request: CustomRequest,
  maxAttempts: number,
  phase: NetworkFailurePhase,
): boolean {
  if (maxAttempts <= 1 || request.bodyReplayable !== true) return false;
  if (request.idempotent === true) {
    return IDEMPOTENT_RETRIABLE_FAILURE_PHASES.has(phase);
  }
  // Otherwise only a phase proving the request never reached the peer.
  return isPreRequestFailurePhase(phase);
}

/** Equal jitter: keeps a real lower bound while spreading the herd. */
function backoffMs(logicalAttempts: number): number {
  return calculateExponentialBackoffMs({
    attempt: Math.max(1, logicalAttempts),
    baseDelayMs: RETRY_BASE_DELAY_MS,
    maxBaseDelayMs: MAX_RETRY_DELAY_MS,
    minJitterFactor: 0.5,
    maxJitterFactor: 1,
  });
}

/** The peer's own pacing instruction outranks any computed backoff. */
function retryAfterMs(response: CustomResponse): number | undefined {
  if (!response.raw) return undefined;
  const headerMs = readRetryAfterHeaderMs(response.raw.headers);
  return headerMs === undefined
    ? undefined
    : Math.min(headerMs, MAX_RETRY_DELAY_MS);
}

function makeDeadline(totalMs: number | undefined): {
  signal: AbortSignal;
  remainingMs(): number;
  cleanup(): void;
} {
  if (totalMs === undefined) {
    return {
      signal: new AbortController().signal,
      remainingMs: () => Infinity,
      cleanup: () => {},
    };
  }
  const controller = new AbortController();
  const expiresAt = performance.now() + totalMs;
  const timer = setTimeout(() => controller.abort(), totalMs);
  return {
    signal: controller.signal,
    remainingMs: () => Math.max(0, expiresAt - performance.now()),
    cleanup: () => clearTimeout(timer),
  };
}
