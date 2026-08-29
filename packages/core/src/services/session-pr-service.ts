/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
   * Issues the PR closes (GitHub's closing references), snapshotted by the
   * daemon timer — never bound by clients. Absent until the first refresh
   * after binding; an empty array means "fetched, none".
   */
  issues?: SessionPrIssue[];
}

export type SessionPrState = 'open' | 'merged' | 'closed';

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
 * Both PR and issue urls are rendered as link targets, so only http(s) URLs
 * are accepted. The url is also interpolated into a stderr audit line by the
 * bridge — control characters would forge log lines.
 */
function isValidBindingUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= SESSION_PR_URL_MAX_LENGTH &&
    /^https?:\/\//i.test(value) &&
    !hasControlCharacter(value)
  );
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
    if (!known || entry.createdAt >= known.createdAt) {
      byNumber.set(entry.number, entry);
    }
  }
  return [...byNumber.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-SESSION_PR_LIST_LIMIT);
}

// Serializes read-modify-write cycles per sidecar path: concurrent mutations
// for the same session must not interleave (read [] → read [] → write [A] →
// write [B] would silently drop A). A failed predecessor must not block
// later mutations.
const mutationQueue = new Map<string, Promise<unknown>>();

function enqueuePrMutation<T>(
  filePath: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = mutationQueue.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
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
 * keeping at most {@link SESSION_PR_LIST_LIMIT} latest entries. A re-bound
 * number moves to the end (latest) with a fresh createdAt. An omitted
 * `state` preserves the existing entry's state when the re-bind targets the
 * same PR (same canonical url) — a different repository's same-numbered PR
 * is a different PR and must not inherit its state. The issue snapshot is
 * kept on the same-PR condition: only the refresh sweep writes it.
 */
export function upsertSessionPr(
  filePath: string,
  pr: { number: number; url: string; state?: SessionPrState },
): Promise<SessionPr[]> {
  return enqueuePrMutation(filePath, async () => {
    const existing = (await readSessionPrs(filePath)) ?? [];
    const known = existing.find(
      (entry) =>
        entry.number === pr.number &&
        canonicalSessionPrUrl(entry.url) === canonicalSessionPrUrl(pr.url),
    );
    const rest = existing.filter((entry) => entry.number !== pr.number);
    const next = [
      ...rest,
      {
        number: pr.number,
        url: pr.url,
        createdAt: new Date().toISOString(),
        ...((pr.state ?? known?.state)
          ? { state: (pr.state ?? known?.state) as SessionPrState }
          : {}),
        ...(known?.issues ? { issues: known.issues } : {}),
      },
    ].slice(-SESSION_PR_LIST_LIMIT);
    await writeSessionPrs(filePath, next);
    return next;
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
 * Replace the sidecar with a precomputed list atomically with respect to
 * concurrent mutations: the planner runs inside the mutation queue against
 * the freshest list, so a plan-then-write cycle cannot clobber a binding
 * that lands between the caller's read and write. The planner returns the
 * replacement list, or null to leave the file untouched. Resolves with the
 * persisted list, or null when nothing changed.
 */
export function replaceSessionPrs(
  filePath: string,
  plan: (existing: SessionPr[]) => SessionPr[] | null,
): Promise<SessionPr[] | null> {
  return enqueuePrMutation(filePath, async () => {
    const existing = (await readSessionPrs(filePath)) ?? [];
    const next = plan(existing);
    if (next === null) return null;
    await writeSessionPrs(filePath, next);
    return next;
  });
}
