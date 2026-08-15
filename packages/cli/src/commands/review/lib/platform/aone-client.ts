/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Aone Code transport — the sibling of lib/gh.ts. It wraps the `a1` CLI the
// same way gh.ts wraps `gh`: no shell, transient retry on idempotent reads,
// an actionable auth check. Where gh.ts routes a global host (GH_HOST), Aone
// passes the repository coordinate per call (`--repo <group>/<project>`), so
// there is no host-routing state here. See
// docs/design/2026-08-15-review-aone-provider.md.

import { execFileSync } from 'node:child_process';

const A1_BINARY = 'a1';
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 3000;
const A1_TIMEOUT_MS = 120_000;

// Anchor to `HTTP 5\d\d` (not bare `502|503|504`): Node embeds the full
// command line in the error, so a deterministic `a1 repo mr view 1503 …`
// would match a bare "503" and pay two pointless retries. ETIMEDOUT is
// deliberately absent — with the deadline below, a stall must surface once,
// not three times.
const TRANSIENT_RE =
  /(HTTP\s?5\d\d|temporarily unavailable|connection (reset|timed? ?out)|ECONNRESET|network is unreachable)/i;

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function execA1WithRetry(args: string[]): string {
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync(A1_BINARY, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
        timeout: A1_TIMEOUT_MS,
      })
        .toString()
        .replace(/\r\n/g, '\n')
        .trim();
    } catch (err) {
      const e = err as {
        message?: string;
        stdout?: Buffer | string;
        stderr?: Buffer | string;
      };
      const rebuilt = new Error(
        [
          e.message ?? '',
          e.stdout?.toString() ?? '',
          e.stderr?.toString() ?? '',
        ].join('\n'),
      );
      if (attempt < MAX_RETRIES && TRANSIENT_RE.test(rebuilt.message)) {
        const delay = BASE_DELAY_MS * (attempt + 1);
        // The sibling gh.ts prints one trace line per retry; a silent 3–9 s
        // blocking sleep reads as a hang in CI logs.
        process.stderr.write(
          `a1 transient error (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms…\n`,
        );
        sleepSync(delay);
        continue;
      }
      throw err;
    }
  }
}

/** Run `a1` with args and return trimmed stdout. */
export function a1(...args: string[]): string {
  return execA1WithRetry(args);
}

/** Run `a1 … --format json` and parse the result. The long `--format` flag is
 *  the one every a1 subcommand accepts (`workitem get` has no `-f` shorthand). */
export function a1Json<T>(...args: string[]): T {
  return JSON.parse(a1(...args, '--format', 'json')) as T;
}

/**
 * Fail fast with an actionable message when `a1` cannot run. A missing
 * binary (ENOENT — the dominant first-run state for this new dependency) is
 * a different remedy than an unauthenticated one.
 */
export function ensureAoneAuthenticated(): void {
  try {
    a1('auth', 'whoami');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('a1 CLI not found on PATH — install the `a1` CLI first.');
    }
    throw new Error(
      `a1 CLI is not authenticated — run \`a1 auth login\` first. ` +
        `(${(err as Error).message.split('\n')[0]})`,
    );
  }
}
