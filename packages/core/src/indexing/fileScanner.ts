/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as crypto from 'node:crypto';
import { runRipgrep } from '../utils/ripgrepUtils.js';
import {
  FileDiscoveryService,
  type FilterFilesOptions,
} from '../services/fileDiscoveryService.js';
import type { FileMetadata, FileStatInfo, IFileScanner } from './types.js';

/**
 * Concurrency limit for file hash computations.
 * A moderate value (4-8) balances throughput with I/O contention.
 */
const HASH_CONCURRENCY = 4;

/**
 * Mapping from file extension to programming language.
 */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // TypeScript/JavaScript
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  // Python
  '.py': 'python',
  '.pyi': 'python',
  '.pyw': 'python',
  // Go
  '.go': 'go',
  // Rust
  '.rs': 'rust',
  // Java/Kotlin
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  // C/C++
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hxx': 'cpp',
  // C#
  '.cs': 'csharp',
  // Ruby
  '.rb': 'ruby',
  '.rake': 'ruby',
  // PHP
  '.php': 'php',
  // Swift
  '.swift': 'swift',
  // Shell
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  // Web
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  // Data/Config
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.md': 'markdown',
  // SQL
  '.sql': 'sql',
};

/**
 * Options for file scanning operations.
 */
export interface FileScannerOptions extends FilterFilesOptions {
  /**
   * AbortSignal to cancel the scan operation.
   */
  signal?: AbortSignal;
}

/**
 * FileScanner implementation using ripgrep for file discovery
 * and FileDiscoveryService for gitignore/qwenignore filtering.
 */
export class FileScanner implements IFileScanner {
  private projectRoot: string;
  private discoveryService: FileDiscoveryService;
  private options: FileScannerOptions;

  constructor(projectRoot: string, options: FileScannerOptions = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.options = {
      respectGitIgnore: true,
      respectQwenIgnore: true,
      ...options,
    };
    this.discoveryService = new FileDiscoveryService(this.projectRoot);
  }

  /**
   * Scans the project for all eligible source files and returns their metadata.
   *
   * @param projectRoot - The root directory to scan (defaults to constructor value)
   * @returns Array of FileMetadata for all discovered files
   */
  async scanFiles(projectRoot?: string): Promise<FileMetadata[]> {
    const root = projectRoot ? path.resolve(projectRoot) : this.projectRoot;

    // Use ripgrep to get all files efficiently
    const allFiles = await this.listFilesWithRipgrep(root);

    // Filter using FileDiscoveryService
    const filteredFiles = this.discoveryService.filterFiles(allFiles, {
      respectGitIgnore: this.options.respectGitIgnore,
      respectQwenIgnore: this.options.respectQwenIgnore,
    });

    // Compute metadata with controlled concurrency
    const metadata = await this.computeFileMetadata(root, filteredFiles);

    return metadata;
  }

  /**
   * Lightweight scan — returns only `stat()` info (mtime, size) for each file.
   * Does NOT read file content or compute hashes.
   * This is the first level of two-level change detection:
   *   1. `scanFileStats()` — cheap, O(stat) per file
   *   2. `scanSpecificFiles()` — expensive, O(read+hash) per file, only for candidates
   *
   * @param projectRoot - The root directory to scan (defaults to constructor value)
   * @returns Array of FileStatInfo (no contentHash)
   */
  async scanFileStats(projectRoot?: string): Promise<FileStatInfo[]> {
    const root = projectRoot ? path.resolve(projectRoot) : this.projectRoot;

    const allFiles = await this.listFilesWithRipgrep(root);

    const filteredFiles = this.discoveryService.filterFiles(allFiles, {
      respectGitIgnore: this.options.respectGitIgnore,
      respectQwenIgnore: this.options.respectQwenIgnore,
    });

    const results: FileStatInfo[] = [];

    // stat() is very cheap — we can use higher concurrency than hash
    const STAT_CONCURRENCY = 16;

    for (let i = 0; i < filteredFiles.length; i += STAT_CONCURRENCY) {
      if (this.options.signal?.aborted) {
        throw new Error('File scan aborted');
      }

      const batch = filteredFiles.slice(i, i + STAT_CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(async (relPath) => {
          const absPath = path.join(root, relPath);
          const stat = await fs.stat(absPath);
          if (!stat.isFile()) return null;
          // Skip very large files (> 10MB) — same threshold as getFileMetadata
          if (stat.size > 10 * 1024 * 1024) return null;
          return {
            path: relPath,
            lastModified: stat.mtimeMs,
            size: stat.size,
            language: this.detectLanguage(relPath),
          } satisfies FileStatInfo;
        }),
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
        }
      }
    }

