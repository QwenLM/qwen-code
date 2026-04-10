/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Commit Attribution Service
 *
 * Tracks character-level contribution ratios between AI and humans per file.
 * When a git commit is made, this data is combined with git diff analysis to
 * calculate real AI vs human contribution percentages, stored as git notes.
 */

import * as path from 'node:path';
import { isGeneratedFile } from './generatedFiles.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileAttribution {
  /** Total characters contributed by AI (accumulated across edits) */
  aiContribution: number;
  /** Whether the file was created by AI */
  aiCreated: boolean;
}

/** Per-file attribution detail in the git notes payload. */
export interface FileAttributionDetail {
  aiChars: number;
  humanChars: number;
  percent: number;
}

/** Full attribution payload stored as git notes JSON. */
export interface CommitAttributionNote {
  version: 1;
  generator: string;
  files: Record<string, FileAttributionDetail>;
  summary: {
    aiPercent: number;
    aiChars: number;
    humanChars: number;
    totalFilesTouched: number;
  };
  excludedGenerated: string[];
}

/** Result of running git commands to get staged file info. */
export interface StagedFileInfo {
  /** Relative file paths from git root */
  files: string[];
  /** Per-file diff size in estimated characters (from git diff --cached --stat) */
  diffSizes: Map<string, number>;
  /** Files that were deleted */
  deletedFiles: Set<string>;
}

// ---------------------------------------------------------------------------
// Model name sanitization
// ---------------------------------------------------------------------------

const INTERNAL_MODEL_PATTERNS = [
  /qwen[-_]?\d+(\.\d+)?[-_]?b?/i,
  /qwen[-_]?coder[-_]?\d*/i,
  /qwen[-_]?max/i,
  /qwen[-_]?plus/i,
  /qwen[-_]?turbo/i,
];

const SANITIZED_GENERATOR_NAME = 'Qwen-Coder';

