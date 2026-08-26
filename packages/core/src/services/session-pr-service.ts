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
}

export type SessionPrState = 'open' | 'merged' | 'closed';

/**
 * Why a binding exists. The worktree slug/branch convention names the PR the
 * session EXISTS FOR; a gh-verified create names the PR the session CREATED;
 * a `/review` command names a PR it merely looked at.
 */
export type SessionPrSource = 'create' | 'worktree' | 'review';

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
 * Runtime shape check for one entry. The url is rendered as a link target,
 * so only http(s) URLs are accepted.
 */
function isValidSessionPr(value: unknown): value is SessionPr {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['number'] === 'number' &&
    Number.isInteger(v['number']) &&
    v['number'] > 0 &&
    typeof v['url'] === 'string' &&
    v['url'].length <= SESSION_PR_URL_MAX_LENGTH &&
    /^https?:\/\//i.test(v['url']) &&
    // The url is interpolated into a stderr audit line by the bridge —
    // control characters would forge log lines.
    !hasControlCharacter(v['url']) &&
    typeof v['createdAt'] === 'string' &&
    (v['state'] === undefined ||
      v['state'] === 'open' ||
      v['state'] === 'merged' ||
      v['state'] === 'closed') &&
    (v['source'] === undefined ||
      v['source'] === 'create' ||
      v['source'] === 'worktree' ||
      v['source'] === 'review')
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

// `gh pr create` must START a command segment: a search like
// `grep -rn 'gh pr create'` mentions the phrase as an argument and must not
// count, while `cd /w && gh pr create` or `FOO=bar gh pr create | tee log`
// do. Wrapper prefixes (sudo/env/nohup/command with up to two flags),
// path-qualified binaries (`/usr/bin/gh`, `~/bin/gh.cmd`) and the `pr new`
// alias are verified-real creation shapes; quote-awareness stays
// approximate because the shell-aware tokenizer lives in tools/shell.ts
// and cannot be imported here without pulling it into the serve bundle
// closure. This is only the execution gate — it cannot attribute a printed
// URL to gh's own run, so callers must verify the binding with gh itself
// before persisting it.
const GH_PR_CREATE_SEGMENT_PATTERN =
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:(?:sudo|env|nohup|command)\s+(?:-\S+(?:\s+\S+)?\s+|[A-Za-z_][A-Za-z0-9_]*=\S+\s+){0,3})?(?:[/~][^\s]*[/])?gh(?:\.exe|\.cmd|\.bat)?\s+pr\s+(?:create|new)\b/;

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
const GH_CREATE_WRAPPER_NAMES = new Set(['sudo', 'env', 'nohup', 'command']);
const GH_BINARY_PATTERN = /(?:^|[/\\])gh(?:\.exe|\.cmd|\.bat)?$/;

/**
 * Approximates the shell's own expansion so the verification legs
 * authenticate the way the create itself did: surrounding quotes are
 * syntax, and `$VAR`/`${VAR}` names the process environment the child
 * shell expands from (an absent variable expands to the empty string,
 * matching the shell). Single quotes suppress expansion in the shell too.
 * Command substitutions (`$(…)`) stay literal — they cannot be evaluated
 * here, and a wrong guess must not authenticate the legs.
 */
function expandInlineEnvValue(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  const unquoted =
    raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1)
      : raw;
  return unquoted.replace(
    /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
    (_match, name: string) => process.env[name] ?? '',
  );
}

/**
 * The inline `GH_*`/`GITHUB_*` credentials a `gh pr create` run carries
 * (e.g. `GH_TOKEN=… gh pr create --fill`). The gh legs that verify a
 * create must authenticate the same way the create itself did: with an
 * inline token and no ambient gh auth, a bare verification run errors and
 * the binding silently misses. Collection covers the shapes the execution
 * gate admits: the prefix assignments of EVERY gate-matching segment (later
 * segments win, so a non-creating gate-matching segment cannot shadow a
 * later segment's token; non-GH assignments are skipped, not terminators),
 * plus `export`-ed assignments anywhere in the command (`export GH_TOKEN=…;
 * gh pr create`). The prefix scan mirrors the gate's approximate grammar
 * (assignments, wrapper names, flags and their values) and stops at the gh
 * binary — assignments after it are gh arguments, not environment.
 */
