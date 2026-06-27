/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonTransport } from './DaemonTransport.js';

// ---------------------------------------------------------------------------
// Transport negotiation
// ---------------------------------------------------------------------------

/** Options for {@link negotiateTransport}. */
export interface NegotiateTransportOptions {
  /** Timeout for the capabilities probe and WS handshake. Default 5000ms. */
  probeTimeoutMs?: number;
}

/**
 * Auto-detect the best available transport by probing the daemon's
 * `GET /capabilities` endpoint and inspecting the `transports` array.
 *
 * Preference order: `acp-ws` > `acp-http` > `rest`.
 *
 * For `acp-ws`, a WebSocket probe with timeout is performed. If the
 * probe fails (timeout, connection refused, etc.), the next-best
 * transport is tried.
 *
 * When the daemon's `/capabilities` response does not include a
 * `transports` field, the factory falls back to REST (the universal
 * baseline).
 *
 * Usage:
 * ```ts
 * const transport = await negotiateTransport(baseUrl, token);
 * const client = new DaemonClient({ baseUrl, token, transport });
 * ```
 */
export async function negotiateTransport(
  baseUrl: string,
  token?: string,
  opts?: NegotiateTransportOptions,
): Promise<DaemonTransport> {
  const fetchFn = globalThis.fetch.bind(globalThis);
  const probeTimeoutMs = opts?.probeTimeoutMs ?? 5_000;

  // Lazy imports to avoid circular module initialization. These
  // modules are always available at runtime (same package), but we
  // don't want to eagerly load ACP transports when the caller never
  // negotiates.
  const { RestSseTransport } = await import('./RestSseTransport.js');

  // Probe capabilities.
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let transports: string[] = [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), probeTimeoutMs);
    try {
      const res = await fetchFn(`${baseUrl}/capabilities`, {
        headers,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const caps = (await res.json()) as {
          transports?: string[];
          [key: string]: unknown;
        };
        transports = Array.isArray(caps.transports) ? caps.transports : [];
      }
    } catch {
      clearTimeout(timer);
      // Probe failed — fall through to REST.
    }
  } catch {
    // Outer catch for timer setup errors (unlikely).
  }

  // Try best available in preference order.
  if (transports.includes('acp-ws')) {
    try {
      const { AcpWsTransport } = await import('./AcpWsTransport.js');
      // Convert http(s) → ws(s) for the WS URL.
      const wsUrl = baseUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
      const transport = new AcpWsTransport(wsUrl + '/acp', token);
      // Probe: try to connect with a timeout.
      const probeTimer = setTimeout(() => {
        /* timeout — handled by race */
      }, probeTimeoutMs);
      try {
        const probeRes = await Promise.race([
          transport.fetch(`${baseUrl}/capabilities`, { method: 'GET' }),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), probeTimeoutMs),
          ),
        ]);
        clearTimeout(probeTimer);
        if (probeRes) {
          return transport;
        }
        // Probe timed out — dispose and try next.
        try {
          transport.dispose();
        } catch {
          /* ignore dispose errors */
        }
      } catch {
        clearTimeout(probeTimer);
        // WS probe failed — dispose and try next.
        try {
          transport.dispose();
        } catch {
          /* ignore dispose errors */
        }
      }
    } catch {
      // WS import/creation failed — try next.
    }
  }

  if (transports.includes('acp-http')) {
    try {
      const { AcpHttpTransport } = await import('./AcpHttpTransport.js');
      return new AcpHttpTransport(baseUrl, token, fetchFn);
    } catch {
      // ACP-HTTP creation failed — fall back to REST.
    }
  }

  // Universal fallback.
  return new RestSseTransport(baseUrl, token, fetchFn);
}
