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

// Conservative: retry only on what reads as a transient server/network
// fault. Auth and 4xx are deterministic and must surface immediately.
const TRANSIENT_RE =
  /(HTTP\s?5\d\d|502|503|504|temporarily unavailable|connection (reset|timed? ?out)|ECONNRESET|ETIMEDOUT|network is unreachable)/i;

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
        sleepSync(BASE_DELAY_MS * (attempt + 1));
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
 * Fail fast with an actionable message when `a1` has no auth. `a1 auth
 * whoami` exits non-zero when unauthenticated.
 */
export function ensureAoneAuthenticated(): void {
  try {
    a1('auth', 'whoami');
  } catch (err) {
    throw new Error(
      `a1 CLI is not authenticated — run \`a1 auth login\` first. ` +
        `(${(err as Error).message.split('\n')[0]})`,
    );
  }
}
