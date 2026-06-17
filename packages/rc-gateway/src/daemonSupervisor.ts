/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DaemonClient } from '@qwen-code/sdk';

export interface SpawnedDaemon {
  baseUrl: string;
  token: string | undefined;
  kill: () => void;
}

export interface StartDaemonOptions {
  /** qwen binary to launch; defaults to "qwen" on PATH. */
  qwenBin?: string;
  /** Loopback port for the daemon; 0 = ephemeral (default). */
  port?: number;
  /** Override how the daemon process is launched (tests inject a stub). */
  spawner?: (token: string) => SpawnedDaemon;
  /** Health-poll budget in ms (default 10000). */
  readyTimeoutMs?: number;
  /**
   * Attach to an ALREADY-RUNNING daemon instead of spawning one (the handoff
   * Phase-1 path: a terminal session's `qwen serve` that the gateway shares, so
   * mobile clients see the SAME sessions). When set, no process is spawned and
   * `stop()` is a NO-OP — the gateway never kills a daemon it did not start.
   * `url` is the daemon's base URL; `token` its `QWEN_SERVER_TOKEN`.
   */
  attach?: { url: string; token: string };
}

export interface DaemonHandle {
  daemon: DaemonClient;
  stop: () => Promise<void>;
  /** True when attached to an externally-managed daemon (`stop()` is a no-op). */
  attached: boolean;
}

/**
 * Build the argv for `qwen serve`. Extracted as a pure function so the exact
 * flag names (which `qwen serve` validates with yargs `.strict()`) are unit
 * tested — a wrong flag would otherwise only fail at real-process spawn time,
 * which no hermetic test exercises.
 */
export function buildServeArgs(port: number): string[] {
  // The daemon defines `--hostname` (NOT `--host`) and `--port`; under
  // `.strict()` an unknown flag aborts startup. See packages/cli/src/commands/serve.ts.
  return [
    'serve',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
    '--require-auth',
  ];
}

/** Default spawner: launch `qwen serve` on loopback with QWEN_SERVER_TOKEN. */
function defaultSpawner(
  token: string,
  qwenBin: string,
  port: number,
): SpawnedDaemon {
  const child = spawn(qwenBin, buildServeArgs(port), {
    env: { ...process.env, QWEN_SERVER_TOKEN: token },
    stdio: 'inherit',
  });
  // NOTE: with ephemeral port 0 the real daemon prints its chosen port;
  // wiring that read-back is a follow-on. For now require an explicit
  // non-zero port in production launches.
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    kill: () => child.kill('SIGTERM'),
  };
}

export async function startDaemon(
  opts: StartDaemonOptions = {},
): Promise<DaemonHandle> {
  const attached = opts.attach !== undefined;
  // Attach: point at an existing daemon, never spawn, never kill. Spawn: launch
  // `qwen serve` with a fresh token and own its lifecycle. Both then share the
  // SAME health-poll + DaemonClient handle below.
  let daemon: DaemonClient;
  let kill: () => void;
  if (opts.attach) {
    daemon = new DaemonClient({
      baseUrl: opts.attach.url,
      token: opts.attach.token,
    });
    kill = () => {}; // never kill a daemon we did not start
  } else {
    const token = randomBytes(32).toString('base64url');
    const port = opts.port ?? 0;
    const spawned = opts.spawner
      ? opts.spawner(token)
      : defaultSpawner(token, opts.qwenBin ?? 'qwen', port);
    daemon = new DaemonClient({
      baseUrl: spawned.baseUrl,
      token: spawned.token,
    });
    kill = spawned.kill;
  }

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 10000);
  // Poll health until ready or timeout.
  for (;;) {
    try {
      await daemon.health();
      break;
    } catch {
      if (Date.now() > deadline) {
        kill(); // no-op in attach mode
        throw new Error(
          attached
            ? `Could not reach the daemon at ${opts.attach!.url} before timeout (URL/token/--require-auth?)`
            : 'Daemon did not become healthy before timeout',
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return {
    daemon,
    stop: async () => {
      kill();
    },
    attached,
  };
}
