/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DashScopeErrorEnvelope } from './types.js';
import type { DashScopeSseFrame } from './sse.js';

const MAX_RAW_BODY_MESSAGE_LENGTH = 500;

export class DashScopeApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly request_id?: string;

  constructor(args: {
    message: string;
    status?: number;
    code?: string;
    requestId?: string;
  }) {
    super(args.message);
    this.name = 'DashScopeApiError';
    this.status = args.status;
    this.code = args.code;
    this.requestId = args.requestId;
    this.request_id = args.requestId;
  }
}

export class DashScopeStreamTruncatedError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(message: string) {
    super(message);
    this.name = 'DashScopeStreamTruncatedError';
  }
}

function truncate(value: string): string {
  return value.length > MAX_RAW_BODY_MESSAGE_LENGTH
    ? `${value.slice(0, MAX_RAW_BODY_MESSAGE_LENGTH)}...`
    : value;
}

function parseJsonEnvelope(value: string): DashScopeErrorEnvelope | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as DashScopeErrorEnvelope;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseSseFramedEnvelope(
  rawBody: string,
): DashScopeErrorEnvelope | undefined {
  for (const line of rawBody.split('\n')) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (trimmed.startsWith('data:')) {
      return parseJsonEnvelope(trimmed.slice('data:'.length));
    }
  }
  return undefined;
}

function extractErrorEnvelope(
  rawBody: string | undefined,
): DashScopeErrorEnvelope | undefined {
  if (rawBody === undefined) {
    return undefined;
  }
  return parseJsonEnvelope(rawBody) ?? parseSseFramedEnvelope(rawBody);
}

function buildErrorMessage(args: {
  status?: number;
  code?: string;
  message: string;
  requestId?: string;
}): string {
  let prefix = 'DashScope API error';
  if (args.status !== undefined) {
    prefix += ` ${args.status}`;
  }
  if (args.code) {
    prefix += ` (${args.code})`;
  }
  let message = `${prefix}: ${args.message}`;
  if (args.requestId) {
    message += ` [request_id: ${args.requestId}]`;
  }
  return message;
}

export function toDashScopeApiError(args: {
  status?: number;
  rawBody?: string;
  headers?: Headers;
}): DashScopeApiError {
  const envelope = extractErrorEnvelope(args.rawBody);
  const requestId =
    envelope?.request_id ?? args.headers?.get('x-request-id') ?? undefined;
  const providerMessage =
    envelope?.message ??
    (args.rawBody !== undefined ? truncate(args.rawBody) : '');

  return new DashScopeApiError({
    message: buildErrorMessage({
      status: args.status,
      code: envelope?.code,
      message: providerMessage,
      requestId,
    }),
    status: args.status,
    code: envelope?.code,
    requestId,
  });
}

export function dashScopeErrorFromFrame(
  frame: DashScopeSseFrame,
): DashScopeApiError | undefined {
  if (
    frame.event === 'error' ||
    (frame.httpStatus !== undefined && frame.httpStatus >= 400)
  ) {
    return toDashScopeApiError({
      status: frame.httpStatus,
      rawBody: frame.data,
    });
  }
  return undefined;
}
