/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { Content } from '@google/genai';
import type { Storage } from '../config/storage.js';
import { createDebugLogger, type DebugLogger } from '../utils/debugLogger.js';

const LOG_FILE_NAME = 'logs.json';

export enum MessageSenderType {
  USER = 'user',
  MODEL_SWITCH = 'model_switch',
}

export interface LogEntry {
  sessionId: string;
  messageId: number;
  timestamp: string;
  type: MessageSenderType;
  message: string;
}

export interface ModelSwitchEvent {
  fromModel: string;
  toModel: string;
  reason: 'vision_auto_switch' | 'manual' | 'fallback' | 'other';
  context?: string;
}

// This regex matches any character that is NOT a letter (a-z, A-Z),
// a number (0-9), a hyphen (-), an underscore (_), or a dot (.).

/**
 * Encodes a string to be safe for use as a filename.
 *
 * It replaces any characters that are not alphanumeric or one of `_`, `-`, `.`
 * with a URL-like percent-encoding (`%` followed by the 2-digit hex code).
 *
 * @param str The input string to encode.
 * @returns The encoded, filename-safe string.
 */
export function encodeTagName(str: string): string {
  return encodeURIComponent(str);
}

/**
 * Decodes a string that was encoded with the `encode` function.
 *
 * It finds any percent-encoded characters and converts them back to their
 * original representation.
 *
 * @param str The encoded string to decode.
 * @returns The decoded, original string.
 */
