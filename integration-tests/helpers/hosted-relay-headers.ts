/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ServerResponse } from 'node:http';

// The Hosted drivers' Node proxies buffer the body fetch decoded and send it
// on, so only headers that still describe that body may follow it. Hop-by-hop
// fields (RFC 9110 §7.6.1, the proxy-auth pair, and every name the upstream
// `Connection` lists) describe Spring's connection: relaying its
// `Keep-Alive: timeout=60` let the daemon's fetch pool reuse a socket the
// proxy had just closed at its own 5 s idle timeout ("other side closed").
// Framing and coding fields describe bytes the proxy no longer holds; Node
// frames the buffered body itself.
const NOT_RELAYED = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'transfer-encoding',
  'upgrade',
  'trailer',
  'content-length',
  'content-encoding',
];

export function relayedHeaders(headers: Headers): Record<string, string> {
  const dropped = new Set([
    ...NOT_RELAYED,
    ...(headers.get('connection') ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  ]);
  return Object.fromEntries(
    [...headers].filter(([name]) => !dropped.has(name)),
  );
}

// The five wholesale upstream relays — hosted-{latency,process-crash,
// shell-output,store-failure,workspace-tool-turn}-driver.ts — pass through
// this one site, pinned by the caller list in hosted-relay-headers.test.ts.
// The drivers' other upstream replies write fixed header literals and must
// stay that way: a driver-local copy of the upstream header set would leak
// hop-by-hop spellings again, and nothing enforces it.
export function relayUpstream(
  res: ServerResponse,
  upstream: Response,
  body: Buffer,
): void {
  res.writeHead(upstream.status, relayedHeaders(upstream.headers));
  res.end(body);
}
