/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { globSync } from 'glob';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { readFileWithLineAndLimit } from '../utils/fileUtils.js';
import {
  readTextCursorWindowFromHandle,
  readTextRangeFromHandle,
  type ReadTextCursorWindowResult,
} from '../utils/read-text-range.js';
import { isUtf8CompatibleEncoding } from '../utils/encoding.js';
import { loadIconvLite, type IconvLite } from '../utils/load-iconv-lite.js';
import { getSystemEncoding } from '../utils/systemEncoding.js';
import type {
  ReadTextFileRequest,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import type { ToolWriteOrigin } from './tool-write-origin.js';

export type LineEnding = 'crlf' | 'lf';

export type ReadTextFileResponse = {
  content: string;
  _meta?: {
    bom?: boolean;
    encoding?: string;
    originalLineCount?: number;
    originalLineCountExact?: boolean;
    lineEnding?: LineEnding;
    truncatedByBytes?: boolean;
    /** Byte offset to resume from; absent once the read reached EOF. */
    nextByteOffset?: number;
  };
};

export type CoreReadTextFileRequest = Omit<
  ReadTextFileRequest,
  'sessionId' | 'line'
> & {
  /**
   * Core-local callers use 0-based line offsets. ACP protocol boundaries remain
   * 1-based and convert explicitly before remote calls.
   */
  line?: number | null;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  stats?: Stats;
};

export type CoreWriteTextFileRequest = Omit<
  WriteTextFileRequest,
  'sessionId'
> & {
  /**
   * Internal core provenance for a final built-in tool write. This is not part
   * of any tool schema and is serialized only at the ACP boundary.
   */
  toolWriteOrigin?: ToolWriteOrigin;
};

/**
 * Handle-bound range read used by filesystem security boundaries. The caller
 * opens the descriptor, keeps it open for the duration, and closes it; this
 * request never transfers ownership.
 *
 * Declared standalone rather than derived from {@link CoreReadTextFileRequest}:
 * a handle-bound read shares only `line` and `signal` with a path-bound one, so
 * an `Omit` chain would strip more than it kept and would keep re-admitting
 * fields that this path has no use for. `fileSize` is the one value retained
 * from the descriptor's opening stat because it bounds reads against appends.
 *
 * Both byte bounds are required rather than optional: what makes a large-file
 * read safe at a boundary is that the *returned* bytes and the *scanned* bytes
 * are each capped. A finite `limit` is not one of those bounds — `limit: 20` at
 * `line: 900_000_000` still walks the whole file — so it stays optional and
 * `maxScanBytes` is what actually keeps the read affordable.
 */
export interface CoreReadTextFileHandleRequest {
  fileHandle: FileHandle;
  /** File size captured from the opened descriptor before reading. */
  fileSize: number;
  /** 0-based start line, matching {@link CoreReadTextFileRequest}. */
  line?: number | null;
  limit?: number;
  maxOutputBytes: number;
  maxScanBytes: number;
  signal?: AbortSignal;
}

/**
 * Byte-cursor read used by filesystem security boundaries to page text without
 * re-scanning from byte 0. Same borrowed-descriptor contract as
 * {@link CoreReadTextFileHandleRequest}.
 */
export interface CoreReadTextCursorRequest {
  fileHandle: FileHandle;
  startOffset: number;
  fileSize: number;
  limit?: number;
  maxOutputBytes: number;
  maxSnapBytes: number;
  signal?: AbortSignal;
}

/**
 * Supported file encodings for new files.
 */
export const FileEncoding = {
  UTF8: 'utf-8',
  UTF8_BOM: 'utf-8-bom',
} as const;

/**
 * Type for file encoding values.
 */
export type FileEncodingType = (typeof FileEncoding)[keyof typeof FileEncoding];

/**
 * Interface for file system operations that may be delegated to different implementations
 */
export interface FileSystemService {
  readTextFile(params: CoreReadTextFileRequest): Promise<ReadTextFileResponse>;

  readTextFileFromHandle?(
    params: CoreReadTextFileHandleRequest,
  ): Promise<ReadTextFileResponse>;

  writeTextFile(
    params: CoreWriteTextFileRequest,
  ): Promise<WriteTextFileResponse>;

  /**
   * Finds files with a given name within specified search paths.
   *
   * @param fileName - The name of the file to find.
   * @param searchPaths - An array of directory paths to search within.
   * @returns An array of absolute paths to the found files.
   */
  findFiles(fileName: string, searchPaths: readonly string[]): string[];
}

/**
 * Options for writing text files
 */
export interface WriteTextFileOptions {
  /**
   * Whether to write the file with UTF-8 BOM.
   * If true, EF BB BF will be prepended to the content.
   * @default false
   */
  bom?: boolean;

  /**
   * The encoding to use when writing the file.
   * If specified and not UTF-8 compatible, iconv-lite will be used to encode.
   * This is used to preserve the original encoding of non-UTF-8 files (e.g. GBK, Big5).
   * @default undefined (writes as UTF-8)
   */
  encoding?: string;
}

/**
 * File extensions that require CRLF (\r\n) line endings to function correctly.
 * cmd.exe parses .bat/.cmd files using CRLF delimiters; LF-only endings can
 * break multi-line constructs, labels, and goto statements.
 */
const CRLF_EXTENSIONS = new Set(['.bat', '.cmd']);

/**
 * File extensions that need UTF-8 BOM on Windows with a non-UTF-8 code page.
 * PowerShell 5.1 (the version that ships with Windows) reads BOM-less files
 * using the system's ANSI code page. Without a BOM, any non-ASCII characters
 * in the script will be misinterpreted (e.g. on a GBK system). PowerShell 7+
 * defaults to UTF-8 and handles BOM fine, so adding BOM is always safe.
 */
const UTF8_BOM_EXTENSIONS = new Set(['.ps1']);

// Cache so we only call getSystemEncoding() once per process
let cachedIsNonUtf8Windows: boolean | undefined;

/**
 * Returns true if a newly created file at the given path should be written
 * with a UTF-8 BOM. Conditions (all must be true):
 * 1. Running on Windows
 * 2. System code page is not UTF-8
 * 3. File extension is in UTF8_BOM_EXTENSIONS (e.g. .ps1)
 */
export function needsUtf8Bom(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (!UTF8_BOM_EXTENSIONS.has(ext)) {
    return false;
  }
  if (cachedIsNonUtf8Windows === undefined) {
    if (os.platform() !== 'win32') {
      cachedIsNonUtf8Windows = false;
    } else {
      const sysEnc = getSystemEncoding();
      cachedIsNonUtf8Windows = sysEnc !== 'utf-8';
    }
  }
  return cachedIsNonUtf8Windows;
}

/**
 * Reset the UTF-8 BOM cache — useful for testing.
 */
export function resetUtf8BomCache(): void {
  cachedIsNonUtf8Windows = undefined;
}

/**
 * Returns true if the file at the given path requires CRLF line endings.
 * Only applies on Windows where cmd.exe actually parses these files.
 */
function needsCrlfLineEndings(filePath: string): boolean {
  if (os.platform() !== 'win32') {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  return CRLF_EXTENSIONS.has(ext);
}

/**
 * Ensures content uses CRLF line endings. First normalizes any existing
 * CRLF to LF to avoid double-conversion, then converts all LF to CRLF.
 */
export function ensureCrlfLineEndings(content: string): string {
  // First normalize CRLF to LF to avoid double-conversion, then convert all LF to CRLF
  return content.split('\r\n').join('\n').split('\n').join('\r\n');
}

/**
 * Detects whether the content uses CRLF or LF line endings.
 * Returns 'crlf' if the content contains at least one CRLF sequence,
 * 'lf' otherwise (including for content with no line endings).
 */
export function detectLineEnding(content: string): LineEnding {
  return content.includes('\r\n') ? 'crlf' : 'lf';
}

export interface PreparedTextFileContent {
  data: string | Buffer;
  encoding?: BufferEncoding;
}

/**
 * Return the BOM byte sequence for a given encoding name, or null if the
 * encoding does not use a standard BOM. Used when writing back a file that
 * originally had a BOM so the BOM is preserved.
 */
function getBOMBytesForEncoding(encoding: string): Buffer | null {
  const lower = encoding.toLowerCase().replace(/[^a-z0-9]/g, '');
  switch (lower) {
    case 'utf8':
      return Buffer.from([0xef, 0xbb, 0xbf]);
    case 'utf16le':
    case 'utf16':
      return Buffer.from([0xff, 0xfe]);
    case 'utf16be':
      return Buffer.from([0xfe, 0xff]);
    case 'utf32le':
    case 'utf32':
      return Buffer.from([0xff, 0xfe, 0x00, 0x00]);
    case 'utf32be':
      return Buffer.from([0x00, 0x00, 0xfe, 0xff]);
    default:
      return null;
  }
}

export function prepareTextFileContent(
  filePath: string,
  content: string,
  meta?: ReadTextFileResponse['_meta'] | null,
  iconvLite?: IconvLite,
): PreparedTextFileContent | undefined {
  const lineEnding = meta?.['lineEnding'] as string | undefined;
  const shouldUseCrlf = needsCrlfLineEndings(filePath) || lineEnding === 'crlf';
  const normalizedContent = shouldUseCrlf
    ? ensureCrlfLineEndings(content)
    : content;
  const bom = meta?.['bom'] ?? (false as boolean);
  const encoding = meta?.['encoding'] as string | undefined;

  // Check if a non-UTF-8 encoding is specified and supported by iconv-lite
  if (encoding && !isUtf8CompatibleEncoding(encoding) && !iconvLite) {
    return undefined;
  }

  if (
    encoding &&
    !isUtf8CompatibleEncoding(encoding) &&
    iconvLite?.encodingExists(encoding)
  ) {
    // Non-UTF-8 encoding (e.g. GBK, Big5, Shift_JIS, UTF-16LE, UTF-32BE…)
    // Use iconv-lite to encode the content. When the file originally had a BOM
    // (bom: true), prepend the correct BOM bytes for this encoding so the
    // byte-order mark is preserved on write-back.
    const encoded = iconvLite.encode(normalizedContent, encoding);
    if (bom) {
      const bomBytes = getBOMBytesForEncoding(encoding);
      return {
        data: bomBytes ? Buffer.concat([bomBytes, encoded]) : encoded,
      };
    }
    return { data: encoded };
  }

  if (bom) {
    // UTF-8 BOM: prepend EF BB BF
    // If content already starts with the BOM character, strip it first to avoid double BOM.
    const contentWithoutBom =
      normalizedContent.charCodeAt(0) === 0xfeff
        ? normalizedContent.slice(1)
        : normalizedContent;
    const bomBuffer = Buffer.from([0xef, 0xbb, 0xbf]);
    const contentBuffer = Buffer.from(contentWithoutBom, 'utf-8');
    return { data: Buffer.concat([bomBuffer, contentBuffer]) };
  }

  return { data: normalizedContent, encoding: 'utf-8' };
}

export async function prepareTextFileContentAsync(
  filePath: string,
  content: string,
  meta?: ReadTextFileResponse['_meta'] | null,
): Promise<PreparedTextFileContent> {
  let prepared = prepareTextFileContent(filePath, content, meta);
  if (!prepared) {
    prepared = prepareTextFileContent(
      filePath,
      content,
      meta,
      await loadIconvLite(),
    );
  }
  if (!prepared) {
    throw new Error('iconv-lite did not prepare non-UTF-8 text content');
  }
  return prepared;
}

export async function encodeTextFileContentAsync(
  filePath: string,
  content: string,
  meta?: ReadTextFileResponse['_meta'] | null,
): Promise<Buffer> {
  const prepared = await prepareTextFileContentAsync(filePath, content, meta);
  return Buffer.isBuffer(prepared.data)
    ? prepared.data
    : Buffer.from(prepared.data, prepared.encoding ?? 'utf-8');
}

/**
 * Standard file system implementation
 */
export class StandardFileSystemService implements FileSystemService {
  async readTextFile(
    params: CoreReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    return readTextFileStandard(params);
  }

  async readTextFileFromHandle(
    params: CoreReadTextFileHandleRequest,
  ): Promise<ReadTextFileResponse> {
    if (!Number.isSafeInteger(params.fileSize) || params.fileSize < 0) {
      throw new RangeError(
        `handle-bound text reads require a non-negative integer fileSize, got ${params.fileSize}`,
      );
    }
    if (!isPositiveSafeInteger(params.maxOutputBytes)) {
      throw new RangeError(
        `handle-bound text reads require a positive finite maxOutputBytes, got ${params.maxOutputBytes}`,
      );
    }
    if (!isPositiveSafeInteger(params.maxScanBytes)) {
      throw new RangeError(
        `handle-bound text reads require a positive finite maxScanBytes, got ${params.maxScanBytes}`,
      );
    }
    if (
      params.limit !== undefined &&
      params.limit !== Number.POSITIVE_INFINITY &&
      !isPositiveSafeInteger(params.limit)
    ) {
      throw new RangeError(
        `handle-bound text reads require a positive integer limit or Infinity, got ${params.limit}`,
      );
    }
    if (
      params.line !== undefined &&
      params.line !== null &&
      (!Number.isSafeInteger(params.line) || params.line < 0)
    ) {
      throw new RangeError(
        `handle-bound text reads require a non-negative integer line, got ${params.line}`,
      );
    }
    const range = await readTextRangeFromHandle(params.fileHandle, {
      offset: params.line ?? 0,
      limit: params.limit ?? Number.POSITIVE_INFINITY,
      fileSize: params.fileSize,
      maxOutputBytes: params.maxOutputBytes,
      maxScanBytes: params.maxScanBytes,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    });
    return toReadTextFileResponse(range);
  }

  async readTextCursorFromHandle(
    params: CoreReadTextCursorRequest,
  ): Promise<ReadTextCursorWindowResult> {
    if (!isPositiveSafeInteger(params.maxOutputBytes)) {
      throw new RangeError(
        `cursor reads require a positive finite maxOutputBytes, got ${params.maxOutputBytes}`,
      );
    }
    if (!isPositiveSafeInteger(params.maxSnapBytes)) {
      throw new RangeError(
        `cursor reads require a positive finite maxSnapBytes, got ${params.maxSnapBytes}`,
      );
    }
    if (
      !Number.isSafeInteger(params.startOffset) ||
      params.startOffset < 0 ||
      !Number.isSafeInteger(params.fileSize) ||
      params.fileSize < 0
    ) {
      throw new RangeError(
        `cursor reads require non-negative integer startOffset and fileSize, got ${params.startOffset}/${params.fileSize}`,
      );
    }
    if (params.limit !== undefined && !isPositiveSafeInteger(params.limit)) {
      throw new RangeError(
        `cursor reads require a positive integer limit, got ${params.limit}`,
      );
    }
    return readTextCursorWindowFromHandle(params.fileHandle, {
      startOffset: params.startOffset,
      fileSize: params.fileSize,
      maxOutputBytes: params.maxOutputBytes,
      maxSnapBytes: params.maxSnapBytes,
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
    });
  }

  async writeTextFile(
    params: CoreWriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    const { path: filePath, _meta } = params;
    const prepared = await prepareTextFileContentAsync(
      filePath,
      params.content,
      _meta,
    );
    if (Buffer.isBuffer(prepared.data)) {
      await atomicWriteFile(filePath, prepared.data);
    } else {
      await atomicWriteFile(filePath, prepared.data, {
        encoding: prepared.encoding ?? 'utf-8',
      });
    }
    return { _meta };
  }

  findFiles(fileName: string, searchPaths: readonly string[]): string[] {
    return searchPaths.flatMap((searchPath) => {
      const pattern = path.posix.join(searchPath, '**', fileName);
      return globSync(pattern, {
        nodir: true,
        absolute: true,
      });
    });
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

async function readTextFileStandard(
  params: CoreReadTextFileRequest,
): Promise<ReadTextFileResponse> {
  const { path, limit, line, maxOutputBytes, signal, stats } = params;
  const readResult = await readFileWithLineAndLimit({
    path,
    limit: limit ?? Number.POSITIVE_INFINITY,
    ...(line !== undefined && line !== null ? { line } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(stats !== undefined ? { stats } : {}),
  });
  return toReadTextFileResponse(readResult);
}

/** Shared metadata shaping so both read paths report identically. */
function toReadTextFileResponse(readResult: {
  content: string;
  bom?: boolean;
  encoding?: string;
  originalLineCount: number;
  originalLineCountExact?: boolean;
  lineEnding?: LineEnding;
  truncatedByBytes?: boolean;
  nextByteOffset?: number;
}): ReadTextFileResponse {
  const detectedLineEnding =
    readResult.lineEnding ?? detectLineEnding(readResult.content);
  return {
    content: readResult.content,
    _meta: {
      bom: readResult.bom,
      encoding: readResult.encoding,
      originalLineCount: readResult.originalLineCount,
      originalLineCountExact: readResult.originalLineCountExact,
      lineEnding: detectedLineEnding,
      ...(readResult.truncatedByBytes !== undefined
        ? { truncatedByBytes: readResult.truncatedByBytes }
        : {}),
      ...(readResult.nextByteOffset !== undefined
        ? { nextByteOffset: readResult.nextByteOffset }
        : {}),
    },
  };
}
