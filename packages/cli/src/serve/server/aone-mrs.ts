/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Aone backend for session PR bindings: per-workspace platform detection
// and the a1 reads (mr list / mr view) that feed session-pr-backfill and
// session-pr-refresh. Sibling of core's fetchGitHubPullRequests, with the
// same degrade-in-place contract: detection returns undefined when the
// workspace is not on Aone, and read failures throw AoneCliUnavailableError
// / AoneCommandError which both consumers catch and degrade (skip branch
// mapping, leave a number unresolved, keep a binding's last state). The
// review subsystem's aone-client.ts is deliberately NOT reused for
// transport: it is execFileSync with a 120s timeout and two blocking
// retries (worst case ~6 min per call) — fine for a CLI command,
// unacceptable on the daemon's event loop and 5-minute timer. Detection
// and the version floor DO reuse review's dependency-light modules so host
// grammar stays single-sourced.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  canonicalSessionPrUrl,
  findGitRoot,
  gitEnv,
  type SessionPrState,
} from '@qwen-code/qwen-code-core';
import {
  isAoneCanonicalHost,
  parseRemoteUrl,
} from '../../commands/review/lib/remote-match.js';
import {
  A1_MIN_VERSION,
  a1VersionAtLeast,
  parseA1Version,
} from '../../commands/review/lib/platform/aone-client.js';

const execFileAsync = promisify(execFile);

// Only a POSITIVE probe is memoized: a missing or too-old a1 keeps
// re-checking, so installing/upgrading it takes effect without a daemon
// restart, while a healthy install costs one probe per daemon lifetime
// instead of one per mr list/view call.
let a1AvailabilityVerified = false;

/**
 * Test seam for the exec layer: the a1 spawn, resolved to stdout. Errors
 * keep the exec shape (code/stdout/stderr/killed) that the error contract
 * below keys on.
 */
export type A1Exec = (
  args: readonly string[],
  options: { timeout: number; maxBuffer?: number },
) => Promise<{ stdout: string }>;

const defaultA1Exec: A1Exec = async (args, options) => {
  const { stdout } = await execFileAsync('a1', [...args], {
    ...options,
    encoding: 'utf8',
    windowsHide: true,
    // No env override: a1 authenticates through its own `a1 auth login`
    // config (review precedent); there is no A1_* token convention.
  });
  return { stdout };
};

let a1Exec: A1Exec = defaultA1Exec;

/** Test seam: swaps the a1 spawn and resets the version-probe memo. */
export function setA1ExecForTest(exec?: A1Exec): void {
  a1Exec = exec ?? defaultA1Exec;
  a1AvailabilityVerified = false;
}

export const A1_TIMEOUT_MS = 20_000;
export const A1_MAX_BUFFER = 16 * 1024 * 1024;
const GIT_ORIGIN_TIMEOUT_MS = 5_000;
/** Own budget for the `a1 --version` probe (not the git origin's). */
export const A1_VERSION_TIMEOUT_MS = 10_000;
/** Display cap for surfaced a1 error messages. */
const A1_ERROR_MESSAGE_MAX = 512;

/**
 * The canonical Aone host pair — the web host first: a detailUrl always
 * carries it, and manual bindings spell the review page with it. The git
 * host is the spelling a clone's remote uses; identity checks accept both.
 */
export const AONE_CANONICAL_HOSTS = [
  'code.alibaba-inc.com',
  'gitlab.alibaba-inc.com',
] as const;

/** `a1 repo mr list` page size is server-fixed; `--page` only picks one. */
export const AONE_MR_LIST_PAGE_SIZE = 20;

/**
 * Pages read per state when backfill maps branches to MRs (newest-first by
 * updatedAt) — a bounded window where gh reads 500 entries in one call.
 */
export const AONE_BACKFILL_PAGES_PER_STATE = 3;

/**
 * Bound on `mr view` calls per backfill run / refresh sweep. A view is the
 * only sanctioned source of an Aone MR URL, and every newly bound or
 * state-refreshed number costs one; the excess degrades to "unresolved /
 * unchanged this run" and the next run retries it.
 */
export const AONE_MAX_MR_VIEW_CALLS_PER_RUN = 25;

export interface AoneWorkspaceRepo {
  gitRoot: string;
  /** The origin's FULL group/project path — every a1 call's `--repo` arg. */
  repoPath: string;
}

export interface AoneMrListEntry {
  /** Aone's GLOBAL MR id (the codereview URL keys on it). */
  number: number;
  /** `sourceBranch` — a branch name, or a head SHA under AGit-Flow. */
  headRefName: string;
  state: SessionPrState;
}

export interface AoneMrView {
  number: number;
  /** The platform's `detailUrl` — Aone links are never assembled. */
  url: string;
  state: SessionPrState;
}

/** Test seam: the two a1 operations the binding paths need. */
export interface AoneMrBackend {
  list(
    repoPath: string,
    state: 'opened' | 'merged',
    pages: number,
  ): Promise<AoneMrListEntry[]>;
  view(repoPath: string, id: number): Promise<AoneMrView>;
}

