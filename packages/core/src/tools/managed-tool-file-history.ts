/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FileHistoryService,
  deserializeSnapshots,
  serializeSnapshot,
  type SerializedFileHistorySnapshot,
} from '../services/fileHistoryService.js';

export interface ManagedToolFileHistoryState {
  ownerSessionId: string;
  revision: number;
  snapshots: SerializedFileHistorySnapshot[];
}

function copySnapshots(
  snapshots: SerializedFileHistorySnapshot[],
): SerializedFileHistorySnapshot[] {
  return snapshots.map((snapshot) => ({
    promptId: snapshot.promptId,
    timestamp: snapshot.timestamp,
    trackedFileBackups: Object.fromEntries(
      Object.entries(snapshot.trackedFileBackups).map(([filePath, backup]) => {
        if (!Number.isSafeInteger(backup.version) || backup.version < 0) {
          throw new Error('Invalid managed file history backup version.');
        }
        return [
          filePath,
          {
            backupFileName: backup.backupFileName,
            version: backup.version,
            backupTime: backup.backupTime,
            ...(backup.failed ? { failed: true } : {}),
          },
        ];
      }),
    ),
  }));
}

export class ManagedToolFileHistory {
  readonly service: FileHistoryService;
  private readonly initialization: Promise<void>;
  private pending: Promise<void> = Promise.resolve();
  private readonly startedPrompts: Set<string>;
  private revision = 0;
  private snapshots: SerializedFileHistorySnapshot[];
  private snapshotJson: string;

  constructor(
    private readonly ownerSessionId: string,
    cwd: string,
    serializedSnapshots: SerializedFileHistorySnapshot[],
  ) {
    this.service = new FileHistoryService(ownerSessionId, true, cwd, () =>
      this.capture(),
    );
    this.service.restoreFromSnapshots(
      deserializeSnapshots(copySnapshots(serializedSnapshots)),
    );
    this.snapshots = this.readSnapshots();
    this.snapshotJson = JSON.stringify(this.snapshots);
    this.startedPrompts = new Set(
      this.snapshots.map(({ promptId }) => promptId),
    );
    this.initialization = this.service.validateRestoredSnapshots();
    void this.initialization.catch(() => {});
  }

  ready(): Promise<void> {
    return this.initialization;
  }

  state(): ManagedToolFileHistoryState {
    return {
      ownerSessionId: this.ownerSessionId,
      revision: this.revision,
      snapshots: structuredClone(this.snapshots),
    };
  }

  checkpoint(promptId: string): Promise<void> {
    return this.run(async () => {
      if (this.service.getSnapshots().at(-1)?.promptId === promptId) return;
      if (this.startedPrompts.has(promptId)) {
        throw new Error('Managed file history cannot reopen an earlier turn.');
      }
      await this.service.makeSnapshot(promptId);
      this.startedPrompts.add(promptId);
    });
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => {
      await this.initialization;
      try {
        return await operation();
      } finally {
        this.capture();
      }
    });
    this.pending = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async drain(): Promise<void> {
    const pending = this.pending;
    await this.initialization;
    await pending;
  }

  private readSnapshots(): SerializedFileHistorySnapshot[] {
    return copySnapshots(this.service.getSnapshots().map(serializeSnapshot));
  }

  private capture(): void {
    const snapshots = this.readSnapshots();
    const snapshotJson = JSON.stringify(snapshots);
    if (snapshotJson === this.snapshotJson) return;
    this.snapshots = snapshots;
    this.snapshotJson = snapshotJson;
    this.revision++;
  }
}
