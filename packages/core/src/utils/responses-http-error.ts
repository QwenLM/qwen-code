/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactProxyCredentials } from './runtimeFetchOptions.js';

export class ResponsesHttpError extends Error {
  readonly headers: Headers;
  readonly requestId?: string;
  readonly code?: string;
  readonly type?: string;
  readonly param?: string;
  readonly error?: Record<string, string>;

  constructor(
    readonly status: number,
    body: string,
    responseHeaders?: Pick<Headers, 'get'>,
    secrets: ReadonlyArray<string | undefined> = [],
  ) {
    const sanitize = (value: string): string => {
      let text = redactProxyCredentials(value);
      for (const secret of secrets) {
        if (secret) text = text.split(secret).join('<redacted>');
      }
      return text;
    };
    const headers = new Headers();
    for (const name of [
      'x-request-id',
      'retry-after',
      'retry-after-ms',
      'x-should-retry',
    ]) {
      const value = responseHeaders?.get(name);
      if (value) headers.set(name, sanitize(value));
    }
    let envelope: Record<string, unknown> | undefined;
    try {
      envelope = record(JSON.parse(body));
    } catch {
      // Non-JSON errors retain the existing bounded excerpt.
    }
    const gateway = record(envelope?.['routify_response']);
    const upstream =
      record(envelope?.['error']) ??
      record(record(gateway?.['error_detail'])?.['error']);
    const error: Record<string, string> = {};
    for (const name of ['message', 'code', 'type', 'param']) {
      const value = upstream?.[name];
      if (typeof value === 'string' || typeof value === 'number') {
        error[name] = sanitize(String(value));
      }
    }
    const requestId =
      headers.get('x-request-id') ??
      (string(gateway?.['request_id'])
        ? sanitize(String(gateway!['request_id']))
        : undefined);
    const diagnostic = {
      ...(Object.keys(error).length ? { error } : {}),
      ...(requestId ? { request_id: requestId } : {}),
      ...(string(gateway?.['trace_id'])
        ? { trace_id: sanitize(String(gateway!['trace_id'])) }
        : {}),
      ...(string(gateway?.['model_name'])
        ? { model_name: sanitize(String(gateway!['model_name'])) }
        : {}),
    };
    const excerpt = Object.keys(error).length
      ? JSON.stringify(diagnostic)
      : sanitize(body).substring(0, 500);
    super(
      `Responses API error ${status}: ${excerpt}` +
        (!Object.keys(error).length && requestId
          ? ` (request_id: ${requestId})`
          : ''),
    );
    this.name = 'ResponsesHttpError';
    this.headers = headers;
    this.requestId = requestId;
    this.error = Object.keys(error).length ? error : undefined;
    this.code = error['code'];
    this.type = error['type'];
    this.param = error['param'];
  }

  shouldRetry(extraRetryErrorCodes?: readonly number[]): boolean {
    const directive = this.headers.get('x-should-retry');
    if (directive === 'true') return true;
    if (directive === 'false') return false;
    return (
      this.status === 408 ||
      this.status === 409 ||
      this.status === 429 ||
      (this.status >= 500 && this.status < 600) ||
      (extraRetryErrorCodes?.includes(this.status) ?? false)
    );
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
