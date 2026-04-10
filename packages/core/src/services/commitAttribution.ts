/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Commit Attribution Service
 *
 * Tracks character-level contribution ratios between AI and humans per file.
 * When a git commit is made, this data is used to generate attribution metadata
 * stored as git notes, keeping the commit history clean while enabling
 * compliance audits and AI disclosure.
 */

import * as path from 'node:path';

export interface FileAttribution {
  /** Characters added by AI */
  aiCharsAdded: number;
  /** Characters removed by AI */
  aiCharsRemoved: number;
  /** Whether the file was created (not just edited) by AI */
  aiCreated: boolean;
}

export interface CommitAttributionNote {
  version: 1;
  generator: string;
  files: Record<
    string,
    {
      aiCharsAdded: number;
      aiCharsRemoved: number;
      aiCreated: boolean;
      aiContributionPercent: number;
    }
  >;
  summary: {
    totalAiCharsAdded: number;
    totalAiCharsRemoved: number;
    totalFilesTouched: number;
    overallAiPercent: number;
  };
}

// Internal model codenames that should be sanitized for external repos
const INTERNAL_MODEL_PATTERNS = [
  /qwen[-_]?\d+(\.\d+)?[-_]?b?/i,
  /qwen[-_]?coder[-_]?\d*/i,
  /qwen[-_]?max/i,
  /qwen[-_]?plus/i,
  /qwen[-_]?turbo/i,
];

const SANITIZED_GENERATOR_NAME = 'Qwen-Coder';

export class CommitAttributionService {
  private static instance: CommitAttributionService | null = null;

  /** Per-file attribution tracking for the current session */
  private fileAttributions: Map<string, FileAttribution> = new Map();

  private constructor() {}

  static getInstance(): CommitAttributionService {
    if (!CommitAttributionService.instance) {
      CommitAttributionService.instance = new CommitAttributionService();
    }
    return CommitAttributionService.instance;
  }

  /**
   * Reset singleton for testing.
   */
  static resetInstance(): void {
    CommitAttributionService.instance = null;
  }

  /**
   * Record an AI edit to a file.
   * Called after EditTool or WriteFileTool successfully modifies a file.
   */
  recordEdit(
    filePath: string,
    oldContent: string | null,
    newContent: string,
  ): void {
    const existing = this.fileAttributions.get(filePath) || {
      aiCharsAdded: 0,
      aiCharsRemoved: 0,
      aiCreated: false,
    };

    // Only treat as new file when oldContent is strictly null (file did not exist).
    // Empty string means the file existed but was empty.
    const isNewFile = oldContent === null;

    if (isNewFile && !existing.aiCreated) {
      existing.aiCreated = true;
      existing.aiCharsAdded += newContent.length;
    } else {
      const { added, removed } = this.calculateCharDiff(
        oldContent ?? '',
        newContent,
      );
      existing.aiCharsAdded += added;
      existing.aiCharsRemoved += removed;
    }

    this.fileAttributions.set(filePath, existing);
  }

  /**
   * Get attribution data for all tracked files (defensive copy).
   */
  getAttributions(): Map<string, FileAttribution> {
    const copy = new Map<string, FileAttribution>();
    for (const [k, v] of this.fileAttributions) {
      copy.set(k, { ...v });
    }
    return copy;
  }

  /**
   * Get attribution for a specific file (defensive copy).
   */
  getFileAttribution(filePath: string): FileAttribution | undefined {
    const attr = this.fileAttributions.get(filePath);
    return attr ? { ...attr } : undefined;
  }

  /**
   * Check if there are any tracked attributions.
   */
  hasAttributions(): boolean {
    return this.fileAttributions.size > 0;
  }

  /**
   * Clear all tracked attributions (called after a commit is made).
   */
  clearAttributions(): void {
    this.fileAttributions.clear();
  }

  /**
   * Generate a git notes JSON payload for the current attributions.
   * File paths are converted to relative paths based on the given base directory
   * to avoid leaking absolute directory structures.
   * @param generatorName The model/tool name (will be sanitized)
   * @param baseDir Base directory to compute relative file paths from
   */
  generateNotePayload(
    generatorName?: string,
    baseDir?: string,
  ): CommitAttributionNote {
    const sanitizedGenerator = this.sanitizeModelName(
      generatorName ?? SANITIZED_GENERATOR_NAME,
    );

    const files: CommitAttributionNote['files'] = {};
    let totalAiCharsAdded = 0;
    let totalAiCharsRemoved = 0;

    for (const [filePath, attr] of this.fileAttributions) {
      const relativePath = baseDir
        ? path.relative(baseDir, filePath)
        : filePath;
      const totalChange = attr.aiCharsAdded + attr.aiCharsRemoved;
      files[relativePath] = {
        aiCharsAdded: attr.aiCharsAdded,
        aiCharsRemoved: attr.aiCharsRemoved,
        aiCreated: attr.aiCreated,
        aiContributionPercent: totalChange > 0 ? 100 : 0,
      };
      totalAiCharsAdded += attr.aiCharsAdded;
      totalAiCharsRemoved += attr.aiCharsRemoved;
    }

    const totalChange = totalAiCharsAdded + totalAiCharsRemoved;

    return {
      version: 1,
      generator: sanitizedGenerator,
      files,
      summary: {
        totalAiCharsAdded,
        totalAiCharsRemoved,
        totalFilesTouched: this.fileAttributions.size,
        overallAiPercent: totalChange > 0 ? 100 : 0,
      },
    };
  }

  /**
   * Calculate character-level additions and removals between two strings.
   * Uses a line-based multiset diff: counts lines present in one version
   * but not the other and sums their character lengths.
   */
  private calculateCharDiff(
    oldContent: string,
    newContent: string,
  ): { added: number; removed: number } {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');

    let added = 0;
    let removed = 0;

    const oldCounts = new Map<string, number>();
    for (const line of oldLines) {
      oldCounts.set(line, (oldCounts.get(line) || 0) + 1);
    }

    const newCounts = new Map<string, number>();
    for (const line of newLines) {
      newCounts.set(line, (newCounts.get(line) || 0) + 1);
    }

    // Count removed lines (in old but fewer occurrences in new)
    for (const [line, oldCount] of oldCounts) {
      const newCount = newCounts.get(line) || 0;
      const removedCount = Math.max(0, oldCount - newCount);
      removed += removedCount * line.length;
    }

    // Count added lines (in new but fewer occurrences in old)
    for (const [line, newCount] of newCounts) {
      const oldCount = oldCounts.get(line) || 0;
      const addedCount = Math.max(0, newCount - oldCount);
      added += addedCount * line.length;
    }

    return { added, removed };
  }

  /**
   * Sanitize internal model codenames to prevent leaking internal details.
   */
  private sanitizeModelName(name: string): string {
    for (const pattern of INTERNAL_MODEL_PATTERNS) {
      if (pattern.test(name)) {
        return SANITIZED_GENERATOR_NAME;
      }
    }
    return name;
  }
}
