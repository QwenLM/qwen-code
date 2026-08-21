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

function execA1(args: string[], retry: boolean): string {
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
      if (
        retry &&
        attempt < MAX_RETRIES &&
        TRANSIENT_RE.test(rebuilt.message)
      ) {
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

/** Run `a1` with args and return trimmed stdout. Idempotent reads ride a
 *  transient retry. */
export function a1(...args: string[]): string {
  return execA1(args, true);
}

/** Run `a1` for a WRITE — exactly once, never retried. A transient retry
 *  after the server ACCEPTED the call would duplicate the write (a
 *  double-posted comment), so a write surfaces its first error and the
 *  caller reports what already landed. */
export function a1Once(...args: string[]): string {
  return execA1(args, false);
}

/** Run `a1 … --format json` and parse the result. The long `--format` flag is
 *  the one every a1 subcommand accepts (`workitem get` has no `-f` shorthand). */
export function a1Json<T>(...args: string[]): T {
  return JSON.parse(a1(...args, '--format', 'json')) as T;
}

/** The JSON shape of `a1Once` — the WRITE that reads its result back (the
 *  created comment's id). TOLERANT on purpose, and only here: an exec
 *  failure propagates (the write genuinely failed), but once the exec
 *  SUCCEEDED the write is ACCEPTED — an answer that then fails to parse is
 *  a platform anomaly, not a failed post, and must degrade to `undefined`
 *  ("landed, result unreadable"). A throw instead would let the caller
 *  count an accepted comment as unposted and re-run it into a duplicate. */
export function a1JsonOnce<T>(...args: string[]): T | undefined {
  const raw = a1Once(...args, '--format', 'json');
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * The authenticated Aone account — the `account` field of `a1 auth whoami`.
 * cleanup's bypass audit filters the MR's comment list by it (the author
 * arm, design D8). A missing or unreadable account THROWS: matching nothing
 * would read exactly like a clean window, and a tripwire whose off state is
 * indistinguishable from its all-clear state is off.
 */
export function aoneWhoamiAccount(): string {
  let out: { account?: unknown } | null;
  try {
    out = a1Json<{ account?: unknown } | null>('auth', 'whoami');
  } catch (err) {
    // A parse failure names the command, mirroring a1CommentList — the
    // skip note must say WHAT failed; an exec failure rethrows untouched.
    if (err instanceof SyntaxError) {
      throw new Error('a1 auth whoami returned an unexpected shape');
    }
    throw err;
  }
  // A literal `null` answer PARSES, so it clears the SyntaxError arm;
  // without its own check the property access below throws an untagged
  // TypeError and the skip note names no command.
  if (
    out === null ||
    typeof out.account !== 'string' ||
    out.account.trim() === ''
  ) {
    throw new Error('a1 auth whoami returned no account');
  }
  return out.account;
}

/**
 * Fail fast with an actionable message when `a1` cannot run, and return the
 * authenticated account. Runs `a1 auth whoami --format json` ONCE — the
 * JSON spelling fully subsumes a plain auth gate, so presubmit reads its
 * self-PR comparison account off this call instead of spawning a second
 * whoami (which retried its own delays a second time under the same
 * transient outage, and could throw uncaught after the report's graceful
 * path had already been decided). A missing binary (ENOENT — the dominant
 * first-run state for this new dependency) is a different remedy than an
 * unauthenticated one. An EXEC-successful answer that does not parse or
 * names no account returns '': the exec's success already proves the auth
 * state, and an unreadable account fails presubmit's self-PR comparison
 * soft, like the GitHub path's empty login.
 */
export function ensureAoneAuthenticated(): string {
  let raw: string;
  try {
    raw = a1('auth', 'whoami', '--format', 'json');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('a1 CLI not found on PATH — install the `a1` CLI first.');
    }
    const e = err as Error & { signal?: string };
    // The 120 s deadline kills the child (signal set, usually no stderr); a
    // persistent network failure is also not an auth state. Neither is
    // remedied by `a1 auth login`.
    if (e.signal) {
      throw new Error(
        'a1 auth check timed out or was killed — check the network / a1 install.',
      );
    }
    // execFileSync failure messages BEGIN with the fixed preamble
    // "Command failed: a1 auth whoami --format json"; a1's real first stderr
    // line is the first NON-empty line after it. `.split('\n')[0]` would
    // render only the preamble and drop the cause.
    const cause =
      e.message
        .split('\n')
        .slice(1)
        .map((l) => l.trim())
        .find(Boolean) ?? '';
    // Neutral on purpose: this fall-through covers MORE than a missing login
    // — a persistent network failure whose message TRANSIENT_RE does not
    // match (ENOTFOUND, a proxy 403) lands here too, and `a1 auth login`
    // cannot fix that class. Lead with the cause, offer the login only as a
    // conditional remedy.
    throw new Error(
      `a1 auth check failed` +
        (cause ? ` — ${cause}` : '') +
        ` (if you have not logged in, run \`a1 auth login\`)`,
    );
  }
  try {
    const out = JSON.parse(raw) as { account?: unknown };
    return typeof out.account === 'string' ? out.account.trim() : '';
  } catch {
    return '';
  }
}
