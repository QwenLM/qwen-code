/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BRAND_FIXED_ENV_PREFIX } from '../config/brand.js';

import { randomUUID } from 'node:crypto';
import { diffLines } from 'diff';
import { constants, type Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { runLogger } from '../utils/runLogger.js';

type BackupFileName = string | null;

export interface FileHistoryBackup {
  backupFileName: BackupFileName;
  /** Capture failed; backupFileName is an unpublished backup id, never null. */
  captureFailed?: true;
  version: number;
  backupTime: Date;
}

export interface FileHistorySnapshot {
  messageId: string;
  trackedFileBackups: Record<string, FileHistoryBackup>;
  timestamp: Date;
  /** 产生快照时的运行 checkout；旧 JSONL 不含该字段。 */
  cwd?: string;
}

export interface FileHistoryState {
  snapshots: FileHistorySnapshot[];
  trackedFiles: Set<string>;
  snapshotSequence: number;
}

export interface FileHistoryDiffStats {
  filesChanged: string[];
  insertions: number;
  deletions: number;
  failedFiles?: FileHistoryRewindResult['failedFiles'];
}

export interface FileHistoryRewindResult {
  filesChanged: string[];
  failedFiles: Array<{ path: string; error: string }>;
}

export interface FileHistorySnapshotRecord {
  messageId: string;
  snapshot: FileHistorySnapshot;
  isSnapshotUpdate: boolean;
}

/** Existing callers can surface partial restoration without a new wire result type. */
export function formatFileHistoryRewindFailure(
  result: FileHistoryRewindResult,
): string | undefined {
  if (!result.failedFiles.length) return undefined;
  return `File rewind incomplete: ${result.filesChanged.length} file(s) restored; ${result.failedFiles.length} file(s) could not be restored: ${result.failedFiles.map((file) => file.path).join(', ')}.`;
}

interface FileHistoryManagerOptions {
  cwd: string;
  sessionId: string;
  enabled?: boolean;
  /** Worktree 会话不兼容未记录 checkout 的旧快照，避免相对路径映射到错误目录。 */
  acceptLegacySnapshots?: boolean;
  checkpointRoot?: string;
  recordSnapshot?: (entry: FileHistorySnapshotRecord) => Promise<void> | void;
}

const MAX_SNAPSHOTS = 100;

/**
 * Private hand-off from the daemon process to a materialized Worker. This is
 * intentionally not a Host/SDK option: the daemon owns the persistent root.
 */
export const ENV_DAEMON_FILE_CHECKPOINT_ROOT = `${BRAND_FIXED_ENV_PREFIX}INTERNAL_DAEMON_FILE_CHECKPOINT_ROOT`;

export function getFileCheckpointRoot(
  configDir = Storage.getGlobalConfigDir(),
): string {
  return path.join(configDir, 'file-history');
}

/** 当前进程的 checkpoint 根；daemon 可通过私有 env 覆盖给 Worker。 */
export function resolveFileCheckpointRoot(
  checkpointRoot?: string,
): string {
  const configured =
    checkpointRoot ?? process.env[ENV_DAEMON_FILE_CHECKPOINT_ROOT];
  return path.resolve(
    configured?.trim() ? configured : getFileCheckpointRoot(),
  );
}

export async function deleteFileCheckpointSession(
  checkpointRoot: string,
  sessionId: string,
): Promise<void> {
  const root = path.resolve(checkpointRoot);
  const target = path.resolve(root, sessionId);
  if (!sessionId || path.dirname(target) !== root) {
    throw new Error(`Invalid file checkpoint Session id: ${sessionId}`);
  }
  await rm(target, { recursive: true, force: true });
}

/**
 * Copy every backup blob referenced by `snapshots` from the source session's
 * checkpoint directory into the target session's directory. Fork creation calls
 * this up front so resuming the new session never has to write or copy again.
 */
export async function copyFileHistoryBackupFiles(options: {
  checkpointRoot: string;
  sourceSessionId: string;
  targetSessionId: string;
  snapshots: readonly FileHistorySnapshot[];
  strict?: boolean;
}): Promise<void> {
  const root = path.resolve(options.checkpointRoot);
  const targetDir = path.join(root, options.targetSessionId);
  const strict = options.strict === true;
  if (strict) {
    await rm(targetDir, { recursive: true, force: true });
  }
  await mkdir(targetDir, { recursive: true });

  const backupFileNames = new Set<string>();
  for (const snapshot of options.snapshots) {
    for (const backup of Object.values(snapshot.trackedFileBackups)) {
      // captureFailed 的 id 从未发布成 blob；跳过，避免把已知失败当成缺失。
      if (!backup.captureFailed && backup.backupFileName) {
        backupFileNames.add(backup.backupFileName);
      }
    }
  }

  const copyFailures: Array<{ backupFileName: string; error: unknown }> = [];
  await Promise.all(
    Array.from(backupFileNames, async (backupFileName) => {
      const sourcePath = path.join(
        root,
        options.sourceSessionId,
        backupFileName,
      );
      const targetPath = path.join(targetDir, backupFileName);
      try {
        await link(sourcePath, targetPath);
      } catch (error) {
        if (isErrno(error, 'EEXIST')) {
          return;
        }
        try {
          await copyFile(sourcePath, targetPath);
        } catch (copyError) {
          if (isErrno(copyError, 'EEXIST')) {
            return;
          }
          copyFailures.push({ backupFileName, error: copyError });
          runLogger.warn(
            `FileHistory: 迁移备份失败 (${backupFileName})`,
            copyError,
          );
        }
      }
    }),
  );

  if (copyFailures.length > 0) {
    runLogger.warn(
      `FileHistory: session ${options.sourceSessionId} -> ${options.targetSessionId} 迁移完成，但有 ${copyFailures.length} 个备份文件未迁移。`,
    );
    if (strict) {
      await rm(targetDir, { recursive: true, force: true });
      throw new AggregateError(
        copyFailures.map(({ error }) => error),
        `FileHistory: failed to copy ${copyFailures.length} checkpoint backup file(s) for fork ${options.targetSessionId}.`,
      );
    }
  }
}

export class FileHistoryManager {
  private cwd: string;
  private readonly checkpointRoot: string;
  private sessionId: string;
  private readonly enabled: boolean;
  private readonly acceptLegacySnapshots: boolean;
  private recordSnapshot?: (
    entry: FileHistorySnapshotRecord,
  ) => Promise<void> | void;
  private state: FileHistoryState = {
    snapshots: [],
    trackedFiles: new Set<string>(),
    snapshotSequence: 0,
  };
  private persistedSnapshotMessageIds = new Set<string>();

  constructor(options: FileHistoryManagerOptions) {
    this.cwd = path.resolve(options.cwd);
    this.checkpointRoot = resolveFileCheckpointRoot(options.checkpointRoot);
    this.sessionId = options.sessionId;
    this.enabled = options.enabled ?? true;
    this.acceptLegacySnapshots = options.acceptLegacySnapshots ?? true;
    this.recordSnapshot = options.recordSnapshot;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  setRecorder(
    recordSnapshot:
      | ((entry: FileHistorySnapshotRecord) => Promise<void> | void)
      | undefined,
  ): void {
    this.recordSnapshot = recordSnapshot;
  }

  getState(): Readonly<FileHistoryState> {
    return this.state;
  }

  getSnapshots(): FileHistorySnapshot[] {
    return [...this.state.snapshots];
  }

  reset(): void {
    this.state = {
      snapshots: [],
      trackedFiles: new Set<string>(),
      snapshotSequence: 0,
    };
    this.persistedSnapshotMessageIds.clear();
  }

  /** 切换运行 checkout 时不允许复用旧 checkout 的相对路径快照。 */
  rebaseCwd(cwd: string): void {
    const nextCwd = path.resolve(cwd);
    if (nextCwd === this.cwd) {
      return;
    }
    const messageId = this.state.snapshots.at(-1)?.messageId;
    this.cwd = nextCwd;
    this.reset();
    if (messageId) {
      // Enter/Exit 可以发生在同一轮工具调用中；保留消息锚点，首次编辑时
      // 为新 checkout 创建备份，不继承旧 checkout 的任何文件或备份。
      this.state.snapshots.push({
        messageId,
        cwd: nextCwd,
        timestamp: new Date(),
        trackedFileBackups: {},
      });
      this.state.snapshotSequence = 1;
    }
  }

  restoreStateFromSnapshots(snapshots: readonly FileHistorySnapshot[]): void {
    if (!this.enabled) {
      this.reset();
      return;
    }

    const normalizedSnapshots: FileHistorySnapshot[] = [];
    const trackedFiles = new Set<string>();
    for (const snapshot of snapshots) {
      if (!this.isSnapshotCompatible(snapshot)) {
        continue;
      }
      const snapshotCwd = snapshot.cwd ? path.resolve(snapshot.cwd) : undefined;
      const trackedFileBackups: Record<string, FileHistoryBackup> = {};
      for (const [filePath, backup] of Object.entries(
        snapshot.trackedFileBackups,
      )) {
        const trackingPath = this.normalizeTrackingPath(filePath);
        trackedFiles.add(trackingPath);
        trackedFileBackups[trackingPath] = {
          ...backup,
          backupTime: new Date(backup.backupTime),
        };
      }
      normalizedSnapshots.push({
        ...snapshot,
        ...(snapshotCwd ? { cwd: snapshotCwd } : {}),
        timestamp: new Date(snapshot.timestamp),
        trackedFileBackups,
      });
    }

    this.state = {
      snapshots: normalizedSnapshots,
      trackedFiles,
      snapshotSequence: normalizedSnapshots.length,
    };
    this.persistedSnapshotMessageIds = new Set(
      normalizedSnapshots.map((snapshot) => snapshot.messageId),
    );
  }

  async rehydrateFromResume(options: {
    sourceSessionId: string;
    snapshots: readonly FileHistorySnapshot[];
    persistToTranscript?: boolean;
    /** Fork creation already copied every blob; resume only restores memory. */
    copyBackupFiles?: boolean;
    strictBackupCopy?: boolean;
  }): Promise<void> {
    if (!this.enabled) {
      this.reset();
      return;
    }

    const {
      sourceSessionId,
      snapshots,
      persistToTranscript = false,
      copyBackupFiles = true,
      strictBackupCopy = false,
    } = options;
    const compatibleSnapshots = snapshots.filter((snapshot) =>
      this.isSnapshotCompatible(snapshot),
    );
    if (copyBackupFiles && sourceSessionId !== this.sessionId) {
      await copyFileHistoryBackupFiles({
        checkpointRoot: this.checkpointRoot,
        sourceSessionId,
        targetSessionId: this.sessionId,
        snapshots: compatibleSnapshots,
        strict: strictBackupCopy,
      });
    }

    this.restoreStateFromSnapshots(compatibleSnapshots);

    if (!persistToTranscript || !this.recordSnapshot) {
      return;
    }

    for (const snapshot of this.state.snapshots) {
      await this.recordSnapshot({
        messageId: snapshot.messageId,
        snapshot,
        isSnapshotUpdate: false,
      });
      this.persistedSnapshotMessageIds.add(snapshot.messageId);
    }
  }

  async makeSnapshot(messageId: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const captured = this.state;
    const trackedFileBackups: Record<string, FileHistoryBackup> = {};
    const mostRecentSnapshot = captured.snapshots.at(-1);

    if (mostRecentSnapshot) {
      await Promise.all(
        Array.from(captured.trackedFiles, async (trackingPath) => {
          const filePath = this.toAbsolutePath(trackingPath);
          const latestBackup =
            mostRecentSnapshot.trackedFileBackups[trackingPath];
          const nextVersion = latestBackup ? latestBackup.version + 1 : 1;
          try {
            const fileStats = await this.tryStat(filePath);

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
              !latestBackup.captureFailed &&
              typeof latestBackup.backupFileName === 'string' &&
              !(await this.checkOriginFileChanged(
                filePath,
                latestBackup.backupFileName,
                fileStats,
              ))
            ) {
              trackedFileBackups[trackingPath] = latestBackup;
              return;
            }

            trackedFileBackups[trackingPath] = await this.createBackup(
              filePath,
              nextVersion,
            );
          } catch (error) {
            trackedFileBackups[trackingPath] = this.unavailableBackup(
              filePath,
              nextVersion,
              error,
            );
          }
        }),
      );
    }

    const lastSnapshot = this.state.snapshots.at(-1);
    if (lastSnapshot) {
      for (const trackingPath of this.state.trackedFiles) {
        if (trackedFileBackups[trackingPath]) {
          continue;
        }
        const inherited = lastSnapshot.trackedFileBackups[trackingPath];
        if (inherited) {
          trackedFileBackups[trackingPath] = inherited;
        }
      }
    }

    const newSnapshot: FileHistorySnapshot = {
      messageId,
      trackedFileBackups,
      timestamp: new Date(),
      cwd: this.cwd,
    };
    const snapshots = [...this.state.snapshots, newSnapshot];
    this.state = {
      ...this.state,
      snapshots:
        snapshots.length > MAX_SNAPSHOTS
          ? snapshots.slice(-MAX_SNAPSHOTS)
          : snapshots,
      snapshotSequence: this.state.snapshotSequence + 1,
    };

    if (Object.keys(newSnapshot.trackedFileBackups).length > 0) {
      await this.persistSnapshot(newSnapshot, false);
    }
  }

  async trackEdit(filePath: string, messageId: string): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const absoluteFilePath = path.resolve(filePath);
    const trackingPath = this.toTrackingPath(absoluteFilePath);
    const mostRecent = this.state.snapshots.at(-1);

    if (!mostRecent || mostRecent.messageId !== messageId) {
      return;
    }

    if (mostRecent.trackedFileBackups[trackingPath]) {
      return;
    }

    const backup = await this.createBackup(absoluteFilePath, 1);
    const freshMostRecent = this.state.snapshots.at(-1);
    if (
      !freshMostRecent ||
      freshMostRecent.messageId !== messageId ||
      // rebase/reset 后即使 messageId 相同，旧异步备份也不能写入新快照。
      freshMostRecent.timestamp !== mostRecent.timestamp ||
      freshMostRecent.trackedFileBackups[trackingPath]
    ) {
      return;
    }

    const updatedSnapshot: FileHistorySnapshot = {
      ...freshMostRecent,
      cwd: this.cwd,
      trackedFileBackups: {
        ...freshMostRecent.trackedFileBackups,
        [trackingPath]: backup,
      },
    };
    const nextSnapshots = [...this.state.snapshots];
    nextSnapshots[nextSnapshots.length - 1] = updatedSnapshot;
    const nextTrackedFiles = new Set(this.state.trackedFiles);
    nextTrackedFiles.add(trackingPath);
    this.state = {
      ...this.state,
      snapshots: nextSnapshots,
      trackedFiles: nextTrackedFiles,
    };

    await this.persistSnapshot(
      updatedSnapshot,
      this.persistedSnapshotMessageIds.has(messageId),
    );
  }

  async rewind(messageId: string): Promise<string[]> {
    return (await this.rewindDetailed(messageId)).filesChanged;
  }

  async rewindDetailed(messageId: string): Promise<FileHistoryRewindResult> {
    if (!this.enabled) {
      return { filesChanged: [], failedFiles: [] };
    }

    const targetSnapshot = this.state.snapshots.findLast(
      (snapshot) => snapshot.messageId === messageId,
    );
    if (!targetSnapshot) {
      throw new Error(`未找到 messageId=${messageId} 对应的文件快照。`);
    }

    const filesChanged: string[] = [];
    const rewindFailures: Array<{ filePath: string; error: unknown }> = [];
    for (const trackingPath of this.state.trackedFiles) {
      const filePath = this.toAbsolutePath(trackingPath);
      try {
        const targetBackup =
          targetSnapshot.trackedFileBackups[trackingPath] ??
          this.getFirstBackup(trackingPath, this.state);
        const backupFileName = targetBackup?.backupFileName;

        if (backupFileName === undefined || targetBackup?.captureFailed) {
          throw new Error('No usable backup was captured for this checkpoint.');
        }

        if (backupFileName === null) {
          try {
            await unlink(filePath);
            filesChanged.push(filePath);
          } catch (error) {
            if (!isErrno(error, 'ENOENT')) {
              throw error;
            }
          }
          continue;
        }

        // A missing source and missing backup are not proof of a valid restore.
        if (!(await this.tryStat(this.resolveBackupPath(backupFileName)))) {
          throw new Error('The checkpoint backup is missing.');
        }
        if (await this.checkOriginFileChanged(filePath, backupFileName)) {
          await this.restoreBackup(filePath, backupFileName);
          filesChanged.push(filePath);
        }
      } catch (error) {
        rewindFailures.push({ filePath, error });
        runLogger.warn(`FileHistory: 回退文件失败 (${filePath})`, error);
      }
    }

    if (rewindFailures.length > 0) {
      runLogger.warn(
        `FileHistory: messageId=${messageId} 回退完成，但有 ${rewindFailures.length} 个文件恢复失败。`,
      );
    }

    return {
      filesChanged,
      failedFiles: rewindFailures.map(({ filePath, error }) => ({
        path: filePath,
        error: error instanceof Error ? error.message : String(error),
      })),
    };
  }

  canRewind(messageId: string): boolean {
    return this.state.snapshots.some(
      (snapshot) => snapshot.messageId === messageId,
    );
  }

  async hasAnyChanges(messageId: string): Promise<boolean> {
    const targetSnapshot = this.state.snapshots.findLast(
      (snapshot) => snapshot.messageId === messageId,
    );
    if (!targetSnapshot) {
      return false;
    }

    for (const trackingPath of this.state.trackedFiles) {
      const filePath = this.toAbsolutePath(trackingPath);
      const targetBackup =
        targetSnapshot.trackedFileBackups[trackingPath] ??
        this.getFirstBackup(trackingPath, this.state);
      const backupFileName = targetBackup?.backupFileName;

      if (backupFileName === undefined || targetBackup?.captureFailed) {
        return true; // Keep the checkpoint visible so its failure can be explained.
      }
      if (backupFileName === null) {
        if (await pathExists(filePath)) {
          return true;
        }
        continue;
      }
      if (await this.checkOriginFileChanged(filePath, backupFileName)) {
        return true;
      }
    }

    return false;
  }

  async getDiffStats(
    messageId: string,
  ): Promise<FileHistoryDiffStats | undefined> {
    const targetSnapshot = this.state.snapshots.findLast(
      (snapshot) => snapshot.messageId === messageId,
    );
    if (!targetSnapshot) {
      return undefined;
    }

    const filesChanged: string[] = [];
    const failedFiles: FileHistoryRewindResult['failedFiles'] = [];
    let insertions = 0;
    let deletions = 0;

    for (const trackingPath of this.state.trackedFiles) {
      const filePath = this.toAbsolutePath(trackingPath);
      const targetBackup =
        targetSnapshot.trackedFileBackups[trackingPath] ??
        this.getFirstBackup(trackingPath, this.state);
      const backupFileName = targetBackup?.backupFileName;

      let stats: FileHistoryDiffStats;
      try {
        if (backupFileName === undefined || targetBackup?.captureFailed) {
          throw new Error('No usable backup was captured for this checkpoint.');
        }
        stats = await this.computeDiffStatsForFile(
          filePath,
          backupFileName === null ? undefined : backupFileName,
        );
      } catch (error) {
        failedFiles.push({
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      if (
        (stats.insertions > 0 || stats.deletions > 0) &&
        !filesChanged.includes(filePath)
      ) {
        filesChanged.push(filePath);
      } else if (backupFileName === null && (await pathExists(filePath))) {
        filesChanged.push(filePath);
      }

      insertions += stats.insertions;
      deletions += stats.deletions;
    }

    return {
      filesChanged,
      insertions,
      deletions,
      ...(failedFiles.length ? { failedFiles } : {}),
    };
  }

  async checkOriginFileChanged(
    originalFile: string,
    backupFileName: string,
    originalStatsHint?: Stats,
  ): Promise<boolean> {
    const backupPath = this.resolveBackupPath(backupFileName);

    let originalStats: Stats | null = originalStatsHint ?? null;
    if (!originalStats) {
      originalStats = await this.tryStat(originalFile);
    }
    const backupStats = await this.tryStat(backupPath);

    if (originalStats === null || backupStats === null) {
      return true;
    }
    if (
      originalStats.mode !== backupStats.mode ||
      originalStats.size !== backupStats.size
    ) {
      return true;
    }
    if (originalStats.mtimeMs < backupStats.mtimeMs) {
      return false;
    }

    try {
      const [originalContent, backupContent] = await Promise.all([
        readFile(originalFile),
        readFile(backupPath),
      ]);
      return !originalContent.equals(backupContent);
    } catch {
      return true;
    }
  }

  private async persistSnapshot(
    snapshot: FileHistorySnapshot,
    isSnapshotUpdate: boolean,
  ): Promise<void> {
    if (!this.recordSnapshot) {
      return;
    }
    try {
      await this.recordSnapshot({
        messageId: snapshot.messageId,
        snapshot,
        isSnapshotUpdate,
      });
      this.persistedSnapshotMessageIds.add(snapshot.messageId);
    } catch (error) {
      runLogger.warn(
        'FileHistory: Failed to persist checkpoint; it is only available in this process.',
        error,
      );
    }
  }


  private unavailableBackup(
    filePath: string,
    version: number,
    error: unknown,
    backupFileName = `${randomUUID()}@v${version}`,
  ): FileHistoryBackup {
    runLogger.warn(
      `FileHistory: Failed to capture ${filePath}; editing may continue, but this file cannot be restored to this checkpoint.`,
      error,
    );
    return {
      backupFileName,
      captureFailed: true,
      version,
      backupTime: new Date(),
    };
  }

  private async createBackup(
    filePath: string,
    version: number,
  ): Promise<FileHistoryBackup> {
    // checkout 切换或重启后版本号可能重用，备份标识必须独立，不能覆盖旧 JSONL 引用的内容。
    const backupFileName = `${randomUUID()}@v${version}`;
    const backupPath = this.resolveBackupPath(backupFileName);

    // Publish only a complete backup. Older readers ignore captureFailed and
    // safely see a missing final file; they must never read a partial copy.
    const temporaryPath = `${backupPath}.tmp`;
    try {
      let sourceStats: Stats;
      try {
        sourceStats = await stat(filePath);
      } catch (error) {
        if (isErrno(error, 'ENOENT')) {
          return { backupFileName: null, version, backupTime: new Date() };
        }
        throw error;
      }
      try {
        await copyFile(filePath, temporaryPath, constants.COPYFILE_EXCL);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error;
        await mkdir(path.dirname(temporaryPath), { recursive: true });
        await copyFile(filePath, temporaryPath, constants.COPYFILE_EXCL);
      }
      await chmod(temporaryPath, sourceStats.mode);
      await rename(temporaryPath, backupPath);
      return { backupFileName, version, backupTime: new Date() };
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch((cleanupError) => {
        runLogger.warn(
          'FileHistory: Failed to remove incomplete backup.',
          cleanupError,
        );
      });
      return this.unavailableBackup(filePath, version, error, backupFileName);
    }
  }

  private async restoreBackup(
    filePath: string,
    backupFileName: string,
  ): Promise<void> {
    const backupPath = this.resolveBackupPath(backupFileName);
    const backupStats = await stat(backupPath);

    try {
      await copyFile(backupPath, filePath);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        throw error;
      }
      await mkdir(path.dirname(filePath), { recursive: true });
      await copyFile(backupPath, filePath);
    }

    await chmod(filePath, backupStats.mode);
  }

  private async computeDiffStatsForFile(
    filePath: string,
    backupFileName?: string,
  ): Promise<FileHistoryDiffStats> {
    const [currentContent, backupContent] = await Promise.all([
      readFileOrNull(filePath),
      backupFileName
        ? readFileOrNull(this.resolveBackupPath(backupFileName))
        : Promise.resolve(null),
    ]);

    if (backupFileName && backupContent === null) {
      throw new Error('The checkpoint backup is missing.');
    }
    if (currentContent === null && backupContent === null) {
      return { filesChanged: [], insertions: 0, deletions: 0 };
    }

    const changes = diffLines(
      currentContent?.toString('utf8') ?? '',
      backupContent?.toString('utf8') ?? '',
    );
    let insertions = 0;
    let deletions = 0;
    for (const change of changes) {
      if (change.added) {
        insertions += change.count ?? 0;
      }
      if (change.removed) {
        deletions += change.count ?? 0;
      }
    }

    return {
      filesChanged: [filePath],
      insertions,
      deletions,
    };
  }

  private resolveBackupPath(
    backupFileName: string,
    sessionId = this.sessionId,
  ): string {
    return path.join(this.getSessionBackupDir(sessionId), backupFileName);
  }

  private getSessionBackupDir(sessionId = this.sessionId): string {
    return path.join(this.checkpointRoot, sessionId);
  }

  private getFirstBackup(
    trackingPath: string,
    state: FileHistoryState,
  ): FileHistoryBackup | undefined {
    for (const snapshot of state.snapshots) {
      const backup = snapshot.trackedFileBackups[trackingPath];
      if (backup && backup.version === 1) {
        return backup;
      }
    }
    return undefined;
  }

  private toTrackingPath(filePath: string): string {
    const absolutePath = path.resolve(filePath);
    if (
      absolutePath.startsWith(this.cwd + path.sep) ||
      absolutePath === this.cwd
    ) {
      return path.relative(this.cwd, absolutePath) || '.';
    }
    return absolutePath;
  }

  private normalizeTrackingPath(trackingPath: string): string {
    if (path.isAbsolute(trackingPath)) {
      return this.toTrackingPath(trackingPath);
    }
    return path.normalize(trackingPath) || '.';
  }

  private isSnapshotCompatible(snapshot: FileHistorySnapshot): boolean {
    if (!snapshot.cwd) {
      return this.acceptLegacySnapshots;
    }
    return path.resolve(snapshot.cwd) === this.cwd;
  }

  private toAbsolutePath(trackingPath: string): string {
    return path.isAbsolute(trackingPath)
      ? trackingPath
      : path.resolve(this.cwd, trackingPath);
  }

  private async tryStat(filePath: string): Promise<Stats | null> {
    try {
      return await stat(filePath);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return null;
      }
      throw error;
    }
  }
}

async function readFileOrNull(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
