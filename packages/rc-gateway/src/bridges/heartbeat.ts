/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The shared bridge heartbeat loop (`add-bridge-protocol`: "Bridge heartbeat and
 * auto-deregister"). A registered bridge must periodically POST
 * `/rc/bridges/:id/heartbeat` or the gateway's reaper drops it after ~3 missed
 * beats. Every bridge runner runs this loop so a live bridge stays listed.
 *
 * On a `404` the gateway no longer knows this bridge — it was reaped (a transient
 * stall) OR the gateway restarted and lost its in-memory registry. Either way the
 * loop calls `reRegister` (re-registration needs no re-pairing, per spec), which
 * also recovers the post-gateway-restart case the one-shot start() register
 * wouldn't. All calls are best-effort: a failed beat just waits for the next one.
 */
export interface HeartbeatLoopOptions {
  /** POST the heartbeat; resolves the HTTP status (404 → re-register). */
  heartbeat: (bridgeId: string) => Promise<{ ok: boolean; status: number }>;
  /** Re-register this bridge (called on a 404). Best-effort. */
  reRegister: () => Promise<unknown>;
  bridgeId: string;
  intervalMs: number;
  signal: AbortSignal;
  /** Injectable abort-aware sleep (tests). Defaults to a real timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (msg: string) => void;
}

export async function runHeartbeatLoop(
  opts: HeartbeatLoopOptions,
): Promise<void> {
  const sleep = opts.sleep ?? defaultSleep;
  const log = opts.log ?? (() => {});
  while (!opts.signal.aborted) {
    await sleep(opts.intervalMs, opts.signal);
    if (opts.signal.aborted) break;
    let res: { ok: boolean; status: number };
    try {
      res = await opts.heartbeat(opts.bridgeId);
    } catch {
      continue; // network error → just try again next interval
    }
    if (res.status === 404) {
      log('bridge heartbeat: gateway lost registration, re-registering');
      try {
        await opts.reRegister();
      } catch {
        // best-effort; the next heartbeat will 404 again and retry
      }
    }
  }
}

/** Default heartbeat cadence (ms) if the register response omits one. */
const DEFAULT_HEARTBEAT_MS = 60_000;

/**
 * The heartbeat cadence (ms) a bridge should use, read from its register
 * response body's `heartbeatIntervalSec` (contract-driven — the gateway dictates
 * the cadence). Falls back to 60 s for a missing/invalid value.
 */
export function heartbeatIntervalMsOf(body: unknown): number {
  const sec = (body as { heartbeatIntervalSec?: unknown })
    ?.heartbeatIntervalSec;
  return typeof sec === 'number' && Number.isFinite(sec) && sec > 0
    ? sec * 1000
    : DEFAULT_HEARTBEAT_MS;
}

/** Sleep `ms`, resolving early if `signal` aborts (so shutdown is prompt). */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
