/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Part, PartListUnion } from '@google/genai';
import type { Config } from '../config/config.js';
import { getErrorMessage, isAbortError } from './errors.js';
import type { ProcessedFileReadResult } from './fileUtils.js';
import {
  isCacheableReadResult,
  processSingleFileContent,
} from './fileUtils.js';
import { getFolderStructure } from './getFolderStructure.js';

/**
 * Options for reading multiple files.
 */
export interface ReadManyFilesOptions {
  /**
   * An array of file or directory paths to read.
   * Paths are relative to the project root.
   */
  paths: string[];

  /**
   * Optional AbortSignal for cancellation support.
   */
  signal?: AbortSignal;

  /**
   * When true and the vision bridge is enabled, keep images inline for a
   * text-only model (instead of an "unsupported" note) so the bridge can
   * transcribe them. Set only by the interactive `@`-resolution path, not by
   * the agent `read_many_files` tool.
   */
  preserveUnsupportedImageForBridge?: boolean;

  /**
   * File identities captured after caller-side workspace/ignore validation.
   * Matching paths are rechecked immediately before and after reading so a
   * replaced symlink or file is dropped instead of entering model context.
   */
  validatedPathIdentities?: ReadonlyMap<string, ReadManyFilesPathIdentity>;
}

export interface ReadManyFilesPathIdentity {
  dev: number;
  ino: number;
}

/**
 * Information about a single file that was read.
 */
export interface FileReadInfo {
  /** Absolute path to the file */
  filePath: string;
  /** Content of the file (string for text, Part for images/PDFs) */
  content: PartListUnion;
  /** Whether this is a directory listing rather than file content */
  isDirectory: boolean;
  /**
   * Error message when the read failed (e.g. missing pdftotext,
   * password-protected PDF, file too large). When present, `content`
   * holds the user-facing guidance string that was surfaced to the LLM,
   * and callers should render this entry as a failed read rather than a
   * successful one.
   */
  error?: string;
}

/**
 * Result from reading multiple files.
 */
export interface ReadManyFilesResult {
  /**
   * Content parts ready for LLM consumption.
   * For text files, content is concatenated with separators.
   * For images/PDFs, includes inline data parts.
   */
  contentParts: PartListUnion;

  /**
   * Individual file results with paths and content.
   * Used for recording each file read as a separate tool result.
   */
  files: FileReadInfo[];

  /**
   * Error message if an error occurred during file search.
   */
  error?: string;
}

const DEFAULT_OUTPUT_HEADER = '\n--- Content from referenced files ---';
const DEFAULT_OUTPUT_TERMINATOR = '\n--- End of content ---';

/**
 * Reads content from multiple files and directories specified by paths.
 *
 * For directories, returns the folder structure.
 * For text files, concatenates their content into a single string with separators.
 * For image and PDF files, returns base64-encoded data.
 *
 * @param config - The runtime configuration
 * @param options - Options for file reading (paths, filters, signal)
 * @returns Result containing content parts and processed files
 *
 * NOTE: This utility is invoked only by explicit user-triggered file reads.
 * Do not apply workspace filters or path restrictions here.
 */
