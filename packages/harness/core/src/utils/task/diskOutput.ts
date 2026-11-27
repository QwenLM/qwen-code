/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Asynchronous disk-backed output writer for shell commands.
 *
 * Uses a flat array as a write queue processed by a single drain loop,
 * so each chunk can be GC'd immediately after its write completes.
 * This avoids the memory retention problem of chained .then() closures.
 */

import { constants as fsConstants, accessSync, realpathSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, stat, symlink, unlink } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { readFileRange, tailFile } from '../fsOperations.js';
import { BRAND_CLI_SLUG } from '../../config/brand.js';
import { runLogger } from '../runLogger.js';

// SECURITY: O_NOFOLLOW prevents following symlinks when opening task output files.
// A symlink in the tasks directory could redirect writes to an unrelated file.
// O_NOFOLLOW is used where available; Windows uses exclusive file creation below.
export const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024; // 8MB

/**
 * Disk cap for task output files. In file mode (bash), a watchdog polls
 * file size and kills the process. In pipe mode, DiskTaskOutput drops
 * chunks past this limit.
 */
export const MAX_TASK_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;
export const MAX_TASK_OUTPUT_BYTES_DISPLAY = '5GB';

// Module-level task output directory. Must be set via setTaskOutputDir() before use.
let _taskOutputDir: string | undefined;

/**
 * Sets the task output directory for subsequent task output operations.
 */
export function setTaskOutputDir(dir: string): void {
  _taskOutputDir = dir;
}

/**
 * Gets the task output directory.
 * Falls back to a default temp directory if not explicitly initialized.
 */
export function getTaskOutputDir(): string {
  if (_taskOutputDir === undefined) {
    _taskOutputDir = join(os.tmpdir(), `${BRAND_CLI_SLUG}-tasks`);
  }
  return _taskOutputDir;
}

// Cached base tmpdir. Branded entries must install their brand before the
// first call; the cached value is never recomputed.
let _cachedBaseTmpDir: string | undefined;
function getBaseTmpDir(): string {
  return (_cachedBaseTmpDir ??= getTaskOutputBaseDir(BRAND_CLI_SLUG));
}

/** Base directory shared by task output production and path adapters. */
export function getTaskOutputBaseDir(slug: string): string {
  if (os.platform() === 'win32') {
    return join(os.tmpdir(), slug);
  } else {
    let resolvedTmp: string;
    const envTmp = process.env['TMPDIR']?.trim();
    if (envTmp) {
      // An explicitly configured $TMPDIR wins — a host may point it at a
      // writable sandbox path precisely because the default /tmp is unusable.
      resolvedTmp = envTmp;
    } else {
      try {
        // /tmp isn't guaranteed usable on all POSIX-like platforms. Besides
        // missing entirely, the HarmonyOS app sandbox exposes a /tmp that
        // resolves but is NOT writable — an existence-only check would wrongly
        // accept it. Require write access so an unusable /tmp falls through to
        // os.tmpdir() (which respects $TMPDIR).
        const candidate = realpathSync('/tmp');
        accessSync(candidate, fsConstants.W_OK);
        resolvedTmp = candidate;
      } catch {
        resolvedTmp = os.tmpdir();
      }
    }
    const uid = process.getuid?.() ?? 0;
    return join(resolvedTmp, `${slug}-${uid}`);
  }
}

/**
 * Computes an isolated task output directory under the system tmpdir.
 * Keeps .output files outside ~/.qwen/ to prevent grep self-chasing.
 */
export function computeIsolatedTaskOutputDir(
  projectIdentifier: string,
  sessionId: string,
): string {
  return join(getBaseTmpDir(), projectIdentifier, sessionId, 'tasks');
}

/** Test helper — clears the configured dir. */
export function _resetTaskOutputDirForTest(): void {
  _taskOutputDir = undefined;
  _cachedBaseTmpDir = undefined;
}

/**
 * Ensure the task output directory exists.
 */
async function ensureOutputDir(
  outputDir: string = getTaskOutputDir(),
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
}

/**
 * Get the output file path for a task.
 */
export function getTaskOutputPath(taskId: string): string {
  return join(getTaskOutputDir(), `${taskId}.output`);
}

