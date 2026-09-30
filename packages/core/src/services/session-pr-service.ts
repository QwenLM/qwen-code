/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { isNodeError } from '../utils/errors.js';
import { atomicWriteJSON } from '../utils/atomicFileWrite.js';
import { SESSION_PR_ISSUE_LIST_LIMIT } from '../utils/github-pr-issues.js';

/**
 * Persisted GitHub pull request binding for a session. Written by the daemon
 * when a PR is created from the session (e.g. the Web Shell Git dialog), and
 * read on session listing so the binding survives daemon restarts. A session
 * may produce several PRs (stacked or unrelated), so the sidecar keeps a
 * bounded list ordered by binding time — the last entry is the latest.
 *
 * Stored as a sidecar JSON file alongside the session's JSONL transcript at
 * `<chatsDir>/<sessionId>.pr.json`.
 */
export interface SessionPr {
  number: number;
  url: string;
  createdAt: string;
  /** Snapshot at last write/refresh; refreshed by the daemon timer. */
  state?: SessionPrState;
  /**
   * Binding provenance, ranked by the tail cap's eviction: the session's
   * convention and created PRs outrank PRs it merely reviewed. Absent on
   * entries persisted before provenance was recorded.
   */
  source?: SessionPrSource;
  /**
   * Issues the PR closes (GitHub's closing references), snapshotted by the
   * daemon timer — never bound by clients. Absent until the first refresh
   * after binding; an empty array means "fetched, none".
   */
  issues?: SessionPrIssue[];
}

export type SessionPrState = 'open' | 'merged' | 'closed';

/**
 * Why a binding exists. The worktree slug/branch convention names the PR the
 * session EXISTS FOR; a gh-verified create names the PR the session CREATED;
 * a `/review` command names a PR it merely looked at.
 */
export type SessionPrSource = 'create' | 'worktree' | 'review';

export interface SessionPrIssue {
  number: number;
  url: string;
  /** Snapshot at last refresh; `not_planned` covers GitHub's "duplicate" too. */
  state?: SessionPrIssueState;
}

export type SessionPrIssueState = 'open' | 'completed' | 'not_planned';

/** Bound on the persisted PR list; oldest bindings are dropped beyond it. */
export const SESSION_PR_LIST_LIMIT = 10;

/** Upper bound for a bound PR URL; generous for enterprise hosts + long paths. */
export const SESSION_PR_URL_MAX_LENGTH = 2048;

interface SessionPrList {
  prs: SessionPr[];
}

// Mirrors the bridge's hasControlCharacter (ESLint forbids control-char
// regexes).
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

/**
 * Shape check for a binding url: rendered as a link target (http(s) only),
 * bounded, and free of control characters (the bridge interpolates it into
 * a stderr audit line, where a control character would forge log lines).
 * Every writer that persists a caller-supplied url must apply it: the
 * reader fails the WHOLE list closed on one invalid entry. PR and issue
 * urls share the rule.
 */
export function isValidSessionPrUrl(url: string): boolean {
  return (
    url.length <= SESSION_PR_URL_MAX_LENGTH &&
    /^https?:\/\//i.test(url) &&
    !hasControlCharacter(url)
  );
}

function isValidBindingUrl(value: unknown): value is string {
  return typeof value === 'string' && isValidSessionPrUrl(value);
}

function isValidSessionPrIssue(value: unknown): value is SessionPrIssue {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['number'] === 'number' &&
    Number.isInteger(v['number']) &&
    v['number'] > 0 &&
    isValidBindingUrl(v['url']) &&
    (v['state'] === undefined ||
      v['state'] === 'open' ||
      v['state'] === 'completed' ||
      v['state'] === 'not_planned')
  );
}

/** Runtime shape check for one entry. */
function isValidSessionPr(value: unknown): value is SessionPr {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['number'] === 'number' &&
    Number.isInteger(v['number']) &&
    v['number'] > 0 &&
    isValidBindingUrl(v['url']) &&
    typeof v['createdAt'] === 'string' &&
    (v['state'] === undefined ||
      v['state'] === 'open' ||
      v['state'] === 'merged' ||
      v['state'] === 'closed') &&
    (v['source'] === undefined ||
      v['source'] === 'create' ||
      v['source'] === 'worktree' ||
      v['source'] === 'review') &&
    (v['issues'] === undefined ||
      (Array.isArray(v['issues']) &&
        v['issues'].length <= SESSION_PR_ISSUE_LIST_LIMIT &&
        v['issues'].every(isValidSessionPrIssue)))
  );
}