export class AoneCliUnavailableError extends Error {}
export class AoneCommandError extends Error {}

/**
 * Aone's state vocabulary, mapped onto the sidecar's. `closed` is never
 * observed (a1 cannot list closed MRs) but defended against; `accepted`
 * is approved-not-merged, and AGit-Flow repos also report `reopened` —
 * both are still open.
 */
export function mapAoneMrState(raw: string | undefined): SessionPrState {
  switch (raw?.toLowerCase()) {
    case 'merged':
      return 'merged';
    case 'closed':
      return 'closed';
    default:
      return 'open';
  }
}

/**
 * Resolves the workspace's Aone coordinates, or undefined when it is not an
 * Aone workspace (not a repo, unreadable origin, non-Aone host). A daemon
 * serves many workspaces, so the origin is read per workspace instead of at
 * process.cwd(). Detection is CANONICAL-only, matching the rule review
 * applies to explicit coordinates: the workspace's origin names the platform
 * of that workspace's own MRs, and a family-wildcard match would displace
 * GitHub Enterprise instances (`*.alibaba-inc.com` also names GHE hosts)
 * onto a1 — a1 then either fails every read (state frozen forever where gh
 * served before) or, if a same-path repo exists on real Aone, serves an
 * unrelated repo's same-numbered MR.
 */
export async function resolveAoneWorkspaceRepo(
  workspaceCwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<AoneWorkspaceRepo | undefined> {
  const gitRoot = findGitRoot(workspaceCwd);
  if (!gitRoot) return undefined;
  let origin: string;
  try {
    ({ stdout: origin } = await execFileAsync(
      'git',
      ['remote', 'get-url', 'origin'],
      {
        cwd: gitRoot,
        timeout: GIT_ORIGIN_TIMEOUT_MS,
        encoding: 'utf8',
        windowsHide: true,
        // Same sanitization as every sibling git spawn in these paths —
        // an inherited GIT_DIR/GIT_CONFIG_* would resolve origin against
        // a different repository despite the cwd.
        env: gitEnv(env),
      },
    ));
  } catch {
    return undefined;
  }
  const identity = parseRemoteUrl(origin.trim());
  if (!identity || !isAoneCanonicalHost(identity.host)) return undefined;
  return { gitRoot, repoPath: identity.groupPath };
}

/**
 * Exact same-MR identity for this workspace's OWN repo: a detailUrl is
 * always `<canonical host>/<repoPath>/codereview/<global id>`, and
 * repoPath here is the origin's exact full group path (no collapse), so the
 * expected shape is exact under either canonical host spelling. Lets the
 * identity guards classify persisted entries WITHOUT an `mr view` — views
 * stay reserved for new bindings and legacy repairs — and lets the refresh
 * sweep drop numbers it can provably never update. This computes an
 * identity shape, it never fabricates a binding URL.
 */
export function isAoneDetailUrlForRepo(
  repoPath: string,
  number: number,
  url: string,
): boolean {
  const canonical = canonicalSessionPrUrl(url);
  return AONE_CANONICAL_HOSTS.some(
    (host) =>
      canonical ===
      canonicalSessionPrUrl(`https://${host}/${repoPath}/codereview/${number}`),
  );
}

function isA1ErrorObject(
  value: unknown,
): value is { schemaVersion: string; message?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['schemaVersion'] === 'a1.error/v1'
  );
}

function a1ErrorMessage(error: unknown): string {
  if ((error as { killed?: unknown } | null)?.killed === true) {
    return `a1 timed out after ${A1_TIMEOUT_MS / 1000}s`;
  }
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const raw =
    typeof stderr === 'string' && stderr.trim()
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, A1_ERROR_MESSAGE_MAX);
}

/** The version floor message mirrors review's ensureAoneAuthenticated. */
function assertA1Version(stdout: string): void {
  const triple = parseA1Version(stdout);
  const floor = parseA1Version(A1_MIN_VERSION);
  if (triple && floor && !a1VersionAtLeast(triple, floor)) {
    throw new AoneCliUnavailableError(
      `a1 ${A1_MIN_VERSION}+ is required (found ${stdout.trim().split('\n')[0]}); ` +
        'upgrade from https://code.alibaba-inc.com/aone/a1',
    );
  }
}

/**
 * Runs `a1 … --format json` and returns the parsed body. a1 answers some
 * errors with an `a1.error/v1` object at exit 0 and others at exit 1 with
 * the same object on stdout — the parsed shape, not the exit code, is the
 * error signal. No retry: the sweep/run re-attempts on its own schedule,
 * and one failed call must cost one timeout, not minutes.
 */
