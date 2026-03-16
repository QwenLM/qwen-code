/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import * as path from 'node:path';
import { globSync } from 'glob';
import { readFileWithLineAndLimit } from '../utils/fileUtils.js';
import {
  iconvEncode,
  iconvEncodingExists,
  isUtf8CompatibleEncoding,
} from '../utils/iconvHelper.js';
import type {
  ReadTextFileRequest,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

export type ReadTextFileResponse = {
  content: string;
  _meta?: {
    bom?: boolean;
    encoding?: string;
    originalLineCount?: number;
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
    return { content, _meta: { bom, encoding, originalLineCount } };
  }

  async writeTextFile(
    params: Omit<WriteTextFileRequest, 'sessionId'>,
  ): Promise<WriteTextFileResponse> {
    const { content, path: filePath, _meta } = params;
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
