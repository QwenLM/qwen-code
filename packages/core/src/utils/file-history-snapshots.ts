/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'node:path';
import type {
  FileHistorySnapshot,
  SerializedFileHistorySnapshot,
} from '../services/fileHistoryService.js';

export function removeFileHistorySnapshots<
  T extends FileHistorySnapshot | SerializedFileHistorySnapshot,
>(snapshots: readonly T[], removedPromptIds: ReadonlySet<string>): T[] {
  return snapshots.flatMap((snapshot, index) => {
    if (removedPromptIds.has(snapshot.promptId)) return [];
    const next = snapshots[index + 1];
    // Keep the original diff endpoint, never a deleted turn's rewind identity.
    if (
      !snapshot.diffAfterBackups &&
      next &&
      removedPromptIds.has(next.promptId)
    ) {
      // Folding a deleted snapshot's backups into a survivor from another
      // working directory would hide their origin: rewind resolves those
      // backups through first-version fallback and expands their keys
      // against the survivor's root, silently writing foreign captures into
      // unrelated files. Drop the fold whenever the deleted snapshot is
      // cwd-labeled and the survivor cannot prove the same root (a labeled
      // survivor with a different root, or an unlabeled legacy survivor).
      // Unlabeled (legacy) deleted data keeps folding as before.
      const sameRootProven =
        next.cwd === undefined ||
        (snapshot.cwd !== undefined &&
          resolve(snapshot.cwd) === resolve(next.cwd));
      return [
        sameRootProven
          ? { ...snapshot, diffAfterBackups: next.trackedFileBackups }
          : snapshot,
      ];
    }
    return [snapshot];
  });
}
