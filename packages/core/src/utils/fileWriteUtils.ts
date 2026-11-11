/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Utilities for file write operations: atomic write, symlink resolution,
 * encoding detection, and line ending handling.
 */

import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isUtf8 } from 'node:buffer';
import fsPromises from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isNodeError } from './errors.js';

// ────────────────────────────────────────────────────────────────────────────
// Line ending types
// ────────────────────────────────────────────────────────────────────────────

export type LineEndingType = 'LF' | 'CRLF';

/**
 * Detect the dominant line ending style from a string sample.
 * Returns 'CRLF' if \r\n sequences outnumber bare \n, otherwise 'LF'.
 */
export function detectLineEndingsForString(content: string): LineEndingType {
  let crlfCount = 0;
  let lfCount = 0;

  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      if (i > 0 && content[i - 1] === '\r') {
        crlfCount++;
      } else {
        lfCount++;
      }
    }
  }

  return crlfCount > lfCount ? 'CRLF' : 'LF';
}

// ────────────────────────────────────────────────────────────────────────────
// Encoding detection
// ────────────────────────────────────────────────────────────────────────────

/**
 * Detect the encoding of a file by reading its first 4096 bytes
 * and checking for BOM markers. Defaults to 'utf8'.
 */
export function detectFileEncoding(filePath: string): BufferEncoding {
  try {
    const resolvedPath = resolveSymlink(filePath);
    return detectEncodingForResolvedPath(resolvedPath);
  } catch {
    return 'utf8';
  }
}

/**
 * Detect encoding from a resolved (non-symlink) path by reading the first
 * bytes and checking for BOM markers.
 */
export function detectEncodingForResolvedPath(
  resolvedPath: string,
): BufferEncoding {
  const fd = openSync(resolvedPath, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const bytesRead: number = readSync(fd, buffer, 0, 4096, 0);
    return detectEncodingFromBytes(buffer.subarray(0, bytesRead));
  } finally {
    closeSync(fd);
  }
}

/** Only a UTF-16LE byte-order mark selects a non-UTF-8 encoding. */
export function detectEncodingFromBytes(bytes: Buffer): BufferEncoding {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return 'utf16le';
  }
  return 'utf8';
}

export function preserveBOM(originalContent: string, content: string): string {
  return content !== '' && originalContent.startsWith('\uFEFF') && !content.startsWith('\uFEFF')
    ? `\uFEFF${content}`
    : content;
}

/** Why a file cannot be round-tripped as text by the file tools. */
export type NotTextReason = 'not_utf8' | 'nul' | 'utf16be';

export const NUL_SCAN_BYTES = 8000;

const NOT_TEXT_DESCRIPTIONS: Record<NotTextReason, string> = {
  not_utf8:
    'is not valid UTF-8: it uses a legacy encoding such as Windows-1252, Shift-JIS or GBK, or it is binary',
  nul: 'has NUL bytes in its first 8 KB: binary data, UTF-16/UTF-32 without a byte-order mark, or text with embedded NULs',
  utf16be:
    'is UTF-16 big-endian (it starts FE FF), which these tools cannot write',
};

/**
 * Classify raw file bytes that the UTF-8/UTF-16LE writers cannot reproduce.
 * Decoding such bytes yields U+FFFD, so writing the decoded text back would
 * irreversibly destroy the original content. Callers that only hold the
 * file head pass `isValidUtf8` computed over the whole file.
 */
export function detectNotText(
  bytes: Buffer,
  isValidUtf8: () => boolean = () => isUtf8(bytes),
): NotTextReason | undefined {
  if (detectEncodingFromBytes(bytes) !== 'utf8') return undefined;
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return 'utf16be';
  }
  if (bytes.subarray(0, NUL_SCAN_BYTES).includes(0)) return 'nul';
  return isValidUtf8() ? undefined : 'not_utf8';
}

/** Error returned by Edit/Write/NotebookEdit when they refuse a file. */
export function notTextWriteRefusal(reason: NotTextReason): string {
  return `File ${NOT_TEXT_DESCRIPTIONS[reason]}. These tools write UTF-8 (or UTF-16LE behind its byte-order mark) and never convert a file's encoding on their own, so nothing was written. If the file is text, make the change with a shell command that reads and writes it in its own encoding (iconv, or PowerShell Get-Content/Set-Content -Encoding), or ask the user whether to convert it to UTF-8 first. To replace the whole file with new UTF-8 text anyway, delete it first, then Write it.`;
}

/** Note appended to Read output for files the write tools will refuse. */
export function notTextReadNote(reason: NotTextReason): string {
  const replacement =
    reason === 'not_utf8'
      ? ' Its undecodable bytes show above as U+FFFD.'
      : '';
  return `[This file ${NOT_TEXT_DESCRIPTIONS[reason]}.${replacement} Edit and Write will refuse it: change it with a shell command that keeps its encoding, or ask the user whether to convert it to UTF-8.]`;
}

