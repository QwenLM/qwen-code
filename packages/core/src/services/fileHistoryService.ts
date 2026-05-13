/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { diffLines } from 'diff';
import { Storage } from '../config/storage.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('FILE_HISTORY');

type BackupFileName = string | null;

export interface FileHistoryBackup {
  backupFileName: BackupFileName;
  version: number;
  backupTime: Date;
}

export interface FileHistorySnapshot {
  promptId: string;
  trackedFileBackups: Record<string, FileHistoryBackup>;
  timestamp: Date;
}

export interface FileHistoryState {
  snapshots: FileHistorySnapshot[];
  trackedFiles: Set<string>;
}

export interface DiffStats {
  filesChanged?: string[];
  insertions: number;
  deletions: number;
}

export interface RewindResult {
  filesChanged: string[];
  filesFailed: string[];
}

const MAX_SNAPSHOTS = 100;
const FILE_HISTORY_DIR = 'file-history';

function isENOENT(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code: string }).code === 'ENOENT'
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function getBackupFileName(filePath: string, version: number): string {
  const fileNameHash = createHash('sha256')
    .update(filePath)
    .digest('hex')
    .slice(0, 16);
  return `${fileNameHash}@v${version}`;
}

function resolveBackupPath(backupFileName: string, sessionId: string): string {
  return join(
    Storage.getGlobalQwenDir(),
    FILE_HISTORY_DIR,
    sessionId,
    backupFileName,
  );
}

async function createBackup(
  filePath: string | null,
  version: number,
  sessionId: string,
): Promise<FileHistoryBackup> {
  if (filePath === null) {
    return { backupFileName: null, version, backupTime: new Date() };
  }

  const backupFileName = getBackupFileName(filePath, version);
  const backupPath = resolveBackupPath(backupFileName, sessionId);

  let srcStats: Stats;
  try {
    srcStats = await stat(filePath);
  } catch (e: unknown) {
    if (isENOENT(e)) {
      return { backupFileName: null, version, backupTime: new Date() };
    }
    throw e;
  }

  try {
    await copyFile(filePath, backupPath);
  } catch (e: unknown) {
    if (!isENOENT(e)) throw e;
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(filePath, backupPath);
  }

  await chmod(backupPath, srcStats.mode);

  return { backupFileName, version, backupTime: new Date() };
}

async function restoreBackup(
  filePath: string,
  backupFileName: string,
  sessionId: string,
): Promise<boolean> {
  const backupPath = resolveBackupPath(backupFileName, sessionId);

  let backupStats: Stats;
  try {
    backupStats = await stat(backupPath);
  } catch (e: unknown) {
    if (isENOENT(e)) {
      debugLogger.error(`FileHistory: Backup file not found: ${backupPath}`);
      return false;
    }
    throw e;
  }

  try {
    await copyFile(backupPath, filePath);
  } catch (e: unknown) {
    if (!isENOENT(e)) throw e;
    await mkdir(dirname(filePath), { recursive: true });
    await copyFile(backupPath, filePath);
  }

  await chmod(filePath, backupStats.mode);
  return true;
}

async function checkOriginFileChanged(
  originalFile: string,
  backupFileName: string,
  sessionId: string,
  originalStatsHint?: Stats,
): Promise<boolean> {
  const backupPath = resolveBackupPath(backupFileName, sessionId);

  let originalStats: Stats | null = originalStatsHint ?? null;
  if (!originalStats) {
    try {
      originalStats = await stat(originalFile);
    } catch (e: unknown) {
      if (!isENOENT(e)) return true;
    }
  }

  let backupStats: Stats | null = null;
  try {
    backupStats = await stat(backupPath);
  } catch (e: unknown) {
    if (!isENOENT(e)) return true;
  }

  if ((originalStats === null) !== (backupStats === null)) return true;
  if (originalStats === null || backupStats === null) return false;

  if (
    originalStats.mode !== backupStats.mode ||
    originalStats.size !== backupStats.size
  ) {
    return true;
  }

  if (originalStats.mtimeMs < backupStats.mtimeMs) return false;

  try {
    const [originalContent, backupContent] = await Promise.all([
      readFile(originalFile, 'utf-8'),
      readFile(backupPath, 'utf-8'),
    ]);
    return originalContent !== backupContent;
  } catch {
    return true;
  }
}

