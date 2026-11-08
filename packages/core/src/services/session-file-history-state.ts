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

/**
 * The shared record/array gate for `file_history_snapshot` records: returns
 * the payload only when the record is a system record of that subtype whose
 * payload carries a snapshots array. Deserialization, error tolerance and
 * per-entry validation stay with each consumer — the accumulator propagates
 * a throw, the fork remap falls back to the original payload, and the
 * collectors skip what they cannot read.
 */
export function readFileHistorySnapshotPayload(
  record: Pick<ChatRecord, 'type' | 'subtype' | 'systemPayload'>,
): FileHistorySnapshotRecordPayload | undefined {
  if (
    record.type !== 'system' ||
    record.subtype !== 'file_history_snapshot' ||
    !record.systemPayload
  ) {
    return undefined;
  }
  const payload = record.systemPayload as FileHistorySnapshotRecordPayload;
  return Array.isArray(payload.snapshots) ? payload : undefined;
}

export class SessionFileHistoryAccumulator {
  private readonly seenPromptIds = new Set<string>();
  private readonly retainedPromptIds: string[] = [];
  private readonly snapshotsByPromptId = new Map<string, FileHistorySnapshot>();

  add(record: Pick<ChatRecord, 'type' | 'subtype' | 'systemPayload'>): void {
    const payload = readFileHistorySnapshotPayload(record);
    if (!payload) return;
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
