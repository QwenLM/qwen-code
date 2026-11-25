/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildControlRequest,
  buildControlCancelRequest,
  buildControlResponse,
  getControlRequestSubtype,
  isSdkMessage,
  normalizeControlMessageKeys,
  parseControlRequest,
} from './controlProtocol.js';

describe('controlProtocol', () => {
  it('builds success control responses with nested response payload', () => {
    expect(buildControlResponse('req-1', 'success', { models: [] })).toEqual({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'req-1',
        response: {
          models: [],
        },
      },
    });
  });

  it('builds error control responses with nested error payload', () => {
    expect(buildControlResponse('req-2', 'error', { error: 'boom' })).toEqual({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: 'req-2',
        error: 'boom',
      },
    });
  });

  it('preserves SDK pending permission requests on error responses', () => {
    const pending = [
      buildControlRequest('pending-1', { subtype: 'can_use_tool' }),
    ];
    const response = buildControlResponse('req-2b', 'error', {
      error: 'needs approval',
      pending_permission_requests: pending,
    });

    expect(response.response.pending_permission_requests).toEqual(pending);
  });

  it('normalizes camelCase requestId keys', () => {
    const value = {
      type: 'control_request',
      requestId: 'req-3',
      request: {
        subtype: 'interrupt',
      },
    };

    expect(normalizeControlMessageKeys(value)).toEqual({
      type: 'control_request',
      request_id: 'req-3',
      request: {
        subtype: 'interrupt',
      },
    });
  });

  it('parses control requests from request.subtype', () => {
    expect(
      parseControlRequest({
        type: 'control_request',
        request_id: 'req-4',
        request: { subtype: 'initialize' },
      }),
    ).toEqual({
      requestId: 'req-4',
      request: { subtype: 'initialize' },
      subtype: 'initialize',
    });
  });

  it('falls back to request.type when subtype is absent', () => {
    expect(
      parseControlRequest({
        type: 'control_request',
        request_id: 'req-5',
        request: { type: 'interrupt' },
      }),
    ).toEqual({
      requestId: 'req-5',
      request: { type: 'interrupt' },
      subtype: 'interrupt',
    });

    expect(getControlRequestSubtype({ type: 'set_model' })).toBe('set_model');
  });

  it('builds control cancel requests', () => {
    expect(buildControlCancelRequest('req-6')).toEqual({
      type: 'control_cancel_request',
      request_id: 'req-6',
    });
  });

  it('builds control requests with normalized subtype', () => {
    expect(
      buildControlRequest('req-7', {
        type: 'interrupt',
      }),
    ).toEqual({
      type: 'control_request',
      request_id: 'req-7',
      request: {
        type: 'interrupt',
        subtype: 'interrupt',
      },
    });
  });

  it('treats control messages as non-SDK transport messages', () => {
    expect(
      isSdkMessage({
        type: 'control_request',
        request_id: 'req-8',
        request: { subtype: 'interrupt' },
      }),
    ).toBe(false);

    expect(
      isSdkMessage({
        type: 'system',
        subtype: 'init',
        session_id: 'session-1',
        uuid: 'uuid-2',
      } as never),
    ).toBe(true);
  });

  it('treats transcript mirror frames as internal transport messages', () => {
    expect(
      isSdkMessage({
        type: 'transcript_mirror',
        filePath: '/tmp/session.jsonl',
        entries: [],
      }),
    ).toBe(false);
  });
});