/**
 * Encapsulates async disk writes for a single task's output.
 *
 * Uses a flat array as a write queue processed by a single drain loop,
 * so each chunk can be GC'd immediately after its write completes.
 */
export class DiskTaskOutput {
  #path: string;
  #fileHandle: FileHandle | null = null;
  #queue: string[] = [];
  #bytesWritten = 0;
  #capped = false;
  #flushPromise: Promise<void> | null = null;
  #flushResolve: (() => void) | null = null;

  constructor(taskId: string) {
    this.#path = getTaskOutputPath(taskId);
  }

  append(content: string): void {
    if (this.#capped) {
      return;
    }
    // content.length (UTF-16 code units) undercounts UTF-8 bytes by at most ~3×.
    // Acceptable for a coarse disk-fill guard.
    this.#bytesWritten += content.length;
    if (this.#bytesWritten > MAX_TASK_OUTPUT_BYTES) {
      this.#capped = true;
      this.#queue.push(
        `\n[output truncated: exceeded ${MAX_TASK_OUTPUT_BYTES_DISPLAY} disk cap]\n`,
      );
    } else {
      this.#queue.push(content);
    }
    if (!this.#flushPromise) {
      this.#flushPromise = new Promise<void>((resolve) => {
        this.#flushResolve = resolve;
      });
      void this.#drain();
    }
  }

  flush(): Promise<void> {
    return this.#flushPromise ?? Promise.resolve();
  }

  cancel(): void {
    this.#queue.length = 0;
  }

  async #drainAllChunks(): Promise<void> {
    while (true) {
      try {
        if (!this.#fileHandle) {
          await ensureOutputDir();
          this.#fileHandle = await open(
            this.#path,
            process.platform === 'win32'
              ? 'a'
              : fsConstants.O_WRONLY |
                  fsConstants.O_APPEND |
                  fsConstants.O_CREAT |
                  O_NOFOLLOW,
          );
        }
        while (true) {
          await this.#writeAllChunks();
          if (this.#queue.length === 0) {
            break;
          }
        }
      } finally {
        if (this.#fileHandle) {
          const fileHandle = this.#fileHandle;
          this.#fileHandle = null;
          await fileHandle.close();
        }
      }
      // Another .append() could arrive while we're closing the file
      if (this.#queue.length) {
        continue;
      }
      break;
    }
  }

  // CRITICAL: DO NOT add `await` here! That would keep Buffer arrays
  // alive in closures, causing memory to balloon as the queue grows.
  #writeAllChunks(): Promise<void> {
    return this.#fileHandle!.appendFile(this.#queueToBuffers());
  }

  // Keep in separate method so GC doesn't keep it alive longer than needed.
  #queueToBuffers(): Buffer {
    // Use .splice to in-place mutate the array, informing the GC it can free it.
    const queue = this.#queue.splice(0, this.#queue.length);

    let totalLength = 0;
    for (const str of queue) {
      totalLength += Buffer.byteLength(str, 'utf8');
    }

    const buffer = Buffer.allocUnsafe(totalLength);
    let offset = 0;
    for (const str of queue) {
      offset += buffer.write(str, offset, 'utf8');
    }

    return buffer;
  }

  async #drain(): Promise<void> {
    try {
      await this.#drainAllChunks();
    } catch {
      // Retry once for transient fs errors (EMFILE, EPERM)
      if (this.#queue.length > 0) {
        try {
          await this.#drainAllChunks();
        } catch {
          // Give up after retry
        }
      }
    } finally {
      const resolve = this.#flushResolve!;
      this.#flushPromise = null;
      this.#flushResolve = null;
      resolve();
    }
  }
}

// Global output registry for background task management
const outputs = new Map<string, DiskTaskOutput>();

/** Test helper — cancel pending writes and clear the map. */
export async function _clearOutputsForTest(): Promise<void> {
  for (const output of outputs.values()) {
    output.cancel();
  }
  outputs.clear();
}

function getOrCreateOutput(taskId: string): DiskTaskOutput {
  let output = outputs.get(taskId);
  if (!output) {
    output = new DiskTaskOutput(taskId);
    outputs.set(taskId, output);
  }
  return output;
}

/**
 * Append output to a task's disk file asynchronously.
 */