export function decodeTagName(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch (_e) {
    // Fallback for old, potentially malformed encoding
    return str.replace(/%([0-9A-F]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  }
}

export class Logger {
  private qwenDir: string | undefined;
  private logFilePath: string | undefined;
  private sessionId: string | undefined;
  private messageId = 0; // Instance-specific counter for the next messageId
  private initialized = false;
  private logs: LogEntry[] = []; // In-memory cache, ideally reflects the last known state of the file
  private lastLoggedUserEntry: LogEntry | null = null; // Tracks the most recently persisted USER entry for cancel-undo (mirrors claude-code's lastAddedEntry).
  // Per-instance write queue for the log-history file (logs.json).
  // Only `logMessage` and `removeLastUserMessage` chain on this queue;
  // their read → splice/append → writeFile cycle is otherwise non-atomic
  // and a fast cancel + resubmit could make removeLast clobber the
  // just-appended entry. Checkpoint ops (saveCheckpoint /
  // deleteCheckpoint / loadCheckpoint) write to *separate* files and are
  // intentionally not serialized on this queue.
  private writeQueue: Promise<unknown> = Promise.resolve();
  private debugLogger: DebugLogger;

  constructor(
    sessionId: string,
    private readonly storage: Storage,
  ) {
    this.sessionId = sessionId;
    this.debugLogger = createDebugLogger('LOGGER');
  }

  /**
   * Serializes a log-history mutation against every previously enqueued
   * op on this Logger. Errors propagate to the caller but do NOT poison
   * the queue (the next op runs regardless). Scope: only `logMessage`
   * and `removeLastUserMessage` go through here — checkpoint ops touch
   * separate files and don't share this queue. Single-instance only:
   * a separate Logger pointing at the same file would have its own
   * queue, which is why callers should share one Logger per session.
   */
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    // The queue's tail is always sourced from `.catch(() => undefined)`
    // below, so writeQueue never rejects — `.then(op)` is sufficient and
    // the earlier `then(op, op)` would have wrongly implied "retry op on
    // rejection". `op`'s return Promise is what propagates to the
    // caller; the queue itself swallows errors so subsequent ops run
    // regardless of any earlier failure.
    const next = this.writeQueue.then(() => op());
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async _readLogFile(): Promise<LogEntry[]> {
    if (!this.logFilePath) {
      throw new Error('Log file path not set during read attempt.');
    }
    try {
      const fileContent = await fs.readFile(this.logFilePath, 'utf-8');
      const parsedLogs = JSON.parse(fileContent);
      if (!Array.isArray(parsedLogs)) {
        this.debugLogger.debug(
          `Log file at ${this.logFilePath} is not a valid JSON array. Starting with empty logs.`,
        );
        await this._backupCorruptedLogFile('malformed_array');
        return [];
      }
      return parsedLogs.filter(
        (entry) =>
          typeof entry.sessionId === 'string' &&
          typeof entry.messageId === 'number' &&
          typeof entry.timestamp === 'string' &&
          typeof entry.type === 'string' &&
          typeof entry.message === 'string',
      ) as LogEntry[];
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return [];
      }
      if (error instanceof SyntaxError) {
        this.debugLogger.debug(
          `Invalid JSON in log file ${this.logFilePath}. Backing up and starting fresh.`,
          error,
        );
        await this._backupCorruptedLogFile('invalid_json');
        return [];
      }
      this.debugLogger.debug(
        `Failed to read or parse log file ${this.logFilePath}:`,
        error,
      );
      throw error;
    }
  }

  private async _backupCorruptedLogFile(reason: string): Promise<void> {
    if (!this.logFilePath) return;
    const backupPath = `${this.logFilePath}.${reason}.${Date.now()}.bak`;
    try {
      await fs.rename(this.logFilePath, backupPath);
      this.debugLogger.debug(`Backed up corrupted log file to ${backupPath}`);
    } catch (_backupError) {
      // If rename fails (e.g. file doesn't exist), no need to log an error here as the primary error (e.g. invalid JSON) is already handled.
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.qwenDir = this.storage.getProjectTempDir();
    this.logFilePath = path.join(this.qwenDir, LOG_FILE_NAME);

    try {
      await fs.mkdir(this.qwenDir, { recursive: true });
      let fileExisted = true;
      try {
        await fs.access(this.logFilePath);
      } catch (_e) {
        fileExisted = false;
      }
      this.logs = await this._readLogFile();
      if (!fileExisted && this.logs.length === 0) {
        await fs.writeFile(this.logFilePath, '[]', 'utf-8');
      }
      const sessionLogs = this.logs.filter(
        (entry) => entry.sessionId === this.sessionId,
      );
      this.messageId =
        sessionLogs.length > 0
          ? Math.max(...sessionLogs.map((entry) => entry.messageId)) + 1
          : 0;
      this.initialized = true;
    } catch (err) {
      this.debugLogger.error('Failed to initialize logger:', err);
      this.initialized = false;
    }
  }

  private async _updateLogFile(
    entryToAppend: LogEntry,
  ): Promise<LogEntry | null> {
    if (!this.logFilePath) {
      this.debugLogger.debug(
        'Log file path not set. Cannot persist log entry.',
      );
      throw new Error('Log file path not set during update attempt.');
    }

    let currentLogsOnDisk: LogEntry[];
    try {
      currentLogsOnDisk = await this._readLogFile();
    } catch (readError) {
      this.debugLogger.debug(
        'Critical error reading log file before append:',
        readError,
      );
      throw readError;
    }

    // Determine the correct messageId for the new entry based on current disk state for its session
    const sessionLogsOnDisk = currentLogsOnDisk.filter(
      (e) => e.sessionId === entryToAppend.sessionId,
    );
    const nextMessageIdForSession =
      sessionLogsOnDisk.length > 0
        ? Math.max(...sessionLogsOnDisk.map((e) => e.messageId)) + 1
        : 0;

    // Update the messageId of the entry we are about to append
    entryToAppend.messageId = nextMessageIdForSession;

    // Check if this entry (same session, same *recalculated* messageId, same content) might already exist
    // This is a stricter check for true duplicates if multiple instances try to log the exact same thing
    // at the exact same calculated messageId slot.
    const entryExists = currentLogsOnDisk.some(
      (e) =>
        e.sessionId === entryToAppend.sessionId &&
        e.messageId === entryToAppend.messageId &&
        e.timestamp === entryToAppend.timestamp && // Timestamps are good for distinguishing
        e.message === entryToAppend.message,
    );

    if (entryExists) {
      this.debugLogger.debug(
        `Duplicate log entry detected and skipped: session ${entryToAppend.sessionId}, messageId ${entryToAppend.messageId}`,
      );
      this.logs = currentLogsOnDisk; // Ensure in-memory is synced with disk
      return null; // Indicate that no new entry was actually added
    }

    currentLogsOnDisk.push(entryToAppend);

    try {
      await fs.writeFile(
        this.logFilePath,
        JSON.stringify(currentLogsOnDisk, null, 2),
        'utf-8',
      );
      this.logs = currentLogsOnDisk;
      return entryToAppend; // Return the successfully appended entry
    } catch (error) {
      this.debugLogger.debug('Error writing to log file:', error);
      throw error;
    }
  }

  async getPreviousUserMessages(): Promise<string[]> {
    if (!this.initialized) return [];
    return this.logs
      .filter((entry) => entry.type === MessageSenderType.USER)
      .sort((a, b) => {
        const dateA = new Date(a.timestamp).getTime();
        const dateB = new Date(b.timestamp).getTime();
        return dateB - dateA;
      })
      .map((entry) => entry.message);
  }

  async logMessage(type: MessageSenderType, message: string): Promise<void> {
    if (!this.initialized || this.sessionId === undefined) {
      this.debugLogger.debug(
        'Logger not initialized or session ID missing. Cannot log message.',
      );
      return;
    }

    // The messageId used here is the instance's idea of the next ID.
    // _updateLogFile will verify and potentially recalculate based on the file's actual state.
    const newEntryObject: LogEntry = {
      sessionId: this.sessionId,
      messageId: this.messageId, // This will be recalculated in _updateLogFile
      type,
      message,
      timestamp: new Date().toISOString(),
    };

    try {
      const writtenEntry = await this.serialize(() =>
        this._updateLogFile(newEntryObject),
      );
      if (writtenEntry) {
        // If an entry was actually written (not a duplicate skip),
        // then this instance can increment its idea of the next messageId for this session.
        this.messageId = writtenEntry.messageId + 1;
        if (writtenEntry.type === MessageSenderType.USER) {
          this.lastLoggedUserEntry = writtenEntry;
        }
      } else if (type === MessageSenderType.USER) {
        // Duplicate-skip path: another logger instance won the race and
        // wrote an entry with the same (sessionId, messageId, timestamp,
        // message). `_updateLogFile` mutated `newEntryObject.messageId`
        // in-place to match disk, so the 5-tuple identifies the row that
        // IS on disk — adopt it as the undo target. Leaving the tracker
        // pointing at the previous USER would let cancel/auto-restore
        // delete an older, unrelated row.
        this.lastLoggedUserEntry = newEntryObject;
      }
    } catch (_error) {
      // Persist failed. Only invalidate the undo tracker when the FAILED
      // attempt was itself a USER write — that's the case where the
      // tracker would otherwise lie about the most recent user entry
      // (logMessage("A" USER) succeeds, logMessage("B" USER) throws,
      // user cancels B → without this guard removeLastUserMessage would
      // delete A's row). A failed non-USER write (e.g., MODEL_SWITCH
      // disk error) doesn't change which row was the last user prompt,
      // so leave the tracker alone — the prior USER undo target is
      // still valid.
      if (type === MessageSenderType.USER) {
        this.lastLoggedUserEntry = null;
      }
      // Error already logged by _updateLogFile or _readLogFile
    }
  }

  /**
   * Undo the most recent {@link logMessage} call for a USER entry — used by
   * the auto-restore-on-cancel flow when the user hits ESC right after submit
   * and the model produced nothing meaningful. Without this, the cancelled
   * prompt would still surface in cross-session ↑-history via
   * {@link getPreviousUserMessages}.
   *
   * Mirrors claude-code's `removeLastFromHistory` (history.ts): one-shot,
   * clears the tracked entry so a second call is a no-op. Identifies the
   * entry by sessionId+messageId+timestamp+message so a stray race that
   * appended a different entry between log and undo will not silently
   * remove the wrong row.
   *
   * Two-phase semantics:
   *   1. Synchronous in-memory removal of the entry from `this.logs` —
   *      runs before this method even returns its Promise. Consumers
   *      that read `getPreviousUserMessages()` on the same render
   *      observe the removal immediately.
   *   2. Async serialized disk reconciliation — read, splice, writeFile.
   *      The returned Promise resolves to whether *the disk write*
   *      succeeded (not whether the in-memory removal happened).
   *
   * Failure handling: when the disk read or write THROWS, the optimistic
   * in-memory removal is ROLLED BACK so the cache stays consistent with
   * what's on disk (which is still the pre-call state). The target entry
   * is re-inserted at its original index (when still absent) and
   * `lastLoggedUserEntry` is restored so a follow-up retry has a target.
   *
   * The other `false`-returning paths intentionally do NOT roll back:
   *   - Initial guards (logger uninitialized / no tracked entry):
   *     nothing was removed in the first place, so nothing to restore.
   *   - Disk read succeeds but the tracked row is no longer on disk
   *     (e.g. another logger instance rotated/cleared the file): the
   *     in-memory cache is re-synced to the fresh disk snapshot, so
   *     both sides agree the entry is gone. Returning `false` here is
   *     truthful — we didn't perform a write — but the entry will NOT
   *     be observable in-memory either.
   *
   * @returns true when the disk row was actually removed; false otherwise.
   *   On `false`, the in-memory cache mirrors disk (entry restored if a
   *   disk op threw; entry stays gone if disk no longer had it).
   */
  async removeLastUserMessage(): Promise<boolean> {
    if (!this.initialized || !this.logFilePath) {
      return false;
    }
    const target = this.lastLoggedUserEntry;
    if (!target) return false;
    this.lastLoggedUserEntry = null;
    const matchesTarget = (e: LogEntry): boolean =>
      e.sessionId === target.sessionId &&
      e.messageId === target.messageId &&
      e.timestamp === target.timestamp &&
      e.message === target.message &&
      e.type === target.type;
    // Optimistic in-memory removal BEFORE the async serialize queue runs.
    // AppContainer's userMessages effect reads `getPreviousUserMessages()`
    // (which reads `this.logs`) on the same render that history truncation
    // fires. Without this sync update, ↑-history in the current session
    // would still surface the cancelled prompt until some unrelated
    // future history change forced the effect to re-run.
    //
    // If the disk path fails (read or write), restore the removed entry
    // from the snapshot so the in-memory state stays consistent with
    // disk — without rollback the caller gets `false` but the in-memory
    // logs show the entry already removed, contract-violating drift.
    const optimisticIdx = this.logs.findIndex(matchesTarget);
    if (optimisticIdx >= 0) {
      this.logs = [
        ...this.logs.slice(0, optimisticIdx),
        ...this.logs.slice(optimisticIdx + 1),
      ];
    }
    const restoreOptimistic = () => {
      // Restore the removed entry back into `this.logs` if (a) we
      // actually performed the optimistic removal AND (b) the entry
      // is no longer present (i.e. concurrent code didn't re-add it
      // by some other path). Re-insert at the original index when
      // possible, otherwise append (insertion order isn't a
      // load-bearing invariant downstream — `getPreviousUserMessages`
      // sorts by timestamp / index).
      if (optimisticIdx >= 0 && this.logs.findIndex(matchesTarget) === -1) {
        const insertAt = Math.min(optimisticIdx, this.logs.length);
        this.logs = [
          ...this.logs.slice(0, insertAt),
          target,
          ...this.logs.slice(insertAt),
        ];
      }
      // Always restore `lastLoggedUserEntry` so a follow-up retry has
      // a target to find. (This survives reentrant retry but doesn't
      // resurrect a target that another path legitimately replaced.)
      if (this.lastLoggedUserEntry === null) {
        this.lastLoggedUserEntry = target;
      }
    };
    const logFilePath = this.logFilePath;
    return this.serialize(async () => {
      let currentLogsOnDisk: LogEntry[];
      try {
        currentLogsOnDisk = await this._readLogFile();
      } catch (error) {
        this.debugLogger.debug(
          'Failed to read log file while undoing last user entry:',
          error,
        );
        restoreOptimistic();
        return false;
      }

      const idx = currentLogsOnDisk.findIndex(matchesTarget);
      if (idx === -1) {
        // Entry already gone from disk (concurrent rotation/clear).
        // Adopt disk state as truth so the in-memory cache doesn't
        // diverge from a freshly-rotated file.
        this.logs = currentLogsOnDisk;
        return false;
      }

      currentLogsOnDisk.splice(idx, 1);

      try {
        await fs.writeFile(
          logFilePath,
          JSON.stringify(currentLogsOnDisk, null, 2),
          'utf-8',
        );
        this.logs = currentLogsOnDisk;
        // Roll back this instance's nextMessageId so a subsequent log doesn't
        // skip the freed slot (matters for tests that assert sequential ids).
        if (
          target.sessionId === this.sessionId &&
          this.messageId === target.messageId + 1
        ) {
          this.messageId = target.messageId;
        }
        return true;
      } catch (error) {
        this.debugLogger.debug(
          'Failed to write log file while undoing last user entry:',
          error,
        );
        restoreOptimistic();
        return false;
      }
    });
  }

  private _checkpointPath(tag: string): string {
    if (!tag.length) {
      throw new Error('No checkpoint tag specified.');
    }
    if (!this.qwenDir) {
      throw new Error('Checkpoint file path not set.');
    }
    // Encode the tag to handle all special characters safely.
    const encodedTag = encodeTagName(tag);
    return path.join(this.qwenDir, `checkpoint-${encodedTag}.json`);
  }

  private async _getCheckpointPath(tag: string): Promise<string> {
    // 1. Check for the new encoded path first.
    const newPath = this._checkpointPath(tag);
    try {
      await fs.access(newPath);
      return newPath; // Found it, use the new path.
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        throw error; // A real error occurred, rethrow it.
      }
      // It was not found, so we'll check the old path next.
    }

    // 2. Fallback for backward compatibility: check for the old raw path.
    const oldPath = path.join(this.qwenDir!, `checkpoint-${tag}.json`);
    try {
      await fs.access(oldPath);
      return oldPath; // Found it, use the old path.
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        throw error; // A real error occurred, rethrow it.
      }
    }

    // 3. If neither path exists, return the new encoded path as the canonical one.
    return newPath;
  }

  async saveCheckpoint(conversation: Content[], tag: string): Promise<void> {
    if (!this.initialized) {
      this.debugLogger.error(
        'Logger not initialized or checkpoint file path not set. Cannot save a checkpoint.',
      );
      return;
    }
    // Always save with the new encoded path.
    const path = this._checkpointPath(tag);
    try {
      await fs.writeFile(path, JSON.stringify(conversation, null, 2), 'utf-8');
    } catch (error) {
      this.debugLogger.error('Error writing to checkpoint file:', error);
    }
  }

  async loadCheckpoint(tag: string): Promise<Content[]> {
    if (!this.initialized) {
      this.debugLogger.error(
        'Logger not initialized or checkpoint file path not set. Cannot load checkpoint.',
      );
      return [];
    }

    const path = await this._getCheckpointPath(tag);
    try {
      const fileContent = await fs.readFile(path, 'utf-8');
      const parsedContent = JSON.parse(fileContent);
      if (!Array.isArray(parsedContent)) {
        this.debugLogger.warn(
          `Checkpoint file at ${path} is not a valid JSON array. Returning empty checkpoint.`,
        );
        return [];
      }
      return parsedContent as Content[];
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        // This is okay, it just means the checkpoint doesn't exist in either format.
        return [];
      }
      this.debugLogger.error(
        `Failed to read or parse checkpoint file ${path}:`,
        error,
      );
      return [];
    }
  }

  async deleteCheckpoint(tag: string): Promise<boolean> {
    if (!this.initialized || !this.qwenDir) {
      this.debugLogger.error(
        'Logger not initialized or checkpoint file path not set. Cannot delete checkpoint.',
      );
      return false;
    }

    let deletedSomething = false;

    // 1. Attempt to delete the new encoded path.
    const newPath = this._checkpointPath(tag);
    try {
      await fs.unlink(newPath);
      deletedSomething = true;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT') {
        this.debugLogger.error(
          `Failed to delete checkpoint file ${newPath}:`,
          error,
        );
        throw error; // Rethrow unexpected errors
      }
      // It's okay if it doesn't exist.
    }

    // 2. Attempt to delete the old raw path for backward compatibility.
    const oldPath = path.join(this.qwenDir!, `checkpoint-${tag}.json`);
    if (newPath !== oldPath) {
      try {
        await fs.unlink(oldPath);
        deletedSomething = true;
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== 'ENOENT') {
          this.debugLogger.error(
            `Failed to delete checkpoint file ${oldPath}:`,
            error,
          );
          throw error; // Rethrow unexpected errors
        }
        // It's okay if it doesn't exist.
      }
    }

    return deletedSomething;
  }

  async checkpointExists(tag: string): Promise<boolean> {
    if (!this.initialized) {
      throw new Error(
        'Logger not initialized. Cannot check for checkpoint existence.',
      );
    }
    let filePath: string | undefined;
    try {
      filePath = await this._getCheckpointPath(tag);
      // We need to check for existence again, because _getCheckpointPath
      // returns a canonical path even if it doesn't exist yet.
      await fs.access(filePath);
      return true;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'ENOENT') {
        return false; // It truly doesn't exist in either format.
      }
      // A different error occurred.
      this.debugLogger.error(
        `Failed to check checkpoint existence for ${
          filePath ?? `path for tag "${tag}"`
        }:`,
        error,
      );
      throw error;
    }
  }

  close(): void {
    this.initialized = false;
    this.logFilePath = undefined;
    this.logs = [];
    this.lastLoggedUserEntry = null;
    this.writeQueue = Promise.resolve();
    this.sessionId = undefined;
    this.messageId = 0;
  }
}
