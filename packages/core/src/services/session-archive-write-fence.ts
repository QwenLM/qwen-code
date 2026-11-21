/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { atomicWriteFileSync } from '../utils/atomicFileWrite.js';
import {
  SessionTranscriptChangedError,
  SessionWriterLostError,
} from './session-writer-lease.js';

interface ArchiveWriteLock {
  assertHeld(): void;
  release(): Promise<void>;
}

function generationPath(activeTranscript: string): string {
  return `${activeTranscript}.archive-generation`;
}

function lockOptions(onCompromised: () => void): lockfile.LockOptions {
  return { realpath: false, stale: 60_000, onCompromised };
}

/**
 * Short storage mutation lock, not an exclusive lifetime writer lease.
 * Legacy recorders and archive maintenance keep their existing independent
 * ownership rules, but must agree about when the active pathname can move.
 */
export async function acquireSessionArchiveWriteLock(
  activeTranscript: string,
): Promise<ArchiveWriteLock> {
  let compromised = false;
  const release = await lockfile.lock(generationPath(activeTranscript), {
    ...lockOptions(() => {
      compromised = true;
    }),
    retries: { retries: 8, factor: 2, minTimeout: 5, maxTimeout: 100 },
  });
  return {
    assertHeld() {
      if (compromised) throw new SessionWriterLostError();
    },
    async release() {
      // A compromised lock is already released by proper-lockfile.
      if (!compromised) await release().catch(() => {});
    },
  };
}

/** For the existing synchronous empty-file initialization and title seed. */
export function withSessionArchiveWriteLockSync<T>(
  activeTranscript: string,
  mutate: () => T,
): T {
  const release = lockfile.lockSync(
    generationPath(activeTranscript),
    lockOptions(() => {}),
  );
  try {
    return mutate();
  } finally {
    release();
  }
}

export function readSessionArchiveGeneration(
  activeTranscript: string,
): string | undefined {
  try {
    return fs.readFileSync(generationPath(activeTranscript), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

/**
 * Publish a new epoch before moving/removing either copy. An old recorder
 * must remain fenced after unarchive brings the same inode back, or after
 * deletion removes the archived copy. A failed move may revoke old writers
 * but cannot restore their authority accidentally.
 */
export function advanceSessionArchiveGeneration(
  activeTranscript: string,
): void {
  atomicWriteFileSync(generationPath(activeTranscript), randomUUID(), {
    mode: 0o600,
    noFollow: true,
  });
}

export function assertSessionArchiveGeneration(
  activeTranscript: string,
  generation: string | undefined,
): void {
  if (readSessionArchiveGeneration(activeTranscript) !== generation) {
    throw new SessionTranscriptChangedError();
  }
  // Also fence snapshots archived before generations were introduced.
  try {
    fs.statSync(
      path.join(
        path.dirname(activeTranscript),
        'archive',
        path.basename(activeTranscript),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new SessionTranscriptChangedError();
}