/**
 * Runtime shape check for a parsed sidecar object. Guards against partial
 * writes and manual edits (same rationale as the worktree sidecar check).
 */
function isValidSessionPrList(value: unknown): value is SessionPrList {
  if (value === null || typeof value !== 'object') return false;
  const prs = (value as Record<string, unknown>)['prs'];
  return Array.isArray(prs) && prs.length > 0 && prs.every(isValidSessionPr);
}

/**
 * Read the sidecar. Returns null when the file does not exist, is invalid
 * JSON, or fails the shape check. Throws only on unexpected I/O errors.
 */
export async function readSessionPrs(
  filePath: string,
  options: { signal?: AbortSignal } = {},
): Promise<SessionPr[] | null> {
  let raw: string;
  try {
    options.signal?.throwIfAborted();
    raw = options.signal
      ? await fs.readFile(filePath, {
          encoding: 'utf-8',
          signal: options.signal,
        })
      : await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    options.signal?.throwIfAborted();
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  options.signal?.throwIfAborted();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  options.signal?.throwIfAborted();
  if (!isValidSessionPrList(parsed)) return null;
  return parsed.prs;
}

/** Writes the PR sidecar via `atomicWriteJSON`. */
export async function writeSessionPrs(
  filePath: string,
  prs: SessionPr[],
  options: { assertCanCommit?: () => void } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJSON(filePath, { prs } satisfies SessionPrList, options);
}

// The execution gate's grammar — a CLOSED set, on purpose. A segment runs
// `gh pr create` when it reads, in order:
//
//   1. leading single-word assignments (`GH_TOKEN=x`, `FOO=bar`);
//   2. any chain of wrappers from {sudo, env, nohup, command}, each with up
//      to three flags (with one optional value) or assignments;
//   3. the gh binary — bare `gh`, `gh.exe`/`.cmd`/`.bat`, or any
//      path-qualified spelling (`/usr/bin/gh`, `~/bin/gh.cmd`, `./gh`,
//      `bin/gh`, `C:\tools\gh.exe`, `\\srv\share\gh.exe`);
//   4. `pr create` or the `pr new` alias.
//
// `gh pr create` must START the segment: `grep -rn 'gh pr create'` mentions
// the phrase as an argument and must not count, while `cd /w && gh pr
// create` or `FOO=bar gh pr create | tee log` do. Shapes outside the
// grammar — a value containing whitespace (`GH_TOKEN="a b"`), a command
// substitution, `bash -c "…"`, `timeout 60 gh …`, a subshell, a
// line-continuation inside the invocation — deliberately do NOT match:
// the gate fails closed, the create still runs, and only the binding is
// skipped (recoverable through `/review <N>` or the worktree convention).
// Quote-awareness stays approximate because the shell-aware tokenizer lives
// in tools/shell.ts and cannot be imported here without pulling it into
// the serve bundle closure. This is only the execution gate — it cannot
// attribute a printed URL to gh's own run, so callers must verify the
// binding with gh itself before persisting it.
const GH_PR_CREATE_SEGMENT_PATTERN =
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:(?:sudo|env|nohup|command)\s+(?:-\S+(?:\s+\S+)?\s+|[A-Za-z_][A-Za-z0-9_]*=\S+\s+){0,3})*(?:\S*[/\\])?gh(?:\.exe|\.cmd|\.bat)?\s+pr\s+(?:create|new)\b/;

export function commandRunsGhPrCreate(command: string): boolean {
  return (
    command
      // \n is a standard shell separator: model-authored commands routinely
      // span lines, and the gate must see a `gh pr create` on a later line.
      .split(/&&|\|\||[;|\n]/)
      .some((segment) => GH_PR_CREATE_SEGMENT_PATTERN.test(segment))
  );
}

