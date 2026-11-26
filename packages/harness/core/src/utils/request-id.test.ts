/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER, resolveClientRequestId } from './request-id.js';

describe('resolveClientRequestId', () => {
  it('uppercases and injects X-Request-ID for openapi endpoint types', () => {
    const headers: Record<string, string> = {};

    const requestId = resolveClientRequestId({
      endpointType: 'openapi',
      url: 'https://api.example.com/api/v1/test',
      requestId: 'client-request-123',
      headers,
    });

    expect(requestId).toBe('CLIENT-REQUEST-123');
    expect(headers[REQUEST_ID_HEADER]).toBe('CLIENT-REQUEST-123');
  });

  it('injects X-Request-ID for non-openapi endpoint types sent to openapi hosts', () => {
    const headers: Record<string, string> = {};

    const requestId = resolveClientRequestId({
      endpointType: 'unmanaged',
      url: 'https://test-openapi.example.com/api/v1/remote/environments',
      headers,
    });

    expect(requestId).toMatch(
      /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/,
    );
    expect(headers[REQUEST_ID_HEADER]).toBe(requestId);
  });

  it('canonicalizes an existing x-request-id header on openapi requests', () => {
    const headers: Record<string, string> = {
      'x-request-id': 'existing-request-id',
    };

    const requestId = resolveClientRequestId({
      endpointType: 'openapi',
      url: 'https://openapi.example.com/api/v1/test',
      headers,
    });

    expect(requestId).toBe('EXISTING-REQUEST-ID');
    expect(headers[REQUEST_ID_HEADER]).toBe('EXISTING-REQUEST-ID');
    expect(headers).not.toHaveProperty('x-request-id');
  });

  it('does not inject headers for non-openapi requests', () => {
    const headers: Record<string, string> = {};

    const requestId = resolveClientRequestId({
      endpointType: 'center',
      url: 'https://center.example.com/api/v1/test',
      requestId: 'center-request-id',
      headers,
    });

    expect(requestId).toBe('center-request-id');
    expect(headers).not.toHaveProperty(REQUEST_ID_HEADER);
  });
});
