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
}

export interface DaemonHandle {
  daemon: DaemonClient;
  stop: () => Promise<void>;
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
  const token = randomBytes(32).toString('base64url');
  const port = opts.port ?? 0;
  const spawned = opts.spawner
    ? opts.spawner(token)
    : defaultSpawner(token, opts.qwenBin ?? 'qwen', port);

  const daemon = new DaemonClient({
    baseUrl: spawned.baseUrl,
    token: spawned.token,
  });

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 10000);
  // Poll health until ready or timeout.
  for (;;) {
    try {
      await daemon.health();
      break;
    } catch {
      if (Date.now() > deadline) {
        spawned.kill();
        throw new Error('Daemon did not become healthy before timeout');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return {
    daemon,
    stop: async () => {
      spawned.kill();
    },
  };
}
