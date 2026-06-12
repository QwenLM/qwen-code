/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ForkRecord } from './forkTranscript.js';
import { isValidSessionId } from './chatsPath.js';
import { parentOf } from './lineage.js';

/** One node in a flat workspace session listing. */
export interface SessionListItem {
  sessionId: string;
  /** The fork parent, when this session is a fork. Omitted for a root. */
  parentSessionId?: string;
  /** Child session ids PRESENT in this listing that forked from this one. */
  forks: string[];
}

/** A whole `/rc/sessions` listing plus a partial-scan flag. */
export interface SessionListResult {
  sessions: SessionListItem[];
  /** True when the on-disk session count exceeded {@link MAX_LIST_SESSIONS}. */
  truncated: boolean;
}

/**
 * Hard cap on how many transcripts a single listing scan opens. Bounds an
 * OWNER endpoint a UI may poll: a workspace can accumulate arbitrarily many
 * dormant transcripts, and we open + first-line-read each one. Filenames are
 * sorted before the cap so it is STABLE across calls (the same prefix wins).
 */
export const MAX_LIST_SESSIONS = 500;

/** Default cap on bytes read while looking for a transcript's first newline. */
const DEFAULT_MAX_FIRST_LINE_BYTES = 1024 * 1024;

/**
 * Reads ONLY the first JSONL record of `<chatsDir>/<id>.jsonl` — the
 * `forkedFrom` source a listing needs — without pulling the whole (possibly
 * multi-MB) transcript into memory.
 *
 * Accumulates raw BYTES up to the first `\n` (or EOF, or `maxBytes`), then
 * decodes the range ONCE via `Buffer.concat` -> `toString('utf8')`, so a
 * multibyte char split across two `read()`s is never corrupted. Returns `null`
 * when the file is missing (ENOENT), empty, or the first line does not parse to
 * a JSON object (including a first line longer than `maxBytes`, which yields a
 * truncated prefix that fails `JSON.parse` -> `null` rather than a partial
 * record). Any non-ENOENT open/read error propagates to the caller.
 */
export async function readFirstRecord(
  chatsDir: string,
  id: string,
  opts: { maxBytes?: number } = {},
): Promise<ForkRecord | null> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FIRST_LINE_BYTES;
  let handle;
  try {
    handle = await open(join(chatsDir, `${id}.jsonl`), 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const buf = Buffer.allocUnsafe(64 * 1024);
    while (total < maxBytes) {
      const { bytesRead } = await handle.read(
        buf,
        0,
        Math.min(buf.length, maxBytes - total),
        null,
      );
      if (bytesRead === 0) break; // EOF before any newline
      const slice = buf.subarray(0, bytesRead);
      const nl = slice.indexOf(0x0a);
      if (nl !== -1) {
        // Copy the pre-newline bytes (the shared `buf` is reused next read).
        chunks.push(Buffer.from(slice.subarray(0, nl)));
        break;
      }
      chunks.push(Buffer.from(slice));
      total += bytesRead;
    }
    const line = Buffer.concat(chunks).toString('utf8').trim();
    if (!line) return null;
    try {
      const obj = JSON.parse(line) as unknown;
      return obj && typeof obj === 'object' ? (obj as ForkRecord) : null;
    } catch {
      return null;
    }
  } finally {
    await handle.close();
  }
}

/** A session id paired with its resolved fork parent (null = root). */
export interface SessionEntry {
  sessionId: string;
  parentSessionId: string | null;
}

/**
 * Pure: turn flat `{sessionId, parentSessionId}` entries into the listing —
 * nodes + the reverse `forks[]` index + a deterministic order. No disk.
 *
 * A child whose parent is NOT among the entries (orphan / deleted / beyond the
 * scan cap) still lists with its `parentSessionId`, but the missing parent is
 * never fabricated as a node and the child appears in no `forks[]`
 * (truncate-don't-fabricate, mirroring lineage). A self-referential
 * `forkedFrom` (`parentSessionId === sessionId`, only possible via a
 * hand-edited transcript) is treated as a root and never indexed.
 */
export function assembleListing(entries: SessionEntry[]): SessionListItem[] {
  const items = new Map<string, SessionListItem>();
  for (const e of entries) {
    if (items.has(e.sessionId)) continue;
    const isRoot =
      e.parentSessionId === null || e.parentSessionId === e.sessionId;
    items.set(e.sessionId, {
      sessionId: e.sessionId,
      ...(isRoot ? {} : { parentSessionId: e.parentSessionId as string }),
      forks: [],
    });
  }
  for (const e of entries) {
    if (e.parentSessionId === null || e.parentSessionId === e.sessionId) {
      continue;
    }
    const parent = items.get(e.parentSessionId);
    if (parent) parent.forks.push(e.sessionId);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  for (const item of items.values()) item.forks.sort(cmp);
  return [...items.values()].sort((a, b) => cmp(a.sessionId, b.sessionId));
}

/**
 * Scan a workspace chats dir into a fork-lineage listing. Mirrors the lineage
 * route's source of truth (each transcript's first-record
 * `forkedFrom.sessionId`), so `/rc/sessions` and `/rc/session/:id/lineage`
 * agree. A missing chats dir (ENOENT) is an empty listing, not an error.
 *
 * Filenames are filtered to syntactically valid `<id>.jsonl` (the same
 * path-traversal guard lineage uses), sorted lexically, then capped at
 * `opts.max` (`truncated` reports the overflow). An unreadable first line lists
 * the session as a root rather than dropping it.
 */
export async function listSessions(
  chatsDir: string,
  opts: { max?: number } = {},
): Promise<SessionListResult> {
  const max = opts.max ?? MAX_LIST_SESSIONS;

  let files: string[];
  try {
    files = await readdir(chatsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { sessions: [], truncated: false };
    }
    throw err;
  }

  const ids = files
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .filter((id) => isValidSessionId(id))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const truncated = ids.length > max;
  const capped = truncated ? ids.slice(0, max) : ids;

  const entries: SessionEntry[] = [];
  for (const id of capped) {
    let parent: string | null;
    try {
      const first = await readFirstRecord(chatsDir, id);
      parent = parentOf(first ? [first] : null);
    } catch {
      // Unreadable first line (e.g. EACCES) -> list it as a root, don't drop.
      parent = null;
    }
    entries.push({ sessionId: id, parentSessionId: parent });
  }

  return { sessions: assembleListing(entries), truncated };
}
