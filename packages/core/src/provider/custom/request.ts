/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ApiKeyResolver } from '../../auth/apiKeyResolver.js';
import type { BearerResolver } from '../../auth/bearerResolver.js';
import { INFERENCE } from '../../client/endpoint/endpointType.js';
import type { EndpointResolver } from '../../client/endpoint/endpointResolver.js';
import { buildCustomOutboundPipeline } from '../../client/pipeline/outboundPipelineFactory.js';
import { CustomRequest } from '../../client/request/customRequest.js';

interface CustomProviderRequestOptionsBase {
  operation: string;
  requestId: string;
  singleAttempt?: boolean;
}

export type CustomProviderRequestOptions =
  | (CustomProviderRequestOptionsBase & {
      streamResponse: true;
      firstPayloadTimeoutMs: number;
      streamIdleTimeoutMs?: number;
    })
  | (CustomProviderRequestOptionsBase & {
      streamResponse?: false;
      requestTimeoutMs: number;
      bodyIdleTimeoutMs?: number;
    });

// 目标由调用方给定的绝对 URL 承载，管线不需要解析链，也不附加任何首方凭证。
const ABSOLUTE_URL_ONLY: EndpointResolver = {
  resolve: () => Promise.resolve(undefined),
};
const NO_BEARER: BearerResolver = { getBearer: () => undefined };
const NO_API_KEY: ApiKeyResolver = { getApiKey: () => undefined };

function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  if (Array.isArray(headers)) {
    for (const [name, value] of headers) record[name] = value;
    return record;
  }
  if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((value, name) => {
      record[name] = value;
    });
    return record;
  }
  return { ...(headers as Record<string, string>) };
}

/**
 * Sends a third-party provider request through the shared outbound pipeline.
 *
 * The destination is the URL the caller already resolved, so no endpoint
 * election applies, and no client identity, trace or bearer credential is
 * injected: a third-party host must receive exactly the headers the provider
 * adapter built. HTTP statuses are surfaced to the adapter unchanged.
 */
export async function customProviderRequest(
  url: string,
  init: RequestInit,
  options: CustomProviderRequestOptions,
): Promise<Response> {
  const signal = init.signal ?? undefined;
  const request = new CustomRequest({
    operation: options.operation,
    requestId: options.requestId,
    endpointType: INFERENCE,
    url,
    method: (init.method ?? 'GET').toUpperCase(),
    headers: toHeaderRecord(init.headers),
    ...(init.body === null || init.body === undefined
      ? {}
      : { body: init.body }),
    ...(signal === undefined ? {} : { signal }),
    ...(init.redirect === undefined ? {} : { redirect: init.redirect }),
    streamResponse: options.streamResponse === true,
    requireBearer: false,
    requireApiKey: false,
    ...(options.streamResponse
      ? {
          firstPayloadTimeoutMs: options.firstPayloadTimeoutMs,
          bodyIdleTimeoutMs: options.streamIdleTimeoutMs,
        }
      : {
          requestTimeoutMs: options.requestTimeoutMs,
          bodyIdleTimeoutMs: options.bodyIdleTimeoutMs,
        }),
    // 单次尝试：非幂等请求不得在无法确认对端未执行时自动重放。
    ...(options.singleAttempt
      ? {
          maxAttempts: 1,
          addressFailover: false,
          preRequestAddressFailover: false,
        }
      : {}),
  });

  const pipeline = buildCustomOutboundPipeline({
    endpointResolver: ABSOLUTE_URL_ONLY,
    bearerResolver: NO_BEARER,
    apiKeyResolver: NO_API_KEY,
  });
  const response = (await pipeline.execute(request)).raw;
  if (!response) {
    throw new Error(
      `${options.operation}: no response from ${new URL(url).host}`,
    );
  }
  return response;
}
