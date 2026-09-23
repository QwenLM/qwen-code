/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatRecord,
  FileHistorySnapshotRecordPayload,
} from './chatRecordingService.js';
import {
  deserializeSnapshots,
  MAX_SNAPSHOTS,
  type FileHistorySnapshot,
} from './fileHistoryService.js';

export class SessionFileHistoryAccumulator {
  private readonly seenPromptIds = new Set<string>();
  private readonly retainedPromptIds: string[] = [];
  private readonly snapshotsByPromptId = new Map<string, FileHistorySnapshot>();

  add(record: Pick<ChatRecord, 'type' | 'subtype' | 'systemPayload'>): void {
    if (
      record.type !== 'system' ||
      record.subtype !== 'file_history_snapshot' ||
      !record.systemPayload
    ) {
      return;
    }
    const payload = record.systemPayload as FileHistorySnapshotRecordPayload;
    if (!Array.isArray(payload.snapshots)) return;
    const deserialized = deserializeSnapshots(payload.snapshots);
    for (const snapshot of deserialized) {
      if (this.seenPromptIds.has(snapshot.promptId)) {
        if (this.snapshotsByPromptId.has(snapshot.promptId)) {
          this.snapshotsByPromptId.set(snapshot.promptId, snapshot);
        }
        continue;
      }
      this.seenPromptIds.add(snapshot.promptId);
      this.retainedPromptIds.push(snapshot.promptId);
      this.snapshotsByPromptId.set(snapshot.promptId, snapshot);
      if (this.retainedPromptIds.length > MAX_SNAPSHOTS) {
        const evictedPromptId = this.retainedPromptIds.shift()!;
        this.snapshotsByPromptId.delete(evictedPromptId);
      }
    }
  }

  finish(): FileHistorySnapshot[] | undefined {
    const snapshots = this.retainedPromptIds.map(
      (promptId) => this.snapshotsByPromptId.get(promptId)!,
    );
    return snapshots.length > 0 ? snapshots : undefined;
  }
}
