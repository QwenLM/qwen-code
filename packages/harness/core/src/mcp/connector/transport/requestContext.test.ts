/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/client';
import {
  MCP_REQUEST_CONTEXT_META_KEY,
  withRequestContextMeta,
} from './requestContext.js';

const info = {
  displayName: 'model',
  key: 'model-key',
  sessionId: 'session-1',
  requestSetId: 'set-1',
};

function request(
  method: string,
  params: Record<string, unknown> = {},
): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    id: 1,
    method,
    params,
  } as unknown as JSONRPCMessage;
}

describe('withRequestContextMeta', () => {
  it('adds the request-group id to stdio tools/call params', () => {
    const message = withRequestContextMeta(
      request('tools/call', {
        name: 'show',
        arguments: {},
        _meta: { existing: true },
      }),
      info,
    ) as { params: Record<string, unknown> };

    expect(message.params['_meta']).toEqual({
      existing: true,
      [MCP_REQUEST_CONTEXT_META_KEY]: { requestSetId: 'set-1' },
    });
  });

  it('omits the context when there is no request-set id', () => {
    expect(
      withRequestContextMeta(request('tools/call'), {
        ...info,
        requestSetId: undefined,
      }),
    ).toEqual(request('tools/call'));
  });

  it('leaves other methods, notifications and responses untouched', () => {
    const list = request('tools/list');
    const notification = {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    } as unknown as JSONRPCMessage;
    const response = {
      jsonrpc: '2.0',
      id: 2,
      result: {},
    } as unknown as JSONRPCMessage;

    expect(withRequestContextMeta(list, info)).toBe(list);
    expect(withRequestContextMeta(notification, info)).toBe(notification);
    expect(withRequestContextMeta(response, info)).toBe(response);
  });

  it('preserves other fields in the request-context object', () => {
    const message = withRequestContextMeta(
      request('tools/call', {
        _meta: {
          [MCP_REQUEST_CONTEXT_META_KEY]: {
            requestSetId: 'forged',
            traceId: 'trace-1',
          },
        },
      }),
      info,
    ) as { params: Record<string, unknown> };

    expect(message.params['_meta']).toEqual({
      [MCP_REQUEST_CONTEXT_META_KEY]: {
        requestSetId: 'set-1',
        traceId: 'trace-1',
      },
    });
  });
});
