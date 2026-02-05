/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import * as path from 'node:path';
import { globSync } from 'glob';

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
 * Standard file system implementation
 */
export class StandardFileSystemService implements FileSystemService {
  async readTextFile(filePath: string): Promise<string> {
    return fs.readFile(filePath, FileEncoding.UTF8);
  }

  async writeTextFile(
    filePath: string,
    content: string,
    options?: WriteTextFileOptions,
  ): Promise<void> {
    const bom = options?.bom ?? false;

    if (bom) {
      // Prepend UTF-8 BOM (EF BB BF)
      // If content already starts with BOM character, strip it first to avoid double BOM
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
