/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Thin wrapper around the GitHub CLI (`gh`) for the `qwen review`
// subcommands. All callers go through `execFileSync` (no shell) so quoting
// and escaping is consistent across macOS, Linux, and Windows.

import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Transient-error retry
// ---------------------------------------------------------------------------

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 3_000;

/** Block the current thread without burning CPU (no busy-wait). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const TRANSIENT_RE =
  /HTTP 5\d{2}|server is currently unavailable|service unavailable|bad gateway|internal server error/i;

function isTransientGhError(err: unknown): boolean {
  const stderr =
    typeof (err as { stderr?: unknown }).stderr === 'string'
      ? ((err as { stderr: string }).stderr as string)
      : '';
  const msg = err instanceof Error ? err.message : '';
  return TRANSIENT_RE.test(stderr) || TRANSIENT_RE.test(msg);
}

/**
 * `execFileSync('gh', …)` with automatic retry on transient GitHub errors
 * (HTTP 5xx / "server is currently unavailable"). Non-transient failures
 * throw immediately.
 */
function execGhWithRetry(
  args: string[],
  options: { input?: string; mode?: 'default' | 'bytes' },
): string {
  const mode = options.mode ?? 'default';
  const execOptions: Parameters<typeof execFileSync>[2] = {
    // 'buffer' for the bytes mode: decoding as utf8 would replace any
    // invalid sequence with U+FFFD before we ever see it.
    encoding: mode === 'bytes' ? 'buffer' : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: ghEnv(),
    ...(options.input !== undefined ? { input: options.input } : {}),
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const out = execFileSync('gh', args, execOptions);
      if (mode === 'bytes') {
        // Byte fidelity end to end: latin1 maps each byte 1:1 onto a char
        // code, so a diff of a Latin-1/Shift-JIS file survives intact (and
        // fetch-diff writes it back with the same encoding). In a diff of a
        // CRLF file the `\r` before git's line-terminating `\n` is blob
        // CONTENT, and a trailing whitespace-only context line is part of
        // the last hunk — nothing may be trimmed or rewritten.
        return (out as unknown as Buffer).toString('latin1');
      }
      return (out as string).replace(/\r\n/g, '\n').trim();
    } catch (err) {
      if (attempt < MAX_RETRIES && isTransientGhError(err)) {
        const delay = BASE_DELAY_MS * (attempt + 1);
        process.stderr.write(
          `gh transient error (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms…\n`,
        );
        sleepSync(delay);
        continue;
      }
      throw err;
    }
  }
}

let ghHost: string | undefined;

// First char must be alphanumeric: without it the class admits flag-shaped
// values like `--help`/`-x`, which are interpolated into CLI invocations
// downstream and misparsed as options (measured: a tampered plan carrying
// host "--help" turned the welded issue-context call into a help print).
export const HOSTNAME_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*(?::\d+)?$/;

// A leading dash makes the value flag-shaped on the command line
// (`--repo -evil/repo` misparses as flags). Only the OWNER half bans it:
// GitHub owners cannot start with a hyphen, but REPO names can (real repo
// `yezhaodan/-Git` has existed since 2018) — banning it on the repo half
// would make real repositories unreviewable for zero protection.
const OWNER_SEGMENT = /^(?!-)[A-Za-z0-9._-]+$/;
const REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * `owner/repo` — the owner half may not start with a dash and neither half
 * may be a dot segment.
 *
 * The character class alone admits `../repo`, `owner/..` and `./repo`: `.`
 * and `..` are made of legal characters and mean something else entirely
 * once they reach a URL path. One home for the rule — submit's --repo
 * check and compose-review's plan identity both build API/anchor URLs
 * from it, and a hardening that lands in only one of them leaves the
 * other URL-building site on the stale rule.
 */
export function isOwnerRepo(repo: string): boolean {
  const [owner, repoName] = repo.split('/');
  return (
    repo.split('/').length === 2 &&
    OWNER_SEGMENT.test(owner) &&
    REPO_SEGMENT.test(repoName) &&
    owner !== '.' &&
    owner !== '..' &&
    repoName !== '.' &&
    repoName !== '..'
  );
}

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
  // Trim once here so every caller is consistent — `resolveGhHost` trims
  // too, and a raw `'ghe.corp '` must not fail validation where the
  // resolved form would pass. Only genuinely-absent input resets: a
  // non-empty all-whitespace value is a validation error, not a silent
  // "restore default" (a scripted `--host "$EMPTY_VAR"` must not silently
  // retarget every call at github.com).
  if (host === undefined || host === '') {
    ghHost = undefined;
    return;
  }
  const trimmed = host.trim();
  if (!HOSTNAME_RE.test(trimmed)) {
    throw new TypeError(
      `--host must be a hostname (optionally :port), got ${JSON.stringify(host)}`,
    );
  }
  ghHost = trimmed;
}

/**
 * The host `gh` calls are currently routed at, or `undefined` for the
 * default (github.com / an operator-exported GH_HOST). Lets a caller that
 * overrides the host for a scoped block save and restore the prior value
 * instead of leaking the override into module state.
 */
export function getGhHost(): string | undefined {
  return ghHost;
}