export function ghPrCreateInlineEnv(
  command: string,
): Readonly<Record<string, string>> | undefined {
  let env: Record<string, string> | undefined;
  let sawGateSegment = false;
  const record = (name: string, rawValue: string): void => {
    (env ??= {})[name] = expandInlineEnvValue(rawValue);
  };
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = segment.trim().split(/\s+/);
    // `export GH_TOKEN=…` in ANY segment binds the variable for every
    // later segment of the command.
    if (tokens[0] === 'export') {
      for (let i = 1; i < tokens.length; i++) {
        const exported = GH_INLINE_ENV_ASSIGNMENT_PATTERN.exec(tokens[i]);
        if (exported !== null) {
          record(exported[1], exported[2]);
          continue;
        }
        // A non-GH assignment (`export FOO=bar GH_TOKEN=x`) exports both —
        // skip it; only a bare name (`export PATH`) cannot be evaluated.
        if (!tokens[i].includes('=')) break;
      }
    }
    if (!GH_PR_CREATE_SEGMENT_PATTERN.test(segment)) continue;
    sawGateSegment = true;
    let previousWasFlag = false;
    for (const token of tokens) {
      const assignment = GH_INLINE_ENV_ASSIGNMENT_PATTERN.exec(token);
      if (assignment !== null) {
        record(assignment[1], assignment[2]);
        previousWasFlag = false;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=\S+$/.test(token)) {
        // A non-GH assignment (`FOO=bar GH_TOKEN=x gh pr create`) — the
        // gate grammar admits it, so it must not end the scan.
        previousWasFlag = false;
        continue;
      }
      if (GH_BINARY_PATTERN.test(token)) break;
      if (GH_CREATE_WRAPPER_NAMES.has(token) || token.startsWith('-')) {
        previousWasFlag = token.startsWith('-');
        continue;
      }
      if (previousWasFlag) {
        // A flag's value (`sudo -u runner`), not the binary.
        previousWasFlag = false;
        continue;
      }
      break;
    }
  }
  return sawGateSegment ? env : undefined;
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
    if (!known || entry.createdAt >= known.createdAt) {
      byNumber.set(entry.number, entry);
    }
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
function sourceAuthority(source: SessionPrSource | undefined): number {
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
          sourceAuthority(list[a].source) - sourceAuthority(list[b].source) ||
          a - b,
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
  // the atomic rename swap never disturbs it — but the guarded path itself
  // must exist. An empty file still reads as "no bindings"
  // (readSessionPrs fails the JSON parse and returns null).
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const materialized = !existsSync(filePath);
  if (materialized) await fs.appendFile(filePath, '');
  const release = await lockfile.lock(filePath, LOCK_OPTIONS);
  try {
    return await run();
  } finally {
    // A mutation that writes nothing (every candidate already bound or
    // unresolved, a declined entry, an absent move source) must not leave
    // the file this lock materialized behind — sessions that never bind
    // a PR would otherwise accumulate stray empty sidecars. An empty file
    // is safe to remove under the lock: every successful writer leaves
    // content.
    if (materialized) {
      try {
        if ((await fs.stat(filePath)).size === 0) await fs.unlink(filePath);
      } catch {
        // Renamed away by a move — nothing to clean up.
      }
    }
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
 * Insert or refresh a binding (matched by PR number) and persist the list,
 * keeping at most {@link SESSION_PR_LIST_LIMIT} entries. A number re-bound
 * to a DIFFERENT url moves to the end (latest) with a fresh createdAt; a
 * same-url refresh rewrites the entry in place, preserving its position and
 * createdAt. An explicitly supplied `state` wins; an explicit `source` wins
 * only against a weaker-or-equal persisted one (a re-bind never downgrades
 * provenance). State never
 * crosses a URL change — the same number in another repository is another
 * PR, and inheriting a terminal 'merged' would poison the new binding
 * permanently (the sweep never re-queries merged entries).
 *
 * Entries the read-side shape check would reject are declined here: the
 * reader fails the WHOLE list closed, so persisting one poisoned entry would
 * erase every earlier binding until the next successful write.
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
    const known = existing.find((entry) => entry.number === pr.number);
    // An explicit source upgrades the entry (review → create) but never
    // DOWNGRADES it: the worktree convention binding names the PR the
    // session exists for, and a client-driven re-bind stamping 'create'
    // must not drop it into the rank the tail cap evicts first.
    const source =
      pr.source !== undefined &&
      sourceAuthority(pr.source) >= sourceAuthority(known?.source)
        ? pr.source
        : known?.source;
    const state =
      pr.state ?? (known && known.url === pr.url ? known.state : undefined);
    const entry: SessionPr = {
      number: pr.number,
      url: pr.url,
      createdAt:
        known && known.url === pr.url
          ? known.createdAt
          : new Date().toISOString(),
      ...(state ? { state } : {}),
      ...(source ? { source } : {}),
    };
    if (!isValidSessionPr(entry)) return existing;
    const next =
      known && known.url === pr.url
        ? existing.map((e) => (e.number === pr.number ? entry : e))
        : capSessionPrListByAuthority([
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
 * does — replace the entry, fresh createdAt, source-upgrade rule, no
 * state carry-over across the URL change. A candidate without a url is
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
      if (known && known.url === candidate.url) {
        if (
          candidate.source !== undefined &&
          sourceAuthority(candidate.source) > sourceAuthority(known.source)
        ) {
          next[knownIndex] = { ...known, source: candidate.source };
          changed = true;
        }
        alreadyBound.push(candidate.number);
        continue;
      }
      // A NEW entry always carries the candidate's source; a known
      // entry keeps the stronger one (a re-bind never downgrades
      // provenance).
      const source =
        known === undefined
          ? candidate.source
          : candidate.source !== undefined &&
              sourceAuthority(candidate.source) >= sourceAuthority(known.source)
            ? candidate.source
            : known.source;
      const entry: SessionPr = {
        number: candidate.number,
        url: candidate.url,
        createdAt: new Date().toISOString(),
        ...(candidate.state ? { state: candidate.state } : {}),
        ...(source ? { source } : {}),
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

/**
 * Rewrites bound PR states in place — order and createdAt are preserved, so
 * a refresh sweep never reshuffles the badge's "latest" entry. Each stamp
 * carries the URL the state was resolved under; an entry whose url no
 * longer matches was re-bound to another PR during the sweep's gh window
 * and is skipped — stamping by bare number across that window would write
 * the stale repo's state onto the new binding. Returns the number of
 * entries actually rewritten; 0 when the sidecar is absent/invalid or
 * nothing changed (no write then).
 */
export function updateSessionPrStates(
  filePath: string,
  states: ReadonlyMap<number, { url: string; state: SessionPrState }>,
): Promise<number> {
  return enqueuePrMutation(filePath, async () => {
    const existing = await readSessionPrs(filePath);
    if (!existing) return 0;
    let changed = 0;
    const next = existing.map((entry) => {
      const stamped = states.get(entry.number);
      if (
        stamped === undefined ||
        stamped.url !== entry.url ||
        stamped.state === entry.state
      ) {
        return entry;
      }
      changed += 1;
      return { ...entry, state: stamped.state };
    });
    if (changed === 0) return 0;
    await writeSessionPrs(filePath, next);
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
  // An absent source must not touch either endpoint: the lock
  // materializes its target before locking, so enqueueing a no-op move
  // would leave a stray empty sidecar at the destination — and
  // archive/restore runs one for EVERY session that never bound a PR.
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
