/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
    return [
      !snapshot.diffAfterBackups && next && removedPromptIds.has(next.promptId)
        ? { ...snapshot, diffAfterBackups: next.trackedFileBackups }
        : snapshot,
    ];
  });
}
