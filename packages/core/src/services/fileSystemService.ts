/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import * as path from 'node:path';
import { globSync } from 'glob';
import {
  readFileWithEncoding,
  readFileWithEncodingInfo,
} from '../utils/fileUtils.js';
import type { FileReadResult } from '../utils/fileUtils.js';
import {
  iconvEncode,
  iconvEncodingExists,
  isUtf8CompatibleEncoding,
} from '../utils/iconvHelper.js';

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
  /**
   * Read text content from a file
   *
   * @param filePath - The path to the file to read
   * @returns The file content as a string
   */
  readTextFile(filePath: string): Promise<string>;

  /**
   * Read text content from a file, returning both the content and encoding metadata.
   * Combines readTextFile + detectFileBOM + detectFileEncoding into a single I/O pass.
   *
   * @param filePath - The path to the file to read
   * @returns The file content, encoding name, and whether a UTF-8 BOM was present
   */
  readTextFileWithInfo(filePath: string): Promise<FileReadResult>;

  /**
   * Write text content to a file
   *
   * @param filePath - The path to the file to write
   * @param content - The content to write
   * @param options - Optional write options including whether to add BOM
   */
  writeTextFile(
    filePath: string,
    content: string,
    options?: WriteTextFileOptions,
  ): Promise<void>;

  /**
   * Detects if a file has UTF-8 BOM (Byte Order Mark).
   *
   * @param filePath - The path to the file to check
   * @returns True if the file has BOM, false otherwise
   */
  detectFileBOM(filePath: string): Promise<boolean>;

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
 * Detects if a buffer has UTF-8 BOM (Byte Order Mark).
 * UTF-8 BOM is the byte sequence EF BB BF.
 *
 * @param buffer - The buffer to check
 * @returns True if the buffer starts with UTF-8 BOM
 */
function hasUTF8BOM(buffer: Buffer): boolean {
  return (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  );
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
  async readTextFile(filePath: string): Promise<string> {
    // Use encoding-aware reader that handles BOM and non-UTF-8 encodings (e.g. GBK)
    return readFileWithEncoding(filePath);
  }

  async readTextFileWithInfo(filePath: string): Promise<FileReadResult> {
    // Single I/O pass: returns content, encoding, and BOM flag together,
    // eliminating the need for separate detectFileEncoding / detectFileBOM calls.
    return readFileWithEncodingInfo(filePath);
  }

  async writeTextFile(
    filePath: string,
    content: string,
    options?: WriteTextFileOptions,
  ): Promise<void> {
    const bom = options?.bom ?? false;
    const encoding = options?.encoding;

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
  }

  async detectFileBOM(filePath: string): Promise<boolean> {
    let fd: fs.FileHandle | undefined;
    try {
      // Read only the first 3 bytes to check for BOM
      fd = await fs.open(filePath, 'r');
      const buffer = Buffer.alloc(3);
      const { bytesRead } = await fd.read(buffer, 0, 3, 0);

      if (bytesRead < 3) {
        return false;
      }

      return hasUTF8BOM(buffer);
    } catch {
      // File doesn't exist or can't be read - treat as no BOM
      return false;
    } finally {
      await fd?.close();
    }
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
