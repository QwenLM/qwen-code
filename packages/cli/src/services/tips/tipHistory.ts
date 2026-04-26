/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tip history tracking — in-session cooldown and cross-session persistence.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';

interface TipHistoryEntry {
  totalShown: number;
  lastSessionTimestamp: number;
}

interface TipHistoryData {
  sessionCount: number;
  tips: Record<string, TipHistoryEntry>;
}

export class TipHistory {
  /** In-session tracking: tipId → prompt count when last shown */
  private sessionShown: Map<string, number> = new Map();
  private data: TipHistoryData;
  private filePath: string;

  constructor(data: TipHistoryData, filePath: string) {
    this.data = data;
    this.filePath = filePath;
  }

  get sessionCount(): number {
    return this.data.sessionCount;
  }

  /**
   * Check if a tip has cooled down enough to be shown again.
   */
  isCooledDown(
    tipId: string,
    cooldownPrompts: number,
    currentPromptCount: number,
  ): boolean {
    const lastShown = this.sessionShown.get(tipId);
    if (lastShown === undefined) return true;
    return currentPromptCount - lastShown >= cooldownPrompts;
  }

  /**
   * Get a recency score for LRU sorting. Lower = shown longer ago (or never).
   * Tips shown in this session get a high score (shown recently).
   * Tips never shown in this session fall back to cross-session
   * lastSessionTimestamp for true recency-based rotation.
   */
  getLastShown(tipId: string): number {
    if (this.sessionShown.has(tipId)) {
      // Use a base larger than persisted epoch-millisecond timestamps so any
      // session-shown tip sorts after cross-session-only tips, while still
      // preserving prompt-count ordering within the current session.
      return (
        Number.MAX_SAFE_INTEGER -
        1_000_000 +
        (this.sessionShown.get(tipId) ?? 0)
      );
    }
    // Use the persisted last-shown timestamp for cross-session recency
    return this.normalizeEntry(this.data.tips[tipId]).lastSessionTimestamp;
  }

  /**
   * Normalize a persisted tip entry so corrupted values cannot crash mutations.
   */
  private normalizeEntry(raw: unknown): TipHistoryEntry {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { totalShown: 0, lastSessionTimestamp: 0 };
    }
    const candidate = raw as Partial<TipHistoryEntry>;
    return {
      totalShown:
        typeof candidate.totalShown === 'number' &&
        Number.isFinite(candidate.totalShown)
          ? candidate.totalShown
          : 0,
      lastSessionTimestamp:
        typeof candidate.lastSessionTimestamp === 'number' &&
        Number.isFinite(candidate.lastSessionTimestamp)
          ? candidate.lastSessionTimestamp
          : 0,
    };
  }

  /**
   * Record that a tip was shown at the given prompt count.
   */
  recordShown(tipId: string, currentPromptCount: number): void {
    this.sessionShown.set(tipId, currentPromptCount);
    const entry = this.normalizeEntry(this.data.tips[tipId]);
    entry.totalShown++;
    entry.lastSessionTimestamp = Date.now();
    this.data.tips[tipId] = entry;
    this.persist();
  }

  /**
   * Persist history to disk.
   */
  private persist(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), {
        mode: 0o600,
      });
    } catch {
      // Silently ignore write errors — tips are non-critical
    }
  }

  /**
   * Load history from disk, incrementing session count.
   */
  static load(): TipHistory {
    const filePath = path.join(Storage.getGlobalQwenDir(), 'tip_history.json');
    let data: TipHistoryData = { sessionCount: 0, tips: {} };
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          typeof parsed.sessionCount === 'number'
        ) {
          data = {
            sessionCount:
              Number.isFinite(parsed.sessionCount) && parsed.sessionCount >= 0
                ? Math.floor(parsed.sessionCount)
                : 0,
            tips: parsed.tips ?? {},
          };
        }
      }
    } catch {
      // Ignore read/parse errors — start fresh
    }

    // Increment session count for this startup
    data.sessionCount++;
    data.tips =
      typeof data.tips === 'object' &&
      data.tips !== null &&
      !Array.isArray(data.tips)
        ? data.tips
        : {};

    const history = new TipHistory(data, filePath);
    history.persist();
    return history;
  }
}