async function computeDiffStatsForFile(
  originalFile: string,
  backupFileName: string | undefined,
  sessionId: string,
): Promise<DiffStats> {
  const filesChanged: string[] = [];
  let insertions = 0;
  let deletions = 0;

  try {
    const backupPath = backupFileName
      ? resolveBackupPath(backupFileName, sessionId)
      : undefined;

    const [originalContent, backupContent] = await Promise.all([
      readFileOrNull(originalFile),
      backupPath ? readFileOrNull(backupPath) : null,
    ]);

    if (originalContent === null && backupContent === null) {
      return { filesChanged, insertions, deletions };
    }

    filesChanged.push(originalFile);

    const changes = diffLines(backupContent ?? '', originalContent ?? '');
    for (const c of changes) {
      if (c.added) insertions += c.count || 0;
      if (c.removed) deletions += c.count || 0;
    }
  } catch (error) {
    debugLogger.error(`FileHistory: Error generating diffStats: ${error}`);
  }

  return { filesChanged, insertions, deletions };
}

export class FileHistoryService {
  private state: FileHistoryState = {
    snapshots: [],
    trackedFiles: new Set(),
  };

  private readonly sessionId: string;
  private readonly enabled: boolean;
  private readonly cwd: string;

  constructor(sessionId: string, enabled: boolean, cwd: string) {
    this.sessionId = sessionId;
    this.enabled = enabled;
    this.cwd = cwd;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getSnapshots(): FileHistorySnapshot[] {
    return this.state.snapshots;
  }

  restoreFromSnapshots(snapshots: FileHistorySnapshot[]): void {
    const trackedFiles = new Set<string>();
    const migrated: FileHistorySnapshot[] = [];
    for (const snapshot of snapshots) {
      const trackedFileBackups: Record<string, FileHistoryBackup> = {};
      for (const [p, backup] of Object.entries(snapshot.trackedFileBackups)) {
        const trackingPath = this.maybeShortenFilePath(p);
        trackedFiles.add(trackingPath);
        trackedFileBackups[trackingPath] = backup;
      }
      migrated.push({ ...snapshot, trackedFileBackups });
    }
    this.state = {
      snapshots: migrated,
      trackedFiles,
    };
  }

  async trackEdit(filePath: string): Promise<void> {
    if (!this.enabled) return;

    const trackingPath = this.maybeShortenFilePath(filePath);
    const mostRecent = this.state.snapshots.at(-1);

    if (!mostRecent) {
      debugLogger.error('FileHistory: Missing most recent snapshot');
      return;
    }

    if (mostRecent.trackedFileBackups[trackingPath]) {
      return;
    }

    let maxVersion = 0;
    for (const snapshot of this.state.snapshots) {
      const existing = snapshot.trackedFileBackups[trackingPath];
      if (existing && existing.version > maxVersion) {
        maxVersion = existing.version;
      }
    }

    let backup: FileHistoryBackup;
    try {
      backup = await createBackup(filePath, maxVersion + 1, this.sessionId);
    } catch (error) {
      debugLogger.error(`FileHistory: trackEdit failed: ${error}`);
      return;
    }

    // Re-check after async backup — concurrent calls write the same
    // deterministic path, so the second overwrites the first harmlessly.
    if (!mostRecent.trackedFileBackups[trackingPath]) {
      mostRecent.trackedFileBackups[trackingPath] = backup;
      this.state.trackedFiles.add(trackingPath);
    }

    debugLogger.debug(`FileHistory: Tracked file modification for ${filePath}`);
  }

  async makeSnapshot(promptId: string): Promise<void> {
    if (!this.enabled) return;

    const trackedFileBackups: Record<string, FileHistoryBackup> = {};
    const mostRecent = this.state.snapshots.at(-1);

    if (mostRecent) {
      await Promise.all(
        Array.from(this.state.trackedFiles, async (trackingPath) => {
          try {
            const filePath = this.maybeExpandFilePath(trackingPath);
            const latestBackup = mostRecent.trackedFileBackups[trackingPath];
            let maxVersion = 0;
            for (const s of this.state.snapshots) {
              const b = s.trackedFileBackups[trackingPath];
              if (b && b.version > maxVersion) maxVersion = b.version;
            }
            const nextVersion = maxVersion + 1;

            let fileStats: Stats | undefined;
            try {
              fileStats = await stat(filePath);
            } catch (e: unknown) {
              if (!isENOENT(e)) throw e;
            }

            if (!fileStats) {
              trackedFileBackups[trackingPath] = {
                backupFileName: null,
                version: nextVersion,
                backupTime: new Date(),
              };
              return;
            }

            if (
              latestBackup &&
              latestBackup.backupFileName !== null &&
              !(await checkOriginFileChanged(
                filePath,
                latestBackup.backupFileName,
                this.sessionId,
                fileStats,
              ))
            ) {
              trackedFileBackups[trackingPath] = latestBackup;
              return;
            }

            trackedFileBackups[trackingPath] = await createBackup(
              filePath,
              nextVersion,
              this.sessionId,
            );
          } catch (error) {
            debugLogger.error(
              `FileHistory: Failed to backup file ${trackingPath}: ${error}`,
            );
          }
        }),
      );
    }

    for (const trackingPath of this.state.trackedFiles) {
      if (trackingPath in trackedFileBackups) continue;
      const inherited = mostRecent?.trackedFileBackups[trackingPath];
      if (inherited) trackedFileBackups[trackingPath] = inherited;
    }

    const newSnapshot: FileHistorySnapshot = {
      promptId,
      trackedFileBackups,
      timestamp: new Date(),
    };

    this.state.snapshots.push(newSnapshot);
    if (this.state.snapshots.length > MAX_SNAPSHOTS) {
      this.state.snapshots = this.state.snapshots.slice(-MAX_SNAPSHOTS);
    }

    debugLogger.debug(
      `FileHistory: Added snapshot for ${promptId}, tracking ${this.state.trackedFiles.size} files`,
    );
  }

  async rewind(
    promptId: string,
    truncateHistory = true,
  ): Promise<RewindResult> {
    if (!this.enabled) return { filesChanged: [], filesFailed: [] };

    const targetSnapshot = this.findSnapshot(promptId);
    if (!targetSnapshot) {
      throw new Error('The selected snapshot was not found');
    }

    debugLogger.debug(`FileHistory: Rewinding to snapshot for ${promptId}`);
    const result = await this.applySnapshot(targetSnapshot);

    if (truncateHistory) {
      const targetIdx = this.state.snapshots.indexOf(targetSnapshot);
      if (targetIdx >= 0) {
        this.state.snapshots = this.state.snapshots.slice(0, targetIdx + 1);
        this.state.trackedFiles = new Set(
          this.state.snapshots.flatMap((s) =>
            Object.keys(s.trackedFileBackups),
          ),
        );
      }
    }

    debugLogger.debug(`FileHistory: Finished rewinding to ${promptId}`);
    return result;
  }

  async getDiffStats(promptId: string): Promise<DiffStats | undefined> {
    if (!this.enabled) return undefined;

    const targetSnapshot = this.findSnapshot(promptId);
    if (!targetSnapshot) return undefined;

    const results = await Promise.all(
      Array.from(this.state.trackedFiles, async (trackingPath) => {
        try {
          const filePath = this.maybeExpandFilePath(trackingPath);
          const targetBackup = targetSnapshot.trackedFileBackups[trackingPath];

          const backupFileName: BackupFileName | undefined = targetBackup
            ? targetBackup.backupFileName
            : this.getBackupFileNameFirstVersion(trackingPath);

          if (backupFileName === undefined) return null;

          const stats = await computeDiffStatsForFile(
            filePath,
            backupFileName === null ? undefined : backupFileName,
            this.sessionId,
          );
          if (stats?.insertions || stats?.deletions) {
            return { filePath, stats };
          }
          if (backupFileName === null && (await pathExists(filePath))) {
            return { filePath, stats };
          }
          return null;
        } catch (error) {
          debugLogger.error(
            `FileHistory: Error computing diff stats: ${error}`,
          );
          return null;
        }
      }),
    );

    const filesChanged: string[] = [];
    let insertions = 0;
    let deletions = 0;
    for (const r of results) {
      if (!r) continue;
      filesChanged.push(r.filePath);
      insertions += r.stats?.insertions || 0;
      deletions += r.stats?.deletions || 0;
    }
    return { filesChanged, insertions, deletions };
  }

  private findSnapshot(promptId: string): FileHistorySnapshot | undefined {
    for (let i = this.state.snapshots.length - 1; i >= 0; i--) {
      if (this.state.snapshots[i]!.promptId === promptId) {
        return this.state.snapshots[i];
      }
    }
    return undefined;
  }

  private async applySnapshot(
    targetSnapshot: FileHistorySnapshot,
  ): Promise<RewindResult> {
    const filesChanged: string[] = [];
    const filesFailed: string[] = [];
    for (const trackingPath of this.state.trackedFiles) {
      try {
        const filePath = this.maybeExpandFilePath(trackingPath);
        const targetBackup = targetSnapshot.trackedFileBackups[trackingPath];

        const backupFileName: BackupFileName | undefined = targetBackup
          ? targetBackup.backupFileName
          : this.getBackupFileNameFirstVersion(trackingPath);

        if (backupFileName === undefined) {
          debugLogger.error(
            'FileHistory: Error finding the backup file to apply',
          );
          filesFailed.push(filePath);
          continue;
        }

        if (backupFileName === null) {
          try {
            await unlink(filePath);
            debugLogger.debug(`FileHistory: Deleted ${filePath}`);
            filesChanged.push(filePath);
          } catch (e: unknown) {
            if (!isENOENT(e)) throw e;
          }
          continue;
        }

        if (
          await checkOriginFileChanged(filePath, backupFileName, this.sessionId)
        ) {
          const restored = await restoreBackup(
            filePath,
            backupFileName,
            this.sessionId,
          );
          if (restored) {
            debugLogger.debug(
              `FileHistory: Restored ${filePath} from ${backupFileName}`,
            );
            filesChanged.push(filePath);
          } else {
            filesFailed.push(filePath);
          }
        }
      } catch (error) {
        debugLogger.error(
          `FileHistory: Error restoring file ${trackingPath}: ${error}`,
        );
        filesFailed.push(this.maybeExpandFilePath(trackingPath));
      }
    }
    return { filesChanged, filesFailed };
  }

  private getBackupFileNameFirstVersion(
    trackingPath: string,
  ): BackupFileName | undefined {
    for (const snapshot of this.state.snapshots) {
      const backup = snapshot.trackedFileBackups[trackingPath];
      if (backup !== undefined && backup.version === 1) {
        return backup.backupFileName;
      }
    }
    return undefined;
  }

  private maybeShortenFilePath(filePath: string): string {
    if (!isAbsolute(filePath)) return filePath;
    if (filePath.startsWith(this.cwd + '/') || filePath === this.cwd) {
      return relative(this.cwd, filePath);
    }
    return filePath;
  }

  private maybeExpandFilePath(filePath: string): string {
    if (isAbsolute(filePath)) return filePath;
    return join(this.cwd, filePath);
  }
}