    return results;
  }

  /**
   * Counts the number of eligible files without computing full metadata.
   *
   * @param projectRoot - The root directory to count (defaults to constructor value)
   * @returns Number of eligible files
   */
  async countFiles(projectRoot?: string): Promise<number> {
    const root = projectRoot ? path.resolve(projectRoot) : this.projectRoot;

    const allFiles = await this.listFilesWithRipgrep(root);

    const filteredFiles = this.discoveryService.filterFiles(allFiles, {
      respectGitIgnore: this.options.respectGitIgnore,
      respectQwenIgnore: this.options.respectQwenIgnore,
    });

    return filteredFiles.length;
  }

  /**
   * Scans specific files and returns their metadata.
   * Useful for incremental updates when specific files have changed.
   *
   * @param filePaths - Array of file paths (relative or absolute)
   * @returns Array of FileMetadata for the specified files
   */
  async scanSpecificFiles(filePaths: string[]): Promise<FileMetadata[]> {
    const metadata: FileMetadata[] = [];

    for (const filePath of filePaths) {
      const absPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(this.projectRoot, filePath);
      const relPath = path.relative(this.projectRoot, absPath);

      try {
        const stat = await fs.stat(absPath);
        if (!stat.isFile()) continue;

        const hash = await this.computeFileHash(absPath);
        const language = this.detectLanguage(relPath);

        metadata.push({
          path: relPath,
          contentHash: hash,
          lastModified: stat.mtimeMs,
          size: stat.size,
          language,
        });
      } catch {
        // File may have been deleted; skip it
        continue;
      }
    }

    return metadata;
  }

  /**
   * Uses ripgrep to list all files in a directory.
   * Leverages ripgrep's built-in .gitignore support for performance.
   * When respectGitIgnore is enabled (default), ripgrep automatically skips
   * ignored directories like node_modules, avoiding expensive traversal.
   */
  private async listFilesWithRipgrep(root: string): Promise<string[]> {
    const args = ['--files', '--hidden'];

    // Use ripgrep's built-in .gitignore support when respectGitIgnore is enabled
    // This is MUCH faster than scanning everything and filtering later,
    // as ripgrep will skip entire directories like node_modules
    if (!this.options.respectGitIgnore) {
      args.push('--no-ignore');
    }

    // Add .qwenignore support via --ignore-file if it exists and is enabled
    if (this.options.respectQwenIgnore) {
      const qwenIgnorePath = path.join(root, '.qwenignore');
      if (fsSync.existsSync(qwenIgnorePath)) {
        args.push('--ignore-file', qwenIgnorePath);
      }
    }

    args.push(root);

    const result = await runRipgrep(args, this.options.signal);

    if (result.error && !result.truncated) {
      throw new Error(`Failed to list files: ${result.error.message}`);
    }

    const files = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((absPath) => path.relative(root, absPath));

    return files;
  }

  /**
   * Computes metadata for a list of files with controlled concurrency.
   */
  private async computeFileMetadata(
    root: string,
    filePaths: string[],
  ): Promise<FileMetadata[]> {
    const results: FileMetadata[] = [];
    const errors: string[] = [];

    // Process files in batches to control concurrency
    for (let i = 0; i < filePaths.length; i += HASH_CONCURRENCY) {
      // Check for abort signal
      if (this.options.signal?.aborted) {
        throw new Error('File scan aborted');
      }

      const batch = filePaths.slice(i, i + HASH_CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map((relPath) => this.getFileMetadata(root, relPath)),
      );

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value);
        } else if (result.status === 'rejected') {
          errors.push(`${batch[j]}: ${result.reason}`);
        }
      }
    }

    // Log errors if any, but don't fail the entire operation
    if (errors.length > 0) {
      console.warn(
        `FileScanner: ${errors.length} files failed to process:\n${errors.slice(0, 10).join('\n')}`,
      );
    }

    return results;
  }

  /**
   * Gets metadata for a single file.
   */
  private async getFileMetadata(
    root: string,
    relPath: string,
  ): Promise<FileMetadata | null> {
    const absPath = path.join(root, relPath);

    try {
      const stat = await fs.stat(absPath);

      // Skip non-files (directories, symlinks, etc.)
      if (!stat.isFile()) {
        return null;
      }

      // Skip very large files (> 10MB)
      if (stat.size > 10 * 1024 * 1024) {
        return null;
      }

      const hash = await this.computeFileHash(absPath);
      const language = this.detectLanguage(relPath);

      return {
        path: relPath,
        contentHash: hash,
        lastModified: stat.mtimeMs,
        size: stat.size,
        language,
      };
    } catch {
      // File may have been deleted or is inaccessible
      return null;
    }
  }

  /**
   * Computes SHA-256 hash of file content.
   */
  private async computeFileHash(absPath: string): Promise<string> {
    const content = await fs.readFile(absPath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Detects programming language from file extension.
   */
  private detectLanguage(filePath: string): string | undefined {
    const ext = path.extname(filePath).toLowerCase();
    return EXTENSION_TO_LANGUAGE[ext];
  }

  /**
   * Streaming file scan - yields batches of file metadata.
   * This is memory-efficient for very large repositories (100k+ files).
   * Uses async generator to yield batches as they are processed.
   *
   * @param projectRoot - The root directory to scan (defaults to constructor value)
   * @param batchSize - Number of files per batch (default: 100)
   * @yields Batches of FileMetadata arrays
   */
  async *scanFilesStreaming(
    projectRoot?: string,
    batchSize: number = 100,
  ): AsyncGenerator<FileMetadata[], void, undefined> {
    const root = projectRoot ? path.resolve(projectRoot) : this.projectRoot;

    // Use ripgrep to get all files - this is already efficient as ripgrep streams results
    // For true streaming, we would need to spawn ripgrep and read stdout line by line
    // Current implementation is a compromise: get file list, then stream metadata computation
    const allFiles = await this.listFilesWithRipgrep(root);

    // Filter using FileDiscoveryService
    const filteredFiles = this.discoveryService.filterFiles(allFiles, {
      respectGitIgnore: this.options.respectGitIgnore,
      respectQwenIgnore: this.options.respectQwenIgnore,
    });

    // Yield batches of computed metadata
    for (let i = 0; i < filteredFiles.length; i += batchSize) {
      // Check for abort signal
      if (this.options.signal?.aborted) {
        return;
      }

      const batchFiles = filteredFiles.slice(i, i + batchSize);
      const batchMetadata = await this.computeFileMetadata(root, batchFiles);

      if (batchMetadata.length > 0) {
        yield batchMetadata;
      }
    }
  }

  /**
   * True streaming file scan using spawned ripgrep process.
   * Processes files in batches without loading the entire file list into memory.
   * Best for extremely large repositories where even the file list is too large.
   *
   * @param projectRoot - The root directory to scan (defaults to constructor value)
   * @param batchSize - Number of files per batch (default: 100)
   * @yields Batches of FileMetadata arrays
   */
  async *scanFilesStreamingLowMemory(
    projectRoot?: string,
    batchSize: number = 100,
  ): AsyncGenerator<FileMetadata[], void, undefined> {
    const root = projectRoot ? path.resolve(projectRoot) : this.projectRoot;
    const { spawn } = await import('node:child_process');

    // Build ripgrep args with ignore support for performance
    const rgArgs = ['--files', '--hidden'];
    if (!this.options.respectGitIgnore) {
      rgArgs.push('--no-ignore');
    }
    if (this.options.respectQwenIgnore) {
      const qwenIgnorePath = path.join(root, '.qwenignore');
      if (fsSync.existsSync(qwenIgnorePath)) {
        rgArgs.push('--ignore-file', qwenIgnorePath);
      }
    }
    rgArgs.push(root);

    // Spawn ripgrep to stream file paths
    const rgProcess = spawn('rg', rgArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    let currentBatch: string[] = [];

    // Process a single line from ripgrep output
    const processLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;

      const relPath = path.relative(root, trimmed);
      // Files are already filtered by ripgrep's ignore rules
      // Only add secondary filtering if ripgrep wasn't configured to filter
      if (!this.options.respectGitIgnore) {
        // ripgrep used --no-ignore, so we need to filter here
        const filtered = this.discoveryService.filterFiles([relPath], {
          respectGitIgnore: this.options.respectGitIgnore,
          respectQwenIgnore: this.options.respectQwenIgnore,
        });
        if (filtered.length > 0) {
          currentBatch.push(filtered[0]);
        }
      } else {
        // ripgrep already filtered, just add the path
        currentBatch.push(relPath);
      }
    };

    try {
      for await (const chunk of rgProcess.stdout!) {
        // Check for abort signal
        if (this.options.signal?.aborted) {
          rgProcess.kill();
          return;
        }

        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          processLine(line);

          // When batch is full, yield it
          if (currentBatch.length >= batchSize) {
            const batchMetadata = await this.computeFileMetadata(
              root,
              currentBatch,
            );
            if (batchMetadata.length > 0) {
              yield batchMetadata;
            }
            currentBatch = [];
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim().length > 0) {
        processLine(buffer);
      }

      // Yield remaining batch
      if (currentBatch.length > 0) {
        const batchMetadata = await this.computeFileMetadata(
          root,
          currentBatch,
        );
        if (batchMetadata.length > 0) {
          yield batchMetadata;
        }
      }
    } finally {
      // Ensure process is cleaned up
      if (!rgProcess.killed) {
        rgProcess.kill();
      }
    }
  }
}
