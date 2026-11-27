/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'X-Request-ID';

function isOpenapiHost(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().includes('openapi');
  } catch {
    return false;
  }
}

function shouldAttachOpenapiRequestId(
  endpointType: string,
  url: string,
): boolean {
  return endpointType.toLowerCase() === 'openapi' || isOpenapiHost(url);
}

function getHeaderKey(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lowerName = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === lowerName);
}

function getNonEmptyString(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function setCanonicalHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  const existingKey = getHeaderKey(headers, name);
  if (existingKey && existingKey !== name) {
    delete headers[existingKey];
  }
  headers[name] = value;
}

export function resolveClientRequestId(params: {
  endpointType: string;
  url: string;
  requestId?: string;
  headers: Record<string, string>;
}): string | undefined {
  if (!shouldAttachOpenapiRequestId(params.endpointType, params.url)) {
    return getNonEmptyString(params.requestId);
  }

  const requestIdHeaderKey = getHeaderKey(params.headers, REQUEST_ID_HEADER);
  const requestId = (
    getNonEmptyString(params.requestId) ??
    getNonEmptyString(
      requestIdHeaderKey ? params.headers[requestIdHeaderKey] : undefined,
    ) ??
    randomUUID()
  ).toUpperCase();
  setCanonicalHeader(params.headers, REQUEST_ID_HEADER, requestId);
  return requestId;
}
