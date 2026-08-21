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
 * The oldest `a1` this provider runs against. The provider's platform facts
 * — the `mr comment create --file/--line/--message` flags, the native
 * `mr approve`, and stable `--format json` output across every subcommand
 * it calls — were probed against a1 0.1.90 (the facts table in
 * docs/design/2026-08-13-review-platform-provider-abstraction.md; open
 * question Q1 resolved to the probed version, since nothing older was
 * verified). An older install is missing flags the provider passes and
 * fails obscurely deep in a review; the floor turns that into a
 * first-run error whose message names the remedy.
 */
export const A1_MIN_VERSION = '0.1.90';

/** The `major.minor.patch` triple of an `a1 --version` line such as
 *  `a1 version 0.2.51 (2026-08-20)`. Anchored at the `version` token
 *  first — a banner that prints a dotted build date BEFORE the version
 *  must not supply the triple the floor compares; the bare-triple parse
 *  is the fallback for a variant that dropped the token. */
export function parseA1Version(
  out: string,
): [number, number, number] | undefined {
  const m =
    /version[^\d]*(\d+)\.(\d+)\.(\d+)/i.exec(out) ??
    /(\d+)\.(\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Numeric component-wise compare — a lexicographic one reads 0.10.0 < 0.9.0. */
export function a1VersionAtLeast(
  version: [number, number, number],
  floor: [number, number, number],
): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== floor[i]) return version[i] > floor[i];
  }
  return true;
}

/**
 * Fail fast with an actionable message when `a1` cannot run. Three distinct
 * states, three distinct remedies: a missing binary (ENOENT — the dominant
 * first-run state for this dependency) → install; a version below
 * A1_MIN_VERSION → upgrade; an unauthenticated login → `a1 auth login`.
 * The checks run in that order — presence, then version, then auth — so a
 * stale install is named BEFORE a login that upgrading would invalidate
 * anyway.
 */
export function ensureAoneAuthenticated(): void {
  // `a1 --version` is a local op — no auth, no network — so it can precede
  // the login check.
  let versionOut: string | undefined;
  try {
    versionOut = a1('--version');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('a1 CLI not found on PATH — install the `a1` CLI first.');
    }
    // The binary runs but the version probe failed — no floor ruling is
    // possible. Absent evidence, not evidence of absence: fall through to
    // the auth check rather than refusing an a1 whose `--version` this
    // check merely cannot read — disclosed, like the unparseable-output
    // arm below. The cause extraction mirrors the whoami catch's: an
    // execFileSync failure message BEGINS with the fixed preamble
    // "Command failed: a1 --version", so line zero is the preamble, not
    // the cause — segfault, unsupported flag and permission failure must
    // stay distinguishable in the one place fail-open promises disclosure.
    const lines = (err instanceof Error ? err.message : String(err)).split(
      '\n',
    );
    const why =
      lines
        .slice(1)
        .map((l) => l.trim())
        .find(Boolean) ?? lines[0];
    process.stderr.write(
      `WARNING: the a1 version probe failed ` +
        `(${JSON.stringify(why.slice(0, 80))}) — the review ` +
        `provider requires a1 >= ${A1_MIN_VERSION}; continuing without a ` +
        `floor ruling.\n`,
    );
  }
  if (versionOut !== undefined) {
    // The constant parses — the `!` is a compile-time formality.
    const floor = parseA1Version(A1_MIN_VERSION)!;
    const version = parseA1Version(versionOut);
    if (version === undefined) {
      // Disclosed fail-open: an unreadable version gets the benefit of the
      // doubt (a variant output format is not a stale install), and a
      // genuine staleness still fails later on its missing flags — but at
      // least this run was warned what the provider expects.
      process.stderr.write(
        `WARNING: could not read the a1 version from ` +
          `${JSON.stringify(versionOut.slice(0, 80))} — the review ` +
          `provider requires a1 >= ${A1_MIN_VERSION}; continuing.\n`,
      );
    } else if (!a1VersionAtLeast(version, floor)) {
      throw new Error(
        `a1 ${version.join('.')} is older than the ${A1_MIN_VERSION} this ` +
          `review provider requires — it depends on the comment-create ` +
          `flags and stable \`--format json\` output introduced there. ` +
          `Upgrade the a1 CLI (https://code.alibaba-inc.com/aone/a1) ` +
          `and retry.`,
      );
    }
  }
  try {
    a1('auth', 'whoami');
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
    // "Command failed: a1 auth whoami"; a1's real first stderr line is the
    // first NON-empty line after it. `.split('\n')[0]` would render only the
    // preamble and drop the cause.
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
}