const GH_INLINE_ENV_ASSIGNMENT_PATTERN =
  /^(GH_[A-Za-z0-9_]*|GITHUB_[A-Za-z0-9_]*)=(\S+)$/;
const GH_ENV_NAME_PATTERN = /^(?:GH_|GITHUB_)[A-Za-z0-9_]*$/;
const GH_CREATE_WRAPPER_NAMES = new Set(['sudo', 'env', 'nohup', 'command']);
const GH_BINARY_PATTERN = /(?:^|[/\\])gh(?:\.exe|\.cmd|\.bat)?$/;

/**
 * Approximates the shell's own expansion so the verification legs
 * authenticate the way the create itself did: surrounding quotes are
 * syntax, and `$VAR`/`${VAR}` names the process environment the child
 * shell expands from (an absent variable expands to the empty string,
 * matching the shell). Single quotes suppress expansion in the shell too.
 * Command substitutions (`$(…)`) and parameter-expansion operators
 * (`${VAR:-default}`, `${VAR#pat}`, …) stay literal — they cannot be
 * evaluated here, and a wrong guess must not authenticate the legs.
 */
function expandInlineEnvValue(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  const unquoted =
    raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1)
      : raw;
  // A `${` that is not the plain `${NAME}` form carries an operator.
  if (/\$\{(?![A-Za-z_][A-Za-z0-9_]*\})/.test(unquoted)) return unquoted;
  return unquoted.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, braced: string | undefined, bare: string | undefined) =>
      process.env[braced ?? bare ?? ''] ?? '',
  );
}

/**
 * The inline `GH_*`/`GITHUB_*` credential changes a `gh pr create` run
 * carries (e.g. `GH_TOKEN=… gh pr create --fill`). The gh legs that verify
 * a create must authenticate the way the create itself did: with an inline
 * token and no ambient gh auth, a bare verification run errors and the
 * binding silently misses; with an ambient token the create explicitly
 * shed (`unset GH_TOKEN`, `env -u GH_TOKEN`, `env -i`), the legs must shed
 * it too. The record is an OVERLAY onto the process environment: a string
 * value sets the variable, `undefined` removes it.
 *
 * Collection follows the command in order and mirrors the execution gate's
 * closed grammar. `export`/`unset` segments accumulate into the exported
 * state that is visible to every LATER segment — an export after the
 * create cannot have authenticated it. For each gate-matching segment the
 * record is that exported state plus the segment's own prefix: assignments
 * (non-GH ones are skipped, not terminators), wrapper names, their flags
 * and values (`env -u NAME` removes, `env -i` drops every ambient GH
 * credential), stopping at the gh binary — assignments after it are gh
 * arguments, not environment. The LAST gate-matching segment wins, so a
 * non-creating gate-matching segment cannot shadow a later create's token.
 * Values are single shell words: a quoted value with whitespace or a
 * command substitution is outside the gate's grammar and stays literal.
 */
