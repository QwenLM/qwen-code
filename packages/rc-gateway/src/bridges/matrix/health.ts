/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Matrix bridge healthz endpoint (`add-matrix-bridge`: "Healthz endpoint"). The
 * bridge exposes `GET /healthz` on a small LOOPBACK HTTP server returning
 * `{ ok, daemonReachable, homeserverReachable, olmStorePresent, registeredId,
 * uptimeSec }` — a liveness/observability probe (e.g. a Docker `HEALTHCHECK` for
 * the sidecar). It is the surface that reflects the olm-store status.
 *
 * Bound to 127.0.0.1 (not 0.0.0.0): the report is unauthenticated and leaks
 * internal reachability + the registered id, so loopback matches the fork's
 * posture and is enough for an in-container probe. Bind failure (e.g. the port is
 * taken) NEVER crashes the bridge — it logs and continues (the same never-kill
 * invariant as the rest of the bridge boot).
 *
 * The dynamic fields are right-sized to the spec, which tests only
 * `olmStorePresent`: `registeredId`/`daemonReachable` come from one post-register
 * hook and `homeserverReachable` from the sync-success / adapter-start signal —
 * no heartbeat-failure tracking and no periodic probes. NOTE the asymmetry: on the
 * fetch path `homeserverReachable` flips false on a sync error, but on the E2EE
 * adapter path the SDK owns `/sync` and hides later reconnects from the runner, so
 * there it means "reachable at start", not a live signal.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { olmStorePresent } from './cryptoAdapter.js';

/** Mutable liveness flags the runner updates; read into each health report. */
export interface MatrixHealthState {
  /** The bridge id once the gateway accepted registration, else null. */
  registeredId: string | null;
  /** Last gateway register/heartbeat succeeded. */
  daemonReachable: boolean;
  /** Last homeserver sync (or adapter start) succeeded. */
  homeserverReachable: boolean;
}

/** The `GET /healthz` response body (spec shape). */
export interface MatrixHealthReport {
  /** `true` iff BOTH daemonReachable AND homeserverReachable. */
  ok: boolean;
  daemonReachable: boolean;
  homeserverReachable: boolean;
  olmStorePresent: boolean;
  registeredId: string | null;
  uptimeSec: number;
}

/**
 * Resolve the healthz port from `QWEN_BRIDGE_HEALTHZ_PORT`. `fallback` is the
 * default when the var is unset (9100 for the sidecar per spec; `undefined`
 * in-process so the gateway process never binds a surprise port). `off`/`none`/`0`
 * (or empty) explicitly disables; a valid 1–65535 wins; anything else → fallback.
 */
export function parseHealthzPort(
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

/** A fresh health state (nothing reachable until the runner reports success). */
export function initialMatrixHealthState(): MatrixHealthState {
  return {
    registeredId: null,
    daemonReachable: false,
    homeserverReachable: false,
  };
}

/**
 * Build the health report from the live state plus the olm-store fs check.
 * `ok` is the conjunction of `daemonReachable` AND `homeserverReachable` —
 * both must be true for the bridge to be fully operational. Pure (aside from
 * the fs read olmStorePresent does) — `nowMs`/`startedAtMs` are injected so
 * uptime is testable.
 */
export function buildMatrixHealthReport(
  state: MatrixHealthState,
  ctx: { stateDir: string; startedAtMs: number; nowMs: number },
): MatrixHealthReport {
  return {
    ok: state.daemonReachable && state.homeserverReachable,
    daemonReachable: state.daemonReachable,
    homeserverReachable: state.homeserverReachable,
    olmStorePresent: olmStorePresent(ctx.stateDir),
    registeredId: state.registeredId,
    uptimeSec: Math.max(0, Math.floor((ctx.nowMs - ctx.startedAtMs) / 1000)),
  };
}

/** A running healthz server; `close()` stops it (idempotent). */
export interface MatrixHealthServer {
  close(): Promise<void>;
  /** The actually-bound port (resolves `port: 0` to the OS-assigned one); 0 if bind failed. */
  port: number;
}

/**
 * Start the loopback `GET /healthz` server on `port`. `report()` is invoked per
 * request (so each response reflects current state + a fresh olm-store check).
 * Resolves once listening, or — on a bind error — logs and resolves with a no-op
 * handle (NEVER rejects: a healthz port conflict must not take down the bridge).
 */
export function startMatrixHealthServer(
  port: number,
  report: () => MatrixHealthReport,
  opts: { log?: (m: string) => void } = {},
): Promise<MatrixHealthServer> {
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
      // Bind failure (EADDRINUSE, EACCES, …) is non-fatal: the bridge keeps
      // running without healthz rather than crashing the process.
      log(
        `matrix healthz: could not bind port ${port} (${
          (err as Error).message ?? err
        }) — healthz disabled`,
      );
      resolve({ close: async () => {}, port: 0 });
    });

    server.listen(port, '127.0.0.1', () => {
      const bound = (server.address() as AddressInfo).port;
      log(`matrix healthz: listening on http://127.0.0.1:${bound}/healthz`);
      resolve({ close, port: bound });
    });
  });
}
