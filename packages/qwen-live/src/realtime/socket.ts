/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal socket abstraction shared by the realtime client and its tests.
 *
 * Ported verbatim from packages/cli/src/ui/voice/voice-stream-session.ts so
 * the ported realtime client (and its FakeSocket-based tests) keep the exact
 * injection seam they were written against.
 */
export interface SocketLike {
  readyState: number;
  OPEN: number;
  bufferedAmount?: number;
  send: (data: string | Uint8Array) => void;
  close: () => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
}

/**
 * Derive the WebSocket origin for a DashScope-style HTTP base URL: swap the
 * scheme and strip a trailing `/compatible-mode/v1` or `/v1` path prefix.
 */
export function deriveWebSocketBase(baseUrl: string): string {
  const url = new URL(baseUrl);
  const wsScheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let prefix = url.pathname.replace(/\/+$/, '');
  if (prefix.endsWith('/compatible-mode/v1')) {
    prefix = prefix.slice(0, -'/compatible-mode/v1'.length);
  } else if (prefix.endsWith('/v1')) {
    prefix = prefix.slice(0, -'/v1'.length);
  }
  return `${wsScheme}//${url.host}${prefix}`;
}
