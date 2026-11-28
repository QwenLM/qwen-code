/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Descriptor-based comparisons also work where path stat and fd stat differ. */
import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isNodeError } from '../../utils/errors.js';
import type { TranscriptFileSnapshot } from './scanner.js';

export function sameTranscriptSnapshot(
  snapshot: TranscriptFileSnapshot,
  stat: Stats,
): boolean {
  return (
    snapshot.device === stat.dev &&
    snapshot.inode === stat.ino &&
    snapshot.size === stat.size &&
    snapshot.modifiedTimeMs === stat.mtimeMs &&
    (snapshot.changedTimeMs === undefined ||
      snapshot.changedTimeMs === stat.ctimeMs)
  );
}

/** 两个 descriptor 快照是否同一版本；任一侧缺少 ctime 时跳过 ctime 比较。 */
export function sameTranscriptSnapshots(
  left: TranscriptFileSnapshot,
  right: TranscriptFileSnapshot,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedTimeMs === right.modifiedTimeMs &&
    (left.changedTimeMs === undefined ||
      right.changedTimeMs === undefined ||
      left.changedTimeMs === right.changedTimeMs)
  );
}

/** Undefined is the expected state of a new, not-yet-created transcript. */
export async function matchesTranscriptSnapshot(
  filePath: string,
  snapshot: TranscriptFileSnapshot | undefined,
): Promise<boolean> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return !snapshot;
    throw error;
  }
  try {
    return (
      snapshot !== undefined &&
      sameTranscriptSnapshot(snapshot, await handle.stat())
    );
  } finally {
    await handle.close();
  }
}
