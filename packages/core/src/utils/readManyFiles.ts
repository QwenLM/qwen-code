/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Part, PartListUnion } from '@google/genai';
import type { Config } from '../config/config.js';
import { getErrorMessage } from './errors.js';
import { processSingleFileContent } from './fileUtils.js';
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
  const { paths: inputPatterns } = options;

  const seenFiles = new Set<string>();
  const contentParts: Part[] = [];
  const files: FileReadInfo[] = [];

  try {
    const projectRoot = config.getProjectRoot();

    for (const rawPattern of inputPatterns) {
      const normalizedPattern = rawPattern.replace(/\\/g, '/');
      const fullPath = path.resolve(projectRoot, normalizedPattern);
      const stats = fs.existsSync(fullPath) ? fs.statSync(fullPath) : null;

      if (stats?.isDirectory()) {
        const { contentParts: dirParts, info } = await readDirectory(
          config,
          fullPath,
        );
        contentParts.push(...dirParts);
        files.push(info);
        continue;
      }

      if (stats?.isFile() && !seenFiles.has(fullPath)) {
        seenFiles.add(fullPath);
        const readResult = await readFileContent(config, fullPath);
        if (readResult) {
          contentParts.push(...readResult.contentParts);
          files.push(readResult.info);
        }
      }
    }
  } catch (error) {
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

async function readDirectory(
  config: Config,
  directoryPath: string,
): Promise<{ contentParts: Part[]; info: FileReadInfo }> {
  const structure = await getFolderStructure(directoryPath, {
    fileService: config.getFileService(),
    fileFilteringOptions: config.getFileFilteringOptions(),
  });

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
): Promise<{ contentParts: Part[]; info: FileReadInfo } | null> {
  try {
    const fileReadResult = await processSingleFileContent(filePath, config);
    if (fileReadResult.error) {
      return null;
    }

    const prefixText: Part = { text: `\nContent from ${filePath}:\n` };

    if (typeof fileReadResult.llmContent === 'string') {
      let fileContentForLlm = '';
      if (fileReadResult.isTruncated) {
        const [start, end] = fileReadResult.linesShown!;
        const total = fileReadResult.originalLineCount!;
        fileContentForLlm = `Showing lines ${start}-${end} of ${total} total lines.\n---\n${fileReadResult.llmContent}`;
      } else {
        fileContentForLlm = fileReadResult.llmContent;
      }
      const contentParts: Part[] = [prefixText, { text: fileContentForLlm }];
      return {
        contentParts,
        info: {
          filePath,
          content: fileContentForLlm,
          isDirectory: false,
        },
      };
    }

    // For binary files (images, PDFs), add prefix text before the inlineData/fileData part
    const contentParts: Part[] = [prefixText, fileReadResult.llmContent];
    return {
      contentParts,
      info: {
        filePath,
        content: fileReadResult.llmContent,
        isDirectory: false,
      },
    };
  } catch {
    return null;
  }
}
