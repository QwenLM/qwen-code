/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single source of truth for a shell command's output.
 *
 * Supports two modes:
 * - **File mode** (bash commands): stdout/stderr go directly to a file via
 *   stdio fds — neither enters JS. Progress is extracted by polling the file tail.
 * - **Pipe mode** (hooks): data flows through writeStdout()/writeStderr() and is
 *   buffered in memory, spilling to disk if it exceeds the limit.
 */

import { CircularBuffer } from '../CircularBuffer.js';
import { readFileRange, tailFile } from '../fsOperations.js';
import { DiskTaskOutput, getTaskOutputPath } from './diskOutput.js';
import { runLogger } from '../runLogger.js';
import { SHELL_INLINE_OUTPUT_MAX_BYTES } from '../shellOutputPolicy.js';

const DEFAULT_MAX_MEMORY = 8 * 1024 * 1024; // 8MB
const POLL_INTERVAL_MS = 1000;
export const PROGRESS_TAIL_BYTES = 4096;

/** Default max bytes to read from output file. */
export const DEFAULT_MAX_OUTPUT_BYTES = SHELL_INLINE_OUTPUT_MAX_BYTES;

export type ProgressCallback = (
  lastLines: string,
  allLines: string,
  totalLines: number,
  totalBytes: number,
  isIncomplete: boolean,
  exactTotalLines?: number,
) => void;

export class TaskOutput {
  readonly taskId: string;
  readonly path: string;
  /** True when stdout goes to a file fd (bypassing JS). False for pipe mode. */
  readonly stdoutToFile: boolean;
  #stdoutBuffer = '';
  #stderrBuffer = '';
  #disk: DiskTaskOutput | null = null;
  #recentLines = new CircularBuffer<string>(1000);
  #totalLines = 0;
  #exactLineCounting = false;
  #countedBytes = 0;
  #countedNewlines = 0;
  #endsWithNewline = true;
  #polling = false;
  #totalBytes = 0;
  #maxMemory: number;
  #onProgress: ProgressCallback | null;
  #onStdout: ((chunk: string) => void) | null;
  #persistToDisk: boolean;
  /** Set by getStdout() — true when the file was fully read. */
  #outputFileRedundant = false;
  /** Set by getStdout() — total file size in bytes. */
  #outputFileSize = 0;

  // --- Shared poller state ---

