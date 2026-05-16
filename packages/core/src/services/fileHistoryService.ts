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
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { diffLines } from 'diff';
import { Storage } from '../config/storage.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('FILE_HISTORY');

type BackupFileName = string | null;

export interface FileHistoryBackup {
  backupFileName: BackupFileName;
  version: number;
  backupTime: Date;
  // Set when makeSnapshot's per-file backup attempt threw. Distinguishes
  // "we have a confirmed backup of this file at this snapshot" from
  // "we tried to capture this file at this snapshot but failed (so the
  // attached backup, if any, is older than this turn)". Rewind / diff
  // surface failed paths via filesFailed instead of silently restoring
  // stale content as if it were current.
  failed?: boolean;
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
  filesChanged: string[];
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

// Copy `src` to `dst`, creating the destination directory if it doesn't exist.
// Returns 'src-missing' if the source file is gone (e.g. deleted between an
// earlier `stat` and this call) so callers can distinguish that from a real
// I/O failure instead of treating every ENOENT as a missing target dir.
async function safeCopyFile(
  src: string,
  dst: string,
): Promise<'ok' | 'src-missing'> {
  try {
    await copyFile(src, dst);
    return 'ok';
  } catch (e: unknown) {
    if (!isENOENT(e)) throw e;
    if (!(await pathExists(src))) return 'src-missing';
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    return 'ok';
  }
}

async function createBackup(
  filePath: string,
  version: number,
  sessionId: string,
): Promise<FileHistoryBackup> {
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

  const result = await safeCopyFile(filePath, backupPath);
  if (result === 'src-missing') {
    return { backupFileName: null, version, backupTime: new Date() };
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

  const result = await safeCopyFile(backupPath, filePath);
  if (result === 'src-missing') {
    debugLogger.error(
      `FileHistory: Backup file disappeared during restore: ${backupPath}`,
    );
    return false;
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

  // Treat any failure to stat the backup (including ENOENT) as "changed" so
  // callers attempt the restore: applySnapshot will surface the missing
  // backup via restoreBackup → filesFailed, and makeSnapshot will create a
  // fresh backup. The previous ENOENT branch silently reported "unchanged"
  // when both the working file and the backup had been deleted, which let
  // rewind report success even though the snapshot expected the file to
  // exist.
  let backupStats: Stats;
  try {
    backupStats = await stat(backupPath);
  } catch {
    return true;
  }

  if (originalStats === null) return true;

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

/**
 * Tracks file edits made through the assistant's `edit` and `write_file`
 * tools so `/rewind` can roll the workspace back to the state at a chosen
 * turn boundary.
 *
 * Scope (intentional, mirrors upstream claude-code): only files touched
 * via `edit` and `write_file` are tracked. Changes made via
 * `run_shell_command` (`sed -i`, `cp`, `mv`, `rm`, `npm` scripts, `git`
 * apply, etc.) and any out-of-tool manual edits are NOT captured, and
 * `/rewind` cannot restore them.
 */
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

    const existing = mostRecent.trackedFileBackups[trackingPath];
    // Skip only when we already have a confirmed (non-failed) backup. If
    // the existing entry is marked `failed` (because makeSnapshot's
    // per-file backup attempt threw earlier), let trackEdit retry: this
    // is the next chance to capture the file's pre-edit state under
    // hopefully-recovered I/O conditions. Without this allowance the
    // failed marker would stay sticky until the file content changes
    // again, permanently poisoning rewind for that file.
    if (existing && !existing.failed) {
      return;
    }

    const maxVersion = this.getMaxVersion(trackingPath);

    let backup: FileHistoryBackup;
    try {
      backup = await createBackup(filePath, maxVersion + 1, this.sessionId);
    } catch (error) {
      debugLogger.error(`FileHistory: trackEdit failed: ${error}`);
      return;
    }

    // Re-check after async backup — concurrent calls write the same
    // deterministic path, so the second overwrites the first harmlessly.
    // Allow overwriting a `failed` entry so the heal path actually
    // records the fresh backup (otherwise we'd leave the failed marker
    // in place even though we successfully captured the file).
    const current = mostRecent.trackedFileBackups[trackingPath];
    if (!current || current.failed) {
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
            const nextVersion = this.getMaxVersion(trackingPath) + 1;

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
              !latestBackup.failed &&
              latestBackup.backupFileName !== null &&
              !(await checkOriginFileChanged(
                filePath,
                latestBackup.backupFileName,
                this.sessionId,
                fileStats,
              ))
            ) {
              // The previous snapshot has a confirmed (non-failed) backup of
              // an unchanged file — reuse it. We must NOT reach this branch
              // when `latestBackup.failed` is set: copying that entry forward
              // would carry the `failed` flag into every subsequent snapshot
              // for as long as the file stays unchanged, permanently
              // poisoning rewind for that file. Instead we fall through and
              // retry `createBackup`, which either heals (transient I/O
              // recovered) or honestly records another failed entry.
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
            // Record the failure rather than letting the inheritance loop
            // silently copy the previous snapshot's backup — that would
            // make a rewind to this snapshot restore the file to its
            // pre-failure content as if it were the captured state of
            // this turn.
            const previous = mostRecent?.trackedFileBackups[trackingPath];
            trackedFileBackups[trackingPath] = {
              backupFileName: previous?.backupFileName ?? null,
              version: this.getMaxVersion(trackingPath) + 1,
              backupTime: new Date(),
              failed: true,
            };
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
      const overflow = this.state.snapshots.length - MAX_SNAPSHOTS;
      const removed = this.state.snapshots.slice(0, overflow);
      this.state.snapshots = this.state.snapshots.slice(overflow);
      await this.cleanupOrphanedBackups(removed);
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

    if (truncateHistory && result.filesFailed.length === 0) {
      const targetIdx = this.state.snapshots.indexOf(targetSnapshot);
      if (targetIdx >= 0) {
        const removed = this.state.snapshots.slice(targetIdx + 1);
        this.state.snapshots = this.state.snapshots.slice(0, targetIdx + 1);
        this.state.trackedFiles = new Set(
          this.state.snapshots.flatMap((s) =>
            Object.keys(s.trackedFileBackups),
          ),
        );
        await this.cleanupOrphanedBackups(removed);
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

          // The backup attempt failed at the target snapshot; we cannot
          // produce a meaningful diff against a content we never captured,
          // so omit this file from the preview rather than show a diff
          // versus an older inherited backup.
          if (targetBackup?.failed) return null;

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

        // makeSnapshot couldn't capture this file at the target turn.
        // Surface it as failed instead of restoring the carried-over
        // (older) backup as if it were the captured state.
        if (targetBackup?.failed) {
          filesFailed.push(filePath);
          continue;
        }

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

  private getMaxVersion(trackingPath: string): number {
    let maxVersion = 0;
    for (const snapshot of this.state.snapshots) {
      const existing = snapshot.trackedFileBackups[trackingPath];
      if (existing && existing.version > maxVersion) {
        maxVersion = existing.version;
      }
    }
    return maxVersion;
  }

  // Best-effort: delete on-disk backup files referenced only by `removedSnapshots`
  // and not by any surviving snapshot. Backup files are content-deduplicated
  // across snapshots (see makeSnapshot's reuse of latestBackup), so we must
  // skip any name still in the live set.
  private async cleanupOrphanedBackups(
    removedSnapshots: FileHistorySnapshot[],
  ): Promise<void> {
    const liveBackups = new Set<string>();
    for (const s of this.state.snapshots) {
      for (const b of Object.values(s.trackedFileBackups)) {
        if (b.backupFileName !== null) liveBackups.add(b.backupFileName);
      }
    }

    const toDelete = new Set<string>();
    for (const s of removedSnapshots) {
      for (const b of Object.values(s.trackedFileBackups)) {
        if (b.backupFileName !== null && !liveBackups.has(b.backupFileName)) {
          toDelete.add(b.backupFileName);
        }
      }
    }

    await Promise.all(
      Array.from(toDelete, async (name) => {
        try {
          await unlink(resolveBackupPath(name, this.sessionId));
        } catch (e: unknown) {
          if (!isENOENT(e)) {
            debugLogger.error(`FileHistory: cleanup failed for ${name}: ${e}`);
          }
        }
      }),
    );
  }

  private maybeShortenFilePath(filePath: string): string {
    if (!isAbsolute(filePath)) return filePath;
    if (filePath.startsWith(this.cwd + sep) || filePath === this.cwd) {
      return relative(this.cwd, filePath);
    }
    return filePath;
  }

  private maybeExpandFilePath(filePath: string): string {
    if (isAbsolute(filePath)) return filePath;
    return join(this.cwd, filePath);
  }
}
