/**
 * Copyright (c) 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * File snapshot
 */
export interface FileSnapshot {
  path: string;
  content: string;
  hash: string;
  size: number;
  modified: Date;
}

/**
 * Test snapshot
 */
export interface TestSnapshot {
  passed: number;
  failed: number;
  skipped: number;
  coverage: number;
  timestamp: Date;
}

/**
 * Snapshot metadata
 */
export interface SnapshotMetadata {
  label: string;
  description?: string;
  tags: string[];
  branch?: string;
  commit?: string;
  author?: string;
  automatic: boolean;
}

/**
 * Complete project snapshot
 */
export interface Snapshot {
  id: string;
  timestamp: Date;
  files: Map<string, FileSnapshot>;
  tests: TestSnapshot;
  metadata: SnapshotMetadata;
  parentId?: string; // For snapshot chains
}

/**
 * Rollback result
 */
export interface RollbackResult {
  success: boolean;
  restoredFiles: string[];
  failedFiles: string[];
  testsAfterRollback?: TestSnapshot;
  duration: number;
}

/**
 * Merge conflict
 */
export interface MergeConflict {
  file: string;
  currentContent: string;
  targetContent: string;
  conflictType: 'content' | 'deletion' | 'addition';
}

/**
 * Merge result
 */
export interface MergeResult {
  success: boolean;
  mergedFiles: string[];
  conflicts: MergeConflict[];
  strategy: 'auto' | 'manual';
}

/**
 * Advanced versioning and rollback system
 */
export class VersioningSystem {
  private snapshotsDir: string;
  private snapshots: Map<string, Snapshot> = new Map();

  constructor(projectRoot: string) {
    this.snapshotsDir = path.join(projectRoot, '.qwen-code', 'snapshots');
  }

  /**
   * Initialize versioning system
   */
  async init(): Promise<void> {
    // Create snapshots directory
    await fs.mkdir(this.snapshotsDir, { recursive: true });

    // Load existing snapshots
    await this.loadSnapshots();
  }

  /**
   * Create a snapshot of current state
   */
  async createSnapshot(label: string, files?: string[]): Promise<Snapshot> {
    const snapshot: Snapshot = {
      id: this.generateSnapshotId(),
      timestamp: new Date(),
      files: new Map(),
      tests: {
        passed: 0,
        failed: 0,
        skipped: 0,
        coverage: 0,
        timestamp: new Date(),
      },
      metadata: {
        label,
        tags: [],
        automatic: false,
      },
    };

    // Capture files
    if (files && files.length > 0) {
      for (const file of files) {
        const fileSnapshot = await this.captureFile(file);
        if (fileSnapshot) {
          snapshot.files.set(file, fileSnapshot);
        }
      }
    } else {
      // Capture all project files
      const allFiles = await this.getAllProjectFiles();
      for (const file of allFiles) {
        const fileSnapshot = await this.captureFile(file);
        if (fileSnapshot) {
          snapshot.files.set(file, fileSnapshot);
        }
      }
    }

    // Capture test state
    snapshot.tests = await this.captureTestState();

    // Capture git info if available
    snapshot.metadata.branch = await this.getCurrentBranch();
    snapshot.metadata.commit = await this.getCurrentCommit();

    // Save snapshot
    await this.saveSnapshot(snapshot);

    this.snapshots.set(snapshot.id, snapshot);

    return snapshot;
  }

  /**
   * Capture a single file
   */
  private async captureFile(filePath: string): Promise<FileSnapshot | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const stats = await fs.stat(filePath);
      const hash = this.hashContent(content);

