/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
// do.
const GH_PR_CREATE_SEGMENT_PATTERN =
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*gh(?:\.exe)?\s+pr\s+create\b/;
// The host must start with an alphanumeric so placeholder hosts never bind.
const GH_PR_CREATE_URL_PATTERN =
  /https?:\/\/[A-Za-z0-9][^\s"'<>)]*\/pull\/(\d+)/;

function commandRunsGhPrCreate(command: string): boolean {
  return command
    .split(/&&|\|\||[;|]/)
    .some((segment) => GH_PR_CREATE_SEGMENT_PATTERN.test(segment));
}

/**
 * Recognizes a `gh pr create` run from the shell tool: some command segment
 * executes the action and gh prints the new PR's URL on success. Failed or
 * `--dry-run` runs print no URL, which is the false-positive gate.
 */
export function detectGhPrCreateBinding(
  command: string,
  output: string,
): { number: number; url: string } | undefined {
  if (!commandRunsGhPrCreate(command)) return undefined;
  if (command.includes('--dry-run')) return undefined;
  const match = GH_PR_CREATE_URL_PATTERN.exec(output);
  if (!match) return undefined;
  // Summarized output elides owner/repo (`https://github.com/.../pull/N`);
  // such a URL is not a usable link target.
  if (match[0].includes('...')) return undefined;
  return { number: Number(match[1]), url: match[0] };
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
 * Insert or refresh a binding (matched by PR number) and persist the list,
 * keeping at most {@link SESSION_PR_LIST_LIMIT} latest entries. A re-bound
 * number moves to the end (latest) with a fresh createdAt. An omitted
 * `state` preserves the existing entry's state on re-bind.
 */
export function upsertSessionPr(
  filePath: string,
  pr: { number: number; url: string; state?: SessionPrState },
): Promise<SessionPr[]> {
  return enqueuePrMutation(filePath, async () => {
    const existing = (await readSessionPrs(filePath)) ?? [];
    const known = existing.find((entry) => entry.number === pr.number);
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
      },
    ].slice(-SESSION_PR_LIST_LIMIT);
    await writeSessionPrs(filePath, next);
    return next;
  });
}

/**
 * Rewrites bound PR states in place — order and createdAt are preserved, so
 * a refresh sweep never reshuffles the badge's "latest" entry. Returns null
 * when the sidecar is absent/invalid or nothing changed (no write then).
 */
export function updateSessionPrStates(
  filePath: string,
  states: ReadonlyMap<number, SessionPrState>,
): Promise<SessionPr[] | null> {
  return enqueuePrMutation(filePath, async () => {
    const existing = await readSessionPrs(filePath);
    if (!existing) return null;
    let changed = false;
    const next = existing.map((entry) => {
      const state = states.get(entry.number);
      if (state === undefined || state === entry.state) return entry;
      changed = true;
      return { ...entry, state };
    });
    if (!changed) return null;
    await writeSessionPrs(filePath, next);
    return next;
  });
}
