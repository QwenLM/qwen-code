/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Opaque resume token for `readText` byte-cursor paging.
 *
 * Unsigned `base64url(JSON)`, matching `encodeOrganizedCursor` in
 * `server/session-list.ts`. Deliberately *not* the HMAC-signed scheme used by
 * `session-transcript-reader.ts`: that cursor addresses a persisted session
 * file the caller names only indirectly, whereas here the path is re-resolved
 * through the workspace boundary on every request. A forged cursor can
 * therefore only move the byte offset within a file the caller is already
 * authorised to read — precisely what `GET /file/bytes?offset=` already allows
 * — so signing would buy a key schedule and no boundary.
 *
 * What the payload *is* for is staleness: `{dev, ino}` catches a replaced file
 * and `size` catches a truncated one, turning a stale cursor into a typed
 * error instead of bytes from the wrong place.
 */

import { FsError } from './errors.js';

const CURSOR_VERSION = 1;

/**
 * A well-formed cursor is ~120 bytes of base64url. The cap exists so a
 * hostile client cannot make us parse megabytes before rejecting.
 */
export const MAX_TEXT_CURSOR_CHARS = 1024;

export interface TextCursorState {
  /** Byte offset the next page starts at. */
  off: number;
  /** File size when the cursor was minted, for shrink detection. */
  size: number;
  /** Device and inode as decimal strings — `Stats` fields may be `bigint`. */
  dev: string;
  ino: string;
}

export function encodeTextCursor(state: TextCursorState): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, ...state }),
    'utf8',
  ).toString('base64url');
}

/**
 * Decode a client-supplied cursor. Shape problems are the client's fault
 * (`parse_error`); a cursor that decodes but no longer matches the file is a
 * concurrency problem (`hash_mismatch`), and that distinction is checked by
 * {@link assertCursorMatchesFile} once the file has been opened.
 */
export function decodeTextCursor(cursor: string): TextCursorState {
  if (cursor.length === 0 || cursor.length > MAX_TEXT_CURSOR_CHARS) {
    throw new FsError(
      'parse_error',
      `cursor must be a non-empty string of at most ${MAX_TEXT_CURSOR_CHARS} characters`,
      { hint: 'pass a cursor returned by a previous read' },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new FsError('parse_error', 'cursor is not a valid read cursor', {
      hint: 'pass a cursor returned by a previous read',
    });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new FsError('parse_error', 'cursor is not a valid read cursor', {
      hint: 'pass a cursor returned by a previous read',
    });
  }
  const raw = parsed as Record<string, unknown>;
  const off = raw['off'];
  const size = raw['size'];
  const dev = raw['dev'];
  const ino = raw['ino'];
  if (
    raw['v'] !== CURSOR_VERSION ||
    !Number.isSafeInteger(off) ||
    (off as number) < 0 ||
    !Number.isSafeInteger(size) ||
    (size as number) < 0 ||
    typeof dev !== 'string' ||
    typeof ino !== 'string'
  ) {
    throw new FsError('parse_error', 'cursor is not a valid read cursor', {
      hint: 'pass a cursor returned by a previous read',
    });
  }
  return { off: off as number, size: size as number, dev, ino };
}

/**
 * Reject a cursor known stale through replacement or shrinkage.
 *
 * Growth is fine and is the point: appending to a log does not move the lines
 * an outstanding cursor points at. Shrinking is not — the offset may now land
 * mid-line or past the end, and the bytes there are not the ones the client
 * was reading.
 *
 * Residual: a same-inode rewrite that keeps or grows the file, or a
 * delete-and-recreate that reuses the inode, passes both checks. `mtimeMs`
 * cannot close that gap because both those cases and a valid append advance
 * it; hashing the prefix would make every page O(n), defeating the cursor.
 */
export function assertCursorMatchesFile(
  cursor: TextCursorState,
  stats: { dev: number | bigint; ino: number | bigint; size: number },
  path: string,
): void {
  if (
    String(stats.dev) !== cursor.dev ||
    String(stats.ino) !== cursor.ino ||
    stats.size < cursor.size
  ) {
    throw new FsError(
      'hash_mismatch',
      `cursor no longer matches the file it was issued for: ${path}`,
      { hint: 're-read the file from the beginning to get a fresh cursor' },
    );
  }
}
