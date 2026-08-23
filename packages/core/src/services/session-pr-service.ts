/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

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
}

export type SessionPrState = 'open' | 'merged' | 'closed';

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
      v['state'] === 'closed')
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
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJSON(filePath, { prs } satisfies SessionPrList);
}

// `gh pr create` must START a command segment: a search like
// `grep -rn 'gh pr create'` mentions the phrase as an argument and must not
// count, while `cd /w && gh pr create` or `FOO=bar gh pr create | tee log`
// do. This is only the execution gate — it cannot attribute any printed URL
// to gh's own run, so callers must verify the binding with gh itself before
// persisting it.
const GH_PR_CREATE_SEGMENT_PATTERN =
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*gh(?:\.exe)?\s+pr\s+create\b/;

export function commandRunsGhPrCreate(command: string): boolean {
  return command
    .split(/&&|\|\||[;|]/)
    .some((segment) => GH_PR_CREATE_SEGMENT_PATTERN.test(segment));
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
  return [...byNumber.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-SESSION_PR_LIST_LIMIT);
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
  await fs.appendFile(filePath, '');
  const release = await lockfile.lock(filePath, LOCK_OPTIONS);
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
 * Insert or refresh a binding (matched by PR number) and persist the list,
 * keeping at most {@link SESSION_PR_LIST_LIMIT} latest entries. A re-bound
 * number moves to the end (latest) with a fresh createdAt. An omitted
 * `state` preserves the existing entry's state on re-bind.
 *
 * Entries the read-side shape check would reject are declined here: the
 * reader fails the WHOLE list closed, so persisting one poisoned entry would
 * erase every earlier binding until the next successful write.
 */
export function upsertSessionPr(
  filePath: string,
  pr: { number: number; url: string; state?: SessionPrState },
): Promise<SessionPr[]> {
  return enqueuePrMutation(filePath, async () => {
    const existing = (await readSessionPrs(filePath)) ?? [];
    const known = existing.find((entry) => entry.number === pr.number);
    const entry: SessionPr = {
      number: pr.number,
      url: pr.url,
      createdAt: new Date().toISOString(),
      ...((pr.state ?? known?.state)
        ? { state: (pr.state ?? known?.state) as SessionPrState }
        : {}),
    };
    if (!isValidSessionPr(entry)) return existing;
    const rest = existing.filter((e) => e.number !== pr.number);
    const next = [...rest, entry].slice(-SESSION_PR_LIST_LIMIT);
    await writeSessionPrs(filePath, next);
    return next;
  });
}

/** One locked read-modify-write for several candidate bindings at once. */
export interface SessionPrUpsertManyResult {
  /** The persisted list after the mutation. */
  prs: SessionPr[];
  /** Candidate numbers newly appended and present in `prs`. */
  added: readonly number[];
  /** Candidate numbers already present — left untouched. */
  alreadyBound: readonly number[];
  /** Candidate numbers with no url that were not already bound. */
  unresolved: readonly number[];
}

/**
 * Applies a run's candidate bindings in ONE locked read-modify-write.
 * Candidates are given in ascending authority order (later entries outrank
 * earlier ones under the tail cap). A number already present keeps its entry
 * untouched — a re-bind would move it to the tail with a fresh createdAt,
 * falsifying the binding-time order the badge and tooltip render by. A
 * candidate without a url is reported `unresolved` (unless already bound).
 * New candidates append with a fresh createdAt; the capped list is written
 * once, so the write cannot cascade and a failure cannot strand a partial
 * result. The read inside the lock sees bindings concurrent writers land
 * before this mutation.
 */
export function upsertSessionPrs(
  filePath: string,
  candidates: ReadonlyArray<{
    number: number;
    url?: string;
    state?: SessionPrState;
  }>,
): Promise<SessionPrUpsertManyResult> {
  return enqueuePrMutation(filePath, async () => {
    const existing = (await readSessionPrs(filePath)) ?? [];
    const existingNumbers = new Set(existing.map((entry) => entry.number));
    const next = [...existing];
    const appended = new Set<number>();
    const alreadyBound: number[] = [];
    const unresolved: number[] = [];
    for (const candidate of candidates) {
      if (existingNumbers.has(candidate.number)) {
        alreadyBound.push(candidate.number);
        continue;
      }
      if (candidate.url === undefined) {
        unresolved.push(candidate.number);
        continue;
      }
      const entry: SessionPr = {
        number: candidate.number,
        url: candidate.url,
        createdAt: new Date().toISOString(),
        ...(candidate.state ? { state: candidate.state } : {}),
      };
      if (!isValidSessionPr(entry)) {
        unresolved.push(candidate.number);
        continue;
      }
      existingNumbers.add(candidate.number);
      appended.add(candidate.number);
      next.push(entry);
    }
    if (appended.size === 0) {
      return { prs: existing, added: [], alreadyBound, unresolved };
    }
    const prs = next.slice(-SESSION_PR_LIST_LIMIT);
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
 * a refresh sweep never reshuffles the badge's "latest" entry. Returns the
 * number of entries actually rewritten; 0 when the sidecar is absent/invalid
 * or nothing changed (no write then).
 */
export function updateSessionPrStates(
  filePath: string,
  states: ReadonlyMap<number, SessionPrState>,
): Promise<number> {
  return enqueuePrMutation(filePath, async () => {
    const existing = await readSessionPrs(filePath);
    if (!existing) return 0;
    let changed = 0;
    const next = existing.map((entry) => {
      const state = states.get(entry.number);
      if (state === undefined || state === entry.state) return entry;
      changed += 1;
      return { ...entry, state };
    });
    if (changed === 0) return 0;
    await writeSessionPrs(filePath, next);
    return changed;
  });
}
