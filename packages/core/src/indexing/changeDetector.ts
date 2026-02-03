/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChangeSet,
  FileMetadata,
  IFileScanner,
  IMetadataStore,
} from './types.js';

/**
 * Options for change detection.
 */
export interface ChangeDetectorOptions {
  /**
   * Whether to compute hash for files with unchanged mtime.
   * If false, only files with changed mtime will have their hash recomputed.
   * Default: false (optimization for faster detection).
   */
  alwaysComputeHash?: boolean;
}

/**
 * ChangeDetector detects file changes in the workspace by comparing
 * current file state against indexed metadata.
 *
 * Uses a polling-based approach for stability and predictable performance.
 *
 * @example
 * ```typescript
 * const detector = new ChangeDetector(fileScanner, metadataStore);
 * const changes = await detector.detectChanges();
 * if (hasChanges(changes)) {
 *   await indexManager.incrementalUpdate(changes);
 * }
 * ```
 */
export class ChangeDetector {
  private readonly fileScanner: IFileScanner;
  private readonly metadataStore: IMetadataStore;
  private readonly options: ChangeDetectorOptions;

  /**
   * Creates a new ChangeDetector instance.
   *
   * @param fileScanner File scanner for discovering current files.
   * @param metadataStore Metadata store containing indexed file records.
   * @param options Detection options.
   */
  constructor(
    fileScanner: IFileScanner,
    metadataStore: IMetadataStore,
    options: ChangeDetectorOptions = {},
  ) {
    this.fileScanner = fileScanner;
    this.metadataStore = metadataStore;
    this.options = {
      alwaysComputeHash: false,
      ...options,
    };
  }

  /**
   * Detects file changes by comparing current files against indexed metadata.
   *
   * Algorithm:
   * 1. Scan current files in the workspace
   * 2. Load indexed file metadata from the database
   * 3. Compare to identify added, modified, and deleted files
   *
   * @returns ChangeSet containing added, modified, and deleted files.
   */
  async detectChanges(): Promise<ChangeSet> {
    // 1. Scan current files
    const currentFiles = await this.fileScanner.scanFiles();

    // 2. Load indexed files
    const indexedFiles = this.metadataStore.getAllFileMeta();

    // 3. Compare and compute changes
    return this.computeChanges(currentFiles, indexedFiles);
  }

  /**
   * Detects changes for a specific set of file paths.
   * Useful when you know which files may have changed (e.g., from file watcher).
   *
   * @param filePaths Array of file paths to check.
   * @returns ChangeSet for the specified files.
   */
  async detectChangesForFiles(filePaths: string[]): Promise<ChangeSet> {
    const result: ChangeSet = {
      added: [],
      modified: [],
      deleted: [],
    };

    // Scan the specific files
    const currentFiles = await this.fileScanner.scanSpecificFiles?.(filePaths);

    if (!currentFiles) {
      // Fallback: scan all and filter
      const allCurrent = await this.fileScanner.scanFiles();
      const currentFilesFiltered = allCurrent.filter((f) =>
        filePaths.includes(f.path),
      );

      const indexedFiles = this.metadataStore.getAllFileMeta();
      const indexedFilesFiltered = indexedFiles.filter((f) =>
        filePaths.includes(f.path),
      );

      return this.computeChanges(currentFilesFiltered, indexedFilesFiltered);
    }

    const currentMap = new Map<string, FileMetadata>();
    for (const file of currentFiles) {
      currentMap.set(file.path, file);
    }

    // Check each file path
    for (const filePath of filePaths) {
      const currentFile = currentMap.get(filePath);
      const indexedFile = this.metadataStore.getFileMeta(filePath);

      if (!currentFile && indexedFile) {
        // File was deleted
        result.deleted.push(filePath);
      } else if (currentFile && !indexedFile) {
        // File is new
        result.added.push(currentFile);
      } else if (currentFile && indexedFile) {
        // Check if modified
        if (this.isFileModified(currentFile, indexedFile)) {
          result.modified.push(currentFile);
        }
      }
    }

    return result;
  }

  /**
   * Computes the difference between current and indexed files.
   *
   * @param currentFiles Currently discovered files.
   * @param indexedFiles Files stored in metadata database.
   * @returns ChangeSet representing the differences.
   */
  private computeChanges(
    currentFiles: FileMetadata[],
    indexedFiles: FileMetadata[],
  ): ChangeSet {
    const result: ChangeSet = {
      added: [],
      modified: [],
      deleted: [],
    };

    // Create maps for O(1) lookup
    const currentMap = new Map<string, FileMetadata>();
    for (const file of currentFiles) {
      currentMap.set(file.path, file);
    }

    const indexedMap = new Map<string, FileMetadata>();
    for (const file of indexedFiles) {
      indexedMap.set(file.path, file);
    }

    // Find added and modified files - O(n) where n = currentFiles.length
    for (const [filePath, currentFile] of currentMap) {
      const indexedFile = indexedMap.get(filePath);

      if (!indexedFile) {
        // File is new
        result.added.push(currentFile);
      } else if (this.isFileModified(currentFile, indexedFile)) {
        // File is modified
        result.modified.push(currentFile);
      }
    }

    // Find deleted files - O(m) where m = indexedFiles.length
    for (const filePath of indexedMap.keys()) {
      if (!currentMap.has(filePath)) {
        result.deleted.push(filePath);
      }
    }

    return result;
  }

  /**
   * Checks if a file has been modified by comparing metadata.
   *
   * Optimization: First checks mtime, only recomputes hash if mtime changed.
   *
   * @param current Current file metadata.
   * @param indexed Indexed file metadata.
   * @returns True if the file is considered modified.
   */
  private isFileModified(
    current: FileMetadata,
    indexed: FileMetadata,
  ): boolean {
    // Quick check: if mtime hasn't changed, file is likely unchanged
    if (
      !this.options.alwaysComputeHash &&
      current.lastModified <= indexed.lastModified
    ) {
      return false;
    }

    // Check content hash
    return current.contentHash !== indexed.contentHash;
  }

  /**
   * Gets a summary of changes for logging/display.
   *
   * @param changes The change set to summarize.
   * @returns Human-readable summary string.
   */
  static summarize(changes: ChangeSet): string {
    const parts: string[] = [];

    if (changes.added.length > 0) {
      parts.push(`${changes.added.length} added`);
    }
    if (changes.modified.length > 0) {
      parts.push(`${changes.modified.length} modified`);
    }
    if (changes.deleted.length > 0) {
      parts.push(`${changes.deleted.length} deleted`);
    }

    if (parts.length === 0) {
      return 'No changes detected';
    }

    return parts.join(', ');
  }
}