      return {
        path: filePath,
        content,
        hash,
        size: stats.size,
        modified: stats.mtime,
      };
    } catch (_error) {
      return null;
    }
  }

  /**
   * Hash content for comparison
   */
  private hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  /**
   * Get all project files
   */
  private async getAllProjectFiles(): Promise<string[]> {
    const files: string[] = [];

    async function walk(dir: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip node_modules, .git, etc.
        if (
          entry.name === 'node_modules' ||
          entry.name === '.git' ||
          entry.name === 'dist' ||
          entry.name === 'build' ||
          entry.name === '.qwen-code'
        ) {
          continue;
        }

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    }

    await walk(process.cwd());
    return files;
  }

  /**
   * Capture test state
   */
  private async captureTestState(): Promise<TestSnapshot> {
    // Simplified - would actually run tests
    return {
      passed: 0,
      failed: 0,
      skipped: 0,
      coverage: 0,
      timestamp: new Date(),
    };
  }

  /**
   * Get current git branch
   */
  private async getCurrentBranch(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD');
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  /**
   * Get current git commit
   */
  private async getCurrentCommit(): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync('git rev-parse HEAD');
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  /**
   * Save snapshot to disk
   */
  private async saveSnapshot(snapshot: Snapshot): Promise<void> {
    const snapshotPath = path.join(this.snapshotsDir, `${snapshot.id}.json`);

    // Convert Map to object for JSON
    const serializable = {
      ...snapshot,
      files: Object.fromEntries(snapshot.files),
    };

    await fs.writeFile(
      snapshotPath,
      JSON.stringify(serializable, null, 2),
      'utf-8',
    );
  }

  /**
   * Load snapshots from disk
   */
  private async loadSnapshots(): Promise<void> {
    try {
      const files = await fs.readdir(this.snapshotsDir);

      for (const file of files) {
        if (file.endsWith('.json')) {
          const snapshotPath = path.join(this.snapshotsDir, file);
          const content = await fs.readFile(snapshotPath, 'utf-8');
          const data = JSON.parse(content);

          // Convert object back to Map
          const snapshot: Snapshot = {
            ...data,
            files: new Map(Object.entries(data.files)),
            timestamp: new Date(data.timestamp),
            tests: {
              ...data.tests,
              timestamp: new Date(data.tests.timestamp),
            },
          };

          this.snapshots.set(snapshot.id, snapshot);
        }
      }
    } catch (_error) {
      // No snapshots directory yet
    }
  }

  /**
   * Rollback to a specific snapshot
   */
  async rollback(snapshotId: string): Promise<RollbackResult> {
    const startTime = Date.now();
    const snapshot = this.snapshots.get(snapshotId);

    if (!snapshot) {
      throw new Error(`Snapshot ${snapshotId} not found`);
    }

    const restoredFiles: string[] = [];
    const failedFiles: string[] = [];

    // Restore each file
    for (const [filePath, fileSnapshot] of snapshot.files.entries()) {
      try {
        // Ensure directory exists
        await fs.mkdir(path.dirname(filePath), { recursive: true });

        // Restore file content
        await fs.writeFile(filePath, fileSnapshot.content, 'utf-8');

        restoredFiles.push(filePath);
      } catch (_error) {
        failedFiles.push(filePath);
      }
    }

    // Run tests after rollback
    const testsAfterRollback = await this.captureTestState();

    return {
      success: failedFiles.length === 0,
      restoredFiles,
      failedFiles,
      testsAfterRollback,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Smart merge between two snapshots
   */
  async smartMerge(currentId: string, targetId: string): Promise<MergeResult> {
    const current = this.snapshots.get(currentId);
    const target = this.snapshots.get(targetId);

    if (!current || !target) {
      throw new Error('Snapshot not found');
    }

    const mergedFiles: string[] = [];
    const conflicts: MergeConflict[] = [];

    // Compare files
    for (const [filePath, targetFile] of target.files.entries()) {
      const currentFile = current.files.get(filePath);

      if (!currentFile) {
        // File only in target - add it
        await fs.writeFile(filePath, targetFile.content, 'utf-8');
        mergedFiles.push(filePath);
      } else if (currentFile.hash === targetFile.hash) {
        // Same content - no change needed
        mergedFiles.push(filePath);
      } else {
        // Different content - conflict
        conflicts.push({
          file: filePath,
          currentContent: currentFile.content,
          targetContent: targetFile.content,
          conflictType: 'content',
        });
      }
    }

    // Check for deletions
    for (const [filePath, currentFile] of current.files.entries()) {
      if (!target.files.has(filePath)) {
        conflicts.push({
          file: filePath,
          currentContent: currentFile.content,
          targetContent: '',
          conflictType: 'deletion',
        });
      }
    }

    return {
      success: conflicts.length === 0,
      mergedFiles,
      conflicts,
      strategy: conflicts.length === 0 ? 'auto' : 'manual',
    };
  }

  /**
   * Create automatic snapshot before risky operation
   */
  async createAutoSnapshot(operation: string): Promise<Snapshot> {
    const snapshot = await this.createSnapshot(`Auto: ${operation}`);
    snapshot.metadata.automatic = true;
    snapshot.metadata.tags.push('auto', operation);
    return snapshot;
  }

  /**
   * List all snapshots
   */
  listSnapshots(): Snapshot[] {
    return Array.from(this.snapshots.values()).sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    );
  }

  /**
   * Get snapshot by ID
   */
  getSnapshot(id: string): Snapshot | undefined {
    return this.snapshots.get(id);
  }

  /**
   * Delete old snapshots
   */
  async cleanupOldSnapshots(
    maxAge: number = 30 * 24 * 60 * 60 * 1000,
  ): Promise<number> {
    const now = Date.now();
    let deleted = 0;

    for (const [id, snapshot] of this.snapshots.entries()) {
      const age = now - snapshot.timestamp.getTime();

      if (age > maxAge && snapshot.metadata.automatic) {
        // Delete snapshot file
        const snapshotPath = path.join(this.snapshotsDir, `${id}.json`);
        try {
          await fs.unlink(snapshotPath);
          this.snapshots.delete(id);
          deleted++;
        } catch (_error) {
          // Ignore errors
        }
      }
    }

    return deleted;
  }

  /**
   * Compare two snapshots
   */
  compareSnapshots(
    id1: string,
    id2: string,
  ): {
    added: string[];
    modified: string[];
    deleted: string[];
  } {
    const snap1 = this.snapshots.get(id1);
    const snap2 = this.snapshots.get(id2);

    if (!snap1 || !snap2) {
      throw new Error('Snapshot not found');
    }

    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    // Find added and modified
    for (const [path, file2] of snap2.files.entries()) {
      const file1 = snap1.files.get(path);

      if (!file1) {
        added.push(path);
      } else if (file1.hash !== file2.hash) {
        modified.push(path);
      }
    }

    // Find deleted
    for (const path of snap1.files.keys()) {
      if (!snap2.files.has(path)) {
        deleted.push(path);
      }
    }

    return { added, modified, deleted };
  }

  /**
   * Generate unique snapshot ID
   */
  private generateSnapshotId(): string {
    return `snapshot-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Create snapshot chain (for incremental snapshots)
   */
  async createIncrementalSnapshot(
    label: string,
    parentId?: string,
  ): Promise<Snapshot> {
    const snapshot = await this.createSnapshot(label);

    if (parentId) {
      snapshot.parentId = parentId;
    }

    return snapshot;
  }

  /**
   * Get snapshot history (chain)
   */
  getSnapshotHistory(snapshotId: string): Snapshot[] {
    const history: Snapshot[] = [];
    let current = this.snapshots.get(snapshotId);

    while (current) {
      history.push(current);

      if (current.parentId) {
        current = this.snapshots.get(current.parentId);
      } else {
        break;
      }
    }

    return history;
  }
}

/**
 * Create a new versioning system instance
 */
export function createVersioningSystem(projectRoot: string): VersioningSystem {
  return new VersioningSystem(projectRoot);
}