export function ghPrCreateInlineEnv(
  command: string,
): Readonly<Record<string, string | undefined>> | undefined {
  const exported: Record<string, string | undefined> = {};
  let record: Record<string, string | undefined> | undefined;
  const dropAmbient = (env: Record<string, string | undefined>): void => {
    for (const name of Object.keys(process.env)) {
      if (GH_ENV_NAME_PATTERN.test(name)) env[name] = undefined;
    }
  };
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/);
    // `export GH_TOKEN=…` / `unset GH_TOKEN` in ANY segment binds or
    // removes the variable for every later segment of the command.
    if (tokens[0] === 'export') {
      for (let i = 1; i < tokens.length; i++) {
        const assignment = GH_INLINE_ENV_ASSIGNMENT_PATTERN.exec(tokens[i]);
        if (assignment !== null) {
          exported[assignment[1]] = expandInlineEnvValue(assignment[2]);
          continue;
        }
        // A non-GH assignment (`export FOO=bar GH_TOKEN=x`) exports both —
        // skip it; only a bare name (`export PATH`) cannot be evaluated.
        if (!tokens[i].includes('=')) break;
      }
      continue;
    }
    if (tokens[0] === 'unset') {
      for (const token of tokens.slice(1)) {
        if (GH_ENV_NAME_PATTERN.test(token)) exported[token] = undefined;
      }
      continue;
    }
    if (!GH_PR_CREATE_SEGMENT_PATTERN.test(segment)) continue;
    const env: Record<string, string | undefined> = { ...exported };
    let pendingFlag: string | undefined;
    for (const token of tokens) {
      const assignment = GH_INLINE_ENV_ASSIGNMENT_PATTERN.exec(token);
      if (assignment !== null) {
        env[assignment[1]] = expandInlineEnvValue(assignment[2]);
        pendingFlag = undefined;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=\S+$/.test(token)) {
        // A non-GH assignment (`FOO=bar GH_TOKEN=x gh pr create`) — the
        // gate grammar admits it, so it must not end the scan.
        pendingFlag = undefined;
        continue;
      }
      if (GH_BINARY_PATTERN.test(token)) break;
      if (pendingFlag !== undefined) {
        // A flag's value (`sudo -u runner`, `env -u GH_TOKEN`), not the
        // binary.
        if (pendingFlag === '-u' && GH_ENV_NAME_PATTERN.test(token)) {
          env[token] = undefined;
        }
        pendingFlag = undefined;
        continue;
      }
      if (token === '-i') {
        dropAmbient(env);
        continue;
      }
      if (GH_CREATE_WRAPPER_NAMES.has(token) || token.startsWith('-')) {
        pendingFlag = token.startsWith('-') ? token : undefined;
        continue;
      }
      break;
    }
    record = env;
  }
  if (record === undefined) return undefined;
  return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Wire projection of a binding: drops the sidecar-only `createdAt` and omits
 * absent optionals, so responses, events, and live bridge entries all carry
 * the same shape.
 */
export function toSessionPrInfo({
  number,
  url,
  state,
  issues,
}: Omit<SessionPr, 'createdAt'>): Omit<SessionPr, 'createdAt'> {
  return {
    number,
    url,
    ...(state ? { state } : {}),
    ...(issues ? { issues } : {}),
  };
}

/**
 * Union two binding lists, deduping by PR number and keeping each number's
 * freshest entry (by createdAt), ordered by binding time and capped. Used
 * when an archive-state move finds both halves of a split pair: the sidecar
 * is the append-only binding history, so the halves are merged instead of
 * one being stranded.
 */
