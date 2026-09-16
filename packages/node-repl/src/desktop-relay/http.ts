/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Just enough HTTP/1.1 for one request per connection. Under launchd's inetd
 * mode every accepted connection is a fresh process whose stdin and stdout are
 * the socket, so there is no server object to hand requests to; the agent reads
 * one request, writes one response with `Connection: close`, and moves on.
 */

export interface HttpRequest {
  method: string;
  path: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
}

export type ParseResult =
  | { kind: 'incomplete' }
  | { kind: 'complete'; request: HttpRequest }
  | { kind: 'invalid'; reason: string };

const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_LINE = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/;

/** Tells an HTTP request line from a raw JSON-RPC stream by its first bytes. */
export function looksLikeHttp(prefix: Buffer): boolean {
  return /^[A-Z]{3,7} /.test(prefix.subarray(0, 8).toString('latin1'));
}

export function parseHttpRequest(buffer: Buffer): ParseResult {
  if (buffer.length > MAX_REQUEST_BYTES) {
    return { kind: 'invalid', reason: 'request too large' };
  }
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0) return { kind: 'incomplete' };
  const lines = buffer.subarray(0, headerEnd).toString('latin1').split('\r\n');
  const match = REQUEST_LINE.exec(lines[0] ?? '');
  if (!match) return { kind: 'invalid', reason: 'malformed request line' };
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) return { kind: 'invalid', reason: 'malformed header' };
    headers[line.slice(0, colon).trim().toLowerCase()] = line
      .slice(colon + 1)
      .trim();
  }
  if (headers['transfer-encoding'] !== undefined) {
    return { kind: 'invalid', reason: 'chunked bodies are not supported' };
  }
  const declared = headers['content-length'];
  const length = declared === undefined ? 0 : Number(declared);
  if (!Number.isInteger(length) || length < 0) {
    return { kind: 'invalid', reason: 'bad content-length' };
  }
  const bodyStart = headerEnd + 4;
  if (buffer.length < bodyStart + length) return { kind: 'incomplete' };
  return {
    kind: 'complete',
    request: {
      method: match[1] ?? '',
      path: match[2] ?? '',
      headers,
      body: buffer.subarray(bodyStart, bodyStart + length).toString('utf8'),
    },
  };
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  421: 'Misdirected Request',
  500: 'Internal Server Error',
};

export function formatHttpResponse(
  status: number,
  headers: Record<string, string>,
  body = '',
): Buffer {
  const payload = Buffer.from(body, 'utf8');
  const all: Record<string, string> = {
    ...headers,
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    connection: 'close',
  };
  const lines = [`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Status'}`];
  for (const [name, value] of Object.entries(all)) {
    lines.push(`${name}: ${value}`);
  }
  return Buffer.concat([
    Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'),
    payload,
  ]);
}
