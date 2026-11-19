/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  jsonRpcErrorToHttpStatusWithData,
  mergeHeaders,
} from '../../src/daemon/acpTransportUtils.js';

describe('mergeHeaders', () => {
  const callerHeaders: Array<[string, HeadersInit]> = [
    ['object', { authorization: 'Bearer caller' }],
    ['tuples', [['authorization', 'Bearer caller']]],
    ['Headers', new Headers({ authorization: 'Bearer caller' })],
  ];

  it.each(callerHeaders)(
    'uses caller headers with different casing (%s)',
    (_name, headers) => {
      const defaults = { Authorization: 'Bearer transport' };
      const merged = new Headers(mergeHeaders(defaults, headers));
      expect(merged.get('authorization')).toBe('Bearer caller');
      expect(defaults).toEqual({ Authorization: 'Bearer transport' });
    },
  );

  it('overrides matching names and preserves unrelated transport headers', () => {
    const headers = new Headers(
      mergeHeaders(
        { Authorization: 'Bearer transport', Accept: 'application/json' },
        { Authorization: 'Bearer caller', 'X-Request-ID': 'request-1' },
      ),
    );
    expect(headers.get('authorization')).toBe('Bearer caller');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('x-request-id')).toBe('request-1');
  });

  it('keeps transport headers when caller headers are absent', () => {
    expect(
      mergeHeaders({ Authorization: 'Bearer transport' }, undefined),
    ).toEqual({
      Authorization: 'Bearer transport',
    });
  });
});

describe('jsonRpcErrorToHttpStatusWithData', () => {
  it.each(['session_archived', 'session_conflict', 'session_archiving'])(
    'maps %s to HTTP 409',
    (errorKind) => {
      expect(
        jsonRpcErrorToHttpStatusWithData(-32603, {
          errorKind,
          sessionId: 's-1',
        }),
      ).toBe(409);
    },
  );
});