export function mergeSessionPrLists(
  base: SessionPr[],
  incoming: SessionPr[],
): SessionPr[] {
  const byNumber = new Map<number, SessionPr>();
  for (const entry of [...base, ...incoming]) {
    const known = byNumber.get(entry.number);
    if (!known) {
      byNumber.set(entry.number, entry);
      continue;
    }
    // The freshest entry survives (the badge renders binding recency), but
    // a same-PR dedup must not DOWNGRADE provenance: the live shell binder
    // stamps `create` on one half of a split pair, and a later `/review`
    // backfill of the other half re-binds the number as `review` — keeping
    // the newer entry wholesale would hand the authority cap a rank-0
    // create binding to evict. Same rule as upsertSessionPr; a different
    // canonical url is another PR and carries nothing across.
    const [newer, older] =
      entry.createdAt >= known.createdAt ? [entry, known] : [known, entry];
    const source =
      canonicalSessionPrUrl(newer.url) === canonicalSessionPrUrl(older.url) &&
      sessionPrSourceAuthority(older.source) >
        sessionPrSourceAuthority(newer.source)
        ? older.source
        : newer.source;
    byNumber.set(
      entry.number,
      source === newer.source ? newer : { ...newer, source },
    );
  }
  return capSessionPrListByAuthority(
    [...byNumber.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
  );
}

// Provenance rank for the tail cap and for source merges. Entries persisted
// before provenance was recorded sit between reviews and creates: they may
// be a session's created or convention binding, so a weak candidate must
// never displace one — but a verified create still outranks them.
export function sessionPrSourceAuthority(
  source: SessionPrSource | undefined,
): number {
  switch (source) {
    case 'worktree':
      return 3;
    case 'create':
      return 2;
    case 'review':
      return 0;
    default:
      return 1;
  }
}

/**
 * Caps a binding list at {@link SESSION_PR_LIST_LIMIT}, dropping the weakest
 * entries first — lowest provenance authority, oldest position within the
 * same authority. The created and convention bindings a session exists for
 * survive an accumulation of reviewed numbers; offered-or-not plays no role,
 * because the strongest bindings are never re-offered by most writers.
 */
function capSessionPrListByAuthority(list: SessionPr[]): SessionPr[] {
  const overflow = list.length - SESSION_PR_LIST_LIMIT;
  if (overflow <= 0) return list;
  const evictPositions = new Set(
    list
      .map((_, index) => index)
      .sort(
        (a, b) =>
          sessionPrSourceAuthority(list[a].source) -
            sessionPrSourceAuthority(list[b].source) || a - b,
      )
      .slice(0, overflow),
  );
  return list.filter((_, index) => !evictPositions.has(index));
}

// Cross-process file lock around every sidecar mutation. The live shell
// binder runs in the session child process while GitDialog, backfill, and
// the refresh sweep write from the daemon; the in-process queue below only
// serializes one of those processes, and `atomicWriteJSON`'s temp+rename
// carries no cross-process exclusion — an interleaved sweep rename would
// replace the file with a list computed before a concurrent create landed,
// silently dropping the new binding. Mirrors the mailbox two-tier pattern
// (in-process serialization inside, `proper-lockfile` outside).
const LOCK_OPTIONS: lockfile.LockOptions = {
  retries: {
    retries: 10,
    minTimeout: 5,
    maxTimeout: 100,
    factor: 2,
    randomize: true,
  },
  stale: 5000,
  onCompromised: () => {
    // A stale-lock takeover is expected after a crashed holder; the
    // mutation still proceeds, so there is nothing to surface.
  },
};

async function withSidecarLock<T>(
  filePath: string,
  run: () => Promise<T>,
): Promise<T> {
  // proper-lockfile locks by creating a sibling `<path>.lock` directory —
  // the atomic rename swap never disturbs it. Its default `realpath`
  // resolution requires the guarded path to EXIST, which a sidecar of a
  // session that never bound a PR does not — and materializing an empty
  // file before locking races a concurrent holder whose no-op mutation
  // unlinks the empty file it materialized, so the acquisition here would
  // fail ENOENT and the mutation would be lost. Canonicalize the parent
  // directory ourselves instead (the same lock path a realpath-resolving
  // holder computes, symlinked temp dirs included) and lock by path, so
  // the file need not exist and nothing is ever materialized.
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const lockPath = path.join(await fs.realpath(dir), path.basename(filePath));
  const release = await lockfile.lock(lockPath, {
    ...LOCK_OPTIONS,
    realpath: false,
  });
  try {
    return await run();
  } finally {
    try {
      await release();
    } catch {
      // Already released or compromised — never fail the mutation for the
      // lock teardown.
    }
  }
}

// Serializes read-modify-write cycles per sidecar path WITHIN this process:
// concurrent mutations for the same session must not interleave (read [] →
// read [] → write [A] → write [B] would silently drop A), and the queue
// keeps same-process writers from stampeding the file lock. A failed
// predecessor must not block later mutations.
const mutationQueue = new Map<string, Promise<unknown>>();

function enqueuePrMutation<T>(
  filePath: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = mutationQueue.get(filePath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => withSidecarLock(filePath, run));
  mutationQueue.set(filePath, next);
  // The cleanup chain must absorb `next`'s rejection too — a derived
  // finally/catch promise would otherwise reject unhandled whenever the
  // queued write fails, even though every caller awaits `next` itself.
  const cleanup = (): void => {
    if (mutationQueue.get(filePath) === next) mutationQueue.delete(filePath);
  };
  void next.then(cleanup, cleanup);
  return next;
}

/**
 * Canonical form of a binding url for same-target comparison: host/path
 * case, trailing slashes, query, and fragment never change which PR a url
 * names (GitHub hosts and repo paths are case-insensitive; query variants
 * are cache-busters), while the repository path does — a same-numbered PR
 * of a different repository is a different PR.
 */
export function canonicalSessionPrUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`
      .toLowerCase()
      .replace(/\/+$/, '');
  } catch {
    return url.toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Insert or refresh a binding (matched by PR number) and persist the list,
 * capped at {@link SESSION_PR_LIST_LIMIT} by provenance authority (see
 * {@link upsertSessionPrs} — every writer caps the same way, so the
 * created and convention bindings a session exists for survive an
 * accumulation of reviewed numbers regardless of which writer overflowed
 * the list). A re-bind moves the number to the end (latest) with a fresh
 * createdAt — the badge renders binding recency, and the backfill cap
 * planner relies on the fresh createdAt to tell a concurrent re-bind from
 * an untouched snapshot entry. An omitted `state` preserves the known one
 * only for the same PR (same canonical url) — a different repository's
 * same-numbered PR is a different PR and must not inherit a terminal
 * state. An explicit `source` wins only against a weaker-or-equal persisted
 * one of the SAME PR (a re-bind never downgrades provenance); a different
 * PR's entry lends nothing.
 *
 * Entries the read-side shape check would reject are declined here: the
 * reader fails the WHOLE list closed, so persisting one poisoned entry would
 * erase every earlier binding until the next successful write. The issue
 * snapshot is kept on the same-PR condition: only the refresh sweep
 * writes it.
 */
export function upsertSessionPr(
  filePath: string,
  pr: {
    number: number;
    url: string;
    state?: SessionPrState;
    source?: SessionPrSource;
  },
): Promise<SessionPr[]> {
  return enqueuePrMutation(filePath, async () => {
    const existing = (await readSessionPrs(filePath)) ?? [];
    const known = existing.find(
      (entry) =>
        entry.number === pr.number &&
        canonicalSessionPrUrl(entry.url) === canonicalSessionPrUrl(pr.url),
    );
    // An explicit source upgrades the entry (review → create) but never
    // DOWNGRADES it: the worktree convention binding names the PR the
    // session exists for, and a client-driven re-bind stamping 'create'
    // must not drop it into the rank the tail cap evicts first.
    // No known entry (a new number, or the number re-bound to ANOTHER PR)
    // takes the candidate's own source; a known one keeps the stronger.
    const source =
      known === undefined
        ? pr.source
        : pr.source !== undefined &&
            sessionPrSourceAuthority(pr.source) >=
              sessionPrSourceAuthority(known.source)
          ? pr.source
          : known.source;
    const state = pr.state ?? known?.state;
    const entry: SessionPr = {
      number: pr.number,
      url: pr.url,
      createdAt: new Date().toISOString(),
      ...(state ? { state } : {}),
      ...(source ? { source } : {}),
      ...(known?.issues ? { issues: known.issues } : {}),
    };
    if (!isValidSessionPr(entry)) return existing;
    const next = capSessionPrListByAuthority([
      ...existing.filter((e) => e.number !== pr.number),
      entry,
    ]);
    await writeSessionPrs(filePath, next);
    return next;
  });
}

/** One locked read-modify-write for several candidate bindings at once. */
export interface SessionPrUpsertManyResult {
  /** The persisted list after the mutation. */
  prs: SessionPr[];
  /** Candidate numbers newly bound and present in `prs`. */
  added: readonly number[];
  /** Candidate numbers already bound at the same URL. */
  alreadyBound: readonly number[];
  /** Candidate numbers with no url that were not already bound. */
  unresolved: readonly number[];
}

/**
 * Applies a run's candidate bindings in ONE locked read-modify-write.
 * Candidates are given in ascending authority order (later entries outrank
 * earlier ones under the tail cap). A number already bound at the SAME url
 * keeps its position and createdAt — moving it would falsify the
 * binding-time order the badge and tooltip render by — but a stronger
 * explicit source upgrades the entry in place. A number bound at a
 * DIFFERENT url is another PR (the same number in another repository is
 * another PR): the candidate re-binds it the way {@link upsertSessionPr}
 * does — replace the entry, fresh createdAt, the candidate's own source,
 * no state or provenance carry-over across the URL change. A candidate
 * without a url is
 * reported `unresolved` (unless already bound). New candidates append
 * with a fresh createdAt; the capped list is written once, so the write
 * cannot cascade and a failure cannot strand a partial result. The read
 * inside the lock sees bindings concurrent writers land before this
 * mutation.
 *
 * When the merged list overflows the cap, eviction is ranked by binding
 * provenance — reviewed PRs first, then pre-provenance entries, then
 * created, then the worktree convention; oldest position within the same
 * rank. Offered-or-not plays no role: a session's created and convention
 * bindings are never re-offered by most writers, and a weak run must not
 * displace them.
 */
export function upsertSessionPrs(
  filePath: string,
  candidates: ReadonlyArray<{
    number: number;
    url?: string;
    state?: SessionPrState;
    source?: SessionPrSource;
  }>,
): Promise<SessionPrUpsertManyResult> {
  return enqueuePrMutation(filePath, async () => {
    const existing = (await readSessionPrs(filePath)) ?? [];
    const next = [...existing];
    const appended = new Set<number>();
    const alreadyBound: number[] = [];
    const unresolved: number[] = [];
    let changed = false;
    for (const candidate of candidates) {
      const knownIndex = next.findIndex(
        (entry) => entry.number === candidate.number,
      );
      const known = knownIndex >= 0 ? next[knownIndex] : undefined;
      if (candidate.url === undefined) {
        (known ? alreadyBound : unresolved).push(candidate.number);
        continue;
      }
      if (
        known &&
        canonicalSessionPrUrl(known.url) ===
          canonicalSessionPrUrl(candidate.url)
      ) {
        if (
          candidate.source !== undefined &&
          sessionPrSourceAuthority(candidate.source) >
            sessionPrSourceAuthority(known.source)
        ) {
          next[knownIndex] = { ...known, source: candidate.source };
          changed = true;
        }
        alreadyBound.push(candidate.number);
        continue;
      }
      // A new entry — or a re-bind of the number to ANOTHER PR — carries
      // the candidate's own source: the replaced entry's provenance
      // belongs to the PR it named, and must not cross onto this one any
      // more than its state does.
      const entry: SessionPr = {
        number: candidate.number,
        url: candidate.url,
        createdAt: new Date().toISOString(),
        ...(candidate.state ? { state: candidate.state } : {}),
        ...(candidate.source ? { source: candidate.source } : {}),
      };
      if (!isValidSessionPr(entry)) {
        unresolved.push(candidate.number);
        continue;
      }
      if (knownIndex >= 0) next.splice(knownIndex, 1);
      next.push(entry);
      appended.add(candidate.number);
    }
    if (appended.size === 0 && !changed) {
      return { prs: existing, added: [], alreadyBound, unresolved };
    }
    const prs = capSessionPrListByAuthority(next);
    const persistedNumbers = new Set(prs.map((entry) => entry.number));
    const added = [...appended].filter((number) =>
      persistedNumbers.has(number),
    );
    await writeSessionPrs(filePath, prs);
    return { prs, added, alreadyBound, unresolved };
  });
}

function sameIssues(
  left: readonly SessionPrIssue[] | undefined,
  right: readonly SessionPrIssue[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.length === right.length &&
    left.every(
      (issue, index) =>
        issue.number === right[index]!.number &&
        issue.url === right[index]!.url &&
        issue.state === right[index]!.state,
    )
  );
}

/**
 * Rewrites bound PR snapshots (`state`, `issues`) in place — order and
 * createdAt are preserved, so a refresh sweep never reshuffles the badge's
 * "latest" entry. A fetched snapshot applies only when its url matches the
 * entry's: the map is keyed by number, but a binding may point at any
 * repository, and a same-numbered PR of a different repo is a different PR.
 * An omitted `state` or `issues` leaves that field alone (the two come from
 * different queries, and either may miss a PR). Returns the number of
 * entries rewritten; 0 when the sidecar is absent/invalid or nothing changed
 * (no write then). `assertCanCommit` runs inside the mutation queue right
 * before the irreversible write commit; a throw aborts the write.
 */
export function updateSessionPrStates(
  filePath: string,
  states: ReadonlyMap<
    number,
    { state?: SessionPrState; url: string; issues?: SessionPrIssue[] }
  >,
  options: { assertCanCommit?: () => void } = {},
): Promise<number> {
  return enqueuePrMutation(filePath, async () => {
    const existing = await readSessionPrs(filePath);
    if (!existing) return 0;
    let changed = 0;
    const next = existing.map((entry) => {
      const fetched = states.get(entry.number);
      if (
        fetched === undefined ||
        canonicalSessionPrUrl(fetched.url) !== canonicalSessionPrUrl(entry.url)
      ) {
        return entry;
      }
      const state = fetched.state ?? entry.state;
      const issues = fetched.issues ?? entry.issues;
      if (state === entry.state && sameIssues(issues, entry.issues)) {
        return entry;
      }
      changed += 1;
      return {
        ...entry,
        ...(state ? { state } : {}),
        ...(issues ? { issues } : {}),
      };
    });
    if (changed === 0) return 0;
    await writeSessionPrs(filePath, next, options);
    return changed;
  });
}

/**
 * Moves a sidecar across archive states under the cross-process lock
 * covering BOTH endpoints, and serialized on both in-process queues. The
 * live shell binder runs in the session child process and may hold a
 * pending mutation on either path; a move whose read/write/unlink
 * interleaved with it would clobber the write and drop the binding.
 *
 * Same policy as the transition's ledger move: the sidecar is the
 * append-only binding history, so when both halves of a split pair exist
 * (a crash between the transcript rename and the sidecar move, or an
 * orphaned write) they are merged by PR number instead of wedging the pair
 * forever — no transition would ever reunite them otherwise.
 */
export function moveSessionPrSidecar(
  sourcePath: string,
  destinationPath: string,
  assertCanMutate?: () => void,
): Promise<void> {
  // An absent source has nothing to move: skip both locks — archive/restore
  // runs a move for EVERY session, and most never bound a PR.
  if (!existsSync(sourcePath)) return Promise.resolve();
  // Lock order is path-sorted so an opposite-direction move of the same
  // pair can never deadlock the file locks. The queue entry serializes with
  // same-process mutations of the first endpoint and runs under its lock
  // (enqueuePrMutation wraps the mutation in it); the second endpoint's
  // lock is acquired inside, which is also where same-process mutations of
  // THAT path serialize — on the file lock itself. The source is
  // re-checked under the locks: only a still-present file moves.
  const [first, second] =
    sourcePath <= destinationPath
      ? [sourcePath, destinationPath]
      : [destinationPath, sourcePath];
  return enqueuePrMutation(first, () =>
    withSidecarLock(second, async () => {
      if (!existsSync(sourcePath)) return;
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      if (!existsSync(destinationPath)) {
        assertCanMutate?.();
        await fs.rename(sourcePath, destinationPath);
        return;
      }
      const merged = mergeSessionPrLists(
        (await readSessionPrs(destinationPath)) ?? [],
        (await readSessionPrs(sourcePath)) ?? [],
      );
      if (merged.length > 0) {
        if (assertCanMutate) {
          await writeSessionPrs(destinationPath, merged, {
            assertCanCommit: assertCanMutate,
          });
        } else {
          await writeSessionPrs(destinationPath, merged);
        }
      }
      assertCanMutate?.();
      await fs.unlink(sourcePath);
    }),
  );
}

/**
 * Replace the sidecar with a precomputed list atomically with respect to
 * concurrent mutations: the planner runs inside the mutation queue against
 * the freshest list, so a plan-then-write cycle cannot clobber a binding
 * that lands between the caller's read and write. The planner returns the
 * replacement list, or null to leave the file untouched. Entries the
 * read-side shape check would reject are declined (dropped from the
 * write) the way the upserts decline them: the reader fails the WHOLE
 * list closed, so persisting one poisoned entry would erase every other
 * binding. Resolves with the persisted list, or null when nothing changed.
 */
export function replaceSessionPrs(
  filePath: string,
  plan: (existing: SessionPr[]) => SessionPr[] | null,
): Promise<SessionPr[] | null> {
  return enqueuePrMutation(filePath, async () => {
    const existing = (await readSessionPrs(filePath)) ?? [];
    const planned = plan(existing);
    if (planned === null) return null;
    const next = planned.filter(isValidSessionPr);
    // A plan made only of declined entries is not a removal: leave the
    // persisted bindings alone (an explicit empty plan still clears).
    if (next.length === 0 && planned.length > 0) return null;
    await writeSessionPrs(filePath, next);
    return next;
  });
}