async function runA1Json<T>(args: string[]): Promise<T> {
  let stdout: string;
  try {
    ({ stdout } = await a1Exec([...args, '--format', 'json'], {
      timeout: A1_TIMEOUT_MS,
      maxBuffer: A1_MAX_BUFFER,
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AoneCliUnavailableError(
        'a1 CLI not installed; install it and run `a1 auth login`',
      );
    }
    // Exit-1 errors carry the structured cause on stdout.
    const errorStdout = (error as { stdout?: unknown } | null)?.stdout;
    if (typeof errorStdout === 'string' && errorStdout.trim()) {
      try {
        const parsed: unknown = JSON.parse(errorStdout);
        if (isA1ErrorObject(parsed)) {
          throw new AoneCommandError(parsed.message || 'a1 command failed');
        }
      } catch (parseError) {
        if (parseError instanceof AoneCommandError) throw parseError;
      }
    }
    throw new AoneCommandError(a1ErrorMessage(error));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AoneCommandError('a1 returned non-JSON output');
  }
  if (isA1ErrorObject(parsed)) {
    throw new AoneCommandError(parsed.message || 'a1 command failed');
  }
  return parsed as T;
}

async function checkA1Available(): Promise<void> {
  if (a1AvailabilityVerified) return;
  let stdout: string;
  try {
    ({ stdout } = await a1Exec(['--version'], {
      timeout: A1_VERSION_TIMEOUT_MS,
    }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AoneCliUnavailableError(
        'a1 CLI not installed; install it and run `a1 auth login`',
      );
    }
    // An unreadable version is not a hard blocker (review fails open too);
    // leave the flag unset so the next read re-probes — memoizing a FAILED
    // probe would silence the version floor for the daemon's lifetime.
    return;
  }
  assertA1Version(stdout);
  a1AvailabilityVerified = true;
}

/** Exported for tests — the list-body parse stays testable without exec. */
export function parseAoneMrListPage(raw: unknown): AoneMrListEntry[] {
  if (!Array.isArray(raw)) {
    throw new AoneCommandError('unexpected a1 mr list output');
  }
  const entries: AoneMrListEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const v = item as Record<string, unknown>;
    if (
      typeof v['id'] !== 'number' ||
      !Number.isInteger(v['id']) ||
      v['id'] <= 0
    ) {
      continue;
    }
    entries.push({
      number: v['id'],
      headRefName:
        typeof v['sourceBranch'] === 'string' ? v['sourceBranch'] : '',
      state: mapAoneMrState(
        typeof v['state'] === 'string' ? v['state'] : undefined,
      ),
    });
  }
  return entries;
}

/**
 * Lists the workspace repo's MRs, newest-updated first, across sequential
 * pages. `--state` only filters opened (incl. reopened) / accepted / merged
 * — closed MRs are NOT listable, which the refresh sweep documents rather
 * than works around (a reopened MR reappears as opened and self-heals).
 */
export async function listAoneMergeRequests(
  repoPath: string,
  options: { state: 'opened' | 'merged'; pages: number },
): Promise<AoneMrListEntry[]> {
  await checkA1Available();
  const entries: AoneMrListEntry[] = [];
  const pages = Math.max(options.pages, 1);
  for (let page = 1; page <= pages; page++) {
    const parsed = await runA1Json<unknown>([
      'repo',
      'mr',
      'list',
      '--repo',
      repoPath,
      '--state',
      options.state,
      '--page',
      String(page),
    ]);
    const pageEntries = parseAoneMrListPage(parsed);
    entries.push(...pageEntries);
    if (Array.isArray(parsed) && parsed.length < AONE_MR_LIST_PAGE_SIZE) {
      break;
    }
  }
  return entries;
}

/** Exported for tests — the view-body parse stays testable without exec. */
export function parseAoneMrView(raw: unknown, id: number): AoneMrView {
  const mr =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)['mergeRequest']
      : undefined;
  if (mr === null || typeof mr !== 'object') {
    throw new AoneCommandError('unexpected a1 mr view output');
  }
  const v = mr as Record<string, unknown>;
  const url = typeof v['detailUrl'] === 'string' ? v['detailUrl'] : '';
  if (!/^https?:\/\//i.test(url)) {
    throw new AoneCommandError('a1 mr view returned no detailUrl');
  }
  return {
    number: id,
    url,
    state: mapAoneMrState(
      typeof v['state'] === 'string' ? v['state'] : undefined,
    ),
  };
}

/**
 * Reads one MR's authoritative state + URL. The URL is the platform's
 * `detailUrl` — nested-group collapse makes Aone links non-assemblable from
 * owner/repo, so this call is the ONLY sanctioned URL source.
 */
export async function viewAoneMergeRequest(
  repoPath: string,
  id: number,
): Promise<AoneMrView> {
  await checkA1Available();
  const parsed = await runA1Json<unknown>([
    'repo',
    'mr',
    'view',
    String(id),
    '--repo',
    repoPath,
  ]);
  return parseAoneMrView(parsed, id);
}

export const defaultAoneMrBackend: AoneMrBackend = {
  list: (repoPath, state, pages) =>
    listAoneMergeRequests(repoPath, { state, pages }),
  view: viewAoneMergeRequest,
};
