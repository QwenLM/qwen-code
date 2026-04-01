/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContentGenerator } from '../core/contentGenerator.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  listMemories,
  deleteMemory,
  updateMemory,
  regenerateIndex,
} from '../memory/memoryStore.js';
import { isStale } from '../memory/memoryAge.js';
import type { MemoryScope } from '../memory/types.js';

const debugLogger = createDebugLogger('MEMORY_CONSOLIDATION');

const DEFAULT_MIN_SESSIONS = 5;
const DEFAULT_MIN_HOURS = 24;
const DEFAULT_MIN_MEMORIES = 5;
const STALE_THRESHOLD_DAYS = 90;
const LOCK_STALE_HOURS = 1;

export interface ConsolidationConfig {
  minSessionsBetween: number;
  minHoursBetween: number;
  /** Minimum memory count before consolidation is worthwhile */
  minMemories: number;
  scope: 'global' | 'project' | 'both';
}

interface ConsolidationState {
  lastConsolidatedAt: number;
  sessionsSinceLastConsolidation: number;
  lockPid?: number;
  lockAcquiredAt?: number;
}

export interface ConsolidationResult {
  consolidated: boolean;
  reason?: string;
  memoriesBefore?: number;
  memoriesAfter?: number;
  merged?: number;
  pruned?: number;
}

/**
 * Periodic "dream pass" consolidation for the file-per-memory system.
 *
 * Pipeline:
 *   Orient  → read all memory headers + bodies
 *   Detect  → group by semantic similarity (LLM-assisted)
 *   Merge   → combine duplicate groups into strongest entry
 *   Prune   → remove stale entries (>90 days with no update)
 *   Index   → regenerateIndex() to refresh MEMORY.md
 *
 * Gated by time (24h), session count (5), and process lock.
 */
export class MemoryConsolidationService {
  private statePath: string;
  private projectDir: string;
  private config: ConsolidationConfig;

  constructor(
    runtimeDir: string,
    projectDir: string,
    private getContentGenerator: () => ContentGenerator | null,
    private getModel: () => string,
    config?: Partial<ConsolidationConfig>,
  ) {
    this.statePath = path.join(runtimeDir, 'memory-consolidation-state.json');
    this.projectDir = projectDir;
    this.config = {
      minSessionsBetween: config?.minSessionsBetween ?? DEFAULT_MIN_SESSIONS,
      minHoursBetween: config?.minHoursBetween ?? DEFAULT_MIN_HOURS,
      minMemories: config?.minMemories ?? DEFAULT_MIN_MEMORIES,
      scope: config?.scope ?? 'both',
    };
  }

  /** Call on session end or after extraction. Gates determine if work happens. */
  async maybeConsolidate(): Promise<ConsolidationResult> {
    const state = this.loadState();

    // Increment session counter
    state.sessionsSinceLastConsolidation =
      (state.sessionsSinceLastConsolidation ?? 0) + 1;
    this.saveState(state);

    // Gate 1: Time
    const hoursSince =
      (Date.now() - (state.lastConsolidatedAt ?? 0)) / (1000 * 60 * 60);
    if (hoursSince < this.config.minHoursBetween) {
      return {
        consolidated: false,
        reason: `Only ${hoursSince.toFixed(1)}h since last consolidation (min: ${this.config.minHoursBetween}h)`,
      };
    }

    // Gate 2: Session count
    if (state.sessionsSinceLastConsolidation < this.config.minSessionsBetween) {
      return {
        consolidated: false,
        reason: `Only ${state.sessionsSinceLastConsolidation} sessions since last (min: ${this.config.minSessionsBetween})`,
      };
    }

    // Gate 3: Lock
    if (!this.acquireLock(state)) {
      return {
        consolidated: false,
        reason: 'Another process is consolidating',
      };
    }

    try {
      return await this.consolidate();
    } finally {
      this.releaseLock(state);
    }
  }

