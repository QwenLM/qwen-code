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
import { StandardFileSystemService } from '../services/fileSystemService.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';
import type {
  FileType,
  ProcessedFileReadResult,
  ProcessSingleFileContentOptions,
} from '../utils/fileUtils.js';
import {
  detectFileType,
  isCacheableReadResult,
  processSingleFileContent,
} from '../utils/fileUtils.js';
import { hasVerifiableInode } from '../utils/file-identity.js';
import { getFolderStructure } from '../utils/getFolderStructure.js';
import { openNoFollow } from '../utils/no-follow-open.js';

const debugLogger = createDebugLogger('READ_MANY_FILES');

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

  /**
   * User-facing labels for canonical paths. Callers that validate a realpath'd
   * target can keep the original @ reference in content delimiters.
   */
  displayPaths?: ReadonlyMap<string, string>;
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
 * Why a validated reference produced neither content nor a file entry.
 * `identity-changed` is the security drop (the target was replaced between
 * validation and the read); `snapshot-failed` is environmental (ENOSPC,
 * read-only TMPDIR, EMFILE); `not-validated` means the caller supplied an
 * identity map that does not cover the path; `unreadable` means the identity
 * check could not complete, or the read itself failed.
 */
export type ReadManyFilesDropReason =
  | 'not-validated'
  | 'identity-changed'
  | 'snapshot-failed'
  | 'unreadable';

/**
 * A reference that was dropped without producing content, reported so the
 * caller can tell the user instead of leaving the drop silent (#8226).
 */
export interface ReadManyFilesDroppedFile {
  /** Caller-facing label for the reference. */
  path: string;
  /**
   * Canonical path the drop was decided on. Callers key their own
   * bookkeeping by it, since one canonical path can carry several labels.
   */
  canonicalPath: string;
  reason: ReadManyFilesDropReason;
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
   * References that produced neither content nor a {@link FileReadInfo},
   * with the reason each was dropped.
   */
  dropped: ReadManyFilesDroppedFile[];

  /**
   * Error message if an error occurred during file search.
   */
  error?: string;
}

const DEFAULT_OUTPUT_HEADER = '\n--- Content from referenced files ---';
const DEFAULT_OUTPUT_TERMINATOR = '\n--- End of content ---';

/**
 * Upper bound on the size of a file we will snapshot-copy for a validated
 * read. Files larger than this are always rejected by the downstream
 * `processSingleFileContent` inline-data caps (100 MB for images, ≤ 10 MB
 * for other binary types), so copying them to a temp file is wasted I/O.
 */
