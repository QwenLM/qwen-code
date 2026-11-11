/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import {
  acquireFileLock,
  OUTLAST_STALE_LOCK_MS,
  type FileLock,
} from '../utils/fileLock.js';
import { runLogger } from '../utils/runLogger.js';
import { isNodeError } from '../utils/errors.js';

// Refresh locks are per identity; write locks coordinate same-name legacy entries.
export type McpOAuthLockPurpose = 'refresh' | 'write';

// Wait for a peer's network refresh without blocking for the full stale window.
const REFRESH_LOCK_WAIT_MS = 8_000;

/** Takes the lock, or rejects when it cannot. */
export function lockMcpOAuthCredential(
  purpose: McpOAuthLockPurpose,
  name: string,
): Promise<FileLock> {
  return acquireFileLock(
    lockPath(purpose, name),
    purpose === 'write' ? OUTLAST_STALE_LOCK_MS : REFRESH_LOCK_WAIT_MS,
  );
}

/** Upper-lock checks are best-effort; physical-file guards protect commit points. */
export async function withMcpOAuthCredentialLock<T>(
  purpose: McpOAuthLockPurpose,
  name: string,
  action: (assertHeld: () => void) => Promise<T>,
): Promise<T> {
  let lock: FileLock;
  try {
    lock = await lockMcpOAuthCredential(purpose, name);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ELOCKED') throw error;
    throw new Error(
      `MCP OAuth credentials of "${name}" are being changed by another process; try again`,
      { cause: error },
    );
  }
  try {
    return await action(lock.assertHeld);
  } finally {
    await lock.release().catch((error) => {
      runLogger.warn(
        `[mcp-oauth] ${purpose} lock for "${name}" could not be released`,
        error,
      );
    });
  }
}

function lockPath(purpose: McpOAuthLockPurpose, name: string): string {
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 16);
  // A directory of their own: nothing else there can be mistaken for a lock.
  return path.join(
    Storage.getGlobalConfigDir(),
    'mcp-oauth-locks',
    `${purpose}-${digest}`,
  );
}