  private async consolidate(): Promise<ConsolidationResult> {
    const scopes: MemoryScope[] =
      this.config.scope === 'both'
        ? ['project', 'global']
        : [this.config.scope];

    let totalBefore = 0;
    let totalAfter = 0;
    let totalMerged = 0;
    let totalPruned = 0;

    for (const scope of scopes) {
      const memories = await listMemories(scope, this.projectDir);
      totalBefore += memories.length;

      if (memories.length < this.config.minMemories) {
        debugLogger.debug(
          `Skipping ${scope}: only ${memories.length} memories (min: ${this.config.minMemories})`,
        );
        totalAfter += memories.length;
        continue;
      }

      // Phase 1: Prune stale entries (>90 days)
      const staleFiles = memories.filter((m) =>
        isStale(m.mtimeMs, STALE_THRESHOLD_DAYS),
      );
      for (const stale of staleFiles) {
        await deleteMemory(stale.filePath, scope, this.projectDir);
        totalPruned++;
        debugLogger.debug(`Pruned stale memory: ${stale.header.name}`);
      }

      const remaining = memories.filter(
        (m) => !isStale(m.mtimeMs, STALE_THRESHOLD_DAYS),
      );

      if (remaining.length < 2) {
        totalAfter += remaining.length;
        continue;
      }

      // Phase 2: Detect duplicates via LLM
      const contentGenerator = this.getContentGenerator();
      if (!contentGenerator) {
        totalAfter += remaining.length;
        continue;
      }

      const manifest = remaining
        .map(
          (m) =>
            `- ${path.basename(m.filePath)}: [${m.header.type}] ${m.header.name} — ${m.header.description}`,
        )
        .join('\n');

      const mergeGroups = await this.detectDuplicates(
        manifest,
        contentGenerator,
      );

      // Phase 3: Merge duplicate groups
      for (const group of mergeGroups) {
        if (group.length < 2) continue;

        // Find the memories in the remaining list
        const groupMemories = group
          .map((filename) =>
            remaining.find((m) => path.basename(m.filePath) === filename),
          )
          .filter(Boolean);

        if (groupMemories.length < 2) continue;

        // Keep the first (newest by mtime), merge descriptions
        const keeper = groupMemories[0]!;
        const others = groupMemories.slice(1);

        // Combine descriptions
        const combinedDesc = [
          keeper.header.description,
          ...others.map((m) => m!.header.description),
        ]
          .filter((d, i, arr) => arr.indexOf(d) === i) // dedup
          .join('; ');

        await updateMemory(
          keeper.filePath,
          { description: combinedDesc },
          scope,
          this.projectDir,
        );

        for (const dup of others) {
          await deleteMemory(dup!.filePath, scope, this.projectDir);
          totalMerged++;
        }
      }

      // Phase 4: Refresh index
      await regenerateIndex(scope, this.projectDir);

      const afterCount = (await listMemories(scope, this.projectDir)).length;
      totalAfter += afterCount;
    }

    // Update state
    const state = this.loadState();
    state.lastConsolidatedAt = Date.now();
    state.sessionsSinceLastConsolidation = 0;
    this.saveState(state);

    debugLogger.info(
      `Consolidation complete: ${totalBefore} -> ${totalAfter} memories (merged: ${totalMerged}, pruned: ${totalPruned})`,
    );

    return {
      consolidated: true,
      memoriesBefore: totalBefore,
      memoriesAfter: totalAfter,
      merged: totalMerged,
      pruned: totalPruned,
    };
  }

  /**
   * Ask the LLM to identify groups of duplicate/overlapping memories.
   * Returns arrays of filenames that should be merged.
   */
  private async detectDuplicates(
    manifest: string,
    contentGenerator: ContentGenerator,
  ): Promise<string[][]> {
    const prompt = `You are a memory deduplication engine. Below is a list of memory files stored by an AI coding assistant.

Identify groups of memories that are duplicates or near-duplicates (same fact stated differently, overlapping information, contradictory entries about the same topic).

Return ONLY a JSON array of arrays. Each inner array contains the filenames that should be merged. Only include groups of 2+. If no duplicates exist, return [].

Example: [["user_prefer-tabs.md", "user_tab-spaces.md"], ["project_deadline.md", "project_launch-date.md"]]

Memory files:
${manifest}

Return JSON array:`;

    try {
      const response = await contentGenerator.generateContent(
        {
          model: this.getModel(),
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: { maxOutputTokens: 1024, temperature: 0 },
        },
        'memory-consolidation',
      );

      const text = response.text?.trim() ?? '[]';
      // Extract JSON from potential markdown code fences
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as string[][];
      }
      return [];
    } catch (err) {
      debugLogger.warn('Duplicate detection failed:', err);
      return [];
    }
  }

  // --- Gating infrastructure (unchanged) ---

  private acquireLock(state: ConsolidationState): boolean {
    if (state.lockPid && state.lockAcquiredAt) {
      const lockAge = (Date.now() - state.lockAcquiredAt) / (1000 * 60 * 60);
      if (lockAge < LOCK_STALE_HOURS) {
        try {
          process.kill(state.lockPid, 0);
          return false;
        } catch {
          // Process dead, lock stale
        }
      }
    }
    state.lockPid = process.pid;
    state.lockAcquiredAt = Date.now();
    this.saveState(state);
    return true;
  }

  private releaseLock(state: ConsolidationState): void {
    state.lockPid = undefined;
    state.lockAcquiredAt = undefined;
    this.saveState(state);
  }

  private loadState(): ConsolidationState {
    try {
      if (fs.existsSync(this.statePath)) {
        return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      }
    } catch {
      /* fresh state */
    }
    return { lastConsolidatedAt: 0, sessionsSinceLastConsolidation: 0 };
  }

  private saveState(state: ConsolidationState): void {
    const dir = path.dirname(this.statePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }
}