export async function readManyFiles(
  config: Config,
  options: ReadManyFilesOptions,
): Promise<ReadManyFilesResult> {
  const {
    paths: inputPatterns,
    preserveUnsupportedImageForBridge,
    signal,
    validatedPathIdentities,
  } = options;

  const seenFiles = new Set<string>();
  const contentParts: Part[] = [];
  const files: FileReadInfo[] = [];

  try {
    const projectRoot = config.getProjectRoot();

    for (const rawPattern of inputPatterns) {
      signal?.throwIfAborted();
      const normalizedPattern = rawPattern.replace(/\\/g, '/');
      const fullPath = path.resolve(projectRoot, normalizedPattern);
      const validatedIdentity = validatedPathIdentities?.get(fullPath);
      if (
        validatedIdentity &&
        !(await matchesValidatedPathIdentity(fullPath, validatedIdentity))
      ) {
        continue;
      }
      const stats = fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;

      if (stats?.isDirectory()) {
        const { contentParts: dirParts, info } = await readDirectory(
          config,
          fullPath,
          signal,
        );
        if (
          validatedIdentity &&
          !(await matchesValidatedPathIdentity(fullPath, validatedIdentity))
        ) {
          continue;
        }
        contentParts.push(...dirParts);
        files.push(info);
        continue;
      }

      if (stats?.isFile() && !seenFiles.has(fullPath)) {
        seenFiles.add(fullPath);
        const snapshot = validatedIdentity
          ? await snapshotValidatedFile(fullPath, validatedIdentity, signal)
          : undefined;
        if (validatedIdentity && !snapshot) continue;
        let readResult;
        try {
          readResult = await readFileContent(
            config,
            snapshot?.filePath ?? fullPath,
            preserveUnsupportedImageForBridge,
            signal,
            fullPath,
            snapshot?.stats,
          );
        } finally {
          await snapshot?.cleanup();
        }
        if (readResult) {
          contentParts.push(...readResult.contentParts);
          files.push(readResult.info);
        }
      }
    }
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw error;
    }
    const errorMessage = `Error during file search: ${getErrorMessage(error)}`;
    return {
      contentParts: [errorMessage],
      files: [],
      error: errorMessage,
    };
  }

  if (contentParts.length > 0) {
    contentParts.unshift({ text: DEFAULT_OUTPUT_HEADER });
    contentParts.push({ text: DEFAULT_OUTPUT_TERMINATOR });
  } else {
    contentParts.push({
      text: 'No files matching the criteria were found or all were skipped.',
    });
  }

  return { contentParts: contentParts as PartListUnion, files };
}

async function matchesValidatedPathIdentity(
  filePath: string,
  expected: ReadManyFilesPathIdentity,
): Promise<boolean> {
  try {
    const [canonicalPath, stats] = await Promise.all([
      fs.promises.realpath(filePath),
      fs.promises.stat(filePath),
    ]);
    return (
      canonicalPath === filePath &&
      stats.dev === expected.dev &&
      stats.ino === expected.ino
    );
  } catch {
    return false;
  }
}

async function snapshotValidatedFile(
  filePath: string,
  expected: ReadManyFilesPathIdentity,
  signal?: AbortSignal,
): Promise<
  | {
      filePath: string;
      stats: fs.Stats;
      cleanup: () => Promise<void>;
    }
  | undefined
> {
  let snapshotDir: string | undefined;
  try {
    signal?.throwIfAborted();
    const source = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const stats = await source.stat();
      if (
        !stats.isFile() ||
        stats.dev !== expected.dev ||
        stats.ino !== expected.ino
      ) {
        return undefined;
      }

      snapshotDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'qwen-validated-read-'),
      );
      const snapshotPath = path.join(snapshotDir, path.basename(filePath));
      const target = await fs.promises.open(
        snapshotPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let sourcePosition = 0;
        while (true) {
          signal?.throwIfAborted();
          const { bytesRead } = await source.read(
            buffer,
            0,
            buffer.length,
            sourcePosition,
          );
          if (bytesRead === 0) break;
          let written = 0;
          while (written < bytesRead) {
            const result = await target.write(
              buffer,
              written,
              bytesRead - written,
            );
            written += result.bytesWritten;
          }
          sourcePosition += bytesRead;
        }
      } finally {
        await target.close();
      }
      return {
        filePath: snapshotPath,
        stats,
        cleanup: () =>
          fs.promises.rm(snapshotDir!, { recursive: true, force: true }),
      };
    } finally {
      await source.close();
    }
  } catch (error) {
    if (snapshotDir) {
      await fs.promises.rm(snapshotDir, { recursive: true, force: true });
    }
    if (signal?.aborted || isAbortError(error)) throw error;
    return undefined;
  }
}

async function readDirectory(
  config: Config,
  directoryPath: string,
  signal?: AbortSignal,
): Promise<{ contentParts: Part[]; info: FileReadInfo }> {
  signal?.throwIfAborted();
  const structure = await getFolderStructure(directoryPath, {
    fileService: config.getFileService(),
    fileFilteringOptions: config.getFileFilteringOptions(),
  });
  signal?.throwIfAborted();

  const contentParts: Part[] = [
    { text: `\nContent from ${directoryPath}:\n` },
    { text: structure },
  ];

  return {
    contentParts,
    info: {
      filePath: directoryPath,
      content: structure,
      isDirectory: true,
    },
  };
}

