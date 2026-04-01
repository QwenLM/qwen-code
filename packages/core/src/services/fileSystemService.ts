/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import * as path from 'node:path';
import { globSync } from 'glob';
import { readFileWithLineAndLimit } from '../utils/fileUtils.js';
import {
  iconvEncode,
  iconvEncodingExists,
  isUtf8CompatibleEncoding,
} from '../utils/iconvHelper.js';
import { getSystemEncoding } from '../utils/systemEncoding.js';
import type {
  ReadTextFileRequest,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

export type LineEnding = 'crlf' | 'lf';

export type ReadTextFileResponse = {
  content: string;
  _meta?: {
    bom?: boolean;
    encoding?: string;
    originalLineCount?: number;
    lineEnding?: LineEnding;
  };
};

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
  readTextFile(
    params: Omit<ReadTextFileRequest, 'sessionId'>,
  ): Promise<ReadTextFileResponse>;

  writeTextFile(
    params: Omit<WriteTextFileRequest, 'sessionId'>,
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

/**
 * Standard file system implementation
 */
export class StandardFileSystemService implements FileSystemService {
  async readTextFile(
    params: Omit<ReadTextFileRequest, 'sessionId'>,
  ): Promise<ReadTextFileResponse> {
    const { path, limit, line } = params;
    // Use encoding-aware reader that handles BOM and non-UTF-8 encodings (e.g. GBK)
    const { content, bom, encoding, originalLineCount } =
      await readFileWithLineAndLimit({
        path,
        limit: limit ?? Number.POSITIVE_INFINITY,
        line: line || 0,
      });
    const lineEnding = detectLineEnding(content);
    return { content, _meta: { bom, encoding, originalLineCount, lineEnding } };
  }

  async writeTextFile(
    params: Omit<WriteTextFileRequest, 'sessionId'>,
  ): Promise<WriteTextFileResponse> {
    const { path: filePath, _meta } = params;
    const lineEnding = _meta?.['lineEnding'] as string | undefined;
    // Convert LF to CRLF when:
    // 1. The file type requires it (e.g. .bat, .cmd on Windows), OR
    // 2. The original file used CRLF line endings (preserve original style)
    const shouldUseCrlf =
      needsCrlfLineEndings(filePath) || lineEnding === 'crlf';
    const content = shouldUseCrlf
      ? ensureCrlfLineEndings(params.content)
      : params.content;
    const bom = _meta?.['bom'] ?? (false as boolean);
    const encoding = _meta?.['encoding'] as string | undefined;

    // Check if a non-UTF-8 encoding is specified and supported by iconv-lite
    const isNonUtf8Encoding =
      encoding &&
      !isUtf8CompatibleEncoding(encoding) &&
      iconvEncodingExists(encoding);

    if (isNonUtf8Encoding) {
      // Non-UTF-8 encoding (e.g. GBK, Big5, Shift_JIS, UTF-16LE, UTF-32BE…)
      // Use iconv-lite to encode the content. When the file originally had a BOM
      // (bom: true), prepend the correct BOM bytes for this encoding so the
      // byte-order mark is preserved on write-back.
      const encoded = iconvEncode(content, encoding);
      if (bom) {
        const bomBytes = getBOMBytesForEncoding(encoding);
        await fs.writeFile(
          filePath,
          bomBytes ? Buffer.concat([bomBytes, encoded]) : encoded,
        );
      } else {
        await fs.writeFile(filePath, encoded);
      }
    } else if (bom) {
      // UTF-8 BOM: prepend EF BB BF
      // If content already starts with the BOM character, strip it first to avoid double BOM.
      const normalizedContent =
        content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
      const bomBuffer = Buffer.from([0xef, 0xbb, 0xbf]);
      const contentBuffer = Buffer.from(normalizedContent, 'utf-8');
      await fs.writeFile(filePath, Buffer.concat([bomBuffer, contentBuffer]));
    } else {
      await fs.writeFile(filePath, content, 'utf-8');
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
