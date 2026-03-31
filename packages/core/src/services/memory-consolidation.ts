/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContentGenerator } from '../core/contentGenerator.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MEMORY_CONSOLIDATION');

const DEFAULT_MIN_SESSIONS = 5;
const DEFAULT_MIN_HOURS = 24;
const DEFAULT_MAX_LINES = 200;
const LOCK_STALE_HOURS = 1;

export interface ConsolidationConfig {
  minSessionsBetween: number;
  minHoursBetween: number;
  maxMemoryLines: number;
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
  linesBeforeGlobal?: number;
  linesAfterGlobal?: number;
  linesBeforeProject?: number;
  linesAfterProject?: number;
}

export class MemoryConsolidationService {
  private statePath: string;
  private globalMemoryPath: string;
  private projectMemoryPath: string;
  private config: ConsolidationConfig;

  constructor(
    runtimeDir: string,
    projectDir: string,
    private getContentGenerator: () => ContentGenerator | null,
    private getModel: () => string,
    config?: Partial<ConsolidationConfig>,
  ) {
    this.statePath = path.join(runtimeDir, 'memory-consolidation-state.json');
    this.globalMemoryPath = path.join(
      process.env['HOME'] ?? '~',
      '.qwen',
      'QWEN.md',
    );
    this.projectMemoryPath = path.join(projectDir, 'QWEN.md');
    this.config = {
      minSessionsBetween: config?.minSessionsBetween ?? DEFAULT_MIN_SESSIONS,
      minHoursBetween: config?.minHoursBetween ?? DEFAULT_MIN_HOURS,
      maxMemoryLines: config?.maxMemoryLines ?? DEFAULT_MAX_LINES,
      scope: config?.scope ?? 'both',
    };
  }

  /** Call on every session end. Gates determine if actual work happens. */
  async maybeConsolidate(): Promise<ConsolidationResult> {
    const state = this.loadState();

    // Increment session counter
    state.sessionsSinceLastConsolidation =
      (state.sessionsSinceLastConsolidation ?? 0) + 1;
    this.saveState(state);

    // Gate 1: Time
    const hoursSinceLastConsolidation =
      (Date.now() - (state.lastConsolidatedAt ?? 0)) / (1000 * 60 * 60);
    if (hoursSinceLastConsolidation < this.config.minHoursBetween) {
      return {
        consolidated: false,
        reason: `Only ${hoursSinceLastConsolidation.toFixed(1)}h since last consolidation (min: ${this.config.minHoursBetween}h)`,
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
    const result: ConsolidationResult = { consolidated: true };
    const contentGenerator = this.getContentGenerator();
    if (!contentGenerator) {
      return { consolidated: false, reason: 'No content generator available' };
    }

    // Phase 1: Orient -- read current memory files
    const targets: Array<{ path: string; scope: 'global' | 'project' }> = [];
    if (
      this.config.scope !== 'project' &&
      fs.existsSync(this.globalMemoryPath)
    ) {
      targets.push({ path: this.globalMemoryPath, scope: 'global' });
    }
    if (
      this.config.scope !== 'global' &&
      fs.existsSync(this.projectMemoryPath)
    ) {
      targets.push({ path: this.projectMemoryPath, scope: 'project' });
    }

    if (targets.length === 0) {
      return { consolidated: false, reason: 'No memory files found' };
    }

    for (const target of targets) {
      const content = fs.readFileSync(target.path, 'utf8');
      const lines = content.split('\n');
      const linesBefore = lines.length;

      if (linesBefore <= this.config.maxMemoryLines * 0.8) {
        // Not worth consolidating yet
        debugLogger.debug(
          `Skipping ${target.scope} memory: ${linesBefore} lines (threshold: ${this.config.maxMemoryLines})`,
        );
        continue;
      }

      // Phase 2: Gather -- the content itself is the signal
      // Phase 3: Consolidate -- side-query to model
      const consolidatedContent = await this.consolidateContent(
        content,
        contentGenerator,
      );

      // Phase 4: Prune -- enforce line limit
      const pruned = this.prune(
        consolidatedContent,
        this.config.maxMemoryLines,
      );

      // Write back
      fs.writeFileSync(target.path, pruned, 'utf8');

      const linesAfter = pruned.split('\n').length;
      if (target.scope === 'global') {
        result.linesBeforeGlobal = linesBefore;
        result.linesAfterGlobal = linesAfter;
      } else {
        result.linesBeforeProject = linesBefore;
        result.linesAfterProject = linesAfter;
      }

      debugLogger.info(
        `Consolidated ${target.scope} memory: ${linesBefore} -> ${linesAfter} lines`,
      );
    }

    // Update state
    const state = this.loadState();
    state.lastConsolidatedAt = Date.now();
    state.sessionsSinceLastConsolidation = 0;
    this.saveState(state);

    return result;
  }

  private async consolidateContent(
    content: string,
    contentGenerator: ContentGenerator,
  ): Promise<string> {
    const prompt = `You are a memory consolidation engine. Below is a memory file used by an AI coding assistant to remember important facts, patterns, and decisions across sessions.

Your task: Consolidate this memory file by:
1. Merging duplicate or near-duplicate entries
2. Removing entries that contradict newer entries (keep the newer one)
3. Combining related entries into concise summaries
4. Preserving all unique, actionable information
5. Maintaining the original markdown formatting and section headers

IMPORTANT: Do NOT add commentary, explanations, or meta-text. Return ONLY the consolidated memory content.

Current memory file:
---
${content}
---

Return the consolidated memory content:`;

    const response = await contentGenerator.generateContent(
      {
        model: this.getModel(),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          maxOutputTokens: 4096,
          temperature: 0,
        },
      },
      'memory-consolidation',
    );

    return response.text?.trim() ?? content;
  }

  private prune(content: string, maxLines: number): string {
    const lines = content.split('\n');
    if (lines.length <= maxLines) return content;

    // Keep the first maxLines lines, preserving complete sections
    // Find the last section header before the cutoff
    let cutPoint = maxLines;
    for (let i = maxLines - 1; i >= maxLines - 20; i--) {
      if (i >= 0 && lines[i]?.startsWith('#')) {
        cutPoint = i;
        break;
      }
    }

    return lines.slice(0, cutPoint).join('\n').trimEnd() + '\n';
  }

  private acquireLock(state: ConsolidationState): boolean {
    if (state.lockPid && state.lockAcquiredAt) {
      const lockAge = (Date.now() - state.lockAcquiredAt) / (1000 * 60 * 60);
      if (lockAge < LOCK_STALE_HOURS) {
        // Check if process is still alive
        try {
          process.kill(state.lockPid, 0);
          return false; // Process alive, lock valid
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
