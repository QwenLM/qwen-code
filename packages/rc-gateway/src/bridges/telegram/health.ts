/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Telegram bridge healthz endpoint. The bridge exposes `GET /healthz` on a
 * small loopback HTTP server returning `{ ok, daemonReachable,
 * telegramReachable, uptimeSec }` — a liveness/observability probe suitable for
 * a Docker `HEALTHCHECK` or k8s liveness probe.
 *
 * `ok` is the conjunction of `daemonReachable AND telegramReachable`.
 *
 * Bound to 127.0.0.1 (not 0.0.0.0): the report is unauthenticated and
 * loopback matches the sidecar posture and is enough for an in-container probe.
 * Bind failure NEVER crashes the bridge — it logs and continues.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TelegramHealthState } from './runner.js';

/** The `GET /healthz` response body. */
export interface TelegramHealthReport {
  /** `true` iff BOTH daemonReachable AND telegramReachable. */
  ok: boolean;
  daemonReachable: boolean;
  telegramReachable: boolean;
  uptimeSec: number;
}

/**
 * Resolve the healthz port from an env string. `fallback` is the default when
 * the var is unset. `off`/`none`/`0` (or empty) explicitly disables; a valid
 * 1–65535 wins; anything else → fallback.
 */
export function parseTelegramHealthzPort(
  value: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === '' || v === 'off' || v === 'none' || v === '0') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return fallback;
  return n;
}

/**
 * Build the health report from the live state.
 * `ok = daemonReachable && telegramReachable`.
 */
export function buildTelegramHealthReport(
  state: TelegramHealthState,
  ctx: { startedAtMs: number; nowMs: number },
): TelegramHealthReport {
  return {
    ok: state.daemonReachable && state.telegramReachable,
    daemonReachable: state.daemonReachable,
    telegramReachable: state.telegramReachable,
    uptimeSec: Math.max(0, Math.floor((ctx.nowMs - ctx.startedAtMs) / 1000)),
  };
}

/** A running healthz server; `close()` stops it (idempotent). */
export interface TelegramHealthServer {
  close(): Promise<void>;
  /** The actually-bound port; 0 if bind failed. */
  port: number;
}

/**
 * Start the loopback `GET /healthz` server on `port`. `report()` is invoked
 * per request. Resolves once listening, or — on bind error — logs and resolves
 * with a no-op handle (NEVER rejects).
 */
export function startTelegramHealthServer(
  port: number,
  report: () => TelegramHealthReport,
  opts: { log?: (m: string) => void } = {},
): Promise<TelegramHealthServer> {
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
        `telegram healthz: could not bind port ${port} (${
          (err as Error).message ?? err
        }) — healthz disabled`,
      );
      resolve({ close: async () => {}, port: 0 });
    });

    server.listen(port, '127.0.0.1', () => {
      const bound = (server.address() as AddressInfo).port;
      log(`telegram healthz: listening on http://127.0.0.1:${bound}/healthz`);
      resolve({ close, port: bound });
    });
  });
}
