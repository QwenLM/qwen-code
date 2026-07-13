/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Thin wrapper around the GitHub CLI (`gh`) for the `qwen review`
// subcommands. All callers go through `execFileSync` (no shell) so quoting
// and escaping is consistent across macOS, Linux, and Windows.

import { execFileSync } from 'node:child_process';

let ghHost: string | undefined;

const HOSTNAME_RE = /^[A-Za-z0-9.-]+(?::\d+)?$/;

/**
 * Route every subsequent `gh` invocation in this process at a GitHub host
 * other than github.com (GitHub Enterprise). The subcommands thread their
 * `--host` option here before making any call, so host targeting is code,
 * not a prose instruction the orchestrating model must remember per call —
 * a dropped host silently reads from and posts to github.com's same-named
 * `owner/repo`.
 *
 * `undefined` (or `''`) restores the default: the child then inherits the
 * parent env untouched, so an operator-exported GH_HOST stays in effect.
 */
export function setGhHost(host: string | undefined): void {
  if (host === undefined || host === '') {
    ghHost = undefined;
    return;
  }
  if (!HOSTNAME_RE.test(host)) {
    throw new TypeError(
      `--host must be a hostname (optionally :port), got ${JSON.stringify(host)}`,
    );
  }
  ghHost = host;
}

/**
 * Environment for `gh` child processes. `undefined` means "inherit the
 * parent env untouched"; with a host set, the inherited env is extended
 * with GH_HOST, which `gh` honours on every command.
 */
export function ghEnv(): NodeJS.ProcessEnv | undefined {
  return ghHost ? { ...process.env, GH_HOST: ghHost } : undefined;
}

/**
 * Run `gh` with args. Returns stdout, trimmed and CRLF-normalised.
 *
 * `maxBuffer` is raised well past Node's 1 MiB default: paginated fetches
 * on comment-heavy PRs routinely exceed it, and the resulting ENOBUFS kills
 * the subcommand mid-review (observed twice on a 43-file PR whose comments
 * crossed the megabyte). 64 MiB is far above any real PR payload while
 * still bounding a runaway response.
 */
export function gh(...args: string[]): string {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: ghEnv(),
  })
    .replace(/\r\n/g, '\n')
    .trim();
}

/**
 * Run `gh api <path>` (optionally with `--jq <expr>`) and JSON-parse the
 * result. Returns null when the response is empty (e.g. 204 / no content).
 */
export function ghApi(path: string, jq?: string): unknown {
  const args = ['api', path];
  if (jq) args.push('--jq', jq);
  const out = gh(...args);
  return out ? JSON.parse(out) : null;
}

/**
 * Run `gh api --paginate <path>` and JSON-parse the merged result.
 *
 * Use this for endpoints that return arrays and may have more than 30
 * (the default `per_page`) entries — PR `/comments`, `/issues/{n}/comments`,
 * `/reviews`, etc. `gh --paginate` walks every `next` link and concatenates
 * each page's array into a single top-level array, so a single
 * `JSON.parse` recovers the full set.
 *
 * Returns `[]` for empty responses or non-array payloads (defensive — the
 * endpoint may legitimately return an object on a 4xx-style 200, e.g. an
 * error envelope).
 */
export function ghApiAll(path: string): unknown[] {
  const out = gh('api', '--paginate', path);
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Paginate an endpoint whose array is nested under a key, e.g.
 * `check-runs` → `{ total_count, check_runs: [...] }`.
 *
 * A plain `ghApiAll` cannot be used here: `--paginate` alone concatenates the
 * raw per-page objects, so `JSON.parse` sees `}{ ` between pages and throws. On
 * a commit with more than 30 check runs (a busy CI matrix — one real head had
 * 508) the un-paginated call silently saw only the first page, which could hide
 * a failing or skipped run behind the cut and let a review approve past it.
 *
 * `--paginate --jq '.<key>[]'` applies the jq to every page and streams each
 * element as a newline-delimited JSON value (NDJSON), so the result is parsed
 * line by line rather than as one array. (`gh api` has no `--slurp`.)
 *
 * `strict` parsing here: a check-runs snapshot feeds CI classification, and
 * dropping a malformed line could hide a *failing* run — the same fail-open the
 * pagination fix closed, reintroduced by lenient parsing. A parse failure
 * throws.
 */
export function ghApiAllNested(path: string, key: string): unknown[] {
  return parseNdjson(gh('api', '--paginate', path, '--jq', `.${key}[]`), {
    strict: true,
  });
}

/**
 * Parse the newline-delimited JSON that `gh --paginate --jq '.x[]'` streams:
 * one JSON value per non-blank line. Split out and exported so the parse is
 * unit-testable without spawning `gh` (the spawn is covered by the commands'
 * own runs, per this module's testing note above).
 *
 * `strict` (default) throws on any non-JSON line — correct when a dropped
 * record would change a safety-relevant answer (e.g. hiding a failing check
 * run). Non-strict skips a stray line, for the rare caller that genuinely
 * expects interleaved human-readable notices and can tolerate a lost record.
 */
export function parseNdjson(
  out: string,
  opts: { strict?: boolean } = {},
): unknown[] {
  const strict = opts.strict ?? true;
  if (!out) return [];
  const values: unknown[] = [];
  for (const line of out.split('\n')) {
    if (line.trim().length === 0) continue;
    if (strict) {
      values.push(JSON.parse(line));
      continue;
    }
    try {
      values.push(JSON.parse(line));
    } catch {
      // not a JSON record; ignore
    }
  }
  return values;
}

/** Login of the currently authenticated GitHub user. */
export function currentUser(): string {
  return gh('api', 'user', '--jq', '.login');
}

/**
 * Verify `gh` is installed and authenticated. Throws a clear error if not —
 * subcommands call this first so missing-auth failures don't show up as
 * cryptic 401s mid-run.
 */
export function ensureAuthenticated(): void {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe', env: ghEnv() });
  } catch {
    throw new Error(
      'gh CLI is not authenticated. Run `gh auth login` and retry.',
    );
  }
}