async function readFileContent(
  config: Config,
  filePath: string,
  preserveUnsupportedImage = false,
  signal?: AbortSignal,
  displayPath = filePath,
  validatedStats?: fs.Stats,
): Promise<{ contentParts: Part[]; info: FileReadInfo } | null> {
  try {
    const fileReadResult = await processSingleFileContent(filePath, config, {
      preserveUnsupportedImage,
      ...(signal !== undefined ? { signal } : {}),
      largePdfBehavior: 'reference',
    });
    if (validatedStats && fileReadResult.stats) {
      fileReadResult.stats = validatedStats;
    }

    const prefixText: Part = { text: `\nContent from ${displayPath}:\n` };

    // Surface any error produced by processSingleFileContent instead of
    // silently skipping the file. This preserves actionable guidance
    // (e.g. "pdftotext is not installed, install poppler-utils...",
    // password-protected PDFs, file-too-large) across batch reads.
    if (fileReadResult.error) {
      const errorText =
        typeof fileReadResult.llmContent === 'string'
          ? fileReadResult.llmContent
          : `Failed to read ${displayPath}: ${fileReadResult.error}`;
      return {
        contentParts: [prefixText, { text: errorText }],
        info: {
          filePath: displayPath,
          content: errorText,
          isDirectory: false,
          error: fileReadResult.error,
        },
      };
    }

    // Record the successful read in the session FileReadCache so a later
    // Edit / WriteFile on an `@`-attached file passes prior-read enforcement
    // without a redundant read_file (issue #6289).
    recordAttachedFileRead(config, displayPath, fileReadResult);

    if (typeof fileReadResult.llmContent === 'string') {
      let fileContentForLlm = '';
      if (
        fileReadResult.isTruncated &&
        fileReadResult.linesShown &&
        fileReadResult.originalLineCount !== undefined
      ) {
        const [start, end] = fileReadResult.linesShown!;
        const total = fileReadResult.originalLineCount!;
        const totalLabel =
          fileReadResult.originalLineCountExact === false
            ? `at least ${total}`
            : total;
        fileContentForLlm = `Showing lines ${start}-${end} of ${totalLabel} total lines.\n---\n${fileReadResult.llmContent}`;
      } else {
        fileContentForLlm = fileReadResult.llmContent;
      }
      const contentParts: Part[] = [prefixText, { text: fileContentForLlm }];
      return {
        contentParts,
        info: {
          filePath: displayPath,
          content: fileContentForLlm,
          isDirectory: false,
        },
      };
    }

    // For binary files (images, PDFs), add prefix text before the media
    // part(s). A page-rendered PDF yields an array of image parts (plus an
    // optional truncation note), so flatten it after the prefix.
    const mediaParts = fileReadResult.llmContent;
    const contentParts: Part[] = Array.isArray(mediaParts)
      ? [prefixText, ...(mediaParts as Part[])]
      : [prefixText, mediaParts];
    return {
      contentParts,
      info: {
        filePath: displayPath,
        content: fileReadResult.llmContent,
        isDirectory: false,
      },
    };
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw error;
    }
    return null;
  }
}

/**
 * Record an `@`-attached file read in the session {@link FileReadCache} so a
 * later Edit / WriteFile on the same file passes prior-read enforcement
 * without the model re-reading it via `read_file` (issue #6289). Without
 * this, `@`-mentions loaded content into context but never touched the
 * cache, so `checkPriorRead` saw `unknown` and rejected the edit with
 * `EDIT_REQUIRES_PRIOR_READ`.
 *
 * Although `@`-mentions pass no explicit offset / limit / pages,
 * `processSingleFileContent` applies `config.getTruncateToolOutputLines()`
 * as a default cap, so large attachments can still be truncated and
 * `full` may be `false` — mirroring `read-file.ts` so the two read paths
 * agree on what Edit / WriteFile may mutate. Binary media
 * (image / audio / native PDF) omit `stats` from the read result and are
 * skipped here; a later Edit on them is still correctly rejected as a
 * non-text payload by prior-read enforcement.
 *
 * Guards mirror `grepReadTracking.ts`: no-op when the cache is disabled or
 * unavailable, matching the other utility that records reads outside the
 * `read_file` tool.
 */
function recordAttachedFileRead(
  config: Config,
  filePath: string,
  result: ProcessedFileReadResult,
): void {
  if (config.getFileReadCacheDisabled?.()) {
    return;
  }
  const cache = config.getFileReadCache?.();
  if (!cache || !result.stats) {
    return;
  }
  const cacheable = isCacheableReadResult(result);
  cache.recordRead(filePath, result.stats, {
    full: !result.isTruncated,
    cacheable,
  });
}