const SNAPSHOT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

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
    displayPaths,
  } = options;

  const seenFiles = new Set<string>();
  const contentParts: Part[] = [];
  const files: FileReadInfo[] = [];
  const dropped: ReadManyFilesDroppedFile[] = [];

  const dropReference = (
    path: string,
    reason: ReadManyFilesDropReason,
    canonicalPath: string,
  ): void => {
    dropped.push({ path, canonicalPath, reason });
    debugLogger.warn(`Dropped ${path} (${reason})`);
  };

  try {
    const projectRoot = config.getProjectRoot();

    for (const rawPattern of inputPatterns) {
      signal?.throwIfAborted();
      // Separator normalization exists for Windows-style patterns. An
      // absolute POSIX path may contain a literal backslash, and rewriting
      // it here would miss the caller's identity and display maps, which are
      // keyed by the realpath.
      const normalizedPattern = path.isAbsolute(rawPattern)
        ? rawPattern
        : rawPattern.replace(/\\/g, '/');
      const fullPath = path.resolve(projectRoot, normalizedPattern);
      const displayPath = displayPaths?.get(fullPath) ?? fullPath;
      const validatedIdentity = validatedPathIdentities?.get(fullPath);
      if (validatedPathIdentities && !validatedIdentity) {
        dropReference(displayPath, 'not-validated', fullPath);
        continue;
      }
      if (validatedIdentity && !hasVerifiableInode(validatedIdentity.ino)) {
        if (!seenFiles.has(fullPath)) {
          seenFiles.add(fullPath);
          const { contentParts: errorParts, info } = createFileReadErrorResult(
            displayPath,
            'Validated file identity is unavailable on this filesystem (inode is 0).',
          );
          contentParts.push(...errorParts);
          files.push(info);
        }
        continue;
      }
      if (validatedIdentity) {
        const identity = await matchesValidatedPathIdentity(
          fullPath,
          validatedIdentity,
        );
        if (identity !== 'match') {
          dropReference(displayPath, dropReasonForIdentity(identity), fullPath);
          continue;
        }
      }
      const stats = fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;

      if (stats?.isDirectory()) {
        const { contentParts: dirParts, info } = await readDirectory(
          config,
          fullPath,
          displayPath,
          signal,
        );
        if (validatedIdentity) {
          const identity = await matchesValidatedPathIdentity(
            fullPath,
            validatedIdentity,
          );
          if (identity !== 'match') {
            dropReference(
              displayPath,
              dropReasonForIdentity(identity),
              fullPath,
            );
            continue;
          }
        }
        contentParts.push(...dirParts);
        files.push(info);
        continue;
      }

      // A validated reference that is neither a directory nor a regular file
      // (a FIFO, a socket, or a path that vanished) reaches no branch below,
      // so report it here rather than letting it disappear.
      if (validatedIdentity && !stats?.isFile()) {
        dropReference(displayPath, 'identity-changed', fullPath);
        continue;
      }

      if (stats?.isFile() && !seenFiles.has(fullPath)) {
        seenFiles.add(fullPath);
        let shouldUseTextHandle = false;
        let shouldSnapshot = false;
        let validatedFileType: FileType | undefined;
        if (validatedIdentity) {
          const standardFileSystem =
            config.getFileSystemService() instanceof StandardFileSystemService;
          const fileType = await detectFileType(fullPath);
          validatedFileType = fileType;
          shouldUseTextHandle = standardFileSystem && fileType === 'text';
          shouldSnapshot =
            !shouldUseTextHandle &&
            (standardFileSystem || fileType !== 'text') &&
            stats.size <= SNAPSHOT_MAX_SIZE_BYTES;
        }
        const snapshotResult = shouldSnapshot
          ? await snapshotValidatedFile(fullPath, validatedIdentity!, signal)
          : undefined;
        if (shouldSnapshot && !snapshotResult?.ok) {
          dropReference(
            displayPath,
            snapshotResult?.reason === 'identity-changed'
              ? 'identity-changed'
              : 'snapshot-failed',
            fullPath,
          );
          continue;
        }
        const snapshot = snapshotResult?.ok ? snapshotResult : undefined;
        let readResult: FileReadOutcome;
        const validateAfterRead =
          validatedIdentity && !snapshot && !shouldUseTextHandle
            ? async () =>
                (await matchesValidatedPathIdentity(
                  fullPath,
                  validatedIdentity,
                )) === 'match'
            : undefined;
        if (shouldUseTextHandle) {
          try {
            readResult = await readValidatedTextFileContent(
              config,
              fullPath,
              validatedIdentity!,
              preserveUnsupportedImageForBridge,
              signal,
              displayPath,
            );
          } catch (error) {
            if (signal?.aborted || isAbortError(error)) throw error;
            const errorMessage = getErrorMessage(error);
            readResult = {
              ok: true,
              ...createFileReadErrorResult(displayPath, errorMessage),
            };
          }
        } else {
          try {
            readResult = await readFileContent(
              config,
              snapshot?.filePath ?? fullPath,
              preserveUnsupportedImageForBridge,
              signal,
              displayPath,
              snapshot?.stats,
              validateAfterRead,
              !snapshot && validatedFileType
                ? { fileType: validatedFileType }
                : undefined,
              fullPath,
            );
          } finally {
            await snapshot?.cleanup();
          }
        }
        if (readResult.ok) {
          contentParts.push(...readResult.contentParts);
          files.push(readResult.info);
        } else {
          dropReference(displayPath, readResult.reason, fullPath);
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
      dropped,
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

  return { contentParts: contentParts as PartListUnion, files, dropped };
}

/**
 * What a validated read produced. A refusal carries the cause so the drop the
 * caller reports names what actually happened: a proven identity change, or a
 * check that could not complete.
 */
type FileReadOutcome =
  | { ok: true; contentParts: Part[]; info: FileReadInfo }
  | { ok: false; reason: 'identity-changed' | 'unreadable' };

async function readValidatedTextFileContent(
  config: Config,
  filePath: string,
  expected: ReadManyFilesPathIdentity,
  preserveUnsupportedImage = false,
  signal: AbortSignal | undefined,
  displayPath: string,
): Promise<FileReadOutcome> {
  // Where O_NOFOLLOW does not exist (Windows) the helper compensates with
  // an lstat/open/fstat identity check instead of collapsing to a plain
  // open that follows symlinks (#8227); the validated-identity re-check
  // below remains the second layer.
  const source = await openNoFollow(filePath);
  try {
    const stats = await source.stat();
    if (!fileStatsMatchValidatedIdentity(stats, expected)) {
      return { ok: false, reason: 'identity-changed' };
    }
    return await readFileContent(
      config,
      filePath,
      preserveUnsupportedImage,
      signal,
      displayPath,
      stats,
      undefined,
      {
        textFileHandle: source,
        textFileStats: stats,
        textFileMaxScanBytes: Math.max(1, stats.size),
      },
      filePath,
    );
  } finally {
    await source.close();
  }
}

type IdentityCheck = 'match' | 'mismatch' | 'inconclusive';

/** A check that could not complete is reported as unreadable, not as a swap. */
function dropReasonForIdentity(check: IdentityCheck): ReadManyFilesDropReason {
  return check === 'mismatch' ? 'identity-changed' : 'unreadable';
}

async function matchesValidatedPathIdentity(
  filePath: string,
  expected: ReadManyFilesPathIdentity,
): Promise<IdentityCheck> {
  try {
    const canonicalPath = await fs.promises.realpath(filePath);
    if (canonicalPath !== filePath) return 'mismatch';
    const stats = await fs.promises.stat(canonicalPath);
    return statsMatchValidatedIdentity(stats, expected) ? 'match' : 'mismatch';
  } catch (error) {
    debugLogger.warn(
      `Identity check could not complete for ${filePath}: ${getErrorMessage(error)}`,
    );
    return 'inconclusive';
  }
}

function statsMatchValidatedIdentity(
  stats: fs.Stats,
  expected: ReadManyFilesPathIdentity,
): boolean {
  return (
    hasVerifiableInode(stats.ino) &&
    stats.dev === expected.dev &&
    stats.ino === expected.ino
  );
}

function fileStatsMatchValidatedIdentity(
  stats: fs.Stats,
  expected: ReadManyFilesPathIdentity,
): boolean {
  return stats.isFile() && statsMatchValidatedIdentity(stats, expected);
}

type SnapshotOutcome =
  | {
      ok: true;
      filePath: string;
      stats: fs.Stats;
      cleanup: () => Promise<void>;
    }
  | { ok: false; reason: 'identity-changed' | 'too-large' | 'failed' };

async function snapshotValidatedFile(
  filePath: string,
  expected: ReadManyFilesPathIdentity,
  signal?: AbortSignal,
): Promise<SnapshotOutcome> {
  let snapshotDir: string | undefined;
  let result:
    | { filePath: string; stats: fs.Stats; cleanup: () => Promise<void> }
    | undefined;
  try {
    signal?.throwIfAborted();
    // See readValidatedTextFileContent: the helper keeps the no-follow
    // guarantee on platforms without O_NOFOLLOW (#8227).
    const source = await openNoFollow(filePath);
    try {
      const stats = await source.stat();
      if (!fileStatsMatchValidatedIdentity(stats, expected)) {
        debugLogger.warn(
          `Snapshot refused for ${filePath}: identity changed since validation`,
        );
        return { ok: false, reason: 'identity-changed' };
      }
      if (stats.size > SNAPSHOT_MAX_SIZE_BYTES) {
        debugLogger.warn(
          `Snapshot refused for ${filePath}: ${stats.size} bytes exceeds the ${SNAPSHOT_MAX_SIZE_BYTES}-byte snapshot cap`,
        );
        return { ok: false, reason: 'too-large' };
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
        while (sourcePosition < stats.size) {
          signal?.throwIfAborted();
          const remaining = stats.size - sourcePosition;
          const { bytesRead } = await source.read(
            buffer,
            0,
            Math.min(buffer.length, remaining),
            sourcePosition,
          );
          if (bytesRead === 0) {
            debugLogger.warn(
              `Snapshot refused for ${filePath}: source ended ${stats.size - sourcePosition} bytes early`,
            );
            return { ok: false, reason: 'identity-changed' };
          }
          let written = 0;
          while (written < bytesRead) {
            const writeResult = await target.write(
              buffer,
              written,
              bytesRead - written,
            );
            written += writeResult.bytesWritten;
          }
          sourcePosition += bytesRead;
        }
        const growthProbe = Buffer.allocUnsafe(1);
        const { bytesRead: extraBytes } = await source.read(
          growthProbe,
          0,
          1,
          sourcePosition,
        );
        if (extraBytes !== 0) {
          debugLogger.warn(
            `Snapshot refused for ${filePath}: source grew while it was copied`,
          );
          return { ok: false, reason: 'identity-changed' };
        }
      } finally {
        await target.close();
      }
      result = {
        filePath: snapshotPath,
        stats,
        cleanup: () =>
          fs.promises.rm(snapshotDir!, { recursive: true, force: true }),
      };
      return { ok: true, ...result };
    } finally {
      await source.close();
    }
  } catch (error) {
    result = undefined;
    if (signal?.aborted || isAbortError(error)) throw error;
    debugLogger.warn(
      `Snapshot failed for ${filePath}: ${getErrorMessage(error)}`,
    );
    return { ok: false, reason: 'failed' };
  } finally {
    if (snapshotDir && !result) {
      await fs.promises.rm(snapshotDir, { recursive: true, force: true });
    }
  }
}

async function readDirectory(
  config: Config,
  directoryPath: string,
  displayPath = directoryPath,
  signal?: AbortSignal,
): Promise<{ contentParts: Part[]; info: FileReadInfo }> {
  signal?.throwIfAborted();
  const structure = await getFolderStructure(directoryPath, {
    fileService: config.getFileService(),
    fileFilteringOptions: config.getFileFilteringOptions(),
  });
  signal?.throwIfAborted();

  const contentParts: Part[] = [
    { text: `\nContent from ${displayPath}:\n` },
    { text: structure },
  ];

  return {
    contentParts,
    info: {
      filePath: displayPath,
      content: structure,
      isDirectory: true,
    },
  };
}

function createFileReadErrorResult(
  displayPath: string,
  errorMessage: string,
): { contentParts: Part[]; info: FileReadInfo } {
  const content = `Error reading ${displayPath}: ${errorMessage}`;
  return {
    contentParts: [
      { text: `\nContent from ${displayPath}:\n` },
      { text: content },
    ],
    info: {
      filePath: displayPath,
      content,
      isDirectory: false,
      error: errorMessage,
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
  validateAfterRead?: () => Promise<boolean>,
  processOptions?: Pick<
    ProcessSingleFileContentOptions,
    'textFileHandle' | 'textFileStats' | 'textFileMaxScanBytes' | 'fileType'
  >,
  canonicalPath?: string,
): Promise<FileReadOutcome> {
  try {
    const fileReadResult = await processSingleFileContent(filePath, config, {
      preserveUnsupportedImage,
      ...(signal !== undefined ? { signal } : {}),
      largePdfBehavior: 'reference',
      displayPath,
      ...processOptions,
    });
    if (validatedStats && fileReadResult.stats) {
      fileReadResult.stats = validatedStats;
    }
    if (validateAfterRead && !(await validateAfterRead())) {
      return { ok: false, reason: 'identity-changed' };
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
        ok: true,
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
    // without a redundant read_file (issue #6289). Key by the canonical
    // (resolved) path — not the display alias — because Edit / WriteFile
    // looks up the cache by canonical path.
    recordAttachedFileRead(config, canonicalPath ?? filePath, fileReadResult);

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
        ok: true,
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
      ok: true,
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
    debugLogger.warn(`Read failed for ${filePath}: ${getErrorMessage(error)}`);
    return { ok: false, reason: 'unreadable' };
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
