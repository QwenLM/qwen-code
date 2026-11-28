/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import { getConfigHomeDir } from '../config/sessions-config.js';

/**
 * Static, stateless session utilities with primitive / string inputs.
 *
 * Heavyweight read/list operations belong to {@link SessionManager} (and the
 * core-side compatibility catalog for legacy callers), not this file.
 */

/**
 * Returns true when `sessionId` is safe to use as a transcript file stem.
 *
 * Mirrors the filesystem guard previously exported from
 * `transcriptSessionService.ts`.
 */
export function isSafeSessionFileStem(sessionId: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) &&
    !sessionId.includes('..')
  );
}

/**
 * Returns true when `value` is a canonical UUID session id — the shape
 * required for newly created and forked session ids.
 */
export function isUuidSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/**
 * Returns true when `value` is a positive, base-10 numeric session index
 * (as accepted by `--resume <number>`).
 */
export function isNumericSessionIndex(value: string): boolean {
  const index = Number.parseInt(value, 10);
  return !Number.isNaN(index) && String(index) === value && index > 0;
}

/**
 * Returns the default transcript bucket directory for a project directory,
 * or the caller-supplied bucket override when one is provided.
 *
 * The default root follows the same resolution as the CLI's config home:
 * see {@link getConfigHomeDir}. The final layout is
 * `<configHomeDir>/projects/<sanitized-project-dir>`.
 */
export function resolveBucketDir(
  projectDir: string,
  bucketDir?: string,
): string {
  if (bucketDir) {
    return bucketDir;
  }
  return nodePath.join(
    getConfigHomeDir(),
    'projects',
    sanitizePath(projectDir),
  );
}

/**
 * Maximum length for a sanitized path component. Most filesystems (ext4,
 * APFS, NTFS) limit individual components to 255 bytes; leave room for the
 * hash suffix and separator appended when a path exceeds this length.
 */
export const MAX_SANITIZED_LENGTH = 200;

function djb2Hash(input: string): number {
  let hash = 5381;
  for (let index = 0; index < input.length; index++) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return hash;
}

/**
 * Makes a string safe for use as a directory or file name.
 * Replaces all non-alphanumeric characters with hyphens, preserving case.
 * For deeply nested paths that would exceed filesystem limits, truncates
 * and appends a short hash suffix for uniqueness.
 */
export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized;
  }
  const hash = Math.abs(djb2Hash(name)).toString(36);
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`;
}

/**
 * Reads and parses the first non-empty JSONL line from a transcript file.
 * Returns `null` when the file is empty or the first line is not valid JSON.
 */
export async function readFirstJsonlLine(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = await handle.readFile({ encoding: 'utf8' });
    const firstLine = buffer.split(/\r?\n/)[0];
    if (!firstLine) return null;
    return JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Returns true when the given error is a Node `ENOENT`.
 */
export function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
