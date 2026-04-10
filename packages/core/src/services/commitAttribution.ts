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
 *
 * Features aligned with Claude Code's attribution system:
 * - Character-level prefix/suffix diff algorithm
 * - Real AI/human contribution ratio via git diff
 * - Surface tracking (cli/ide/api/sdk)
 * - Prompt & permission prompt counting
 * - Session baseline (content hash) for precise human edit detection
 * - Snapshot/restore for session persistence
 * - Generated file exclusion
 */

import { createHash } from 'node:crypto';
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
  /** SHA-256 hash of the file content after AI's last edit */
  contentHash: string;
}

/** Session baseline: snapshot of file state at session start or first AI touch */
export interface FileBaseline {
  contentHash: string;
  mtime: number;
}

/** Per-file attribution detail in the git notes payload. */
export interface FileAttributionDetail {
  aiChars: number;
  humanChars: number;
  percent: number;
  surface?: string;
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
    surfaces: string[];
  };
  surfaceBreakdown: Record<string, { aiChars: number; percent: number }>;
  excludedGenerated: string[];
  promptCount: number;
}

/** Result of running git commands to get staged file info. */
export interface StagedFileInfo {
  files: string[];
  diffSizes: Map<string, number>;
  deletedFiles: Set<string>;
}

/** Serializable snapshot for session persistence. */
export interface AttributionSnapshot {
  type: 'attribution-snapshot';
  surface: string;
  fileStates: Record<string, FileAttribution>;
  baselines: Record<string, FileBaseline>;
  promptCount: number;
  promptCountAtLastCommit: number;
  permissionPromptCount: number;
  permissionPromptCountAtLastCommit: number;
  escapeCount: number;
  escapeCountAtLastCommit: number;
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
// Utilities
// ---------------------------------------------------------------------------

export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function getClientSurface(): string {
  return process.env['QWEN_CODE_ENTRYPOINT'] ?? 'cli';
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CommitAttributionService {
  private static instance: CommitAttributionService | null = null;

  /** Per-file AI contribution tracking (keyed by absolute path) */
  private fileAttributions: Map<string, FileAttribution> = new Map();
  /** Baselines recorded when AI first touches a file */
  private sessionBaselines: Map<string, FileBaseline> = new Map();
  /** Client surface (cli, ide, api, sdk, etc.) */
  private surface: string = getClientSurface();

  // -- Prompt counting --
  private promptCount: number = 0;
  private promptCountAtLastCommit: number = 0;
  private permissionPromptCount: number = 0;
  private permissionPromptCountAtLastCommit: number = 0;
  private escapeCount: number = 0;
  private escapeCountAtLastCommit: number = 0;

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
   * Uses prefix/suffix matching for precise character-level contribution.
   * On first edit of a file, saves a session baseline of the old content.
   */
  recordEdit(
    filePath: string,
    oldContent: string | null,
    newContent: string,
  ): void {
    const existing = this.fileAttributions.get(filePath) || {
      aiContribution: 0,
      aiCreated: false,
      contentHash: '',
    };

    // Save baseline on first AI touch (before AI modifies it)
    if (!this.sessionBaselines.has(filePath) && oldContent !== null) {
      this.sessionBaselines.set(filePath, {
        contentHash: computeContentHash(oldContent),
        mtime: Date.now(),
      });
    }

    const isNewFile = oldContent === null;
    const contribution = computeCharContribution(oldContent ?? '', newContent);

    existing.aiContribution += contribution;
    existing.contentHash = computeContentHash(newContent);
    if (isNewFile && !existing.aiCreated) {
      existing.aiCreated = true;
    }

    this.fileAttributions.set(filePath, existing);
  }

  /** Record an AI file deletion. */
  recordDeletion(filePath: string, deletedContentLength: number): void {
    const existing = this.fileAttributions.get(filePath) || {
      aiContribution: 0,
      aiCreated: false,
      contentHash: '',
    };
    existing.aiContribution += deletedContentLength;
    this.fileAttributions.set(filePath, existing);
  }

  // -----------------------------------------------------------------------
  // Prompt / permission counting
  // -----------------------------------------------------------------------

  incrementPromptCount(): void {
    this.promptCount++;
  }

  incrementPermissionPromptCount(): void {
    this.permissionPromptCount++;
  }

  incrementEscapeCount(): void {
    this.escapeCount++;
  }

  getPromptCount(): number {
    return this.promptCount;
  }

  /** Prompts since last commit (for "N-shotted" display). */
  getPromptsSinceLastCommit(): number {
    return this.promptCount - this.promptCountAtLastCommit;
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

  getSurface(): string {
    return this.surface;
  }

  clearAttributions(): void {
    this.promptCountAtLastCommit = this.promptCount;
    this.permissionPromptCountAtLastCommit = this.permissionPromptCount;
    this.escapeCountAtLastCommit = this.escapeCount;
    this.fileAttributions.clear();
    this.sessionBaselines.clear();
  }

  // -----------------------------------------------------------------------
  // Snapshot / restore (session persistence)
  // -----------------------------------------------------------------------

  /** Serialize current state for session persistence. */
  toSnapshot(): AttributionSnapshot {
    const fileStates: Record<string, FileAttribution> = {};
    for (const [k, v] of this.fileAttributions) {
      fileStates[k] = { ...v };
    }
    const baselines: Record<string, FileBaseline> = {};
    for (const [k, v] of this.sessionBaselines) {
      baselines[k] = { ...v };
    }
    return {
      type: 'attribution-snapshot',
      surface: this.surface,
      fileStates,
      baselines,
      promptCount: this.promptCount,
      promptCountAtLastCommit: this.promptCountAtLastCommit,
      permissionPromptCount: this.permissionPromptCount,
      permissionPromptCountAtLastCommit: this.permissionPromptCountAtLastCommit,
      escapeCount: this.escapeCount,
      escapeCountAtLastCommit: this.escapeCountAtLastCommit,
    };
  }

  /** Restore state from a persisted snapshot. */
  restoreFromSnapshot(snapshot: AttributionSnapshot): void {
    this.surface = snapshot.surface;
    this.promptCount = snapshot.promptCount ?? 0;
    this.promptCountAtLastCommit = snapshot.promptCountAtLastCommit ?? 0;
    this.permissionPromptCount = snapshot.permissionPromptCount ?? 0;
    this.permissionPromptCountAtLastCommit =
      snapshot.permissionPromptCountAtLastCommit ?? 0;
    this.escapeCount = snapshot.escapeCount ?? 0;
    this.escapeCountAtLastCommit = snapshot.escapeCountAtLastCommit ?? 0;

    this.fileAttributions.clear();
    for (const [k, v] of Object.entries(snapshot.fileStates ?? {})) {
      this.fileAttributions.set(k, { ...v });
    }
    this.sessionBaselines.clear();
    for (const [k, v] of Object.entries(snapshot.baselines ?? {})) {
      this.sessionBaselines.set(k, { ...v });
    }
  }

  // -----------------------------------------------------------------------
  // Payload generation
  // -----------------------------------------------------------------------

  /**
   * Generate the git notes JSON payload by combining tracked AI contributions
   * with staged file information from git.
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
    const surfaceCounts: Record<string, number> = {};
    let totalAiChars = 0;
    let totalHumanChars = 0;

    // Build lookup: relative path → tracked AI contribution
    const aiLookup = new Map<string, FileAttribution>();
    for (const [absPath, attr] of this.fileAttributions) {
      const rel = path.relative(baseDir, absPath);
      aiLookup.set(rel, attr);
    }

    for (const relFile of stagedInfo.files) {
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
        humanChars = Math.max(0, diffSize - aiChars);
      } else if (isDeleted) {
        aiChars = 0;
        humanChars = diffSize > 0 ? diffSize : 100;
      } else {
        aiChars = 0;
        humanChars = diffSize;
      }

      const total = aiChars + humanChars;
      const percent = total > 0 ? Math.round((aiChars / total) * 100) : 0;

      files[relFile] = { aiChars, humanChars, percent, surface: this.surface };
      totalAiChars += aiChars;
      totalHumanChars += humanChars;
      surfaceCounts[this.surface] =
        (surfaceCounts[this.surface] ?? 0) + aiChars;
    }

    const totalChars = totalAiChars + totalHumanChars;
    const aiPercent =
      totalChars > 0 ? Math.round((totalAiChars / totalChars) * 100) : 0;

    // Surface breakdown
    const surfaceBreakdown: Record<
      string,
      { aiChars: number; percent: number }
    > = {};
    for (const [surf, chars] of Object.entries(surfaceCounts)) {
      surfaceBreakdown[surf] = {
        aiChars: chars,
        percent: totalChars > 0 ? Math.round((chars / totalChars) * 100) : 0,
      };
    }

    return {
      version: 1,
      generator,
      files,
      summary: {
        aiPercent,
        aiChars: totalAiChars,
        humanChars: totalHumanChars,
        totalFilesTouched: Object.keys(files).length,
        surfaces: [this.surface],
      },
      surfaceBreakdown,
      excludedGenerated,
      promptCount: this.getPromptsSinceLastCommit(),
    };
  }

  // -----------------------------------------------------------------------
  // PR attribution text
  // -----------------------------------------------------------------------

  /**
   * Generate enhanced PR attribution text.
   * Format: "🤖 Generated with Qwen Code (85% 3-shotted by Qwen-Coder)"
   */
  generatePRAttribution(
    stagedInfo: StagedFileInfo,
    baseDir: string,
    generatorName?: string,
  ): string {
    const note = this.generateNotePayload(stagedInfo, baseDir, generatorName);
    const generator = note.generator;
    const percent = note.summary.aiPercent;
    const shots = this.getPromptsSinceLastCommit();

    if (percent === 0 && shots === 0) {
      return `🤖 Generated with Qwen Code`;
    }

    return `🤖 Generated with Qwen Code (${percent}% ${shots}-shotted by ${generator})`;
  }
}

// ---------------------------------------------------------------------------
// Character contribution calculation (Claude's prefix/suffix algorithm)
// ---------------------------------------------------------------------------

/**
 * Compute the character contribution for a file modification.
 * Uses common prefix/suffix matching to find the actual changed region,
 * then returns the larger of the old/new changed lengths.
 */
export function computeCharContribution(
  oldContent: string,
  newContent: string,
): number {
  if (oldContent === '' || newContent === '') {
    return oldContent === '' ? newContent.length : oldContent.length;
  }

  const minLen = Math.min(oldContent.length, newContent.length);
  let prefixEnd = 0;
  while (
    prefixEnd < minLen &&
    oldContent[prefixEnd] === newContent[prefixEnd]
  ) {
    prefixEnd++;
  }

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