/**
 * The effective GitHub host for a command invocation: an explicit `--host`
 * flag wins, else an operator-exported GH_HOST, else `undefined` — the
 * caller applies its own default (`gh`'s github.com, or the matcher's
 * comparison host). Every call site that needs the effective host as a
 * value — the matcher and the two write-side authorisation gates —
 * resolves through this one helper so they cannot disagree; routing
 * sites go through `setGhHost` and inherit an operator-exported GH_HOST
 * via the child env.
 *
 * `|| undefined`, not `??`: an exported-but-empty GH_HOST ("" survives
 * `??`, being non-nullish) must read as "no host", not as a host named ""
 * that fails every comparison. The flag branch normalises the same way:
 * yargs delivers `''` for a bare `--host`, and `setGhHost('')` documents
 * empty as "restore default", so an empty flag falls through to the env.
 * A NON-EMPTY all-whitespace flag is different: it is returned as `''`
 * (it does NOT fall through to the env), so callers that validate the raw
 * flag via setGhHost see a real value and the documented TypeError fires,
 * instead of the flag silently retargeting a write at the env/default host.
 */
export function resolveGhHost(
  flagHost: string | undefined,
): string | undefined {
  return (
    (flagHost === undefined || flagHost === '' ? undefined : flagHost.trim()) ??
    (process.env['GH_HOST']?.trim() || undefined)
  );
}

/**
 * The canonical spelling of a GitHub host for URL BUILDING: lowercase, the
 * implicit `:443` dropped (leading zeros included), one trailing dot (FQDN
 * form) dropped, and `www.github.com` folded onto `github.com`. A
 * NON-default port SURVIVES — a GHE instance on :8443 serves its pages
 * there, and stripping it would 404 the link. One home for every PR-page
 * builder (compose-review's comment anchors and the reader's composeUrl),
 * so a host-spelling change lands in one file and one review run can never
 * print two textual spellings of the same PR page.
 */
export function normalizeGhHostForUrl(host: string): string {
  return host
    .toLowerCase()
    .replace(/:0*443$/, '')
    .replace(/\.$/, '')
    .replace(/^www\.github\.com$/, 'github.com');
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
 * Retries automatically on transient GitHub errors (HTTP 5xx).
 *
 * `maxBuffer` is raised well past Node's 1 MiB default: paginated fetches
 * on comment-heavy PRs routinely exceed it, and the resulting ENOBUFS kills
 * the subcommand mid-review (observed twice on a 43-file PR whose comments
 * crossed the megabyte). 64 MiB is far above any real PR payload while
 * still bounding a runaway response.
 */
export function gh(...args: string[]): string {
  return execGhWithRetry(args, {});
}

/**
 * Same transport with the bytes UNTOUCHED — runs with encoding 'buffer' and
 * decodes latin1 (1:1 byte→char), so no invalid-UTF-8 byte is lost to U+FFFD
 * and nothing is trimmed or CRLF-rewritten. For payloads whose bytes are
 * content: a PR diff (source files may be Latin-1/Shift-JIS, and in a CRLF
 * file the `\r` is blob content). The caller writes it back with latin1.
 */
export function ghRaw(...args: string[]): string {
  return execGhWithRetry(args, { mode: 'bytes' });
}

/**
 * Run `gh` with `input` on its stdin, WITH the same transient-error retry as
 * `gh()` — for callers whose input-carrying writes are idempotent
 * (publish-assets: content-hashed PUTs, a ref create whose duplicate is
 * caught). Non-idempotent writes use `ghWithInput` below.
 */
export function ghWithInputRetried(input: string, ...args: string[]): string {
  return execGhWithRetry(args, { input });
}

/**
 * Run `gh` with `input` on its stdin. Returns stdout, trimmed.
 *
 * Unlike `gh()`, this does NOT retry on transient errors: `submit.ts` POSTs
 * a review, which is not idempotent — a retry after a proxy-level 502/503
 * could duplicate the review if GitHub already processed the original
 * request. A caller whose input-carrying write IS idempotent (publish-assets:
 * content-hashed PUTs, a ref create whose duplicate is caught) uses
 * `ghWithInputRetried` above, which shares `gh()`'s transient-error retry.
 *
 * Exists so a caller can send bytes it already holds in memory instead of a
 * pathname `gh` would re-open. Passing `--input <file>` re-reads the file at
 * call time, so a swap or truncation between validating that file and posting it
 * sends GitHub something other than what passed validation — a review the author
 * did not write, or a 422. Sending the validated bytes over stdin (`--input -`)
 * closes that window: the bytes checked are the bytes posted.
 */
export function ghWithInput(input: string, ...args: string[]): string {
  return (
    execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: ghEnv(),
      input,
    }) as string
  )
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
 * `/reviews`, etc.
 *
 * **Why a single `JSON.parse` is correct on multi-page output (a recurring
 * review question):** for a TOP-LEVEL JSON array `gh --paginate` MERGES the
 * pages into one array — it does NOT emit one array per page. So the output
 * is a single well-formed array and `JSON.parse` recovers the full set. The
 * per-page-concatenation failure mode (`}{` / `][` between pages that would
 * throw) only happens for endpoints whose array is NESTED under a key (e.g.
 * `check-runs`), and those go through {@link ghApiAllNested} with
 * `--jq '.<key>[]'` + NDJSON parsing precisely because `--paginate` can't
 * merge them. Verified empirically on a 4-page (`per_page=30`, 97-comment)
 * `pulls/{n}/comments` response: zero `][` markers, one array, clean parse.
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
 *
 * Retries once after a short delay: the OS keyring can transiently fail to
 * unlock (observed on macOS when the keyring prompt races with process
 * startup), and a single retry avoids a spurious "not authenticated" abort
 * that forces the orchestrating model to debug and re-run the subcommand.
 */
export function ensureAuthenticated(): void {
  for (let attempt = 0; ; attempt++) {
    try {
      execFileSync('gh', ['auth', 'status'], { stdio: 'pipe', env: ghEnv() });
      return;
    } catch (err) {
      if (attempt === 0 && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        sleepSync(2_000);
        continue;
      }
      throw new Error(
        'gh CLI is not authenticated. Run `gh auth login` and retry.',
      );
    }
  }
}
