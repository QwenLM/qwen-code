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
  /**
   * Optional: settles (resolves — never rejects, to avoid stray unhandled
   * rejections) when the child terminates, carrying a human-readable reason.
   * `startDaemon` races this against the health poll so a daemon that crashes
   * at startup fails fast with the REAL cause (`spawn ENOENT`, `exited code 1:
   * <stderr>`) instead of a generic "did not become healthy" timeout — the gap
   * that made a supervisor crash look like a "WSL timeout".
   */
  whenExited?: Promise<DaemonExit>;
}

export interface DaemonExit {
  /** Human-readable reason the daemon process ended (for diagnostics). */
  reason: string;
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
  // Ephemeral-port (0) read-back from the daemon's stdout is not implemented;
  // polling http://127.0.0.1:0 would never connect. Fail loudly instead of
  // silently hanging until the health timeout.
  if (port === 0) {
    throw new Error(
      'startDaemon: a non-zero port is required when spawning the daemon ' +
        '(ephemeral-port read-back is not implemented). Pass { port } or { spawner }.',
    );
  }
  // Pipe (not inherit) stdout/stderr so we can BOTH preserve the daemon's
  // console output AND capture a stderr tail to explain a startup crash. With
  // `inherit` the child's failure reason is printed but unreachable in-process,
  // so a crash is indistinguishable from a hang.
  const child = spawn(qwenBin, buildServeArgs(port), {
    env: { ...process.env, QWEN_SERVER_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const TAIL_MAX = 4000;
  let stderrTail = '';
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    stderrTail = (stderrTail + chunk.toString()).slice(-TAIL_MAX);
  });

  let settled = false;
  const whenExited = new Promise<DaemonExit>((resolve) => {
    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      // e.g. ENOENT when `qwen` is not on PATH.
      resolve({ reason: `failed to spawn "${qwenBin}": ${err.message}` });
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      const how = signal ? `signal ${signal}` : `code ${code}`;
      const tail = stderrTail.trim();
      resolve({
        reason:
          `"${qwenBin} serve" exited with ${how}` +
          (tail ? `: ${tail.slice(-500)}` : ''),
      });
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    kill: () => child.kill('SIGTERM'),
    whenExited,
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
  // Set once the spawned daemon process terminates before we deem it healthy;
  // `exitSignal` resolves to 'exited' so we can RACE it against a (possibly
  // slow) health attempt rather than wait for health to return first.
  let exitReason: string | undefined;
  let exitSignal: Promise<'exited'> | undefined;
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
    // `whenExited` resolves (never rejects), so this can't leak an unhandled
    // rejection even when the daemon exits long after startup.
    exitSignal = spawned.whenExited?.then((e) => {
      exitReason = e.reason;
      return 'exited' as const;
    });
  }

  const failExited = () => {
    kill();
    return new Error(
      `Daemon process ended before becoming healthy: ${exitReason}`,
    );
  };

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 10000);
  // Poll health until ready, the child dies, or the budget is exhausted.
  for (;;) {
    // `.then(ok, fail)` makes the health attempt never reject, so a dangling
    // attempt (when the exit signal wins the race) can't leak a rejection.
    const healthAttempt = daemon.health().then(
      () => 'healthy' as const,
      () => 'unhealthy' as const,
    );
    const outcome = exitSignal
      ? await Promise.race([healthAttempt, exitSignal])
      : await healthAttempt;

    if (outcome === 'healthy') break;
    if (outcome === 'exited' || exitReason !== undefined) throw failExited();
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

  return {
    daemon,
    stop: async () => {
      kill();
    },
    attached,
  };
}