  /** Registry of all file-mode TaskOutput instances with onProgress callbacks. */
  static #registry = new Map<string, TaskOutput>();
  /** Subset of #registry currently being polled. */
  static #activePolling = new Map<string, TaskOutput>();
  static #pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    taskId: string,
    onProgress: ProgressCallback | null,
    stdoutToFile = false,
    maxMemory: number = DEFAULT_MAX_MEMORY,
    onStdout: ((chunk: string) => void) | null = null,
    persistToDisk = false,
  ) {
    this.taskId = taskId;
    this.path = getTaskOutputPath(taskId);
    this.stdoutToFile = stdoutToFile;
    this.#maxMemory = maxMemory;
    this.#onProgress = onProgress;
    this.#onStdout = onStdout;
    this.#persistToDisk = persistToDisk;
    if (persistToDisk) {
      this.#disk = new DiskTaskOutput(taskId);
    }

    // Register for polling when stdout goes to a file and progress is needed.
    if (stdoutToFile && onProgress) {
      TaskOutput.#registry.set(taskId, this);
    }
  }

  /**
   * Begin polling the output file for progress. Called from React
   * useEffect when the progress component mounts.
   */
  static startPolling(taskId: string): void {
    const instance = TaskOutput.#registry.get(taskId);
    if (!instance || !instance.#onProgress) {
      runLogger.debug(
        `[TaskOutput] startPolling: taskId=${taskId} skipped (no instance or onProgress)`,
      );
      return;
    }
    runLogger.debug(
      `[TaskOutput] startPolling: taskId=${taskId}, path=${instance.path}`,
    );
    TaskOutput.#activePolling.set(taskId, instance);
    if (!TaskOutput.#pollInterval) {
      TaskOutput.#pollInterval = setInterval(
        TaskOutput.#tick,
        POLL_INTERVAL_MS,
      );
      TaskOutput.#pollInterval.unref();
    }
  }

  /**
   * Stop polling the output file. Called from React useEffect cleanup.
   */
  static stopPolling(taskId: string): void {
    runLogger.debug(
      `[TaskOutput] stopPolling: taskId=${taskId}, remaining=${TaskOutput.#activePolling.size - 1}`,
    );
    TaskOutput.#activePolling.delete(taskId);
    if (TaskOutput.#activePolling.size === 0 && TaskOutput.#pollInterval) {
      clearInterval(TaskOutput.#pollInterval);
      TaskOutput.#pollInterval = null;
    }
  }

  /**
   * Shared tick: reads the file tail for every actively-polled task.
   * Non-async body (.then) to avoid stacking if I/O is slow.
   */
  static #tickCount = 0;
  static #tick(): void {
    TaskOutput.#tickCount++;
    if (TaskOutput.#tickCount % 10 === 0 && runLogger.isDebugEnabled) {
      runLogger.debug(
        `[TaskOutput] tick #${TaskOutput.#tickCount}, activePolling=${TaskOutput.#activePolling.size}, tasks=[${[...TaskOutput.#activePolling.keys()].join(',')}]`,
      );
    }
    for (const [, entry] of TaskOutput.#activePolling) {
      if (!entry.#onProgress || entry.#polling) {
        continue;
      }
      entry.#polling = true;
      void tailFile(entry.path, PROGRESS_TAIL_BYTES).then(
        async ({ content, bytesRead, bytesTotal }) => {
          if (!entry.#onProgress) {
            return;
          }
          if (!content) {
            entry.#onProgress('', '', entry.#totalLines, bytesTotal, false);
            return;
          }
          // Reverse-scan logical lines once: count them and locate the last 5
          // and last 100. A trailing newline terminates the final line; it
          // must not create an extra empty line in the progress count.
          let pos = content.endsWith('\n') ? content.length - 1 : content.length;
          let n5 = 0;
          let n100 = 0;
          let linesSeen = 0;
          while (pos > 0) {
            const newline = content.lastIndexOf('\n', pos - 1);
            linesSeen++;
            if (linesSeen === 5) n5 = newline < 0 ? 0 : newline + 1;
            if (linesSeen === 100) n100 = newline < 0 ? 0 : newline + 1;
            if (newline < 0) break;
            pos = newline;
          }
          if (bytesRead >= bytesTotal && pos === 0 && content.startsWith('\n')) linesSeen++;
          // Keep the historical tail-only estimate for existing consumers.
          const estimatedLines = bytesRead >= bytesTotal ? linesSeen
            : Math.max(entry.#totalLines, Math.round(bytesTotal / bytesRead * linesSeen));
          const exactTotalLines = entry.#exactLineCounting
            ? await entry.#countFileLines(bytesTotal) : undefined;
          const totalLines = exactTotalLines ?? estimatedLines;
          entry.#totalLines = totalLines;
          entry.#totalBytes = bytesTotal;
          entry.#onProgress?.(
            content.slice(n5),
            content.slice(n100),
            totalLines,
            bytesTotal,
            bytesRead < bytesTotal,
            exactTotalLines,
          );
        },
        () => {
          // File may not exist yet
        },
      ).catch(() => {
        // A completed foreground command may already have moved its log.
      }).finally(() => { entry.#polling = false; });
    }
  }

  get exactLineCountingEnabled(): boolean {
    return this.#exactLineCounting;
  }

  setExactLineCounting(enabled: boolean): void {
    this.#exactLineCounting = enabled;
  }

  async #countFileLines(size: number): Promise<number | undefined> {
    if (size < this.#countedBytes) {
      this.#countedBytes = 0;
      this.#countedNewlines = 0;
      this.#endsWithNewline = true;
    }
    // Bound each poll to 1 MiB. Publish the tail even when counting is behind;
    // the optional exact total remains unknown until this snapshot is covered.
    const limit = Math.min(size, this.#countedBytes + 1024 * 1024);
    while (this.#exactLineCounting && this.#countedBytes < limit) {
      const chunk = await readFileRange(this.path, this.#countedBytes,
        Math.min(64 * 1024, limit - this.#countedBytes));
      if (!chunk?.bytesRead) throw new Error('Output changed while counting lines');
      for (let i = 0; i < chunk.content.length; i++) {
        if (chunk.content.charCodeAt(i) === 10) this.#countedNewlines++;
      }
      this.#countedBytes += chunk.bytesRead;
      this.#endsWithNewline = chunk.content.endsWith('\n');
    }
    if (!this.#exactLineCounting || this.#countedBytes < size) return undefined;
    return this.#countedNewlines + (size > 0 && !this.#endsWithNewline ? 1 : 0);
  }

  /** Write stdout data (pipe mode only). */
  writeStdout(data: string): void {
    this.#onStdout?.(data);
    this.#writeBuffered(data, false);
  }

  /** Write stderr data (always piped). */
  writeStderr(data: string): void {
    this.#writeBuffered(data, true);
  }

  #writeBuffered(data: string, isStderr: boolean): void {
    this.#totalBytes += data.length;

    this.#updateProgress(data);

    // Write to disk if already overflowed
    if (this.#disk) {
      this.#disk.append(isStderr ? `[stderr] ${data}` : data);
      return;
    }

    // Check if this chunk would exceed the in-memory limit
    const totalMem =
      this.#stdoutBuffer.length + this.#stderrBuffer.length + data.length;
    if (totalMem > this.#maxMemory) {
      this.#spillToDisk(isStderr ? data : null, isStderr ? null : data);
      return;
    }

    if (isStderr) {
      this.#stderrBuffer += data;
    } else {
      this.#stdoutBuffer += data;
    }
  }

  /**
   * Single backward pass: count all newlines (for totalLines) and extract
   * the last few lines as flat copies (for the CircularBuffer / progress).
   * Only used in pipe mode. File mode uses the shared poller.
   */
  #updateProgress(data: string): void {
    const MAX_PROGRESS_BYTES = 4096;
    const MAX_PROGRESS_LINES = 100;

    let lineCount = 0;
    const lines: string[] = [];
    let extractedBytes = 0;
    let pos = data.length;

    while (pos > 0) {
      const prev = data.lastIndexOf('\n', pos - 1);
      if (prev === -1) {
        break;
      }
      lineCount++;
      if (
        lines.length < MAX_PROGRESS_LINES &&
        extractedBytes < MAX_PROGRESS_BYTES
      ) {
        const lineLen = pos - prev - 1;
        if (lineLen > 0 && lineLen <= MAX_PROGRESS_BYTES - extractedBytes) {
          const line = data.slice(prev + 1, pos);
          if (line.trim()) {
            // Break SlicedString reference
            lines.push(Buffer.from(line).toString());
            extractedBytes += lineLen;
          }
        }
      }
      pos = prev;
    }

    this.#totalLines += lineCount;

    for (let i = lines.length - 1; i >= 0; i--) {
      this.#recentLines.add(lines[i]);
    }

    if (this.#onProgress && lines.length > 0) {
      const recent = this.#recentLines.getRecent(5);
      this.#onProgress(
        recent.join('\n'),
        this.#recentLines.getRecent(100).join('\n'),
        this.#totalLines,
        this.#totalBytes,
        this.#disk !== null,
      );
    }
  }

  #spillToDisk(stderrChunk: string | null, stdoutChunk: string | null): void {
    this.#disk = new DiskTaskOutput(this.taskId);

    // Flush existing buffers
    if (this.#stdoutBuffer) {
      this.#disk.append(this.#stdoutBuffer);
      this.#stdoutBuffer = '';
    }
    if (this.#stderrBuffer) {
      this.#disk.append(`[stderr] ${this.#stderrBuffer}`);
      this.#stderrBuffer = '';
    }

    // Write the chunk that triggered overflow
    if (stdoutChunk) {
      this.#disk.append(stdoutChunk);
    }
    if (stderrChunk) {
      this.#disk.append(`[stderr] ${stderrChunk}`);
    }
  }

  /**
   * Get stdout. In file mode, reads from the output file.
   * In pipe mode, returns the in-memory buffer or tail from CircularBuffer.
   */
  async getStdout(maxBytes?: number): Promise<string> {
    if (this.stdoutToFile) {
      return this.#readStdoutFromFile(maxBytes);
    }
    if (this.#persistToDisk) {
      await this.flush();
      return this.#readStdoutFromFile(maxBytes);
    }
    // Pipe mode — use in-memory data
    if (this.#disk) {
      const recent = this.#recentLines.getRecent(5);
      const tail = recent.join('\n');
      const sizeKB = Math.round(this.#totalBytes / 1024);
      const notice = `\nOutput truncated (${sizeKB}KB total). Full output saved to: ${this.path}`;
      return tail ? tail + notice : notice.trimStart();
    }
    return this.#stdoutBuffer;
  }

  async #readStdoutFromFile(maxBytes?: number): Promise<string> {
    const max = maxBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    try {
      const result = await readFileRange(this.path, 0, max);
      if (!result) {
        this.#outputFileRedundant = true;
        return '';
      }
      const { content, bytesRead, bytesTotal } = result;
      this.#outputFileSize = bytesTotal;
      this.#outputFileRedundant = bytesTotal <= bytesRead;
      return content;
    } catch (error) {
      const errorCode =
        error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : 'unknown';
      runLogger.warn(
        `[TaskOutput] failed to read output file: taskId=${this.taskId}, ` +
          `path=${this.path}, code=${errorCode}`,
        error,
      );
      return `<bash output unavailable: output file ${this.path} could not be read>`;
    }
  }

  /** Sync getter for stderr. */
  getStderr(): string {
    if (this.#disk) {
      return '';
    }
    return this.#stderrBuffer;
  }

  get isOverflowed(): boolean {
    return this.#disk !== null;
  }

  get totalLines(): number {
    return this.#totalLines;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  /**
   * True after getStdout() when the output file was fully read.
   */
  get outputFileRedundant(): boolean {
    return this.#outputFileRedundant;
  }

  /** Total file size in bytes, set after getStdout() reads the file. */
  get outputFileSize(): number {
    return this.#outputFileSize;
  }

  /** Force all buffered content to disk. Call when backgrounding. */
  spillToDisk(): void {
    if (!this.#disk) {
      this.#spillToDisk(null, null);
    }
  }

  async flush(): Promise<void> {
    await this.#disk?.flush();
  }

  /** Delete the output file (fire-and-forget safe). */
  async deleteOutputFile(): Promise<void> {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(this.path);
    } catch {
      // File may already be deleted
    }
  }

  clear(): void {
    this.#exactLineCounting = false;
    this.#stdoutBuffer = '';
    this.#stderrBuffer = '';
    this.#recentLines.clear();
    this.#onProgress = null;
    this.#onStdout = null;
    this.#disk?.cancel();
    TaskOutput.stopPolling(this.taskId);
    TaskOutput.#registry.delete(this.taskId);
  }

  /** Test helper — reset all static state. */
  static _resetForTest(): void {
    TaskOutput.#registry.clear();
    TaskOutput.#activePolling.clear();
    TaskOutput.#tickCount = 0;
    if (TaskOutput.#pollInterval) {
      clearInterval(TaskOutput.#pollInterval);
      TaskOutput.#pollInterval = null;
    }
  }
}
