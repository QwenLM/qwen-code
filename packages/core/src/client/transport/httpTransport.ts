/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomRequest } from '../request/customRequest.js';
import type { CustomResponse } from '../response/customResponse.js';
import {
  fetchWithResolvedIp,
  proxiedFetch,
  withFetchTimeouts,
} from '../../utils/fetch.js';
import type { Transport } from './transport.js';
import {
  beginModelPhysicalSend,
  failModelPhysicalSend,
  finishModelPhysicalSend,
} from './modelRequestPhysicalObservation.js';

/**
 * Protocol-neutral HTTP wire transport. The input owns route selection results;
 * this transport only applies proxy, resolved-IP, or direct dispatch.
 */
export class HttpTransport implements Transport {
  async invoke(input: CustomRequest, output: CustomResponse): Promise<void> {
    const deadline = new AbortController();
    const timeoutMs = input.establishmentTimeoutMs;
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            deadline.abort(
              new DOMException(
                'HTTP establishment deadline exceeded',
                'TimeoutError',
              ),
            );
          }, timeoutMs);
    timeout?.unref?.();
    // Keep caller cancellation attached after headers: it also owns body reads.
    // Only the establishment timer is cleared when the transport returns.
    const signal =
      timeoutMs === undefined
        ? input.signal
        : input.signal
          ? AbortSignal.any([input.signal, deadline.signal])
          : deadline.signal;
    try {
      const init = withFetchTimeouts(
        {
          method: input.method,
          headers: { ...input.headers },
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(signal !== undefined ? { signal } : {}),
          ...(input.redirect !== undefined ? { redirect: input.redirect } : {}),
        },
        {
          ...(input.connectTimeoutMs !== undefined
            ? { connectTimeoutMs: input.connectTimeoutMs }
            : {}),
          ...(input.responseHeadersTimeoutMs !== undefined
            ? { requestTimeoutMs: input.responseHeadersTimeoutMs }
            : input.requestTimeoutMs !== undefined
              ? { requestTimeoutMs: input.requestTimeoutMs }
              : {}),
          bodyIdleTimeoutMs: input.streamResponse ? 0 : input.bodyIdleTimeoutMs,
        },
      );
      const observation = beginModelPhysicalSend(input);
      try {
        output.raw = input.proxy
          ? await proxiedFetch(input.url, init, { proxyUrl: input.proxy })
          : input.ip
            ? await fetchWithResolvedIp(input.url, init, {
                ip: input.ip,
                originalHostname: new URL(input.url).hostname,
              })
            : await proxiedFetch(input.url, init);
        finishModelPhysicalSend(observation, () => output.raw?.status);
      } catch (error) {
        failModelPhysicalSend(observation, error);
        throw error;
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