function sanitizeModelName(name: string): string {
  for (const pattern of INTERNAL_MODEL_PATTERNS) {
    if (pattern.test(name)) {
      return SANITIZED_GENERATOR_NAME;
    }
  }
  return name;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CommitAttributionService {
  private static instance: CommitAttributionService | null = null;

  /** Per-file AI contribution tracking (keyed by absolute path) */
  private fileAttributions: Map<string, FileAttribution> = new Map();

  private constructor() {}

  static getInstance(): CommitAttributionService {
    if (!CommitAttributionService.instance) {
      CommitAttributionService.instance = new CommitAttributionService();
    }
    return CommitAttributionService.instance;
  }

  /** Reset singleton for testing. */
  static resetInstance(): void {
    CommitAttributionService.instance = null;
  }

  // -----------------------------------------------------------------------
  // Recording
  // -----------------------------------------------------------------------

  /**
   * Record an AI edit to a file.
   * Uses Claude's prefix/suffix matching algorithm for precise character-level
   * contribution calculation.
   */
  recordEdit(
    filePath: string,
    oldContent: string | null,
    newContent: string,
  ): void {
    const existing = this.fileAttributions.get(filePath) || {
      aiContribution: 0,
      aiCreated: false,
    };

    const isNewFile = oldContent === null;
    const contribution = computeCharContribution(oldContent ?? '', newContent);

    existing.aiContribution += contribution;
    if (isNewFile && !existing.aiCreated) {
      existing.aiCreated = true;
    }

    this.fileAttributions.set(filePath, existing);
  }

  /**
   * Record an AI file deletion.
   */
  recordDeletion(filePath: string, deletedContentLength: number): void {
    const existing = this.fileAttributions.get(filePath) || {
      aiContribution: 0,
      aiCreated: false,
    };
    existing.aiContribution += deletedContentLength;
    this.fileAttributions.set(filePath, existing);
  }

  // -----------------------------------------------------------------------
  // Querying
  // -----------------------------------------------------------------------

  getAttributions(): Map<string, FileAttribution> {
    const copy = new Map<string, FileAttribution>();
    for (const [k, v] of this.fileAttributions) {
      copy.set(k, { ...v });
    }
    return copy;
  }

  getFileAttribution(filePath: string): FileAttribution | undefined {
    const attr = this.fileAttributions.get(filePath);
    return attr ? { ...attr } : undefined;
  }

  hasAttributions(): boolean {
    return this.fileAttributions.size > 0;
  }

  clearAttributions(): void {
    this.fileAttributions.clear();
  }

  // -----------------------------------------------------------------------
  // Payload generation
  // -----------------------------------------------------------------------

  /**
   * Generate the git notes JSON payload by combining tracked AI contributions
   * with staged file information from git.
   *
   * For each staged file:
   * - If AI tracked it: aiChars = tracked contribution; humanChars = max(0, diffSize - aiChars)
   * - If AI did NOT track it: aiChars = 0; humanChars = diffSize (100% human)
   * - Generated files (lock, dist, etc.) are excluded
   *
   * @param stagedInfo  Result of git diff --cached analysis
   * @param baseDir     Project root for converting absolute paths to relative
   * @param generatorName  Model/tool name (will be sanitized)
   */
  generateNotePayload(
    stagedInfo: StagedFileInfo,
    baseDir: string,
    generatorName?: string,
  ): CommitAttributionNote {
    const generator = sanitizeModelName(
      generatorName ?? SANITIZED_GENERATOR_NAME,
    );

    const files: Record<string, FileAttributionDetail> = {};
    const excludedGenerated: string[] = [];
    let totalAiChars = 0;
    let totalHumanChars = 0;

    // Build a lookup from relative path → tracked AI contribution
    const aiLookup = new Map<string, FileAttribution>();
    for (const [absPath, attr] of this.fileAttributions) {
      const rel = path.relative(baseDir, absPath);
      aiLookup.set(rel, attr);
    }

    for (const relFile of stagedInfo.files) {
      // Skip generated files
      if (isGeneratedFile(relFile)) {
        excludedGenerated.push(relFile);
        continue;
      }

      const tracked = aiLookup.get(relFile);
      const diffSize = stagedInfo.diffSizes.get(relFile) ?? 0;
      const isDeleted = stagedInfo.deletedFiles.has(relFile);

      let aiChars: number;
      let humanChars: number;

      if (tracked) {
        aiChars = tracked.aiContribution;
        // Human contribution = total diff size minus AI's tracked contribution
        // (clamped to 0 — AI may have contributed more than the final diff
        //  if it rewrote the same region multiple times)
        humanChars = Math.max(0, diffSize - aiChars);
      } else if (isDeleted) {
        // Untracked deletion = human did it
        aiChars = 0;
        humanChars = diffSize > 0 ? diffSize : 100;
      } else {
        // Untracked file = 100% human
        aiChars = 0;
        humanChars = diffSize;
      }

      const total = aiChars + humanChars;
      const percent = total > 0 ? Math.round((aiChars / total) * 100) : 0;

      files[relFile] = { aiChars, humanChars, percent };
      totalAiChars += aiChars;
      totalHumanChars += humanChars;
    }

    const totalChars = totalAiChars + totalHumanChars;
    const aiPercent =
      totalChars > 0 ? Math.round((totalAiChars / totalChars) * 100) : 0;

    return {
      version: 1,
      generator,
      files,
      summary: {
        aiPercent,
        aiChars: totalAiChars,
        humanChars: totalHumanChars,
        totalFilesTouched: Object.keys(files).length,
      },
      excludedGenerated,
    };
  }
}

// ---------------------------------------------------------------------------
// Character contribution calculation (Claude's prefix/suffix algorithm)
// ---------------------------------------------------------------------------

/**
 * Compute the character contribution for a file modification.
 * Uses common prefix/suffix matching to find the actual changed region,
 * then returns the larger of the old/new changed lengths.
 *
 * This correctly handles same-length replacements (e.g., "Esc" → "esc")
 * where a simple length difference would be 0.
 */
export function computeCharContribution(
  oldContent: string,
  newContent: string,
): number {
  if (oldContent === '' || newContent === '') {
    // New file creation or full deletion
    return oldContent === '' ? newContent.length : oldContent.length;
  }

  // Find common prefix
  const minLen = Math.min(oldContent.length, newContent.length);
  let prefixEnd = 0;
  while (
    prefixEnd < minLen &&
    oldContent[prefixEnd] === newContent[prefixEnd]
  ) {
    prefixEnd++;
  }

  // Find common suffix (not overlapping with prefix)
  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixEnd &&
    oldContent[oldContent.length - 1 - suffixLen] ===
      newContent[newContent.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const oldChangedLen = oldContent.length - prefixEnd - suffixLen;
  const newChangedLen = newContent.length - prefixEnd - suffixLen;
  return Math.max(oldChangedLen, newChangedLen);
}
