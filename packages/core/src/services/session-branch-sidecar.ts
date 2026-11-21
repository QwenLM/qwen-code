/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomicFileWrite.js';

/**
 * The immutable start commit recorded when a session is branched from a
 * checkpoint (persist-only, no live entry at branch time). The change
 * overview's commit fallback scopes its window to `<baseCommit>..HEAD`; a
 * checkpoint-branch session is created by restore, not by spawn, so it cannot
 * capture the start commit in memory at creation — the branch point is
 * persisted here and re-applied when the session is restored.
 */
export interface SessionBranchSidecar {
  version: 1;
  baseCommit: string;
}

export const SESSION_BRANCH_SIDECAR_SUFFIX = '.branch.json';

export function sessionBranchSidecarPath(
  chatsDir: string,
  sessionId: string,
): string {
  return path.join(chatsDir, `${sessionId}${SESSION_BRANCH_SIDECAR_SUFFIX}`);
}

export function readSessionBranchSidecar(
  filePath: string,
): SessionBranchSidecar | undefined {
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
  const baseCommit =
    typeof record['baseCommit'] === 'string' ? record['baseCommit'].trim() : '';
  if (record['version'] !== 1 || baseCommit.length === 0) return undefined;
  return { version: 1, baseCommit };
}

/**
 * Persists the branch point next to the transcript. Best-effort: a committed
 * fork must not turn into a 500 because the sidecar cannot be written, so
 * callers get a boolean instead of an exception.
 */
export function writeSessionBranchSidecar(
  filePath: string,
  baseCommit: string,
): boolean {
  const normalized = baseCommit.trim();
  if (normalized.length === 0) return false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFileSync(
      filePath,
      `${JSON.stringify(
        { version: 1, baseCommit: normalized } satisfies SessionBranchSidecar,
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

export function removeSessionBranchSidecar(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup; the transcript is already gone.
  }
}

/**
 * Moves a branch sidecar across archive states. A missing source is a no-op
 * because only checkpoint-branch sessions carry one.
 */
export function moveSessionBranchSidecar(from: string, to: string): void {
  if (!fs.existsSync(from)) return;
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}
