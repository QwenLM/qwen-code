/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomicFileWrite.js';

/**
 * Where a persisted display name came from. `prompt` is derived from the
 * session's first user prompt and only exists so a transcript that loses its
 * head keeps a label; it is not a custom title.
 */
export type SessionTitleSidecarSource = 'manual' | 'auto' | 'prompt';

export interface SessionTitleSidecar {
  version: 1;
  displayName: string;
  source: SessionTitleSidecarSource;
  updatedAt: string;
}

export const SESSION_TITLE_SIDECAR_SUFFIX = '.title.json';

/** Matches the cap `PATCH /session/:id/metadata` applies to display names. */
const MAX_DISPLAY_NAME_CHARS = 256;

/**
 * The list reader's prompt policy: at most 200 code points, then an ellipsis.
 * Shared by every writer so the sidecar never stores a string the list would
 * have rendered differently (UTF-16 `slice` could also split a surrogate pair).
 */
export function truncateTitleForList(
  text: string,
  maxCodePoints = 200,
): string {
  const codePoints: string[] = [];
  for (const codePoint of text) {
    if (codePoints.length === maxCodePoints) {
      return `${codePoints.join('')}...`;
    }
    codePoints.push(codePoint);
  }
  return text;
}

/** Hard cap without an ellipsis, counted in code points so no pair splits. */
function truncateCodePoints(text: string, maxCodePoints: number): string {
  const codePoints = Array.from(text);
  return codePoints.length <= maxCodePoints
    ? text
    : codePoints.slice(0, maxCodePoints).join('');
}

export function sessionTitleSidecarPath(
  chatsDir: string,
  sessionId: string,
): string {
  return path.join(chatsDir, `${sessionId}${SESSION_TITLE_SIDECAR_SUFFIX}`);
}

export function readSessionTitleSidecar(
  filePath: string,
): SessionTitleSidecar | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const displayName =
    typeof record['displayName'] === 'string'
      ? record['displayName'].trim()
      : '';
  const source = record['source'];
  if (
    record['version'] !== 1 ||
    displayName.length === 0 ||
    Array.from(displayName).length > MAX_DISPLAY_NAME_CHARS ||
    (source !== 'manual' && source !== 'auto' && source !== 'prompt')
  ) {
    return undefined;
  }
  const updatedAt =
    typeof record['updatedAt'] === 'string' ? record['updatedAt'] : '';
  return {
    version: 1,
    displayName,
    source,
    updatedAt,
  };
}

/**
 * Persists the session's current display name next to the transcript.
 * Best-effort: a session must keep working when the sidecar cannot be
 * written, so callers get a boolean instead of an exception.
 */
export function writeSessionTitleSidecar(
  filePath: string,
  displayName: string,
  source: SessionTitleSidecarSource,
): boolean {
  const normalized = truncateCodePoints(
    displayName.trim(),
    MAX_DISPLAY_NAME_CHARS,
  );
  if (normalized.length === 0) return false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(
      filePath,
      `${JSON.stringify(
        {
          version: 1,
          displayName: normalized,
          source,
          updatedAt: new Date().toISOString(),
        } satisfies SessionTitleSidecar,
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
}

export function removeSessionTitleSidecar(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup; the transcript is already gone.
  }
}

/**
 * Moves a title sidecar across archive states. A missing source is a no-op
 * because most sessions never get an explicit title.
 */
export function moveSessionTitleSidecar(from: string, to: string): void {
  if (!fs.existsSync(from)) return;
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}
