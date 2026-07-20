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
  open,
  readFile,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { diffLines, structuredPatch, type Hunk } from 'diff';
import { Storage } from '../config/storage.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { MAX_DIFF_SIZE_BYTES } from '../utils/gitDiff.js';

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

type FileHistorySnapshotRecorder = (snapshot: FileHistorySnapshot) => void;

export interface DiffStats {
  filesChanged: string[];
  insertions: number;
  deletions: number;
}

export interface RewindResult {
  filesChanged: string[];
  filesFailed: string[];
}

export interface TurnFileDiff {
  filePath: string;
  hunks: Hunk[];
  isNewFile: boolean;
  isDeleted: boolean;
  linesAdded: number;
  linesRemoved: number;
  /** True when the before/after content exceeded `MAX_DIFF_SIZE_BYTES` and
   *  hunk generation was skipped to keep dialog memory bounded. The stats
   *  remain a best-effort line-count delta. */
  oversized: boolean;
  /** True when either endpoint's content contains NUL bytes (the standard
   *  binary sniff). Hunks are empty in that case — rendering them as text
   *  would corrupt the terminal or freeze the renderer. */
  isBinary: boolean;
}

export interface TurnDiff {
  promptId: string;
  timestamp: Date;
  files: TurnFileDiff[];
  stats: {
    filesChanged: number;
    linesAdded: number;
    linesRemoved: number;
    /** Upper bound on candidate files dropped because the turn touched
     *  more than `MAX_TURN_DIFF_FILES`. It is intentionally counted at
     *  the candidate layer (pre-diff) rather than the diff layer (post-
     *  filter for unchanged), so a turn editing 600 files with cap 500
     *  reports `filesOmitted = 100` regardless of how many of the
     *  processed 500 turn out to have no actual change. Some of the
     *  100 may also have had no change — we can't know without paying
     *  the read the cap was specifically meant to avoid. Treat it as
     *  "up to N more files were not surfaced". */
    filesOmitted: number;
  };
}

export const MAX_SNAPSHOTS = 100;
export const FILE_HISTORY_DIR = 'file-history';

// ---------------------------------------------------------------------------
// Serialization types for JSONL persistence
// ---------------------------------------------------------------------------

export interface SerializedFileHistorySnapshot {
  promptId: string;
  trackedFileBackups: Record<string, SerializedFileHistoryBackup>;
  timestamp: string;
}

export interface SerializedFileHistoryBackup {
  backupFileName: string | null;
  version: number;
  backupTime: string;
  failed?: boolean;
}

export function serializeSnapshot(
  s: FileHistorySnapshot,
): SerializedFileHistorySnapshot {
  return {
    promptId: s.promptId,
    timestamp: s.timestamp.toISOString(),
    trackedFileBackups: Object.fromEntries(
      Object.entries(s.trackedFileBackups).map(([path, backup]) => [
        path,
        {
          backupFileName: backup.backupFileName,
          version: backup.version,
          backupTime: backup.backupTime.toISOString(),
          failed: backup.failed || undefined,
        },
      ]),
    ),
  };
}

