/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SDKMessage } from '@qwen-code/core';

export type ControlResponseSubtype = 'success' | 'error';

export interface ControlRequestEnvelope {
  type: 'control_request';
  request_id: string;
  request: Record<string, unknown>;
}

export interface ControlResponseEnvelope {
  type: 'control_response';
  response: {
    subtype: ControlResponseSubtype;
    request_id: string;
    response?: Record<string, unknown>;
    error?: string;
    code?: string;
    pending_permission_requests?: ControlRequestEnvelope[];
  };
}

export interface ControlCancelRequestEnvelope {
  type: 'control_cancel_request';
  request_id: string;
}

export interface KeepAliveMessage {
  type: 'keep_alive';
}

/** Internal frame carrying transcript entries committed by the CLI. */
export interface TranscriptMirrorMessage {
  type: 'transcript_mirror';
  /**
   * Present on the daemon route, where many Sessions share one connection and
   * the SDK must attribute every frame to a Session. Absent on the legacy
   * single-session stdout, which needs no routing key.
   */
  session_id?: string;
  filePath: string;
  entries: unknown[];
}

export type SdkStdoutMessage =
  | SDKMessage
  | ControlRequestEnvelope
  | ControlResponseEnvelope
  | ControlCancelRequestEnvelope
  | KeepAliveMessage
  | TranscriptMirrorMessage;

export type StdoutMessage = SdkStdoutMessage;

export function isSdkMessage(message: StdoutMessage): message is SDKMessage {
  return (
    message.type !== 'control_request' &&
    message.type !== 'control_response' &&
    message.type !== 'control_cancel_request' &&
    message.type !== 'keep_alive' &&
    message.type !== 'transcript_mirror'
  );
}

export interface ParsedControlRequest {
  requestId: string;
  request: Record<string, unknown>;
  subtype?: string;
}

export interface ParsedControlResponse {
  requestId: string;
  subtype: ControlResponseSubtype;
  response?: Record<string, unknown>;
  error?: string;
  code?: string;
  pendingPermissionRequests?: ControlRequestEnvelope[];
}

export function normalizeControlMessageKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  const record = obj as Record<string, unknown>;
  if ('requestId' in record && !('request_id' in record)) {
    record['request_id'] = record['requestId'];
    delete record['requestId'];
  }

  if ('response' in record && isRecord(record['response'])) {
    const response = record['response'];
    if ('requestId' in response && !('request_id' in response)) {
      response['request_id'] = response['requestId'];
      delete response['requestId'];
    }
  }

  return obj;
}

export function getControlRequestSubtype(
  request: Record<string, unknown>,
): string | undefined {
  return asString(request['subtype']) ?? asString(request['type']);
}

export function parseControlRequest(
  value: unknown,
): ParsedControlRequest | null {
  const normalized = normalizeControlMessageKeys(value);
  if (!isRecord(normalized)) {
    return null;
  }

  const requestId = asString(normalized['request_id']);
  if (!requestId) {
    return null;
  }

  const request = isRecord(normalized['request'])
    ? normalized['request']
    : normalized;
  const subtype =
    getControlRequestSubtype(request) ??
    asString(normalized['subtype']) ??
    asString(normalized['type']);

  return {
    requestId,
    request,
    subtype,
  };
}

export function buildControlResponse(
  requestId: string,
  subtype: ControlResponseSubtype,
  extra?: Record<string, unknown>,
): ControlResponseEnvelope {
  const response: ControlResponseEnvelope['response'] = {
    subtype,
    request_id: requestId,
  };

  if (subtype === 'success') {
    if (extra && Object.keys(extra).length > 0) {
      response.response = extra;
    }
  } else if (extra) {
    response.error = asString(extra['error']) ?? 'Unknown error';
    const code = asString(extra['code']);
    if (code) {
      response.code = code;
    }
    if (Array.isArray(extra['pending_permission_requests'])) {
      response.pending_permission_requests = extra[
        'pending_permission_requests'
      ] as ControlRequestEnvelope[];
    }
  } else {
    response.error = 'Unknown error';
  }

  return {
    type: 'control_response',
    response,
  };
}

export function buildControlRequest(
  requestId: string,
  request: Record<string, unknown>,
): ControlRequestEnvelope {
  const subtype = getControlRequestSubtype(request);
  return {
    type: 'control_request',
    request_id: requestId,
    request:
      subtype && !('subtype' in request)
        ? {
            ...request,
            subtype,
          }
        : request,
  };
}

export function buildControlCancelRequest(
  requestId: string,
): ControlCancelRequestEnvelope {
  return {
    type: 'control_cancel_request',
    request_id: requestId,
  };
}

export function parseControlResponse(
  value: unknown,
): ParsedControlResponse | null {
  const normalized = normalizeControlMessageKeys(value);
  if (!isRecord(normalized) || normalized['type'] !== 'control_response') {
    return null;
  }

  const response = isRecord(normalized['response'])
    ? normalized['response']
    : null;
  if (!response) {
    return null;
  }

  const requestId = asString(response['request_id']);
  const subtype = asControlResponseSubtype(response['subtype']);
  if (!requestId || !subtype) {
    return null;
  }

  return {
    requestId,
    subtype,
    response: isRecord(response['response']) ? response['response'] : undefined,
    error: asString(response['error']),
    code: asString(response['code']),
    pendingPermissionRequests: Array.isArray(
      response['pending_permission_requests'],
    )
      ? (response['pending_permission_requests'] as ControlRequestEnvelope[])
      : undefined,
  };
}

export function isControlCancelRequest(value: unknown): value is {
  type: 'control_cancel_request' | 'control_cancel';
  request_id: string;
} {
  const normalized = normalizeControlMessageKeys(value);
  if (!isRecord(normalized)) {
    return false;
  }
  const type = normalized['type'];
  return (
    (type === 'control_cancel_request' || type === 'control_cancel') &&
    asString(normalized['request_id']) !== undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asControlResponseSubtype(
  value: unknown,
): ControlResponseSubtype | undefined {
  return value === 'success' || value === 'error' ? value : undefined;
}
