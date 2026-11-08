/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { formatHttpResponse, looksLikeHttp, parseHttpRequest } from './http.js';

const request = (text: string) => Buffer.from(text, 'utf8');

describe('parseHttpRequest', () => {
  it('waits until the headers and the declared body have arrived', () => {
    expect(
      parseHttpRequest(request('POST /connect HTTP/1.1\r\nHost: x')),
    ).toEqual({ kind: 'incomplete' });
    expect(
      parseHttpRequest(
        request('POST /connect HTTP/1.1\r\nContent-Length: 4\r\n\r\n{}'),
      ),
    ).toEqual({ kind: 'incomplete' });
  });

  it('returns the method, path, lower-cased headers and body', () => {
    const parsed = parseHttpRequest(
      request(
        'POST /connect HTTP/1.1\r\nHost: 127.0.0.1:47821\r\nOrigin: https://devbox:4170\r\nContent-Length: 2\r\n\r\n{}',
      ),
    );
    expect(parsed).toEqual({
      kind: 'complete',
      request: {
        method: 'POST',
        path: '/connect',
        headers: {
          host: '127.0.0.1:47821',
          origin: 'https://devbox:4170',
          'content-length': '2',
        },
        body: '{}',
      },
    });
  });

  it('rejects chunked bodies and malformed request lines', () => {
    expect(
      parseHttpRequest(
        request('POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n'),
      ).kind,
    ).toBe('invalid');
    expect(parseHttpRequest(request('hello there\r\n\r\n')).kind).toBe(
      'invalid',
    );
  });
});

describe('looksLikeHttp', () => {
  it('tells an HTTP request line from other input', () => {
    expect(looksLikeHttp(request('OPTIONS /connect HTTP/1.1'))).toBe(true);
    expect(looksLikeHttp(request('GET /status HTTP/1.1'))).toBe(true);
    expect(looksLikeHttp(request('not-http'))).toBe(false);
  });
});

describe('formatHttpResponse', () => {
  it('closes the connection and sizes the body in bytes', () => {
    const text = formatHttpResponse(
      200,
      { 'x-test': '1' },
      '{"a":"é"}',
    ).toString('utf8');
    expect(text.startsWith('HTTP/1.1 200 OK\r\n')).toBe(true);
    expect(text).toContain('x-test: 1\r\n');
    expect(text).toContain('connection: close\r\n');
    expect(text).toContain(
      `content-length: ${Buffer.byteLength('{"a":"é"}')}\r\n`,
    );
    expect(text.endsWith('\r\n\r\n{"a":"é"}')).toBe(true);
  });
});