export function appendTaskOutput(taskId: string, content: string): void {
  getOrCreateOutput(taskId).append(content);
}

/**
 * Wait for all pending writes for a task to complete.
 */
export async function flushTaskOutput(taskId: string): Promise<void> {
  const output = outputs.get(taskId);
  if (output) {
    await output.flush();
  }
}

/**
 * Evict a task's DiskTaskOutput from the in-memory map after flushing.
 */
export async function evictTaskOutput(taskId: string): Promise<void> {
  const output = outputs.get(taskId);
  if (output) {
    await output.flush();
    outputs.delete(taskId);
  }
}

/**
 * Get delta (new content) since last read.
 */
export async function getTaskOutputDelta(
  taskId: string,
  fromOffset: number,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
): Promise<{ content: string; newOffset: number }> {
  try {
    const result = await readFileRange(
      getTaskOutputPath(taskId),
      fromOffset,
      maxBytes,
    );
    if (!result) {
      return { content: '', newOffset: fromOffset };
    }
    return {
      content: result.content,
      newOffset: fromOffset + result.bytesRead,
    };
  } catch {
    return { content: '', newOffset: fromOffset };
  }
}

/**
 * Get output for a task, reading the tail of the file.
 */
export async function getTaskOutput(
  taskId: string,
  maxBytes: number = DEFAULT_MAX_READ_BYTES,
): Promise<string> {
  try {
    const { content, bytesTotal, bytesRead } = await tailFile(
      getTaskOutputPath(taskId),
      maxBytes,
    );
    if (bytesTotal > bytesRead) {
      return `[${Math.round((bytesTotal - bytesRead) / 1024)}KB of earlier output omitted]\n${content}`;
    }
    return content;
  } catch {
    return '';
  }
}

/**
 * Get the current size of a task's output file.
 */
export async function getTaskOutputSize(taskId: string): Promise<number> {
  try {
    return (await stat(getTaskOutputPath(taskId))).size;
  } catch {
    return 0;
  }
}

/**
 * Clean up a task's output file and write queue.
 */
export async function cleanupTaskOutput(taskId: string): Promise<void> {
  const output = outputs.get(taskId);
  if (output) {
    output.cancel();
    outputs.delete(taskId);
  }

  try {
    await unlink(getTaskOutputPath(taskId));
  } catch {
    // File may already be deleted or not exist
  }
}

/**
 * Initialize output file for a new task.
 * Creates an empty file to ensure the path exists.
 */
export async function initTaskOutput(
  taskId: string,
  outputPath: string = getTaskOutputPath(taskId),
): Promise<string> {
  await ensureOutputDir(dirname(outputPath));
  // SECURITY: O_NOFOLLOW prevents following a symlink at the output path.
  // O_EXCL ensures we create a new file and fail if something already exists.
  const fh = await open(
    outputPath,
    process.platform === 'win32'
      ? 'wx'
      : fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          O_NOFOLLOW,
  );
  await fh.close();
  return outputPath;
}

/**
 * Initialize output file as a symlink to another file (e.g., agent transcript).
 * Tries to create the symlink first; if a file already exists, removes it and retries.
 * If symlink creation fails entirely (e.g., Windows EPERM without Developer Mode),
 * falls back to creating a plain empty output file so the task output path remains valid.
 */
export async function initTaskOutputAsSymlink(
  taskId: string,
  targetPath: string,
): Promise<string> {
  const outputPath = getTaskOutputPath(taskId);
  try {
    await ensureOutputDir(dirname(outputPath));

    try {
      await symlink(targetPath, outputPath);
    } catch {
      await unlink(outputPath).catch(() => {});
      await symlink(targetPath, outputPath);
    }

    return outputPath;
  } catch (error) {
    runLogger.warn(
      `[initTaskOutputAsSymlink] symlink failed for task=${taskId}, falling back to plain file`,
      error instanceof Error ? error.message : String(error),
    );
    // A failed symlink operation on Windows can still leave a dangling link.
    // Remove the retry's residue before exclusive creation; never follow or
    // truncate an existing path by changing the fallback to overwrite mode.
    await unlink(outputPath).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== 'ENOENT') {
        throw cleanupError;
      }
    });
    return initTaskOutput(taskId, outputPath);
  }
}
