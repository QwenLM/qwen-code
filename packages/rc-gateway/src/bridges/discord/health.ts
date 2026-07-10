/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Discord bridge healthz endpoint (`add-discord-bridge`). The bridge exposes
 * `GET /healthz` on a small LOOPBACK HTTP server returning
 * `{ ok, daemonReachable, gatewayConnected, registeredId, uptimeSec }`.
 *
 * `ok` is `daemonReachable AND gatewayConnected` — both must be true for the
 * bridge to serve traffic (the daemon must accept registrations AND the Discord
 * gateway WebSocket must be up).
 *
 * Bound to 127.0.0.1 (not 0.0.0.0): the report is unauthenticated and leaks
 * internal reachability, so loopback is enough for an in-container probe.
 * Bind failure NEVER crashes the bridge — it logs and continues.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Mutable liveness flags the runner updates; read into each health report. */
export interface DiscordHealthState {
  /** The bridge id once the gateway accepted registration, else null. */
  registeredId: string | null;
  /** Last gateway register/heartbeat succeeded. */
  daemonReachable: boolean;
  /** The Discord gateway WebSocket is connected and ready. */
  gatewayConnected: boolean;
}

/** The `GET /healthz` response body. */
export interface DiscordHealthReport {
  /** `true` iff BOTH daemonReachable AND gatewayConnected. */
  ok: boolean;
  daemonReachable: boolean;
  gatewayConnected: boolean;
  registeredId: string | null;
  uptimeSec: number;
}

/** A fresh health state (nothing reachable until the runner reports success). */
export function initialDiscordHealthState(): DiscordHealthState {
  return {
    registeredId: null,
    daemonReachable: false,
    gatewayConnected: false,
  };
}

/**
 * Build the health report from live state. `ok` is the conjunction of
 * `daemonReachable` AND `gatewayConnected` — a probe failure on either means
 * the bridge is not fully operational.
 */
export function buildDiscordHealthReport(
  state: DiscordHealthState,
  ctx: { startedAtMs: number; nowMs: number },
): DiscordHealthReport {
  return {
    ok: state.daemonReachable && state.gatewayConnected,
    daemonReachable: state.daemonReachable,
    gatewayConnected: state.gatewayConnected,
    registeredId: state.registeredId,
    uptimeSec: Math.max(0, Math.floor((ctx.nowMs - ctx.startedAtMs) / 1000)),
  };
}

/** A running healthz server; `close()` stops it (idempotent). */
export interface DiscordHealthServer {
  close(): Promise<void>;
  /** The actually-bound port (resolves `port: 0` to the OS-assigned one); 0 if bind failed. */
  port: number;
}

/**
 * Start the loopback `GET /healthz` server on `port`. `report()` is invoked
 * per request so each response reflects current state. Resolves once listening,
 * or — on a bind error — logs and resolves with a no-op handle (NEVER rejects).
 */
export function startDiscordHealthServer(
  port: number,
  report: () => DiscordHealthReport,
  opts: { log?: (m: string) => void } = {},
): Promise<DiscordHealthServer> {
  const log = opts.log ?? (() => {});
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/healthz') {
        const body = JSON.stringify(report());
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const close = (): Promise<void> =>
      new Promise((r) => server.close(() => r()));

    server.once('error', (err) => {
      log(
        `discord healthz: could not bind port ${port} (${
          (err as Error).message ?? err
        }) — healthz disabled`,
      );
      resolve({ close: async () => {}, port: 0 });
    });

    server.listen(port, '127.0.0.1', () => {
      const bound = (server.address() as AddressInfo).port;
      log(`discord healthz: listening on http://127.0.0.1:${bound}/healthz`);
      resolve({ close, port: bound });
    });
  });
}
