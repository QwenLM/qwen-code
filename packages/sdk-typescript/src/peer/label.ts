/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Names, as sessions display and type them.
 *
 * Every name and directory in the registry was written by the process it
 * describes and ends up in listings, tool output and error messages. So it
 * is flattened to one line — control, format and bidirectional characters
 * collapsed to a space — and bounded, before anything shows it.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

/**
 * Control and format characters, and the line and paragraph separators —
 * matched by Unicode category rather than by a list of ranges, so blocks
 * nobody thought to list (tag characters, the Mongolian vowel separator,
 * interlinear annotation marks) are covered along with zero-width spaces
 * and bidi overrides.
 */
const INVISIBLE_RUN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

const ELLIPSIS = '…';

/** Longest flattened label kept anywhere a sender names itself. */
export const MAX_LABEL_CHARS = 200;

/** Longest name a record keeps: it is printed in a fixed-width column. */
export const MAX_SESSION_NAME_CHARS = 40;

/**
 * One line of printable text, at most {@link MAX_LABEL_CHARS} code points.
 * Counted in code points so the cut never leaves half of an astral
 * character behind.
 */
export function flattenPeerLabel(value: string): string {
  const oneLine = value.replace(INVISIBLE_RUN, ' ').trim();
  const points = Array.from(oneLine);
  return points.length > MAX_LABEL_CHARS
    ? `${points.slice(0, MAX_LABEL_CHARS - 1).join('')}${ELLIPSIS}`
    : oneLine;
}

/**
 * The name a record stores: flattened, then cut to
 * {@link MAX_SESSION_NAME_CHARS} code points. Counted in code points so an
 * astral character at the boundary is never split into a lone surrogate.
 */
export function boundSessionName(name: string): string {
  const points = Array.from(flattenPeerLabel(name));
  return points.length > MAX_SESSION_NAME_CHARS
    ? `${points.slice(0, MAX_SESSION_NAME_CHARS - 1).join('')}${ELLIPSIS}`
    : points.join('');
}

/**
 * Six hex characters of `sha256(sessionId)`: the handle that tells two
 * sessions of the same name apart. Derived rather than random, so a session
 * prints the same one every time it is listed.
 */
export function peerRef(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 6);
}

/**
 * A readable default name: the directory's basename plus two hex characters
 * of the session id, since two sessions in one directory is the common case.
 */
export function deriveSessionName(cwd: string, sessionId: string): string {
  const base = Array.from(
    path
      .basename(cwd)
      .normalize('NFC')
      .replace(/[^\p{L}\p{M}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, ''),
  )
    .slice(0, 32)
    .join('');
  const suffix = createHash('sha256')
    .update(sessionId)
    .digest('hex')
    .slice(0, 2);
  return `${base || 'session'}-${suffix}`;
}