function safeParseDate(iso: string): Date {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

export function deserializeSnapshots(
  arr: SerializedFileHistorySnapshot[],
): FileHistorySnapshot[] {
  return arr.map((s) => ({
    promptId: s.promptId,
    timestamp: safeParseDate(s.timestamp),
    trackedFileBackups: Object.fromEntries(
      Object.entries(s.trackedFileBackups).map(([path, backup]) => [
        path,
        {
          backupFileName: backup.backupFileName,
          version: backup.version,
          backupTime: safeParseDate(backup.backupTime),
          failed: backup.failed,
        },
      ]),
    ),
  }));
}
/** Per-turn read-fanout cap. Each candidate file may read up to two backups,
 *  so 500 files ≈ 1000 concurrent opens — safely under the typical 4096 fd
 *  ceiling and well below `ulimit -n` defaults on Linux/macOS. */
const MAX_TURN_DIFF_FILES = 500;
/** How many bytes to scan for NUL when sniffing binary content. Matches
 *  git's heuristic and is enough to catch the common cases (PNG/JPEG/PDF
 *  headers, ELF/Mach-O magic) without re-scanning the entire file. */
const BINARY_SNIFF_BYTES = 8 * 1024;

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
  const baseDir = resolve(
    Storage.getGlobalQwenDir(),
    FILE_HISTORY_DIR,
    sessionId,
  );
  const backupPath = resolve(baseDir, backupFileName);
  if (!backupPath.startsWith(baseDir + sep)) {
    throw new Error(`backupFileName escapes base directory: ${backupFileName}`);
  }
  return backupPath;
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

/** Discriminated-union outcome of an endpoint read. Adding an explicit
 *  `kind` to every variant lets the compiler enforce branch coverage and
 *  removes the manual `as` casts the previous shape forced on callers. */
interface EndpointReadOk {
  kind: 'ok';
  content: string;
  exists: boolean;
}

interface EndpointReadUnreadable {
  kind: 'unreadable';
}

/** Sentinel returned when the underlying file is too large to read into memory
 *  safely. Caller treats the row as oversized without ever holding the bytes. */
interface EndpointReadOversized {
  kind: 'oversized';
  /** True when the path exists (only meaningful for the worktree branch — a
   *  backup record with a real `backupFileName` always implies the file existed
   *  at snapshot time). */
  exists: boolean;
}

type EndpointRead =
  | EndpointReadOk
  | EndpointReadUnreadable
  | EndpointReadOversized;

/**
 * Read one endpoint of a turn diff (either a snapshot backup or, when the
 * "after" endpoint is the live worktree, the file on disk).
 *
 * Returns `'unreadable'` when the underlying file exists but cannot be
 * read (permission flip, EBUSY, decoding failure, etc.). `getTurnDiff`
 * skips rows for which either endpoint is unreadable, so the dialog
 * never fabricates phantom hunks against an empty string we never
 * actually had. ENOENT is treated as a genuine absence — for the live
 * worktree that means the file was deleted; for a backup with a real
 * `backupFileName` it means the snapshot is corrupt and is reported
 * as unreadable.
 *
 * Returns `{ kind: 'oversized' }` when the on-disk file is larger than
 * `MAX_DIFF_SIZE_BYTES`. We `stat()` first and bail before allocating —
 * otherwise a 2 GB `write_file` blob would be slurped into the Node heap
 * just for the downstream `Buffer.byteLength` check to reject it, OOM-ing
 * the dialog before the cap can fire. The dialog renders these rows as
 * "(oversized — diff omitted)" without ever holding the bytes.
 */
async function readEndpointContent(
  backup: FileHistoryBackup | undefined,
  worktreePath: string | undefined,
  sessionId: string,
): Promise<EndpointRead> {
  if (worktreePath !== undefined) {
    return readPathWithSizeGuard(worktreePath, 'worktree');
  }
  if (!backup) return { kind: 'ok', content: '', exists: false };
  if (backup.backupFileName === null) {
    return { kind: 'ok', content: '', exists: false };
  }
  const backupPath = resolveBackupPath(backup.backupFileName, sessionId);
  return readPathWithSizeGuard(backupPath, 'backup');
}

/**
 * Stat-then-read against a single open file descriptor. Using `open()` +
 * `fstat()` + `readFile({ fd })` closes the TOCTOU window that a separate
 * `stat()` + `readFile()` pair would leave open: a concurrent `write_file`
 * appending to the same path between the two syscalls would otherwise grow
 * past `MAX_DIFF_SIZE_BYTES` and slip the OOM guard.
 *
 * Operating on the same inode also means the size we check matches the
 * bytes we read — Node's `readFile(fd)` reads the underlying file from
 * offset 0 regardless of how the path entry shifts in the meantime.
 */
async function readPathWithSizeGuard(
  path: string,
  kind: 'worktree' | 'backup',
): Promise<EndpointRead> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, 'r');
  } catch (e: unknown) {
    if (isENOENT(e)) {
      // Worktree: genuine deletion → absence. Backup: snapshot recorded a
      // file we can no longer find → unreadable (lying about an empty
      // before-state would synthesize a fake every-line-added hunk).
      if (kind === 'worktree') {
        return { kind: 'ok', content: '', exists: false };
      }
      return { kind: 'unreadable' };
    }
    debugLogger.error(`FileHistory: ${kind} open failed for ${path}: ${e}`);
    return { kind: 'unreadable' };
  }
  try {
    const st = await fh.stat();
    if (st.size > MAX_DIFF_SIZE_BYTES) {
      return { kind: 'oversized', exists: true };
    }
    try {
      const text = await fh.readFile('utf-8');
      return { kind: 'ok', content: text, exists: true };
    } catch (e: unknown) {
      debugLogger.error(`FileHistory: ${kind} read failed for ${path}: ${e}`);
      return { kind: 'unreadable' };
    }
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/**
 * Binary sniff. Scans both the head and the tail of the string so a long
 * text prefix can't bury a binary payload past the head window — git's
 * heuristic only looks at the head, which is sufficient when invoked on
 * file open but not when an attacker / faulty generator can craft mixed
 * inputs. Content past MAX_DIFF_SIZE_BYTES is already short-circuited as
 * `oversized` upstream, so this stays cheap.
 */
function looksBinary(content: string): boolean {
  const len = content.length;
  if (len === 0) return false;
  const headEnd = Math.min(len, BINARY_SNIFF_BYTES);
  for (let i = 0; i < headEnd; i++) {
    if (content.charCodeAt(i) === 0) return true;
  }
  if (len > BINARY_SNIFF_BYTES) {
    const tailStart = Math.max(headEnd, len - BINARY_SNIFF_BYTES);
    for (let i = tailStart; i < len; i++) {
      if (content.charCodeAt(i) === 0) return true;
    }
  }
  return false;
}

function countLines(text: string): number {
  if (text === '') return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) count++;
  }
  // A trailing newline already accounted for the final empty token; don't
  // double-count it as an extra line.
  if (text.charCodeAt(text.length - 1) === 10) count--;
  return count;
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
  private readonly onSnapshotUpdated?: FileHistorySnapshotRecorder;

  constructor(
    sessionId: string,
    enabled: boolean,
    cwd: string,
    onSnapshotUpdated?: FileHistorySnapshotRecorder,
  ) {
    this.sessionId = sessionId;
    this.enabled = enabled;
    this.cwd = cwd;
    this.onSnapshotUpdated = onSnapshotUpdated;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getSnapshots(): FileHistorySnapshot[] {
    return this.state.snapshots;
  }

  private recordSnapshotUpdate(snapshot: FileHistorySnapshot): void {
    try {
      this.onSnapshotUpdated?.(snapshot);
    } catch (error) {
      debugLogger.error(`FileHistory: recordSnapshotUpdate failed: ${error}`);
    }
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

  async validateRestoredSnapshots(): Promise<void> {
    // Collect unique backup file names to stat (dedup: many snapshots share
    // the same backup file via the inheritance optimization in makeSnapshot).
    const uniqueNames = new Set<string>();
    for (const snapshot of this.state.snapshots) {
      for (const backup of Object.values(snapshot.trackedFileBackups)) {
        if (backup.backupFileName !== null && !backup.failed) {
          uniqueNames.add(backup.backupFileName);
        }
      }
    }
    if (uniqueNames.size === 0) return;

    // Parallel stat with bounded concurrency to avoid fd exhaustion.
    const BATCH_SIZE = 200;
    const missing = new Set<string>();
    const names = [...uniqueNames];
    for (let i = 0; i < names.length; i += BATCH_SIZE) {
      const batch = names.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (name) => {
          let backupPath: string;
          try {
            backupPath = resolveBackupPath(name, this.sessionId);
          } catch (e) {
            debugLogger.error(
              `FileHistory: rejected backupFileName during validation: ${name}: ${e}`,
            );
            return false;
          }
          return await pathExists(backupPath);
        }),
      );
      for (let j = 0; j < batch.length; j++) {
        if (!results[j]) missing.add(batch[j]);
      }
    }

    if (missing.size === 0) return;

    // Single synchronous pass to mark failures — minimizes the mutation
    // window so concurrent makeSnapshot/trackEdit see a consistent state.
    const affectedSnapshots = new Set<FileHistorySnapshot>();
    for (const snapshot of this.state.snapshots) {
      for (const backup of Object.values(snapshot.trackedFileBackups)) {
        if (backup.backupFileName && missing.has(backup.backupFileName)) {
          backup.failed = true;
          affectedSnapshots.add(snapshot);
        }
      }
    }
    for (const snapshot of affectedSnapshots) {
      this.recordSnapshotUpdate(snapshot);
    }

    debugLogger.warn(
      `FileHistory: ${missing.size} restored backup file(s) missing on disk`,
    );
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
    if (!this.state.snapshots.includes(mostRecent)) {
      return;
    }

    // Allow overwriting a `failed` entry so the heal path actually
    // records the fresh backup (otherwise we'd leave the failed marker
    // in place even though we successfully captured the file).
    const current = mostRecent.trackedFileBackups[trackingPath];
    if (!current || current.failed) {
      mostRecent.trackedFileBackups[trackingPath] = backup;
      this.state.trackedFiles.add(trackingPath);
      this.recordSnapshotUpdate(mostRecent);
      debugLogger.debug(
        `FileHistory: Tracked file modification for ${filePath}`,
      );
    }
  }

  /**
   * Creates the next turn snapshot. Callers that need session persistence must
   * record `getSnapshots().at(-1)` after this resolves.
   */
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

  /**
   * Compute the file-level diff produced *during* the turn identified by
   * `promptId`. The turn's snapshot captures the workspace state at the
   * start of that turn (before any of its tool-driven edits), so:
   *   - "before" = this snapshot's backups
   *   - "after"  = the next snapshot's backups, or the live worktree if this
   *               is the most recent turn
   *
   * Only files whose backup pointer differs between the two endpoints (or
   * whose content differs in the most-recent-turn case) are returned.
   * Files that the snapshotter failed to capture are silently skipped:
   * we can't produce a meaningful per-turn diff without a known "before",
   * and surfacing a wrong hunk is worse than hiding the row.
   */
  async getTurnDiff(promptId: string): Promise<TurnDiff | undefined> {
    if (!this.enabled) return undefined;

    // `findSnapshotIndex` mirrors `findSnapshot`'s last-occurrence-wins
    // tie-break so `/rewind` and `/diff` agree on which snapshot a reused
    // promptId resolves to. In normal sessions promptIds are unique per
    // submission, so this is defensive.
    const targetIdx = this.findSnapshotIndex(promptId);
    if (targetIdx < 0) return undefined;

    const target = this.state.snapshots[targetIdx]!;
    const nextSnapshot =
      targetIdx + 1 < this.state.snapshots.length
        ? this.state.snapshots[targetIdx + 1]
        : undefined;

    // Candidates are restricted to files that target's snapshot actually
    // tracked. A file that first shows up in the *next* snapshot's backups
    // (because trackEdit added it during turn N+1) didn't change during
    // turn N — including it would either fast-path to no-op or, worse,
    // produce a phantom "new file" hunk attributed to the wrong turn.
    // `trackEdit` mutates `mostRecent` in place, so by the time we read
    // target.trackedFileBackups it already contains every file touched
    // during target's turn, including newly created or deleted ones.
    // Sort so the cap below is deterministic. `Object.keys` order is
    // spec-defined as insertion order for string keys, but sorting makes
    // the kept-vs-dropped split reproducible across runs that may insert
    // in different orders (e.g. a session resumed from disk vs. one that
    // grew live), which matters for both reviewer reproducibility and
    // for the truncation log line below.
    const candidatePaths = Object.keys(target.trackedFileBackups).sort((a, b) =>
      a.localeCompare(b),
    );

    // Cap concurrent file reads. Each candidate reads up to two backups,
    // so a 250-file turn would issue ~500 simultaneous opens — enough to
    // hit ulimit -n on common CI configurations. The cap is bounded by
    // the same constant the git path uses (MAX_FILES_FOR_DETAILS = 500
    // files total), with two reads each → 1000 open()s worst case, still
    // comfortably below the typical 4096 fd ceiling.
    const filesOmitted = Math.max(
      0,
      candidatePaths.length - MAX_TURN_DIFF_FILES,
    );
    if (filesOmitted > 0) {
      debugLogger.warn(
        `FileHistory: getTurnDiff truncating ${filesOmitted} files for prompt ${promptId} (cap: ${MAX_TURN_DIFF_FILES})`,
      );
    }
    const cappedPaths = candidatePaths.slice(0, MAX_TURN_DIFF_FILES);
    const results = await Promise.all(
      cappedPaths.map((trackingPath) =>
        this.computeTurnFileDiff(trackingPath, target, nextSnapshot),
      ),
    );

    const files: TurnFileDiff[] = [];
    let totalAdded = 0;
    let totalRemoved = 0;
    for (const r of results) {
      if (!r) continue;
      files.push(r);
      totalAdded += r.linesAdded;
      totalRemoved += r.linesRemoved;
    }
    files.sort((a, b) => a.filePath.localeCompare(b.filePath));

    return {
      promptId,
      timestamp: target.timestamp,
      files,
      stats: {
        filesChanged: files.length,
        linesAdded: totalAdded,
        linesRemoved: totalRemoved,
        filesOmitted,
      },
    };
  }

  private async computeTurnFileDiff(
    trackingPath: string,
    before: FileHistorySnapshot,
    after: FileHistorySnapshot | undefined,
  ): Promise<TurnFileDiff | null> {
    try {
      return await this.computeTurnFileDiffUnsafe(trackingPath, before, after);
    } catch (e) {
      // Per-file isolation: a structuredPatch crash, a transient read
      // error, anything thrown from a single candidate must not poison
      // the whole turn's Promise.all and silently erase every row.
      // Log + drop the row, surface the rest.
      debugLogger.error(
        `FileHistory: computeTurnFileDiff failed for ${trackingPath}: ${e}`,
      );
      return null;
    }
  }

  private async computeTurnFileDiffUnsafe(
    trackingPath: string,
    before: FileHistorySnapshot,
    after: FileHistorySnapshot | undefined,
  ): Promise<TurnFileDiff | null> {
    // `trackingPath` is repo-relative (or absolute for files outside cwd)
    // per `maybeShortenFilePath`; matches the convention `fetchGitDiff` uses
    // for the Current source so the dialog renders both consistently.
    // `absoluteFilePath` is used only for live-worktree I/O below.
    const absoluteFilePath = this.maybeExpandFilePath(trackingPath);

    const beforeBackup = before.trackedFileBackups[trackingPath];
    if (beforeBackup?.failed) return null;

    let afterBackup: FileHistoryBackup | undefined;
    let afterFromWorktree = false;
    if (after) {
      afterBackup = after.trackedFileBackups[trackingPath];
      if (afterBackup?.failed) return null;
    } else {
      afterFromWorktree = true;
    }

    // Fast path: when both endpoints point at the exact same backup file,
    // we know without reading anything that the file did not change during
    // this turn. `makeSnapshot` reuses unchanged backups verbatim, so this
    // skips the bulk of files in any long-running session.
    //
    // Guard: require `beforeBackup !== undefined`. With the current
    // candidatePaths construction (keys(target.trackedFileBackups) only)
    // both endpoints can never both be undefined for a real input, but
    // future refactors that broaden the candidate set should not let an
    // `undefined === undefined` match silently swallow a newly created
    // file as "unchanged".
    if (
      !afterFromWorktree &&
      beforeBackup !== undefined &&
      beforeBackup.backupFileName === afterBackup?.backupFileName &&
      beforeBackup.version === afterBackup?.version
    ) {
      return null;
    }

    const beforeRead = await readEndpointContent(
      beforeBackup,
      undefined,
      this.sessionId,
    );
    // A non-null backup name that fails to read means we cannot produce a
    // trustworthy "before" content — fabricating an empty string would
    // present every line as a fresh addition. Skip the row instead, but
    // log so a missing/permission-flipped backup leaves a trace.
    if (beforeRead.kind === 'unreadable') {
      debugLogger.warn(
        `FileHistory: skipping turn diff for ${trackingPath}: before backup unreadable`,
      );
      return null;
    }

    const afterRead = afterFromWorktree
      ? await readEndpointContent(undefined, absoluteFilePath, this.sessionId)
      : await readEndpointContent(afterBackup, undefined, this.sessionId);
    if (afterRead.kind === 'unreadable') {
      debugLogger.warn(
        `FileHistory: skipping turn diff for ${trackingPath}: after ${afterFromWorktree ? 'worktree' : 'backup'} unreadable`,
      );
      return null;
    }

    // Pre-read size guard tripped — either endpoint sits above the cap.
    // Bail before any content work so a 2 GB blob never lands in the heap;
    // we cannot compute precise +N/-M stats without reading, but the row
    // still shows up with the oversized badge and is treated correctly by
    // the dialog (Enter is gated, hint surfaces "use git diff"). The
    // discriminated union (.kind) lets tsc narrow `.exists` access without
    // any manual casts.
    if (beforeRead.kind === 'oversized' || afterRead.kind === 'oversized') {
      const beforeExists = beforeRead.exists;
      const afterExists = afterRead.exists;
      return {
        filePath: trackingPath,
        hunks: [],
        isNewFile: !beforeExists && afterExists,
        isDeleted: beforeExists && !afterExists,
        linesAdded: 0,
        linesRemoved: 0,
        oversized: true,
        isBinary: false,
      };
    }

    // Both endpoints now narrow to EndpointReadOk.
    const { content: beforeContent, exists: beforeExists } = beforeRead;
    const { content: afterContent, exists: afterExists } = afterRead;

    if (beforeContent === afterContent && beforeExists === afterExists) {
      return null;
    }

    // Binary sniff: scanning either endpoint catches changes against a
    // text→binary or binary→text flip. Feeding NUL-laced strings into
    // `structuredPatch` and then through `DiffRenderer` can produce
    // garbage output or hang the terminal, so surface them as a binary
    // row with no hunks (mirrors the git path's binary handling).
    const isBinary = looksBinary(beforeContent) || looksBinary(afterContent);
    if (isBinary) {
      return {
        filePath: trackingPath,
        hunks: [],
        isNewFile: !beforeExists && afterExists,
        isDeleted: beforeExists && !afterExists,
        linesAdded: 0,
        linesRemoved: 0,
        oversized: false,
        isBinary: true,
      };
    }

    // Cap the patch input to keep dialog memory bounded: a single 50MB
    // generated file should not allocate hundreds of MB of hunk strings
    // when `/diff` opens. Report the file with stats but no hunks; the
    // dialog renders an "(oversized — diff omitted)" tag for these.
    const oversized =
      Buffer.byteLength(beforeContent, 'utf8') > MAX_DIFF_SIZE_BYTES ||
      Buffer.byteLength(afterContent, 'utf8') > MAX_DIFF_SIZE_BYTES;

    if (oversized) {
      // Coarse line-count delta so the file row still shows a meaningful
      // `+N -M` summary. Counting newlines is O(n) but allocates nothing
      // extra past the strings we already hold.
      const beforeLines = beforeExists ? countLines(beforeContent) : 0;
      const afterLines = afterExists ? countLines(afterContent) : 0;
      return {
        filePath: trackingPath,
        hunks: [],
        isNewFile: !beforeExists && afterExists,
        isDeleted: beforeExists && !afterExists,
        linesAdded: Math.max(0, afterLines - beforeLines),
        linesRemoved: Math.max(0, beforeLines - afterLines),
        oversized: true,
        isBinary: false,
      };
    }

    const patch = structuredPatch(
      trackingPath,
      trackingPath,
      beforeContent,
      afterContent,
      '',
      '',
      { context: 3 },
    );

    let linesAdded = 0;
    let linesRemoved = 0;
    for (const h of patch.hunks) {
      for (const line of h.lines) {
        if (line.startsWith('+')) linesAdded++;
        else if (line.startsWith('-')) linesRemoved++;
      }
    }

    if (patch.hunks.length === 0 && linesAdded === 0 && linesRemoved === 0) {
      return null;
    }

    return {
      filePath: trackingPath,
      hunks: patch.hunks,
      isNewFile: !beforeExists && afterExists,
      isDeleted: beforeExists && !afterExists,
      linesAdded,
      linesRemoved,
      oversized: false,
      isBinary: false,
    };
  }

  private findSnapshot(promptId: string): FileHistorySnapshot | undefined {
    return this.state.snapshots[this.findSnapshotIndex(promptId)];
  }

  /** Same matching rule as `findSnapshot` (last occurrence wins) but
   *  returns the slot index so callers that need the neighbour snapshot
   *  (e.g. `getTurnDiff`) don't have to re-scan. Returns -1 on miss. */
  private findSnapshotIndex(promptId: string): number {
    for (let i = this.state.snapshots.length - 1; i >= 0; i--) {
      if (this.state.snapshots[i]!.promptId === promptId) {
        return i;
      }
    }
    return -1;
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