/** Thrown at write time when the file on disk is no longer writable text. */
export class FileNotTextError extends Error {
  constructor(readonly reason: NotTextReason) {
    super(notTextWriteRefusal(reason));
    this.name = 'FileNotTextError';
  }
}

/**
 * Detect line endings from a file by reading its first bytes.
 */
export function detectLineEndings(
  filePath: string,
  encoding: BufferEncoding = 'utf8',
): LineEndingType {
  try {
    const resolvedPath = resolveSymlink(filePath);
    const fd = openSync(resolvedPath, 'r');
    try {
      const buffer = Buffer.alloc(4096);
      const bytesRead: number = readSync(fd, buffer, 0, 4096, 0);
      const content = buffer.toString(encoding, 0, bytesRead);
      return detectLineEndingsForString(content);
    } finally {
      closeSync(fd);
    }
  } catch {
    return 'LF';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Symlink resolution
// ────────────────────────────────────────────────────────────────────────────

/**
 * If the given path is a symlink, return the resolved target path.
 * Otherwise return the path itself. Preserves the symlink itself while
 * allowing callers to write to the target.
 */
export function resolveSymlink(filePath: string): string {
  try {
    const linkTarget = readlinkSync(filePath);
    return isAbsolute(linkTarget)
      ? linkTarget
      : resolve(dirname(filePath), linkTarget);
  } catch {
    // ENOENT (doesn't exist) or EINVAL (not a symlink) — return as-is
    return filePath;
  }
}

/**
 * Check if a path is a symlink and return both the original and resolved paths.
 */
export function resolveSymlinkWithInfo(filePath: string): {
  resolvedPath: string;
  isSymlink: boolean;
} {
  try {
    const linkTarget = readlinkSync(filePath);
    const resolvedPath = isAbsolute(linkTarget)
      ? linkTarget
      : resolve(dirname(filePath), linkTarget);
    return { resolvedPath, isSymlink: true };
  } catch {
    return { resolvedPath: filePath, isSymlink: false };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Atomic write
// ────────────────────────────────────────────────────────────────────────────

/** 同步写入的脱敏诊断，不携带文件路径或内容。 */
export interface SyncAtomicWriteDiagnostic {
  event: 'begin' | 'fallback' | 'complete' | 'failed';
  stage:
    | 'resolve-target'
    | 'stat-target'
    | 'write-temp'
    | 'chmod-temp'
    | 'rename'
    | 'write-direct';
  errorCode?: string;
  temporarySuffix?: string;
  byteLength?: number;
  previousByteLength?: number;
  previousMtimeMs?: number;
}

/** 临时文件写入后原子替换；失败时保留既有直接覆盖回退。 */
export function writeFileSyncAtomic(
  filePath: string,
  content: string,
  options: {
    encoding: BufferEncoding;
    onDiagnostic?: (event: SyncAtomicWriteDiagnostic) => void;
  } = { encoding: 'utf-8' },
): void {
  // 诊断失败不得影响文件写入，也不能触发原子写的直接覆盖回退。
  const report = (event: SyncAtomicWriteDiagnostic): void => {
    try {
      options.onDiagnostic?.(event);
    } catch {
      // 日志只用于排障，保持原有业务结果。
    }
  };
  let stage: SyncAtomicWriteDiagnostic['stage'] = 'resolve-target';
  try {
    const targetPath = resolveSymlink(filePath);
    const temporarySuffix = `.tmp.${process.pid}.${Date.now()}`;
    const tempPath = `${targetPath}${temporarySuffix}`;
    let targetMode: number | undefined;
    let targetExists = false;
    let previousByteLength: number | undefined;
    let previousMtimeMs: number | undefined;
    stage = 'stat-target';
    try {
      const targetStat = statSync(targetPath);
      targetMode = targetStat.mode;
      previousByteLength = targetStat.size;
      previousMtimeMs = targetStat.mtimeMs;
      targetExists = true;
    } catch (e) {
      if (!isNodeError(e) || e.code !== 'ENOENT') throw e;
    }

    stage = 'write-temp';
    report({
      event: 'begin',
      stage,
      temporarySuffix,
      previousByteLength,
      previousMtimeMs,
      byteLength: options.onDiagnostic
        ? Buffer.byteLength(content, options.encoding)
        : undefined,
    });
    try {
      writeFileSync(tempPath, content, {
        encoding: options.encoding,
        flush: true,
      });
      if (targetExists && targetMode !== undefined) {
        stage = 'chmod-temp';
        chmodSync(tempPath, targetMode);
      }
      stage = 'rename';
      renameSync(tempPath, targetPath);
    } catch (error) {
      // 在清理临时文件和截断目标之前记录原始失败，便于追查退出期间的损坏。
      report({
        event: 'fallback',
        stage,
        errorCode: isNodeError(error) ? error.code : 'UNKNOWN',
        temporarySuffix,
        previousByteLength,
        previousMtimeMs,
      });
      try {
        unlinkSync(tempPath);
      } catch {
        // 保持既有临时文件清理语义。
      }
      stage = 'write-direct';
      writeFileSync(targetPath, content, {
        encoding: options.encoding,
        flush: true,
      });
    }
    report({
      event: 'complete',
      stage,
      temporarySuffix,
      previousByteLength,
      previousMtimeMs,
    });
  } catch (error) {
    report({
      event: 'failed',
      stage,
      errorCode: isNodeError(error) ? error.code : 'UNKNOWN',
    });
    throw error;
  }
}

const RENAME_FALLBACK_ERRORS = new Set(['EXDEV', 'EPERM', 'EEXIST', 'EBUSY']);

/**
 * Async variant of writeFileSyncAtomic.
 * Uses the same temp-file + atomic rename strategy. An existing file keeps
 * its permissions; `mode` sets those of a file this call creates.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string,
  options: {
    encoding: BufferEncoding;
    beforeWrite?: () => void;
    mode?: number;
  } = {
    encoding: 'utf-8',
  },
): Promise<void> {
  // Resolve symlinks to write to the target while preserving the link
  const targetPath = resolveSymlink(filePath);

  const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;

  // Get existing file permissions if the file already exists
  let targetMode: number | undefined;
  let targetExists = false;
  try {
    const stats = await fsPromises.stat(targetPath);
    targetMode = stats.mode;
    targetExists = true;
  } catch (e) {
    if (!isNodeError(e) || e.code !== 'ENOENT') throw e;
  }

  let phase: 'staging' | 'guard' | 'rename' = 'staging';
  try {
    // Write to temp file with flush for durability
    await fsPromises.writeFile(tempPath, content, {
      encoding: options.encoding,
      flush: true,
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });

    // Preserve original permissions for existing files
    if (targetExists && targetMode !== undefined) {
      await fsPromises.chmod(tempPath, targetMode);
    }

    phase = 'guard';
    // A guard failure must never be retried as an I/O fallback.
    options.beforeWrite?.();
    phase = 'rename';
    await fsPromises.rename(tempPath, targetPath);
  } catch (error) {
    // Clean up temp file on error
    try {
      await fsPromises.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }

    if (
      !isNodeError(error) ||
      !(
        (phase === 'rename' && RENAME_FALLBACK_ERRORS.has(error.code ?? '')) ||
        (phase === 'staging' && targetExists && error.code === 'EACCES')
      )
    )
      throw error;
    options.beforeWrite?.();
    // Fallback to non-atomic write
    await fsPromises.writeFile(targetPath, content, {
      encoding: options.encoding,
      flush: true,
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Write with encoding + line ending preservation
// ────────────────────────────────────────────────────────────────────────────

/**
 * Write text content to a file, preserving the original encoding
 * and line ending style. Uses atomic write internally.
 *
 * @param filePath - Target file path
 * @param content - Content to write (in LF form)
 * @param encoding - File encoding to use
 * @param endings - Line ending type to apply
 */
export async function writeTextContent(
  filePath: string,
  content: string,
  encoding: BufferEncoding,
  endings: LineEndingType,
  beforeWrite?: () => void,
): Promise<void> {
  let toWrite = content;
  if (endings === 'CRLF') {
    // Normalize any existing CRLF to LF first so that raw model output
    // containing \r\n doesn't become \r\r\n after the join.
    toWrite = content.replaceAll('\r\n', '\n').split('\n').join('\r\n');
  }

  await writeFileAtomic(filePath, toWrite, { encoding, beforeWrite });
}

// ────────────────────────────────────────────────────────────────────────────
// Read file with metadata (encoding + line endings)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Read a file and return its content (LF-normalized), detected encoding,
 * and detected line ending style.
 */
export function readFileWithMetadata(filePath: string): {
  content: string;
  encoding: BufferEncoding;
  lineEndings: LineEndingType;
  notText?: NotTextReason;
} {
  const { resolvedPath, isSymlink: _isSymlink } =
    resolveSymlinkWithInfo(filePath);

  const bytes = readFileSync(resolvedPath);
  const encoding = detectEncodingFromBytes(bytes.subarray(0, 4096));
  const notText = detectNotText(bytes);
  const raw = bytes.toString(encoding);
  // Detect line endings from the raw head before CRLF normalization erases
  // the distinction.
  const lineEndings = detectLineEndingsForString(raw.slice(0, 4096));
  return {
    content: raw.replaceAll('\r\n', '\n'),
    encoding,
    lineEndings,
    ...(notText && { notText }),
  };
}
